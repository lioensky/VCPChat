import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagedRoot = process.env.VCPCHAT_PACKAGED_ROOT;
const evidenceOutput = process.env.VCPCHAT_PACKAGED_ARTIFACT_SMOKE_OUTPUT;
const writeEvidence = value => {
    if (!evidenceOutput) return;
    const filename = path.resolve(evidenceOutput);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `${JSON.stringify({ kind: 'unpacked-packaged-artifact-filesystem-smoke', ...value }, null, 2)}\n`, 'utf8');
};
if (!packagedRoot) {
    writeEvidence({ status: 'skipped', reason: 'VCPCHAT_PACKAGED_ROOT was not provided' });
    console.log('Packaged artifact smoke skipped (set VCPCHAT_PACKAGED_ROOT to an unpacked electron-builder directory).');
    process.exit(0);
}
const resolved = path.resolve(packagedRoot);
if (resolved === root) {
    writeEvidence({ status: 'failed', reason: 'packaged root must be separate from the workspace source root' });
    throw new Error('packaged root must be separate from the workspace source root');
}
const appRoot = path.join(resolved, 'resources', 'app');
if (!fs.existsSync(resolved)) {
    writeEvidence({ status: 'failed', reason: `packaged root is missing: ${resolved}` });
    throw new Error(`packaged root is missing: ${resolved}`);
}
if (!fs.existsSync(appRoot)) {
    writeEvidence({ status: 'failed', reason: `packaged resources/app is missing: ${appRoot}` });
    throw new Error(`packaged resources/app is missing: ${appRoot}`);
}
const entry = path.join(appRoot, 'main.js');
if (!fs.existsSync(entry)) {
    writeEvidence({ status: 'failed', reason: `packaged main entry is missing: ${entry}` });
    throw new Error(`packaged main entry is missing: ${entry}`);
}
const packCheck = spawnSync(process.execPath, ['scripts/check-webawesome-pack.mjs', '--root', appRoot], {
    cwd: root,
    encoding: 'utf8',
});
if (packCheck.status !== 0) {
    writeEvidence({ status: 'failed', reason: packCheck.stderr || packCheck.stdout || 'packaged Web Awesome check failed' });
    throw new Error(packCheck.stderr || packCheck.stdout || 'packaged Web Awesome check failed');
}
writeEvidence({ status: 'passed', root: resolved, entry: path.relative(root, entry) });
console.log(`Packaged artifact smoke passed (${resolved}; entry and vendor tree verified).`);
