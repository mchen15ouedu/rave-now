export function createFeedbackTranscriber({WorkerImpl=globalThis.Worker,timeoutMs=75000}={}) {
  let worker,active,sequence=0;
  const discard=()=>{worker?.terminate();worker=null;};
  return function transcribe(audio,{onProgress,signal}={}) {
    signal?.throwIfAborted();
    if (!(audio instanceof Float32Array)||audio.length<1600||audio.length>960000||audio.some(sample=>!Number.isFinite(sample))) return Promise.reject(new Error('Record between a moment and 60 seconds of feedback.'));
    if (active) return Promise.reject(new Error('A voice transcript is already being prepared.'));
    if (!WorkerImpl) return Promise.reject(new Error('Voice transcription is unavailable. You can type your feedback.'));
    return new Promise((resolve,reject)=>{
      const id=++sequence;let timer;
      const finish=(error,text)=>{
        if (active?.id!==id) return;
        clearTimeout(timer);signal?.removeEventListener('abort',cancel);active=null;
        if (error) {discard();reject(error);} else resolve(text);
      };
      const cancel=()=>finish(signal.reason||new DOMException('Transcription cancelled','AbortError'));
      try {
        worker??=new WorkerImpl('/browser/vendor/whisper-worker.bundle.js',{type:'module'});
        active={id};
        worker.onmessage=({data})=>{
          if (active?.id!==id||data?.id!==id) return;
          if (data.type==='progress') {try {onProgress?.(typeof data.message==='string'?data.message:'Preparing voice transcription…');} catch {}return;}
          if (data.type==='error') {finish(new Error('Could not transcribe the recording. Try again or type your feedback.'));return;}
          if (data.type!=='result') return;
          const text=typeof data.text==='string'?data.text.trim():'';
          if (!text||text.length>2000) finish(new Error('Could not get a usable transcript. Try a shorter recording or type your feedback.'));
          else finish(null,text);
        };
        worker.onerror=()=>finish(new Error('Voice transcription is unavailable. You can type your feedback.'));
        timer=setTimeout(()=>finish(new Error('Voice transcription took too long. Try again or type your feedback.')),timeoutMs);
        signal?.addEventListener('abort',cancel,{once:true});
        if (signal?.aborted) {cancel();return;}
        const copy=new Float32Array(audio);
        worker.postMessage({type:'transcribe',id,audio:copy},[copy.buffer]);
      } catch {active??={id};finish(new Error('Voice transcription is unavailable. You can type your feedback.'));}
    });
  };
}

export const transcribeFeedback=createFeedbackTranscriber();
