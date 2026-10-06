/**
 * Rave Now's server-only artist catalog bridge.
 *
 * Deploy as a web app executing as the spreadsheet owner, with access Anyone.
 * Set ARTIST_CATALOG_SECRET (at least 32 random characters) in Script Properties,
 * then set the same secret and this deployment's /exec URL in the HF Space's
 * Secrets as ARTIST_CATALOG_SECRET and ARTIST_CATALOG_URL. Never put this key in
 * a browser, repository, or URL. Catalog reads return only name columns; show
 * reads return only the eight documented event columns. Event rows are read-only.
 *
 * Web apps cannot use bound getActiveSpreadsheet(). Fixed openById therefore
 * requires https://www.googleapis.com/auth/spreadsheets. The OAuth permission
 * covers Sheets; this code nevertheless opens only the workbook and tab IDs
 * configured in server-side Script Properties, never request-provided IDs.
 * No Drive, Gmail, external-fetch, or event-collection access is used. readShows
 * reads the current event sheet; it does not research or modify events.
 */

var CATALOG_MAX_NAME_LENGTH = 120;
var CATALOG_MAX_SHOW_ROWS = 10000;
var CATALOG_MAX_SHOW_COLUMNS = 100;
var CATALOG_SHOW_HEADERS = ['Artist', 'Event', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];

function doPost(e) {
  try {
    var content = e && e.postData && e.postData.contents;
    if (typeof content !== 'string' || content.length > 4096) return catalogOutput_({ ok: false, code: 'INVALID_REQUEST' });
    var input = JSON.parse(content);
    var properties = PropertiesService.getScriptProperties();
    var secret = properties.getProperty('ARTIST_CATALOG_SECRET');
    if (!secret || secret.length < 32 || !input || typeof input !== 'object' || Array.isArray(input) || !catalogSecretEquals_(input.secret, secret)) {
      return catalogOutput_({ ok: false, code: 'UNAUTHORIZED' });
    }
    if (input.action !== 'readCatalog' && input.action !== 'ensureArtist' && input.action !== 'readShows') return catalogOutput_({ ok: false, code: 'INVALID_ACTION' });
    var config = catalogConfiguration_(properties);
    var name = input.action === 'ensureArtist' ? catalogCleanName_(input.name) : null;
    // Protect both reads and deduplicating additions from overlapping requests.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return catalogOutput_({ ok: false, code: 'BUSY' });
    try {
      var workbook = SpreadsheetApp.openById(config.workbookId);
      if (input.action === 'readShows') return catalogOutput_({ ok: true, rows: catalogShowRows_(workbook, config.showSheetId) });
      var artistSheet = catalogSheet_(workbook, config.artistSheetId, 'Artist List');
      var promoterSheet = catalogSheet_(workbook, config.promoterSheetId, 'Promoter List');
      var artists = catalogNames_(artistSheet);
      if (input.action === 'readCatalog') return catalogOutput_({ ok: true, artists: artists, promoters: catalogNames_(promoterSheet) });
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
