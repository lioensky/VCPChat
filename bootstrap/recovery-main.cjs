'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(process.env.VCPCHAT_PROJECT_ROOT || path.join(__dirname, '..'));
// Recovery is a separate Electron surface. Give it its own identity and
// userData root so opening it never collides with the already-running VCPChat
// main process' Electron single-instance lock.
app.setName('VCPChat Bootstrap');
app.setPath('userData', path.join(app.getPath('appData'), 'VCPChat Bootstrap'));
const { terminateProcess } = require(path.join(projectRoot, 'modules', 'bootstrap', 'process-runner'));
const { managedSpawnOptions } = require(path.join(projectRoot, 'modules', 'bootstrap', 'platform-process'));
let windowRef;
let operation;

function nodeCommand() {
    return process.env.VCPCHAT_NODE_PATH || process.execPath;
}

function scriptPath(name) { return path.join(projectRoot, 'scripts', name); }

function runScript(name, args = [], { streamStdout = true, streamStderr = true } = {}) {
    if (operation) return Promise.reject(Object.assign(new Error('已有 Bootstrap 操作正在运行。'), { code: 'E_OPERATION_BUSY' }));
    return new Promise((resolve, reject) => {
        const child = spawn(nodeCommand(), [scriptPath(name), ...args], {
            cwd: projectRoot,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VCPCHAT_PROJECT_ROOT: projectRoot },
            stdio: ['ignore', 'pipe', 'pipe'],
            ...managedSpawnOptions(),
        });
        operation = child;
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => {
            stdout += String(chunk);
            if (streamStdout) windowRef?.webContents.send('bootstrap:output', { stream: 'stdout', text: String(chunk) });
        });
        child.stderr.on('data', chunk => {
            stderr += String(chunk);
            if (streamStderr) windowRef?.webContents.send('bootstrap:output', { stream: 'stderr', text: String(chunk) });
        });
        child.once('error', error => { operation = null; reject(error); });
        child.once('exit', code => {
            operation = null;
            if (code === 0) resolve({ code, stdout, stderr });
            else reject(Object.assign(new Error(stderr || stdout || `Bootstrap command exited ${code}`), { code: code || 1, stdout, stderr }));
        });
    });
}

function createWindow() {
    windowRef = new BrowserWindow({
        width: 980,
        height: 720,
        minWidth: 720,
        minHeight: 560,
        show: false,
        title: 'VCPChat',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 18 } : undefined,
        backgroundColor: '#252a30',
        webPreferences: {
            preload: path.join(__dirname, 'recovery-preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    windowRef.loadFile(path.join(__dirname, 'recovery.html'));
    windowRef.webContents.once('did-finish-load', () => {
        const smokePath = process.env.VCPCHAT_RECOVERY_SMOKE_PATH;
        if (!smokePath) return;
        fs.writeFileSync(smokePath, `${JSON.stringify({ loaded: true, preload: true })}\n`, 'utf8');
        // Give the initial doctor request enough time to settle before the
        // smoke harness closes the window; otherwise the child is reported as
        // an unexplained null exit even though the UI loaded successfully.
        setTimeout(() => app.quit(), 2_000);
    });
    windowRef.once('ready-to-show', () => windowRef.show());
    windowRef.on('closed', () => { windowRef = null; });
}

ipcMain.handle('bootstrap:doctor', async (_event, deep = true) => {
    const result = await runScript('vcpchat-doctor.mjs', deep ? ['--deep', '--json'] : ['--json'], { streamStdout: false });
    return JSON.parse(result.stdout);
});
ipcMain.handle('bootstrap:plan', async () => {
    const result = await runScript('vcpchat-repair.mjs', ['--json'], { streamStdout: false });
    return JSON.parse(result.stdout);
});
ipcMain.handle('bootstrap:repair', async (_event, args = []) => runScript('vcpchat-repair.mjs', ['--apply', '--yes', ...args]));
ipcMain.handle('bootstrap:launch', async (_event, safe = false) => {
    return runScript(
        'vcpchat.mjs',
        safe ? ['--project-root', projectRoot, '--handoff', '--', '--disable-gpu'] : ['--project-root', projectRoot, '--handoff'],
        { streamStdout: false },
    );
});
ipcMain.handle('bootstrap:cancel', () => {
    if (!operation) return false;
    terminateProcess(operation);
    return true;
});
ipcMain.handle('bootstrap:logs', () => {
    const directory = path.join(process.env.VCPCHAT_STATE_DIR || path.join(projectRoot, 'bootstrap-state'), 'diagnostics');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().reverse().slice(0, 20).map(name => ({ name, path: path.join(directory, name) }));
});
ipcMain.handle('bootstrap:open-log', async (_event, target) => {
    const directory = path.resolve(process.env.VCPCHAT_STATE_DIR || path.join(projectRoot, 'bootstrap-state'), 'diagnostics');
    const resolved = path.resolve(target || '');
    if (!resolved.startsWith(`${directory}${path.sep}`) || !fs.existsSync(resolved)) return false;
    await shell.openPath(resolved);
    return true;
});
ipcMain.handle('bootstrap:quit', () => { app.quit(); return true; });

app.whenReady().then(createWindow);
app.on('before-quit', () => {
    if (operation) terminateProcess(operation);
});
app.on('window-all-closed', () => app.quit());
