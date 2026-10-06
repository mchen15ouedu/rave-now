import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { TimeZoneError } from '../src/timezones.mjs';
import { DemoLocationProvider } from '../src/locations.mjs';
import { parseShows } from '../src/shows.mjs';
import { buildSampleData } from '../scripts/generate-sample-data.mjs';

const sms='+15550102026', whatsapp=`whatsapp:${sms}`;
const fixedSample=buildSampleData('2026-10-05');
const sampleSource=()=>({load:async()=>({shows:parseShows(fixedSample.rows),snapshotUpdatedAt:fixedSample.metadata.updatedAt,sample:true,warnings:[]})});
function app(options={}) {
  return createApp({config:loadConfig({APP_MODE:'demo'}),store:new Store(':memory:'),source:sampleSource(),...options});
}

test('starting the live worker automatically runs due reminders and shuts down cleanly',async()=>{
  const demoConfig=loadConfig({APP_MODE:'demo'});
  let notify;const reached=new Promise(resolve=>notify=resolve);let sends=0;
  const instance=app({config:{...demoConfig,mode:'live'},source:sampleSource(),geocoder:new DemoLocationProvider(),sender:{send:async()=>{sends++;notify();return {sid:'local-test',status:'queued',outcome:'accepted'};}},reminderClock:()=>new Date('2026-10-06T03:00:00Z')});
  try {
    const user=instance.store.register(sms);
    instance.store.saveLocation(sms,{lat:32.78,lng:-96.8,label:'Dallas, TX'},'America/Chicago',user.revision);
    instance.startReminders();await reached;await instance.stopReminders();
    assert.equal(sends,1);assert.equal(instance.store.hasReminder(sms,'2026-10-05'),true);
    assert.equal(instance.store.db.prepare('SELECT status FROM reminder_deliveries').get().status,'accepted');
    assert.equal((await instance.runReminders(new Date('2026-10-06T03:05:00Z'))).accepted,0);
  } finally {await instance.stopReminders();instance.store.close();}
});

test('location searches persist the latest town and local zone across channels; FULL leaves it unchanged',async()=>{
  const instance=app();
  try {
    for (const from of [sms,whatsapp]) {
      const registered=await instance.bot.handle({from,body:'INFO'});
      assert.match(registered,/Daily weekend reminders.*10 PM/);
      assert.equal(instance.store.listReminderUsers().length,from===sms?0:1);
      const reply=await instance.handleOnce(`location-${from}`,{from,body:'Dallas TX'});
      assert.match(reply,/Saved location: Dallas, TX.*Daily weekend reminders around 10 PM local time \(America\/Chicago\)/);
      assert.match(reply,/Sample Dawn/);
      const saved=instance.store.get(from);
      assert.equal(saved.location_lat,32.78);assert.equal(saved.location_timezone,'America/Chicago');
      const full=await instance.bot.handle({from,body:'FULL'});
      assert.match(full,/[1-9]\d* upcoming shows/);assert.equal(instance.store.get(from).location_revision,saved.location_revision);
      const updated=await instance.bot.handle({from,body:'Las Vegas NV'});
      assert.match(updated,/America\/Los_Angeles/);
      assert.equal(instance.store.get(from).location_label,'Las Vegas, NV');
      assert.notEqual(instance.store.get(from).location_revision,saved.location_revision);
    }
    assert.equal(instance.store.listReminderUsers().length,2);
    const privacy=await instance.bot.handle({from:sms,body:'PRIVACY'});
    assert.match(privacy,/latest location coordinates/);assert.match(privacy,/STOP disables/);
  } finally {instance.store.close();}
});

test('WEEKEND uses saved location, paginates full details, and requires registration and a location',async()=>{
  const instance=app();
  try {
    assert.match(await instance.bot.handle({from:sms,body:'WEEKEND'}),/register/);
    await instance.bot.handle({from:sms,body:'INFO'});
    assert.match(await instance.bot.handle({from:sms,body:'WEEKEND'}),/location.*first/);
    await instance.bot.handle({from:sms,body:'Las Vegas NV'});
    const revision=instance.store.get(sms).location_revision;
    const weekend=await instance.bot.handle({from:sms,body:'weekend'});
    assert.match(weekend,/nearby weekend shows.*Las Vegas/s);assert.match(weekend,/Oct 9 - Oct 11/);
    assert.match(weekend,/Sample Prism/);assert.match(weekend,/Sample Orbit/);assert.doesNotMatch(weekend,/Sample Mirage/);
    assert.equal(instance.store.get(sms).location_revision,revision);
  } finally {instance.store.close();}
});

test('failed time-zone updates preserve the previous town; tracker outage still saves a valid location',async()=>{
  const instance=app();
  try {
    await instance.bot.handle({from:sms,body:'INFO'});await instance.bot.handle({from:sms,body:'Dallas TX'});
    const before=instance.store.get(sms);
    instance.bot.timezones={resolve:async()=>{throw new TimeZoneError('UNAVAILABLE','secret provider payload');}};
    assert.match(await instance.bot.handle({from:sms,body:'Las Vegas NV'}),/saved location was not changed/);
    assert.equal(instance.store.get(sms).location_revision,before.location_revision);
    instance.bot.timezones={resolve:async()=> 'America/Los_Angeles'};
    instance.bot.source={load:async()=>{throw new Error('private error');}};
    const reply=await instance.bot.handle({from:sms,body:'Las Vegas NV'});
    assert.match(reply,/Saved location: Las Vegas, NV/);assert.match(reply,/temporarily unavailable/);
    assert.equal(instance.store.get(sms).location_timezone,'America/Los_Angeles');
  } finally {instance.store.close();}
});

test('STOP or DELETE during a time-zone lookup prevents saved-location resurrection',async()=>{
  for(const command of ['STOP','DELETE']) {
    let release,reached;
    const wait=new Promise(resolve=>release=resolve), started=new Promise(resolve=>reached=resolve);
    const instance=app({timezones:{resolve:async()=>{reached();await wait;return 'America/Chicago';}}});
    try {
      await instance.bot.handle({from:sms,body:'INFO'});
      const search=instance.handleOnce('slow',{from:sms,body:'Dallas TX'});await started;
      await instance.handleOnce('cancel',{from:sms,body:command});release();
      assert.equal(await search,null);assert.equal(instance.store.listReminderUsers().length,0);
      assert.equal(instance.store.cached('slow'),undefined);
      if(command==='STOP')assert.equal(instance.store.get(sms).location_lat,null);
      else assert.equal(instance.store.get(sms),undefined);
    } finally {instance.store.close();}
  }
});

test('an older delayed location request cannot overwrite the latest town or return stale pages',async()=>{
  let release,reached;
  const wait=new Promise(resolve=>release=resolve), started=new Promise(resolve=>reached=resolve);
  const instance=app();
  const provider=instance.bot.geocoder;
  instance.bot.geocoder={resolve:async(query,options)=>{
    if(query==='Dallas TX' && options?.cache===false){reached();await wait;}
    return provider.resolve(query,options);
  }};
  try {
    await instance.bot.handle({from:sms,body:'INFO'});
    const old=instance.handleOnce('older-location',{from:sms,body:'Dallas TX'});await started;
    const latest=await instance.handleOnce('latest-location',{from:sms,body:'Las Vegas NV'});
    assert.match(latest,/Saved location: Las Vegas/);release();
    assert.equal(await old,null);assert.equal(instance.store.get(sms).location_label,'Las Vegas, NV');
    assert.equal(instance.store.cached('older-location'),undefined);
  } finally {instance.store.close();}
});

test('configured reminder hour is reflected in registration, help, and saved-location replies',async()=>{
  const instance=app({config:loadConfig({APP_MODE:'demo',REMINDER_HOUR:'21'})});
  try {
    assert.match(await instance.bot.handle({from:sms,body:'INFO'}),/around 9 PM/);
    assert.match(await instance.bot.handle({from:sms,body:'HELP'}),/around 9 PM/);
    assert.match(await instance.bot.handle({from:sms,body:'Dallas TX'}),/around 9 PM local time/);
  } finally {instance.store.close();}
});

test('local reminder preview generates the selected channel only; STOP and DELETE take effect',async t=>{
  const instance=app();instance.server.listen(0,'127.0.0.1');await once(instance.server,'listening');
  t.after(async()=>{await instance.stopReminders();await new Promise(resolve=>instance.server.close(resolve));instance.store.close();});
  const base=`http://127.0.0.1:${instance.server.address().port}`;
  const post=async(url,data)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await post('/api/demo/reminder',{channel:'sms'})).status,400);
  await post('/api/demo',{channel:'sms',body:'INFO'});await post('/api/demo',{channel:'sms',body:'Dallas TX'});
  const response=await post('/api/demo/reminder',{channel:'sms'});assert.equal(response.status,200);
  const preview=await response.json();assert.equal(preview.preview,true);assert.equal(preview.localTime,'22:00');
  assert.match(preview.reply,/Sample Circuit/);assert.match(preview.reply,/different town\? Send your location again/);
  assert.equal(instance.store.demoNotifications(sms).length,1);assert.equal(instance.store.demoNotifications(whatsapp).length,0);
  assert.equal(instance.store.hasReminder(sms,'2026-10-05'),false);
  const status=await (await fetch(base+'/api/demo/status?channel=sms')).json();
  assert.equal(status.location,'Dallas, TX');assert.equal(status.remindersEnabled,true);
  await post('/api/demo',{channel:'sms',body:'STOP'});
  assert.equal((await post('/api/demo/reminder',{channel:'sms'})).status,400);
  assert.equal(instance.store.get(sms).location_label,'Dallas, TX');
  await post('/api/demo',{channel:'sms',body:'DELETE'});
  assert.equal(instance.store.get(sms),undefined);assert.equal(instance.store.demoNotifications(sms).length,0);
});

test('legacy users migrate without scheduling until a location is supplied, and old completion cannot overwrite a new claim',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'show-finder-migration-'));
  const filename=path.join(directory,'users.sqlite');
  const db=new DatabaseSync(filename);
  db.exec(`CREATE TABLE users(address TEXT PRIMARY KEY,channel TEXT NOT NULL,phone TEXT NOT NULL,active INTEGER NOT NULL,registered_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  db.prepare('INSERT INTO users VALUES(?,?,?,1,?,?)').run(sms,'sms',sms,'2026-10-01','2026-10-01');db.close();
  const store=new Store(filename);
  try {
    assert.equal(store.listReminderUsers().length,0);assert.equal(store.get(sms).reminders_enabled,0);
    const user=store.register(sms);store.saveLocation(sms,{lat:32.78,lng:-96.8,label:'Dallas, TX'},'America/Chicago',user.revision);
    assert.equal(store.claimReminder(sms,'2026-10-05',user.revision,new Date()),true);
    store.forget(sms);const updated=store.register(sms);store.saveLocation(sms,{lat:32.78,lng:-96.8,label:'Dallas, TX'},'America/Chicago',updated.revision);
    assert.equal(store.claimReminder(sms,'2026-10-05',updated.revision,new Date()),true);
    store.completeReminder(sms,'2026-10-05','accepted','old-sid',null,user.revision);
    assert.equal(store.db.prepare('SELECT status FROM reminder_deliveries').get().status,'claimed');
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
