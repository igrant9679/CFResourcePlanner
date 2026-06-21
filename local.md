# Atlas — Local Working Notes (Contract Management module)

> Local-only scratch/reference doc (gitignored). Updated 2026-06-21.
> Paste this whole file into a new session to bring the assistant up to speed.
> `PROJECT_HANDOFF.md` is the fuller committed handoff (its top "session state"
> section predates this Contract Management build).

## New-session quick start
| Thing | Value |
|---|---|
| Working dir | `C:\Users\saqib\Documents\CFResourcePlanner` |
| The app | **Atlas** — single-file SPA: `index.html` (HTML+CSS+JS, global `D`); Express `server.js` serving it; Railway Postgres |
| Live URL | https://cfresourceplanner-production.up.railway.app |
| GitHub | `igrant9679/CFResourcePlanner`, branch `main` (push → Railway auto-deploys ~1–3 min) |
| Login (admin) | `khaja@communityforce.com` / `Namtra_CF27` |
| Preview auth | set `sessionStorage cf_user='acct_admin'` + `cf_auth='1'` |
| No build step | edit `index.html` → `node --check` the big `<script>` → preview-verify → `git commit -F` (+Co-Authored-By) → push → confirm live |

**Standing hazards (read before touching prod/server.js):**
- **`server.js` has a held GovWin adapter, uncommitted.** Never commit it. Normal
  `git status` shows ` M server.js` = GovWin only — stage `index.html` explicitly,
  never `git add -A`.
- **Single-row JSONB, last-write-wins.** Editing prod data: `GET /api/data`
  (capture `X-Atlas-Updated-At`) → modify → `POST` with header
  `X-Atlas-Base-Updated-At: <stamp>`; back up to `_backups/` first. Hard-refresh
  before editing in the UI.
- All Contract Management work is **frontend-only** (index.html) + **prod data
  writes via the API**. server.js untouched throughout.

## What this covers
A self-contained **Contract Management** module in `index.html` (the single-file
SPA, global `D`). Nothing here links to org members (`allM`), departments, or
projects — it's deliberately separate. Frontend-only; `server.js` is never
touched (the held GovWin adapter stays uncommitted).

## Contract page tabs (`contractTab`)
`Staff Planning` · `Portfolio Dashboard` · `Project Performance Summary` · `Resource Dashboard`

- **Staff Planning** (`_contractStaffHTML`) — the positions grid. Option-Year
  selector sits at the very top.
- **Portfolio Dashboard** (`_contractDashHTML`) — sub-tabs (`contractDashTab`):
  - **Overview** — summary cards + flow + queue charts + roster chart, then the
    SPHERE block (program panel, critical-path access gates, WS0–WS14), then
    **Team — workstream & load**. The Transformation/Support/overdue cards + flow
    now derive from **live task counts** (active tasks per ws; overdue = late active).
  - **Workstream Details & Resources** (`_ctDashWorkstreamsHTML`) — Transformation
    vs Support panels; manage the resource list; assign people.
  - **Tasks by Group** (`_ctDashByGroupHTML`) — multi-select **Group** filter;
    "By SPHERE Workstream" / "By Transformation/Support" toggle; fully inline-editable
    table (priority, status, T/S, WS, Sprint dropdowns + assign/edit/delete).
  - **Tasks by Sprint** (`_ctDashBySprintHTML`) — same table/filters, grouped by Sprint.
  - **Reports** (`_ctDashReportsHTML`) — exec rollup; task-group status w/ editable
    objectives (+ AI draft).
- **Project Performance Summary** (`_contractPPRHTML`) — exec PMR: accomplishments,
  month picker (by category), throughput, recently delivered, SPHERE, top
  contributors (ranked by **who completed** the task).
- **Resource Dashboard** (`_contractResourceDashHTML`) — per-person; "Completed by"
  box shows tasks the selected resource **completed** (`completedBy`); table ordered
  by completed count; hover tooltips.

## Task data model (`c.dashboard.tasks[]`)
Fields: `id, taskId, name, bucket, ws (Transformation|Support), wsx (WS0–WS14),
priority, progress, due, completedDate, completedBy, late, assignees[], labels[],
desc, source (P|S), sprint`.

- **Source**: `P` = Planner (SAF/CNBB tracker), `S` = Spreadsheet (SPHERE plan).
  Shown as a P/S badge by every task name; editable in the task editor.
- **Counts**: 935 tasks = **777 Planner (P)** + **158 SPHERE (S)**. 679 completed.
- Other dashboard keys: `resources[]`, `groupObjectives{}`, `completedFilter{years,buckets,ws}`,
  `wsClass{}`, `personWs{}`, `sphere{}`, plus seed flags `_taskSeed/V2/V3`,
  `_wsxSeeded`, `_groupObjSeeded`.

## Data sources / how to refresh
- Planner tracker: `Desktop/SAF-CNBB Task Tracker.xlsx` → 777 active+completed tasks.
- SPHERE plan: `Desktop/SPHERE_Project_Plan_Updated_v4 updated.xlsx` ("Project
  Overview" sheet) → 158 tasks (phase-header rows filtered, deduped by name).
- Seed constants `CT_BCLM_TASKS` / `CT_BCLM_RESOURCES` are baked into `index.html`.
  To regenerate: parse the xlsx offline with node (`NODE_PATH` → project node_modules,
  the `xlsx` dep), rebuild the seed, swap into index.html, then merge into prod by
  `taskId` via the API (GET → modify → POST with `X-Atlas-Base-Updated-At`).
- `wsx` (SPHERE workstream) auto-mapped by keyword (ADVANA→WS1, EKR→WS9, DITIP→WS10,
  IDM→WS4, OOC→WS8, …); editable per-task. `sprint` auto-filled for SPHERE tasks
  from their description.

## Prod data writes done (via API, backups in `_backups/`)
Name spelling fixes; task merges (V2 completed history, V3 SPHERE); desc/labels/
completedBy backfills; group objectives seed; opportunity import (13 Lead-Gen opps
under Younus Shah). Prod = single-row JSONB — always fetch fresh + base-stamp guard.

## Conventions
No build step. After editing index.html: extract the big `<script>` and `node --check`
it, preview-verify (set `sessionStorage cf_user='acct_admin'` + `cf_auth='1'`),
commit via `git commit -F` + Co-Authored-By trailer, push to `main` (Railway
auto-deploys ~1–3 min), confirm live by grepping the served page for a marker.

## Open notes / TODO
- Tasks by Group / by Sprint render every row with several inline `<select>`s; with
  completed shown (~900 rows) it's heavy (screenshot tool times out; page still
  responsive). Consider collapsing completed sections or virtualizing if sluggish.
- SPHERE task assignees are stored in the task description (SPHERE-team first names),
  not as `assignees`, to avoid fragmenting the Resource Dashboard with first-name
  duplicates. Could map to full names on request.
- First-pass Transformation/Support classification of completed Planner tasks is
  heuristic; the 2024–2025 archive skews Support "delivered" — use the Completed-scope
  filter to exclude it.

## Change log (newest first)
- `95eb13a` Tasks by Group: multi-select groups; Sprint tag; new Tasks by Sprint tab; live Overview counts
- `495c1eb` Task Source (P/S) + import 158 SPHERE plan tasks
- `e242e9f` Tasks by Group: inline-editable table
- `d2d052a` PPR top contributors ranked by who completed
- `a4495e6` Resource Dashboard ordered by completed count
- `901bcd6` Resource Dashboard completed view = tasks completed by selected resource
- `b7964ed` OY selector to top; SPHERE sections above Team; Completed-by columns
- `6924e8b` Editable + AI task-group objectives
- `b1e7da9` Show Completed By on completed rows
- `7716669` Tasks by Group grouped by SPHERE workstream (WS0–WS14)
- `4ca6f92` Select all/Deselect all on checkbox lists + Completed By
- `da1238a` Added Tasks by Group sub-tab
- `b603862` PPR month picker + by-category; resource hover details
- `852e426` Completed-task scope filter (year/group/workstream)
- `88379ff` Completed tasks + Resource Dashboard + Project Performance Summary
- `822215e` Fix Donald Vanmeter spelling in seed
- `d9c42c1` Short section descriptions
- `22ce10c` Legible task-group headers + Reports tab
- `0a8c4fc` Workstream Details + self-contained resources
- `1be5134` Initial BCLM portfolio dashboard in Contract Management
