import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {localProfile} from './local-profile.mjs';

// SQLite's online backup includes committed WAL contents. No source file is moved.
export async function snapshotDatabase(source,destination){
  if(!existsSync(source))throw Error('源数据库不存在，请先启动本地服务。');
  if(existsSync(destination))throw Error('目标目录已存在；不会覆盖已有快照。');
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  mkdirSync(destination,{mode:0o700});
  const output=join(destination,'portal.sqlite');
  const db=new DatabaseSync(source,{readOnly:true});
  try{await backup(db,output);}finally{db.close();}
  chmodSync(output,0o600);
  const check=new DatabaseSync(output,{readOnly:true});let counts;
  try{
    if(Object.values(check.prepare('PRAGMA integrity_check').get())[0]!=='ok')throw Error('快照完整性检查失败。');
    counts={};
    for(const table of ['accounts','orders','payment_events','fulfillment_jobs','gifts','tickets','ticket_messages']){
      if(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))counts[table]=check.prepare(`SELECT count(*) n FROM ${table}`).get().n;
    }
  }finally{check.close();}
  const digest=createHash('sha256').update(readFileSync(output)).digest('hex');
  writeFileSync(join(destination,'portal.sqlite.sha256'),`${digest}  portal.sqlite\n`,{mode:0o600});
  writeFileSync(join(destination,'snapshot.json'),JSON.stringify({format:1,createdAt:new Date().toISOString(),node:process.version,sha256:digest,counts,note:'包含真实业务数据。只有 SQLite 快照，没有明文访问码、环境变量或 GM Pay 数据。'},null,2)+'\n',{mode:0o600});
  return {directory:destination,counts};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const {dbPath}=localProfile();
    const stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex');
    const result=await snapshotDatabase(dbPath,resolve(dirname(dbPath),'migrations',stamp));
    console.log(`已生成一致性迁移快照：${result.directory}\n未停止服务、未移动源数据、未包含明文访问码。`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
