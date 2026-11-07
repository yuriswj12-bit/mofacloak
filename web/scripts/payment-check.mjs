// Read-only local acceptance check. Never creates an order, signs a receipt or transfers funds.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {localProfile,webRoot} from './local-profile.mjs';
import {loadConfig} from '../server/config.mjs';
import {callbackReady} from '../server/callback-readiness.mjs';

const checks=[];
async function check(name,fn){try{const detail=await fn();checks.push({name,ok:true,...(detail?{detail}:{})});}catch{checks.push({name,ok:false});}}
function requireThat(value){if(!value)throw Error('Check failed');}
async function request(url,options={}){return fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000),...options});}
async function json(url){const r=await request(url);requireThat(r.ok);return r.json();}
async function rpcProbe(url){
  requireThat(new URL(url).protocol==='wss:');
  return new Promise((done,reject)=>{
    const ws=new WebSocket(url);let chain=false,head=false,subscription=false,settled=false;
    const timer=setTimeout(()=>finish(false),20000);
    function finish(ok){if(settled)return;settled=true;clearTimeout(timer);ws.close();ok?done({chainId:56,newHeadReceived:true}):reject(Error('RPC unavailable'));}
    ws.addEventListener('open',()=>{ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}));ws.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_subscribe',params:['newHeads']}));});
    ws.addEventListener('error',()=>finish(false));ws.addEventListener('close',()=>{if(!settled)finish(false);});
    ws.addEventListener('message',e=>{try{const m=JSON.parse(String(e.data));if(m.error)return finish(false);if(m.id===1)chain=m.result==='0x38';if(m.id===2)subscription=typeof m.result==='string';if(m.method==='eth_subscription'&&m.params?.result?.number)head=true;if(chain&&head&&subscription)finish(true);}catch{finish(false);}});
  });
}

try{
  const profile=localProfile(),config=loadConfig(profile.env);
  requireThat(config.localGateway);
  const input=JSON.parse(readFileSync(resolve(webRoot,'data/payment-setup/input.json'),'utf8'));
  await check('website-and-api',async()=>requireThat((await json(config.origin+'/api/v1/health')).status==='ok'));
  await check('live-channel-enabled',async()=>{const c=await json(config.origin+'/api/v1/payments/config');requireThat(c.enabled&&c.channels.filter(x=>x.enabled).map(x=>x.id).join()==='usdt');return {plans:c.plans.map(p=>({name:p.name,monthly:p.price,monthlyCurrency:p.monthlyCurrency,annual:p.annual,trafficGB:p.trafficGB}))};});
  await check('gateway-only-bsc-usdt',async()=>{const c=await json(config.gateway+'/payments/gmpay/v1/config');requireThat(c.status_code===200&&c.data.supported_assets.length===1&&['binance','bsc'].includes(c.data.supported_assets[0].network)&&c.data.supported_assets[0].tokens.map(x=>x.toLowerCase()).join()==='usdt');});
  await check('callback-heartbeat',async()=>requireThat(callbackReady(config)));
  await check('public-callback-signature-rejected',async()=>requireThat((await request(config.notifyOrigin+'/api/v1/payments/gmpay/notify',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status===401));
  await check('public-private-routes-closed',async()=>{for(const path of ['/','/admin','/api/v1/account'])requireThat((await request(config.notifyOrigin+path)).status===404);});
  await check('private-runtime-not-served',async()=>{for(const path of ['/.local-runtime.env','/data/local-access.json'])requireThat([403,404].includes((await request(config.origin+path)).status));});
  await check('native-wallet-and-rpc',async()=>{
    requireThat(config.receiveAddress?.toLowerCase()===input.wallet.toLowerCase());
    const db=new DatabaseSync(resolve(webRoot,'data/gmpay-local/epusdt.db'),{readOnly:true});
    try{
      requireThat(db.prepare("SELECT address FROM wallet_address WHERE network='binance' AND status=1 AND deleted_at IS NULL").all().some(x=>x.address.toLowerCase()===input.wallet.toLowerCase()));
      requireThat(db.prepare("SELECT url FROM rpc_nodes WHERE network='binance' AND enabled=1 AND deleted_at IS NULL").all().some(x=>x.url===input.rpc));
      const chain=db.prepare("SELECT min_confirmations,enabled FROM chains WHERE network='binance' AND deleted_at IS NULL").get();requireThat(chain?.enabled&&chain.min_confirmations>=1);
      return {minConfirmations:chain.min_confirmations};
    }finally{db.close();}
  });
  await check('bsc-wss-mainnet-live-head',()=>rpcProbe(input.rpc));
  await check('payment-ledger-consistent',async()=>{
    const portal=new DatabaseSync(profile.dbPath,{readOnly:true}),native=new DatabaseSync(resolve(webRoot,'data/gmpay-local/epusdt.db'),{readOnly:true});
    try{
      requireThat(Object.values(portal.prepare('PRAGMA integrity_check').get())[0]==='ok');
      const orders=portal.prepare('SELECT id,status,amount_cents,currency,trade_id,paid_trade_id,tx_hash FROM orders').all();
      for(const o of orders){
        const upstream=native.prepare('SELECT trade_id,status,amount,currency,block_transaction_id FROM orders WHERE order_id=?').get(o.id);
        if(o.status==='paid'){requireThat(upstream?.status===2&&upstream.trade_id===o.paid_trade_id&&upstream.block_transaction_id?.toLowerCase()===o.tx_hash?.toLowerCase()&&Math.round(upstream.amount*100)===o.amount_cents&&upstream.currency.toUpperCase()===o.currency);requireThat(portal.prepare('SELECT order_id FROM payment_events WHERE order_id=?').get(o.id));}
        if(upstream?.status===2)requireThat(o.status==='paid');
        if(['creating','review'].includes(o.status))throw Error('Manual reconciliation required');
      }
      return {orders:orders.length,paid:orders.filter(o=>o.status==='paid').length,pending:orders.filter(o=>o.status==='pending').length,receiptEvents:portal.prepare('SELECT count(*) n FROM payment_events').get().n};
    }finally{portal.close();native.close();}
  });
  const report={checkedAt:new Date().toISOString(),ready:checks.every(x=>x.ok),checks,mainnetAcceptance:'Requires a real wallet transfer and matching signed receipt; no transfer was performed by this check.'};
  const dir=resolve(webRoot,'data/payment-setup');mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'readiness-latest.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report,null,2));if(!report.ready)process.exitCode=1;
}catch{console.error('Local payment check unavailable. Check protected local configuration; no credentials were printed.');process.exitCode=1;}
