import {Worker} from 'node:worker_threads';
import path from 'node:path';
import {projectDir} from './config.mjs';
import {cleanArtistName} from './artist-catalog.mjs';
import {parseFeedbackAnalysis} from './feedback-analysis.mjs';

const key=value=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('en-US').replace(/\s+/gu,' ').trim();
export function parseArtistExtraction(output,text) {
  if(typeof output!=='string'||output.length>2000)throw Error('Artist extraction unavailable');
  let result;
  try {result=JSON.parse(output.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1'));}catch{throw Error('Artist extraction unavailable');}
  if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='artist,hasEvent'||typeof result.hasEvent!=='boolean')throw Error('Artist extraction unavailable');
  if(result.artist===null)return {artist:null,hasEvent:result.hasEvent};
  const artist=cleanArtistName(result.artist),needle=key(artist),haystack=key(text);
  const escaped=needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(!new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`,'u').test(haystack))throw Error('Artist extraction unavailable');
  // Explicit event language cannot be silently discarded by a model decision.
  const hasEvent=result.hasEvent||/\b(?:show|event|festival|concert|perform(?:s|ing|ance)?|plays?|tickets?|venue|tonight|weekend|friday|saturday|sunday)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b|https:\/\//i.test(text);
  return {artist,hasEvent};
}

export function createContributionAI({env=process.env,WorkerImpl=Worker,timeoutMs=240000}={}) {
  let worker,active,sequence=0;
  const discard=(target=worker)=>{if(worker===target)worker=null;void target?.terminate();};
    async function run(text,{signal}={},mode='artist') {
      signal?.throwIfAborted();
      if(active)throw Error('Artist extraction busy');
      return new Promise((resolve,reject)=>{
        const id=++sequence;
        const finish=(error,value)=>{
          if(active?.id!==id)return;
          clearTimeout(active.timer);active.cleanup?.();signal?.removeEventListener('abort',cancel);active=null;
          if(error){discard();reject(Error('Artist extraction unavailable'));}else resolve(value);
        };
        const cancel=()=>finish(Error('Cancelled'));
        try {
          if(!worker){
            const created=new WorkerImpl(new URL('./contributions-ai-worker.mjs',import.meta.url),{workerData:{cacheDir:path.resolve(projectDir,env.ARTIST_AI_CACHE_DIR||'work/models')}});
            worker=created;
            // Keep an idle worker error from becoming an uncaught process error.
            // A terminated older worker must never clear a newer replacement.
            const unavailable=()=>{if(worker!==created)return;if(active)active.cancel();else discard(created);};
            created.on('error',unavailable);created.once('exit',unavailable);
          }
          const jobWorker=worker;
          const onMessage=data=>{
            if(active?.id!==id||data?.id!==id)return;
            jobWorker.off('message',onMessage);
            if(data.error){finish(Error('Unavailable'));return;}
            try{finish(null,mode==='feedback'?parseFeedbackAnalysis(data.output):parseArtistExtraction(data.output,text));}catch{finish(Error('Invalid result'));}
          };
          active={id,cancel,timer:setTimeout(cancel,Math.min(240000,Math.max(1,timeoutMs))),cleanup:()=>{jobWorker.off('message',onMessage);}};
          jobWorker.on('message',onMessage);signal?.addEventListener('abort',cancel,{once:true});
          if(signal?.aborted){cancel();return;}
          jobWorker.postMessage({id,text,...(mode==='feedback'?{mode}:{})});
        }catch{active??={id};finish(Error('Unavailable'));}
      });
    }
  return {
    extract:(text,options)=>run(text,options),
    analyzeFeedback:(text,options)=>run(text,options,'feedback'),
    close(){active?.cancel?.();discard();},
  };
}
