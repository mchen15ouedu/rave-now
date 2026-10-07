import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createInputAnalysisApp} from '../src/input-analysis.mjs';
import {parseFeedbackAnalysis,createFeedbackReportStore,createFeedbackAnalysisService} from '../src/feedback-analysis.mjs';

const id='10b0baf4-2d28-4781-9a4a-3d8f036e8cd2',other='20b0baf4-2d28-4781-9a4a-3d8f036e8cd2';
const submittedUtc='2026-10-07T12:00:00.000Z';
const analysis={summary:'The user reports slow page loading.',category:'performance',suggestion:'Review page loading times.'};
const env={INPUT_ANALYSIS_HF_REPO:'sample/private-reports',FEEDBACK_HF_REPO:'sample/private-feedback',CONTRIBUTIONS_HF_REPO:'sample/private-contributions',FEEDBACK_HF_TOKEN:'fixture-token',ARTIST_CATALOG_URL:'fixture-url',ARTIST_CATALOG_SECRET:'fixture-key',PORT:'0'};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('feedback reports reject invalid schemas, secrets and links and remain review suggestions',()=>{
  assert.deepEqual(parseFeedbackAnalysis(JSON.stringify(analysis)),analysis);
  for(const value of [{...analysis,category:'critical'},{...analysis,run:'change the app'},{...analysis,summary:'https://example.com/private'},{...analysis,suggestion:'private-secret-contents'},{...analysis,summary:'x'.repeat(501)}])assert.throws(()=>parseFeedbackAnalysis(JSON.stringify(value),{secrets:['private-secret-contents']}));
});

test('report store saves one bounded private report tied to original feedback UUID without its raw text',async()=>{
  const records=[];let writes=0;
  const store={submit:async input=>{writes++;records.push({...input,submittedUtc});return {id:input.id,saved:true};},list:async()=>records};
  const reports=createFeedbackReportStore({env,store});
  await reports.save({feedbackId:id,feedbackSubmittedUtc:submittedUtc,analysis});
  const [saved]=await reports.list();assert.equal(writes,1);assert.equal(saved.feedbackId,id);assert.equal(saved.reviewStatus,'owner-review');assert.equal(saved.model,'onnx-community/Qwen3-0.6B-ONNX');
  assert.deepEqual(Object.keys(JSON.parse(records[0].text)).sort(),['category','feedbackId','feedbackSubmittedUtc','model','modelRevision','reviewStatus','schemaVersion','suggestion','summary']);
  records[0].id=other;await assert.rejects(reports.list());
  for(const repo of [env.FEEDBACK_HF_REPO,env.CONTRIBUTIONS_HF_REPO])await assert.rejects(createFeedbackReportStore({env:{...env,INPUT_ANALYSIS_HF_REPO:repo},store}).list());
});

test('feedback batches skip saved UUIDs, process FIFO once and ignore invalid model outputs',async()=>{
  const records=[{id:other,text:'The page is slow.',submittedUtc:'2026-10-07T13:00:00.000Z'},{id,text:'It takes long to open.',submittedUtc}],saved=[];let calls=0;
  const service=createFeedbackAnalysisService({env,feedbackStore:{list:async()=>records},reportStore:{list:async()=>saved,save:async value=>{saved.push(value);return {id:value.feedbackId,saved:true};}},ai:{analyzeFeedback:async()=>{calls++;return analysis;}}});
  assert.deepEqual(await service.drain(),{analyzed:2,failed:0});assert.deepEqual(saved.map(v=>v.feedbackId),[id,other]);
  assert.deepEqual(await service.drain(),{analyzed:0,failed:0});assert.equal(calls,2);await service.stop();
  let writes=0;
  const bad=createFeedbackAnalysisService({env,feedbackStore:{list:async()=>records},reportStore:{list:async()=>[],save:async()=>{writes++;}},ai:{analyzeFeedback:async()=>({...analysis,action:'publish'})}});
  assert.deepEqual(await bad.drain(),{analyzed:0,failed:2});assert.equal(writes,0);await bad.stop();
});

test('interrupted feedback analysis never saves a completion and can retry later',async()=>{
  const started=deferred();let writes=0;
  const service=createFeedbackAnalysisService({env,feedbackStore:{list:async()=>[{id,text:'The page is slow.',submittedUtc}]},reportStore:{list:async()=>[],save:async()=>{writes++;}},ai:{analyzeFeedback:async(text,{signal})=>{started.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}});
  const running=service.drain();await started.promise;await service.stop();await running;assert.equal(writes,0);
});

test('processor startup and hourly ticks run sequentially without overlap and health exposes no private records',async t=>{
  const release=deferred(),calls=[];let tick,interval,closed=0;
  const app=createInputAnalysisApp({env,ai:{close(){closed++;}},contributions:{drain:async()=>{calls.push('contributions');await release.promise;},stop:async()=>calls.push('stop-contributions')},feedback:{drain:async()=>calls.push('feedback'),stop:async()=>calls.push('stop-feedback')},setIntervalImpl:(callback,ms)=>{tick=callback;interval=ms;return {unref(){}};},clearIntervalImpl:()=>calls.push('clear-timer')});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  app.start();assert.equal(interval,3600000);await new Promise(resolve=>setImmediate(resolve));void tick();
  assert.deepEqual(calls,['contributions']);
  const health=await (await fetch(origin+'/healthz')).json();assert.equal(health.ok,true);assert.equal(health.state,'processing');assert.equal(health.batchIntervalMinutes,60);assert.doesNotMatch(JSON.stringify(health),/token|secret|transcript|records|fixture/);
  assert.equal((await fetch(origin+'/api/browser/contributions')).status,404);assert.equal((await fetch(origin+'/run',{method:'POST'})).status,404);
  release.resolve();await app.runBatch();assert.deepEqual(calls,['contributions','feedback']);await tick();await app.runBatch();assert.deepEqual(calls,['contributions','feedback','contributions','feedback']);
  await app.stop();assert.equal(closed,1);
});

test('processor reports missing configuration as unhealthy',async t=>{
  const app=createInputAnalysisApp({env:{PORT:'0'},ai:{close(){}},contributions:{async drain(){},async stop(){}},feedback:{async drain(){},async stop(){}}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/healthz`);assert.equal(response.status,503);assert.equal((await response.json()).ok,false);await app.stop();
});
