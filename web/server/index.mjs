import {createServer} from 'node:http';
import {isIP} from 'node:net';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {loadConfig,root} from './config.mjs';
import {openConfiguredStore} from './storage.mjs';
import {createApp} from './app.mjs';

const config=loadConfig();
let store;try{store=await openConfiguredStore(config);}catch{console.error('数据库启动失败，请检查私有连接配置及迁移状态。');process.exit(1);}
const handle=createApp({config,store});
const staticRoot=resolve(root,'dist/client');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,config.origin);
    if(url.pathname.startsWith('/api/')){
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413,{'content-type':'application/json'});res.end(JSON.stringify({message:'请求内容过大'}));return;}chunks.push(chunk);}
      const request=new Request(url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
      const peer=req.socket.remoteAddress,forwarded=req.headers['x-real-ip'];
      const remoteAddress=config.trustProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:peer;
      const response=await handle(request,{remoteAddress});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end();return;}
    const file=resolve(staticRoot,'.'+pathname);
    if((file!==staticRoot&&!file.startsWith(staticRoot+sep))||pathname.split('/').some(p=>p.startsWith('.'))){res.writeHead(404);res.end();return;}
    let bytes,target=pathname==='/'?resolve(staticRoot,'index.html'):file;
    try{bytes=await readFile(target);}catch{if(extname(pathname)){res.writeHead(404);res.end();return;}target=resolve(staticRoot,'index.html');bytes=await readFile(target);}
    res.writeHead(200,{'content-type':types[extname(target)]||'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",'cache-control':extname(target)==='.html'?'no-cache':'public, max-age=3600'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({message:'服务暂时不可用'}));}
});
server.requestTimeout=20000;server.headersTimeout=10000;
server.listen(config.port,config.host,()=>console.log(`Portal API: http://${config.host}:${server.address().port} · payments ${config.enabled?'configured':'not enabled'}`));
const stop=()=>server.close(async()=>{await store.close();process.exit(0);});process.on('SIGTERM',stop);process.on('SIGINT',stop);
