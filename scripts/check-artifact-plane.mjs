import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { throw new Error(`Artifact plane check failed: ${message}`); };
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageJson.main !== 'main.js' || !fs.existsSync(path.join(root, packageJson.main))) fail('package main entry is missing');
if (typeof packageJson.scripts?.build !== 'string') fail('build script is missing');
const electronPackage = path.join(root, 'node_modules', 'electron', 'package.json');
if (!fs.existsSync(electronPackage)) fail('Electron package is not installed');
const electron = await import('electron');
const runtime = typeof electron.default === 'string' ? electron.default : electron;
if (typeof runtime !== 'string' || !fs.existsSync(runtime)) fail('Electron runtime binary is missing');
for (const file of ['modules/chat/streamSession.js', 'modules/chat/streamCoordinator.js', 'renderer.js']) {
    if (!fs.existsSync(path.join(root, file))) fail(`source entry missing: ${file}`);
}
const nativeRuntime = process.env.VCPCHAT_NATIVE_RUNTIME_INPUT
    ? path.resolve(process.env.VCPCHAT_NATIVE_RUNTIME_INPUT)
    : path.join(root, 'modules/services/chatDataService/bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vcp_chat_data_service.exe' : 'vcp_chat_data_service');
if (fs.existsSync(nativeRuntime)) console.log(`Native artifact present: ${nativeRuntime}`);
else if (process.env.VCPCHAT_REQUIRE_NATIVE_ARTIFACT === '1') fail(`required native artifact is missing: ${nativeRuntime}`);
else console.warn(`Native artifact not built in this source-plane run: ${nativeRuntime}`);
console.log(`Artifact plane check passed (Electron runtime: ${runtime}).`);
