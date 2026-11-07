import {createServer} from 'node:http';
import {verify} from './gmpay.mjs';

// Only this one signed JSON POST can reach the private portal. No browser/admin routes.
export function notificationRelay({pid,secret,target='http://127.0.0.1:8788/api/v1/payments/gmpay/notify',fetchImpl=fetch}){
  const destination=new URL(target);
  if(destination.origin!=='http://127.0.0.1:8788'||destination.pathname!=='/api/v1/payments/gmpay/notify'||destination.search||destination.hash||destination.username||destination.password||!pid||!secret)throw Error('A fixed loopback target and real merchant credentials are required');
  const server=createServer(async(req,res)=>{
    const reply=(status,text)=>{res.writeHead(status,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(text);};
    if(req.url!=='/api/v1/payments/gmpay/notify'||req.method!=='POST'){reply(404,'not found');return;}
    if(!(req.headers['content-type']||'').toLowerCase().startsWith('application/json')){reply(415,'JSON required');return;}
    if(Number(req.headers['content-length'])>16384){reply(413,'request too large');req.resume();return;}
    try{
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>16384){reply(413,'request too large');return;}chunks.push(chunk);}
      const raw=Buffer.concat(chunks);let data;
      try{data=JSON.parse(raw);}catch{reply(400,'invalid JSON');return;}
      if(!data||typeof data!=='object'||Array.isArray(data)||String(data.pid)!==String(pid)||!verify(data,secret)){reply(401,'invalid signature');return;}
      const response=await fetchImpl(destination,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(8000)});
      reply(response.status,await response.text());
    }catch{if(!res.headersSent)reply(502,'notification delivery unavailable');else res.destroy();}
  });
  server.headersTimeout=10000;server.requestTimeout=15000;
  return server;
}
