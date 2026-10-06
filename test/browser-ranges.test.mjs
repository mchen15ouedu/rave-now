import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {browserDateWindow} from '../src/browser-ranges.mjs';
import {createHostedApp} from '../src/hosted.mjs';
import {parseShows} from '../src/shows.mjs';
import {buildSampleData} from '../scripts/generate-sample-data.mjs';

test('browser ranges use local calendar dates, calendar month ends and three calendar months',()=>{
 const now='2026-10-06',zone='America/New_York';
 assert.deepEqual(browserDateWindow('today',now,zone),{start:now,end:now,days:1,label:'Today'});
 assert.deepEqual(browserDateWindow('nearby',now,zone),{start:now,end:'2026-10-12',days:7,label:'Next 7 days'});
 assert.deepEqual(browserDateWindow('weekend',now,zone),{start:'2026-10-09',end:'2026-10-11',days:3,label:'This weekend'});
 assert.deepEqual(browserDateWindow('month',now,zone),{start:now,end:'2026-10-31',days:26,label:'This month'});
 assert.deepEqual(browserDateWindow('three-months',now,zone),{start:now,end:'2027-01-05',days:92,label:'Next 3 months'});
 assert.equal(browserDateWindow('month','2028-02-28',zone).end,'2028-02-29');
 assert.equal(browserDateWindow('three-months','2027-01-31',zone).end,'2027-04-29');
 assert.equal(browserDateWindow('month','2026-12-31',zone).days,1);
});

test('weekend results never include earlier local days and UTC midnight does not change the local date',()=>{
 assert.deepEqual(browserDateWindow('weekend','2026-10-11','America/New_York'),{start:'2026-10-11',end:'2026-10-11',days:1,label:'This weekend'});
 const instant=new Date('2026-10-06T00:30:00Z');
 assert.equal(browserDateWindow('today',instant,'America/New_York').start,'2026-10-05');
 assert.equal(browserDateWindow('today',instant,'Asia/Tokyo').start,'2026-10-06');
 assert.throws(()=>browserDateWindow('never',instant,'America/Chicago'),/Unsupported/);
});

test('all browser date options filter local and location-free artist searches with inclusive boundaries and latest dates first',async t=>{
 const dates=['2026-10-05','2026-10-06','2026-10-09','2026-10-11','2026-10-12','2026-10-13','2026-10-31','2026-11-01','2027-01-05','2027-01-06'];
 const shows=parseShows([['Artist','Event','Location','Address','City','Ticket Link','Show Time','YouTube (Most Popular Song)'],...dates.map(date=>['DJ Test','','Venue','','New York, NY','https://tickets.example/event',date,'https://youtu.be/artist'])]);
 const app=createHostedApp({env:{PORT:'0'},browser:{clock:()=>'2026-10-06',source:{load:async()=>({shows})},catalog:{load:async()=>({artists:['DJ Test'],promoters:[]})},geocoder:{resolveCity:async()=>({lat:40.7,lng:-74,label:'New York',timeZone:'America/New_York'}),resolve:async()=>({lat:40.7,lng:-74})}}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>app.server.close(resolve)));
 const post=async input=>{const res=await fetch(`http://127.0.0.1:${app.server.address().port}/api/browser/shows`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(res.status,200);return res.json();};
 const expected={today:[1],nearby:[4,3,2,1],weekend:[3,2],month:[6,5,4,3,2,1],'three-months':[8,7,6,5,4,3,2,1]};
 for(const [view,indexes] of Object.entries(expected)) {
  const local=await post({query:'location: New York',view});assert.deepEqual(local.shows.map(show=>show.date),indexes.map(index=>dates[index]));
  const global=await post({query:'DJ Test',view,timeZone:'America/New_York'});assert.deepEqual(global.shows.map(show=>show.date),indexes.map(index=>dates[index]));assert.equal(global.locationLabel,null);
  assert.equal(global.rangeLabel,local.rangeLabel);
 }
});

test('fictional sample feed returns NYC and Brooklyn shows in the selected week and its anchor date',async()=>{
 const sample=buildSampleData('2026-10-05');
 const app=createHostedApp({env:{},browser:{clock:()=>'2026-10-06',source:{load:async()=>({shows:parseShows(sample.rows),snapshotUpdatedAt:sample.metadata.updatedAt,sample:true})}}});
 const result=await app.browserApp.search({query:'New York',timeZone:'America/Chicago'});
 assert.equal(result.windowStart,'2026-10-06');assert.equal(result.windowEnd,'2026-10-12');
 assert.deepEqual(result.shows.map(show=>show.artist),['Sample Pulse','Sample Metro','Sample Tidal']);
 assert.ok(result.shows.every(show=>show.distanceMiles<80));
 assert.ok(result.shows.some(show=>show.ticketUrl));
 assert.equal(result.source.updatedAt,'2026-10-05');
 const today=await app.browserApp.search({query:'New York',view:'today'});assert.equal(today.total,0);
 const month=await app.browserApp.search({query:'New York',view:'month'});assert.ok(month.total>result.total);
});
