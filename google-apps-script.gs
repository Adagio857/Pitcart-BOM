/**
 * @OnlyCurrentDoc
 */

const SHEET_NAME = 'Parts';
const FOLDERS_SHEET_NAME = 'Folders';
const ATTACHMENTS_SHEET_NAME = 'Attachments';
const ATTACHMENT_CHUNK_SIZE = 40000;
const HEADERS = [
  'id',
  'name',
  'partNumber',
  'originalPartNumber',
  'folder',
  'quantity',
  'unitPrice',
  'discountPercent',
  'material',
  'thickness',
  'processes',
  'drawingUrl',
  'vendor',
  'location',
  'notes',
  'itemKind',
  'linkedBomId',
  'attachmentFileName',
  'attachmentMimeType'
];
const FOLDER_HEADERS = ['id', 'name', 'parentId', 'order', 'itemKind'];
const ATTACHMENT_HEADERS = ['partId', 'fileName', 'mimeType', 'chunkIndex', 'data'];

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

    const parts = normalizePartNumbers_(payload.parts || []);
    writeParts_(parts);
    writeFolders_(payload.folders || []);
    writeAttachments_(parts);
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
    if (action === 'beginSync') {
      return beginSync_(e.parameter);
    }

    if (action === 'appendSync') {
      return appendSync_(e.parameter);
    }

    if (action === 'commitSync') {
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        return commitSync_(e.parameter);
      } finally {
        lock.releaseLock();
      }
    }

    if (action === 'replaceAll') {
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        const payload = JSON.parse((e.parameter && e.parameter.payload) || '{}');
        const parts = normalizePartNumbers_(payload.parts || []);
        writeParts_(parts);
        writeFolders_(payload.folders || []);
        writeAttachments_(parts);
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

function beginSync_(parameter) {
  const session = String(parameter.session || '').trim();
  const total = Number(parameter.total || 0);
  if (!session || total < 1) return { ok: false, error: 'Invalid sync session.' };

  const cache = CacheService.getScriptCache();
  cache.put(`sync:${session}:total`, String(total), 600);
  return { ok: true };
}

function appendSync_(parameter) {
  const session = String(parameter.session || '').trim();
  const index = Number(parameter.index);
  const chunk = String(parameter.chunk || '');
  if (!session || !Number.isInteger(index) || index < 0 || !chunk) {
    return { ok: false, error: 'Invalid sync chunk.' };
  }

  CacheService.getScriptCache().put(`sync:${session}:${index}`, chunk, 600);
  return { ok: true };
}

function commitSync_(parameter) {
  const session = String(parameter.session || '').trim();
  const total = Number(parameter.total || 0);
  if (!session || total < 1) return { ok: false, error: 'Invalid sync commit.' };

  const cache = CacheService.getScriptCache();
  const cachedTotal = Number(cache.get(`sync:${session}:total`) || 0);
  if (cachedTotal !== total) return { ok: false, error: 'Sync session expired. Try syncing again.' };

  let encoded = '';
  for (let index = 0; index < total; index += 1) {
    const chunk = cache.get(`sync:${session}:${index}`);
    if (!chunk) return { ok: false, error: `Missing sync chunk ${index + 1} of ${total}. Try syncing again.` };
    encoded += chunk;
  }

  const payload = JSON.parse(decodeBase64Utf8_(encoded));
  const parts = normalizePartNumbers_(payload.parts || []);
  writeParts_(parts);
  writeFolders_(payload.folders || []);
  writeAttachments_(parts);
  return { ok: true };
}

function decodeBase64Utf8_(value) {
  return Utilities.newBlob(Utilities.base64Decode(value)).getDataAsString();
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

function getAttachmentsSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open this script from Extensions > Apps Script inside the target Google Sheet.');

  let sheet = spreadsheet.getSheetByName(ATTACHMENTS_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(ATTACHMENTS_SHEET_NAME);

  const currentHeaders = sheet.getRange(1, 1, 1, ATTACHMENT_HEADERS.length).getValues()[0];
  const needsHeaders = ATTACHMENT_HEADERS.some((header, index) => currentHeaders[index] !== header);
  if (needsHeaders) {
    sheet.getRange(1, 1, 1, ATTACHMENT_HEADERS.length).setValues([ATTACHMENT_HEADERS]);
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
  const attachments = readAttachments_();

  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  return values
    .filter(row => row.some(value => value !== ''))
    .map(row => {
      const part = {};
      HEADERS.forEach((header, index) => {
        part[header] = row[index];
      });
      if (attachments[part.id]) {
        part.attachmentFileName = attachments[part.id].fileName;
        part.attachmentMimeType = attachments[part.id].mimeType;
        part.attachmentDataUrl = attachments[part.id].dataUrl;
      }
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

function readAttachments_() {
  const sheet = getAttachmentsSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  const grouped = {};
  sheet
    .getRange(2, 1, lastRow - 1, ATTACHMENT_HEADERS.length)
    .getValues()
    .forEach(row => {
      const partId = String(row[0] || '').trim();
      if (!partId) return;
      if (!grouped[partId]) {
        grouped[partId] = {
          fileName: String(row[1] || ''),
          mimeType: String(row[2] || 'application/pdf'),
          chunks: []
        };
      }
      grouped[partId].chunks[Number(row[3]) || 0] = String(row[4] || '');
    });

  const attachments = {};
  Object.keys(grouped).forEach(partId => {
    const attachment = grouped[partId];
    attachments[partId] = {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      dataUrl: attachment.chunks.join('')
    };
  });

  return attachments;
}

function writeAttachments_(parts) {
  const sheet = getAttachmentsSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, ATTACHMENT_HEADERS.length).clearContent();
  }

  const rows = [];
  parts.forEach(part => {
    const dataUrl = String(part.attachmentDataUrl || '').trim();
    if (!part.id || !dataUrl) return;
    for (let index = 0; index < dataUrl.length; index += ATTACHMENT_CHUNK_SIZE) {
      rows.push([
        part.id,
        part.attachmentFileName || '',
        part.attachmentMimeType || 'application/pdf',
        Math.floor(index / ATTACHMENT_CHUNK_SIZE),
        dataUrl.slice(index, index + ATTACHMENT_CHUNK_SIZE)
      ]);
    }
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, ATTACHMENT_HEADERS.length).setValues(rows);
  }
}

function normalizePartNumbers_(parts) {
  const used = {};
  let highest = 0;

  parts.forEach(part => {
    if (part.itemKind !== 'production') return;
    const number = String(part.partNumber || '');
    const match = number.match(/(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  });

  return parts.map(part => {
    if (part.itemKind !== 'production') {
      part.partNumber = '';
      part.originalPartNumber = '';
      return part;
    }

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
    .map(row => {
      const id = String(row[0] || '').trim();
      const name = String(row[1] || '').trim();
      const parentId = String(row[2] || '').trim();
      const itemKind = String(row[4] || '').trim();
      if (id && name && !parentId && /^\d+$/.test(name)) return id;
      return { id, name, parentId, itemKind };
    })
    .filter(folder => typeof folder === 'string' ? folder : folder.id && folder.name);
}

function writeFolders_(folders) {
  const sheet = getFoldersSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, FOLDER_HEADERS.length).clearContent();
  }

  const seen = {};
  const uniqueFolders = folders
    .map(folder => {
      if (typeof folder === 'string') {
        const path = String(folder || '').trim();
        return { id: `legacy-bom-${path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, name: path.split('/').pop().trim(), parentId: '', itemKind: 'bom' };
      }
      return {
        id: String(folder.id || '').trim(),
        name: String(folder.name || '').trim(),
        parentId: String(folder.parentId || '').trim(),
        itemKind: String(folder.itemKind || 'bom').trim() === 'production' ? 'production' : 'bom'
      };
    })
    .filter(folder => {
      if (!folder.id || !folder.name || seen[folder.id]) return false;
      seen[folder.id] = true;
      return true;
    });
  if (!uniqueFolders.length) return;

  sheet
    .getRange(2, 1, uniqueFolders.length, FOLDER_HEADERS.length)
    .setValues(uniqueFolders.map((folder, index) => [folder.id, folder.name, folder.parentId, index, folder.itemKind]));
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
