import {PaymentError,verify,canonical,GMPay} from './gmpay.mjs';
import {productFor} from './config.mjs';
import {hash} from './store.mjs';
import {Tickets} from './tickets.mjs';
import {Quotes} from './quotes.mjs';
import {callbackReady} from './callback-readiness.mjs';
import {uidQuote} from './binance-uid.mjs';

const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{...headers,'content-type':'application/json; charset=utf-8',...extra}});
const label={creating:'创建中',review:'待核对',pending:'待支付',paid:'已付款',expired:'已过期',failed:'创建失败'};
export function publicOrder(o){return {id:o.id,name:o.name,planId:o.plan_id,kind:o.kind,cycle:o.cycle,amount:o.amount_cents/100,currency:o.currency||'CNY',status:label[o.status],paymentStatus:o.status,fulfillmentStatus:o.status==='paid'?(o.kind==='gift'?'gift_issued':'pending_activation'):null,tradeId:o.trade_id,actualAmount:o.actual_amount,token:'USDT',network:'BSC / BEP20',receiveAddress:o.receive_address,paymentUrl:o.payment_url,expiresAt:o.expires_at,txHash:o.tx_hash,createdAt:o.created_at,date:new Date(o.created_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).slice(0,16),real:true};}
export function createApp({config,store,gateway=new GMPay(config),quoteService}){
  const tickets=store.tickets||new Tickets(store);
  const quotes=quoteService||new Quotes(config);
  async function present(o){
    const result=publicOrder(o);
    if(o.pid==='BINANCE_UID'){
      const m=await store.manualPayment(o.id);
      if(!m)throw Error('Missing Binance payment record');
      return {...result,channel:'binance_uid',network:'币安内部转账',binanceUid:m.receiver_uid,actualAmount:(m.due_cents/100).toFixed(2),claimTransactionId:m.claim_transaction_id,binanceTransactionId:m.confirmed_transaction_id,submittedAt:m.submitted_at,receiveAddress:null,paymentUrl:null};
    }
    return {...result,channel:'usdt'};
  }
  const limits=new Map();
  const cookieName=config.production?'__Host-cloak_session':'cloak_session';
  const cookie=value=>`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value?604800:0}${config.production?'; Secure':''}`;
  const session=req=>{const raw=req.headers.get('cookie')||'';const parts=raw.split(';').map(x=>x.trim().split('='));const found=parts.find(([k])=>k===cookieName);return found?.[1]||'';};
  const authenticate=async req=>{const user=await store.account(session(req));if(!user)throw new PaymentError('AUTH_REQUIRED','请使用管理员发放的账户访问码登录。',401);return user;};
  function limit(key,max,ms){const now=Date.now(),entry=limits.get(key);if(!entry||entry.until<now){if(limits.size>10000)limits.clear();limits.set(key,{until:now+ms,n:1});return;}if(++entry.n>max)throw new PaymentError('RATE_LIMITED','请求过于频繁，请稍后再试。',429);}
  async function body(req){const text=await req.text();if(Buffer.byteLength(text)>16384)throw new PaymentError('BODY_TOO_LARGE','请求内容过大。',413);if(!(req.headers.get('content-type')||'').startsWith('application/json'))throw new PaymentError('CONTENT_TYPE','需要 JSON 请求。',415);try{const b=JSON.parse(text);if(!b||typeof b!=='object'||Array.isArray(b))throw Error();return b;}catch{throw new PaymentError('INVALID_JSON','请求格式无效。');}}
  return async function handle(req,{remoteAddress='local'}={}){
    try{
      const url=new URL(req.url),path=url.pathname,method=req.method;
      if(path==='/api/v1/health'&&method==='GET'){
        try{await store.health();return json({status:'ok'});}
        catch{return json({status:'unavailable'},503);}
      }
      if(path==='/api/v1/payments/gmpay/notify'){
        if(method!=='POST')throw new PaymentError('METHOD','不支持此请求。',405);
        if(!config.secret||!config.pid)throw new PaymentError('PAYMENTS_DISABLED','支付未开通。',503);
        const data=await body(req);
        if(String(data.pid)!==config.pid||!verify(data,config.secret))throw new PaymentError('INVALID_SIGNATURE','回调签名无效。',401);
        if(config.receiveAddress&&String(data.receive_address).toLowerCase()!==config.receiveAddress.toLowerCase())throw new PaymentError('WALLET_MISMATCH','付款通知的收款钱包不一致。',400);
        await store.applyPaid(data,hash(canonical(data)));
        return new Response('success',{headers:{...headers,'content-type':'text/plain; charset=utf-8'}});
      }
      if(!['GET','POST'].includes(method))throw new PaymentError('METHOD','不支持此请求。',405);
      if(method==='POST'&&req.headers.get('origin')!==config.origin)throw new PaymentError('ORIGIN_REJECTED','请求来源无效。',403);
      limit('api:'+remoteAddress,240,60000);
      if(path==='/api/v1/payments/config'&&method==='GET'){const enabled=config.enabled&&callbackReady(config);return json({provider:'GM Pay',protocol:'GMPay v2 / HMAC-SHA256',enabled:enabled||!!config.binanceEnabled,token:'USDT',network:'bsc',networkLabel:'BSC / BEP20',pricingCurrency:'CNY',pointsEnabled:false,binanceUidEnabled:!!config.binanceEnabled,bscEnabled:enabled,channels:[{id:'binance_uid',name:'币安 UID 转账 · 人工核账',enabled:!!config.binanceEnabled},{id:'usdt',name:'USDT / BSC',enabled},{id:'alipay',name:'支付宝',enabled:false},{id:'wechat',name:'微信支付',enabled:false}],message:(config.binanceEnabled?'币安 UID 转账已开通（人工核账）；':'')+(enabled?'USDT / BSC 已配置，主网实付验收尚待完成；支付宝、微信支付未开通。':'USDT 收款尚未开通；支付宝、微信支付尚未接入。'),plans:config.plans.map(p=>({id:p.id,name:p.name,price:p.priceCents/100,monthlyCurrency:p.monthlyCurrency,annualCurrency:p.annualCurrency,annual:p.annualCents/100,trafficGB:p.trafficGB??null,traffic:p.trafficGB==null?null:p.trafficGB+' GB',devices:p.devices??null}))});}
      if(path==='/api/v1/payments/quote'&&method==='GET')return json(await quotes.current());
      if(path==='/api/v1/auth/login'&&method==='POST'){
        limit('login:'+remoteAddress,10,600000);const b=await body(req);
        if(typeof b.accessCode!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.accessCode))throw new PaymentError('LOGIN_FAILED','访问码无效。',401);
        const result=await store.login(b.accessCode);return json({account:result.account},200,{'set-cookie':cookie(result.session)});
      }
      if(path==='/api/v1/auth/logout'&&method==='POST'){await store.logout(session(req));return json({ok:true},200,{'set-cookie':cookie('')});}
      const user=await authenticate(req);
      if(path==='/api/v1/tickets'&&method==='GET')return json({tickets:await tickets.list(user.id)});
      if(path==='/api/v1/tickets'&&method==='POST'){
        const result=await tickets.create(user.id,req.headers.get('idempotency-key'),await body(req));return json({ticket:result.ticket},result.created?201:200);
      }
      const ticketMatch=path.match(/^\/api\/v1\/tickets\/(TK[a-f0-9]{24})(?:\/(messages|close))?$/);
      if(ticketMatch){
        const [,id,action]=ticketMatch;
        if(method==='GET'&&!action)return json({ticket:await tickets.detail(id,user.id)});
        if(method==='POST'&&action==='messages'){limit('ticket-reply:'+user.id,10,60000);return json({ticket:await tickets.userReply(id,user.id,req.headers.get('idempotency-key'),await body(req))});}
        if(method==='POST'&&action==='close'){const b=await body(req);if(Object.keys(b).length)throw new PaymentError('INVALID_TICKET','关闭工单不需要额外参数。');return json({ticket:await tickets.close(id,user.id)});}
      }
      if(path==='/api/v1/account'&&method==='GET'){await store.expirePending(user.id);return json({account:user,orders:await Promise.all((await store.listOrders(user.id)).map(present)),gifts:(await store.listGifts(user.id)).map(g=>({id:g.id,name:g.name,code:g.code,months:g.months,status:g.redeemed_by?'已兑换':'未兑换',date:new Date(g.created_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),real:true})),points:{balance:0,history:[]},subscription:null});}
      if(path==='/api/v1/orders/binance'&&method==='POST'){
        limit('orders:'+user.id,10,60000);const b=await body(req);
        if(!config.binanceEnabled)throw new PaymentError('BINANCE_DISABLED','币安 UID 转账尚未开通。',503);
        const product=productFor({...config,enabled:true},b),key=req.headers.get('idempotency-key');
        if(!key||!/^[A-Za-z0-9_-]{16,100}$/.test(key))throw new PaymentError('IDEMPOTENCY_REQUIRED','缺少有效请求标识。');
        const fingerprint=hash(JSON.stringify({...b,channel:'binance_uid'}));
        const existing=await store.db.prepare('SELECT * FROM orders WHERE account_id=? AND idempotency_key=?').get(user.id,key);
        if(existing){if(existing.request_fingerprint!==fingerprint)throw new PaymentError('IDEMPOTENCY_CONFLICT','该请求标识已用于其他订单。',409);return json({order:await present(existing)});}
        const quote=await uidQuote(config,quotes,b);
        const result=await store.createOrder(user.id,key,fingerprint,product,b.cycle,'BINANCE_UID',quote);
        return json({order:await present(result.order)},result.created?201:200);
      }
      const claimMatch=path.match(/^\/api\/v1\/orders\/([A-Za-z0-9]+)\/binance-claim$/);
      if(claimMatch&&method==='POST'){
        limit('binance-claim:'+user.id,10,60000);const b=await body(req);
        if(Object.keys(b).some(k=>k!=='transactionId'))throw new PaymentError('INVALID_CLAIM','仅需提交币安交易号。');
        return json({order:await present(await store.submitManualPayment(claimMatch[1],user.id,b.transactionId))});
      }
      if(path==='/api/v1/orders'&&method==='POST'){
        if(config.enabled&&!callbackReady(config))throw new PaymentError('CALLBACK_OFFLINE','到账通知入口未就绪，暂不创建新付款。',503);
        limit('orders:'+user.id,10,60000);const b=await body(req),product=productFor(config,b);
        const key=req.headers.get('idempotency-key');if(!key||!/^[A-Za-z0-9_-]{16,100}$/.test(key))throw new PaymentError('IDEMPOTENCY_REQUIRED','缺少有效请求标识。');
        const result=await store.createOrder(user.id,key,hash(JSON.stringify({planId:b.planId,cycle:b.cycle,kind:b.kind})),product,b.cycle,config.pid);
        if(!result.created)return json({order:publicOrder(result.order)},200);
        try{const data=await gateway.create(result.order);return json({order:publicOrder(await store.attachGateway(result.order.id,data))},201);}catch(error){if(error.noTransaction)await store.markFailed(result.order.id);else await store.markReview(result.order.id);return json({code:error instanceof PaymentError?error.code:'GATEWAY_ERROR',message:error.noTransaction?'收款通道暂时不可用，此订单未进入收银台。':'交易创建结果尚未确认，请查看此订单或联系管理员。请勿重复付款。',order:publicOrder(await store.order(result.order.id))},502);}
      }
      const match=path.match(/^\/api\/v1\/orders\/([A-Za-z0-9]+)$/);
      if(match&&method==='GET'){
        let order=await store.ownOrder(match[1],user.id);
        if(config.enabled&&order.status==='pending'&&order.trade_id&&Date.now()-order.updated_at>=10000){
          try{const state=await gateway.status(order.trade_id);if(Number(state.status)===3&&String(state.trade_id)===order.trade_id)await store.expire(order.id);else await store.touchOrder(order.id);}catch{/* Only signed callbacks can confirm paid. Preserve local state if gateway unavailable. */}
          order=await store.order(order.id);
        }
        return json({order:await present(order)});
      }
      if(path==='/api/v1/gifts/redeem'&&method==='POST'){limit('redeem:'+user.id,10,60000);const b=await body(req);if(typeof b.code!=='string'||!/^CLOAK-[A-F0-9]{40}$/.test(b.code))throw new PaymentError('INVALID_GIFT','兑换码格式无效。');return json(await store.redeem(user.id,b.code));}
      throw new PaymentError('NOT_FOUND','接口不存在。',404);
    }catch(e){if(e instanceof PaymentError)return json({code:e.code,message:e.message},e.status);return json({code:'INTERNAL_ERROR',message:'服务暂时不可用，请联系管理员。'},500);}
  };
}
