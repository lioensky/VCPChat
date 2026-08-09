import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(
    projectRoot,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const [script, ...args] = process.argv.slice(2);

if (!script) {
    throw new Error('Usage: node scripts/run-electron-node.mjs <script> [...args]');
}

const child = spawn(electronExecutable, [path.resolve(projectRoot, script), ...args], {
    cwd: projectRoot,
    env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: 'inherit',
    windowsHide: true,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill(signal));
}

const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
        if (signal) {
            resolve(1);
            return;
        }
        resolve(code ?? 1);
    });
});

process.exitCode = exitCode;
