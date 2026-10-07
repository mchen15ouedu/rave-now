import test from 'node:test';
import assert from 'node:assert/strict';
import { processContribution, createContributionService } from '../src/contributions-service.mjs';

const id='20b0baf4-2d28-4781-9a4a-3d8f036e8cd2',otherId='30b0baf4-2d28-4781-9a4a-3d8f036e8cd2';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const artist='Tiësto',musicSource='https://musicbrainz.org/artist/20b0baf4-2d28-4781-9a4a-3d8f036e8cd2';
const ticket='https://www.ticketmaster.com/event/example-show';
const headers=['Artist','Event','Location','City','Address','Ticket Link','Show Time','YouTube (Most Popular Song)'];
const record=(patch={})=>({id,text:'Please add Tiësto.',submittedUtc:'2026-10-07T12:00:00.000Z',updatedUtc:'2026-10-07T12:00:00.000Z',status:'queued',lease:null,result:null,...patch});
const event={artist,event:'Example Show',venue:'Example Club',city:'Dallas, TX',address:'',date:'2026-10-30',ticketUrl:ticket,youtubeUrl:'',sourceUrl:ticket};
const eventText=`Please add Tiësto and the show on 2026-10-30: ${ticket}`;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

function processor(options={}) {
  const calls={extract:[],verify:[],load:0,invalidates:0,artists:[],shows:0,events:[],checkpoints:[],changed:0};
  const names=[...(options.artists||[])];
  const dependencies={
    ai:{extract:async(text,{signal}={})=>{calls.extract.push({text,signal});return options.extraction??{artist,hasEvent:false};}},
    verifier:{verify:async(name,{signal}={})=>{calls.verify.push({name,signal});return options.verification??{status:'verified',name:artist,sourceUrl:musicSource,officialUrls:['https://www.tiesto.com/']};}},
    catalog:{
      load:async()=>{calls.load++;return {artists:[...names]};},
      invalidate:()=>{calls.invalidates++;},
      ensureArtist:async(name,{signal}={})=>{calls.artists.push({name,signal});if(options.artistError)throw options.artistError;if(Object.hasOwn(options,'artistReceipt'))return options.artistReceipt;const added=!names.includes(name);if(added)names.push(name);return {name,added};},
      readShows:async()=>{calls.shows++;return {rows:options.rows??[headers]};},
      ensureEvent:async(value,{signal}={})=>{calls.events.push({value:structuredClone(value),signal});if(options.eventError)throw options.eventError;return Object.hasOwn(options,'eventReceipt')?options.eventReceipt:{status:'added',row:2,event:value};},
    },
    eventVerifier:{verify:async(input,{signal}={})=>{calls.eventVerification={input:structuredClone(input),signal};return options.evidence??{status:'verified',event};}},
    checkpoint:async value=>calls.checkpoints.push(structuredClone(value)),
    onEventsChanged:()=>{calls.changed++;},
  };
  return {calls,dependencies};
}

test('one submitted real artist is independently verified before adding and event work is skipped',async()=>{
  const {calls,dependencies}=processor();
  const outcome=await processContribution(record(),dependencies);
  assert.equal(outcome.status,'completed');assert.equal(outcome.result.artistStatus,'added');assert.equal(outcome.result.eventStatus,'not-requested');
  assert.match(outcome.result.message,/added to Artist List/);
  assert.deepEqual(outcome.result.sourceUrls,[musicSource]);assert.equal(calls.artists[0].name,artist);
  assert.equal(calls.shows,0);assert.equal(calls.events.length,0);assert.equal(calls.checkpoints.length,0);assert.equal(calls.changed,0);
});

test('missing, malformed, or hallucinated extraction never reaches a catalog mutation',async()=>{
  for(const extraction of [{artist:null,hasEvent:false},null,{},[],{artist,hasEvent:'true'},{artist:'Carl Cox',hasEvent:false},{artist,hasEvent:false,token:'private'},{artist:'Tiësto\nFake',hasEvent:false}]) {
    const {calls,dependencies}=processor({extraction});
    dependencies.ai.extract=async()=>extraction;
    const outcome=await processContribution(record(),dependencies);
    assert.equal(outcome.status,'needs-review');assert.notEqual(outcome.result.artistStatus,'added');
    assert.equal(calls.verify.length,0);assert.equal(calls.load,0);assert.equal(calls.artists.length,0);assert.equal(calls.events.length,0);
  }
});

test('unverified, unavailable or mismatched independent identity stays saved for review without writes',async()=>{
  for(const verification of [{status:'unverified'},{status:'unavailable'},{status:'verified',name:'Carl Cox'},null]) {
    const {calls,dependencies}=processor({verification});dependencies.verifier.verify=async()=>verification;
    const outcome=await processContribution(record(),dependencies);
    assert.equal(outcome.status,'needs-review');assert.notEqual(outcome.result.artistStatus,'added');
    assert.equal(calls.load,0);assert.equal(calls.artists.length,0);assert.equal(calls.events.length,0);
  }
});

test('known artist comparison tolerates accents and casing while avoiding duplicate additions',async()=>{
  const {calls,dependencies}=processor({artists:['TIESTO']});
  const outcome=await processContribution(record(),dependencies);
  assert.equal(outcome.status,'completed');assert.equal(outcome.result.artistStatus,'existing');
  assert.match(outcome.result.message,/already in Artist List/);assert.equal(calls.artists.length,0);
});

test('unconfirmed artist receipts and provider exceptions report review honestly without leaking errors',async()=>{
  for(const options of [{artistReceipt:null},{artistReceipt:{name:'Carl Cox',added:true}},{artistReceipt:{name:artist,added:'true'}},{artistError:new Error('hf_'+'sensitiveprovidersecret123456 private-provider URL')}]) {
    const {calls,dependencies}=processor(options);
    const outcome=await processContribution(record({text:eventText}),dependencies);
    assert.equal(outcome.status,'needs-review');assert.equal(outcome.result.artistStatus,'unavailable');
    assert.equal(calls.events.length,0);assert.equal(calls.shows,0);assert.equal(calls.artists.length,1);
    assert.doesNotMatch(JSON.stringify(outcome),/hf_sensitive|private-provider/);assert.doesNotMatch(outcome.result.message,/was added/);
  }
});

test('lost artist receipts reconcile with one fresh read and never repeat the mutation',async()=>{
  for(const withEvent of [false,true])for(const invalidReceipt of [false,true]) {
    const {calls,dependencies}=processor();let persisted=false,invalidated=false;
    dependencies.catalog.load=async()=>{calls.load++;if(calls.load===2)assert.equal(invalidated,true);return {artists:persisted&&invalidated?['TIESTO']:[]};};
    dependencies.catalog.invalidate=()=>{calls.invalidates++;invalidated=true;};
    dependencies.catalog.ensureArtist=async(name,{signal}={})=>{
      calls.artists.push({name,signal});persisted=true;
      if(invalidReceipt)return {name,added:'unconfirmed'};
      throw Error('private-provider response unavailable');
    };
    const outcome=await processContribution(record(withEvent?{text:eventText}:{}),dependencies);
    assert.equal(outcome.status,'completed');assert.equal(outcome.result.artistStatus,'existing');
    assert.match(outcome.result.message,/already in Artist List/);assert.doesNotMatch(outcome.result.message,/was added to Artist List|private-provider/);
    assert.equal(calls.artists.length,1);assert.equal(calls.load,2);assert.equal(calls.invalidates,1);
    assert.equal(calls.events.length,withEvent?1:0);assert.equal(outcome.result.eventStatus,withEvent?'added':'not-requested');
    assert.deepEqual(calls.checkpoints.map(value=>value.artistStatus),withEvent?['existing']:[]);
  }
});

test('missing or unavailable fresh catalog reads retain unconfirmed artist writes for review',async()=>{
  for(const fresh of [[],['Carl Cox'],null,'unavailable']) {
    const {calls,dependencies}=processor({artistError:Error('private-provider write unavailable')});
    dependencies.catalog.load=async()=>{
      calls.load++;if(calls.load===1)return {artists:[]};assert.equal(calls.invalidates,1);
      if(fresh==='unavailable')throw Error('private-provider fresh read unavailable');
      return {artists:fresh};
    };
    const outcome=await processContribution(record({text:eventText}),dependencies);
    assert.equal(outcome.status,'needs-review');assert.equal(outcome.result.artistStatus,'unavailable');
    assert.equal(calls.artists.length,1);assert.equal(calls.load,2);assert.equal(calls.invalidates,1);
    assert.equal(calls.events.length,0);assert.equal(calls.shows,0);assert.equal(calls.checkpoints.length,0);
    assert.doesNotMatch(JSON.stringify(outcome),/private-provider|was added|already in Artist List/);
  }
});

test('cancellation during artist reconciliation prevents every later read or event write',async()=>{
  for(const stage of ['write','invalidate','read']) {
    const controller=new AbortController(),{calls,dependencies}=processor();dependencies.signal=controller.signal;
    dependencies.catalog.ensureArtist=async(name,{signal}={})=>{calls.artists.push({name,signal});if(stage==='write')controller.abort();throw Error('write response unavailable');};
    dependencies.catalog.invalidate=()=>{calls.invalidates++;if(stage==='invalidate')controller.abort();};
    dependencies.catalog.load=async()=>{calls.load++;if(calls.load===1)return {artists:[]};controller.abort();return {artists:[artist]};};
    await assert.rejects(processContribution(record({text:eventText}),dependencies),error=>error.name==='AbortError');
    assert.equal(calls.artists.length,1);assert.equal(calls.invalidates,stage==='write'?0:1);assert.equal(calls.load,stage==='read'?2:1);
    assert.equal(calls.events.length,0);assert.equal(calls.shows,0);assert.equal(calls.checkpoints.length,0);
  }
  for(const error of [new DOMException('cancelled','AbortError'),Object.assign(Error('cancelled'),{code:'CANCELLED'})]) {
    const {calls,dependencies}=processor({artistError:error});
    const outcome=await processContribution(record(),dependencies);
    assert.equal(outcome.status,'needs-review');assert.equal(calls.invalidates,0);assert.equal(calls.load,1);assert.equal(calls.artists.length,1);
  }
});

test('explicit event language cannot be dropped by AI and checkpoints precede event mutations',async()=>{
  const {calls,dependencies}=processor({extraction:{artist,hasEvent:false}});
  dependencies.catalog.ensureEvent=async value=>{
    assert.equal(calls.checkpoints.length,1);assert.equal(calls.checkpoints[0].artistStatus,'added');assert.equal(calls.checkpoints[0].eventStatus,'pending');
    calls.events.push({value});return {status:'added',row:2,event:value};
  };
  const outcome=await processContribution(record({text:eventText}),dependencies);
  assert.equal(outcome.status,'completed');assert.equal(outcome.result.eventStatus,'added');assert.equal(calls.events.length,1);assert.equal(calls.changed,1);
  assert.deepEqual(calls.eventVerification.input.officialUrls,['https://www.tiesto.com/']);
});

test('one owner-maintained linked artist/date event is existing without a research or write retry',async()=>{
  const row=[artist,'Example Show','Example Club','Dallas, TX','',ticket,'2026-10-30',''];
  const {calls,dependencies}=processor({artists:[artist],rows:[headers,row]});
  const outcome=await processContribution(record({text:`Please add Tiësto at Example Club in Dallas, TX on October 30, 2026: ${ticket}`}),dependencies);
  assert.equal(outcome.status,'completed');assert.equal(outcome.result.artistStatus,'existing');assert.equal(outcome.result.eventStatus,'existing');
  assert.equal(calls.artists.length,0);assert.equal(calls.events.length,0);assert.equal(calls.eventVerification,undefined);assert.equal(calls.changed,0);
  assert.ok(outcome.result.sourceUrls.includes(ticket));
});

test('contradictory English or numeric dates cannot bypass primary event verification',async()=>{
  const row=[artist,'Example Show','Example Club','Dallas, TX','',ticket,'2026-10-30',''];
  for(const date of ['October 31, 2026','31 October 2026','10/31/2026','30/11/2026','2026-11-30']) {
    const {calls,dependencies}=processor({artists:[artist],rows:[headers,row],evidence:{status:'unverified'}});
    const outcome=await processContribution(record({text:`Please add Tiësto show at Example Club in Dallas, TX on ${date}: ${ticket}`}),dependencies);
    assert.equal(outcome.status,'needs-review');assert.equal(outcome.result.eventStatus,'needs-review');
    assert.ok(calls.eventVerification);assert.equal(calls.events.length,0);assert.equal(calls.changed,0);
  }
});

test('longer or unrelated tracker artist names cannot confirm events or seed trusted source domains',async()=>{
  const unrelatedTicket='https://unrelatedvenue.com/events/another-artist';
  const rows=[headers,[artist+' Collective','Example Show','Example Club','Dallas, TX','',ticket,'2026-10-30',''],['Other '+artist,'Other Show','Other Club','Dallas, TX','',unrelatedTicket,'2026-10-30','']];
  const {calls,dependencies}=processor({artists:[artist],rows,evidence:{status:'unverified'}});
  const outcome=await processContribution(record({text:`Please add Tiësto at Example Club in Dallas, TX on 2026-10-30: ${ticket}`}),dependencies);
  assert.equal(outcome.status,'needs-review');assert.equal(outcome.result.eventStatus,'needs-review');
  assert.deepEqual(calls.eventVerification.input.officialUrls,['https://www.tiesto.com/']);
  assert.equal(calls.events.length,0);assert.equal(calls.changed,0);
});

test('a general ticket link or partial place/date details cannot acknowledge a different existing show',async()=>{
  const general='https://www.tiesto.com/tour';
  const row=[artist,'Example Show','Example Club','Dallas, TX','',general,'2030-10-30',''];
  for(const details of [
    'this weekend at Example Club in Dallas, TX',
    'October 30 at Example Club in Dallas, TX',
    '2030-10-30',
    '2030-10-30 at Example Club',
    '2030-10-30 in Dallas, TX',
    '2030-10-30 at Example Clubhouse in Dallas, TX',
    '2030-10-30 at Example Club in Dallas, MO',
  ]) {
    const {calls,dependencies}=processor({artists:[artist],rows:[headers,row],evidence:{status:'unverified'}});
    const outcome=await processContribution(record({text:`Please add Tiësto show ${details}: ${general}`}),dependencies);
    assert.equal(outcome.status,'needs-review');assert.equal(outcome.result.eventStatus,'needs-review');
    assert.ok(calls.eventVerification);assert.equal(calls.events.length,0);
  }
});

test('verified event added/merged/exists/conflict receipts produce accurate status and preserve conflicts',async()=>{
  for(const receipt of ['added','merged','exists','conflict']) {
    const {calls,dependencies}=processor({artists:[artist],eventReceipt:{status:receipt,row:2,event}});
    const outcome=await processContribution(record({text:eventText}),dependencies);
    assert.equal(calls.events.length,1);assert.deepEqual(calls.events[0].value,event);
    assert.equal(outcome.result.eventStatus,receipt==='exists'?'existing':receipt==='conflict'?'needs-review':receipt);
    assert.equal(outcome.status,receipt==='conflict'?'needs-review':'completed');
    assert.equal(calls.changed,['added','merged'].includes(receipt)?1:0);
    if(receipt==='conflict')assert.match(outcome.result.message,/Existing event information was kept/);
  }
});

test('no primary event evidence retains the contribution for review without adding event facts',async()=>{
  const {calls,dependencies}=processor({artists:[artist],evidence:{status:'unverified'}});
  const outcome=await processContribution(record({text:eventText}),dependencies);
  assert.equal(outcome.status,'needs-review');assert.equal(outcome.result.artistStatus,'existing');assert.equal(outcome.result.eventStatus,'needs-review');
  assert.match(outcome.result.message,/primary source/);assert.equal(calls.events.length,0);assert.equal(calls.changed,0);
});

test('invalid event identity, source and receipt cannot become a confirmed event update',async()=>{
  for(const options of [{evidence:{status:'verified',event:{...event,artist:'Carl Cox'}}},{evidence:{status:'verified',event:{...event,sourceUrl:'http://insecure.invalid'}}},{eventReceipt:null},{eventReceipt:{status:'anything'}},{eventError:new Error('private-provider '+'hf_'+'sensitiveprovidersecret123456')}]) {
    const {calls,dependencies}=processor({artists:[artist],...options});
    const outcome=await processContribution(record({text:eventText}),dependencies);
    assert.equal(outcome.status,'needs-review');assert.equal(outcome.result.artistStatus,'existing');assert.equal(outcome.result.eventStatus,'unavailable');assert.equal(calls.changed,0);
    assert.doesNotMatch(JSON.stringify(outcome),/private-provider|hf_sensitive/);
    if(options.evidence)assert.equal(calls.events.length,0);
  }
});

test('cancellation after reads or checkpoint prevents every subsequent tracker write',async()=>{
  for(const stage of ['extract','verify','load','checkpoint','shows','eventVerification']) {
    const controller=new AbortController(),{calls,dependencies}=processor({artists:[artist]});
    dependencies.signal=controller.signal;
    const wrap=method=>async(...args)=>{const value=await method(...args);controller.abort();return value;};
    if(stage==='extract')dependencies.ai.extract=wrap(dependencies.ai.extract);
    if(stage==='verify')dependencies.verifier.verify=wrap(dependencies.verifier.verify);
    if(stage==='load')dependencies.catalog.load=wrap(dependencies.catalog.load);
    if(stage==='checkpoint')dependencies.checkpoint=wrap(dependencies.checkpoint);
    if(stage==='shows')dependencies.catalog.readShows=wrap(dependencies.catalog.readShows);
    if(stage==='eventVerification')dependencies.eventVerifier.verify=wrap(dependencies.eventVerifier.verify);
    await assert.rejects(processContribution(record({text:eventText}),dependencies),error=>error.name==='AbortError');
    assert.equal(calls.artists.length,0);assert.equal(calls.events.length,0);assert.equal(calls.changed,0);
  }
});

function queue(records=[],options={}) {
  const values=new Map(records.map(value=>[value.id,structuredClone(value)]));
  const calls={pending:0,claims:[],updates:[],submits:[],gets:0};
  const store={
    pending:async()=>{calls.pending++;return [...values.values()].filter(value=>value.status==='queued'||value.status==='processing'&&Date.parse(value.lease.until)<=Date.now()).map(value=>structuredClone(value));},
    claim:async(id,args)=>{
      calls.claims.push({id,...args});if(options.refuseClaim)return null;
      const value=values.get(id);if(!value)return null;
      value.status='processing';value.lease={owner:args.owner,until:new Date(Date.now()+args.leaseMs).toISOString()};return structuredClone(value);
    },
    update:async(id,patch,args)=>{
      calls.updates.push({id,patch:structuredClone(patch),owner:args.owner,signal:args.signal});
      const value=values.get(id);assert.equal(value.lease.owner,args.owner);if(options.updateError)throw options.updateError;
      Object.assign(value,structuredClone(patch));if(patch.status!=='processing')value.lease=null;return structuredClone(value);
    },
    submit:async(input,args)=>{
      calls.submits.push({input:structuredClone(input),signal:args.signal});if(Object.hasOwn(options,'receipt'))return options.receipt;
      if(!values.has(input.id))values.set(input.id,record(input));return {id:input.id,saved:true};
    },
    get:async id=>{calls.gets++;return values.has(id)?structuredClone(values.get(id)):null;},
  };
  return {store,calls,values};
}

test('service submit canonicalizes drafts and returns only confirmed durable receipts',async()=>{
  const storage=queue(),{dependencies}=processor();
  const service=createContributionService({env:{},store:storage.store,...dependencies});
  assert.deepEqual(await service.submit({id:id.toUpperCase(),text:' Please add Tie\u0308sto. '}),{id,saved:true});
  assert.deepEqual(storage.calls.submits[0].input,{id,text:'Please add Tiësto.'});assert.equal(storage.calls.pending,0);
  for(const receipt of [null,undefined,{id,saved:false},{id,saved:'true'},{id:otherId,saved:true}]) {
    const invalid=createContributionService({env:{},store:queue([],{receipt}).store,...dependencies});
    await assert.rejects(invalid.submit({id,text:'Tiësto'}),/Unconfirmed save/);
  }
  await service.stop();
});

test('enabled queue processes persisted records with a fresh claim nonce and owner-matching checkpoint',async()=>{
  const storage=queue([record({text:eventText}),record({id:otherId})]),{calls,dependencies}=processor();let invalidations=0;
  const service=createContributionService({env:{CONTRIBUTIONS_WORKER_ENABLED:'true'},store:storage.store,...dependencies,source:{invalidate:()=>invalidations++}});
  await Promise.all([service.drain(),service.drain()]);
  assert.equal(storage.calls.pending,1);assert.equal(storage.calls.claims.length,2);
  const owners=storage.calls.claims.map(value=>value.owner);assert.ok(owners.every(owner=>uuid.test(owner)));assert.notEqual(owners[0],owners[1]);
  assert.ok(storage.calls.claims.every(value=>value.leaseMs===420000));
  assert.equal(storage.calls.updates[0].patch.status,'processing');assert.equal(storage.calls.updates[0].owner,owners[0]);
  assert.deepEqual(storage.calls.updates.map(value=>value.patch.status),['processing','completed','completed']);
  assert.equal(storage.values.get(id).status,'completed');assert.equal(storage.values.get(otherId).result.artistStatus,'existing');
  assert.equal(calls.artists.length,1);assert.equal(calls.events.length,1);assert.equal(invalidations,1);
  await service.stop();
});

test('disabled sample and a missed conditional claim never run AI or mutate the tracker',async()=>{
  for(const enabled of [false,true]) {
    const storage=queue([record()],{refuseClaim:true}),{calls,dependencies}=processor();
    const service=createContributionService({env:enabled?{CONTRIBUTIONS_WORKER_ENABLED:'true'}:{},store:storage.store,...dependencies});
    service.start();await service.drain();await service.stop();
    assert.equal(calls.extract.length,0);assert.equal(storage.calls.updates.length,0);
    assert.equal(storage.calls.pending,enabled?1:0);
  }
});

test('status exposes only public fields, caches immutable copies and returns null for unknown UUIDs',async()=>{
  const stored=record({text:'private transcript',status:'completed',result:{message:'Artist added.',artistStatus:'added',eventStatus:'not-requested',sourceUrls:[musicSource]},token:'hf_'+'privateruntimetoken123456789',lease:{owner:'private-owner',until:'2099-01-01T00:00:00.000Z'}});
  const storage=queue([stored]),{dependencies}=processor();
  const service=createContributionService({env:{},store:storage.store,...dependencies});
  const first=await service.status(id);
  assert.deepEqual(first,{id,status:'completed',message:'Artist added.'});assert.doesNotMatch(JSON.stringify(first),/transcript|sourceUrls|lease|private-owner|hf_private/);
  first.status='rejected';first.message='caller mutation';assert.equal((await service.status(id)).message,'Artist added.');assert.equal(storage.calls.gets,1);
  assert.equal(await service.status(otherId),null);await service.stop();
});

test('stop aborts active processing and leaves its durable lease for restart recovery',async()=>{
  const storage=queue([record()]),{calls,dependencies}=processor(),started=deferred();let closes=0;
  dependencies.ai={extract:async(text,{signal})=>{started.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},close:()=>closes++};
  const service=createContributionService({env:{CONTRIBUTIONS_WORKER_ENABLED:'true'},store:storage.store,...dependencies});
  const draining=service.drain();await started.promise;await service.stop();await draining;
  assert.equal(storage.values.get(id).status,'processing');assert.equal(storage.values.get(id).result,null);assert.equal(storage.calls.updates.length,0);assert.equal(calls.artists.length,0);assert.equal(closes,1);
  const oldOwner=storage.values.get(id).lease.owner;storage.values.get(id).lease.until='2000-01-01T00:00:00.000Z';
  const restarted=createContributionService({env:{CONTRIBUTIONS_WORKER_ENABLED:'true'},store:storage.store,...processor().dependencies});
  await restarted.drain();assert.equal(storage.values.get(id).status,'completed');assert.notEqual(storage.calls.claims[1].owner,oldOwner);await restarted.stop();
});

test('lost checkpoint ownership prevents event mutation and never reports an unpersisted completion',async()=>{
  const storage=queue([record({text:eventText})],{updateError:Object.assign(new Error('private-provider'),{code:'LEASE_LOST'})}),{calls,dependencies}=processor();
  const service=createContributionService({env:{CONTRIBUTIONS_WORKER_ENABLED:'true'},store:storage.store,...dependencies});
  await service.drain();assert.equal(calls.events.length,0);assert.equal(calls.shows,0);assert.equal(storage.values.get(id).status,'processing');
  assert.ok(storage.calls.updates.every(value=>value.owner===storage.calls.claims[0].owner));
  assert.equal((await service.status(id)).status,'processing');await service.stop();
});

test('stopping during an in-flight claim does not start AI after that claim finishes',async()=>{
  const storage=queue([record()]),{calls,dependencies}=processor(),claimed=deferred(),release=deferred();
  const original=storage.store.claim;
  storage.store.claim=async(...args)=>{const value=await original(...args);claimed.resolve();await release.promise;return value;};
  const service=createContributionService({env:{CONTRIBUTIONS_WORKER_ENABLED:'true'},store:storage.store,...dependencies});
  const draining=service.drain();await claimed.promise;const stopping=service.stop();release.resolve();await stopping;await draining;
  assert.equal(calls.extract.length,0);assert.equal(calls.artists.length,0);assert.equal(storage.calls.updates.length,0);
  assert.equal(storage.values.get(id).status,'processing');
});

test('expired job deadline prevents subsequent writes even if extraction ignored its abort signal',async()=>{
  const storage=queue([record()]),{calls,dependencies}=processor(),started=deferred(),release=deferred();
  dependencies.ai.extract=async(text,{signal})=>{started.resolve(signal);await release.promise;return {artist,hasEvent:false};};
  const service=createContributionService({env:{CONTRIBUTIONS_WORKER_ENABLED:'true'},store:storage.store,...dependencies,jobTimeoutMs:20});
  const draining=service.drain(),signal=await started.promise;
  if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  release.resolve();await draining;
  assert.equal(calls.verify.length,0);assert.equal(calls.artists.length,0);assert.equal(storage.calls.updates.length,0);assert.equal(storage.values.get(id).status,'processing');
  await service.stop();
});
