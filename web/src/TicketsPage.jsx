import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowClockwise,CheckCircle,ChatCircleText,PaperPlaneTilt,Plus} from '@phosphor-icons/react';
import {api} from './payments.jsx';
import './tickets.css';

const categories={connection:'连接问题',payment:'支付问题',subscription:'套餐与订阅',other:'其他问题'};
const date=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export function TicketsPage({account}){
  const [items,setItems]=useState([]),[selected,setSelected]=useState(null),[creating,setCreating]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [title,setTitle]=useState(''),[category,setCategory]=useState('connection'),[message,setMessage]=useState(''),[reply,setReply]=useState('');
  const createKey=useRef(crypto.randomUUID()),replyKey=useRef(crypto.randomUUID()),active=useRef(null);
  async function list(){const result=await api('/tickets');setItems(result.tickets);}
  useEffect(()=>{
    if(!account){setLoading(false);return;}
    let mounted=true;
    async function refresh(){try{const result=await api('/tickets');if(mounted)setItems(result.tickets);}catch(e){if(mounted)setError(e.message);}finally{if(mounted)setLoading(false);}}
    refresh();const timer=setInterval(refresh,20000);return()=>{mounted=false;clearInterval(timer);};
  },[account?.id]);
  useEffect(()=>{
    if(!selected?.id)return;
    const id=selected.id;let mounted=true;
    const timer=setInterval(async()=>{try{const result=await api('/tickets/'+id);if(mounted&&active.current===id)setSelected(result.ticket);}catch{}},15000);
    return()=>{mounted=false;clearInterval(timer);};
  },[selected?.id]);
  async function select(id){
    active.current=id;setBusy(true);setError('');setNotice('');
    try{const result=await api('/tickets/'+id);if(active.current===id){setSelected(result.ticket);setReply('');replyKey.current=crypto.randomUUID();}}
    catch(e){if(active.current===id)setError(e.message);}finally{setBusy(false);}
  }
  async function submit(e){
    e.preventDefault();setBusy(true);setError('');
    try{
      const result=await api('/tickets',{method:'POST',headers:{'idempotency-key':createKey.current},body:JSON.stringify({title,category,message})});
      active.current=result.ticket.id;setSelected(result.ticket);setCreating(false);setTitle('');setMessage('');createKey.current=crypto.randomUUID();setNotice('工单已提交，服务管理员可查看并回复。');await list();
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function send(e){
    e.preventDefault();setBusy(true);setError('');
    try{const result=await api('/tickets/'+selected.id+'/messages',{method:'POST',headers:{'idempotency-key':replyKey.current},body:JSON.stringify({message:reply})});setSelected(result.ticket);setReply('');replyKey.current=crypto.randomUUID();setNotice('补充内容已发送。');await list();}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function close(){
    setBusy(true);setError('');try{const result=await api('/tickets/'+selected.id+'/close',{method:'POST',body:'{}'});setSelected(result.ticket);setNotice('工单已关闭。');await list();}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  const back=()=>{active.current=null;setSelected(null);setCreating(false);setError('');setNotice('');};
  const startNew=()=>{createKey.current=crypto.randomUUID();setTitle('');setMessage('');setCreating(true);setError('');setNotice('');};
  if(!account)return <section className="panel ticket-empty"><ChatCircleText size={38}/><h2>登录后提交工单</h2><p>使用您的账户访问码登录，查看仅属于自己的问题与回复。</p></section>;
  return <section className="ticket-workspace">
    <div className="ticket-toolbar"><div><h2>{creating?'提交新工单':selected?'工单详情':'我的工单'}</h2><p>连接、付款和套餐问题，在这里继续沟通。</p></div>{creating||selected?<button className="btn small" onClick={back} disabled={busy}><ArrowLeft size={16}/>返回列表</button>:<button className="btn primary" onClick={startNew} disabled={busy}><Plus size={17}/>新建工单</button>}</div>
    {error&&<p className="ticket-alert" role="alert">{error}</p>}{notice&&<p className="ticket-notice" role="status"><CheckCircle size={17}/>{notice}</p>}
    {creating?<form className="panel ticket-form" onSubmit={submit}>
      <label htmlFor="ticket-title">工单标题</label><input id="ticket-title" value={title} onChange={e=>setTitle(e.target.value)} placeholder="简要描述您遇到的问题" required maxLength={80} disabled={busy}/>
      <label htmlFor="ticket-category">问题分类</label><select id="ticket-category" value={category} onChange={e=>setCategory(e.target.value)} disabled={busy}>{Object.entries(categories).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
      <label htmlFor="ticket-message">问题描述</label><textarea id="ticket-message" value={message} onChange={e=>setMessage(e.target.value)} placeholder="请描述出现时间、设备与客户端、错误提示及已尝试的操作。" required maxLength={4000} rows={7} disabled={busy}/>
      <p className="ticket-hint">请勿提交钱包私钥、助记词、账户访问码或商户密钥。无需上传文件即可描述问题。</p><button className="btn primary" disabled={busy||!title.trim()||!message.trim()}><PaperPlaneTilt size={17}/>{busy?'正在提交…':'提交工单'}</button>
    </form>:selected?<>
      <div className="panel ticket-detail-heading"><div><span className={'ticket-status '+selected.status}>{selected.statusLabel}</span><span className="ticket-category">{categories[selected.category]}</span><h3>{selected.title}</h3><p>{selected.id} · 创建于 {date(selected.createdAt)}</p></div>{selected.status!=='closed'&&<button className="btn small" onClick={close} disabled={busy}>关闭工单</button>}</div>
      <ol className="ticket-thread" aria-label="工单对话">{selected.messages.map(m=><li className={'panel ticket-message '+m.role} key={m.id}><div><strong>{m.role==='support'?'服务管理员':'我'}</strong><time dateTime={new Date(m.createdAt).toISOString()}>{date(m.createdAt)}</time></div><p>{m.body}</p></li>)}</ol>
      {selected.status==='closed'?<section className="panel ticket-closed"><CheckCircle size={22}/><p>工单已关闭。若有新的问题，可以新建工单。</p></section>:<form className="panel ticket-form" onSubmit={send}><label htmlFor="ticket-reply">补充内容</label><textarea id="ticket-reply" rows={4} value={reply} onChange={e=>setReply(e.target.value)} required maxLength={4000} disabled={busy}/><button className="btn primary" disabled={busy||!reply.trim()}><PaperPlaneTilt size={17}/>{busy?'正在发送…':'发送补充'}</button></form>}
    </>:<section className="panel ticket-list-panel">
      <div className="ticket-list-heading"><span>最近 100 条工单</span><button className="text-btn" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await list();}catch(e){setError(e.message);}finally{setBusy(false);}}}><ArrowClockwise size={16}/>刷新</button></div>
      {loading?<p className="ticket-hint">正在读取工单…</p>:!items.length?<div className="ticket-empty"><ChatCircleText size={40}/><h3>还没有工单</h3><p>遇到问题时，提交一张工单并保留沟通记录。</p><button className="btn" onClick={startNew}>提交第一张工单</button></div>:<div className="ticket-list">{items.map(t=><button className="ticket-row" key={t.id} onClick={()=>select(t.id)} disabled={busy}><div><span className={'ticket-status '+t.status}>{t.statusLabel}</span><strong>{t.title}</strong><span className="ticket-category">{categories[t.category]}</span></div><small>{date(t.updatedAt)}</small></button>)}</div>}
    </section>}
  </section>;
}
