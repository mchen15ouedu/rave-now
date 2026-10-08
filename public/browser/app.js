const $ = (id) => document.getElementById(id);
const state = { origin: null, lastSearch: null, pendingSearch: null, view: 'nearby', request: 0, geoRequest: 0, controller: null, suggestionsLoaded: false, suggestionsTimer: null, suggestionsController: null };
const searchTimeoutMs = 50000;
const slowSearchMs = 4000;
const suggestionsDelayMs = 1500;
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

function categoryKey(label) {
  return label.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function categoryColor(label) {
  const key = categoryKey(label);
  const known = { nighttime: 'nighttime', daytime: 'daytime', festival: 'festival', afters: 'afters' };
  if (Object.hasOwn(known, key)) return known[key];
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.codePointAt(0)) >>> 0;
  return `other-${hash % 6}`;
}

function showCard(show) {
  const card = element('article', 'show-card');
  const date = element('time', '', showDate(show));
  if (typeof show.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(show.date)) date.dateTime = show.date;
  const dateLine = element('p', 'show-date');
  dateLine.append(date);
  const title = show.type === 'event' ? show.event || show.artist || 'Live event' : show.artist || 'Live show';
  card.append(element('h2', '', title));
  if (typeof show.style === 'string' && show.style.trim()) card.append(element('p', 'show-style', show.style.trim()));
  card.append(dateLine);
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
  const categoryValues = Array.isArray(show.categories) ? show.categories : [];
  const labels = new Map();
  for (const value of categoryValues) {
    if (typeof value === 'string' && value.trim() && !labels.has(categoryKey(value))) labels.set(categoryKey(value), value.trim());
  }
  if (!labels.size && typeof show.category === 'string' && show.category.trim()) labels.set(categoryKey(show.category), show.category.trim());
  if (labels.size) {
    const categories = element('div', 'show-categories');
    categories.setAttribute('role', 'group');
    categories.setAttribute('aria-label', 'Event categories');
    for (const label of labels.values()) categories.append(element('span', `show-category category-${categoryColor(label)}`, label));
    card.append(categories);
  }
  return card;
}

function status(text, error = false) {
  $('location-status').replaceChildren();
  $('location-status').textContent = text;
  $('location-status').classList.toggle('error', error);
}

function showSearchError(message, input, request, canRetry) {
  status(message, true);
  if (!canRetry) return;
  const retry = element('button', 'secondary', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', () => {
    if (request !== state.request) return;
    ++state.geoRequest;
    loadShows({ ...input });
  });
  $('location-status').append(element('span', '', ' '), retry);
}

function stopSuggestions() {
  clearTimeout(state.suggestionsTimer);
  state.suggestionsTimer = null;
  state.suggestionsController?.abort();
  state.suggestionsController = null;
}

async function loadSuggestions() {
  if (state.suggestionsLoaded || state.pendingSearch || state.controller) return;
  const controller = state.suggestionsController = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('/api/browser/artists', {
      headers: { Accept: 'application/json' }, signal: controller.signal,
      credentials: 'same-origin', cache: 'no-store',
    });
    const data = response.ok ? await response.json() : null;
    if (controller.signal.aborted || state.suggestionsController !== controller || !Array.isArray(data?.artists)) return;
    const suggestions = data.artists.filter(name => typeof name === 'string' && name.length <= 120).map(name => {
      const option = element('option'); option.value = name; option.label = 'Artist'; return option;
    });
    $('artist-suggestions').replaceChildren(...suggestions);
    state.suggestionsLoaded = true;
  } catch {
    // Suggestions are optional. Their availability cannot replace show results.
  } finally {
    clearTimeout(timeout);
    if (state.suggestionsController === controller) state.suggestionsController = null;
  }
}

function scheduleSuggestions() {
  if (state.suggestionsLoaded) return;
  clearTimeout(state.suggestionsTimer);
  state.suggestionsTimer = setTimeout(() => {
    state.suggestionsTimer = null;
    loadSuggestions();
  }, suggestionsDelayMs);
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
  stopSuggestions();
  state.controller?.abort();
  const request = ++state.request;
  const controller = state.controller = new AbortController();
  let timeout, timedOut = false, succeeded = false, canRetry = true;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error('The search took too long. Try again or enter a city.'));
      controller.abort();
    }, searchTimeoutMs);
  });
  const slowTimer = setTimeout(() => {
    if (request === state.request) status('Still finding shows… You can enter a city or artist while this loads.');
  }, slowSearchMs);
  state.pendingSearch = { ...input };
  $('show-grid').replaceChildren();
  $('show-grid').setAttribute('aria-busy', 'true');
  $('feed-freshness').hidden = true;
  status('Finding shows…');
  try {
    const result = (async () => {
      const response = await fetch('/api/browser/shows', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...input, view: state.view, timeZone }),
        signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
      });
      return { response, data: await response.json().catch(() => ({})) };
    })();
    const { response, data } = await Promise.race([result, deadline]);
    if (request !== state.request) return;
    if (!response.ok) {
      canRetry = response.status >= 500 || response.status === 429;
      throw new Error(typeof data.error === 'string' ? data.error : 'The show feed is temporarily unavailable. Please try again.');
    }
    if (!Array.isArray(data.shows)) throw new Error('The show feed returned an incomplete response. Please try again.');
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
        : data.artistRegistration?.status === 'queued' ? ` “${data.artistRegistration.name || name}” was saved for the next analysis batch. Verified artists will be added after processing.`
        : data.artistRegistration?.status === 'unverified' ? ` Could not verify “${data.artistRegistration.name || name}” as a music artist; not added.`
        : data.artistRegistration?.status === 'verification-unavailable' ? ' Artist verification is temporarily unavailable; not added.'
        : data.artistRegistration?.status === 'not-saved' ? ' Artist list update could not be confirmed.' : '';
      status(`${data.shows.length ? name : `No shows found for ${name}`} · ${scope}.${saved}`);
    } else status(data.shows.length ? `Shows near ${label} · ${rangeLabel}` : `No shows near ${label} · ${rangeLabel}. Try another location, artist or date range.`);
    succeeded = true;
  } catch (error) {
    if (request !== state.request || error.name === 'AbortError' && !timedOut) return;
    const message = timedOut ? 'The search took too long. Try again or enter a city.'
      : error.name === 'TypeError' ? 'Could not connect to the show feed. Please try again.'
      : error.message || 'The show feed is temporarily unavailable. Please try again.';
    showSearchError(message, input, request, canRetry);
  } finally {
    clearTimeout(timeout);
    clearTimeout(slowTimer);
    if (request === state.request) {
      state.pendingSearch = null;
      state.controller = null;
      $('show-grid').setAttribute('aria-busy', 'false');
      if (succeeded) scheduleSuggestions();
    }
  }
}

function requestLocation() {
  stopSuggestions();
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
  if (!state.origin && state.pendingSearch?.latitude !== undefined && state.pendingSearch.query === undefined) {
    ++state.request;
    state.controller?.abort();
    state.controller = null;
    state.pendingSearch = null;
    $('show-grid').setAttribute('aria-busy', 'false');
  }
  if (!state.origin) status('Enter a city, ZIP code or artist name.');
});

window.addEventListener('pageshow', (event) => { if (event.persisted) requestLocation(); });
requestLocation();
