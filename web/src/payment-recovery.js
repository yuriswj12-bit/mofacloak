// Store only an opaque idempotency key; never store credentials or payment details.
export function recoveryKey(accountId,planId,cycle,kind){return `cloak-payment:${accountId}:${planId}:${cycle}:${kind}`;}
export function recoverRequest(storage,name,newKey=()=>crypto.randomUUID()){
  try{const saved=storage?.getItem(name);if(saved&&/^[A-Za-z0-9_-]{16,100}$/.test(saved))return saved;}catch{}
  const key=newKey();try{storage?.setItem(name,key);}catch{}return key;
}
export function forgetRequest(storage,name){try{storage?.removeItem(name);}catch{}}
export function paymentExpired(order,now=Date.now()){
  return order?.paymentStatus==='expired'||(order?.paymentStatus==='pending'&&Number.isFinite(Number(order.expiresAt))&&Number(order.expiresAt)>0&&Number(order.expiresAt)<=now);
}
