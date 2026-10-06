import { readFile } from 'node:fs/promises';
import { parseShows, parseShowDate } from './shows.mjs';
import { createArtistCatalog } from './artist-catalog.mjs';

export class ShowSourceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ShowSourceError';
    this.code = 'UNAVAILABLE';
  }
}

/** Tab-separated exports can quote tabs, newlines, and doubled quote characters. */
export function parseTsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (quoted || cell === '') quoted = !quoted;
      else cell += character;
    } else if (!quoted && character === '\t') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  if (quoted) throw new ShowSourceError('The tracker snapshot contains an unterminated quoted cell.');
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function columnName(number) {
  let result = '';
  while (number > 0) {
    number -= 1;
    result = String.fromCharCode(65 + number % 26) + result;
    number = Math.floor(number / 26);
  }
  return result;
}

async function defaultAuthFactory() {
  const { GoogleAuth } = await import('google-auth-library');
  return new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
}

/** Read-only Sheets API using ADC, or a visibly identified local TSV snapshot in demo mode. */
export function createShowSource(config = {}) {
  const mode = config.mode || 'demo';
  if (!['demo', 'live', 'apps-script'].includes(mode)) throw new TypeError('Choose a supported show source mode.');
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  const clock = config.clock || Date.now;
  const cacheTtlMs = Math.min(Math.max(Number(config.cacheTtlMs ?? 60000) || 0, 0), 60000);
  const maxRows = Math.min(Math.max(Number(config.maxRows) || 10000, 1), 10000);
  let cached;
  let auth;
  let bridge;

  async function authenticatedGet(url, signal) {
    signal?.throwIfAborted();
    try {
      auth ??= config.auth || await (config.authFactory || defaultAuthFactory)();
      const client = typeof auth.getClient === 'function' ? await auth.getClient() : auth;
      const tokenResult = await client.getAccessToken();
      const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
      if (!token) throw new ShowSourceError('Google Sheets credentials did not provide an access token.');
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal });
      if (!response.ok) throw new ShowSourceError(`Google Sheets could not be read (HTTP ${response.status}). Check the service account access and spreadsheet settings.`);
      return await response.json();
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (error instanceof ShowSourceError) throw error;
      throw new ShowSourceError('Google Sheets is temporarily unavailable or its credentials are not configured.', { cause: error });
    }
  }

  async function loadRows(signal) {
    if (mode === 'apps-script') {
      bridge ??= config.bridge || createArtistCatalog({env:{ARTIST_CATALOG_URL:config.bridgeUrl,ARTIST_CATALOG_SECRET:config.bridgeSecret},fetchImpl});
      try {return (await bridge.readShows({signal})).rows;}
      catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        throw new ShowSourceError('The current event feed is temporarily unavailable.',{cause:error});
      }
    }
    if (mode === 'demo') {
      if (!config.snapshotFile) throw new ShowSourceError('A tracker snapshot file is required in demo mode.');
      try {
        return parseTsv(await readFile(config.snapshotFile, { encoding: 'utf8', signal }));
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        if (error instanceof ShowSourceError) throw error;
        throw new ShowSourceError('The local tracker snapshot could not be read.', { cause: error });
      }
    }
    if (!config.spreadsheetId || !/^[A-Za-z0-9_-]+$/.test(config.spreadsheetId)) throw new ShowSourceError('A valid Google spreadsheet ID is required in live mode.');
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}`;
    const metadataUrl = new URL(base);
    metadataUrl.searchParams.set('fields', 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))');
    const metadata = await authenticatedGet(metadataUrl, signal);
    if (!Array.isArray(metadata.sheets)) throw new ShowSourceError('Google Sheets returned invalid tracker metadata.');
    const sheets = metadata.sheets.map((sheet) => sheet.properties).filter(Boolean);
    const selected = config.sheetId != null
      ? sheets.find((sheet) => String(sheet.sheetId) === String(config.sheetId))
      : sheets.find((sheet) => sheet.title === (config.sheetName || 'Upcoming Shows'));
    if (!selected?.title) throw new ShowSourceError('The configured tracker tab was not found in Google Sheets.');
    const rows = Math.floor(Math.min(maxRows, Number(selected.gridProperties?.rowCount) || maxRows));
    const columns = Math.floor(Math.min(100, Math.max(1, Number(selected.gridProperties?.columnCount) || 26)));
    const range = `'${selected.title.replace(/'/g, "''")}'!A1:${columnName(columns)}${rows}`;
    const valuesUrl = new URL(`${base}/values/${encodeURIComponent(range)}`);
    valuesUrl.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
    valuesUrl.searchParams.set('dateTimeRenderOption', 'FORMATTED_STRING');
    const values = await authenticatedGet(valuesUrl, signal);
    if (!Array.isArray(values.values)) throw new ShowSourceError('The configured tracker tab is empty.');
    if (Number(selected.gridProperties?.rowCount) > rows && values.values.length >= rows &&
        Array.isArray(values.values[rows - 1]) && values.values[rows - 1].some((cell) => String(cell ?? '').trim() !== '')) {
      throw new ShowSourceError(`The tracker may exceed the ${rows}-row read limit. Narrow the tracker tab before searching so results are complete.`);
    }
    return values.values;
  }

  return {
    async load({ signal } = {}) {
      signal?.throwIfAborted();
      if (cached && cached.expiresAt > clock()) return { ...cached.value, warnings: [...cached.value.warnings] };
      // Expired results are discarded: live errors never silently fall back to stale or demo shows.
      cached = undefined;
      const rows = await loadRows(signal);
      signal?.throwIfAborted();
      let shows;
      try {
        shows = parseShows(rows);
      } catch (error) {
        throw new ShowSourceError(error.message, { cause: error });
      }
      let snapshotUpdatedAt, sample = false;
      if(mode === 'demo') {
        try {
          const metadata=JSON.parse(await readFile(config.snapshotMetadataFile || `${config.snapshotFile}.meta.json`,{encoding:'utf8',signal}));
          sample=metadata.sample===true;
          if(typeof metadata.updatedAt==='string' && /^\d{4}-\d{2}-\d{2}$/.test(metadata.updatedAt) && parseShowDate(metadata.updatedAt))snapshotUpdatedAt=metadata.updatedAt;
        } catch(error) {if(signal?.aborted || error?.name==='AbortError')throw error;}
        if(!snapshotUpdatedAt && typeof config.snapshotUpdatedAt==='string' && /^\d{4}-\d{2}-\d{2}$/.test(config.snapshotUpdatedAt) && parseShowDate(config.snapshotUpdatedAt))snapshotUpdatedAt=config.snapshotUpdatedAt;
      }
      const value = { shows, loadedAt: new Date(clock()).toISOString(), source: mode === 'demo' ? 'snapshot' : mode==='apps-script'?'apps-script':'google-sheets', ...(snapshotUpdatedAt?{snapshotUpdatedAt}:{}), ...(sample?{sample:true}:{}), warnings: [...shows.warnings] };
      if (cacheTtlMs) cached = { value, expiresAt: clock() + cacheTtlMs };
      return { ...value, warnings: [...value.warnings] };
    },
  };
}
