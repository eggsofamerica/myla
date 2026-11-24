// Fake Open Legislation API + Assembly hearings page, shaped like the documented responses.
const state = { updated: [] };
function bill(base, session, title, opts = {}) {
  const ver = opts.ver || '';
  const am = {
    basePrintNo: base, session, printNo: base + ver, version: ver,
    sameAs: { items: opts.sameAs ? [{ basePrintNo: opts.sameAs, session, printNo: opts.sameAs, version: '' }] : [], size: opts.sameAs ? 1 : 0 },
    memo: 'Sponsor memo for ' + base, lawSection: opts.law || 'Executive Law', lawCode: '', fullText: opts.text || ('Section 1. Text of ' + base + '\n'),
    coSponsors: { items: [], size: opts.cos || 0 }
  };
  return {
    basePrintNo: base, session, printNo: base + ver, activeVersion: ver, title, summary: opts.summary || '', signed: false,
    publishedDateTime: opts.pub || '2025-02-01T10:00:00',
    billType: { chamber: base[0] === 'S' ? 'SENATE' : 'ASSEMBLY', resolution: false },
    sponsor: opts.budget ? { member: null, budget: true, rules: false } : { member: { fullName: opts.sponsor || 'Jane Doe', shortName: 'DOE' }, budget: false, rules: false },
    status: { statusType: 'IN_SENATE_COMM', statusDesc: 'In Senate Committee', actionDate: '2025-02-01', committeeName: 'Energy and Telecommunications' },
    programInfo: null,
    amendments: { items: { [ver]: am }, size: 1 },
    votes: { items: [], size: 0 },
    actions: { items: [{ date: '2025-02-01', chamber: 'SENATE', sequenceNo: 1, text: 'REFERRED TO ENERGY AND TELECOMMUNICATIONS' }], size: 1 },
    previousVersions: { items: opts.prev || [], size: (opts.prev || []).length },
    committeeAgendas: { items: [] }, calendars: { items: [] }, vetoMessages: { items: [], size: 0 }, approvalMessage: null
  };
}
const BUDGET_TEXT = [
  '                             PART A', '     1  Section 1. The education law is amended to read as follows:', '     2  schools and libraries.',
  '                             PART B', '     1  Section 1. The public service law is amended by adding a new section',
  '     2  66-x. The public service commission shall direct the New York state energy research and development authority',
  '     3  to administer a clean energy program, and the power authority shall build renewable generation.',
  '                             PART C', '     1  Section 1. The tax law is amended. Nothing about energy here except energy once.',
  '                             PART D', '     1  Section 1. NYSERDA shall establish a cap and invest program to reduce greenhouse gas emissions.'
].join('\n');
const CARRY = {
  'S700-2025': bill('S700', 2025, 'Relates to public library hours', { law: 'Education Law' }),
  'S50-2027': bill('S50', 2027, 'Relates to the establishment of a thermal energy network program', { law: 'Public Service Law', pub: '2027-01-08T10:00:00', prev: [{ basePrintNo: 'S100', session: 2025, printNo: 'S100', version: '' }, { basePrintNo: 'S5000', session: 2023 }] }),
  'S60-2027': Object.assign(bill('S60', 2027, 'Relates to public library hours', { law: 'Education Law', pub: '2027-01-09T10:00:00', prev: [{ basePrintNo: 'S700', session: 2025, printNo: 'S700', version: '' }] }), { _hidden: true }),
};
const DB = {
  'S100-2025': bill('S100', 2025, 'Relates to the establishment of a thermal energy network program', { sameAs: 'A200', law: 'Public Service Law', cos: 3, prev: [{ basePrintNo: 'S5000', session: 2023 }, { basePrintNo: 'A7000', session: 2021 }, { basePrintNo: 'S5000', session: 2023 }] }),
  'A200-2025': bill('A200', 2025, 'Relates to the establishment of a thermal energy network program', { sameAs: 'S100', law: 'Public Service Law', sponsor: 'John Roe' }),
  'S300-2025': bill('S300', 2025, 'Relates to farm wildlife habitat programs', { law: 'Environmental Conservation Law' }),
  'A400-2025': bill('A400', 2025, 'Relates to the powers of the public service commission', { law: 'Public Service Law' }),
  'S600-2025': bill('S600', 2025, 'Relates to the authorities budget office and reporting by public authorities', { law: 'Public Authorities Law' }),
  'S601-2025': bill('S601', 2025, 'Relates to the metropolitan transportation authority board', { law: 'Public Authorities Law', summary: 'Relates to the MTA, a public authority' }),
  'S602-2025': bill('S602', 2025, 'Relates to the storage of road salt', { law: 'Public Authorities Law', summary: 'Requires state agencies and public authorities to store road salt under cover' }),
  'S500-2025': bill('S500', 2025, 'Relates to broadband telecommunications access', { law: 'Public Service Law' }),
  'S3003-2025': bill('S3003', 2025, 'Enacts into law major components of legislation necessary to implement the state education, labor and family assistance budget for the 2025-2026 state fiscal year', { budget: true, text: BUDGET_TEXT.replace('New York state energy research and development authority', 'state energy office') }),
  'S3006-2025': bill('S3006', 2025, 'Enacts into law major components of legislation necessary to implement the state transportation, economic development and environmental conservation budget', { budget: true, text: BUDGET_TEXT }),
};
const RES = { 'J1952-2025': Object.assign(bill('J1952', 2025, 'Resolution in response to the 2026-2027 Executive Budget submission', { text: 'RESOLVED, That the Senate rejects the transfer of $50 million from NYSERDA to the general fund and supports offshore wind.' }), { billType: { chamber: 'SENATE', resolution: true } }) };
const NEW_LATER = { 'S900-2025': bill('S900', 2025, 'Relates to offshore wind transmission', { pub: '2026-11-23T09:00:00', law: 'Public Service Law' }) };
function ok(obj) { return { code: 200, body: JSON.stringify(Object.assign({ success: true, message: '' }, obj)) }; }
function list(items) { return ok({ total: items.length, offsetStart: 1, offsetEnd: items.length, limit: 1000, result: { items, size: items.length } }); }
function summaryOf(b) { const s = Object.assign({}, b); delete s.amendments; delete s.votes; return s; }
const HEARINGS_HTML = `<html><body><div id="nav"><a href="/leg/">Bills</a></div>
<h2>Standing Committee Public Hearing Calendar</h2>
<ul><li>Nov. 23<ul><li>Assembly Standing Committee on Corporations, Authorities and Commissions</li><li>Public Hearing: Federal Impacts to Public-Private Partnerships for Transmission</li><li>Place: Assembly Hearing Room, 250 Broadway, 19th Floor</li><li>Time: 10:00 A.M.</li><li><a href="/comm/?id=9&amp;sec=story&amp;story=119826">View public hearing notice</a></li></ul></li>
<li>Nov. 30<ul><li>Joint -- Assembly Standing Committee on Codes</li><li>Public Hearing: Artificial Intelligence in Law Enforcement</li><li>Time: 11:00 A.M.</li></ul></li>
<li>Nov. 23<ul><li>Assembly Standing Committee on Corporations, Authorities and Commissions</li><li>Public Hearing: Federal Impacts to Public-Private Partnerships for Transmission</li><li>Place: Assembly Hearing Room, 250 Broadway, 19th Floor</li><li>Time: 10:00 A.M.</li><li>/comm/?id=9&sec=story&story=119826</li></ul></li></ul></body></html>`;
function handle(url) {
  const u = new URL(url);
  if (u.hostname === 'nystateassembly.granicus.com') {
    const g = state.granicus || {};
    if (/ViewPublisher/.test(u.pathname)) return { code: 200, body: (g['view' + u.searchParams.get('view_id')] || '<table></table>') };
    if (/AgendaViewer/.test(u.pathname)) return { code: 200, body: g.agenda || '' };
    if (/MinutesViewer/.test(u.pathname)) return { code: 200, type: 'application/pdf', body: '%PDF-1.7 fake transcript ' + u.searchParams.get('clip_id') };
    return { code: 404, body: '' };
  }
  if (u.hostname === 'nyassembly.gov' && u.pathname.startsWith('/testimony')) {
    const id = +u.searchParams.get('ph_id'), ph = (state.ph || {})[id];
    if (ph) return { code: 200, body: ph };
    if (state.phFill && id >= 1441 && id < state.phFill) return { code: 200, body: phPage(id, 'Some Other Hearing on Libraries', 'October 1, 2026', []) };
    return { code: 200, body: '<html><head><title>Legislative Proceeding Testimony/Transcript</title></head><body></body></html>' };
  }
  if (u.hostname === 'nyassembly.gov' && u.pathname.startsWith('/write/upload/publichearing')) return { code: 200, type: 'application/pdf', body: '%PDF-1.4 fake testimony ' + u.pathname };
  if (u.hostname === 'nyassembly.gov') return { code: 200, body: state.hearingsHtml || HEARINGS_HTML };
  if (!u.searchParams.get('key')) return { code: 401, body: '{"success":false,"errorCode":701}' };
  const p = decodeURIComponent(u.pathname).replace('/api/3', '');
  let m;
  if ((m = p.match(/^\/bills\/(\d+)\/search$/))) {
    const term = u.searchParams.get('term');
    const all = Object.assign({}, DB, state.newOn ? NEW_LATER : {}, state.carryOn ? CARRY : {});
    let items = Object.values(all).filter(b => String(b.session) === m[1]);
    const pv = term.match(/previousVersions\.items\.basePrintNo:(\w+)/);
    if (pv) return list(items.filter(b => b.previousVersions.items.some(x => x.basePrintNo === pv[1])).map(b => ({ result: summaryOf(b), rank: 1, highlights: {} })));
    items = items.filter(b => !b._hidden);
    if (/billType\.resolution:true/.test(term)) items = state.resOn ? Object.values(RES) : [];
    else if (/sponsor\.budget:true/.test(term)) items = items.filter(b => b.sponsor.budget);
    else if (/lawSection/.test(term)) items = items.filter(b => !b.sponsor.budget && b.amendments.items[b.activeVersion].lawSection === 'Public Service Law');
    else if (/^\(summary:/.test(term)) items = [];
    else items = items.filter(b => !b.sponsor.budget);
    if (/publishedDateTime:\[(\S+) TO/.test(term)) { const from = term.match(/publishedDateTime:\[(\S+) TO/)[1]; items = items.filter(b => b.publishedDateTime.slice(0, 10) >= from); }
    return list(items.map(b => ({ result: summaryOf(b), rank: 1, highlights: {} })));
  }
  if ((m = p.match(/^\/bills\/updates\/(.+)$/))) return list(state.updated.map(id => ({ id: { basePrintNo: id.split('-')[0], session: +id.split('-')[1] }, contentType: 'BILL' })));
  if ((m = p.match(/^\/bills\/(\d+)\/([A-Z]\d+)$/))) {
    const all = Object.assign({}, DB, state.newOn ? NEW_LATER : {}, state.carryOn ? CARRY : {}, RES);
    const b = all[m[2] + '-' + m[1]];
    if (!b) return { code: 404, body: '{"success":false}' };
    return ok({ responseType: 'bill', result: b });
  }
  if ((m = p.match(/^\/transcripts\/(\d{4})$/))) return list(((state.senTx || {}).list || []));
  if ((m = p.match(/^\/transcripts\/(\d{4}-\d\d-\d\dT[\d:]+)/))) { const t = ((state.senTx || {}).texts || {})[m[1]]; return t ? ok({ result: { dateTime: m[1], text: t } }) : { code: 404, body: '{}' }; }
  if ((m = p.match(/^\/hearings\/(\d{4})$/))) return list(((state.senHear || {}).list || []));
  if ((m = p.match(/^\/hearings\/(\d+)$/))) { const h = ((state.senHear || {}).items || {})[m[1]]; return h ? ok({ result: h }) : { code: 404, body: '{}' }; }
  if ((m = p.match(/^\/agendas\/(\d+)\/(\d+)\/(.+)$/))) return ok({ result: { committeeAgendaId: {}, addenda: { items: [{ meeting: { meetingDateTime: '2026-11-25T11:00:00', location: 'Room 124 CAP' } }] } } });
  return { code: 404, body: '{}' };
}
function phPage(id, title, date, docs, tx) {
  return '<html><head><title>Legislative Proceeding Testimony/Transcript</title><style>body{font-family:arial}</style></head><body><div id="heading"><h2>' + title + '</h2><p>' + date + '<br>10:00 AM<br>Hearing Room B</p></div>' +
    (tx ? '<h3><a href="https://nyassembly.gov/write/upload/publichearing/00' + id + '/transcript.pdf">Transcript</a></h3>' : '<h3>Transcript</h3>') +
    '<h3>Oral Testimony</h3>' + docs.filter(d => !d.w).map((d, i) => '<p><a href="https://nyassembly.gov/write/upload/publichearing/00' + id + '/00' + (6000 + i) + '.pdf">' + d.n + '</a><br>' + d.o + '</p>').join('') +
    '<h3>Written Testimony</h3>' + docs.filter(d => d.w).map((d, i) => '<p><a href="https://nyassembly.gov/write/upload/publichearing/00' + id + '/00' + (7000 + i) + '.pdf">' + d.n + '</a><br>' + d.o + '</p>').join('') + '<p>' + 'x'.repeat(1600) + '</p></body></html>';
}
module.exports = { handle, state, DB, bill, phPage };
