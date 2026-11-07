import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
import {openStore,hash} from '../server/store.mjs';
import {loadConfig} from '../server/config.mjs';

export const webRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const template=`# Local development only; production uses deploy/config/portal.env.
NODE_ENV=development
HOST=127.0.0.1
PORT=8788
PUBLIC_ORIGIN=http://127.0.0.1:4173
DATABASE_PATH=data/portal.sqlite
TRUST_PROXY=false
PAYMENTS_ENABLED=false
GMPAY_BASE_URL=
GMPAY_PID=
GMPAY_SECRET_KEY=
PAYMENT_CATALOG_FILE=config/payment-catalog.json
`;

export function localProfile({root=webRoot,lanIp}={}){
  const file=resolve(root,'.local-runtime.env');
  if(!existsSync(file))writeFileSync(file,template,{flag:'wx',mode:0o600});
  const env=parseEnv(readFileSync(file,'utf8'));
  if(env.NODE_ENV!=='development'||env.HOST!=='127.0.0.1'||env.PORT!=='8788'||env.TRUST_PROXY!=='false'||env.PUBLIC_ORIGIN!=='http://127.0.0.1:4173'||!['true','false'].includes(env.PAYMENTS_ENABLED)||!env.DATABASE_PATH||env.DATABASE_PATH===':memory:')throw Error('本地配置不符合开发模式要求。请检查 .local-runtime.env。');
  if(env.PAYMENTS_ENABLED==='true'){
    if(env.ALLOW_LOOPBACK_GMPAY!=='true'||env.GMPAY_BASE_URL!=='http://127.0.0.1:8000'||lanIp)throw Error('本地真实收款仅允许明确开启的同机回环连接；生产仍必须 HTTPS。');
    loadConfig(env);
  }
  if(lanIp){
    const addresses=Object.values(networkInterfaces()).flat().filter(Boolean).filter(a=>!a.internal).map(a=>a.address);
    if(isIP(lanIp)!==4||!addresses.includes(lanIp))throw Error('--lan 必须指定本机实际拥有的局域网 IPv4 地址。');
  }
  return {env:{...env,PUBLIC_ORIGIN:`http://${lanIp||'127.0.0.1'}:4173`},dbPath:resolve(root,env.DATABASE_PATH),host:lanIp||'127.0.0.1',origin:`http://${lanIp||'127.0.0.1'}:4173`};
}

export function ensureLocalAccount(profile){
  const file=resolve(dirname(profile.dbPath),'local-access.json');
  const store=openStore(profile.dbPath);
  try{
    if(existsSync(file)){
      const saved=JSON.parse(readFileSync(file,'utf8'));
      const account=store.db.prepare('SELECT id FROM accounts WHERE id=? AND access_hash=? AND enabled=1').get(saved.accountId,hash(saved.accessCode));
      if(!account)throw Error('本地访问码文件与数据库不匹配或账户已停用；请检查文件，不自动覆盖现有凭据。');
      return {file,accountId:account.id,created:false};
    }
    mkdirSync(dirname(file),{recursive:true,mode:0o700});
    let result;
    store.transaction(()=>{
      const account=store.createAccount('本地开发账户');
      writeFileSync(file,JSON.stringify({accountId:account.id,name:account.name,accessCode:account.accessCode,note:'真实本地账户的登录凭据。请勿提交 Git、公开分享或放入迁移安装包。'},null,2)+'\n',{flag:'wx',mode:0o600});
      result={file,accountId:account.id,created:true};
    });
    return result;
  }finally{store.close();}
}
