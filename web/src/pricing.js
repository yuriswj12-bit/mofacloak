export const PLANS = [
  {id:'select',english:'Basic',name:'基础版'},
  {id:'premium',english:'Standard',name:'标准版'},
  {id:'exclusive',english:'Premium',name:'尊享版'},
];
export function priceFor(plan,cycle='month',currency='CNY'){
  if(currency!=='CNY')return null;
  const value=cycle==='year'?plan.annual:plan.price;
  return typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
}
export const money=(value,currency='CNY')=>value==null||!Number.isFinite(Number(value))?'待报价':currency==='USDT'?`${Number(value).toFixed(2)} USDT`:`${currency==='USD'?'US$':'¥'}${Number(value).toFixed(2)}`;
export const orderMoney=order=>money(order.quotedAmount??order.amount,order.currency??'CNY');
export function referenceFor(quote,planId,cycle){
  if(!quote?.available||quote.referenceOnly!==true||!Array.isArray(quote.plans))return null;
  const value=quote.plans.find(p=>p.id===planId)?.[cycle];
  return typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
}
