import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfileLink, initProfileLinks } from '../public/browser/profiles.js';

const key = 'rave-now:profiles:v1';
const instagram = 'https://instagram.com/rave.dj';
const youtube = 'https://youtube.com/@RaveNow';
const spotify = 'https://open.spotify.com/user/rave_user';

class Element {
  constructor() { this.value = ''; this.textContent = ''; this.handlers = {}; this.attributes = {}; this.open = false; this.classList = { toggle: (name, active) => { this[name] = active; } }; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function page({ saved = null, failRead = false, failWrite = false } = {}) {
  const ids = ['profiles-open', 'profiles-dialog', 'profiles-form', 'profile-instagram', 'profile-youtube', 'profile-spotify', 'profiles-cancel', 'profiles-status', 'profiles-summary'];
  const nodes = new Map(ids.map((id) => [id, new Element()])), operations = [], values = new Map();
  if (saved !== null) values.set(key, saved);
  const localStorage = {
    getItem(name) { operations.push(['read', name]); if (failRead) throw new Error('Blocked'); return values.get(name) ?? null; },
    setItem(name, value) { if (failWrite) throw new Error('Quota'); operations.push(['write', name, value]); values.set(name, value); },
    removeItem(name) { if (failWrite) throw new Error('Blocked'); operations.push(['remove', name]); values.delete(name); },
  };
  const document = { getElementById(id) { return nodes.get(id); } };
  const window = { localStorage, fetch() { throw new Error('Profile links must not make network requests'); } };
  assert.equal(initProfileLinks(document, window), true);
  return {
    nodes, values, operations,
    open() { nodes.get('profiles-open').handlers.click(); },
    submit() { nodes.get('profiles-form').handlers.submit({ preventDefault() {} }); },
    input(provider, value) { nodes.get(`profile-${provider}`).value = value; },
  };
}

test('supported public profile URLs are canonical and contain no query or fragment', () => {
  assert.equal(normalizeProfileLink('instagram', '  https://WWW.INSTAGRAM.COM/rave.dj/?igsh=private#bio  '), instagram);
  assert.equal(normalizeProfileLink('youtube', 'https://www.youtube.com/@RaveNow?si=private#video'), youtube);
  assert.equal(normalizeProfileLink('youtube', 'https://music.youtube.com/channel/UCabcdefghijklmnopqrstuv/'), 'https://music.youtube.com/channel/UCabcdefghijklmnopqrstuv');
  const international = 'https://youtube.com/@%E9%9F%B3%E4%B9%90%E9%A2%91%E9%81%93';
  assert.equal(normalizeProfileLink('youtube', 'https://youtube.com/@音乐频道'), international);
  assert.equal(normalizeProfileLink('youtube', international), international);
  assert.equal(normalizeProfileLink('spotify', 'https://www.open.spotify.com/user/rave_user?si=tracking'), spotify);
  assert.equal(normalizeProfileLink('instagram', 'https://instagram.com:443/rave.dj'), instagram);
  for (const provider of ['instagram', 'youtube', 'spotify']) assert.equal(normalizeProfileLink(provider, '  '), null);
});

test('profile validation rejects impostor hosts, credentials, ports and malformed paths', () => {
  for (const [provider, links] of [
    ['instagram', ['http://instagram.com/rave.dj', 'https://instagram.com.evil.example/rave.dj', 'https://evil.example/instagram.com/rave.dj', 'https://user:pass@instagram.com/rave.dj', 'https://instagram.com:444/rave.dj', 'https://instagram.com/p/abc', 'https://instagram.com/reels/', 'https://instagram.com/explore/', 'https://instagram.com/rave.dj/extra', 'https://instagram.com/.name', 'https://instagram.com/name.', 'https://instagram.com/rave..dj', 'https://instagram.com/a/../rave.dj', 'https://instagram.com/%72ave.dj', 'https://instagram.com\\rave.dj', 'https://instagram.com/ra\nve.dj']],
    ['youtube', ['https://youtube.com/watch?v=abc', 'https://youtube.com/playlist?list=abc', 'https://youtu.be/abc', 'https://youtube.com/@name/videos', 'https://youtube.com/channel/short', 'https://youtube.com.evil.example/@name', 'https://youtube.com/%40name', 'https://youtube.com/bad/%2e%2e/@name', 'https://youtube.com/@na%2fme', 'https://youtube.com/@na%5cme', 'https://youtube.com/@na%00me']],
    ['spotify', ['https://spotify.com/user/name', 'https://open.spotify.com/artist/abc', 'https://open.spotify.com/playlist/abc', 'https://open.spotify.com/user/name/extra', 'https://open.spotify.com.evil.example/user/name', 'https://open.spotify.com/user/%6eame']],
  ]) for (const link of links) assert.throws(() => normalizeProfileLink(provider, link), /public profile link/, link);
  assert.throws(() => normalizeProfileLink('unknown', instagram), /supported/);
  assert.throws(() => normalizeProfileLink('instagram', { href: instagram }), /valid/);
});

test('saving stores exactly three canonical public URLs locally and does not fetch history', () => {
  const app = page(); app.open();
  app.input('instagram', `${instagram}/?igsh=tracking`); app.input('youtube', youtube); app.input('spotify', spotify); app.submit();
  assert.deepEqual(JSON.parse(app.values.get(key)), { instagram, youtube, spotify });
  assert.equal(app.values.size, 1);
  assert.equal(app.nodes.get('profiles-dialog').open, false);
  assert.equal(app.nodes.get('profiles-summary').textContent, 'Music profiles (3)');
  assert.match(app.nodes.get('profiles-status').textContent, /Saved on this device\. Listening history is not imported\./);
  assert.equal(app.nodes.get('profiles-open').attributes['aria-label'], 'Music profiles (3)');
});

test('validation is atomic: an invalid later field leaves previous stored links and dialog intact', () => {
  const before = JSON.stringify({ instagram, youtube: null, spotify: null });
  const app = page({ saved: before }); app.open();
  app.input('instagram', 'https://instagram.com/newname'); app.input('spotify', 'https://open.spotify.com/artist/abc'); app.submit();
  assert.equal(app.values.get(key), before);
  assert.equal(app.operations.some(([operation]) => operation === 'write' || operation === 'remove'), false);
  assert.equal(app.nodes.get('profiles-dialog').open, true);
  assert.equal(app.nodes.get('profile-spotify').focused, true);
  assert.equal(app.nodes.get('profiles-summary').textContent, 'Music profiles (1)');
  assert.match(app.nodes.get('profiles-status').textContent, /Spotify public profile link/);
});

test('storage errors never claim saved and keep edits available to retry', () => {
  const app = page({ failWrite: true }); app.open(); app.input('youtube', youtube); app.submit();
  assert.equal(app.values.has(key), false);
  assert.equal(app.nodes.get('profiles-dialog').open, true);
  assert.equal(app.nodes.get('profile-youtube').value, youtube);
  assert.equal(app.nodes.get('profiles-summary').textContent, 'Link music profiles');
  assert.match(app.nodes.get('profiles-status').textContent, /changes were not saved/);
  const removal = page({ saved: JSON.stringify({ instagram }), failWrite: true }); removal.open(); removal.input('instagram', ''); removal.submit();
  assert.equal(removal.values.has(key), true);
  assert.equal(removal.nodes.get('profiles-dialog').open, true);
});

test('invalid stored data is ignored safely and storage access failures leave the feature usable', () => {
  for (const saved of ['{broken', 'null', '[]', '"string"']) {
    const app = page({ saved }); app.open();
    assert.equal(app.nodes.get('profile-instagram').value, '');
    assert.equal(app.nodes.get('profiles-summary').textContent, 'Link music profiles');
    assert.match(app.nodes.get('profiles-status').textContent, /could not be read/);
  }
  const app = page({ saved: JSON.stringify({ instagram, youtube: 'javascript:alert(1)', spotify: { token: 'secret' }, location: 'Dallas', token: 'secret' }) });
  app.open();
  assert.equal(app.nodes.get('profile-instagram').value, instagram);
  assert.equal(app.nodes.get('profile-youtube').value, '');
  assert.equal(app.nodes.get('profile-spotify').value, '');
  assert.match(app.nodes.get('profiles-status').textContent, /invalid/);
  app.submit();
  assert.deepEqual(JSON.parse(app.values.get(key)), { instagram, youtube: null, spotify: null });
  const blocked = page({ failRead: true }); blocked.open();
  assert.equal(blocked.nodes.get('profiles-dialog').open, true);
  assert.match(blocked.nodes.get('profiles-status').textContent, /could not be read/);
});

test('opening reloads saved links, cancel changes nothing, and clearing all removes only the profile key', () => {
  const app = page({ saved: JSON.stringify({ instagram }) });
  app.values.set('unrelated', 'keep'); app.open(); app.input('instagram', 'https://instagram.com/temporary');
  app.nodes.get('profiles-cancel').handlers.click();
  assert.equal(app.nodes.get('profiles-dialog').open, false);
  assert.equal(JSON.parse(app.values.get(key)).instagram, instagram);
  app.open(); assert.equal(app.nodes.get('profile-instagram').value, instagram);
  app.input('instagram', ''); app.submit();
  assert.equal(app.values.has(key), false); assert.equal(app.values.get('unrelated'), 'keep');
  assert.equal(app.nodes.get('profiles-summary').textContent, 'Link music profiles');
  assert.match(app.nodes.get('profiles-status').textContent, /removed from this device/);
});

test('initialization tolerates pages that do not include the optional profile dialog', () => {
  assert.equal(initProfileLinks({ getElementById() { return null; } }, {}), false);
});
