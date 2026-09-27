$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$themeDir = Join-Path $root 'styles\themes'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$report = Join-Path $root ("theme-wallpaper-missing-$stamp.txt")
if (-not (Test-Path -LiteralPath $themeDir)) { Write-Host "Theme directory not found: $themeDir" -ForegroundColor Red; exit 1 }
$rows = @()
$cssFiles = @(Get-ChildItem -LiteralPath $themeDir -Filter '*.css' -File | Sort-Object Name)
$pattern = '(?im)--chat-wallpaper-(dark|light)\s*:\s*(?:url\(\s*([^)]*)|([^;\r\n]+))'
foreach ($css in $cssFiles) {
    $text = Get-Content -LiteralPath $css.FullName -Raw -Encoding UTF8
    foreach ($m in [regex]::Matches($text, $pattern)) {
        $mode = $m.Groups[1].Value
        $raw = if ($m.Groups[2].Success) { $m.Groups[2].Value.Trim() } else { $m.Groups[3].Value.Trim() }
        $raw = $raw.Trim([char]34, [char]39, [char]32, [char]9)
        if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq 'none') { continue }
        if ($raw -match '^(?i)(https?:|data:|blob:|file:)') { $rows += [pscustomobject]@{ Theme=$css.BaseName; Mode=$mode; Status='remote'; Reference=$raw; Resolved='' }; continue }
        $clean = $raw -replace '/', '\'
        if ($clean.StartsWith('..\')) { $resolved = [IO.Path]::GetFullPath((Join-Path $root $clean.Substring(3))) }
        elseif ([IO.Path]::IsPathRooted($clean)) { $resolved = [IO.Path]::GetFullPath($clean) }
        else { $resolved = [IO.Path]::GetFullPath((Join-Path $css.DirectoryName $clean)) }
        $status = if (Test-Path -LiteralPath $resolved -PathType Leaf) { 'ok' } else { 'missing' }
        $rows += [pscustomobject]@{ Theme=$css.BaseName; Mode=$mode; Status=$status; Reference=$raw; Resolved=$resolved }
    }
}
$missing = @($rows | Where-Object { $_.Status -eq 'missing' })
$checked = @($rows | Where-Object { $_.Status -in @('ok','missing') })
$remote = @($rows | Where-Object { $_.Status -eq 'remote' })
$out = @('VCPChat theme wallpaper report', ('Generated: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')), ('Theme directory: ' + $themeDir), '', ('Theme files: ' + $cssFiles.Count), ('Wallpaper references: ' + $checked.Count), ('Missing: ' + $missing.Count), ('Remote/special: ' + $remote.Count), '')
if ($missing.Count -eq 0) { $out += 'No missing local wallpaper files found.' } else { $out += 'Missing wallpapers:'; foreach ($item in $missing) { $out += ('[' + $item.Theme + '] ' + $item.Mode); $out += ('  Reference: ' + $item.Reference); $out += ('  Expected: ' + $item.Resolved) } }
if ($remote.Count -gt 0) { $out += ''; $out += 'Remote or special references:'; foreach ($item in $remote) { $out += ('[' + $item.Theme + '] ' + $item.Mode + ' ' + $item.Reference) } }
$out | Set-Content -LiteralPath $report -Encoding UTF8
Write-Host ('Checked ' + $cssFiles.Count + ' themes; missing wallpapers: ' + $missing.Count)
Write-Host ('Report: ' + $report)
foreach ($item in $missing) { Write-Host ('[' + $item.Theme + '] ' + $item.Mode + ' -> ' + $item.Reference) }
