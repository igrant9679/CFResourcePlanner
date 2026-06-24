# GovWin → Atlas sync (Hybrid Phase 1)

Ingests the local GovWin capture folder into Atlas's `gov_opportunities` table
(opportunities) and `gov_opp_docs` table (extracted RFP/RFI text). Two paths:

1. **Scheduled local sync** (primary, automated) — `tools/govwin-sync.mjs`, run
   Mon & Thu by a Windows scheduled task. Reads `index.csv` + each opp's document
   folder, extracts text from PDF/DOCX/XLSX/PPTX/TXT (and unzips ZIP bundles),
   and pushes only **new/changed** opps + text. The 364 MB of binaries never
   leave the machine — only extracted text is uploaded. Idempotent by GovWin id.
2. **In-app upload** (manual top-up) — Gov Discovery → **📋 Import GovWin index.csv**
   upserts the opportunity manifest from the browser (no documents).

## Source folder
`C:\Users\saqib\OneDrive - CommunityForce Inc\Documents\Govwin`
- `index.csv` — manifest: `GovWinID, Agency, Title, List, Status, SolicitationDate, EstValue, Folder, Link`
- `AGENCY/<GovWinID> - <TITLE>/…` — the documents for each opportunity.
  (Folders are resolved by **GovWinID prefix**, since the CSV `Folder` column is title-truncated.)

## Why deps live outside OneDrive
The repo's `node_modules` is under OneDrive, which de-hydrates nested files and
breaks `pdf-parse`. `setup-govwin-sync.ps1` installs the extractors into
`%LOCALAPPDATA%\atlas-govwin-sync` and the script loads them via `GOVWIN_DEPS`.
The delta-state file (`.govwin-sync-state.json`) lives there too.

## Setup (one time)
```powershell
./tools/setup-govwin-sync.ps1      # installs deps + registers the Mon/Thu task
```

## Run manually
```bash
# dry run (no writes) — parse + extract + show what would push
GOVWIN_DEPS="$LOCALAPPDATA/atlas-govwin-sync" node tools/govwin-sync.mjs --dry-run --limit 5

# fast coverage check (no extraction)
node tools/govwin-sync.mjs --manifest-only --dry-run

# real sync to production
GOVWIN_DEPS="$LOCALAPPDATA/atlas-govwin-sync" \
  node tools/govwin-sync.mjs --base https://cfresourceplanner-production.up.railway.app
```
Flags: `--base <url>`, `--token <t>` (if `GOVWIN_INGEST_TOKEN` is set server-side),
`--dry-run`, `--manifest-only`, `--limit <n>`, `--folder <dir>`, `--csv <file>`, `--quiet`.

## Server endpoints (Atlas)
- `POST /api/govwin/ingest` — `{opportunities:[…]}` upsert by GovWin id (reuses `govScore`).
- `POST /api/govwin/:govwinId/docs` — `{docs:[{name,kind,sha,chars,text}]}` extracted text.
- `GET  /api/govwin/:govwinId/docs` — doc index for an opportunity.
Optional `GOVWIN_INGEST_TOKEN` env var locks the POST endpoints (sent as `X-Govwin-Token`).
