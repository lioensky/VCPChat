# ============================================================
# kill_worker.ps1
# Kill the resident ScreenPilot Python worker ONLY.
# Matches by conda env path (vcp_screenshot) so other Python is untouched.
# Node side auto-spawns a fresh worker on the next ScreenPilot request.
# This script ONLY kills; it never restarts.
# ============================================================

$ErrorActionPreference = 'SilentlyContinue'

$procs = Get-Process python -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like '*vcp_screenshot*' }

if (-not $procs) {
    Write-Host '[kill_worker] No ScreenPilot worker running. Nothing to do.' -ForegroundColor Yellow
    exit 0
}

foreach ($p in $procs) {
    Write-Host "[kill_worker] Killing PID=$($p.Id)  $($p.Path)" -ForegroundColor Cyan
    Stop-Process -Id $p.Id -Force
}

Start-Sleep -Milliseconds 600

$still = Get-Process python -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like '*vcp_screenshot*' }

if ($still) {
    Write-Host '[kill_worker] WARNING: some worker still alive, check manually.' -ForegroundColor Red
    exit 1
}

Write-Host '[kill_worker] Done. Worker killed. A new one auto-spawns on next request.' -ForegroundColor Green
exit 0