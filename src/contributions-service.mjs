import {randomUUID} from 'node:crypto';
import {createContributionsStore,cleanContribution} from './contributions-store.mjs';
import {createContributionAI,parseArtistExtraction} from './contributions-ai.mjs';
import {createEventVerifier,evidenceUrl,transcriptDateConflicts,transcriptDateMatches} from './event-evidence.mjs';
import {normalizeArtistName} from './artist-catalog.mjs';
import {parseShowDate} from './shows.mjs';

const same=(left,right)=>normalizeArtistName(left)===normalizeArtistName(right);
const phrase=value=>typeof value==='string'?value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim():'';
const mentions=(text,value)=>Boolean(phrase(value)&&(' '+phrase(text)+' ').includes(' '+phrase(value)+' '));
const normalizedUrl=value=>{try{return evidenceUrl(value).href;}catch{return null;}};
const explicitUrls=text=>[...text.matchAll(/https:\/\/[^\s<>"']+/g)].map(match=>normalizedUrl(match[0].replace(/[),.;!?]+$/,''))).filter(Boolean);

/** Extract candidates with HF AI; only independent music records and primary
 * event evidence authorize tracker mutations. No AI-created fact is published. */
export async function processContribution(record,{ai,verifier,catalog,eventVerifier,signal,checkpoint=async()=>{},onEventsChanged=()=>{}}) {
  let result={message:'Checking the submitted artist.',artistStatus:'pending',eventStatus:'not-requested'};
  const review=message=>({status:'needs-review',result:{...result,message}});
  try {
    const extracted=await ai.extract(record.text,{signal});signal?.throwIfAborted();
    const extraction=parseArtistExtraction(JSON.stringify(extracted),record.text);
    if(!extraction.artist)return review('The artist name was unclear. Submit one DJ or artist name, with an event link if you have a show to add.');
    result.artistName=extraction.artist;
    const verification=await verifier.verify(extraction.artist,{signal});signal?.throwIfAborted();
    if(verification.status!=='verified'||!same(verification.name,extraction.artist)) {
      result.artistStatus=verification.status==='unavailable'?'unavailable':'unverified';
      return review(verification.status==='unavailable'?'Artist verification was unavailable. Your submission is saved for review.':'We could not independently verify this music artist. Your submission is saved for review; no artist was added.');
    }
    result.artistName=verification.name;
    result.sourceUrls=verification.sourceUrl?[verification.sourceUrl]:[];
    const names=await catalog.load({signal});signal?.throwIfAborted();
    const exists=names.artists.some(name=>same(name,verification.name));
    if(exists)result.artistStatus='existing';
    else {
      const receipt=await catalog.ensureArtist(verification.name,{signal});signal?.throwIfAborted();
      if(!receipt||typeof receipt.added!=='boolean'||!same(receipt.name,verification.name))throw Error('Unconfirmed artist save');
      result.artistStatus=receipt.added?'added':'existing';
    }
    const artistMessage=result.artistStatus==='added'?`${verification.name} was added to Artist List.`:`${verification.name} is already in Artist List.`;
    if(!extraction.hasEvent)return {status:'completed',result:{...result,message:artistMessage}};
    result.eventStatus='pending';result.message=artistMessage+' Checking the event information.';
    await checkpoint(result);signal?.throwIfAborted();
    // Owner-maintained tracker links are independent trusted venue sources.
    const {rows}=await catalog.readShows({signal});signal?.throwIfAborted();
    const headers=rows[0],at=(row,header)=>row[headers.indexOf(header)]||'';
    const artistRows=rows.slice(1).filter(row=>{try{return same(at(row,'Artist'),verification.name);}catch{return false;}});
    const supplied=explicitUrls(record.text);
    const existing=artistRows.filter(row=>{
      const url=normalizedUrl(at(row,'Ticket Link')),date=parseShowDate(at(row,'Show Time'));
      return url&&supplied.includes(url)&&date&&transcriptDateMatches(record.text,date)&&!transcriptDateConflicts(record.text,date)&&mentions(record.text,at(row,'Location'))&&mentions(record.text,at(row,'City'));
    });
    if(existing.length===1) {
      result.eventStatus='existing';
      const source=normalizedUrl(at(existing[0],'Ticket Link'));if(source&&!result.sourceUrls.includes(source))result.sourceUrls.push(source);
      return {status:'completed',result:{...result,message:artistMessage+' The linked event is already in the tracker.'}};
    }
    const officialUrls=[...(verification.officialUrls||[]),...artistRows.map(row=>normalizedUrl(at(row,'Ticket Link'))).filter(Boolean)].slice(0,30);
    const evidence=await eventVerifier.verify({artist:verification.name,text:record.text,officialUrls},{signal});signal?.throwIfAborted();
    if(evidence.status!=='verified') {
      result.eventStatus='needs-review';return review(artistMessage+' We could not confirm one matching upcoming show from a primary source. Your event details are saved for review. Include an official event or ticket link to help verification.');
    }
    const event=evidence.event;
    if(!event||!same(event.artist,verification.name)||!normalizedUrl(event.sourceUrl))throw Error('Invalid event evidence');
    const receipt=await catalog.ensureEvent(event,{signal});signal?.throwIfAborted();
    if(!receipt||!['added','merged','exists','conflict'].includes(receipt.status))throw Error('Unconfirmed event save');
    result.sourceUrls=[...new Set([...result.sourceUrls,event.sourceUrl])].slice(0,10);
    if(receipt.status==='conflict'){result.eventStatus='needs-review';return review(artistMessage+' A conflicting event entry needs review. Existing event information was kept.');}
    result.eventStatus=receipt.status==='exists'?'existing':receipt.status;
    if(receipt.status==='added'||receipt.status==='merged')onEventsChanged();
    const action=receipt.status==='added'?'The verified event was added to the tracker.':receipt.status==='merged'?'Verified missing event details were merged into its existing entry.':'The event is already in the tracker.';
    return {status:'completed',result:{...result,message:artistMessage+' '+action}};
  }catch(error) {
    if(signal?.aborted)throw error;
    if(result.artistStatus==='pending')result.artistStatus='unavailable';
    if(result.eventStatus==='pending')result.eventStatus='unavailable';
    return review(result.artistStatus==='added'||result.artistStatus==='existing'?'The artist was confirmed, but the remaining event update could not be confirmed. Your submitted details are saved for review.':'Verification or saving could not be confirmed. Your submission is saved for review.');
  }
}

export function createContributionService({env=process.env,store,ai,verifier,catalog,eventVerifier,source,intervalMs=60000,jobTimeoutMs=360000}={}) {
  store??=createContributionsStore({env});ai??=createContributionAI({env});eventVerifier??=createEventVerifier();
  const enabled=env.CONTRIBUTIONS_WORKER_ENABLED==='true';
  let timer,running,controller,stopped=false;
  const statusCache=new Map();
  async function drain() {
    if(stopped||!enabled||running)return running;
    running=(async()=>{
      try {
        const pending=await store.pending({limit:3,signal:AbortSignal.timeout(30000)});
        for(const item of pending) {
          if(stopped)break;
          const owner=randomUUID();
          const record=await store.claim(item.id,{owner,leaseMs:420000,signal:AbortSignal.timeout(30000)});
          if(stopped)break;
          if(!record)continue;
          statusCache.delete(item.id);
          controller=new AbortController();
          const timeout=setTimeout(()=>controller?.abort(),Math.min(360000,jobTimeoutMs));
          try {
            const outcome=await processContribution(record,{ai,verifier,catalog,eventVerifier,signal:controller.signal,onEventsChanged:()=>source?.invalidate?.(),checkpoint:async result=>{await store.update(record.id,{status:'processing',result},{owner,signal:controller.signal});statusCache.delete(record.id);}});
            if(!stopped)await store.update(record.id,outcome,{owner,signal:AbortSignal.timeout(30000)});
          }catch {
            // Interruption leaves a persisted lease for restart recovery. A
            // later attempt rechecks catalog identities before writing again.
          }finally{clearTimeout(timeout);controller=null;statusCache.delete(record.id);}
        }
      }catch{/* The durable inbox retains work during a provider outage. */}
    })();
    try{await running;}finally{running=null;}
  }
  return {
    async submit(input,{signal}={}) {
      const clean=cleanContribution(input),result=await store.submit(clean,{signal});
      if(result?.saved!==true||result.id!==clean.id)throw Error('Unconfirmed save');
      statusCache.delete(result.id);void drain();return result;
    },
    async status(id,{signal}={}) {
      const cached=statusCache.get(id);if(cached&&cached.until>Date.now())return {...cached.value};
      const record=await store.get(id,{signal});if(!record)return null;
      const value={id:record.id,status:record.status,message:record.result?.message||(record.status==='processing'?'Checking the artist and event details.':'Waiting for processing.')};
      if(statusCache.size>=1000)statusCache.delete(statusCache.keys().next().value);
      statusCache.set(id,{until:Date.now()+3000,value});return {...value};
    },
    start(){if(!enabled||timer)return;stopped=false;timer=setInterval(()=>void drain(),Math.max(1000,intervalMs));timer.unref();void drain();},
    async stop(){stopped=true;clearInterval(timer);timer=null;controller?.abort();ai.close?.();await running;},
    drain,
  };
}
