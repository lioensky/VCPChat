'use strict';

const quote = value => "'" + String(value).replace(/'/g, "''") + "'";

/** No second shell: this wrapper runs inside the existing shared PowerShell PTY. */
function buildCaptureWrapper({ scriptPath, outputPath, receiptPath, runId }) {
    return `
$env:PAGER = 'cat'
$env:GIT_PAGER = 'cat'
$env:GIT_TERMINAL_PROMPT = '0'
$ErrorActionPreference = 'Continue'
if (-not ('VcpCommandCaptureWriter' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
public sealed class VcpCommandCaptureWriter : TextWriter {
    readonly TextWriter display;
    readonly TextWriter capture;
    readonly object gate;
    readonly int limit;
    int written;
    public bool Truncated { get; private set; }
    public VcpCommandCaptureWriter(TextWriter display, TextWriter capture, object gate, int limit) {
        this.display = display; this.capture = capture; this.gate = gate; this.limit = limit;
    }
    public override Encoding Encoding { get { return display.Encoding; } }
    public override void Write(char value) { Write(value.ToString()); }
    public override void Write(string value) {
        if (value == null) return;
        lock (gate) {
            int count = Math.Min(value.Length, Math.Max(0, limit - written));
            if (count > 0) capture.Write(value.Substring(0, count));
            written += count;
            if (count < value.Length) Truncated = true;
            display.Write(value);
        }
    }
    public override void WriteLine(string value) { Write(value + NewLine); }
    public override void WriteLine() { Write(NewLine); }
    public override void Flush() { lock (gate) { capture.Flush(); display.Flush(); } }
}
'@ -ErrorAction Stop
}
$vcpOriginalOut = [Console]::Out
$vcpOriginalError = [Console]::Error
$vcpLog = [IO.StreamWriter]::new(${quote(outputPath)}, $false, [Text.UTF8Encoding]::new($false))
$vcpLog.AutoFlush = $true
$vcpGate = [object]::new()
$vcpOut = [VcpCommandCaptureWriter]::new($vcpOriginalOut, $vcpLog, $vcpGate, 262144)
$vcpErr = [VcpCommandCaptureWriter]::new($vcpOriginalError, $vcpLog, $vcpGate, 262144)
$vcpErrors = 0
$vcpTerminated = $false
$vcpWatch = [Diagnostics.Stopwatch]::StartNew()
$global:LASTEXITCODE = $null
try {
    [Console]::SetOut($vcpOut)
    [Console]::SetError($vcpErr)
    $vcpFormatter = { Out-String -Width 4096 -Stream | ForEach-Object { [Console]::Out.WriteLine($_) } }.GetSteppablePipeline()
    $vcpFormatter.Begin($true)
    & ${quote(scriptPath)} *>&1 | ForEach-Object {
        if ($_ -is [Management.Automation.ErrorRecord]) {
            if ($_.FullyQualifiedErrorId -notin @('NativeCommandError', 'NativeCommandErrorMessage')) { $vcpErrors++ }
            [Console]::Error.WriteLine($_.ToString())
        } elseif ($_ -is [Management.Automation.InformationRecord]) {
            $message = $_.MessageData
            if ($null -ne $message -and $null -ne $message.PSObject.Properties['NoNewLine']) {
                if ($message.NoNewLine) { [Console]::Out.Write([string]$message.Message) }
                else { [Console]::Out.WriteLine([string]$message.Message) }
            } else { [Console]::Out.WriteLine([string]$message) }
        } elseif ($_ -is [Management.Automation.WarningRecord]) {
            [Console]::Out.WriteLine('WARNING: ' + $_.Message)
        } elseif ($_ -is [string]) {
            [Console]::Out.WriteLine($_)
        } else {
            $vcpFormatter.Process($_)
        }
    }
    $vcpFormatter.End()
} catch {
    $vcpTerminated = $true
    $vcpErrors++
    [Console]::Error.WriteLine($_.ToString())
} finally {
    $vcpNativeExit = $global:LASTEXITCODE
    [Console]::SetOut($vcpOriginalOut)
    [Console]::SetError($vcpOriginalError)
    $vcpLog.Dispose()
    $vcpWatch.Stop()
    $vcpReceipt = [ordered]@{
        version = 1
        runId = ${quote(runId)}
        executionState = 'completed'
        errorCount = $vcpErrors
        terminatingError = $vcpTerminated
        nativeExitCode = $vcpNativeExit
        durationMs = $vcpWatch.ElapsedMilliseconds
        truncated = ($vcpOut.Truncated -or $vcpErr.Truncated)
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText(${quote(receiptPath + '.pending')}, $vcpReceipt, [Text.UTF8Encoding]::new($false))
    [IO.File]::Move(${quote(receiptPath + '.pending')}, ${quote(receiptPath)})
}
`;
}

function parseCaptureReceipt(text, runId) {
    const receipt = JSON.parse(text);
    if (receipt.version !== 1 || receipt.runId !== runId ||
        receipt.executionState !== 'completed' ||
        !Number.isInteger(receipt.errorCount) || receipt.errorCount < 0 ||
        typeof receipt.terminatingError !== 'boolean' ||
        typeof receipt.truncated !== 'boolean' ||
        !Number.isFinite(receipt.durationMs) || receipt.durationMs < 0 ||
        !(receipt.nativeExitCode === null || Number.isInteger(receipt.nativeExitCode))) {
        throw new Error('Invalid PowerShell completion receipt');
    }
    return receipt;
}

module.exports = { buildCaptureWrapper, parseCaptureReceipt };