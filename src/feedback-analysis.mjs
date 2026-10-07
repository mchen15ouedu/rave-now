import {createFeedbackStore,cleanFeedback} from './feedback-store.mjs';

export const FEEDBACK_ANALYSIS_MODEL='onnx-community/Qwen3-0.6B-ONNX';
export const FEEDBACK_ANALYSIS_REVISION='da1453100cf3ff33ef56d17983fc7a8648706db6';
const categories=new Set(['accuracy','usability','performance','accessibility','reliability','other']);
const badText=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u;
const credential=/\b(?:hf_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})\b/;
const unavailable=()=>Error('Feedback analysis unavailable.');
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const secretValues=env=>[env.FEEDBACK_HF_TOKEN,env.INPUT_ANALYSIS_HF_TOKEN,env.CONTRIBUTIONS_HF_TOKEN,env.ARTIST_CATALOG_SECRET].filter(value=>typeof value==='string'&&value.length>8);

function text(value,max,secrets) {
  if(typeof value!=='string'||badText.test(value))throw unavailable();
  const result=value.normalize('NFC').replace(/\s+/gu,' ').trim();
  if(!result||result.length>max||credential.test(result)||/https?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(result)||secrets.some(secret=>result.includes(secret)))throw unavailable();
  return result;
}

/** Model output is an owner-review suggestion, never an action or verified fact. */
export function parseFeedbackAnalysis(output,{secrets=[]}={}) {
  if(typeof output!=='string'||output.length>3000)throw unavailable();
  let value;try{value=JSON.parse(output.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1'));}catch{throw unavailable();}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='category,suggestion,summary'||!categories.has(value.category))throw unavailable();
  return {summary:text(value.summary,500,secrets),category:value.category,suggestion:text(value.suggestion,700,secrets)};
}

function report(value,secrets) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='category,feedbackId,feedbackSubmittedUtc,model,modelRevision,reviewStatus,schemaVersion,suggestion,summary'||value.schemaVersion!==1||value.reviewStatus!=='owner-review'||value.model!==FEEDBACK_ANALYSIS_MODEL||value.modelRevision!==FEEDBACK_ANALYSIS_REVISION||!iso(value.feedbackSubmittedUtc))throw unavailable();
  const {id}=cleanFeedback({id:value.feedbackId,text:'report'});
  if(id!==value.feedbackId)throw unavailable();
  const analysis=parseFeedbackAnalysis(JSON.stringify({summary:value.summary,category:value.category,suggestion:value.suggestion}),{secrets});
  return {schemaVersion:1,feedbackId:id,feedbackSubmittedUtc:value.feedbackSubmittedUtc,...analysis,reviewStatus:'owner-review',model:FEEDBACK_ANALYSIS_MODEL,modelRevision:FEEDBACK_ANALYSIS_REVISION};
}

/** Reuse the private Hub snapshot/CAS protocol. JSON reports are stored as the
 * existing store's bounded text payload in a separate private Dataset. */
export function createFeedbackReportStore({env=process.env,store,fetchImpl=fetch,clock=()=>new Date()}={}) {
  const secrets=secretValues(env);
  store??=createFeedbackStore({env:{FEEDBACK_HF_REPO:env.INPUT_ANALYSIS_HF_REPO,FEEDBACK_HF_TOKEN:env.INPUT_ANALYSIS_HF_TOKEN||env.FEEDBACK_HF_TOKEN},fetchImpl,clock,timeoutMs:120000});
  const configured=()=>{
    if(!env.INPUT_ANALYSIS_HF_REPO||[env.FEEDBACK_HF_REPO,env.CONTRIBUTIONS_HF_REPO].includes(env.INPUT_ANALYSIS_HF_REPO))throw unavailable();
  };
  return {
    async list({signal}={}) {
      configured();const records=await store.list({signal});signal?.throwIfAborted();
      if(!Array.isArray(records)||records.length>2000)throw unavailable();
      const seen=new Set();
      return records.map(record=>{
        let value;try{value=report(JSON.parse(record.text),secrets);}catch{throw unavailable();}
        if(value.feedbackId!==record.id||!iso(record.submittedUtc)||seen.has(value.feedbackId))throw unavailable();
        seen.add(value.feedbackId);return {...value,analyzedUtc:record.submittedUtc};
      });
    },
    async save({feedbackId,feedbackSubmittedUtc,analysis},{signal}={}) {
      configured();
      const value=report({schemaVersion:1,feedbackId,feedbackSubmittedUtc,...parseFeedbackAnalysis(JSON.stringify(analysis),{secrets}),reviewStatus:'owner-review',model:FEEDBACK_ANALYSIS_MODEL,modelRevision:FEEDBACK_ANALYSIS_REVISION},secrets);
      const result=await store.submit({id:value.feedbackId,text:JSON.stringify(value)},{signal});signal?.throwIfAborted();
      if(result?.saved!==true||result.id!==value.feedbackId)throw unavailable();
      return {id:value.feedbackId,saved:true};
    },
  };
}

function abortable(operation,signal) {
  signal.throwIfAborted();let cancel;
  const aborted=new Promise((_,reject)=>{cancel=()=>reject(signal.reason||unavailable());signal.addEventListener('abort',cancel,{once:true});});
  return Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return operation(signal);}),aborted]).finally(()=>signal.removeEventListener('abort',cancel));
}

/** Bounded FIFO analysis. A saved UUID is skipped on every later batch/restart;
 * failed or interrupted inference never creates a pretend report. */
export function createFeedbackAnalysisService({env=process.env,feedbackStore,reportStore,ai,limit=10,jobTimeoutMs=240000}={}) {
  feedbackStore??=createFeedbackStore({env,timeoutMs:120000});reportStore??=createFeedbackReportStore({env});
  const max=Math.min(10,Math.max(1,Number.isInteger(limit)?limit:10)),secrets=secretValues(env);
  let running,controller,stopped=false;
  async function drain() {
    if(stopped)return {analyzed:0,failed:0};if(running)return running;
    controller=new AbortController();const active=controller;
    running=(async()=>{
      let analyzed=0,failed=0;
      try {
        const readSignal=AbortSignal.any([active.signal,AbortSignal.timeout(120000)]);
        const reports=await abortable(signal=>reportStore.list({signal}),readSignal);
        const records=await abortable(signal=>feedbackStore.list({signal}),readSignal);
        if(!Array.isArray(reports)||reports.length>2000||!Array.isArray(records)||records.length>2000)throw unavailable();
        const saved=new Set(reports.map(value=>value.feedbackId));
        const pending=records.filter(value=>!saved.has(value.id)).sort((a,b)=>String(a.submittedUtc).localeCompare(String(b.submittedUtc))||String(a.id).localeCompare(String(b.id))).slice(0,max);
        for(const record of pending) {
          active.signal.throwIfAborted();
          const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),Math.min(240000,Math.max(1,jobTimeoutMs)));
          const signal=AbortSignal.any([active.signal,deadline.signal]);
          try {
            const clean=cleanFeedback(record);if(clean.id!==record.id||clean.text!==record.text||!iso(record.submittedUtc))throw unavailable();
            const output=await abortable(signal=>ai.analyzeFeedback(clean.text,{signal}),signal);
            const analysis=parseFeedbackAnalysis(JSON.stringify(output),{secrets});signal.throwIfAborted();
            const receipt=await abortable(signal=>reportStore.save({feedbackId:clean.id,feedbackSubmittedUtc:record.submittedUtc,analysis},{signal}),signal);
            if(receipt?.saved!==true||receipt.id!==clean.id)throw unavailable();
            analyzed++;
          }catch{if(active.signal.aborted)break;failed++;}
          finally{clearTimeout(timer);}
        }
      }catch{if(!active.signal.aborted)failed++;}
      return {analyzed,failed};
    })();
    try{return await running;}finally{running=null;if(controller===active)controller=null;}
  }
  return {drain,async stop(){stopped=true;controller?.abort();await running;}};
}
