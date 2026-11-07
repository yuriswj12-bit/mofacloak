import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {localProfile,ensureLocalAccount,webRoot} from './local-profile.mjs';

const children=[];let stopping=false;
function stop(code=0){
  if(stopping)return;stopping=true;process.exitCode=code;
  for(const child of children)if(child.exitCode===null&&!child.killed)child.kill('SIGTERM');
}
process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
async function available(port,host){
  await new Promise((done,reject)=>{
    const server=createServer();server.once('error',()=>reject(Error(`端口 ${port} 已被占用。先停止已有预览；启动器不会关闭未知进程。`)));
    server.listen(port,host,()=>server.close(done));
  });
}
function start(args,env){
  const child=spawn(process.execPath,args,{cwd:webRoot,env:{...process.env,...env},stdio:'inherit',windowsHide:true});
  children.push(child);
  child.once('error',()=>{console.error('无法启动开发进程。');stop(1);});
  child.once('exit',code=>{if(!stopping){console.error('开发进程已退出，正在停止另一进程。');stop(code||1);}});
  return child;
}
try{
  const {values}=parseArgs({options:{lan:{type:'string'}}});
  if(Number(process.versions.node.split('.')[0])<24)throw Error('需要 Node.js 24 或更高版本。');
  if(!existsSync(resolve(webRoot,'node_modules/vite/bin/vite.js')))throw Error('尚未安装依赖，请先在 web 目录运行 npm ci。');
  const profile=localProfile({lanIp:values.lan});
  await available(8788,'127.0.0.1');await available(4173,profile.host);
  const account=ensureLocalAccount(profile);
  console.log(`本地开发：${profile.origin}\n登录凭据文件：${account.file}\n${profile.env.PAYMENTS_ENABLED==='true'?'仅本机 USDT 真实收款已配置，待钱包实付验收':'收款关闭'}；账户与订单持久化。按 Ctrl+C 停止前后端。`);
  if(values.lan)console.log('局域网模式：其他设备使用上述 IPv4 地址；不会自动修改系统防火墙或暴露到互联网。');
  start(['server/index.mjs'],profile.env);
  start(['node_modules/vite/bin/vite.js','--host',profile.host,'--port','4173','--strictPort'],profile.env);
}catch(error){console.error(error.message);stop(1);}
