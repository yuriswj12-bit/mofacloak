import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs,parseEnv} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {snapshotDatabase} from './local-snapshot.mjs';
import {localProfile,webRoot} from './local-profile.mjs';
import {postgresDatabase,portalTables} from '../server/postgres-db.mjs';
import {hash} from '../server/store.mjs';

export async function copyPortal(sqlite,db){
  const checks=[];
  await db.transaction(async()=>{
    for(const table of portalTables){
      if((await db.prepare(`SELECT count(*) n FROM ${table}`).get()).n!==0)throw Error('Destination portal tables must be empty; existing records are never overwritten');
    }
    for(const table of portalTables){
      const info=sqlite.prepare(`PRAGMA table_info(${table})`).all();
      if(!info.length)throw Error('Missing source table: '+table);
      const columns=info.map(c=>c.name),primary=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      if(!primary.length||columns.some(c=>!/^[a-z][a-z0-9_]*$/.test(c)))throw Error('Unexpected source table schema');
      const projection=columns.map(c=>`"${c}"`).join(','),order=primary.map(c=>`"${c}"`).join(',');
      const rows=sqlite.prepare(`SELECT ${projection} FROM ${table} ORDER BY ${order}`).all();
      const insert=db.prepare(`INSERT INTO ${table}(${projection}) VALUES(${columns.map(()=>'?').join(',')})`);
      for(const row of rows)await insert.run(...columns.map(c=>row[c]));
      const actual=await db.prepare(`SELECT ${projection} FROM ${table} ORDER BY ${order}`).all();
      const sourceDigest=hash(JSON.stringify(rows)),destinationDigest=hash(JSON.stringify(actual));
      if(sourceDigest!==destinationDigest)throw Error('Migration row verification failed: '+table);
      checks.push({table,count:rows.length,sha256:sourceDigest});
    }
    await db.query("SELECT setval('cloak.ticket_messages_id_seq',COALESCE(MAX(id),1),MAX(id) IS NOT NULL) FROM ticket_messages");
  });
  return checks;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let sqlite,db;
  try{
    const {values}=parseArgs({options:{'connection-file':{type:'string'}}});
    if(!values['connection-file'])throw Error('Specify a private --connection-file with SUPABASE_DATABASE_URL and DATABASE_CA_FILE');
    const profile=localProfile();
    if(profile.env.DATABASE_PROVIDER==='supabase')throw Error('Already configured for cloud storage; refusing another import');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const snapshot=await snapshotDatabase(profile.dbPath,resolve(webRoot,'data/supabase/migrations',stamp));
    const env=parseEnv(readFileSync(resolve(values['connection-file']),'utf8'));
    db=postgresDatabase({databaseURL:env.SUPABASE_DATABASE_URL,databaseCAFile:resolve(webRoot,env.DATABASE_CA_FILE)});
    sqlite=new DatabaseSync(join(snapshot.directory,'portal.sqlite'),{readOnly:true});
    const tables=await copyPortal(sqlite,db);
    const report={migratedAt:new Date().toISOString(),schema:'cloak',snapshot:snapshot.directory,tables};
    writeFileSync(join(snapshot.directory,'cloud-verification.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({verified:true,tables:tables.map(({table,count})=>({table,count})),snapshot:snapshot.directory},null,2));
  }catch(error){
    console.error('Cloud migration did not complete. Source data retained. '+(error.message?.startsWith('Destination')?error.message:'Check the private connection and schema configuration.'));
    process.exitCode=1;
  }finally{sqlite?.close();await db?.close();}
}
