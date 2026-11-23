#!/usr/bin/env python3
"""MyLA transcript tool, run by the scheduled Claude check.

  python3 myla_tools.py floor   --out OUT.txt  --bills S1463,A2345  FILE [FILE...]
  python3 myla_tools.py hearing --out OUT.txt  [--picks "Name A|Name B"] [--bills S1,A2] [--all] FILE [FILE...]
  python3 myla_tools.py index   FILE          (prints the hearing's witness index as JSON)
  python3 myla_tools.py testimony --out OUT.txt --names "Name A|Name B" FILE [FILE...]   (written testimony PDFs, in order)

FILE may be a PDF (Assembly, via Granicus) or a text file (Senate, via Open Legislation).
Prints a one-line JSON status to stdout; writes the excerpt (with page markers) to --out.
"""
import json, re, subprocess, sys, argparse, unicodedata

MAX_OUT = 200_000


# ------------------------------------------------------------------ loading
def load_pages(path):
    """Return a list of (page_label, text) with line numbers stripped."""
    if path.lower().endswith('.pdf') or open(path, 'rb').read(5) == b'%PDF-':
        raw = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, check=True).stdout.decode('utf-8', 'replace')
        chunks = raw.split('\f')
        pages = []
        for i, ch in enumerate(chunks):
            if not ch.strip():
                continue
            lines = ch.split('\n')
            label = str(i + 1)
            nonblank = [l for l in lines if l.strip()]
            # footer page number alone on a line (Assembly floor), else header ending in a number
            # (hearings: "Standing Committee on X, 10-20-26   13"), never a year/date.
            foot = [l for l in nonblank[-3:] if re.match(r'^\s{15,}\d{1,4}\s*$', l)]
            head = [l for l in nonblank[:3] if re.search(r',\s*\d{1,2}-\d{1,2}-\d{2,4}\s+\d{1,4}\s*$', l)]
            if head:
                label = re.search(r'(\d{1,4})\s*$', head[0]).group(1)
            elif foot:
                label = foot[-1].strip()
            else:
                for l in nonblank[:3]:
                    m = re.search(r'\s(\d{1,4})\s*$', l)
                    if m and len(l.strip()) > 6 and not re.search(r'(19|20)\d\d\s*$|\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d', l, re.I):
                        label = m.group(1); break
            pages.append((label, clean_lines(lines)))
        return pages
    text = open(path, encoding='utf-8', errors='replace').read()
    # Senate text: page numbers on their own line (indented), lines prefixed with line numbers 1-25
    pages, cur, label = [], [], '1'
    for l in text.split('\n'):
        m = re.match(r'^\s{20,}(\d{1,5})\s*$', l)
        if m:
            if cur:
                pages.append((label, clean_lines(cur)))
            cur, label = [], m.group(1)
            continue
        cur.append(l)
    if cur:
        pages.append((label, clean_lines(cur)))
    return pages


def clean_lines(lines):
    out = []
    for l in lines:
        l = re.sub(r'^\s{0,4}\d{1,2}(\s{2,}|\s*$)', '', l.rstrip())  # transcript line numbers
        if re.match(r'^\s*NYS ASSEMBLY\s{3,}.*\d{4}\s*$', l):          # Assembly running header
            continue
        if re.match(r'^\s*\d{1,5}\s*$', l):                                # bare page numbers
            continue
        if re.match(r'^\s*.{5,80},\s*\d{1,2}-\d{1,2}-\d{2,4}\s+\d{1,4}\s*$', l):  # hearing running header
            continue
        if not l.strip():
            continue
        out.append(l.strip())
    return '\n'.join(out)


def norm(s):
    return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()


def bill_parts(b):
    m = re.match(r'^([AS])\.?\s*0*(\d+)', b.strip().upper())
    return (m.group(1), m.group(2)) if m else (None, None)


# ------------------------------------------------------------------ floor
_W = r'(?:\s|\[p\.\s*\d+\])+'   # whitespace, possibly spanning a page marker
CALL_RE = re.compile(
    r'(THE' + _W + r'CLERK:' + _W + r'(?P<ah>Assembly|Senate)' + _W + r'No\.' + _W + r'(?P<ap>[AS])0*(?P<an>\d+)(?:-?(?P<av>[A-Z]))?'
    r'|THE' + _W + r'SECRETARY:' + _W + r'Calendar' + _W + r'Number' + _W + r'\d+,?' + _W + r'(?P<sh>Senate|Assembly)' + _W + r'(?:Print|Bill)' + _W + r'(?:Number' + _W + r'|No\.\s*)?(?P<sn>\d+)(?P<sv>[A-Z]?)\b)',
    re.S)


def floor(files, bills, out):
    want = {bill_parts(b) for b in bills}
    want.discard((None, None))
    pages = []
    for f in files:
        pages += load_pages(f)
    # flatten with page markers
    flat, starts = [], []
    pos = 0
    for label, txt in pages:
        piece = '\n[p. %s]\n%s' % (label, txt)
        starts.append((pos, label))
        flat.append(piece)
        pos += len(piece)
    doc = ''.join(flat)
    calls = []
    for m in CALL_RE.finditer(doc):
        if m.group('ap'):
            key = (m.group('ap'), m.group('an'))
        else:
            key = ('S' if m.group('sh') == 'Senate' else 'A', m.group('sn'))
        calls.append((m.start(), key))
    segs = []
    for i, (st, key) in enumerate(calls):
        if key in want:
            en = calls[i + 1][0] if i + 1 < len(calls) else len(doc)
            segs.append((st, min(en, st + 200_000)))
    def page_at(p):
        lab = starts[0][1] if starts else '?'
        for s, l in starts:
            if s <= p: lab = l
            else: break
        return lab
    parts, total = [], 0
    for st, en in segs:
        body = doc[st:en]
        hdr = '=== Bill called (transcript p. %s) ===\n' % page_at(st)
        parts.append(hdr + body.strip())
        total += len(body)
    text = '\n\n'.join(parts)
    if len(text) > MAX_OUT:
        text = text[:MAX_OUT] + '\n[... excerpt cut at %d characters ...]' % MAX_OUT
    open(out, 'w').write(text)
    words = len(re.findall(r'\w+', text))
    debated = bool(re.search(r'explain (his|her|their|my) vote|SENATOR [A-Z\'-]+:|(MR|MS|MRS)\. [A-Z\'-]+:\s+(Thank|Will|Would|Mr\.|Madam)', text))
    return {'ok': True, 'segments': len(segs), 'chars': len(text), 'words': words, 'pages': len(pages),
            'bill_calls_in_transcript': len(calls), 'likely_debated': debated and words > 400}


# ------------------------------------------------------------------ hearings
def parse_index(pages):
    """Find the witness index (INDEX / LIST OF SPEAKERS) and return entries in order:
    [{'name','title','page','panel'}]. Page is the first transcript page for that witness."""
    entries, panel, seen_index = [], 0, False
    for label, txt in pages[:15]:
        if re.search(r'^\s*(INDEX|LIST OF SPEAKERS)', txt, re.M):
            seen_index = True
        if not seen_index:
            continue
        for l in txt.split('\n'):
            s = l.strip()
            if re.match(r'^(INDEX|LIST OF SPEAKERS|STATEMENT|QUESTIONS|PAGE)\b', s, re.I):
                continue
            if re.match(r'^(PANEL|-and-)', s, re.I):
                if s.upper().startswith('PANEL'):
                    panel += 1
                continue
            m = re.match(r'^(.*?\S)\s{2,}(\d{1,4})(?:\s+(\d{1,4}))?\s*$', s)
            if m and not re.search(r'\d{1,2}-\d{1,2}-\d{2}', s):
                entries.append({'name': m.group(1).strip(' .'), 'title': '', 'page': int(m.group(2)),
                                'q': int(m.group(3)) if m.group(3) else None, 'panel': panel})
            elif entries and s and len(entries[-1]['title']) < 200 and not re.search(r'\d{1,2}-\d{1,2}-\d{2}', s):
                entries[-1]['title'] = (entries[-1]['title'] + '; ' + s).strip('; ')
        if seen_index and entries and not re.search(r'\s{2,}\d{1,4}\s*$', txt.split('\n')[-1] if txt else ''):
            pass
    # keep plausible, increasing pages
    out, last = [], 0
    for e in entries:
        if e['page'] >= last:
            out.append(e); last = e['page']
    return out


def hearing(files, picks, bills, all_, out):
    pages = []
    for f in files:
        pages += load_pages(f)
    labels = [p[0] for p in pages]
    def idx_of(page_no):
        s = str(page_no)
        if s in labels: return labels.index(s)
        return min(max(page_no - 1, 0), len(pages) - 1)
    index = parse_index(pages)
    ranges, matched, unmatched = [], [], []
    if all_:
        ranges.append((0, len(pages) - 1, 'whole hearing'))
    for pk in picks:
        toks = [t for t in re.findall(r'[a-z]+', norm(pk.split(',')[0])) if len(t) > 2]
        hit = None
        for i, e in enumerate(index):
            nm = norm(e['name'])
            if toks and toks[-1] in nm and (len(toks) == 1 or toks[0] in nm):
                hit = i; break
        if hit is None:
            for i, e in enumerate(index):
                if toks and toks[-1] in norm(e['name']):
                    hit = i; break
        if hit is None:
            unmatched.append(pk); continue
        e = index[hit]
        # range: from this witness's page to the page before the next witness (in a different slot)
        a = idx_of(e['page'])
        if e['q']:
            # budget-hearing style: each witness has its own statement + questions pages
            nq = next((x['page'] for x in index[hit + 1:] if x['page'] > e['q']), None)
            b = idx_of(nq) - 1 if nq else len(pages) - 1
        elif e['panel']:
            # panel style: statements first, then questions to the whole panel -> run to next panel
            np_ = next((x['page'] for x in index[hit + 1:] if x['panel'] != e['panel']), None)
            b = idx_of(np_) - 1 if np_ else len(pages) - 1
        else:
            nxt = next((x['page'] for x in index[hit + 1:] if x['page'] > e['page']), None)
            b = idx_of(nxt) - 1 if nxt else len(pages) - 1
        ranges.append((a, max(a, b), e['name']))
        matched.append(e['name'])
    if bills:
        pats = []
        for b in bills:
            h, n = bill_parts(b)
            if not h: continue
            word = 'Assembly' if h == 'A' else 'Senate'
            pats.append(r'\b%s\.?\s*-?0*%s\b|\b%s\s+(Bill|Print)\s+(No\.?\s*)?0*%s\b' % (h, n, word, n))
        rx = re.compile('|'.join(pats), re.I) if pats else None
        hits = [i for i, (_, t) in enumerate(pages) if rx and rx.search(t)]
        for i in hits:
            ranges.append((max(0, i - 1), min(len(pages) - 1, i + 1), 'mentions ' + ','.join(bills)))
    # merge ranges
    ranges.sort()
    merged = []
    for a, b, why in ranges:
        if merged and a <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b), merged[-1][2] + ('' if why in merged[-1][2] else '; ' + why))
        else:
            merged.append((a, b, why))
    # Write the excerpt; if it is long, also split it into parts of about 150k characters at page
    # boundaries (out.part1.txt, ...) so each part can be read by its own subagent.
    chunks, cur, cur_len = [], [], 0
    for a, b, why in merged:
        cur.append('=== Pages %s-%s (%s) ===' % (pages[a][0], pages[b][0], why))
        for i in range(a, b + 1):
            piece = '[p. %s]\n%s' % pages[i]
            if cur_len + len(piece) > 150_000 and cur_len > 0:
                chunks.append('\n'.join(cur)); cur, cur_len = ['=== (continued) ==='], 0
            cur.append(piece); cur_len += len(piece)
    if cur and cur_len:
        chunks.append('\n'.join(cur))
    text = '\n\n'.join(chunks)
    open(out, 'w').write(text)
    parts = []
    if len(chunks) > 1:
        base = out[:-4] if out.endswith('.txt') else out
        for k, c in enumerate(chunks, 1):
            pth = '%s.part%d.txt' % (base, k); open(pth, 'w').write(c); parts.append(pth)
    return {'ok': True, 'pages_total': len(pages), 'ranges': [[pages[a][0], pages[b][0], w] for a, b, w in merged],
            'matched': matched, 'unmatched': unmatched, 'index_entries': len(index), 'chars': len(text), 'parts': parts}


def testimony(files, names, out):
    parts = []
    for i, f in enumerate(files):
        nm = names[i] if i < len(names) else 'Witness %d' % (i + 1)
        try:
            pages = load_pages(f)
            body = '\n'.join('[p. %s]\n%s' % p for p in pages)
        except Exception as e:
            body = '(could not read this PDF: %s)' % e
        parts.append('=== Written testimony: %s ===\n%s' % (nm, body[:120_000]))
    text = '\n\n'.join(parts)
    open(out, 'w').write(text)
    return {'ok': True, 'docs': len(files), 'chars': len(text)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['floor', 'hearing', 'index', 'testimony'])
    ap.add_argument('files', nargs='+')
    ap.add_argument('--out', default='/tmp/myla_excerpt.txt')
    ap.add_argument('--bills', default='')
    ap.add_argument('--picks', default='')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--names', default='')
    a = ap.parse_args()
    bills = [b for b in a.bills.split(',') if b.strip()]
    picks = [p.strip() for p in a.picks.split('|') if p.strip()]
    try:
        if a.cmd == 'floor':
            r = floor(a.files, bills, a.out)
        elif a.cmd == 'testimony':
            r = testimony(a.files, [n.strip() for n in a.names.split('|')], a.out)
        elif a.cmd == 'hearing':
            r = hearing(a.files, picks, bills, a.all, a.out)
        else:
            pages = []
            for f in a.files: pages += load_pages(f)
            r = {'ok': True, 'index': parse_index(pages)}
    except Exception as e:  # report, don't crash the check
        r = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
    print(json.dumps(r))


if __name__ == '__main__':
    main()
