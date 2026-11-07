import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {webRoot} from './local-profile.mjs';
import {notificationRelay} from '../server/notify-relay.mjs';
const env=parseEnv(readFileSync(resolve(webRoot,'.local-runtime.env'),'utf8'));
const relay=notificationRelay({pid:env.GMPAY_PID,secret:env.GMPAY_SECRET_KEY});
relay.listen(8790,'127.0.0.1',()=>console.log('Signed notification relay: 127.0.0.1:8790 (no public listener)'));
const stop=()=>relay.close(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);
