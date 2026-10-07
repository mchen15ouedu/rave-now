import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createContributionHandler } from '../src/contributions.mjs';
import { createContributionService } from '../src/contributions-service.mjs';

const id='20b0baf4-2d28-4781-9a4a-3d8f036e8cd2',otherId='30b0baf4-2d28-4781-9a4a-3d8f036e8cd2';
const input={id,text:'Please add Tiësto.'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
const defaultService={submit:async value=>({id:value.id,saved:true}),status:async value=>({id:value,status:'queued',message:'Waiting for processing.'})};

async function server(t,options={}) {
  const handle=createContributionHandler({env:{},service:defaultService,...options}),errors=[];
  const http=createServer((req,res)=>{
    Promise.resolve(handle(req,res)).then(handled=>{if(!handled){res.writeHead(404);res.end('Unknown route');}}).catch(error=>{errors.push(error);if(!res.headersSent){res.writeHead(500);res.end('Unhandled error');}else res.destroy();});
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(()=>new Promise(resolve=>{http.closeAllConnections();http.close(resolve);}));
  const origin=`http://127.0.0.1:${http.address().port}`,url=origin+'/api/browser/contributions';
  const post=(value=input,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
  const get=(value=id,headers={})=>fetch(url+'/'+value,{headers});
  return {http,origin,url,post,get,errors};
}

function upload(url,chunks) {
  let req;
  const response=new Promise((resolve,reject)=>{
    req=request(url,{method:'POST',headers:{'Content-Type':'application/json'}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));res.once('error',reject);});
    req.once('error',reject);for(const chunk of chunks)req.write(chunk);
  });
  return {req,response};
}

test('POST acknowledges a reviewed canonical UUID only after durable storage confirms its matching receipt',async t=>{
  const started=deferred(),saved=deferred();let observed,resolved=false;
  const {post}=await server(t,{service:{submit:async(value,{signal})=>{observed={value,signal};started.resolve();await saved.promise;return {id:value.id,saved:true,status:'completed',text:'private transcript',token:'private'};}}});
  const waiting=post({id:id.toUpperCase(),text:' Please add Tie\u0308sto. '}).then(value=>{resolved=true;return value;});
  await started.promise;await nextTurn();assert.equal(resolved,false);assert.deepEqual(observed.value,input);assert.ok(observed.signal instanceof AbortSignal);
  saved.resolve();const response=await waiting;
  assert.equal(response.status,202);assert.deepEqual(await response.json(),{ok:true,id,status:'queued'});
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
});

test('POST never acknowledges missing, false or mismatched durable receipts',async t=>{
  for(const receipt of [null,undefined,{}, {id,saved:false},{id,saved:'true'},{id:otherId,saved:true},{id:id.toUpperCase(),saved:true}]) {
    let calls=0;const {post}=await server(t,{service:{submit:async()=>{calls++;return receipt;}}});
    const response=await post(),data=await response.json();assert.equal(response.status,503);assert.equal(data.ok,undefined);assert.equal(data.id,undefined);assert.equal(calls,1);
  }
});

test('route methods and canonical GET UUIDs are enforced before storage or worker calls',async t=>{
  let submits=0,gets=0;
  const {url,origin,get}=await server(t,{service:{submit:async()=>{submits++;},status:async()=>{gets++;}}});
  for(const method of ['GET','PUT','PATCH','DELETE','OPTIONS']) {const response=await fetch(url,{method});assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'POST');}
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) {const response=await fetch(url+'/'+id,{method});assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'GET');}
  for(const invalid of ['invalid',id.toUpperCase(),'00000000-0000-0000-0000-000000000000',id+'%2Fprivate'])assert.equal((await get(invalid)).status,400);
  assert.equal((await fetch(origin+'/api/browser/contributions/private/nested')).status,404);
  assert.equal(submits,0);assert.equal(gets,0);
});

test('only request Host or configured public Origin can submit or poll status',async t=>{
  const configured='https://configured-app.example';let calls=0;
  const service={submit:async value=>{calls++;return {id:value.id,saved:true};},status:async id=>{calls++;return {id,status:'queued',message:'Waiting.'};}};
  const {origin,post,get}=await server(t,{env:{BROWSER_PUBLIC_ORIGIN:configured},service});
  for(const allowed of [origin,origin.replace('http:','https:'),configured]) {assert.equal((await post(input,{Origin:allowed})).status,202);assert.equal((await get(id,{Origin:allowed})).status,200);}
  for(const rejected of ['https://external.example',configured+'/path','null','https://sample-unrelated.hf.space']) {
    const response=await post(input,{Origin:rejected});assert.equal(response.status,403);assert.equal(response.headers.get('access-control-allow-origin'),null);
    assert.equal((await get(id,{Origin:rejected})).status,403);
  }
  assert.equal(calls,6);
});

test('invalid media type, JSON, unknown audio/location/secret keys and invalid text never reach save',async t=>{
  let calls=0;const {url,post}=await server(t,{service:{submit:async()=>{calls++;return {id,saved:true};}}});
  for(const type of ['text/plain','application/jsonp','application/json-extra','multipart/form-data'])assert.equal((await post(input,{'Content-Type':type})).status,415);
  for(const body of ['', '{invalid', 'undefined'])assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,400);
  for(const invalid of [null,[],123,{}, {id},{id,text:''},{id,text:' '},{id,text:123},{id,text:'x'.repeat(2001)},{id,text:'a\u0000b'},{id:'../private',text:'Tiësto'},{...input,audio:'raw'},{...input,latitude:32},{...input,secret:'private'},{...input,sourceUrls:['https://private.example']}])assert.equal((await post(invalid)).status,400);
  assert.equal(calls,0);assert.equal((await post(input,{'Content-Type':'Application/JSON; charset=UTF-8'})).status,202);assert.equal(calls,1);
});

test('oversized Content-Length and chunked uploads return 413 without a save or broken socket',async t=>{
  let calls=0;const {url,post,errors}=await server(t,{service:{submit:async value=>{calls++;return {id:value.id,saved:true};}}});
  assert.equal((await post({...input,text:'x'.repeat(12001)})).status,413);
  const streamed=upload(url,['x'.repeat(6000),'x'.repeat(6001)]);streamed.req.end();assert.equal((await streamed.response).status,413);
  assert.equal(calls,0);assert.equal((await post()).status,202);assert.deepEqual(errors,[]);
});

test('GET returns only ID/status/message and never transcript, result evidence, lease or token',async t=>{
  const privateFields={text:'private transcript',sourceUrls:['https://private.example'],lease:{owner:'private-owner',until:'2099-01-01'},token:'hf_'+'privateruntimetoken123456789',result:{message:'private result',sourceUrls:['https://private.example']}};
  for(const status of ['queued','processing','completed','needs-review','rejected']) {
    const {get}=await server(t,{service:{status:async id=>({id,status,message:'Safe public message.',...privateFields})}});
    const response=await get(),data=await response.json();assert.equal(response.status,200);assert.deepEqual(data,{id,status,message:'Safe public message.'});
    assert.doesNotMatch(JSON.stringify(data),/transcript|sourceUrls|lease|token|private-owner|hf_private|private\.example/);
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  const missing=await server(t,{service:{status:async()=>null}});assert.equal((await missing.get()).status,404);
  for(const value of [{id:otherId,status:'completed',message:'private transcript'},{id,status:'arbitrary',message:'private transcript'}]) {
    const invalid=await server(t,{service:{status:async()=>value}}),response=await invalid.get();assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private transcript/);
  }
});

test('POST and GET errors are sanitized and conflicts/invalid drafts have explicit status',async t=>{
  for(const [code,status] of [['INVALID_CONTRIBUTION',400],['ID_CONFLICT',409],['NOT_CONFIGURED',503],['INVALID_CONFIGURATION',503],['UNAVAILABLE',503],['LIMIT_EXCEEDED',503]]) {
    const fail=async()=>{throw Object.assign(new Error('private-provider '+'hf_'+'sensitiveprovidersecret123456 https://private.example'),{code});};
    const {post,get}=await server(t,{service:{submit:fail,status:fail}});
    for(const response of [await post(),await get()]) {assert.equal(response.status,status);const data=await response.json();assert.deepEqual(Object.keys(data),['error']);assert.doesNotMatch(JSON.stringify(data),/private-provider|hf_sensitive|private\.example/);}
  }
});

test('actual unconfigured sample service returns 503 and never fakes queued or saved state',async t=>{
  const service=createContributionService({env:{}});t.after(()=>service.stop());
  const {post,get}=await server(t,{service});
  for(const response of [await post(),await get()]) {assert.equal(response.status,503);const data=await response.json();assert.equal(data.ok,undefined);assert.equal(data.id,undefined);assert.equal(data.status,undefined);}
});

test('four active operations reject a fifth without storage calls and release capacity afterwards',async t=>{
  const started=deferred(),finish=deferred();let calls=0;
  const {post}=await server(t,{service:{submit:async value=>{if(++calls===4)started.resolve();await finish.promise;return {id:value.id,saved:true};}}});
  const pending=Array.from({length:4},()=>post());await started.promise;
  assert.equal((await post()).status,429);assert.equal(calls,4);
  finish.resolve();for(const response of await Promise.all(pending))assert.equal(response.status,202);
  assert.equal((await post()).status,202);assert.equal(calls,5);
});

test('120 confirmed hourly submissions cap writes until reset and rejected drafts do not count',async t=>{
  let time=0,calls=0;const {post}=await server(t,{clock:()=>time,service:{submit:async value=>{calls++;return {id:value.id,saved:true};}}});
  assert.equal((await post({id,text:''})).status,400);
  for(let index=0;index<120;index++)assert.equal((await post()).status,202);
  assert.equal((await post()).status,429);assert.equal(calls,120);time+=3600000;
  assert.equal((await post()).status,202);assert.equal(calls,121);
});

test('timeouts bound ignored service waits or stalled uploads without reporting queued or malformed input',async t=>{
  let calls=0;const stalled=deferred();
  const {url,post}=await server(t,{timeoutMs:150,service:{submit:async value=>{if(++calls===1)return stalled.promise;return {id:value.id,saved:true};}}});
  assert.equal((await post()).status,503);assert.equal((await post()).status,202);stalled.resolve({id,saved:true});await nextTurn();
  const streamed=upload(url,['{"id":']);t.after(()=>streamed.req.destroy());const response=await streamed.response;streamed.req.end();
  assert.equal(response.status,503);assert.equal(calls,2);assert.equal((await post()).status,202);
});

test('disconnect cancels only that save and never retries its durable submission',async t=>{
  const started=deferred(),cancelled=deferred(),finish=deferred();let calls=0;
  const {url,post}=await server(t,{service:{submit:async(value,{signal})=>{if(++calls===1){signal.addEventListener('abort',()=>cancelled.resolve(),{once:true});started.resolve();return finish.promise;}return {id:value.id,saved:true};}}});
  const visitor=new AbortController();
  const waiting=fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:visitor.signal});
  const rejected=assert.rejects(waiting,error=>error.name==='AbortError');await started.promise;visitor.abort();await rejected;await cancelled.promise;await nextTurn();
  assert.equal((await post()).status,202);assert.equal(calls,2);finish.resolve({id,saved:true});await nextTurn();
});
