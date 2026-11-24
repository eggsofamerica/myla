// Carry-over: tracked bills reintroduced in a later session are tracked again automatically.
const H = require('./harness.js');
const API = require('./fake_api.js');
const { MyLA, files, sheets, setNow, mkFile, CFGIDS } = H;
const INBOX = 'YOUR_INBOX_FOLDER_ID';
const events = () => JSON.parse(files[CFGIDS.EVENTS].content).events;
const data = () => JSON.parse(files[CFGIDS.DATA].content);
function assert(c, m) { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); }
function ack() { const ev = events(); if (ev.length) mkFile('ack' + Math.random() + '.json', JSON.stringify({ ops: [{ op: 'ack', upTo: Math.max(...ev.map(e => e.id)) }] }), INBOX); }
function op(o) { mkFile('op' + Math.random() + '.json', JSON.stringify(o), INBOX); }
function ticks(n, iso) { for (let i = 0; i < n; i++) { setNow(new Date(Date.parse(iso) + i * 5 * 60000).toISOString()); MyLA.tick(); } }

try { MyLA.setup(); } catch (e) {}
sheets['Settings'][1][1] = 'TESTKEY';
setNow('2026-11-24T12:10:00Z'); MyLA.setup();
API.state.carryOn = true;
ack(); op({ op: 'track', id: 'S100-2025' }); op({ op: 'add', id: 'S700-2025', track: true });
ticks(2, '2026-11-24T12:40:00Z');
let d = data();
assert(d.bills.find(b => b.id === 'S100-2025').tr && d.bills.find(b => b.id === 'S700-2025').tr, 'S100 (+A200) and hand-added S700 tracked');
ack();

// New session: Jan 1, 2027
ticks(12, '2027-01-01T13:00:00Z');
d = data();
const carry = d.carry || [];
assert(['S100-2025', 'A200-2025', 'S700-2025'].every(id => carry.some(c => c.id === id)), 'carry list built at rollover: ' + carry.map(c => c.id + (c.now ? '->' + c.now : '')).join(', '));
const s50 = d.bills.find(b => b.id === 'S50-2027');
assert(s50 && s50.tr, 'S50-2027 (reintroduction of S100, found by the normal search) tracked automatically');
assert(carry.find(c => c.id === 'S100-2025').now === 'S50-2027', 'carry item S100 marked as reintroduced');
assert(!d.bills.find(b => b.id === 'S60-2027'), 'off-topic reintroduction not found by keyword search');
let ev = events();
assert(ev.some(e => e.type === 'info' && /Reintroduced and now tracked: S50/.test(e.detail)), 'push event for S50');
ack();

// Weekday regular check runs the targeted search
setNow('2027-01-11T13:20:00Z'); MyLA.checkNow();
ticks(2, '2027-01-11T13:25:00Z');
d = data();
const s60 = d.bills.find(b => b.id === 'S60-2027');
assert(s60 && s60.tr, 'off-topic S60-2027 (reintroduction of hand-added S700) found by previous-version search and tracked');
assert(d.carry.find(c => c.id === 'S700-2025').now === 'S60-2027', 'carry item S700 resolved');
ev = events();
assert(ev.some(e => e.type === 'info' && /S60/.test(e.detail)), 'push event for S60');
ack();

// Untracking the new bill sticks; stop watching works
op({ op: 'untrack', id: 'S60-2027' }); op({ op: 'carry_off', id: 'A200-2025' });
ticks(1, '2027-01-11T14:00:00Z');
setNow('2027-01-12T13:20:00Z'); MyLA.checkNow();
d = data();
assert(!d.bills.find(b => b.id === 'S60-2027').tr, 'untracked reintroduction stays untracked');
assert(d.carry.find(c => c.id === 'A200-2025').off, 'stop watching recorded');
console.log('\nLOG:\n' + files[CFGIDS.LOG].content.split('\n').filter(l => /carry|rollover|tracking/i.test(l)).join('\n'));
