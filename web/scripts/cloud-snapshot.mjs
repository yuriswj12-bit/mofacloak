import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {localProfile,webRoot} from './local-profile.mjs';
import {loadConfig} from '../server/config.mjs';
import {openConfiguredStore} from '../server/storage.mjs';
import {portalTables} from '../server/postgres-db.mjs';
import {hash} from '../server/store.mjs';

let store;
try{
  const config=loadConfig(localProfile().env);
  if(config.databaseProvider!=='supabase')throw Error('Cloud storage is not configured');
  store=await openConfiguredStore(config);
  const tables={};
  await store.transaction(async()=>{
    await store.db.query('SET TRANSACTION READ ONLY');
    for(const table of portalTables)tables[table]=await store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
  });
  const body=JSON.stringify({format:1,createdAt:new Date().toISOString(),schema:'cloak',tables},null,2)+'\n';
  const directory=resolve(webRoot,'data/supabase/backups',new Date().toISOString().replace(/[:.]/g,'-'));
  mkdirSync(directory,{recursive:true,mode:0o700});
  writeFileSync(resolve(directory,'portal.json'),body,{mode:0o600});
  writeFileSync(resolve(directory,'portal.json.sha256'),hash(body)+'  portal.json\n',{mode:0o600});
  console.log(JSON.stringify({directory,counts:Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.length]))},null,2));
}catch{console.error('Cloud backup failed. No database credentials were printed.');process.exitCode=1;}finally{await store?.close();}
