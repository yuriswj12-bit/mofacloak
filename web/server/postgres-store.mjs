import {randomBytes} from 'node:crypto';
import {PaymentError,cents} from './gmpay.mjs';
import {hash,token} from './store.mjs';
export class PostgresStore {
  constructor(db) {
    this.db = db;
  }
  async transaction(fn) {
    return await this.db.transaction(fn);
  }
  async createAccount(name) {
    const id = 'usr_' + randomBytes(12).toString('hex'),
      accessCode = token();
    await this.db.prepare('INSERT INTO accounts(id,name,access_hash,created_at) VALUES(?,?,?,?)').run(id, name, hash(accessCode), Date.now());
    return {
      id,
      name,
      accessCode
    };
  }
  async login(access) {
    const a = await this.db.prepare('SELECT id,name FROM accounts WHERE access_hash=? AND enabled=1').get(hash(access));
    if (!a) throw new PaymentError('LOGIN_FAILED', '访问码无效。', 401);
    const session = token();
    await this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(session), a.id, Date.now() + 7 * 86400000);
    return {
      account: a,
      session
    };
  }
  async account(session) {
    if (!session) return null;
    return (await this.db.prepare('SELECT a.id,a.name FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE s.token_hash=? AND s.expires_at>? AND a.enabled=1').get(hash(session), Date.now())) || null;
  }
  async logout(session) {
    if (session) await this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(session));
  }
  async order(id) {
    return await this.db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  }
  async ownOrder(id, accountId) {
    const o = await this.db.prepare('SELECT * FROM orders WHERE id=? AND account_id=?').get(id, accountId);
    if (!o) throw new PaymentError('ORDER_NOT_FOUND', '订单不存在。', 404);
    return o;
  }
  async createOrder(accountId, key, fingerprint, product, cycle, pid) {
    return await this.transaction(async () => {
      const existing = await this.db.prepare('SELECT * FROM orders WHERE account_id=? AND idempotency_key=?').get(accountId, key);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new PaymentError('IDEMPOTENCY_CONFLICT', '该请求标识已用于其他订单。', 409);
        return {
          order: existing,
          created: false
        };
      }
      // Release expired cashier slots even when the user never reopens those orders.
      // An authenticated signed late receipt can still confirm an expired order.
      await this.db.prepare("UPDATE orders SET status='expired',updated_at=? WHERE account_id=? AND status='pending' AND expires_at IS NOT NULL AND expires_at<=?").run(Date.now(), accountId, Date.now());
      if ((await this.db.prepare("SELECT count(*) n FROM orders WHERE account_id=? AND status IN ('creating','pending','review')").get(accountId)).n >= 5) throw new PaymentError('TOO_MANY_ORDERS', '请先处理已有的待付款订单。', 429);
      const id = 'MF' + randomBytes(14).toString('hex'),
        time = Date.now();
      await this.db.prepare('INSERT INTO orders(id,account_id,idempotency_key,request_fingerprint,name,plan_id,kind,cycle,months,amount_cents,currency,pid,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, accountId, key, fingerprint, product.name, product.plan.id, product.kind, cycle, product.months, product.amount_cents, product.currency || 'CNY', pid, 'creating', time, time);
      return {
        order: await this.order(id),
        created: true
      };
    });
  }
  async attachGateway(id, data) {
    return await this.transaction(async () => {
      const o = await this.order(id);
      if (!o) throw new Error('Missing order');
      if (o.paid_trade_id && o.paid_trade_id !== String(data.trade_id)) throw new PaymentError('TRADE_MISMATCH', '收银台交易号与已确认付款不一致。', 409);
      await this.db.prepare("UPDATE orders SET trade_id=?,payment_url=?,actual_amount=CASE WHEN status='paid' THEN actual_amount ELSE ? END,receive_address=CASE WHEN status='paid' THEN receive_address ELSE ? END,expires_at=?,status=CASE WHEN status='paid' THEN status ELSE 'pending' END,updated_at=? WHERE id=?").run(String(data.trade_id), data.payment_url, String(data.actual_amount), data.receive_address, Number(data.expiration_time) * 1000, Date.now(), id);
      return await this.order(id);
    });
  }
  async markReview(id) {
    await this.db.prepare("UPDATE orders SET status='review',updated_at=? WHERE id=? AND status='creating'").run(Date.now(), id);
  }
  async markFailed(id) {
    await this.db.prepare("UPDATE orders SET status='failed',updated_at=? WHERE id=? AND status='creating'").run(Date.now(), id);
  }
  async expire(id) {
    await this.db.prepare("UPDATE orders SET status='expired',updated_at=? WHERE id=? AND status='pending'").run(Date.now(), id);
  }
  async applyPaid(params, digest) {
    return await this.transaction(async () => {
      const o = await this.order(params.order_id);
      if (!o) throw new PaymentError('ORDER_NOT_FOUND', '订单不存在。', 404);
      if (params.currency != null && String(params.currency).toUpperCase() !== o.currency) throw new PaymentError('CURRENCY_MISMATCH', '通知币种与原订单不一致。');
      if (String(params.pid) !== o.pid || Number(params.status) !== 2 || cents(params.amount) !== o.amount_cents || String(params.token).toUpperCase() !== 'USDT' || !Number.isFinite(Number(params.actual_amount)) || !(Number(params.actual_amount) > 0) || typeof params.trade_id !== 'string' || !params.trade_id || typeof params.block_transaction_id !== 'string' || !params.block_transaction_id || typeof params.receive_address !== 'string' || !params.receive_address) throw new PaymentError('CALLBACK_MISMATCH', '回调数据与订单不一致。', 400);
      if (o.trade_id && o.trade_id !== params.trade_id || o.receive_address && o.receive_address.toLowerCase() !== params.receive_address.toLowerCase()) throw new PaymentError('CALLBACK_MISMATCH', '付款通知的交易号或收款地址与原订单不一致。', 400);
      if (o.status === 'paid') {
        if (o.paid_trade_id !== params.trade_id || o.tx_hash.toLowerCase() !== params.block_transaction_id.toLowerCase()) throw new PaymentError('CALLBACK_MISMATCH', '重复通知与原付款记录不一致。', 409);
        return {
          duplicate: true,
          order: o
        };
      }
      const reusedHash = await this.db.prepare("SELECT id FROM orders WHERE lower(tx_hash)=lower(?) AND id<>? AND status='paid'").get(params.block_transaction_id, o.id);
      if (reusedHash) throw new PaymentError('TRANSACTION_REUSED', '链上交易已用于其他订单。', 409);
      const conflict = await this.db.prepare('SELECT id FROM orders WHERE paid_trade_id=? AND id<>?').get(params.trade_id, o.id);
      if (conflict) throw new PaymentError('TRADE_REUSED', '交易号已用于其他订单。', 409);
      const time = Date.now();
      await this.db.prepare("UPDATE orders SET status='paid',trade_id=COALESCE(trade_id,?),paid_trade_id=?,tx_hash=?,actual_amount=?,receive_address=?,paid_at=?,updated_at=? WHERE id=?").run(params.trade_id, params.trade_id, params.block_transaction_id, String(params.actual_amount), params.receive_address, time, time, o.id);
      await this.db.prepare('INSERT INTO payment_events VALUES(?,?,?)').run(o.id, digest, time);
      if (o.kind === 'gift') await this.db.prepare('INSERT INTO gifts(id,order_id,owner_id,code,plan_id,name,months,created_at) VALUES(?,?,?,?,?,?,?,?)').run('gift_' + randomBytes(12).toString('hex'), o.id, o.account_id, 'CLOAK-' + randomBytes(20).toString('hex').toUpperCase(), o.plan_id, o.name.replace('礼品卡', ''), o.months, time);else await this.db.prepare('INSERT INTO fulfillment_jobs(order_id,account_id,plan_id,months,created_at) VALUES(?,?,?,?,?)').run(o.id, o.account_id, o.plan_id, o.months, time);
      return {
        duplicate: false,
        order: await this.order(o.id)
      };
    });
  }
  async listOrders(id) {
    return await this.db.prepare('SELECT * FROM orders WHERE account_id=? ORDER BY created_at DESC LIMIT 200').all(id);
  }
  async listGifts(id) {
    return await this.db.prepare('SELECT * FROM gifts WHERE owner_id=? ORDER BY created_at DESC LIMIT 200').all(id);
  }
  async redeem(id, code) {
    return await this.transaction(async () => {
      const g = await this.db.prepare('SELECT * FROM gifts WHERE code=?').get(code);
      if (!g) throw new PaymentError('GIFT_NOT_FOUND', '兑换码无效。', 404);
      if (g.redeemed_by) throw new PaymentError('GIFT_USED', '该礼品卡已兑换。', 409);
      const time = Date.now();
      await this.db.prepare('UPDATE gifts SET redeemed_by=?,redeemed_at=? WHERE id=? AND redeemed_by IS NULL').run(id, time, g.id);
      await this.db.prepare('INSERT INTO fulfillment_jobs(order_id,account_id,plan_id,months,created_at) VALUES(?,?,?,?,?)').run(g.order_id, id, g.plan_id, g.months, time);
      return {
        status: 'pending_activation'
      };
    });
  }
  async disableAccount(id){return this.transaction(async()=>{await this.db.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(id);await this.db.prepare('DELETE FROM sessions WHERE account_id=?').run(id);});}
  async health(){return this.db.prepare('SELECT id FROM accounts LIMIT 1').get();}
  async expirePending(accountId){return this.db.prepare("UPDATE orders SET status='expired',updated_at=? WHERE account_id=? AND status='pending' AND expires_at IS NOT NULL AND expires_at<=?").run(Date.now(),accountId,Date.now());}
  async touchOrder(id){return this.db.prepare('UPDATE orders SET updated_at=? WHERE id=?').run(Date.now(),id);}
  async close() {
    await this.db.close();
  }
}
