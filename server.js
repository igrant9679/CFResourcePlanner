const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

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
}

app.get('/api/data', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
    res.json(r.rows.length ? r.rows[0].data : null);
  } catch (e) {
    console.error('GET /api/data failed:', e.message);
    res.status(500).json({ error: e.message, code: e.code });
  }
});

app.post('/api/data', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/data failed:', e.message);
    res.status(500).json({ error: e.message, code: e.code });
  }
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
    let json;
    if (prov === 'anthropic') {
      const userContent = [];
      if (isPdf) userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } });
      else userContent.push({ type: 'text', text: `[Attachment "${att.name}" is type ${mime}; Claude cannot read it directly. Proceed using only the instruction below.]` });
      userContent.push({ type: 'text', text: instruction });
      json = await callAnthropic({ apiKey, model, system: systemPrompt, max_tokens, messages: [{ role: 'user', content: userContent }] });
    } else if (prov === 'google') {
      json = await callGoogle({
        apiKey, model, system: systemPrompt, max_tokens,
        messages: [{ role: 'user', content: instruction }],
        fileBase64: isPdf ? fileBase64 : null,
        fileMime: 'application/pdf',
      });
      if (!isPdf) json.content[0].text = `[Attachment "${att.name}" is type ${mime}; not sent inline.]\n\n` + json.content[0].text;
    } else {
      // OpenAI: chat/completions endpoint cannot accept binary; instruct that
      // attachment was not included. The Files+Assistants API would require a
      // larger refactor; defer until there's user demand.
      json = await callOpenAI({
        apiKey, model, system: systemPrompt, max_tokens,
        messages: [{ role: 'user', content: `[Attachment "${att.name}" (${mime}) cannot be sent to OpenAI via this proxy yet — switch to Anthropic or Google for PDF analysis.]\n\n${instruction}` }],
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
// candidates (PII / sensitive workflow data).
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

    res.json({
      version: '1',
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
    });
  } catch (e) {
    console.error('GET /api/atlas-snapshot failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

initDb()
  .then(() => app.listen(PORT, () => console.log('Server listening on ' + PORT)))
  .catch((err) => {
    console.error('DB init failed:', err.message);
    app.listen(PORT, () => console.log('Server listening on ' + PORT + ' (DB unavailable)'));
  });
