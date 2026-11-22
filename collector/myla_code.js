/* MyLA collector — runs inside Google Apps Script, loaded by the bootstrap.
 * Pulls NY legislature data (Open Legislation API + Assembly hearing calendar),
 * keeps a database in Drive, writes the Sheet, the dashboard data file and the
 * event queue that the scheduled Claude check reads. No AI runs here. */
globalThis.MyLA = (function () {
  'use strict';
  var CFG = {
    VERSION: '2026-11-21.10',
    ROOT: 'YOUR_MYLA_FOLDER_ID',
    INBOX: 'YOUR_INBOX_FOLDER_ID',
    WORK: 'YOUR_WORK_FOLDER_ID',
    BRIEFS: 'YOUR_BRIEFS_FOLDER_ID',
    SHEET: 'YOUR_SHEET_ID',
    DATA: 'YOUR_DATA_FILE_ID',
    EVENTS: 'YOUR_EVENTS_FILE_ID',
    LOG: 'YOUR_LOG_FILE_ID',
    API: 'https://legislation.nysenate.gov/api/3',
    HEARINGS_URL: 'https://nyassembly.gov/leg/?sh=hear',
    TZ: 'America/New_York',
    TIME_BUDGET_MS: 270000,
    BATCH: 4
  };
  var START = Date.now();
  var LOGBUF = [];

  // ------------------------------------------------------------------ keywords
  // Search groups are split so each request URL stays well under Apps Script's 2 KB limit.
  var SEARCH_GROUPS = [
    'energy OR electric* OR electricity OR utility OR utilities OR renewabl* OR solar OR "wind energy" OR "offshore wind" OR "wind turbine" OR "wind turbines"',
    'climate OR "greenhouse gas" OR "greenhouse gases" OR emissions OR "carbon dioxide" OR decarboni* OR "fossil fuel" OR "fossil fuels" OR "zero-emission" OR "zero emission" OR "cap and invest" OR RGGI',
    '"public service commission" OR NYSERDA OR "energy research and development" OR "power authority" OR "power plant" OR "power plants" OR peaker OR "generating facility" OR "generating facilities" OR transmission',
    '"natural gas" OR "gas corporation" OR "gas corporations" OR "gas service" OR pipeline OR pipelines OR ratepayer OR ratepayers OR "net metering" OR microgrid OR microgrids OR "demand response"',
    '"heat pump" OR "heat pumps" OR geothermal OR nuclear OR hydrogen OR "energy storage" OR "battery storage" OR "electric vehicle" OR "electric vehicles" OR "charging station" OR "charging stations"',
    '"energy code" OR "all-electric" OR electrification OR "thermal energy" OR "district energy" OR weatherization OR "energy efficiency" OR "data center" OR "data centers" OR propane OR "heating oil" OR biofuel OR "renewable natural gas"'
  ];
  var LAW_NAMES = ['"Public Service Law"', '"Energy Law"'];
  var LAW_FIELDS = ['amendments.items.\\*.lawSection', 'lawSection', '\\*.lawSection'];
  var CORE_LAWS = /^(public service law|energy law)$/i;
  var ENERGY_RE = /\b(energy|electric\w*|utilit(y|ies)|renewabl\w*|solar|wind (energy|turbines?|power|farms?)|offshore wind|climate|greenhouse|emission|carbon dioxide|decarboni\w*|fossil fuel|zero[- ]emission|cap[- ]and[- ]invest|rggi|public service commission|nyserda|energy research and development|power authority|power plants?|peaker|generating facilit\w*|natural gas|gas (corporations?|service|utilit\w*)|pipelines?|ratepayers?|net metering|microgrids?|demand response|heat pumps?|geothermal|nuclear|hydrogen|energy storage|battery storage|electric vehicles?|charging stations?|energy code|all-electric|electrification|thermal energy|district energy|weatherization|energy efficiency|data cent(er|re)s?|propane|heating oil|biofuel|transmission (lines?|facilit\w*|system|projects?|siting))\b/i;
  var EXCLUDE_RE = /\b(agricultur\w*|farm\w*|forest\w*|wildlife|fish\w*|hunting|trapping|wetlands?|pesticides?|deer|invasive species|state parks?|carbon monoxide|hiv|telecommunications?|broadband|cable television|telephone)\b/i;
  var HEARING_RE = /\b(energy|electric\w*|utilit(y|ies)|public service|psc|nyserda|power authority|nypa|lipa|long island power|renewabl\w*|solar|wind|climate|greenhouse|emissions?|carbon|decarboni\w*|fossil|natural gas|ratepayers?|transmission|grid|nuclear|hydrogen|heat pumps?|building electrification|clcpa|cap[- ]and[- ]invest|affordab\w*|energy costs?)\b/i;
  var BUDGET_TERMS = [
    [/new york state energy research and development authority|\bnyserda\b|energy research and development authority/ig, 4],
    [/public service commission|department of public service|public service law/ig, 3],
    [/power authority|long island power authority|\bnypa\b|\blipa\b/ig, 3],
    [/cap[- ]and[- ]invest|regional greenhouse gas|greenhouse gas|climate leadership|climate action|sustainable future/ig, 3],
    [/clean energy|renewable|offshore wind|energy efficiency|heat pump|electrification|zero[- ]emission|nuclear|transmission|energy storage/ig, 2],
    [/electric|utilit(y|ies)|natural gas|ratepayer|energy law|system benefits?|energy/ig, 1]
  ];

  var TOPICS = [
    ['Batteries & storage', /batter(y|ies)|energy storage|storage (system|facilit)/i],
    ['Siting & permitting', /\bsit(e|es|ing)\b|permit|zoning|setback|host communit|land use|office of renewable energy siting|\bores\b|94-c/i],
    ['Renewables', /renewabl|solar|wind|hydroelectric|hydropower|geothermal|community solar/i],
    ['Goals & mandates', /\bgoals?\b|\btargets?\b|mandate|portfolio standard|clean energy standard|clcpa|climate leadership|by the year 20\d\d|percent (of|by)|emissions? reduction/i],
    ['Investment & funding', /\bfund(s|ing)?\b|appropriat|grant|loan|financ|\bbonds?\b|invest|incentive|rebate|tax credit|subsid/i],
    ['Rates & affordability', /\brates?\b|rate case|afford|arrear|ratepayer|surcharge|tariff|energy burden|shut ?off|termination of (utility )?service|utility bills?/i],
    ['Utility oversight & PSC', /public service commission|\bpsc\b|department of public service|utility (corporation|compan)|management audit|penalt/i],
    ['Transmission & grid', /transmission|\bgrid\b|interconnect|distribution system|nyiso|microgrid|reliabil/i],
    ['Buildings & efficiency', /thermal energy network|district energy|building|heat pump|efficien|electrification|weatheriz|energy code|all-electric|appliance/i],
    ['Transportation & EVs', /electric vehicle|\bevs?\b|charging|zero[- ]emission (vehicle|bus|truck)|fleet|transportation/i],
    ['Gas & fossil fuels', /natural gas|gas (service|corporation|utilit|plant)|pipeline|fossil|100[- ]foot|peaker|heating oil|propane/i],
    ['Nuclear, hydrogen & clean firm', /nuclear|hydrogen|clean firm|small modular|fusion|biofuel|renewable natural gas/i],
    ['Emissions & climate policy', /emission|greenhouse|climate|carbon|cap[- ]and[- ]invest|rggi|methane/i],
    ['Public power (NYPA/LIPA)', /power authority|\bnypa\b|long island power|\blipa\b|public power|municipal electric/i],
    ['Workforce & labor', /labor|workforce|prevailing wage|apprentice|union/i],
    ['Environmental justice', /disadvantaged communit|environmental justice|frontline/i],
    ['Data centers & large loads', /data cent|large load|cryptocurrenc|bitcoin/i],
    ['NYSERDA', /nyserda|energy research and development authority/i]
  ];
  function tagTopics(b) {
    var text = [b.t, b.sm, b.sum].join(' \n ');
    return TOPICS.filter(function (x) { return x[1].test(text); }).map(function (x) { return x[0]; });
  }

  // ------------------------------------------------------------------ utilities
  function log(msg) {
    var line = fmt(new Date(), 'yyyy-MM-dd HH:mm:ss') + '  ' + msg;
    LOGBUF.push(line);
    try { console.log(line); } catch (e) {}
  }
  function flushLog() {
    if (!LOGBUF.length) return;
    try {
      var f = DriveApp.getFileById(CFG.LOG);
      var old = f.getBlob().getDataAsString().split('\n');
      var lines = old.concat(LOGBUF).filter(function (l) { return l !== ''; });
      if (lines.length > 400) lines = lines.slice(lines.length - 400);
      f.setContent(lines.join('\n') + '\n');
      LOGBUF = [];
    } catch (e) { try { console.log('log flush failed ' + e); } catch (x) {} }
  }
  function fmt(d, pattern) { return Utilities.formatDate(d, CFG.TZ, pattern); }
  function nyNow() {
    var d = new Date();
    var p = fmt(d, 'yyyy-M-d-H-u').split('-').map(Number);
    return { date: d, y: p[0], m: p[1], d: p[2], h: p[3], dow: p[4], iso: fmt(d, "yyyy-MM-dd'T'HH:mm:ss"), day: fmt(d, 'yyyy-MM-dd') };
  }
  function sessionFor(n) { return n.y % 2 === 1 ? n.y : n.y - 1; }
  function inSessionWindow(n) { return n.m < 6 || (n.m === 6 && n.d <= 15); }
  function timeLeft() { return CFG.TIME_BUDGET_MS - (Date.now() - START); }
  function qs(o) {
    return Object.keys(o).filter(function (k) { return o[k] !== undefined && o[k] !== null && o[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
  }
  function billId(basePrintNo, session) { return basePrintNo + '-' + session; }
  function billUrl(basePrintNo, session) { return 'https://www.nysenate.gov/legislation/bills/' + session + '/' + basePrintNo; }
  function hash(s) {
    var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
    return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 16);
  }
  function getKey() {
    var props = PropertiesService.getScriptProperties();
    var k = props.getProperty('API_KEY');
    if (k) return k;
    var sh = SpreadsheetApp.openById(CFG.SHEET).getSheetByName('Settings');
    k = sh ? String(sh.getRange('B2').getValue()).trim() : '';
    if (!k) throw new Error('No Open Legislation API key. Paste it in the Settings tab, cell B2.');
    props.setProperty('API_KEY', k);
    return k;
  }

  // ------------------------------------------------------------------ API
  function apiUrl(path, params) {
    var p = Object.assign({}, params || {});
    p.key = getKey();
    return CFG.API + path + '?' + qs(p);
  }
  function parseResp(resp, url) {
    var code = resp.getResponseCode();
    var text = resp.getContentText();
    if (code === 404) return null;
    if (code !== 200) throw new Error('HTTP ' + code + ' for ' + url.replace(/key=[^&]+/, 'key=…') + ': ' + text.slice(0, 200));
    var j = JSON.parse(text);
    if (j.success === false) throw new Error('API error ' + (j.errorCode || '') + ': ' + (j.message || '').slice(0, 200));
    return j;
  }
  function api(path, params) {
    var url = apiUrl(path, params);
    for (var attempt = 0; attempt < 4; attempt++) {
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (r.getResponseCode() === 429) {
        var wait = Number((r.getHeaders() || {})['Retry-After'] || 2);
        Utilities.sleep(Math.min(10, Math.max(1, wait)) * 1000);
        continue;
      }
      if (r.getResponseCode() >= 500 && attempt < 2) { Utilities.sleep(2000); continue; }
      return parseResp(r, url);
    }
    throw new Error('Rate limited repeatedly: ' + path);
  }
  // Fetch many paths, CFG.BATCH at a time (the API allows 4 concurrent requests per key).
  function apiMany(reqs) {
    var out = new Array(reqs.length);
    for (var i = 0; i < reqs.length; i += CFG.BATCH) {
      var chunk = reqs.slice(i, i + CFG.BATCH);
      var urls = chunk.map(function (r) { return apiUrl(r.path, r.params); });
      var resps = UrlFetchApp.fetchAll(urls.map(function (u) { return { url: u, muteHttpExceptions: true }; }));
      for (var k = 0; k < resps.length; k++) {
        var idx = i + k;
        try {
          if (resps[k].getResponseCode() === 429) { Utilities.sleep(1500); out[idx] = api(chunk[k].path, chunk[k].params); }
          else out[idx] = parseResp(resps[k], urls[k]);
        } catch (e) { out[idx] = { error: String(e) }; }
      }
      Utilities.sleep(250);
    }
    return out;
  }
  function searchAll(session, term, max) {
    var items = [], offset = 1, total = 1;
    while (offset <= total && items.length < (max || 5000)) {
      if (timeLeft() < 45000) throw new Error('TIME');
      var j = api('/bills/' + session + '/search', { term: term, limit: 1000, offset: offset, idsOnly: true, sort: 'publishedDateTime:ASC' });
      if (!j || !j.result) break;
      total = j.total || 0;
      (j.result.items || []).forEach(function (it) { items.push(it.result || it); });
      if (!j.offsetEnd || j.offsetEnd >= total) break;
      offset = j.offsetEnd + 1;
    }
    return items;
  }

  // ------------------------------------------------------------------ database
  function dbFile() {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('DB_ID');
    if (id) { try { return DriveApp.getFileById(id); } catch (e) {} }
    var f = DriveApp.getFolderById(CFG.WORK).createFile('myla_db.json', '{}', 'text/plain');
    props.setProperty('DB_ID', f.getId());
    return f;
  }
  function loadDb() {
    var db = {};
    try { db = JSON.parse(dbFile().getBlob().getDataAsString() || '{}'); } catch (e) { db = {}; }
    db.bills = db.bills || {};
    db.hearings = db.hearings || {};
    db.budget = db.budget || { bills: {}, briefs: [] };
    db.budget.bills = db.budget.bills || {};
    db.budget.briefs = db.budget.briefs || [];
    db.activity = db.activity || [];
    db.queue = db.queue || { refetch: [] };
    db.queue.refetch = db.queue.refetch || [];
    db.events = db.events || [];
    db.seq = db.seq || 0;
    db.acked = db.acked || 0;
    db.errors = db.errors || [];
    db.sheetTracked = db.sheetTracked || {};
    db.pendingNew = db.pendingNew || [];
    // migration: fill hearing subjects parsed by older code
    Object.keys(db.hearings).forEach(function (k) {
      var h = db.hearings[k];
      if (!h.subject && h.text) { h.text = h.text.replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); }); h.subject = hearingSubject(h.text); }
    });
    db.events.forEach(function (e) {
      if (e.type === 'hearing_backlog') (e.items || []).forEach(function (it) { if (!it.subject && db.hearings[it.key]) it.subject = db.hearings[it.key].subject; });
    });
    return db;
  }
  function saveDb(db) { dbFile().setContent(JSON.stringify(db)); }
  function addEvent(db, ev) {
    db.seq += 1;
    ev.id = db.seq;
    ev.ts = nyNow().iso;
    db.events.push(ev);
  }
  function addActivity(db, id, text, date) {
    db.activity.unshift({ id: id, text: text, date: date || nyNow().day, ts: nyNow().iso });
    if (db.activity.length > 500) db.activity.length = 500;
    var b = db.bills[id];
    if (b) { b.ev = b.ev || []; b.ev.unshift({ d: date || nyNow().day, t: text }); if (b.ev.length > 40) b.ev.length = 40; }
  }

  // ------------------------------------------------------------------ bills
  function pickAmendment(b) {
    var items = (b.amendments && b.amendments.items) || {};
    return items[b.activeVersion || ''] || items[''] || items[Object.keys(items)[0]] || {};
  }
  function classify(rec) {
    var t = rec.t || '';
    var energyTitle = ENERGY_RE.test(t);
    var telecom = /telecommunication|broadband|cable television|telephone|wireless|internet/i.test(t);
    if (telecom && !energyTitle) return 'exclude';
    if (energyTitle) return 'core';
    if (EXCLUDE_RE.test(t)) return 'exclude';
    if (CORE_LAWS.test(rec.ls || '')) return 'core';
    return ENERGY_RE.test(rec.sm || '') ? 'broad' : 'exclude';
  }
  function normalize(b, prev) {
    var am = pickAmendment(b);
    var sameAs = ((am.sameAs && am.sameAs.items) || []).map(function (x) { return billId(x.basePrintNo, x.session); });
    var sp = b.sponsor || {};
    var sponsor = sp.member ? (sp.member.fullName || sp.member.shortName) : (sp.budget ? 'Budget bill (Governor)' : (sp.rules ? 'Rules Committee' : ''));
    var acts = (b.actions && b.actions.items) || [];
    var last = acts.length ? acts[acts.length - 1] : null;
    var st = b.status || {};
    var rec = prev ? Object.assign({}, prev) : {};
    rec.id = billId(b.basePrintNo, b.session);
    rec.b = b.basePrintNo;
    rec.p = b.printNo || b.basePrintNo;
    rec.s = b.session;
    rec.t = b.title || '';
    rec.sm = (b.summary || '').slice(0, 600);
    rec.sp = sponsor;
    rec.co = (am.coSponsors && am.coSponsors.size) || 0;
    rec.sa = sameAs.join(', ');
    rec.st = st.statusDesc || '';
    rec.sd = st.actionDate || '';
    rec.cm = st.committeeName || '';
    rec.la = last ? last.text : '';
    rec.ld = last ? last.date : (st.actionDate || '');
    rec.ls = am.lawSection || '';
    rec.pg = (b.programInfo && b.programInfo.name) || '';
    rec.dist = sp.member ? (sp.member.districtCode || '') : '';
    var pc = (b.pastCommittees && b.pastCommittees.items) || [];
    rec.lc = pc.length ? cap(pc[pc.length - 1].chamber) + ' ' + pc[pc.length - 1].name : '';
    rec.pub = (b.publishedDateTime || '').slice(0, 10);
    rec.u = billUrl(b.basePrintNo, b.session);
    rec.ch = (b.billType && b.billType.chamber) || (String(b.basePrintNo).charAt(0) === 'S' ? 'SENATE' : 'ASSEMBLY');
    rec.signed = !!b.signed;
    rec.snap = {
      an: acts.length,
      vn: ((b.votes && b.votes.items) || []).length,
      ag: ((b.committeeAgendas && b.committeeAgendas.items) || []).length,
      ca: ((b.calendars && b.calendars.items) || []).length,
      vt: ((b.vetoMessages && b.vetoMessages.items) || []).length,
      ap: b.approvalMessage && b.approvalMessage.chapter ? 1 : 0
    };
    if (!rec.rel) rec.rel = classify(rec);
    if (rec.tr) rec.hist = buildHist(b); else delete rec.hist;
    return rec;
  }
  // Full action and vote history for tracked bills, newest first.
  function buildHist(b) {
    var h = [];
    ((b.actions && b.actions.items) || []).forEach(function (a, i) { h.push({ d: a.date || '', t: a.text + (a.chamber ? ' (' + cap(a.chamber) + ')' : ''), o: i }); });
    ((b.votes && b.votes.items) || []).forEach(function (v, i) { h.push({ d: v.voteDate || '', t: voteText(v), o: 1000 + i }); });
    h.sort(function (x, y) { return String(y.d).localeCompare(String(x.d)) || y.o - x.o; });
    return h.slice(0, 300).map(function (x) { return { d: x.d, t: x.t }; });
  }
  function voteText(v) {
    var mv = (v.memberVotes && v.memberVotes.items) || {};
    function n(code) { return (mv[code] && (mv[code].size || (mv[code].items || []).length)) || 0; }
    var ayes = n('AYE') + n('AYEWR'), nays = n('NAY');
    var where = v.voteType === 'COMMITTEE' ? ((v.committee && v.committee.chamber ? cap(v.committee.chamber) + ' ' : '') + ((v.committee && v.committee.name) || '') + ' Committee vote') : (cap((v.committee && v.committee.chamber) || '') + ' floor vote').trim();
    return where + ' (' + (v.voteDate || '') + '): ' + ayes + ' aye, ' + nays + ' nay';
  }
  function cap(s) { s = String(s || '').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }
  function agendaText(item) {
    try {
      var a = item.agendaId || {}, c = item.committeeId || {};
      var j = api('/agendas/' + a.year + '/' + a.number + '/' + encodeURIComponent(c.name || ''), {});
      var raw = j ? JSON.stringify(j) : '';
      var dt = (raw.match(/"meetingDateTime"\s*:\s*"([^"]+)"/) || [])[1] || '';
      var loc = (raw.match(/"location"\s*:\s*"([^"]+)"/) || [])[1] || '';
      return 'On the ' + cap(c.chamber) + ' ' + (c.name || '') + ' Committee agenda' + (dt ? ' for ' + dt.replace('T', ' ').slice(0, 16) : '') + (loc ? ' (' + loc + ')' : '');
    } catch (e) {
      return 'Placed on a ' + cap((item.committeeId || {}).chamber) + ' ' + ((item.committeeId || {}).name || '') + ' Committee agenda';
    }
  }
  var MAJOR_RE = /passed|delivered to governor|signed|vetoed|chapter|reported|third reading|substituted|returned|recalled|amend/i;
  function diffTracked(db, rec, b, prevSnap) {
    if (!prevSnap) return;
    var acts = (b.actions && b.actions.items) || [];
    acts.slice(prevSnap.an).forEach(function (a) {
      var text = a.text + (a.chamber ? ' (' + cap(a.chamber) + ')' : '');
      addActivity(db, rec.id, text, a.date);
      addEvent(db, { type: 'bill_action', bill: rec.id, printNo: rec.p, title: rec.t, detail: text, date: a.date, major: MAJOR_RE.test(a.text), url: rec.u });
    });
    var votes = (b.votes && b.votes.items) || [];
    votes.slice(prevSnap.vn).forEach(function (v) {
      var t = voteText(v);
      addActivity(db, rec.id, t, v.voteDate);
      addEvent(db, { type: 'bill_vote', bill: rec.id, printNo: rec.p, title: rec.t, detail: t, date: v.voteDate, major: true, url: rec.u });
    });
    var ags = (b.committeeAgendas && b.committeeAgendas.items) || [];
    ags.slice(prevSnap.ag).forEach(function (item) {
      var t = agendaText(item);
      addActivity(db, rec.id, t);
      addEvent(db, { type: 'bill_agenda', bill: rec.id, printNo: rec.p, title: rec.t, detail: t, major: true, url: rec.u });
    });
    if (rec.snap.vt > prevSnap.vt) addEvent(db, { type: 'bill_action', bill: rec.id, printNo: rec.p, title: rec.t, detail: 'Vetoed by the Governor', major: true, url: rec.u });
    if (rec.snap.ap > prevSnap.ap) addEvent(db, { type: 'bill_action', bill: rec.id, printNo: rec.p, title: rec.t, detail: 'Signed into law' + (b.approvalMessage.chapter ? ' (Chapter ' + b.approvalMessage.chapter + ')' : ''), major: true, url: rec.u });
  }
  // Fetch full records for ids; update db; returns ids not finished (time ran out).
  function refreshBills(db, ids, opts) {
    opts = opts || {};
    var i = 0;
    while (i < ids.length && timeLeft() > 30000) {
      var chunk = ids.slice(i, i + 20);
      var res = apiMany(chunk.map(function (id) {
        var parts = id.split('-');
        return { path: '/bills/' + parts[1] + '/' + parts[0], params: { view: 'no_fulltext' } };
      }));
      res.forEach(function (j, k) {
        var id = chunk[k];
        if (!j || j.error || !j.result) { if (j && j.error) log('fetch ' + id + ' failed: ' + j.error.slice(0, 150)); return; }
        var b = j.result;
        var prev = db.bills[id];
        var prevSnap = prev && prev.snap;
        var rec = normalize(b, prev);
        if (!prev && opts.relevantOnly && rec.rel === 'exclude') { db.excluded = db.excluded || {}; db.excluded[id] = 1; return; }
        db.bills[id] = rec;
        if (prev && prev.tr) diffTracked(db, rec, b, prevSnap);
        if (!prev && opts.onNew) opts.onNew(rec);
      });
      i += chunk.length;
    }
    return ids.slice(i);
  }
  // Runs every search term; resumable. prog = {i, ids:{}} persists between runs (backfill) or is fresh (daily check).
  function searchTerms() {
    var terms = [];
    SEARCH_GROUPS.forEach(function (g) { terms.push('title:(' + g + ')'); terms.push('summary:(' + g + ')'); });
    return terms;
  }
  function addHits(out, rs, session) {
    var n = 0;
    rs.forEach(function (r) {
      if (!r || !r.basePrintNo || !/^[SA]\d/.test(r.basePrintNo)) return;   // bills only, no resolutions
      out[billId(r.basePrintNo, r.session || session)] = 1; n++;
    });
    return n;
  }
  function candidateIds(session, extraTerm, prog) {
    prog = prog || {};
    prog.i = prog.i || 0;
    prog.ids = prog.ids || {};
    var terms = searchTerms();
    while (prog.i < terms.length) {
      var t = terms[prog.i];
      try {
        var n = addHits(prog.ids, searchAll(session, '(' + t + ')' + (extraTerm ? ' AND ' + extraTerm : '')), session);
        if (!extraTerm) log('search ' + (prog.i + 1) + '/' + terms.length + ': ' + n + ' hits');
      } catch (e) {
        if (String(e).indexOf('TIME') >= 0) { prog.partial = true; return null; }
        log('search failed (' + t.slice(0, 40) + '…): ' + String(e).slice(0, 160));
      }
      prog.i++;
    }
    // Law-section searches: the right field name isn't documented, so try a few and remember what works.
    var props = PropertiesService.getScriptProperties();
    var field = props.getProperty('LAW_FIELD');
    if (field !== 'none' && timeLeft() > 45000) {
      var fields = field ? [field] : LAW_FIELDS, done = false;
      for (var f = 0; f < fields.length && !done; f++) {
        var got = 0, ok = true;
        for (var k = 0; k < LAW_NAMES.length && ok; k++) {
          try { got += addHits(prog.ids, searchAll(session, fields[f] + ':' + LAW_NAMES[k] + (extraTerm ? ' AND ' + extraTerm : '')), session); }
          catch (e) { ok = false; }
        }
        if (ok && (got > 0 || field)) { done = true; if (!field) { props.setProperty('LAW_FIELD', fields[f]); log('law-section search works with field ' + fields[f]); } }
      }
      if (!done && !field) { props.setProperty('LAW_FIELD', 'none'); log('law-section search unavailable; relying on title and summary searches'); }
    }
    prog.partial = false;
    return Object.keys(prog.ids);
  }

  // ------------------------------------------------------------------ tracking
  function setTracked(db, id, on, viaSheet) {
    var ids = [id];
    var b = db.bills[id];
    if (!b) {
      var left = refreshBills(db, [id], {});
      b = db.bills[id];
      if (!b) { log('track: unknown bill ' + id); return; }
    }
    (b.sa || '').split(', ').filter(String).forEach(function (s) {
      if (!db.bills[s]) refreshBills(db, [s], {});
      if (db.bills[s]) ids.push(s);
    });
    ids.forEach(function (x) {
      var r = db.bills[x];
      if (!r) return;
      if (r.rel === 'exclude') r.rel = 'core';
      var was = !!r.tr;
      r.tr = !!on;
      if (on && !was) addActivity(db, x, 'Tracking started');
    });
    try { refreshBills(db, ids, {}); } catch (e) { log('history refresh failed: ' + e); }
    if (on && !b.sum && !b.sumQueued) queueSummary(db, id);
    log((on ? 'tracking ' : 'untracked ') + ids.join(' + ') + (viaSheet ? ' (from Sheet)' : ''));
  }
  function queueSummary(db, id) {
    var parts = id.split('-');
    var b = db.bills[id];
    var j = api('/bills/' + parts[1] + '/' + parts[0], { view: 'default', fullTextFormat: 'PLAIN' });
    if (!j || !j.result) return;
    var am = pickAmendment(j.result);
    var text = am.fullText || '';
    var memo = am.memo || '';
    var sameText = '';
    (b.sa || '').split(', ').filter(String).slice(0, 1).forEach(function (s) {
      var sb = db.bills[s];
      if (sb) sameText = s + ' (' + sb.sp + ')';
    });
    var doc = [
      'BILL: ' + b.p + ' (' + b.s + '-' + (Number(b.s) + 1) + ' session)',
      'TITLE: ' + b.t,
      'SPONSOR: ' + b.sp + (b.co ? ' + ' + b.co + ' cosponsors' : ''),
      'SAME AS: ' + (sameText || 'none'),
      'LAW SECTION: ' + b.ls,
      'STATUS: ' + b.st + ' (' + b.sd + ')',
      'PROGRAM BILL: ' + (b.pg || 'no'),
      'URL: ' + b.u,
      '',
      '=== SPONSOR MEMO ===',
      memo.slice(0, 60000) || '(no memo)',
      '',
      '=== BILL TEXT ===',
      text.length > 200000 ? text.slice(0, 200000) + '\n[... text truncated at 200,000 characters of ' + text.length + ' ...]' : text
    ].join('\n');
    var f = DriveApp.getFolderById(CFG.WORK).createFile('summary_' + id + '.txt', doc, 'text/plain');
    b.sumQueued = f.getId();
    addEvent(db, { type: 'summary_needed', bill: id, printNo: b.p, title: b.t, fileId: f.getId(), url: b.u });
  }

  // ------------------------------------------------------------------ hearings
  function htmlToText(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function (m, href, inner) {
        var abs = href.indexOf('http') === 0 ? href : 'https://nyassembly.gov' + (href.charAt(0) === '/' ? '' : '/leg/') + href;
        return inner + ' [' + abs.replace(/&amp;/g, '&') + ']';
      })
      .replace(/<(br|\/p|\/li|\/div|\/tr|\/h\d|li|p|tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&ndash;|&mdash;/g, '–').replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); })
      .replace(/[ \t]+/g, ' ')
      .split('\n').map(function (l) { return l.trim(); }).filter(String).join('\n');
  }
  function hearingSubject(clean) {
    var lines = clean.split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^(Public Hearing|Roundtable|Budget Hearing)\s*:?\s*(.*)$/i);
      if (!m) continue;
      if (m[2]) out.push(m[2]);
      for (var j = i + 1; j < lines.length && out.length < 3; j++) {
        if (/^(Place|Time|Contact|Chair|Media|Oral|Joint|Assembly Standing|Senate Standing)\b/i.test(lines[j])) break;
        out.push(lines[j]);
      }
      break;
    }
    return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  var DATE_LINE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/;
  function parseHearings(text) {
    var lines = text.split('\n'), blocks = [], cur = null;
    lines.forEach(function (l) {
      if (DATE_LINE.test(l)) { if (cur) blocks.push(cur); cur = [l]; }
      else if (cur) { if (cur.length < 40) cur.push(l); }
    });
    if (cur) blocks.push(cur);
    var out = [], seen = {};
    blocks.forEach(function (bl) {
      var full = bl.join('\n');
      if (!/public hearing|roundtable|budget hearing/i.test(full)) return;
      var link = (full.match(/\[(https?:\/\/[^\]]+comm\/[^\]]+)\]/) || full.match(/\[(https?:\/\/[^\]]+)\]/) || [])[1] || CFG.HEARINGS_URL;
      var clean = full.replace(/\s*\[https?:\/\/[^\]]+\]/g, '').replace(/\S*\/comm\/\?\S*/g, '').replace(/View public hearing notice/gi, '').replace(/\n{2,}/g, '\n').trim();
      var key = hash(clean.replace(/\s+/g, ' ').toLowerCase());
      if (seen[key]) return;
      seen[key] = 1;
      var subject = hearingSubject(clean);
      out.push({ key: key, date: bl[0].match(DATE_LINE)[0], subject: subject.replace(/\n/g, ' ').trim(), text: clean.slice(0, 1500), link: link });
    });
    return out;
  }
  function checkHearings(db, firstRun) {
    var r = UrlFetchApp.fetch(CFG.HEARINGS_URL, { muteHttpExceptions: true, followRedirects: true });
    if (r.getResponseCode() !== 200) { log('hearings page HTTP ' + r.getResponseCode()); return; }
    var hs = parseHearings(htmlToText(r.getContentText()));
    if (!hs.length) {
      db.hearingMiss = (db.hearingMiss || 0) + 1;
      log('hearings page: no hearings parsed (' + db.hearingMiss + ' in a row)');
      if (db.hearingMiss === 3) addEvent(db, { type: 'error', detail: 'The Assembly hearing calendar page returned no hearings three checks in a row. Its layout may have changed.' });
      return;
    }
    db.hearingMiss = 0;
    var n = 0;
    hs.forEach(function (h) {
      if (db.hearings[h.key]) return;
      h.found = nyNow().day;
      h.match = HEARING_RE.test(h.subject + ' ' + h.text);
      h.rel = h.match ? null : false;   // Claude decides relevance for keyword matches
      db.hearings[h.key] = h;
      n++;
      if (h.match && !firstRun) addEvent(db, { type: 'hearing', key: h.key, date: h.date, subject: h.subject, text: h.text, url: h.link });
      if (h.match && firstRun) h.rel = null;
    });
    if (firstRun) {
      // On the very first run, queue matched hearings once for Claude to judge, without push.
      var matched = hs.filter(function (h) { return h.match; });
      if (matched.length) addEvent(db, { type: 'hearing_backlog', items: matched.map(function (h) { return { key: h.key, date: h.date, subject: h.subject }; }) });
    }
    // Drop hearings found more than 120 days ago
    var cutoff = fmt(new Date(Date.now() - 120 * 864e5), 'yyyy-MM-dd');
    Object.keys(db.hearings).forEach(function (k) { if (db.hearings[k].found < cutoff) delete db.hearings[k]; });
    log('hearings: ' + hs.length + ' on calendar, ' + n + ' new');
  }

  // ------------------------------------------------------------------ budget
  function segmentText(text) {
    var lines = text.split('\n');
    var partIdx = [];
    lines.forEach(function (l, i) { if (/^\s*(\d+\s+)?PART\s+[A-Z]{1,3}\.?\s*$/.test(l)) partIdx.push(i); });
    var segs = [];
    if (partIdx.length >= 3) {
      if (partIdx[0] > 0) segs.push({ name: 'Preamble', text: lines.slice(0, partIdx[0]).join('\n') });
      partIdx.forEach(function (st, k) {
        var en = k + 1 < partIdx.length ? partIdx[k + 1] : lines.length;
        segs.push({ name: lines[st].trim(), text: lines.slice(st, en).join('\n') });
      });
      return segs;
    }
    // Appropriation bills: split on all-caps agency headings
    var hdr = [];
    lines.forEach(function (l, i) {
      var t = l.replace(/^\s*\d+\s+/, '').trim();
      if (t.length > 12 && t.length < 110 && /^[A-Z][A-Z ,.'&()\-]+$/.test(t) && /(DEPARTMENT|AUTHORITY|OFFICE|DIVISION|COMMISSION|AGENCY|COUNCIL|BOARD|FUND|PROGRAM)/.test(t)) hdr.push(i);
    });
    if (hdr.length >= 3) {
      if (hdr[0] > 0) segs.push({ name: 'Preamble', text: lines.slice(0, hdr[0]).join('\n') });
      hdr.forEach(function (st, k) {
        var en = k + 1 < hdr.length ? hdr[k + 1] : lines.length;
        segs.push({ name: lines[st].replace(/^\s*\d+\s+/, '').trim(), text: lines.slice(st, en).join('\n') });
      });
      return segs;
    }
    for (var i = 0; i < lines.length; i += 400) segs.push({ name: 'Lines ' + (i + 1) + '–' + Math.min(lines.length, i + 400), text: lines.slice(i, i + 400).join('\n') });
    return segs;
  }
  function scoreText(t) {
    var s = 0;
    BUDGET_TERMS.forEach(function (pair) { var m = t.match(pair[0]); if (m) s += Math.min(m.length, 25) * pair[1]; });
    return s;
  }
  var NYSERDA_RE = /nyserda|energy research and development authority/i;
  function excerptBudget(text, cap, onlyRe) {
    cap = cap || 160000;
    var segs = segmentText(text).map(function (s) { s.score = scoreText(s.name + '\n' + s.text) + (/ENERGY RESEARCH|PUBLIC SERVICE|POWER AUTHORITY|ENVIRONMENTAL CONSERVATION/.test(s.name) ? 50 : 0); return s; });
    var keep = onlyRe ? segs.filter(function (s) { return onlyRe.test(s.name + '\n' + s.text); }) : segs.filter(function (s) { return s.score >= 6; });
    keep.sort(function (a, b) { return b.score - a.score; });
    var out = [], used = 0;
    keep.forEach(function (s) {
      var t = s.text.length > 60000 ? s.text.slice(0, 60000) + '\n[... segment truncated ...]' : s.text;
      if (used + t.length > cap) return;
      used += t.length;
      out.push(s.name);
      s.kept = t;
    });
    var ordered = segs.filter(function (s) { return s.kept; });
    return { names: out, total: segs.length, text: ordered.map(function (s) { return '##### ' + s.name + ' (relevance score ' + s.score + ')\n' + s.kept; }).join('\n\n') };
  }
  function stageGuess(n, version, changedChambers, status) {
    if (/signed|chapter|delivered to governor/i.test(status || '')) return 'Enacted budget';
    if (!version) return 'Executive Budget';
    if (version === 'A' && n.m <= 3) return '30-day amendments';
    if (changedChambers.length === 1 && n.m <= 4) return cap(changedChambers[0]) + ' one-house budget';
    return 'Amended budget bills (version ' + version + ')';
  }
  function budgetBillWanted(title) {
    var t = String(title || '');
    if (!/major components of legislation necessary to implement/i.test(t)) return true; // appropriation bills
    return /transportation, economic development and environmental conservation|revenue/i.test(t);
  }
  function checkBudget(db, n, session, seedOnly) {
    var items = searchAll(session, 'sponsor.budget:true', 200);
    var bills = items.filter(function (r) { return r && r.basePrintNo && !(r.billType && r.billType.resolution); });
    if (!bills.length) return;
    var res = apiMany(bills.map(function (r) { return { path: '/bills/' + session + '/' + r.basePrintNo, params: { view: 'no_fulltext' } }; }));
    var changed = [];
    res.forEach(function (j) {
      if (!j || j.error || !j.result) return;
      var b = j.result, id = billId(b.basePrintNo, b.session);
      var prev = db.budget.bills[id];
      var ver = b.activeVersion || '';
      var am = pickAmendment(b);
      var info = { id: id, b: b.basePrintNo, t: b.title, v: ver, st: (b.status || {}).statusDesc || '', ch: (b.billType && b.billType.chamber) || '', sa: ((am.sameAs && am.sameAs.items) || []).map(function (x) { return billId(x.basePrintNo, x.session); }).join(', '), u: billUrl(b.basePrintNo, b.session), versions: (prev && prev.versions) || {} };
      if (!info.versions[ver]) { info.versions[ver] = nyNow().day; if (!seedOnly) changed.push(info); }
      db.budget.bills[id] = info;
    });
    // Rule: of the Article VII language bills, read TED (and Revenue) in full for energy/climate;
    // scan the others only for passages that name NYSERDA.
    changed.forEach(function (c) { c.nyserdaOnly = !budgetBillWanted(c.t); });
    if (!changed.length) return;
    var chambers = {};
    changed.forEach(function (c) { chambers[c.ch] = 1; });
    var stage = stageGuess(n, changed[0].v, Object.keys(chambers), changed[0].st);
    var hashes = {}, files = [];
    changed.forEach(function (c) {
      if (timeLeft() < 60000) { delete c.versions[c.v]; db.budget.bills[c.id] = c; return; } // retry next tick
      var j = api('/bills/' + session + '/' + c.b, { view: 'default', fullTextFormat: 'PLAIN' });
      if (!j || !j.result) return;
      var am = ((j.result.amendments && j.result.amendments.items) || {})[c.v] || pickAmendment(j.result);
      var text = am.fullText || '';
      var h = hash(text);
      if (hashes[h]) { hashes[h].dups.push(c.b + c.v); return; }
      var ex = excerptBudget(text, null, c.nyserdaOnly ? NYSERDA_RE : null);
      if (c.nyserdaOnly && !ex.names.length) { log('budget: ' + c.b + (c.v || '') + ' does not mention NYSERDA; skipped'); return; }
      var header = ['BUDGET BILL: ' + c.b + (c.v ? '-' + c.v : '') + '  (' + cap(c.ch) + ')', 'TITLE: ' + c.t, 'SAME AS: ' + (c.sa || 'none'), 'STAGE (guess): ' + stage, 'URL: ' + c.u, 'FULL TEXT: ' + text.length + ' characters, ' + ex.total + ' sections; ' + ex.names.length + (c.nyserdaOnly ? ' sections kept below ONLY because they name NYSERDA (this Article VII bill is outside TED, so only NYSERDA-related provisions matter here).' : ' sections kept below because they mention energy, climate, NYSERDA, DPS/PSC, NYPA/LIPA or related terms.'), ''].join('\n');
      var f = DriveApp.getFolderById(CFG.WORK).createFile('budget_' + c.b + (c.v || '') + '.txt', header + '\n' + (ex.text || '(no relevant sections found)'), 'text/plain');
      var entry = { bill: c.b + (c.v ? '-' + c.v : ''), nyserdaOnly: !!c.nyserdaOnly, title: c.t, chamber: c.ch, url: c.u, fileId: f.getId(), chars: text.length, kept: ex.names.length, dups: [] };
      hashes[h] = entry;
      files.push(entry);
    });
    if (files.length) {
      addEvent(db, { type: 'budget_posted', stage: stage, bills: files, prevBrief: db.budget.briefs.length ? db.budget.briefs[0] : null });
      log('budget: ' + stage + ' — ' + files.length + ' bill texts queued');
    }
  }

  // ------------------------------------------------------------------ inbox
  function ingest(db) {
    var folder = DriveApp.getFolderById(CFG.INBOX);
    var it = folder.getFiles(), files = [];
    while (it.hasNext()) files.push(it.next());
    files.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
    var n = 0;
    files.forEach(function (f) {
      var ops = [];
      try {
        var j = JSON.parse(f.getBlob().getDataAsString());
        ops = j.ops || [j];
      } catch (e) { log('inbox: could not read ' + f.getName() + ': ' + e); }
      ops.forEach(function (op) {
        try { applyOp(db, op); n++; } catch (e) { log('inbox op ' + JSON.stringify(op).slice(0, 120) + ' failed: ' + e); }
      });
      f.setTrashed(true);
    });
    if (n) log('inbox: applied ' + n + ' ops');
    return n;
  }
  function applyOp(db, op) {
    switch (op.op) {
      case 'track': setTracked(db, op.id, true); break;
      case 'untrack': setTracked(db, op.id, false); break;
      case 'summary': {
        var b = db.bills[op.id];
        if (!b) return;
        [op.id].concat((b.sa || '').split(', ').filter(String)).forEach(function (x) {
          var r = db.bills[x];
          if (!r) return;
          r.sum = op.text;
          r.sumAt = nyNow().day;
          if (r.sumQueued) { try { DriveApp.getFileById(r.sumQueued).setTrashed(true); } catch (e) {} delete r.sumQueued; }
        });
        break;
      }
      case 'hearing': {
        var h = db.hearings[op.key];
        if (h) { h.rel = !!op.relevant; if (op.note) h.note = op.note; }
        break;
      }
      case 'budget_brief': {
        db.budget.briefs.unshift({ stage: op.stage, title: op.title, url: op.url, date: nyNow().day, highlights: op.highlights || [] });
        (op.files || []).forEach(function (fid) { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {} });
        break;
      }
      case 'ack': {
        var upTo = Number(op.upTo) || 0;
        db.acked = Math.max(db.acked, upTo);
        db.events = db.events.filter(function (e) { return e.id > db.acked; });
        break;
      }
      case 'party': { db.party = db.party || {}; if (op.name && op.party && op.party !== '?') db.party[op.name] = String(op.party).slice(0, 12); break; }
      case 'resummarize': { var r = db.bills[op.id]; if (r) { delete r.sum; delete r.sumQueued; queueSummary(db, op.id); } break; }
      default: log('inbox: unknown op ' + op.op);
    }
  }

  // ------------------------------------------------------------------ outputs
  var PARTY = {};
  function compact(b) {
    return { pt: PARTY[b.sp] || '', lc: b.lc || '', ch: b.ch || '', tp: tagTopics(b), id: b.id, p: b.p, t: b.t, sp: b.sp, co: b.co, sa: b.sa, st: b.st, sd: b.sd, cm: b.cm, la: b.la, ld: b.ld, ls: b.ls, pg: b.pg, pub: b.pub, u: b.u, rel: b.rel, tr: !!b.tr, sum: b.sum || '', sumAt: b.sumAt || '', q: !!b.sumQueued, ev: b.tr ? mergeHist(b) : undefined };
  }
  function mergeHist(b) {
    var hist = b.hist || [], seen = {};
    hist.forEach(function (x) { seen[x.d + '|' + x.t] = 1; seen[x.t] = 1; });
    var notes = (b.ev || []).filter(function (e) { return !seen[e.d + '|' + e.t] && !seen[e.t]; });
    var all = hist.concat(notes);
    all.sort(function (x, y) { return String(y.d).localeCompare(String(x.d)); });
    return all.slice(0, 300);
  }
  function writeOutputs(db, n) {
    PARTY = db.party || {};
    var session = db.session;
    var bills = Object.keys(db.bills).map(function (k) { return db.bills[k]; })
      .filter(function (b) { return String(b.s) === String(session) && b.rel !== 'exclude' && (b.tr || !/^stricken/i.test(b.st || '')); });
    bills.sort(function (a, b) { return (b.tr ? 1 : 0) - (a.tr ? 1 : 0) || String(b.ld).localeCompare(String(a.ld)); });
    var hearings = Object.keys(db.hearings).map(function (k) { return db.hearings[k]; })
      .sort(function (a, b) { return String(b.found).localeCompare(String(a.found)); }).slice(0, 80);
    var data = {
      version: CFG.VERSION, asof: n.iso, session: session, lastCheck: db.lastCheck || '', backfill: db.backfill || null,
      counts: { bills: bills.length, tracked: bills.filter(function (b) { return b.tr; }).length },
      bills: bills.map(compact),
      hearings: hearings.map(function (h) { return { key: h.key, date: h.date, subject: h.subject, text: h.text, url: h.link, found: h.found, match: h.match, rel: h.rel, note: h.note || '' }; }),
      budget: { briefs: db.budget.briefs.slice(0, 20), bills: Object.keys(db.budget.bills).map(function (k) { var x = db.budget.bills[k]; return { id: x.id, b: x.b, t: x.t, v: x.v, st: x.st, u: x.u, versions: x.versions }; }) },
      activity: db.activity.slice(0, 150),
      errors: db.errors.slice(0, 5)
    };
    DriveApp.getFileById(CFG.DATA).setContent(JSON.stringify(data));
    DriveApp.getFileById(CFG.EVENTS).setContent(JSON.stringify({ updated: n.iso, acked: db.acked, events: db.events.filter(function (e) { return e.id > db.acked; }).slice(-150) }, null, 1));
    writeSheet(db, bills, hearings);
  }
  function ensureSheet(ss, name, header) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (header) {
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  }
  var BILL_HEADER = ['Track', 'Bill', 'Same as', 'Title', 'Sponsor', 'Status', 'Last action date', 'Last action', 'Law section', 'Relevance', 'Link', 'Summary'];
  function writeSheet(db, bills, hearings) {
    var ss = SpreadsheetApp.openById(CFG.SHEET);
    var sh = ensureSheet(ss, 'Bills', BILL_HEADER);
    var rows = bills.map(function (b) { return [!!b.tr, b.id, b.sa, b.t, b.sp, b.st, b.ld, b.la, b.ls, b.rel, b.u, (b.sum || '').slice(0, 45000)]; });
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, BILL_HEADER.length).clearContent();
    if (rows.length) {
      sh.getRange(2, 1, rows.length, BILL_HEADER.length).setValues(rows);
      sh.getRange(2, 1, rows.length, 1).insertCheckboxes();
    }
    db.sheetTracked = {};
    bills.forEach(function (b) { if (b.tr) db.sheetTracked[b.id] = 1; });
    var ah = ensureSheet(ss, 'Activity', ['Date', 'Bill', 'What happened']);
    var arows = db.activity.slice(0, 500).map(function (a) { return [a.date, a.id, a.text]; });
    if (ah.getLastRow() > 1) ah.getRange(2, 1, ah.getLastRow() - 1, 3).clearContent();
    if (arows.length) ah.getRange(2, 1, arows.length, 3).setValues(arows);
    var hh = ensureSheet(ss, 'Hearings', ['Found', 'Date', 'Subject', 'Energy/climate?', 'Details', 'Link']);
    var hrows = hearings.map(function (h) { return [h.found, h.date, h.subject, h.rel === true ? 'yes' : h.rel === false ? 'no' : (h.match ? 'checking' : 'no'), h.text, h.link]; });
    if (hh.getLastRow() > 1) hh.getRange(2, 1, hh.getLastRow() - 1, 6).clearContent();
    if (hrows.length) hh.getRange(2, 1, hrows.length, 6).setValues(hrows);
    var bh = ensureSheet(ss, 'Budget', ['Date', 'Stage', 'Brief', 'Link']);
    var brows = db.budget.briefs.map(function (x) { return [x.date, x.stage, x.title, x.url]; });
    if (bh.getLastRow() > 1) bh.getRange(2, 1, bh.getLastRow() - 1, 4).clearContent();
    if (brows.length) bh.getRange(2, 1, brows.length, 4).setValues(brows);
    var st = ss.getSheetByName('Settings');
    if (st) st.getRange('A5:B7').setValues([['Last check', db.lastCheck || ''], ['Code version', CFG.VERSION], ['Bills in view', bills.length]]);
  }
  // Checkbox changes made directly in the Sheet.
  function syncSheetTracking(db) {
    var sh = SpreadsheetApp.openById(CFG.SHEET).getSheetByName('Bills');
    if (!sh || sh.getLastRow() < 2) return 0;
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues(), n = 0;
    vals.forEach(function (r) {
      var id = r[1], on = r[0] === true;
      if (!id || !db.bills[id]) return;
      var wrote = !!db.sheetTracked[id];
      if (on !== wrote && on !== !!db.bills[id].tr) { setTracked(db, id, on, true); n++; }
    });
    return n;
  }

  // ------------------------------------------------------------------ main flows
  function rollSession(db, n) {
    var session = sessionFor(n);
    if (db.session && String(db.session) === String(session)) return false;
    if (db.session) {
      // Archive the old session's tracked bills and start fresh.
      var arch = {};
      Object.keys(db.bills).forEach(function (k) { if (db.bills[k].tr) arch[k] = db.bills[k]; });
      DriveApp.getFolderById(CFG.WORK).createFile('archive_' + db.session + '.json', JSON.stringify({ tracked: arch, activity: db.activity }), 'text/plain');
      log('session rollover ' + db.session + ' -> ' + session + '; archived ' + Object.keys(arch).length + ' tracked bills');
      db.bills = {}; db.activity = []; db.excluded = {}; db.budget.bills = {}; db.queue.refetch = [];
      addEvent(db, { type: 'info', detail: 'New legislative session ' + session + '–' + (session + 1) + ' started. MyLA archived last session\'s tracked bills and is loading the new session.' });
    }
    db.session = session;
    db.backfill = { stage: 'search', session: session, started: n.iso };
    return true;
  }
  function runBackfill(db, n) {
    var bf = db.backfill;
    if (!bf || bf.stage === 'done') return;
    if (bf.stage === 'search') {
      bf.prog = bf.prog || {};
      var found = candidateIds(bf.session, null, bf.prog);
      if (!found) { log('backfill: searches paused at ' + bf.prog.i + '; continuing next run'); return; }
      delete bf.prog;
      bf.ids = found.filter(function (id) { return !db.bills[id]; });
      bf.total = bf.ids.length;
      bf.stage = 'fetch';
      bf.fromTime = n.iso;
      log('backfill: ' + bf.total + ' candidate bills for session ' + bf.session);
    }
    if (bf.stage === 'fetch') {
      bf.ids = refreshBills(db, bf.ids, { relevantOnly: true });
      log('backfill: ' + (bf.total - bf.ids.length) + ' / ' + bf.total + ' fetched');
      if (!bf.ids.length) {
        bf.stage = 'done';
        bf.finished = n.iso;
        db.lastNewCheck = bf.fromTime;
        db.lastUpdateCheck = bf.fromTime;
        try { checkHearings(db, true); } catch (e) { log('hearings failed: ' + e); }
        try { checkBudget(db, n, bf.session, true); } catch (e) { log('budget seed failed: ' + e); }
        var count = Object.keys(db.bills).filter(function (k) { return db.bills[k].rel !== 'exclude'; }).length;
        addEvent(db, { type: 'setup_complete', session: bf.session, count: count, detail: 'MyLA loaded ' + count + ' energy and climate bills from the ' + bf.session + '–' + (bf.session + 1) + ' session.' });
      }
    }
  }
  function regularCheck(db, n) {
    var session = db.session;
    // 1. Bills changed since last check
    var from = db.lastUpdateCheck || n.iso;
    var changed = {}, offset = 1, total = 1, guard = 0;
    while (offset <= total && guard++ < 20) {
      var j = api('/bills/updates/' + from.slice(0, 19), { type: 'processed', limit: 1000, offset: offset });
      if (!j || !j.result) break;
      total = j.total || 0;
      (j.result.items || []).forEach(function (it) { var x = it.id || {}; if (x.basePrintNo) changed[billId(x.basePrintNo, x.session)] = 1; });
      if (!j.offsetEnd || j.offsetEnd >= total) break;
      offset = j.offsetEnd + 1;
    }
    // Only tracked bills are kept current; untracked bills stay as first loaded (static fields only).
    var known = Object.keys(changed).filter(function (id) { return db.bills[id] && db.bills[id].tr; });
    db.queue.refetch = db.queue.refetch.concat(known.filter(function (id) { return db.queue.refetch.indexOf(id) < 0; }));
    db.lastUpdateCheck = n.iso;
    // 2. New bills since last check
    var since = (db.lastNewCheck || n.iso).slice(0, 10);
    var yesterday = fmt(new Date(new Date(since + 'T12:00:00').getTime() - 864e5), 'yyyy-MM-dd');
    var fresh = (candidateIds(session, 'publishedDateTime:[' + yesterday + ' TO *]') || [])
      .filter(function (id) { return !db.bills[id] && !(db.excluded || {})[id]; });
    db.pendingNew = db.pendingNew.concat(fresh.filter(function (id) { return db.pendingNew.indexOf(id) < 0; }));
    db.lastNewCheck = n.iso;
    log('check: ' + Object.keys(changed).length + ' bills changed statewide (' + known.length + ' tracked), ' + fresh.length + ' new candidates');
  }
  function drainQueues(db) {
    db.queue.refetch = db.queue.refetch.filter(function (id) { return db.bills[id] && db.bills[id].tr; });
    if (db.queue.refetch.length) db.queue.refetch = refreshBills(db, db.queue.refetch, {});
    if (db.pendingNew.length && timeLeft() > 40000) {
      var added = [];
      db.pendingNew = refreshBills(db, db.pendingNew, { relevantOnly: true, onNew: function (r) { if (r.rel !== 'exclude') added.push(r); } });
      if (added.length) {
        added.forEach(function (r) { r.isNew = nyNow().day; });
        addEvent(db, { type: 'new_bills', count: added.length, bills: added.slice(0, 40).map(function (r) { return { id: r.id, p: r.p, t: r.t, sp: r.sp, sa: r.sa, rel: r.rel, u: r.u }; }) });
      }
    }
  }
  function slotFor(n) {
    var hours = inSessionWindow(n) ? [7, 12, 17] : (n.dow >= 1 && n.dow <= 5 ? [7] : []);
    return hours.indexOf(n.h) >= 0 ? n.day + '-' + n.h : null;
  }
  // Cheap check so the 5-minute timer costs almost nothing when there is nothing to do.
  function needsWork(force) {
    if (force) return true;
    var props = PropertiesService.getScriptProperties(), n = nyNow();
    if (props.getProperty('BUSY') === '1') return true;                       // backfill or queues pending
    if (props.getProperty('CODE_VERSION') !== CFG.VERSION) return true;       // first run of new code
    var slot = slotFor(n);
    if (slot && props.getProperty('LAST_SLOT') !== slot) return true;          // scheduled check due
    if (DriveApp.getFolderById(CFG.INBOX).getFiles().hasNext()) return true;   // dashboard or Claude sent something
    var wrote = Number(props.getProperty('SHEET_WRITTEN') || 0);
    if (DriveApp.getFileById(CFG.SHEET).getLastUpdated().getTime() > wrote + 60000) return true; // Sheet edited by hand
    if (sessionFor(n) !== Number(props.getProperty('SESSION') || 0)) return true;
    return false;
  }
  function ensureTimer() {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('TIMER') === '5min') return;
    ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(tr); });
    ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
    props.setProperty('TIMER', '5min');
    log('timer: now every 5 minutes (quick exit when idle)');
  }
  function tick(force) {
    START = Date.now();
    try { ensureTimer(); } catch (e) { log('timer update failed: ' + e); }
    if (!needsWork(force)) { flushLog(); return; }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) { log('tick skipped: another run is in progress'); flushLog(); return; }
    var n = nyNow(), db = loadDb(), did = [];
    try {
      rollSession(db, n);
      if (ingest(db)) did.push('inbox');
      db.party = db.party || {}; db.partyAsked = db.partyAsked || {};
      var need = {};
      Object.keys(db.bills).forEach(function (k) {
        var b = db.bills[k];
        if (!b.tr) return;
        [b].concat((b.sa || '').split(', ').filter(String).map(function (x) { return db.bills[x]; })).forEach(function (r) {
          if (r && r.sp && !/budget bill|rules committee/i.test(r.sp) && !db.party[r.sp] && !(db.partyAsked[r.sp] && db.partyAsked[r.sp] > fmt(new Date(Date.now() - 3 * 864e5), 'yyyy-MM-dd'))) need[r.sp] = { name: r.sp, chamber: cap(r.ch), district: r.dist || '' };
        });
      });
      var needList = Object.keys(need).map(function (k) { return need[k]; });
      if (needList.length) {
        needList.forEach(function (m) { db.partyAsked[m.name] = nyNow().day; });
        addEvent(db, { type: 'party_needed', members: needList });
        did.push('party');
      }
      var noHist = Object.keys(db.bills).filter(function (k) { var b = db.bills[k]; return b.tr && (!b.hist || b.dist === undefined) && db.queue.refetch.indexOf(k) < 0; });
      if (noHist.length) { db.queue.refetch = db.queue.refetch.concat(noHist); did.push('history'); }
      try { if (syncSheetTracking(db)) did.push('sheet'); } catch (e) { log('sheet sync failed: ' + e); }
      if (db.backfill && db.backfill.stage !== 'done') {
        runBackfill(db, n); did.push('backfill');
      } else {
        var slot = slotFor(n);
        if (force || (slot && db.lastSlot !== slot)) {
          regularCheck(db, n);
          if (timeLeft() > 120000) { try { checkHearings(db, false); } catch (e) { log('hearings failed: ' + e); } }
          if (inSessionWindow(n) || force) { try { checkBudget(db, n, db.session, false); } catch (e) { log('budget failed: ' + e); } }
          db.lastSlot = slot || db.lastSlot;
          db.lastCheck = n.iso;
          did.push('check');
        }
        if (db.queue.refetch.length || db.pendingNew.length) { drainQueues(db); did.push('queues'); }
      }
      if (did.length) { writeOutputs(db, n); }
      saveDb(db);
      var props = PropertiesService.getScriptProperties();
      props.setProperty('BUSY', (db.backfill && db.backfill.stage !== 'done') || db.queue.refetch.length || db.pendingNew.length ? '1' : '0');
      if (db.lastSlot) props.setProperty('LAST_SLOT', db.lastSlot);
      props.setProperty('SESSION', String(db.session));
      props.setProperty('CODE_VERSION', CFG.VERSION);
      if (did.length) props.setProperty('SHEET_WRITTEN', String(Date.now()));
    } catch (e) {
      log('ERROR ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
      db.errors.unshift({ at: n.iso, msg: String(e).slice(0, 300) });
      db.errors.length = Math.min(db.errors.length, 10);
      var today = n.day;
      if (db.lastErrorEvent !== today) { db.lastErrorEvent = today; addEvent(db, { type: 'error', detail: String(e).slice(0, 300) }); }
      try { saveDb(db); writeOutputs(db, n); } catch (x) {}
    } finally {
      if (did.length) log('tick done: ' + did.join(', ') + ' in ' + Math.round((Date.now() - START) / 1000) + 's');
      flushLog();
      lock.releaseLock();
    }
  }
  function cleanupCode() {
    var it = DriveApp.getFolderById(CFG.ROOT).getFilesByName('myla_code.js'), files = [];
    while (it.hasNext()) files.push(it.next());
    files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
    files.slice(1).forEach(function (f) { try { f.setTrashed(true); } catch (e) {} });
  }
  function setup() {
    START = Date.now();
    var ss = SpreadsheetApp.openById(CFG.SHEET);
    var st = ss.getSheetByName('Settings') || ss.insertSheet('Settings');
    if (!st.getRange('A1').getValue()) {
      st.getRange('A1:B3').setValues([['MyLA settings', ''], ['Open Legislation API key', ''], ['(Paste your key in B2, then run setup again)', '']]);
      st.getRange('A1').setFontWeight('bold');
      st.setColumnWidth(1, 260); st.setColumnWidth(2, 360);
    }
    ensureSheet(ss, 'Bills', BILL_HEADER);
    var s1 = ss.getSheetByName('Sheet1'); if (s1 && ss.getSheets().length > 1) ss.deleteSheet(s1);
    PropertiesService.getScriptProperties().deleteProperty('API_KEY');
    var key = String(st.getRange('B2').getValue()).trim();
    if (!key) {
      log('setup: waiting for API key in Settings!B2');
      flushLog();
      SpreadsheetApp.getActive() && ss.setActiveSheet(st);
      throw new Error('Paste your Open Legislation API key into the Settings tab, cell B2, then run setup again.');
    }
    // Quick key test
    var t = api('/bills/2025/S1', { view: 'info' });
    log('setup: API key works (test response keys: ' + (t ? Object.keys(t).join(',') : 'none') + '; result: ' + (t && t.result ? String(t.result.title || Object.keys(t.result).slice(0, 12).join(',')).slice(0, 80) : '?') + ')');
    ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(tr); });
    ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
    PropertiesService.getScriptProperties().setProperty('TIMER', '5min');
    log('setup: 5-minute timer created; code version ' + CFG.VERSION);
    cleanupCode();
    flushLog();
    tick(false);
  }
  return {
    setup: setup,
    tick: function () { tick(false); },
    checkNow: function () { tick(true); },
    _test: { parseHearings: parseHearings, htmlToText: htmlToText, excerptBudget: excerptBudget, classify: classify, normalize: normalize, segmentText: segmentText, voteText: voteText }
  };
})();
