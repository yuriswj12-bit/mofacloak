import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationRelay} from '../server/notify-relay.mjs';
import {sign} from '../server/gmpay.mjs';
import {callbackReady} from '../server/callback-readiness.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';

const credentials={pid:'test-merchant',secret:'isolated-test-signing-key'};
async function setup(t,fetchImpl){
  const server=notificationRelay({...credentials,fetchImpl});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  return `http://127.0.0.1:${server.address().port}`;
}
test('notification relay exposes no website/admin routes and rejects unsigned payloads before forwarding',async t=>{
  let calls=0;const base=await setup(t,async()=>{calls++;return new Response('success');});
  for(const path of ['/','/admin','/api/v1/account','/api/v1/payments/gmpay/notify'])assert.equal((await fetch(base+path)).status,404);
  const response=await fetch(base+'/api/v1/payments/gmpay/notify',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(response.status,401);assert.equal(calls,0);
});
test('valid signed JSON is forwarded unchanged only to the fixed loopback callback',async t=>{
  const payload={pid:credentials.pid,order_id:'isolated-relay-contract-test',status:2};payload.signature=sign(payload,credentials.secret);const raw=JSON.stringify(payload);let calls=0;
  const base=await setup(t,async(url,options)=>{calls++;assert.equal(String(url),'http://127.0.0.1:8788/api/v1/payments/gmpay/notify');assert.equal(options.body.toString('utf8'),raw);assert.equal(options.redirect,'error');return new Response('success');});
  const response=await fetch(base+'/api/v1/payments/gmpay/notify',{method:'POST',headers:{'content-type':'application/json'},body:raw});assert.equal(response.status,200);assert.equal(await response.text(),'success');assert.equal(calls,1);
});
test('large/malformed bodies and wrong merchants cannot reach the private API',async t=>{
  let calls=0;const base=await setup(t,async()=>{calls++;return new Response('success');});
  for(const [body,status] of [['x'.repeat(17000),413],['{bad',400],[JSON.stringify({pid:'other',signature:'a'.repeat(64)}),401]]){
    const response=await fetch(base+'/api/v1/payments/gmpay/notify',{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(response.status,status);
  }
  assert.equal(calls,0);
});
test('relay fails safely on private API outage and cannot be configured as an arbitrary proxy',async t=>{
  assert.throws(()=>notificationRelay({...credentials,target:'https://another-site.net/'}));
  const base=await setup(t,async()=>{throw Error('no connection');});const payload={pid:credentials.pid};payload.signature=sign(payload,credentials.secret);
  const response=await fetch(base+'/api/v1/payments/gmpay/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(response.status,502);assert.equal(await response.text(),'notification delivery unavailable');
});
test('local payment readiness requires a matching active tunnel and a fresh heartbeat',t=>{
  const root=mkdtempSync(join(tmpdir(),'mofacloak-callback-test-'));
  t.after(()=>{assert.equal(dirname(root),resolve(tmpdir()));assert.ok(root.startsWith(join(resolve(tmpdir()),'mofacloak-callback-test-')));rmSync(root,{recursive:true,force:true});});
  const path=join(root,'state.json'),config={localGateway:true,callbackStatePath:path,notifyOrigin:'https://isolated-tunnel.example'};
  assert.equal(callbackReady(config),false);
  const current={origin:config.notifyOrigin,active:true,heartbeatAt:Date.now(),publicCheckedAt:Date.now()};
  writeFileSync(path,JSON.stringify(current));assert.equal(callbackReady(config),true);
  for(const patch of [{active:false},{publicCheckedAt:undefined},{publicCheckedAt:Date.now()-20000},{origin:'https://wrong-tunnel.example'},{heartbeatAt:Date.now()-20000}]){writeFileSync(path,JSON.stringify({...current,...patch}));assert.equal(callbackReady(config),false);}
  assert.equal(callbackReady({localGateway:false}),true);
});
