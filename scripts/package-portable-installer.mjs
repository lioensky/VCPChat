import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCommandInvocation } from '../modules/bootstrap/command-invocation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerRoot = path.join(root, 'apps', 'bootstrap-installer');
const targetExe = path.join(installerRoot, 'src-tauri', 'target', 'release', 'VCPChat-Setup.exe');
const outputExe = path.join(root, 'VCPChat-Setup.exe');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const invocation = resolveCommandInvocation(npm, ['run', 'tauri:build', '--', '--no-bundle']);

execFileSync(invocation.command, invocation.args, {
    cwd: installerRoot,
    stdio: 'inherit',
    env: process.env,
});

if (!fs.existsSync(targetExe)) {
    throw new Error(`Tauri portable installer was not produced: ${targetExe}`);
}

fs.copyFileSync(targetExe, outputExe);
console.log(`Portable Tauri installer: ${outputExe}`);
