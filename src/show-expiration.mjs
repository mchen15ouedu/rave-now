import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseShowDate, parseShowClock } from './shows.mjs';
import { normalizeShowDateTimeText } from './show-datetime.mjs';
import { usableEventName } from './event-groups.mjs';

const DAY = 86400000;
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const clean = value => String(value ?? '').trim();
const isFestival = row => normalize(row.category) === 'festival';
const formatters = new Map();
let cityIndex;

function validZone(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,99}$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function localParts(instant, timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  const parts = Object.fromEntries(formatters.get(timeZone).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Resolve a local wall clock. A DST fold uses the later instant; a gap is retained. */
function localInstant(date, clock, zone) {
  const target = `${date}T${clock}`, hint = Date.parse(`${target}Z`);
  if (!Number.isFinite(hint)) return null;
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = hint + hours * 3600000;
    offsets.add(Date.parse(`${localParts(sample, zone)}Z`) - sample);
  }
  const matches = [...offsets].map(offset => hint - offset).filter(instant => localParts(instant, zone) === target);
  return matches.length ? Math.max(...matches) : null;
}

function followingDate(date) { return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10); }
function dateEpoch(date) { return Date.parse(`${date}T00:00:00Z`); }
const contains = (text, value) => Boolean(value && ` ${text} `.includes(` ${value} `));

// A deterministic, local lookup only. Unlike a user-facing geocoder, deletion
// must not pick a dominant city when other matching towns have another zone.
function loadCityIndex() {
  if (cityIndex !== undefined) return cityIndex;
  try {
    const directory = JSON.parse(gunzipSync(readFileSync(new URL('../data/city-directory.json.gz', import.meta.url))).toString('utf8'));
    const names = new Map();
    for (const row of directory.cities) for (const name of new Set([normalize(row[0]), normalize(row[1]), ...(row[0] === 'New York City' && row[2] === 'US' ? ['new york', 'nyc'] : [])])) {
      if (!names.has(name)) names.set(name, []);
      names.get(name).push(row);
    }
    const states = Object.entries(directory.admins).filter(([code]) => code.startsWith('US.')).flatMap(([code, name]) => [[normalize(name), code.slice(3)], [normalize(code.slice(3)), code.slice(3)]]);
    const countries = Object.entries(directory.countries).map(([code, name]) => [normalize(name), code]);
    countries.push(['us', 'US'], ['usa', 'US'], ['united states of america', 'US'], ['uk', 'GB'], ['great britain', 'GB']);
    cityIndex = { directory, names, states, countries };
  } catch { cityIndex = null; }
  return cityIndex;
}

function cityZone(row) {
  const index = loadCityIndex();
  if (!index) return null;
  const query = normalize(row.city), address = normalize(row.address);
  const context = `${query} ${address}`.trim();
  if (!context) return null;
  const countryMatches = index.countries.filter(([name]) => contains(context, name)).sort((a, b) => b[0].length - a[0].length);
  const country = countryMatches[0]?.[1];
  const stateMatches = index.states.filter(([name]) => contains(context, name)).sort((a, b) => b[0].length - a[0].length);
  const state = (!country || country === 'US') ? stateMatches[0]?.[1] : null;
  const tokens = (query || address).split(' '), found = new Map();
  for (let start = 0; start < tokens.length; start++) for (let length = Math.min(7, tokens.length - start); length >= 1; length--) {
    const phrase = tokens.slice(start, start + length).join(' '), cities = index.names.get(phrase);
    if (!cities) continue;
    // With no City cell, a street-name city match needs an explicit region.
    if (!query && !state && !country) continue;
    const rest = [...tokens.slice(0, start), ...tokens.slice(start + length)].join(' ');
    for (const city of cities) {
      if ((country && city[2] !== country) || (state && (city[2] !== 'US' || city[3] !== state))) continue;
      if (query) {
        const labels = [normalize(index.directory.admins[`${city[2]}.${city[3]}`]), normalize(city[3]), normalize(index.directory.countries[city[2]]), normalize(city[2]), 'usa', 'us', 'uk'].filter(Boolean).sort((a, b) => b.length - a.length);
        let remaining = ` ${rest} `;
        for (const label of labels) remaining = remaining.split(` ${label} `).join(' ');
        if (remaining.trim()) continue;
      }
      const score = phrase.length;
      if (!found.has(city) || found.get(city) < score) found.set(city, score);
    }
  }
  if (!found.size) return null;
  const score = Math.max(...found.values());
  const zones = new Set([...found].filter(([, value]) => value === score).map(([city]) => city[7]));
  return zones.size === 1 && validZone([...zones][0]) ? [...zones][0] : null;
}

function nativeInstant(value) {
  // Snapshot native dates are ISO values produced by the bridge, not arbitrary
  // Date.parse input whose interpretation could depend on the host locale.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) && parseShowDate(value) ? result : null;
}

function latestListedClock(text) {
  const match = text.match(/^(\d{4}-\d{2}-\d{2})\s+(.*&.*)$/);
  if (!match) return text;
  const clocks = match[2].split('&').map(value => value.trim());
  let previous = -1, latest;
  for (const value of clocks) {
    // Only an explicitly dated, increasing same-day list of 24-hour clocks.
    // A decreasing list might cross midnight, so it stays for review instead.
    if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)) return null;
    const candidate = `${match[1]}T${value}`;
    const date = parseShowDate(candidate, { rejectAmbiguous: true });
    const clock = parseShowClock(candidate);
    if (!date || !clock.startTime) return null;
    const [hours, minutes, seconds] = clock.startTime.split(':').map(Number);
    const at = hours * 3600 + minutes * 60 + seconds;
    if (at <= previous) return null;
    previous = at; latest = candidate;
  }
  return latest || text;
}

function timing(row, prefix, workbookZone) {
  let text = normalizeShowDateTimeText(row[prefix]);
  const native = nativeInstant(row[`${prefix}Instant`]);
  const flag = row[`${prefix}DateOnly`];
  if (native !== null && flag !== true && flag !== false) return null;
  const namedSuffix = text.match(/\s+([A-Za-z_]+\/[A-Za-z0-9_+\-/]+)$/)?.[1];
  if (namedSuffix) text = text.slice(0, -namedSuffix.length).trim();
  text = latestListedClock(text);
  if (text === null) return null;
  const sourceZone = namedSuffix || clean(row.timeZone);
  if (sourceZone && !validZone(sourceZone)) return null;
  // Display searches may choose a documented numeric date order. Cleanup must
  // not delete a text row whose day and month could describe different dates.
  // Trusted native cells can still fall back to their workbook calendar below.
  const parseOptions = { rejectAmbiguous: true };
  let date = parseShowDate(text, parseOptions), clock = parseShowClock(text, parseOptions);
  if (!date && native !== null && validZone(workbookZone)) {
    const parts = localParts(native, workbookZone);
    date = parts.slice(0, 10);
    if (flag === false) clock = { startTime: parts.slice(11), timeSpecified: true, timeZoneOffset: null };
  }
  if (!date) return null;
  if (flag === true) clock = { startTime: null, timeSpecified: false, timeZoneOffset: null };
  if (clock.timeSpecified && !clock.startTime) return null;
  // Unambiguous numeric offsets in the source outrank all named-zone inference.
  const offset = /^[+-]\d{2}:\d{2}$/.test(clock.timeZoneOffset || '') ? clock.timeZoneOffset : null;
  const zone = sourceZone || (!offset && cityZone(row));
  if (!offset && clock.timeZoneOffset && zone) {
    // Abbreviations are ambiguous worldwide. With a known venue zone, only
    // accept one that actually labels that local date; a mismatched label may
    // describe another timezone and must not be silently interpreted early.
    const probe = localInstant(date, clock.startTime, zone);
    if (probe === null) return null;
    const abbreviation = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(probe)).find(part => part.type === 'timeZoneName')?.value;
    if (abbreviation?.toUpperCase() !== clock.timeZoneOffset.toUpperCase()) return null;
  }
  const dateOnly = !clock.startTime;
  const targetDate = dateOnly ? followingDate(date) : date;
  const targetClock = dateOnly ? '00:00:00' : clock.startTime;
  let instant;
  if (offset) instant = Date.parse(`${targetDate}T${targetClock}${offset}`);
  else if (zone) instant = localInstant(targetDate, targetClock, zone);
  else if (native !== null && flag === false) instant = native;
  else {
    // A workbook timezone says how cells are formatted, not where a show is.
    // UTC−12 is the latest possible local occurrence globally. This retains
    // uncertain-locale rows longer rather than deleting them too early.
    instant = Date.parse(`${targetDate}T${targetClock}Z`) + 12 * 3600000;
  }
  if (!dateOnly && !(native !== null && flag === false && !offset && !zone)) {
    const fraction = text.match(/\d{1,2}:\d{2}:\d{2}[.,](\d+)/)?.[1];
    if (fraction) {
      // Source precision can exceed Date's milliseconds. Round upward so every
      // supported displayed clock remains intact until its complete 24 hours.
      const milliseconds = Number(fraction.slice(0, 3).padEnd(3, '0'));
      instant += milliseconds + (/[1-9]/.test(fraction.slice(3)) ? 1 : 0);
    }
  }
  if (!Number.isFinite(instant)) return null;
  return { date, instant, dateOnly, zone: zone || null, offset, uncertainLocale: !offset && !zone && !(native !== null && flag === false) };
}

function endOfDay(row, parsed) {
  const date = followingDate(parsed.date);
  if (parsed.offset) return Date.parse(`${date}T00:00:00${parsed.offset}`);
  if (parsed.zone) return localInstant(date, '00:00:00', parsed.zone);
  // Even a trusted native start cannot establish an unknown venue's midnight.
  return Date.parse(`${date}T00:00:00Z`) + 12 * 3600000;
}

function usablePlace(value) {
  const text = clean(value);
  return text && !/^(?:[-–—]|n\/?a|none|unknown)$/i.test(text) && !/\b(?:tba|tbd|secret|undisclosed|to be announced)\b/i.test(text) ? normalize(text) : null;
}

function festivalName(value) {
  // A pending lineup says nothing about the festival's dates. Ignore only a
  // complete parenthetical lineup-status annotation, not date/site uncertainty.
  const event = usableEventName(clean(value).replace(/\(\s*line[\s-]*up\s*:?\s*(?:tba|tbd|to\s+be\s+(?:announced|determined))\s*\)/gi, '').trim());
  if (!event) return null;
  // Tracker announcements and per-artist rows often omit spaces, "Festival",
  // and the year. Only remove those mechanical variants, never fuzzy-match DJs.
  const name = normalize(event).replace(/\b(?:19|20)\d{2}\b/g, '').replace(/(?:19|20)\d{2}$/g, '').replace(/\b(?:music\s+)?festival\b/g, '').replace(/festival/g, '').replace(/\s+/g, '');
  return name || null;
}

function festivalIdentity(row) {
  const name = festivalName(row.event);
  const locality = usablePlace(row.city) || usablePlace(row.address);
  const venue = usablePlace(row.venue) || usablePlace(row.address);
  // One festival can use several stages or omit its venue. Its name and city
  // establish the family; venue is only additional evidence for incomplete rows.
  return name && locality ? { key: `${locality}|${name}`, name, locality, venue } : null;
}

function explicitFestivalYear(value) {
  const years = new Set([...clean(value).matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)].map(match => Number(match[0])));
  return years.size === 1 ? [...years][0] : null;
}

function badEnd(entry) {
  if (!entry.explicitEnd) return false;
  if (!entry.start || !entry.end) return true;
  return entry.end.date < entry.start.date || (!entry.start.dateOnly && !entry.end.dateOnly && entry.end.instant < entry.start.instant);
}

/** Plan fingerprint-guarded source deletions; never perform any writes here.
 * Every row in the unfiltered snapshot participates in festival retention.
 */
export function planExpiredShows(snapshot, { now = new Date(), limit = 500 } = {}) {
  if (!snapshot || !Array.isArray(snapshot.rows)) throw new TypeError('An expiration snapshot with rows is required.');
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(at)) throw new TypeError('A valid expiration reference instant is required.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new TypeError('The expiration limit must be between 1 and 5000.');
  const seen = new Set(), duplicateRows = new Set();
  for (const row of snapshot.rows) { if (seen.has(row?.row)) duplicateRows.add(row.row); seen.add(row?.row); }
  const entries = snapshot.rows.map(row => ({ row, start: timing(row || {}, 'start', snapshot.timeZone), end: clean(row?.end) || row?.endInstant ? timing(row || {}, 'end', snapshot.timeZone) : null,
    explicitEnd: Boolean(clean(row?.end) || row?.endInstant), festival: isFestival(row || {}), identity: festivalIdentity(row || {}), partialIdentity: festivalIdentity(row || {}, false), expiresAt: null, blocked: false }));
  const knownFestivalKeys = new Set(entries.filter(entry => entry.festival && entry.partialIdentity).map(entry => entry.partialIdentity.key));
  // A festival announcement identifies its per-artist rows even if those rows
  // were not all given a Category. All related source rows establish the end.
  for (const entry of entries) if (entry.partialIdentity && knownFestivalKeys.has(entry.partialIdentity.key)) entry.festival = true;
  const families = new Map();
  for (const entry of entries) {
    if (!entry.festival) { if (entry.start && !badEnd(entry)) entry.expiresAt = entry.start.instant + DAY; continue; }
    if (!entry.identity) { entry.blocked = true; continue; }
    if (!families.has(entry.identity.key)) families.set(entry.identity.key, []);
    families.get(entry.identity.key).push(entry);
  }
  for (const family of families.values()) {
    if (family.some(entry => !entry.start || badEnd(entry))) { for (const entry of family) entry.blocked = true; continue; }
    const ordered = [...family].sort((a, b) => a.start.date.localeCompare(b.start.date));
    const occurrences = [];
    for (const entry of ordered) {
      const previous = occurrences.at(-1);
      // A weekly gap separates recurring weekends. Consecutive festival dates
      // and an explicit final date can extend a longer occurrence; splitting
      // a continuous eight-day festival at seven days would delete it early.
      const latestStart = previous && Math.max(...previous.map(item => dateEpoch(item.start.date)));
      const listedEnd = previous && Math.max(...previous.map(item => dateEpoch(item.end?.date || item.start.date)));
      if (!previous || (dateEpoch(entry.start.date) - dateEpoch(previous[0].start.date) > 6 * DAY && dateEpoch(entry.start.date) - latestStart > 3 * DAY && dateEpoch(entry.start.date) > listedEnd)) occurrences.push([entry]);
      else previous.push(entry);
    }
    for (const occurrence of occurrences) {
      const first = occurrence[0].start.date, last = occurrence.map(entry => entry.end?.date || entry.start.date).sort().at(-1);
      const members = new Set(occurrence);
      const conflictingYear = occurrence.some(entry => {
        const namedYear = explicitFestivalYear(entry.row.event);
        if (!namedYear || Number(entry.start.date.slice(0, 4)) === namedYear) return false;
        // A title year alone is not enough: New Year's editions legitimately
        // begin in December. Retain only when another separate occurrence in
        // this exact name/city family corroborates the conflicting named year.
        return family.some(other => !members.has(other) &&
          explicitFestivalYear(other.row.event) === namedYear &&
          Number(other.start.date.slice(0, 4)) === namedYear &&
          Math.abs(dateEpoch(other.start.date) - dateEpoch(entry.start.date)) > 6 * DAY);
      });
      if (conflictingYear) { for (const entry of occurrence) entry.blocked = true; continue; }
      const sites = new Set(occurrence.map(entry => entry.identity.venue).filter(Boolean));
      const possibleStart = dateEpoch(first) - 3 * DAY, possibleEnd = Math.max(dateEpoch(last) + 3 * DAY, dateEpoch(first) + 6 * DAY);
      const incomplete = entries.some(entry => {
        if (!entry.festival || entry.identity) return false;
        const name = festivalName(entry.row?.event);
        // An uncertain date for another identifiable festival cannot extend
        // every festival in the same city or at the same venue indefinitely.
        if (name && name !== occurrence[0].identity.name) return false;
        const locality = usablePlace(entry.row?.city) || usablePlace(entry.row?.address);
        const venue = usablePlace(entry.row?.venue) || usablePlace(entry.row?.address);
        const sameLocality = locality && locality === occurrence[0].identity.locality;
        const sameVenue = venue && sites.has(venue);
        if (!sameLocality && !sameVenue) return false;
        // A missing-name row just after known dates may be the real final day.
        // Do not silently treat the currently known range as complete.
        return !entry.start || (dateEpoch(entry.start.date) >= possibleStart && dateEpoch(entry.start.date) <= possibleEnd);
      });
      if (incomplete) { for (const entry of occurrence) entry.blocked = true; continue; }
      // "Last day" means retain the whole final local calendar day even when
      // an end clock is supplied. Actual later instants remain a lower bound.
      const clocks = occurrence.map(entry => Math.max(entry.start.instant, entry.end?.instant ?? -Infinity, endOfDay(entry.row, entry.start) ?? NaN, entry.end ? endOfDay(entry.row, entry.end) ?? NaN : -Infinity));
      if (clocks.some(value => !Number.isFinite(value))) { for (const entry of occurrence) entry.blocked = true; continue; }
      const expiresAt = Math.max(...clocks) + DAY;
      for (const entry of occurrence) entry.expiresAt = expiresAt;
    }
  }
  let invalidCount = 0, blockedFestivalCount = 0, uncertainLocaleCount = 0;
  const eligible = [];
  for (const entry of entries) {
    const row = entry.row;
    const validReference = Number.isInteger(row?.row) && row.row >= 2 && typeof row.fingerprint === 'string' && row.fingerprint.length > 0 && row.fingerprint.length <= 300 && !duplicateRows.has(row.row);
    if (!validReference || !entry.start || badEnd(entry)) invalidCount++;
    if (entry.blocked) blockedFestivalCount++;
    if (entry.start?.uncertainLocale || entry.end?.uncertainLocale) uncertainLocaleCount++;
    if (validReference && !entry.blocked && Number.isFinite(entry.expiresAt) && entry.expiresAt <= at) eligible.push({ row: row.row, fingerprint: row.fingerprint, expiresAt: new Date(entry.expiresAt).toISOString() });
  }
  eligible.sort((a, b) => a.row - b.row);
  const candidates = eligible.slice(0, limit);
  return { candidates, totalRows: entries.length, expiredCount: eligible.length, keptCount: entries.length - candidates.length, invalidCount, blockedFestivalCount, uncertainLocaleCount, limitedCount: eligible.length - candidates.length };
}
