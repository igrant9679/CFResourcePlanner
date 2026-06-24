@echo off
REM ── Atlas GovWin sync runner (called by the "Atlas GovWin Sync" scheduled task) ──
REM Reads the local Govwin folder, extracts RFP/RFI text, pushes deltas to Atlas.
setlocal
set "REPO=%~dp0.."
set "GOVWIN_DEPS=%LOCALAPPDATA%\atlas-govwin-sync"
set "BASE=https://cfresourceplanner-production.up.railway.app"
REM If you set GOVWIN_INGEST_TOKEN on the server (Railway), set the same here:
REM set "GOVWIN_INGEST_TOKEN=your-shared-secret"
cd /d "%REPO%"
echo ==== %DATE% %TIME% : GovWin sync starting ==== >> "%GOVWIN_DEPS%\sync.log"
node "tools\govwin-sync.mjs" --base "%BASE%" %* >> "%GOVWIN_DEPS%\sync.log" 2>&1
echo ==== %DATE% %TIME% : exit %ERRORLEVEL% ==== >> "%GOVWIN_DEPS%\sync.log"
endlocal
