import {readFileSync,writeFileSync,createWriteStream,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
import {webRoot} from './local-profile.mjs';

try{
  const root=resolve(webRoot,'data/gmpay-local');
  const installation=JSON.parse(readFileSync(resolve(root,'installation.json'),'utf8'));
  const expectedRoot=(root+'/bin/').replaceAll('\\','/').toLowerCase();
  if(!resolve(installation.executable).replaceAll('\\','/').toLowerCase().startsWith(expectedRoot)||!existsSync(installation.executable))throw Error('安装信息中的可执行路径无效。');
  const digest=createHash('sha256').update(readFileSync(installation.executable)).digest('hex');
  if(digest!==installation.executableSha256)throw Error('网关程序校验失败，不执行。');
  const config=resolve(root,'.env'),env=parseEnv(readFileSync(config,'utf8'));
  if(env.http_listen!=='127.0.0.1:8000'||env.install!=='false')throw Error('本地网关必须绑定 127.0.0.1:8000 并关闭全网监听的安装向导。');
  const log=createWriteStream(resolve(root,'startup.log'),{flags:'a',mode:0o600});
  const child=spawn(installation.executable,['http','start'],{cwd:root,env:{...process.env,EPUSDT_CONFIG:config},stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  let initialOutput='';
  child.stdout.on('data',chunk=>{
    if(existsSync(resolve(root,'admin-access.json')))return;
    initialOutput=(initialOutput+chunk.toString('utf8')).slice(-16384);
    const text=initialOutput.replace(/\x1b\[[0-9;]*[A-Za-z]/g,''),match=text.match(/Password:\s+(\S+)\s+[║\r\n]/);
    if(match){try{writeFileSync(resolve(root,'admin-access.json'),JSON.stringify({username:'admin',password:match[1],note:'官方首次启动生成的初始凭据；修改密码后此文件不会自动更新。'},null,2)+'\n',{flag:'wx',mode:0o600});}catch{/* Existing files are never overwritten; original remains in the protected startup log. */}initialOutput='';}
  });
  console.log(`真实 GM Pay 本机地址：http://127.0.0.1:8000\n首次管理员凭据记录于：${resolve(root,'startup.log')}\n钱包与链上监听按现有网关配置运行；本命令不创建交易。按 Ctrl+C 停止。`);
  const stop=()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGTERM');};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  child.once('error',()=>{console.error('无法启动 GM Pay。');process.exitCode=1;log.end();});
  child.once('exit',code=>{log.end();process.exitCode=code||0;});
}catch(error){console.error(error.message+'\n安装命令：powershell -File ../deploy/setup-gmpay-local.ps1');process.exitCode=1;}
