import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createFeedbackHandler } from './feedback.mjs';
import {createContributionService} from './contributions-service.mjs';
import {createContributionHandler} from './contributions.mjs';
import path from 'node:path';
import { projectDir } from './config.mjs';
import { createShowSource } from './providers.mjs';
import { CityLocationProvider } from './city-locations.mjs';
import { GoogleLocationProvider, LocationError } from './locations.mjs';
import { findNearbyShows, findFutureShows } from './shows.mjs';
import { browserDateWindow, browserRangeLabels } from './browser-ranges.mjs';
import { groupFestivalResults, mergeShowSlots } from './event-groups.mjs';
import { createArtistCatalog,cleanArtistName } from './artist-catalog.mjs';
import { createArtistVerifier } from './artist-verification.mjs';
import { artistKey, parseSearchQuery, matchingArtistNames, artistMatches, looksLikeLocation, SearchInputError } from './artist-search.mjs';

class BrowserError extends Error {constructor(status,message){super(message);this.status=status;}}
function validZone(value) {
  if (typeof value!=='string'||value.length>100||!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {new Intl.DateTimeFormat('en-US',{timeZone:value});return true;}catch{return false;}
}
const bounded=(value,fallback,min,max)=>Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max?Number(value):fallback;
function configForBrowser(env) {
  const days=bounded(env.WINDOW_DAYS,7,1,31);
  const mode=['live','apps-script'].includes(env.BROWSER_SOURCE_MODE)?env.BROWSER_SOURCE_MODE:'demo';
  const spreadsheetId=env.SPREADSHEET_ID||'';
  const sheetId=String(env.SHEET_ID??'').trim()?Number(env.SHEET_ID):undefined;
  if (mode==='live' && !/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) throw new Error('SPREADSHEET_ID is required for BROWSER_SOURCE_MODE=live');
  if (sheetId!==undefined && (!Number.isInteger(sheetId)||sheetId<0||sheetId>2147483647)) throw new Error('SHEET_ID must be a nonnegative integer');
  if (mode==='apps-script' && (!env.ARTIST_CATALOG_URL||!env.ARTIST_CATALOG_SECRET)) throw new Error('ARTIST_CATALOG_URL and ARTIST_CATALOG_SECRET are required for BROWSER_SOURCE_MODE=apps-script');
  return {radiusMiles:bounded(env.RADIUS_MILES,80,1,500),days:Number.isInteger(days)?days:7,timeZone:validZone(env.TIME_ZONE)?env.TIME_ZONE:'America/Chicago',mode,snapshotFile:path.resolve(projectDir,env.BROWSER_SNAPSHOT_FILE||env.SNAPSHOT_FILE||'data/tracker-snapshot.tsv'),snapshotUpdatedAt:env.BROWSER_SNAPSHOT_UPDATED_AT,bridgeUrl:env.ARTIST_CATALOG_URL,bridgeSecret:env.ARTIST_CATALOG_SECRET,spreadsheetId,sheetId,sheetName:env.SHEET_NAME||'Upcoming Shows'};
}
function send(res,status,value,type='application/json; charset=utf-8') {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  res.end(type.startsWith('application/json')?JSON.stringify(value):value);
}
async function jsonBody(req) {
  if (!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) throw new BrowserError(415,'Expected JSON');
  if (Number(req.headers['content-length'])>8192) {req.resume();throw new BrowserError(413,'Search request is too large');}
  let size=0;const chunks=[];
  for await (const chunk of req) {size+=chunk.length;if(size>8192) throw new BrowserError(413,'Search request is too large');chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new BrowserError(400,'Invalid JSON');}
}
const publicFields=['id','artist','style','category','categories','event','type','entryCount','venue','address','city','date','dateEnd','dateLabel','startTime','timeZoneOffset','ticketUrl','ticketLinks','youtubeUrl','youtubeLinks','locationSource','locationApproximate','distanceMiles'];

/** Browser searches share show selection rules without registering a messaging
 * user, opening SQLite, or retaining the visitor's location.
 */
export function createBrowserHandler({env=process.env,source,geocoder,catalog,verifier,feedbackStore,contributionStore,contributionAI,eventVerifier,contributionService,clock=()=>new Date(),messagingReady=false}={}) {
  const config=configForBrowser(env);
  const handleFeedback=createFeedbackHandler({env,store:feedbackStore});
  source??=createShowSource(config);
  catalog??=createArtistCatalog({env});
  verifier??=createArtistVerifier();
  geocoder??=env.BROWSER_GEOCODER==='google'?new GoogleLocationProvider({apiKey:env.GOOGLE_MAPS_API_KEY}):new CityLocationProvider();
  contributionService??=createContributionService({env,store:contributionStore,ai:contributionAI,eventVerifier,catalog,verifier,source});
  const handleContribution=createContributionHandler({env,service:contributionService});
  const sourceMeta={label:'Event feed',snapshot:config.mode==='demo'};
  const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/browser/app.js',['app.js','text/javascript; charset=utf-8']],['/browser/profiles.js',['profiles.js','text/javascript; charset=utf-8']],['/browser/style.css',['style.css','text/css; charset=utf-8']]]);
  assets.set('/browser/contributions.js',['contributions.js','text/javascript; charset=utf-8']);
  assets.set('/browser/feedback.js',['feedback.js','text/javascript; charset=utf-8']);
  assets.set('/browser/whisper-client.js',['whisper-client.js','text/javascript; charset=utf-8']);
  const files=new Map();let inFlight=0;
  const queuedArtists=new Map();
  async function queueArtist(name,{signal}={}) {
    const clean=cleanArtistName(name),key=artistKey(clean),now=Date.now();
    for(const [key,value] of queuedArtists)if(value.until<=now)queuedArtists.delete(key);
    let item=queuedArtists.get(key);
    if(!item){if(queuedArtists.size>=120)return {name:clean,added:false,status:'not-saved'};item={id:randomUUID(),until:now+3600000,saved:false};queuedArtists.set(key,item);}
    if(!item.saved) {
      try {
        const receipt=await contributionService.submit({id:item.id,text:`artist: ${clean}`},{signal});
        if(receipt?.saved!==true||receipt.id!==item.id)throw Error('Unconfirmed save');
        item.saved=true;
      }catch{signal?.throwIfAborted();return {name:clean,added:false,status:'not-saved'};}
    }
    return {name:clean,added:false,status:'queued',id:item.id};
  }
  async function optionalCatalog(signal,timeoutMs) {
    if (timeoutMs<=0) return {artists:[],promoters:[],available:false};
    const deadline=AbortSignal.timeout(Math.ceil(timeoutMs));
    const limited=signal?AbortSignal.any([signal,deadline]):deadline;
    let onAbort;
    const aborted=new Promise((_,reject)=>{onAbort=()=>reject(limited.reason);limited.addEventListener('abort',onAbort,{once:true});});
    try {
      limited.throwIfAborted();
      const names=await Promise.race([catalog.load({signal:limited}),aborted]);
      return {...names,available:true};
    } catch {
      signal?.throwIfAborted();
      return {artists:[],promoters:[],available:false};
    } finally {limited.removeEventListener('abort',onAbort);}
  }
  async function registerVerifiedArtist(name,{signal,startedAt}) {
    async function boundedOperation(operation,budget) {
      const deadline=AbortSignal.timeout(Math.ceil(budget));
      const limited=signal?AbortSignal.any([signal,deadline]):deadline;
      let onAbort;
      const aborted=new Promise((_,reject)=>{onAbort=()=>reject(limited.reason);limited.addEventListener('abort',onAbort,{once:true});});
      try {limited.throwIfAborted();return await Promise.race([operation(limited),aborted]);}
      finally {limited.removeEventListener('abort',onAbort);}
    }
    const remaining=42_000-(performance.now()-startedAt);
    if (remaining<=0) return {name,added:false,status:'verification-unavailable'};
    let verification;
    try {verification=await boundedOperation(limited=>verifier.verify(name,{signal:limited}),Math.min(10_000,remaining));}
    catch {signal?.throwIfAborted();return {name,added:false,status:'verification-unavailable'};}
    signal?.throwIfAborted();
    if (verification?.status==='unavailable') return {name,added:false,status:'verification-unavailable'};
    if (verification?.status!=='verified' || artistKey(verification.name)!==artistKey(name)) return {name,added:false,status:'unverified'};
    // A verified identity is still not a confirmed save. Writes get one attempt
    // and share the search deadline; the bridge deduplicates under its lock.
    const saveBudget=42_000-(performance.now()-startedAt);
    if (saveBudget<=0) return {name,added:false,status:'not-saved'};
    try {
      return await boundedOperation(limited=>catalog.ensureArtist(verification.name,{signal:limited}),saveBudget);
    } catch {
      signal?.throwIfAborted();return {name,added:false,status:'not-saved'};
    }
  }
  async function resolveOrigin(input,{signal}={}) {
    const hasCoordinates=input.latitude!==undefined||input.longitude!==undefined;
    if (hasCoordinates) {
      if (input.location!==undefined || typeof input.latitude!=='number'||typeof input.longitude!=='number'||!Number.isFinite(input.latitude)||!Number.isFinite(input.longitude)||Math.abs(input.latitude)>90||Math.abs(input.longitude)>180) throw new BrowserError(400,'Share a valid location or enter a city');
      return {lat:input.latitude,lng:input.longitude,label:'your current location'};
    }
    if (typeof input.location!=='string'||!input.location.trim()||input.location.length>300) throw new BrowserError(400,'Share your location or enter a city and state');
    return geocoder.resolveCity?geocoder.resolveCity(input.location,{signal}):geocoder.resolve(input.location,{signal,cache:false});
  }
  async function search(input,{signal}={}) {
    const startedAt=performance.now();
    if (!input||typeof input!=='object'||Array.isArray(input)) throw new BrowserError(400,'Invalid search');
    const view=input.view||'nearby';
    if (!Object.hasOwn(browserRangeLabels,view)) throw new BrowserError(400,'Choose a supported show range');
    if (input.timeZone!==undefined && !validZone(input.timeZone)) throw new BrowserError(400,'Choose a valid time zone');
    let timeZone=input.timeZone||config.timeZone,origin,loaded,artistQuery=null,registration=null,searchKind='location';
    const hasCoordinates=input.latitude!==undefined||input.longitude!==undefined;
    if (input.query!==undefined) {
      const {query,kind}=parseSearchQuery(input.query);
      // Validate a carried location before any catalog write, even if the query
      // later replaces that location with another town.
      if (hasCoordinates || input.location!==undefined) origin=await resolveOrigin(input,{signal});
      if (kind==='location') {
        origin=await resolveOrigin({location:query},{signal});
      } else {
        loaded=await source.load({signal});
        // Event data is required; artist suggestions must not block a usable
        // city search or consume the whole remaining request deadline.
        const names=await optionalCatalog(signal,Math.max(0,Math.min(5_000,40_000-(performance.now()-startedAt))));
        const knownNames=[...names.artists,...loaded.shows.filter(show=>show.type!=='event').map(show=>show.artist)];
        const key=artistKey(query);
        const exact=knownNames.find(name=>artistKey(name)===key);
        const partial=key.length>=3?matchingArtistNames(query,knownNames):[];
        let artist=kind==='artist' || Boolean(exact) || !looksLikeLocation(query) && partial.length>0;
        if (!artist) {
          try {origin=await resolveOrigin({location:query},{signal});}
          catch(error) {
            if (!(error instanceof LocationError) || error.code!=='NOT_FOUND') throw error;
            if (looksLikeLocation(query)) throw error;
            if (!names.available) throw new BrowserError(503,'Artist names are temporarily unavailable. Use location: City or artist: Name to clarify your search.');
            if (matchingArtistNames(query,names.promoters).length) throw new BrowserError(400,'That name is in the promoter list. Enter a location or artist name.');
            artist=true;
          }
        }
        if (artist) {
          searchKind='artist';artistQuery=exact||query;
          const inCatalog=names.artists.some(name=>artistKey(name)===artistKey(artistQuery));
          // Partial queries match existing names; they are not new artists.
          if (!names.available) registration={name:artistQuery,added:false,status:'not-saved'};
          else if (!inCatalog && (exact || partial.length===0)) {
            if (matchingArtistNames(artistQuery,names.promoters).length) throw new BrowserError(400,'That name is in the promoter list. Enter a location or artist name.');
            registration=env.CONTRIBUTIONS_PROCESSING_MODE==='batch'?await queueArtist(artistQuery,{signal}):await registerVerifiedArtist(artistQuery,{signal,startedAt});
          }
        }
      }
    } else if (view!=='full') origin=await resolveOrigin(input,{signal});
    if (validZone(origin?.timeZone)) timeZone=origin.timeZone;
    loaded??=await source.load({signal});
    const shows=artistQuery?loaded.shows.filter(show=>artistMatches(show.artist,artistQuery)):loaded.shows;
    const now=clock();
    const window=browserDateWindow(view,now,timeZone,config.days);
    let found;
    if(view==='full' || artistQuery && !origin) {
      found=findFutureShows({shows,now,timeZone,signal});
      found={...found,matches:found.matches.filter(show=>show.date>=window.start && (!window.end || show.date<=window.end)),windowStart:window.start,windowEnd:window.end};
    } else found=await findNearbyShows({shows,origin,geocoder,now:window.start,timeZone,days:window.days,radiusMiles:config.radiusMiles,signal});
    const displayShows=mergeShowSlots(groupFestivalResults(found.matches));
    const result={view,rangeLabel:window.label,searchKind,artistQuery,artistRegistration:registration,shows:displayShows.map(show=>Object.fromEntries(publicFields.filter(key=>show[key]!==undefined).map(key=>[key,show[key]]))),total:displayShows.length,locationLabel:found.locationLabel||null,windowStart:found.windowStart,windowEnd:found.windowEnd||null,radiusMiles:config.radiusMiles,days:window.days,timeZone,excludedCount:found.excludedCount||0,source:{...sourceMeta,...(config.mode==='demo' && loaded.sample===true?{sample:true,label:'Fictional sample events'}:{}),...(config.mode==='demo' && (loaded.snapshotUpdatedAt || env.BROWSER_SNAPSHOT_UPDATED_AT)?{updatedAt:loaded.snapshotUpdatedAt || env.BROWSER_SNAPSHOT_UPDATED_AT}:{})},locationMethod:env.BROWSER_GEOCODER==='google'?'geocoding':'city-centers'};
    if (input.query!==undefined && searchKind==='location') {
      const parsed=parseSearchQuery(input.query);
      result.locationInput=parsed.query;
    }
    return result;
  }
  const handle=async(req,res)=>{
    if (req.method==='GET' && req.url==='/healthz') {send(res,200,{ok:true,mode:messagingReady?'live':'browser',browserReady:true,messagingReady,ready:messagingReady});return true;}
    if (await handleFeedback(req,res)) return true;
    if (await handleContribution(req,res)) return true;
    let asset=assets.get(req.url);
    const vendor=/^\/browser\/vendor\/(whisper-worker\.bundle\.js(?:\.LEGAL\.txt)?|ort-wasm-simd-threaded(?:\.jsep)?\.(?:mjs|wasm))$/.exec(req.url);
    if (vendor) asset=['vendor/'+vendor[1],vendor[1].endsWith('.wasm')?'application/wasm':vendor[1].endsWith('.txt')?'text/plain; charset=utf-8':'text/javascript; charset=utf-8'];
    if (req.method==='GET' && asset) {
      if (!files.has(asset[0])) files.set(asset[0],await readFile(path.join(projectDir,'public/browser',asset[0])));
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://huggingface.co https://*.hf.co https://cdn-lfs.huggingface.co; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://huggingface.co");
      res.setHeader('Permissions-Policy','geolocation=(self), camera=(), microphone=(self)');
      send(res,200,files.get(asset[0]),asset[1]);return true;
    }
    if (req.method==='GET' && req.url==='/api/browser/status') {send(res,200,{radiusMiles:config.radiusMiles,days:config.days,messagingReady,sourceLabel:sourceMeta.label,locationMethod:env.BROWSER_GEOCODER==='google'?'geocoding':'city-centers'});return true;}
    if (req.method==='GET' && req.url==='/api/browser/artists') {
      try {const names=await catalog.load({signal:AbortSignal.timeout(30_000)});send(res,200,{artists:names.artists});}
      catch {send(res,503,{error:'Artist names are temporarily unavailable.'});}
      return true;
    }
    if (req.url!=='/api/browser/shows') return false;
    if (req.method!=='POST') {res.setHeader('Allow','POST');send(res,405,{error:'Use POST for a browser search'});return true;}
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45_000);
    const disconnected=()=>{if(!res.writableEnded)controller.abort();};
    req.once('aborted',disconnected);res.once('close',disconnected);let counted=false;
    try {
      const origin=req.headers.origin;
      const allowed=new Set([`http://${req.headers.host}`,`https://${req.headers.host}`]);
      if (env.BROWSER_PUBLIC_ORIGIN) allowed.add(env.BROWSER_PUBLIC_ORIGIN);
      if (origin && !allowed.has(origin)) throw new BrowserError(403,'Open this app to search for shows');
      if (inFlight>=8) throw new BrowserError(429,'The app is busy. Please try again shortly.');
      inFlight++;counted=true;
      const input=await jsonBody(req),result=await search(input,{signal:controller.signal});
      if (!res.destroyed) send(res,200,result);
    } catch(error) {
      let status=error instanceof BrowserError?error.status:503;
      let message=error instanceof BrowserError?error.message:'The show feed is temporarily unavailable. Please try again.';
      if (error instanceof LocationError) {status=['NOT_FOUND','AMBIGUOUS'].includes(error.code)?400:503;message=error.message;}
      if (error instanceof SearchInputError) {status=400;message=error.message;}
      if (controller.signal.aborted && !(error instanceof BrowserError)) {status=504;message='The search took too long. Please try again.';}
      if (!res.destroyed && !res.headersSent) send(res,status,{error:message});
    } finally {clearTimeout(timeout);if(counted)inFlight--;req.off('aborted',disconnected);res.off('close',disconnected);}
    return true;
  };
  return {handle,search,config,startContributions:()=>contributionService.start(),stopContributions:()=>contributionService.stop()};
}
