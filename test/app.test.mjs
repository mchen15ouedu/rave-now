import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import twilio from 'twilio';
import { createApp } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { DemoLocationProvider } from '../src/locations.mjs';
import { createShowSource } from '../src/providers.mjs';
import { parseShows } from '../src/shows.mjs';
import { buildSampleData } from '../scripts/generate-sample-data.mjs';

const fixedSample = buildSampleData('2026-10-05');
const sampleSource = () => ({load:async()=>({shows:parseShows(fixedSample.rows),snapshotUpdatedAt:fixedSample.metadata.updatedAt,sample:true,warnings:[]})});

function appForTest(mode='demo',overrides={}){
  const env={ APP_MODE:mode,HOST:'127.0.0.1',PORT:'0',SPREADSHEET_ID:'test-sheet',SHEET_ID:'1',TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'test-auth-token',PUBLIC_WEBHOOK_URL:'https://show-finder.example/webhooks/twilio',GOOGLE_MAPS_API_KEY:'test-no-requests',TWILIO_SMS_FROM:'+15550000000',TWILIO_WHATSAPP_FROM:'whatsapp:+15550000000',WHATSAPP_REMINDER_CONTENT_SID:'HX'+'a'.repeat(32) };
  const config=loadConfig(env);
  return createApp({config,store:new Store(':memory:'),source:sampleSource(),geocoder:new DemoLocationProvider(),timezones:{resolve:async point=>point.lng<-110?'America/Los_Angeles':'America/Chicago'},clock:()=>'2026-10-05',...overrides});
}
async function listening(t,app){
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{ await new Promise(resolve=>app.server.close(resolve));app.store.close(); });
  return `http://127.0.0.1:${app.server.address().port}`;
}
const sender='whatsapp:+15550102026';

test('registration, fictional Dallas/Las Vegas/Los Angeles sample matches, STOP, restart and erasure',async()=>{
  const app=appForTest();
  try{
    assert.match(await app.bot.handle({from:sender,body:'Dallas TX'}),/register/);
    assert.equal(app.store.counts().registered,0);
    assert.match(await app.handleOnce('demo-register',{from:sender,body:'info'}),/saved your WhatsApp number/);
    assert.equal(app.store.get(sender).phone,'+15550102026');
    const dallas=await app.handleOnce('demo-search',{from:sender,body:'Dallas TX'});
    assert.match(dallas,/Sample Daybreak Festival/);assert.match(dallas,/Oct 5 - Oct 11/);assert.doesNotMatch(dallas,/Sample Mirage|Sample Horizon/);
    const vegas=await app.bot.handle({from:sender,body:'Las Vegas NV'});
    for(const artist of ['Sample Mirage','Sample Prism','Sample Orbit'])assert.ok(vegas.includes(artist));
    const losAngeles=await app.bot.handle({from:sender,body:'Los Angeles CA'});
    assert.match(losAngeles,/Sample Aurora/);
    assert.match(losAngeles,/Los Angeles \(city approximation\)/);
    assert.doesNotMatch(losAngeles,/Sample Daybreak Festival|Sample Mirage/);
    assert.match(await app.bot.handle({from:sender,body:'STOP'}),/unsubscribed/);
    assert.equal(app.store.get(sender).active,0);
    assert.match(await app.bot.handle({from:sender,body:'Dallas TX'}),/register again/);
    await app.bot.handle({from:sender,body:'START'});
    assert.equal(app.store.get(sender).active,1);
    assert.match(await app.handleOnce('demo-delete',{from:sender,body:'DELETE'}),/deleted/);
    assert.equal(app.store.counts().registered,0);assert.equal(app.store.cached('demo-search').address,'');assert.equal(app.store.cached('demo-search').reply,'');assert.equal(app.store.cached('demo-delete').address,'');
  }finally{app.store.close();}
});

test('SMS and WhatsApp replies label City fallback and preserve Address priority and unknown venue text',async()=>{
  const header=['Artist','Location','Address','City','Ticket Link','Show Time','YouTube (Most Popular Song)'];
  const shows=parseShows([
    header,
    ['City fallback','TBA','TBA','Dallas, TX','https://example.com/city','Fri, Oct 9, 2026',''],
    ['Address priority','Example Venue','100 Example Street, Dallas, TX 75201','Austin, TX','https://example.com/address','Fri, Oct 9, 2026',''],
  ]);
  for(const from of [sender,'+15550102026']){
    const app=appForTest('demo',{source:{load:async()=>({shows})}});
    try{
      await app.bot.handle({from,body:'INFO'});
      const reply=await app.bot.handle({from,body:'Dallas TX'});
      assert.match(reply,/2 nearby shows/);
      assert.match(reply,/City fallback\nFri, Oct 9, 2026 \| TBA\nDallas, TX \(city approximation\)\nApprox\. \d+ straight-line miles/);
      assert.match(reply,/Address priority/);
      assert.match(reply,/100 Example Street, Dallas, TX 75201/);
      assert.doesNotMatch(reply,/Austin, TX \(city approximation\)|\nTBA\nApprox/);
      assert.ok(reply.length<=1600);
    }finally{app.store.close();}
  }
});

test('duplicates return one cached response, channel registrations stay distinct',async()=>{
  const app=appForTest();
  try{
    const input={from:sender,body:'INFO'};
    const [a,b]=await Promise.all([app.handleOnce('same-sid',input),app.handleOnce('same-sid',input)]);
    assert.equal(a,b);assert.equal(app.store.counts().registered,1);
    assert.equal(await app.handleOnce('same-sid',input),a);
    await assert.rejects(app.handleOnce('same-sid',{from:'+15550102026',body:'INFO'}),/identity/);
    await app.bot.handle({from:'+15550102026',body:'SHOWS'});
    assert.equal(app.store.counts().registered,2);
  }finally{app.store.close();}
});

test('STOP suppresses historical replies; DELETE prevents delayed registration retries',async()=>{
  const app=appForTest();
  try{
    const input={from:sender,body:'INFO'};
    await app.handleOnce('register-old',input);
    await app.handleOnce('search-old',{from:sender,body:'Dallas TX'});
    await app.handleOnce('stop-now',{from:sender,body:'STOP'});
    assert.equal(await app.handleOnce('register-old',input),null);
    assert.equal(await app.handleOnce('search-old',{from:sender,body:'Dallas TX'}),null);
    assert.equal(app.store.get(sender).active,0);
    await app.handleOnce('delete-now',{from:sender,body:'DELETE'});
    assert.equal(await app.handleOnce('register-old',input),null);
    assert.equal(app.store.counts().registered,0);
  }finally{app.store.close();}
});

test('a concurrent STOP or DELETE cannot recreate search pages or phone receipts',async()=>{
  for(const command of ['STOP','DELETE']){
    let release,loaded;
    const reached=new Promise(resolve=>loaded=resolve);
    const wait=new Promise(resolve=>release=resolve);
    const config=loadConfig({APP_MODE:'demo'});
    const real=createShowSource(config);
    const app=appForTest('demo',{source:{load:async options=>{loaded();await wait;return real.load(options);}}});
    try{
      await app.handleOnce('registration',{from:sender,body:'INFO'});
      const search=app.handleOnce('slow-search',{from:sender,body:'Dallas TX'});
      await reached;
      await app.handleOnce('cancel-search',{from:sender,body:command});
      release();
      assert.equal(await search,null);
      assert.equal(app.bot.pages.size,0);assert.equal(app.store.cached('slow-search'),undefined);
      if(command==='DELETE')assert.equal(app.store.counts().registered,0);
      else assert.equal(app.store.get(sender).active,0);
    }finally{app.store.close();}
  }
});

test('WhatsApp pins work; malformed pins and unsupported demo cities get helpful responses',async()=>{
  const app=appForTest();
  try{
    await app.bot.handle({from:sender,body:'INFO'});
    const reply=await app.bot.handle({from:sender,body:'',latitude:'32.78',longitude:'-96.8'});
    assert.match(reply,/Sample Daybreak Festival/);assert.match(reply,/your shared location/);
    assert.match(await app.bot.handle({from:sender,body:'',latitude:'',longitude:'-96.8'}),/invalid/);
    assert.match(await app.bot.handle({from:sender,body:'London'}),/offline demo supports/);
  }finally{app.store.close();}
});

test('HELP and PRIVACY do not register and provider failures do not masquerade as no results',async()=>{
  const app=appForTest('demo',{source:{load:async()=>{throw new Error('private credentials should not leak');}}});
  try{
    assert.match(await app.bot.handle({from:sender,body:'HELP'}),/city and state/);
    assert.match(await app.bot.handle({from:sender,body:'PRIVACY'}),/24 hours/);
    assert.equal(app.store.counts().registered,0);
    await app.bot.handle({from:sender,body:'INFO'});
    const reply=await app.bot.handle({from:sender,body:'Dallas TX'});
    assert.match(reply,/temporarily unavailable/);assert.doesNotMatch(reply,/private credentials|No nearby shows/);
  }finally{app.store.close();}
});

test('long result lists paginate within Twilio body limit and expire on STOP',async()=>{
  const header=['Artist','Location','Address','Ticket Link','Show Time','YouTube (Most Popular Song)'];
  const shows=parseShows([header,...Array.from({length:12},(_,i)=>[`Artist ${i}`,'SILO Dallas','100 Example Street, Dallas, TX 75201',`https://example.com/tickets/${'a'.repeat(200)}?artist=${i}`,'Fri, Oct 9, 2026',''])]);
  const app=appForTest('demo',{source:{load:async()=>({shows})}});
  try{
    await app.bot.handle({from:sender,body:'INFO'});
    let reply=await app.bot.handle({from:sender,body:'Dallas TX'});
    let pages=1;const visited=new Set();
    while(true){
      assert.ok(reply.length<=1600);
      for(const match of reply.matchAll(/Artist (\d+)\n/g))visited.add(Number(match[1]));
      if(!reply.includes('Reply MORE'))break;
      reply=await app.bot.handle({from:sender,body:'MORE'});pages++;
      assert.ok(pages<10);
    }
    assert.equal(visited.size,12);assert.ok(pages>1);
    await app.bot.handle({from:sender,body:'STOP'});assert.equal(app.bot.pages.size,0);
  }finally{app.store.close();}
});

test('live webhook rejects unsigned messages and simulator paths, accepts signed SMS and WhatsApp',async t=>{
  const app=appForTest('live');const base=await listening(t,app);
  const input={ AccountSid:app.bot.config.twilioAccountSid,MessageSid:'SM'+'1'.repeat(32),From:sender,To:'whatsapp:+15550000000',Body:'INFO' };
  const request=async(params,signature)=>fetch(base+'/webhooks/twilio',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature},body:new URLSearchParams(params)});
  let response=await request(input,'bad');assert.equal(response.status,403);assert.equal(app.store.counts().registered,0);
  const sign=params=>twilio.getExpectedTwilioSignature(app.bot.config.twilioAuthToken,app.bot.config.publicWebhookUrl,params);
  response=await request(input,sign(input));assert.equal(response.status,200);assert.match(await response.text(),/saved your WhatsApp number/);
  const stop={...input,MessageSid:'SM'+'2'.repeat(32),Body:'STOP',OptOutType:'STOP'};
  response=await request(stop,sign(stop));assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/<Message>/);assert.equal(app.store.get(sender).active,0);
  const start={...input,MessageSid:'SM'+'3'.repeat(32),Body:'START',OptOutType:'START'};
  response=await request(start,sign(start));assert.doesNotMatch(await response.text(),/<Message>/);assert.equal(app.store.get(sender).active,1);
  const pin={...input,MessageSid:'MM'+'4'.repeat(32),Body:'',Latitude:'32.78',Longitude:'-96.8'};
  response=await request(pin,sign(pin));assert.match(await response.text(),/Sample Daybreak Festival/);
  const sms={...input,MessageSid:'SM'+'5'.repeat(32),From:'+15550102026',To:'+15550000000',Body:'SHOWS'};
  response=await request(sms,sign(sms));assert.match(await response.text(),/saved your SMS number/);
  const full={...sms,MessageSid:'SM'+'6'.repeat(32),Body:' full '};
  response=await request(full,sign(full));assert.equal(response.status,200);
  const fullReply=await response.text();assert.match(fullReply,/[1-9]\d* upcoming shows/);assert.match(fullReply,/All locations/);assert.doesNotMatch(fullReply,/straight-line/);
  assert.equal((await fetch(base+'/')).status,404);assert.equal((await fetch(base+'/api/demo/status')).status,404);
});

test('demo endpoints reject cross-origin and non-JSON writes; live mode requires configuration',async t=>{
  assert.throws(()=>loadConfig({APP_MODE:'demo',HOST:'0.0.0.0'}),/localhost/);
  assert.throws(()=>loadConfig({APP_MODE:'live'}),/required/);
  const app=appForTest();const base=await listening(t,app);
  let response=await fetch(base+'/api/demo',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({channel:'sms',body:'INFO'})});
  assert.equal(response.status,403);assert.equal(app.store.counts().registered,0);
  response=await fetch(base+'/api/demo',{method:'POST',headers:{'Content-Type':'text/plain'},body:'INFO'});assert.equal(response.status,415);
  response=await fetch(base+'/api/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:'sms',body:'INFO'})});assert.equal(response.status,200);
  const reply=await response.json();assert.match(reply.reply,/SMS/);assert.equal(reply.counts.registered,1);
});
