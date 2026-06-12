const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname, {
  // HTML must always be revalidated so a deploy reaches every browser on next
  // load (no stale cached app logic). ETag/Last-Modified still allow 304s.
  setHeaders: function (res, filePath) {
    if (/\.html$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

const dbUrl = process.env.DATABASE_URL;
const useSsl = !!dbUrl && !/railway\.internal/.test(dbUrl) && !/localhost|127\.0\.0\.1/.test(dbUrl);
const pool = new Pool({
  connectionString: dbUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
  // Every accepted save archives the PREVIOUS state here, so any accidental
  // overwrite (stale tab, bad merge, user error) is recoverable. Pruned to the
  // most recent 300 snapshots.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state_history (
      id BIGSERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      data_updated_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT,
      mime TEXT,
      size INTEGER,
      data BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Gov opportunity pipeline (GovWin-style, free sources): unified records
  // from SAM.gov / forecast CSVs / USAspending enrichment. Lives OUTSIDE the
  // app_state blob — there can be thousands of records.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gov_opportunities (
      id TEXT PRIMARY KEY,
      solnum TEXT, title TEXT, agency TEXT, sub_agency TEXT, description TEXT,
      naics TEXT, psc TEXT, set_aside TEXT,
      value_low NUMERIC, value_high NUMERIC,
      est_solicitation_date TEXT, est_award_date TEXT,
      place TEXT, poc_name TEXT, poc_email TEXT,
      source TEXT, source_url TEXT, notice_type TEXT, lifecycle TEXT,
      stage TEXT DEFAULT 'identified',
      score NUMERIC DEFAULT 0, score_parts JSONB, recompete JSONB,
      timeline JSONB DEFAULT '[]', raw JSONB,
      archived BOOLEAN DEFAULT false,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_updated TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingestion_runs (
      id BIGSERIAL PRIMARY KEY,
      source TEXT, trigger_kind TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
      fetched INT DEFAULT 0, added INT DEFAULT 0, updated INT DEFAULT 0,
      errors JSONB DEFAULT '[]', digest JSONB
    )
  `);
  // RFP Shred: per-proposal requirements database, L-M-C mappings, format
  // rules, and annotated outline. One row per proposal, OUTSIDE the app_state
  // blob so hundreds of requirements never bloat the synced state.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proposal_shreds (
      proposal_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Knowledge Bank: past proposals + capability/reference docs the Proposal
  // Generator pulls from. The heavy extracted_text (and the original binary)
  // live HERE, not in the app_state JSONB blob — only lightweight metadata
  // (id, name, type, summary, tags) is mirrored into D.knowledgeBank so the
  // autosaved single-row state and backups stay small.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_docs (
      id TEXT PRIMARY KEY,
      name TEXT,
      doc_type TEXT,
      mime TEXT,
      size INTEGER,
      extracted_text TEXT,
      data BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// Extract plain text from an uploaded knowledge-bank document.
// DOCX → mammoth, PDF → pdf-parse, text/markdown → utf8. Anything else (or a
// scanned/image PDF) yields '' and the doc is still stored as a reference.
// Requires are lazy + guarded so the server still boots if a dep is missing.
async function extractDocText(buffer, mime, name) {
  const lower = String(name || '').toLowerCase();
  const m = String(mime || '').toLowerCase();
  const isDocx = /wordprocessingml/.test(m) || lower.endsWith('.docx');
  const isPdf = /pdf$/.test(m) || lower.endsWith('.pdf');
  const isXlsx = /spreadsheetml|ms-excel/.test(m) || lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls');
  const isText = /^text\//.test(m) || lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv');
  try {
    if (isDocx) {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ buffer });
      return String((r && r.value) || '').trim();
    }
    if (isPdf) {
      const pdfParse = require('pdf-parse');
      const r = await pdfParse(buffer);
      return String((r && r.text) || '').trim();
    }
    if (isXlsx) {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      let out = '';
      (wb.SheetNames || []).forEach((n) => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[n]) || '';
        if (csv.trim()) out += '=== Sheet: ' + n + ' ===\n' + csv + '\n\n';
      });
      return out.trim();
    }
    if (isText) return buffer.toString('utf8').trim();
  } catch (e) {
    console.error('extractDocText failed for ' + name + ':', e.message);
  }
  return '';
}

// Per-page text extraction for RFP shredding. PDFs get true page numbers so
// every extracted requirement can cite its source page; DOCX/XLSX/TXT fall
// back to a single pseudo-page (cited by section instead).
async function extractDocTextPaged(buffer, mime, name) {
  const lower = String(name || '').toLowerCase();
  const m = String(mime || '').toLowerCase();
  const isPdf = /pdf$/.test(m) || lower.endsWith('.pdf');
  if (isPdf) {
    try {
      const pdfParse = require('pdf-parse');
      const pages = [];
      await pdfParse(buffer, {
        pagerender: (pageData) => pageData.getTextContent().then((tc) => {
          const text = tc.items.map((i) => i.str).join(' ');
          pages.push(text);
          return text;
        }),
      });
      const total = pages.reduce((a, p) => a + p.length, 0);
      return {
        pages: pages.map((t, i) => ({ n: i + 1, text: t })),
        chars: total,
        ocrNeeded: pages.length > 0 && total / pages.length < 40,  // likely scanned
      };
    } catch (e) { console.error('paged pdf extract failed for ' + name + ':', e.message); return { pages: [], chars: 0, ocrNeeded: false, error: e.message }; }
  }
  const text = await extractDocText(buffer, mime, name);
  return { pages: text ? [{ n: 1, text }] : [], chars: text.length, ocrNeeded: false };
}

app.get('/api/data', async (req, res) => {
  try {
    const r = await pool.query('SELECT data, updated_at FROM app_state WHERE id = 1');
    // Version stamp for optimistic locking (client echoes it back on save).
    if (r.rows.length && r.rows[0].updated_at) res.setHeader('X-Atlas-Updated-At', r.rows[0].updated_at.toISOString());
    res.json(r.rows.length ? r.rows[0].data : null);
  } catch (e) {
    console.error('GET /api/data failed:', e.message);
    res.status(500).json({ error: e.message, code: e.code });
  }
});

// Guardrail: arrays of user-authored records that must never be wiped to 0 by
// a save. If the incoming payload would shrink any of these from >0 to 0, the
// save is rejected with 409. Stops a stale browser tab / botched migration
// from silently clobbering live data. The client toasts the user to refresh.
const PROTECTED_ARRAYS = [
  'departments',          // org chart
  'projects',             // projects + initiatives + opportunities + overhead
  'activities',           // COE Plan + Project Tasks
  'recruitings',          // job requisitions
  'candidates',           // candidate submissions
  'proposals',            // proposals authored
  'proposalTemplates',
  'corporateCertifications',
  'taskTemplates',
  'programs',
  'accounts',
  'knowledgeBank',        // proposal knowledge-bank metadata (text lives in knowledge_docs)
  'resumeBank',           // dedicated standalone resume uploads
];

app.post('/api/data', async (req, res) => {
  try {
    const newData = req.body || {};
    // Optional bypass for explicit reset/import flows the user knowingly chose
    const force = req.query.force === '1' || req.get('X-Atlas-Force') === '1';
    const base = req.get('X-Atlas-Base-Updated-At') || '';
    let prevRow = null;
    if (!force) {
      const existing = await pool.query('SELECT data, updated_at FROM app_state WHERE id = 1');
      prevRow = existing.rows.length ? existing.rows[0] : null;
      const oldData = existing.rows.length ? existing.rows[0].data : null;
      const curTs = existing.rows.length && existing.rows[0].updated_at ? existing.rows[0].updated_at.toISOString() : '';
      // Optimistic lock: another client saved since this one loaded → don't silently overwrite.
      if (base && curTs && base !== curTs) {
        console.warn('[lock] REJECTED save: base ' + base + ' != current ' + curTs);
        return res.status(409).json({
          conflict: true,
          error: 'Another user saved changes since you loaded this page. Reload to get their latest version, or choose to overwrite.',
          serverUpdatedAt: curTs,
        });
      }
      // A save with NO version stamp comes from an outdated tab (code from
      // before the optimistic lock) or a tab that booted offline. Accepting it
      // would overwrite the whole state with that tab's stale snapshot — the
      // root cause of "data entered hours ago disappeared". Reject as a
      // conflict; current clients reload-and-merge, old clients fail safe.
      if (!base && curTs) {
        console.warn('[lock] REJECTED save: missing base stamp (stale/outdated client)');
        return res.status(409).json({
          conflict: true,
          staleClient: true,
          error: 'This browser tab is out of date (or loaded offline). Refresh the page to get the latest version — your save was blocked to protect newer data.',
          serverUpdatedAt: curTs,
        });
      }
      if (oldData) {
        for (const key of PROTECTED_ARRAYS) {
          const oldArr = Array.isArray(oldData[key]) ? oldData[key] : null;
          const newArr = Array.isArray(newData[key]) ? newData[key] : null;
          if (oldArr && oldArr.length > 0 && newArr && newArr.length === 0) {
            console.warn(`[guardrail] REJECTED save: ${key} would shrink from ${oldArr.length} to 0`);
            return res.status(409).json({
              error: `Refused to save: '${key}' would shrink from ${oldArr.length} records to 0. This usually means a stale browser tab is overwriting live data. Refresh the page to reload from server, then try again. (Pass ?force=1 to override — destructive.)`,
              protectedKey: key,
              oldCount: oldArr.length,
              newCount: 0,
            });
          }
        }
      }
    }
    // Archive the state we're about to replace, then prune to the newest 300.
    try {
      if (force && !prevRow) {
        const ex = await pool.query('SELECT data, updated_at FROM app_state WHERE id = 1');
        prevRow = ex.rows.length ? ex.rows[0] : null;
      }
      if (prevRow) {
        await pool.query('INSERT INTO app_state_history (data, data_updated_at) VALUES ($1, $2)', [JSON.stringify(prevRow.data), prevRow.updated_at]);
        // Retention: drop >14 days; beyond the newest 150 saves keep only the
        // last save of each hour — fine-grained recent history plus two weeks
        // of hourly recovery points, without unbounded growth.
        await pool.query("DELETE FROM app_state_history WHERE archived_at < now() - interval '14 days'");
        await pool.query(`DELETE FROM app_state_history WHERE id NOT IN (SELECT id FROM app_state_history ORDER BY id DESC LIMIT 150)
          AND id NOT IN (SELECT max(id) FROM app_state_history GROUP BY date_trunc('hour', archived_at))`);
      }
    } catch (e) { console.error('history archive failed (save continues):', e.message); }
    const w = await pool.query(
      `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()
       RETURNING updated_at`,
      [JSON.stringify(newData)]
    );
    res.json({ ok: true, updatedAt: w.rows.length && w.rows[0].updated_at ? w.rows[0].updated_at.toISOString() : null });
  } catch (e) {
    console.error('POST /api/data failed:', e.message);
    res.status(500).json({ error: e.message, code: e.code });
  }
});

// ── VERSION / HISTORY ──
// bootedAt changes on every deploy — clients poll it to retire stale tabs.
const SERVER_BOOTED_AT = new Date().toISOString();
app.get('/api/version', async (req, res) => {
  try {
    const r = await pool.query('SELECT updated_at FROM app_state WHERE id = 1');
    res.json({
      bootedAt: SERVER_BOOTED_AT,
      updatedAt: r.rows.length && r.rows[0].updated_at ? r.rows[0].updated_at.toISOString() : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Snapshot index — id, when it was archived, and rough collection counts so a
// recovery point can be picked without downloading every blob.
app.get('/api/history', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, data_updated_at, archived_at, data FROM app_state_history ORDER BY id DESC LIMIT 100');
    res.json(r.rows.map((row) => {
      const d = row.data || {};
      const counts = {};
      ['departments', 'projects', 'activities', 'proposals', 'recruitings', 'candidates'].forEach((k) => { counts[k] = Array.isArray(d[k]) ? d[k].length : 0; });
      if (d.companyProfile) counts.services = Array.isArray(d.companyProfile.services) ? d.companyProfile.services.length : 0;
      return { id: row.id, dataUpdatedAt: row.data_updated_at, archivedAt: row.archived_at, counts };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full snapshot payload — restore by POSTing it back to /api/data?force=1.
app.get('/api/history/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM app_state_history WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0].data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════════════════════════════════
   GOV OPPORTUNITY PIPELINE (Module 1) — free official sources only.
   ════════════════════════════════════════════════════════════════════ */
/* ── GOVOPS PURE LOGIC (self-contained; mirrored by tests/govops.test.js) ── */
function govNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function govTitleSim(a, b) {
  const ta = new Set(govNorm(a).split(' ').filter((w) => w.length > 2));
  const tb = new Set(govNorm(b).split(' ').filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0; ta.forEach((w) => { if (tb.has(w)) inter++; });
  return inter / (ta.size + tb.size - inter);
}
// Dedup/lifecycle matching: same solicitation number wins; otherwise fuzzy
// title similarity + same agency root + NAICS overlap.
function govMatch(incoming, candidates) {
  const inSol = govNorm(incoming.solnum).replace(/ /g, '');
  if (inSol) {
    const bySol = candidates.find((c) => govNorm(c.solnum).replace(/ /g, '') === inSol);
    if (bySol) return bySol;
  }
  const agRoot = govNorm(incoming.agency).split(' ').slice(0, 3).join(' ');
  return candidates.find((c) => {
    if (agRoot && govNorm(c.agency).indexOf(agRoot.split(' ')[0]) < 0) return false;
    const nA = String(incoming.naics || '').slice(0, 4), nB = String(c.naics || '').slice(0, 4);
    if (nA && nB && nA !== nB) return false;
    return govTitleSim(incoming.title, c.title) > 0.55;
  }) || null;
}
const NOTICE_RANK = { forecast: 0, 'sources-sought': 1, special: 1, presolicitation: 2, solicitation: 3, combined: 3 };
function govLifecycleMax(a, b) { return (NOTICE_RANK[b] || 0) >= (NOTICE_RANK[a] || 0) ? b : a; }
// Fit score vs the company profile. Weights configurable via app_state
// govPipeline.settings.weights — defaults below.
function govScore(opp, profile, weights) {
  const w = Object.assign({ naics: 35, setAside: 15, keywords: 35, agency: 15 }, weights || {});
  const parts = {};
  const myNaics = (profile.naics || []).map(String);
  const oN = String(opp.naics || '');
  parts.naics = myNaics.some((n) => n === oN) ? w.naics : (myNaics.some((n) => n.slice(0, 4) === oN.slice(0, 4) && oN) ? w.naics * 0.6 : 0);
  const sa = govNorm(opp.set_aside);
  const mySa = (profile.setAsides || []).map(govNorm);
  parts.setAside = !sa || sa === 'none' ? w.setAside * 0.5 : (mySa.some((s) => s && sa.indexOf(s) > -1) ? w.setAside : 0);
  const text = govNorm((opp.title || '') + ' ' + (opp.description || ''));
  const kws = (profile.keywords || []).map(govNorm).filter(Boolean);
  const hits = kws.filter((k) => text.indexOf(k) > -1).length;
  parts.keywords = kws.length ? w.keywords * Math.min(1, hits / Math.min(kws.length, 8)) : 0;
  const ag = govNorm(opp.agency);
  parts.agency = (profile.agencies || []).map(govNorm).some((a) => a && (ag.indexOf(a) > -1 || a.indexOf(ag.split(' ')[0]) > -1)) ? w.agency : 0;
  const score = Math.round(Object.keys(parts).reduce((a, k) => a + parts[k], 0));
  return { score, parts };
}
// Forecast CSV adapters: header-alias mapping so format drift doesn't break
// ingestion. Add an agency = add an entry here (see README).
const GOV_CSV_ADAPTERS = {
  'gsa-forecast': { label: 'GSA Acquisition Gateway Forecast', aliases: { title: ['title', 'requirement title', 'project title'], agency: ['organization', 'agency', 'department'], sub_agency: ['bureau', 'sub-agency', 'contracting office'], description: ['description', 'requirement description', 'summary of requirement'], naics: ['naics', 'naics code', 'primary naics'], set_aside: ['set aside', 'set-aside', 'small business set-aside', 'competition type'], value_text: ['estimated value', 'dollar range', 'estimated contract value', 'total estimated value'], est_solicitation_date: ['estimated solicitation date', 'target solicitation date', 'solicitation date'], est_award_date: ['estimated award date', 'target award date', 'award date', 'estimated award fy-quarter'], place: ['place of performance', 'location'], poc_name: ['point of contact', 'poc', 'contact name', 'small business specialist'], poc_email: ['email', 'poc email', 'contact email'], solnum: ['solicitation number', 'listing id', 'forecast id'] } },
  'dhs-apfs': { label: 'DHS Acquisition Planning Forecast System', aliases: { title: ['title', 'requirement title'], agency: ['component', 'organization'], description: ['description', 'requirement description', 'description of requirement'], naics: ['naics', 'naics code'], set_aside: ['small business program', 'set aside', 'competition strategy'], value_text: ['dollar range', 'estimated value'], est_solicitation_date: ['estimated solicitation release date', 'estimated release date'], est_award_date: ['estimated award date', 'award quarter'], place: ['place of performance'], poc_name: ['small business specialist', 'point of contact'], poc_email: ['contact email', 'email'], solnum: ['apfs number', 'forecast number'] } },
  'epa': { label: 'EPA Acquisition Forecast', aliases: { title: ['title', 'project title', 'requirement'], agency: ['office', 'program office'], description: ['description', 'project description'], naics: ['naics', 'naics code'], set_aside: ['extent competed', 'set aside type', 'small business set-aside'], value_text: ['estimated range of cost', 'estimated value'], est_solicitation_date: ['estimated solicitation date', 'target solicitation quarter'], est_award_date: ['estimated award date'], place: ['place of performance'], poc_name: ['poc name', 'contact'], poc_email: ['poc email', 'email'], solnum: ['forecast id'] } },
  'generic': { label: 'Generic forecast CSV', aliases: { title: ['title'], agency: ['agency', 'organization'], description: ['description'], naics: ['naics'], set_aside: ['set aside', 'set-aside'], value_text: ['value', 'estimated value'], est_solicitation_date: ['solicitation date'], est_award_date: ['award date'], place: ['place'], poc_name: ['contact'], poc_email: ['email'], solnum: ['solicitation number', 'id'] } },
};
function govParseValueRange(t) {
  const nums = String(t || '').replace(/[, ]/g, '').match(/\$?([\d.]+)(k|m|b)?/gi) || [];
  const parse = (s) => { const m = /([\d.]+)(k|m|b)?/i.exec(s); if (!m) return 0; let v = parseFloat(m[1]); if (/k/i.test(m[2] || '')) v *= 1e3; if (/m/i.test(m[2] || '')) v *= 1e6; if (/b/i.test(m[2] || '')) v *= 1e9; return v; };
  const vals = nums.map(parse).filter((v) => v > 999);
  if (!vals.length) return { low: null, high: null };
  return { low: Math.min(...vals), high: Math.max(...vals) };
}
function govMapCsvRow(adapterKey, headers, row) {
  const ad = GOV_CSV_ADAPTERS[adapterKey] || GOV_CSV_ADAPTERS.generic;
  const hNorm = headers.map((h) => govNorm(h));
  const pick = (field) => {
    const aliases = ad.aliases[field] || [];
    for (const a of aliases) { const i = hNorm.findIndex((h) => h === govNorm(a) || h.indexOf(govNorm(a)) === 0); if (i > -1 && row[i] != null && String(row[i]).trim()) return String(row[i]).trim(); }
    return '';
  };
  const out = { title: pick('title'), agency: pick('agency'), sub_agency: pick('sub_agency'), description: pick('description'), naics: (pick('naics').match(/\d{6}/) || [pick('naics')])[0] || '', set_aside: pick('set_aside'), est_solicitation_date: pick('est_solicitation_date'), est_award_date: pick('est_award_date'), place: pick('place'), poc_name: pick('poc_name'), poc_email: pick('poc_email'), solnum: pick('solnum'), notice_type: 'forecast', lifecycle: 'forecast' };
  const vr = govParseValueRange(pick('value_text'));
  out.value_low = vr.low; out.value_high = vr.high;
  return out.title ? out : null;
}
/* ── END GOVOPS PURE LOGIC ── */

// Retry/backoff wrapper for government APIs — polite UA, never hammers.
async function govFetch(url, opts, tries) {
  tries = tries == null ? 3 : tries;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, Object.assign({ headers: Object.assign({ 'User-Agent': 'Atlas-ResourcePlanner/1.0 (CommunityForce; contact: idris.grant@communityforce.com)' }, (opts && opts.headers) || {}) }, opts || {}));
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      if (attempt >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(3, attempt)));
    }
  }
}
async function govProfile() {
  const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
  const d = r.rows.length ? r.rows[0].data : {};
  const cp = (d && d.companyProfile) || {};
  const ident = cp.identity || {};
  const keywords = [];
  (cp.services || []).forEach((s) => { if (s.name) keywords.push(s.name); (s.differentiators || []).slice(0, 2).forEach((x) => keywords.push(x)); });
  (cp.differentiators || []).forEach((x) => keywords.push(x));
  const agencies = [];
  ((d && d.projects) || []).forEach((p) => { if (p.customer && agencies.indexOf(p.customer) < 0) agencies.push(p.customer); });
  ((d && d.pastClients) || []).forEach((c) => { const n = typeof c === 'string' ? c : (c && c.name); if (n && agencies.indexOf(n) < 0) agencies.push(n); });
  const gp = (d && d.govPipeline) || {};
  return {
    naics: ident.naics || [],
    setAsides: [ident.ownershipType || 'Small Business'].concat((gp.settings && gp.settings.setAsides) || []),
    keywords: ((gp.settings && gp.settings.keywords) || []).concat(keywords).slice(0, 40),
    agencies: agencies.slice(0, 40),
    weights: (gp.settings && gp.settings.weights) || null,
    searches: gp.searches || [],
    samApiKey: (gp.settings && gp.settings.samApiKey) || '',
  };
}
async function govUpsert(unified, profile, stats) {
  if (!unified || !unified.title) return;
  const cand = await pool.query(
    `SELECT id, solnum, title, agency, naics, lifecycle, timeline FROM gov_opportunities
     WHERE archived = false AND (solnum = $1 OR left(coalesce(naics,''),4) = left($2,4) OR $2 = '') LIMIT 400`,
    [unified.solnum || '', String(unified.naics || '')]
  );
  const match = govMatch(unified, cand.rows);
  const sc = govScore(unified, profile, profile.weights);
  const tlEntry = { source: unified.source, notice_type: unified.notice_type, url: unified.source_url || '', at: new Date().toISOString(), title: unified.title };
  if (match) {
    const lifecycle = govLifecycleMax(match.lifecycle || 'forecast', unified.lifecycle || 'forecast');
    const timeline = (match.timeline || []).concat([tlEntry]).slice(-25);
    await pool.query(
      `UPDATE gov_opportunities SET title=coalesce(nullif($2,''),title), agency=coalesce(nullif($3,''),agency), sub_agency=coalesce(nullif($4,''),sub_agency),
        description=CASE WHEN length(coalesce($5,''))>length(coalesce(description,'')) THEN $5 ELSE description END,
        naics=coalesce(nullif($6,''),naics), psc=coalesce(nullif($7,''),psc), set_aside=coalesce(nullif($8,''),set_aside),
        value_low=coalesce($9,value_low), value_high=coalesce($10,value_high),
        est_solicitation_date=coalesce(nullif($11,''),est_solicitation_date), est_award_date=coalesce(nullif($12,''),est_award_date),
        place=coalesce(nullif($13,''),place), poc_name=coalesce(nullif($14,''),poc_name), poc_email=coalesce(nullif($15,''),poc_email),
        source_url=coalesce(nullif($16,''),source_url), notice_type=$17, lifecycle=$18, solnum=coalesce(nullif($19,''),solnum),
        score=$20, score_parts=$21, timeline=$22, raw=$23, last_updated=now()
       WHERE id=$1`,
      [match.id, unified.title || '', unified.agency || '', unified.sub_agency || '', unified.description || '', String(unified.naics || ''), unified.psc || '', unified.set_aside || '', unified.value_low, unified.value_high, unified.est_solicitation_date || '', unified.est_award_date || '', unified.place || '', unified.poc_name || '', unified.poc_email || '', unified.source_url || '', unified.notice_type || '', lifecycle, unified.solnum || '', sc.score, JSON.stringify(sc.parts), JSON.stringify(timeline), JSON.stringify(unified.raw || {})]
    );
    stats.updated++;
  } else {
    const id = 'gov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO gov_opportunities (id, solnum, title, agency, sub_agency, description, naics, psc, set_aside, value_low, value_high,
        est_solicitation_date, est_award_date, place, poc_name, poc_email, source, source_url, notice_type, lifecycle, score, score_parts, timeline, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [id, unified.solnum || '', unified.title, unified.agency || '', unified.sub_agency || '', unified.description || '', String(unified.naics || ''), unified.psc || '', unified.set_aside || '', unified.value_low, unified.value_high, unified.est_solicitation_date || '', unified.est_award_date || '', unified.place || '', unified.poc_name || '', unified.poc_email || '', unified.source || 'unknown', unified.source_url || '', unified.notice_type || '', unified.lifecycle || 'forecast', sc.score, JSON.stringify(sc.parts), JSON.stringify([tlEntry]), JSON.stringify(unified.raw || {})]
    );
    stats.added++;
  }
}
const SAM_PTYPE = { p: 'presolicitation', r: 'sources-sought', s: 'special', o: 'solicitation', k: 'combined' };
async function samIngest(profile, stats, errors) {
  // Env var wins; otherwise the org-wide key saved in Admin → Integrations.
  const key = process.env.SAM_GOV_API_KEY || profile.samApiKey;
  if (!key) { errors.push({ source: 'sam.gov', error: 'No SAM.gov API key — source skipped. Add one in Admin → Integrations → Data Sources (free key: sam.gov → Workspace → Account Details → Public API Key).' }); return; }
  const fmt = (dt) => String(dt.getMonth() + 1).padStart(2, '0') + '/' + String(dt.getDate()).padStart(2, '0') + '/' + dt.getFullYear();
  const to = new Date(); const from = new Date(Date.now() - 60 * 86400000);
  const naicsList = (profile.naics || []).slice(0, 6);
  if (!naicsList.length) naicsList.push('');
  for (const naics of naicsList) {
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const url = 'https://api.sam.gov/opportunities/v2/search?api_key=' + encodeURIComponent(key)
        + '&postedFrom=' + encodeURIComponent(fmt(from)) + '&postedTo=' + encodeURIComponent(fmt(to))
        + '&ptype=p,r,s,o,k&limit=200&offset=' + offset + (naics ? '&ncode=' + encodeURIComponent(naics) : '');
      try {
        const res = await govFetch(url, {}, 3);
        if (!res.ok) { errors.push({ source: 'sam.gov', error: 'HTTP ' + res.status }); break; }
        const j = await res.json();
        const list = (j && j.opportunitiesData) || [];
        stats.fetched += list.length;
        for (const o of list) {
          const ptype = String(o.type || '').toLowerCase();
          const lifecycle = SAM_PTYPE[(o.baseType || '').toLowerCase().slice(0, 1)] || (/solicitation/.test(ptype) ? 'solicitation' : /sources/.test(ptype) ? 'sources-sought' : /presol/.test(ptype) ? 'presolicitation' : 'special');
          await govUpsert({
            solnum: o.solicitationNumber || '', title: o.title || '', agency: o.department || o.fullParentPathName || '', sub_agency: o.subTier || o.office || '',
            description: (o.description && String(o.description).slice(0, 4000)) || '', naics: o.naicsCode || '', psc: o.classificationCode || '',
            set_aside: o.typeOfSetAsideDescription || o.typeOfSetAside || '', value_low: null, value_high: null,
            est_solicitation_date: o.postedDate || '', est_award_date: '', place: (o.placeOfPerformance && (o.placeOfPerformance.city && o.placeOfPerformance.city.name || '') + ' ' + (o.placeOfPerformance.state && o.placeOfPerformance.state.code || '')) || '',
            poc_name: (o.pointOfContact && o.pointOfContact[0] && o.pointOfContact[0].fullName) || '', poc_email: (o.pointOfContact && o.pointOfContact[0] && o.pointOfContact[0].email) || '',
            source: 'sam.gov', source_url: o.uiLink || '', notice_type: lifecycle, lifecycle, raw: o,
          }, profile, stats);
        }
        if (list.length < 200) break;
        offset += 200;
        await new Promise((r) => setTimeout(r, 1200)); // polite pacing
      } catch (e) { errors.push({ source: 'sam.gov', error: e.message }); break; }
    }
  }
}
// USAspending enrichment: expiring contracts (12–18 months out) matching
// agency + NAICS + similar description → recompete flags on opportunities.
async function usaspendingRecompete(profile, stats, errors) {
  const naicsList = (profile.naics || []).slice(0, 6);
  if (!naicsList.length) return;
  const opps = await pool.query("SELECT id, title, agency, naics, description FROM gov_opportunities WHERE archived = false");
  for (const naics of naicsList) {
    try {
      const body = {
        filters: { naics_codes: [naics], award_type_codes: ['A', 'B', 'C', 'D'], time_period: [{ start_date: new Date(Date.now() - 5 * 365 * 86400000).toISOString().slice(0, 10), end_date: new Date().toISOString().slice(0, 10) }] },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Awarding Sub Agency', 'End Date', 'Description'],
        sort: 'End Date', order: 'desc', limit: 100, page: 1,
      };
      const res = await govFetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 3);
      if (!res.ok) { errors.push({ source: 'usaspending', error: 'HTTP ' + res.status }); continue; }
      const j = await res.json();
      const now = Date.now(), lo = now, hi = now + 18 * 30 * 86400000;
      const expiring = ((j && j.results) || []).filter((a) => { const t = Date.parse(a['End Date']); return t && t >= lo && t <= hi; });
      stats.fetched += expiring.length;
      for (const a of expiring) {
        const matches = opps.rows.filter((o) => String(o.naics || '').slice(0, 4) === naics.slice(0, 4)
          && (govTitleSim(o.title + ' ' + (o.description || '').slice(0, 300), a.Description || '') > 0.18
            || govNorm(o.agency).indexOf(govNorm(a['Awarding Agency']).split(' ')[0]) > -1));
        for (const o of matches) {
          await pool.query('UPDATE gov_opportunities SET recompete = $2, last_updated = now() WHERE id = $1',
            [o.id, JSON.stringify({ incumbent: a['Recipient Name'] || '', value: a['Award Amount'] || 0, endDate: a['End Date'] || '', awardId: a['Award ID'] || '', flaggedAt: new Date().toISOString() })]);
          stats.updated++;
        }
      }
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) { errors.push({ source: 'usaspending', error: e.message }); }
  }
}
async function govRunIngestion(triggerKind) {
  const run = await pool.query('INSERT INTO ingestion_runs (source, trigger_kind) VALUES ($1,$2) RETURNING id', ['daily', triggerKind]);
  const runId = run.rows[0].id;
  const stats = { fetched: 0, added: 0, updated: 0 };
  const errors = [];
  try {
    const profile = await govProfile();
    const before = await pool.query("SELECT id FROM gov_opportunities");
    await samIngest(profile, stats, errors);
    await usaspendingRecompete(profile, stats, errors);
    // digest per saved search: new + updated since this run started
    const digest = [];
    for (const s of (profile.searches || [])) {
      const f = s.filters || {};
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM gov_opportunities WHERE archived=false AND last_updated >= (SELECT started_at FROM ingestion_runs WHERE id=$1)
          AND ($2='' OR agency ILIKE '%'||$2||'%') AND ($3='' OR naics LIKE $3||'%') AND ($4='' OR set_aside ILIKE '%'||$4||'%')
          AND ($5='' OR title ILIKE '%'||$5||'%' OR description ILIKE '%'||$5||'%')`,
        [runId, f.agency || '', f.naics || '', f.setAside || '', f.q || '']
      );
      digest.push({ searchId: s.id, name: s.name, hits: r.rows[0].n });
    }
    await pool.query('UPDATE ingestion_runs SET finished_at=now(), fetched=$2, added=$3, updated=$4, errors=$5, digest=$6 WHERE id=$1',
      [runId, stats.fetched, stats.added, stats.updated, JSON.stringify(errors), JSON.stringify(digest)]);
    return { runId, ...stats, errors, digest };
  } catch (e) {
    errors.push({ source: 'run', error: e.message });
    await pool.query('UPDATE ingestion_runs SET finished_at=now(), fetched=$2, added=$3, updated=$4, errors=$5 WHERE id=$1',
      [runId, stats.fetched, stats.added, stats.updated, JSON.stringify(errors)]);
    return { runId, ...stats, errors };
  }
}
// Daily scheduler: checked every 2h; runs if the last auto run is >22h old.
setInterval(async () => {
  try {
    const r = await pool.query("SELECT max(started_at) AS last FROM ingestion_runs WHERE trigger_kind = 'auto'");
    const last = r.rows[0].last ? new Date(r.rows[0].last).getTime() : 0;
    if (Date.now() - last > 22 * 3600000) { console.log('[govops] starting scheduled ingestion'); await govRunIngestion('auto'); }
  } catch (e) { console.error('[govops] scheduler error:', e.message); }
}, 2 * 3600000);

app.get('/api/govops', async (req, res) => {
  try {
    const q = req.query;
    const r = await pool.query(
      `SELECT id, solnum, title, agency, sub_agency, naics, psc, set_aside, value_low, value_high, est_solicitation_date, est_award_date,
              place, poc_name, poc_email, source, source_url, notice_type, lifecycle, stage, score, score_parts, recompete, timeline,
              left(coalesce(description,''), 600) AS description, first_seen, last_updated
       FROM gov_opportunities
       WHERE archived = ($1='1') AND ($2='' OR title ILIKE '%'||$2||'%' OR description ILIKE '%'||$2||'%' OR solnum ILIKE '%'||$2||'%')
         AND ($3='' OR agency ILIKE '%'||$3||'%') AND ($4='' OR naics LIKE $4||'%') AND ($5='' OR set_aside ILIKE '%'||$5||'%')
         AND ($6='' OR lifecycle=$6) AND ($7='' OR stage=$7) AND ($8='' OR recompete IS NOT NULL)
       ORDER BY score DESC, last_updated DESC LIMIT $9 OFFSET $10`,
      [q.archived || '', q.q || '', q.agency || '', q.naics || '', q.setAside || '', q.lifecycle || '', q.stage || '', q.recompete || '', Math.min(Number(q.limit) || 100, 300), Number(q.offset) || 0]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/govops/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = []; const vals = [req.params.id]; let i = 1;
    if (b.stage !== undefined) { sets.push('stage=$' + (++i)); vals.push(String(b.stage)); }
    if (b.archived !== undefined) { sets.push('archived=$' + (++i)); vals.push(!!b.archived); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    await pool.query('UPDATE gov_opportunities SET ' + sets.join(',') + ', last_updated=now() WHERE id=$1', vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/govops/ingest', async (req, res) => {
  try { res.json(await govRunIngestion('manual')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Forecast CSV/XLSX import (GSA Acquisition Gateway, DHS APFS, EPA, generic).
app.post('/api/govops/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const adapterKey = req.body.source || 'generic';
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (rows.length < 2) return res.status(400).json({ error: 'No data rows found' });
    const headers = rows[0].map(String);
    const profile = await govProfile();
    const stats = { fetched: 0, added: 0, updated: 0 };
    const errors = [];
    for (const row of rows.slice(1)) {
      try {
        const u = govMapCsvRow(adapterKey, headers, row);
        if (!u) continue;
        u.source = adapterKey; u.raw = { headers, row };
        stats.fetched++;
        await govUpsert(u, profile, stats);
      } catch (e) { errors.push({ row: stats.fetched, error: e.message }); }
    }
    await pool.query('INSERT INTO ingestion_runs (source, trigger_kind, finished_at, fetched, added, updated, errors) VALUES ($1,$2,now(),$3,$4,$5,$6)',
      [adapterKey, 'import', stats.fetched, stats.added, stats.updated, JSON.stringify(errors)]);
    res.json({ ...stats, errors: errors.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/govops/runs', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, source, trigger_kind, started_at, finished_at, fetched, added, updated, errors, digest FROM ingestion_runs ORDER BY id DESC LIMIT 40');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FILE ATTACHMENTS ──
app.post('/api/attachments', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      'INSERT INTO attachments (id, project_id, name, mime, size, data) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, req.body.projectId || null, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer]
    );
    res.json({ id, name: req.file.originalname, mime: req.file.mimetype, size: req.file.size, url: '/api/attachments/' + id });
  } catch (e) {
    console.error('Upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attachments/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT name, mime, data FROM attachments WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).send('Not found');
    const row = r.rows[0];
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(row.name || 'file').replace(/[\r\n"]/g, '') + '"');
    res.send(row.data);
  } catch (e) {
    console.error('Download failed:', e.message);
    res.status(500).send('error');
  }
});

app.delete('/api/attachments/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM attachments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── RFP SHRED ──
// Upload a solicitation/amendment/attachment: store the binary (downloadable
// like any attachment) and return per-page text for the client-side shred.
app.post('/api/shred-doc', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      'INSERT INTO attachments (id, project_id, name, mime, size, data) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, req.body.proposalId || null, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer]
    );
    const ex = await extractDocTextPaged(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({ attachmentId: id, name: req.file.originalname, mime: req.file.mimetype, size: req.file.size, chars: ex.chars, ocrNeeded: !!ex.ocrNeeded, pages: ex.pages });
  } catch (e) {
    console.error('shred-doc upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/shred/:proposalId', async (req, res) => {
  try {
    const r = await pool.query('SELECT data, updated_at FROM proposal_shreds WHERE proposal_id = $1', [req.params.proposalId]);
    if (!r.rows.length) return res.json(null);
    res.json(r.rows[0].data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/shred/:proposalId', async (req, res) => {
  try {
    const data = req.body || {};
    await pool.query(
      `INSERT INTO proposal_shreds (proposal_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (proposal_id) DO UPDATE SET data = $2, updated_at = now()`,
      [req.params.proposalId, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Compliance matrix XLSX: one row per active requirement with citation,
// assignment, owner, and drafting status.
app.get('/api/shred/:proposalId/compliance.xlsx', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM proposal_shreds WHERE proposal_id = $1', [req.params.proposalId]);
    if (!r.rows.length) return res.status(404).send('No shred for this proposal');
    const d = r.rows[0].data || {};
    const XLSX = require('xlsx');
    const rows = (d.requirements || []).filter((q) => q.status !== 'deleted').map((q) => ({
      'Req ID': q.id,
      'Requirement': q.text,
      'Type': q.type || '',
      'Volume': q.volume || '',
      'Source Doc': q.doc || '',
      'Section': q.section || '',
      'Page': q.page || '',
      'L Refs': (q.refs && q.refs.L || []).join(', '),
      'M Refs': (q.refs && q.refs.M || []).join(', '),
      'Proposal Section': q.sectionTitle || '',
      'Owner': q.owner || '',
      'Status': q.compliance || 'not-started',
      'Confidence': q.confidence || '',
      'Notes': q.notes || '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Compliance Matrix');
    const fr = (d.formatRules || {});
    const frRows = Object.keys(fr).map((k) => ({ Rule: k, Value: typeof fr[k] === 'object' ? JSON.stringify(fr[k]) : String(fr[k] || '') }));
    if (frRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(frRows), 'Format Rules');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="compliance-matrix.xlsx"');
    res.send(buf);
  } catch (e) {
    console.error('compliance export failed:', e.message);
    res.status(500).send('export failed');
  }
});

// Annotated outline DOCX: Section-L-mirrored headings, each followed by an
// italicized annotation block (L ref, M factors/weights, requirement IDs,
// page allocation, win-theme slots, writer).
app.get('/api/shred/:proposalId/outline.docx', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM proposal_shreds WHERE proposal_id = $1', [req.params.proposalId]);
    const d = r.rows.length ? (r.rows[0].data || {}) : {};
    const o = d.outline;
    if (!o || !Array.isArray(o.volumes) || !o.volumes.length) return res.status(404).send('No outline generated yet');
    const docx = require('docx');
    const children = [new docx.Paragraph({ text: 'Annotated Proposal Outline', heading: docx.HeadingLevel.TITLE })];
    o.volumes.forEach((v) => {
      children.push(new docx.Paragraph({ text: (v.title || 'Volume') + (v.pageLimit ? '  —  page limit: ' + v.pageLimit : ''), heading: docx.HeadingLevel.HEADING_1 }));
      (v.sections || []).forEach((s) => {
        children.push(new docx.Paragraph({ text: (s.number ? s.number + '  ' : '') + (s.title || ''), heading: docx.HeadingLevel.HEADING_2 }));
        const ann = [
          s.lRef ? 'Satisfies: ' + s.lRef : '',
          (s.mRefs || []).length ? 'Evaluated under: ' + s.mRefs.map((m) => (m.factor || m) + (m.weight ? ' (' + m.weight + ')' : '')).join('; ') : '',
          (s.reqIds || []).length ? 'Must address: ' + s.reqIds.join(', ') : '',
          s.pages ? 'Page allocation: ' + s.pages + ' pp' : '',
          'Win themes / discriminators / proof points: [                ]',
          'Writer: ' + (s.writer || '[unassigned]'),
        ].filter(Boolean).join('   •   ');
        children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: ann, italics: true, size: 18, color: '666666' })] }));
      });
    });
    const doc = new docx.Document({ sections: [{ children }] });
    const buf = await docx.Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="annotated-outline.docx"');
    res.send(buf);
  } catch (e) {
    console.error('outline export failed:', e.message);
    res.status(500).send('export failed');
  }
});

// ── KNOWLEDGE BANK ──
// Upload a document (PDF/DOCX/TXT) → store binary + extracted text. Returns the
// extracted text so the client can run its AI summary/tag pass and mirror
// lightweight metadata into D.knowledgeBank.
app.post('/api/knowledge', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const id = 'kb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const text = await extractDocText(req.file.buffer, req.file.mimetype, req.file.originalname);
    await pool.query(
      'INSERT INTO knowledge_docs (id, name, doc_type, mime, size, extracted_text, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, req.file.originalname, req.body.docType || 'other', req.file.mimetype, req.file.size, text, req.file.buffer]
    );
    res.json({ id, name: req.file.originalname, mime: req.file.mimetype, size: req.file.size, chars: text.length, text: text.slice(0, 200000) });
  } catch (e) {
    console.error('KB upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Add a knowledge-bank entry from pasted text (no file).
app.post('/api/knowledge/text', async (req, res) => {
  try {
    const { name, docType, text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const id = 'kb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      'INSERT INTO knowledge_docs (id, name, doc_type, mime, size, extracted_text, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, name || 'Pasted note', docType || 'other', 'text/plain', Buffer.byteLength(text, 'utf8'), text, null]
    );
    res.json({ id, name: name || 'Pasted note', chars: String(text).length });
  } catch (e) {
    console.error('KB text add failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// List knowledge-bank metadata (no text body) — for reconciliation/debug.
app.get('/api/knowledge', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, doc_type, mime, size, length(extracted_text) AS chars, created_at FROM knowledge_docs ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch one document's full extracted text (used at generation time).
app.get('/api/knowledge/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, doc_type, mime, size, extracted_text, created_at FROM knowledge_docs WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download/preview the original binary.
app.get('/api/knowledge/:id/raw', async (req, res) => {
  try {
    const r = await pool.query('SELECT name, mime, data FROM knowledge_docs WHERE id = $1', [req.params.id]);
    if (!r.rows.length || !r.rows[0].data) return res.status(404).send('Not found');
    const row = r.rows[0];
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(row.name || 'file').replace(/[\r\n"]/g, '') + '"');
    res.send(row.data);
  } catch (e) {
    res.status(500).send('error');
  }
});

app.delete('/api/knowledge/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM knowledge_docs WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LLM PROXY (multi-provider: Anthropic, OpenAI, Google Gemini) ──
// Resolves the API key for a request from (1) the calling user's per-provider
// override, falling back to (2) the org-wide env var. Normalizes the response
// shape across providers so the client always sees Anthropic-style
// {content:[{type:'text',text}], usage, model, provider}.

const LLM_PROVIDERS = {
  anthropic: {
    label: 'Anthropic Claude',
    envVar: 'ANTHROPIC_API_KEY',
    accountKey: 'apiKey',          // existing field — kept for backward compat
    defaultModel: 'claude-sonnet-4-5',
    supportsPdf: true,
  },
  openai: {
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    accountKey: 'apiKey_openai',
    defaultModel: 'gpt-4o',
    supportsPdf: false,            // requires Files API + assistant endpoint; not v1
  },
  google: {
    label: 'Google Gemini',
    envVar: 'GOOGLE_API_KEY',
    accountKey: 'apiKey_google',
    defaultModel: 'gemini-2.0-flash-exp',
    supportsPdf: true,             // supports inline_data PDFs
  },
};

async function resolveApiKey(providerKey, accountId) {
  const cfg = LLM_PROVIDERS[providerKey];
  if (!cfg) throw new Error('Unknown provider: ' + providerKey);
  let key = process.env[cfg.envVar] || '';
  if (accountId) {
    const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
    const data = r.rows[0] && r.rows[0].data;
    const acc = data && Array.isArray(data.accounts) && data.accounts.find((a) => a.id === accountId);
    if (acc && acc[cfg.accountKey]) key = acc[cfg.accountKey];
  }
  return key;
}

// Provider-specific calls. Each returns a normalized
// {content:[{type:'text',text}], usage, model, provider} shape.

async function callAnthropic({ apiKey, model, system, messages, max_tokens }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: model || LLM_PROVIDERS.anthropic.defaultModel,
      max_tokens: max_tokens || 4096,
      system: system || '',
      messages,
    }),
  });
  const json = await resp.json();
  if (!resp.ok) { const err = new Error(json.error?.message || ('HTTP ' + resp.status)); err.status = resp.status; err.body = json; throw err; }
  // Anthropic already returns {content:[{type:'text',text}]}
  json.provider = 'anthropic';
  return json;
}

async function callOpenAI({ apiKey, model, system, messages, max_tokens }) {
  // Convert Anthropic-shaped messages to OpenAI chat format.
  const oaiMessages = [];
  if (system) oaiMessages.push({ role: 'system', content: system });
  for (const m of messages) {
    let content = m.content;
    if (Array.isArray(content)) content = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    oaiMessages.push({ role: m.role, content });
  }
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: model || LLM_PROVIDERS.openai.defaultModel,
      messages: oaiMessages,
      max_tokens: max_tokens || 4096,
    }),
  });
  const json = await resp.json();
  if (!resp.ok) { const err = new Error(json.error?.message || ('HTTP ' + resp.status)); err.status = resp.status; err.body = json; throw err; }
  const text = json.choices?.[0]?.message?.content || '';
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: json.usage?.prompt_tokens, output_tokens: json.usage?.completion_tokens },
    model: json.model,
    provider: 'openai',
    stop_reason: json.choices?.[0]?.finish_reason,
  };
}

async function callGoogle({ apiKey, model, system, messages, max_tokens, fileBase64, fileMime }) {
  const m = model || LLM_PROVIDERS.google.defaultModel;
  const body = {
    contents: messages.map((msg) => {
      const parts = [];
      // PDF/file goes inline before text
      if (fileBase64 && msg === messages[messages.length - 1]) {
        parts.push({ inline_data: { mime_type: fileMime || 'application/pdf', data: fileBase64 } });
      }
      const text = Array.isArray(msg.content)
        ? msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
        : msg.content;
      if (text) parts.push({ text });
      return { role: msg.role === 'assistant' ? 'model' : msg.role, parts };
    }),
    generationConfig: { maxOutputTokens: max_tokens || 4096 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) { const err = new Error(json.error?.message || ('HTTP ' + resp.status)); err.status = resp.status; err.body = json; throw err; }
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: json.usageMetadata?.promptTokenCount, output_tokens: json.usageMetadata?.candidatesTokenCount },
    model: m,
    provider: 'google',
    stop_reason: json.candidates?.[0]?.finishReason,
  };
}

app.get('/api/llm/providers', (req, res) => {
  const out = {};
  for (const [k, cfg] of Object.entries(LLM_PROVIDERS)) {
    out[k] = {
      label: cfg.label,
      orgKeyConfigured: !!process.env[cfg.envVar],
      envVar: cfg.envVar,
      defaultModel: cfg.defaultModel,
      supportsPdf: cfg.supportsPdf,
    };
  }
  res.json(out);
});

// Backward-compat: keep /api/llm/status returning the Anthropic status.
app.get('/api/llm/status', (req, res) => {
  res.json({ orgKeyConfigured: !!process.env.ANTHROPIC_API_KEY });
});

app.post('/api/llm/complete', async (req, res) => {
  try {
    const { accountId, provider, system: systemPrompt, messages, model, max_tokens } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
    const prov = (provider || 'anthropic').toLowerCase();
    if (!LLM_PROVIDERS[prov]) return res.status(400).json({ error: 'Unknown provider: ' + prov });
    const apiKey = await resolveApiKey(prov, accountId);
    if (!apiKey) return res.status(400).json({ error: `No ${LLM_PROVIDERS[prov].label} API key configured. Set ${LLM_PROVIDERS[prov].envVar} env var or your personal override in Admin → Integrations.` });
    const params = { apiKey, model, system: systemPrompt, messages, max_tokens };
    let json;
    if (prov === 'openai') json = await callOpenAI(params);
    else if (prov === 'google') json = await callGoogle(params);
    else json = await callAnthropic(params);
    res.json(json);
  } catch (e) {
    console.error('LLM completion failed:', e.message);
    res.status(e.status || 500).json(e.body || { error: e.message });
  }
});

// LLM with attachment (e.g. resume PDF as a document content block).
// Currently anthropic + google (both support inline PDF); openai requires the
// Files API + assistant endpoint, so it falls back to text-only with a note.
app.post('/api/llm/with-attachment', async (req, res) => {
  try {
    const { accountId, provider, attachmentId, system: systemPrompt, instruction, model, max_tokens } = req.body || {};
    if (!attachmentId) return res.status(400).json({ error: 'attachmentId required' });
    if (!instruction) return res.status(400).json({ error: 'instruction required' });
    const prov = (provider || 'anthropic').toLowerCase();
    if (!LLM_PROVIDERS[prov]) return res.status(400).json({ error: 'Unknown provider: ' + prov });
    const apiKey = await resolveApiKey(prov, accountId);
    if (!apiKey) return res.status(400).json({ error: `No ${LLM_PROVIDERS[prov].label} API key configured. See Admin → Integrations.` });
    const ar = await pool.query('SELECT name, mime, data FROM attachments WHERE id = $1', [attachmentId]);
    if (!ar.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const att = ar.rows[0];
    const mime = att.mime || 'application/octet-stream';
    const isPdf = /pdf$/i.test(mime) || /\.pdf$/i.test(att.name || '');
    const fileBase64 = Buffer.from(att.data).toString('base64');
    // Non-PDF documents (DOCX/XLSX/TXT/CSV/MD): no provider accepts the binary
    // through this proxy, so extract the text server-side and inline it.
    let docBlock = '';
    if (!isPdf) {
      const docText = await extractDocText(att.data, mime, att.name);
      docBlock = docText
        ? `Extracted text of the attached document "${att.name}":\n"""\n${docText.slice(0, 150000)}\n"""`
        : `[Attachment "${att.name}" is type ${mime}; no text could be extracted from it. Proceed using only the instruction below.]`;
    }
    let json;
    if (prov === 'anthropic') {
      const userContent = [];
      if (isPdf) userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } });
      else userContent.push({ type: 'text', text: docBlock });
      userContent.push({ type: 'text', text: instruction });
      json = await callAnthropic({ apiKey, model, system: systemPrompt, max_tokens, messages: [{ role: 'user', content: userContent }] });
    } else if (prov === 'google') {
      json = await callGoogle({
        apiKey, model, system: systemPrompt, max_tokens,
        messages: [{ role: 'user', content: isPdf ? instruction : docBlock + '\n\n' + instruction }],
        fileBase64: isPdf ? fileBase64 : null,
        fileMime: 'application/pdf',
      });
    } else {
      // OpenAI: chat/completions endpoint cannot accept binary, so PDFs fall
      // back to a notice; extracted-text docs work like any other provider.
      json = await callOpenAI({
        apiKey, model, system: systemPrompt, max_tokens,
        messages: [{ role: 'user', content: (isPdf ? `[Attachment "${att.name}" (${mime}) cannot be sent to OpenAI via this proxy yet — switch to Anthropic or Google for PDF analysis.]` : docBlock) + `\n\n${instruction}` }],
      });
    }
    res.json(json);
  } catch (e) {
    console.error('LLM with-attachment failed:', e.message);
    res.status(e.status || 500).json(e.body || { error: e.message });
  }
});

// ── ATLAS SNAPSHOT (one-way sync feed for LevelUp / other consumers) ──
// Returns a sanitized read-only view of the Atlas dataset.
// Optional bearer auth: if ATLAS_SYNC_TOKEN env var is set, callers must send
//   Authorization: Bearer <token>. If unset, the endpoint is open.
// Deliberately EXCLUDED for safety: accounts, notifications, recruitings,
// candidates (PII / sensitive workflow data), and proforma (confidential CEO
// financials/debt/M&A — Admin-only, never synced). The response below is an
// explicit allowlist, so any field not named here is excluded by construction.
app.get('/api/atlas-snapshot', async (req, res) => {
  try {
    const token = process.env.ATLAS_SYNC_TOKEN || '';
    if (token) {
      const auth = req.get('Authorization') || '';
      const got = auth.replace(/^Bearer\s+/i, '').trim();
      if (got !== token) return res.status(401).json({ error: 'Unauthorized' });
    }
    const r = await pool.query('SELECT data, updated_at FROM app_state WHERE id = 1');
    if (!r.rows.length) return res.json({ version: null, generatedAt: new Date().toISOString(), source: 'atlas', empty: true });
    const data = r.rows[0].data || {};
    const updatedAt = r.rows[0].updated_at;

    // Strip sensitive fields off the members (resume URLs are OK; cost is OK; notes/badge/etc. are OK)
    const departments = (data.departments || []).map((d) => ({
      id: d.id,
      name: d.name,
      subtitle: d.subtitle || '',
      accent: d.accent || '',
      parentId: d.parentId || null,
      members: (d.members || []).map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role || '',
        cost: m.cost || 0,
        badge: m.badge || '',
        reportsTo: m.reportsTo || '',
        projects: m.projects || [],
        skillsets: m.skillsets || [],
        certifications: m.certifications || [],
        location: m.location || '',
        clearance: m.clearance || '',
        hub: !!m.hub,
        sme: !!m.sme,
        associate: !!m.associate,
        proposal: !!m.proposal,
        recruiter: !!m.recruiter,
        note: m.note || '',
        reassess: !!m.reassess,
        pastProjects: m.pastProjects || [],
        pastClients: m.pastClients || [],
        resumeLink: m.resumeLink || '',
        attachments: m.attachments || [],
        // Financial / time-phased fields (for Resource Planning + Capacity mirror)
        pto: m.pto || [],
        furloughDate: m.furloughDate || '',
        allocSchedule: m.allocSchedule || [],
        costSchedule: m.costSchedule || [],
        costEscalator: m.costEscalator || null,
        oneTimeCosts: m.oneTimeCosts || [],
      })),
    }));

    // Projects — pass through with CLINs intact, drop nothing
    const projects = (data.projects || []).map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category || 'project',
      revenue: p.revenue || 0,
      targetRevenue: p.targetRevenue || 0,
      revenueNote: p.revenueNote || '',
      description: p.description || '',
      parentId: p.parentId || null,
      attachments: p.attachments || [],
      clins: p.clins || [],
      // Opportunity-specific
      customer: p.customer || '',
      stage: p.stage || '',
      status: p.status || '',
      leadGen: p.leadGen || '',
      presales: p.presales || '',
      sales: p.sales || '',
      delivery: p.delivery || '',
      opr: p.opr || '',
      pm: p.pm || '',
      team: p.team || '',
      potential: p.potential || 0,
      closeDate: p.closeDate || '',
      changeRequested: p.changeRequested || '',
      // Scheduling / time-phased revenue (for Capacity + Resource Planning mirror)
      startDate: p.startDate || '',
      endDate: p.endDate || '',
      timeline: p.timeline || [],
      revenueSteps: p.revenueSteps || [],
      revenueEscalator: p.revenueEscalator || null,
    }));

    // Activities — exclude any tied to recruitings (workflow-internal) by templateId; include COE + project kinds
    const activities = (data.activities || []).map((a) => ({
      id: a.id,
      kind: a.kind || 'coe',
      programId: a.programId || '',
      program: a.program || '',
      task: a.task || '',
      subtask: a.subtask || '',
      outline: a.outline || '',
      objective: a.objective || '',
      phase: a.phase || '',
      start: a.start || '',
      dueDate: a.dueDate || '',
      isMilestone: !!a.isMilestone,
      status: a.status || 'todo',
      parentId: a.parentId || null,
      owners: a.owners || [],
      ownerText: a.ownerText || '',
      projectId: a.projectId || null,
      pm: a.pm || '',
      order: a.order || 0,
      templateId: a.templateId || '',
      updates: (a.updates || []).map((u) => ({ id: u.id, ts: u.ts, author: u.author, text: u.text })),
      attachments: a.attachments || [],
    }));

    // Proposals — full record. Sections HTML, RFP fields, staffing, redTeam are
    // all included. Sensitive bits (per-user API keys, account passwords) live
    // on D.accounts and are excluded above.
    const proposals = (data.proposals || []).map((p) => ({
      id: p.id,
      title: p.title || '',
      status: p.status || 'draft',
      opportunityId: p.opportunityId || '',
      templateId: p.templateId || '',
      llmProvider: p.llmProvider || '',
      llmModel: p.llmModel || '',
      createdAt: p.createdAt || 0,
      createdBy: p.createdBy || '',
      rfp: p.rfp || {},
      sections: (p.sections || []).map((s) => ({
        id: s.id,
        title: s.title,
        source: s.source || 'user-only',
        pageBudget: s.pageBudget || 0,
        html: s.html || '',
        draftedAt: s.draftedAt || 0,
        draftedBy: s.draftedBy || '',
        draftedWith: s.draftedWith || null,
        templatePrompt: s.templatePrompt || '',
        evidence: s.evidence || [],
      })),
      pastPerformance: p.pastPerformance || { matches: [], generatedAt: 0 },
      coverSheet: p.coverSheet || { certIds: [], includedCaseStudyIds: [], generatedAt: 0 },
      pricing: p.pricing || { mode: 'manual', items: [] },
      staffing: p.staffing || { generatedAt: 0, roleMatches: [] },
      redTeam: p.redTeam || { rubric: [], reviews: [], createdTaskId: '', generatedAt: 0 },
      winLoss: p.winLoss || null,
      gapAnalysis: p.gapAnalysis || null,
      events: p.events || [],
    }));

    // Company profile — the inputs Claude uses. Identity + voice + boilerplate
    // + services + case studies + win themes + key personnel + teaming partners.
    const companyProfile = data.companyProfile || {};

    // Corporate certifications & designations — for cover sheets.
    const corporateCertifications = (data.corporateCertifications || []).map((c) => ({
      id: c.id,
      name: c.name || '',
      number: c.number || '',
      issuer: c.issuer || '',
      issuedAt: c.issuedAt || '',
      expiresAt: c.expiresAt || '',
      logoUrl: c.logoUrl || '',
      supportingDocId: c.supportingDocId || '',
    }));

    res.json({
      version: '2',
      source: 'atlas',
      generatedAt: new Date().toISOString(),
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
      planStart: data.planStart || null,
      departments,
      projects,
      activities,
      programs: data.programs || [],
      taskTemplates: data.taskTemplates || [],
      locations: data.locations || [],
      skillsets: data.skillsets || [],
      certifications: data.certifications || [],
      clearances: data.clearances || [],
      pastProjects: data.pastProjects || [],
      pastClients: data.pastClients || [],
      proposals,
      companyProfile,
      corporateCertifications,
      // Recruiting (requisitions + candidate pipeline + resume bank)
      recruitings: data.recruitings || [],
      candidates: data.candidates || [],
      resumeBank: data.resumeBank || [],
      // Financial model (Proforma page) + saved Capacity scenarios + custom reports
      proforma: data.proforma || null,
      scenarios: data.scenarios || [],
      reportTemplates: data.reportTemplates || [],
      // Pre-computed bundle (capacity/forecast/resource-planning data + rendered
      // report HTML) baked by the Atlas client's buildAtlasComputed().
      atlasComputed: data.atlasComputed || null,
    });
  } catch (e) {
    console.error('GET /api/atlas-snapshot failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb()
  .then(() => app.listen(PORT, () => console.log('Server listening on ' + PORT)))
  .catch((err) => {
    console.error('DB init failed:', err.message);
    app.listen(PORT, () => console.log('Server listening on ' + PORT + ' (DB unavailable)'));
  });
