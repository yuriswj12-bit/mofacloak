// Reference display only. The signed gateway transaction determines the actual amount.
export class Quotes{
  constructor(config,fetchImpl=fetch){this.config=config;this.fetch=fetchImpl;this.cached=null;this.inflight=null;}
  async current(){
    if(!this.config.rateURL)return {available:false,message:'参考汇率尚未配置，实际金额以收银台为准。'};
    if(this.cached&&Date.now()-this.cached.fetchedAt<300000)return this.cached;
    if(this.inflight)return this.inflight;
    this.inflight=this.load().catch(()=>({available:false,message:'暂时无法取得参考汇率，请以收银台实际报价为准。'})).finally(()=>{this.inflight=null;});
    return this.inflight;
  }
  async load(){
    const response=await this.fetch(this.config.rateURL,{redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw Error('Rate unavailable');
    const raw=await response.text();if(raw.length>65536)throw Error('Rate too large');
    const data=JSON.parse(raw),rate=data.cny?.usdt;
    if(typeof rate!=='number'||!Number.isFinite(rate)||rate<=0||typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date))throw Error('Invalid rate');
    const converted=cents=>Number((cents/100*rate).toFixed(2));
    this.cached={available:true,referenceOnly:true,sourceDate:data.date,fetchedAt:Date.now(),usdtPerCny:rate,plans:this.config.plans.map(p=>({id:p.id,month:p.monthlyCurrency==='USD'?(typeof data.cny.usd==='number'&&data.cny.usd>0?Number((p.priceCents/100*rate/data.cny.usd).toFixed(2)):null):converted(p.priceCents),year:converted(p.annualCents)}))};
    return this.cached;
  }
}
