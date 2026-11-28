# 一键编译并装上音频引擎（audio_server.exe）。
#
# 用法（在 VCPChat 目录里双击 rust_audio_engine\scripts\install-audio-server.bat，或在 PowerShell 里）：
#   .\install-audio-server.ps1            编译、自检、备份旧版、装上
#   .\install-audio-server.ps1 -Test      额外跑一遍引擎单元测试
#   .\install-audio-server.ps1 -Rollback  换回上一次备份的引擎
#
# 装到 audio_engine\bin\win32-x64\audio_server.exe：主进程优先用这里的引擎，
# 找不到才退回 audio_engine\audio_server.exe，所以旧文件不用动，回退也只改这一个位置。
# VCPChat 或这个目录的引擎还开着时脚本会停下，不会替你结束进程。

param(
    [switch]$Test,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$RustRoot = Split-Path $PSScriptRoot -Parent
$RepoRoot = Split-Path $RustRoot -Parent
$BinDir = Join-Path $RepoRoot 'audio_engine\bin\win32-x64'
$Target = Join-Path $BinDir 'audio_server.exe'
$Legacy = Join-Path $RepoRoot 'audio_engine\audio_server.exe'
$Built = Join-Path $RustRoot 'target\release\audio_server.exe'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) { Say "[失败] $text" 'Red'; exit 1 }

# ---------- 1. 这个目录的 VCPChat 和引擎都得先退出 ----------
function Get-BlockingProcesses {
    $root = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\') + '\'
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and
        ($_.Name -ieq 'audio_server.exe' -or $_.Name -ieq 'electron.exe' -or $_.Name -ieq 'VCPChat.exe')
    }
}
$blocking = @(Get-BlockingProcesses)
if ($blocking.Count) {
    Say '下面这些进程还开着，请先退出 VCPChat（托盘里也退出），再运行一次：' 'Yellow'
    $blocking | ForEach-Object { Say ("  {0}  PID {1}  {2}" -f $_.Name, $_.ProcessId, $_.ExecutablePath) }
    exit 2
}

# ---------- 回退 ----------
if ($Rollback) {
    $last = Get-ChildItem $BinDir -Filter 'audio_server.exe.bak-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($last) {
        Copy-Item $last.FullName $Target -Force
        Say "已换回 $($last.Name)" 'Green'
    } elseif (Test-Path $Target) {
        # 第一次装之前 bin 里没有引擎：删掉新装的，主进程会退回 audio_engine\audio_server.exe
        Remove-Item $Target -Force
        Say '已删掉新装的引擎，VCPChat 会用回 audio_engine\audio_server.exe' 'Green'
    } else {
        Say '没有可回退的备份。' 'Yellow'
    }
    exit 0
}

# ---------- 2. 工具链 ----------
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Fail '没找到 cargo。先装 Rust（https://rustup.rs ，选默认的 MSVC 工具链），装完重开 PowerShell 再运行。'
}
$hostLine = (& rustc -vV | Select-String '^host:').ToString()
if ($hostLine -notmatch 'windows-msvc') { Fail "当前 Rust 工具链是 $hostLine，需要 x86_64-pc-windows-msvc（rustup default stable-msvc）。" }
Say "Rust: $((& rustc --version))"

# ---------- 3. 编译 ----------
Push-Location $RustRoot
try {
    if ($Test) {
        Say '>>> 跑引擎单元测试…' 'Cyan'
        & cargo test --release --locked --lib
        if ($LASTEXITCODE -ne 0) { Fail '单元测试没通过，没有装新引擎。' }
    }
    Say '>>> 编译 audio_server（release，第一次大约 5 到 10 分钟）…' 'Cyan'
    & cargo build --release --locked --bin audio_server
    if ($LASTEXITCODE -ne 0) { Fail '编译失败，没有装新引擎。上面是 cargo 的报错。' }
} finally { Pop-Location }
if (-not (Test-Path $Built)) { Fail "编译完找不到 $Built" }

# ---------- 4. 自检：用临时端口和临时数据目录起一次，能回 /state 才算好 ----------
Say '>>> 自检新引擎…' 'Cyan'
$port = Get-Random -Minimum 45000 -Maximum 49000
$tmpData = Join-Path $env:TEMP ("vcp-audio-selftest-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpData | Out-Null
$env:VCP_APP_DATA = $tmpData
$proc = Start-Process -FilePath $Built -ArgumentList '--port', $port -PassThru -WindowStyle Hidden
Remove-Item Env:VCP_APP_DATA
$ok = $false
try {
    for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
        Start-Sleep -Milliseconds 250
        if ($proc.HasExited) { break }
        try {
            $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$port/state"
            if ($r.StatusCode -eq 200) { $ok = $true }
        } catch { }
    }
} finally {
    try { Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 2 "http://127.0.0.1:$port/shutdown" | Out-Null } catch { }
    Start-Sleep -Milliseconds 500
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item $tmpData -Recurse -Force -ErrorAction SilentlyContinue
}
if (-not $ok) { Fail '新引擎起不来或不回 /state，没有装。可以手动运行 target\release\audio_server.exe --port 45555 看报错。' }
Say '自检通过。' 'Green'

# ---------- 5. 备份旧版，装上 ----------
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFrom = if (Test-Path $Target) { $Target } else { $null }  # 第一次装时 bin 里还没有，旧的 audio_engine\audio_server.exe 原样留着
if ($backupFrom) {
    Copy-Item $backupFrom (Join-Path $BinDir "audio_server.exe.bak-$stamp") -Force
    Say "旧引擎备份为 audio_engine\bin\win32-x64\audio_server.exe.bak-$stamp"
}
$tmp = "$Target.tmp-$PID"
Copy-Item $Built $tmp -Force
Move-Item $tmp $Target -Force
$hash = (Get-FileHash $Target -Algorithm SHA256).Hash.Substring(0, 12)
$commit = try { (& git -C $RepoRoot rev-parse --short HEAD) } catch { '?' }
Say "已装上：$Target" 'Green'
Say "  提交 $commit，SHA256 $hash"
Say '下次打开 VCPChat 就会用新引擎。要换回旧版：.\install-audio-server.ps1 -Rollback'
