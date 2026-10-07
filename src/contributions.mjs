import {readBody,waitForSave} from './feedback.mjs';
import {cleanContribution} from './contributions-store.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES=new Set(['queued','processing','completed','needs-review','rejected']);
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
export function createContributionHandler({env=process.env,service,clock=Date.now,timeoutMs=18000}={}) {
  const minutes=Number(env.CONTRIBUTIONS_BATCH_INTERVAL_MINUTES||60);
  const batch=env.CONTRIBUTIONS_PROCESSING_MODE==='batch'?{processingMode:'batch',batchIntervalMinutes:Number.isInteger(minutes)&&minutes>=1&&minutes<=1440?minutes:60}:{};
  let saves=0,window=Number(clock()),active=0;
  return async(req,res)=>{
    const match=/^\/api\/browser\/contributions(?:\/([^/?]+))?$/.exec(req.url);
    if(!match)return false;
    const id=match[1],method=id?'GET':'POST';
    if(req.method!==method){res.setHeader('Allow',method);send(res,405,{error:'Use '+method+' for this request.'});return true;}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(18000,timeoutMs));
    const disconnected=()=>{if(!res.writableEnded)controller.abort();};req.once('aborted',disconnected);res.once('close',disconnected);
    let counted=false;
    try {
      const allowed=new Set([`http://${req.headers.host}`,`https://${req.headers.host}`]);if(env.BROWSER_PUBLIC_ORIGIN)allowed.add(env.BROWSER_PUBLIC_ORIGIN);
      if(req.headers.origin&&!allowed.has(req.headers.origin)){req.resume();send(res,403,{error:'Open this app to submit artist details.'});return true;}
      if(active>=4){req.resume();send(res,429,{error:'Artist submissions are busy. Please try again shortly.'});return true;}
      active++;counted=true;
      if(id) {
        if(!UUID.test(id)){send(res,400,{error:'Invalid submission ID.'});return true;}
        const value=await waitForSave(()=>service.status(id,{signal:controller.signal}),controller.signal);controller.signal.throwIfAborted();
        if(!value){send(res,404,{error:'Submission not found.'});return true;}
        if(value.id!==id||!STATES.has(value.status))throw Error('Invalid status');
        const message=typeof value.message==='string'?value.message.slice(0,1000):'';
        send(res,200,{id,status:value.status,message,...batch});return true;
      }
      if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'').trim())){req.resume();send(res,415,{error:'Send reviewed artist details as text.'});return true;}
      if(Number(req.headers['content-length'])>12000){req.resume();send(res,413,{error:'Artist details are too long.'});return true;}
      if(Number(clock())-window>=3600000){window=Number(clock());saves=0;}
      if(saves>=120){req.resume();send(res,429,{error:'Artist submissions are busy. Please try again shortly.'});return true;}
      const raw=await readBody(req,controller.signal);
      let input;try{input=JSON.parse(raw);}catch{send(res,400,{error:'Enter an artist name and any show details.'});return true;}
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['id','text'].includes(key))){send(res,400,{error:'Enter an artist name and any show details.'});return true;}
      const clean=cleanContribution(input);
      const result=await waitForSave(()=>service.submit(clean,{signal:controller.signal}),controller.signal);controller.signal.throwIfAborted();
      if(result?.saved!==true||result.id!==clean.id)throw Error('Unconfirmed save');
      saves++;send(res,202,{ok:true,id:clean.id,status:'queued',...batch});
    }catch(error){
      const code=error?.code,status=code==='BODY_TOO_LARGE'?413:code==='INVALID_CONTRIBUTION'?400:code==='ID_CONFLICT'?409:503;
      if(!res.destroyed&&!res.headersSent)send(res,status,{error:status===503?'Saving or processing could not be confirmed. Your draft is kept; please try again.':'Enter valid artist details and try again.'});
    }finally{clearTimeout(timer);if(counted)active--;req.off('aborted',disconnected);res.off('close',disconnected);}
    return true;
  };
}
