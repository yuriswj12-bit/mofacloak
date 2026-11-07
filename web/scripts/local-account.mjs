import {readFileSync} from 'node:fs';
import {localProfile,ensureLocalAccount} from './local-profile.mjs';
try{
  const result=ensureLocalAccount(localProfile());
  if(process.argv.includes('--show'))console.log(readFileSync(result.file,'utf8'));
  else console.log(`本地账户已就绪。凭据位于：${result.file}\n如需在自己的终端显示访问码，运行 npm run local:account -- --show。`);
}catch(error){console.error(error.message);process.exitCode=1;}
