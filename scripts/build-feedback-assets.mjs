import {build} from 'esbuild';
import {mkdir,readdir,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const vendor=path.join(root,'public/browser/vendor');
await mkdir(vendor,{recursive:true});
await build({entryPoints:[path.join(root,'public/browser/whisper-worker.js')],outfile:path.join(vendor,'whisper-worker.bundle.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'external'});
const require=createRequire(import.meta.resolve('@huggingface/transformers'));
const ortDist=path.dirname(require.resolve('onnxruntime-web'));
for (const name of await readdir(ortDist)) {
  if (/^ort-wasm.*\.(?:wasm|mjs)$/.test(name)) await copyFile(path.join(ortDist,name),path.join(vendor,name));
}
console.log('Built browser Whisper worker and local WASM assets.');
