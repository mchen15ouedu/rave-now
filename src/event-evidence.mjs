import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {cleanArtistName} from './artist-catalog.mjs';

const TICKET_HOSTS=['dice.fm','ra.co','residentadvisor.net','ticketmaster.com','livenation.com','axs.com','tixr.com','seetickets.us','seetickets.com','eventbrite.com','eventbrite.co.uk','ticketweb.com','posh.vip','frontgatetickets.com'];
const clean=value=>typeof value==='string'?value.normalize('NFC').replace(/\s+/gu,' ').trim():'';
const normalized=value=>clean(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const containsName=(value,name)=>{
  const escaped=normalized(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`,'u').test(normalized(value));
};
const unavailable=()=>Error('Event evidence unavailable');
const MAX_READS=5,READ_LIMIT_MS=12000;
const evidenceKeys=new WeakMap();
export function evidenceUrl(value) {
  let url;try{url=new URL(value);}catch{throw unavailable();}
  if(typeof value!=='string'||url.protocol!=='https:'||url.username||url.password||url.port||url.href.length>2048||isIP(url.hostname)||!url.hostname.includes('.')||/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(url.hostname)||[...url.searchParams.keys()].some(key=>/(?:^|[_-])(?:token|secret|authorization|auth|api[_-]?key|access[_-]?token|password|passwd|credential|signature|session|jwt|bearer|key|sig|code)(?:$|[_-])/i.test(key)||/^(?:apiToken|authToken|sessionId)$/i.test(key)))throw unavailable();
  url.hash='';return url;
}
export function publicAddress(value) {
  if(isIP(value)===4){const [a,b,c]=value.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===100&&b>=64&&b<=127||a>=224||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
  // Only ordinary global unicast. Deny mapped/translation, documentation,
  // protocol-assignment and transition ranges (IANA special-purpose registries).
  if(isIP(value)!==6||value.includes('%'))return false;
  const [first,second]=value.split(':').map(part=>parseInt(part||'0',16));
  return first>=0x2000&&first<=0x3fff&&!(first===0x2001&&(second<0x200||second===0xdb8)||first===0x2002||first===0x3ffe||first===0x3fff&&second<0x1000);
}
const hostMatches=(host,base)=>host===base||host.endsWith('.'+base);
function trusted(url,officialUrls=[]) {
  if(TICKET_HOSTS.some(host=>hostMatches(url.hostname,host)))return true;
  return officialUrls.some(value=>{try{return hostMatches(url.hostname,evidenceUrl(value).hostname);}catch{return false;}});
}
async function limited(work,{signal,timeoutMs=READ_LIMIT_MS}={}) {
  signal?.throwIfAborted();
  const controller=new AbortController();let timer,onAbort;
  const canceled=new Promise((_,reject)=>{
    onAbort=()=>{controller.abort(signal?.reason||unavailable());reject(signal?.reason||unavailable());};
    signal?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>{controller.abort(unavailable());reject(unavailable());},timeoutMs);
  });
  try{return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work(controller.signal);}),canceled]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}
async function pinnedGet(url,{signal,resolver=lookup,maxBytes=1_500_000,timeoutMs=12000}={}) {
  return limited(async activeSignal=>{
    const addresses=await resolver(url.hostname,{all:true});
    activeSignal.throwIfAborted();
    if(!Array.isArray(addresses)||!addresses.length||addresses.some(value=>!publicAddress(value.address)||isIP(value.address)!==value.family))throw unavailable();
    const address=addresses[0];
    return new Promise((resolve,reject)=>{
      let request,total=0,settled=false;
      const cancel=()=>request?.destroy(unavailable());
      const finish=(error,result)=>{if(settled)return;settled=true;activeSignal.removeEventListener('abort',cancel);if(error)reject(unavailable());else resolve(result);};
      request=https.get(url,{headers:{'User-Agent':'RaveNow/0.1 (+https://github.com/mchen15ouedu/rave-now)','Accept':'text/html,application/xhtml+xml'},lookup:(_host,options,callback)=>options?.all?callback(null,[address]):callback(null,address.address,address.family)},response=>{
        const chunks=[];
        if(Number(response.headers['content-length'])>maxBytes){response.destroy();finish(unavailable());return;}
        response.on('data',chunk=>{if(settled)return;total+=chunk.length;if(total>maxBytes){response.destroy();finish(unavailable());return;}chunks.push(chunk);});
        response.once('error',()=>finish(unavailable()));
        response.once('aborted',()=>finish(unavailable()));
        response.once('end',()=>finish(null,{status:response.statusCode,location:response.headers.location,contentType:response.headers['content-type']||'',html:Buffer.concat(chunks).toString('utf8')}));
      });
      activeSignal.addEventListener('abort',cancel,{once:true});
      request.once('error',()=>finish(unavailable()));if(activeSignal.aborted)cancel();
    });
  },{signal,timeoutMs});
}
const entities=value=>value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
function objectsFromHtml(html) {
  const objects=[];let nodes=0;
  const walk=(value,depth=0)=>{
    if(depth>10||++nodes>2000)throw unavailable();
    if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return;}
    if(!value||typeof value!=='object')return;
    objects.push(value);
    for(const child of Object.values(value))if(child&&typeof child==='object')walk(child,depth+1);
  };
  const scripts=[...html.matchAll(/<script(?=[\s>])((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/gi)].filter(script=>{
    const attributes=[...script[1].matchAll(/([^\s=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)];
    const type=attributes.find(attribute=>attribute[1].toLowerCase()==='type');
    return type&&String(type[2]??type[3]??type[4]??'').trim().toLowerCase()==='application/ld+json';
  });
  if(scripts.length>40)throw unavailable();
  for(const script of scripts){let parsed;try{parsed=JSON.parse(script[2].trim());}catch{continue;}walk(parsed);}
  return objects;
}
const textValue=value=>typeof value==='string'?clean(value):clean(value?.name);
const dateKey=value=>{
  if(typeof value!=='string')return null;
  const match=value.match(/^\d{4}-\d{2}-\d{2}(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/);
  if(!match||match[1]&&(Number(match[1])>23||Number(match[2])>59||Number(match[3]||0)>59))return null;
  if(match[4]&&match[4]!=='Z'){const [hour,minute]=match[4].slice(1).split(':').map(Number);if(hour>14||minute>59||hour===14&&minute!==0)return null;}
  const key=value.slice(0,10),date=new Date(key+'T12:00:00Z');
  return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===key?key:null;
};
const MONTH_NAMES='Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const monthNumber=name=>['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(name.slice(0,3).toLowerCase())+1;
function transcriptDates(text) {
  const dates=[...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].map(match=>({year:Number(match[1]),month:Number(match[2]),day:Number(match[3])}));
  for(const match of text.matchAll(new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`,'gi')))dates.push({year:match[3]?Number(match[3]):null,month:monthNumber(match[1]),day:Number(match[2])});
  for(const match of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?(?:\\s*,?\\s*(\\d{4}))?\\b`,'gi')))dates.push({year:match[3]?Number(match[3]):null,month:monthNumber(match[2]),day:Number(match[1])});
  for(const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const left=Number(match[1]),right=Number(match[2]),year=Number(match[3]);
    const american=left>=1&&left<=12&&right>=1&&right<=31,european=right>=1&&right<=12&&left>=1&&left<=31;
    if(american)dates.push({year,month:left,day:right});
    if(european&&(!american||left!==right))dates.push({year,month:right,day:left});
    if(!american&&!european)dates.push({year,month:0,day:0});
  }
  return dates;
}
export function transcriptDateConflicts(text,date) {
  const key=dateKey(date);
  if(typeof text!=='string'||!key)return true;
  const [year,month,day]=key.split('-').map(Number);
  return transcriptDates(text).some(value=>value.year!==null&&value.year!==year||value.month!==month||value.day!==day);
}
export function transcriptDateMatches(text,date) {
  const key=dateKey(date);
  if(typeof text!=='string'||!key)return false;
  const [year,month,day]=key.split('-').map(Number);
  return transcriptDates(text).some(value=>value.year===year&&value.month===month&&value.day===day);
}
export function verifiedEventsFromHtml(html,{artist,sourceUrl,text='',directLink=true,today=new Date().toISOString().slice(0,10)}={}) {
  if(typeof html!=='string'||Buffer.byteLength(html)>1_500_000)throw unavailable();
  artist=cleanArtistName(artist);if(typeof text!=='string'||text.length>2000||!dateKey(today))throw unavailable();
  const source=evidenceUrl(sourceUrl),events=[];
  for(const value of objectsFromHtml(html)) {
    const types=Array.isArray(value['@type'])?value['@type']:[value['@type']];
    if(!types.some(type=>typeof type==='string'&&/^(?:https?:\/\/schema\.org\/)?(?:Event|MusicEvent|Festival)$/.test(type)))continue;
    if(value.eventStatus&&!/^(?:https?:\/\/schema\.org\/)?EventScheduled$/.test(value.eventStatus))continue;
    const date=dateKey(value.startDate);if(!date||date<today)continue;
    if(value.endDate&&(!dateKey(value.endDate)||dateKey(value.endDate)<date))continue;
    if(value.endDate&&/T/.test(value.startDate)&&/T/.test(value.endDate)&&/[Zz]|[+-]\d{2}:\d{2}$/.test(value.startDate)&&/[Zz]|[+-]\d{2}:\d{2}$/.test(value.endDate)&&new Date(value.endDate)<new Date(value.startDate))continue;
    const event=textValue(value.name),venue=textValue(value.location),address=value.location?.address;
    const locality=clean(address?.addressLocality),region=clean(address?.addressRegion),country=textValue(address?.addressCountry);
    const qualified=values=>{
      const seen=new Set();
      return values.flatMap(value=>value.split(',').map(clean)).filter(value=>{const key=normalized(value);if(!key||seen.has(key))return false;seen.add(key);return true;}).join(', ');
    };
    const city=qualified([locality,region,country]);
    if(/\b(?:cancelled|canceled|postponed)\b/i.test(event))continue;
    const performers=(Array.isArray(value.performer)?value.performer:[value.performer]).map(textValue).filter(Boolean);
    const names=performers.length?performers:[event];
    if(!names.some(name=>containsName(name,artist))||!event||event.length>200||!venue||venue.length>200||!locality||!city||city.length>160)continue;
    if(!directLink&&(!transcriptDateMatches(text,date)||!containsName(text,locality)))continue;
    // An explicitly supplied full calendar date must match the cited event.
    if(transcriptDateConflicts(text,date))continue;
    const offers=Array.isArray(value.offers)?value.offers:[value.offers];
    let ticketUrl=source.href;
    for(const offer of offers){try{const candidate=evidenceUrl(offer?.url);if(trusted(candidate)){ticketUrl=candidate.href;break;}}catch{}}
    const street=clean(address?.streetAddress),postal=clean(address?.postalCode);
    const fullAddress=street?[street,qualified([locality,region,postal,country])].join(', '):'';
    if(fullAddress.length>300)continue;
    const result={artist:cleanArtistName(artist),event,venue,city,address:fullAddress,date,ticketUrl,youtubeUrl:'https://www.youtube.com/results?search_query='+encodeURIComponent(artist),sourceUrl:source.href};
    if(Object.values(result).some(value=>/[\p{Cc}\p{Cf}]/u.test(value)))continue;
    const start=/[Zz]|[+-]\d{2}:\d{2}$/.test(value.startDate)?new Date(value.startDate).toISOString():value.startDate;
    const key=JSON.stringify([start,normalized(event),normalized(venue),normalized(city),normalized(fullAddress),normalized(region),normalized(country)]);
    evidenceKeys.set(result,key);
    if(!events.some(existing=>evidenceKeys.get(existing)===key))events.push(result);
  }
  return events;
}

export function createEventVerifier({getPage=pinnedGet,clock=()=>new Date()}={}) {
  return {
    async verify({artist,text,officialUrls=[]},{signal}={}) {
      signal?.throwIfAborted();
      try{artist=cleanArtistName(artist);}catch{return {status:'needs-review'};}
      if(typeof text!=='string'||text.length>2000||!Array.isArray(officialUrls)||officialUrls.length>100)return {status:'needs-review'};
      // officialUrls is independently obtained from verified artist relations or
      // owner-controlled tracker rows. Never populate it from submitted text.
      const submitted=[...text.matchAll(/https:\/\/[^\s<>"']+/g)].map(match=>match[0].replace(/[),.;!?]+$/,''));
      if(submitted.length>MAX_READS)return {status:'needs-review'};
      const candidates=[];
      for(const link of submitted.slice(0,5)){try{const url=evidenceUrl(link);if(trusted(url,officialUrls))candidates.push({url,direct:true});}catch{}}
      if(!submitted.length)for(const link of officialUrls.slice(0,2)){try{const url=evidenceUrl(link);if(trusted(url,officialUrls))candidates.push({url,direct:false});}catch{}}
      const found=[];let readCount=0;const visited=new Set();
      while(candidates.length&&readCount<MAX_READS) {
        signal?.throwIfAborted();let {url,direct}=candidates.shift();
        try {
          for(let redirects=0;redirects<4&&readCount<MAX_READS;redirects++) {
            if(visited.has(url.href))break;visited.add(url.href);
            signal?.throwIfAborted();readCount++;
            const page=await limited(activeSignal=>getPage(url,{signal:activeSignal}),{signal});
            if([301,302,303,307,308].includes(page.status)) {
              if(typeof page.location!=='string'||!page.location.trim())throw unavailable();
              url=evidenceUrl(new URL(page.location,url).href);if(!trusted(url,officialUrls))throw unavailable();continue;
            }
            if(page.status!==200||typeof page.contentType!=='string'||!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.contentType))throw unavailable();
            found.push(...verifiedEventsFromHtml(page.html,{artist,sourceUrl:url.href,text,directLink:direct,today:new Date(clock()).toISOString().slice(0,10)}));
            if(!direct) {
              const links=[...page.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(match=>entities(match[1]));
              for(const link of links.filter(link=>/tour|shows?|events?|tickets?/i.test(link)).slice(0,3)) {
                try {const next=evidenceUrl(new URL(link,url).href);if(trusted(next,officialUrls)&&next.href!==url.href)candidates.push({url:next,direct:false});}catch{}
              }
            }
            break;
          }
        }catch{signal?.throwIfAborted();}
      }
      const unique=found.filter((value,index,all)=>all.findIndex(other=>evidenceKeys.get(other)===evidenceKeys.get(value))===index);
      return unique.length===1?{status:'verified',event:unique[0]}:{status:'needs-review'};
    },
  };
}
