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
const response=(data)=>({ok:true,status:200,json:async()=>data});
async function page({geolocation=true,fetchResult}={}) {
 const nodes=new Map(),calls=[],geo={requests:[]},events={},timers=new Map();
 let timerId=0,elapsed=0;
 const advanceTimers=milliseconds=>{
  elapsed+=milliseconds;
  while(true) {
   const due=[...timers].filter(([,timer])=>timer.at<=elapsed).sort((a,b)=>a[1].at-b[1].at)[0];
   if(!due)break;
   timers.delete(due[0]);due[1].callback();
  }
 };
 const context={
  document:{
   getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},
   createElement(tag){return Object.assign(new Element(),{tag});},
  },
  navigator:geolocation?{geolocation:{getCurrentPosition(success,failure,options){geo.requests.push({success,failure,options});}}}:{},
  window:{addEventListener(name,callback){events[name]=callback;}},
  Intl,Date,URL,AbortController,console,
  setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,at:elapsed+delay});return id;},
  clearTimeout(id){timers.delete(id);},
  fetch:async(url,options)=>{
   const call={url,options,...(options.body?{payload:JSON.parse(options.body)}:{})};
   calls.push(call);
   return fetchResult?fetchResult(call):response({shows:[],days:7,searchKind:'location',locationInput:call.payload.query,locationLabel:call.payload.query||call.payload.location||'your current location'});
  },
 };
 vm.runInNewContext(await readFile(new URL('../public/browser/app.js',import.meta.url),'utf8'),context);
 await tick();return {nodes,calls,geo,events,advanceTimers};
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


test('a shared show card keeps performer names, styles, categories and every safe labeled link',async()=>{
 const group={
  type:'show-group',artist:'Alpha, Beta, Gamma',style:'House · Techno',categories:['Nighttime','Afters'],event:'Room A · Room B',date:'2026-10-09',venue:'Club',city:'Dallas',
  ticketUrl:'https://tickets.example/legacy',
  ticketLinks:[
   {url:'https://tickets.example/',label:'Alpha tickets'},
   {url:'https://tickets.example',label:'Duplicate tickets'},
   {url:'https://tickets.example/beta',label:'Beta tickets'},
   {url:'javascript:alert(1)',label:'Unsafe ticket'},
   {url:'https://user:password@tickets.example/private',label:'Credential ticket'},null,'invalid',
  ],
  youtubeUrl:'https://youtu.be/legacy',
  youtubeLinks:[
   {url:'https://youtu.be/shared',label:'YouTube · Alpha'},
   {url:'https://youtu.be/shared',label:'YouTube · Beta'},
   {url:'https://youtu.be/shared',label:'YouTube · Alpha'},
   {url:'https://www.youtube.com/results?search_query=Gamma',label:'YouTube search · <img src=x onerror=alert(1)>'},
   {url:'data:text/html,unsafe',label:'Unsafe video'},
   {url:'https://user:password@youtube.com/private',label:'Credential video'},null,'invalid',
  ],
 };
 const {nodes}=await page({fetchResult:()=>response({shows:[group],locationLabel:'Dallas',days:7})});
 submit(nodes,'Dallas TX');await tick();
 const cards=nodes.get('show-grid').children;assert.equal(cards.length,1);
 const card=cards[0];assert.equal(card.children[0].textContent,group.artist);assert.equal(card.children[1].textContent,group.style);assert.equal(card.children[2].className,'show-date');
 assert.ok(card.children.some(node=>node.textContent===group.event));
 assert.deepEqual(card.children.at(-1).children.map(node=>node.textContent),group.categories);
 const links=descendants(card).filter(node=>node.tag==='a');
 assert.deepEqual(links.map(node=>node.textContent),['Alpha tickets','Beta tickets','YouTube · Alpha','YouTube · Beta','YouTube search · <img src=x onerror=alert(1)>']);
 assert.deepEqual(links.map(node=>node.href),['https://tickets.example/','https://tickets.example/beta','https://youtu.be/shared','https://youtu.be/shared','https://www.youtube.com/results?search_query=Gamma']);
 assert.ok(links.every(node=>node.target==='_blank'&&node.rel==='noopener noreferrer'&&node.attributes['aria-label'].includes(group.artist)));
 assert.ok(links.every(node=>node.children.length===0));
});


test('Festival category uses the event headline and one festival search while retaining every ticket',async()=>{
 const artists=Array.from({length:20},(_,i)=>'DJ '+i).join(', ');
 const tickets=Array.from({length:5},(_,i)=>({url:'https://tickets.example/festival/'+i,label:'Ticket option '+i}));
 const videos=Array.from({length:20},(_,i)=>({url:'https://youtu.be/performer'+i,label:'YouTube · DJ '+i}));
 const variants=[{type:'show-group',category:'  fEsTiVaL  '},{type:'show-group',categories:['Nighttime',' FESTIVAL ']},{type:'event',category:'Festival'},{category:'Festival'}];
 const shows=variants.map(variant=>({...variant,artist:artists,event:'  Neon & Friends  ',style:'House, Techno',date:'2026-10-09',ticketLinks:tickets,youtubeLinks:videos,youtubeUrl:'https://youtu.be/performer0'}));
 const {nodes}=await page({fetchResult:()=>response({shows,locationLabel:'Dallas',days:7})});
 submit(nodes,'Dallas TX');await tick();
 for(const card of nodes.get('show-grid').children) {
  assert.equal(card.children[0].textContent,'Neon & Friends');assert.equal(card.children[1].textContent,'House, Techno');
  assert.equal(card.children.filter(node=>node.textContent==='Neon & Friends').length,1);
  assert.ok(!descendants(card).some(node=>node.textContent===artists));
  const links=descendants(card).filter(node=>node.tag==='a');
  assert.deepEqual(links.filter(node=>node.href.startsWith('https://tickets.example/')).map(node=>node.href),tickets.map(ticket=>ticket.url));
  const youtube=links.filter(node=>new URL(node.href).hostname==='www.youtube.com');
  assert.equal(youtube.length,1);assert.equal(youtube[0].textContent,'YouTube search');assert.equal(new URL(youtube[0].href).searchParams.get('search_query'),'Neon & Friends');
  assert.equal(links.length,tickets.length+1);assert.ok(links.every(node=>node.target==='_blank'&&node.rel==='noopener noreferrer'));
 }
});

test('nonfestival categories keep the complete artist headline and individual performer links',async()=>{
 const names=Array.from({length:12},(_,i)=>'Artist '+i),artist=names.join(', ');
 const youtubeLinks=names.map((name,i)=>({url:'https://youtu.be/artist'+i,label:'YouTube · '+name}));
 const shows=['Nighttime','Festival Afterparty'].map(category=>({type:'show-group',artist,event:'Club Night',category,date:'2026-10-09',youtubeLinks}));
 const {nodes}=await page({fetchResult:()=>response({shows,locationLabel:'Dallas',days:7})});
 submit(nodes,'Dallas TX');await tick();
 for(const card of nodes.get('show-grid').children) {
  assert.equal(card.children[0].textContent,artist);assert.ok(card.children.some(node=>node.textContent==='Club Night'));
  assert.deepEqual(descendants(card).filter(node=>node.tag==='a').map(node=>node.textContent),youtubeLinks.map(link=>link.label));
 }
});

test('Festival cards with missing or placeholder event names retain artists without inventing an event title',async()=>{
 const artist='Alpha, Beta',youtubeLinks=[{url:'https://youtu.be/alpha',label:'YouTube · Alpha'},{url:'https://youtu.be/beta',label:'YouTube · Beta'}];
 const shows=[undefined,'',' Event ','Festival','TBA','To be announced','Unknown Festival'].flatMap(event=>['event','show-group'].map(type=>({type,artist,event,category:'Festival',date:'2026-10-09',youtubeLinks})));
 const {nodes}=await page({fetchResult:()=>response({shows,locationLabel:'Dallas',days:7})});
 submit(nodes,'Dallas TX');await tick();
 for(const card of nodes.get('show-grid').children) {
  assert.equal(card.children[0].textContent,artist);
  assert.deepEqual(descendants(card).filter(node=>node.tag==='a').map(node=>node.textContent),youtubeLinks.map(link=>link.label));
  assert.equal(card.children.filter(node=>node.tag==='p'&&node.className!=='show-date').length,0);
 }
});

test('a shared show card collapses many ticket choices while leaving every performer video visible',async()=>{
 const tickets=Array.from({length:6},(_,i)=>({url:'https://tickets.example/artist/'+i,label:'Tickets · Artist '+i}));
 const videos=Array.from({length:6},(_,i)=>({url:'https://www.youtube.com/results?search_query=Artist+'+i,label:'YouTube search · Artist '+i}));
 const group={type:'show-group',artist:'Artists 0–5',date:'2026-10-09',ticketLinks:[...tickets,tickets[0],{url:'javascript:bad',label:'Bad'}],youtubeLinks:videos};
 const {nodes}=await page({fetchResult:()=>response({shows:[group],locationLabel:'Dallas',days:7})});
 submit(nodes,'Dallas TX');await tick();
 const card=nodes.get('show-grid').children[0];
 const visible=card.children.filter(node=>node.tag==='div').flatMap(descendants).filter(node=>node.tag==='a');
 assert.deepEqual(visible.map(node=>node.textContent),[tickets[0].label,...videos.map(video=>video.label)]);
 const options=card.children.find(node=>node.tag==='details');assert.ok(options);assert.equal(options.open,undefined);
 assert.deepEqual(descendants(options).filter(node=>node.tag==='a').map(node=>node.href),tickets.slice(1).map(ticket=>ticket.url));
 assert.equal(descendants(card).filter(node=>node.tag==='a').length,tickets.length+videos.length);
});


test('single-date results display distinct explicit show times without inventing clocks for date-only or multi-day events',async()=>{
 const shows=[
  {artist:'Early set',date:'2026-10-09',startTime:'20:00:00',timeZoneOffset:'CDT'},
  {artist:'Late set',date:'2026-10-09',startTime:'22:30:00',timeZoneOffset:'-05:00'},
  {artist:'After midnight',date:'2026-10-10',startTime:'00:15:30'},
  {artist:'Date only',date:'2026-10-09'},
  {type:'event',event:'Weekend festival',date:'2026-10-09',dateEnd:'2026-10-11',startTime:'20:00:00',timeZoneOffset:'CDT'},
  {artist:'Invalid clock',date:'2026-10-09',startTime:'25:00:00',timeZoneOffset:'CDT'},
 ];
 const {nodes}=await page({fetchResult:()=>response({shows,locationLabel:'Dallas',days:7})});
 submit(nodes,'Dallas TX');await tick();
 const cards=nodes.get('show-grid').children;assert.equal(cards.length,shows.length);
 const dates=cards.map(card=>descendants(card).find(node=>node.tag==='time').textContent);
 assert.match(dates[0],/Fri, Oct 9, 2026 · 8:00 PM CDT$/);
 assert.match(dates[1],/Fri, Oct 9, 2026 · 10:30 PM UTC-05:00$/);
 assert.match(dates[2],/Sat, Oct 10, 2026 · 12:15:30 AM$/);
 assert.doesNotMatch(dates[3],/AM|PM/);assert.doesNotMatch(dates[4],/AM|PM/);assert.doesNotMatch(dates[5],/AM|PM/);
 assert.match(dates[4],/9/);assert.match(dates[4],/11/);
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

test('typed artist results explain their scope and registration status',async()=>{
 const {nodes,calls}=await page({geolocation:false,fetchResult:()=>response({shows:[],searchKind:'artist',artistQuery:'New DJ',view:'full',artistRegistration:{name:'New DJ',added:true}})});

 submit(nodes,'New DJ');await tick();assert.equal(calls[0].payload.location,undefined);
 assert.match(nodes.get('location-status').textContent,/All upcoming shows.*All locations/);
 assert.match(nodes.get('location-status').textContent,/Added “New DJ” to Artist List/);
 const failed=await page({geolocation:false,fetchResult:()=>response({shows:[],searchKind:'artist',artistQuery:'New DJ',view:'full',artistRegistration:{name:'New DJ',added:false,status:'not-saved'}})});
 submit(failed.nodes,'New DJ');await tick();assert.match(failed.nodes.get('location-status').textContent,/Artist list update could not be confirmed/);
});

test('an artist appearance keeps the festival name and ticket and YouTube links',async()=>{
 const show={artist:'Tiësto',event:'Big Festival',date:'2026-10-09',ticketUrl:'https://tickets.example/festival',youtubeUrl:'https://youtu.be/artist'};
 const {nodes}=await page({fetchResult:()=>response({shows:[show],searchKind:'artist',artistQuery:'Tiësto',locationLabel:'Dallas',days:7})});
 submit(nodes,'Tiësto');await tick();const card=nodes.get('show-grid').children[0];
 assert.equal(card.children[0].textContent,'Tiësto');assert.ok(descendants(card).some(node=>node.textContent==='Big Festival'));
 assert.deepEqual(descendants(card).filter(node=>node.tag==='a').map(node=>node.textContent),['Tickets','YouTube']);
});

test('an unverified artist stays unadded and keeps its honest zero-show result',async()=>{
 const {nodes,calls}=await page({geolocation:false,fetchResult:()=>response({shows:[],searchKind:'artist',artistQuery:'Unknown DJ',artistRegistration:{name:'Unknown DJ',added:false,status:'unverified'}})});
 submit(nodes,'Unknown DJ');await tick();
 const message=nodes.get('location-status').textContent;
 assert.match(message,/No shows found for Unknown DJ.*Next 7 days.*All locations/);
 assert.match(message,/Could not verify “Unknown DJ” as a music artist; not added/);
 assert.doesNotMatch(message,/Added .* to Artist List|temporarily unavailable|could not be confirmed/);
 assert.equal(nodes.get('show-grid').children.length,0);assert.equal(nodes.get('show-grid').attributes['aria-busy'],'false');
 assert.equal(nodes.get('location-status').children.length,0);assert.equal(calls.length,1);
});

test('unavailable artist verification does not hide usable show results or claim a saved name',async()=>{
 const {nodes}=await page({geolocation:false,fetchResult:()=>response({shows:[{artist:'Search DJ',date:'2026-10-09',ticketUrl:'https://tickets.example/show'}],searchKind:'artist',artistQuery:'Search DJ',artistRegistration:{name:'Search DJ',added:false,status:'verification-unavailable'}})});
 submit(nodes,'Search DJ');await tick();
 const message=nodes.get('location-status').textContent;
 assert.match(message,/Artist verification is temporarily unavailable; not added/);
 assert.doesNotMatch(message,/Added .* to Artist List|Could not verify|No shows found/);
 assert.equal(nodes.get('show-grid').children[0].children[0].textContent,'Search DJ');
 assert.equal(nodes.get('location-status').children.length,0);
});

test('a verified artist can be confirmed added even when the selected range has no events',async()=>{
 const {nodes,calls}=await page({geolocation:false,fetchResult:()=>response({shows:[],searchKind:'artist',artistQuery:'Confirmed DJ',artistRegistration:{name:'Confirmed DJ',added:true,status:'saved'}})});
 submit(nodes,'Confirmed DJ');await tick();
 const message=nodes.get('location-status').textContent;
 assert.match(message,/No shows found for Confirmed DJ.*Next 7 days.*All locations/);
 assert.match(message,/Added “Confirmed DJ” to Artist List/);
 assert.doesNotMatch(message,/not added|could not be confirmed|Could not verify/);
 assert.equal(nodes.get('show-grid').children.length,0);assert.equal(calls.length,1);
});

test('an existing saved artist is not presented as a new addition or verification failure',async()=>{
 const {nodes}=await page({geolocation:false,fetchResult:()=>response({shows:[],searchKind:'artist',artistQuery:'Existing DJ',artistRegistration:{name:'Existing DJ',added:false,status:'saved'}})});
 submit(nodes,'Existing DJ');await tick();
 const message=nodes.get('location-status').textContent;
 assert.match(message,/No shows found for Existing DJ/);
 assert.doesNotMatch(message,/Added .* to Artist List|not added|verification|Could not verify|could not be confirmed/);
});

test('startup renders the show search without extra background catalog requests',async()=>{
 const pending=[];
 const {nodes,calls,geo,advanceTimers}=await page({fetchResult:()=>new Promise(resolve=>pending.push(resolve))});
 advanceTimers(30000);await tick();
 geo.requests[0].success({coords:{latitude:40.71,longitude:-74.01}});
 advanceTimers(10000);await tick();
 assert.equal(calls.length,1);
 pending[0](response({shows:[{artist:'First show',date:'2026-10-09'}],locationLabel:'New York',source:{snapshot:false}}));await tick();
 assert.equal(nodes.get('show-grid').children[0].children[0].textContent,'First show');
 assert.equal(nodes.get('show-grid').attributes['aria-busy'],'false');
 advanceTimers(30000);await tick();assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/browser/shows');
 assert.match(nodes.get('location-status').textContent,/Shows near New York/);
});

test('a stalled GPS search shows progress, ends after 50 seconds, and retries only on request',async()=>{
 const pending=[];
 const {nodes,calls,geo,advanceTimers}=await page({fetchResult:()=>new Promise(resolve=>pending.push(resolve))});
 selectRange(nodes,'weekend');
 geo.requests[0].success({coords:{latitude:40.71,longitude:-74.01}});
 assert.equal(nodes.get('show-grid').attributes['aria-busy'],'true');
 advanceTimers(3999);await tick();assert.match(nodes.get('location-status').textContent,/^Finding shows/);
 advanceTimers(1);await tick();assert.match(nodes.get('location-status').textContent,/Still finding shows/);
 advanceTimers(46000);await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,true);
 assert.equal(nodes.get('show-grid').attributes['aria-busy'],'false');
 assert.match(nodes.get('location-status').textContent,/took too long/);
 assert.doesNotMatch(nodes.get('location-status').textContent,/No shows/);
 const retry=nodes.get('location-status').children.find(node=>node.tag==='button');
 assert.equal(retry.textContent,'Try again');retry.handlers.click();
 assert.equal(calls.length,2);assert.equal(calls[1].payload.latitude,40.71);assert.equal(calls[1].payload.longitude,-74.01);assert.equal(calls[1].payload.view,'weekend');
 pending[1](response({shows:[{artist:'Retry result',date:'2026-10-10'}],locationLabel:'New York',view:'weekend',rangeLabel:'This weekend'}));await tick();
 pending[0](response({shows:[{artist:'Late original',date:'2026-10-09'}],locationLabel:'Old city'}));await tick();
 assert.equal(nodes.get('show-grid').children[0].children[0].textContent,'Retry result');
 assert.match(nodes.get('location-status').textContent,/New York.*This weekend/);
 assert.equal(nodes.get('location-status').children.length,0);
});

test('the search deadline also bounds a stalled response body',async()=>{
 let finishBody;
 const {nodes,calls,advanceTimers}=await page({geolocation:false,fetchResult:()=>({ok:true,status:200,json:()=>new Promise(resolve=>finishBody=resolve)})});
 submit(nodes,'Dallas TX');await tick();advanceTimers(50000);await tick();
 assert.match(nodes.get('location-status').textContent,/took too long/);
 assert.equal(calls[0].options.signal.aborted,true);assert.equal(nodes.get('show-grid').attributes['aria-busy'],'false');
 finishBody({shows:[{artist:'Late body',date:'2026-10-09'}],locationLabel:'Dallas'});await tick();
 assert.equal(nodes.get('show-grid').children.length,0);assert.match(nodes.get('location-status').textContent,/took too long/);
});

test('typing manual input aborts an already-started automatic GPS feed request',async()=>{
 const pending=[];
 const {nodes,calls,geo,advanceTimers}=await page({fetchResult:()=>new Promise(resolve=>pending.push(resolve))});
 geo.requests[0].success({coords:{latitude:32.78,longitude:-96.8}});
 nodes.get('city').value='New York NY';nodes.get('city').handlers.input();
 assert.equal(calls[0].options.signal.aborted,true);assert.equal(nodes.get('show-grid').attributes['aria-busy'],'false');
 advanceTimers(50000);await tick();assert.match(nodes.get('location-status').textContent,/^Enter a city/);
 assert.equal(nodes.get('location-status').children.length,0);
 submit(nodes,'New York NY');assert.equal(calls[1].payload.latitude,undefined);assert.equal(calls[1].payload.query,'New York NY');
 pending[1](response({shows:[{artist:'Manual result',date:'2026-10-09'}],locationInput:'New York NY',locationLabel:'New York'}));await tick();
 pending[0](response({shows:[{artist:'GPS result',date:'2026-10-09'}],locationLabel:'Dallas'}));await tick();
 assert.equal(nodes.get('show-grid').children[0].children[0].textContent,'Manual result');
 assert.match(nodes.get('location-status').textContent,/New York/);
});

test('an older deadline cannot replace a newer successful search with an error or slow status',async()=>{
 let finishOld;
 const {nodes,calls,advanceTimers}=await page({geolocation:false,fetchResult:call=>call.payload.query==='Dallas TX'?new Promise(resolve=>finishOld=resolve):response({shows:[{artist:'Current result',date:'2026-10-10'}],locationLabel:'New York'})});
 submit(nodes,'Dallas TX');advanceTimers(4000);await tick();
 submit(nodes,'New York NY');await tick();const currentStatus=nodes.get('location-status').textContent;
 advanceTimers(50000);await tick();
 assert.equal(calls.length,2);assert.equal(nodes.get('location-status').textContent,currentStatus);
 assert.equal(nodes.get('location-status').children.length,0);
 finishOld(response({shows:[],locationLabel:'Dallas'}));await tick();
 assert.equal(nodes.get('show-grid').children[0].children[0].textContent,'Current result');
});

test('a transient feed error stays an error and offers retry without an automatic POST',async()=>{
 const {nodes,calls,advanceTimers}=await page({geolocation:false,fetchResult:()=>({ok:false,status:503,json:async()=>({error:'The live feed is temporarily unavailable. Please try again.'})})});
 submit(nodes,'New York NY');await tick();advanceTimers(100000);await tick();
 assert.equal(calls.length,1);
 assert.equal(nodes.get('show-grid').attributes['aria-busy'],'false');
 assert.match(nodes.get('location-status').textContent,/temporarily unavailable/);
 assert.doesNotMatch(nodes.get('location-status').textContent,/No shows/);
 assert.equal(nodes.get('location-status').children.find(node=>node.tag==='button').textContent,'Try again');
 assert.equal(nodes.get('feed-freshness').hidden,true);
});

test('an incomplete feed is reported as an error rather than an empty show list',async()=>{
 const {nodes,advanceTimers}=await page({geolocation:false,fetchResult:()=>response({locationLabel:'New York'})});
 submit(nodes,'New York NY');await tick();advanceTimers(1500);await tick();
 assert.match(nodes.get('location-status').textContent,/incomplete response/);
 assert.doesNotMatch(nodes.get('location-status').textContent,/No shows/);
 assert.equal(nodes.get('show-grid').attributes['aria-busy'],'false');
});
