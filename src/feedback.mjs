import {createFeedbackStore,cleanFeedback} from './feedback-store.mjs';

function send(res,status,value) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(value));
}
function readBody(req,signal) {
  return new Promise((resolve,reject)=>{
    const chunks=[];let length=0;
    const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',failed);signal.removeEventListener('abort',cancelled);};
    const failed=error=>{cleanup();req.resume();reject(error);};
    const cancelled=()=>failed(signal.reason??new DOMException('Request cancelled','AbortError'));
    const data=chunk=>{
      length+=chunk.length;
      if(length>12000){const error=new Error('Body limit');error.code='BODY_TOO_LARGE';failed(error);return;}
      chunks.push(chunk);
    };
    const end=()=>{cleanup();resolve(Buffer.concat(chunks).toString('utf8'));};
    req.on('data',data);req.once('end',end);req.once('error',failed);
    signal.addEventListener('abort',cancelled,{once:true});
    if(signal.aborted)cancelled();
  });
}
async function waitForSave(operation,signal) {
  let cancelled;
  const aborted=new Promise((_,reject)=>{cancelled=()=>reject(signal.reason??new DOMException('Request cancelled','AbortError'));signal.addEventListener('abort',cancelled,{once:true});});
  try {signal.throwIfAborted();return await Promise.race([Promise.resolve().then(operation),aborted]);}
  finally {signal.removeEventListener('abort',cancelled);}
}
export function createFeedbackHandler({env=process.env,store,clock=Date.now,timeoutMs=18000}={}) {
  store??=createFeedbackStore({env});
  let active=false,windowStart=Number(clock()),saved=0;
  const budget=Math.min(18000,Math.max(1,Number(timeoutMs)||18000));
  return async function handle(req,res) {
    if (req.url!=='/api/browser/feedback') return false;
    if (req.method!=='POST') {res.setHeader('Allow','POST');send(res,405,{error:'Use POST to send feedback.'});return true;}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),budget);
    const disconnected=()=>{if(!res.writableEnded)controller.abort();};
    req.once('aborted',disconnected);res.once('close',disconnected);
    let counted=false;
    try {
      const allowed=new Set([`http://${req.headers.host}`,`https://${req.headers.host}`]);
      if(env.BROWSER_PUBLIC_ORIGIN)allowed.add(env.BROWSER_PUBLIC_ORIGIN);
      if (req.headers.origin&&!allowed.has(req.headers.origin)) {req.resume();send(res,403,{error:'Open this app to send feedback.'});return true;}
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'').trim())) {req.resume();send(res,415,{error:'Send feedback as text.'});return true;}
      if (Number(req.headers['content-length'])>12000) {req.resume();send(res,413,{error:'Feedback is too long.'});return true;}
      if (Number(clock())-windowStart>=3600000) {windowStart=Number(clock());saved=0;}
      if (active||saved>=120) {req.resume();send(res,429,{error:'Feedback is busy. Please try again shortly.'});return true;}
      active=true;counted=true;
      const raw=await readBody(req,controller.signal);
      let input;
      try {input=JSON.parse(raw);} catch {send(res,400,{error:'Enter feedback text.'});return true;}
      if (!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['id','text'].includes(key))) {send(res,400,{error:'Enter feedback text.'});return true;}
      const feedback=cleanFeedback(input);
      const result=await waitForSave(()=>store.submit(feedback,{signal:controller.signal}),controller.signal);
      controller.signal.throwIfAborted();
      if (result?.saved!==true||result.id!==feedback.id) throw new Error('Unconfirmed save');
      saved++;
      if (!res.destroyed) send(res,200,{ok:true,id:result.id});
    } catch(error) {
      const invalid=['INVALID_FEEDBACK','ID_CONFLICT'].includes(error?.code);
      const tooLarge=error?.code==='BODY_TOO_LARGE';
      const status=tooLarge?413:error?.code==='ID_CONFLICT'?409:invalid?400:503;
      if(!res.destroyed&&!res.headersSent)send(res,status,{error:tooLarge?'Feedback is too long.':invalid?'Enter valid feedback text and try again.':'Feedback save was not confirmed. Please try again.'});
    } finally {clearTimeout(timer);if(counted)active=false;req.off('aborted',disconnected);res.off('close',disconnected);}
    return true;
  };
}
