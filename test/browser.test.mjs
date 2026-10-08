import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHostedApp } from '../src/hosted.mjs';
import { CityLocationProvider } from '../src/city-locations.mjs';
import { parseShows } from '../src/shows.mjs';

const header=['Artist','Location','Address','City','Ticket Link','Show Time','YouTube (Most Popular Song)'];
const shows=parseShows([header,
 ['Address first','Dallas Venue','100 Example Street, Dallas, TX 75201','Austin, TX','https://example.com/tickets','Fri, Oct 9, 2026','https://youtu.be/example'],
 ['City fallback','TBA','','Los Angeles, CA','','Sun, Oct 11, 2026',''],
 ['Far future','Dallas Venue','','Dallas, TX','','Fri, Jan 1, 2027',''],
 ['Location unknown','TBA','','','','Sat, Oct 10, 2026',''],
 ['Past show','Old Venue','','Dallas, TX','','Sun, Oct 4, 2026',''],
]);
async function server(t,browser={}) {
 const app=createHostedApp({env:{PORT:'0'},browser:{clock:()=>'2026-10-05',source:{load:async()=>({shows,source:'snapshot'})},...browser}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 t.after(()=>new Promise(resolve=>app.server.close(resolve)));
 const url=`http://127.0.0.1:${app.server.address().port}`;
 const post=(input,headers={})=>fetch(url+'/api/browser/shows',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
 return {app,url,post};
}

test('browser returns tracker styles and categories on artist and grouped festival results', async t => {
 const styled = parseShows([[...header, 'Event', 'Style', 'Category'],
  ...Array.from({length:4},(_,i)=>['DJ '+i,'Festival grounds','','Dallas, TX','https://example.com/festival','2026-10-09','','Example Festival',i%2?'Techno':'House',i%2?'Daytime':'Festival']),
  ['Independent DJ','Club','','Dallas, TX','','2026-10-10','','','Trance','Nighttime'],
 ]);
 const {post}=await server(t,{source:{load:async()=>({shows:styled})}});
 const res=await post({view:'full',timeZone:'America/Chicago'}),data=await res.json();
 assert.equal(res.status,200);
 assert.deepEqual(data.shows.map(show=>[show.artist,show.style]),[['Example Festival','House, Techno'],['Independent DJ','Trance']]);
 assert.deepEqual(data.shows[0].categories,['Festival','Daytime']);
 assert.equal(data.shows[1].category,'Nighttime');
});

test('browser FULL needs no location, includes every future show, and creates no messaging user store',async t=>{
 const {app,url,post}=await server(t,{geocoder:{resolve(){throw new Error('Full must not geocode');}}});
 const res=await post({view:'full',timeZone:'America/Chicago'}),data=await res.json();
 assert.equal(res.status,200);assert.equal(data.total,4);assert.equal(data.shows[0].artist,'Address first');
 assert.deepEqual(data.shows.map(show=>show.date),['2026-10-09','2026-10-10','2026-10-11','2027-01-01']);
 assert.ok(data.shows.some(show=>show.artist==='Location unknown'));assert.equal(data.locationLabel,null);
 assert.equal(app.store,undefined);assert.equal(app.ready,false);assert.equal(data.source.snapshot,true);
 const page=await fetch(url);assert.match(page.headers.get('permissions-policy'),/geolocation=\(self\)/);
 assert.match(await page.text(),/Location or artist/);
 assert.equal((await fetch(url+'/browser/app.js')).status,200);
 const profiles=await fetch(url+'/browser/profiles.js');
 assert.equal(profiles.status,200);
 assert.match(profiles.headers.get('content-type'),/javascript/);
 assert.equal((await fetch(url+'/api/demo',{method:'POST'})).status,503);
});

test('device coordinates return the nearby feed without reverse geocoding or returning precise user coordinates',async t=>{
 const geo=new CityLocationProvider();
 const {post}=await server(t,{geocoder:{resolveCity(){throw new Error('GPS must not geocode the origin');},resolve:geo.resolve.bind(geo)}});
 const res=await post({view:'nearby',latitude:32.78,longitude:-96.8,timeZone:'America/Chicago'}),data=await res.json();
 assert.equal(res.status,200);assert.deepEqual(data.shows.map(show=>show.artist),['Address first']);
 assert.equal(data.windowStart,'2026-10-05');assert.equal(data.windowEnd,'2026-10-11');assert.equal(data.excludedCount,1);
 assert.ok(data.shows[0].distanceMiles<5);assert.equal(data.shows[0].locationSource,'address');assert.equal(data.shows[0].locationApproximate,true);
 assert.equal(data.locationLabel,'your current location');
 assert.equal(Object.hasOwn(data,'latitude'),false);assert.equal(Object.hasOwn(data,'longitude'),false);
});

test('manual city uses its local zone; weekend and City fallback share messaging selection rules',async t=>{
 const {post}=await server(t);
 const res=await post({view:'weekend',location:'Los Angeles CA',timeZone:'America/Chicago'}),data=await res.json();
 assert.equal(res.status,200);assert.equal(data.timeZone,'America/Los_Angeles');assert.equal(data.windowStart,'2026-10-09');assert.equal(data.windowEnd,'2026-10-11');
 assert.deepEqual(data.shows.map(show=>show.artist),['City fallback']);assert.equal(data.shows[0].locationSource,'city');assert.equal(data.shows[0].locationApproximate,true);
 assert.match(data.locationLabel,/Los Angeles/);
});

test('browser collapses a large matching festival after filtering and retains event links and dates',async t=>{
 const festivalShows=parseShows([[...header,'Event','Category'],
  ...Array.from({length:100},(_,i)=>['DJ '+i,'Festival grounds','','Dallas, TX','https://example.com/festival',i<50?'2026-10-09':'2026-10-10','https://youtu.be/artist'+i,'Example Festival','Festival']),
  ['Independent DJ','Other venue','','Dallas, TX','https://example.com/other','2026-10-11','','','Nighttime'],
 ]);
 const {post}=await server(t,{source:{load:async()=>({shows:festivalShows})},geocoder:{resolve:async()=>({lat:32.78,lng:-96.8,label:'Dallas',approximate:true})}});
 const res=await post({view:'nearby',latitude:32.78,longitude:-96.8,timeZone:'America/Chicago'}),data=await res.json();
 assert.equal(res.status,200);assert.equal(data.total,2);assert.equal(data.shows.length,2);
 const festival=data.shows[0];
 assert.equal(festival.type,'event');assert.equal(festival.event,'Example Festival');assert.equal(festival.artist,'Example Festival');
 assert.equal(festival.entryCount,100);assert.equal(festival.date,'2026-10-09');assert.equal(festival.dateEnd,'2026-10-10');
 assert.equal(festival.ticketUrl,'https://example.com/festival');
 assert.equal(new URL(festival.youtubeUrl).searchParams.get('search_query'),'Example Festival');
 assert.equal(data.shows[1].artist,'Independent DJ');
 assert.ok(festival.date<data.shows[1].date, 'A multi-day festival sorts by its upcoming start date');
});

test('festival category uses the event name even for fewer than four filtered performers',async t=>{
 const festivalShows=parseShows([[...header,'Event','Category'],
  ...Array.from({length:4},(_,i)=>['DJ '+i,'Festival grounds','','Dallas, TX','https://example.com/festival',i<3?'2026-10-11':'2026-10-12','','Example Festival','Festival']),
 ]);
 const {post}=await server(t,{source:{load:async()=>({shows:festivalShows})},geocoder:{resolve:async()=>({lat:32.78,lng:-96.8})}});
 const data=await (await post({view:'nearby',latitude:32.78,longitude:-96.8,timeZone:'America/Chicago'})).json();
 assert.equal(data.total,1);assert.equal(data.shows[0].type,'event');assert.equal(data.shows[0].entryCount,3);assert.equal(data.shows[0].artist,'Example Festival');assert.equal(data.shows[0].dateEnd,'2026-10-11');
 const full=await (await post({view:'full',timeZone:'America/Chicago'})).json();
 assert.equal(full.total,1);assert.equal(full.shows[0].entryCount,4);
});

test('browser validates input, method, origin, and size before loading the event source',async t=>{
 let loads=0;const {url,post}=await server(t,{source:{load:async()=>{loads++;return {shows};}}});
 for (const input of [{view:'unknown'},{view:'nearby'},{view:'nearby',latitude:91,longitude:0},{view:'nearby',latitude:1},{view:'nearby',latitude:'32',longitude:-96},{view:'nearby',location:'Dallas',latitude:32,longitude:-96},{view:'full',timeZone:'Bad/Zone'},null,[]]) assert.equal((await post(input)).status,400);
 assert.equal((await post({view:'full'},{Origin:'https://elsewhere.example'})).status,403);
 assert.equal((await fetch(url+'/api/browser/shows')).status,405);
 assert.equal((await post({view:'nearby',location:'x'.repeat(9000)})).status,413);
 assert.equal(loads,0);
});

test('source outage reports a sanitized failure instead of a partial or misleading empty feed',async t=>{
 const {post}=await server(t,{source:{load:async()=>{throw new Error('secret-provider-token and internal URL');}}});
 const res=await post({view:'full'}),data=await res.json();
 assert.equal(res.status,503);assert.match(data.error,/temporarily unavailable/);assert.doesNotMatch(JSON.stringify(data),/secret-provider|internal URL/);
});

test('city directory handles worldwide city/region names, US ZIPs, ambiguity, and unknown places offline',async()=>{
 const geo=new CityLocationProvider();
 assert.equal((await geo.resolveCity('Dallas, TX')).timeZone,'America/Chicago');
 assert.equal((await geo.resolveCity('London, United Kingdom')).timeZone,'Europe/London');
 assert.equal((await geo.resolveCity('Paris, France')).timeZone,'Europe/Paris');
 assert.match((await geo.resolveCity('75207')).label,/Dallas/);
 assert.equal((await geo.resolve('100 Example Street, Dallas, TX 75201')).approximate,true);
 assert.match((await geo.resolve('10001 Main St, Dallas, TX 75207')).label,/Dallas/);
 assert.match((await geo.resolve('10001 Main St, Dallas, TX')).label,/Dallas/);
 await assert.rejects(geo.resolveCity('Springfield'),error=>error.code==='AMBIGUOUS');
 await assert.rejects(geo.resolveCity('made-up Dallas TX'),error=>error.code==='NOT_FOUND');
 await assert.rejects(geo.resolveCity('New Jersey'),error=>error.code==='NOT_FOUND');
 const controller=new AbortController();controller.abort();await assert.rejects(geo.resolveCity('Dallas TX',{signal:controller.signal}),error=>error.name==='AbortError');
});


test('browser merges same-slot lineups after filtering and keeps other times and venues distinct', async t => {
  const grouped=parseShows([[...header,'Style','Category'],
    ['DJ One','Same Club','','Dallas, TX','https://example.com/one','Oct 9, 2026 - 8 PM','https://youtu.be/one','House','Nighttime'],
    ['DJ Two','Same Club','','Dallas, TX','https://example.com/two','Oct 9, 2026 - 20:00','https://youtu.be/two','Techno','Afters'],
    ['Later DJ','Same Club','','Dallas, TX','','Oct 9, 2026 - 11 PM','','Trance','Nighttime'],
    ['Other Club DJ','Other Club','','Dallas, TX','','Oct 9, 2026 - 8 PM','','House','Nighttime'],
  ]);
  const {post}=await server(t,{source:{load:async()=>({shows:grouped})},catalog:{load:async()=>({artists:['DJ One','DJ Two'],promoters:[]}),ensureArtist(){throw Error('Known artists must not be added');}}});
  const all=await (await post({view:'full'})).json();
  assert.equal(all.total,3);
  const merged=all.shows.find(show=>show.type==='show-group');
  assert.equal(merged.artist,'DJ One, DJ Two');assert.equal(merged.startTime,'20:00:00');
  assert.equal(merged.style,'House, Techno');assert.deepEqual(merged.categories,['Nighttime','Afters']);
  assert.deepEqual(merged.ticketLinks.map(link=>link.url),['https://example.com/one','https://example.com/two']);
  assert.deepEqual(merged.youtubeLinks.map(link=>link.url),['https://youtu.be/one','https://youtu.be/two']);
  assert.equal(all.shows.at(-1).artist,'Later DJ');
  const filtered=await (await post({view:'full',query:'artist: DJ Two'})).json();
  assert.equal(filtered.total,1);assert.equal(filtered.shows[0].artist,'DJ Two');
  assert.equal(filtered.shows[0].type,undefined,'Filtering does not expose the other merged performers');
});


test('browser keeps large regular lineups and uses a festival title for a single matching artist', async t => {
  const records=parseShows([[...header,'Event','Category'],
    ...Array.from({length:6},(_,i)=>['Regular DJ '+i,'Club','','Dallas, TX','https://example.com/club','Oct 9, 2026 - 8 PM','https://youtu.be/regular'+i,'Launch Night','Nighttime']),
    ['Festival DJ','Festival grounds','','Dallas, TX','https://example.com/festival','Oct 10, 2026 - 6 PM','https://youtu.be/performer','Sample Festival',' Festival '],
  ]);
  const {post}=await server(t,{source:{load:async()=>({shows:records})},catalog:{load:async()=>({artists:['Festival DJ'],promoters:[]})}});
  const all=await (await post({view:'full'})).json();
  assert.equal(all.total,2);
  assert.equal(all.shows[0].type,'show-group');assert.equal(all.shows[0].artist,Array.from({length:6},(_,i)=>'Regular DJ '+i).join(', '));
  assert.equal(all.shows[0].youtubeLinks.length,6);
  assert.equal(all.shows[1].type,'event');assert.equal(all.shows[1].artist,'Sample Festival');
  assert.equal(all.shows[1].youtubeLinks,undefined);assert.equal(all.shows[1].artists,undefined);
  assert.equal(new URL(all.shows[1].youtubeUrl).searchParams.get('search_query'),'Sample Festival');
  const filtered=await (await post({query:'Festival DJ'})).json();
  assert.equal(filtered.total,1);assert.equal(filtered.shows[0].artist,'Sample Festival');assert.equal(filtered.shows[0].entryCount,1);
  assert.equal(filtered.shows[0].ticketUrl,'https://example.com/festival');
});
