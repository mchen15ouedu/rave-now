import {createExpirationBridge,invalidateHostedShows} from '../src/show-expiration-service.mjs';
import {planExpiredShows} from '../src/show-expiration.mjs';

// Read-only preview is the default. Credentials belong in the environment.
const apply=process.argv.slice(2).includes('--apply');
try {
  if(process.argv.slice(2).some(value=>!['--apply','--dry-run'].includes(value)))throw Error('Unsupported option');
  const bridge=createExpirationBridge();
  const snapshot=await bridge.readSnapshot({signal:AbortSignal.timeout(40000)});
  const plan=planExpiredShows(snapshot,{now:new Date(),limit:500});
  const receipt=plan.candidates.length?await (apply?bridge.apply:bridge.dryRun)({snapshotToken:snapshot.snapshotToken,candidates:plan.candidates},{signal:AbortSignal.timeout(40000)}):{deleted:0,skippedRows:[]};
  let invalidated=false;
  if(apply)invalidated=await invalidateHostedShows();
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',sourceRows:plan.totalRows,expired:plan.expiredCount,planned:plan.candidates.length,retained:plan.keptCount,invalid:plan.invalidCount,blockedFestivals:plan.blockedFestivalCount,deleted:receipt.deleted,skipped:receipt.skippedRows.length,cacheInvalidated:invalidated}));
}catch{
  console.error('Show cleanup could not be confirmed. Run a fresh preview before retrying.');
  process.exitCode=1;
}
