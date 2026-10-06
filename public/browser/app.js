const $ = (id) => document.getElementById(id);
const state = { origin: null, lastSearch: null, pendingSearch: null, view: 'nearby', request: 0, geoRequest: 0, controller: null };
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
const rangeLabels = { today: 'Today', nearby: 'Next 7 days', weekend: 'This weekend', month: 'This month', 'three-months': 'Next 3 months', full: 'All upcoming shows' };
const selectableRanges = ['today', 'nearby', 'weekend', 'month', 'three-months'];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function httpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function showDate(show) {
  if (typeof show.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(show.date)) {
    const date = new Date(`${show.date}T12:00:00Z`);
    if (Number.isFinite(date.getTime())) {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      });
      if (typeof show.dateEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(show.dateEnd) && show.dateEnd > show.date) {
        const end = new Date(`${show.dateEnd}T12:00:00Z`);
        if (Number.isFinite(end.getTime())) return formatter.formatRange(date, end);
      }
      return formatter.format(date);
    }
  }
  return String(show.dateLabel || 'Date to be confirmed');
}

function showCard(show) {
  const card = element('article', 'show-card');
  const date = element('time', '', showDate(show));
  if (typeof show.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(show.date)) date.dateTime = show.date;
  const dateLine = element('p', 'show-date');
  dateLine.append(date);
  const title = show.type === 'event' ? show.event || show.artist || 'Live event' : show.artist || 'Live show';
  card.append(element('h2', '', title), dateLine);
  if (show.event && show.type !== 'event') card.append(element('p', '', show.event));
  const venue = [show.venue, show.city].filter(Boolean).join(' · ');
  if (venue) card.append(element('p', '', venue));
  if (show.address && show.locationSource !== 'city') card.append(element('p', 'show-address', show.address));
  if (typeof show.distanceMiles === 'number' && Number.isFinite(show.distanceMiles)) {
    const miles = Math.round(Math.max(0, show.distanceMiles));
    card.append(element('p', 'show-distance', `≈ ${miles < 1 ? '<1 mile' : miles === 1 ? '1 mile' : `${miles} miles`}${show.locationApproximate ? ' · city estimate' : ''}`));
  }
  const links = element('div', 'show-links');
  let youtubeUrl = httpUrl(show.youtubeUrl);
  let youtubeLabel = show.type === 'event' ? 'YouTube search' : 'YouTube';
  if (!show.youtubeUrl && typeof show.artist === 'string' && show.artist.trim()) {
    const search = new URL('https://www.youtube.com/results');
    search.searchParams.set('search_query', show.artist);
    youtubeUrl = search.href;
    youtubeLabel = 'YouTube search';
  }
  const ticketLinks = show.type === 'event' && Array.isArray(show.ticketLinks) && show.ticketLinks.length
    ? show.ticketLinks.filter((link) => link && typeof link === 'object').map((link) => [link.url, link.label || 'Tickets']) : [[show.ticketUrl, 'Tickets']];
  const safeTickets = ticketLinks.filter(([value]) => httpUrl(value));
  const extraTickets = safeTickets.length > 3 ? safeTickets.slice(1) : [];
  const visibleTickets = extraTickets.length ? safeTickets.slice(0, 1) : safeTickets;
  function showLink(value, label) {
    const url = httpUrl(value);
    if (!url) return null;
    const link = element('a', '', label);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${label} for ${title}`);
    return link;
  }
  for (const [value, label] of [...visibleTickets, [youtubeUrl, youtubeLabel]]) {
    const link = showLink(value, label);
    if (link) links.append(link);
  }
  if (links.children.length) card.append(links);
  if (extraTickets.length) {
    const options = element('details', 'ticket-options');
    const optionLinks = element('div', 'show-links');
    options.append(element('summary', '', 'More ticket options'));
    for (const [value, label] of extraTickets) optionLinks.append(showLink(value, label));
    options.append(optionLinks);
    card.append(options);
  }
  return card;
}

function status(text, error = false) {
  $('location-status').textContent = text;
  $('location-status').classList.toggle('error', error);
}

function updateRangeButtons() {
  for (const range of selectableRanges) $('range-' + range).setAttribute('aria-pressed', String(state.view === range));
}

function updateFreshness(source) {
  const node = $('feed-freshness');
  node.hidden = true;
  if (source?.sample === true) {
    node.textContent = 'Fictional sample events · ticket links are placeholders';
    node.hidden = false;
    return;
  }
  if (source?.snapshot === false) {
    node.textContent = 'Live event feed';
    node.hidden = false;
    return;
  }
  if (!source?.snapshot || typeof source.updatedAt !== 'string') return;
  const calendar = source.updatedAt.match(/^\d{4}-\d{2}-\d{2}$/);
  const date = new Date(calendar ? `${source.updatedAt}T12:00:00Z` : source.updatedAt);
  if (!Number.isFinite(date.getTime())) return;
  node.textContent = `Event feed updated ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(date)}`;
  node.hidden = false;
}

async function loadShows(input) {
  state.controller?.abort();
  const request = ++state.request;
  const controller = state.controller = new AbortController();
  state.pendingSearch = { ...input };
  $('show-grid').replaceChildren();
  $('show-grid').setAttribute('aria-busy', 'true');
  status('Finding shows…');
  try {
    const response = await fetch('/api/browser/shows', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...input, view: state.view, timeZone }),
      signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (request !== state.request) return;
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Please enter a location or artist and try again.');
    if (!Array.isArray(data.shows)) throw new Error('Please enter a location or artist and try again.');
    if (data.searchKind !== 'artist') state.origin = data.locationInput ? { location: data.locationInput } : input.query ? { location: input.query.replace(/^location:\s*/i, '') } : { ...input };
    state.lastSearch = data.searchKind === 'artist' ? { ...state.origin, query: input.query } : { ...state.origin };
    $('show-grid').replaceChildren(...data.shows.map(showCard));
    const label = String(data.locationLabel || state.origin?.location || 'your current location');
    const days = Number.isInteger(data.days) && data.days > 0 ? data.days : 7;
    const rangeLabel = typeof data.rangeLabel === 'string' ? data.rangeLabel : rangeLabels[data.view || state.view] || `Next ${days} days`;
    updateFreshness(data.source);
    if (data.searchKind === 'artist') {
      const name = String(data.artistQuery || input.query || 'this artist');
      const hasOrigin = typeof input.location === 'string' || Number.isFinite(input.latitude) && Number.isFinite(input.longitude);
      const scope = data.view === 'full' || !hasOrigin ? `${rangeLabel} · All locations` : `Near ${label} · ${rangeLabel}`;
      const saved = data.artistRegistration?.added ? ` Added “${data.artistRegistration.name}” to Artist List.`
        : data.artistRegistration?.status === 'not-saved' ? ' This artist’s name has not been added to the list yet.' : '';
      status(`${data.shows.length ? name : `No shows found for ${name}`} · ${scope}.${saved}`);
    } else status(data.shows.length ? `Shows near ${label} · ${rangeLabel}` : `No shows near ${label} · ${rangeLabel}. Try another location, artist or date range.`);
  } catch (error) {
    if (request !== state.request || error.name === 'AbortError') return;
    status(error.message || 'Please enter a location or artist and try again.', true);
  } finally {
    if (request === state.request) { state.pendingSearch = null; $('show-grid').setAttribute('aria-busy', 'false'); }
  }
}

function requestLocation() {
  const geoRequest = ++state.geoRequest;
  ++state.request;
  state.controller?.abort();
  state.origin = null;
  state.lastSearch = null;
  state.pendingSearch = null;
  state.view = 'nearby';
  updateRangeButtons();
  $('city').value = '';
  $('show-grid').replaceChildren();
  $('show-grid').setAttribute('aria-busy', 'false');
  $('feed-freshness').hidden = true;
  status('Finding your location…');
  const unavailable = () => {
    if (geoRequest !== state.geoRequest) return;
    status('Enter a city, ZIP code or artist name.');
  };
  if (!navigator.geolocation) { unavailable(); return; }
  try {
    navigator.geolocation.getCurrentPosition((position) => {
      if (geoRequest !== state.geoRequest) return;
      const latitude = position.coords.latitude, longitude = position.coords.longitude;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        unavailable(); return;
      }
      loadShows({ latitude, longitude });
    }, unavailable, { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 });
  } catch { unavailable(); }
}

$('location-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('city').value.trim();
  if (!query) { $('city').focus(); return; }
  ++state.geoRequest;
  loadShows({ ...state.origin, query });
});

for (const range of selectableRanges) $('range-' + range).addEventListener('click', () => {
  if (state.view === range) return;
  state.view = range;
  updateRangeButtons();
  const search = state.pendingSearch || state.lastSearch;
  if (search) loadShows({ ...search });
  else {
    ++state.request;
    state.controller?.abort();
    $('show-grid').replaceChildren();
    $('show-grid').setAttribute('aria-busy', 'false');
    status('Enter a city, ZIP code or artist name.');
  }
});

// Choosing manual entry takes priority over a still-pending automatic lookup.
$('city').addEventListener('input', () => {
  ++state.geoRequest;
  if (!state.origin) status('Enter a city, ZIP code or artist name.');
});

window.addEventListener('pageshow', (event) => { if (event.persisted) requestLocation(); });
requestLocation();

// Native suggestions keep artist entry in the same field as location entry.
fetch('/api/browser/artists', { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
  .then(async (response) => response.ok ? response.json() : null)
  .then((data) => {
    if (!Array.isArray(data?.artists)) return;
    const suggestions = data.artists.filter((name) => typeof name === 'string' && name.length <= 120).map((name) => {
      const option = element('option');option.value = name;option.label = 'Artist';return option;
    });
    $('artist-suggestions').replaceChildren(...suggestions);
  }).catch(() => {});
