import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {localProfile,ensureLocalAccount} from '../scripts/local-profile.mjs';
import {snapshotDatabase} from '../scripts/local-snapshot.mjs';
import {openStore} from '../server/store.mjs';
import {createServer} from 'vite';

function temporary(t){
  const dir=mkdtempSync(join(tmpdir(),'mofacloak-local-test-'));
  t.after(()=>{assert.equal(dirname(dir),resolve(tmpdir()));assert.ok(dir.startsWith(join(resolve(tmpdir()),'mofacloak-local-test-')));rmSync(dir,{recursive:true,force:true});});
  return dir;
}
test('local profile leaves production env untouched and disables payments by default',t=>{
  const root=temporary(t),production='PAYMENTS_ENABLED=true\nGMPAY_SECRET_KEY=do-not-read-test-key\n';
  writeFileSync(join(root,'.env'),production);
  const profile=localProfile({root});
  assert.equal(profile.env.PAYMENTS_ENABLED,'false');assert.equal(profile.env.HOST,'127.0.0.1');assert.equal(profile.origin,'http://127.0.0.1:4173');assert.equal(profile.env.GMPAY_SECRET_KEY,'');
  assert.equal(readFileSync(join(root,'.env'),'utf8'),production);
  assert.equal(localProfile({root}).dbPath,profile.dbPath);
});
test('local profile rejects enabled payments and an IP not owned by this computer',t=>{
  const root=temporary(t);localProfile({root});
  assert.throws(()=>localProfile({root,lanIp:'192.0.2.245'}),/IPv4/);
  const file=join(root,'.local-runtime.env');writeFileSync(file,readFileSync(file,'utf8').replace('PAYMENTS_ENABLED=false','PAYMENTS_ENABLED=true'));
  assert.throws(()=>localProfile({root}),/HTTPS/);
});
test('persistent local account logs in, is reused, and creates no orders or payment events',t=>{
  const profile=localProfile({root:temporary(t)}),first=ensureLocalAccount(profile),second=ensureLocalAccount(profile);
  assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(second.accountId,first.accountId);
  const saved=JSON.parse(readFileSync(first.file,'utf8')),store=openStore(profile.dbPath);
  try{
    assert.equal(store.login(saved.accessCode).account.id,first.accountId);
    assert.equal(store.db.prepare('SELECT count(*) n FROM accounts').get().n,1);
    for(const table of ['orders','payment_events'])assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  }finally{store.close();}
});
test('invalid local credential file is not silently overwritten or replaced by a new account',t=>{
  const profile=localProfile({root:temporary(t)}),first=ensureLocalAccount(profile);
  writeFileSync(first.file,'{"accountId":"missing","accessCode":"invalid"}');
  assert.throws(()=>ensureLocalAccount(profile),/不匹配/);assert.ok(readFileSync(first.file,'utf8').includes('invalid'));
});
test('migration snapshot includes committed WAL data, stays consistent and refuses to overwrite',async t=>{
  const root=temporary(t),source=join(root,'source.sqlite'),destination=join(root,'export');
  const store=openStore(source);
  try{
    store.db.exec('PRAGMA wal_autocheckpoint=0');
    const account=store.createAccount('isolated snapshot test');
    assert.ok(existsSync(source+'-wal'));
    const result=await snapshotDatabase(source,destination);assert.equal(result.counts.accounts,1);assert.equal(result.counts.orders,0);
    const snapshot=new DatabaseSync(join(destination,'portal.sqlite'),{readOnly:true});
    try{assert.equal(snapshot.prepare('SELECT id FROM accounts').get().id,account.id);}finally{snapshot.close();}
    assert.equal(store.db.prepare('SELECT count(*) n FROM accounts').get().n,1);
    assert.equal(existsSync(join(destination,'local-access.json')),false);
    await assert.rejects(snapshotDatabase(source,destination),/不会覆盖/);
  }finally{store.close();}
});

test('real Vite server blocks private data through normal, raw and filesystem URLs',async t=>{
  // Hosted Windows can expose TEMP through an 8.3 alias; Vite compares canonical paths.
  const root=realpathSync(temporary(t));mkdirSync(join(root,'data'));
  writeFileSync(join(root,'data/private.json'),'{"private":"isolated-test-only"}');
  writeFileSync(join(root,'visible.txt'),'public development file');
  const server=await createServer({root,configFile:fileURLToPath(new URL('../vite.config.mjs',import.meta.url)),logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]},server:{fs:{allow:[root]},port:0,strictPort:true,host:'127.0.0.1',warmup:{clientFiles:[]}}});
  try{
    await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
    for(const path of ['/data/private.json','/data/private.json?raw','/@fs/'+join(root,'data/private.json').replaceAll('\\','/')]){
      const response=await fetch(new URL(path,origin));
      // Patched Vite can hide Windows cross-drive paths with 404 instead of 403.
      assert.ok([403,404].includes(response.status),`Private path must be inaccessible: ${path} (${response.status})`);
      assert.ok(!(await response.text()).includes('isolated-test-only'));
    }
    const visible=await fetch(origin+'/visible.txt'),publicText=await visible.text();
    assert.equal(visible.status,200,`Public fixture must be served; root=${root}; allow=${server.config.server.fs.allow.join(',')}; response=${publicText.slice(0,1500)}`);assert.equal(publicText,'public development file');
  }finally{await server.close();}
});
