const DAY_MS = 86400000;
const OCCURRENCE_DAYS = 7;
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

function clean(value) {
  return value == null ? '' : String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function normalized(value) {
  return clean(value).toLowerCase();
}

export function usableEventName(value) {
  const text = clean(value);
  if (!text || /^(?:[-–—]|n\/?a|none|unknown|event|festival|music festival|concert|show|live music)$/i.test(text)) return null;
  if (/\b(?:tba|tbd|to be (?:announced|determined)|unknown)\b/i.test(text)) return null;
  return text;
}

function usableLocation(value) {
  const text = clean(value);
  if (!text || /^(?:[-–—]|n\/?a|none|unknown)$/i.test(text)) return null;
  if (/\b(?:tba|tbd|to be (?:announced|determined)|secret|undisclosed)\b/i.test(text)) return null;
  return text;
}

function locationIdentity(show) {
  // A festival can have several stages/addresses in the same city. A city is
  // therefore the common identity when supplied; a venue alone never names an event.
  const city = usableLocation(show.city);
  if (city) return `city:${normalized(city).replace(/[,]/g, '').replace(/\s+/g, ' ')}`;
  const query = usableLocation(show.locationQuery) || usableLocation(show.address);
  if (query) return `address:${normalized(query)}`;
  const venue = usableLocation(show.venue);
  return venue ? `venue:${normalized(venue)}` : null;
}

function addressSite(show) {
  if (!usableLocation(show.city)) return null;
  const address = usableLocation(show.address);
  if (!address || show.locationSource === 'city') return null;
  const key = normalized(address).replace(/[,]/g, '').replace(/\s+/g, ' ');
  const city = normalized(show.city).replace(/[,]/g, '').replace(/\s+/g, ' ');
  return key === city ? null : key;
}

function dateEpoch(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value ? epoch : null;
}

function displayDate(date) {
  return dateFormatter.format(new Date(`${date}T00:00:00Z`));
}

function displayRange(start, end) {
  return start === end ? displayDate(start) : `${displayDate(start)} – ${displayDate(end)}`;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(clean(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function ticketIdentity(value) {
  const url = new URL(value);
  // Ignore only known tracking parameters. Ticket type/day/checkout parameters
  // may carry meaning and must remain part of the identity and the original link.
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(?:gclid|fbclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

function eventTickets(entries) {
  const tickets = new Map();
  for (const { show } of entries) {
    const url = safeHttpUrl(show.ticketUrl);
    if (!url) continue;
    const key = ticketIdentity(url);
    const ticket = tickets.get(key) || { url, dates: new Set() };
    ticket.dates.add(show.date);
    tickets.set(key, ticket);
  }
  return [...tickets.values()].map(({ url, dates }) => {
    const ordered = [...dates].sort();
    const contiguous = ordered.every((date, index) => index === 0 || dateEpoch(date) - dateEpoch(ordered[index - 1]) === DAY_MS);
    const dateLabel = contiguous ? displayRange(ordered[0], ordered.at(-1))
      : ordered.length <= 3 ? ordered.map(displayDate).join(', ') : 'selected event dates';
    return { url, label: `Tickets · ${dateLabel}` };
  });
}

function eventResult(entries) {
  const first = entries.reduce((a, b) => a.index < b.index ? a : b);
  const nearest = entries.reduce((a, b) => {
    const aDistance = Number.isFinite(a.show.distanceMiles) ? a.show.distanceMiles : Infinity;
    const bDistance = Number.isFinite(b.show.distanceMiles) ? b.show.distanceMiles : Infinity;
    return bDistance < aDistance ? b : a;
  });
  const dates = entries.map(({ show }) => show.date).sort();
  const event = usableEventName(first.show.event);
  const ticketLinks = eventTickets(entries);
  const styles = new Map();
  for (const { show } of entries) {
    for (const value of clean(show.style).split(/[,;]/u)) {
      const style = clean(value);
      if (style && !styles.has(normalized(style))) styles.set(normalized(style), style);
    }
  }
  return {
    ...nearest.show,
    id: `event:${first.show.id ?? first.index}:${dates[0]}`,
    type: 'event',
    artist: event,
    style: [...styles.values()].join(', '),
    event,
    date: dates[0],
    dateEnd: dates.at(-1),
    dateLabel: displayRange(dates[0], dates.at(-1)),
    entryCount: entries.filter(({ show }) => show.type !== 'event').length,
    ticketUrl: ticketLinks[0]?.url ?? null,
    ticketLinks,
    youtubeUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(event)}`,
  };
}

/** Collapse four or more already-matching artist entries into their named event.
 * Run after date/location filtering: only entries actually in the result count.
 * Standalone announcements do not count as performers or duplicate their lineup.
 * Results use soonest start date first, preserving the input order of date ties.
 * Neither the input records nor the input array are modified.
 */
export function groupEventResults(matches) {
  if (!Array.isArray(matches)) throw new TypeError('matches must be an array.');
  const identities = new Map();
  matches.forEach((show, index) => {
    if (!show || typeof show !== 'object') return;
    const event = usableEventName(show.event);
    const location = locationIdentity(show);
    const epoch = dateEpoch(show.date);
    if (!event || !location || epoch == null) return;
    const key = JSON.stringify([normalized(event), location]);
    const entries = identities.get(key) || [];
    entries.push({ show, index, epoch });
    identities.set(key, entries);
  });

  const replacements = new Map();
  const hidden = new Set();
  const collapseSite = (entries) => {
    const performers = entries.filter(({ show }) => show.type !== 'event');
    const events = entries.filter(({ show }) => show.type === 'event');
    if (performers.length <= 3 && performers.length) {
      // A tracker may include an event announcement followed by its lineup.
      // The announcement is not another DJ and must not trigger the threshold
      // or add a duplicate card beside the individual small-lineup results.
      for (const { index } of events) hidden.add(index);
      return;
    }
    if (performers.length <= 3 && events.length <= 1) return;
    const firstIndex = Math.min(...entries.map(({ index }) => index));
    replacements.set(firstIndex, eventResult(entries));
    for (const { index } of entries) if (index !== firstIndex) hidden.add(index);
  };
  const collapse = (entries) => {
    const sites = new Set(entries.map(({ show }) => addressSite(show)).filter(Boolean));
    if (sites.size <= 1) return collapseSite(entries);
    // Distinct known sites can mean two same-named events in one city. Stage
    // names alone are not discriminators; ambiguous city-only rows stay individual.
    for (const site of sites) collapseSite(entries.filter(({ show }) => addressSite(show) === site));
  };

  for (const entries of identities.values()) {
    const byDate = [...entries].sort((a, b) => a.epoch - b.epoch || a.index - b.index);
    let occurrence = [];
    let occurrenceStart = null;
    for (const entry of byDate) {
      // Missing lineup days must not split one weekend festival. Anchor the
      // window at its first matching day so weekly editions and long-running
      // daily series cannot chain into a single event indefinitely.
      if (occurrenceStart != null && entry.epoch - occurrenceStart >= OCCURRENCE_DAYS * DAY_MS) {
        collapse(occurrence);
        occurrence = [];
        occurrenceStart = null;
      }
      occurrenceStart ??= entry.epoch;
      occurrence.push(entry);
    }
    collapse(occurrence);
  }
  const results = matches.flatMap((show, index) => hidden.has(index) ? [] : [replacements.get(index) ?? show]);
  // A multi-day group can replace its Sunday row with a Friday start date.
  // Sort the completed cards again so that replacement cannot misorder dates.
  return results.sort((a, b) => {
    const aDate = dateEpoch(a?.date);
    const bDate = dateEpoch(b?.date);
    if (aDate == null) return bDate == null ? 0 : 1;
    if (bDate == null) return -1;
    return aDate - bDate;
  });
}
