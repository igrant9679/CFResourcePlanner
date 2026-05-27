# Atlas — CommunityForce Resource Planner · Project Handoff

A single-page workforce / resource-planning app (org chart, projects, initiatives,
opportunities, overhead, allocations) for CommunityForce. This document is everything
you need to continue the project from a new machine or a new AI session.

> Paste this whole file into a new session's first message (or open it in the repo) to
> bring the assistant up to speed.

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

The login is a **client-side gate only** (defined in `index.html`, stored in
`sessionStorage`). It keeps casual visitors out but is visible in page source and does
not protect the API. Treat it as a soft gate, not real security.

---

## 2. Repository Layout

```
CFResourcePlanner/
├── index.html        ← THE ENTIRE FRONT-END APP (HTML + CSS + JS in one file)
├── server.js         ← Express backend (static serving + /api endpoints)
├── package.json      ← deps: express, pg, multer
├── package-lock.json
├── .gitignore        ← node_modules/, *.log
├── brand/            ← generated logo assets (atlas-logo-*.png, favicon.ico, favicon-256.png)
└── PROJECT_HANDOFF.md ← this file
```

Almost all app logic lives in **`index.html`** (the `<script>` block). The data object
is the global `D`. There is no build step — edit the file, commit, push, done.

---

## 3. GitHub

- Repo: `igrant9679/CFResourcePlanner`, branch `main`.
- No CI; pushing to `main` is what triggers a Railway deploy.
- To work on a new computer:
  ```bash
  git clone https://github.com/igrant9679/CFResourcePlanner
  cd CFResourcePlanner
  npm install
  ```

---

## 4. Railway (Hosting)

- A Railway **project** contains two services: the **app** (this repo) and **Postgres**.
- The app service is connected to GitHub and **auto-deploys on every push to `main`**.
  Deploys take ~1–3 minutes.
- Start command: `npm start` → `node server.js`. Railway provides `PORT` via env.
- Public domain: `cfresourceplanner-production.up.railway.app` (Railway-generated).

### Database connection wiring (important)
The app reads `process.env.DATABASE_URL`. This is **not** hard-coded — it's a Railway
**variable reference**. On the app service → **Variables**, there is:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
```

This resolves to the internal address `postgres.railway.internal:5432` (no SSL needed).
`server.js` auto-detects SSL: it uses SSL only if the URL is NOT a `railway.internal`
or `localhost` host. If you ever switch to the **public** Postgres URL, SSL turns on
automatically.

If a fresh deploy ever shows "Offline — using local copy" in the app header, it means
`DATABASE_URL` isn't reaching the app service — re-add the variable reference (or drag a
connection from Postgres to the app on the Railway canvas) and redeploy.

---

## 5. Database (PostgreSQL)

Tables are auto-created on server boot (`initDb()` in `server.js`):

```sql
-- Single-row blob holding the entire app state (departments, projects, members, etc.)
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
```

- All app data lives in `app_state` row `id = 1` as one JSON document.
- File attachments live in `attachments` (binary), referenced from items by `{id, name, url, type:'file', size}`.
- **Backups:** the app has Export / Import buttons that download / restore the full
  JSON. Use Export periodically. (Attachments are not in the JSON export — they're in the
  `attachments` table only.)

To get DB credentials on a new machine: Railway dashboard → **Postgres service** →
**Variables** (or **Connect** tab) → copy `DATABASE_URL` / `DATABASE_PUBLIC_URL`.

---

## 6. API Endpoints (server.js)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/data` | Returns the app JSON (or `null` if empty) |
| POST | `/api/data` | Upserts the app JSON (whole document) |
| POST | `/api/attachments` | Multipart file upload (field `file`, max 25 MB) → `{id,name,url,...}` |
| GET | `/api/attachments/:id` | Stream/download a stored file |
| DELETE | `/api/attachments/:id` | Delete a stored file |
| GET | `/` | Serves `index.html` |

---

## 7. Front-end Data Model (global `D` in index.html)

```
D = {
  skillsets: [{id,name}], certifications:[], locations:[], clearances:[],
  pastProjects:[], pastClients:[],
  projects: [
    { id, name, category, revenue, targetRevenue, revenueNote,
      description, attachments:[{id?,name,url,type,size?}], parentId }
  ],
  departments: [
    { id, name, subtitle, accent, parentId,
      members: [
        { id, name, role, cost, badge, reportsTo (name string),
          projects:[{id,pct}], skillsets:[id], certifications:[id],
          location, clearance, hub, sme, associate, note, reassess,
          resumeLink, pastProjects:[], pastClients:[] }
      ] }
  ],

  // ── 120-Day Plan module (see §7a) ──
  programs: [ { id, name, color, order, lead } ],
  activities: [
    { id, programId, program (legacy name cache), task, subtask (title),
      outline, objective, phase ("Month 1".."Month 4"),
      start (YYYY-MM-DD), dueDate (YYYY-MM-DD), isMilestone,
      status ("todo"|"doing"|"done"|"blocked"),
      parentId (null | parent activity id = subtask),
      owners:[memberId], ownerText, projectId, pm, order,
      updates:[{id,ts,author,text}], attachments:[{id,name,url,type,size?}] }
  ],
  planStart: "2026-06-01",   // Month 1 anchor for phase-derived dates

  // ── Accounts / roles (client-side only — see §7b) ──
  accounts: [
    { id, email, name, password, role ("admin"|"owner"|"editor"|"viewer"),
      programIds:[id] (owner scope), memberId (linked person), active }
  ],

  overheadSeeded: true, planSeeded: true   // migration flags
}
```

**Item categories** (`project.category`):
- `project` — has real monthly `revenue` (counts in totals).
- `initiative` — `targetRevenue` = expected future revenue (shown, NOT counted).
- `opportunity` — `targetRevenue` = potential pipeline value (shown, NOT counted).
- `overhead` — cost-only, never revenue (e.g., Management, G&A/Operations, Federal Sales/BD).

People are allocated to any item via `member.projects = [{id, pct}]`. `reportsTo` is a
**name string** (used to build the Org Chart view).

### 7a. 120-Day Plan module (the "ClickUp replacement")

A task tracker seeded from the CommunityForce 120-day plan (8 programs, 58 tasks).
- **Programs** are first-class objects (`D.programs`). Managed via the **Programs** button in
  the Plan toolbar (create / rename-with-cascade / recolor / delete; also sets `planStart`).
- **Tasks** = `D.activities`. Hierarchy is grouping by `programId` → `task` (text) → activity.
  Activities can have a `parentId` (nested subtasks — full tasks in their own right).
- **Owners** auto-link to member cards by name (`+`-joined, e.g. `Idris + Ayesha`); unmatched
  tokens stay as text. `projectId` optionally links a task to a project/contract.
- **Scheduling:** `start`/`dueDate` (ISO). When blank, dates fall back to the `phase` month
  off `planStart` (`planActStart`/`planActEnd`).
- **Five views** (segmented control in the toolbar): **List** (grouped, collapsible),
  **Board** (status Kanban, drag-to-change), **Gantt** (month timeline, status-colored bars,
  milestones as diamonds), **Calendar** (by `dueDate`/milestone), **Milestones** (timeline of
  `isMilestone` tasks).
- Each task carries **ongoing status updates** (`updates[]`) and **attachments[]** (reuse the
  `/api/attachments` upload endpoint, or paste links).
- Key functions: `renderPlanView`, `planListHTML`/`planBoardHTML`/`planGanttHTML`/
  `planCalendarHTML`/`planMilestoneHTML`, `openPlanModal`, `savePlan`, `planMigrate`,
  `openProgramsManager`.

### 7b. Accounts & roles (CLIENT-SIDE ONLY)

`D.accounts` holds login accounts with roles **admin / owner (Program Owner) / editor / viewer**.
- Login (`doLogin`) validates email+password against `D.accounts`; session id is in
  `sessionStorage.cf_user`. Seed admin = `khaja@communityforce.com` / `Namtra_CF27`
  (the legacy gate credentials still work and map to that admin).
- `can(action, ctx)` is the permission gate; `applyRoleUI()` (called from `renderView`) shows/
  hides header buttons; the Plan module disables controls per role. **Program Owners** can edit
  only tasks in their `programIds`.
- Manage via the **Accounts** header button (admin only): `openAccountsManager`, `saveAccount`.
- ⚠ **This is UI gating only — it does NOT secure `/api/*`.** See §10.

---

## 8. Views / Features

- **Department View** — org structure; drag people between departments; click a card to edit.
- **Org Chart** — five switchable layouts (segmented control at top): **Hierarchical**
  (top-down `reportsTo` tree), **Flat/Horizontal** (same tree, left-to-right), **Matrix**
  (team × project grid), **Functional** (columns by department), **Division** (columns by
  business line / project). Functions: `renderOrgChartView` → `renderOrgHier` /
  `renderOrgMatrix` / `renderOrgFunctional` / `renderOrgDivision`.
- **120-Day Plan** — task tracker with 5 views, programs, subtasks, updates, attachments,
  roles (see §7a / §7b).
- **Projects / Initiatives / Opportunities / Overhead** — category-filtered views with
  revenue/cost/margin (or potential value / cost-only) and assigned resources. Utilization
  `%` is editable inline on each resource row.
- **Resources View** — resource-centric listing.
- Per-item **description** + **attachments** (file uploads or links).
- **+ Person / Departments / + Project / + Initiative / + Opportunity / + Overhead / Skills /
  Accounts / Admin** (header buttons are role-gated; **Logout** + a user badge are in the header).
- **Export / Import** JSON backups.
- Persistence: loads from `/api/data` (Postgres), autosaves ~1s after edits;
  `localStorage` is an offline cache/fallback.

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
Without `DATABASE_URL` the server still boots; the app falls back to `localStorage`
(no cross-device persistence). **Careful:** running locally against the prod DB edits live data.

### Deploy
```bash
git add -p && git commit -m "..."
git push            # Railway auto-deploys main (~1–3 min)
```
Verify by polling the live URL or watching the Railway deploy logs.

### Logo / favicon assets
The in-app favicon is an inline SVG data URI (set in `index.html`). The header/login use
an inline SVG badge. Downloadable PNG/ICO files are in `brand/`. They were generated with
a throwaway script using `sharp` + `png-to-ico` (was in `C:\Users\idris\brandgen` on the
original machine — not in the repo; recreate if needed).

---

## 10. Known Limitations / TODO

- **Concurrency: last-write-wins.** `app_state` is a single shared row. If two
  browsers/people edit at once, the later save silently overwrites the earlier one.
  Recommended next step: add optimistic-locking via `updated_at`, or poll-and-merge with a
  conflict warning. (Not yet implemented.)
- **Auth is client-side only** — `D.accounts` + roles (admin/owner/editor/viewer) gate the
  **UI** via `can()`/`applyRoleUI()`, but passwords live in the JSON blob and `/api/*` is fully
  open, so any technical user can bypass roles by hitting the API directly. For real protection,
  move auth server-side (hashed passwords, cookie/session, gate the page **and** the API).
  This is the recommended next phase ("Phase B").
- **Attachments capped at 25 MB** each and stored in Postgres `bytea`. Fine for docs/images;
  migrate to S3-style object storage if you expect large media or very many files.
- The "Management" department still exists in Department View even though Management is also
  represented as an Overhead cost center (intentional: people need an org home).

---

## 11. Notes for the next AI session

- The whole app is `index.html`; search the `<script>` block for function names
  (`renderProjView`, `renderOrgChartView`, `openEditProject`, `saveEditProject`,
  `openEditMember`, `serverSave`, `projCat`, `itemRev`).
- **Boot sequence** (changed for accounts): `initApp()` → `bootstrapData()` loads `D` and runs
  `migrate()` (which calls `planMigrate()` + `authMigrate()`) → `currentAccount()` resolves the
  session → `renderView()`. `migrate()` is idempotent and seeds programs/activities/accounts
  on first load (guarded by `planSeeded` / `accounts` presence).
- **Plan module** functions: `renderPlanView`, `planMigrate`, `planFiltered`, `openPlanModal`,
  `savePlan`, `planSetStatus`, `openProgramsManager`. **Org layouts:** `renderOrgHier`,
  `renderOrgMatrix`, `renderOrgFunctional`, `renderOrgDivision`. **Auth:** `can`, `applyRoleUI`,
  `doLogin`, `openAccountsManager`.
- Data edits to live content are done by mutating `D` in the browser console and calling
  `save()` / `serverSave()`, OR through the UI — both persist to Postgres.
- Syntax-check the inline script before deploying by extracting the `<script>` contents and
  running `node --check`.
- Railway deploys are not instant; poll the live URL for a marker string from your change
  before verifying in the browser.
