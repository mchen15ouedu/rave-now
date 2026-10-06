import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

class Element {
 constructor(){this.children=[];this.handlers={};this.classList={toggle(){}};this.value='';this.textContent='';this.attributes={};}
 addEventListener(name,callback){this.handlers[name]=callback;}
 setAttribute(name,value){this.attributes[name]=value;}
 focus(){this.focused=true;}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=(data)=>({ok:true,json:async()=>data});
async function page({geolocation=true,fetchResult,artists=[]}={}) {
 const nodes=new Map(),calls=[],geo={requests:[]},events={};
 const context={
  document:{
   getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},
   createElement(tag){return Object.assign(new Element(),{tag});},
  },
  navigator:geolocation?{geolocation:{getCurrentPosition(success,failure,options){geo.requests.push({success,failure,options});}}}:{},
  window:{addEventListener(name,callback){events[name]=callback;}},
  Intl,Date,URL,AbortController,console,
  fetch:async(url,options)=>{
   if(url==='/api/browser/artists')return response({artists});
   const call={url,options,payload:JSON.parse(options.body)};calls.push(call);
   return fetchResult?fetchResult(call):response({shows:[],days:7,searchKind:'location',locationInput:call.payload.query,locationLabel:call.payload.query||call.payload.location||'your current location'});
  },
 };
 vm.runInNewContext(await readFile(new URL('../public/browser/app.js',import.meta.url),'utf8'),context);
 await tick();return {nodes,calls,geo,events};
}
function submit(nodes,location) {
 nodes.get('city').value=location;
 nodes.get('location-form').handlers.submit({preventDefault(){}});
}
function selectRange(nodes,range) {nodes.get('range-'+range).handlers.click();}
function descendants(node) {return [node,...node.children.flatMap(descendants)];}

test('opening requests a fresh location immediately and waits for it before a nearby POST search',async()=>{
 const {calls,geo}=await page();
 assert.equal(geo.requests.length,1);assert.equal(geo.requests[0].options.maximumAge,0);assert.equal(calls.length,0);
 geo.requests[0].success({coords:{latitude:32.78,longitude:-96.8}});await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/browser/shows');assert.equal(calls[0].options.method,'POST');
 assert.equal(calls[0].payload.view,'nearby');assert.equal(calls[0].payload.latitude,32.78);assert.equal(calls[0].payload.longitude,-96.8);
});

test('permission denial and unavailable GPS both leave manual search usable',async()=>{
 for(const geolocation of [true,false]) {
  const {nodes,calls,geo}=await page({geolocation});
  if(geolocation)geo.requests[0].failure({code:1});
  assert.match(nodes.get('location-status').textContent,/Enter a city/);
  submit(nodes,'Dallas TX');await tick();
  assert.equal(calls.length,1);assert.equal(calls[0].payload.query,'Dallas TX');assert.equal(calls[0].payload.latitude,undefined);
 }
});

test('manual submission wins over late GPS success and failure',async()=>{
 const {nodes,calls,geo}=await page();
 submit(nodes,'Dallas TX');await tick();
 const before=nodes.get('location-status').textContent;
 geo.requests[0].success({coords:{latitude:36.17,longitude:-115.14}});
 geo.requests[0].failure({code:1});await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].payload.query,'Dallas TX');
 assert.equal(nodes.get('location-status').textContent,before);assert.equal(nodes.get('city').value,'Dallas TX');
});

test('typing a location prevents automatic GPS from replacing the manual entry',async()=>{
 const {nodes,calls,geo}=await page();
 nodes.get('city').value='Los Angeles CA';nodes.get('city').handlers.input();
 geo.requests[0].success({coords:{latitude:32.78,longitude:-96.8}});await tick();
 assert.equal(calls.length,0);assert.equal(nodes.get('city').value,'Los Angeles CA');
 submit(nodes,'Los Angeles CA');await tick();assert.equal(calls[0].payload.query,'Los Angeles CA');
});

test('an older search response cannot overwrite results for a newer location',async()=>{
 const pending=[];
 const {nodes,calls}=await page({fetchResult:()=>new Promise(resolve=>pending.push(resolve))});
 submit(nodes,'Dallas TX');submit(nodes,'Las Vegas NV');
 assert.equal(calls[0].options.signal.aborted,true);
 pending[1](response({shows:[{artist:'New result',date:'2026-10-09'}],locationLabel:'Las Vegas, NV',days:7}));await tick();
 pending[0](response({shows:[{artist:'Old result',date:'2026-10-09'}],locationLabel:'Dallas, TX',days:7}));await tick();
 assert.equal(nodes.get('show-grid').children.length,1);
 assert.equal(nodes.get('show-grid').children[0].children[0].textContent,'New result');
 assert.match(nodes.get('location-status').textContent,/Las Vegas/);
});

test('the complete list includes safe ticket and YouTube links',async()=>{
 const shows=Array.from({length:30},(_,i)=>({artist:i===0?'<img src=x onerror=alert(1)>':'DJ '+i,date:'2026-10-09',venue:'Venue',city:'Dallas',ticketUrl:'https://tickets.example/show/'+i,youtubeUrl:'https://www.youtube.com/watch?v=example'+i}));
 shows.push({artist:'Unsafe links',date:'2026-10-09',ticketUrl:'javascript:alert(1)',youtubeUrl:'https://user:password@example.com/'});
 shows.push({artist:'DJ & Friends',date:'2026-10-09',ticketUrl:'https://tickets.example/last'});
 const {nodes}=await page({fetchResult:()=>response({shows,locationLabel:'Dallas, TX',days:7})});
 submit(nodes,'Dallas TX');await tick();
 const cards=nodes.get('show-grid').children;assert.equal(cards.length,32);
 assert.equal(cards[0].children[0].textContent,shows[0].artist);
 const links=descendants(cards[0]).filter(node=>node.tag==='a');
 assert.deepEqual(links.map(node=>node.textContent),['Tickets','YouTube']);
 assert.equal(links[0].href,shows[0].ticketUrl);assert.equal(links[1].href,shows[0].youtubeUrl);
 assert.ok(links.every(node=>node.target==='_blank'&&node.rel==='noopener noreferrer'));
 assert.equal(descendants(cards.at(-2)).filter(node=>node.tag==='a').length,0);
 const fallback=descendants(cards.at(-1)).find(node=>node.textContent==='YouTube search');
 assert.equal(new URL(fallback.href).origin,'https://www.youtube.com');
 assert.equal(new URL(fallback.href).searchParams.get('search_query'),'DJ & Friends');
});

test('a grouped event renders one festival title, date range, ticket choices and event YouTube search',async()=>{
 const festival={type:'event',artist:'Example Festival',event:'Example Festival',entryCount:100,date:'2026-10-09',dateEnd:'2026-10-11',venue:'Festival grounds',city:'Dallas',ticketUrl:'https://tickets.example/weekend',ticketLinks:[{url:'https://tickets.example/weekend',label:'Tickets'},{url:'https://tickets.example/sunday',label:'Sunday tickets'}],youtubeUrl:'https://www.youtube.com/results?search_query=Example+Festival'};
 const {nodes}=await page({fetchResult:()=>response({shows:[festival],locationLabel:'Dallas, TX',days:7})});
 submit(nodes,'Dallas TX');await tick();
 const cards=nodes.get('show-grid').children;assert.equal(cards.length,1);
 assert.equal(cards[0].children[0].textContent,'Example Festival');
 const date=descendants(cards[0]).find(node=>node.tag==='time');
 assert.match(date.textContent,/Oct/);assert.match(date.textContent,/9/);assert.match(date.textContent,/11/);
 const links=descendants(cards[0]).filter(node=>node.tag==='a');
 assert.deepEqual(links.map(link=>link.textContent),['Tickets','Sunday tickets','YouTube search']);
 assert.equal(links.at(-1).href,festival.youtubeUrl);
 assert.ok(links.every(link=>link.attributes['aria-label'].includes('Example Festival')));
});

test('large event ticket lists stay collapsed while preserving every safe option',async()=>{
 const tickets=Array.from({length:100},(_,i)=>({url:'https://tickets.example/festival?option='+i,label:'Ticket option '+i}));
 const festival={type:'event',event:'Example Festival',artist:'Example Festival',date:'2026-10-09',ticketLinks:[...tickets,{url:'javascript:bad',label:'Bad link'}],youtubeUrl:'https://www.youtube.com/results?search_query=Example+Festival'};
 const {nodes}=await page({fetchResult:()=>response({shows:[festival],locationLabel:'Dallas',days:7})});
 submit(nodes,'Dallas TX');await tick();
 const card=nodes.get('show-grid').children[0];
 const visibleLinks=card.children.filter(node=>node.tag==='div').flatMap(descendants).filter(node=>node.tag==='a');
 assert.equal(visibleLinks.length,2);assert.equal(visibleLinks[0].href,tickets[0].url);
 const options=card.children.find(node=>node.tag==='details');
 assert.ok(options);assert.equal(options.open,undefined);
 assert.equal(descendants(options).filter(node=>node.tag==='a').length,99);
 assert.equal(descendants(card).filter(node=>node.tag==='a').length,101);
});

test('restoring the page from browser history requests location again and clears the old location',async()=>{
 const {nodes,calls,geo,events}=await page();
 events.pageshow({persisted:false});assert.equal(geo.requests.length,1);
 submit(nodes,'Dallas TX');await tick();
 selectRange(nodes,'month');await tick();assert.equal(calls.at(-1).payload.view,'month');
 events.pageshow({persisted:true});assert.equal(geo.requests.length,2);assert.equal(nodes.get('city').value,'');
 assert.equal(nodes.get('show-grid').children.length,0);
 assert.equal(nodes.get('range-nearby').attributes['aria-pressed'],'true');
 assert.equal(nodes.get('range-month').attributes['aria-pressed'],'false');
 selectRange(nodes,'today');assert.equal(calls.length,2);
 geo.requests[1].success({coords:{latitude:36.17,longitude:-115.14}});await tick();
 assert.equal(calls.at(-1).payload.latitude,36.17);
 assert.equal(calls.at(-1).payload.location,undefined);assert.equal(calls.at(-1).payload.view,'today');
});

test('range switches repeat only the accepted location and ignore edited but unsent input',async()=>{
 const {nodes,calls}=await page({geolocation:false,fetchResult:call=>response({shows:[],searchKind:'location',locationInput:call.payload.query||call.payload.location,locationLabel:'Dallas, TX',view:call.payload.view,rangeLabel:call.payload.view==='today'?'Today':'This month',days:1})});
 submit(nodes,'Dallas TX');await tick();
 nodes.get('city').value='Los Angeles CA';nodes.get('city').handlers.input();
 selectRange(nodes,'today');await tick();
 assert.equal(calls.at(-1).payload.view,'today');assert.equal(calls.at(-1).payload.location,'Dallas TX');assert.equal(calls.at(-1).payload.query,undefined);
 assert.equal(nodes.get('city').value,'Los Angeles CA');
 assert.equal(nodes.get('range-today').attributes['aria-pressed'],'true');
 assert.equal(nodes.get('range-nearby').attributes['aria-pressed'],'false');
 assert.match(nodes.get('location-status').textContent,/No shows near Dallas.*Today/);
 selectRange(nodes,'month');await tick();assert.equal(calls.at(-1).payload.location,'Dallas TX');assert.equal(calls.at(-1).payload.view,'month');
});

test('date filters retain artist query and GPS origin together',async()=>{
 const {nodes,calls,geo}=await page({fetchResult:call=>response({shows:[],searchKind:call.payload.query?'artist':'location',artistQuery:call.payload.query,locationLabel:'your current location',view:call.payload.view,rangeLabel:call.payload.view==='weekend'?'This weekend':'Next 7 days'})});
 geo.requests[0].success({coords:{latitude:40.71,longitude:-74.01}});await tick();
 submit(nodes,'Tiësto');await tick();
 nodes.get('city').value='Unsent artist';selectRange(nodes,'weekend');await tick();
 const call=calls.at(-1);
 assert.equal(call.payload.view,'weekend');assert.equal(call.payload.query,'Tiësto');
 assert.equal(call.payload.latitude,40.71);assert.equal(call.payload.longitude,-74.01);
 assert.match(nodes.get('location-status').textContent,/No shows found for Tiësto.*Near your current location.*This weekend/);
});

test('all-location artist searches obey the selected date range and show zero without a fallback request',async()=>{
 const {nodes,calls}=await page({geolocation:false,fetchResult:call=>response({shows:[],searchKind:'artist',artistQuery:call.payload.query,view:call.payload.view,rangeLabel:call.payload.view==='three-months'?'Next 3 months':'Next 7 days',source:{snapshot:true,updatedAt:'2026-10-05'}})});
 submit(nodes,'Tiësto');await tick();assert.equal(calls.length,1);assert.equal(calls[0].payload.view,'nearby');
 assert.equal(nodes.get('show-grid').children.length,0);
 assert.match(nodes.get('location-status').textContent,/No shows found for Tiësto.*Next 7 days.*All locations/);
 assert.equal(nodes.get('feed-freshness').hidden,false);assert.equal(nodes.get('feed-freshness').textContent,'Event feed updated Oct 5, 2026');
 selectRange(nodes,'three-months');await tick();assert.equal(calls.length,2);assert.equal(calls.at(-1).payload.query,'Tiësto');assert.equal(calls.at(-1).payload.location,undefined);
 assert.match(nodes.get('location-status').textContent,/Next 3 months.*All locations/);
});

test('sample results are labeled as fictional and ticket links as placeholders',async()=>{
 const {nodes}=await page({geolocation:false,fetchResult:()=>response({shows:[],searchKind:'location',locationLabel:'New York',source:{snapshot:true,sample:true,updatedAt:'2026-10-05'}})});
 submit(nodes,'New York, NY');await tick();
 assert.equal(nodes.get('feed-freshness').hidden,false);
 assert.equal(nodes.get('feed-freshness').textContent,'Fictional sample events · ticket links are placeholders');
});

test('live feed freshness identifies the live source without presenting a timestamp as the last edit time',async()=>{
 const {nodes}=await page({geolocation:false,fetchResult:call=>response({shows:[],searchKind:'location',locationInput:call.payload.query,locationLabel:'Dallas',source:call.payload.query==='Dallas TX'?{snapshot:false,updatedAt:'2026-10-05T12:00:00Z'}:undefined})});
 submit(nodes,'Dallas TX');await tick();
 assert.equal(nodes.get('feed-freshness').hidden,false);
 assert.equal(nodes.get('feed-freshness').textContent,'Live event feed');
 submit(nodes,'Austin TX');await tick();assert.equal(nodes.get('feed-freshness').hidden,true);
});

test('failed new input does not replace the accepted artist search used by date filters',async()=>{
 const {nodes,calls}=await page({geolocation:false,fetchResult:call=>call.payload.query==='Bad city'?{ok:false,json:async()=>({error:'Location not found'})}:response({shows:[],searchKind:call.payload.query==='Dallas TX'?'location':'artist',locationInput:call.payload.query==='Dallas TX'?'Dallas TX':undefined,artistQuery:call.payload.query,locationLabel:'Dallas',view:call.payload.view})});
 submit(nodes,'Dallas TX');await tick();submit(nodes,'Tiësto');await tick();submit(nodes,'Bad city');await tick();
 selectRange(nodes,'weekend');await tick();assert.equal(calls.at(-1).payload.location,'Dallas TX');assert.equal(calls.at(-1).payload.query,'Tiësto');assert.equal(calls.at(-1).payload.view,'weekend');
});

test('a later range response wins when an earlier range request finishes afterward',async()=>{
 const pending=[];
 const {nodes,calls}=await page({geolocation:false,fetchResult:call=>call.payload.view==='nearby'?response({shows:[],searchKind:'location',locationInput:'Dallas TX',locationLabel:'Dallas'}):new Promise(resolve=>pending.push(resolve))});
 submit(nodes,'Dallas TX');await tick();selectRange(nodes,'weekend');selectRange(nodes,'month');
 assert.equal(calls.at(-2).options.signal.aborted,true);
 pending[1](response({shows:[{artist:'Month result',date:'2026-10-20'}],locationLabel:'Dallas',view:'month',rangeLabel:'This month'}));await tick();
 pending[0](response({shows:[{artist:'Weekend result',date:'2026-10-09'}],locationLabel:'Dallas',view:'weekend',rangeLabel:'This weekend'}));await tick();
 assert.equal(nodes.get('show-grid').children[0].children[0].textContent,'Month result');assert.match(nodes.get('location-status').textContent,/This month/);
 assert.equal(nodes.get('range-month').attributes['aria-pressed'],'true');
});

test('changing range during the first search reuses submitted GPS coordinates without another prompt',async()=>{
 const pending=[];
 const {nodes,calls,geo}=await page({fetchResult:()=>new Promise(resolve=>pending.push(resolve))});
 geo.requests[0].success({coords:{latitude:40.71,longitude:-74.01}});
 nodes.get('city').value='Unsent edit';selectRange(nodes,'weekend');
 assert.equal(calls.length,2);assert.equal(calls[0].options.signal.aborted,true);
 assert.equal(calls[1].payload.latitude,40.71);assert.equal(calls[1].payload.longitude,-74.01);assert.equal(calls[1].payload.query,undefined);assert.equal(calls[1].payload.view,'weekend');
 assert.equal(geo.requests.length,1);
 pending[1](response({shows:[],locationLabel:'New York',view:'weekend',rangeLabel:'This weekend'}));await tick();
 pending[0](response({shows:[{artist:'Earlier result',date:'2026-10-09'}],locationLabel:'New York'}));await tick();
 assert.equal(nodes.get('show-grid').children.length,0);assert.match(nodes.get('location-status').textContent,/This weekend/);
});

test('range switches follow the latest submitted location while its search is pending instead of reverting to the previous location',async()=>{
 const pending=[];
 const {nodes,calls}=await page({geolocation:false,fetchResult:call=>call.payload.query==='New York NY'?response({shows:[],searchKind:'location',locationInput:'New York NY',locationLabel:'New York, NY'}):new Promise(resolve=>pending.push(resolve))});
 submit(nodes,'New York NY');await tick();
 submit(nodes,'Los Angeles CA');
 nodes.get('city').value='Unsent Boston MA';selectRange(nodes,'weekend');
 assert.equal(calls.at(-2).options.signal.aborted,true);
 assert.equal(calls.at(-1).payload.query,'Los Angeles CA');assert.equal(calls.at(-1).payload.view,'weekend');
 assert.equal(nodes.get('city').value,'Unsent Boston MA');
 pending[1](response({shows:[{artist:'LA weekend',date:'2026-10-09'}],searchKind:'location',locationInput:'Los Angeles CA',locationLabel:'Los Angeles, CA',view:'weekend',rangeLabel:'This weekend'}));await tick();
 pending[0](response({shows:[{artist:'LA previous range',date:'2026-10-08'}],searchKind:'location',locationInput:'Los Angeles CA',locationLabel:'Los Angeles, CA',view:'nearby',rangeLabel:'Next 7 days'}));await tick();
 assert.equal(nodes.get('show-grid').children[0].children[0].textContent,'LA weekend');
 assert.match(nodes.get('location-status').textContent,/Los Angeles.*This weekend/);
 selectRange(nodes,'month');assert.equal(calls.at(-1).payload.location,'Los Angeles CA');assert.equal(calls.at(-1).payload.query,undefined);
 pending[2](response({shows:[],searchKind:'location',locationInput:'Los Angeles CA',locationLabel:'Los Angeles, CA',view:'month',rangeLabel:'This month'}));await tick();
});

test('artist queries retain an accepted GPS origin across successive searches',async()=>{
 const {nodes,calls,geo}=await page({fetchResult:call=>response({shows:[],searchKind:call.payload.query?'artist':'location',artistQuery:call.payload.query,locationLabel:'your current location',days:7})});
 geo.requests[0].success({coords:{latitude:32.78,longitude:-96.8}});await tick();
 submit(nodes,'Tiësto');await tick();submit(nodes,'Steve Angello');await tick();
 for(const call of calls.slice(1)){assert.equal(call.payload.latitude,32.78);assert.equal(call.payload.longitude,-96.8);assert.equal(call.payload.location,undefined);}
 assert.match(nodes.get('location-status').textContent,/Steve Angello.*Next 7 days/);
});

test('artist queries retain a typed location, and failed locations never replace it',async()=>{
 const {nodes,calls}=await page({geolocation:false,fetchResult:call=>call.payload.query==='bad city'?{ok:false,json:async()=>({error:'Location not found'})}:response({shows:[],searchKind:call.payload.query==='Dallas TX'?'location':'artist',locationInput:call.payload.query==='Dallas TX'?'Dallas TX':undefined,artistQuery:call.payload.query,locationLabel:'Dallas, TX',days:7})});
 submit(nodes,'Dallas TX');await tick();submit(nodes,'bad city');await tick();submit(nodes,'Tiësto');await tick();submit(nodes,'Steve Angello');await tick();
 assert.equal(calls[2].payload.location,'Dallas TX');assert.equal(calls[3].payload.location,'Dallas TX');
});

test('artist suggestions use names, and all-location results explain their scope and registration status',async()=>{
 const {nodes,calls}=await page({geolocation:false,artists:['Tiësto','Paris'],fetchResult:()=>response({shows:[],searchKind:'artist',artistQuery:'New DJ',view:'full',artistRegistration:{name:'New DJ',added:true}})});
 assert.deepEqual(nodes.get('artist-suggestions').children.map(option=>option.value),['Tiësto','Paris']);
 submit(nodes,'New DJ');await tick();assert.equal(calls[0].payload.location,undefined);
 assert.match(nodes.get('location-status').textContent,/All upcoming shows.*All locations/);
 assert.match(nodes.get('location-status').textContent,/Added “New DJ” to Artist List/);
 const failed=await page({geolocation:false,fetchResult:()=>response({shows:[],searchKind:'artist',artistQuery:'New DJ',view:'full',artistRegistration:{name:'New DJ',added:false,status:'not-saved'}})});
 submit(failed.nodes,'New DJ');await tick();assert.match(failed.nodes.get('location-status').textContent,/has not been added/);
});

test('an artist appearance keeps the festival name and ticket and YouTube links',async()=>{
 const show={artist:'Tiësto',event:'Big Festival',date:'2026-10-09',ticketUrl:'https://tickets.example/festival',youtubeUrl:'https://youtu.be/artist'};
 const {nodes}=await page({fetchResult:()=>response({shows:[show],searchKind:'artist',artistQuery:'Tiësto',locationLabel:'Dallas',days:7})});
 submit(nodes,'Tiësto');await tick();const card=nodes.get('show-grid').children[0];
 assert.equal(card.children[0].textContent,'Tiësto');assert.ok(descendants(card).some(node=>node.textContent==='Big Festival'));
 assert.deepEqual(descendants(card).filter(node=>node.tag==='a').map(node=>node.textContent),['Tickets','YouTube']);
});
