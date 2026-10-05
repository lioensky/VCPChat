import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = fs.readdirSync(path.join(root, 'tests')).filter(file => /\.test\.(?:js|mjs|cjs)$/.test(file)).sort();
if (!files.length) throw new Error('No test files discovered');
// Some suites intentionally replace process globals. Keep each file isolated,
// and keep profile writes away from the developer's real LOCALAPPDATA.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-all-tests-'));
const report = process.env.VCPCHAT_TEST_REPORT_DIR ? path.resolve(process.env.VCPCHAT_TEST_REPORT_DIR) : path.join(sandbox, 'reports');
fs.mkdirSync(report, { recursive: true });
const env = { ...process.env, LOCALAPPDATA: path.join(sandbox, 'localappdata') };
fs.mkdirSync(env.LOCALAPPDATA);
const totals = { files: files.length, passedFiles: 0, failedFiles: 0, tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, timeouts: 0 };
for (const file of files) {
    let output = '', timedOut = false;
    const code = await new Promise(resolve => {
        const child = spawn(process.execPath, ['--test', path.join('tests', file)], { cwd: root, env, windowsHide: true });
        const timer = setTimeout(() => {
            timedOut = true;
            // This process owns the child and all of its test-only descendants.
            if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            else child.kill('SIGKILL');
        }, 150_000);
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.once('error', error => { output += String(error); clearTimeout(timer); resolve(-1); });
        child.once('close', status => { clearTimeout(timer); resolve(status); });
    });
    const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key =>
        [key, Number(output.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'))?.[1] ?? NaN)]));
    const valid = code === 0 && !timedOut && Object.values(counts).every(Number.isFinite)
        && counts.tests > 0 && !counts.fail && !counts.cancelled && !counts.skipped && !counts.todo;
    totals[valid ? 'passedFiles' : 'failedFiles']++;
    if (timedOut) totals.timeouts++;
    for (const [key, count] of Object.entries(counts)) if (Number.isFinite(count)) totals[key] += count;
    fs.writeFileSync(path.join(report, file + '.txt'), output);
    console.log(`${valid ? 'PASS' : timedOut ? 'TIMEOUT' : 'FAIL'} tests/${file} (${counts.pass} passed)`);
    if (!valid) console.error(output);
    fs.writeFileSync(path.join(report, 'summary.json'), JSON.stringify(totals, null, 2) + '\n');
}
console.log(JSON.stringify(totals));
if (totals.failedFiles) {
    console.error(`Full test logs: ${report}`);
    process.exitCode = 1;
} else {
    // Delete only the uniquely allocated directory owned by this run.
    if (path.dirname(sandbox) !== path.resolve(os.tmpdir()) || !path.basename(sandbox).startsWith('vcp-all-tests-')) throw new Error('Invalid test sandbox');
    fs.rmSync(sandbox, { recursive: true, force: true });
}
