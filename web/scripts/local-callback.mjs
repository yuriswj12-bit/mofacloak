// Public callback only. Starting this command exposes signed receipt data via Cloudflare.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,createWriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
import {webRoot} from './local-profile.mjs';
const root=resolve(webRoot,'data/callback-client'),statePath=resolve(root,'current.json'),children=[];
let origin=null,heartbeat=null,stopping=false,publicCheckedAt=0;
function state(active){writeFileSync(statePath,JSON.stringify({origin,active,heartbeatAt:Date.now(),publicCheckedAt,target:'127.0.0.1:8790',path:'/api/v1/payments/gmpay/notify'}),{mode:0o600});}
function stop(code=0){if(stopping)return;stopping=true;clearInterval(heartbeat);if(origin)state(false);for(const child of children)if(child.exitCode===null&&!child.killed)child.kill('SIGTERM');process.exitCode=code;}
process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
function child(file,args,stdio){
  const p=spawn(file,args,{cwd:webRoot,env:process.env,stdio,windowsHide:true});children.push(p);
  p.once('error',()=>{console.error('Callback process could not start.');stop(1);});
  p.once('exit',code=>{if(!stopping)stop(code||1);});return p;
}
try{
  const exe=resolve(root,'cloudflared.exe');
  if(createHash('sha256').update(readFileSync(exe)).digest('hex')!=='2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343')throw Error('Cloudflare client checksum mismatch');
  const relay=child(process.execPath,['scripts/local-notify-relay.mjs'],['ignore','pipe','pipe']);
  await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('Relay startup timeout')),10000);relay.stdout.on('data',b=>{if(b.toString().includes('Signed notification relay:')){clearTimeout(timer);done();}});relay.once('exit',()=>{clearTimeout(timer);reject(Error('Relay exited'));});});
  const log=createWriteStream(resolve(root,'tunnel.log'),{flags:'a',mode:0o600});
  const client=child(exe,['tunnel','--url','http://127.0.0.1:8790','--protocol','http2','--no-autoupdate'],['ignore','pipe','pipe']);
  let output='';
  await new Promise((done,reject)=>{
    const timer=setTimeout(()=>reject(Error('Public callback URL unavailable; inspect private tunnel.log')),45000);
    const onData=b=>{log.write(b);output=(output+b.toString()).slice(-24000);const match=output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match){origin=match[0];clearTimeout(timer);done();}};
    client.stdout.on('data',onData);client.stderr.on('data',onData);client.once('exit',()=>{log.end();clearTimeout(timer);reject(Error('Tunnel exited'));});
  });
  state(false);let verified=false;
  for(let i=0;i<20&&!stopping;i++){
    try{const r=await fetch(origin+'/api/v1/payments/gmpay/notify',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(4000)});if(r.status===401&&(await r.text())==='invalid signature'){verified=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,500));
  }
  if(!verified)throw Error('Public endpoint did not pass signature rejection probe');
  const envPath=resolve(webRoot,'.local-runtime.env'),env=parseEnv(readFileSync(envPath,'utf8'));env.GMPAY_NOTIFY_ORIGIN=origin;
  writeFileSync(envPath,Object.entries(env).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600});
  publicCheckedAt=Date.now();state(true);let probing=false;
  heartbeat=setInterval(async()=>{
    if(probing||stopping)return;probing=true;
    try{
      const r=await fetch(origin+'/api/v1/payments/gmpay/notify',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(4000)});
      const valid=r.status===401&&(await r.text())==='invalid signature';
      if(valid)publicCheckedAt=Date.now();
      if(!stopping)state(valid);
    }catch{if(!stopping)state(false);}finally{probing=false;}
  },5000);
  console.log(`Callback ready: ${origin}/api/v1/payments/gmpay/notify\nOnly verified signed JSON is forwarded. Website/admin stay private. Restart portal after URL changes. Keep this process running until all pending payments are reconciled.`);
}catch(error){console.error(error.message);stop(1);}
