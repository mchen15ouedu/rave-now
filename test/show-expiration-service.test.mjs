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
  const first=await service.drain();assert.equal(first.status,'failed');assert.equal(first.deleted,1);
  const second=await service.drain();assert.equal(second.status,'completed');assert.equal(second.deleted,0);assert.equal(second.cacheInvalidated,true);
  assert.equal(reads,2);assert.equal(writes,1);assert.equal(notifications,2);await service.stop();
});

test('uncertain sheet write is not automatically retried and still clears potentially stale cache',async()=>{
  let writes=0,notifications=0;
  const service=createShowExpirationService({env,clock:()=>now,bridge:{readSnapshot:async()=>snapshot,apply:async()=>{writes++;throw Error('response lost');}},invalidate:async()=>{notifications++;return true;}});
  const result=await service.drain();assert.equal(result.status,'failed');assert.equal(writes,1);assert.equal(notifications,1);await service.stop();
});

test('startup and 15-minute ticks do not overlap, and stop cancels a running cleanup',async()=>{
  let tick,interval,reads=0,clears=0,release;
  const wait=new Promise(resolve=>release=resolve);
  const service=createShowExpirationService({env,clock:()=>now,setIntervalImpl:(callback,ms)=>{tick=callback;interval=ms;return {unref(){}};},clearIntervalImpl:()=>clears++,bridge:{readSnapshot:async({signal})=>{reads++;await Promise.race([wait,new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);return {...snapshot,rows:[]};}},invalidate:async()=>true});
  service.start();await Promise.resolve();void tick();assert.equal(interval,900000);assert.equal(reads,1);await service.stop();release();assert.equal(clears,1);assert.equal(service.state().status,'interrupted');
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
