/* Test harness for the pure-logic blocks in index.html (shred) and server.js
   (gov pipeline). The app deliberately has no build system, so the blocks are
   extracted by their marker comments and eval'd — keep the markers intact.
   Run: npm test  (no DB, no network, no live API calls — fixtures only). */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function extract(src, startMark, endMark, label) {
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark);
  if (a < 0 || b < 0) throw new Error('marker block not found: ' + label);
  return src.slice(a, b);
}
// shred pure logic needs a DOM-free environment — it is plain JS already
eval(extract(html, 'function shredSegmentDoc', '/* ── END SHRED PURE LOGIC ── */', 'shred'));
eval(extract(srv, 'function govNorm', '/* ── END GOVOPS PURE LOGIC ── */', 'govops'));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

console.log('shred: UCF segmentation (fixture RFP)');
const rfpText = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-rfp.txt'), 'utf8');
// fixture as 3 pseudo-pages split on section boundaries to exercise page spans
const idxL = rfpText.indexOf('SECTION L —'), idxM = rfpText.indexOf('SECTION M —');
const pages = [
  { n: 3, text: rfpText.slice(0, idxL) },
  { n: 9, text: rfpText.slice(idxL, idxM) },
  { n: 14, text: rfpText.slice(idxM) },
];
const segs = shredSegmentDoc(pages);
t('detects C, L, M sections', () => {
  const keys = segs.map((s) => s.key);
  assert(keys.includes('C') && keys.includes('L') && keys.includes('M'), 'got ' + keys.join(','));
});
t('skips the table of contents (L starts on page 9, not page 3)', () => {
  const l = segs.find((s) => s.key === 'L');
  assert.strictEqual(l.pageStart, 9);
});
t('chunking embeds [PAGE n] markers and respects segment boundaries', () => {
  const l = segs.find((s) => s.key === 'L');
  const chunks = shredChunkSegment(l, 14000, 600);
  assert(chunks.length >= 1);
  assert(chunks[0].text.includes('[PAGE 9]'));
  assert(!chunks.some((c) => c.text.includes('SECTION M —')));
});
t('binding-language is present in the C segment for the extractor', () => {
  const c = segs.find((s) => s.key === 'C');
  const txt = c.pages.map((p) => p.text).join(' ');
  ['shall provide', 'must maintain', 'are required to hold', 'will provide'].forEach((kw) => assert(txt.includes(kw), 'missing: ' + kw));
});

console.log('shred: requirement IDs / orphans / page budget');
t('IDs continue from the highest existing R-number', () => {
  const out = shredAssignIds([{ text: 'a' }, { text: 'b' }], [{ id: 'R-041' }, { id: 'R-007' }]);
  assert.strictEqual(out[0].id, 'R-042');
  assert.strictEqual(out[1].id, 'R-043');
});
t('orphan detection: M factor with no L mapping; requirement no L covers', () => {
  const o = shredOrphans(
    [{ L: 'L.4.1', M: ['M.2'], C: ['R-001'] }],
    [{ ref: 'L.4.1' }],
    [{ ref: 'M.2' }, { ref: 'M.3' }],
    [{ id: 'R-001', section: 'C.2' }, { id: 'R-002', section: 'C.2' }]
  );
  assert.deepStrictEqual(o.M, ['M.3']);
  assert.deepStrictEqual(o.C, ['R-002']);
});
t('page allocation is weight-proportional and never exceeds the limit', () => {
  const v = shredAllocatePages({ pageLimit: 20, sections: [{ mRefs: [{ weight: '40' }] }, { mRefs: [{ weight: '30' }] }, { mRefs: [{ weight: '30' }] }] });
  const total = v.sections.reduce((a, s) => a + s.pages, 0);
  assert(total <= 20, 'allocated ' + total);
  assert(v.sections[0].pages >= v.sections[1].pages);
});
t('budget table flags overflow', () => {
  const b = shredPageBudget({ volumes: [{ title: 'Vol I', pageLimit: 10, sections: [{ pages: 8 }, { pages: 5 }] }] });
  assert.strictEqual(b[0].over, true);
  assert.strictEqual(b[0].allocated, 13);
});

console.log('govops: dedup / lifecycle / scoring / CSV adapters');
t('matches by solicitation number regardless of formatting', () => {
  const m = govMatch({ solnum: 'FA8771-26-R-0042', title: 'whatever', agency: 'x' }, [{ id: '1', solnum: 'fa8771 26 r 0042', title: 'other', agency: 'y' }]);
  assert(m && m.id === '1');
});
t('fuzzy-matches forecast → solicitation lifecycle (same agency + naics)', () => {
  const m = govMatch(
    { solnum: '', title: 'Enterprise Application Modernization Support Services', agency: 'Department of the Air Force', naics: '541512' },
    [{ id: '2', solnum: '', title: 'Enterprise Application Modernization and Support', agency: 'department of the air force afmc', naics: '541519' }]
  );
  assert(m && m.id === '2');
});
t('does NOT merge different procurements', () => {
  const m = govMatch(
    { solnum: '', title: 'Custodial Services Building 400', agency: 'GSA', naics: '561720' },
    [{ id: '3', solnum: '', title: 'Enterprise Application Modernization', agency: 'GSA', naics: '541512' }]
  );
  assert.strictEqual(m, null);
});
t('lifecycle never moves backwards', () => {
  assert.strictEqual(govLifecycleMax('solicitation', 'forecast'), 'solicitation');
  assert.strictEqual(govLifecycleMax('forecast', 'sources-sought'), 'sources-sought');
});
t('scoring rewards NAICS + set-aside + keywords; weights configurable', () => {
  const profile = { naics: ['541512'], setAsides: ['small business'], keywords: ['application modernization', 'cloud migration'], agencies: ['air force'] };
  const hi = govScore({ naics: '541512', set_aside: 'Total Small Business Set-Aside', title: 'Application modernization and cloud migration', description: '', agency: 'Department of the Air Force' }, profile, null);
  const lo = govScore({ naics: '722310', set_aside: '8(a)', title: 'Food services', description: '', agency: 'USDA' }, profile, null);
  assert(hi.score > 70, 'hi=' + hi.score);
  assert(lo.score < 20, 'lo=' + lo.score);
  const weighted = govScore({ naics: '541512', set_aside: '', title: '', description: '', agency: '' }, profile, { naics: 100, setAside: 0, keywords: 0, agency: 0 });
  assert.strictEqual(weighted.score, 100);
});
t('CSV adapter maps aliased headers (GSA forecast)', () => {
  const headers = ['Requirement Title', 'Organization', 'Summary of Requirement', 'NAICS Code', 'Small Business Set-Aside', 'Estimated Contract Value', 'Target Solicitation Date'];
  const row = ['Cloud Support Services', 'General Services Administration', 'Cloud ops', '541512', 'WOSB', '$1,000,000 - $5,000,000', '2026-09-01'];
  const u = govMapCsvRow('gsa-forecast', headers, row);
  assert.strictEqual(u.title, 'Cloud Support Services');
  assert.strictEqual(u.naics, '541512');
  assert.strictEqual(u.value_low, 1000000);
  assert.strictEqual(u.value_high, 5000000);
  assert.strictEqual(u.lifecycle, 'forecast');
});
t('CSV adapter returns null for rows without a title (fails per-row, not per-file)', () => {
  assert.strictEqual(govMapCsvRow('gsa-forecast', ['Requirement Title'], ['']), null);
});
t('value range parser handles $, commas, K/M', () => {
  assert.deepStrictEqual(govParseValueRange('$250K - $1.5M'), { low: 250000, high: 1500000 });
  assert.deepStrictEqual(govParseValueRange('n/a'), { low: null, high: null });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
