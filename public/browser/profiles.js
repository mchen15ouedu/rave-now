const providers = ['instagram', 'youtube', 'spotify'];
const labels = { instagram: 'Instagram', youtube: 'YouTube / YouTube Music', spotify: 'Spotify' };
const storageKey = 'rave-now:profiles:v1';
const instagramRoutes = new Set(['p', 'reel', 'reels', 'stories', 'tv', 'explore', 'direct', 'accounts', 'about', 'legal', 'privacy', 'web', 'developer', 'developers', 'api', 'oauth', 'challenge', 'directory', 'emails', 'terms']);

export function normalizeProfileLink(provider, value) {
  if (!providers.includes(provider)) throw new Error('Choose a supported profile provider.');
  if (typeof value !== 'string') throw new Error(`Enter a valid ${labels[provider]} profile link.`);
  const input = value.trim();
  if (!input) return null;
  const invalid = () => { throw new Error(`Enter an HTTPS ${labels[provider]} public profile link.`); };
  if (!/^https:\/\//i.test(input) || /[\\\s\u0000-\u001f\u007f]/u.test(input)) return invalid();
  let url;
  try { url = new URL(input); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return invalid();
  // Read the original path as well: URL parsing resolves dot segments before validation.
  const originalPath = input.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1] || '/';
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(originalPath)) return invalid();
  let path = originalPath.replace(/\/$/, '');
  if (provider === 'youtube') {
    try {
      const decoded = decodeURIComponent(path);
      // Encoded non-ASCII handles are valid, encoded ASCII/path separators are not.
      if (originalPath.includes('%') && encodeURI(decoded) !== path) return invalid();
      path = decoded;
    } catch { return invalid(); }
  } else if (originalPath.includes('%')) return invalid();
  let host;
  if (provider === 'instagram') {
    if (!['instagram.com', 'www.instagram.com'].includes(url.hostname)) return invalid();
    const username = path.slice(1);
    if (!/^\/[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?$/.test(path)
      || username.includes('..') || instagramRoutes.has(username.toLowerCase())) return invalid();
    host = 'instagram.com';
  } else if (provider === 'youtube') {
    if (!['youtube.com', 'www.youtube.com', 'music.youtube.com'].includes(url.hostname)) return invalid();
    if (!/^\/channel\/UC[A-Za-z0-9_-]{22}$/.test(path)
      && !/^\/@[\p{L}\p{N}\p{M}_.-]{1,30}$/u.test(path)) return invalid();
    host = url.hostname === 'music.youtube.com' ? 'music.youtube.com' : 'youtube.com';
  } else {
    if (!['open.spotify.com', 'www.open.spotify.com'].includes(url.hostname)
      || !/^\/user\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(path)) return invalid();
    host = 'open.spotify.com';
  }
  return new URL(`https://${host}${path}`).href;
}

export function initProfileLinks(document, window) {
  const get = (id) => document.getElementById(id);
  const opener = get('profiles-open'), dialog = get('profiles-dialog'), form = get('profiles-form');
  const cancel = get('profiles-cancel'), status = get('profiles-status'), summary = get('profiles-summary');
  const fields = Object.fromEntries(providers.map((provider) => [provider, get(`profile-${provider}`)]));
  if (![opener, dialog, form, cancel, status, summary, ...Object.values(fields)].every(Boolean)) return false;
  const empty = () => Object.fromEntries(providers.map((provider) => [provider, null]));
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle('error', error);
  };
  const updateSummary = (profiles) => {
    const count = providers.filter((provider) => profiles[provider]).length;
    const label = count ? `Music profiles (${count})` : 'Link music profiles';
    summary.textContent = label;
    opener.setAttribute('aria-label', label);
  };
  const load = () => {
    const profiles = empty();
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) return { profiles };
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error();
      let invalid = false;
      for (const provider of providers) {
        if (saved[provider] === undefined || saved[provider] === null) continue;
        try { profiles[provider] = normalizeProfileLink(provider, saved[provider]); } catch { invalid = true; }
      }
      return { profiles, warning: invalid ? 'Some saved links were invalid. Check your public profile links.' : '' };
    } catch {
      return { profiles, warning: 'Saved links could not be read on this device. Enter your public profile links.' };
    }
  };
  updateSummary(load().profiles);
  opener.addEventListener('click', () => {
    const { profiles, warning } = load();
    for (const provider of providers) fields[provider].value = profiles[provider] || '';
    updateSummary(profiles);
    setStatus(warning || '', Boolean(warning));
    dialog.showModal();
  });
  cancel.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const profiles = empty();
    for (const provider of providers) {
      try { profiles[provider] = normalizeProfileLink(provider, fields[provider].value); }
      catch (error) { setStatus(error.message, true); fields[provider].focus(); return; }
    }
    const count = providers.filter((provider) => profiles[provider]).length;
    try {
      if (count) window.localStorage.setItem(storageKey, JSON.stringify(profiles));
      else window.localStorage.removeItem(storageKey);
    } catch {
      setStatus('Could not save profile links on this device. Your changes were not saved.', true);
      return;
    }
    for (const provider of providers) fields[provider].value = profiles[provider] || '';
    updateSummary(profiles);
    setStatus(`${count ? 'Saved on this device.' : 'Profile links removed from this device.'} Listening history is not imported.`);
    dialog.close();
  });
  return true;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') initProfileLinks(document, window);
