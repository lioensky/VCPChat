'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildCaptureWrapper, parseCaptureReceipt } = require('../VCPDistributedServer/Plugin/PowerShellExecutor/commandCapture');
const shell = process.env.VCP_TEST_PWSH || 'pwsh';
const available = !spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeout: 15000 }).error;

function execute(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-capture-test-'));
    try {
        const scriptPath = path.join(dir, 'input.ps1');
        const outputPath = path.join(dir, 'output.txt');
        const receiptPath = path.join(dir, 'receipt.json');
        const wrapperPath = path.join(dir, 'wrapper.ps1');
        fs.writeFileSync(scriptPath, '\ufeff' + script);
        fs.writeFileSync(wrapperPath, '\ufeff' + buildCaptureWrapper({ scriptPath, outputPath, receiptPath, runId: 'capture-test' }));
        const child = spawnSync(shell, ['-NoLogo', '-NoProfile', '-Command', "& '" + wrapperPath.replaceAll("'", "''") + "'"], { encoding: 'utf8', timeout: 30000 });
        assert.ifError(child.error);
        assert.ok(fs.existsSync(receiptPath), child.stderr + child.stdout);
        return {
            output: fs.readFileSync(outputPath, 'utf8'),
            receipt: parseCaptureReceipt(fs.readFileSync(receiptPath, 'utf8'), 'capture-test'),
        };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('receipt rejects foreign identity and malformed state', () => {
    assert.throws(() => parseCaptureReceipt('{"version":1,"runId":"foreign"}', 'expected'));
    assert.throws(() => parseCaptureReceipt('partial', 'expected'));
});

test('real PowerShell captures long strings, Host no-newline and direct Console writes', { skip: !available }, () => {
    const long = '0123456789'.repeat(160);
    const result = execute(`
Write-Output ('0123456789' * 160)
Write-Output '{"path":"H:\\\\VCP\\\\VCPMain","text":"中文 🦆"}'
Write-Host -NoNewline 'HOST_A|'
Write-Host 'HOST_B'
[Console]::Out.Write('DIRECT_A|')
[Console]::Out.WriteLine('DIRECT_B')
[Console]::Error.WriteLine('DIRECT_ERROR')
Write-Warning 'WARNING_TEST'
`);
    assert.ok(result.output.includes(long + '\r\n') || result.output.includes(long + '\n'));
    assert.ok(result.output.includes('HOST_A|HOST_B'));
    assert.ok(result.output.includes('DIRECT_A|DIRECT_B'));
    assert.ok(result.output.includes('DIRECT_ERROR'));
    assert.ok(result.output.includes('WARNING: WARNING_TEST'));
    const json = result.output.split(/\r?\n/).find(line => line.startsWith('{'));
    assert.equal(JSON.parse(json).text, '中文 🦆');
    assert.equal(result.receipt.errorCount, 0);
    assert.equal(result.receipt.truncated, false);
});

test('real PowerShell records nonterminating and terminating errors distinctly', { skip: !available }, () => {
    const result = execute("Write-Error 'NONTERM' -ErrorAction Continue; Write-Output 'AFTER'; throw 'TERM'");
    assert.ok(result.output.includes('NONTERM'));
    assert.ok(result.output.includes('AFTER'));
    assert.ok(result.output.includes('TERM'));
    assert.equal(result.receipt.errorCount, 2);
    assert.equal(result.receipt.terminatingError, true);
});

test('real PowerShell retains native exit code without treating script completion as success', { skip: !available || process.platform !== 'win32' }, () => {
    const result = execute("& $env:ComSpec /d /c 'echo NATIVE_OUT & echo NATIVE_ERR 1>&2 & exit /b 7'; Write-Output ('VISIBLE_EXIT=' + $LASTEXITCODE)");
    assert.ok(result.output.includes('NATIVE_OUT'));
    assert.ok(result.output.includes('NATIVE_ERR'));
    assert.equal(result.receipt.nativeExitCode, 7);
    assert.ok(result.output.includes('VISIBLE_EXIT=7'), result.output);
    assert.equal(result.receipt.errorCount, 0);
});
test('real PowerShell captures explicit tables and plain objects', { skip: !available }, () => {
    const table = execute("@([pscustomobject]@{Name='alpha';Value=7},[pscustomobject]@{Name='中文';Value=42}) | Format-Table -AutoSize");
    assert.ok(table.output.includes('alpha'), table.output);
    assert.ok(table.output.includes('中文'), table.output);
    assert.ok(table.output.includes('42'), table.output);
    assert.equal(table.receipt.errorCount, 0);
    const object = execute("[pscustomobject]@{Name='object-test';Value=123}");
    assert.ok(object.output.includes('object-test'), object.output);
    assert.equal(object.receipt.errorCount, 0);
});

test('real PowerShell parser errors still publish a completion receipt', { skip: !available }, () => {
    const result = execute('function broken {');
    assert.equal(result.receipt.terminatingError, true);
    assert.ok(result.receipt.errorCount > 0);
    assert.ok(result.output.length > 0);
});

test('real PowerShell bounds captured output and reports truncation', { skip: !available }, () => {
    const result = execute("Write-Output ('x' * 600000)");
    assert.equal(result.receipt.truncated, true);
    assert.ok(result.output.length <= 524288);
    assert.ok(result.output.startsWith('x'.repeat(100)));
});
test('two captures share one shell and restore Console writers', { skip: !available }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-shared-capture-'));
    try {
        const wrappers = [1, 2].map(n => {
            const scriptPath = path.join(dir, `input${n}.ps1`);
            const outputPath = path.join(dir, `output${n}.txt`);
            const receiptPath = path.join(dir, `receipt${n}.json`);
            const wrapperPath = path.join(dir, `wrapper${n}.ps1`);
            fs.writeFileSync(scriptPath, '\ufeff' + (n === 1
                ? "$env:VCP_CAPTURE_TEST='shared'; Write-Output ('PID=' + $PID)"
                : "Write-Output ('PID=' + $PID); Write-Output $env:VCP_CAPTURE_TEST"));
            fs.writeFileSync(wrapperPath, '\ufeff' + buildCaptureWrapper({
                scriptPath, outputPath, receiptPath, runId: `shared-${n}`
            }));
            return { wrapperPath, outputPath, receiptPath };
        });
        const driver = path.join(dir, 'driver.ps1');
        const q = p => "'" + p.replaceAll("'", "''") + "'";
        fs.writeFileSync(driver, '\ufeff' + [
            '$beforeOut = [Console]::Out; $beforeErr = [Console]::Error',
            ...wrappers.map(w => '& ' + q(w.wrapperPath)),
            "if (-not [object]::ReferenceEquals($beforeOut, [Console]::Out)) { throw 'Out not restored' }",
            "if (-not [object]::ReferenceEquals($beforeErr, [Console]::Error)) { throw 'Error not restored' }",
        ].join('\n'));
        const child = spawnSync(shell, ['-NoLogo', '-NoProfile', '-File', driver], { encoding: 'utf8', timeout: 30000 });
        assert.ifError(child.error);
        assert.equal(child.status, 0, child.stderr);
        const outputs = wrappers.map(w => fs.readFileSync(w.outputPath, 'utf8'));
        assert.equal(outputs[0].match(/PID=\d+/)[0], outputs[1].match(/PID=\d+/)[0]);
        assert.ok(outputs[1].includes('shared'));
        wrappers.forEach((w, i) => assert.equal(parseCaptureReceipt(fs.readFileSync(w.receiptPath, 'utf8'), `shared-${i + 1}`).errorCount, 0));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});