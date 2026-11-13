import {randomBytes,createHash} from 'node:crypto';
import {PaymentError} from './gmpay.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const labels = {
  open: '待回复',
  answered: '已回复',
  closed: '已关闭'
};
const keyPattern = /^[A-Za-z0-9_-]{16,100}$/;
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new PaymentError('INVALID_TICKET', '请检查内容长度和格式。');
  return value.trim();
}
function key(value) {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw new PaymentError('IDEMPOTENCY_REQUIRED', '缺少有效请求标识。');
  return value;
}
const summary = t => ({
  id: t.id,
  title: t.title,
  category: t.category,
  status: t.status,
  statusLabel: labels[t.status],
  createdAt: t.created_at,
  updatedAt: t.updated_at
});
export class PostgresTickets {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }
  async row(id, accountId) {
    const row = accountId ? await this.db.prepare('SELECT * FROM tickets WHERE id=? AND account_id=?').get(id, accountId) : await this.db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
    if (!row) throw new PaymentError('TICKET_NOT_FOUND', '工单不存在。', 404);
    return row;
  }
  async detail(id, accountId) {
    const row = await this.row(id, accountId);
    return {
      ...summary(row),
      messages: await this.db.prepare('SELECT id,author_role role,body,created_at "createdAt" FROM ticket_messages WHERE ticket_id=? ORDER BY id').all(id)
    };
  }
  async list(accountId) {
    return (await this.db.prepare('SELECT * FROM tickets WHERE account_id=? ORDER BY updated_at DESC,id DESC LIMIT 100').all(accountId)).map(summary);
  }
  async create(accountId, requestKey, body) {
    key(requestKey);
    if (!body || Object.keys(body).some(k => !['title', 'category', 'message'].includes(k)) || !['connection', 'payment', 'subscription', 'other'].includes(body.category)) throw new PaymentError('INVALID_TICKET', '工单分类或参数无效。');
    const title = text(body.title, 80),
      message = text(body.message, 4000),
      fingerprint = digest({
        title,
        category: body.category,
        message
      });
    return await this.store.transaction(async () => {
      const old = await this.db.prepare('SELECT * FROM tickets WHERE account_id=? AND request_key=?').get(accountId, requestKey);
      if (old) {
        if (old.request_hash !== fingerprint) throw new PaymentError('IDEMPOTENCY_CONFLICT', '该请求标识已用于其他内容。', 409);
        return {
          ticket: await this.detail(old.id, accountId),
          created: false
        };
      }
      if ((await this.db.prepare("SELECT count(*) n FROM tickets WHERE account_id=? AND status!='closed'").get(accountId)).n >= 10 || (await this.db.prepare('SELECT count(*) n FROM tickets WHERE account_id=? AND created_at>?').get(accountId, Date.now() - 3600000)).n >= 5) throw new PaymentError('TICKET_LIMIT', '请先处理现有工单，或稍后再提交。', 429);
      const id = 'TK' + randomBytes(12).toString('hex'),
        time = Date.now();
      await this.db.prepare("INSERT INTO tickets(id,account_id,title,category,status,request_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,'open',?,?,?,?)").run(id, accountId, title, body.category, requestKey, fingerprint, time, time);
      await this.db.prepare("INSERT INTO ticket_messages(ticket_id,author_role,body,request_key,request_hash,created_at) VALUES(?,'customer',?,?,?,?)").run(id, message, requestKey, digest(message), time);
      return {
        ticket: await this.detail(id, accountId),
        created: true
      };
    });
  }
  async append(id, accountId, role, requestKey, content) {
    key(requestKey);
    const message = text(content, 4000),
      fingerprint = digest(message);
    return await this.store.transaction(async () => {
      const ticket = await this.row(id, accountId);
      const old = await this.db.prepare('SELECT request_hash FROM ticket_messages WHERE ticket_id=? AND author_role=? AND request_key=?').get(id, role, requestKey);
      if (old) {
        if (old.request_hash !== fingerprint) throw new PaymentError('IDEMPOTENCY_CONFLICT', '该请求标识已用于其他内容。', 409);
        return await this.detail(id, accountId);
      }
      if (ticket.status === 'closed') throw new PaymentError('TICKET_CLOSED', '工单已关闭，不能继续回复。', 409);
      if ((await this.db.prepare('SELECT count(*) n FROM ticket_messages WHERE ticket_id=?').get(id)).n >= 200) throw new PaymentError('THREAD_LIMIT', '该工单消息已达上限，请新建工单。', 409);
      const time = Date.now();
      await this.db.prepare('INSERT INTO ticket_messages(ticket_id,author_role,body,request_key,request_hash,created_at) VALUES(?,?,?,?,?,?)').run(id, role, message, requestKey, fingerprint, time);
      await this.db.prepare('UPDATE tickets SET status=?,updated_at=? WHERE id=?').run(role === 'support' ? 'answered' : 'open', time, id);
      return await this.detail(id, accountId);
    });
  }
  async userReply(id, accountId, requestKey, body) {
    if (!body || Object.keys(body).some(k => k !== 'message')) throw new PaymentError('INVALID_TICKET', '回复参数无效。');
    return await this.append(id, accountId, 'customer', requestKey, body.message);
  }
  async adminReply(id, requestKey, message) {
    return await this.append(id, null, 'support', requestKey, message);
  }
  async close(id, accountId) {
    return await this.store.transaction(async () => {
      await this.row(id, accountId);
      await this.db.prepare("UPDATE tickets SET status='closed',updated_at=? WHERE id=? AND status!='closed'").run(Date.now(), id);
      return await this.detail(id, accountId);
    });
  }
}
