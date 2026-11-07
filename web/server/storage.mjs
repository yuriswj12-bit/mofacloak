import {openStore} from './store.mjs';
import {postgresDatabase} from './postgres-db.mjs';
import {PostgresStore} from './postgres-store.mjs';
import {PostgresTickets} from './postgres-tickets.mjs';

export async function openConfiguredStore(config){
  if(config.databaseProvider!=='supabase')return openStore(config.dbPath);
  const db=postgresDatabase(config),store=new PostgresStore(db);
  store.tickets=new PostgresTickets(store);
  try{await store.health();return store;}catch{await store.close();throw Error('Cloud database unavailable or schema not initialized');}
}
