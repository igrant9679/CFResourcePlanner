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
        await pool.query('DELETE FROM app_state_history WHERE id NOT IN (SELECT id FROM app_state_history ORDER BY id DESC LIMIT 300)');
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
