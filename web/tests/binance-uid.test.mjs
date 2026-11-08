import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {openStore} from '../server/store.mjs';
import {PostgresDatabase,safeInteger} from '../server/postgres-db.mjs';
import {PostgresStore} from '../server/postgres-store.mjs';
import {loadConfig} from '../server/config.mjs';
import {createApp} from '../server/app.mjs';
import {uidQuote} from '../server/binance-uid.mjs';

test('UID configuration fails closed and live quotes must be fresh',async()=>{
  assert.equal(loadConfig({}).binanceEnabled,false);
  assert.throws(()=>loadConfig({BINANCE_UID_ENABLED:'true'}));
  assert.throws(()=>loadConfig({BINANCE_RECEIVE_UID:'0x1234'}));
  const config={binanceEnabled:true,binanceUid:'123456789',rateURL:'https://rates.example/latest'};
  const body={planId:'select',cycle:'month'};
  await assert.rejects(()=>uidQuote({...config,binanceEnabled:false},{},body));
  await assert.rejects(()=>uidQuote(config,{current:async()=>({available:false})},body));
  await assert.rejects(()=>uidQuote(config,{current:async()=>({available:true,sourceDate:'2020-01-01',plans:[{id:'select',month:10}]})},body));
});

for(const provider of ['sqlite','postgres'])test(provider+': UID payments require real admin review and remain isolated from GM Pay',async()=>{
  let store;
  if(provider==='sqlite')store=openStore(':memory:');
  else{
    const engine=await PGlite.create({parsers:{20:safeInteger}});
    for(const file of ['20261107160000_cloak.sql','20261108040000_binance_uid.sql'])await engine.exec(readFileSync(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
    const db=new PostgresDatabase({query:(...args)=>engine.query(...args),end:()=>engine.close()});
    db.transaction=fn=>engine.transaction(tx=>db.context.run(tx,fn));store=new PostgresStore(db);
  }
  try{
    const config=loadConfig({PAYMENTS_ENABLED:'false',PUBLIC_ORIGIN:'https://merchant.example',BINANCE_UID_ENABLED:'true',BINANCE_RECEIVE_UID:'123456789',PAYMENT_CATALOG_FILE:'config/payment-catalog.confirmed.json'});
    const alice=await store.createAccount('isolated uid payer'),bob=await store.createAccount('other account');
    let gatewayCalls=0,quoteCalls=0;
    const quoteService={current:async()=>{quoteCalls++;return {available:true,sourceDate:new Date().toISOString().slice(0,10),plans:[{id:'select',month:10,year:100}]};}};
    const app=createApp({config,store,quoteService,gateway:{create:async()=>{gatewayCalls++;throw Error('must never reach GM Pay');}}});
    const call=(path,{method='GET',cookie,key,data}={})=>app(new Request(config.origin+'/api/v1'+path,{method,headers:{origin:config.origin,'content-type':'application/json',...(cookie?{cookie}:{}),...(key?{'idempotency-key':key}:{})},...(data?{body:JSON.stringify(data)}:{})}));
    const login=async a=>(await call('/auth/login',{method:'POST',data:{accessCode:a.accessCode}})).headers.get('set-cookie').split(';')[0];
    const cookie=await login(alice),other=await login(bob),data={planId:'select',cycle:'month',kind:'plan'},key='binance-isolated-order-0001';
    let r=await call('/orders/binance',{method:'POST',cookie,key,data});assert.equal(r.status,201);const o=(await r.json()).order;
    assert.equal(o.channel,'binance_uid');assert.equal(o.binanceUid,'123456789');assert.equal(o.actualAmount,'10.00');assert.equal(o.paymentStatus,'pending');assert.equal(o.paymentUrl,null);assert.equal(gatewayCalls,0);
    r=await call('/orders/binance',{method:'POST',cookie,key,data});assert.equal((await r.json()).order.id,o.id);assert.equal(quoteCalls,1);
    assert.equal((await call('/orders/binance',{method:'POST',cookie,key,data:{...data,kind:'gift'}})).status,409);
    assert.equal((await call('/orders/'+o.id,{cookie:other})).status,404);
    assert.equal((await call('/orders/'+o.id+'/binance-claim',{method:'POST',cookie:other,data:{transactionId:'M_PAY_ISOLATED_001'}})).status,404);
    assert.equal((await call('/orders/'+o.id+'/binance-claim',{method:'POST',cookie,data:{transactionId:'M_PAY_ISOLATED_001',paid:true}})).status,400);
    const proof={receiverUid:'123456789',currency:'USDT',transactionId:'M_PAY_ISOLATED_001',receivedAmount:'10.00',reviewer:'isolated reviewer',evidenceRef:'isolated evidence fixture only'};
    await assert.rejects(async()=>store.confirmManualPayment(o.id,proof),e=>e.code==='CLAIM_REQUIRED');
    r=await call('/orders/'+o.id+'/binance-claim',{method:'POST',cookie,data:{transactionId:proof.transactionId}});assert.equal((await r.json()).order.paymentStatus,'review');
    assert.equal((await store.db.prepare('SELECT count(*) n FROM fulfillment_jobs').get()).n,0);
    assert.equal((await store.db.prepare('SELECT count(*) n FROM payment_events').get()).n,0);
    await assert.rejects(async()=>store.confirmManualPayment(o.id,{...proof,receivedAmount:'9.85'}),e=>e.code==='AMOUNT_MISMATCH');
    await assert.rejects(async()=>store.confirmManualPayment(o.id,{...proof,receiverUid:'999999999'}),e=>e.code==='INVALID_PROOF');
    assert.equal((await store.order(o.id)).status,'review');
    assert.equal((await store.confirmManualPayment(o.id,proof)).duplicate,false);
    assert.equal((await store.confirmManualPayment(o.id,proof)).duplicate,true);
    assert.equal((await store.db.prepare('SELECT count(*) n FROM fulfillment_jobs').get()).n,1);
    assert.equal((await store.db.prepare('SELECT count(*) n FROM payment_events').get()).n,1);
    const paid=(await (await call('/orders/'+o.id,{cookie})).json()).order;assert.equal(paid.paymentStatus,'paid');assert.equal(paid.txHash,null);assert.equal(paid.binanceTransactionId,proof.transactionId);
    const second=(await (await call('/orders/binance',{method:'POST',cookie,key:'binance-isolated-order-0002',data:{...data,kind:'gift'}})).json()).order;
    await store.submitManualPayment(second.id,alice.id,proof.transactionId);
    await assert.rejects(async()=>store.confirmManualPayment(second.id,proof),e=>e.code==='TRANSACTION_REUSED');
    assert.equal((await store.order(second.id)).status,'review');
    assert.equal((await store.db.prepare('SELECT count(*) n FROM gifts').get()).n,0);
    assert.equal(gatewayCalls,0);
  }finally{await store.close();}
});
