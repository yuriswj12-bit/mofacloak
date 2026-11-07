import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PLANS,priceFor,money,orderMoney} from '../src/pricing.js';
test('unconfigured catalog contains no manufactured prices',()=>{
  assert.deepEqual(PLANS.map(p=>priceFor(p,'month','CNY')),[null,null,null]);
});
test('configured annual amount is independent from monthly amount',()=>{
  assert.equal(priceFor({price:99,annual:840},'year','CNY'),840);
});
test('USDT never uses a fabricated frontend exchange quote',()=>{
  assert.equal(priceFor({price:99,usdt:14},'month','USDT'),null);
});
test('missing amounts stay unquoted and actual server amounts are formatted',()=>{
  assert.equal(money(undefined),'待报价');assert.equal(money(null),'待报价');
  assert.equal(orderMoney({amount:99,currency:'CNY'}),'¥99.00');
});

test('USD order display cannot be mistaken for CNY',()=>{assert.equal(orderMoney({amount:5,currency:'USD'}),'US$5.00');});
