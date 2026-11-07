import {loadConfig} from './config.mjs';
import {openConfiguredStore} from './storage.mjs';
import {Tickets} from './tickets.mjs';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const config=loadConfig(),store=await openConfiguredStore(config),[command,...args]=process.argv.slice(2);
try{
  if(command==='user:create'){
    const name=args.join(' ').trim();if(!name||name.length>50)throw new Error('Usage: npm run user:create -- 客户名称');
    const a=await store.createAccount(name);console.log(JSON.stringify({accountId:a.id,name:a.name,accessCode:a.accessCode,note:'仅在此显示一次。请通过可信渠道私下交给客户，不要提交到 Git。'},null,2));
  }else if(command==='fulfillment:list'){
    console.log(JSON.stringify(await store.db.prepare("SELECT j.order_id,a.name account_name,j.plan_id,j.months,j.status,j.created_at FROM fulfillment_jobs j JOIN accounts a ON a.id=j.account_id WHERE j.status='pending' ORDER BY j.created_at").all(),null,2));
  }else if(command==='ticket:list'){
    console.log(JSON.stringify(await store.db.prepare('SELECT t.id,t.title,t.category,t.status,t.updated_at,a.name account_name FROM tickets t JOIN accounts a ON a.id=t.account_id ORDER BY t.updated_at DESC LIMIT 100').all(),null,2));
  }else if(command==='ticket:show'){
    console.log(JSON.stringify(await (store.tickets||new Tickets(store)).detail(args[0]),null,2));
  }else if(command==='ticket:reply'){
    if(!args[0]||!args[1])throw Error('Usage: ticket:reply TK_ID reply-file.txt');
    console.log(JSON.stringify(await (store.tickets||new Tickets(store)).adminReply(args[0],randomUUID(),readFileSync(args[1],'utf8')),null,2));
  }else if(command==='ticket:close'){
    console.log(JSON.stringify(await (store.tickets||new Tickets(store)).close(args[0]),null,2));
  }else if(command==='user:disable'){
    const id=args[0];if(!id)throw new Error('Account ID required');await store.disableAccount(id);console.log('Account disabled and sessions revoked');
  }else throw new Error('Supported commands: user:create, user:disable, fulfillment:list, ticket:list, ticket:show, ticket:reply, ticket:close');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await store.close();}
