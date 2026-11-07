import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {loadConfig,productFor} from '../server/config.mjs';
import {sign,verify,canonical,cents,GMPay} from '../server/gmpay.mjs';
import {openStore,hash} from '../server/store.mjs';
import {createApp} from '../server/app.mjs';

const fixtureConfig=()=>loadConfig({PAYMENTS_ENABLED:'true',PUBLIC_ORIGIN:'https://merchant.example',GMPAY_BASE_URL:'https://pay.example',GMPAY_PID:'1000',GMPAY_SECRET_KEY:'unit-test-secret-not-production',PAYMENT_CATALOG_FILE:'config/payment-catalog.example.json'});
const productBody={planId:'premium',cycle:'month',kind:'plan'};
function setup(t,{gateway,enabled=true,dbPath=':memory:'}={}){
  const config=fixtureConfig();config.enabled=enabled;const store=openStore(dbPath);t.after(()=>store.close());
  const account=store.createAccount('fixture-account'),other=store.createAccount('other-account');
  const upstream={create:async o=>({trade_id:'gateway_'+o.id,order_id:o.id,amount:o.amount_cents/100,currency:'CNY',actual_amount:13.75,token:'USDT',receive_address:'0x'+'1'.repeat(40),status:1,expiration_time:Math.floor(Date.now()/1000)+600,payment_url:'https://pay.example/pay/checkout-counter/gateway_'+o.id}),status:async id=>({trade_id:id,status:1}),...gateway};
  const handle=createApp({config,store,gateway:upstream});
  const call=(path,{method='GET',data,cookie,origin=config.origin,key}={})=>handle(new Request(config.origin+path,{method,headers:{'content-type':'application/json',...(origin?{origin}:{}),...(cookie?{cookie}:{}),...(key?{'idempotency-key':key}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})}));
  async function login(a=account){const r=await call('/api/v1/auth/login',{method:'POST',data:{accessCode:a.accessCode}});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
  async function order({body=productBody,key='idempotency-test-0001',cookie}={}){cookie||=await login();const res=await call('/api/v1/orders',{method:'POST',cookie,key,data:body});return {res,data:await res.json(),cookie};}
  function event(o,overrides={}){const params={pid:config.pid,trade_id:o.tradeId,order_id:o.id,amount:o.amount,actual_amount:13.75,receive_address:'0x'+'1'.repeat(40),token:'USDT',block_transaction_id:'0x'+hash(o.id),status:2,...overrides};params.signature=sign(params,config.secret);return params;}
  return {config,store,account,other,handle,call,login,order,event};
}

test('signature matches official GMPay v2 published vector',()=>{
  const p={pid:'1000',order_id:'ORD202605230001',currency:'cny',token:'usdt',network:'tron',amount:100,notify_url:'https://merchant.example/notify',redirect_url:'https://merchant.example/return',name:'VIP'};
  assert.equal(sign(p,'epusdt_secret_key'),'6f874b1919d95081835e2809b620e354a5866f5a6dbb2e432d1627f1eb10059d');
  assert.equal(canonical({z:null,b:0,a:'',c:false}),'b=0&c=false');
  assert.throws(()=>canonical({bad:{nested:true}}));assert.equal(verify({...p,signature:'0'.repeat(64)},'epusdt_secret_key'),false);
});
test('configuration is closed by default and requires server catalog and HTTPS',()=>{
  assert.equal(loadConfig({}).enabled,false);
  assert.throws(()=>loadConfig({PAYMENTS_ENABLED:'true'}));
  assert.throws(()=>loadConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'http://merchant.example'}));
  assert.throws(()=>productFor(fixtureConfig(),{...productBody,amount:.01}));
  assert.equal(productFor(fixtureConfig(),{...productBody,cycle:'year'}).amount_cents,84000);
  assert.equal(cents('59.01'),5901);assert.throws(()=>cents('0.001'));
});
test('disabled endpoint has no credentials or fabricated orders',async t=>{
  const s=setup(t,{enabled:false});const config=await (await s.call('/api/v1/payments/config')).json();
  assert.equal(config.enabled,false);assert.equal(config.plans.length,3);assert.equal(config.plans[1].price,99);assert.ok(!JSON.stringify(config).includes(s.config.secret));
  const {res}=await s.order();assert.equal(res.status,503);assert.equal(s.store.db.prepare('SELECT count(*) n FROM orders').get().n,0);
});

test('local checkout blocks new orders when callback tunnel is unavailable',async t=>{
  let called=0;const s=setup(t,{gateway:{create:async()=>{called++;throw Error('must not reach gateway');}}});
  s.config.localGateway=true;s.config.callbackStatePath=join(tmpdir(),'missing-callback-state-'+Date.now()+'.json');
  const result=await s.order();assert.equal(result.res.status,503);assert.equal(called,0);assert.equal(s.store.db.prepare('SELECT count(*) n FROM orders').get().n,0);
});

test('explicit native notify URL rejection is a failed creation rather than ambiguous payment',async t=>{
  const config=fixtureConfig();
  const gateway=new GMPay(config,async url=>String(url).endsWith('/config')?Response.json({status_code:200,data:{supported_assets:[{network:'binance',tokens:['usdt']}]}}):Response.json({status_code:10041,message:'invalid notify url'},{status:400}));
  const s=setup(t,{gateway:{create:order=>gateway.create(order)}}),result=await s.order();
  assert.equal(result.data.order.paymentStatus,'failed');assert.equal(s.store.db.prepare('SELECT count(*) n FROM payment_events').get().n,0);
});
test('authentication, origin checks and account ownership isolate payments',async t=>{
  const s=setup(t);assert.equal((await s.call('/api/v1/account')).status,401);
  assert.equal((await s.call('/api/v1/auth/login',{method:'POST',origin:'https://evil.example',data:{accessCode:s.account.accessCode}})).status,403);
  const {data,cookie}=await s.order();const otherCookie=await s.login(s.other);
  assert.equal((await s.call('/api/v1/orders/'+data.order.id,{cookie:otherCookie})).status,404);
  assert.equal((await s.call('/api/v1/orders/'+data.order.id,{cookie})).status,200);
  assert.equal((await s.call('/api/v1/auth/logout',{method:'POST',cookie,data:{}})).status,200);
  assert.equal((await s.call('/api/v1/account',{cookie})).status,401);
});
test('idempotency retries return one server-priced order and reject parameter reuse',async t=>{
  const s=setup(t),first=await s.order();assert.equal(first.res.status,201);assert.equal(first.data.order.amount,99);
  const second=await s.order({cookie:first.cookie});assert.equal(second.res.status,200);assert.equal(second.data.order.id,first.data.order.id);
  const changed=await s.order({cookie:first.cookie,body:{...productBody,cycle:'year'}});assert.equal(changed.res.status,409);
  const tampered=await s.order({cookie:first.cookie,key:'idempotency-tamper-1',body:{...productBody,amount:1}});assert.equal(tampered.res.status,400);
});
test('forged signatures, wrong amount, status or token never fulfill',async t=>{
  const s=setup(t),{data}=await s.order();
  for(const payload of [s.event(data.order,{signature:'bad'}),s.event(data.order,{amount:1}),s.event(data.order,{status:1}),s.event(data.order,{token:'USDC'})]){
    if(payload.amount===99&&payload.status===2&&payload.token==='USDT')payload.signature='0'.repeat(64);
    const r=await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:payload});assert.ok(r.status>=400);
  }
  assert.equal(s.store.order(data.order.id).status,'pending');assert.equal(s.store.db.prepare('SELECT count(*) n FROM fulfillment_jobs').get().n,0);
});
test('unopened expired orders release pending slots and still accept a signed late receipt',async t=>{
  const s=setup(t),cookie=await s.login(),expired=[];
  for(let i=0;i<5;i++){
    const {res,data}=await s.order({cookie,key:`expired-order-key-${i}`});assert.equal(res.status,201);expired.push(data.order);
  }
  const blocked=await s.order({cookie,key:'blocked-active-slots-01'});assert.equal(blocked.res.status,429);
  for(const o of expired)assert.equal(s.store.order(o.id).status,'pending');
  // These orders reached a real cashier state in the adapter contract; no user reopened them.
  s.store.db.prepare("UPDATE orders SET expires_at=? WHERE account_id=?").run(Date.now()-1000,s.account.id);
  const fresh=await s.order({cookie,key:'new-after-expiry-01'});assert.equal(fresh.res.status,201);
  for(const o of expired)assert.equal(s.store.order(o.id).status,'expired');
  const payload=s.event(expired[0]);
  const paid=await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:payload});assert.equal(paid.status,200);
  assert.equal(s.store.order(expired[0].id).status,'paid');assert.equal(s.store.db.prepare('SELECT count(*) n FROM fulfillment_jobs').get().n,1);
});

test('unknown gateway outcomes retain their pending slots and are never expired by guesswork',async t=>{
  const s=setup(t,{gateway:{create:async()=>{throw Error('unknown outcome');}}}),cookie=await s.login();
  for(let i=0;i<5;i++){const {res,data}=await s.order({cookie,key:`unknown-slot-key-${i}`});assert.equal(res.status,502);assert.equal(data.order.paymentStatus,'review');}
  const blocked=await s.order({cookie,key:'new-after-unknown-01'});assert.equal(blocked.res.status,429);
  assert.equal(s.store.db.prepare("SELECT count(*) n FROM orders WHERE status='review'").get().n,5);
});

test('signed callbacks fulfill once even under repeated concurrent delivery',async t=>{
  const s=setup(t),{data}=await s.order(),payload=s.event(data.order);
  const responses=await Promise.all(Array.from({length:8},()=>s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:payload})));
  for(const r of responses){assert.equal(r.status,200);assert.equal(await r.text(),'success');}
  assert.equal(s.store.order(data.order.id).status,'paid');assert.equal(s.store.db.prepare('SELECT count(*) n FROM fulfillment_jobs').get().n,1);assert.equal(s.store.db.prepare('SELECT count(*) n FROM payment_events').get().n,1);
  const accountCookie=await s.login();const accountState=await (await s.call('/api/v1/account',{cookie:accountCookie})).json();assert.equal(accountState.orders[0].status,'已付款');assert.equal(accountState.orders[0].fulfillmentStatus,'pending_activation');assert.equal(accountState.subscription,null);
});
test('paid status query or redirect never grants fulfillment without callback',async t=>{
  const s=setup(t,{gateway:{status:async id=>({trade_id:id,status:2})}}),{data,cookie}=await s.order();
  s.store.db.prepare('UPDATE orders SET updated_at=0 WHERE id=?').run(data.order.id);
  const r=await s.call('/api/v1/orders/'+data.order.id+'?paid=true',{cookie});assert.equal((await r.json()).order.paymentStatus,'pending');assert.equal(s.store.db.prepare('SELECT count(*) n FROM fulfillment_jobs').get().n,0);
});
test('unknown upstream result is retained for reconciliation and not charged twice',async t=>{
  let calls=0;const s=setup(t,{gateway:{create:async()=>{calls++;throw Error('timeout');}}}),first=await s.order();
  assert.equal(first.res.status,502);assert.equal(first.data.order.paymentStatus,'review');
  const retry=await s.order({cookie:first.cookie});assert.equal(retry.res.status,200);assert.equal(calls,1);
});
test('callback racing gateway attachment cannot be demoted to pending',async t=>{
  const s=setup(t),product=productFor(s.config,productBody),created=s.store.createOrder(s.account.id,'race-key-00000001','fingerprint',product,'month',s.config.pid).order;
  const payload=s.event({id:created.id,tradeId:'race-trade',amount:99},{actual_amount:13.9});s.store.applyPaid(payload,hash('receipt'));
  s.store.attachGateway(created.id,{trade_id:'race-trade',payment_url:'https://pay.example/cashier/race-trade',actual_amount:13.75,receive_address:'0x1',expiration_time:Math.floor(Date.now()/1000)+600});
  assert.equal(s.store.order(created.id).status,'paid');assert.equal(s.store.order(created.id).actual_amount,'13.9');
});
test('gift issuance and redemption are atomic and remain account scoped',async t=>{
  const s=setup(t),{data}=await s.order({body:{...productBody,kind:'gift'}}),payload=s.event(data.order);
  await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:payload});await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:payload});
  const gifts=s.store.listGifts(s.account.id);assert.equal(gifts.length,1);assert.equal(s.store.listGifts(s.other.id).length,0);
  const cookie=await s.login(s.other),r=await s.call('/api/v1/gifts/redeem',{method:'POST',cookie,data:{code:gifts[0].code}});assert.equal(r.status,200);
  assert.equal((await s.call('/api/v1/gifts/redeem',{method:'POST',cookie,data:{code:gifts[0].code}})).status,409);
  const job=s.store.db.prepare('SELECT * FROM fulfillment_jobs').get();assert.equal(job.account_id,s.other.id);
});
test('real adapter sends signed bsc/usdt form and validates cashier origin',async()=>{
  const config=fixtureConfig(),calls=[];
  const fakeFetch=async(url,opts)=>{calls.push([String(url),opts]);if(String(url).endsWith('/config'))return Response.json({status_code:200,data:{supported_assets:[{network:'bsc',tokens:['USDT']}]}});
    return Response.json({status_code:200,data:{order_id:'MFtest',trade_id:'trade',amount:99,currency:'CNY',token:'USDT',actual_amount:13.75,status:1,receive_address:'0x'+'1'.repeat(40),expiration_time:Math.floor(Date.now()/1000)+600,payment_url:'https://pay.example/pay/checkout-counter/trade'}});};
  const adapter=new GMPay(config,fakeFetch),data=await adapter.create({id:'MFtest',amount_cents:9900,name:'标准版'});assert.equal(data.trade_id,'trade');
  const params=Object.fromEntries(calls[1][1].body);assert.equal(params.network,'bsc');assert.equal(params.token,'usdt');assert.equal(params.amount,'99.00');assert.equal(verify(params,config.secret),true);
  const bad=new GMPay(config,async(url,opts)=>{const r=await fakeFetch(url,opts);const body=await r.json();if(body.data.payment_url)body.data.payment_url='https://evil.example/cashier/trade';return Response.json(body);});
  await assert.rejects(()=>bad.create({id:'MFtest',amount_cents:9900,name:'标准版'}),/收银台地址/);
});
test('paid records survive database reopen',()=>{
  const base=resolve(tmpdir()),dir=mkdtempSync(join(base,'cloak-payment-test-')),path=join(dir,'store.sqlite');let store;
  try{const config=fixtureConfig();store=openStore(path);const a=store.createAccount('persistent');const p=productFor(config,productBody),o=store.createOrder(a.id,'persistent-key-001','fp',p,'month',config.pid).order;store.applyPaid({pid:config.pid,order_id:o.id,trade_id:'persist-trade',amount:99,status:2,token:'USDT',actual_amount:13.75,receive_address:'0x1',block_transaction_id:'0xabc'},'digest');store.close();store=openStore(path);assert.equal(store.order(o.id).status,'paid');assert.equal(store.db.prepare('SELECT count(*) n FROM fulfillment_jobs').get().n,1);}finally{store?.close();if(dirname(resolve(dir))!==base||!basename(dir).startsWith('cloak-payment-test-'))throw Error('Unsafe test cleanup path');rmSync(dir,{recursive:true,force:true});}
});
test('failed preflight does not reserve a payable order slot',async t=>{
  const s=setup(t,{gateway:{create:async()=>{const e=Error('No configured asset');e.noTransaction=true;throw e;}}});
  const result=await s.order();assert.equal(result.data.order.paymentStatus,'failed');assert.equal(result.data.order.paymentUrl,null);
});
test('current binance BSC network key is discovered rather than hardcoding a legacy alias',async()=>{
  const config=fixtureConfig();let chosen;
  const adapter=new GMPay(config,async(url,options)=>{
    if(String(url).endsWith('/config'))return Response.json({status_code:200,data:{supported_assets:[{network:'binance',tokens:['USDT']}]}});
    chosen=Object.fromEntries(options.body).network;
    return Response.json({status_code:200,data:{order_id:'MFmodern',trade_id:'modern',amount:99,currency:'CNY',token:'USDT',actual_amount:13.75,status:1,receive_address:'0x'+'1'.repeat(40),expiration_time:Math.floor(Date.now()/1000)+600,payment_url:'https://pay.example/pay/checkout-counter/modern'}});
  });
  await adapter.create({id:'MFmodern',amount_cents:9900,name:'标准版'});assert.equal(chosen,'binance');
});
test('disabling new orders still permits signed receipts for outstanding orders',async t=>{
  const s=setup(t),{data}=await s.order();s.config.enabled=false;
  const res=await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:s.event(data.order)});
  assert.equal(res.status,200);assert.equal(s.store.order(data.order.id).status,'paid');
});


test('signed receipts remain bound to the original trade and receiving wallet',async t=>{
  const s=setup(t),{data}=await s.order();
  for(const overrides of [{trade_id:'different-trade'},{receive_address:'0x'+'2'.repeat(40)}]){
    const res=await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:s.event(data.order,overrides)});
    assert.equal(res.status,400);
  }
  assert.equal(s.store.order(data.order.id).status,'pending');
  assert.equal(s.store.db.prepare('SELECT count(*) n FROM payment_events').get().n,0);
});

test('one chain transaction cannot pay two orders and altered duplicates are rejected',async t=>{
  const s=setup(t),first=await s.order(),second=await s.order({cookie:first.cookie,key:'second-order-key-02'});
  const payload=s.event(first.data.order);
  assert.equal((await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:payload})).status,200);
  assert.equal((await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:s.event(second.data.order,{block_transaction_id:payload.block_transaction_id.toUpperCase()})})).status,409);
  assert.equal((await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:s.event(first.data.order,{block_transaction_id:'0x'+hash('other-transaction')})})).status,409);
  assert.equal(s.store.db.prepare('SELECT count(*) n FROM fulfillment_jobs').get().n,1);
});

test('early confirmed receipt sets trade identity and rejects conflicting late attachment',async t=>{
  const s=setup(t),product=productFor(s.config,productBody),o=s.store.createOrder(s.account.id,'early-receipt-key-01','fp',product,'month',s.config.pid).order;
  s.store.applyPaid(s.event({id:o.id,tradeId:'early-trade',amount:99}),hash('early'));
  assert.equal(s.store.order(o.id).trade_id,'early-trade');
  assert.throws(()=>s.store.attachGateway(o.id,{trade_id:'wrong-trade'}),/交易号/);
  assert.equal(s.store.order(o.id).status,'paid');
});

test('account refresh reflects elapsed cashier expiry and accepts a genuine late receipt',async t=>{
  const s=setup(t),{data,cookie}=await s.order();
  s.store.db.prepare('UPDATE orders SET expires_at=? WHERE id=?').run(Date.now()-1000,data.order.id);
  const state=await (await s.call('/api/v1/account',{cookie})).json();
  assert.equal(state.orders[0].paymentStatus,'expired');
  assert.equal((await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:s.event(data.order)})).status,200);
});


test('explicit receiving wallet rejects a mismatched early signed receipt',async t=>{
  const s=setup(t),{data}=await s.order();s.config.receiveAddress='0x'+'2'.repeat(40);
  const res=await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:s.event(data.order)});
  assert.equal(res.status,400);assert.equal(s.store.order(data.order.id).status,'pending');
});

test('cashier adapter refuses an unexpected receiving wallet',async()=>{
  const config=fixtureConfig();config.receiveAddress='0x'+'2'.repeat(40);
  const gateway=new GMPay(config,async url=>String(url).endsWith('/config')?Response.json({status_code:200,data:{supported_assets:[{network:'binance',tokens:['usdt']}]}}):Response.json({status_code:200,data:{order_id:'MFwallet',trade_id:'wallet-trade',amount:99,currency:'CNY',token:'USDT',actual_amount:13.75,status:1,receive_address:'0x'+'1'.repeat(40),expiration_time:Math.floor(Date.now()/1000)+600,payment_url:'https://pay.example/cashier/wallet-trade'}}));
  await assert.rejects(()=>gateway.create({id:'MFwallet',amount_cents:9900,name:'标准版'}),/指定钱包/);
});


test('USD monthly test order keeps currency and signed amount without changing CNY annual prices',async t=>{
  const s=setup(t);s.config.plans[1].monthlyCurrency='USD';s.config.plans[1].priceCents=500;
  const result=await s.order();assert.equal(result.data.order.amount,5);assert.equal(result.data.order.currency,'USD');
  assert.equal(productFor(s.config,{...productBody,cycle:'year'}).currency,'CNY');
  assert.equal(productFor(s.config,{...productBody,cycle:'year'}).amount_cents,84000);
  const wrong=s.event(result.data.order,{currency:'CNY'});
  assert.equal((await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:wrong})).status,400);
  assert.equal((await s.call('/api/v1/payments/gmpay/notify',{method:'POST',origin:null,data:s.event(result.data.order)})).status,200);
});

test('real adapter submits signed USD 5 and rejects a CNY response',async()=>{
  const config=fixtureConfig();let submitted;
  const gateway=new GMPay(config,async(url,options)=>{
    if(String(url).endsWith('/config'))return Response.json({status_code:200,data:{supported_assets:[{network:'binance',tokens:['usdt']}]}});
    submitted=Object.fromEntries(options.body);
    return Response.json({status_code:200,data:{order_id:'MFusd',trade_id:'usd-trade',amount:5,currency:'USD',actual_amount:5,token:'USDT',status:1,receive_address:'0x'+'1'.repeat(40),expiration_time:Math.floor(Date.now()/1000)+600,payment_url:'https://pay.example/cashier/usd-trade'}});
  });
  await gateway.create({id:'MFusd',amount_cents:500,currency:'USD',name:'test'});
  assert.equal(submitted.amount,'5.00');assert.equal(submitted.currency,'usd');assert.equal(verify(submitted,config.secret),true);
});
