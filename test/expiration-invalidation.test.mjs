import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import http from 'node:http';
import {PassThrough} from 'node:stream';
import {createBrowserHandler} from '../src/browser.mjs';
import {createShowSource} from '../src/providers.mjs';

const SECRET='test-cache-invalidation-secret-32-characters';
const NOW='2026-10-09T12:00:00.000Z';
const ENDPOINT='/api/internal/show-expiration';
function signed(timestamp=NOW,nonce=randomUUID(),secret=SECRET) {
  return {timestamp,nonce,signature:createHmac('sha256',secret).update(`${timestamp}\n${nonce}`).digest('hex')};
}
function fixture({secret=SECRET,source,clock=()=>NOW}={}) {
  let invalidations=0;
  const browser=createBrowserHandler({
    env:{ARTIST_CATALOG_SECRET:secret},clock,
    source:source||{load:async()=>({shows:[]}),invalidate(){invalidations++;}},
    catalog:{load:async()=>({artists:[],promoters:[]})},
    contributionService:{start(){},stop(){}},
  });
  return {browser,get invalidations(){return invalidations;}};
}
async function invoke(browser,input,{method='POST',url=ENDPOINT,raw,headers={},chunks}={}) {
  const req=new PassThrough();
  req.method=method;req.url=url;req.headers={'content-type':'application/json',...headers};
  const res={headers:{},destroyed:false,headersSent:false,
    setHeader(name,value){this.headers[name.toLowerCase()]=value;},
    writeHead(status,values){this.status=status;this.headersSent=true;for(const [name,value]of Object.entries(values))this.setHeader(name,value);},
    end(value){this.body=JSON.parse(value);},
  };
  const pending=browser.handle(req,res);
  if(chunks){for(const chunk of chunks)req.write(chunk);req.end();}
  else req.end(raw??JSON.stringify(input));
  const handled=await pending;
  return {...res,handled};
}

test('valid signed HTTP callback clears the actual live source cache once',async t=>{
  const header=['Artist','Location','Address','City','Ticket Link','Show Time','YouTube (Most Popular Song)'];
  let rows=[header,['Sample DJ','Example Club','','Dallas, TX','','2026-10-10','']],reads=0,invalidations=0;
  const source=createShowSource({mode:'apps-script',bridge:{async readShows(){reads++;return {rows};}}});
  const invalidate=source.invalidate.bind(source);source.invalidate=()=>{invalidations++;invalidate();};
  const {browser}=fixture({source});
  const server=http.createServer(async(req,res)=>{if(!await browser.handle(req,res)){res.writeHead(404);res.end();}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await source.load()).shows.length,1);
  rows=[header];
  assert.equal((await source.load()).shows.length,1);assert.equal(reads,1);
  const receipt=signed();
  const response=await fetch(url+ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(receipt),redirect:'error'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,invalidated:true});
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('location'),null);
  assert.equal((await source.load()).shows.length,0);assert.equal(reads,2);assert.equal(invalidations,1);
  const replay=await fetch(url+ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(receipt)});
  assert.equal(replay.status,403);assert.equal(invalidations,1);
});

test('missing or invalid configuration hides the internal endpoint; configured GET requires POST',async()=>{
  for(const secret of [undefined,'',123,'short']) {
    const value=fixture({secret:secret??''});
    for(const method of ['GET','POST'])assert.equal((await invoke(value.browser,signed(),{method})).status,404);
    assert.equal(value.invalidations,0);
  }
  const value=fixture(),result=await invoke(value.browser,signed(),{method:'GET'});
  assert.equal(result.status,405);assert.equal(result.headers.allow,'POST');assert.equal(value.invalidations,0);
  assert.equal((await invoke(value.browser,signed(),{url:ENDPOINT+'?redirect=https://example.com'})).handled,false);
});

test('signature authenticates exact timestamp and nonce; forged requests cannot consume a valid nonce',async()=>{
  const value=fixture(),receipt=signed();
  for(const input of [
    {...receipt,signature:'0'.repeat(64)},
    {...receipt,timestamp:'2026-10-09T12:00:01.000Z'},
    {...receipt,nonce:randomUUID()},
    signed(NOW,receipt.nonce,'another-secret-that-is-long-enough'),
  ])assert.equal((await invoke(value.browser,input)).status,403);
  assert.equal(value.invalidations,0);
  assert.equal((await invoke(value.browser,receipt)).status,200);
  const upper=signed(NOW,receipt.nonce.toUpperCase());
  assert.equal((await invoke(value.browser,upper)).status,403);
  assert.equal(value.invalidations,1);
});

test('timestamp window includes its exact boundaries and rejects past/future timeouts',async()=>{
  const value=fixture();
  for(const timestamp of ['2026-10-09T11:55:00.000Z','2026-10-09T12:05:00.000Z','2026-10-09T07:00:00-05:00'])assert.equal((await invoke(value.browser,signed(timestamp))).status,200);
  for(const timestamp of ['2026-10-09T11:54:59.999Z','2026-10-09T12:05:00.001Z'])assert.equal((await invoke(value.browser,signed(timestamp))).status,403);
  assert.equal(value.invalidations,3);
});

test('exact JSON schema rejects coercions, invalid calendars, credentials, and extra data',async()=>{
  const value=fixture(),receipt=signed();
  const cases=[null,[],{}, {...receipt,timestamp:Date.parse(NOW)},{...receipt,nonce:123},{...receipt,signature:123},
    {...receipt,nonce:'not-a-uuid'},{...receipt,nonce:'00000000-0000-0000-0000-000000000000'},
    {...receipt,signature:'abc'},{...receipt,signature:'g'.repeat(64)},
    {...receipt,timestamp:'2026-02-30T12:00:00.000Z'},{...receipt,timestamp:'2026-10-09'},
    {...receipt,timestamp:'2026-10-09T12:00:00+14:01'},
    {...receipt,secret:SECRET},{...receipt,rows:[]},
  ];
  for(const input of cases)assert.equal((await invoke(value.browser,input)).status,400);
  assert.equal((await invoke(value.browser,null,{raw:'{broken'})).status,400);
  assert.equal(value.invalidations,0);
});

test('body limit enforces bytes for declared and chunked JSON without cache changes',async()=>{
  const value=fixture(),receipt=signed();
  assert.equal((await invoke(value.browser,receipt,{headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await invoke(value.browser,receipt,{headers:{'content-length':'1025'}})).status,413);
  assert.equal((await invoke(value.browser,receipt,{chunks:[Buffer.alloc(700,32),Buffer.alloc(325,32)]})).status,413);
  const raw=JSON.stringify(receipt);const bytes=Buffer.byteLength(raw);
  assert.equal((await invoke(value.browser,receipt,{raw:raw+' '.repeat(1024-bytes)})).status,200);
  assert.equal(value.invalidations,1);
});

test('unfinished request bodies time out without invalidating the cache',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const value=fixture(),req=new PassThrough();req.method='POST';req.url=ENDPOINT;req.headers={'content-type':'application/json'};
  const res={destroyed:false,headersSent:false,writeHead(status){this.status=status;this.headersSent=true;},end(body){this.body=JSON.parse(body);}};
  const pending=value.browser.handle(req,res);
  req.write('{');t.mock.timers.tick(5000);
  assert.equal(await pending,true);assert.equal(res.status,408);assert.equal(value.invalidations,0);req.destroy();
});

test('replay guard remains bounded without evicting active nonces and expires safely',async()=>{
  let now=Date.parse(NOW);const value=fixture({clock:()=>new Date(now)}),first=signed();
  assert.equal((await invoke(value.browser,first)).status,200);
  for(let i=1;i<1000;i++)assert.equal((await invoke(value.browser,signed())).status,200);
  assert.equal((await invoke(value.browser,signed())).status,429);
  assert.equal((await invoke(value.browser,first)).status,403);assert.equal(value.invalidations,1000);
  now+=300001;
  assert.equal((await invoke(value.browser,signed(new Date(now).toISOString()))).status,200);
  assert.equal((await invoke(value.browser,first)).status,403);assert.equal(value.invalidations,1001);
});

test('future-dated nonce stays protected until its own signature expires',async()=>{
  let now=Date.parse(NOW);const value=fixture({clock:()=>new Date(now)}),receipt=signed('2026-10-09T12:05:00.000Z');
  assert.equal((await invoke(value.browser,receipt)).status,200);
  now+=300001;
  assert.equal((await invoke(value.browser,receipt)).status,403);assert.equal(value.invalidations,1);
});

test('concurrent copies of a signed request invoke invalidation only once',async()=>{
  let release,started,calls=0;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const value=fixture({source:{load:async()=>({shows:[]}),async invalidate(){calls++;started();await gate;}}}),receipt=signed();
  const first=invoke(value.browser,receipt);await entered;
  assert.equal((await invoke(value.browser,receipt)).status,403);assert.equal(calls,1);
  release();assert.equal((await first).status,200);assert.equal(calls,1);
});

test('failed invalidation is never acknowledged or repeated and never exposes internal errors',async()=>{
  let calls=0;const value=fixture({source:{load:async()=>({shows:[]}),invalidate(){calls++;throw Error(SECRET);}}}),receipt=signed();
  const result=await invoke(value.browser,receipt);
  assert.equal(result.status,503);assert.deepEqual(result.body,{error:'Cache invalidation is unavailable'});
  assert.equal((await invoke(value.browser,receipt)).status,403);assert.equal(calls,1);
  const missing=fixture({source:{load:async()=>({shows:[]})}});
  assert.equal((await invoke(missing.browser,signed())).status,503);
});
