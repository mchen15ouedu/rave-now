import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import dns from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {evidenceUrl,publicAddress,verifiedEventsFromHtml,createEventVerifier,transcriptDateConflicts,transcriptDateMatches} from '../src/event-evidence.mjs';

const artist='DJ Example',today='2026-10-07',ticket='https://www.ticketmaster.com/event/example';
const official='https://djexamplemusic.com/';
const event=(changes={})=>({
  '@context':'https://schema.org','@type':'MusicEvent',name:'DJ Example Live',
  performer:{'@type':'MusicGroup',name:artist},startDate:'2026-10-09T20:00:00-04:00',
  eventStatus:'https://schema.org/EventScheduled',
  location:{'@type':'Place',name:'Example Hall',address:{'@type':'PostalAddress',streetAddress:'123 Main St',addressLocality:'New York',addressRegion:'NY',postalCode:'10001'}},
  offers:{'@type':'Offer',url:ticket},...changes,
});
const html=value=>`<!doctype html><script type="application/ld+json">${JSON.stringify(value)}</script>`;
const page=(body,status=200,extra={})=>({status,html:body,contentType:'text/html; charset=utf-8',...extra});
const parse=(value,options={})=>verifiedEventsFromHtml(html(value),{artist,today,sourceUrl:ticket,text:artist,...options});
const verifier=getPage=>createEventVerifier({getPage,clock:()=>new Date(today+'T12:00:00Z')});

test('evidence links require credential-free HTTPS and reject literal/local destinations and secret query parameters',()=>{
  assert.equal(evidenceUrl(ticket+'?eventId=abc#tickets').href,ticket+'?eventId=abc');
  for(const value of ['http://ticketmaster.com/event','https://user:pass@ticketmaster.com/event','https://ticketmaster.com:8443/event','https://127.0.0.1/','https://2130706433/','https://[::1]/','https://[::ffff:127.0.0.1]/','https://localhost/','https://service.local/','https://service.internal/','https://ticketmaster.com/?api_key=secret','https://ticketmaster.com/?apiToken=secret','https://ticketmaster.com/?X-Amz-Credential=secret','https://ticketmaster.com/?auth=secret'])assert.throws(()=>evidenceUrl(value),/unavailable/,value);
});

test('public DNS guard excludes private, special-purpose, translated and documentation IPv4/IPv6 ranges',()=>{
  for(const address of ['8.8.8.8','1.1.1.1','93.184.215.14','172.15.1.1','172.32.1.1','192.0.3.1','198.51.101.1','203.0.114.1','2606:4700:4700::1111','2001:4860:4860::8888','2a00:1450:4001:800::200e'])assert.equal(publicAddress(address),true,address);
  for(const address of ['0.1.2.3','10.1.2.3','100.64.0.1','100.127.255.255','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.255','192.168.1.1','192.0.0.1','192.0.2.10','192.88.99.1','198.18.0.1','198.19.255.255','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:8.8.8.8','64:ff9b::a00:1','64:ff9b:1::1','100::1','2001::1','2001:2::1','2001:1ff::1','2001:db8::1','2001:0db8:0000::1','2002:7f00:1::1','3fff::1','3fff:fff::1','fc00::1','fd00::1','fe80::1','ff02::1','2606:4700::1111%eth0','not an IP'])assert.equal(publicAddress(address),false,address);
});

test('a unique primary JSON-LD event supplies independently observed artist/date/venue/city and safe ticket link',async()=>{
  const calls=[];const result=await verifier(async(url,options)=>{calls.push({url:url.href,options});return page(html(event()));}).verify({artist,text:`${artist} ${ticket}`});
  assert.equal(result.status,'verified');assert.equal(result.event.artist,artist);assert.equal(result.event.date,'2026-10-09');assert.equal(result.event.venue,'Example Hall');assert.equal(result.event.city,'New York, NY');
  assert.equal(result.event.address,'123 Main St, New York, NY, 10001');assert.equal(result.event.sourceUrl,ticket);assert.equal(result.event.ticketUrl,ticket);
  assert.deepEqual(Object.keys(calls[0].options),['signal']);
  const unsafeOffer=parse(event({offers:{url:'https://attacker.example.com/fake-ticket'}}))[0];assert.equal(unsafeOffer.ticketUrl,ticket);
});

test('submitted arbitrary domains, spoofed ticket domains and user text alone never become trusted sources',async()=>{
  let calls=0;const check=verifier(async()=>{calls++;return page(html(event()));});
  for(const text of [`${artist} https://attacker.com/event`,`${artist} https://ticketmaster.com.attacker.com/event`,`${artist} https://evil.com/?claimed_official=${official}`,`${artist} October 9, 2026 at Example Hall in New York`])assert.equal((await check.verify({artist,text})).status,'needs-review');
  assert.equal(calls,0);
  assert.equal((await check.verify({artist,text:`${artist} ${official}shows`,officialUrls:[official]})).status,'verified');assert.equal(calls,1);
});

test('source pages with no JSON-LD or incomplete/nonmatching/cancelled events require review',()=>{
  assert.deepEqual(verifiedEventsFromHtml(`<h1>${artist}</h1><p>October 9, 2026 at Example Hall, New York</p>`,{artist,today,sourceUrl:ticket}),[]);
  for(const attributes of ['data-type="application/ld+json"',`type="text/javascript" data-note='type="application/ld+json"'`])assert.deepEqual(verifiedEventsFromHtml(`<script ${attributes}>${JSON.stringify(event())}</script>`,{artist,today,sourceUrl:ticket}),[]);
  for(const value of [event({performer:{name:'Somebody Else'}}),event({name:'A DJ Example Tribute',performer:{name:'Tribute Band'}}),event({name:'Wrong Artist',performer:{name:'DJ Examples'}}),event({startDate:'2026-10-06'}),event({startDate:'2026-10-09Tnot-a-time'}),event({startDate:'2026-10-09T25:00:00Z'}),event({startDate:'2026-02-30'}),event({endDate:'2026-10-08'}),event({endDate:'2026-10-09T18:00:00-04:00'}),event({eventStatus:'https://schema.org/EventCancelled'}),event({eventStatus:'https://schema.org/EventPostponed'}),event({eventStatus:'NotEventScheduled'}),event({name:'CANCELLED: DJ Example Live'}),event({location:{name:'Example Hall',address:{}}}),event({location:{address:{addressLocality:'New York'}}}),event({'@type':'https://untrusted.com/MusicEvent'})])assert.deepEqual(parse(value),[],JSON.stringify(value));
  assert.equal(parse(event({name:'Tiesto',performer:{name:'Tiësto'}}),{artist:'Tiesto'}).length,1);
});

test('region and country remain available for geocoding when a primary event has no street address',()=>{
  const location=address=>({name:'Example Hall',address:{'@type':'PostalAddress',...address}});
  const texas=event({location:location({addressLocality:'Paris',addressRegion:'TX',addressCountry:{'@type':'Country',name:'US'}})});
  const result=parse(texas)[0];assert.equal(result.city,'Paris, TX, US');assert.equal(result.address,'');
  assert.equal(parse(texas,{directLink:false,text:`${artist} October 9, 2026 in Paris`}).length,1);
  assert.equal(parse(event({location:location({addressLocality:'Paris',addressCountry:'France'})}))[0].city,'Paris, France');
  const repeated=parse(event({location:location({streetAddress:'123 Main St',addressLocality:'Paris, TX',addressRegion:'TX',postalCode:'75460',addressCountry:'US'})}))[0];
  assert.equal(repeated.city,'Paris, TX, US');assert.equal(repeated.address,'123 Main St, Paris, TX, 75460, US');
  assert.deepEqual(parse(event({location:location({addressRegion:'TX',addressCountry:'US'})})),[]);
});

test('same-named cities in different regions remain distinct event identities',async()=>{
  const location=region=>({name:'Example Hall',address:{addressLocality:'Paris',addressRegion:region,addressCountry:'US'}});
  const events=[event({location:location('TX')}),event({location:location('TN')})];
  assert.deepEqual(parse(events).map(value=>value.city),['Paris, TX, US','Paris, TN, US']);
  assert.equal((await verifier(async()=>page(html(events))).verify({artist,text:`${artist} ${ticket}`})).status,'needs-review');
});

test('conflicting ISO, spoken, partial and ambiguous numeric dates cannot override source evidence',()=>{
  for(const text of [`${artist} 2026-10-10`,`${artist} October 10, 2026`,`${artist} 10 Oct 2026`,`${artist} October 10`,`${artist} October 9, 2027`,`${artist} 2026-10-09 and 2026-10-10`,`${artist} 10/09/2026`])assert.deepEqual(parse(event(),{text}),[],text);
  for(const text of [`${artist} 2026-10-09`,`${artist} October 9, 2026`,`${artist} 9th Oct 2026`,`${artist} October 9`])assert.equal(parse(event(),{text}).length,1,text);
  assert.equal(parse(event({startDate:'2026-10-13'}),{text:`${artist} 13/10/2026`}).length,1);
  assert.equal(parse(event({startDate:'2026-12-31'}),{text:`${artist} 12/31/2026`}).length,1);
  assert.equal(transcriptDateConflicts(`${artist} October 10, 2026`,'2026-10-09'),true);
  assert.equal(transcriptDateConflicts(`${artist} October 9`,'2026-10-09'),false);
  assert.equal(transcriptDateConflicts(`${artist} 10/09/2026`,'2026-10-09'),true);
  assert.equal(transcriptDateConflicts(artist,'2026-02-30'),true);
  assert.equal(transcriptDateMatches(`${artist} October 9, 2026`,'2026-10-09'),true);
  assert.equal(transcriptDateMatches(`${artist} October 9`,'2026-10-09'),false);
  assert.equal(transcriptDateMatches(`${artist} 2026-10-09`,'2026-02-30'),false);
});

test('official tour pages need transcript date and city while an explicit primary event link does not',async()=>{
  let calls=0;const check=verifier(async()=>{calls++;return page(html(event()));});
  for(const text of [`${artist}`,`${artist} October 9, 2026 in Boston`,`${artist} in New York`,`${artist} October 10, 2026 in New York`])assert.equal((await check.verify({artist,text,officialUrls:[official]})).status,'needs-review');
  assert.equal((await check.verify({artist,text:`${artist} October 9, 2026 in New York`,officialUrls:[official]})).status,'verified');
  assert.equal((await check.verify({artist,text:`${artist} ${ticket}`})).status,'verified');assert.equal(calls,6);
});

test('multiple future events, differing same-night performances and event titles require review, while exact duplicate graph records collapse',async()=>{
  const duplicate=event();
  for(const values of [[event(),event({startDate:'2026-10-10T20:00:00-04:00'})],[event(),event({startDate:'2026-10-09T23:00:00-04:00'})],[event(),event({name:'DJ Example Second Event'})]])assert.equal((await verifier(async()=>page(html(values))).verify({artist,text:`${artist} ${ticket}`})).status,'needs-review');
  const exact=await verifier(async()=>page(html({'@context':'https://schema.org','@graph':[duplicate,duplicate]}))).verify({artist,text:`${artist} ${ticket}`});assert.equal(exact.status,'verified');
});

test('redirects revalidate every destination, strip fragments, enforce MIME and cap total reads including redirects',async()=>{
  for(const redirect of ['http://ticketmaster.com/plain','https://127.0.0.1/private','https://evil.com/event','https://ticketmaster.com/event?token=secret',undefined]) {
    const calls=[];const result=await verifier(async(url)=>{calls.push(url.href);return page('',302,{location:redirect});}).verify({artist,text:`${artist} ${ticket}`});
    assert.equal(result.status,'needs-review');assert.equal(calls.length,1,redirect);
  }
  const reads=[];const check=verifier(async url=>{reads.push(url.href);return page('',302,{location:'/redirect-'+reads.length});});
  await check.verify({artist,text:`${artist} ${ticket} https://dice.fm/another-event https://ra.co/events/example`});assert.equal(reads.length,5);
  const loop=[];await verifier(async url=>{loop.push(url.href);return page('',302,{location:ticket});}).verify({artist,text:`${artist} ${ticket}`});assert.equal(loop.length,1);
  let excessive=0;assert.equal((await verifier(async()=>{excessive++;return page(html(event()));}).verify({artist,text:Array.from({length:6},(_,index)=>ticket+'/'+index).join(' ')})).status,'needs-review');assert.equal(excessive,0);
  assert.equal((await verifier(async()=>page(html(event()),200,{contentType:'text/html-malicious'})).verify({artist,text:`${artist} ${ticket}`})).status,'needs-review');
});

test('JSON-LD page/node/depth limits fail closed rather than accepting a valid prefix before truncation',()=>{
  assert.throws(()=>verifiedEventsFromHtml('x'.repeat(1500001),{artist,sourceUrl:ticket,today}),/unavailable/);
  assert.throws(()=>verifiedEventsFromHtml(Array.from({length:41},()=>html(event())).join(''),{artist,sourceUrl:ticket,today}),/unavailable/);
  assert.throws(()=>parse([event(),...Array.from({length:2001},()=>({extra:true}))]),/unavailable/);
  let deep={};for(let i=0;i<12;i++)deep={nested:deep};assert.throws(()=>parse([event(),deep]),/unavailable/);
});

function mockNetwork(t,{addresses=[{address:'8.8.8.8',family:4}],body=html(event()),contentLength,resolver}={}) {
  const calls=[];
  t.mock.method(dns,'lookup',resolver||(async()=>addresses));syncBuiltinESMExports();
  t.mock.method(https,'get',(url,options,callback)=>{
    calls.push({url,options});const request=new EventEmitter();request.destroy=error=>queueMicrotask(()=>request.emit('error',error));
    setImmediate(()=>{
      const response=new EventEmitter();response.statusCode=200;response.headers={'content-type':'text/html',...(contentLength?{'content-length':String(contentLength)}:{})};response.destroy=()=>{response.destroyed=true;};
      callback(response);if(!response.destroyed){response.emit('data',Buffer.from(body));if(!response.destroyed)response.emit('end');}
    });return request;
  });
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});return calls;
}

test('pinned HTTPS rejects any non-public DNS answer before connection and forwards no credentials',async t=>{
  await t.test('mixed DNS results fail closed',async t=>{
    const calls=mockNetwork(t,{addresses:[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]});
    assert.equal((await createEventVerifier({clock:()=>new Date(today)}).verify({artist,text:`${artist} ${ticket}`})).status,'needs-review');assert.equal(calls.length,0);
  });
  await t.test('public answer is pinned for both Node lookup modes',async t=>{
    const calls=mockNetwork(t);const result=await createEventVerifier({clock:()=>new Date(today)}).verify({artist,text:`${artist} ${ticket}`});assert.equal(result.status,'verified');assert.equal(calls.length,1);
    assert.deepEqual(Object.keys(calls[0].options.headers).sort(),['Accept','User-Agent']);assert.equal(calls[0].url.username,'');assert.equal(calls[0].url.password,'');
    calls[0].options.lookup('rebound.example',{all:false},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
    calls[0].options.lookup('rebound.example',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);});
  });
  await t.test('streamed oversized pages fail closed',async t=>{
    const calls=mockNetwork(t,{body:'x'.repeat(1500001)});assert.equal((await createEventVerifier({clock:()=>new Date(today)}).verify({artist,text:`${artist} ${ticket}`})).status,'needs-review');assert.equal(calls.length,1);
  });
  await t.test('announced oversized pages are rejected before their valid event body is read',async t=>{
    const calls=mockNetwork(t,{contentLength:1500001});assert.equal((await createEventVerifier({clock:()=>new Date(today)}).verify({artist,text:`${artist} ${ticket}`})).status,'needs-review');assert.equal(calls.length,1);
  });
});

test('DNS and injected page reads honor cancellation even when the underlying work never settles',async t=>{
  await t.test('an unresponsive DNS resolver has an intrinsic deadline without caller cancellation',async t=>{
    const originalTimer=globalThis.setTimeout,delays=[];
    t.mock.method(globalThis,'setTimeout',(callback,delay)=>{delays.push(delay);return originalTimer(callback,delay===12000?10:delay);});
    const calls=mockNetwork(t,{resolver:()=>new Promise(()=>{})});
    assert.equal((await createEventVerifier().verify({artist,text:`${artist} ${ticket}`})).status,'needs-review');
    assert.ok(delays.includes(12000));assert.equal(calls.length,0);
  });
  await t.test('DNS timeout cannot start a later HTTPS request',async t=>{
    let release;const pending=new Promise(resolve=>{release=resolve;});const calls=mockNetwork(t,{resolver:()=>pending});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Object.assign(new Error('Canceled'),{name:'AbortError'})),20);t.after(()=>clearTimeout(timer));
    await assert.rejects(createEventVerifier().verify({artist,text:`${artist} ${ticket}`},{signal:controller.signal}),{name:'AbortError'});
    release([{address:'8.8.8.8',family:4}]);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0);
  });
  await t.test('a hanging page seam still receives and honors the bounding signal',async t=>{
    let active;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(Object.assign(new Error('Canceled'),{name:'AbortError'})),20);t.after(()=>clearTimeout(timer));
    await assert.rejects(verifier(async(_url,{signal})=>{active=signal;return new Promise(()=>{});}).verify({artist,text:`${artist} ${ticket}`},{signal:controller.signal}),{name:'AbortError'});assert.equal(active.aborted,true);
  });
});
