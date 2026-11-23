const H = require('./harness.js');
const API = require('./fake_api.js');
const { MyLA, files, sheets, setNow, mkFile, CFGIDS } = H;
const INBOX = 'YOUR_INBOX_FOLDER_ID';
function events() { return JSON.parse(files[CFGIDS.EVENTS].content); }
function data() { return JSON.parse(files[CFGIDS.DATA].content); }
function assert(c, m) { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); }

// 1. setup without key
try { MyLA.setup(); assert(false, 'setup should demand key'); } catch (e) { assert(/API key/.test(e.message), 'setup asks for key'); }
// 2. paste key, setup
sheets['Settings'][1][1] = 'TESTKEY';
setNow('2026-11-23T12:10:00Z'); // Mon 7:10 NY
MyLA.setup();
let d = data();
assert(d.backfill && d.backfill.stage === 'done', 'backfill finished in one run: ' + JSON.stringify(d.backfill && d.backfill.stage));
const ids = d.bills.map(b => b.id).sort();
assert(JSON.stringify(ids) === JSON.stringify(['A200-2025', 'A400-2025', 'S100-2025']), 'relevant bills: ' + ids.join(','));
let ev = events().events;
assert(ev.some(e => e.type === 'setup_complete'), 'setup_complete event');
assert(ev.some(e => e.type === 'hearing_backlog' && e.items.length === 1), 'hearing backlog has 1 matched hearing (deduped): ' + JSON.stringify(ev.filter(e => e.type === 'hearing_backlog').map(e => e.items)));
assert(d.hearings.length === 2, 'two distinct hearings stored: ' + d.hearings.length);
assert(!ev.some(e => e.type === 'budget_posted'), 'no budget event on seed');
const s100 = d.bills.find(b => b.id === 'S100-2025');
assert(JSON.stringify(s100.pv) === JSON.stringify(['S5000-2023','A7000-2021']), 'prior versions: ' + JSON.stringify(s100.pv));
assert(s100.sa === 'A200-2025' && s100.sp === 'Jane Doe' && s100.u.endsWith('/2025/S100'), 'bill fields: ' + JSON.stringify({ sa: s100.sa, sp: s100.sp, u: s100.u }));
assert(sheets['Bills'].length === 4, 'sheet rows: ' + sheets['Bills'].length);

// 3. Claude acks, dashboard tracks S100
const maxId = Math.max(...ev.map(e => e.id));
mkFile('op1.json', JSON.stringify({ ops: [{ op: 'ack', upTo: maxId }] }), INBOX);
mkFile('op2.json', JSON.stringify({ op: 'track', id: 'S100-2025' }), INBOX);
setNow('2026-11-23T12:40:00Z'); // 7:40, slot already used
MyLA.tick();
d = data(); ev = events().events;
assert(d.bills.find(b => b.id === 'S100-2025').tr && d.bills.find(b => b.id === 'A200-2025').tr, 'S100 and same-as A200 tracked');
const sn = ev.filter(e => e.type === 'summary_needed');
assert(sn.length === 1 && files[sn[0].fileId] && /BILL TEXT/.test(files[sn[0].fileId].content), 'one summary queued with text file');
assert(!ev.some(e => e.id <= maxId), 'acked events removed');
assert(ev.some(e => e.type === 'party_needed' && e.members.some(m => m.name === 'Jane Doe') && e.members.some(m => m.name === 'John Roe')), 'party asked for sponsor and same-as sponsor');
assert(Object.values(files).filter(f => f.parent === INBOX && !f.trashed).length === 0, 'inbox emptied');

// 4. Claude writes summary
mkFile('op3.json', JSON.stringify({ ops: [{ op: 'summary', id: 'S100-2025', text: 'Creates a thermal energy network program.' }, { op: 'ack', upTo: Math.max(...ev.map(e => e.id)) }, { op: 'party', name: 'Jane Doe', party: 'D' }, { op: 'hearing', key: d.hearings.find(h => h.match).key, relevant: true }] }), INBOX);
// 5. Next slot: S100 gets action, vote and agenda; new bill appears; budget bill amended (outside session window -> budget not checked)
const b = API.DB['S100-2025'];
b.actions.items.push({ date: '2026-11-23', chamber: 'SENATE', sequenceNo: 2, text: 'REPORTED AND COMMITTED TO FINANCE' });
b.votes.items.push({ version: '', voteType: 'COMMITTEE', voteDate: '2026-11-23', committee: { chamber: 'SENATE', name: 'Energy and Telecommunications' }, memberVotes: { items: { AYE: { items: [], size: 6 }, NAY: { items: [], size: 2 } } } });
b.committeeAgendas.items.push({ agendaId: { number: 12, year: 2025 }, committeeId: { chamber: 'SENATE', name: 'Finance' } });
API.state.updated = ['S100-2025', 'S777-2025'];
API.state.newOn = true;
setNow('2026-11-24T12:05:00Z'); // Tue 7:05
MyLA.tick();
d = data(); ev = events().events;
const s100b = d.bills.find(x => x.id === 'S100-2025');
assert(s100b.pt === 'D' && s100b.tp.length > 0, 'party and topics on bill: ' + s100b.pt + ' ' + JSON.stringify(s100b.tp));
assert(s100b.sum === 'Creates a thermal energy network program.' && d.bills.find(x => x.id === 'A200-2025').sum, 'summary stored on both bills');
const types = ev.map(e => e.type);
console.log('   hist:', JSON.stringify(d.bills.find(x => x.id === 'S100-2025').ev.slice(0,4)));
assert(types.includes('bill_action') && types.includes('bill_vote') && types.includes('bill_agenda'), 'tracked bill events: ' + types.join(','));
console.log('   ', ev.filter(e => e.bill).map(e => e.detail).join(' | '));
const pn = ev.find(e => e.type === 'party_needed'); console.log('   party_needed:', JSON.stringify(pn && pn.members));
console.log('   topics:', JSON.stringify(d.bills.find(x => x.id === 'S100-2025').tp), 'lc:', d.bills.find(x => x.id === 'S100-2025').lc);
const nb = ev.find(e => e.type === 'new_bills');
assert(nb && nb.bills.length === 1 && nb.bills[0].id === 'S900-2025', 'new bill event for S900');
assert(d.hearings.find(h => h.match).rel === true, 'hearing relevance stored');
// 6. Budget: in-session date, amend budget bill
['S3006-2025','S3003-2025'].forEach(function(k){ API.DB[k].activeVersion = 'A'; API.DB[k].amendments.items['A'] = Object.assign({}, API.DB[k].amendments.items[''], { version: 'A' }); });
API.DB['S3006-2025'].activeVersion = 'A';
API.DB['S3006-2025'].amendments.items['A'] = Object.assign({}, API.DB['S3006-2025'].amendments.items[''], { version: 'A' });
setNow('2027-02-10T17:05:00Z'); // but this rolls session to 2027 -> test separately below
// Instead force a check in 2026 with checkNow (budget is checked when forced)
setNow('2026-11-24T17:05:00Z');
MyLA.checkNow();
ev = events().events;
const bp = ev.find(e => e.type === 'budget_posted');
assert(bp && bp.bills.length === 2, 'budget event bills: ' + JSON.stringify(bp && bp.bills.map(x=>[x.bill,x.nyserdaOnly,x.kept])));
if (bp) { const e = bp.bills.find(x=>x.nyserdaOnly); const t = files[e.fileId].content; assert(/PART D/.test(t) && !/PART B/.test(t) && /ONLY because they name NYSERDA/.test(t), 'non-TED bill keeps only the NYSERDA part'); bp.bills = bp.bills.filter(x=>!x.nyserdaOnly); }
if (bp) {
  const t = files[bp.bills[0].fileId].content;
  assert(/PART B/.test(t) && /PART D/.test(t) && !/PART A/.test(t), 'budget excerpt keeps energy parts only (B, D) — kept: ' + bp.bills[0].kept);
}
// 6b. One-house resolution appears (first forced check seeded resolutions as empty set)
API.state.resOn = true;
setNow('2026-11-24T17:20:00Z');
MyLA.checkNow();
ev = events().events;
const br = ev.find(e => e.type === 'budget_resolution');
assert(br && br.house === 'Senate' && /NYSERDA/.test(files[br.fileId].content), 'one-house resolution queued: ' + JSON.stringify(br && {h: br.house, b: br.bill}));
// 7. Sheet checkbox untrack
const rows = sheets['Bills'];
const r = rows.findIndex(x => x && x[1] === 'S100-2025');
rows[r][0] = false;
setNow('2026-11-24T17:40:00Z');
MyLA.tick();
d = data();
console.log('DBG', d.asof, d.bills.filter(x=>x.tr).map(x=>x.id), JSON.stringify(sheets['Bills'].slice(0,5).map(x=>x&&x.slice(0,2))));
assert(!d.bills.find(x => x.id === 'S100-2025').tr && !d.bills.find(x => x.id === 'A200-2025').tr, 'untracked via sheet checkbox');
// 7b. Manual add: an off-topic bill (S300 farm bill, excluded by filters) added and tracked; a bad number fails
mkFile('add1.json', JSON.stringify({ op: 'add', id: 'S300-2025', track: true }), INBOX);
mkFile('add2.json', JSON.stringify({ op: 'add', id: 'S99999-2025', track: false }), INBOX);
setNow('2026-11-24T18:10:00Z');
MyLA.tick();
d = data();
const s300 = d.bills.find(x => x.id === 'S300-2025');
assert(s300 && s300.rel === 'manual' && s300.tr && s300.man, 'manual add of off-topic bill, tracked: ' + JSON.stringify(s300 && {rel: s300.rel, tr: s300.tr}));
assert(d.addFailed && d.addFailed[0].id === 'S99999-2025', 'failed add reported: ' + JSON.stringify(d.addFailed));
// 8. Session rollover
setNow('2027-01-01T13:00:00Z');
API.state.updated = [];
MyLA.tick();
d = data();
assert(d.session === 2027, 'rolled to 2027, backfill stage ' + (d.backfill && d.backfill.stage));
console.log('\nLOG tail:\n' + files[CFGIDS.LOG].content.split('\n').slice(-12).join('\n'));
console.log('data.json size', files[CFGIDS.DATA].content.length);
