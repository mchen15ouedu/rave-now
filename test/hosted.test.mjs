import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHostedApp } from '../src/hosted.mjs';
import { Store } from '../src/store.mjs';
import { DemoLocationProvider } from '../src/locations.mjs';

const configured={PORT:'0',SPREADSHEET_ID:'example-workbook',TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'test-secret-never-public',GOOGLE_MAPS_API_KEY:'test-key-never-public',PUBLIC_WEBHOOK_URL:'https://example.hf.space/webhooks/twilio',REMINDERS_ENABLED:'false'};
async function listening(t,app) {
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.stopReminders();await new Promise(resolve=>app.server.close(resolve));app.store?.close();});
  return `http://127.0.0.1:${app.server.address().port}`;
}

test('browser discovery stays independent of deliberate messaging activation, even with credentials',async t=>{
  const app=createHostedApp({env:{...configured,APP_MODE:'demo'}});
  const url=await listening(t,app);
  assert.equal(app.ready,false);assert.equal(app.store,undefined);
  assert.deepEqual(await (await fetch(url+'/healthz')).json(),{ok:true,mode:'browser',browserReady:true,messagingReady:false,ready:false});
  const page=await (await fetch(url)).text();
  assert.match(page,/Location or artist/);assert.doesNotMatch(page,/test-secret|test-key|TWILIO_AUTH/);
  for (const route of ['/webhooks/twilio','/api/demo','/api/demo/reminder']) {
    const res=await fetch(url+route,{method:'POST',body:'Body=INFO'});
    assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:'Messaging setup is pending'});
  }
});

test('incomplete or invalid live configuration serves setup without exposing the failure',async t=>{
  const app=createHostedApp({env:{HOSTED_SERVICE_ENABLED:'true',PORT:'0',TWILIO_AUTH_TOKEN:'test-secret-never-public',TIME_ZONE:'invalid-secret-value'}});
  const url=await listening(t,app);
  assert.equal(app.ready,false);
  const page=await (await fetch(url)).text();
  assert.doesNotMatch(page,/test-secret|invalid-secret|TIME_ZONE/);
  assert.equal((await fetch(url+'/healthz')).status,200);
});

test('activated hosted app always enforces signed live webhooks and hides demo routes',async t=>{
  const store=new Store(':memory:');
  const app=createHostedApp({env:{...configured,HOSTED_SERVICE_ENABLED:'true',APP_MODE:'demo'},store,source:{load:async()=>({shows:[]})},geocoder:new DemoLocationProvider(),sender:{send:async()=>{throw new Error('No real delivery in test');}}});
  const url=await listening(t,app);
  assert.equal(app.ready,true);assert.equal(app.config.mode,'live');
  assert.match(await (await fetch(url)).text(),/Location or artist/);
  const webhook=await fetch(url+'/webhooks/twilio',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'Body=INFO'});
  assert.equal(webhook.status,403);assert.equal(store.counts().registered,0);
  assert.equal((await fetch(url+'/api/demo',{method:'POST'})).status,404);
});
