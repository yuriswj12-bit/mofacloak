import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PaymentError,cents} from './gmpay.mjs';

export const root=fileURLToPath(new URL('../',import.meta.url));
export function loadConfig(env=process.env){
  const production=env.NODE_ENV==='production';
  const origin=new URL(env.PUBLIC_ORIGIN||'http://127.0.0.1:4173');
  if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('PUBLIC_ORIGIN must be an origin');
  if(production&&origin.protocol!=='https:')throw new Error('Production PUBLIC_ORIGIN requires HTTPS');
  const enabled=env.PAYMENTS_ENABLED==='true';
  const config={enabled,origin:origin.origin,notifyOrigin:env.GMPAY_NOTIFY_ORIGIN||origin.origin,localGateway:false,callbackStatePath:resolve(root,'data/callback-client/current.json'),production,trustProxy:env.TRUST_PROXY==='true',host:env.HOST||'127.0.0.1',port:Number(env.PORT||8788),dbPath:resolve(root,env.DATABASE_PATH||'data/portal.sqlite'),gateway:env.GMPAY_BASE_URL||'',pid:env.GMPAY_PID||'',secret:env.GMPAY_SECRET_KEY||'',rateURL:env.QUOTE_RATE_URL||'',network:'binance',receiveAddress:env.GMPAY_RECEIVE_ADDRESS||'',plans:[]};
  config.databaseProvider=env.DATABASE_PROVIDER||'sqlite';
  config.binanceUid=env.BINANCE_RECEIVE_UID||'';
  config.binanceEnabled=env.BINANCE_UID_ENABLED==='true';
  if(config.binanceUid&&!/^[1-9][0-9]{4,19}$/.test(config.binanceUid))throw Error('Invalid Binance receiving UID');
  if(config.binanceEnabled&&!config.binanceUid)throw Error('Binance UID receiving requires a real UID');
  config.databaseURL=env.SUPABASE_DATABASE_URL||'';
  config.databaseCAFile=env.DATABASE_CA_FILE?resolve(root,env.DATABASE_CA_FILE):'';
  if(!['sqlite','supabase'].includes(config.databaseProvider))throw Error('Unsupported DATABASE_PROVIDER');
  if(config.databaseProvider==='supabase'){
    try{const db=new URL(config.databaseURL);if(!['postgres:','postgresql:'].includes(db.protocol)||!db.username||!db.password||!db.hostname)throw Error();}catch{throw Error('Supabase storage requires a valid private database URL');}
  }
  if(enabled){
    if(!config.gateway||!config.pid||!config.secret||!env.PAYMENT_CATALOG_FILE)throw new Error('Enabled payments require GMPAY_BASE_URL, GMPAY_PID, GMPAY_SECRET_KEY and PAYMENT_CATALOG_FILE');
    const gateway=new URL(config.gateway);
    const localOnly=!production&&env.ALLOW_LOOPBACK_GMPAY==='true'&&config.host==='127.0.0.1'&&config.port===8788&&config.origin==='http://127.0.0.1:4173'&&gateway.origin==='http://127.0.0.1:8000';
    config.localGateway=localOnly;
    if((gateway.protocol!=='https:'&&!localOnly)||gateway.username||gateway.password||gateway.pathname!=='/'||gateway.search||gateway.hash)throw new Error('GMPAY_BASE_URL requires HTTPS, except explicitly enabled same-machine loopback development');
    config.gateway=gateway.origin;
    const notify=new URL(config.notifyOrigin);
    if(notify.protocol!=='https:'||notify.username||notify.password||notify.pathname!=='/'||notify.search||notify.hash)throw Error('Payments require a public clean HTTPS notification origin');
  }
  if(config.receiveAddress&&!/^0x[a-fA-F0-9]{40}$/.test(config.receiveAddress))throw Error('GMPAY_RECEIVE_ADDRESS must be a BSC address');
  if(config.rateURL){const url=new URL(config.rateURL);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw Error('QUOTE_RATE_URL requires HTTPS');}
  if(!env.PAYMENT_CATALOG_FILE||(!enabled&&!existsSync(resolve(root,env.PAYMENT_CATALOG_FILE))))return config;
  const catalog=JSON.parse(readFileSync(resolve(root,env.PAYMENT_CATALOG_FILE),'utf8'));
  if(!Array.isArray(catalog.plans)||!catalog.plans.length)throw new Error('Payment catalog is empty');
  const seen=new Set();
  config.plans=catalog.plans.map(p=>{
    if(!['select','premium','exclusive'].includes(p.id)||seen.has(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>30||(p.trafficGB!=null&&(!Number.isSafeInteger(p.trafficGB)||p.trafficGB<=0))||(p.devices!=null&&(!Number.isSafeInteger(p.devices)||p.devices<=0)))throw new Error('Invalid payment catalog');
    seen.add(p.id);
    const monthlyCurrency=p.monthlyUsd!=null?'USD':'CNY';
    const priceCents=cents(p.monthlyUsd??p.monthlyCny),annualCents=cents(p.annualCny);
    if(priceCents<2||annualCents<2)throw new Error('Catalog prices must exceed 0.01 CNY');
    return {...p,priceCents,annualCents,monthlyCurrency,annualCurrency:'CNY'};
  });
  return config;
}
export function productFor(config,body){
  if(!config.enabled)throw new PaymentError('PAYMENTS_DISABLED','支付尚未开通，暂不接受付款。',503);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['planId','cycle','kind'].includes(k)))throw new PaymentError('INVALID_ORDER','请提交套餐、周期与订单类型，不要提交自定义金额。');
  const plan=config.plans.find(p=>p.id===body.planId);
  if(!plan||!['month','year'].includes(body.cycle)||!['plan','gift'].includes(body.kind))throw new PaymentError('INVALID_ORDER','套餐或购买周期无效。');
  return {plan,name:`${plan.name} · ${body.cycle==='year'?'年付':'月付'}${body.kind==='gift'?'礼品卡':''}`,amount_cents:body.cycle==='year'?plan.annualCents:plan.priceCents,currency:body.cycle==='year'?'CNY':plan.monthlyCurrency,months:body.cycle==='year'?12:1,kind:body.kind};
}
