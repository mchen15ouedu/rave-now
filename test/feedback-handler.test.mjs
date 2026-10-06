import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createFeedbackHandler } from '../src/feedback.mjs';

const id='20b0baf4-2d28-4781-9a4a-3d8f036e8cd2';
const input={id,text:'The artist search feels slow.'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));

async function server(t,options={}) {
  const handle=createFeedbackHandler({env:{},...options});
  const errors=[];
  const http=createServer((req,res)=>{
    Promise.resolve(handle(req,res)).then(handled=>{
      if(!handled){res.writeHead(404);res.end('Unknown route');}
    }).catch(error=>{
      errors.push(error);
      if(!res.headersSent){res.writeHead(500);res.end('Unhandled handler error');}
      else res.destroy();
    });
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(()=>new Promise(resolve=>{http.closeAllConnections();http.close(resolve);}));
  const origin=`http://127.0.0.1:${http.address().port}`;
  const url=origin+'/api/browser/feedback';
  const post=(body=input,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  return {http,origin,url,post,errors};
}

function chunked(url,chunks,headers={}) {
  let req;
  const response=new Promise((resolve,reject)=>{
    req=request(url,{method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{
      const body=[];
      res.on('data',chunk=>body.push(chunk));
      res.once('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(body).toString('utf8')}));
      res.once('error',reject);
    });
    req.once('error',reject);
    for(const chunk of chunks)req.write(chunk);
  });
  return {req,response};
}

test('feedback handler owns only its POST route and rejects other methods before saving',async t=>{
  let calls=0;const {url,origin,errors}=await server(t,{store:{submit:async()=>{calls++;return {id,saved:true};}}});
  for(const method of ['GET','PUT','PATCH','DELETE','OPTIONS']) {
    const response=await fetch(url,{method});
    assert.equal(response.status,405);
    assert.equal(response.headers.get('allow'),'POST');
    assert.deepEqual(await response.json(),{error:'Use POST to send feedback.'});
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  assert.equal((await fetch(origin+'/api/browser/feedback/private')).status,404);
  assert.equal(calls,0);assert.deepEqual(errors,[]);
});

test('feedback accepts its request Host and configured public origin but rejects external and former owner origins',async t=>{
  let calls=0;const publicOrigin='https://configured-app.example';
  const {origin,post}=await server(t,{env:{BROWSER_PUBLIC_ORIGIN:publicOrigin},store:{submit:async value=>{calls++;return {id:value.id,saved:true};}}});
  for(const allowed of [undefined,origin,origin.replace('http:','https:'),publicOrigin]) {
    const response=await post(input,allowed?{Origin:allowed}:{});
    assert.equal(response.status,200);
  }
  for(const rejected of ['https://external.example',publicOrigin+'/path','null','https://old-owner-app.hf.space']) {
    const response=await post(input,{Origin:rejected});
    assert.equal(response.status,403);
    assert.equal(response.headers.get('access-control-allow-origin'),null);
    assert.deepEqual(await response.json(),{error:'Open this app to send feedback.'});
  }
  assert.equal(calls,4);
});

test('feedback requires actual JSON media type and rejects invalid JSON and unknown keys before saving',async t=>{
  let calls=0;const {url,post}=await server(t,{store:{submit:async value=>{calls++;return {id:value.id,saved:true};}}});
  for(const type of ['text/plain','application/jsonp','application/json-extra','multipart/form-data']) assert.equal((await post(input,{'Content-Type':type})).status,415);
  for(const raw of ['', '{invalid', 'undefined']) {
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:raw});
    assert.equal(response.status,400);
  }
  for(const invalid of [null,[],123,'text',{...input,audio:'raw-audio'},{...input,latitude:32},{...input,secret:'private'},{...input,status:'Reviewed'}]) {
    const response=await post(invalid);assert.equal(response.status,400);
  }
  assert.equal(calls,0);
  assert.equal((await post(input,{'Content-Type':'Application/JSON; charset=UTF-8'})).status,200);
  assert.equal(calls,1);
});

test('feedback validates UUID and text independently of the injected store',async t=>{
  let calls=0;const {post}=await server(t,{store:{submit:async()=>{calls++;return {saved:true};}}});
  for(const invalid of [{},{id},{text:'Complaint'},{id:100,text:'Complaint'},{id:'../file',text:'Complaint'},{id,text:123},{id,text:''},{id,text:' '.repeat(2)},{id,text:'x'.repeat(2001)},{id,text:'a\u0000b'},{id,text:'a\u202eb'}]) {
    const response=await post(invalid);
    assert.equal(response.status,400);
    assert.deepEqual(await response.json(),{error:'Enter valid feedback text and try again.'});
  }
  assert.equal(calls,0);
});

test('oversized feedback is rejected by bytes with Content-Length or a chunked stream',async t=>{
  let calls=0;const {url,post,errors}=await server(t,{store:{submit:async value=>{calls++;return {id:value.id,saved:true};}}});
  assert.equal((await post({...input,text:'x'.repeat(12001)})).status,413);
  const streamed=chunked(url,['x'.repeat(6000),'x'.repeat(6001)]);streamed.req.end();
  const response=await streamed.response;
  assert.equal(response.status,413);
  assert.deepEqual(JSON.parse(response.text),{error:'Feedback is too long.'});
  assert.equal(calls,0);
  assert.equal((await post()).status,200);
  assert.deepEqual(errors,[]);
});

test('feedback acknowledges only a confirmed matching lowercase ID and returns no provider details',async t=>{
  let observed;
  const {post}=await server(t,{store:{submit:async(value,{signal})=>{
    observed={value,signal};return {id:value.id,saved:true,text:'private transcript',token:'private token',commitUrl:'https://private-provider.example'};
  }}});
  const response=await post({id:id.toUpperCase(),text:'  Cafe\u0301 search\r\nneeds a fix.  '});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,id});
  assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(observed.value,{id,text:'Café search\nneeds a fix.'});
  assert.ok(observed.signal instanceof AbortSignal);
  assert.equal(observed.signal.aborted,false);
  for(const receipt of [null,undefined,{}, {id,saved:false},{id,saved:'true'},{saved:true},{id:'different',saved:true},{id:id.toUpperCase(),saved:true}]) {
    const app=await server(t,{store:{submit:async()=>receipt}});
    const rejected=await app.post();assert.equal(rejected.status,503);
    assert.deepEqual(await rejected.json(),{error:'Feedback save was not confirmed. Please try again.'});
  }
});

test('feedback errors are sanitized and invalid/conflicting inputs have explicit HTTP statuses',async t=>{
  for(const [errorCode,status] of [['INVALID_FEEDBACK',400],['ID_CONFLICT',409],['NOT_CONFIGURED',503],['INVALID_CONFIGURATION',503],['UNAVAILABLE',503],['LIMIT_EXCEEDED',503],['CANCELLED',503],['unexpected',503]]) {
    const {post,errors}=await server(t,{store:{submit:async()=>{throw Object.assign(new Error('private-provider-token hf_'+'sensitivesecret0123456789 https://private.example'),{code:errorCode});}}});
    const response=await post(),data=await response.json();
    assert.equal(response.status,status);
    assert.equal(Object.keys(data).join(','),'error');
    assert.doesNotMatch(JSON.stringify(data),/private-provider|hf_sensitive|private\.example/);
    assert.equal(data.ok,undefined);
    assert.deepEqual(errors,[]);
  }
});

test('the actual unconfigured durable store returns 503 and never claims an ephemeral save',async t=>{
  const {post}=await server(t,{env:{}});
  for(let attempt=0;attempt<2;attempt++) {
    const response=await post();assert.equal(response.status,503);
    const data=await response.json();
    assert.deepEqual(data,{error:'Feedback save was not confirmed. Please try again.'});
    assert.equal(data.ok,undefined);assert.equal(data.id,undefined);
  }
});

test('one active save rejects simultaneous submissions and frees capacity after completion',async t=>{
  const started=deferred(),complete=deferred();let calls=0;
  const {post}=await server(t,{store:{submit:async value=>{if(++calls===1){started.resolve();await complete.promise;}return {id:value.id,saved:true};}}});
  const first=post();await started.promise;
  const busy=await post();assert.equal(busy.status,429);
  assert.deepEqual(await busy.json(),{error:'Feedback is busy. Please try again shortly.'});
  assert.equal(calls,1);
  complete.resolve();assert.equal((await first).status,200);
  assert.equal((await post()).status,200);assert.equal(calls,2);
});

test('successful hourly save limit resets after an hour and rejected inputs do not consume it',async t=>{
  let now=0,calls=0;
  const {post}=await server(t,{clock:()=>now,store:{submit:async value=>{calls++;return {id:value.id,saved:true};}}});
  for(let index=0;index<3;index++)assert.equal((await post({id,text:''})).status,400);
  for(let index=0;index<120;index++)assert.equal((await post()).status,200);
  assert.equal((await post()).status,429);assert.equal(calls,120);
  now=3600000;
  assert.equal((await post()).status,200);assert.equal(calls,121);
});

test('a deadline bounds providers that ignore cancellation and releases the active-save slot',async t=>{
  const stalled=deferred();let calls=0,observedSignal;
  const {post}=await server(t,{timeoutMs:150,store:{submit:async(value,{signal})=>{
    calls++;observedSignal=signal;if(calls===1)return stalled.promise;return {id:value.id,saved:true};
  }}});
  const response=await post();assert.equal(response.status,503);
  assert.equal(observedSignal.aborted,true);
  assert.deepEqual(await response.json(),{error:'Feedback save was not confirmed. Please try again.'});
  assert.equal((await post()).status,200);
  assert.equal(calls,2);
  stalled.resolve({id,saved:true});await nextTurn();
});

test('a stalled request body reaches its deadline without saving and the next request works',async t=>{
  let calls=0;
  const {url,post,errors}=await server(t,{timeoutMs:150,store:{submit:async value=>{calls++;return {id:value.id,saved:true};}}});
  const upload=chunked(url,['{"id":']);t.after(()=>upload.req.destroy());
  const response=await upload.response;upload.req.end();
  assert.equal(response.status,503);assert.equal(calls,0);
  assert.equal((await post()).status,200);assert.equal(calls,1);
  assert.deepEqual(errors,[]);
});

test('a disconnected visitor cancels one save without retrying or holding subsequent submissions',async t=>{
  const started=deferred(),cancelled=deferred(),finish=deferred();let calls=0;
  const {post,url}=await server(t,{store:{submit:async(value,{signal})=>{
    if(++calls===1){signal.addEventListener('abort',()=>cancelled.resolve(),{once:true});started.resolve();return finish.promise;}
    return {id:value.id,saved:true};
  }}});
  const visitor=new AbortController();
  const waiting=fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:visitor.signal});
  const rejected=assert.rejects(waiting,error=>error.name==='AbortError');
  await started.promise;visitor.abort();await rejected;await cancelled.promise;await nextTurn();
  assert.equal((await post()).status,200);assert.equal(calls,2);
  finish.resolve({id,saved:true});await nextTurn();
});

test('a disconnected upload releases its body-read slot without submitting partial text',async t=>{
  let calls=0;
  const {http,url,post,errors}=await server(t,{store:{submit:async value=>{calls++;return {id:value.id,saved:true};}}});
  const accepted=once(http,'request');
  const upload=chunked(url,['{"id":']);
  const rejected=assert.rejects(upload.response,error=>error.code==='ECONNRESET');
  const [incoming]=await accepted;
  const aborted=once(incoming,'aborted');
  upload.req.destroy();await rejected;await aborted;await nextTurn();
  assert.equal(calls,0);
  assert.equal((await post()).status,200);assert.equal(calls,1);
  assert.deepEqual(errors,[]);
});
