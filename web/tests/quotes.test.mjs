import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig,productFor} from '../server/config.mjs';
import {Quotes} from '../server/quotes.mjs';
import {referenceFor} from '../src/pricing.js';

const environment={PAYMENTS_ENABLED:'true',PUBLIC_ORIGIN:'http://127.0.0.1:4173',GMPAY_NOTIFY_ORIGIN:'https://notify-unit.example',HOST:'127.0.0.1',PORT:'8788',ALLOW_LOOPBACK_GMPAY:'true',GMPAY_BASE_URL:'http://127.0.0.1:8000',GMPAY_PID:'1000',GMPAY_SECRET_KEY:'test-only-key',PAYMENT_CATALOG_FILE:'config/payment-catalog.confirmed.json'};
test('confirmed CNY prices and annual 20 percent reduction use exact server cents',()=>{
  const config=loadConfig(environment);
  assert.deepEqual(config.plans.map(p=>p.priceCents),[7990,16900,21900]);
  assert.deepEqual(config.plans.map(p=>p.annualCents),[76704,162240,210240]);
  for(const p of config.plans)assert.equal(p.annualCents,p.priceCents*12*80/100);
  assert.equal(productFor(config,{planId:'select',cycle:'year',kind:'plan'}).amount_cents,76704);
  assert.deepEqual(config.plans.map(p=>p.trafficGB),[300,600,1000]);assert.deepEqual(config.plans.map(p=>p.devices),[3,5,8]);
});
test('HTTP gateway is allowed only for explicitly opted in same-machine development',()=>{
  assert.equal(loadConfig(environment).gateway,'http://127.0.0.1:8000');
  for(const override of [{ALLOW_LOOPBACK_GMPAY:'false'},{GMPAY_BASE_URL:'http://192.168.1.10:8000'},{PUBLIC_ORIGIN:'http://192.168.1.10:4173'},{NODE_ENV:'production',PUBLIC_ORIGIN:'https://merchant-unit.net'},{HOST:'0.0.0.0'},{GMPAY_NOTIFY_ORIGIN:'http://127.0.0.1:4173'}])assert.throws(()=>loadConfig({...environment,...override}));
});
test('server catalog remains available for price display while new purchases are disabled',()=>{
  const config=loadConfig({...environment,PAYMENTS_ENABLED:'false'});
  assert.equal(config.plans[0].priceCents,7990);assert.equal(config.enabled,false);
  assert.throws(()=>productFor(config,{planId:'select',cycle:'month',kind:'plan'}),e=>e.code==='PAYMENTS_DISABLED');
});
test('reference quotes use fetched rates, cache requests and never change CNY order prices',async()=>{
  const config=loadConfig(environment);config.rateURL='https://rates-unit.net/cny.json';let calls=0;
  const service=new Quotes(config,async()=>{calls++;return Response.json({date:'2026-11-07',cny:{usdt:0.15}});});
  const [a,b]=await Promise.all([service.current(),service.current()]);
  assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.referenceOnly,true);
  assert.equal(referenceFor(a,'select','month'),11.99);assert.equal(referenceFor(a,'premium','year'),243.36);
  assert.equal(productFor(config,{planId:'select',cycle:'month',kind:'plan'}).amount_cents,7990);
  await service.current();assert.equal(calls,1);
});
test('missing or invalid live rates produce unavailable state rather than invented USDT amounts',async()=>{
  const config=loadConfig(environment);let called=false;
  assert.equal((await new Quotes(config,async()=>{called=true;}).current()).available,false);assert.equal(called,false);
  config.rateURL='https://rates-unit.net/cny.json';
  for(const payload of [{date:'2026-11-07',cny:{usdt:0}},{date:'invalid',cny:{usdt:0.15}},{date:'2026-11-07',cny:{usdt:'0.15'}}]){
    const value=await new Quotes(config,async()=>Response.json(payload)).current();assert.equal(value.available,false);assert.equal(referenceFor(value,'select','month'),null);
  }
});


test('USD reference uses the fetched USD cross rate instead of treating dollars as yuan',async()=>{
  const config=loadConfig(environment);config.rateURL='https://rates-unit.net/cny.json';config.plans[0].monthlyCurrency='USD';config.plans[0].priceCents=500;
  const quote=await new Quotes(config,async()=>Response.json({date:'2026-11-07',cny:{usdt:0.15,usd:0.15}})).current();
  assert.equal(referenceFor(quote,'select','month'),5);assert.equal(referenceFor(quote,'select','year'),115.06);
  const missing=await new Quotes(config,async()=>Response.json({date:'2026-11-07',cny:{usdt:0.15}})).current();assert.equal(referenceFor(missing,'select','month'),null);
});
