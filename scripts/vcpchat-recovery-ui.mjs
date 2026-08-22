#!/usr/bin/env node

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { resolveProjectStateRoot } = require('../modules/bootstrap/launch-protocol');
const electron = (() => {
    try { return require(path.join(projectRoot, 'node_modules', 'electron')); } catch { return null; }
})();
const electronBinary = typeof electron === 'string' ? electron : process.env.VCPCHAT_ELECTRON_BINARY;
if (!electronBinary) {
    process.stderr.write('无法找到项目内 Electron；请先运行 npm run doctor。\n');
    process.exitCode = 1;
} else {
    const child = spawn(electronBinary, [path.join(projectRoot, 'bootstrap', 'recovery-main.cjs')], {
        cwd: projectRoot,
        env: { ...process.env, VCPCHAT_PROJECT_ROOT: projectRoot, VCPCHAT_STATE_DIR: resolveProjectStateRoot({ projectRoot }) },
        stdio: 'inherit',
        windowsHide: false,
    });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
