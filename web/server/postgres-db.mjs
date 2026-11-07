import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import pg from 'pg';

export const portalTables=['accounts','sessions','orders','payment_events','fulfillment_jobs','gifts','tickets','ticket_messages'];
export function postgresStatement(sql){
  // These are application-authored statements; all user values remain parameters.
  let index=0;
  return sql.replace(/\?/g,()=>'$'+(++index)).replace(/\b(FROM|JOIN|UPDATE|INTO)\s+([a-z_]+)\b/gi,(all,verb,table)=>portalTables.includes(table)?`${verb} cloak.${table}`:all);
}
export function safeInteger(value){const number=Number(value);if(!Number.isSafeInteger(number))throw Error('Database integer is outside the supported range');return number;}
export function connectionOptions(config){
  const url=new URL(config.databaseURL);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.password||url.hash)throw Error('Invalid database connection settings');
  if(url.searchParams.has('sslmode')||url.searchParams.has('sslcert')||url.searchParams.has('sslkey')||url.searchParams.has('sslrootcert'))throw Error('Use DATABASE_CA_FILE for verified TLS; remove SSL overrides from the URL');
  return {connectionString:url.href,max:5,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,statement_timeout:15000,application_name:'mofacloak',ssl:{rejectUnauthorized:true,...(config.databaseCAFile?{ca:readFileSync(config.databaseCAFile,'utf8')}:{})},types:{getTypeParser:(oid,format)=>oid===20?safeInteger:pg.types.getTypeParser(oid,format)}};
}
export class PostgresDatabase{
  constructor(pool){this.pool=pool;this.context=new AsyncLocalStorage();}
  async query(sql,params=[]){return (this.context.getStore()||this.pool).query(postgresStatement(sql),params);}
  prepare(sql){return {get:async(...p)=>(await this.query(sql,p)).rows[0],all:async(...p)=>(await this.query(sql,p)).rows,run:async(...p)=>{const r=await this.query(sql,p);return {changes:r.rowCount??r.affectedRows??0};}};}
  async transaction(fn){
    if(this.context.getStore())return fn();
    for(let attempt=0;;attempt++){
      const client=await this.pool.connect();
      try{
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const value=await this.context.run(client,fn);await client.query('COMMIT');return value;
      }catch(error){
        await client.query('ROLLBACK').catch(()=>{});
        if(attempt<3&&['40001','40P01','23505'].includes(error.code))continue;
        throw error;
      }finally{client.release();}
    }
  }
  async close(){await this.pool.end();}
}
export function postgresDatabase(config){const pool=new pg.Pool(connectionOptions(config));pool.on('error',()=>console.error('Cloud database connection interrupted.'));return new PostgresDatabase(pool);}
