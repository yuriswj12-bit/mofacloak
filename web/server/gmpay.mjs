import {createHmac,timingSafeEqual} from 'node:crypto';

export class PaymentError extends Error {
  constructor(code,message,status=400){super(message);this.code=code;this.status=status;}
}
export function canonical(params){
  return Object.keys(params).filter(k=>k!=='signature'&&params[k]!==''&&params[k]!==null&&params[k]!==undefined).sort().map(k=>{
    const v=params[k];if(!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v))throw new PaymentError('INVALID_SIGNATURE_DATA','签名参数格式错误');
    return `${k}=${String(v)}`;
  }).join('&');
}
export const sign=(params,secret)=>createHmac('sha256',secret).update(canonical(params)).digest('hex');
export function verify(params,secret){
  if(typeof params.signature!=='string'||!(/^[a-f0-9]{64}$/.test(params.signature)))return false;
  try{return timingSafeEqual(Buffer.from(params.signature,'hex'),Buffer.from(sign(params,secret),'hex'));}catch{return false;}
}
export function cents(value){
  const s=String(value);if(!/^\d{1,7}(\.\d{1,2})?$/.test(s))throw new PaymentError('INVALID_AMOUNT','金额格式错误');
  const [a,b='']=s.split('.');return Number(a)*100+Number(b.padEnd(2,'0'));
}
export const decimal=value=>(value/100).toFixed(2);
export function checkoutURL(value,base){
  let u;try{u=new URL(value);}catch{throw new PaymentError('INVALID_CASHIER','网关未返回有效收银台地址',502);}
  const origin=new URL(base).origin;
  if(u.origin!==origin||u.username||u.password||!/^\/(pay\/checkout-counter|cashier)\/[^/]+\/?$/.test(u.pathname))throw new PaymentError('INVALID_CASHIER','收银台地址与配置网关不匹配',502);
  return u.href;
}
export class GMPay {
  constructor(config,fetchImpl=fetch){this.config=config;this.fetch=fetchImpl;}
  async request(path,options={}){
    let res;try{res=await this.fetch(new URL(path,this.config.gateway),{...options,redirect:'error',signal:AbortSignal.timeout(12000)});}catch{throw new PaymentError('GATEWAY_UNAVAILABLE','暂时无法连接收款网关，请稍后刷新订单。',502);}
    let data;try{data=await res.json();}catch{throw new PaymentError('GATEWAY_RESPONSE','网关响应格式错误，请联系管理员。',502);}
    if(!res.ok||data.status_code!==200||!data.data){
      if(path==='/payments/gmpay/v1/order/create-transaction'&&data.status_code===10041){const error=new PaymentError('NOTIFY_URL_REJECTED','网关拒绝本机通知地址，需先配置公开 HTTPS 到账通知入口。',503);error.noTransaction=true;throw error;}
      throw new PaymentError('GATEWAY_REJECTED','收款网关暂时无法创建此交易，请联系管理员。',502);
    }
    return data.data;
  }
  async assets(){const data=await this.request('/payments/gmpay/v1/config');return (data.supported_assets||[]).filter(a=>['binance','bsc'].includes(a.network)&&Array.isArray(a.tokens)&&a.tokens.some(t=>String(t).toLowerCase()==='usdt'));}
  async create(order){
    let assets;try{assets=await this.assets();if(!assets.length)throw new PaymentError('ASSET_NOT_READY','网关尚未配置 USDT / BSC 收款通道。',503);}catch(error){error.noTransaction=true;throw error;}
    const network=(assets.find(a=>a.network===this.config.network)||assets[0]).network;
    const params={pid:this.config.pid,order_id:order.id,currency:(order.currency||'CNY').toLowerCase(),token:'usdt',network,amount:decimal(order.amount_cents),notify_url:(this.config.notifyOrigin||this.config.origin)+'/api/v1/payments/gmpay/notify',redirect_url:this.config.origin+'/#orders',name:order.name};
    params.signature=sign(params,this.config.secret);
    const data=await this.request('/payments/gmpay/v1/order/create-transaction',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)});
    if(data.order_id!==order.id||cents(data.amount)!==order.amount_cents||String(data.currency).toUpperCase()!==(order.currency||'CNY')||String(data.token).toUpperCase()!=='USDT'||Number(data.status)!==1||!data.trade_id||!Number.isFinite(Number(data.actual_amount))||!(Number(data.actual_amount)>0)||!data.receive_address||!Number.isFinite(Number(data.expiration_time))||!(Number(data.expiration_time)>Date.now()/1000))throw new PaymentError('GATEWAY_MISMATCH','网关交易数据与订单不一致，请联系管理员。',502);
    if(this.config.receiveAddress&&String(data.receive_address).toLowerCase()!==this.config.receiveAddress.toLowerCase())throw new PaymentError('WALLET_MISMATCH','网关收款地址与指定钱包不一致，请联系管理员，暂勿付款。',502);
    return {...data,payment_url:checkoutURL(data.payment_url,this.config.gateway)};
  }
  async status(tradeId){return this.request('/pay/check-status/'+encodeURIComponent(tradeId));}
}
