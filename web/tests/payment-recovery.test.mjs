import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverRequest,recoveryKey,forgetRequest,paymentExpired} from '../src/payment-recovery.js';

test('reopening checkout recovers one request for the same account and product',()=>{
  const map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  const name=recoveryKey('account','premium','month','plan');
  const first=recoverRequest(storage,name,()=> 'first-request-key-001');
  assert.equal(recoverRequest(storage,name,()=> 'second-request-key-002'),first);
  assert.notEqual(recoveryKey('other','premium','month','plan'),name);
  assert.notEqual(recoveryKey('account','premium','year','plan'),name);
  assert.notEqual(recoveryKey('account','premium','month','gift'),name);
  forgetRequest(storage,name);
  assert.equal(recoverRequest(storage,name,()=> 'second-request-key-002'),'second-request-key-002');
});

test('unavailable browser storage and corrupt keys never break checkout',()=>{
  const broken={getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}};
  assert.equal(recoverRequest(broken,'checkout',()=> 'valid-request-key-001'),'valid-request-key-001');
  assert.doesNotThrow(()=>forgetRequest(broken,'checkout'));
  assert.equal(recoverRequest({getItem:()=>'<invalid>',setItem(){}},'checkout',()=> 'valid-request-key-001'),'valid-request-key-001');
});

test('cashier action expires at the exact deadline but never downgrades paid',()=>{
  assert.equal(paymentExpired({paymentStatus:'pending',expiresAt:1000},999),false);
  assert.equal(paymentExpired({paymentStatus:'pending',expiresAt:1000},1000),true);
  assert.equal(paymentExpired({paymentStatus:'expired'},0),true);
  assert.equal(paymentExpired({paymentStatus:'paid',expiresAt:1000},2000),false);
  assert.equal(paymentExpired({paymentStatus:'pending',expiresAt:null},2000),false);
});
