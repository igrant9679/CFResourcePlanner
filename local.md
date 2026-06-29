# Atlas — Local Working Notes

> Local-only scratch/reference doc (tracked, but working notes). Updated 2026-06-26.
> Paste this whole file into a new session to bring the assistant up to speed.
> Covers the **Contract Management** module **plus** the GovWin capture pipeline,
> Proposals, and Strategy work added since. `PROJECT_HANDOFF.md` is the older
> committed handoff and predates most of this.

## New-session quick start
| Thing | Value |
|---|---|
| Working dir (reliable) | `C:\Users\saqib\OneDrive - CommunityForce Inc\Documents\CFResourcePlanner` — the **OneDrive-redirected** path. The plain `C:\Users\saqib\Documents\CFResourcePlanner` is a junction that can stop resolving mid-session. Prefer the OneDrive path; quote it (spaces). |
| The app | **Atlas** — single-file SPA: `index.html` (HTML+CSS+JS, global `D`); Express `server.js` serving it + APIs; Railway Postgres |
| Live URL | https://cfresourceplanner-production.up.railway.app |
| GitHub | `igrant9679/CFResourcePlanner`, branch `main` (push → Railway auto-deploys ~1–3 min) |
| Login (admin) | `khaja@communityforce.com` / `Namtra_CF27` |
| Preview auth | set `sessionStorage cf_user='acct_admin'` + `cf_auth='1'` |
| No build step | edit `index.html` → `node --check` the big `<script>` → preview-verify (if possible) → `git commit -F` (+Co-Authored-By) → push → confirm live by grepping the served page for a marker |
| GovWin sync deps | extractors (pdf-parse/mammoth/jszip/xlsx) live OUTSIDE OneDrive at `%LOCALAPPDATA%\atlas-govwin-sync`; the sync script loads them via the `GOVWIN_DEPS` env var |

**Standing hazards / environment quirks (read before touching prod / server.js):**
- **OneDrive flakiness.** Repo + `node_modules` are under OneDrive, which de-hydrates nested files — it broke `pdf-parse` locally (empty vendored dir), which is why the GovWin extractor deps live OUTSIDE OneDrive. The plain `Documents\CFResourcePlanner` path is a junction and can break; use the OneDrive path.
- **`server.js` is committed and active** (GovWin IQ API adapter + ingest/score endpoints, landed 2026-06-23). The old "never commit server.js" rule is **RETIRED**. Still stage files explicitly (never `git add -A`). The GovWin IQ API path stays dormant without `GOVWIN_*` creds.
- **Single-row JSONB, last-write-wins.** Prod data edits: `GET /api/data` (capture `X-Atlas-Updated-At`) → modify → `POST` with header `X-Atlas-Base-Updated-At: <stamp>`; **back up to `_backups/` first**. PROTECTED_ARRAYS guard 409s if a key array would shrink to 0. Hard-refresh before UI edits.
- **No `DATABASE_URL` in the shell** → can't run `server.js` locally. The Claude_Preview server (`npm start`, name `atlas` in `.claude/launch.json`) historically had the DB but the launch config is flaky. Server endpoints are verified at deploy on Railway (poll the served page / hit the endpoint).

## Major areas
1. **Contract Management** (`renderContractsView`) — standalone **BCLM** contract: OY staffing (`c.positions[]`) + a task tracker (`c.dashboard.tasks[]`). Self-contained (no `allM`/projects). Tabs below.
2. **GovWin Discovery** (Opportunities → 🛰 Gov Discovery) — capture pipeline: folder/CSV ingest, deterministic fit score, AI Bid/No-Bid scoring, No-Bid disposition, in-app doc viewer, stage kanban board. Backed by `server.js` + `gov_opportunities`/`gov_opp_docs` tables.
3. **Proposals** — per-section include checkboxes; custom-prompt section scoping; new "To Be Drafted" status.
4. **Strategy** — Break-even "Simulate Cuts" now drives the whole Overview (`_stratCashCut`).

## Contract page tabs (`contractTab`)
`Staff Planning` · `Portfolio Dashboard` · `Project Performance Summary` · `Resource Dashboard`

- **Staff Planning** (`_contractStaffHTML`) — positions grid; Option-Year selector at top. Filters `contractFilter{oy,company,group,status,hideTBD}`. OY2→OY3 delta highlighting (computed, `_ctBuildOyDelta`) + persisted `p.review{flag,note}` markup (green add / amber change / red review) used for chart reconciliation.
- **Portfolio Dashboard** (`_contractDashHTML`) — sub-tabs (`contractDashTab`): Overview (cards/flow/queue/roster + SPHERE block + Team workstream&load; cards derive from live task counts), Workstream Details & Resources (`_ctDashWorkstreamsHTML`), Tasks by Group (`_ctDashByGroupHTML`, multi-select group filter, WS/T-S toggle, inline-editable), Tasks by Sprint (`_ctDashBySprintHTML`), Reports (`_ctDashReportsHTML`, exec rollup + editable/AI objectives).
- **Project Performance Summary** (`_contractPPRHTML`) — exec PMR; month picker; throughput; SPHERE; top contributors by who completed.
- **Resource Dashboard** (`_contractResourceDashHTML`) — per-person; grouped Transformation/Support; surfaces SPHERE desc-assignees (first-name→full-name); "Completed by" view.

## Task data model (`c.dashboard.tasks[]`)
Fields: `id, taskId, name, bucket, ws (Transformation|Support), wsx (WS0–WS14), priority, progress, due, completedDate, completedBy, late, assignees[], labels[], desc, source (P|S|MSR), sprint`.
- **Source**: `P` = Planner (SAF/CNBB tracker), `S` = Spreadsheet (SPHERE), **`MSR` = Monthly Status Report** (purple badge). `_ctSrc`/`_ctSrcLabel`/`_ctSrcBadge`; editable in the task editor.
- **Counts (2026-06-25): 1305 tasks** = 777 P + 158 S + **370 MSR** (330 completed accomplishments + 40 Not-started planned activities; planned also carry label `planned`). MSR tasks bucketed by LOE/category; generic **"MSR Accomplishments" (37)** is a catch-all for bullets whose slide had no category header.
- Other dashboard keys: `resources[]`, `groupObjectives{}`, `completedFilter{years,buckets,ws}`, `wsClass{}`, `personWs{}`, `sphere{}`, seed flags.

## Staff Planning positions (`c.positions[]`) — OY staffing (separate from tasks)
Fields: `id, oy ('OY2'|'OY3'), resource, fte, company, lcat, role, workstreamGroup, status (Filled/TBH/TBD/Reserve), rateHr, annualCost, civilianLead, contractorLead, pwsRef, review{flag,note}`. Annual = `rateHr*fte*1860` (OY3 prorated convention). OY3 reconciled vs the latest org chart (2026-06-24/25) — review markup written to prod; a few confirms still pending (Cloud/ICAM names, TBH role labels, the "Liz" box).

## GovWin pipeline (server.js + index.html)
- **Tables**: `gov_opportunities` (id `govwin_<GovWinID>`; `score`=fit; `no_bid`/`no_bid_reason`; `bid_score`/`bid_band`/`bid_rationale`/`bid_dims`/`bid_risks`), `gov_opp_docs` (extracted RFP/RFI text by GovWinID — **text only; binaries stay local**).
- **Endpoints**: `POST /api/govwin/ingest`, `POST|GET /api/govwin/:id/docs`, `GET /api/govwin/:id/doctext`, `POST /api/govwin/:id/score`; plus existing `/api/govops` (list/patch/ingest), `/api/llm/complete`.
- **Sync tool**: `tools/govwin-sync.mjs` (+ `govwin-sync.cmd`, `setup-govwin-sync.ps1`, `GOVWIN_SYNC.md`). Reads `…\OneDrive…\Documents\Govwin\index.csv` + per-agency `<GovWinID> - <Title>/` doc folders (resolves folders by GovWinID prefix — the CSV `Folder` col is truncated), unzips + extracts PDF/DOCX/XLSX/PPTX text, pushes deltas. Run: `GOVWIN_DEPS="%LOCALAPPDATA%\atlas-govwin-sync" node tools/govwin-sync.mjs --base https://cfresourceplanner-production.up.railway.app [--dry-run|--manifest-only|--limit N]`.
- **Bid/No-Bid**: the **fit** score (deterministic `govScore` vs `D.companyProfile`) is SEPARATE from **bid_score** (AI 9-dim weighted rubric over the RFP docs + company/partner knowledge; default `claude-sonnet-4-5`). Gov **stages** (identified→…→won/lost) are a capture funnel SEPARATE from CRM `OPP_STAGES`; promotion (→ CRM Opp / → Start Proposal, or stage dropdown → Qualified/Proposal) bridges to the pipeline + a **"To Be Drafted"** proposal.
- **Status**: first sync DONE — **232 opps + ~681 docs + 57 MB text** in prod. **PENDING**: register the Mon/Thu scheduled task (`./tools/setup-govwin-sync.ps1`); bulk-score the 232 (⚖ Score unscored — real LLM cost); set `SAM_GOV_API_KEY` on Railway (still unset); optional `GOVWIN_*` creds for the live IQ API.

## Conventions
No build step. After editing `index.html`: extract the big `<script>` and `node --check` it; preview-verify if the preview server is up (`sessionStorage cf_user='acct_admin'`+`cf_auth='1'`); commit via `git commit -F` + Co-Authored-By trailer; push to `main`; confirm live by grepping the served page for a marker. Data-only changes go via the API with the base-stamp guard + a `_backups/` snapshot first.

## Prod data writes done (via API, backups in `_backups/`)
Earlier: name fixes; task merges (V2 completed, V3 SPHERE); desc/labels/completedBy backfills; group objectives; 13 Lead-Gen opps. This session: GovWin first sync (232 opps + docs); **OY3 copy of Kierra Byrd** (rate 147.52); **OY3 chart-reconciliation review markup** + 4 green TBH placeholders; **369 MSR items captured** → corrected to **330 completed + 40 planned** + 3 Program-Oversight boilerplate reverts; **bucket tidy** (28 remaps, 37→24 buckets). **2026-06-26 (data-only, additive):** duplicated **FAMS OY2 → "C1 FAMS OY3"** project (`id_1782404396651_25z2o`, POP 2026-09→2027-09, FY2027, $76,944/mo timeline shifted to OY3; 3 resources Melissa Jones/Hashim Kalla/Ajaz Ahmed Beigh re-allocated via allocSchedule; 8 activities copied, contract-end milestone shifted to 2027-09-24); added **118 current customers to Educian Software** as `subClients` (112 Kashmir Schools + 6 Higher Education from `Educian Billing Details.xlsx`, $42,854 ARR → $3,571/mo, `revenueFromSubs:true`, Expentor note preserved) — mirrors the Awards Mgmt Platform subClients pattern. Backups `prod_data_20260625_pre_famsoy3.json` / `prod_data_20260625_pre_educian.json`. All reversible via `source`/`labels`; always fetch fresh + base-stamp guard.

## Open notes / TODO
- Task views (Tasks by Group / by Sprint) now render ~1305 rows with inline `<select>`s — heavy. Use the **Completed-scope filter**; consider a **source filter (P/S/MSR)** and/or virtualization.
- The generic **"MSR Accomplishments" (37)** bucket could be keyword-categorized into proper LOEs on request.
- **OY3 reconciliation** has a few open confirms (Cloud/ICAM Norman/Perry vs MB/Cloud Architect; TBH role relabels; the grey "Liz" box). The amber/red items are comments only — apply for real on confirmation.
- SPHERE task assignees live in the task `desc` (first names), surfaced via first-name→full-name map; could map to full names everywhere on request.
- First-pass T/S classification of completed Planner tasks is heuristic (2024–25 archive skews Support); MSR `ws` is keyword-inferred — adjustable per-task.

## Change log (newest first)
- `20422ba` Gov Discovery **Reports** made configurable/sophisticated: **metric toggle** (Count vs Pipeline value) reskins every breakdown; **"Break down by"** dropdown with 11 dimensions (stage, agency, sub-agency, NAICS, set-aside, lifecycle, bid band, fit band, value band, new-vs-recompete, no-bid status) via reusable `GOV_RPT_DIMS`/`_govRptSeries`; 8 KPI cards (count+distinct agencies, pipeline value, avg/median value, scored %, avg fit, no-bid %, recompetes, won/lost); fit-score distribution histogram + metric-aware by-value-band/by-stage/by-bid-band charts; Top-12 opportunities-by-value table. State `_govRpt{metric,dim}` + `govRptSet`; toggles recompute client-side from the loaded list (no refetch); still respects the filter bar.
- `565f227` Gov Discovery: **Agency filter → dropdown** ("All agencies" + union of full agency set captured into `_govState.agencies` on an unfiltered load + current-list agencies + active selection, so options never collapse) and **Reports tab** added — List/Board toggle replaced by three view buttons (List/Board/Reports); `_govReportsHTML` renders pipeline analytics over the current (filtered) list. Display-only, no server changes.
- `403071b` Contract Staff Planning: **Alternate (backup resource) per position** + **OY2→OY3 role-change indicator**. (1) New **Alternate** column in the positions grid (after Resource) + edit-form field, stored as `p.alternate`, inline-editable via `contractUpdatePos` — a backup resource per seat (display/data only; doesn't feed cost or the delta). (2) `_ctBuildOyDelta` now also detects **role** changes per resource between OY2/OY3 (case-insensitive compare) — flags the amber change-highlight with a `role: old→new` note merged with any FTE/company change; legend now reads "FTE / company / role changed". Empty-row colspan bumped 11→12.
- `4ded3c5` PPR: **Sources filter** (P/S/MSR) in "Accomplishments by category" — `_ctPPRSrc`/`ctPPRSetSrc`; cascading dropdown (month → source → category) narrows the month-scoped completed set before grouping, so category options/counts and the render re-scope to the selected source; subtitle + empty-state mention the active source
- `7752dc9` Contract Staff Planning: computed **Funding gap** KPI (`Contract floor − Annual cost`) beside Contract floor — green when ≥0, red when cost exceeds the floor; shows only when a floor is set; uses the same filtered annual cost as the Annual cost KPI
- `db100ea` Access Control: made **Section Visibility authoritative**. (1) `renderContractsView` gated on `canProforma()` (admin-only) so a granted Contracts section still showed "restricted to Admin" → now gates on `canSee('contracts')`. (2) `canSee('prop')`/`canSee('recruit')` returned `canProposal()`/`canRecruit()` and ignored `D.sectionVis` entirely (matrix toggle was a no-op) → `canSee` now treats an explicit grant/revoke as authoritative; an UNSET cell falls back to the module capability (preserves defaults). Edit actions stay capability-gated (read-only when a tab is granted to a non-capable role); Proforma/Strategy stay admin-only by design. Note: every non-admin account is role `editor` — there are NO `viewer`-role accounts (so role-level toggles hit all editors; set an account's role to `viewer` for read-only). Contract Mgmt has no separate edit gate yet (granted = full edit).
- `1f597f0` Proposals: **SBIR/STTR proposal templates** — two agency-agnostic templates seeded into `D.proposalTemplates` alongside `tpl_cf_technical`: **`tpl_sbir_phase1`** (Phase I, 15 sections) and **`tpl_sbir_phase2`** (Phase II / Direct-to-Phase-II, 16 sections, modeled on the real InsightForge-AI SF254-D1201 D2P2). Each AI section has an SBIR/STTR-tuned prompt (phase-feasibility framing, Phase III nexus, ITAR/foreign-national disclosure, use-only-real-data guardrails) that adapts to the loaded topic context. Purely additive: `_sbirPhase1Template()`/`_sbirPhase2Template()` + idempotent seed block (`sbirTemplatesSeeded` flag). No server changes — plugs into existing New-proposal → template pick → Sections materialize → Draft All Sections / include checkboxes / custom-prompt scoping / assembly. Best output when the topic doc is attached (RFP/topic upload) and Knowledge Bank/Company Profile carry real award + team data.
- `18d107b` PPR: **category filter** in "Accomplishments by category" (Project Performance Summary) — `_ctPPRCat` state + `ctPPRSetCat` setter mirror the month-filter pattern; "All categories (N)" dropdown beside the month picker narrows both render modes; orthogonal to the month filter (they combine); self-clears if the category isn't present after a month change
- `c351413` Contract tasks: added **MSR** task source (purple badge, editor + _ctSrc/_ctSrcBadge). Then captured MSR items from the 9 monthly decks into BCLM tasks — all source=MSR, label MSR, bucket=LOE/category, ws keyword-inferred. Final state (data-only, prod writes, backups in _backups/): **BCLM tasks 935→1305; MSR=370 → 330 Completed accomplishments + 40 Not-started planned activities** (planned also carry label 'planned'). Note: planned bullets sit above the slide's "Planned Activities" footer so the first accomplishment pass mis-swept 42 as Completed → corrected to Not-started; 3 recurring Program-Oversight boilerplate lines reverted to Completed. Reversible via source=MSR / labels. Bucket tidy: remapped 28 stray task-sentence/one-off buckets to proper LOE/categories + merged SPHERE near-dupes (37→24 distinct); generic "MSR Accomplishments" (37) kept as catch-all
- `163b59b` Gov Discovery: pipeline board (kanban by gov stage) — List/Board toggle, drag-to-change-stage (drag→Qualified/Proposal still prompts promote via govStageChange), optimistic govSetStage. Gov stages are a capture funnel SEPARATE from the CRM OPP_STAGES pipeline; promotion bridges them
- `230513a` Staff Planning: "Hide TBD" filter toggle — excludes status=TBD positions (`contractFilter.hideTBD`), wired into filter/Clear/anyFilter
- `3dc47eb` Staff Planning: render persisted `p.review` markup (chart-reconciliation comments/colors) — add=green/change=amber/review=red, priority over computed delta. Used to mark OY3 vs latest org chart (annotations + 4 green TBH placeholders written to prod, backup in _backups/)
- `dce8a8f` Contract Staff Planning: OY2→OY3 delta highlighting — per-resource compare (computed, no data write) colors position rows green=NEW in OY3 / amber=FTE-or-company changed / red=removed, + legend; company designation suffixes normalized out (`_ctBuildOyDelta`)
- `748a00f` Gov Discovery: stage dropdown promotes — Qualified→create CRM opp, Proposal→start proposal (confirm + no-dup guard via govOppId; decline = label only); added "To Be Drafted" PROP_STATUS, gov-pipeline proposals land there (`govStageChange`)
- `5a187aa` Gov Discovery: in-app RFP/RFI document viewer — `📎 Docs (N)` per opp opens a list + reads extracted text (`GET /api/govwin/:id/doctext`; `doc_count` in /api/govops). Originals stay local (text-only in `gov_opp_docs`)
- `5fe48a4` Bid scoring: max_tokens 3000 (fix JSON truncation) + tolerant parse
- `32f4654` Gov Discovery: AI Bid/No-Bid scoring Phase 2 — POST /api/govwin/:id/score (opp + RFP docs + Company Profile → 9-dim rubric → band/score/rationale/risks); per-opp Score button + band chip + assessment panel + "Score unscored" bulk + band filter
- `04bc61d` Gov Discovery: No Bid disposition (no_bid column + per-opp toggle/badge/filter `govSetNoBid`); GovWin sync robustness (strip NUL/C0, non-fatal per-opp, incremental state)
- `618be55` GovWin ingest Hybrid Phase 1: gov_opp_docs + /api/govwin/ingest + /docs, Gov Discovery "Import GovWin index.csv", tools/govwin-sync.mjs (+cmd/ps1/md); commits held GovWin IQ API adapter. First sync: 232 opps + 681 docs + 57MB text
- `03ebf46` Proposals: editable custom prompt on Sections tab + "Select sections from prompt" — parses section refs (1.2/1.4, "Section 3", or titles) → sets include flags, scoping both AI gen and assembled output (`_propSectionsMatchingPrompt`/`pdScopeSectionsFromPrompt`)
- `4187a84` Proposals: per-section include checkboxes (default all on) — gate both "Draft All Sections" AI gen and the assembled/printed proposal (`_secIncluded`/`pdToggleSectionInclude`)
- `0616b74` Resource Dashboard: group resources by Transformation/Support + surface SPHERE desc-assignees (first-name→full-name map); Strategy: Break-even cuts now drive the whole Overview (`_stratCashCut`)
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
