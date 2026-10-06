import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHostedApp} from '../src/hosted.mjs';

test('hosted browser exposes feedback without activating messaging or leaking inbox records',async t=>{
  let submitted;
  const app=createHostedApp({env:{PORT:'0'},browser:{source:{load:async()=>({shows:[]})},feedbackStore:{submit:async input=>{submitted=input;return {saved:true,id:input.id};},list:()=>{throw Error('Public list must never be called');}}}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const page=await fetch(url),html=await page.text();
  assert.match(html,/Give feedback/);assert.match(html,/feedback-dialog/);assert.match(html,/Only the text you send is saved privately/);
  assert.match(page.headers.get('permissions-policy'),/microphone=\(self\)/);
  assert.match(page.headers.get('content-security-policy'),/wasm-unsafe-eval/);
  assert.match(page.headers.get('content-security-policy'),/worker-src 'self'/);
  const client=await fetch(url+'/browser/feedback.js');assert.equal(client.status,200);assert.match(client.headers.get('content-type'),/javascript/);
  assert.equal((await fetch(url+'/browser/whisper-client.js')).status,200);
  const worker=await fetch(url+'/browser/vendor/whisper-worker.bundle.js');assert.equal(worker.status,200);assert.match(worker.headers.get('content-type'),/javascript/);
  const wasm=await fetch(url+'/browser/vendor/ort-wasm-simd-threaded.wasm');assert.equal(wasm.status,200);assert.equal(wasm.headers.get('content-type'),'application/wasm');
  assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()).slice(0,4),new Uint8Array([0,97,115,109]));
  const input={id:'65fe9374-971d-4aaa-9c2f-a1c6b1899a25',text:'Clearer loading feedback please.'};
  const result=await fetch(url+'/api/browser/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true,id:input.id});assert.deepEqual(submitted,input);
  assert.equal((await fetch(url+'/api/browser/feedback')).status,405);assert.equal(app.ready,false);assert.equal(app.store,undefined);
  assert.notEqual((await fetch(url+'/browser/vendor/secrets.json')).status,200);
});
