import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createExpirationBridge,createShowExpirationService,invalidateHostedShows,ShowExpirationError} from '../src/show-expiration-service.mjs';

const key='fixture-cleanup-key-never-real-00000000';
const env={SHOW_EXPIRATION_ENABLED:'true',ARTIST_CATALOG_URL:'https://script.google.com/macros/s/fixture/exec',ARTIST_CATALOG_SECRET:key,SHOW_EXPIRATION_BROWSER_ORIGIN:'https://sample-rave-now.hf.space'};
const now=new Date('2026-10-04T12:00:00Z');
const row={row:2,fingerprint:'a'.repeat(64),artist:'Sample DJ',event:'Sample concert',venue:'Sample Club',city:'Dallas, TX',address:'',category:'Nighttime',start:'2026-10-01T20:00:00Z',startInstant:null,startDateOnly:false,end:'',endInstant:null,endDateOnly:null,timeZone:null};
const snapshot={ok:true,snapshotToken:'signed-fixture',capturedAt:now.toISOString(),timeZone:'America/Chicago',rows:[row]};
const candidates=[{row:2,fingerprint:row.fingerprint,expiresAt:'2026-10-02T20:00:00.000Z'}];
const receipt={ok:true,deleted:1,deletedRows:[2],skippedRows:[]};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const fail=error=>error instanceof ShowExpirationError&&!error.message.includes(key);

test('cleanup bridge reads complete snapshot and sends one authenticated apply with fixed plan fields',async()=>{
  const calls=[];
  const bridge=createExpirationBridge({env,fetchImpl:async(url,options)=>{calls.push({url,options});return json(calls.length===1?snapshot:receipt);}});
  assert.deepEqual(await bridge.readSnapshot(),{snapshotToken:snapshot.snapshotToken,capturedAt:snapshot.capturedAt,timeZone:snapshot.timeZone,rows:[row]});
  assert.deepEqual(await bridge.apply({snapshotToken:snapshot.snapshotToken,candidates,privateNote:'ignored'}),{deleted:1,deletedRows:[2],skippedRows:[]});
  assert.equal(calls.length,2);assert.equal(calls[0].options.redirect,'manual');
  assert.deepEqual(JSON.parse(calls[1].options.body),{secret:key,action:'applyExpiredShows',snapshotToken:snapshot.snapshotToken,candidates});
});

test('Apps Script output redirect uses fresh Google GET without forwarding a write or shared key',async()=>{
  const calls=[];
  const bridge=createExpirationBridge({env,fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/output?fixture=1'}}):json(snapshot);}});
  await bridge.readSnapshot();assert.equal(calls[1].options.method,'GET');assert.equal(calls[1].options.body,undefined);assert.equal(calls[1].options.headers,undefined);
  for(const target of ['https://evil.example/output','http://script.googleusercontent.com/output','https://user:password@script.googleusercontent.com/output']){
    const bad=createExpirationBridge({env,fetchImpl:async()=>new Response(null,{status:302,headers:{location:target}})});
    await assert.rejects(bad.readSnapshot(),fail);
  }
});

test('cleanup bridge rejects malformed full snapshots and unconfirmed receipts without exposing provider text',async()=>{
  for(const value of [{...snapshot,rows:[row,row]},{...snapshot,rows:[{...row,fingerprint:'bad'}]},{...snapshot,rows:[{...row,startDateOnly:'yes'}]},{...snapshot,rows:[{...row,start:34}]},{...snapshot,ok:false,code:'INVALID_STRUCTURE',error:key}]){
    await assert.rejects(createExpirationBridge({env,fetchImpl:async()=>json(value)}).readSnapshot(),fail);
  }
  for(const value of [{...receipt,deleted:2},{...receipt,deletedRows:[3]},{...receipt,skippedRows:[2]},{...receipt,deletedRows:[2,2]}]){
    await assert.rejects(createExpirationBridge({env,fetchImpl:async()=>json(value)}).apply({snapshotToken:snapshot.snapshotToken,candidates}),fail);
  }
  let writes=0;await assert.rejects(createExpirationBridge({env,fetchImpl:async()=>{writes++;throw Error(key);}}).apply({snapshotToken:snapshot.snapshotToken,candidates}),fail);assert.equal(writes,1);
});

test('service dry-run never applies deletions or invalidates the live cache',async()=>{
  let planned=0,deleted=0,invalidated=0;
  const bridge={readSnapshot:async()=>snapshot,dryRun:async plan=>{planned=plan.candidates.length;return {deleted:0,deletedRows:[],skippedRows:[]};},apply:async()=>{deleted++;return receipt;}};
  const service=createShowExpirationService({env,bridge,clock:()=>now,invalidate:async()=>{invalidated++;return true;}});
  const result=await service.drain({dryRun:true});assert.equal(result.status,'dry-run');assert.equal(planned,1);assert.equal(deleted,0);assert.equal(invalidated,0);await service.stop();
});

test('service keeps a cache notification pending after a partial failure and retries with a fresh snapshot',async()=>{
  let reads=0,writes=0,notifications=0;
  const service=createShowExpirationService({env,clock:()=>now,bridge:{readSnapshot:async()=>({...snapshot,rows:++reads===1?[row]:[]}),apply:async()=>{writes++;return receipt;}},invalidate:async()=>{if(++notifications===1)throw Error('network down');return true;}});
  const first=await service.drain();assert.equal(first.status,'failed');assert.equal(first.deleted,1);assert.equal(first.errorCode,'UNAVAILABLE');assert.equal(first.errorStage,'invalidate');
  const second=await service.drain();assert.equal(second.status,'completed');assert.equal(second.deleted,0);assert.equal(second.cacheInvalidated,true);assert.equal(second.errorCode,null);assert.equal(second.errorStage,null);
  assert.equal(reads,2);assert.equal(writes,1);assert.equal(notifications,2);await service.stop();
});

test('uncertain sheet write is not automatically retried and still clears potentially stale cache',async()=>{
  let writes=0,notifications=0;
  const service=createShowExpirationService({env,clock:()=>now,bridge:{readSnapshot:async()=>snapshot,apply:async()=>{writes++;throw Error('response lost');}},invalidate:async()=>{notifications++;return true;}});
  const result=await service.drain();assert.equal(result.status,'failed');assert.equal(result.errorCode,'UNAVAILABLE');assert.equal(result.errorStage,'apply');assert.equal(writes,1);assert.equal(notifications,1);await service.stop();
});

test('startup and 15-minute ticks do not overlap, and stop cancels a running cleanup',async()=>{
  let tick,interval,reads=0,clears=0,release;
  const wait=new Promise(resolve=>release=resolve);
  const service=createShowExpirationService({env,clock:()=>now,setIntervalImpl:(callback,ms)=>{tick=callback;interval=ms;return {unref(){}};},clearIntervalImpl:()=>clears++,bridge:{readSnapshot:async({signal})=>{reads++;await Promise.race([wait,new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);return {...snapshot,rows:[]};}},invalidate:async()=>true});
  service.start();await Promise.resolve();void tick();assert.equal(interval,900000);assert.equal(reads,1);await service.stop();release();assert.equal(clears,1);assert.equal(service.state().status,'interrupted');assert.equal(service.state().errorCode,'CANCELLED');assert.equal(service.state().errorStage,'read');
});

test('disabled cleanup cannot read or write a sheet',async()=>{
  let calls=0;const service=createShowExpirationService({env:{...env,SHOW_EXPIRATION_ENABLED:'false'},bridge:{readSnapshot:async()=>calls++}});
  service.start();assert.equal((await service.drain()).status,'disabled');assert.equal(calls,0);await service.stop();
});

test('hosted callback is signed with an existing key, has a deadline and never follows redirects',async()=>{
  let saved;
  assert.equal(await invalidateHostedShows({env,clock:()=>now,fetchImpl:async(url,options)=>{saved={url:String(url),options};return json({ok:true,invalidated:true});}}),true);
  assert.equal(saved.url,'https://sample-rave-now.hf.space/api/internal/show-expiration');assert.equal(saved.options.redirect,'error');assert.ok(saved.options.signal);
  const body=JSON.parse(saved.options.body);assert.equal(body.timestamp,now.toISOString());assert.equal(body.signature,createHmac('sha256',key).update(`${body.timestamp}\n${body.nonce}`).digest('hex'));assert.doesNotMatch(saved.options.body,new RegExp(key));
  for(const origin of ['http://sample.hf.space','https://user:password@sample.hf.space','https://sample.hf.space/wrong','https://sample.hf.space/?key=1'])await assert.rejects(invalidateHostedShows({env:{...env,SHOW_EXPIRATION_BROWSER_ORIGIN:origin}}),fail);
});

test('cleanup bridge only accepts known fixed failure labels and discards provider details',async()=>{
  for(const [code,expected] of [['UNAUTHORIZED','UNAUTHORIZED'],['INVALID_STRUCTURE','INVALID_STRUCTURE'],['STALE_SNAPSHOT','STALE_SNAPSHOT'],['NOT_EXPIRED','NOT_EXPIRED'],['PRIVATE_PROVIDER_TOKEN_NEVER_PUBLIC','UNAVAILABLE'],[key,'UNAVAILABLE']]){
    const bridge=createExpirationBridge({env,fetchImpl:async()=>json({ok:false,code,error:`${key} https://private.example/source`})});
    await assert.rejects(bridge.readSnapshot(),error=>{assert.equal(error.code,expected);assert.equal(error.message,'Show cleanup could not be confirmed.');assert.doesNotMatch(JSON.stringify(error),new RegExp(key));return true;});
  }
  assert.equal(new ShowExpirationError('ARBITRARY_UPSTREAM_CODE').code,'UNAVAILABLE');
});

test('bridge and hosted callback classify aborts without exposing abort reasons',async()=>{
  for(const operation of [
    signal=>createExpirationBridge({env,fetchImpl:async()=>{throw new DOMException(key,'AbortError');}}).readSnapshot({signal}),
    signal=>invalidateHostedShows({env,clock:()=>now,signal,fetchImpl:async()=>{throw new DOMException(key,'AbortError');}}),
  ]){
    const controller=new AbortController();controller.abort(Error(key));
    await assert.rejects(operation(controller.signal),error=>{assert.equal(error.code,'CANCELLED');assert.doesNotMatch(error.message,new RegExp(key));return true;});
  }
});

test('owned bridge failures distinguish fixed transport labels without disclosing status, URL or cause',async()=>{
  const privateMessage=`${key} https://private.example/source`;
  for(const [response,expected] of [
    [()=>new Response(privateMessage,{status:503}),'HTTP_ERROR'],
    [()=>new Response(null,{status:302,headers:{location:'https://private.example/source'}}),'INVALID_REDIRECT'],
    [()=>{throw new DOMException(privateMessage,'TimeoutError');},'FETCH_TIMEOUT'],
    [()=>{throw Error(privateMessage,{cause:new DOMException(privateMessage,'TimeoutError')});},'FETCH_TIMEOUT'],
    [()=>{throw Error(privateMessage,{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});},'FETCH_TIMEOUT'],
    [()=>{throw Error(privateMessage,{cause:{code:'ENOTFOUND',hostname:'private.example'}});},'NETWORK_DNS'],
    [()=>{throw Error(privateMessage,{cause:{code:'EAI_AGAIN'}});},'NETWORK_DNS'],
    [()=>{throw Error(privateMessage,{cause:{code:'ECONNRESET'}});},'NETWORK_ERROR'],
    [()=>{throw Error(privateMessage,{cause:{code:'PRIVATE_PROVIDER_TOKEN_NEVER_PUBLIC'}});},'UNAVAILABLE'],
  ]){
    const service=createShowExpirationService({env,clock:()=>now,bridge:createExpirationBridge({env,fetchImpl:async()=>response()}),invalidate:async()=>true});
    const result=await service.drain();assert.equal(result.errorCode,expected);assert.equal(result.errorStage,'read');assert.doesNotMatch(JSON.stringify({result,state:service.state()}),/503|private\.example|fixture-cleanup-key|hostname|PRIVATE_PROVIDER_TOKEN_NEVER_PUBLIC/);await service.stop();
  }
});

test('read failures retain safe first diagnostics when cache invalidation also fails',async()=>{
  for(const [code,expected] of [['UNAUTHORIZED','UNAUTHORIZED'],['BUSY','BUSY'],['PRIVATE_PROVIDER_TOKEN_NEVER_PUBLIC','UNAVAILABLE']]){
    let writes=0;
    const service=createShowExpirationService({env,clock:()=>now,bridge:{readSnapshot:async()=>{throw Object.assign(Error(`${key} https://private.example/source`),{code});},apply:async()=>writes++},invalidate:async()=>{throw new ShowExpirationError('INVALIDATION_FAILED');}});
    const result=await service.drain();assert.equal(result.status,'failed');assert.equal(result.errorCode,expected);assert.equal(result.errorStage,'read');assert.equal(result.cacheInvalidated,false);assert.equal(writes,0);
    const state=service.state();assert.equal(state.errorCode,expected);assert.equal(state.errorStage,'read');assert.doesNotMatch(JSON.stringify({result,state}),/PRIVATE_PROVIDER_TOKEN_NEVER_PUBLIC|private\.example|fixture-cleanup-key|stack|message/);await service.stop();
  }
});

test('a malformed planner input reports the plan stage with no row or provider information',async()=>{
  const service=createShowExpirationService({env,clock:()=>now,bridge:{readSnapshot:async()=>null},invalidate:async()=>true});
  const result=await service.drain();assert.equal(result.status,'failed');assert.equal(result.errorCode,'UNAVAILABLE');assert.equal(result.errorStage,'plan');assert.equal(result.sourceRows,0);assert.equal(result.cacheInvalidated,true);await service.stop();
});

test('stale apply diagnosis survives a failed notification and an eventual fresh run resets it',async()=>{
  let reads=0,writes=0,notifications=0;
  const service=createShowExpirationService({env,clock:()=>now,bridge:{readSnapshot:async()=>({...snapshot,rows:++reads===1?[row]:[]}),apply:async()=>{writes++;throw new ShowExpirationError('STALE_SNAPSHOT');}},invalidate:async()=>{if(++notifications===1)throw Object.assign(Error(key),{code:'INVALIDATION_FAILED'});return true;}});
  const first=await service.drain();assert.equal(first.status,'failed');assert.equal(first.errorCode,'STALE_SNAPSHOT');assert.equal(first.errorStage,'apply');assert.equal(first.sourceRows,1);assert.equal(first.deleted,0);
  const second=await service.drain();assert.equal(second.status,'completed');assert.equal(second.errorCode,null);assert.equal(second.errorStage,null);assert.equal(second.cacheInvalidated,true);assert.equal(writes,1);assert.equal(reads,2);assert.equal(notifications,2);await service.stop();
});

test('a confirmed deletion followed by callback failure reports invalidate and keeps deletion totals',async()=>{
  const service=createShowExpirationService({env,clock:()=>now,bridge:{readSnapshot:async()=>snapshot,apply:async()=>receipt},invalidate:async()=>{throw new ShowExpirationError('INVALIDATION_FAILED');}});
  const result=await service.drain();assert.equal(result.status,'failed');assert.equal(result.errorCode,'INVALIDATION_FAILED');assert.equal(result.errorStage,'invalidate');assert.equal(result.deleted,1);assert.equal(result.cacheInvalidated,false);await service.stop();
});
