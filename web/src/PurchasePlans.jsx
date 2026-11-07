import React,{useState} from 'react';
import {ArrowRight,Check,MagicWand,Plus,ShieldCheck,Star} from '@phosphor-icons/react';
import {PLANS,priceFor,money,referenceFor} from './pricing.js';
import './navigation-pages.css';

export function PlansPage({cycle,setCycle,currency,setCurrency,onChoose,plans=PLANS,quote,enabled=false}){
  const [faq,setFaq]=useState(null);
  const faqs=[
    ['人民币和 USDT 有什么区别？','常规套餐以人民币定价；基础版月付当前临时设为5美元测试价。当前已配置的实际收款方式是 USDT / BSC；支付宝、微信支付尚未开通，不能通过个人收款码自动核验到账。'],
    ['年付如何计费？','常规年付按照原人民币月价乘以 12，再优惠 20%；5美元临时测试价不适用年付。页面展示整年人民币应付金额；USDT 实付由网关按订单创建时的有效汇率换算。'],
    ['为什么 USDT 金额有“约”？','这里显示最新可用汇率数据计算的参考值。汇率数据会定期更新，金额精度或同地址订单匹配也可能影响实际应付数量，请以收银台为准。'],
    ['付款后如何确认和开通？','只有通过验签的网关通知会确认付款。付款后进入待开通队列，服务管理员完成真实套餐与订阅交付后才能使用。']
  ];
  return <div className="pricing-page">
    <div className="pricing-hero"><span className="pricing-brand"><MagicWand size={28} weight="fill"/>魔法披风</span><h2>选择您的套餐</h2><div className="pricing-divider"><Star size={18} weight="fill"/></div><p>为每一次重要的连接，准备一件合适的披风</p></div>
    <div className="pricing-controls"><div className="segmented" aria-label="套餐周期">{[['month','按月'],['year','按年 · 省20%']].map(([v,t])=><button key={v} aria-pressed={cycle===v} className={cycle===v?'selected':''} onClick={()=>setCycle(v)}>{t}</button>)}</div><div className="segmented" aria-label="价格币种">{['CNY','USDT'].map(c=><button aria-pressed={currency===c} className={currency===c?'selected':''} key={c} onClick={()=>setCurrency(c)}>{c==='CNY'&&plans.some(p=>p.monthlyCurrency==='USD')?'标价':c}</button>)}</div></div>
    <div className="pricing-cards">{plans.map((p,i)=>{
      const baseCurrency=cycle==='year'?(p.annualCurrency||'CNY'):(p.monthlyCurrency||'CNY');
      const price=priceFor(p,cycle,'CNY'),reference=referenceFor(quote,p.id,cycle);
      const perks=[p.traffic?`${p.traffic} 月流量`:'流量额度待确认',p.devices?`${p.devices} 台设备`:'设备额度待确认','USDT / BSC 收款','付款确认后人工开通','主流客户端订阅导入'];
      return <section className={'pricing-tier '+(i===1?'popular':'')} key={p.id}>
        {i===1&&<div className="popular-ribbon">推荐套餐 <Star size={15} weight="fill"/></div>}<h3><span>{p.english}</span> {p.name}</h3><div className="tier-rule"/>
        <div className="tier-price">{price!==null&&currency==='CNY'?<><small>{baseCurrency==='USD'?'US$':'¥'}</small><strong>{Number.isInteger(price)?price:price.toFixed(2)}</strong><span>/{cycle==='year'?'年':'月'}</span></>:price!==null&&reference!==null?<><small>约</small><strong>{reference.toFixed(2)}</strong><span>USDT/{cycle==='year'?'年':'月'}</span></>:<strong className="quote-pending">{price===null?'报价待配置':'收银台报价'}</strong>}</div>
        <span className="annual-pill">{price===null?'套餐报价尚未配置':currency==='USDT'?`订单标价 ${money(price,baseCurrency)}`:cycle==='month'&&baseCurrency==='USD'?'基础版临时测试价 · 5 美元/月':cycle==='month'?`年付 ${money(p.annual)} · 省20%`:p.monthlyCurrency==='USD'?'常规年付价 · 不含月付测试优惠':`折合 ${money(price/12,baseCurrency)} / 月`}</span>
        <ul>{perks.map(t=><li key={t}><Check size={21} weight="bold"/>{t}</li>)}</ul><button className="btn primary full" onClick={()=>onChoose(p)}>{enabled?'选择'+p.name:'查看收款状态'}<ArrowRight size={18}/></button>
      </section>;
    })}</div>
    <div className="pricing-footnote"><ShieldCheck size={17}/><span>{currency==='USDT'&&quote?.available?`参考汇率日期 ${quote.sourceDate}；`:''}金额由服务端确定，USDT 实付以收银台为准。支付宝、微信支付待开通。</span></div>
    <section className="panel faq-panel"><h2>选购前，您可能想了解</h2>{faqs.map(([q,a],i)=><div className="faq-item" key={q}><button onClick={()=>setFaq(faq===i?null:i)} aria-expanded={faq===i}>{q}<Plus size={18} className={faq===i?'rotated':''}/></button>{faq===i&&<p>{a}</p>}</div>)}</section>
  </div>;
}
