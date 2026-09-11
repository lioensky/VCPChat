# Pure-Rust Rubato/DSP Audio Engine Dual-Build Script (AVX2 & AVX-512)
# No vcpkg, pkg-config, or native resampler discovery is required.

# Directory Setup
$RootDir = Get-Location
$OutputDir = Join-Path (Split-Path $RootDir -Parent) "audio_engine"
if (!(Test-Path $OutputDir)) { 
    Write-Host "Creating output directory: $OutputDir"
    New-Item -ItemType Directory -Path $OutputDir 
}

# --- 1. Build AVX2 Version ---
Write-Host ">>> Building Rubato/DSP AVX2 Version (x86-64-v3)..." -ForegroundColor Cyan
# IMPORTANT: Use target-specific RUSTFLAGS to avoid crashing build-scripts on host
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = "-C target-cpu=x86-64-v3"
cargo build --release --locked --bin audio_server --target x86_64-pc-windows-msvc --no-default-features --features rubato,loudness-db
if ($LASTEXITCODE -eq 0) {
    if (Test-Path "target/x86_64-pc-windows-msvc/release/audio_server.exe") {
        Move-Item -Path "target/x86_64-pc-windows-msvc/release/audio_server.exe" -Destination (Join-Path $OutputDir "audio_server_rubato_dsp_avx2.exe") -Force
        Write-Host ">>> AVX2 build SUCCESSFUL." -ForegroundColor Green
    } else {
        Write-Host ">>> ERROR: Binary not found in expected target directory." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host ">>> AVX2 build FAILED." -ForegroundColor Red
    exit 1
}

# --- 2. Build AVX-512 Version ---
Write-Host "`n>>> Building Rubato/DSP AVX-512 Version (x86-64-v4)..." -ForegroundColor Cyan
# IMPORTANT: This ensures build-scripts run on host (no AVX-512), while target EXE uses AVX-512
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = "-C target-cpu=x86-64-v4"
cargo build --release --locked --bin audio_server --target x86_64-pc-windows-msvc --no-default-features --features rubato,loudness-db
if ($LASTEXITCODE -eq 0) {
    if (Test-Path "target/x86_64-pc-windows-msvc/release/audio_server.exe") {
        Move-Item -Path "target/x86_64-pc-windows-msvc/release/audio_server.exe" -Destination (Join-Path $OutputDir "audio_server_rubato_dsp_avx512.exe") -Force
        Write-Host ">>> AVX-512 build SUCCESSFUL." -ForegroundColor Green
    } else {
        Write-Host ">>> ERROR: Binary not found in expected target directory." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host ">>> AVX-512 build FAILED." -ForegroundColor Red
    exit 1
}

# Cleanup env
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = ""

Write-Host "`n[DONE] Independent Rubato/DSP A/B outputs exported to: $OutputDir" -ForegroundColor Green
Write-Host "  - audio_server_rubato_dsp_avx2.exe (AVX2-Ready)"
Write-Host "  - audio_server_rubato_dsp_avx512.exe (AVX-512-Ready)"
