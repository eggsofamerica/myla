// MyLA — paste this whole file into Extensions > Apps Script (replacing what's there), save, then run "setup".
// It loads MyLA's actual code from your Google Drive (MyLA folder > myla_code.js), so Claude can
// update the app later without you pasting anything again.
var MYLA_FOLDER = 'YOUR_MYLA_FOLDER_ID';

function loadMyLA_() {
  if (globalThis.MyLA) return globalThis.MyLA;
  var it = DriveApp.getFolderById(MYLA_FOLDER).getFilesByName('myla_code.js'), best = null;
  while (it.hasNext()) { var f = it.next(); if (!best || f.getDateCreated() > best.getDateCreated()) best = f; }
  if (!best) throw new Error('myla_code.js is missing from the MyLA folder in Drive.');
  (0, eval)(best.getBlob().getDataAsString());
  return globalThis.MyLA;
}
function setup() { loadMyLA_().setup(); }
function tick() { loadMyLA_().tick(); }
function checkNow() { loadMyLA_().checkNow(); }
function onOpen() {
  SpreadsheetApp.getUi().createMenu('MyLA').addItem('Run a check now', 'checkNow').addItem('Re-run setup', 'setup').addToUi();
}
// Never called. It tells Google which permissions MyLA needs (read/write its Drive files and the Sheet,
// fetch legislature data, run on a timer).
function permissions_() {
  var f = DriveApp.getFileById('x'); f.setContent(''); f.setTrashed(true); DriveApp.createFile('x', 'x');
  DriveApp.getFolderById('x').createFile('x', 'x', 'text/plain');
  UrlFetchApp.fetch('https://legislation.nysenate.gov'); UrlFetchApp.fetchAll([]);
  SpreadsheetApp.openById('x').insertSheet('x');
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(30).create(); ScriptApp.getProjectTriggers();
  PropertiesService.getScriptProperties(); LockService.getScriptLock();
}
