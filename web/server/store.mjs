import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {PaymentError,cents} from './gmpay.mjs';

export const hash=s=>createHash('sha256').update(s).digest('hex');
export const token=()=>randomBytes(32).toString('base64url');
export function openStore(path){
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const db=new DatabaseSync(path);
  if(path!==':memory:')chmodSync(path,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,access_hash TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),idempotency_key TEXT NOT NULL,request_fingerprint TEXT NOT NULL,name TEXT NOT NULL,plan_id TEXT NOT NULL,kind TEXT NOT NULL,cycle TEXT NOT NULL,months INTEGER NOT NULL,amount_cents INTEGER NOT NULL,pid TEXT NOT NULL,status TEXT NOT NULL,trade_id TEXT,payment_url TEXT,actual_amount TEXT,receive_address TEXT,expires_at INTEGER,paid_trade_id TEXT UNIQUE,tx_hash TEXT,paid_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(account_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS payment_events(order_id TEXT PRIMARY KEY REFERENCES orders(id),payload_digest TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS fulfillment_jobs(order_id TEXT PRIMARY KEY REFERENCES orders(id),account_id TEXT NOT NULL,plan_id TEXT NOT NULL,months INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS gifts(id TEXT PRIMARY KEY,order_id TEXT UNIQUE NOT NULL REFERENCES orders(id),owner_id TEXT NOT NULL REFERENCES accounts(id),code TEXT UNIQUE NOT NULL,plan_id TEXT NOT NULL,name TEXT NOT NULL,months INTEGER NOT NULL,redeemed_by TEXT REFERENCES accounts(id),redeemed_at INTEGER,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,category TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','answered','closed')),request_key TEXT NOT NULL,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(account_id,request_key));
    CREATE TABLE IF NOT EXISTS ticket_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id TEXT NOT NULL REFERENCES tickets(id),author_role TEXT NOT NULL CHECK(author_role IN ('customer','support')),body TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(ticket_id,author_role,request_key));
    CREATE INDEX IF NOT EXISTS tickets_account_updated ON tickets(account_id,updated_at);
    CREATE TABLE IF NOT EXISTS binance_payments(order_id TEXT PRIMARY KEY REFERENCES orders(id),receiver_uid TEXT NOT NULL,due_cents INTEGER NOT NULL CHECK(due_cents>0),quote_source TEXT NOT NULL,quote_at INTEGER NOT NULL,claim_transaction_id TEXT,submitted_at INTEGER,confirmed_transaction_id TEXT UNIQUE,received_cents INTEGER,reviewer TEXT,evidence_ref TEXT,confirmed_at INTEGER);
  `);
  if(!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='currency'))db.exec("ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY'");
  return new Store(db);
}
export class Store{
  constructor(db){this.db=db;}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  createAccount(name){const id='usr_'+randomBytes(12).toString('hex'),accessCode=token();this.db.prepare('INSERT INTO accounts(id,name,access_hash,created_at) VALUES(?,?,?,?)').run(id,name,hash(accessCode),Date.now());return {id,name,accessCode};}
  login(access){const a=this.db.prepare('SELECT id,name FROM accounts WHERE access_hash=? AND enabled=1').get(hash(access));if(!a)throw new PaymentError('LOGIN_FAILED','访问码无效。',401);const session=token();this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(session),a.id,Date.now()+7*86400000);return {account:a,session};}
  account(session){if(!session)return null;return this.db.prepare('SELECT a.id,a.name FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE s.token_hash=? AND s.expires_at>? AND a.enabled=1').get(hash(session),Date.now())||null;}
  logout(session){if(session)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(session));}
  order(id){return this.db.prepare('SELECT * FROM orders WHERE id=?').get(id);}
  ownOrder(id,accountId){const o=this.db.prepare('SELECT * FROM orders WHERE id=? AND account_id=?').get(id,accountId);if(!o)throw new PaymentError('ORDER_NOT_FOUND','订单不存在。',404);return o;}
  createOrder(accountId,key,fingerprint,product,cycle,pid,manual=null){return this.transaction(()=>{
    const existing=this.db.prepare('SELECT * FROM orders WHERE account_id=? AND idempotency_key=?').get(accountId,key);
    if(existing){if(existing.request_fingerprint!==fingerprint)throw new PaymentError('IDEMPOTENCY_CONFLICT','该请求标识已用于其他订单。',409);return {order:existing,created:false};}
    // Release expired cashier slots even when the user never reopens those orders.
    // An authenticated signed late receipt can still confirm an expired order.
    this.db.prepare("UPDATE orders SET status='expired',updated_at=? WHERE account_id=? AND status='pending' AND expires_at IS NOT NULL AND expires_at<=?").run(Date.now(),accountId,Date.now());
    if(this.db.prepare("SELECT count(*) n FROM orders WHERE account_id=? AND status IN ('creating','pending','review')").get(accountId).n>=5)throw new PaymentError('TOO_MANY_ORDERS','请先处理已有的待付款订单。',429);
    const id='MF'+randomBytes(14).toString('hex'),time=Date.now();
    this.db.prepare('INSERT INTO orders(id,account_id,idempotency_key,request_fingerprint,name,plan_id,kind,cycle,months,amount_cents,currency,pid,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,accountId,key,fingerprint,product.name,product.plan.id,product.kind,cycle,product.months,product.amount_cents,product.currency||'CNY',pid,'creating',time,time);
    if(manual){
      if(pid!=='BINANCE_UID'||!Number.isSafeInteger(manual.dueCents)||manual.dueCents<=0||!/^[1-9][0-9]{4,19}$/.test(manual.uid)||!manual.source)throw new PaymentError('INVALID_MANUAL_PAYMENT','币安收款配置或报价无效。');
      this.db.prepare('INSERT INTO binance_payments(order_id,receiver_uid,due_cents,quote_source,quote_at) VALUES(?,?,?,?,?)').run(id,manual.uid,manual.dueCents,manual.source,time);
      this.db.prepare("UPDATE orders SET status='pending',actual_amount=?,expires_at=? WHERE id=?").run((manual.dueCents/100).toFixed(2),time+30*60000,id);
    }
    return {order:this.order(id),created:true};
  });}
  manualPayment(id){return this.db.prepare('SELECT * FROM binance_payments WHERE order_id=?').get(id);}
  submitManualPayment(id,accountId,transactionId){return this.transaction(()=>{
    const o=this.ownOrder(id,accountId),m=this.manualPayment(id);
    if(!m||o.pid!=='BINANCE_UID')throw new PaymentError('INVALID_CHANNEL','该订单不是币安 UID 转账订单。');
    if(typeof transactionId!=='string'||!/^[-A-Za-z0-9_]{6,100}$/.test(transactionId))throw new PaymentError('INVALID_TRANSACTION','请填写币安交易详情中的交易号。');
    if(o.status==='paid'){if(m.confirmed_transaction_id!==transactionId)throw new PaymentError('PAYMENT_CONFIRMED','订单已确认，请勿更换交易号。',409);return this.order(id);}
    if(m.claim_transaction_id&&m.claim_transaction_id!==transactionId)throw new PaymentError('CLAIM_CONFLICT','已提交其他交易号，请通过工单联系管理员。',409);
    if(!['pending','review','expired'].includes(o.status))throw new PaymentError('INVALID_STATE','此订单不能提交付款信息。',409);
    this.db.prepare('UPDATE binance_payments SET claim_transaction_id=?,submitted_at=COALESCE(submitted_at,?) WHERE order_id=?').run(transactionId,Date.now(),id);
    this.db.prepare("UPDATE orders SET status='review',updated_at=? WHERE id=?").run(Date.now(),id);
    return this.order(id);
  });}
  confirmManualPayment(id,proof){return this.transaction(()=>{
    const o=this.order(id),m=this.manualPayment(id);
    if(!o||!m||o.pid!=='BINANCE_UID')throw new PaymentError('ORDER_NOT_FOUND','币安订单不存在。',404);
    if(!proof||proof.receiverUid!==m.receiver_uid||proof.currency!=='USDT'||typeof proof.transactionId!=='string'||!/^[-A-Za-z0-9_]{6,100}$/.test(proof.transactionId)||typeof proof.reviewer!=='string'||!proof.reviewer.trim()||proof.reviewer.length>100||typeof proof.evidenceRef!=='string'||!proof.evidenceRef.trim()||proof.evidenceRef.length>500)throw new PaymentError('INVALID_PROOF','核账必须提供收款 UID、USDT 实收金额、币安交易号、核账人和凭证位置。');
    const received=cents(proof.receivedAmount);
    if(received!==m.due_cents)throw new PaymentError('AMOUNT_MISMATCH','实收金额必须与订单应付 USDT 完全一致；少付请另行人工处理。');
    if(o.status==='paid'){if(m.confirmed_transaction_id!==proof.transactionId||m.received_cents!==received)throw new PaymentError('PROOF_CONFLICT','与已确认记录不一致。',409);return {duplicate:true,order:o};}
    if(o.status!=='review'||m.claim_transaction_id!==proof.transactionId)throw new PaymentError('CLAIM_REQUIRED','必须先由客户提交相同的币安交易号待核账。',409);
    if(this.db.prepare('SELECT order_id FROM binance_payments WHERE confirmed_transaction_id=? AND order_id<>?').get(proof.transactionId,id))throw new PaymentError('TRANSACTION_REUSED','币安交易号已用于其他订单。',409);
    const time=Date.now();
    this.db.prepare('UPDATE binance_payments SET confirmed_transaction_id=?,received_cents=?,reviewer=?,evidence_ref=?,confirmed_at=? WHERE order_id=?').run(proof.transactionId,received,proof.reviewer.trim(),proof.evidenceRef.trim(),time,id);
    this.db.prepare("UPDATE orders SET status='paid',paid_trade_id=?,paid_at=?,updated_at=? WHERE id=?").run('BINANCE_UID:'+proof.transactionId,time,time,id);
    this.db.prepare('INSERT INTO payment_events VALUES(?,?,?)').run(id,hash(JSON.stringify(proof)),time);
    this.fulfillOrder(o,time);
    return {duplicate:false,order:this.order(id)};
  });}
  fulfillOrder(o,time){
    if(o.kind==='gift')this.db.prepare('INSERT INTO gifts(id,order_id,owner_id,code,plan_id,name,months,created_at) VALUES(?,?,?,?,?,?,?,?)').run('gift_'+randomBytes(12).toString('hex'),o.id,o.account_id,'CLOAK-'+randomBytes(20).toString('hex').toUpperCase(),o.plan_id,o.name.replace('礼品卡',''),o.months,time);
    else this.db.prepare('INSERT INTO fulfillment_jobs(order_id,account_id,plan_id,months,created_at) VALUES(?,?,?,?,?)').run(o.id,o.account_id,o.plan_id,o.months,time);
  }
  attachGateway(id,data){return this.transaction(()=>{const o=this.order(id);if(!o)throw new Error('Missing order');if(o.paid_trade_id&&o.paid_trade_id!==String(data.trade_id))throw new PaymentError('TRADE_MISMATCH','收银台交易号与已确认付款不一致。',409);this.db.prepare("UPDATE orders SET trade_id=?,payment_url=?,actual_amount=CASE WHEN status='paid' THEN actual_amount ELSE ? END,receive_address=CASE WHEN status='paid' THEN receive_address ELSE ? END,expires_at=?,status=CASE WHEN status='paid' THEN status ELSE 'pending' END,updated_at=? WHERE id=?").run(String(data.trade_id),data.payment_url,String(data.actual_amount),data.receive_address,Number(data.expiration_time)*1000,Date.now(),id);return this.order(id);});}
  markReview(id){this.db.prepare("UPDATE orders SET status='review',updated_at=? WHERE id=? AND status='creating'").run(Date.now(),id);}
  markFailed(id){this.db.prepare("UPDATE orders SET status='failed',updated_at=? WHERE id=? AND status='creating'").run(Date.now(),id);}
  expire(id){this.db.prepare("UPDATE orders SET status='expired',updated_at=? WHERE id=? AND status='pending'").run(Date.now(),id);}
  applyPaid(params,digest){return this.transaction(()=>{
    const o=this.order(params.order_id);
    if(!o)throw new PaymentError('ORDER_NOT_FOUND','订单不存在。',404);
    if(params.currency!=null&&String(params.currency).toUpperCase()!==o.currency)throw new PaymentError('CURRENCY_MISMATCH','通知币种与原订单不一致。');
    if(String(params.pid)!==o.pid||Number(params.status)!==2||cents(params.amount)!==o.amount_cents||String(params.token).toUpperCase()!=='USDT'||!Number.isFinite(Number(params.actual_amount))||!(Number(params.actual_amount)>0)||typeof params.trade_id!=='string'||!params.trade_id||typeof params.block_transaction_id!=='string'||!params.block_transaction_id||typeof params.receive_address!=='string'||!params.receive_address)throw new PaymentError('CALLBACK_MISMATCH','回调数据与订单不一致。',400);
    if((o.trade_id&&o.trade_id!==params.trade_id)||(o.receive_address&&o.receive_address.toLowerCase()!==params.receive_address.toLowerCase()))throw new PaymentError('CALLBACK_MISMATCH','付款通知的交易号或收款地址与原订单不一致。',400);
    if(o.status==='paid'){
      if(o.paid_trade_id!==params.trade_id||o.tx_hash.toLowerCase()!==params.block_transaction_id.toLowerCase())throw new PaymentError('CALLBACK_MISMATCH','重复通知与原付款记录不一致。',409);
      return {duplicate:true,order:o};
    }
    const reusedHash=this.db.prepare("SELECT id FROM orders WHERE lower(tx_hash)=lower(?) AND id<>? AND status='paid'").get(params.block_transaction_id,o.id);
    if(reusedHash)throw new PaymentError('TRANSACTION_REUSED','链上交易已用于其他订单。',409);
    const conflict=this.db.prepare('SELECT id FROM orders WHERE paid_trade_id=? AND id<>?').get(params.trade_id,o.id);if(conflict)throw new PaymentError('TRADE_REUSED','交易号已用于其他订单。',409);
    const time=Date.now();
    this.db.prepare("UPDATE orders SET status='paid',trade_id=COALESCE(trade_id,?),paid_trade_id=?,tx_hash=?,actual_amount=?,receive_address=?,paid_at=?,updated_at=? WHERE id=?").run(params.trade_id,params.trade_id,params.block_transaction_id,String(params.actual_amount),params.receive_address,time,time,o.id);
    this.db.prepare('INSERT INTO payment_events VALUES(?,?,?)').run(o.id,digest,time);
    this.fulfillOrder(o,time);
    return {duplicate:false,order:this.order(o.id)};
  });}
  listOrders(id){return this.db.prepare('SELECT * FROM orders WHERE account_id=? ORDER BY created_at DESC LIMIT 200').all(id);}
  listGifts(id){return this.db.prepare('SELECT * FROM gifts WHERE owner_id=? ORDER BY created_at DESC LIMIT 200').all(id);}
  redeem(id,code){return this.transaction(()=>{
    const g=this.db.prepare('SELECT * FROM gifts WHERE code=?').get(code);if(!g)throw new PaymentError('GIFT_NOT_FOUND','兑换码无效。',404);
    if(g.redeemed_by)throw new PaymentError('GIFT_USED','该礼品卡已兑换。',409);
    const time=Date.now();this.db.prepare('UPDATE gifts SET redeemed_by=?,redeemed_at=? WHERE id=? AND redeemed_by IS NULL').run(id,time,g.id);
    this.db.prepare('INSERT INTO fulfillment_jobs(order_id,account_id,plan_id,months,created_at) VALUES(?,?,?,?,?)').run(g.order_id,id,g.plan_id,g.months,time);
    return {status:'pending_activation'};
  });}
  disableAccount(id){return this.transaction(()=>{this.db.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(id);this.db.prepare('DELETE FROM sessions WHERE account_id=?').run(id);});}
  health(){return this.db.prepare('SELECT id FROM accounts LIMIT 1').get();}
  expirePending(accountId){return this.db.prepare("UPDATE orders SET status='expired',updated_at=? WHERE account_id=? AND status='pending' AND expires_at IS NOT NULL AND expires_at<=?").run(Date.now(),accountId,Date.now());}
  touchOrder(id){return this.db.prepare('UPDATE orders SET updated_at=? WHERE id=?').run(Date.now(),id);}
  close(){this.db.close();}
}
