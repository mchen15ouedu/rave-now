import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHostedApp} from '../src/hosted.mjs';
import {parseShows} from '../src/shows.mjs';
import {LocationError} from '../src/locations.mjs';

const headers=['Artist','Event','Location','City','Address','Ticket Link','Show Time','YouTube (Most Popular Song)'];
const row=(artist,date='2026-10-09',event='',city='Dallas, TX')=>[artist,event,'Venue',city,'','https://tickets.example/event',date,'https://youtu.be/artist'];
const records=parseShows([headers,row('Tiësto'),row('Other DJ'),row('Tiësto','2027-01-01'),row('Paris'),row('Steve Angello')]);
async function setup(t,{artists=['Tiësto','Paris'],shows=records,geocoder,ensureArtist,loadCatalog}={}) {
 const writes=[];
 const catalog={load:loadCatalog||(async()=>({artists,promoters:['SILO Dallas'],canAdd:true})),ensureArtist:ensureArtist||(async(name)=>{writes.push(name);return{name,added:true};})};
 const geo=geocoder||{resolveCity:async(query)=>{
  if(/^(Dallas(?:, TX)?|Paris, France)$/.test(query))return{lat:32.78,lng:-96.8,label:query,timeZone:'America/Chicago'};
  if(query==='Springfield')throw new LocationError('AMBIGUOUS','Add a state.');
  throw new LocationError('NOT_FOUND','Location not found.');
 },resolve:async()=>({lat:32.78,lng:-96.8})};
 const app=createHostedApp({env:{PORT:'0'},browser:{clock:()=>'2026-10-05',source:{load:async()=>({shows})},catalog,geocoder:geo}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>app.server.close(resolve)));
 const url=`http://127.0.0.1:${app.server.address().port}`;
 const post=(input,extra={})=>fetch(url+'/api/browser/shows',{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify({view:'nearby',timeZone:'America/Chicago',...input})});
 return{url,post,writes};
}

test('one-box known artist filtering keeps nearby seven-day scope and supports accent variants',async t=>{
 const {post,writes}=await setup(t);
 const result=await (await post({query:'TIESTO',latitude:32.78,longitude:-96.8})).json();
 assert.equal(result.searchKind,'artist');assert.equal(result.artistQuery,'Tiësto');assert.equal(result.shows.length,1);
 assert.equal(result.shows[0].artist,'Tiësto');assert.equal(result.view,'nearby');assert.equal(result.windowEnd,'2026-10-11');assert.deepEqual(writes,[]);
 assert.equal(result.shows[0].ticketUrl,'https://tickets.example/event');
});

test('artist searches without a location obey the selected date window across locations',async t=>{
 const {post}=await setup(t);
 const result=await (await post({query:'Tiësto'})).json();
 assert.equal(result.view,'nearby');assert.equal(result.shows.length,1);assert.equal(result.locationLabel,null);assert.equal(result.windowEnd,'2026-10-11');
 const full=await (await post({query:'Tiësto',view:'full'})).json();assert.equal(full.shows.length,2);assert.equal(full.windowEnd,null);
});

test('exact catalog artists take priority even when names resemble a location',async t=>{
 const {post,writes}=await setup(t,{artists:['999999999','Ocean Drive','Artist CO','DJ, Friends']});
 for(const query of ['999999999','Ocean Drive','Artist CO','DJ, Friends']) {
  const response=await post({query});assert.equal(response.status,200,query);
  assert.equal((await response.json()).searchKind,'artist');
 }
 assert.deepEqual(writes,[]);
});

test('locations replace a carried origin; catalog artist/city collisions allow explicit location entry',async t=>{
 const {post}=await setup(t);
 const artist=await (await post({query:'Paris'})).json();assert.equal(artist.searchKind,'artist');
 const city=await (await post({query:'location: Paris, France',location:'Dallas, TX'})).json();
 assert.equal(city.searchKind,'location');assert.equal(city.locationInput,'Paris, France');assert.equal(city.locationLabel,'Paris, France');
});

test('a show artist absent from Artist List gets added, but partial queries do not create artist names',async t=>{
 const {post,writes}=await setup(t);
 const result=await (await post({query:'Steve Angello'})).json();assert.equal(result.artistRegistration.added,true);assert.deepEqual(writes,['Steve Angello']);
 const partial=await (await post({query:'angello'})).json();assert.equal(partial.searchKind,'artist');assert.equal(partial.shows.length,1);assert.equal(writes.length,1);
});

test('a genuinely new artist is added even if no upcoming shows match',async t=>{
 const {post,writes}=await setup(t);
 const result=await (await post({query:'New DJ'})).json();assert.equal(result.searchKind,'artist');assert.equal(result.total,0);
 assert.deepEqual(writes,['New DJ']);assert.deepEqual(result.artistRegistration,{name:'New DJ',added:true});
});

test('promoters, ambiguous cities, ZIP errors, invalid input, cross-origin requests and outages never add artists',async t=>{
 const {post,writes}=await setup(t);
 for(const query of ['SILO Dallas','Springfield','99999','Unknown City, TX','artist:','DJ\nInjected'])assert.equal((await post({query})).status,400,query);
 assert.equal((await post({query:'New DJ',latitude:91,longitude:0})).status,400);
 assert.equal((await post({query:'New DJ'},{Origin:'https://other.example'})).status,403);assert.deepEqual(writes,[]);
 const outage=await setup(t,{geocoder:{resolveCity:async()=>{throw new LocationError('UNAVAILABLE','Provider down.');},resolve:async()=>({lat:0,lng:0})}});
 assert.equal((await outage.post({query:'New DJ'})).status,503);assert.deepEqual(outage.writes,[]);
});

test('failed artist registration remains honest without hiding usable show results',async t=>{
 const {post}=await setup(t,{ensureArtist:async()=>{throw new Error('SECRET provider failure');}});
 const result=await (await post({query:'Steve Angello'})).json();assert.equal(result.shows.length,1);assert.equal(result.artistRegistration.status,'not-saved');
 assert.doesNotMatch(JSON.stringify(result),/SECRET/);assert.equal(result.artistRegistration.added,false);
});

test('artist filtering precedes festival grouping and retains event context',async t=>{
 const shows=parseShows([headers,...Array.from({length:100},(_,i)=>row('DJ '+i,'2026-10-09','Big Festival'))]);
 const {post}=await setup(t,{shows,artists:['DJ 99']});
 const result=await (await post({query:'DJ 99',location:'Dallas, TX'})).json();
 assert.equal(result.shows.length,1);assert.equal(result.shows[0].artist,'DJ 99');assert.equal(result.shows[0].event,'Big Festival');assert.notEqual(result.shows[0].type,'event');
});

test('native suggestion endpoint exposes only artist names',async t=>{
 const {url}=await setup(t);const result=await (await fetch(url+'/api/browser/artists')).json();assert.deepEqual(result,{artists:['Tiësto','Paris']});
});
