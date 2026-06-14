# Atlas — CommunityForce Resource Planner · Project Handoff

A single-page workforce / resource-planning + AI-assisted proposal-authoring app
for CommunityForce. Org chart, projects, initiatives, opportunities, overhead,
allocations, recruiting, proposals, COE plan, and project tasks — all in one
Postgres-backed SPA. Now syncs read-only into the **LevelUp Second Brain** app.

This document is everything you need to continue the project from a new machine
or a new AI session.

> Paste this whole file into a new session's first message (or open it in the
> repo) to bring the assistant up to speed.

---

## 0. Latest session state (2026-06-14) — READ FIRST

### ⚠️ Open / in-progress
- **C1FAMS (Leidos) was accidentally deleted from prod — RESTORED 2026-06-14**
  via API from `_backups/atlas-prod-20260614-092458.json`, with the corrected
  end-Sep model: id `p_c1fams`, **project**, revenue **$25,984/mo, start `2026-06`,
  end `2026-09`** (active Jun→Sep 24, $0 from Oct), single timeline segment, 4
  CLINs preserved. Allocations re-linked automatically (Ande Bhasker 40% sched,
  Asif Ahmed Rather 100%, Yasir Arfath Farooqie 100%) because they live on the
  people's `allocSchedule` (projectId `p_c1fams`), not the project. Contract cost
  line is $25,000/mo (near-breakeven, 2 resources). Done — no action needed.
- **Debt-service override not yet set on prod.** The Cash-gate "Debt service /mo"
  field (Capacity → Projections → 💵 Cash gate) now persists to
  `D.proforma.financials.debtServiceOverride` (read by `capFixedBurden`). The
  computed $15,360 = SBA $9,860 (ALSO in Overhead → double-counted) + Fairfax
  $5,500 (not in Overhead). Recommended value **$5,500** (drops the SBA
  double-count, keeps Fairfax) or **$0** if Fairfax/Sterling get added to Overhead.
- **Lost data, NOT recoverable:** the user's "Fibretek" + "Xcelerate" opportunities
  (added ~June 13) are absent from prod AND from all 14 days of server history —
  a stale-tab overwrite or a save that never persisted. Re-create if still needed.

### 🛑 Data-loss hazard (recurring — warn the user)
Multiple/stale browser tabs overwrite each other. **Keep ONE tab; reload before
editing.** Server keeps ~14 days of snapshots: `GET /api/history` (index) +
`GET /api/history/:id` (payload); restore by POSTing a payload to
`/api/data?force=1`. Local point-in-time backups this session are in `_backups/`.

### 🔧 Assistant protocol for editing PROD data directly
`GET /api/data` (capture the `X-Atlas-Updated-At` response header) → modify the
JSON → `POST /api/data` with header `X-Atlas-Base-Updated-At: <that stamp>`.
Always save a backup to `_backups/` first. A 200 means no concurrent write landed.

### ✅ Shipped this session (all live on `main`/Railway; latest commit `4598c9d`)
- **Strategy break-even suite:** no-negative-operating-profit guardrail + per-month
  red/green strip; **cost-to-restore ladder** (Tier 1 discretionary/subs → Tier 2
  non-billable W2 → Tier 3 non-billable contractor → Tier 4 deferrable initiatives;
  billable-project labor NEVER cut; debt excluded — it's below the operating line);
  **slip simulator**; **trigger register**; **Break-even sub-tab** with a full
  recommendation breakdown + **cut simulator** (`_stratCutLevers`/`_stratCutSel`).
- **Forecast model — option B:** bench/unallocated labor now counts as cost (Other
  payroll) **until furloughed** (`furloughDate`); `_capNotYetStarted` excludes
  future hires before their first allocation. `capBuildRoster` carries
  `contractor` + `furloughDate`. Big behavior change vs the old "unallocated = $0".
- **Capacity → Projections:** every $ is a drill-down link (`capDrill(y,m,metric)`).
- **Initiatives:** List ↔ **Detail** sub-tab (`renderInitiativesView`, dropdown
  deep-dive) with financials/scorecard, source (self/partner-led), strategic +
  market relevance, exec summary, people, proposals, milestones, and
  **linked opportunities** (`o.initiativeIds[]`, editable both sides; pipeline-impact rollup).
- **Branding:** rebuilt Atlas logo (inline SVG) on login + header, favicon,
  "Operating System" wording.
- **Nav order:** Proforma · Strategy · Capacity Planning · Resource Planning ·
  Projects · Initiatives · Opportunities · Proposals · Overhead · Resources ·
  Reports · Recruiting · COE Tasks · Project Tasks · Org Chart. (COE Plan→COE Tasks.)
- **Contracts:** FAMS + C1FAMS both **end Sep 24, 2026** (C1FAMS no longer ramps to
  $100K). Contract-end milestones added.
- **Proforma cleanup:** removed the stale **Scenarios tab** + V4 forecast-scenario
  selector (cash trajectory now always base); **Pipeline tab → "Marines"** (static
  Federal-pipeline table removed, Marines DD577 detail kept). Contracts tab KEPT
  (it's the live time-phased contract-revenue editor). **Proforma table rows now
  carry `id`** (`pfRowIdsBackfilled`) so the 3-way merge stops resurrecting deleted
  rows. "Unallocated Resources" re-categorized initiative→**overhead** (parked
  people are now Tier-2 non-billable, not a deferrable investment).

### Note on the Jun–Sep negative operating margin
It's **structural / pre-existing**, not caused by this session's engine changes
(option B added only ~$2.5K/mo of bench). Driver: ~$82K/mo of **non-billable
labor** — Management + Phoenix 2 / Salesforce / Tableau practice investments +
the Unallocated Resources parking bucket. The new break-even guardrail simply
**surfaces** these long-negative months for the first time.

### Working norms / verify loop
No build step — edit `index.html`/`server.js`, syntax-check the inline `<script>`
with `node --check`-style parse, `npm test` (24 tests, marker-delimited pure
logic), preview-verify (set `sessionStorage cf_auth='1'`), commit (`git commit -F`
temp file + Co-Authored-By trailer), push to `main` (deploys ~1-3 min), confirm
live. Push cadence: fine to commit+push+verify per change during active iteration.

---

## 1. Quick Facts

| Thing | Value |
|-------|-------|
| App name | **Atlas** (CommunityForce Resource Planner) |
| Live URL | https://cfresourceplanner-production.up.railway.app |
| GitHub repo | https://github.com/igrant9679/CFResourcePlanner |
| Default branch | `main` |
| Hosting | Railway (auto-deploys from `main`) |
| Database | Railway PostgreSQL |
| Stack | Node.js + Express (`server.js`) serving a single static `index.html` |
| Login (app gate) | user: `khaja@communityforce.com` · pass: `Namtra_CF27` |
| Anthropic key env | `ANTHROPIC_API_KEY` (org-wide; per-user override on each account) |
| OpenAI key env | `OPENAI_API_KEY` (optional) |
| Google Gemini key env | `GOOGLE_API_KEY` (optional) |
| Atlas → LevelUp sync token | `ATLAS_SYNC_TOKEN` (must match the LevelUp Railway env var) |

The login is a **client-side gate only** (defined in `index.html`, stored in
`sessionStorage`). It keeps casual visitors out but is visible in page source
and does not protect the API. Treat it as a soft gate, not real security.

### Sister app: LevelUp Second Brain

LevelUp is the user's separate productivity / second-brain web app, deployed
independently. Atlas exposes a read-only snapshot endpoint that LevelUp
mirrors into a dedicated page so the user can see Atlas data, annotate items,
and spawn LevelUp notes / journal entries / tasks linked back to Atlas
objects — all without writing back to Atlas.

| LevelUp Thing | Value |
|---|---|
| App name | **LevelUp Second Brain** |
| Live URL | https://levelupnow.tools |
| GitHub repo | https://github.com/igrant9679/levelup-second-brain |
| Local clone | `C:\Users\saqib\Documents\levelup-second-brain` |
| Stack | React 19 + Vite + TypeScript + Tailwind + tRPC + Drizzle ORM + MySQL |
| Hosting | Railway (separate project from Atlas), `pnpm install --frozen-lockfile` build, `drizzle-kit migrate` runs at boot |
| Real UI lives in | `client/index.html` (shell) + `client/public/js/app-part1.js` (~12k lines) + `client/public/js/app-part2.js` (~11k lines) |
| Atlas integration code | `server/routers/atlas.ts` (tRPC), `server/_core/atlasAdapter.ts` (pull helper) |
| Atlas Page in LevelUp | `s-atlas` screen, sidebar entry "Atlas" with sky-blue icon |
| LevelUp env vars for Atlas | `ATLAS_SYNC_URL=https://cfresourceplanner-production.up.railway.app` and `ATLAS_SYNC_TOKEN=<must match Atlas>` |

LevelUp pulls Atlas hourly via its existing `externalTasksCron` (extended to
call `processAtlasPull()` once per pass) and stores the snapshot in
`user_app_data.atlas` per-user. Per-user annotations live in
`user_app_data.atlasAnnotations` (migration `0044`).

---

## 2. Repository Layout

```
CFResourcePlanner/
├── index.html        ← THE ENTIRE FRONT-END APP (HTML + CSS + JS in one file)
├── server.js         ← Express backend (static serving + /api endpoints)
├── package.json      ← deps: express, pg, multer, mammoth, pdf-parse, xlsx
├── package-lock.json
├── .gitignore        ← node_modules/, *.log
├── brand/            ← generated logo assets (atlas-logo-*.png, favicon.ico, favicon-256.png)
└── PROJECT_HANDOFF.md ← this file
```

Almost all app logic lives in **`index.html`** (the `<script>` block, ~5,800
lines). The data object is the global `D`. There is no build step — edit the
file, commit, push, done.

---

## 3. GitHub

- Repo: `igrant9679/CFResourcePlanner`, branch `main`.
- No CI; pushing to `main` is what triggers a Railway deploy.
- Git identity on the working machine:
  ```bash
  git config user.name "Idris Grant"
  git config user.email "idris.grant@gmail.com"
  ```
- To work on a new computer:
  ```bash
  git clone https://github.com/igrant9679/CFResourcePlanner
  cd CFResourcePlanner
  npm install
  ```

---

## 4. Railway (Hosting)

- A Railway **project** contains two services: the **app** (this repo) and
  **Postgres**.
- The app service is connected to GitHub and **auto-deploys on every push to
  `main`**. Deploys take ~1–3 minutes.
- Start command: `npm start` → `node server.js`. Railway provides `PORT` via env.
- Public domain: `cfresourceplanner-production.up.railway.app` (Railway-generated).

### Environment variables (Atlas Railway service)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` reference to the sibling Postgres |
| `ANTHROPIC_API_KEY` | Org-wide Claude key (per-user override available in Admin → Integrations) |
| `OPENAI_API_KEY` | Optional org-wide OpenAI key |
| `GOOGLE_API_KEY` | Optional org-wide Google Gemini key |
| `ATLAS_SYNC_TOKEN` | Bearer token required by `/api/atlas-snapshot`; must match LevelUp's env var |

### Database connection wiring

The app reads `process.env.DATABASE_URL`. This is **not** hard-coded — it's a
Railway **variable reference**. On the app service → **Variables**, there is:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
```

This resolves to the internal address `postgres.railway.internal:5432` (no SSL
needed). `server.js` auto-detects SSL: it uses SSL only if the URL is NOT a
`railway.internal` or `localhost` host. If you ever switch to the **public**
Postgres URL, SSL turns on automatically.

If a fresh deploy ever shows "Offline — using local copy" in the app header, it
means `DATABASE_URL` isn't reaching the app service — re-add the variable
reference (or drag a connection from Postgres to the app on the Railway canvas)
and redeploy.

---

## 5. Database (PostgreSQL)

Tables are auto-created on server boot (`initDb()` in `server.js`):

```sql
-- Single-row blob holding the entire app state
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Uploaded files (stored as binary, NOT in the JSON blob)
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  name TEXT,
  mime TEXT,
  size INTEGER,
  data BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Knowledge Bank: past proposals + capability/reference docs the Proposal
-- Generator pulls from. Heavy extracted_text + original binary live HERE, not
-- in app_state — only lightweight metadata mirrors into D.knowledgeBank.
CREATE TABLE knowledge_docs (
  id TEXT PRIMARY KEY,
  name TEXT,
  doc_type TEXT,
  mime TEXT,
  size INTEGER,
  extracted_text TEXT,
  data BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Server-side text extraction (`extractDocText` in `server.js`): DOCX→`mammoth`,
PDF→`pdf-parse`, XLSX/XLS→`xlsx` (SheetJS, per-sheet CSV), TXT/MD/CSV→utf8.
Lazy/guarded requires so the server still boots if a dep is missing.

- All app data lives in `app_state` row `id = 1` as one JSON document.
- File attachments live in `attachments` (binary), referenced from items by
  `{id, name, url, type:'file', size}`.
- **Backups:** the app has Export / Import buttons that download / restore the
  full JSON. Use Export periodically. (Attachments are not in the JSON export —
  they're in the `attachments` table only.)

### Server-side guardrail against array wipes

`POST /api/data` refuses any save where a **protected array** would shrink
from N>0 records to 0 (shipped 2026-05-30 after a recruiting-data-loss
incident). Returns HTTP 409 with a structured error body; client toasts the
user and offers to reload from server. Bypass with `?force=1` (used by
Reset/Import flows).

Protected arrays: `departments`, `projects`, `activities`, `recruitings`,
`candidates`, `proposals`, `proposalTemplates`, `corporateCertifications`,
`taskTemplates`, `programs`, `accounts`, `knowledgeBank`, `resumeBank`.

To get DB credentials on a new machine: Railway dashboard → **Postgres
service** → **Variables** (or **Connect** tab) → copy `DATABASE_URL` /
`DATABASE_PUBLIC_URL`.

---

## 6. API Endpoints (server.js)

### Core data + attachments
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/data` | Returns the app JSON (or `null` if empty) |
| POST | `/api/data` | Upserts the app JSON; guardrail rejects array-to-zero shrinks |
| POST | `/api/attachments` | Multipart upload (field `file`, max 25 MB) → `{id,name,url,...}` |
| GET | `/api/attachments/:id` | Stream/download a stored file |
| DELETE | `/api/attachments/:id` | Delete a stored file |
| GET | `/` | Serves `index.html` |

### Knowledge Bank (proposal sources)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/knowledge` | Multipart upload (field `file`, body `docType`) → extract text → returns `{id,name,mime,size,chars,text}` |
| POST | `/api/knowledge/text` | Add a pasted text source `{name,docType,text}` |
| GET | `/api/knowledge` | List metadata (no text body) |
| GET | `/api/knowledge/:id` | One doc's full `extracted_text` (used at generation time) |
| GET | `/api/knowledge/:id/raw` | Download/preview the original binary |
| DELETE | `/api/knowledge/:id` | Delete a knowledge doc |

### LLM proxy (multi-provider)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/llm/status` | Backward-compat: does Anthropic env key exist? |
| GET | `/api/llm/providers` | Per-provider status: `{anthropic:{...},openai:{...},google:{...}}` |
| POST | `/api/llm/complete` | Multi-provider chat completion. Body: `{accountId, provider, model, system, messages, max_tokens}`. Normalizes response to Anthropic shape `{content:[{type:'text',text}], usage, model, provider}` so client parsers work across all three. Falls back to `anthropic` if `provider` omitted. |
| POST | `/api/llm/with-attachment` | Same idea but injects an attachment (PDF) into the message. Anthropic uses `document` content blocks; Google uses inline_data; OpenAI falls back to text-only with a note. |

Key resolution per provider: per-user override on `D.accounts[i].apiKey` (and
`apiKey_openai`, `apiKey_google`) wins; otherwise the env var
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY`).

### LevelUp sync feed
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/atlas-snapshot` | Bearer-token-protected read-only JSON snapshot. Required header: `Authorization: Bearer <ATLAS_SYNC_TOKEN>`. Excludes `accounts`, `notifications`, `recruitings`, `candidates` for safety. Includes `proposals`, `companyProfile`, `corporateCertifications` (added in v2). |

---

## 7. Front-end Data Model (global `D` in index.html)

```
D = {
  /* ── Lookup lists ── */
  skillsets: [{id,name}], certifications:[], locations:[], clearances:[],
  pastProjects:[], pastClients:[],

  /* ── Projects (all categories) — see §7c, §7d ── */
  projects: [
    { id, name, category /* project|initiative|opportunity|overhead */,
      revenue, targetRevenue, revenueNote,
      description, attachments:[...], parentId,
      // Project category — has CLINs:
      clins: [ { id, number, title, revenue ($/mo), notes } ],
      // Opportunity category only:
      customer, leadGen, presales, sales, delivery, opr, pm, team,
      stage, status, potential ($/yr), closeDate, comment, changeRequested }
  ],

  /* ── Org chart ── */
  departments: [
    { id, name, subtitle, accent, parentId,
      members: [
        { id, name, role, cost, badge, reportsTo (name string),
          projects:[{id, pct, clinId?}],
          skillsets:[id], certifications:[id],
          location, clearance,
          hub, sme, associate, proposal, recruiter,  /* classification flags */
          note, reassess, resumeLink,
          attachments:[...], pastProjects:[], pastClients:[] }
      ] }
  ],

  /* ── COE Plan (formerly "120-Day Plan") + Project Tasks — see §7a ── */
  programs: [ { id, name, color, order, lead } ],
  activities: [
    { id, kind ('coe'|'project'), programId, program, task, subtask,
      outline, objective, phase, start, dueDate, isMilestone,
      status ('todo'|'doing'|'done'|'blocked'),
      parentId, owners:[memberId], ownerText, projectId, pm, order,
      templateId,  /* if spawned from a Task Template (Workflow on Opportunities) */
      updates:[...], attachments:[...] }
  ],
  planStart: "2026-06-01",

  /* ── Accounts / roles (client-side only) — see §7b ── */
  accounts: [
    { id, email, name, password, role, programIds:[id], memberId, active,
      apiKey,          /* Anthropic personal override */
      apiKey_openai, apiKey_google,
      defaultLlmProvider, defaultLlmModel } ],
  sectionVis: { owner:{...}, editor:{...}, viewer:{...} },

  /* ── Task Templates — admin-managed repeatable tasks ── */
  taskTemplates: [{id, name}],   /* seed: Lead Generation, Business Development,
                                     Scoping, Proposal Development, Recruiting,
                                     Oversee Delivery */

  /* ── Recruiting module — see §7f ── */
  recruitings: [
    { id, taskId,                        /* optional FK to a Perform Recruiting activity */
      projectId, departmentId,           /* parent (opp/project/dept) */
      busDevId, pmId,                    /* member IDs */
      jdTitle, jdDescription (rich HTML), jdAttachments:[...],
      status ('open'|'on-hold'|'filled'|'cancelled'),
      createdAt, updatedAt, createdBy,
      proposalContingent (bool),         /* hire-on-award flag from Proposals → Recruiting bridge */
      proposalId, rfpRoleSnapshot } ],
  candidates: [
    { id, recruitingId, name, location, workAuth, salaryK, clearance, availability,
      source:{kind, agency, referrerId}, status, resume:{...}, interviews:[...],
      offer:{amount, signingBonus, startDate, state, counterNotes},
      rejectionReason, rejectionNote, notes,
      events:[{ts,actorId,actorName,type,payload}], createdAt, createdBy,
      fitScore, fitSummary, fitStrengths, fitGaps, fitGeneratedAt,
      interviewKit:{questions,rubric,generatedAt} } ],

  /* ── In-app notifications bell ── */
  notifications: [
    { id, toMemberId, kind, refType ('recruiting'|'candidate'),
      refId, msg, ts, read } ],

  /* ── Proposals module — see §7g ── */
  proposals: [
    { id, title, status, opportunityId, templateId,
      llmProvider, llmModel,            /* per-proposal LLM override */
      rfp:{...},                         /* extracted RFP fields */
      sections:[{id,title,source,pageBudget,html,draftedAt,...}],
      pastPerformance:{matches,generatedAt},
      coverSheet:{certIds, includedCaseStudyIds, generatedAt},
      pricing:{mode ('manual'|'project-clins'), linkedProjectId, items:[...],
               currency, paymentTerms, optionalAddons:[], assumptionsHtml},
      staffing:{generatedAt, roleMatches:[{intent, candidates, requisitionId, assignedMemberIds}]},
      redTeam:{rubric, reviews, createdTaskId, generatedAt},
      winLoss:{status, decidedAt, decidedBy, notes},
      gapAnalysis:{results, generatedAt},
      events:[...] } ],
  proposalTemplates: [
    { id, name, serviceLine, complianceFramework, pageLimit, version,
      sections:[{id, title, order, required, source, pageBudget, prompt, evidence}],
      winningExamples:[{id, fromProposalId, sectionTitle, html, promotedAt}] } ],
  companyProfile: {
    identity:{legalName, dba, duns, uei, cage, naics:[], hq:{...}, foundedYear,
              ownershipType, employeeCount},
    voice:{primaryTone, toneTags:[], samples:[{id,sectionType,text}], do:[], dont:[]},
    boilerplate:[{id, name, text, lastReviewedAt, ownerId}],
    services:[{id, name, shortDesc, longDesc, targetBuyer, differentiators:[],
               pricingModel, dealSizeBand, naicsCodes:[], relatedCaseStudyIds:[]}],
    caseStudies:[{id, title, customer, customerReferenceable, contractVehicle,
                  period, value, role, scope, tech:[], outcomes:[], challenges,
                  testimonial, pocName, pocPermission, attachments:[],
                  fromProposalId}],
    winThemes:[{id, theme, evidence:[]}],
    keyPersonnel:[memberIds],
    teamingPartners:[{id, name, capabilities, setAsideStatus, priorTeaming, mndaFlag}],
    governance:{ownerId, lastReviewedAt, version}
  },
  corporateCertifications: [
    { id, name, number, issuer, issuedAt, expiresAt, logoUrl, supportingDocId } ],

  /* ── Knowledge Bank (metadata only; text in knowledge_docs table) ── */
  knowledgeBank: [{id, name, type, summary, tags:[], chars, mime, createdAt, createdBy}],

  /* ── Resume Bank (dedicated standalone resume uploads; binary in attachments) ── */
  resumeBank: [{id, name, role, attachmentId, attachmentName, clearance, location, skills:[], summary, createdAt, createdBy}],

  /* ── Migration flags ── */
  overheadSeeded, planSeeded, accountsSeeded,
  oppSeeded, oppEnriched, tplSeeded, cfTemplateSeeded
}
```

**New proposal/profile fields (added this session):**
- `proposal.brief` = `{text(html), winThemes, differentiators, updatedAt, updatedBy}` — BusDev intake.
- `proposal.dossiers` = `[{id, name, role, sourceKey, sourceKind, html, generatedAt}]` — generated key-personnel bios for the appendix.
- `proposal.pricing.cf` = `{monthlyRate, baseMonths, optionYears, escalationPct, resources:[{id,role,count,monthlyRate}], odcs:[{id,item,vendor,qty,unitCost}], travel}` — the CF resource×months pricing model (`pricing.mode='cf-monthly'`).
- `companyProfile.differentiators` = `[string]` (company-wide); `companyProfile.services[i].differentiators` = `[string]`.
- Seeded proposal template id `tpl_cf_technical` ("CommunityForce — Federal Technical Proposal").
```

**Item categories** (`project.category`):
- `project` — has real monthly `revenue` (counts in totals)
- `initiative` — `targetRevenue` = expected future revenue (shown, NOT counted)
- `opportunity` — `targetRevenue` = potential pipeline value (shown, NOT counted)
- `overhead` — cost-only, never revenue

People are allocated to any item via `member.projects = [{id, pct}]`.
`reportsTo` is a **name string** (used to build the Org Chart view).

---

### 7a. COE Plan + Project Tasks

A task tracker shared by two kinds:
- **`kind: 'coe'`** — COE Plan (the seeded 120-day plan, 8 programs, 58 tasks).
  Renamed from "120-Day Plan" to "COE Plan" in this session.
- **`kind: 'project'`** — Project Tasks. Created via the **Project Tasks** tab,
  or auto-spawned by the **Opportunity Workflow** (Task Templates picked from
  inside an opportunity edit modal).

Same data shape in `D.activities`, filtered by `kind` per tab.

- **Programs** (`D.programs`) are first-class objects. Managed via the
  **Programs** button in the COE Plan toolbar. Project Tasks do not require a
  program.
- **Six views** (segmented control in toolbar): **List · Board · Cards · Gantt
  · Calendar · Milestones**.
- **Cards view** (added 2026-05-30): 2D matrix, rows = project/program,
  columns = status. Mini-cards in each cell. Drag-and-drop between status
  columns to change status.
- **Drag-to-reorder** on top-level rows in List view — dots-grip handle on
  the left; updates `order` field on the activity, persists immediately,
  scoped to same project (or same program for COE).
- Activities have `parentId` for subtasks.
- **Owners** auto-link to member cards by name (`+`-joined); unmatched tokens
  stay as text. `projectId` optionally links a task to a project/contract.
- Each task carries **rich-text description** (was "Outline", now
  "Description"), **Next Steps** (was "Objective"), ongoing status updates,
  attachments.
- Modal is **90vw wide** with contenteditable rich-text editor (toolbar:
  bold/italic/underline/lists/link/clear).
- For Project Tasks: Program field is hidden; **Related Item is required**
  (Project/Initiative/Opportunity/Overhead). Modal includes a **Related Item —
  filter** dropdown above the picker to narrow by category.
- Task Templates (admin → Reference Library) seed standard names; pick one
  inside an opportunity to spawn a workflow Project Task linked to that opp.

Key functions: `renderPlanView`, `planListHTML` / `planBoardHTML` /
`planCardsHTML` / `planGanttHTML` / `planCalendarHTML` / `planMilestoneHTML`,
`openPlanModal`, `savePlan`, `planMigrate`, `openProgramsManager`,
`planReorder`, `openTaskTemplatesManager`, `oppAddTemplateTask`.

### 7b. Accounts & roles (CLIENT-SIDE ONLY)

`D.accounts` holds login accounts with roles **admin / owner / editor /
viewer**.
- Login validates email+password against `D.accounts`; session id is in
  `sessionStorage.cf_user`. Seed admin = `khaja@communityforce.com` /
  `Namtra_CF27`.
- `can(action, ctx)` is the permission gate; `applyRoleUI()` (called from
  `renderView`) hides tab buttons and disables controls per role.
- Accounts auto-seed (one-time, gated by `D.accountsSeeded`):
  `firstname.lastname@communityforce.com`, role Editor, shared password
  `CommunityForce2026` (constant `DEFAULT_PW`), linked to `memberId`.
- Per-account LLM config: `apiKey` (Anthropic), `apiKey_openai`, `apiKey_google`,
  `defaultLlmProvider` ('anthropic'|'openai'|'google'), `defaultLlmModel`.
- ⚠ **UI gating only — does NOT secure `/api/*`.** See §10.

### 7c. Opportunities pipeline

`D.projects` rows with `category='opportunity'`. Seeded from
`CF_Pipeline_Project 2026_2027.xlsx` (19 pursuits) via `oppMigrate()`.

- **Pipeline gates** stored as strings: `leadGen`, `presales`, `sales`,
  `delivery`. Rightmost occupied → board stage via `oppDeriveStage()`.
- **Stage** values from `OPP_STAGES`: Lead Gen / Presales / Sales / Delivery /
  Won / Lost.
- **Status** values from `OPP_STATUSES`: New / Qualified / Proposal /
  Negotiation / Closed Won / Closed Lost / On-Hold.
- `p.potential` (yearly $), `p.closeDate` (YYYY-MM-DD).
- **Four views**: Pipeline (Kanban drag-to-change), List, Table, Calendar.
- **Workflow** section at the bottom of an opportunity edit modal lets the
  user pick **Task Templates** to spawn Project Tasks attached to the opp
  (`Task_<OppName>_<Customer>` naming convention). Each row has assignee
  dropdown + status + due date inline.
- `Owner (OPR)` and `PM` are member-name dropdowns (preserve legacy/unknown
  values via `memberNameOpts`).

### 7d. CLINs (Contract Line Items) — revenue breakdown + P&L

Each contract `project` can carry a `clins[]` array. Resources assigned to the
project optionally pin to a CLIN via `member.projects[i].clinId`.

- Inline editable CLIN table inside the project edit modal (number / title /
  revenue), with computed Assigned Cost + Profit/Loss per CLIN.
- Resource → CLIN assignment dropdown for every person on the project.
- Pricing on a Proposal can optionally **pull CLIN structure** from a linked
  project (Proposals → Pricing tab → mode "Project CLINs").
- Helpers: `clinAdd`, `clinUpdate`, `clinDel`, `clinAssignedMembers`,
  `clinAssignedCost`, `projClinRevenue`, `setAssignmentClin`.

### 7e. Section visibility (per-role)

`D.sectionVis` is `{ role: { sectionKey: bool } }`. Admin always sees all.
- `canSee(k)` is the gate; `applyRoleUI()` hides tab buttons.
- Special-case gates: `canRecruit()` for the Recruiting tab, `canProposal()`
  for the Proposals tab (admin/editor or members with the matching
  classification flag).

### 7f. Recruiting module

Admin / editor / **Recruiter-classified** members only. New top-level
**Recruiting** tab (after Projects).

**Requisitions** (`D.recruitings`)
- Parent: project / initiative / opportunity / overhead / department
- Fields: `jdTitle`, `jdDescription` (rich text), `jdAttachments`,
  `busDevId`, `pmId`, `status` (open/on-hold/filled/cancelled)
- Multiple requisitions per Perform Recruiting task supported
- Card grid grouped by status, with SLA chips (amber 30d, red 60d) and a
  funnel summary header
- `proposalContingent` + `proposalId` link a req back to its originating
  proposal (via the RFP → Recruiting bridge in §7g)

**Candidates** (`D.candidates`)
- Kanban board by status (New / Screening / Interviewing / Offer / Hired /
  Rejected / Withdrawn)
- Profile fields: Name, Location, Work Auth, Salary $k, Clearance,
  Availability, Source (structured: agency/referral/inbound/outreach/linkedin/
  other), Notes
- Resume upload with inline PDF preview via `<embed>`
- Interviews: schedule (date/time + multi-select interviewers from BusDev +
  PM + SME + Hub + Proposal-classified), outcome dropdown (reject/consider/
  accept), per-interview notes
- Offer sub-object: amount / signing bonus / start date / state (Pending /
  Accepted / Declined / Countered)
- Rejection reason taxonomy: Skills Gap / Salary Mismatch / Clearance /
  Culture / Withdrew / Position Filled / Other
- Audit log via `events[]`: created, status changes, resume uploaded,
  interviews scheduled/outcomes, offers, hires
- Duplicate detection on intake
- **Hire → Member**: prompts to create a department member pre-filled with
  name, location, monthly cost (salaryK / 12), clearance, resume attachment

**AI features** (route via `llmComplete` / `llmDocComplete` → user's default
LLM provider unless per-task overridden)
- **JD AI Assist** in the requisition modal: Rewrite / Expand / Generate
  from title; lands in a preview modal before Apply
- **Extract fields from resume**: PDF → Claude (or Gemini) → structured
  fields; per-field Apply preview; existing values require confirmation to
  overwrite
- **Compute fit score**: 0–100 with strengths/gaps/summary; stored on
  candidate
- **Generate interview kit**: 6–8 tailored questions + 5-criterion rubric
- **Summarize interview notes**: raw notes → structured summary + suggested
  outcome
- **Draft email**: outreach / schedule / offer / rejection / follow-up

**Notifications bell** (in header, between user badge and Admin)
- `D.notifications[]` keyed by `toMemberId`
- Fires on: resume uploaded → BusDev+PM, JD file uploaded → BusDev,
  interview scheduled → interviewers, outcome recorded → BusDev+PM, status
  change to offer/hired/rejected → BusDev+PM

Key functions: `renderRecruitView`, `openRecruitModal`, `saveRecruit`,
`openCandModal`, `saveCand`, `candHire`, `candExtractResume`,
`candComputeFit`, `candGenKit`, `candSummInterview`, `candDraftEmail`,
`openNotifications`.

### 7g. Proposals module

Admin / editor / **Proposal-classified** members only. New top-level
**Proposals** tab (after Opportunities, before Overhead).

**Six phases shipped (A–F)**:

| Phase | What landed |
|---|---|
| A | Foundation: tab + visibility + Company Profile + Templates + Corporate Certifications + multi-LLM plumbing |
| B | New Proposal flow: RFP upload + Claude extraction + opportunity auto-provisioning + Past Performance finder + Cover Sheet auto-build |
| C | Sections tab with per-section AI drafting + Gap Analysis + Brand Voice Rewrite |
| D | Pricing editor with LCAT-from-CLIN toggle + AI Pricing Assumptions |
| E | RFP → Recruiting bridge + Internal Bench Fit-Score |
| F | Red Team rubric + PDF export + Win/Loss feedback loop |

**New Proposal flow**
- **Upload RFP** (PDF/DOCX): uploads to `attachments` table; calls
  `/api/llm/with-attachment`; Claude returns structured `rfp` extraction
  (customer, summary, scope, PoP, due date, potential $, contract vehicle,
  set-aside, requirements[], requiredCerts[], requiredClearances[],
  requiredRoles[], deliverables[], evaluationCriteria[], keyDates[]); user
  reviews; user picks/creates opportunity + template; proposal created
- **Opportunity auto-provisioning**: if no fuzzy customer match exists,
  Atlas creates a new `D.projects` opp (stage=Presales, status=Qualified,
  potential = extracted value, closeDate = RFP due date) and seeds the
  Perform Proposal Development task template
- **Manual path**: title + customer + opportunity + template, no AI

**Proposal detail modal — eight tabs**
1. **Overview** — hero cards + status pill + due-date countdown
2. **RFP Details** — every extracted field is editable (textareas for list
   fields)
3. **Sections** — master/detail layout: sidebar lists template sections;
   editor pane has rich text + AI Draft / Voice Rewrite / Save buttons; Gap
   Analysis runner at the top
4. **Staffing** — Bench fit-score per role + intent (Bench / Open Req /
   Sub) + JD draft + Create Requisition (creates real `D.recruitings` entry
   with `proposalContingent: true`)
5. **Past Performance** — Claude semantic match against
   `companyProfile.caseStudies`; ranked results with include-in-proposal
   checkboxes
6. **Pricing** — Mode toggle (Manual / Project CLINs); inline editable
   table; auto-totals; currency + payment terms + optional add-ons; AI
   Pricing Assumptions drafter
7. **Cover Sheet** — per-cert checkboxes (expired auto-disabled) + live HTML
   preview rendering identity, certifications, selected PP citations
8. **Red Team** — Generate Rubric (Compliance / Win Themes / Clarity /
   Risk × 1/3/5 anchors per section); reviewers score 1–5 per criterion;
   per-key averages aggregate; Assign Reviewers creates a Project Task with
   reviewer ownership
9. **Export** — Pre-flight checklist + Open Print Preview / PDF (assembles
   cover + ToC + sections + PP appendix + pricing table into a single
   print-ready HTML doc; opens in new window for browser Save-as-PDF)
10. **Files** + **Settings** (per-proposal LLM provider/model override +
   activity log)

**Win/Loss workflow**
- Triggered when proposal status flips to `won` or `lost`
- Modal: capture debrief notes; flip linked `proposalContingent` reqs to
  active hires (Won) or cancel/keep (Lost); promote winning sections to
  template `winningExamples[]`; quick-add proposal to Company Profile
  `caseStudies` (Won)

Key functions: `renderProposalsView`, `propCardsHTML`, `openNewProposalModal`,
`_npExtractRFP`, `_propAutoCreateOpp`, `openProposalDetail`,
`pdSectionAIDraft`, `pdRunGapAnalysis`, `pdSectionVoiceRewrite`,
`pdRunPastPerf`, `pdScoreBench`, `pdStaffingDraftReq`,
`pdPricingDraftAssumptions`, `pdGenerateRedTeamRubric`, `pdExportPrint`,
`_buildProposalPrintHTML`, `openWinLossModal`, `openCompanyProfileManager`,
`openProposalTemplatesManager`, `openCorporateCertsManager`.

### 7h. Classification View

New top-level tab. Groups people by classification flag — **Hub / SME /
Associate / Proposal / Recruiter** — each as a labeled card with headcount +
monthly cost. A person can appear in multiple groups. Anyone with no
classification flag lands in "Unclassified".

The classification flags are also additive: `m.hub`, `m.sme`, `m.associate`,
`m.proposal`, `m.recruiter` (booleans). Surface on department cards as small
tags and on profile drawers as large badges. **Proposal and Recruiter were
added** in this session — defaults to false on migration.

### 7i. Multi-LLM support

`server.js` routes to Anthropic / OpenAI / Google Gemini based on
`provider` in the request body. Response normalized to Anthropic shape so
client parsers (`llmExtractText`, `llmExtractJSON`) work for all three.

`LLM_PROVIDER_LIST` in `index.html` is the single source of truth for which
models appear in the UI — easy to extend.

Per-call resolution order: opt.provider → account.defaultLlmProvider →
`'anthropic'`. Same for model.

Per-proposal LLM override on proposal detail Settings tab — wins over
account default.

Admin → Integrations modal: three API key fields + default provider/model
selector. Live per-provider org-key status fetched from `/api/llm/providers`.

PDF support: Anthropic (document content blocks) ✓ · Google
(inline_data) ✓ · OpenAI ✗ (falls back to text-only via the proxy).

---

## 8. Views / Features (current tab bar)

In order: **Department · Org Chart · Projects · Recruiting · Initiatives ·
Opportunities · Proposals · Overhead · Resources · Classification · COE Plan ·
Project Tasks**

Search bar moved into the header (between user badge and Admin) in this
session to free the toolbar row for tabs.

### Admin menu (gear icon)

- **People & Teams** — + Person, Departments
- **Items** — + Project, + Initiative, + Opportunity, + Overhead
- **Reference Library** — Skills/certs/locations/clearances · Task Templates
- **Proposals** — Company Profile · Proposal Templates · Corporate Certifications (visible only to canProposal users)
- **Access Control** — Accounts · Section visibility (admin only)
- **Integrations** — LLM Providers & API Keys
- **Data** — Export · Import

Persistence: loads from `/api/data` (Postgres), autosaves ~1s after edits;
`localStorage` is an offline cache/fallback. Server guardrail rejects
array-to-zero shrinks.

### Modal stacking fix

`openModal` now increments a z-index counter on each open so a newly opened
modal always renders on top of any existing modal. `closeModal` clears the
inline z-index. Fixes the "edit window opens behind the open object" bug.

---

## 9. Run & Deploy

### Run locally
```bash
npm install
# Optional: point at the prod DB (use the PUBLIC url so SSL is on)
#   PowerShell:  $env:DATABASE_URL = "postgresql://...public-url..."
#   bash:        export DATABASE_URL="postgresql://...public-url..."
npm start            # → http://localhost:3000
```
Without `DATABASE_URL` the server still boots; the app falls back to
`localStorage` (no cross-device persistence). **Careful:** running locally
against the prod DB edits live data.

### Deploy
```bash
git add -p && git commit -m "..."
git push            # Railway auto-deploys main (~1–3 min)
```
Verify by polling the live URL or watching the Railway deploy logs.

### Syntax check before pushing
```powershell
# Extract <script> from index.html and run node --check
$content = Get-Content "index.html" -Raw
$scripts = [regex]::Matches($content, '(?s)<script>(.*?)</script>')
$big = $scripts | Sort-Object {$_.Groups[1].Length} -Descending | Select-Object -First 1
$big.Groups[1].Value | Out-File "C:\Users\saqib\AppData\Local\Temp\atlas-script.js" -Encoding utf8
node --check "C:\Users\saqib\AppData\Local\Temp\atlas-script.js"
node --check "server.js"
```

### Logo / favicon assets
In-app favicon is an inline SVG data URI. Header/login use an inline SVG
badge. Downloadable PNG/ICO files in `brand/`. They were generated with a
throwaway script using `sharp` + `png-to-ico` (was in
`C:\Users\idris\brandgen` on the original machine — not in the repo;
recreate if needed).

---

## 10. Atlas → LevelUp integration

### Atlas side (in this repo)

- `GET /api/atlas-snapshot` (in `server.js`) — bearer-token-protected. Returns
  v2 payload with: `departments`, `projects`, `activities`, `programs`,
  `taskTemplates`, lookup lists, `proposals`, `companyProfile`,
  `corporateCertifications`. **Excluded for safety**: `accounts`,
  `notifications`, `recruitings`, `candidates` (PII / workflow-internal).
- Required env var: `ATLAS_SYNC_TOKEN` (must match LevelUp's env var of the
  same name). 401 if mismatch, open if env var unset (don't ship open to prod).

### LevelUp side (in `levelup-second-brain` repo)

- **Adapter**: `server/_core/atlasAdapter.ts` — typed `AtlasSnapshot` shape +
  `pullAtlasSnapshot()` (30s timeout, bearer auth) + `atlasConfigStatus()`
  (env-var check).
- **tRPC router**: `server/routers/atlas.ts` — `atlas.status` /
  `atlas.pull` / `atlas.clear`.
- **Migrations**: `drizzle/0043_atlas_snapshot.sql` (adds `atlas` mediumtext
  column to `user_app_data`); `drizzle/0044_atlas_annotations.sql` (adds
  `atlasAnnotations`).
- **Cron**: `processAtlasPull()` runs hourly inside `externalTasksCron.ts`;
  one pull per pass distributed to every user who has opted in (has a
  non-null `atlas` blob).
- **Required env vars on LevelUp Railway service**:
  - `ATLAS_SYNC_URL` (e.g., `https://cfresourceplanner-production.up.railway.app`)
  - `ATLAS_SYNC_TOKEN` (must match Atlas)
- **Atlas page in LevelUp** (`s-atlas` screen in `app-part2.js`): sidebar
  entry with sky-blue globe icon; ten view tabs mirroring Atlas's pages —
  Projects, Initiatives, Opportunities, **Proposals**, Overhead, Org Chart,
  Resources, **Classification**, COE Plan, Project Tasks.
- **Detail drawer** for every entity type (project, member, department,
  activity, proposal). Three tabs: Details / My Notes / Create. Details
  shows every field with click-through to related entities. My Notes is a
  private rich textarea stored in `D.atlasAnnotations`. Create spawns a
  LevelUp note, journal entry, or task linked back to the Atlas object.
- **Annotations** persist in `user_app_data.atlasAnnotations`, keyed by
  `{type}:{id}`. Never synced back to Atlas — they live entirely on the
  LevelUp side. A yellow 📝 badge appears on items with notes.
- **Smartsheet/Nifty scaffolding removed** from Settings → Integrations
  (Atlas is the source of truth for CF data now). Pipeline page (`s-pipeline`)
  is kept intact for future use.

### Token management

Current token: rotate by generating 32 random bytes hex-encoded and updating
both Railway projects:
```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
-join ($bytes | ForEach-Object { $_.ToString("x2") })
```

---

## 11. Known Limitations / TODO

- **Concurrency: last-write-wins.** `app_state` is a single shared row. If
  two browsers/people edit at once, the later save silently overwrites the
  earlier one (now blocked only when shrinking protected arrays to zero —
  see §5 guardrail). Recommended next step: optimistic locking via
  `updated_at`, or poll-and-merge with conflict warning.
- **Auth is client-side only.** Roles gate the **UI** via `can()` /
  `applyRoleUI()`, but passwords live in the JSON blob and `/api/*` is fully
  open (except `/api/atlas-snapshot`, which has bearer auth, and
  `/api/llm/*`, which requires `accountId` to find the right API key).
  Real protection needs server-side auth (hashed passwords, cookie/session,
  gate the page AND the API).
- **Attachments capped at 25 MB** each and stored in Postgres `bytea`.
  Migrate to S3-style object storage if you expect large media or very many
  files.
- **PDF export** for proposals uses browser print-to-PDF. Brittle for
  federal cover sheets with strict formatting. Server-side Puppeteer would
  give better fidelity (see Phase F notes in commits).
- **OpenAI provider doesn't support PDFs** through the LLM proxy yet — it
  requires the Files + Assistants API, which would be a separate refactor.
  Anthropic and Google both work.
- **Recruiting AI features** are deliberately hardcoded to Anthropic in the
  client (their prompts are tuned for Claude's JSON output). Per-user
  default-provider routing applies only to `llmComplete()` callers, not
  these direct fetches.

---

## 12. Notes for the next AI session

- The whole app is `index.html`; search the `<script>` block for function
  names. File is now ~5,800 lines.
- **Boot sequence**: `initApp()` → `bootstrapData()` loads `D` and runs
  `migrate()` (which calls `planMigrate()` + `authMigrate()` + `oppMigrate()`
  + `tplMigrate()` + `recruitMigrate()` + `proposalsMigrate()`) →
  `currentAccount()` resolves the session → `renderView()`.
- **All migrations are now defensive** (2026-05-30): seed blocks only fire
  when the target array is genuinely empty. `tplMigrate` pushes only missing
  templates by ID. `planMigrate` and `oppMigrate` gate on activity/opportunity
  arrays being empty. `_lookupOpts` helper preserves unknown
  location/clearance IDs to prevent silent wipes.
- **Server-side guardrail** in `POST /api/data` rejects writes that would
  shrink any protected array from N>0 to 0. Returns HTTP 409. Bypass with
  `?force=1` for legitimate destructive ops.
- **Function inventory** (by module):
  - **COE Plan + Project Tasks** — `renderPlanView`, `planMigrate`,
    `planFiltered`, `openPlanModal`, `savePlan`, `planSetStatus`,
    `planReorder`, view-renderers `planListHTML` / `planBoardHTML` /
    `planCardsHTML` / `planGanttHTML` / `planCalendarHTML` /
    `planMilestoneHTML`, `planKind()` discriminates 'coe' vs 'project'.
  - **Task Templates** — `openTaskTemplatesManager`, `tplAdd`,
    `tplUpdateName`, `tplDel`, `oppAddTemplateTask`.
  - **Org Chart** — `renderOrgChartView`, `renderOrgHier`, `renderOrgMatrix`,
    `renderOrgFunctional`, `renderOrgDivision`.
  - **Classification View** — `renderClassificationView`, `CLASSIFICATIONS`
    constant.
  - **Opportunities** — `renderOppView`, `oppBoardHTML` / `oppListHTML` /
    `oppTableHTML` / `oppCalendarHTML`, `oppEditFields`, `oppMigrate`,
    `oppDeriveStage`, `OPP_STAGES`, `PIPELINE_SEED`, `OPP_ENRICH`,
    `oppWorkflowHTML`, `oppAddTemplateTask`.
  - **CLINs** — `renderClinsSection`, `clinAdd`, `clinUpdate`, `clinDel`,
    `setAssignmentClin`, `clinAssignedCost`, `projClinRevenue`.
  - **Person edit / profile** — `openEditMember`, `saveEdit`,
    `openPersonProfile`, `findMember`, `memberUpload`, `memberAddLink`,
    `_lookupOpts` (defensive dropdown for location/clearance).
  - **Recruiting** — `renderRecruitView`, `openRecruitModal`, `saveRecruit`,
    `delRecruit`, `openCandModal`, `saveCand`, `candHire`,
    `candExtractResume`, `candComputeFit`, `candGenKit`,
    `candSummInterview`, `candDraftEmail`, `pushNotif`,
    `openNotifications`, `renderNotifBadge`.
  - **Proposals** — `renderProposalsView`, `propCardsHTML`,
    `openNewProposalModal`, `_npExtractRFP`, `_propAutoCreateOpp`,
    `openProposalDetail`, `_pdOverviewHTML` / `_pdRFPHTML` /
    `_pdSectionsHTML` / `_pdStaffingHTML` / `_pdPastPerfHTML` /
    `_pdPricingHTML` / `_pdCoverSheetHTML` / `_pdRedTeamHTML` /
    `_pdExportHTML`, `pdSectionAIDraft`, `pdSectionVoiceRewrite`,
    `pdRunGapAnalysis`, `pdRunPastPerf`, `pdScoreBench`,
    `pdStaffingDraftReq`, `pdPricingDraftAssumptions`,
    `pdGenerateRedTeamRubric`, `pdExportPrint`,
    `_buildProposalPrintHTML`, `openWinLossModal`, `wlReqAction`,
    `wlPromoteSections`, `wlAddCaseStudy`, `_propBuildRFPCtx`,
    `_propBuildVoiceCtx`, `_propLLMOpts`.
  - **Company Profile / Templates / Certifications** —
    `openCompanyProfileManager`, `openProposalTemplatesManager`,
    `openCorporateCertsManager`, `cpEditService`, `cpEditCaseStudy`,
    `propTplAdd`, `propTplEdit`, `propTplSecField`, `certEdit`.
  - **LLM proxy** — `llmComplete`, `llmDocComplete`, `llmExtractText`,
    `llmExtractJSON`, `LLM_PROVIDER_LIST`, `llmModelOpts`, `llmProvOpts`.
  - **Auth / access** — `can`, `canSee`, `canRecruit`, `canProposal`,
    `applyRoleUI`, `doLogin`, `authMigrate`, `currentAccount`,
    `openAccountsManager`, `openVisibilityManager`, `setSectionVis`,
    `SECTIONS`, `ROLE_LABELS`, `DEFAULT_PW`, `emailFromName`.
  - **Admin menu** — `openAdmin` (the menu), `openAdminLibrary` (legacy
    tabbed library), `openIntegrationsManager`.
  - **Server sync** — `serverLoad`, `serverSave({force?})`, `save()`
    (debounced ~1s).
- **Data edits to live content** are done by mutating `D` in the browser
  console and calling `save()` / `serverSave()`, OR through the UI — both
  persist to Postgres.
- **Modal stacking**: every `openModal(id)` increments `_modalZ` and
  applies inline z-index. `closeModal(id)` clears it. New modals always
  appear on top.
- **Rich text editor** helpers: `richEditor(id, value, opts)`,
  `rtGet(id)`, `rtExec(cmd)`, `plainToRich(s)`. Use everywhere a long-form
  text field is needed (descriptions, JD, proposal sections).
- **Member name dropdowns**: `memberNameOpts(currentName)` for Owner/PM
  fields (preserves legacy values).
- **Railway deploys are not instant**; poll the live URL for a marker
  string from your change before verifying in the browser.

---

## 13. Session log highlights (since the original handoff)

Material work done in the May 28–30, 2026 session:

- **Renamed** "120-Day Plan" → "COE Plan"; added "Project Tasks" view (same data, different `kind` discriminator)
- **Task Templates** module (Admin → Reference Library); seeded with 6 standard tasks; usable from Opportunity Workflow
- **Recruiting module** (Phase 1A-2B): requisitions, candidates board, interviews, offer state machine, hire→member, notifications bell, JD AI Assist, resume autofill, fit score, interview kit, summarizer, email drafts
- **Multi-LLM support**: server proxy + Admin → Integrations panel + per-account defaults + per-proposal overrides
- **Proposals module** (Phases A-F): full RFP-to-submission lifecycle described in §7g
- **Classification View** (Hub/SME/Associate/Proposal/Recruiter), with Proposal+Recruiter added as new classification flags
- **Atlas → LevelUp sync**: `/api/atlas-snapshot` v2, adapter + drawer + annotations + spawn helpers on the LevelUp side, removed Smartsheet/Nifty scaffolding from LevelUp Settings
- **Cards view** for tasks (project × status matrix)
- **Server-side guardrail** against array-wipe saves (HTTP 409)
- **Drag-to-reorder** for tasks in List view
- **Search bar** moved to header
- **Member dropdowns** for Owner/PM with legacy-value preservation
- **`_lookupOpts`** helper to prevent silent location/clearance wipes
- **Modal stacking** z-index fix
- **Migration hardening** — all seed blocks now defensive against re-running on populated data

---

## 14. Session log — Proposal Generator build-out + UX overhaul (June 2026)

Large session. Everything below is live on `main`.

### New capability: AI proposal generation pipeline
- **Knowledge Bank** (Admin → Proposals → 📚 Knowledge Bank): upload past
  proposals / capability docs (PDF/DOCX/XLSX/TXT) or paste text. Server extracts
  text (`extractDocText`) into the new `knowledge_docs` table; an AI pass writes a
  summary + tags. Retrieval is **select-then-inject** (no vector DB):
  `kbSelectRelevant` asks the LLM which docs fit the RFP, `kbFetchTexts` pulls
  their text, `kbBuildContext` returns an injectable block. Functions:
  `openKnowledgeBankManager`, `kbUpload`, `kbPasteText`, `kbSummarizeDoc`,
  `kbResummarize`, `kbDelete`, `kbSelectRelevant`, `kbFetchTexts`, `kbBuildContext`.
- **BusDev Brief tab** (`_pdBriefHTML`): raw stream-of-consciousness intake +
  win themes + differentiators → `p.brief`. `pdCaptureBrief` / `pdSaveBrief`.
- **Generate Full Proposal** (`pdGenerateFullProposal`): captures brief → KB
  retrieval once → drafts every AI/hybrid section sequentially with live progress.
  Opt-in checkboxes also **seed CF pricing from RFP roles** (`_genSeedPricing`)
  and **generate dossiers for assigned bench** (`_genDossiers`). Shared prompt
  builder `_propSectionPrompt(p,s,kbBlock)` (brief + KB + voice + differentiators
  + PP/certs aware) — also powers single-section "Draft with AI". Entry points on
  both the Brief tab and Sections tab ("Generate All").
- **CF house template** seeded idempotently (`_cfTechnicalTemplate`, id
  `tpl_cf_technical`, gated by `cfTemplateSeeded`) — 14-section DoD structure
  modeled on the DTMO PEIS proposal.
- **CF-format export** (`_buildProposalPrintHTML`): fielded DoD cover
  (CAGE/UEI/DUNS, vehicle, PoP, set-aside, due date), numbered sections + Contents.

### Recruiting: Resume Bank + dossiers
- **Resume Bank** (Recruiting → 📄 Resume Bank): `resumeBankAll()` unifies
  recruiting candidates (with resumes), department staff (`resumeLink`), and
  dedicated uploads (`D.resumeBank`). `openResumeBankManager`, `rbUploadPrompt`,
  `rbDelete`.
- **Key-personnel dossiers** (Staffing tab → `_pdDossiersHTML`): pick people from
  the Resume Bank → `_dossGenerateOne` writes a tailored one-page bio (from the
  resume PDF via `llmDocComplete` when on file, else structured profile) → stored
  on `p.dossiers`, rendered into the export appendix. `openDossierPicker`,
  `dossGenerateSelected`, `dossRemove`.

### CF pricing model (Phase 5)
- New `cf-monthly` pricing mode: resource × months × fixed monthly rate, base +
  option years + escalation; Section A Labor / B ODCs / C Travel; live totals +
  monthly burn. `_cfPricingTotals`, `_cfPricingEditorHTML`, `_cfPricingPrintHTML`,
  `cfPrSet`/`cfResAdd`/`cfResSet`/`cfResDel`/`cfOdcAdd`/`cfOdcSet`/`cfOdcDel`,
  `cfSeedRoles`/`cfSeedCLINs`. **CLIN/cost margin:** link a contract project to
  compare `projClinRevenue` + `_projMonthlyCost` (assigned-member cost) vs the
  proposed monthly burn. `_propPricingTotal` is cf-aware.

### Differentiators
- Service editor rebuilt as a form modal with an add/remove multi-differentiator
  list (`_svcRender`/`cpSvcAddDiff`/`cpSvcDelDiff`/`cpSvcSave`); company-wide
  `companyProfile.differentiators` list (`cpAddDiff`/`cpDelDiff`); injected into
  drafting via `_propBuildDifferentiatorsCtx`.

### UX foundation (applies app-wide)
- **Modal a11y:** `openModal`/`closeModal` add `role=dialog`/`aria-modal`, focus
  capture/restore + autofocus, and a global **Escape-to-close** (topmost).
- **Toasts:** `toast(msg,kind,ms)` + `toastAction(msg,label,fn,ms)` (Undo); CSS
  `#toastWrap`. `window.alert` is overridden to route notifications through toasts
  (severity inferred from text); `confirm()`/`prompt()` stay blocking.
- **Reusable form modal** `openFormModal({fields,onSubmit})` (ovForm) with text/
  textarea/select/file/number/date/**checkboxes** field types — replaced the old
  chained `prompt()` editors (Resume Bank, Corporate Certs, Proposal Templates +
  rename + section add/prompt, KB paste, boilerplate, case studies, task templates,
  candidate Hire→member, red-team assign, win/loss promote, interview summarizer).
  Only the rich-text link-URL prompt remains.
- **Tabbed long modals:** proposal detail's 12 tabs grouped into 4 clusters
  (Content / Inputs / Business / Review & Output); Person edit + Add member split
  into Core / Projects & Skills / Profile / Background panes (`meSetTab`, display-
  toggled — field IDs unchanged so `saveEdit`/`saveAddMem` are untouched).
- **Drag polish:** Undo toasts on task-status (`planSetStatus`) and opportunity-
  stage (`oppDrop`) drops; grab cursors + dashed drop-zone highlight.
- **Misc:** debounced header search (`_searchDebounced`, `type=search`); mobile
  responsive pass (scrollable tab bar, 95vw modals, horizontal-scroll tables).

### Known gaps / notes for next session
- `xlsx`/SheetJS has low-severity npm audit advisories (functional; flagged).
- Spreadsheet KB docs uploaded **before** the xlsx-extraction commit have 0 chars
  stored — re-upload to extract + summarize.
- AI features require an LLM key: org `ANTHROPIC_API_KEY` (now set on Railway) or a
  per-user key in Admin → Integrations. `/api/llm/providers` reports org-key status.
- Drag→Undo is code-complete but couldn't be exercised via the browser-automation
  harness (synthetic mouse-drag doesn't fire HTML5 DnD events) — verify by hand.
- Deferred: broader `confirm()` → styled-modal migration; richer Knowledge Bank
  tag editing; server-side Puppeteer PDF export (still browser print-to-PDF).

---

## 15. Capacity Planning module (resource simulation / what-if)

New top-level **Capacity Planning** tab (`viewMode='cap'`, `renderCapacityView`).
A **non-destructive sandbox** over the allocation model for capacity experiments.

- **Sandbox:** `CAP = {name, roster:[...], baseline}` (global, in-memory, session-
  scoped). `capEnter()` clones live people into `CAP.roster` on first render and
  freezes a `baseline` (live totals) for Δ comparison. Nothing touches `D` until
  **Apply to live**. `capReset()` rebuilds from live.
- **Roster person:** `{id,name,role,cost,_origin:'member'|'ghost'|'prospect',_deptName,projects:[{id,pct,clinId}]}`.
- **Engine (reads a roster):** `capItems` (project/initiative/overhead),
  `capItemRevenue` (project→revenue, initiative→targetRevenue), `capItemCostR`,
  `capItemFTER`, `capAllocR`, `capTotals`. Semantics: projects always count
  revenue; **initiatives count revenue only when staffed (FTE>0)**;
  profit = revenue − payroll; utilization = allocated cost / payroll; plus bench
  FTE and over-allocation count.
- **UI:** KPI bar (revenue/payroll/profit/margin/util/bench/over) with Δ-vs-baseline
  chips; SVG charts (`_capChartsHTML` — profit-by-item bars + utilization donut);
  per-item profitability cards; editable **people×items matrix** (`capSetPct`,
  sticky person column, capacity bars, per-item FTE footer). **Drag** a person's
  grip onto a card to dump free capacity (`capDragStart`/`capCardDrop`).
- **Hypotheticals:** `capAddGhost` (ghost hire), inline `capSetCost`,
  `capRemovePerson`, `capAddProspects` (stage open reqs + Resume-Bank people via
  `capProspectOptions`).
- **Scenarios:** `D.scenarios=[{id,name,createdAt,createdBy,roster}]`;
  `capSaveScenario` / `capLoadScenario` / `capDeleteScenario`; `capCompare`
  (modal `ovCapCmp`) shows Live vs each saved scenario vs working sandbox.
- **Apply:** `capApply()` writes member allocations back to `D` (confirm-gated);
  ghosts/prospects/removals are planning-only and never written.
- Reads existing helpers `allM`, `findMember`, `projCat`, `fmt`. `D.scenarios`
  is lazily initialized; not in the array-wipe guardrail.
