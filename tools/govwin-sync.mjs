#!/usr/bin/env node
/*
 * GovWin folder → Atlas sync (Hybrid Phase 1, automated path).
 *
 * Reads index.csv + the per-agency RFP/RFI document folders, extracts text from
 * PDF/DOCX/XLSX/PPTX/TXT (and unzips ZIP bundles), and pushes only NEW or CHANGED
 * opportunities + document text to Atlas. Idempotent by GovWin id; a local state
 * file (.govwin-sync-state.json) tracks what was last pushed so re-runs send only
 * deltas. The 364 MB of binaries never leave the machine — only extracted text.
 *
 * Usage (from the repo root):
 *   node tools/govwin-sync.mjs --dry-run                 # parse + extract, no writes
 *   node tools/govwin-sync.mjs --base http://localhost:3000
 *   node tools/govwin-sync.mjs --base https://cfresourceplanner-production.up.railway.app --token $GOVWIN_INGEST_TOKEN
 *   node tools/govwin-sync.mjs --limit 5 --dry-run       # first 5 opps only (fast test)
 *
 * Flags: --folder <dir> (default: ../Govwin relative to repo), --csv <file>
 *        (default: <folder>/index.csv), --base <url>, --token <t>, --dry-run,
 *        --limit <n>, --quiet.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
// The repo's node_modules lives under OneDrive, which de-hydrates nested files
// (pdf-parse's vendored pdf.js goes missing). Point GOVWIN_DEPS at a node_modules
// OUTSIDE OneDrive (see tools/setup-govwin-sync) so extraction stays reliable.
const depsRequire = process.env.GOVWIN_DEPS ? createRequire(path.join(process.env.GOVWIN_DEPS, 'package.json')) : null;

// ---- args ----
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i > -1 && args[i + 1] ? args[i + 1] : d; };
const DRY = flag('dry-run');
const QUIET = flag('quiet');
const LIMIT = Number(opt('limit', 0)) || 0;
const BASE = opt('base', 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = opt('token', process.env.GOVWIN_INGEST_TOKEN || '');
const FOLDER = path.resolve(opt('folder', path.join(REPO, '..', 'Govwin')));
const CSV = path.resolve(opt('csv', path.join(FOLDER, 'index.csv')));
// Keep delta-state outside OneDrive (with the deps) so it isn't de-hydrated;
// falls back to tools/ for ad-hoc local runs without GOVWIN_DEPS.
const STATE_FILE = path.join(process.env.GOVWIN_DEPS || __dirname, '.govwin-sync-state.json');
const MAX_DOC_CHARS = 300000;          // cap per-file text so payloads stay sane

// pdf.js (inside pdf-parse) spams harmless "Warning: TT: undefined function"
// font notes via console — filter just those so scheduled-job logs stay clean.
const _origLog = console.log, _origWarn = console.warn;
const _noise = (a) => typeof a[0] === 'string' && /^Warning: (TT|fontkit|Indexing)/.test(a[0]);
console.log = (...a) => { if (!_noise(a)) _origLog(...a); };
console.warn = (...a) => { if (!_noise(a)) _origWarn(...a); };
const log = (...a) => { if (!QUIET) _origLog(...a); };

// Split a doc list so each POST body stays comfortably under the 10 MB limit.
function chunkBySize(docs, maxChars) {
  const out = []; let cur = [], n = 0;
  for (const d of docs) {
    const len = (d.text || '').length + 200;
    if (cur.length && n + len > maxChars) { out.push(cur); cur = []; n = 0; }
    cur.push(d); n += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---- lazy extractors (reuse the repo's deps) ----
function reqDep(name) {
  if (depsRequire) { try { return depsRequire(name); } catch (e) { /* fall through */ } }
  try { return require(name); } catch (e) { return null; }
}
const JSZip = reqDep('jszip');

async function extractText(buffer, name) {
  const lower = String(name || '').toLowerCase();
  try {
    if (lower.endsWith('.docx') || lower.endsWith('.doc')) {
      const mammoth = reqDep('mammoth'); if (!mammoth) return '';
      const r = await mammoth.extractRawText({ buffer }); return String((r && r.value) || '').trim();
    }
    if (lower.endsWith('.pdf')) {
      const pdfParse = reqDep('pdf-parse'); if (!pdfParse) return '';
      const r = await pdfParse(buffer); return String((r && r.text) || '').trim();
    }
    if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')) {
      const XLSX = reqDep('xlsx'); if (!XLSX) return '';
      const wb = XLSX.read(buffer, { type: 'buffer' }); let out = '';
      (wb.SheetNames || []).forEach((n) => { const csv = XLSX.utils.sheet_to_csv(wb.Sheets[n]) || ''; if (csv.trim()) out += '=== Sheet: ' + n + ' ===\n' + csv + '\n\n'; });
      return out.trim();
    }
    if (lower.endsWith('.pptx')) {
      // Pull slide text out of the .pptx (a zip of slideN.xml) without a dep.
      if (!JSZip) return '';
      const zip = await JSZip.loadAsync(buffer); let out = '';
      const slides = Object.keys(zip.files).filter((f) => /ppt\/slides\/slide\d+\.xml$/.test(f)).sort();
      for (const s of slides) { const xml = await zip.files[s].async('string'); const txt = xml.replace(/<a:t>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); if (txt) out += txt + '\n'; }
      return out.trim();
    }
    if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')) return buffer.toString('utf8').trim();
  } catch (e) { log('   ! extract failed for', name, '-', e.message); }
  return '';
}

// Recursively gather {name, text, sha, kind} from a file buffer, expanding ZIPs.
async function docsFromFile(absPath, displayName, kind, sink) {
  const buf = fs.readFileSync(absPath);
  const lower = displayName.toLowerCase();
  if (lower.endsWith('.zip')) {
    if (!JSZip) return;
    let zip; try { zip = await JSZip.loadAsync(buf); } catch (e) { log('   ! bad zip', displayName); return; }
    for (const entryName of Object.keys(zip.files)) {
      const entry = zip.files[entryName]; if (entry.dir) continue;
      const ebuf = await entry.async('nodebuffer');
      const text = await extractText(ebuf, entryName);
      const full = displayName + '/' + entryName;
      sink.push({ name: full, kind, sha: sha1(ebuf), chars: text.length, text: text.slice(0, MAX_DOC_CHARS) });
    }
    return;
  }
  const text = await extractText(buf, displayName);
  sink.push({ name: displayName, kind, sha: sha1(buf), chars: text.length, text: text.slice(0, MAX_DOC_CHARS) });
}

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function hashObj(o) { return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex'); }

// ---- minimal CSV parser (handles quoted fields with commas) ----
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length && r.some((c) => c !== ''));
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { opps: {}, docs: {} }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }

// Resolve an opp's on-disk folder by GovWin id prefix inside the agency dir
// (the CSV "Folder" column is title-truncated and can't be matched exactly).
function resolveFolder(agency, gid, folderCol) {
  const agencyDir = path.join(FOLDER, agency);
  if (fs.existsSync(agencyDir)) {
    try {
      const hit = fs.readdirSync(agencyDir).find((d) => new RegExp('^' + gid + '\\b').test(d) && fs.statSync(path.join(agencyDir, d)).isDirectory());
      if (hit) return path.join(agencyDir, hit);
    } catch (e) { /* ignore */ }
  }
  const byCol = path.join(FOLDER, folderCol || '');
  if (folderCol && fs.existsSync(byCol)) return byCol;
  return null;
}

async function post(url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['X-Govwin-Token'] = TOKEN;
  const res = await fetch(BASE + url, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (j.error || ''));
  return j;
}

async function main() {
  if (!fs.existsSync(CSV)) { console.error('index.csv not found at', CSV); process.exit(1); }
  log('GovWin sync' + (DRY ? ' (DRY RUN — no writes)' : '') + '\n  folder: ' + FOLDER + '\n  base:   ' + (DRY ? '(skipped)' : BASE) + '\n');
  const rows = parseCSV(fs.readFileSync(CSV, 'utf8'));
  const header = rows.shift().map((h) => h.trim());
  const idx = (n) => header.indexOf(n);
  const col = { gid: idx('GovWinID'), agency: idx('Agency'), title: idx('Title'), list: idx('List'), status: idx('Status'), sol: idx('SolicitationDate'), val: idx('EstValue'), folder: idx('Folder'), link: idx('Link') };

  const state = loadState();
  let opps = rows.map((r) => ({
    govwinId: (r[col.gid] || '').trim(), Agency: r[col.agency] || '', Title: r[col.title] || '', List: r[col.list] || '',
    Status: r[col.status] || '', SolicitationDate: r[col.sol] || '', EstValue: r[col.val] || '', Folder: r[col.folder] || '', Link: r[col.link] || '',
  })).filter((o) => o.govwinId);
  if (LIMIT) opps = opps.slice(0, LIMIT);
  log('manifest: ' + opps.length + ' opportunit' + (opps.length === 1 ? 'y' : 'ies') + (LIMIT ? ' (limited)' : ''));

  // 1) opportunity deltas
  // Fast coverage check: parse + folder resolution only, no text extraction.
  if (flag('manifest-only')) {
    let resolved = 0, missing = 0, files = 0;
    for (const o of opps) {
      const dir = resolveFolder(o.Agency, o.govwinId, o.Folder);
      if (dir) { resolved++; files += fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).length; }
      else { missing++; if (missing <= 15) log('  ⚠ no folder: ' + o.govwinId + ' — ' + o.Agency + ' / ' + o.Title.slice(0, 40)); }
    }
    log('\nmanifest-only: ' + opps.length + ' opps · ' + resolved + ' folders resolved · ' + missing + ' missing · ' + files + ' files total');
    return;
  }

  const oppPush = [];
  for (const o of opps) {
    const h = hashObj(o);
    if (state.opps[o.govwinId] !== h) { oppPush.push(o); }
  }
  log('  opps new/changed: ' + oppPush.length);
  if (oppPush.length && !DRY) {
    const r = await post('/api/govwin/ingest', { opportunities: oppPush });
    log('  → ingested:', JSON.stringify(r));
  }
  if (!DRY) oppPush.forEach((o) => { state.opps[o.govwinId] = hashObj(o); });

  // 2) document deltas (per opp)
  let totalDocs = 0, totalChanged = 0, totalChars = 0, sampleShown = false;
  for (const o of opps) {
    const dir = resolveFolder(o.Agency, o.govwinId, o.Folder);
    if (!dir) { log('  ⚠ no folder for ' + o.govwinId + ' (' + o.Agency + ')'); continue; }
    const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
    const docs = [];
    for (const f of files) {
      const kind = /solicit/i.test(f) ? 'solicitation' : /amend/i.test(f) ? 'amendment' : /rfi/i.test(f) ? 'rfi' : 'attachment';
      await docsFromFile(path.join(dir, f), f, kind, docs);
    }
    totalDocs += docs.length;
    const seen = state.docs[o.govwinId] || {};
    const changed = docs.filter((d) => seen[d.name] !== d.sha);
    totalChanged += changed.length;
    changed.forEach((d) => { totalChars += d.chars; });
    if (DRY && changed.length && !sampleShown) {
      sampleShown = true;
      const s = changed[0];
      log('\n  sample doc [' + o.govwinId + '] ' + s.name + ' (' + s.kind + ', ' + s.chars + ' chars):');
      log('    "' + s.text.slice(0, 220).replace(/\s+/g, ' ') + '…"\n');
    }
    if (changed.length && !DRY) {
      let storedN = 0;
      for (const batch of chunkBySize(changed, 8000000)) {
        const r = await post('/api/govwin/' + encodeURIComponent(o.govwinId) + '/docs', { docs: batch });
        storedN += (r.stored || 0);
      }
      log('  [' + o.govwinId + '] ' + o.Title.slice(0, 50) + ' → ' + storedN + ' doc(s)');
      state.docs[o.govwinId] = seen;
      changed.forEach((d) => { state.docs[o.govwinId][d.name] = d.sha; });
    }
  }

  log('\nsummary: ' + opps.length + ' opps · ' + totalDocs + ' docs scanned · ' + totalChanged + ' doc(s) new/changed · ' + Math.round(totalChars / 1000) + 'K chars of text' + (DRY ? ' (nothing written)' : ' pushed'));
  if (!DRY) { saveState(state); log('state saved → ' + STATE_FILE); }
}

main().catch((e) => { console.error('SYNC FAILED:', e.message); process.exit(1); });
