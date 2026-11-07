// Internal liveness/readiness check. Never contacts a gateway or creates an order.
try{
  const response=await fetch('http://127.0.0.1:8788/api/v1/health',{redirect:'error',signal:AbortSignal.timeout(3000)});
  if(!response.ok||(await response.json()).status!=='ok')process.exitCode=1;
}catch{process.exitCode=1;}
