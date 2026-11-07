import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {checkDeployment} from '../scripts/deployment-check.mjs';
import {openStore} from '../server/store.mjs';
import {createApp} from '../server/app.mjs';
import {loadConfig} from '../server/config.mjs';

function temporary(t){
  const dir=mkdtempSync(join(tmpdir(),'mofacloak-deployment-test-'));
  t.after(()=>{assert.equal(dirname(dir),resolve(tmpdir()));assert.ok(dir.startsWith(join(resolve(tmpdir()),'mofacloak-deployment-test-')));rmSync(dir,{recursive:true,force:true});});
  return dir;
}
function fixture(t,{enabled=false,secret='test-only-merchant-key'}={}){
  const dir=temporary(t);mkdirSync(join(dir,'config'));
  const deployment='PORTAL_DOMAIN=merchant-unit.net\nPAY_DOMAIN=pay.merchant-unit.net\nACME_EMAIL=owner@merchant-unit.net\n';
  const portal=`NODE_ENV=production\nHOST=127.0.0.1\nPORT=8788\nTRUST_PROXY=true\nDATABASE_PATH=/app/data/portal.sqlite\nPUBLIC_ORIGIN=https://merchant-unit.net\nGMPAY_BASE_URL=https://pay.merchant-unit.net\nPAYMENTS_ENABLED=${enabled}\nGMPAY_PID=${enabled?'1000':''}\nGMPAY_SECRET_KEY=${enabled?secret:''}\nPAYMENT_CATALOG_FILE=/app/config/payment-catalog.json\n`;
  writeFileSync(join(dir,'.env'),deployment,{mode:0o600});writeFileSync(join(dir,'config/portal.env'),portal,{mode:0o600});
  writeFileSync(join(dir,'config/payment-catalog.json'),readFileSync(new URL('../config/payment-catalog.example.json',import.meta.url)));
  return dir;
}
const result=(report,id)=>report.checks.find(c=>c.id===id)?.status;

test('preflight fails closed without configuration and never probes the network',async t=>{
  let calls=0;const report=await checkDeployment({directory:temporary(t),online:true,fetchImpl:()=>{calls++;throw Error();}});
  assert.equal(report.ok,false);assert.equal(result(report,'files'),'FAIL');assert.equal(calls,0);
});
test('closed payments allow infrastructure setup but do not imply mainnet acceptance',async t=>{
  const dir=fixture(t),report=await checkDeployment({directory:dir});
  assert.equal(report.ok,true);assert.equal(result(report,'payments-closed'),'WARN');assert.equal(result(report,'catalog'),'PASS');
  assert.equal(readFileSync(join(dir,'config/portal.env'),'utf8').includes('PAYMENTS_ENABLED=false'),true);
});
test('preflight rejects unsafe bindings, mismatched domains and invalid catalog without exposing secrets',async t=>{
  const secret='never-print-this-test-key',dir=fixture(t,{enabled:true,secret}),path=join(dir,'config/portal.env');
  writeFileSync(path,readFileSync(path,'utf8').replace('HOST=127.0.0.1','HOST=0.0.0.0').replace('PUBLIC_ORIGIN=https://merchant-unit.net','PUBLIC_ORIGIN=https://wrong-unit.net'));
  writeFileSync(join(dir,'config/payment-catalog.json'),'{bad json '+secret);
  const report=await checkDeployment({directory:dir});
  assert.equal(report.ok,false);assert.equal(result(report,'runtime'),'FAIL');assert.equal(result(report,'origins'),'FAIL');assert.equal(result(report,'catalog'),'FAIL');assert.ok(!JSON.stringify(report).includes(secret));
});
test('enabled payments require merchant credentials even with a valid catalog',async t=>{
  const dir=fixture(t,{enabled:true,secret:''}),report=await checkDeployment({directory:dir});
  assert.equal(report.ok,false);assert.equal(result(report,'credentials'),'FAIL');
});
test('online preflight uses GET only, checks deployment drift and does not authenticate or create transactions',async t=>{
  const dir=fixture(t,{enabled:true}),requests=[];
  const report=await checkDeployment({directory:dir,online:true,expectedIp:'192.0.2.1',resolve4Impl:async()=>['192.0.2.1'],fetchImpl:async(url,options)=>{
    requests.push({url:String(url),options});
    if(String(url).endsWith('/health'))return Response.json({status:'ok'});
    if(String(url).includes('/payments/gmpay/'))return Response.json({status_code:200,data:{supported_assets:[{network:'binance',tokens:['usdt']}]}});
    return Response.json({provider:'GM Pay',enabled:true,plans:[]});
  }});
  assert.equal(result(report,'portal-health'),'PASS');assert.equal(result(report,'gateway-assets'),'PASS');assert.equal(result(report,'public-prices'),'FAIL');assert.equal(report.ok,false);
  assert.equal(result(report,'mainnet-acceptance'),'WARN');assert.equal(requests.length,3);
  for(const r of requests){assert.equal(r.options.method,'GET');assert.equal(r.options.redirect,'error');assert.ok(!JSON.stringify(r).includes('test-only-merchant-key'));assert.ok(!r.url.includes('create-transaction'));}
});
test('online probe errors and oversized responses cannot leak credentials or count as a pass',async t=>{
  const dir=fixture(t,{enabled:true}),secret='upstream-secret-must-not-appear';
  const report=await checkDeployment({directory:dir,online:true,fetchImpl:async(url)=>{
    if(String(url).endsWith('/health'))return new Response('x'.repeat(70000));
    throw Error('connection failed '+secret);
  }});
  assert.equal(report.ok,false);assert.equal(result(report,'portal-health'),'FAIL');assert.equal(result(report,'gateway-assets'),'FAIL');assert.ok(!JSON.stringify(report).includes(secret));
});
test('health reports actual database failure, does not require login and never exposes configuration',async()=>{
  const store=openStore(':memory:'),handle=createApp({config:loadConfig({}),store});
  try{
    const response=await handle(new Request('https://merchant-unit.net/api/v1/health'));
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{status:'ok'});
    store.close();
    const failed=await handle(new Request('https://merchant-unit.net/api/v1/health'));assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{status:'unavailable'});
  }finally{try{store.close();}catch{}}
});
test('real HTTP server starts with an isolated persistent database and responds to health checks',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mofacloak-deployment-test-')),dbPath=join(dir,'isolated.sqlite');
  const child=spawn(process.execPath,['server/index.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,NODE_ENV:'development',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1',DATABASE_PATH:dbPath,PAYMENTS_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
    assert.equal(dirname(dir),resolve(tmpdir()));assert.ok(dir.startsWith(join(resolve(tmpdir()),'mofacloak-deployment-test-')));rmSync(dir,{recursive:true,force:true});
  });
  const origin=await new Promise((resolveOrigin,reject)=>{
    let text='';const timer=setTimeout(()=>reject(Error('Server startup timeout')),10000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('Server exited before startup'));});
    child.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/Portal API: (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolveOrigin(match[1]);}});
  });
  const response=await fetch(origin+'/api/v1/health');assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'ok'});
  const config=await (await fetch(origin+'/api/v1/payments/config')).json();assert.equal(config.enabled,false);assert.deepEqual(config.plans,[]);
  const store=openStore(dbPath);try{assert.equal(store.db.prepare('SELECT count(*) n FROM accounts').get().n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM orders').get().n,0);}finally{store.close();}
});
