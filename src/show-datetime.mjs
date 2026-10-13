const MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9], ['oct', 10],
  ['october', 10], ['nov', 11], ['november', 11], ['dec', 12], ['december', 12],
]);
const ABSENT_CLOCK = { startTime: null, timeZoneOffset: null, timeSpecified: false };
const INVALID_CLOCK = { ...ABSENT_CLOCK, timeSpecified: true };
const ZONE_ABBREVIATIONS = new Set(('EST EDT CST CDT MST MDT PST PDT AKST AKDT HST HAST HADT ' +
  'CET CEST EET EEST WET WEST BST IST JST KST HKT SGT ICT WIB WITA WIT ' +
  'AEST AEDT ACST ACDT AWST NZST NZDT ART BRT BRST CLT CLST AST ADT NST NDT ' +
  'MSK TRT PKT NPT BDT MYT PHT SAST CAT EAT GST').split(' '));

export function isoDate(year, month, day) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 ||
      !Number.isInteger(day) || day < 1 || day > lengths[month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const yearNumber = value => {
  const text = String(value).replace(/^'/, ''), year = Number(text);
  return text.length === 2 ? year + (year <= 69 ? 2000 : 1900) : year;
};
const clockRecord = (hours, minutes = 0, seconds = 0, zone = null) => ({
  startTime: [hours, minutes, seconds].map(part => String(part).padStart(2, '0')).join(':'),
  timeZoneOffset: zone, timeSpecified: true,
});

export function normalizeShowDateTimeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\u200b-\u200d\uFEFF]/g, '').replace(/[−–—]/g, '-').replace(/\s+/g, ' ').trim();
}

function parseClockTail(tail) {
  if (!tail.trim()) return { ...ABSENT_CLOCK };
  // A clock needs a separator from the calendar date; extra date digits must
  // never become an invented hour after a shorter valid day or year.
  if (!/^(?:\s|[Tt,@−–—-])/.test(tail)) return { ...INVALID_CLOCK };
  let text = tail.trim().replace(/^(?:[Tt,@-]|at\b)\s*/i, '');
  // Date.toString() includes a descriptive label after its explicit GMT offset.
  text = text.replace(/((?:GMT|UTC)[+-]\d{2}:?\d{2})\s+\([A-Za-z ]{1,100}\)$/i, '$1');
  const parts = text.match(/^(\d{1,2})(?::(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*([ap]\.?\s*m\.?)?\s*(Z|(?:UTC|GMT)(?:[+-]\d{2}(?::?\d{2})?)?|[+-]\d{2}(?::?\d{2})?|[A-Z]{2,5}|[A-Za-z_]+\/[A-Za-z0-9_+\-/]+)?$/i);
  if (!parts) return { ...INVALID_CLOCK };
  let hours = Number(parts[1]);
  const minutes = Number(parts[2] || 0), seconds = Number(parts[3] || 0);
  const meridiem = parts[4]?.replace(/[.\s]/g, '').toUpperCase();
  if (minutes > 59 || seconds > 59 || hours > (meridiem ? 12 : 23) || (meridiem && hours < 1)) return { ...INVALID_CLOCK };
  if (meridiem) hours = hours % 12 + (meridiem === 'PM' ? 12 : 0);
  let zone = parts[5] || null;
  if (zone) {
    if (zone.includes('/')) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { return { ...INVALID_CLOCK }; }
    } else {
      zone = zone.toUpperCase();
      if (/^(?:Z|UTC|GMT)$/.test(zone)) zone = '+00:00';
      else if (/^(?:(?:UTC|GMT))?[+-]/.test(zone)) {
        zone = zone.replace(/^(?:UTC|GMT)/, '');
        if (/^[+-]\d{2}$/.test(zone)) zone += ':00';
        zone = zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
        const offsetHours = Number(zone.slice(1, 3)), offsetMinutes = Number(zone.slice(4));
        if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) return { ...INVALID_CLOCK };
        if (zone === '-00:00') zone = '+00:00';
      } else if (!ZONE_ABBREVIATIONS.has(zone)) return { ...INVALID_CLOCK };
    }
  }
  return clockRecord(hours, minutes, seconds, zone);
}

/** Explicit spreadsheet formats; never depend on the machine's Date.parse locale. */
export function parseShowDateTime(value, { dateOrder = 'MDY', rejectAmbiguous = false } = {}) {
  if (!['MDY', 'DMY'].includes(dateOrder)) throw new TypeError('dateOrder must be MDY or DMY.');
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 2958465) return { date: null, clock: { ...ABSENT_CLOCK } };
    const native = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    const date = isoDate(native.getUTCFullYear(), native.getUTCMonth() + 1, native.getUTCDate());
    const seconds = Math.min(86399, Math.round((value - Math.floor(value)) * 86400));
    return { date, clock: Number.isInteger(value) ? { ...ABSENT_CLOCK } : clockRecord(Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60) };
  }
  if (value instanceof Date) {
    const valid = Number.isFinite(value.getTime());
    return { date: valid ? isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()) : null,
      clock: valid ? clockRecord(value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), '+00:00') : { ...ABSENT_CLOCK } };
  }
  let text = normalizeShowDateTimeText(value);
  if (!text || text.length > 300) return { date: null, clock: { ...ABSENT_CLOCK } };
  text = text.replace(/^(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)\.?(?:\s*,\s*|\s+)/i, '');
  let match, year, month, day, tail = '', ambiguous = false;
  if ((match = text.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(.*)$/))) {
    [, year, , month, day, tail] = match;
  } else if ((match = text.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})[日号](.*)$/))) {
    [, year, month, day, tail] = match;
  } else if ((match = text.match(/^(\d{4})(\d{2})(\d{2})(?=$|[Tt\s,@])(.*)$/))) {
    [, year, month, day, tail] = match;
  } else if ((match = text.match(/^(\d{4})[\s/-]*([a-z]+)\.?[\s/-]*(\d{1,2})(?:st|nd|rd|th)?(.*)$/i))) {
    year = match[1]; month = MONTHS.get(match[2].toLowerCase()); day = match[3]; tail = match[4];
  } else if ((match = text.match(/^([a-z]+)\.?[\s/-]*(\d{1,2})(?:st|nd|rd|th)?(?:\s*,\s*|[\s/-]+)('?\d{4}|'?\d{2})(?!\d)(.*)$/i))) {
    month = MONTHS.get(match[1].toLowerCase()); day = match[2]; year = match[3]; tail = match[4];
  } else if ((match = text.match(/^([a-z]+)\.?(\d{1,2})(?:st|nd|rd|th)?(\d{4})(?!\d)(.*)$/i))) {
    month = MONTHS.get(match[1].toLowerCase()); day = match[2]; year = match[3]; tail = match[4];
  } else if ((match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s./-]*([a-z]+)\.?(?:\s*,\s*|[\s/-]*)('?\d{4}|'?\d{2})(?!\d)(.*)$/i))) {
    day = match[1]; month = MONTHS.get(match[2].toLowerCase()); year = match[3]; tail = match[4];
  } else if ((match = text.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})(?!\d)(.*)$/))) {
    const first = Number(match[1]), second = Number(match[3]);
    ambiguous = first >= 1 && first <= 12 && second >= 1 && second <= 12 && first !== second;
    const dayFirst = first > 12 || (second <= 12 && dateOrder === 'DMY');
    month = dayFirst ? second : first; day = dayFirst ? first : second; year = match[4]; tail = match[5];
  } else return { date: null, clock: { ...ABSENT_CLOCK } };
  const clock = parseClockTail(tail);
  const date = isoDate(yearNumber(year), Number(month), Number(day));
  return { date: date && (!clock.timeSpecified || clock.startTime) && !(rejectAmbiguous && ambiguous) ? date : null,
    clock: rejectAmbiguous && ambiguous ? { ...INVALID_CLOCK } : clock };
}
