import {PaymentError} from './gmpay.mjs';

// Freeze a live conversion into an exact USDT amount for this order.
export async function uidQuote(config,quotes,body){
  if(!config.binanceEnabled||!config.binanceUid)throw new PaymentError('BINANCE_DISABLED','币安 UID 转账尚未开通。',503);
  const q=await quotes.current();
  const date=Date.parse(q.sourceDate+'T00:00:00Z');
  const amount=q.plans?.find(p=>p.id===body.planId)?.[body.cycle];
  if(!q.available||!Number.isFinite(date)||Date.now()-date>3*86400000||date>Date.now()+86400000||typeof amount!=='number'||!Number.isFinite(amount)||amount<=0)throw new PaymentError('QUOTE_UNAVAILABLE','暂时无法取得有效的 USDT 报价，请稍后重试。',503);
  const dueCents=Math.round(amount*100);
  if(!Number.isSafeInteger(dueCents)||dueCents<1)throw new PaymentError('QUOTE_UNAVAILABLE','USDT 报价无效。',503);
  return {uid:config.binanceUid,dueCents,source:config.rateURL+' # '+q.sourceDate};
}
