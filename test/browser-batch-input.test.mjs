import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHandler} from '../src/browser.mjs';

test('batch artist searches save one stable queue receipt, skip synchronous verification and preserve known searches',async()=>{
  const submissions=[];
  const app=createBrowserHandler({env:{CONTRIBUTIONS_PROCESSING_MODE:'batch'},source:{load:async()=>({shows:[]})},catalog:{load:async()=>({artists:['Known DJ'],promoters:[]}),ensureArtist:async()=>{throw Error('Must not write from browser');}},verifier:{verify:async()=>{throw Error('Must not verify from browser');}},contributionService:{submit:async input=>{submissions.push(input);return {id:input.id,saved:true};},status:async()=>null,start(){},async stop(){}},clock:()=>new Date('2026-10-07T12:00:00Z')});
  const first=await app.search({query:'artist: Example DJ'}),again=await app.search({query:'artist: Example DJ',view:'month'}),known=await app.search({query:'artist: Known DJ'});
  assert.equal(first.artistRegistration.status,'queued');assert.equal(first.artistRegistration.added,false);assert.equal(again.artistRegistration.id,first.artistRegistration.id);assert.equal(submissions.length,1);assert.equal(submissions[0].text,'artist: Example DJ');assert.equal(known.artistRegistration,null);assert.equal(first.total,0);
});

test('a missing durable receipt cannot claim that an artist was queued',async()=>{
  const app=createBrowserHandler({env:{CONTRIBUTIONS_PROCESSING_MODE:'batch'},source:{load:async()=>({shows:[]})},catalog:{load:async()=>({artists:[],promoters:[]})},contributionService:{submit:async()=>({saved:false}),start(){},async stop(){}},clock:()=>new Date('2026-10-07T12:00:00Z')});
  const result=await app.search({query:'artist: Example DJ'});assert.equal(result.artistRegistration.status,'not-saved');assert.equal(result.artistRegistration.id,undefined);
});
