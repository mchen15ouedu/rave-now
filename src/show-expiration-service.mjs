import {createHmac,randomUUID} from 'node:crypto';
import {planExpiredShows} from './show-expiration.mjs';

const MAX_BYTES=10*1024*1024;
export class ShowExpirationError extends Error {
  constructor(code='UNAVAILABLE'){super('Show cleanup could not be confirmed.');this.name='ShowExpirationError';this.code=code;}
}
const invalid=()=>new ShowExpirationError('INVALID_RESPONSE');
const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));

async function responseJson(response) {
  if(!response.ok)throw new ShowExpirationError();
  if(Number(response.headers.get('content-length'))>MAX_BYTES)throw invalid();
  const reader=response.body?.getReader();
  if(!reader)throw invalid();
  const chunks=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw invalid();chunks.push(Buffer.from(value));}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw invalid();}
  if(!value||Array.isArray(value)||value.ok!==true)throw new ShowExpirationError(typeof value?.code==='string'&&/^[A-Z_]{1,40}$/.test(value.code)?value.code:'INVALID_RESPONSE');
  return value;
}

function bridgeOrigin(value) {
  let url;try{url=new URL(value);}catch{throw new ShowExpirationError('NOT_CONFIGURED');}
  if(url.protocol!=='https:'||url.hostname!=='script.google.com'||!/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)||url.port||url.username||url.password||url.search||url.hash)throw new ShowExpirationError('NOT_CONFIGURED');
  return url.href;
}

function snapshotValue(value) {
  if(typeof value.snapshotToken!=='string'||!value.snapshotToken||value.snapshotToken.length>2048||!instant(value.capturedAt)||typeof value.timeZone!=='string'||value.timeZone.length>100||!Array.isArray(value.rows)||value.rows.length>10000)throw invalid();
  const seen=new Set();
  for(const row of value.rows){
    if(!row||!Number.isInteger(row.row)||row.row<2||row.row>10001||seen.has(row.row)||!/^[a-f0-9]{64}$/.test(row.fingerprint))throw invalid();
    seen.add(row.row);
    for(const key of ['artist','event','venue','city','address','category','start','end'])if(typeof row[key]!=='string'||row[key].length>5000)throw invalid();
    for(const key of ['startInstant','endInstant'])if(row[key]!=null&&!instant(row[key]))throw invalid();
    for(const key of ['startDateOnly','endDateOnly'])if(row[key]!=null&&typeof row[key]!=='boolean')throw invalid();
    if(row.timeZone!=null&&(typeof row.timeZone!=='string'||row.timeZone.length>100))throw invalid();
  }
  return {snapshotToken:value.snapshotToken,capturedAt:value.capturedAt,timeZone:value.timeZone,rows:value.rows};
}

function receiptValue(value,candidates,{dryRun=false}={}) {
  const allowed=new Set(candidates.map(row=>row.row));
  for(const key of ['deletedRows','skippedRows']){
    if(!Array.isArray(value[key])||value[key].length>500||value[key].some(row=>!Number.isInteger(row)||!allowed.has(row))||new Set(value[key]).size!==value[key].length)throw invalid();
  }
  if(!Number.isInteger(value.deleted)||value.deleted!==value.deletedRows.length||value.deletedRows.some(row=>value.skippedRows.includes(row))||dryRun&&value.deleted!==0)throw invalid();
  return {deleted:value.deleted,deletedRows:value.deletedRows,skippedRows:value.skippedRows};
}

/** Authenticated read/plan/apply connection. Writes get one attempt; only a
 * fresh whole-sheet snapshot authorizes a later retry. Secrets never redirect. */
export function createExpirationBridge({env=process.env,fetchImpl=fetch}={}) {
  async function request(action,details,{signal}={}) {
    const key=env.ARTIST_CATALOG_SECRET;
    if(typeof key!=='string'||key.length<32||key.length>512)throw new ShowExpirationError('NOT_CONFIGURED');
    const url=bridgeOrigin(env.ARTIST_CATALOG_URL),deadline=AbortSignal.timeout(35000);
    const requestSignal=signal?AbortSignal.any([signal,deadline]):deadline;
    try{
      let response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:key,action,...details}),redirect:'manual',signal:requestSignal});
      if([301,302,303].includes(response.status)){
        let redirect;try{redirect=new URL(response.headers.get('location'));}catch{throw invalid();}
        if(redirect.protocol!=='https:'||redirect.hostname!=='script.googleusercontent.com'||redirect.port||redirect.username||redirect.password)throw invalid();
        response=await fetchImpl(redirect.href,{method:'GET',redirect:'error',signal:requestSignal});
      }
      return await responseJson(response);
    }catch(error){if(error instanceof ShowExpirationError)throw error;throw new ShowExpirationError(signal?.aborted?'CANCELLED':'UNAVAILABLE');}
  }
  const write=async(action,plan,options)=>receiptValue(await request(action,{snapshotToken:plan.snapshotToken,candidates:plan.candidates},options),plan.candidates,{dryRun:action==='dryRunExpiredShows'});
  return {
    async readSnapshot(options){return snapshotValue(await request('readExpirationSnapshot',{},options));},
    dryRun(plan,options){return write('dryRunExpiredShows',plan,options);},
    apply(plan,options){return write('applyExpiredShows',plan,options);},
  };
}

/** Clear the hosted RAM feed after a confirmed or uncertain sheet write. A
 * failed notification retries on the next cleanup tick or processor startup. */
export async function invalidateHostedShows({env=process.env,fetchImpl=fetch,clock=()=>new Date(),signal}={}) {
  const key=env.ARTIST_CATALOG_SECRET;
  let origin;try{origin=new URL(env.SHOW_EXPIRATION_BROWSER_ORIGIN);}catch{throw new ShowExpirationError('NOT_CONFIGURED');}
  if(typeof key!=='string'||key.length<32||key.length>512||origin.protocol!=='https:'||origin.port||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new ShowExpirationError('NOT_CONFIGURED');
  const timestamp=new Date(clock()).toISOString(),nonce=randomUUID();
  const signature=createHmac('sha256',key).update(`${timestamp}\n${nonce}`).digest('hex');
  try {
    const response=await fetchImpl(new URL('/api/internal/show-expiration',origin),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({timestamp,nonce,signature}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    const value=await responseJson(response);if(value.invalidated!==true)throw invalid();
  }catch(error){if(error instanceof ShowExpirationError)throw error;throw new ShowExpirationError('INVALIDATION_FAILED');}
  return true;
}

export function createShowExpirationService({env=process.env,bridge,fetchImpl=fetch,clock=()=>new Date(),invalidate,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}) {
  const enabled=env.SHOW_EXPIRATION_ENABLED==='true';
  const interval=Number(env.SHOW_EXPIRATION_INTERVAL_MINUTES??15),minutes=Number.isInteger(interval)&&interval>=1&&interval<=1440?interval:15;
  const configured=Boolean(env.ARTIST_CATALOG_URL&&env.ARTIST_CATALOG_SECRET&&env.SHOW_EXPIRATION_BROWSER_ORIGIN);
  bridge??=createExpirationBridge({env,fetchImpl});
  invalidate??=options=>invalidateHostedShows({env,fetchImpl,clock,...options});
  let running,timer,controller,stopped=false,pendingInvalidation=true;
  let last={status:enabled?'idle':'disabled',lastRunUtc:null,sourceRows:0,expired:0,retained:0,invalid:0,blockedFestivalRows:0,deleted:0,skipped:0,cacheInvalidated:false};
  async function drain({dryRun=false}={}) {
    if(!enabled||stopped)return {status:enabled?'stopped':'disabled',deleted:0};
    if(running)return running;
    controller=new AbortController();
    const deadline=setTimeout(()=>controller.abort(),120000);
    running=(async()=>{
      const runAt=new Date(clock());let deleted=0,skipped=0,cacheInvalidated=false,status='completed';
      let counts={sourceRows:0,expired:0,retained:0,invalid:0,blockedFestivalRows:0};
      try {
        if(!configured)throw new ShowExpirationError('NOT_CONFIGURED');
        const snapshot=await bridge.readSnapshot({signal:controller.signal});
        const plan=planExpiredShows(snapshot,{now:runAt,limit:500});
        counts={sourceRows:plan.totalRows,expired:plan.expiredCount,retained:plan.keptCount,invalid:plan.invalidCount,blockedFestivalRows:plan.blockedFestivalCount};
        if(plan.candidates.length){
          if(!dryRun)pendingInvalidation=true;
          const receipt=await (dryRun?bridge.dryRun:bridge.apply)({snapshotToken:snapshot.snapshotToken,candidates:plan.candidates},{signal:controller.signal});
          deleted=receipt.deleted;skipped=receipt.skippedRows.length;
        }
        if(dryRun)status='dry-run';
      }catch{status=controller.signal.aborted?'interrupted':'failed';}
      finally{
        if(!dryRun&&pendingInvalidation&&!controller.signal.aborted&&configured){
          try{cacheInvalidated=await invalidate({signal:controller.signal});pendingInvalidation=!cacheInvalidated;}catch{status='failed';}
        }
        last={status,lastRunUtc:runAt.toISOString(),...counts,deleted,skipped,cacheInvalidated};
      }
      return {...last};
    })();
    try{return await running;}finally{clearTimeout(deadline);running=null;controller=null;}
  }
  return {
    drain,
    state(){return {enabled,configured:enabled&&configured,intervalMinutes:minutes,...last,state:running?'processing':'idle'};},
    start(){if(!enabled||stopped||timer)return;timer=setIntervalImpl(()=>void drain(),minutes*60000);timer.unref?.();void drain();},
    async stop(){stopped=true;clearIntervalImpl(timer);timer=null;controller?.abort();await running;},
  };
}
