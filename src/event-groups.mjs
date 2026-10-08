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
  const categories = new Map();
  for (const { show } of entries) {
    const category = clean(show.category);
    if (category && !categories.has(normalized(category))) categories.set(normalized(category), category);
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
    category: categories.size === 1 ? [...categories.values()][0] : '',
    categories: [...categories.values()],
    event,
    date: dates[0],
    dateEnd: dates.at(-1),
    dateLabel: displayRange(dates[0], dates.at(-1)),
    ...uniformEventClock(entries),
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

function slotLocationKey(value) {
  return normalized(value).replace(/[.,’'\x60]/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function slotClock(show) {
  if (show.startTime == null || show.startTime === '') {
    return show.timeSpecified ? null : { time: null, offset: null };
  }
  if (typeof show.startTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(show.startTime)) return null;
  const offset = clean(show.timeZoneOffset).toUpperCase() || null;
  return { time: show.startTime.length === 5 ? show.startTime + ':00' : show.startTime, offset };
}

function uniformEventClock(entries) {
  const clocks = entries.map(({ show }) => slotClock(show));
  const first = clocks[0];
  if (!first?.time || clocks.some(clock => !clock || clock.time !== first.time || clock.offset !== first.offset)) {
    return { startTime: null, timeZoneOffset: null, timeSpecified: entries.some(({ show }) => Boolean(show.timeSpecified || show.startTime)) };
  }
  return { startTime: first.time, timeZoneOffset: first.offset, timeSpecified: true };
}

function slotSite(show) {
  const city = usableLocation(show.city);
  const cityKey = city ? slotLocationKey(city) || null : null;
  const venue = usableLocation(show.venue);
  const venueKey = venue && slotLocationKey(venue) !== cityKey ? slotLocationKey(venue) : null;
  const address = usableLocation(show.address);
  let addressKey = address && show.locationSource !== 'city' ? slotLocationKey(address) : null;
  if (addressKey) {
    const withoutCity = cityKey ? addressKey.replace(cityKey, '').trim() : addressKey;
    // City/ZIP centers and coordinates do not establish a physical street site.
    if (!withoutCity || /^[\d\s-]+$/u.test(withoutCity) || !/\p{L}/u.test(addressKey) ||
        !/^\d[\p{L}\d\-/]*\s+\p{L}/u.test(addressKey) && !/\b(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|way|court|ct|terrace|place|pl|rue|calle|weg|strasse|straße|via|piazza)\b/iu.test(addressKey)) addressKey = null;
  }
  if (!cityKey && !addressKey) return null;
  return venueKey || addressKey ? { city: cityKey, venue: venueKey, address: addressKey } : null;
}

function slotResult(entries) {
  const first = entries.reduce((a, b) => a.index < b.index ? a : b);
  const nearest = entries.reduce((a, b) => {
    const aDistance = Number.isFinite(a.show.distanceMiles) ? a.show.distanceMiles : Infinity;
    const bDistance = Number.isFinite(b.show.distanceMiles) ? b.show.distanceMiles : Infinity;
    return bDistance < aDistance ? b : a;
  });
  const standalone = new Set(entries.map(({ show }) => clean(show.artist)).filter(name => !name.includes(',')).map(normalized));
  const namesFor = show => {
    if (show.type === 'show-group' && Array.isArray(show.artists)) return show.artists.map(clean).filter(Boolean);
    const name = clean(show.artist), pieces = name.split(',').map(clean).filter(Boolean);
    // An Artist cell may itself contain a comma. Only unpack a roster when its
    // components are independently listed here, or this is our own prior group.
    return pieces.length > 1 && (show.type === 'show-group' || pieces.every(piece => standalone.has(normalized(piece)))) ? pieces : name ? [name] : [];
  };
  const artists = new Map(), styles = new Map(), categories = new Map(), events = new Map();
  const tickets = new Map(), videos = new Map(), extraVideos = new Map();
  const remember = (map, value) => { const name = clean(value); if (name && !map.has(normalized(name))) map.set(normalized(name), name); };
  for (const { show } of entries) {
    const names = namesFor(show);
    for (const name of names) { remember(artists, name); if (!videos.has(normalized(name))) videos.set(normalized(name), new Map()); }
    for (const style of clean(show.style).split(/[,;]/u)) remember(styles, style);
    for (const category of [show.category, ...(Array.isArray(show.categories) ? show.categories : [])]) remember(categories, category);
    const event = usableEventName(show.event);
    if (event && !names.some(name => normalized(name) === normalized(event)) && normalized(event) !== normalized(show.artist)) remember(events, event);
    const ticketLabel = 'Tickets · ' + clean(show.artist);
    for (const link of [...(Array.isArray(show.ticketLinks) ? show.ticketLinks : []), { url: show.ticketUrl, label: ticketLabel }]) {
      const url = safeHttpUrl(link?.url);
      if (url && !tickets.has(ticketIdentity(url))) tickets.set(ticketIdentity(url), { url, label: clean(link?.label) || ticketLabel });
    }
    const scalar = show.type === 'show-group' && Array.isArray(show.youtubeLinks) && show.youtubeLinks.some(link => safeHttpUrl(link?.url)) ? null : safeHttpUrl(show.youtubeUrl);
    if (scalar) for (const name of names) videos.get(normalized(name)).set(ticketIdentity(scalar), scalar);
    for (const link of Array.isArray(show.youtubeLinks) ? show.youtubeLinks : []) {
      const url = safeHttpUrl(link?.url);
      if (!url) continue;
      const label = clean(link.label);
      const name = names.find(value => label.endsWith(' · ' + value));
      if (name) videos.get(normalized(name)).set(ticketIdentity(url), url);
      else extraVideos.set(JSON.stringify([ticketIdentity(url), label]), { url, label: label || 'YouTube' });
    }
  }
  const youtubeLinks = [];
  for (const [key, name] of artists) {
    const urls = videos.get(key);
    if (urls.size) for (const url of urls.values()) {
      const parsed = new URL(url);
      const label = parsed.pathname === '/results' && parsed.searchParams.has('search_query') ? 'YouTube search · ' : 'YouTube · ';
      youtubeLinks.push({ url, label: label + name });
    }
    else youtubeLinks.push({ url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(name), label: 'YouTube search · ' + name });
  }
  for (const link of extraVideos.values()) if (!youtubeLinks.some(value => value.url === link.url && value.label === link.label)) youtubeLinks.push(link);
  const clock = slotClock(first.show);
  return {
    ...nearest.show,
    id: first.show.id ?? 'slot-' + first.index,
    type: 'show-group',
    artist: [...artists.values()].join(', '),
    artists: [...artists.values()],
    style: [...styles.values()].join(', '),
    category: categories.size === 1 ? [...categories.values()][0] : '',
    categories: [...categories.values()],
    event: [...events.values()].filter(event => !artists.has(normalized(event))).join(', '),
    date: first.show.date,
    dateLabel: first.show.dateLabel,
    startTime: clock.time,
    timeZoneOffset: clock.offset,
    timeSpecified: Boolean(clock.time),
    entryCount: entries.reduce((total, { show }) => total + (Number.isInteger(show.entryCount) && show.entryCount >= 0 ? show.entryCount : show.type === 'event' ? 0 : 1), 0),
    ticketUrl: [...tickets.values()][0]?.url ?? null,
    ticketLinks: [...tickets.values()],
    youtubeUrl: youtubeLinks[0]?.url ?? null,
    youtubeLinks,
  };
}

/** Browser-only consolidation after named festivals have already been counted.
 * A slot needs the same calendar day, explicit clock/offset (or both date-only),
 * and a known physical site. Ambiguous partial locations remain individual.
 * Multi-day event cards keep their date ranges. A one-day event contributes
 * only its existing headline, never an inferred performer roster.
 */
export function mergeShowSlots(matches) {
  if (!Array.isArray(matches)) throw new TypeError('matches must be an array.');
  const slots = new Map();
  matches.forEach((show, index) => {
    if (!show || typeof show !== 'object' || show.type === 'event' && show.dateEnd && show.dateEnd !== show.date || dateEpoch(show.date) == null) return;
    const clock = slotClock(show), site = slotSite(show);
    if (!clock || !site) return;
    const key = JSON.stringify([show.date, clock.time, clock.offset]);
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push({ show, index, site });
  });
  const replacements = new Map(), hidden = new Set();
  const locatedSlots = [];
  for (const entries of slots.values()) {
    const addressCities = new Map(), cities = new Map();
    for (const { site } of entries) {
      if (!site.city || !site.address) continue;
      if (!addressCities.has(site.address)) addressCities.set(site.address, new Set());
      addressCities.get(site.address).add(site.city);
    }
    for (const entry of entries) {
      let city = entry.site.city;
      if (!city) {
        const known = addressCities.get(entry.site.address) || new Set();
        if (known.size > 1) continue;
        city = known.size === 1 ? [...known][0] : '';
      }
      if (!cities.has(city)) cities.set(city, []);
      cities.get(city).push(entry);
    }
    locatedSlots.push(...cities.values());
  }
  for (const entries of locatedSlots) {
    const byVenue = new Map(), byAddress = new Map(), groups = new Map();
    for (const { site } of entries) {
      if (!site.venue || !site.address) continue;
      const key = JSON.stringify([site.venue, site.address]);
      if (!byVenue.has(site.venue)) byVenue.set(site.venue, new Set());
      if (!byAddress.has(site.address)) byAddress.set(site.address, new Set());
      byVenue.get(site.venue).add(key); byAddress.get(site.address).add(key);
    }
    for (const entry of entries) {
      const { site } = entry;
      let key;
      if (site.venue && site.address) key = JSON.stringify([site.venue, site.address]);
      else {
        const candidates = (site.venue ? byVenue.get(site.venue) : byAddress.get(site.address)) || new Set();
        key = candidates.size === 1 ? [...candidates][0] : candidates.size > 1 ? 'ambiguous:' + entry.index : JSON.stringify([site.venue, site.address]);
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const first = group.reduce((a, b) => a.index < b.index ? a : b);
      replacements.set(first.index, slotResult(group));
      for (const { index } of group) if (index !== first.index) hidden.add(index);
    }
  }
  const results = matches.flatMap((show, index) => hidden.has(index) ? [] : [replacements.get(index) ?? show]);
  return results.sort((a, b) => {
    const aDate = dateEpoch(a?.date), bDate = dateEpoch(b?.date);
    if (aDate == null) return bDate == null ? 0 : 1;
    if (bDate == null) return -1;
    return aDate - bDate || (slotClock(a)?.time ?? '99:99:99').localeCompare(slotClock(b)?.time ?? '99:99:99');
  });
}
