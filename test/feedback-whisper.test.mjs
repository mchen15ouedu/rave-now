import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeedbackTranscriber} from '../public/browser/whisper-client.js';

function setup(options={}) {
  const workers=[];
  class Worker {
    constructor(url,options){this.url=url;this.options=options;workers.push(this);}
    postMessage(message,transfer){this.message=message;this.transfer=transfer;}
    terminate(){this.terminated=true;}
    emit(type,values={}){this.onmessage({data:{id:this.message.id,type,...values}});}
  }
  return {workers,transcribe:createFeedbackTranscriber({WorkerImpl:Worker,...options})};
}
const audio=()=>new Float32Array(3200).fill(0.1);

test('Whisper starts lazily, copies audio to its worker and reuses it after success',async()=>{
  const {transcribe,workers}=setup();assert.equal(workers.length,0);
  const input=audio(),progress=[];
  const result=transcribe(input,{onProgress:value=>progress.push(value)}),worker=workers[0];
  assert.equal(worker.url,'/browser/vendor/whisper-worker.bundle.js');assert.equal(worker.options.type,'module');
  assert.notEqual(worker.message.audio,input);assert.deepEqual(worker.message.audio,input);
  assert.deepEqual(worker.transfer,[worker.message.audio.buffer]);assert.equal(input.length,3200);
  worker.emit('progress',{message:'Loading model'});worker.emit('result',{text:'  Clearer loading please.  '});
  assert.equal(await result,'Clearer loading please.');assert.deepEqual(progress,['Loading model']);
  const next=transcribe(input);worker.emit('result',{text:'More feedback'});
  assert.equal(await next,'More feedback');assert.equal(workers.length,1);assert.ok(!worker.terminated);
});

test('Whisper rejects overlapping jobs and ignores a stale message',async()=>{
  const {transcribe,workers}=setup();const pending=transcribe(audio());
  await assert.rejects(transcribe(audio()),/already/);
  const worker=workers[0];worker.onmessage({data:{id:99,type:'result',text:'Wrong recording'}});
  worker.emit('result',{text:'Right recording'});assert.equal(await pending,'Right recording');
});

test('cancelled transcription terminates the worker and permits a fresh attempt',async()=>{
  const {transcribe,workers}=setup(),controller=new AbortController();
  const pending=transcribe(audio(),{signal:controller.signal});controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.ok(workers[0].terminated);
  const next=transcribe(audio());workers[1].emit('result',{text:'Try again'});assert.equal(await next,'Try again');
});

test('worker errors and unusable transcripts fail without leaking a provider message',async()=>{
  for(const response of [{type:'error',text:'secret'},{type:'result',text:''},{type:'result',text:'x'.repeat(2001)}]) {
    const {transcribe,workers}=setup(),pending=transcribe(audio());workers[0].emit(response.type,response);
    await assert.rejects(pending,error=>!error.message.includes('secret'));assert.ok(workers[0].terminated);
  }
});

test('Whisper timeout terminates an unresponsive worker',async()=>{
  const {transcribe,workers}=setup({timeoutMs:10});await assert.rejects(transcribe(audio()),/too long/);
  assert.ok(workers[0].terminated);
});

test('invalid audio and unavailable workers leave typed feedback available',async()=>{
  const {transcribe,workers}=setup();
  for(const value of [[],new Float32Array(1),new Float32Array(960001),new Float32Array(2000).fill(NaN)]) await assert.rejects(transcribe(value),/60 seconds/);
  assert.equal(workers.length,0);
  await assert.rejects(createFeedbackTranscriber({WorkerImpl:null})(audio()),/type your feedback/);
});
