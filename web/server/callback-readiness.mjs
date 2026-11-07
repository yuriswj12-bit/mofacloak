import {readFileSync} from 'node:fs';
export function callbackReady(config){
  if(!config.localGateway)return true;
  try{const state=JSON.parse(readFileSync(config.callbackStatePath,'utf8')),age=Date.now()-state.heartbeatAt;return state.active===true&&state.origin===config.notifyOrigin&&age>=0&&age<15000&&Number.isFinite(state.publicCheckedAt)&&Date.now()-state.publicCheckedAt>=0&&Date.now()-state.publicCheckedAt<15000;}catch{return false;}
}
