import React,{useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,ArrowClockwise,CheckCircle,Clock,Lock,SignIn,WarningCircle,Wallet} from '@phosphor-icons/react';
import {money} from './pricing.js';
import {recoveryKey,recoverRequest,forgetRequest,paymentExpired} from './payment-recovery.js';
import './payments.css';

export async function api(path,options={}){
  let res;try{res=await fetch('/api/v1'+path,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30000),...options,headers:{'content-type':'application/json',...options.headers}});}catch{throw new Error('服务暂时无法连接，请稍后重试。');}
  let body;try{body=await res.json();}catch{throw new Error('服务响应异常，请联系管理员。');}
  if(!res.ok){const error=new Error(body.message||'请求失败，请稍后重试。');error.status=res.status;error.code=body.code;error.order=body.order;throw error;}return body;
}
export function usePaymentAccount(){
  const [config,setConfig]=useState({enabled:false,loading:true,message:'正在检查支付通道…',plans:[]});
  const [state,setState]=useState({account:null,orders:[],gifts:[],subscription:null});
  const [quote,setQuote]=useState({available:false});
  const [accountError,setAccountError]=useState('');
  const accountSequence=useRef(0),sessionChannel=useRef(null);
  const refresh=useCallback(async()=>{const sequence=++accountSequence.current;try{const next=await api('/account');if(sequence===accountSequence.current){setState(next);setAccountError('');}}catch(e){if(sequence!==accountSequence.current)return;if(e.status===401){setState({account:null,orders:[],gifts:[],subscription:null});setAccountError('');}else{setAccountError('账户数据暂时无法刷新，当前可能显示上次结果。请重试。');throw e;}}},[]);
  useEffect(()=>{
    if(typeof BroadcastChannel==='undefined')return;
    const channel=new BroadcastChannel('cloak-account-session');sessionChannel.current=channel;
    channel.onmessage=e=>{if(e.data==='logout'){accountSequence.current++;setState({account:null,orders:[],gifts:[],subscription:null});setAccountError('');}else if(e.data==='login')refresh().catch(()=>{});};
    return()=>{channel.close();sessionChannel.current=null;};
  },[refresh]);
  useEffect(()=>{let active=true,inFlight=false;
    const update=async()=>{if(inFlight)return;inFlight=true;try{const v=await api('/payments/config');if(active)setConfig({...v,loading:false,online:true});}catch(e){if(active)setConfig(v=>({...v,enabled:false,online:false,loading:false,message:e.message}));}finally{inFlight=false;}};
    update();refresh().catch(()=>{});const timer=setInterval(update,15000);window.addEventListener('focus',update);
    return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',update);};
  },[refresh]);
  useEffect(()=>{if(!state.account)return;const id=setInterval(()=>refresh().catch(()=>{}),15000);return()=>clearInterval(id);},[state.account?.id,refresh]);
  useEffect(()=>{if(!config.plans?.length)return;let active=true;const update=()=>api('/payments/quote').then(v=>{if(active)setQuote(v);}).catch(()=>{if(active)setQuote({available:false});});update();const timer=setInterval(update,300000);return()=>{active=false;clearInterval(timer);};},[config.plans?.length]);
  const login=async accessCode=>{await api('/auth/login',{method:'POST',body:JSON.stringify({accessCode})});sessionChannel.current?.postMessage('login');await refresh();};
  const logout=async()=>{await api('/auth/logout',{method:'POST',body:'{}'});accountSequence.current++;setState({account:null,orders:[],gifts:[],subscription:null});setAccountError('');sessionChannel.current?.postMessage('logout');};
  return {config,quote,...state,accountError,refresh,login,logout};
}
export function AccountLogin({account,onLogin,onLogout}){
  const [code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  if(account)return <div className="signed-account"><CheckCircle size={23}/><div><strong>{account.name}</strong><p>已登录，付款订单归属于当前账户</p></div><button className="btn small" onClick={onLogout}>退出登录</button></div>;
  return <form className="account-login" noValidate onSubmit={async e=>{e.preventDefault();setError('');const access=code.trim();if(!/^[A-Za-z0-9_-]{43}$/.test(access)){setError('请粘贴邀请人提供的完整 43 位访问码。这不是需要自行设置的密码。');return;}setBusy(true);try{await onLogin(access);setCode('');}catch(err){setError(err.message);}finally{setBusy(false);}}}><div className="login-explainer"><Lock size={25}/><div><h3>账户登录</h3><p>粘贴邀请人提供的账户访问码，查看和支付自己的订单；没有访问码请联系邀请人。</p></div></div><label htmlFor="payment-access-code">账户访问码</label><input id="payment-access-code" type="password" autoComplete="current-password" placeholder="粘贴完整的 43 位访问码" value={code} disabled={busy} aria-invalid={!!error} aria-describedby={error?'login-error':undefined} onChange={e=>setCode(e.target.value)} required minLength={43} maxLength={43}/>{error&&<p id="login-error" role="alert" className="field-error">{error}</p>}<button className="btn primary full" disabled={busy}>{busy?'正在登录…':<><SignIn size={17}/>登录账户</>}</button></form>;
}
export function PaymentDialog({portal,plan,cycle='month',kind='plan',orderId,onOrders}){
  const [order,setOrder]=useState(()=>portal.orders.find(o=>o.id===orderId)||null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
  const activePlan=portal.config.plans?.find(p=>p.id===plan?.id);
  const activeCurrency=cycle==='year'?(activePlan?.annualCurrency||'CNY'):(activePlan?.monthlyCurrency||'CNY');
  const recoveryName=recoveryKey(portal.account?.id,plan?.id,cycle,kind)+':'+activeCurrency+':'+(cycle==='year'?activePlan?.annual:activePlan?.price);
  const key=useRef(null),refreshing=useRef(false);
  const [now,setNow]=useState(Date.now());
  async function copyPayment(value){try{await navigator.clipboard.writeText(value);setNote('已复制，请在付款钱包中再次核对。');}catch{setError('复制失败，请在收银台手动核对并复制。');}}
  useEffect(()=>{if(!portal.account||orderId)return;key.current=recoverRequest(window.sessionStorage,recoveryName);},[portal.account?.id,recoveryName,orderId]);
  useEffect(()=>{if(!order?.id)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[order?.id]);
  useEffect(()=>{if(order?.paymentStatus==='paid')forgetRequest(window.sessionStorage,recoveryName);},[order?.paymentStatus,recoveryName]);
  useEffect(()=>{if(!orderId||order||!portal.account)return;let active=true;api('/orders/'+orderId).then(data=>{if(active)setOrder(data.order);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[orderId,order?.id,portal.account?.id]);
  const configuredPlan=portal.config.plans?.find(p=>p.id===plan?.id);
  const amount=configuredPlan?(cycle==='year'?configuredPlan.annual:configuredPlan.price):null;
  const refreshOrder=useCallback(async()=>{if(!order?.id||refreshing.current)return;refreshing.current=true;try{const data=await api('/orders/'+order.id);setOrder(data.order);await portal.refresh();return data.order;}finally{refreshing.current=false;}},[order?.id,portal.refresh]);
  useEffect(()=>{if(!order?.id||['paid','expired','failed'].includes(order.paymentStatus))return;const id=setInterval(()=>refreshOrder().catch(()=>{}),10000);return()=>clearInterval(id);},[order?.id,order?.paymentStatus,refreshOrder]);
  async function create(){setBusy(true);setError('');try{key.current||=recoverRequest(window.sessionStorage,recoveryName);const data=await api('/orders',{method:'POST',headers:{'idempotency-key':key.current},body:JSON.stringify({planId:plan.id,cycle,kind})});setOrder(data.order);await portal.refresh();}catch(e){if(e.order){setOrder(e.order);await portal.refresh().catch(()=>{});}setError(e.message);}finally{setBusy(false);}}
  if(portal.config.loading)return <p className="muted">正在检查支付通道…</p>;
  if(!portal.config.enabled&&!order&&!orderId)return <div className="payment-unavailable"><span className="payment-state-icon"><Wallet size={42}/></span><h3>支付尚未开通</h3><p>{portal.config.message||'支付通道暂不可用，当前不接受新付款。'}</p><div className="payment-network"><span>计划收款通道</span><strong>USDT · BSC（BEP20）</strong></div><p className="field-hint">通道开通后，订单会由 GM Pay 收银台处理。此处不会生成收款地址或已付款记录。</p></div>;
  if(!portal.account)return <AccountLogin account={null} onLogin={portal.login} onLogout={portal.logout}/>;
  if(orderId&&!order)return <p className={error?'field-error':'muted'}>{error||'正在读取订单…'}</p>;
  if(order){const paid=order.paymentStatus==='paid',expired=paymentExpired(order,now),pending=order.paymentStatus==='pending'&&!expired;return <div className="real-order-detail"><div className="payment-result"><span className={'payment-state-icon '+(paid?'paid':'')}>{paid?<CheckCircle size={42}/>:<Clock size={42}/>}</span><h3>{paid?'付款已确认':expired?'订单已过期':order.status}</h3><p>{paid?(order.kind==='gift'?'礼品卡已签发，可在礼品卡页面查看。':'套餐已进入待开通队列，请等待服务交付。'):pending?'请在收银台完成 USDT / BSC 支付。':expired?'请勿向此订单继续付款。已转账但尚未确认的，请保留交易哈希并联系管理员，勿重复支付。':'此订单暂不能继续付款，请联系服务管理员核对。'}</p></div><div className="detail-lines"><p><span>订单号</span><strong className="mono">{order.id}</strong></p><p><span>商品</span><strong>{order.name}</strong></p><p><span>订单原价</span><strong>{money(order.amount,order.currency)}</strong></p>{order.actualAmount&&<p><span>网关应付</span><strong>{order.actualAmount} USDT</strong></p>}<p><span>支付网络</span><strong>BSC / BEP20</strong></p>{order.expiresAt&&<p><span>支付有效期（北京时间）</span><strong>{new Date(order.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</strong></p>}{pending&&<p><span>剩余付款时间</span><strong>{Math.max(0,Math.floor((order.expiresAt-now)/60000))}分{Math.max(0,Math.floor((order.expiresAt-now)/1000)%60)}秒</strong></p>}{order.receiveAddress&&<p><span>收款地址</span><strong className="tx-hash">{order.receiveAddress}</strong></p>}{pending&&<p><span>复制收款信息</span><strong><button className="text-btn" onClick={()=>copyPayment(order.receiveAddress)}>复制地址</button> · <button className="text-btn" onClick={()=>copyPayment(String(order.actualAmount))}>复制金额</button></strong></p>}{order.txHash&&<p><span>链上交易</span><strong className="tx-hash"><a href={'https://bscscan.com/tx/'+encodeURIComponent(order.txHash)} target="_blank" rel="noopener noreferrer">{order.txHash}</a></strong></p>}</div>{pending&&order.paymentUrl&&portal.config.enabled&&<><a className="btn primary full" href={order.paymentUrl} target="_blank" rel="noopener noreferrer">前往 GM Pay 收银台<ArrowUpRight size={18}/></a><button className="btn full" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const o=await refreshOrder();setNote(o?.paymentStatus==='paid'?'付款已由服务端确认。':'暂未收到付款确认，请等待链上确认与网关通知。');}catch(e){setError(e.message);}finally{setBusy(false);}}}><ArrowClockwise size={17}/>我已付款，刷新状态</button><p className="field-hint">请按收银台当前展示的网络、地址和精确金额付款。页面返回本身不会改变支付状态。</p></>}{pending&&!portal.config.enabled&&<p role="alert" className="field-error">支付通道暂不可用，暂缓转账；已付款请等待确认并保留交易哈希。</p>}{(expired||order.paymentStatus==='failed')&&plan&&<button className="btn primary full" onClick={()=>{forgetRequest(window.sessionStorage,recoveryName);key.current=recoverRequest(window.sessionStorage,recoveryName);setOrder(null);setError('');setNote('');}}>重新创建订单（仅在尚未转账时）</button>}{note&&<p role="status" className="payment-note">{note}</p>}{error&&<p className="field-error" role="alert">{error}</p>}<button className="btn full" onClick={onOrders}>查看我的订单</button></div>;}
  return <><div className="checkout-product"><Wallet size={33} className="purple"/><div><h3>{configuredPlan?.name||plan?.name}{kind==='gift'?'礼品卡':''}</h3><p>{cycle==='year'?'12 个月':'1 个月'} · USDT / BSC</p></div></div><fieldset className="payment-channels"><legend>付款方式</legend><label><input type="radio" name="payment-channel" checked readOnly/>USDT / BSC</label><label className="not-ready"><input type="radio" name="payment-channel" disabled/>支付宝 · 未开通</label><label className="not-ready"><input type="radio" name="payment-channel" disabled/>微信支付 · 未开通</label></fieldset><div className="checkout-line total"><span>订单金额</span><strong>{amount===null?'报价未配置':money(amount,activeCurrency)}</strong></div><div className="payment-network"><span>收款网络</span><strong>USDT · BSC（BEP20）</strong></div><p className="notice-line">仅使用 BSC（BEP20）网络的 USDT，按收银台精确金额转账；钱包需预留 BNB 网络费。不要使用其他网络或代币。付款后等待链上确认，勿重复转账。套餐尚需管理员开通；积分抵扣暂未开放。</p>{error&&<p className="field-error" role="alert">{error}</p>}<button className="btn primary full" onClick={create} disabled={busy||amount===null}>{busy?'正在创建订单…':'创建订单并获取收银台'}<ArrowUpRight size={17}/></button></>;
}
export function PaymentBanner({config,onSettings}){return <div className={'payment-banner '+(config.enabled?'ready':'')}><span><Wallet size={18}/>{config.loading?'正在检查支付通道':config.enabled?'USDT / BSC 支付通道已配置':'USDT / BSC 支付尚未开通'}</span><button className="text-btn" onClick={onSettings}>{config.enabled?'账户与订单':'查看状态'}<ArrowUpRight size={15}/></button></div>}
