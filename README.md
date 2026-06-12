# Atlas — CommunityForce Resource Planner

Single-page workforce/resource-planning + AI-assisted proposal-authoring app.
See `PROJECT_HANDOFF.md` for the full architecture, hosting, and sync notes.
This README covers running the app and the **Gov Discovery / RFP Shred /
Annotated Outline** capability modules.

## Run

```bash
npm install
DATABASE_URL=postgres://... node server.js   # Railway provides PORT + DATABASE_URL
npm test                                      # pure-logic tests, no DB / no network
```

## Environment variables

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres (Railway-provided) |
| `ANTHROPIC_API_KEY` | LLM drafting/extraction (org-wide default) |
| `OPENAI_API_KEY`, `GOOGLE_API_KEY` | optional LLM providers |
| `SAM_GOV_API_KEY` | **Gov Discovery**: free key from your SAM.gov account profile (Account Details → Public API Key). Optional — the key can also be entered in-app under **Admin → Integrations → Data Sources** (org-wide; the env var takes precedence if both are set). Without either, the SAM source is skipped and the ingestion log says so; forecast CSV import and USAspending enrichment still work (no key needed). |
| `ATLAS_SYNC_TOKEN` | LevelUp mirror auth (see handoff doc) |

## Gov Discovery (Opportunities → 🛰 Gov Discovery)

- **Sources** (toggle each in 🛰 Gov Discovery → ⚙ Sources; every source fails independently and logs to the ingestion log):
  - **SAM.gov Opportunities API** (key required — env var or Admin → Integrations): presol / sources sought / special / solicitation / combined, last 60 days, paginated politely.
  - **DHS APFS live API** (`apfs-cloud.dhs.gov/api/forecast/`, no key): the full DHS forecast incl. incumbent contractors, contract numbers, and POC emails; filtered to your Company Profile NAICS prefixes; per-record source links to the public-print page.
  - **FPDS ATOM recompete leads** (no key): direct query for contracts in your NAICS with ultimate completion dates 12–18 months out → `[Recompete]` lead records carrying incumbent, value, and end date.
  - **USAspending enrichment** (no key): recompete flags on existing records when a matching incumbent contract is expiring.
  - **Forecast CSV/XLSX imports** (manual upload): GSA Acquisition Gateway, DHS APFS, EPA, generic column adapters.
  - **URL sources** (saved, run daily): paste a direct CSV/XLSX download link (EPA / HHS / DOE / NASA / State / USDA / Commerce / Treasury OSDBU forecast files, data.gov-hosted datasets) or an RSS/ATOM feed (NZ GETS saved-search feeds, state portals like Virginia eVA). "Test now" runs one immediately. Note: Data.gov's CKAN API and the GSA Gateway export have no stable machine endpoints today, so both are covered via file URLs / manual export rather than scraping; SBA SubNet has no public API — revisit if one appears.
  - Bulk sources (APFS, FPDS) require NAICS codes in the Company Profile and skip with a visible notice otherwise — that's what keeps the pipeline relevant instead of firehosed.
- **Run ingestion manually**: the "⟳ Run ingestion now" button in the UI, or `curl -X POST <app>/api/govops/ingest`. A scheduler also runs it automatically about once a day while the server is up. Every run logs source / fetched / new / updated / errors to `ingestion_runs` (visible via "Show ingestion log" or `GET /api/govops/runs`). A source that fails parsing fails alone and surfaces its error — data is never silently dropped.
- **Dedup & lifecycle**: records merge by solicitation number, else fuzzy title+agency+NAICS. The same procurement seen as forecast → sources sought → presolicitation → solicitation becomes ONE record with a timeline; lifecycle never moves backwards.
- **Scoring**: NAICS match, set-aside eligibility, capability-keyword overlap, agency history — sourced from the Company Profile. Weights configurable in app state under `govPipeline.settings.weights` (`{naics,setAside,keywords,agency}`).
- **Saved searches**: star a filter combination; each ingestion run reports new/changed matches per saved search.
- **Pipeline**: Identified → Qualified → Capture → Proposal → Submitted → Won/Lost. "→ Start Proposal" creates a CRM opportunity + a proposal pre-populated with customer, solicitation number, due date, and source link.

### Adding a new agency forecast adapter

Adapters are header-alias maps in `server.js` → `GOV_CSV_ADAPTERS`. Add an entry:

```js
'agency-key': { label: 'Shown in the import dialog', aliases: {
  title: ['their title column', ...], agency: [...], description: [...],
  naics: [...], set_aside: [...], value_text: [...],
  est_solicitation_date: [...], est_award_date: [...], place: [...],
  poc_name: [...], poc_email: [...], solnum: [...] } }
```

then add the same key to the source dropdown in `govImportModal()` in
`index.html`. Header matching is case/punctuation-insensitive and tolerant of
format drift; a row that fails maps to a per-row error, never a dropped file.

## RFP Shred (proposal → Shred tab)

Upload the solicitation + attachments (PDF gets true page-number citations;
DOCX/XLSX/TXT are supported; scanned PDFs are detected and flagged — OCR is
deliberately not bundled yet). "Run Shred" extracts every binding requirement
verbatim with stable `R-###` IDs, type, volume, confidence flag, and source
citations; cross-references L ↔ M ↔ C with orphan detection; extracts format
compliance rules. Amendments diff against the current requirements with
preserved history. The requirements table is human-correctable (edit / merge /
split / restore) and exports a compliance-matrix XLSX. Shred data lives in the
`proposal_shreds` table (`GET/PUT /api/shred/:proposalId`).

## Annotated Outline (proposal → Outline tab)

Generated from the shred; structure mirrors **Section L exactly** (never
reorganized). Each section carries its L instruction, M factors/weights, mapped
requirement IDs, a page allocation proportional to evaluation weight within the
volume page limit (budget table warns on overflow), win-theme slots, and a
writer assignment. "Apply to Sections" turns the outline into the proposal's
sections — drafting then injects each section's mapped requirements into the
prompt automatically, and compliance statuses advance to *drafted* as sections
gain content. Export: annotated outline DOCX.

## Tests

`npm test` exercises the pure logic only (UCF segmentation on the fixture RFP
in `tests/fixtures/`, chunking, requirement IDs, L-M-C orphans, page budgets,
dedup/fuzzy matching, lifecycle ranking, scoring, CSV adapters) — recorded
fixtures, never live API calls.
