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
  // GovWin RFP/RFI documents (folder/CSV ingest): extracted text per file,
  // keyed by GovWin opportunity id. Text only — the original binaries stay on
  // the user's machine; this stays OUT of the app_state JSONB blob.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gov_opp_docs (
      id TEXT PRIMARY KEY,
      govwin_id TEXT NOT NULL,
      name TEXT,
      kind TEXT,
      mime TEXT,
      sha TEXT,
      chars INTEGER,
      extracted_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (govwin_id, name)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS gov_opp_docs_gid ON gov_opp_docs (govwin_id)`);
  // No-Bid disposition on gov opportunities (Bid/No-Bid workflow).
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS no_bid BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS no_bid_reason TEXT`);
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS no_bid_at TIMESTAMPTZ`);
  // AI Bid/No-Bid assessment (Phase 2) — composite, band, rationale, per-dimension.
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS bid_score NUMERIC`);
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS bid_band TEXT`);
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS bid_rationale TEXT`);
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS bid_dims JSONB`);
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS bid_risks JSONB`);
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS bid_scored_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE gov_opportunities ADD COLUMN IF NOT EXISTS bid_model TEXT`);
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
  'prospects',            // BizDev prospects (accounts + POCs) in the pipeline
  'contracts',            // Contract Management staff-planning (self-contained)
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
// DHS APFS record → unified schema. APFS is the richest free source: recompetes
// carry the incumbent contractor + contract number, plus POC emails.
function govMapApfsRecord(r) {
  if (!r || !r.requirements_title) return null;
  const naics = (String(r.naics || '').match(/\d{6}/) || [''])[0];
  const vr = govParseValueRange((r.dollar_range && r.dollar_range.display_name) || '');
  const out = {
    solnum: r.apfs_number || '', title: r.requirements_title, agency: 'DHS' + (r.organization ? ' — ' + r.organization : ''),
    sub_agency: r.contracting_office || '', description: String(r.requirement || '').slice(0, 4000), naics,
    set_aside: r.small_business_set_aside || r.small_business_program || '',
    value_low: vr.low, value_high: vr.high,
    est_solicitation_date: r.estimated_solicitation_release_date || r.estimated_release_date || '',
    est_award_date: r.anticipated_award_date || r.award_quarter || '',
    place: [r.place_of_performance_city, r.place_of_performance_state].filter(Boolean).join(', '),
    poc_name: [r.requirements_contact_first_name, r.requirements_contact_last_name].filter(Boolean).join(' '),
    poc_email: r.requirements_contact_email || r.sbs_coordinator_email || '',
    source: 'dhs-apfs', source_url: 'https://apfs-cloud.dhs.gov/record/' + r.id + '/public-print/',
    notice_type: 'forecast', lifecycle: 'forecast', raw: r,
  };
  if (r.contractor) out.recompete = { incumbent: r.contractor, contractNumber: r.contract_number || '', endDate: r.estimated_period_of_performance_start || '', via: 'dhs-apfs' };
  return out;
}
// FPDS ATOM entry parser — regex over the ns1 XML (a real XML dep isn't worth
// it for the handful of fields we need; tests pin the format).
function govParseFpdsAtom(xml) {
  const out = [];
  const entries = String(xml).split('<entry>').slice(1);
  for (const e of entries) {
    const pick = (tag) => { const m = new RegExp('<ns1:' + tag + '(?:\\s[^>]*)?>([^<]*)</ns1:' + tag + '>').exec(e); return m ? m[1].trim() : ''; };
    const attr = (tag, at) => { const m = new RegExp('<ns1:' + tag + '\\s[^>]*' + at + '="([^"]*)"').exec(e); return m ? m[1] : ''; };
    const titleM = /<title><!\[CDATA\[(.*?)\]\]><\/title>/s.exec(e);
    const vendorM = /awarded to ([^,]+(?:, (?:LLC|INC|L\.L\.C\.|CORP)[\.]?)?)/i.exec(titleM ? titleM[1] : '');
    out.push({
      piid: pick('PIID'), title: titleM ? titleM[1].slice(0, 200) : '',
      vendor: pick('vendorName') || (vendorM ? vendorM[1].trim() : ''),
      agency: attr('contractingOfficeAgencyID', 'name') || attr('agencyID', 'name'),
      department: attr('contractingOfficeAgencyID', 'departmentName'),
      signedDate: pick('signedDate').slice(0, 10),
      ultimateCompletionDate: pick('ultimateCompletionDate').slice(0, 10),
      totalValue: Number(pick('totalBaseAndAllOptionsValue') || pick('totalObligatedAmount')) || 0,
      naics: pick('principalNAICSCode'),
      description: pick('descriptionOfContractRequirement').slice(0, 600),
    });
  }
  return out.filter((x) => x.piid);
}
// Generic RSS/ATOM item parser for URL feed sources (NZ GETS, state portals
// like Virginia eVA — anything with a feed becomes an adapter for free).
function govParseRssItems(xml) {
  const s = String(xml);
  const blocks = s.split(/<item[\s>]/).slice(1).concat(s.split(/<entry[\s>]/).slice(1));
  return blocks.map((b) => {
    const grab = (tag) => { const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(b); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''; };
    const linkAttr = /<link[^>]*href="([^"]+)"/.exec(b);
    return { title: grab('title'), link: grab('link') || (linkAttr ? linkAttr[1] : ''), description: grab('description') || grab('summary') || grab('content'), pubDate: grab('pubDate') || grab('updated') || grab('published') };
  }).filter((x) => x.title);
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
    ingestKeywords: ((gp.settings && gp.settings.ingestKeywords) || []).filter(Boolean),   // explicit download filter
    agencies: agencies.slice(0, 40),
    weights: (gp.settings && gp.settings.weights) || null,
    searches: gp.searches || [],
    samApiKey: (gp.settings && gp.settings.samApiKey) || '',
    sources: (gp.settings && gp.settings.sources) || {},   // per-adapter on/off toggles
    urlSources: gp.urlSources || [],                        // [{id,name,url,kind:'csv'|'rss',adapter}]
    schedule: (gp.settings && gp.settings.schedule) || null, // {enabled,everyHours} for the auto scheduler
  };
}
async function govUpsert(unified, profile, stats) {
  if (!unified || !unified.title) return;
  // Keyword download criteria: when set, only keep opportunities whose title or
  // description matches at least one keyword (case-insensitive). Applies to all sources.
  const kws = (profile && profile.ingestKeywords) || [];
  if (kws.length) {
    const hay = ((unified.title || '') + ' ' + (unified.description || '')).toLowerCase();
    if (!kws.some((k) => hay.indexOf(String(k).toLowerCase()) > -1)) { if (stats) stats.filtered = (stats.filtered || 0) + 1; return; }
  }
  const cand = await pool.query(
    `SELECT id, solnum, title, agency, naics, lifecycle, timeline FROM gov_opportunities
     WHERE archived = false AND (solnum = $1 OR left(coalesce(naics,''),4) = left($2,4) OR $2 = '') LIMIT 400`,
    [unified.solnum || '', String(unified.naics || '')]
  );
  const match = govMatch(unified, cand.rows);
  const sc = govScore(unified, profile, profile.weights);
  const tlEntry = { source: unified.source, notice_type: unified.notice_type, url: unified.source_url || '', at: new Date().toISOString(), title: unified.title };
  const recompete = unified.recompete ? JSON.stringify(unified.recompete) : null;
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
        score=$20, score_parts=$21, timeline=$22, raw=$23, recompete=coalesce($24,recompete), last_updated=now()
       WHERE id=$1`,
      [match.id, unified.title || '', unified.agency || '', unified.sub_agency || '', unified.description || '', String(unified.naics || ''), unified.psc || '', unified.set_aside || '', unified.value_low, unified.value_high, unified.est_solicitation_date || '', unified.est_award_date || '', unified.place || '', unified.poc_name || '', unified.poc_email || '', unified.source_url || '', unified.notice_type || '', lifecycle, unified.solnum || '', sc.score, JSON.stringify(sc.parts), JSON.stringify(timeline), JSON.stringify(unified.raw || {}), recompete]
    );
    stats.updated++;
  } else {
    const id = 'gov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO gov_opportunities (id, solnum, title, agency, sub_agency, description, naics, psc, set_aside, value_low, value_high,
        est_solicitation_date, est_award_date, place, poc_name, poc_email, source, source_url, notice_type, lifecycle, score, score_parts, timeline, raw, recompete)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [id, unified.solnum || '', unified.title, unified.agency || '', unified.sub_agency || '', unified.description || '', String(unified.naics || ''), unified.psc || '', unified.set_aside || '', unified.value_low, unified.value_high, unified.est_solicitation_date || '', unified.est_award_date || '', unified.place || '', unified.poc_name || '', unified.poc_email || '', unified.source || 'unknown', unified.source_url || '', unified.notice_type || '', unified.lifecycle || 'forecast', sc.score, JSON.stringify(sc.parts), JSON.stringify([tlEntry]), JSON.stringify(unified.raw || {}), recompete]
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
// DHS APFS — public JSON API, no key. The whole forecast comes down in one
// request; we keep records matching the profile's NAICS prefixes (all, when
// no NAICS are configured yet).
async function apfsIngest(profile, stats, errors) {
  try {
    const res = await govFetch('https://apfs-cloud.dhs.gov/api/forecast/', {}, 3);
    if (!res.ok) { errors.push({ source: 'dhs-apfs', error: 'HTTP ' + res.status }); return; }
    const all = await res.json();
    const list = Array.isArray(all) ? all : (all.results || []);
    const prefixes = (profile.naics || []).map((n) => String(n).slice(0, 4));
    if (!prefixes.length) { errors.push({ source: 'dhs-apfs', error: 'No NAICS codes in the Company Profile — skipped to avoid ingesting the entire DHS forecast. Add your NAICS codes (Admin → Company Profile), then re-run.' }); return; }
    for (const r of list) {
      const u = govMapApfsRecord(r);
      if (!u) continue;
      if (!prefixes.includes(String(u.naics || '').slice(0, 4))) continue;
      stats.fetched++;
      await govUpsert(u, profile, stats);
    }
  } catch (e) { errors.push({ source: 'dhs-apfs', error: e.message }); }
}
// FPDS ATOM — recompete LEADS by direct query: contracts in the profile's
// NAICS whose ultimate completion date lands 12–18 months out. Each lead
// carries the incumbent, value, and end date.
async function fpdsRecompete(profile, stats, errors) {
  const naicsList = (profile.naics || []).slice(0, 6);
  if (!naicsList.length) { errors.push({ source: 'fpds', error: 'No NAICS codes in the Company Profile — recompete search needs them. Add your NAICS codes (Admin → Company Profile), then re-run.' }); return; }
  const fmt = (d) => d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
  const lo = new Date(Date.now() + 12 * 30 * 86400000), hi = new Date(Date.now() + 18 * 30 * 86400000);
  for (const naics of naicsList) {
    try {
      // ESTIMATED_COMPLETION_DATE is the indexed search field (ULTIMATE_… is
      // only an output field) — probed live 2026-06-12.
      const q = encodeURIComponent('PRINCIPAL_NAICS_CODE:"' + naics + '" ESTIMATED_COMPLETION_DATE:[' + fmt(lo) + ',' + fmt(hi) + ']');
      for (let start = 0; start < 30; start += 10) {
        const res = await govFetch('https://www.fpds.gov/ezsearch/FEEDS/ATOM?FEEDNAME=PUBLIC&q=' + q + '&start=' + start, {}, 2);
        if (!res.ok) { errors.push({ source: 'fpds', error: 'HTTP ' + res.status }); break; }
        const xml = await res.text();
        const awards = govParseFpdsAtom(xml);
        if (!awards.length) break;
        stats.fetched += awards.length;
        for (const a of awards) {
          if (a.totalValue < 100000) continue;   // skip noise mods
          await govUpsert({
            solnum: '', title: '[Recompete] ' + (a.description || a.title || a.piid).slice(0, 150),
            agency: a.department || a.agency || '', sub_agency: a.agency || '',
            description: 'Incumbent contract ' + a.piid + ' (' + (a.vendor || 'unknown vendor') + ') ends ' + a.ultimateCompletionDate + '. ' + (a.description || ''),
            naics: a.naics || naics, set_aside: '', value_low: a.totalValue || null, value_high: a.totalValue || null,
            est_solicitation_date: a.ultimateCompletionDate, est_award_date: '',
            place: '', poc_name: '', poc_email: '',
            source: 'fpds-recompete', source_url: 'https://www.fpds.gov/ezsearch/search.do?s=FPDS&indexName=awardfull&templateName=1.5.3&q=' + encodeURIComponent(a.piid),
            notice_type: 'forecast', lifecycle: 'forecast', raw: a,
            recompete: { incumbent: a.vendor || '', value: a.totalValue || 0, endDate: a.ultimateCompletionDate, awardId: a.piid, via: 'fpds' },
          }, profile, stats);
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (e) { errors.push({ source: 'fpds', error: e.message }); }
  }
}
// Saved URL sources — CSV/XLSX file links (agency OSDBU forecast downloads,
// data.gov-hosted datasets) and RSS/ATOM feeds (NZ GETS, state portals).
async function urlSourceIngest(src, profile, stats, errors) {
  try {
    const res = await govFetch(src.url, {}, 2);
    if (!res.ok) { errors.push({ source: src.name || src.url, error: 'HTTP ' + res.status }); return; }
    if ((src.kind || 'csv') === 'rss') {
      const items = govParseRssItems(await res.text());
      for (const it of items.slice(0, 200)) {
        stats.fetched++;
        await govUpsert({ solnum: '', title: it.title, agency: src.name || 'feed', description: it.description || '', naics: '', set_aside: '', value_low: null, value_high: null, est_solicitation_date: (it.pubDate || '').slice(0, 24), est_award_date: '', place: '', poc_name: '', poc_email: '', source: src.name || 'rss', source_url: it.link || src.url, notice_type: 'solicitation', lifecycle: 'solicitation', raw: it }, profile, stats);
      }
    } else {
      const XLSX = require('xlsx');
      const buf = Buffer.from(await res.arrayBuffer());
      const wb = XLSX.read(buf, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      if (rows.length < 2) { errors.push({ source: src.name || src.url, error: 'no data rows' }); return; }
      const headers = rows[0].map(String);
      for (const row of rows.slice(1)) {
        const u = govMapCsvRow(src.adapter || 'generic', headers, row);
        if (!u) continue;
        u.source = src.name || src.adapter || 'url-import'; u.raw = { headers, row };
        stats.fetched++;
        await govUpsert(u, profile, stats);
      }
    }
  } catch (e) { errors.push({ source: src.name || src.url, error: e.message }); }
}
// ── Deltek GovWin IQ — official IQ API (neo-ws), OAuth2 "password" grant. ──
// Requires a GovWin API entitlement: a client id + secret from Deltek, PLUS a
// username + password. A normal web login alone cannot call the API. All four
// are read from environment variables so nothing sensitive lives in the app
// data blob or the repo. Opt-in: off until enabled in Gov Discovery → Sources.
const GOVWIN_BASE = process.env.GOVWIN_BASE || 'https://services.govwin.com/neo-ws';
function govwinConfigured() {
  return ['GOVWIN_CLIENT_ID', 'GOVWIN_CLIENT_SECRET', 'GOVWIN_USERNAME', 'GOVWIN_PASSWORD'].filter((k) => !process.env[k]);
}
async function govwinToken() {
  const basic = Buffer.from(process.env.GOVWIN_CLIENT_ID + ':' + process.env.GOVWIN_CLIENT_SECRET).toString('base64');
  const body = 'grant_type=password&username=' + encodeURIComponent(process.env.GOVWIN_USERNAME)
    + '&password=' + encodeURIComponent(process.env.GOVWIN_PASSWORD) + '&scope=read';
  const res = await govFetch(GOVWIN_BASE + '/oauth/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  }, 2);
  if (!res.ok) throw new Error('token HTTP ' + res.status + ' (verify API entitlement + credentials)');
  const j = await res.json();
  if (!j.access_token) throw new Error('no access_token in token response');
  return j.access_token;
}
function govwinLifecycle(o) {
  const s = String(o.oppStatus || o.status || o.statusName || '').toLowerCase();
  if (/award/.test(s)) return 'special';
  if (/source|rfi|pre-?rfp|pre-?solicit/.test(s)) return 'sources-sought';
  if (/solicit|rfp|rfq|active|open/.test(s)) return 'solicitation';
  return 'forecast';
}
function govwinMap(o) {
  const id = o.id || o.iqOppId || o.opportunityId || '';
  const ge = o.govEntity || o.organization || {};
  const naics = (o.primaryNAICS && (o.primaryNAICS.id || o.primaryNAICS.code)) || o.naicsCode
    || (Array.isArray(o.naics) && o.naics[0] && (o.naics[0].id || o.naics[0].code)) || '';
  const val = Number(o.contractValue || o.estimatedValue || o.value || 0) || null;
  const poc = (Array.isArray(o.contacts) && o.contacts[0]) || o.primaryContact || {};
  return {
    solnum: o.solicitationNumber || o.referenceNumber || '',
    title: o.title || o.name || '(GovWin opportunity)',
    agency: (ge && (ge.name || ge.title)) || o.organizationName || o.agency || '',
    sub_agency: (o.subOrganization && o.subOrganization.name) || '',
    description: String(o.description || o.summary || o.scope || '').slice(0, 4000),
    naics: String(naics || ''), psc: o.pscCode || '', set_aside: o.setAside || o.competitionType || '',
    value_low: val, value_high: val,
    est_solicitation_date: o.solicitationDate || o.expectedSolicitationDate || o.rfpDate || '',
    est_award_date: o.awardDate || o.expectedAwardDate || '',
    place: (o.placeOfPerformance && (o.placeOfPerformance.state || o.placeOfPerformance.location)) || '',
    poc_name: poc.name || poc.fullName || '', poc_email: poc.email || '',
    source: 'govwin', source_url: o.govWinUrl || o.detailUrl || (id ? 'https://iq.govwin.com/neo/opportunity/view/' + id : ''),
    notice_type: 'govwin', lifecycle: govwinLifecycle(o), raw: o,
  };
}
async function govwinIngest(profile, stats, errors) {
  const missing = govwinConfigured();
  if (missing.length) { errors.push({ source: 'govwin', error: 'GovWin not configured — missing env var(s): ' + missing.join(', ') + '. Requires a Deltek GovWin IQ API entitlement (client id + secret), not just a web login.' }); return; }
  let token;
  try { token = await govwinToken(); } catch (e) { errors.push({ source: 'govwin', error: 'Auth failed: ' + e.message }); return; }
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  const naicsList = (profile.naics || []).slice(0, 6);
  const updatedAfter = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const queries = naicsList.length
    ? naicsList.map((n) => ({ key: 'primaryNAICSCode', val: n }))
    : [{ key: 'q', val: (profile.keywords || []).slice(0, 3).join(' ') || 'IT services' }];
  for (const q of queries) {
    for (let offset = 0; offset < 300; offset += 100) {
      const url = GOVWIN_BASE + '/opportunities?max=100&offset=' + offset
        + '&' + q.key + '=' + encodeURIComponent(q.val) + '&updatedAfter=' + encodeURIComponent(updatedAfter);
      try {
        const res = await govFetch(url, { headers }, 2);
        if (res.status === 401) { errors.push({ source: 'govwin', error: 'Unauthorized (401) — token rejected or API scope missing.' }); return; }
        if (!res.ok) { errors.push({ source: 'govwin', error: 'HTTP ' + res.status }); break; }
        const j = await res.json();
        const list = Array.isArray(j) ? j : (j.opportunities || j.results || j.items || j.data || []);
        stats.fetched += list.length;
        for (const o of list) { try { await govUpsert(govwinMap(o), profile, stats); } catch (e) { errors.push({ source: 'govwin', error: e.message }); } }
        if (list.length < 100) break;
        await new Promise((r) => setTimeout(r, 1200));
      } catch (e) { errors.push({ source: 'govwin', error: e.message }); break; }
    }
  }
}
// ── GovWin folder/CSV ingest (Hybrid Phase 1) ──────────────────────────────
// Map an index.csv-style row (GovWinID, Agency, Title, List, Status,
// SolicitationDate, EstValue, Folder, Link) to the unified gov_opportunities
// shape. EstValue like "$48,480 (USD-$K)" is read as thousands.
function govwinCsvMap(row) {
  const naics = (String(row.naics || row.List || row.list || '').match(/\d{4,6}/) || [''])[0];
  let val = null;
  const mv = String(row.estValue || row.EstValue || '').replace(/,/g, '').match(/([\d.]+)/);
  if (mv) val = Math.round(parseFloat(mv[1]) * 1000);
  const status = row.status || row.Status || '';
  const gid = String(row.govwinId || row.GovWinID || '').trim();
  return {
    solnum: '', title: row.title || row.Title || '(GovWin opportunity)',
    agency: row.agency || row.Agency || '', sub_agency: '',
    description: '', naics: naics, psc: '', set_aside: '',
    value_low: val, value_high: val,
    est_solicitation_date: row.solicitationDate || row.SolicitationDate || '', est_award_date: '',
    place: '', poc_name: '', poc_email: '',
    source: 'govwin', source_url: row.link || row.Link || (gid ? 'https://iq.govwin.com/neo/opportunity/view/' + gid : ''),
    notice_type: 'govwin', lifecycle: govwinLifecycle({ status: status }),
    raw: { govwinId: gid, status: status, list: row.List || row.list || row.naics || '', folder: row.folder || row.Folder || '' },
  };
}
// Deterministic upsert keyed by GovWin opportunity id (id = 'govwin_<gid>') so
// re-syncs update in place — no fuzzy matching, true idempotency. Reuses govScore.
async function govwinUpsertById(govwinId, unified, profile, stats) {
  const id = 'govwin_' + String(govwinId);
  const sc = govScore(unified, profile, profile.weights);
  const tlEntry = { source: 'govwin-folder', notice_type: unified.notice_type, url: unified.source_url || '', at: new Date().toISOString(), title: unified.title };
  const r = await pool.query('SELECT id FROM gov_opportunities WHERE id=$1', [id]);
  if (r.rows.length) {
    await pool.query(
      `UPDATE gov_opportunities SET title=coalesce(nullif($2,''),title), agency=coalesce(nullif($3,''),agency),
        naics=coalesce(nullif($4,''),naics), value_low=coalesce($5,value_low), value_high=coalesce($6,value_high),
        est_solicitation_date=coalesce(nullif($7,''),est_solicitation_date), source_url=coalesce(nullif($8,''),source_url),
        lifecycle=$9, score=$10, score_parts=$11, raw=$12, last_updated=now() WHERE id=$1`,
      [id, unified.title || '', unified.agency || '', String(unified.naics || ''), unified.value_low, unified.value_high, unified.est_solicitation_date || '', unified.source_url || '', unified.lifecycle || 'forecast', sc.score, JSON.stringify(sc.parts), JSON.stringify(unified.raw || {})]
    );
    if (stats) stats.updated++;
  } else {
    await pool.query(
      `INSERT INTO gov_opportunities (id, solnum, title, agency, sub_agency, description, naics, psc, set_aside, value_low, value_high,
        est_solicitation_date, est_award_date, place, poc_name, poc_email, source, source_url, notice_type, lifecycle, score, score_parts, timeline, raw)
       VALUES ($1,'',$2,$3,'','',$4,'','',$5,$6,$7,'','','','','govwin',$8,'govwin',$9,$10,$11,$12,$13)`,
      [id, unified.title, unified.agency || '', String(unified.naics || ''), unified.value_low, unified.value_high, unified.est_solicitation_date || '', unified.source_url || '', unified.lifecycle || 'forecast', sc.score, JSON.stringify(sc.parts), JSON.stringify([tlEntry]), JSON.stringify(unified.raw || {})]
    );
    if (stats) stats.added++;
  }
}
function govwinIngestAuthed(req) {
  const need = process.env.GOVWIN_INGEST_TOKEN || '';
  if (!need) return true;                       // open if no token configured
  return (req.get('X-Govwin-Token') || (req.body && req.body.token) || '') === need;
}
// ── DoD SBIR/STTR (dodsbirsttr.mil) — OPEN topics + full-topic instruction PDF ──
// Public DSIP API. topicReleaseStatus 591 = Open. Each open topic becomes a
// solicitation-lifecycle opportunity (program as the set-aside, close date as the
// date); the full-topic PDF is downloaded, text-extracted (pdf-parse), and stored
// in gov_opp_docs so it reads in the app's 📎 Docs viewer. Browser UA required.
const SBIR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
function sbirHeaders(json) { return { 'User-Agent': SBIR_UA, 'Referer': 'https://www.dodsbirsttr.mil/topics-app/', 'Accept': json ? 'application/json, text/plain, */*' : '*/*' }; }
function sbirStripHtml(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim(); }
function sbirDate(ms) { if (!ms) return ''; const d = new Date(Number(ms)); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
async function sbirIngest(profile, stats, errors) {
  const BASE = 'https://www.dodsbirsttr.mil/topics/api/public';
  const searchParam = JSON.stringify({ searchText: null, components: null, programYear: null, solicitationCycleNames: [], releaseNumbers: [], topicReleaseStatus: [591], modernizationPriorities: [], sortBy: 'finalTopicCode,asc', technologyAreaIds: [], component: null, program: null });
  let page = 0; const size = 50; const MAX = 400; let topics = [];
  try {
    while (topics.length < MAX) {
      const url = BASE + '/topics/search?searchParam=' + encodeURIComponent(searchParam) + '&size=' + size + '&page=' + page;
      const r = await fetch(url, { headers: sbirHeaders(true) });
      if (!r.ok) throw new Error('search HTTP ' + r.status);
      const j = await r.json();
      const rows = j.data || j.content || [];
      topics = topics.concat(rows);
      if (rows.length < size || (j.total && topics.length >= j.total)) break;
      page++;
    }
  } catch (e) { errors.push({ source: 'dod-sbir', error: 'search: ' + e.message }); return; }
  stats.fetched += topics.length;
  let pdfParse; try { pdfParse = require('pdf-parse'); } catch (e) { pdfParse = null; }
  const kws = (profile && profile.ingestKeywords) || [];
  for (const t of topics) {
    try {
      const id = 'dod-sbir_' + t.topicId;
      let desc = t.topicTitle || '';
      try {
        const dr = await fetch(BASE + '/topics/' + encodeURIComponent(t.topicId) + '/details', { headers: sbirHeaders(true) });
        if (dr.ok) { const dj = await dr.json(); const body = sbirStripHtml([dj.objective, dj.description, dj.phase1Description].filter(Boolean).join(' \n\n ')); if (body) desc = body; if (dj.keywords) desc += ' \n\nKeywords: ' + (Array.isArray(dj.keywords) ? dj.keywords.join(', ') : dj.keywords); }
      } catch (e) {}
      desc = desc.slice(0, 4000);
      const unified = {
        solnum: t.topicCode || '', title: (t.topicCode ? t.topicCode + ': ' : '') + (t.topicTitle || 'SBIR/STTR topic'),
        agency: t.component || 'DoD', sub_agency: t.command || '', description: desc, naics: '', psc: '',
        set_aside: t.program || 'SBIR', est_solicitation_date: sbirDate(t.topicEndDate), source: 'dod-sbir',
        source_url: 'https://www.dodsbirsttr.mil/topics-app/#/topics/' + t.topicId, notice_type: 'solicitation', lifecycle: 'solicitation',
      };
      if (kws.length) { const hay = (unified.title + ' ' + unified.description).toLowerCase(); if (!kws.some((k) => hay.indexOf(String(k).toLowerCase()) > -1)) { stats.filtered = (stats.filtered || 0) + 1; continue; } }
      const sc = govScore(unified, profile, profile.weights);
      const tlEntry = { source: 'dod-sbir', notice_type: 'solicitation', url: unified.source_url, at: new Date().toISOString(), title: unified.title };
      const existing = await pool.query('SELECT id, timeline FROM gov_opportunities WHERE id=$1', [id]);
      if (existing.rows.length) {
        const tl = (existing.rows[0].timeline || []).concat([tlEntry]).slice(-25);
        await pool.query(`UPDATE gov_opportunities SET title=$2, agency=$3, sub_agency=$4, description=CASE WHEN length($5)>length(coalesce(description,'')) THEN $5 ELSE description END, set_aside=$6, est_solicitation_date=$7, source_url=$8, notice_type=$9, lifecycle=$10, solnum=$11, score=$12, score_parts=$13, timeline=$14, raw=$15, last_updated=now() WHERE id=$1`,
          [id, unified.title, unified.agency, unified.sub_agency, unified.description, unified.set_aside, unified.est_solicitation_date, unified.source_url, unified.notice_type, unified.lifecycle, unified.solnum, sc.score, JSON.stringify(sc.parts), JSON.stringify(tl), JSON.stringify(t)]);
        stats.updated++;
      } else {
        await pool.query(`INSERT INTO gov_opportunities (id, solnum, title, agency, sub_agency, description, naics, psc, set_aside, value_low, value_high, est_solicitation_date, est_award_date, place, poc_name, poc_email, source, source_url, notice_type, lifecycle, score, score_parts, timeline, raw)
          VALUES ($1,$2,$3,$4,$5,$6,'','',$7,null,null,$8,'','','','','dod-sbir',$9,$10,$11,$12,$13,$14,$15)`,
          [id, unified.solnum, unified.title, unified.agency, unified.sub_agency, unified.description, unified.set_aside, unified.est_solicitation_date, unified.source_url, unified.notice_type, unified.lifecycle, sc.score, JSON.stringify(sc.parts), JSON.stringify([tlEntry]), JSON.stringify(t)]);
        stats.added++;
      }
      if (pdfParse) {
        try {
          const docName = (t.topicCode || t.topicId) + ' — Full Topic & Instructions.pdf';
          const have = await pool.query('SELECT chars FROM gov_opp_docs WHERE govwin_id=$1 AND name=$2', [id, docName]);
          if (!have.rows.length || !have.rows[0].chars) {
            const pr = await fetch(BASE + '/topics/' + encodeURIComponent(t.topicId) + '/download/PDF', { headers: sbirHeaders(false) });
            if (pr.ok) {
              const buf = Buffer.from(await pr.arrayBuffer());
              if (buf.slice(0, 5).toString('latin1') === '%PDF-') {
                const parsed = await pdfParse(buf);
                const text = String(parsed.text || '').slice(0, 300000);
                await pool.query(`INSERT INTO gov_opp_docs (id, govwin_id, name, kind, mime, sha, chars, extracted_text) VALUES ($1,$2,$3,'solicitation','application/pdf','',$4,$5)
                  ON CONFLICT (govwin_id, name) DO UPDATE SET chars=$4, extracted_text=$5`,
                  ['doc_sbir_' + t.topicId, id, docName, text.length, text]);
              }
            }
          }
        } catch (e) { errors.push({ source: 'dod-sbir', error: 'doc ' + (t.topicCode || t.topicId) + ': ' + e.message }); }
      }
    } catch (e) { errors.push({ source: 'dod-sbir', error: ((t && t.topicCode) || '?') + ': ' + e.message }); }
  }
}
async function govRunIngestion(triggerKind) {
  const run = await pool.query('INSERT INTO ingestion_runs (source, trigger_kind) VALUES ($1,$2) RETURNING id', ['daily', triggerKind]);
  const runId = run.rows[0].id;
  const stats = { fetched: 0, added: 0, updated: 0 };
  const errors = [];
  try {
    const profile = await govProfile();
    const on = (k) => profile.sources[k] !== false;   // every source defaults ON
    if (on('sam')) await samIngest(profile, stats, errors);
    if (profile.sources.govwin === true) await govwinIngest(profile, stats, errors);   // opt-in: needs API creds
    if (on('apfs')) await apfsIngest(profile, stats, errors);
    if (on('fpds')) await fpdsRecompete(profile, stats, errors);
    if (on('usaspending')) await usaspendingRecompete(profile, stats, errors);
    if (on('sbir')) await sbirIngest(profile, stats, errors);
    for (const src of (profile.urlSources || [])) {
      if (src.enabled === false) continue;
      await urlSourceIngest(src, profile, stats, errors);
    }
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
// Scheduler: ticks hourly; runs the ingestion when scheduling is enabled and the
// last auto run is older than the configured cadence (Gov Discovery → Data
// Sources → Automatic download schedule). Defaults to every 24h when unset.
setInterval(async () => {
  try {
    let sched = { enabled: true, everyHours: 24 };
    try { const p = await govProfile(); if (p && p.schedule) sched = Object.assign(sched, p.schedule); } catch (e) {}
    if (sched.enabled === false) return;
    const everyMs = Math.max(1, Number(sched.everyHours) || 24) * 3600000;
    const r = await pool.query("SELECT max(started_at) AS last FROM ingestion_runs WHERE trigger_kind = 'auto'");
    const last = r.rows[0].last ? new Date(r.rows[0].last).getTime() : 0;
    if (Date.now() - last >= everyMs - 60000) { console.log('[govops] scheduled ingestion (every ' + (sched.everyHours || 24) + 'h)'); await govRunIngestion('auto'); }
  } catch (e) { console.error('[govops] scheduler error:', e.message); }
}, 3600000);

// Parse the (mixed-format) est_solicitation_date text into a real date so we can
// bucket by "days until due". Strict regexes keep invalid month/day out of
// to_date. Handles YYYY-MM-DD, MM/DD/YYYY, and MM/YYYY; anything else → NULL.
const GOV_DL = "(CASE "
  + "WHEN est_solicitation_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])' THEN to_date(substr(est_solicitation_date,1,10),'YYYY-MM-DD') "
  + "WHEN est_solicitation_date ~ '^(0?[1-9]|1[0-2])/(0?[1-9]|[12][0-9]|3[01])/[0-9]{4}' THEN to_date(substring(est_solicitation_date from '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}'),'MM/DD/YYYY') "
  + "WHEN est_solicitation_date ~ '^(0?[1-9]|1[0-2])/[0-9]{4}' THEN to_date(substring(est_solicitation_date from '^[0-9]{1,2}/[0-9]{4}'),'MM/YYYY') "
  + "ELSE NULL END)";
app.get('/api/govops', async (req, res) => {
  try {
    const q = req.query;
    const r = await pool.query(
      `SELECT id, solnum, title, agency, sub_agency, naics, psc, set_aside, value_low, value_high, est_solicitation_date, est_award_date,
              place, poc_name, poc_email, source, source_url, notice_type, lifecycle, stage, no_bid, no_bid_reason, score, score_parts, recompete, timeline,
              bid_score, bid_band, bid_rationale, bid_dims, bid_risks, bid_scored_at,
              (SELECT count(*)::int FROM gov_opp_docs gd WHERE gd.govwin_id = regexp_replace(gov_opportunities.id,'^govwin_','')) AS doc_count,
              left(coalesce(description,''), 600) AS description, first_seen, last_updated
       FROM gov_opportunities
       WHERE archived = ($1='1') AND ($2='' OR title ILIKE '%'||$2||'%' OR description ILIKE '%'||$2||'%' OR solnum ILIKE '%'||$2||'%')
         AND ($3='' OR agency ILIKE '%'||$3||'%') AND ($4='' OR naics LIKE $4||'%') AND ($5='' OR set_aside ILIKE '%'||$5||'%')
         AND ($6='' OR lifecycle=$6) AND ($7='' OR stage=$7) AND ($8='' OR recompete IS NOT NULL)
         AND ($11='' OR ($11='only' AND no_bid=true) OR ($11='hide' AND coalesce(no_bid,false)=false))
         AND ($12='' OR bid_band=$12)
         AND ($13='' OR (CASE WHEN $13='30' THEN ${GOV_DL} >= current_date AND ${GOV_DL} <= current_date+30
                              WHEN $13='3060' THEN ${GOV_DL} > current_date+30 AND ${GOV_DL} <= current_date+60
                              WHEN $13='60' THEN ${GOV_DL} > current_date+60 ELSE true END))
       ORDER BY score DESC, last_updated DESC LIMIT $9 OFFSET $10`,
      [q.archived || '', q.q || '', q.agency || '', q.naics || '', q.setAside || '', q.lifecycle || '', q.stage || '', q.recompete || '', Math.min(Number(q.limit) || 100, 300), Number(q.offset) || 0, q.noBid || '', q.bidBand || '', q.due || '']
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Aggregate counts for the report-card strip. Mirrors the /api/govops filters
// (minus limit/offset) so the cards reflect the true pool, not the capped page.
app.get('/api/govops/summary', async (req, res) => {
  try {
    const q = req.query;
    const dueClause = (n) => `($${n}='' OR (CASE WHEN $${n}='30' THEN ${GOV_DL} >= current_date AND ${GOV_DL} <= current_date+30 WHEN $${n}='3060' THEN ${GOV_DL} > current_date+30 AND ${GOV_DL} <= current_date+60 WHEN $${n}='60' THEN ${GOV_DL} > current_date+60 ELSE true END))`;
    const where = `archived = ($1='1')
      AND ($2='' OR title ILIKE '%'||$2||'%' OR description ILIKE '%'||$2||'%' OR solnum ILIKE '%'||$2||'%')
      AND ($3='' OR agency ILIKE '%'||$3||'%') AND ($4='' OR naics LIKE $4||'%') AND ($5='' OR set_aside ILIKE '%'||$5||'%')
      AND ($6='' OR lifecycle=$6) AND ($7='' OR stage=$7) AND ($8='' OR recompete IS NOT NULL)
      AND ($9='' OR ($9='only' AND no_bid=true) OR ($9='hide' AND coalesce(no_bid,false)=false))
      AND ($10='' OR bid_band=$10) AND ${dueClause(11)}`;
    const params = [q.archived || '', q.q || '', q.agency || '', q.naics || '', q.setAside || '', q.lifecycle || '', q.stage || '', q.recompete || '', q.noBid || '', q.bidBand || '', q.due || ''];
    const byStage = await pool.query(`SELECT coalesce(nullif(stage,''),'identified') AS stage, count(*)::int AS n FROM gov_opportunities WHERE ${where} GROUP BY 1`, params);
    const agg = await pool.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE coalesce(no_bid,false))::int AS no_bid,
        count(*) FILTER (WHERE bid_band IS NOT NULL AND bid_band<>'')::int AS scored,
        count(*) FILTER (WHERE recompete IS NOT NULL)::int AS recompete,
        coalesce(sum(coalesce(value_high, value_low, 0)),0)::bigint AS value_sum
      FROM gov_opportunities WHERE ${where}`, params);
    // Deadline buckets neutralize the due self-filter ($11) so the cards stay
    // stable and switchable while every OTHER breakdown reflects the due filter.
    const dueParams = params.slice(); dueParams[10] = '';
    const dueAgg = await pool.query(`SELECT
        count(*) FILTER (WHERE ${GOV_DL} >= current_date AND ${GOV_DL} <= current_date+30)::int AS due30,
        count(*) FILTER (WHERE ${GOV_DL} > current_date+30 AND ${GOV_DL} <= current_date+60)::int AS due3060,
        count(*) FILTER (WHERE ${GOV_DL} > current_date+60)::int AS due60
      FROM gov_opportunities WHERE ${where}`, dueParams);
    // Archived count — always the archived pool matching the other filters,
    // independent of the current archived-view toggle, so the card shows even
    // while viewing the active pool.
    const archAgg = await pool.query(`SELECT count(*)::int AS n FROM gov_opportunities WHERE archived = true
        AND ($1='' OR title ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%' OR solnum ILIKE '%'||$1||'%')
        AND ($2='' OR agency ILIKE '%'||$2||'%') AND ($3='' OR naics LIKE $3||'%') AND ($4='' OR set_aside ILIKE '%'||$4||'%')
        AND ($5='' OR lifecycle=$5) AND ($6='' OR stage=$6) AND ($7='' OR recompete IS NOT NULL)
        AND ($8='' OR ($8='only' AND no_bid=true) OR ($8='hide' AND coalesce(no_bid,false)=false))
        AND ($9='' OR bid_band=$9) AND ${dueClause(10)}`, params.slice(1));
    // Distinct NAICS / set-aside values for the filter dropdowns — over the
    // current archived scope only (ignoring the text filters) so the option
    // lists stay complete and stable as the user filters.
    const naicsList = await pool.query(`SELECT naics AS v, count(*)::int AS n FROM gov_opportunities
        WHERE archived = ($1='1') AND coalesce(naics,'') <> '' GROUP BY naics ORDER BY n DESC, naics`, [q.archived || '']);
    const setAsideList = await pool.query(`SELECT set_aside AS v, count(*)::int AS n FROM gov_opportunities
        WHERE archived = ($1='1') AND coalesce(set_aside,'') <> '' GROUP BY set_aside ORDER BY n DESC, set_aside`, [q.archived || '']);
    // Lifecycle / agency breakdowns — each neutralizes its OWN self-filter (by
    // blanking that param) so its card group stays complete and switchable while
    // still respecting every other active filter.
    const lifecycleParams = params.slice(); lifecycleParams[5] = '';   // $6 = lifecycle
    const agencyParams = params.slice(); agencyParams[2] = '';         // $3 = agency
    const setAsideParams = params.slice(); setAsideParams[4] = '';     // $5 = set_aside
    const byLifecycle = await pool.query(`SELECT coalesce(nullif(lifecycle,''),'?') AS v, count(*)::int AS n FROM gov_opportunities WHERE ${where} GROUP BY 1`, lifecycleParams);
    const byAgency = await pool.query(`SELECT coalesce(nullif(agency,''),'(unknown)') AS v, count(*)::int AS n FROM gov_opportunities WHERE ${where} GROUP BY 1 ORDER BY n DESC, v LIMIT 12`, agencyParams);
    const bySetAside = await pool.query(`SELECT coalesce(nullif(set_aside,''),'(blank)') AS v, count(*)::int AS n FROM gov_opportunities WHERE ${where} GROUP BY 1 ORDER BY n DESC, v`, setAsideParams);
    const stages = {};
    byStage.rows.forEach(r => { stages[r.stage] = r.n; });
    const lifecycles = {};
    byLifecycle.rows.forEach(r => { lifecycles[r.v] = r.n; });
    const a = agg.rows[0] || {}; const du = dueAgg.rows[0] || {};
    res.json({ total: a.total || 0, byStage: stages, no_bid: a.no_bid || 0, scored: a.scored || 0, recompete: a.recompete || 0, value_sum: Number(a.value_sum) || 0, archived_count: (archAgg.rows[0] && archAgg.rows[0].n) || 0, naics: naicsList.rows, setAside: setAsideList.rows, byLifecycle: lifecycles, byAgency: byAgency.rows, bySetAside: bySetAside.rows, due30: du.due30 || 0, due3060: du.due3060 || 0, due60: du.due60 || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/govops/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = []; const vals = [req.params.id]; let i = 1;
    if (b.stage !== undefined) { sets.push('stage=$' + (++i)); vals.push(String(b.stage)); }
    if (b.archived !== undefined) { sets.push('archived=$' + (++i)); vals.push(!!b.archived); }
    if (b.no_bid !== undefined) { sets.push('no_bid=$' + (++i)); vals.push(!!b.no_bid); sets.push('no_bid_at=now()'); }
    if (b.no_bid_reason !== undefined) { sets.push('no_bid_reason=$' + (++i)); vals.push(String(b.no_bid_reason || '')); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    await pool.query('UPDATE gov_opportunities SET ' + sets.join(',') + ', last_updated=now() WHERE id=$1', vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/govops/ingest', async (req, res) => {
  try { res.json(await govRunIngestion('manual')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// GovWin folder/CSV ingest — both the local sync script and the in-app
// index.csv upload POST opportunities here. Idempotent by GovWin id.
app.post('/api/govwin/ingest', async (req, res) => {
  try {
    if (!govwinIngestAuthed(req)) return res.status(401).json({ error: 'bad or missing ingest token' });
    const opps = (req.body && req.body.opportunities) || [];
    if (!Array.isArray(opps) || !opps.length) return res.status(400).json({ error: 'no opportunities provided' });
    const profile = await govProfile();
    const stats = { added: 0, updated: 0, skipped: 0 };
    for (const row of opps) {
      const gid = String(row.govwinId || row.GovWinID || '').trim();
      if (!gid) { stats.skipped++; continue; }
      await govwinUpsertById(gid, govwinCsvMap(row), profile, stats);
    }
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Per-opportunity extracted document text (from the local sync script).
app.post('/api/govwin/:govwinId/docs', async (req, res) => {
  try {
    if (!govwinIngestAuthed(req)) return res.status(401).json({ error: 'bad or missing ingest token' });
    const gid = String(req.params.govwinId || '').trim();
    if (!gid) return res.status(400).json({ error: 'missing govwinId' });
    const docs = (req.body && req.body.docs) || [];
    const crypto = require('crypto');
    let stored = 0;
    for (const d of docs) {
      const name = String(d.name || '').slice(0, 500);
      if (!name) continue;
      const id = 'gd_' + gid + '_' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 12);
      await pool.query(
        `INSERT INTO gov_opp_docs (id, govwin_id, name, kind, mime, sha, chars, extracted_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (govwin_id, name) DO UPDATE SET kind=$4, mime=$5, sha=$6, chars=$7, extracted_text=$8`,
        [id, gid, name, d.kind || '', d.mime || '', d.sha || '', Number(d.chars) || 0, String(d.text || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')]
      );
      stored++;
    }
    res.json({ stored });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Doc index for one opportunity (UI / Bid-No-Bid scoring later).
app.get('/api/govwin/:govwinId/docs', async (req, res) => {
  try {
    const r = await pool.query('SELECT name, kind, chars, created_at FROM gov_opp_docs WHERE govwin_id=$1 ORDER BY name', [String(req.params.govwinId || '')]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Full extracted text of one document (for the in-app document viewer).
app.get('/api/govwin/:govwinId/doctext', async (req, res) => {
  try {
    const r = await pool.query('SELECT name, kind, mime, chars, extracted_text FROM gov_opp_docs WHERE govwin_id=$1 AND name=$2', [String(req.params.govwinId || ''), String(req.query.name || '')]);
    if (!r.rows.length) return res.status(404).json({ error: 'document not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Manifest of every stored doc (govwin_id + name) so the in-app importer can
// skip files it already has and only upload new ones.
app.get('/api/govwin/docs-manifest', async (req, res) => {
  try { const r = await pool.query('SELECT govwin_id, name FROM gov_opp_docs'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// In-app GovWin document upload: the browser sends a raw RFP/RFI file (from the
// user's local Govwin folder); the server extracts text (PDF/DOCX/XLSX) and
// stores it in gov_opp_docs keyed by GovWin id — the same table the local sync
// tool and the doc viewer use. Binaries are NOT persisted, only extracted text.
app.post('/api/govwin/:govwinId/docfile', upload.single('file'), async (req, res) => {
  try {
    const gid = String(req.params.govwinId || '');
    const f = req.file;
    if (!gid || !f) return res.status(400).json({ error: 'missing govwin id or file' });
    const name = String((req.body && req.body.name) || f.originalname || 'document');
    const ext = (name.split('.').pop() || '').toLowerCase();
    let text = '';
    try {
      if (ext === 'pdf') { const pdfParse = require('pdf-parse'); const r = await pdfParse(f.buffer); text = String(r.text || ''); }
      else if (ext === 'docx' || ext === 'doc') { const mammoth = require('mammoth'); const r = await mammoth.extractRawText({ buffer: f.buffer }); text = String((r && r.value) || ''); }
      else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') { const XLSX = require('xlsx'); const wb = XLSX.read(f.buffer, { type: 'buffer' }); text = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n'); }
    } catch (e) { text = ''; }
    text = String(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').slice(0, 300000);
    const kind = /solicit|rfp|rfi|pws|sow|instruction|amend/i.test(name) ? 'solicitation' : 'attachment';
    const id = 'doc_' + require('crypto').createHash('sha1').update(gid + '|' + name).digest('hex').slice(0, 22);
    await pool.query(`INSERT INTO gov_opp_docs (id, govwin_id, name, kind, mime, sha, chars, extracted_text) VALUES ($1,$2,$3,$4,$5,'',$6,$7)
      ON CONFLICT (govwin_id, name) DO UPDATE SET kind=$4, mime=$5, chars=$6, extracted_text=$7`,
      [id, gid, name, kind, f.mimetype || '', text.length, text]);
    res.json({ ok: true, name, chars: text.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GovWin Bid/No-Bid AI scoring (Phase 2) ─────────────────────────────────
// Weighted 9-dimension rubric → composite 0–100 → band. The model returns a
// 0–5 score + justification per dimension; the composite is computed here so it
// stays explainable and isn't subject to model arithmetic drift.
const BID_WEIGHTS = { capabilityFit: 20, winProbability: 14, pastPerformance: 12, strategicAlignment: 12, customerRelationship: 10, eligibility: 10, teamingFit: 8, valueVsCapacity: 8, effortVsDeadline: 6 };
const BID_DIMS = Object.keys(BID_WEIGHTS);
function bidBand(score) { return score >= 70 ? 'Bid' : score >= 55 ? 'Likely Bid' : score >= 40 ? 'Review' : 'No-Bid'; }
function bidKnowledgeCtx(d) {
  const cp = (d && d.companyProfile) || {}, id = cp.identity || {}; const parts = [];
  parts.push('COMPANY: ' + (id.legalName || 'CommunityForce') + (id.naics && id.naics.length ? ' · NAICS ' + id.naics.join(', ') : '') + (id.ownershipType ? ' · ' + id.ownershipType : ''));
  const svc = (cp.services || []).map((s) => s.name + ((s.differentiators || []).length ? ' (' + s.differentiators.slice(0, 3).join('; ') + ')' : '')).filter(Boolean);
  if (svc.length) parts.push('SERVICES: ' + svc.join(' | ').slice(0, 1400));
  const diff = (cp.differentiators || []).filter(Boolean); if (diff.length) parts.push('DIFFERENTIATORS: ' + diff.join('; ').slice(0, 800));
  const wt = (cp.winThemes || []).map((w) => typeof w === 'string' ? w : (w && w.theme)).filter(Boolean); if (wt.length) parts.push('WIN THEMES: ' + wt.join('; ').slice(0, 600));
  const cs = (cp.caseStudies || []).slice(0, 12).map((c) => '- ' + (c.title || c.customer || '?') + (c.customer ? ' (' + c.customer + ')' : '') + (c.value ? ' $' + c.value : '') + (c.scope ? ': ' + String(c.scope).slice(0, 180) : '')); if (cs.length) parts.push('PAST PERFORMANCE / CASE STUDIES:\n' + cs.join('\n'));
  const partners = ((d && d.partnerBank) || []).slice(0, 15).map((p) => '- ' + (p.partnerName || 'Partner') + (p.summary ? ': ' + String(p.summary).slice(0, 160) : '')); if (partners.length) parts.push('TEAMING PARTNERS (available to fill gaps):\n' + partners.join('\n'));
  return parts.join('\n\n') || '(Company Profile is sparse — score with low confidence and flag the gaps.)';
}
async function bidDocExcerpt(gid, cap) {
  const r = await pool.query("SELECT name, kind, extracted_text FROM gov_opp_docs WHERE govwin_id=$1 ORDER BY (kind='solicitation') DESC, length(coalesce(extracted_text,'')) DESC", [gid]);
  let out = '', used = 0;
  for (const row of r.rows) {
    const t = String(row.extracted_text || '').trim(); if (!t || used >= cap) continue;
    const take = t.slice(0, Math.max(0, cap - used));
    out += '\n\n=== ' + (row.name || 'doc') + ' (' + (row.kind || '') + ') ===\n' + take; used += take.length;
  }
  return { text: out.trim(), docCount: r.rows.length, usedChars: used };
}
function bidParseJSON(text) {
  let s = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a > -1 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); }  // tolerate trailing commas
}
app.post('/api/govwin/:id/score', async (req, res) => {
  try {
    const oppId = String(req.params.id || '');
    const rr = await pool.query('SELECT * FROM gov_opportunities WHERE id=$1', [oppId]);
    if (!rr.rows.length) return res.status(404).json({ error: 'opportunity not found' });
    const opp = rr.rows[0];
    const gid = (opp.raw && opp.raw.govwinId) || oppId.replace(/^govwin_/, '');
    const prov = ((req.body && req.body.provider) || 'anthropic').toLowerCase();
    if (!LLM_PROVIDERS[prov]) return res.status(400).json({ error: 'Unknown provider: ' + prov });
    const apiKey = await resolveApiKey(prov, req.body && req.body.accountId);
    if (!apiKey) return res.status(400).json({ error: `No ${LLM_PROVIDERS[prov].label} API key configured. Set ${LLM_PROVIDERS[prov].envVar} or a personal key in Admin → Integrations.` });
    const stateR = await pool.query('SELECT data FROM app_state WHERE id=1');
    const d = (stateR.rows[0] && stateR.rows[0].data) || {};
    const knowledge = bidKnowledgeCtx(d);
    const ex = await bidDocExcerpt(gid, 45000);
    const oppBlock = 'OPPORTUNITY:\nTitle: ' + (opp.title || '') + '\nAgency: ' + (opp.agency || '') + (opp.sub_agency ? ' / ' + opp.sub_agency : '') + '\nNAICS: ' + (opp.naics || '?') + '\nSet-aside: ' + (opp.set_aside || '(none / full & open)') + '\nLifecycle: ' + (opp.lifecycle || '?') + '\nEst. value: ' + (opp.value_high ? ('$' + Number(opp.value_high).toLocaleString()) : '?') + '\nSolicitation date: ' + (opp.est_solicitation_date || '?') + '\nLink: ' + (opp.source_url || '');
    const docBlock = ex.text ? ('RFP/RFI DOCUMENT EXCERPTS (' + ex.docCount + ' doc(s), ' + Math.round(ex.usedChars / 1000) + 'K chars):\n' + ex.text) : 'RFP/RFI DOCUMENTS: none ingested — score on metadata only and lower the confidence accordingly.';
    const dimList = BID_DIMS.map((k) => '  "' + k + '": {"score": <0-5 integer>, "note": "<one concise sentence>"}').join(',\n');
    const sys = "You are a senior federal capture manager performing a Bid/No-Bid assessment for CommunityForce, a government IT/software services contractor. Judge how well THIS opportunity fits CommunityForce's capabilities, past performance, eligibility, and strategy. Be specific and skeptical — do not inflate scores. Use ONLY the provided materials; never invent past performance, certifications, or customer relationships. Respond with ONLY a JSON object — no prose, no code fences.";
    const instruction = 'Score the opportunity on each dimension 0–5 (0 = no fit / major risk, 5 = excellent fit) with a one-sentence justification grounded in the materials, then an overall rationale (2–4 sentences) and the top risks/unknowns.\n\nReturn EXACTLY this JSON shape:\n{\n"dimensions": {\n' + dimList + '\n},\n"rationale": "<2-4 sentences>",\n"risks": ["<risk>", "..."]\n}\n\nKeep each note under 18 words. Output ONLY the JSON object (minified is fine); never put unescaped double-quotes or line breaks inside string values.\n\nDimension meanings: capabilityFit=match to our services/NAICS/scope; pastPerformance=relevant prior work we can cite; eligibility=set-aside/clearance/qualification fit; customerRelationship=incumbency or prior work with this agency; winProbability=realistic chance vs competition/incumbent; valueVsCapacity=contract size right-sized for us; teamingFit=can a listed partner fill capability gaps; effortVsDeadline=proposal effort vs time available; strategicAlignment=fit to our growth strategy.\n\n=== CFORCE KNOWLEDGE ===\n' + knowledge + '\n\n=== ' + oppBlock + '\n\n' + docBlock;
    const params = { apiKey, model: req.body && req.body.model, system: sys, messages: [{ role: 'user', content: instruction }], max_tokens: 3000 };
    let json;
    if (prov === 'openai') json = await callOpenAI(params);
    else if (prov === 'google') json = await callGoogle(params);
    else json = await callAnthropic(params);
    const txt = (json.content && json.content[0] && json.content[0].text) || '';
    let parsed; try { parsed = bidParseJSON(txt); } catch (e) { return res.status(502).json({ error: 'Could not parse AI response as JSON: ' + e.message, raw: txt.slice(0, 1500) }); }
    const dims = parsed.dimensions || {};
    let composite = 0; const cleanDims = {};
    for (const k of BID_DIMS) { const ds = dims[k] || {}; const sc = Math.max(0, Math.min(5, Number(ds.score) || 0)); cleanDims[k] = { score: sc, note: String(ds.note || '').slice(0, 300) }; composite += (sc / 5) * BID_WEIGHTS[k]; }
    composite = Math.round(composite);
    const band = bidBand(composite);
    const risks = Array.isArray(parsed.risks) ? parsed.risks.map((r) => String(r).slice(0, 300)).slice(0, 8) : [];
    const rationale = String(parsed.rationale || '').slice(0, 2000);
    const usedModel = json.model || (req.body && req.body.model) || LLM_PROVIDERS[prov].defaultModel;
    await pool.query('UPDATE gov_opportunities SET bid_score=$2, bid_band=$3, bid_rationale=$4, bid_dims=$5, bid_risks=$6, bid_model=$7, bid_scored_at=now(), last_updated=now() WHERE id=$1',
      [oppId, composite, band, rationale, JSON.stringify(cleanDims), JSON.stringify(risks), String(usedModel)]);
    res.json({ id: oppId, bid_score: composite, bid_band: band, bid_dims: cleanDims, bid_rationale: rationale, bid_risks: risks, bid_model: usedModel, docCount: ex.docCount, usedChars: ex.usedChars });
  } catch (e) { console.error('bid score failed:', e.message); res.status(e.status || 500).json(e.body || { error: e.message }); }
});
// One-off pull of a single URL source (used by the Sources manager "Test now").
app.post('/api/govops/ingest-url', async (req, res) => {
  try {
    const src = req.body || {};
    if (!src.url) return res.status(400).json({ error: 'url required' });
    const profile = await govProfile();
    const stats = { fetched: 0, added: 0, updated: 0 };
    const errors = [];
    await urlSourceIngest(src, profile, stats, errors);
    await pool.query('INSERT INTO ingestion_runs (source, trigger_kind, finished_at, fetched, added, updated, errors) VALUES ($1,$2,now(),$3,$4,$5,$6)',
      [src.name || src.url, 'url-test', stats.fetched, stats.added, stats.updated, JSON.stringify(errors)]);
    res.json({ ...stats, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
// Parse an uploaded subscription-client spreadsheet (XLSX/CSV) into normalized
// rows. Stateless — returns the parsed clients + totals; the client stores them
// on the project. Auto-detects the header row and maps common column names.
app.post('/api/subclients/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    if (!aoa.length) return res.status(400).json({ error: 'Empty spreadsheet' });
    // Find the header row (first row that has an "account" and a "value/amount/arr/revenue" column) within the first 15 rows.
    let hi = -1;
    for (let i = 0; i < Math.min(aoa.length, 15); i++) {
      const cells = aoa[i].map((c) => String(c).toLowerCase());
      if (cells.some((c) => c.includes('account')) && cells.some((c) => /value|amount|arr|revenue/.test(c))) { hi = i; break; }
    }
    if (hi < 0) hi = 0;
    const headers = aoa[hi].map((c) => String(c).trim());
    const findCol = (re) => headers.findIndex((h) => re.test(h));
    const ci = {
      account: findCol(/account|client|customer|organi/i),
      product: findCol(/product/i),
      renewalDate: findCol(/renewal\s*date|renew/i),
      renewalYear: findCol(/renewal\s*year|year/i),
      value: findCol(/total\s*opp|value|amount|arr|revenue/i),
      country: findCol(/country/i),
    };
    if (ci.account < 0 || ci.value < 0) return res.status(400).json({ error: 'Could not find the "Account Name" and "Total Opp Value" columns. Expected a header row with those columns.' });
    const toDate = (v) => {
      if (v === '' || v == null) return '';
      if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); if (d) return [d.y, String(d.m).padStart(2, '0'), String(d.d).padStart(2, '0')].join('-'); }
      const dt = new Date(v); return isNaN(dt.getTime()) ? String(v) : dt.toISOString().slice(0, 10);
    };
    const clients = []; let total = 0;
    for (const row of aoa.slice(hi + 1)) {
      const account = String(row[ci.account] || '').trim();
      if (!account) continue;
      const value = Number(String(row[ci.value]).replace(/[$,\s]/g, '')) || 0;
      total += value;
      clients.push({
        account,
        product: ci.product >= 0 ? String(row[ci.product] || '').trim() : '',
        renewalDate: ci.renewalDate >= 0 ? toDate(row[ci.renewalDate]) : '',
        renewalYear: ci.renewalYear >= 0 ? String(row[ci.renewalYear] || '').trim() : '',
        value,
        country: ci.country >= 0 ? String(row[ci.country] || '').trim() : '',
      });
    }
    if (!clients.length) return res.status(400).json({ error: 'No client rows found under the header.' });
    res.json({ clients, total, count: clients.length, monthly: Math.round(total / 12) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parse a contract STAFFING workbook (e.g. BCLM OY2/OY3) into a self-contained
// contract object: positions (one row per resource), pricing (CLINs), funding
// targets, and funding scenarios. Stateless — the client stores it in D.contracts.
app.post('/api/contracts/parse-staffing', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const sheetByName = (re) => wb.SheetNames.find((n) => re.test(n));
    const aoaOf = (name) => name ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true }) : [];
    const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isNaN(n) ? 0 : n; };
    const findHeader = (aoa, mustHave) => { for (let i = 0; i < Math.min(aoa.length, 8); i++) { const cells = aoa[i].map((c) => String(c).toLowerCase()); if (mustHave.every((re) => cells.some((c) => re.test(c)))) return i; } return -1; };

    // ── Positions: read each staffing sheet, tagging rows with their option year. ──
    // Handles BOTH the normalized "Resource Assignments" layout (one row per named
    // resource) and the "requirements" layout (Role + Quantity, names in Comments).
    function extractPositions(aoa) {
      if (!aoa || !aoa.length) return [];
      const title = aoa.slice(0, 3).map((r) => r.join(' ')).join(' ');
      const oyM = title.match(/option year\s*(\d)|\bOY\s*(\d)/i);
      const oy = oyM ? ('OY' + (oyM[1] || oyM[2])) : '';
      let hi = -1;
      for (let i = 0; i < Math.min(aoa.length, 8); i++) {
        const cells = aoa[i].map((c) => String(c).toLowerCase());
        if (cells.some((c) => /workstream/.test(c)) && cells.some((c) => /role|title/.test(c)) && cells.some((c) => /\bfte\b|^fte|quantity|\bqty\b/.test(c))) { hi = i; break; }
      }
      if (hi < 0) return [];
      const hg = aoa[hi].map((c) => String(c).toLowerCase());
      const col = (re, exclude) => { for (let i = 0; i < hg.length; i++) { if (re.test(hg[i]) && i !== exclude) return i; } return -1; };
      const ciGroup = col(/workstream group/);
      const ciAssigned = col(/assigned resource|resource name/);   // explicit named-resource column ⇒ assignments layout
      const ci = {
        group: ciGroup, workstream: col(/workstream/, ciGroup),
        resource: ciAssigned >= 0 ? ciAssigned : col(/^resource|comments|named|incumbent/),
        role: col(/role|title/), fte: col(/\bfte\b|^fte|quantity|\bqty\b/),
        company: col(/company/), lcat: col(/lcat/), rate: col(/rate/),
        annual: col(/annual\s*cost|annual/), lead: col(/civilian lead|^lead/), pws: col(/pws/),
        desc: col(/full description|description/),
      };
      const requireResource = ciAssigned >= 0;   // assignments: each row needs a named resource; requirements: needs a role
      const out = []; let lastGroup = '';
      for (const row of aoa.slice(hi + 1)) {
        const grp = ci.group >= 0 ? String(row[ci.group] || '').trim() : '';
        if (grp) lastGroup = grp;
        const resource = ci.resource >= 0 ? String(row[ci.resource] || '').trim() : '';
        const role = ci.role >= 0 ? String(row[ci.role] || '').trim() : '';
        const ws = ci.workstream >= 0 ? String(row[ci.workstream] || '').trim() : '';
        // Some sheets stack a SECOND table lower down with a different column layout
        // (e.g. the OY2 "adds" block where col positions shift). Stop at that
        // re-declared header so we don't read rates into the resource column.
        const lc = row.map((cell) => String(cell).toLowerCase());
        if (lc.some((cell) => /rate\s*\/\s*hr|feai lcat|resource\s*\/\s*service|monthly burn/.test(cell))) break;
        if (/^fte$/i.test(role) || /^fte$/i.test(resource)) continue;   // section FTE-total marker row
        if (/subtotal|grand total|^total\b/i.test(resource) || /subtotal|grand total/i.test(ws) || /subtotal|grand total/i.test(role)) continue;
        if (requireResource ? !resource : (!role && !resource)) continue;
        const fte = ci.fte >= 0 ? num(row[ci.fte]) : 0;
        const rateHr = ci.rate >= 0 ? num(row[ci.rate]) : 0;
        let annual = ci.annual >= 0 ? num(row[ci.annual]) : 0;
        if (!annual && rateHr && fte) annual = Math.round(rateHr * fte * 1860);
        const status = /\b(tbh|tbd|tbc|tbb|to be|placeholder|open)\b/i.test(resource) ? 'TBH' : (/reserve/i.test(resource) ? 'Reserve' : (resource ? 'Filled' : 'TBH'));
        out.push({
          oy, workstreamGroup: lastGroup || ws, workstream: ws, resource: resource || '(TBH)', role, fte,
          company: ci.company >= 0 ? String(row[ci.company] || '').trim() : '',
          lcat: ci.lcat >= 0 ? String(row[ci.lcat] || '').trim() : '',
          rateHr, annualCost: annual,
          civilianLead: ci.lead >= 0 ? String(row[ci.lead] || '').trim() : '',
          pwsRef: ci.pws >= 0 ? String(row[ci.pws] || '').trim() : '', status, notes: '',
          description: ci.desc >= 0 ? String(row[ci.desc] || '').trim() : '',
        });
      }
      return out;
    }
    const posSheets = [];
    const oy3a = sheetByName(/resource assignments/i); if (oy3a) posSheets.push(oy3a);
    const oy2s = sheetByName(/oy2.*staffing/i); if (oy2s) posSheets.push(oy2s);
    if (!posSheets.length) { const s = sheetByName(/staffing/i); if (s) posSheets.push(s); }
    let positions = [];
    posSheets.forEach((sn) => { positions = positions.concat(extractPositions(aoaOf(sn))); });
    const titleBlob = (aoaOf(posSheets[0] || '').slice(0, 3).map((r) => r.join(' ')).join(' '));
    const byOy = []; positions.forEach((p) => { if (p.oy && byOy.indexOf(p.oy) < 0) byOy.push(p.oy); });

    // ── Descriptions: the assignments sheet has none, so build a lookup from the
    // "Role Descriptions" sheet (keyed by OY + workstream + role, with fallbacks)
    // and fill in any position missing a description. ──
    const descMap = {};
    const rdA = aoaOf(sheetByName(/role descriptions/i));
    const rhi = findHeader(rdA, [/workstream/, /full description|description/]);
    if (rhi >= 0) {
      const hg = rdA[rhi].map((c) => String(c).toLowerCase());
      const col = (re, ex) => { for (let i = 0; i < hg.length; i++) { if (re.test(hg[i]) && i !== ex) return i; } return -1; };
      const wsg = col(/workstream group/);
      const rc = { oy: col(/option year|^oy\b/), ws: col(/workstream/, wsg), role: col(/role|title/), desc: col(/full description|description/) };
      const norm = (s) => String(s || '').trim().toLowerCase();
      for (const row of rdA.slice(rhi + 1)) {
        const d = rc.desc >= 0 ? String(row[rc.desc] || '').trim() : ''; if (!d) continue;
        const oy = rc.oy >= 0 ? norm(row[rc.oy]) : '', ws = rc.ws >= 0 ? norm(row[rc.ws]) : '', role = rc.role >= 0 ? norm(row[rc.role]) : '';
        if (!ws) continue;
        [oy + '|' + ws + '|' + role, oy + '|' + ws, '*|' + ws + '|' + role, '*|' + ws].forEach((k) => { if (!descMap[k]) descMap[k] = d; });
      }
    }
    positions.forEach((p) => {
      if (p.description) return;
      const oy = String(p.oy || '').trim().toLowerCase(), ws = String(p.workstream || '').trim().toLowerCase(), role = String(p.role || '').trim().toLowerCase();
      p.description = descMap[oy + '|' + ws + '|' + role] || descMap[oy + '|' + ws] || descMap['*|' + ws + '|' + role] || descMap['*|' + ws] || '';
    });

    // ── Pricing (CLINs by option year) ──
    const pricing = [];
    const prA = aoaOf(sheetByName(/pricing/i));
    const phi = findHeader(prA, [/clin|cost element/, /amount/]);
    if (phi >= 0) {
      const hg = prA[phi].map((c) => String(c).toLowerCase());
      const col = (re) => hg.findIndex((c) => re.test(c));
      const pc = { period: col(/period/), pop: col(/pop/), clin: col(/clin/), element: col(/element/), orig: col(/original/), revised: col(/revised/), notes: col(/notes/) };
      let lastPeriod = '', lastPop = '';
      for (const row of prA.slice(phi + 1)) {
        const period = pc.period >= 0 ? String(row[pc.period] || '').trim() : '';
        if (period) lastPeriod = period;
        const pop = pc.pop >= 0 ? String(row[pc.pop] || '').trim() : '';
        if (pop) lastPop = pop;
        const element = pc.element >= 0 ? String(row[pc.element] || '').trim() : '';
        const clin = pc.clin >= 0 ? String(row[pc.clin] || '').trim() : '';
        if (!element && !clin) continue;
        pricing.push({ period: lastPeriod, pop: lastPop, clin, element, original: pc.orig >= 0 ? num(row[pc.orig]) : 0, revised: pc.revised >= 0 ? num(row[pc.revised]) : 0, notes: pc.notes >= 0 ? String(row[pc.notes] || '').trim() : '' });
      }
    }

    // ── Funding targets (floor / baseline / target) from the spend-justification sheet ──
    const funding = {};
    const fjA = aoaOf(sheetByName(/justification|spend/i));
    for (const row of fjA) {
      const label = String(row[0] || '').toLowerCase();
      const lastNum = row.reduce((acc, c) => { const n = num(c); return n ? n : acc; }, 0);
      if (!lastNum) continue;
      if (/floor/.test(label) && !funding.floor) funding.floor = lastNum;
      else if (/baseline/.test(label) && !funding.baseline) funding.baseline = lastNum;
      else if (/funding target/.test(label) && !funding.target) funding.target = lastNum;
      else if (/combined/.test(label) && !funding.combined) funding.combined = lastNum;
    }

    // ── Funding scenarios (A/B/C comparison) ──
    const scenarios = [];
    const scA = aoaOf(sheetByName(/funding scenario|scenario/i));
    const shi = findHeader(scA, [/scenario a|dimension/]);
    if (shi >= 0) {
      for (const row of scA.slice(shi + 1)) {
        const dim = String(row[0] || '').trim();
        if (!dim) continue;
        scenarios.push({ dimension: dim, a: String(row[1] || '').trim(), b: String(row[2] || '').trim(), c: String(row[3] || '').trim(), notes: String(row[4] || '').trim() });
      }
    }

    const numberMatch = titleBlob.match(/\bFA\w{10,}\b/) || (prA.length ? prA.map((r) => r.join(' ')).join(' ').match(/\bFA\w{10,}\b/) : null);
    res.json({
      name: (req.body && req.body.name) || 'BCLM',
      number: numberMatch ? numberMatch[0] : '',
      positions, pricing, funding, scenarios, byOy,
      count: positions.length,
      totalFTE: Math.round(positions.reduce((a, p) => a + (Number(p.fte) || 0), 0) * 100) / 100,
      totalAnnual: positions.reduce((a, p) => a + (Number(p.annualCost) || 0), 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Whether GovWin env vars are present (booleans only — never returns the values).
app.get('/api/govops/govwin-status', (req, res) => {
  const missing = govwinConfigured();
  res.json({ configured: missing.length === 0, missing });
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
