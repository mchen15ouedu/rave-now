import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHostedApp} from '../src/hosted.mjs';
import {parseShows} from '../src/shows.mjs';
import {LocationError} from '../src/locations.mjs';

const headers=['Artist','Event','Location','City','Address','Ticket Link','Show Time','YouTube (Most Popular Song)'];
const row=(artist,date='2026-10-09',event='',city='Dallas, TX')=>[artist,event,'Venue',city,'','https://tickets.example/event',date,'https://youtu.be/artist'];
const records=parseShows([headers,row('Tiësto'),row('Other DJ'),row('Tiësto','2027-01-01'),row('Paris'),row('Steve Angello')]);
async function setup(t,{artists=['Tiësto','Paris'],shows=records,geocoder,ensureArtist,loadCatalog,loadSource,verifyArtist}={}) {
 const writes=[],verifications=[];
 const catalog={load:loadCatalog||(async()=>({artists,promoters:['SILO Dallas'],canAdd:true})),ensureArtist:ensureArtist||(async(name)=>{writes.push(name);artists.push(name);return{name,added:true};})};
 const verifier={verify:async(name,options)=>{verifications.push(name);return verifyArtist?verifyArtist(name,options):{status:'verified',name};}};
 const geo=geocoder||{resolveCity:async(query)=>{
  if(/^(Dallas(?:, TX)?|Paris, France)$/.test(query))return{lat:32.78,lng:-96.8,label:query,timeZone:'America/Chicago'};
  if(query==='Springfield')throw new LocationError('AMBIGUOUS','Add a state.');
  throw new LocationError('NOT_FOUND','Location not found.');
 },resolve:async()=>({lat:32.78,lng:-96.8})};
 const app=createHostedApp({env:{PORT:'0'},browser:{clock:()=>'2026-10-05',source:{load:loadSource||(async()=>({shows}))},catalog,verifier,geocoder:geo}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>app.server.close(resolve)));
 const url=`http://127.0.0.1:${app.server.address().port}`;
 const post=(input,extra={})=>fetch(url+'/api/browser/shows',{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify({view:'nearby',timeZone:'America/Chicago',...input})});
 return{url,post,writes,verifications,search:app.browserApp.search};
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

test('a verified new artist is added even if no upcoming shows match',async t=>{
 const {post,writes,verifications}=await setup(t);
 const result=await (await post({query:'New DJ'})).json();assert.equal(result.searchKind,'artist');assert.equal(result.total,0);
 assert.deepEqual(writes,['New DJ']);assert.deepEqual(result.artistRegistration,{name:'New DJ',added:true});
 assert.deepEqual(verifications,['New DJ']);
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

test('required event source loads before the optional catalog for one-box searches',async t=>{
 const calls=[];
 const {post}=await setup(t,{
  loadSource:async()=>{calls.push('source');return{shows:records};},
  loadCatalog:async()=>{calls.push('catalog');return{artists:['Tiësto'],promoters:[],canAdd:true};},
 });
 const response=await post({query:'Dallas'});
 assert.equal(response.status,200);
 assert.equal((await response.json()).searchKind,'location');
 assert.deepEqual(calls,['source','catalog']);
});

test('event source failure does not start a catalog request or expose provider details',async t=>{
 const calls=[];
 const {post,writes}=await setup(t,{
  loadSource:async()=>{calls.push('source');throw new Error('SECRET event provider failure');},
  loadCatalog:async()=>{calls.push('catalog');return{artists:[],promoters:[],canAdd:true};},
 });
 const response=await post({query:'Dallas'});
 assert.equal(response.status,503);
 const result=await response.json();
 assert.match(result.error,/show feed.*unavailable/i);
 assert.doesNotMatch(JSON.stringify(result),/SECRET/);
 assert.deepEqual(calls,['source']);assert.deepEqual(writes,[]);
});

test('optional catalog outage keeps resolvable cities and feed artist searches usable without writes',async t=>{
 const {post,writes}=await setup(t,{loadCatalog:async()=>{throw new Error('SECRET catalog failure');}});
 const cityResponse=await post({query:'Dallas'});assert.equal(cityResponse.status,200);
 const city=await cityResponse.json();assert.equal(city.searchKind,'location');assert.equal(city.locationLabel,'Dallas');assert.equal(city.total,4);
 const exactResponse=await post({query:'STEVE ANGELLO'});assert.equal(exactResponse.status,200);
 const exact=await exactResponse.json();assert.equal(exact.searchKind,'artist');assert.equal(exact.artistQuery,'Steve Angello');assert.equal(exact.shows.length,1);
 const partialResponse=await post({query:'angello'});assert.equal(partialResponse.status,200);
 const partial=await partialResponse.json();assert.equal(partial.searchKind,'artist');assert.equal(partial.shows.length,1);assert.equal(partial.shows[0].artist,'Steve Angello');
 // Feed artists retain their exact-match priority over a city-like name.
 const collision=await (await post({query:'Paris'})).json();assert.equal(collision.searchKind,'artist');assert.equal(collision.shows[0].artist,'Paris');
 assert.doesNotMatch(JSON.stringify([city,exact,partial,collision]),/SECRET/);assert.deepEqual(writes,[]);
});

test('ambiguous and clearly invalid town queries remain location errors during catalog outages',async t=>{
 const {post,writes}=await setup(t,{loadCatalog:async()=>{throw new Error('Catalog unavailable');}});
 const ambiguous=await post({query:'Springfield'});assert.equal(ambiguous.status,400);
 assert.match((await ambiguous.json()).error,/state/i);
 for(const query of ['99999','Unknown City, TX'])assert.equal((await post({query})).status,400,query);
 assert.deepEqual(writes,[]);
});

test('unknown automatic queries require explicit classification when the catalog is unavailable',async t=>{
 const {post,writes}=await setup(t,{loadCatalog:async()=>{throw new Error('SECRET catalog unavailable');}});
 const response=await post({query:'New DJ'});assert.equal(response.status,503);
 const result=await response.json();assert.match(result.error,/artist:/i);assert.match(result.error,/location:/i);
 assert.doesNotMatch(JSON.stringify(result),/SECRET/);assert.deepEqual(writes,[]);
});

test('explicit artist queries return feed results with honest unsaved status during catalog outages',async t=>{
 const {post,writes}=await setup(t,{loadCatalog:async()=>{throw new Error('Catalog unavailable');}});
 const response=await post({query:'artist: Steve Angello'});assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.searchKind,'artist');assert.equal(result.shows.length,1);assert.equal(result.shows[0].artist,'Steve Angello');
 assert.deepEqual(result.artistRegistration,{name:'Steve Angello',added:false,status:'not-saved'});
 const newResponse=await post({query:'artist: New DJ'});assert.equal(newResponse.status,200);
 const fresh=await newResponse.json();assert.equal(fresh.total,0);assert.equal(fresh.artistRegistration.added,false);assert.equal(fresh.artistRegistration.status,'not-saved');
 assert.deepEqual(writes,[]);
});

test('an explicit artist prefix does not bypass the promoter guard for new names',async t=>{
 const {post,writes}=await setup(t);
 const response=await post({query:'artist: SILO Dallas'});assert.equal(response.status,400);
 assert.match((await response.json()).error,/promoter/i);assert.deepEqual(writes,[]);
});

test('explicit locations and GPS searches do not depend on or call the artist catalog',async t=>{
 let catalogCalls=0;
 const {post,writes}=await setup(t,{loadCatalog:async()=>{catalogCalls++;throw new Error('Catalog should not be called');}});
 const locationResponse=await post({query:'location: Dallas',location:'Paris, France'});assert.equal(locationResponse.status,200);
 const location=await locationResponse.json();assert.equal(location.searchKind,'location');assert.equal(location.locationInput,'Dallas');
 const gpsResponse=await post({latitude:32.78,longitude:-96.8});assert.equal(gpsResponse.status,200);
 assert.equal((await gpsResponse.json()).total,4);
 assert.equal(catalogCalls,0);assert.deepEqual(writes,[]);
});

test('unverified names never reach a catalog write, including explicit artist entries',async t=>{
 const {post,writes,verifications}=await setup(t,{verifyArtist:async()=>({status:'unverified'})});
 for(const query of ['Made Up DJ','artist: Made Up DJ','Steve Angello']) {
  const response=await post({query});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.artistRegistration.status,'unverified');
  assert.equal(result.artistRegistration.added,false);
  assert.equal(result.total,query==='Steve Angello'?1:0);
 }
 assert.deepEqual(verifications,['Made Up DJ','Made Up DJ','Steve Angello']);assert.deepEqual(writes,[]);
});

test('verification failures leave both zero-event and usable artist searches available without writes',async t=>{
 for(const verifyArtist of [async()=>({status:'unavailable'}),async()=>{throw new Error('SECRET verification failure');}]) {
  const {post,writes}=await setup(t,{verifyArtist});
  for(const query of ['New DJ','Steve Angello']) {
   const response=await post({query});assert.equal(response.status,200);
   const result=await response.json();assert.equal(result.artistRegistration.status,'verification-unavailable');
   assert.equal(result.total,query==='Steve Angello'?1:0);assert.doesNotMatch(JSON.stringify(result),/SECRET/);
  }
  assert.deepEqual(writes,[]);
 }
});

test('existing artists and partial searches bypass both verification and additions even with no events',async t=>{
 const {post,writes,verifications}=await setup(t,{artists:['Existing DJ','Tiësto'],verifyArtist:async()=>{throw new Error('Must not verify');}});
 const existing=await (await post({query:'artist: EXISTING DJ'})).json();assert.equal(existing.total,0);assert.equal(existing.artistRegistration,null);
 const partial=await (await post({query:'angello'})).json();assert.equal(partial.shows.length,1);assert.equal(partial.artistRegistration,null);
 assert.deepEqual(writes,[]);assert.deepEqual(verifications,[]);
});

test('verified canonical spelling is saved once and later zero-event searches reuse the list',async t=>{
 const {post,writes,verifications}=await setup(t,{verifyArtist:async()=>({status:'verified',name:'Autechre'})});
 const first=await (await post({query:'autechre'})).json();assert.equal(first.total,0);
 assert.deepEqual(first.artistRegistration,{name:'Autechre',added:true});
 const second=await (await post({query:'AUTECHRE'})).json();assert.equal(second.total,0);assert.equal(second.artistRegistration,null);
 assert.deepEqual(writes,['Autechre']);assert.deepEqual(verifications,['autechre']);
});

test('a verification result for a different artist cannot authorize a write',async t=>{
 const {post,writes}=await setup(t,{verifyArtist:async()=>({status:'verified',name:'A different artist'})});
 const result=await (await post({query:'New DJ'})).json();assert.equal(result.artistRegistration.status,'unverified');assert.deepEqual(writes,[]);
});

test('cancellation during verification prevents a later addition',async t=>{
 let begin;const started=new Promise(resolve=>{begin=resolve;});
 let finish;const pending=new Promise(resolve=>{finish=resolve;});
 const {search,writes}=await setup(t,{verifyArtist:async()=>{begin();await pending;return{status:'verified',name:'New DJ'};}});
 const controller=new AbortController();
 const result=search({query:'New DJ',view:'nearby'},{signal:controller.signal});
 await started;controller.abort();await assert.rejects(result,{name:'AbortError'});
 finish();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(writes,[]);
});
