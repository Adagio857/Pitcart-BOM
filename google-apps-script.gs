/**
 * @OnlyCurrentDoc
 */

const SHEET_NAME = 'Parts';
const FOLDERS_SHEET_NAME = 'Folders';
const HEADERS = [
  'id',
  'name',
  'partNumber',
  'originalPartNumber',
  'folder',
  'quantity',
  'unitPrice',
  'material',
  'thickness',
  'processes',
  'drawingUrl',
  'vendor',
  'location',
  'notes'
];
const FOLDER_HEADERS = ['path', 'order'];

function doGet(e) {
  const result = handleRequest_(e);
  const callback = e && e.parameter && e.parameter.callback;
  const output = callback
    ? `${callback}(${JSON.stringify(result)});`
    : JSON.stringify(result);

  return ContentService
    .createTextOutput(output)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const payload = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (payload.action !== 'replaceAll') {
      return json_({ ok: false, error: 'Unsupported action.' });
    }

    writeParts_(normalizePartNumbers_(payload.parts || []));
    writeFolders_(payload.folders || []);
    return json_({ ok: true });
  } catch (error) {
    return json_({ ok: false, error: String(error) });
  } finally {
    lock.releaseLock();
  }
}

function handleRequest_(e) {
  try {
    const action = e && e.parameter && e.parameter.action;
    if (action === 'replaceAll') {
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        const payload = JSON.parse((e.parameter && e.parameter.payload) || '{}');
        writeParts_(normalizePartNumbers_(payload.parts || []));
        writeFolders_(payload.folders || []);
        return { ok: true };
      } finally {
        lock.releaseLock();
      }
    }

    if (action !== 'list') return { ok: false, error: 'Unsupported action.' };
    return { ok: true, parts: readParts_(), folders: readFolders_() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function getFoldersSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open this script from Extensions > Apps Script inside the target Google Sheet.');

  let sheet = spreadsheet.getSheetByName(FOLDERS_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(FOLDERS_SHEET_NAME);

  const currentHeaders = sheet.getRange(1, 1, 1, FOLDER_HEADERS.length).getValues()[0];
  const needsHeaders = FOLDER_HEADERS.some((header, index) => currentHeaders[index] !== header);
  if (needsHeaders) {
    sheet.getRange(1, 1, 1, FOLDER_HEADERS.length).setValues([FOLDER_HEADERS]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function getSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open this script from Extensions > Apps Script inside the target Google Sheet.');

  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);

  const currentHeaders = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const needsHeaders = HEADERS.some((header, index) => currentHeaders[index] !== header);
  if (needsHeaders) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function readParts_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  return values
    .filter(row => row.some(value => value !== ''))
    .map(row => {
      const part = {};
      HEADERS.forEach((header, index) => {
        part[header] = row[index];
      });
      return part;
    });
}

function writeParts_(parts) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
  }

  if (!parts.length) return;

  const rows = parts.map(part =>
    HEADERS.map(header => {
      if (header === 'processes' && Array.isArray(part.processes)) {
        return part.processes.map(process => `${process.name}:${process.status}`).join('; ');
      }
      return part[header] == null ? '' : part[header];
    })
  );

  sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
}

function normalizePartNumbers_(parts) {
  const used = {};
  let highest = 0;

  parts.forEach(part => {
    const number = String(part.partNumber || '');
    const match = number.match(/(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  });

  return parts.map(part => {
    let number = String(part.partNumber || '');
    if (!number || used[number]) {
      highest += 1;
      number = `PT-${String(highest).padStart(4, '0')}`;
      part.partNumber = number;
      if (!part.originalPartNumber || used[String(part.originalPartNumber)]) {
        part.originalPartNumber = number;
      }
    }

    used[number] = true;
    return part;
  });
}

function readFolders_() {
  const sheet = getFoldersSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  return sheet
    .getRange(2, 1, lastRow - 1, FOLDER_HEADERS.length)
    .getValues()
    .map(row => String(row[0] || '').trim())
    .filter(Boolean);
}

function writeFolders_(folders) {
  const sheet = getFoldersSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).clearContent();
  }

  const seen = {};
  const uniqueFolders = folders
    .map(folder => String(folder || '').trim())
    .filter(folder => {
      if (!folder || seen[folder]) return false;
      seen[folder] = true;
      return true;
    });
  if (!uniqueFolders.length) return;

  sheet
    .getRange(2, 1, uniqueFolders.length, FOLDER_HEADERS.length)
    .setValues(uniqueFolders.map((folder, index) => [folder, index]));
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
