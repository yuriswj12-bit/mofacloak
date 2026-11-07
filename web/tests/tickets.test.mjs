import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {openStore} from '../server/store.mjs';
import {Tickets} from '../server/tickets.mjs';
import {createApp} from '../server/app.mjs';
import {loadConfig} from '../server/config.mjs';

const content={title:'连接问题验收',category:'connection',message:'隔离测试数据库中的问题描述。'};
function setup(t){
  const store=openStore(':memory:');t.after(()=>store.close());
  const first=store.createAccount('test-owner'),second=store.createAccount('test-other');
  const config=loadConfig({}),handle=createApp({config,store});
  const firstCookie='cloak_session='+store.login(first.accessCode).session,secondCookie='cloak_session='+store.login(second.accessCode).session;
  const call=(path,{method='GET',body,cookie=firstCookie,key='ticket-request-000001',origin=config.origin}={})=>handle(new Request(config.origin+'/api/v1'+path,{method,headers:{origin,'content-type':'application/json',cookie,'idempotency-key':key},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
  return {store,first,second,firstCookie,secondCookie,call,tickets:new Tickets(store)};
}
test('ticket creation works with payments disabled and never creates payment records',async t=>{
  const s=setup(t),response=await s.call('/tickets',{method:'POST',body:content});assert.equal(response.status,201);
  const data=await response.json();assert.match(data.ticket.id,/^TK[a-f0-9]{24}$/);assert.equal(data.ticket.messages[0].role,'customer');assert.equal(data.ticket.status,'open');
  for(const table of ['orders','payment_events','fulfillment_jobs'])assert.equal(s.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
test('ticket and thread reads and writes are scoped to the authenticated account',async t=>{
  const s=setup(t),id=s.tickets.create(s.first.id,'ticket-owner-key-001',content).ticket.id;
  assert.equal((await s.call('/tickets',{cookie:''})).status,401);
  for(const [path,method,body] of [[`/tickets/${id}`,'GET'],[`/tickets/${id}/messages`,'POST',{message:'forbidden'}],[`/tickets/${id}/close`,'POST',{}]]){
    assert.equal((await s.call(path,{method,body,cookie:s.secondCookie})).status,404);
  }
  assert.deepEqual((await(await s.call('/tickets',{cookie:s.secondCookie})).json()).tickets,[]);
  assert.equal((await s.call('/tickets',{method:'POST',body:content,origin:'https://not-our-site.net'})).status,403);
});
test('create and reply retries are idempotent and reject changed content under the same key',async t=>{
  const s=setup(t),first=await(await s.call('/tickets',{method:'POST',body:content})).json();
  assert.equal((await s.call('/tickets',{method:'POST',body:content})).status,200);
  assert.equal((await s.call('/tickets',{method:'POST',body:{...content,title:'different'}})).status,409);
  const path='/tickets/'+first.ticket.id+'/messages';
  for(let i=0;i<2;i++)assert.equal((await s.call(path,{method:'POST',key:'reply-request-key-001',body:{message:'补充描述'}})).status,200);
  assert.equal((await s.call(path,{method:'POST',key:'reply-request-key-001',body:{message:'changed'}})).status,409);
  assert.equal(s.tickets.detail(first.ticket.id,s.first.id).messages.length,2);
});
test('support replies, customer follow-up and closure have real persisted state transitions',async t=>{
  const s=setup(t),id=s.tickets.create(s.first.id,'ticket-workflow-key-01',content).ticket.id;
  s.tickets.adminReply(id,'support-reply-key-001','管理员在隔离环境的回复');assert.equal(s.tickets.detail(id,s.first.id).status,'answered');
  s.tickets.userReply(id,s.first.id,'customer-reply-key-01',{message:'仍需补充说明'});assert.equal(s.tickets.detail(id,s.first.id).status,'open');
  const response=await s.call('/tickets/'+id+'/close',{method:'POST',body:{}});assert.equal(response.status,200);
  assert.equal((await s.call('/tickets/'+id+'/close',{method:'POST',body:{}})).status,200);
  assert.equal((await s.call('/tickets/'+id+'/messages',{method:'POST',body:{message:'closed'}})).status,409);
  assert.throws(()=>s.tickets.adminReply(id,'support-after-close-01','closed'),e=>e.code==='TICKET_CLOSED');
});
test('invalid inputs and customer attempts to forge support roles are rejected',async t=>{
  const s=setup(t);
  for(const body of [{...content,title:' '},{...content,message:'x'.repeat(4001)},{...content,category:'administrator'},{...content,role:'support'}])assert.equal((await s.call('/tickets',{method:'POST',body})).status,400);
  const id=s.tickets.create(s.first.id,'valid-ticket-key-001',content).ticket.id;
  assert.equal((await s.call('/tickets/'+id+'/messages',{method:'POST',body:{message:'forge',role:'support'}})).status,400);
  assert.equal(s.tickets.detail(id,s.first.id).messages.length,1);
});
test('creation quota is stored in SQLite rather than reset with the HTTP app',t=>{
  const s=setup(t);
  for(let i=0;i<5;i++)s.tickets.create(s.first.id,`quota-ticket-key-${i}`,content);
  assert.throws(()=>new Tickets(s.store).create(s.first.id,'quota-ticket-key-6',content),e=>e.code==='TICKET_LIMIT');
});
test('real administrator CLI replies via a file and ticket content survives database reopen',t=>{
  const dir=mkdtempSync(join(tmpdir(),'mofacloak-ticket-cli-'));
  t.after(()=>{assert.equal(dirname(dir),resolve(tmpdir()));assert.ok(dir.startsWith(join(resolve(tmpdir()),'mofacloak-ticket-cli-')));rmSync(dir,{recursive:true,force:true});});
  const path=join(dir,'portal.sqlite'),store=openStore(path),account=store.createAccount('cli-test');
  const id=new Tickets(store).create(account.id,'cli-ticket-key-0001',content).ticket.id;store.close();
  const body='多行回复\n保留原文 `$() <b>plain text</b>';const file=join(dir,'reply.txt');writeFileSync(file,body);
  const result=spawnSync(process.execPath,['server/manage.mjs','ticket:reply',id,file],{cwd:new URL('..',import.meta.url),env:{...process.env,DATABASE_PATH:path,PAYMENTS_ENABLED:'false',NODE_ENV:'development',PUBLIC_ORIGIN:'http://127.0.0.1:4173'},encoding:'utf8'});
  assert.equal(result.status,0);const reopened=openStore(path);
  try{const ticket=new Tickets(reopened).detail(id,account.id);assert.equal(ticket.status,'answered');assert.equal(ticket.messages[1].body,body);assert.equal(ticket.messages[1].role,'support');}finally{reopened.close();}
});
