import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContributionService} from './contributions-service.mjs';
import {createContributionAI} from './contributions-ai.mjs';
import {createArtistCatalog} from './artist-catalog.mjs';
import {createArtistVerifier} from './artist-verification.mjs';
import {createFeedbackAnalysisService} from './feedback-analysis.mjs';
import {createShowExpirationService} from './show-expiration-service.mjs';

const bounded=(value,fallback,min,max)=>Number.isInteger(Number(value))&&Number(value)>=min&&Number(value)<=max?Number(value):fallback;

/** Separate CPU process: no user-facing search, messaging, or transcript API.
 * Both private inboxes share one model and run sequentially once per batch. */
export function createInputAnalysisApp({env=process.env,ai,contributions,feedback,cleanup,clock=()=>new Date(),setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}) {
  const minutes=bounded(env.INPUT_ANALYSIS_INTERVAL_MINUTES,60,1,1440);
  const port=bounded(env.PORT,7860,0,65535);
  const configured=Boolean(env.CONTRIBUTIONS_HF_REPO&&(env.CONTRIBUTIONS_HF_TOKEN||env.FEEDBACK_HF_TOKEN)&&env.ARTIST_CATALOG_URL&&env.ARTIST_CATALOG_SECRET);
  ai??=createContributionAI({env});
  contributions??=createContributionService({env:{...env,CONTRIBUTIONS_WORKER_ENABLED:'true'},ai,catalog:createArtistCatalog({env}),verifier:createArtistVerifier(),autoDrain:false,batchLimit:bounded(env.CONTRIBUTIONS_BATCH_LIMIT,20,1,50)});
  feedback??=env.INPUT_ANALYSIS_HF_REPO?createFeedbackAnalysisService({env,ai}):{async drain(){},async stop(){}};
  cleanup??=createShowExpirationService({env,clock,setIntervalImpl,clearIntervalImpl});
  let timer,running,stopped=false,lastBatchStartedUtc=null,lastBatchFinishedUtc=null;
  async function runBatch() {
    if(stopped)return;if(running)return running;
    lastBatchStartedUtc=new Date(clock()).toISOString();
    running=(async()=>{
      try {await contributions.drain();if(!stopped)await feedback.drain();}
      catch {/* Durable input remains available for the next batch. */}
      finally {lastBatchFinishedUtc=new Date(clock()).toISOString();}
    })();
    try {await running;}finally{running=null;}
  }
  const server=http.createServer((req,res)=>{
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
    if(req.method==='GET'&&req.url==='/healthz') {
      const expiration=cleanup.state();
      const ready=configured&&(!expiration.enabled||expiration.configured);
      res.writeHead(ready?200:503,headers);
      res.end(JSON.stringify({ok:ready,role:'input-analysis',batchIntervalMinutes:minutes,state:running?'processing':'idle',lastBatchStartedUtc,lastBatchFinishedUtc,showExpiration:expiration}));
    } else if(req.method==='GET'&&req.url==='/') {
      res.writeHead(200,{...headers,'Content-Type':'text/plain; charset=utf-8'});
      res.end('Rave Now input analysis\nSaved artist/show submissions and feedback are processed privately in scheduled batches. Expired shows are removed by the scheduled cleanup worker.\n');
    } else {req.resume();res.writeHead(404,headers);res.end(JSON.stringify({error:'Not found'}));}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return {server,config:{host:'0.0.0.0',port},runBatch,
    start(){if(timer||stopped)return;cleanup.start();timer=setIntervalImpl(()=>void runBatch(),minutes*60000);timer.unref?.();void runBatch();},
    async stop(){stopped=true;clearIntervalImpl(timer);timer=null;await Promise.all([contributions.stop(),feedback.stop(),cleanup.stop()]);ai.close();await running;},
  };
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const app=createInputAnalysisApp();
    app.server.listen(app.config.port,app.config.host,()=>{console.log('Rave Now input analysis is online.');app.start();});
    app.server.on('error',()=>{console.error('Input analysis listener failed.');process.exitCode=1;});
    const close=async()=>{await app.stop();app.server.close(()=>process.exit(0));};
    process.once('SIGINT',close);process.once('SIGTERM',close);
  }catch{console.error('Input analysis startup failed; check server configuration.');process.exitCode=1;}
}
