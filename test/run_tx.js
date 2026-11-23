// Transcripts feature: floor debate on tracked bills, hearing agendas, review requests, testimony, transcripts.
const H = require('./harness.js');
const API = require('./fake_api.js');
const { MyLA, files, sheets, setNow, mkFile, CFGIDS } = H;
const INBOX = 'YOUR_INBOX_FOLDER_ID';
const events = () => JSON.parse(files[CFGIDS.EVENTS].content).events;
const data = () => JSON.parse(files[CFGIDS.DATA].content);
function assert(c, m) { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); }
function ack() { const ev = events(); if (ev.length) mkFile('ack' + Math.random() + '.json', JSON.stringify({ ops: [{ op: 'ack', upTo: Math.max(...ev.map(e => e.id)) }] }), INBOX); }
function op(o) { mkFile('op' + Math.random() + '.json', JSON.stringify(o), INBOX); }

try { MyLA.setup(); } catch (e) {}
sheets['Settings'][1][1] = 'TESTKEY';
setNow('2026-11-23T12:10:00Z');
MyLA.setup();
ack(); op({ op: 'track', id: 'S100-2025' });
setNow('2026-11-23T12:40:00Z'); MyLA.tick();
assert(data().bills.find(b => b.id === 'S100-2025').tr, 'S100 tracked');
ack();

// --- Senate floor: S100 passes the Senate on Nov 24
API.DB['S100-2025'].actions.items.push({ date: '2026-11-24', chamber: 'SENATE', sequenceNo: 2, text: 'PASSED SENATE' });
API.state.updated = ['S100-2025'];
setNow('2026-11-24T13:20:00Z'); MyLA.checkNow();
let d = data();
assert(d.floor && d.floor.length === 1 && d.floor[0].st === 'wait' && d.floor[0].ch === 'SENATE', 'floor watch queued on PASSED SENATE: ' + JSON.stringify(d.floor));
API.state.updated = [];
const TXT = '                    THE SECRETARY:   Calendar Number\n\n                                                               100\n\n 1    55, Senate Print 100, by Senator Doe, an act.\n 2                 SENATOR SMITH:   Explain my vote.\n';
API.state.senTx = { list: [{ dateTime: '2026-11-24T11:00', sessionType: 'Regular Session' }], texts: { '2026-11-24T11:00': TXT + 'x'.repeat(1200) } };
setNow('2026-11-24T18:20:00Z'); MyLA.checkNow();
let ev = events(), fd = ev.find(e => e.type === 'floor_debate');
assert(fd && fd.chamber === 'SENATE' && fd.files[0].kind === 'txt' && /Senate Print 100/.test(files[fd.files[0].id].content) && fd.printNos.includes('A200'), 'Senate floor transcript staged: ' + JSON.stringify(fd && { pn: fd.printNos, f: fd.files }));
const srcId = fd.files[0].id;
ack(); op({ op: 'floor', key: fd.key, text: '**Outcome:** passed 40-20.' });
setNow('2026-11-24T18:40:00Z'); MyLA.tick();
d = data();
assert(d.floor[0].st === 'done' && /passed 40-20/.test(d.floor[0].sum) && files[srcId].trashed, 'floor summary stored, source file trashed');

// --- Assembly floor: A200 passes the Assembly on Nov 25 (Granicus PDF)
API.DB['A200-2025'].actions.items.push({ date: '2026-11-25', chamber: 'ASSEMBLY', sequenceNo: 2, text: 'PASSED ASSEMBLY' });
API.state.updated = ['A200-2025'];
setNow('2026-11-25T13:20:00Z'); MyLA.checkNow();
API.state.updated = [];
API.state.granicus = { view6: '<table><tr><td>Name</td><td>Date</td></tr><tr><td>11-25-26 Session</td><td>Nov 25, 2026</td><td>05h 00m</td><td><a href="//nystateassembly.granicus.com/AgendaViewer.php?view_id=6&amp;clip_id=9700">Agenda</a></td><td><a href="//nystateassembly.granicus.com/MinutesViewer.php?view_id=6&amp;clip_id=9700&amp;doc_id=x">Transcript</a></td></tr></table>' };
setNow('2026-11-25T18:20:00Z'); MyLA.checkNow();
ev = events(); fd = ev.find(e => e.type === 'floor_debate' && e.chamber === 'ASSEMBLY');
assert(fd && fd.files[0].kind === 'pdf' && /^%PDF/.test(files[fd.files[0].id].content), 'Assembly floor transcript PDF staged');
ack();

// --- Hearings: the Nov 23 transmission hearing is relevant; witness list appears; review request; testimony; transcript
const hkey = data().hearings.find(h => /Transmission/.test(h.subject)).key;
op({ op: 'hearing', key: hkey, relevant: true });
API.state.granicus.view8 = '<table><tr><td>11-23-26 Assembly Public Hearing on Federal Impacts to Public-Private Partnerships for Transmission</td><td>Nov 23, 2026</td><td>03h</td><td><a href="//nystateassembly.granicus.com/AgendaViewer.php?view_id=8&amp;clip_id=9800">Agenda</a></td><td>&nbsp;</td></tr></table>';
API.state.granicus.agenda = '<html><body>NOTICE OF PUBLIC HEARING SUBJECT: Federal impacts. PURPOSE: transmission P3s.<a href="MediaPlayer.php?view_id=8&clip_id=9800&meta_id=1">Opening Statements</a><a href="MediaPlayer.php?view_id=8&clip_id=9800&meta_id=2">Assembly Member Edward C. Braunstein</a><a href="x?meta_id=3">PANEL</a><a href="x?meta_id=4">Jane Smith, Executive Vice President, New York Power Authority</a><a href="x?meta_id=5">Bob Jones, Director, NYSERDA</a><a href="x?meta_id=6">Assembly Member Didi Barrett</a><a href="x?meta_id=7">PANEL</a><a href="x?meta_id=8">Ann Lee, Policy Director, Clean Energy Group</a></body></html>';
API.state.phFill = 1500;
API.state.ph = { 1500: API.phPage(1500, 'Federal Impacts to Public-Private Partnerships for Transmission', 'November 23, 2026', [{ n: 'Jane Smith', o: 'New York Power Authority' }, { n: 'Bob Jones', o: 'NYSERDA' }, { n: 'Pat Writer', o: 'Some Coalition', w: true }]) };
setNow('2026-11-26T13:20:00Z'); MyLA.checkNow();
d = data(); let hx = d.hearings.find(h => h.key === hkey); ev = events();
assert(hx.agenda && hx.agenda.length === 3 && hx.agenda[0].p === 1 && hx.agenda[2].p === 2 && !hx.agenda.some(a => /Assembly Member/.test(a.t)), 'agenda parsed (3 witnesses, 2 panels, questioners dropped): ' + JSON.stringify(hx.agenda));
assert(ev.some(e => e.type === 'hearing_agenda' && e.key === hkey), 'hearing_agenda push event');
ack();
op({ op: 'hearing_review', key: hkey, picks: ['Bob Jones, Director, NYSERDA'], all: false });
setNow('2026-11-26T13:40:00Z'); MyLA.tick();
setNow('2026-11-26T18:20:00Z'); MyLA.checkNow();
ev = events(); d = data(); hx = d.hearings.find(h => h.key === hkey);
const te = ev.find(e => e.type === 'hearing_testimony');
assert(te && te.files.length === 1 && /Bob Jones/.test(te.files[0].name) && /^%PDF/.test(files[te.files[0].id].content), 'written testimony for the picked witness staged: ' + JSON.stringify(te && te.files));
assert(hx.rv.st === 'wait' && !ev.some(e => e.type === 'hearing_transcript'), 'still waiting for the transcript');
ack(); op({ op: 'hearing_brief', key: hkey, pass: 'testimony', url: 'https://docs.google.com/document/d/T', title: 'Testimony review', highlights: ['NYSERDA asked about X'] });
// transcript appears on Granicus a month later
API.state.granicus.view8 = API.state.granicus.view8.replace('<td>&nbsp;</td>', '<td><a href="//nystateassembly.granicus.com/MinutesViewer.php?view_id=8&amp;clip_id=9800&amp;doc_id=y">Transcript</a></td>');
setNow('2026-12-21T13:20:00Z'); MyLA.checkNow();
ev = events(); d = data(); hx = d.hearings.find(h => h.key === hkey);
const ht = ev.find(e => e.type === 'hearing_transcript');
assert(ht && ht.picks[0].startsWith('Bob Jones') && !ht.all && hx.rv.st === 'sent' && hx.rv.tbrief && hx.rv.tbrief.title === 'Testimony review', 'hearing transcript staged with picks; testimony brief kept');
ack(); op({ op: 'hearing_brief', key: hkey, pass: 'transcript', url: 'https://docs.google.com/document/d/R', title: 'Hearing review', highlights: ['a', 'b'] });
setNow('2026-12-21T13:40:00Z'); MyLA.tick();
hx = data().hearings.find(h => h.key === hkey);
assert(hx.rv.st === 'done' && hx.rv.brief.url.endsWith('/R'), 'hearing review stored');

// --- Auto review: a new hearing whose notice names tracked bill S100
API.state.hearingsHtml = (API.state.hearingsHtml || '') + '<ul><li>Jan. 12<ul><li>Senate Standing Committee on Energy</li><li>Public Hearing: Thermal energy networks and S.100</li><li>Time: 10:00 A.M.</li></ul></li></ul>';
setNow('2026-12-22T13:20:00Z'); MyLA.checkNow();
d = data(); const auto = d.hearings.find(h => /Thermal/.test(h.subject));
assert(auto && auto.rv && auto.rv.auto && auto.rv.bills.includes('S100-2025') && auto.rv.bills.includes('A200-2025') && auto.iso === '2027-01-12', 'hearing naming a tracked bill gets an automatic review (year rolls): ' + JSON.stringify(auto && { rv: auto.rv, iso: auto.iso }));
console.log('\nLOG tail:\n' + files[CFGIDS.LOG].content.split('\n').filter(l => /floor|hearing|testimony|transcript|failed/i.test(l)).slice(-14).join('\n'));
