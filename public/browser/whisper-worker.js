import {env,pipeline} from '@huggingface/transformers';

// Audio stays inside this browser worker. Only public model assets are fetched.
env.allowLocalModels=false;
env.useBrowserCache=true;
env.backends.onnx.wasm.wasmPaths='/browser/vendor/';
env.backends.onnx.wasm.numThreads=1;
env.backends.onnx.wasm.proxy=false;
let recognizer,busy=false;
self.onmessage=async({data})=>{
  if (data?.type!=='transcribe') return;
  const {id,audio}=data;
  if (busy||!(audio instanceof Float32Array)||audio.length<1600||audio.length>960000||audio.some(value=>!Number.isFinite(value))) {
    self.postMessage({id,type:'error'});return;
  }
  busy=true;
  try {
    recognizer??=pipeline('automatic-speech-recognition','Xenova/whisper-tiny',{
      device:'wasm',dtype:'q8',revision:'5332fcc35e32a33b86612b9a57a89be7906102b1',
      progress_callback:progress=>{
        const message=progress.status==='progress'&&Number.isFinite(progress.progress)
          ?`Preparing Whisper… ${Math.round(progress.progress)}%`
          :progress.status==='ready'?'Transcribing your feedback…':'Preparing Whisper for voice feedback…';
        self.postMessage({id,type:'progress',message});
      },
    });
    const transcriber=await recognizer;
    self.postMessage({id,type:'progress',message:'Transcribing your feedback…'});
    const result=await transcriber(audio,{task:'transcribe',chunk_length_s:20,stride_length_s:3});
    self.postMessage({id,type:'result',text:result.text});
  } catch {recognizer=null;self.postMessage({id,type:'error'});}
  finally {busy=false;}
};
