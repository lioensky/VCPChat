#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failures = [];
const warnings = [];

function exists(relativePath) {
    const target = path.join(root, relativePath);
    if (!fs.existsSync(target)) failures.push(`missing required path: ${relativePath}`);
    return target;
}

function read(relativePath) {
    return fs.readFileSync(exists(relativePath), 'utf8');
}

const packageJson = JSON.parse(read('package.json'));
const installerPackage = JSON.parse(read('apps/bootstrap-installer/package.json'));
const installerLock = JSON.parse(read('apps/bootstrap-installer/package-lock.json'));
const tauri = JSON.parse(read('apps/bootstrap-installer/src-tauri/tauri.conf.json'));

for (const file of [
    'main.js',
    'package-lock.json',
    'scripts/vcpchat.mjs',
    'scripts/vcpchat-dev-launcher.mjs',
    'launchers/VCPChat-Launcher.vbs',
    'launchers/VCPChat-Launcher.command',
    'launchers/VCPChat-Launcher.sh',
    'apps/bootstrap-installer/src-tauri/Cargo.lock',
    'apps/bootstrap-installer/src-tauri/icons/icon.png',
    'apps/bootstrap-installer/src-tauri/icons/icon.ico',
    'docs/project-entrypoints.md',
    'docs/technical-debt.md',
]) exists(file);

for (const [name, command] of Object.entries({
    'vcpchat': 'scripts/vcpchat.mjs',
    'doctor': 'scripts/vcpchat-doctor.mjs',
    'installer:typecheck': 'apps/bootstrap-installer',
    'installer:build': 'apps/bootstrap-installer',
    'installer:portable': 'scripts/package-portable-installer.mjs',
    'check:release-surface': 'scripts/check-release-surface.mjs',
})) {
    if (!packageJson.scripts?.[name]) failures.push(`missing package script: ${name}`);
    else if (command.includes('/') && !fs.existsSync(path.join(root, command))) failures.push(`script ${name} references missing ${command}`);
}

if (!installerPackage.devDependencies?.['@types/node']) failures.push('installer devDependencies missing @types/node');
if (!installerLock.packages?.['']?.devDependencies?.['@types/node']) failures.push('installer lockfile missing @types/node');
if (!Array.isArray(tauri.bundle?.targets) || tauri.bundle.targets.length !== 1 || !tauri.bundle.targets.includes('app')) {
    failures.push('Tauri config must declare only the portable app target');
}
if (!tauri.bundle.icon?.some(file => file.endsWith('.ico'))) failures.push('Tauri config must declare a Windows .ico icon');

for (const generated of ['node_modules', 'dist', 'apps/bootstrap-installer/src-tauri/target', 'VCPChat-Setup.exe']) {
    if (fs.existsSync(path.join(root, generated))) warnings.push(`local build output present (never commit): ${generated}`);
}

const result = { ok: failures.length === 0, root, failures, warnings };
if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
} else {
    console.log(JSON.stringify(result, null, 2));
}
