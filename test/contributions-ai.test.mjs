import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createContributionAI,parseArtistExtraction} from '../src/contributions-ai.mjs';

test('extraction requires grounded names and a bounded strict schema',()=>{
  assert.deepEqual(parseArtistExtraction('{"artist":"Beyoncé","hasEvent":false}','Please add Beyonce.'),{artist:'Beyoncé',hasEvent:false});
  assert.deepEqual(parseArtistExtraction('```json\n{"artist":"Autechre","hasEvent":false}\n```','Autechre tickets this weekend'),{artist:'Autechre',hasEvent:true});
  for(const output of ['{"artist":"Cher","hasEvent":false}','{"artist":"Autechre","hasEvent":false,"verified":true}','{"artist":9,"hasEvent":false}','not json','x'.repeat(2001)])assert.throws(()=>parseArtistExtraction(output,'Autechre'));
  assert.throws(()=>parseArtistExtraction('{"artist":"Cher","hasEvent":false}','Autechre'));
  assert.throws(()=>parseArtistExtraction('{"artist":"Cher","hasEvent":false}','Cherish'));
});

const workers=[];
class FakeWorker extends EventEmitter {
  constructor(){super();workers.push(this);this.messages=[];this.terminated=false;}
  postMessage(value){this.messages.push(value);}
  terminate(){this.terminated=true;return Promise.resolve(0);}
  respond(output,id=this.messages.at(-1).id){this.emit('message',{id,output});}
}
const valid='{"artist":"Autechre","hasEvent":false}';

test('explicit calendar dates cannot be discarded by a model without event words',()=>{
  for(const text of ['Autechre Dallas October 9, 2026','Autechre Dallas 9 October 2026','Autechre Dallas 10/9/2026'])assert.equal(parseArtistExtraction(valid,text).hasEvent,true);
});

test('one lazy worker is reused and stale replies do not complete a later job',async()=>{
  const ai=createContributionAI({WorkerImpl:FakeWorker,timeoutMs:1000});
  try{
    const first=ai.extract('Autechre'),worker=workers.at(-1);
    worker.respond(valid,999);worker.respond(valid);
    assert.equal((await first).artist,'Autechre');
    const second=ai.extract('Autechre');
    assert.equal(workers.at(-1),worker);
    await assert.rejects(ai.extract('Autechre'),/busy/);
    worker.respond(valid,1);worker.respond(valid);
    assert.equal((await second).artist,'Autechre');
    assert.equal(worker.listenerCount('message'),0);
  }finally{ai.close();}
});

test('idle errors are handled and an old worker exit does not discard its replacement',async()=>{
  const ai=createContributionAI({WorkerImpl:FakeWorker,timeoutMs:1000});
  try{
    const first=ai.extract('Autechre'),old=workers.at(-1);old.respond(valid);await first;
    old.emit('error',Error('private worker detail'));
    assert.equal(old.terminated,true);
    const second=ai.extract('Autechre'),replacement=workers.at(-1);
    assert.notEqual(replacement,old);old.emit('exit',1);
    assert.equal(replacement.terminated,false);replacement.respond(valid);await second;
  }finally{ai.close();}
});

test('cancellation and deadlines terminate work with sanitized errors',async()=>{
  const ai=createContributionAI({WorkerImpl:FakeWorker,timeoutMs:20});
  const abort=new AbortController();
  const first=ai.extract('Autechre',{signal:abort.signal}),worker=workers.at(-1);
  abort.abort(Error('sensitive cancellation reason'));
  await assert.rejects(first,error=>error.message==='Artist extraction unavailable');
  assert.equal(worker.terminated,true);
  const second=ai.extract('Autechre'),next=workers.at(-1);
  await assert.rejects(second,/unavailable/);assert.equal(next.terminated,true);
  ai.close();
});

test('malformed model output or worker failure cannot claim a verified artist',async()=>{
  const ai=createContributionAI({WorkerImpl:FakeWorker,timeoutMs:1000});
  try{
    const first=ai.extract('Autechre'),worker=workers.at(-1);worker.respond('{"artist":"Invented","hasEvent":false}');
    await assert.rejects(first,/unavailable/);assert.equal(worker.terminated,true);
    const second=ai.extract('Autechre');workers.at(-1).emit('error',Error('private model failure'));
    await assert.rejects(second,error=>error.message==='Artist extraction unavailable');
  }finally{ai.close();}
});
