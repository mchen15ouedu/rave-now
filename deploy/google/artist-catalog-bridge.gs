/**
 * Rave Now's server-only artist catalog bridge.
 *
 * Deploy as a web app executing as the spreadsheet owner, with access Anyone.
 * Set ARTIST_CATALOG_SECRET (at least 32 random characters) in Script Properties,
 * then set the same secret and this deployment's /exec URL in the HF Space's
 * Secrets as ARTIST_CATALOG_SECRET and ARTIST_CATALOG_URL. Never put this key in
 * a browser, repository, or URL. Catalog reads return only name columns; show
 * reads return only the eight documented event columns. ensureEvent writes only
 * independently verified event fields and preserves populated tracker facts.
 *
 * Web apps cannot use bound getActiveSpreadsheet(). Fixed openById therefore
 * requires https://www.googleapis.com/auth/spreadsheets. The OAuth permission
 * covers Sheets; this code nevertheless opens only the workbook and tab IDs
 * configured in server-side Script Properties, never request-provided IDs.
 * No Drive, Gmail, external-fetch, or event-collection access is used. readShows
 * reads the current event sheet; it does not research events.
 */

var CATALOG_MAX_NAME_LENGTH = 120;
var CATALOG_MAX_SHOW_ROWS = 10000;
var CATALOG_MAX_SHOW_COLUMNS = 100;
var CATALOG_SHOW_HEADERS = ['Artist', 'Event', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];

function doPost(e) {
  try {
    var content = e && e.postData && e.postData.contents;
    if (typeof content !== 'string' || content.length > 16384) return catalogOutput_({ ok: false, code: 'INVALID_REQUEST' });
    var input = JSON.parse(content);
    var properties = PropertiesService.getScriptProperties();
    var secret = properties.getProperty('ARTIST_CATALOG_SECRET');
    if (!secret || secret.length < 32 || !input || typeof input !== 'object' || Array.isArray(input) || !catalogSecretEquals_(input.secret, secret)) {
      return catalogOutput_({ ok: false, code: 'UNAUTHORIZED' });
    }
    if (input.action !== 'readCatalog' && input.action !== 'ensureArtist' && input.action !== 'readShows' && input.action !== 'ensureEvent') return catalogOutput_({ ok: false, code: 'INVALID_ACTION' });
    var config = catalogConfiguration_(properties);
    var name = input.action === 'ensureArtist' ? catalogCleanName_(input.name) : null;
    var event = input.action === 'ensureEvent' ? catalogEventInput_(input.event) : null;
    var workbook = SpreadsheetApp.openById(config.workbookId);
    if (input.action === 'readShows') return catalogOutput_({ ok: true, rows: catalogShowRows_(workbook, config.showSheetId) });
    if (input.action === 'readCatalog') {
      var readArtistSheet = catalogSheet_(workbook, config.artistSheetId, 'Artist List');
      var readPromoterSheet = catalogSheet_(workbook, config.promoterSheetId, 'Promoter List');
      return catalogOutput_({ ok: true, artists: catalogNames_(readArtistSheet), promoters: catalogNames_(readPromoterSheet) });
    }
    // Only deduplicating writes require a lock; independent reads must not wait
    // behind a refresh or an optional artist-suggestion request.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return catalogOutput_({ ok: false, code: 'BUSY' });
    try {
      if (input.action === 'ensureEvent') return catalogOutput_(catalogEnsureEvent_(workbook, config.showSheetId, event));
      var artistSheet = catalogSheet_(workbook, config.artistSheetId, 'Artist List');
      var promoterSheet = catalogSheet_(workbook, config.promoterSheetId, 'Promoter List');
      var artists = catalogNames_(artistSheet);
      var key = catalogNameKey_(name);
      for (var i = 0; i < artists.length; i++) {
        if (catalogNameKey_(artists[i]) === key) return catalogOutput_({ ok: true, name: artists[i], added: false });
      }
      var row = Math.max(2, artistSheet.getLastRow() + 1);
      if (row > artistSheet.getMaxRows()) artistSheet.insertRowsAfter(artistSheet.getMaxRows(), 1);
      var target = artistSheet.getRange(row, 2);
      // Copy only formatting to a new row. Instagram and Notes stay empty.
      if (row > 2) artistSheet.getRange(row - 1, 1, 1, 3).copyFormatToRange(artistSheet, 1, 3, row, row);
      // RichTextValue holds text, avoiding formula execution for names like
      // '=HYPERLINK(...)'. setValue/setValues interpret a leading '=' as formula.
      var style = target.getTextStyle();
      var value = SpreadsheetApp.newRichTextValue().setText(name).setTextStyle(style).build();
      target.setRichTextValue(value);
      SpreadsheetApp.flush();
      return catalogOutput_({ ok: true, name: name, added: true });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    // Google exception messages can contain document details. Never return them.
    return catalogOutput_({ ok: false, code: error && error.catalogCode || 'UNAVAILABLE' });
  }
}

function doGet() { return catalogOutput_({ ok: false, code: 'POST_REQUIRED' }); }

function catalogConfiguration_(properties) {
  var workbookId = (properties.getProperty('CATALOG_WORKBOOK_ID') || '').trim();
  var keys = ['CATALOG_ARTIST_SHEET_ID', 'CATALOG_PROMOTER_SHEET_ID', 'CATALOG_SHOW_SHEET_ID'];
  var ids = keys.map(function (key) {
    var value = (properties.getProperty(key) || '').trim();
    if (!/^\d+$/.test(value) || Number(value) > 2147483647) return null;
    return Number(value);
  });
  if (!/^[A-Za-z0-9_-]+$/.test(workbookId) || ids.some(function (id) { return id === null; }) || new Set(ids).size !== ids.length) {
    var error = new Error('Configure workbook and tab IDs in Script Properties'); error.catalogCode = 'INVALID_CONFIGURATION'; throw error;
  }
  return { workbookId: workbookId, artistSheetId: ids[0], promoterSheetId: ids[1], showSheetId: ids[2] };
}

function catalogSheet_(workbook, id, expectedName) {
  var sheet = workbook.getSheetById(id);
  if (!sheet || sheet.getName() !== expectedName || sheet.getRange(1, 2).getDisplayValue().trim() !== 'Name') {
    var error = new Error('Catalog structure changed'); error.catalogCode = 'INVALID_STRUCTURE'; throw error;
  }
  return sheet;
}

function catalogShowRows_(workbook, showSheetId) {
  var sheet = workbook.getSheetById(showSheetId);
  if (!sheet || sheet.getName() !== 'Upcoming Shows') {
    var missing = new Error('Show structure changed'); missing.catalogCode = 'INVALID_STRUCTURE'; throw missing;
  }
  var rowCount = sheet.getLastRow(), columnCount = sheet.getLastColumn();
  if (rowCount < 1 || columnCount < 1) {
    var empty = new Error('Show headers missing'); empty.catalogCode = 'INVALID_STRUCTURE'; throw empty;
  }
  if (rowCount - 1 > CATALOG_MAX_SHOW_ROWS || columnCount > CATALOG_MAX_SHOW_COLUMNS) {
    var limit = new Error('Show limits exceeded'); limit.catalogCode = 'LIMIT_EXCEEDED'; throw limit;
  }
  var values = sheet.getRange(1, 1, rowCount, columnCount).getDisplayValues();
  var keys = values[0].map(function (header) { return header.trim().toLowerCase().replace(/[^a-z0-9]/g, ''); });
  var indexes = CATALOG_SHOW_HEADERS.map(function (header) {
    var key = header.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    var index = keys.indexOf(key);
    if (index < 0 || keys.lastIndexOf(key) !== index) {
      var invalid = new Error('Show headers changed'); invalid.catalogCode = 'INVALID_STRUCTURE'; throw invalid;
    }
    return index;
  });
  var rows = [CATALOG_SHOW_HEADERS.slice()];
  for (var row = 1; row < values.length; row++) {
    rows.push(indexes.map(function (index) { return values[row][index]; }));
  }
  return rows;
}

function catalogEventError_(code) { var error = new Error('Event write rejected'); error.catalogCode = code; throw error; }

function catalogEventText_(value, maximum, required) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) catalogEventError_('INVALID_EVENT');
  var clean = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (clean.length > maximum || required && !clean) catalogEventError_('INVALID_EVENT');
  return clean;
}

function catalogEventUrl_(value, required, youtube) {
  var clean = catalogEventText_(value, 2048, required);
  if (!clean) return '';
  // Apps Script has no browser URL global. Accept only an ordinary public
  // HTTPS hostname, no credentials/custom ports or whitespace-bearing URLs.
  var match = clean.match(/^https:\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?::443)?(?:[/?#][^\s<>"\\]*)?$/i);
  if (!match || youtube && ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].indexOf(match[1].toLowerCase()) < 0) catalogEventError_('INVALID_EVENT');
  return clean;
}

function catalogEventDate_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  var parts = value.split('-').map(Number), date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return parts[0] >= 2000 && parts[0] <= 2100 && date.toISOString().slice(0, 10) === value ? value : null;
}

function catalogEventInput_(value) {
  var fields = ['artist', 'event', 'venue', 'city', 'address', 'date', 'ticketUrl', 'youtubeUrl', 'sourceUrl'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(function (key) { return fields.indexOf(key) < 0; })) catalogEventError_('INVALID_EVENT');
  var result = {
    artist: catalogEventText_(value.artist, 120, true),
    event: catalogEventText_(value.event == null ? '' : value.event, 240, false),
    venue: catalogEventText_(value.venue == null ? '' : value.venue, 240, false),
    city: catalogEventText_(value.city, 160, true),
    address: catalogEventText_(value.address == null ? '' : value.address, 500, false),
    date: catalogEventText_(value.date, 10, true),
    ticketUrl: catalogEventUrl_(value.ticketUrl == null ? '' : value.ticketUrl, false, false),
    youtubeUrl: catalogEventUrl_(value.youtubeUrl == null ? '' : value.youtubeUrl, false, true),
    sourceUrl: catalogEventUrl_(value.sourceUrl, true, false)
  };
  if ((!result.event && !result.venue) || !catalogEventDate_(result.date)) catalogEventError_('INVALID_EVENT');
  return result;
}

function catalogEventKey_(value) { return String(value == null ? '' : value).normalize('NFKD').replace(/\p{M}/gu, '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'); }
function catalogEventCityKey_(value) { return catalogEventKey_(value); }
function catalogEventLinkKey_(value) { return String(value || '').trim().replace(/#.*$/, '').replace(/^https:\/\/([^/]+)/i, function (all, host) { return 'https://' + host.toLowerCase().replace(/:443$/, ''); }); }

function catalogExistingEventDate_(raw, display, zone) {
  if (Object.prototype.toString.call(raw) === '[object Date]' && !isNaN(raw.getTime())) return catalogEventDate_(Utilities.formatDate(raw, zone, 'yyyy-MM-dd'));
  var value = String(display || raw || '').trim(), direct = catalogEventDate_(value);
  if (direct) return direct;
  var numeric = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (numeric) return catalogEventDate_(numeric[3] + '-' + ('0' + numeric[1]).slice(-2) + '-' + ('0' + numeric[2]).slice(-2));
  value = value.replace(/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?),?\s+/i, '');
  var named = value.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:\s+\d{1,2}:\d{2}(?:\s*[ap]m)?)?$/i);
  if (!named) return null;
  var month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(named[1].slice(0, 3).toLowerCase()) + 1;
  return month ? catalogEventDate_(named[3] + '-' + ('0' + month).slice(-2) + '-' + ('0' + named[2]).slice(-2)) : null;
}

function catalogEnsureEvent_(workbook, sheetId, event) {
  var sheet = workbook.getSheetById(sheetId);
  if (!sheet || sheet.getName() !== 'Upcoming Shows') catalogEventError_('INVALID_STRUCTURE');
  var height = sheet.getLastRow(), width = sheet.getLastColumn();
  if (height < 1 || width < 1) catalogEventError_('INVALID_STRUCTURE');
  if (height - 1 > CATALOG_MAX_SHOW_ROWS || width > CATALOG_MAX_SHOW_COLUMNS) catalogEventError_('LIMIT_EXCEEDED');
  var range = sheet.getRange(1, 1, height, width), display = range.getDisplayValues(), raw = range.getValues(), formulas = range.getFormulas();
  var headers = display[0].map(function (value) { return value.trim().toLowerCase().replace(/[^a-z0-9]/g, ''); });
  var indexes = CATALOG_SHOW_HEADERS.map(function (header) {
    var key = header.trim().toLowerCase().replace(/[^a-z0-9]/g, ''), index = headers.indexOf(key);
    if (index < 0 || headers.lastIndexOf(key) !== index) catalogEventError_('INVALID_STRUCTURE');
    return index;
  });
  var sources = headers.map(function (key, index) { return key === 'sourceurl' || key === 'sourcelink' ? index : -1; }).filter(function (index) { return index >= 0; });
  if (sources.length > 1) catalogEventError_('INVALID_STRUCTURE');
  var sourceIndex = sources.length ? sources[0] : -1, zone = workbook.getSpreadsheetTimeZone();
  var key = catalogEventKey_(event.artist), cityKey = catalogEventCityKey_(event.city), candidates = [];
  for (var row = 1; row < height; row++) {
    if (catalogEventKey_(display[row][indexes[0]]) !== key) continue;
    var date = catalogExistingEventDate_(raw[row][indexes[6]], display[row][indexes[6]], zone);
    if (date && date !== event.date) continue;
    var oldCity = catalogEventCityKey_(display[row][indexes[3]]);
    var linkMatch = Boolean(event.ticketUrl && catalogEventLinkKey_(display[row][indexes[5]]) === catalogEventLinkKey_(event.ticketUrl) || sourceIndex >= 0 && catalogEventLinkKey_(display[row][sourceIndex]) === catalogEventLinkKey_(event.sourceUrl));
    var sameCityName = catalogEventKey_(oldCity.split(',')[0]) === catalogEventKey_(cityKey.split(',')[0]);
    if (oldCity && oldCity !== cityKey && !linkMatch && !sameCityName) continue;
    candidates.push({ row: row, date: date, city: oldCity, linked: linkMatch });
  }
  var targetRow = candidates.length ? candidates[0].row + 1 : height + 1;
  var receipt = function (status) { return { ok: true, status: status, row: targetRow, event: event }; };
  if (candidates.length > 1) return receipt('conflict');
  var merging = candidates.length === 1;
  if (merging) {
    var candidate = candidates[0], existing = display[candidate.row];
    var oldVenue = catalogEventKey_(existing[indexes[2]]), oldEvent = catalogEventKey_(existing[indexes[1]]);
    var newVenue = catalogEventKey_(event.venue), newEvent = catalogEventKey_(event.event);
    var compatible = !(oldVenue && newVenue && oldVenue !== newVenue) && !(oldEvent && newEvent && oldEvent !== newEvent);
    var samePlaceOrEvent = Boolean(oldVenue && oldVenue === newVenue || oldEvent && oldEvent === newEvent);
    if (candidate.date !== event.date || candidate.city && candidate.city !== cityKey || !candidate.linked && (!compatible || !samePlaceOrEvent)) return receipt('conflict');
  } else if (height - 1 >= CATALOG_MAX_SHOW_ROWS) catalogEventError_('LIMIT_EXCEEDED');
  var keys = ['artist', 'event', 'venue', 'city', 'address', 'ticketUrl', 'date', 'youtubeUrl'];
  var plan = [];
  for (var i = 0; i < keys.length; i++) {
    if (merging && (keys[i] === 'artist' || keys[i] === 'date')) continue;
    var value = event[keys[i]], column = indexes[i];
    if (!value || merging && (raw[targetRow - 1][column] !== '' || formulas[targetRow - 1][column] || display[targetRow - 1][column].trim())) continue;
    plan.push({ column: column + 1, value: value });
  }
  if (sourceIndex >= 0 && (!merging || raw[targetRow - 1][sourceIndex] === '' && !formulas[targetRow - 1][sourceIndex] && !display[targetRow - 1][sourceIndex].trim())) plan.push({ column: sourceIndex + 1, value: event.sourceUrl });
  if (!plan.length) return receipt('exists');
  var growing = targetRow > sheet.getMaxRows();
  // Complex native validation is not guessed or removed. Any constrained,
  // merged, protected or formula-bearing target blocks this operation.
  for (var p = 0; p < plan.length; p++) {
    var cell = sheet.getRange(growing ? height : targetRow, plan[p].column);
    if (cell.isPartOfMerge() || !cell.canEdit() || cell.getDataValidation() || !growing && (cell.getFormula() || cell.getValue() !== '')) return receipt('conflict');
  }
  if (growing) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 1);
    sheet.getRange(height, 1, 1, width).copyFormatToRange(sheet, 1, width, targetRow, targetRow);
  }
  for (var write = 0; write < plan.length; write++) {
    var target = sheet.getRange(targetRow, plan[write].column);
    var rich = SpreadsheetApp.newRichTextValue().setText(plan[write].value).setTextStyle(target.getTextStyle()).build();
    target.setRichTextValue(rich);
  }
  SpreadsheetApp.flush();
  return receipt(merging ? 'merged' : 'added');
}

function catalogCleanName_(name) {
  if (typeof name !== 'string' || /[\p{Cc}\p{Cf}]/u.test(name)) {
    var error = new Error('Invalid name'); error.catalogCode = 'INVALID_NAME'; throw error;
  }
  var clean = name.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!clean || clean.length > CATALOG_MAX_NAME_LENGTH) {
    var invalid = new Error('Invalid name'); invalid.catalogCode = 'INVALID_NAME'; throw invalid;
  }
  return clean;
}

function catalogNameKey_(name) {
  return catalogCleanName_(name).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US');
}

function catalogNames_(sheet) {
  var count = sheet.getLastRow() - 1;
  if (count <= 0) return [];
  if (count > 30000) throw new Error('Catalog too large');
  var values = sheet.getRange(2, 2, count, 1).getDisplayValues();
  var seen = Object.create(null), names = [];
  for (var i = 0; i < values.length; i++) {
    if (!values[i][0].trim()) continue;
    var name = catalogCleanName_(values[i][0]), key = catalogNameKey_(name);
    if (!seen[key]) { seen[key] = true; names.push(name); }
  }
  return names;
}

function catalogSecretEquals_(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false;
  var difference = 0;
  for (var i = 0; i < expected.length; i++) difference |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function catalogOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
