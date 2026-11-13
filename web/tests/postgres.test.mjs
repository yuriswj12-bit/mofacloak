import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {PostgresDatabase,connectionOptions,safeInteger} from '../server/postgres-db.mjs';
import {PostgresStore} from '../server/postgres-store.mjs';
import {PostgresTickets} from '../server/postgres-tickets.mjs';
import {createApp} from '../server/app.mjs';
import {loadConfig} from '../server/config.mjs';
import {sign,verify} from '../server/gmpay.mjs';
import {openStore,hash} from '../server/store.mjs';
import {Tickets} from '../server/tickets.mjs';
import {copyPortal} from '../scripts/migrate-supabase.mjs';

test('PostgreSQL schema protects all portal tables from anonymous users',async()=>{
  const engine=await PGlite.create({parsers:{20:safeInteger}});
  try{
    await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    await engine.exec(readFileSync(new URL('../../supabase/migrations/20261107160000_cloak.sql',import.meta.url),'utf8'));
    await engine.exec(readFileSync(new URL('../../supabase/migrations/20261108040000_binance_uid.sql',import.meta.url),'utf8'));
    const tables=(await engine.query("SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='cloak'")).rows;
    assert.equal(tables.length,9);assert.ok(tables.every(t=>t.rowsecurity));
    await engine.exec('SET ROLE anon');
    await assert.rejects(()=>engine.query('SELECT * FROM cloak.accounts'),e=>e.code==='42501');
    await engine.exec('RESET ROLE; SET ROLE authenticated');
    await assert.rejects(()=>engine.query('SELECT * FROM cloak.orders'),e=>e.code==='42501');
    await engine.exec('RESET ROLE; SET ROLE cloak_app');
    assert.equal((await engine.query('SELECT * FROM cloak.accounts')).rows.length,0);
    await assert.rejects(()=>engine.query('CREATE TABLE cloak.forbidden(id integer)'),e=>e.code==='42501');
  }finally{await engine.close();}
});

test('PostgreSQL account, order, signed receipt, gift and ticket contracts work end to end',async()=>{
  // This is an isolated PostgreSQL engine, not a production gateway or fabricated live receipt.
  const engine=await PGlite.create({parsers:{20:safeInteger}});
  const db=new PostgresDatabase({query:(...args)=>engine.query(...args),end:()=>engine.close()});
  db.transaction=fn=>engine.transaction(tx=>db.context.run(tx,fn));
  const store=new PostgresStore(db);store.tickets=new PostgresTickets(store);
  try{
    await engine.exec(readFileSync(new URL('../../supabase/migrations/20261107160000_cloak.sql',import.meta.url),'utf8'));
    await engine.exec(readFileSync(new URL('../../supabase/migrations/20261108040000_binance_uid.sql',import.meta.url),'utf8'));
    const config=loadConfig({PAYMENTS_ENABLED:'true',PUBLIC_ORIGIN:'https://merchant.example',GMPAY_BASE_URL:'https://pay.example',GMPAY_PID:'1000',GMPAY_SECRET_KEY:'postgres-test-only-secret',PAYMENT_CATALOG_FILE:'config/payment-catalog.confirmed.json'});
    config.plans[0].monthlyCurrency='USD';config.plans[0].priceCents=500;
    const alice=await store.createAccount('isolated-alice'),bob=await store.createAccount('isolated-bob');
    const gateway={create:async o=>({trade_id:'trade_'+o.id,payment_url:'https://pay.example/cashier/'+o.id,actual_amount:5,receive_address:'0x'+'1'.repeat(40),expiration_time:Math.floor(Date.now()/1000)+600})};
    const app=createApp({config,store,gateway});
    const call=(path,{method='GET',data,cookie,key}={})=>app(new Request(config.origin+'/api/v1'+path,{method,headers:{origin:config.origin,'content-type':'application/json',...(cookie?{cookie}:{}),...(key?{'idempotency-key':key}:{})},...(data?{body:JSON.stringify(data)}:{})}));
    const login=async a=>{const r=await call('/auth/login',{method:'POST',data:{accessCode:a.accessCode}});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
    const cookie=await login(alice),other=await login(bob);
    assert.equal((await call('/health')).status,200);
    const body={planId:'select',cycle:'month',kind:'plan'};
    const result=await call('/orders',{method:'POST',cookie,key:'postgres-plan-request-001',data:body});assert.equal(result.status,201);
    const order=(await result.json()).order;assert.equal(order.currency,'USD');assert.equal(order.amount,5);
    assert.equal((await call('/orders/'+order.id,{cookie:other})).status,404);
    const retried=await (await call('/orders',{method:'POST',cookie,key:'postgres-plan-request-001',data:body})).json();assert.equal(retried.order.id,order.id);
    const event=o=>{const p={pid:'1000',order_id:o.id,trade_id:o.tradeId,amount:o.amount,token:'USDT',status:2,actual_amount:5,receive_address:'0x'+'1'.repeat(40),block_transaction_id:'0x'+o.id.slice(2).padEnd(64,'0')};p.signature=sign(p,config.secret);return p;};
    const receipt=event(order);assert.ok(verify(receipt,config.secret));
    for(let i=0;i<2;i++)assert.equal((await call('/payments/gmpay/notify',{method:'POST',data:receipt})).status,200);
    assert.equal((await db.prepare('SELECT count(*) n FROM payment_events').get()).n,1);
    assert.equal((await db.prepare('SELECT count(*) n FROM fulfillment_jobs').get()).n,1);
    const account=(await (await call('/account',{cookie})).json());assert.equal(account.orders[0].paymentStatus,'paid');assert.equal(account.orders[0].fulfillmentStatus,'pending_activation');assert.equal(account.subscription,null);
    const giftOrder=(await (await call('/orders',{method:'POST',cookie,key:'postgres-gift-request-001',data:{...body,kind:'gift'}})).json()).order;
    assert.equal((await call('/payments/gmpay/notify',{method:'POST',data:event(giftOrder)})).status,200);
    const gifts=await store.listGifts(alice.id);assert.equal(gifts.length,1);
    const redeemed=await call('/gifts/redeem',{method:'POST',cookie:other,data:{code:gifts[0].code}});assert.equal(redeemed.status,200);
    assert.equal((await call('/gifts/redeem',{method:'POST',cookie:other,data:{code:gifts[0].code}})).status,409);
    const created=await call('/tickets',{method:'POST',cookie,key:'postgres-ticket-request-001',data:{title:'Isolated test',category:'other',message:'PostgreSQL contract validation'}});
    assert.equal(created.status,201);const ticket=(await created.json()).ticket;assert.ok(Number.isSafeInteger(ticket.messages[0].createdAt));
    assert.equal((await call('/tickets/'+ticket.id,{cookie:other})).status,404);
    await store.tickets.adminReply(ticket.id,'postgres-support-request-001','Reply in isolated test database');
    const detail=(await (await call('/tickets/'+ticket.id,{cookie})).json()).ticket;assert.equal(detail.status,'answered');assert.equal(detail.messages[1].role,'support');
    assert.equal((await call('/tickets/'+ticket.id+'/close',{method:'POST',cookie,data:{}})).status,200);
    assert.equal((await call('/auth/logout',{method:'POST',cookie,data:{}})).status,200);
    assert.equal((await call('/account',{cookie})).status,401);
  }finally{await store.close();}
});

test('PostgreSQL driver verifies TLS and pins each transaction to one client',async()=>{
  const options=connectionOptions({databaseURL:'postgresql://role:password@database.example:5432/postgres'});
  assert.equal(options.ssl.rejectUnauthorized,true);
  assert.throws(()=>connectionOptions({databaseURL:'postgresql://role:password@database.example/postgres?sslmode=disable'}));
  assert.throws(()=>safeInteger('9007199254740992'));
  const calls=[];let released=0;
  const client={query:async(sql,params)=>{calls.push({sql,params});return {rows:[{n:1}],rowCount:1};},release:()=>released++};
  const db=new PostgresDatabase({connect:async()=>client,query:()=>{throw Error('transaction escaped to pool');}});
  await db.transaction(async()=>assert.equal((await db.prepare('SELECT count(*) n FROM orders WHERE account_id=?').get('owner')).n,1));
  assert.deepEqual(calls.map(c=>c.sql),['BEGIN ISOLATION LEVEL SERIALIZABLE','SELECT count(*) n FROM cloak.orders WHERE account_id=$1','COMMIT']);
  assert.equal(released,1);
});

test('SQLite migration preserves identities, session hashes, orders and ticket messages atomically',async()=>{
  const source=openStore(':memory:'),engine=await PGlite.create({parsers:{20:safeInteger}});
  const db=new PostgresDatabase({query:(...args)=>engine.query(...args),end:()=>engine.close()});
  db.transaction=fn=>engine.transaction(tx=>db.context.run(tx,fn));
  try{
    await engine.exec(readFileSync(new URL('../../supabase/migrations/20261107160000_cloak.sql',import.meta.url),'utf8'));
    await engine.exec(readFileSync(new URL('../../supabase/migrations/20261108040000_binance_uid.sql',import.meta.url),'utf8'));
    const account=source.createAccount('migration-fixture'),session=source.login(account.accessCode);
    const ticket=new Tickets(source).create(account.id,'migration-ticket-key-001',{title:'Migration check',category:'other',message:'Preserve this isolated message'}).ticket;
    const config=loadConfig({PAYMENT_CATALOG_FILE:'config/payment-catalog.confirmed.json'}),plan=config.plans[0];
    source.createOrder(account.id,'migration-order-key-001','migration-fingerprint',{plan,name:'Migration order',amount_cents:7990,months:1,kind:'plan'},'month','1000');
    const report=await copyPortal(source.db,db);assert.equal(report.length,9);
    const target=new PostgresStore(db),tickets=new PostgresTickets(target);
    assert.equal((await target.account(session.session)).id,account.id);
    assert.equal((await target.login(account.accessCode)).account.id,account.id);
    assert.equal((await target.listOrders(account.id))[0].amount_cents,7990);
    assert.equal((await tickets.detail(ticket.id,account.id)).messages[0].body,'Preserve this isolated message');
    const added=await tickets.userReply(ticket.id,account.id,'migration-followup-key-001',{message:'Sequence continues after imported ids'});
    assert.equal(added.messages[1].id,2);
    await assert.rejects(()=>copyPortal(source.db,db),/must be empty/);
    assert.equal((await db.prepare('SELECT count(*) n FROM accounts').get()).n,1);
    assert.equal((await target.account(session.session)).id,account.id);
  }finally{source.close();await db.close();}
});

test('failed import rolls all destination tables back and leaves source records intact',async()=>{
  const source=openStore(':memory:'),engine=await PGlite.create({parsers:{20:safeInteger}});
  const db=new PostgresDatabase({query:(...args)=>engine.query(...args),end:()=>engine.close()});
  db.transaction=fn=>engine.transaction(tx=>db.context.run(tx,fn));
  try{
    await engine.exec(readFileSync(new URL('../../supabase/migrations/20261107160000_cloak.sql',import.meta.url),'utf8'));
    await engine.exec(readFileSync(new URL('../../supabase/migrations/20261108040000_binance_uid.sql',import.meta.url),'utf8'));
    const account=source.createAccount('rollback-fixture');
    const o=source.createOrder(account.id,'migration-invalid-key-01','fp',{plan:{id:'select'},name:'Isolated invalid import',amount_cents:0,months:1,kind:'plan'},'month','1000').order;
    await assert.rejects(()=>copyPortal(source.db,db));
    assert.equal((await db.prepare('SELECT count(*) n FROM accounts').get()).n,0);
    assert.equal(source.order(o.id).amount_cents,0);
    assert.equal(source.db.prepare('SELECT count(*) n FROM accounts').get().n,1);
  }finally{source.close();await db.close();}
});
