import {mkdtempSync,readdirSync,readFileSync,writeFileSync,copyFileSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const temp=mkdtempSync(join(tmpdir(),'mofacloak-package-'));
const paths=[];
function add(rel){
  const full=resolve(root,rel);
  const entries=readdirSync(dirname(full),{withFileTypes:true});
  const entry=entries.find(p=>p.name===rel.split('/').at(-1));
  if(!entry||entry.isSymbolicLink())throw Error('Missing input or symlink: '+rel);
  if(entry.isDirectory())for(const p of readdirSync(full,{withFileTypes:true}))add(`${rel}/${p.name}`);
  else{
    if(!entry.isFile()||/[\r\n]/.test(rel)||/(?:^|\/)(?:\.env(?!\.example$)|\.local-runtime\.env|node_modules|data|secrets?)(?:\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|pem|key)$/i.test(rel))throw Error('Unsafe bundle input: '+rel);
    paths.push(rel);
  }
}
function tar(args){const r=spawnSync('tar',args,{cwd:temp,encoding:'utf8',maxBuffer:8*1024*1024});if(r.error||r.status!==0)throw Error('tar failed: '+(r.error?.message||r.stderr?.slice(0,2000)||'unknown error'));return r.stdout;}
try{
  for(const name of ['LOCAL.md','GM-PAY-SETUP.md','PLAN-REVIEW.md','SUPABASE.md','BINANCE-PAY.md','start-local.cmd','start-gmpay.cmd','start-callback.cmd'])add(name);
  for(const name of ['Dockerfile','.dockerignore','.env.example','package.json','package-lock.json','vite.config.mjs','index.html','server','src','public','scripts','worker','.openai','config/supabase-ca.crt','config/payment-catalog.example.json','config/payment-catalog.confirmed.json','README.md','PAYMENTS.md','TICKETS.md','payments-qa.md','AGENTS.md','tests'])add('web/'+name);
  for(const name of ['compose.yaml','deployment.env.example','portal.env.example','Caddyfile.setup','Caddyfile.live','prepare.sh','install-docker.sh','backup.sh','import-portal.sh','setup-gmpay-local.ps1','setup-callback-client.ps1','README.md'])add('deploy/'+name);
  add('supabase/migrations');add('supabase/config.toml');
  paths.sort();
  for(const path of paths){mkdirSync(dirname(join(temp,path)),{recursive:true});copyFileSync(resolve(root,path),join(temp,path));}
  const files=paths.map(path=>{const bytes=readFileSync(join(temp,path));return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
  // The manifest contains paths and hashes only; never package runtime directories.
  mkdirSync(join(temp,'deploy'),{recursive:true});
  writeFileSync(join(temp,'deploy/bundle-manifest.json'),JSON.stringify({format:1,files},null,2)+'\n');
  const archive=join(temp,'mofacloak-deploy.tar.gz');
  // A real list file also works with Windows bsdtar; do not depend on its stdin handling.
  writeFileSync(join(temp,'bundle-files.txt'),[...paths,'deploy/bundle-manifest.json'].join('\n')+'\n');
  tar(['-czf',archive,'--no-recursion','-T','bundle-files.txt']);
  const listed=tar(['-tzf',archive]).trim().split(/\r?\n/).sort();
  const expected=[...paths,'deploy/bundle-manifest.json'].sort();
  if(JSON.stringify(listed)!==JSON.stringify(expected))throw Error('Archive manifest mismatch');
  const digest=createHash('sha256').update(readFileSync(archive)).digest('hex');
  copyFileSync(archive,join(root,'deploy/mofacloak-deploy.tar.gz'));
  writeFileSync(join(root,'deploy/mofacloak-deploy.tar.gz.sha256'),`${digest}  mofacloak-deploy.tar.gz\n`);
  console.log(`Packaged ${listed.length} files; no runtime database or merchant configuration.`);
  console.log(`Archive: ${relative(root,join(root,'deploy/mofacloak-deploy.tar.gz'))}`);
  console.log(`SHA256: ${digest}`);
}finally{
  // Remove only the temporary directory created by this invocation.
  if(dirname(temp)===resolve(tmpdir())&&temp.startsWith(join(resolve(tmpdir()),'mofacloak-package-')))rmSync(temp,{recursive:true,force:true});
}
