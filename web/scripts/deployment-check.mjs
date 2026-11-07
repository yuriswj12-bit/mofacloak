import {readFileSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs,parseEnv} from 'node:util';
import {isIP} from 'node:net';
import {resolve4} from 'node:dns/promises';
import {loadConfig} from '../server/config.mjs';

const defaultDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'../../deploy');
const isDomain=value=>typeof value==='string'&&value.length<=253&&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)&&!/(?:^|\.)(?:example|invalid|test|localhost|local)$/.test(value);
const placeholder=value=>!value||/CHANGE_ME|YOUR_|replace.?me|example\.(?:com|net|org)/i.test(value);

async function readJSON(url,fetchImpl){
  const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{accept:'application/json'}});
  if(!response.ok)throw Error('HTTP');
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536)throw Error('Too large');chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{await reader.cancel().catch(()=>{});}
}

// Read-only. No merchant credentials are sent, no order is created, no transfer is signed.
// Deliberately returns fixed messages: raw config values / network exceptions can contain keys.
export async function checkDeployment({directory=defaultDirectory,online=false,expectedIp,fetchImpl=fetch,resolve4Impl=resolve4}={}){
  const checks=[];
  const add=(id,ok,message)=>checks.push({id,status:ok?'PASS':'FAIL',message});
  const warn=(id,message)=>checks.push({id,status:'WARN',message});
  const dir=resolve(directory);let deployment,portal,config;
  try{deployment=parseEnv(readFileSync(resolve(dir,'.env'),'utf8'));portal=parseEnv(readFileSync(resolve(dir,'config/portal.env'),'utf8'));add('files',true,'已读取部署配置，未打印任何密钥。');}
  catch{add('files',false,'缺少或无法读取 deploy/.env、config/portal.env；请先运行 prepare.sh 并填写。');return {ok:false,checks};}
  add('domains',isDomain(deployment.PORTAL_DOMAIN)&&isDomain(deployment.PAY_DOMAIN)&&deployment.PORTAL_DOMAIN!==deployment.PAY_DOMAIN,'主站与收款域名必须有效、不同，不能使用保留示例域名。');
  add('email',!placeholder(deployment.ACME_EMAIL)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(deployment.ACME_EMAIL||''),'证书联系邮箱必须填写。');
  add('runtime',portal.NODE_ENV==='production'&&portal.HOST==='127.0.0.1'&&portal.PORT==='8788'&&portal.TRUST_PROXY==='true'&&portal.DATABASE_PATH==='/app/data/portal.sqlite','检查生产模式、回环监听、端口、代理信任和持久化路径。');
  add('origins',portal.PUBLIC_ORIGIN===`https://${deployment.PORTAL_DOMAIN}`&&portal.GMPAY_BASE_URL===`https://${deployment.PAY_DOMAIN}`,'网站与网关必须使用对应 HTTPS 域名，不能含额外路径。');
  add('payment-switch',['true','false'].includes(portal.PAYMENTS_ENABLED),'收款开关只能是 true 或 false。');
  add('catalog-path',portal.PAYMENT_CATALOG_FILE==='/app/config/payment-catalog.json','套餐配置必须指向挂载目录。');
  try{
    // Validate the catalog even when payments are closed, using the existing production rules.
    config=loadConfig({...portal,PAYMENTS_ENABLED:'true',GMPAY_PID:portal.GMPAY_PID||'preflight-only',GMPAY_SECRET_KEY:portal.GMPAY_SECRET_KEY||'preflight-only',PAYMENT_CATALOG_FILE:resolve(dir,'config/payment-catalog.json')});
    add('catalog',true,'套餐金额和权益格式有效；这不代表经营者已确认售价。');
  }catch{add('catalog',false,'套餐目录、金额、权益或网关格式无效；检查配置文件。');}
  if(portal.PAYMENTS_ENABLED==='true')add('credentials',!placeholder(portal.GMPAY_PID)&&!placeholder(portal.GMPAY_SECRET_KEY),'已开启收款，必须填写真实配对的 PID 和商户密钥。');
  else warn('payments-closed','当前禁止创建新付款；可先部署网站、私下初始化网关。');
  if(process.platform!=='win32'){
    for(const [id,file] of [['deployment-permissions','.env'],['merchant-permissions','config/portal.env']]){
      add(id,(statSync(resolve(dir,file)).mode&0o077)===0,'含凭据配置不可供其他系统用户读取。');
    }
  }else warn('permissions','Windows 不核验 Linux 文件权限；在服务器上需再次检查。');
  if(expectedIp&&!online)add('dns-options',false,'expected-ip 需与 online 同时使用。');
  if(expectedIp&&isIP(expectedIp)!==4)add('expected-ip',false,'预期服务器地址必须是 IPv4。');
  if(online&&!checks.some(c=>c.status==='FAIL')){
    if(expectedIp){
      for(const [id,domain] of [['portal-dns',deployment.PORTAL_DOMAIN],['gateway-dns',deployment.PAY_DOMAIN]]){
        try{const addresses=await resolve4Impl(domain);add(id,addresses.includes(expectedIp),'A 记录应包含指定服务器 IPv4。');}catch{add(id,false,'无法解析 A 记录。');}
      }
    }else warn('dns','未指定服务器 IPv4，未检查 DNS 是否指向预期机器。');
    try{const data=await readJSON(`${portal.PUBLIC_ORIGIN}/api/v1/health`,fetchImpl);add('portal-health',data.status==='ok','公网 HTTPS 与网站数据库健康检查。');}catch{add('portal-health',false,'网站健康端点不可用，检查 DNS、证书、反向代理和数据库。');}
    try{
      const data=await readJSON(`${portal.PUBLIC_ORIGIN}/api/v1/payments/config`,fetchImpl);
      add('public-config',data.provider==='GM Pay'&&data.enabled===(portal.PAYMENTS_ENABLED==='true'),'公网收款开关应与当前配置一致。');
      if(portal.PAYMENTS_ENABLED==='true'&&config)add('public-prices',Array.isArray(data.plans)&&data.plans.length===config.plans.length&&config.plans.every(p=>data.plans.some(q=>q.id===p.id&&q.price===p.priceCents/100&&q.annual===p.annualCents/100&&q.devices===p.devices&&q.trafficGB===p.trafficGB)),'公网套餐与本次确认的价格、权益应一致。');
    }catch{add('public-config',false,'无法读取网站支付配置。');}
    try{
      const data=await readJSON(`${portal.GMPAY_BASE_URL}/payments/gmpay/v1/config`,fetchImpl);
      const ready=data.status_code===200&&Array.isArray(data.data?.supported_assets)&&data.data.supported_assets.some(a=>['binance','bsc'].includes(a.network)&&Array.isArray(a.tokens)&&a.tokens.some(t=>String(t).toLowerCase()==='usdt'));
      add('gateway-assets',ready,'网关应公开可用的 USDT / BSC 资产组合。');
    }catch{
      if(portal.PAYMENTS_ENABLED==='false')warn('gateway-assets','网关仍处于私下安装或不可用；开启收款前必须重新检查。');
      else add('gateway-assets',false,'无法读取网关资产配置，不能视为收款就绪。');
    }
    warn('mainnet-acceptance','只读检查不能证明 WSS 持续同步、密钥配对、主网到账、签名回调或真实交付；仍需逐项验收。');
  }
  return {ok:!checks.some(c=>c.status==='FAIL'),checks};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const {values}=parseArgs({options:{dir:{type:'string'},online:{type:'boolean'},'expected-ip':{type:'string'},json:{type:'boolean'}}});
    const report=await checkDeployment({directory:values.dir,online:values.online,expectedIp:values['expected-ip']});
    if(values.json)console.log(JSON.stringify(report,null,2));
    else{for(const c of report.checks)console.log(`${c.status} ${c.id}: ${c.message}`);console.log(report.ok?'配置检查通过；不等于主网收款验收通过。':'配置检查未通过，先修复 FAIL 项。');}
    if(!report.ok)process.exitCode=1;
  }catch{console.error('检查未完成。支持 --dir PATH、--online、--expected-ip IPv4、--json；需要 Node.js 24。');process.exitCode=1;}
}
