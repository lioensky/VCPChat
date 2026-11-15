#!/usr/bin/env node
'use strict';
// Minimal real packaged-runtime smoke for ProjectForge.
// It stages only the files needed to exercise the production asar/as unpacked paths,
// packs them with @electron/asar using the same unpack globs as package.json,
// then runs a real Electron main process from app.asar with isolated userData/DB.
// Temporary artifacts intentionally remain under .forge/pf-asar-smoke.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const electronExport = require('electron');
const electronExe = typeof electronExport === 'string' ? electronExport : electronExport?.default;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeRoot = path.join(root, '.forge', 'pf-asar-smoke');
const appSrc = path.join(smokeRoot, 'app-src');
const resourcesDir = path.join(smokeRoot, 'resources');
const appAsar = path.join(resourcesDir, 'app.asar');
const appUnpacked = `${appAsar}.unpacked`;
const resultPath = path.join(smokeRoot, 'smoke-result.json');

if (!electronExe || !fsSync.existsSync(electronExe)) {
    throw new Error(`Electron executable not found: ${electronExe || '(empty)'}`);
}
if (typeof asar.createPackageWithOptions !== 'function') {
    throw new Error('@electron/asar createPackageWithOptions unavailable');
}

async function copyEntry(relativePath) {
    const source = path.join(root, relativePath);
    const target = path.join(appSrc, relativePath);
    await fs.access(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, dereference: true, force: true });
}

function packageConfigCheck() {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const files = pkg.build?.files || [];
    const unpack = pkg.build?.asarUnpack || [];
    const requiredFiles = [
        'VCPDistributedServer/Plugin/ProjectForge/**/*',
        'ProjectForgemodules/**/*',
        'preloads/**/*',
    ];
    const requiredUnpack = [
        'VCPDistributedServer/Plugin/ProjectForge/**/*',
        'VCPDistributedServer/shared/**/*',
    ];
    for (const entry of requiredFiles) {
        if (!files.includes(entry)) throw new Error(`package.json build.files missing ${entry}`);
    }
    for (const entry of requiredUnpack) {
        if (!unpack.includes(entry)) throw new Error(`package.json build.asarUnpack missing ${entry}`);
    }
    return { files, unpack };
}

async function stage() {
    await fs.rm(smokeRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(appSrc, 'ProjectForgemodules'), { recursive: true });
    await fs.mkdir(path.join(appSrc, 'vendor'), { recursive: true });
    await fs.mkdir(path.join(appSrc, 'Canvasmodules', 'vendor'), { recursive: true });
    await fs.mkdir(path.join(appSrc, 'styles'), { recursive: true });
    await fs.mkdir(path.join(appSrc, 'assets', 'wallpaper'), { recursive: true });
    await fs.mkdir(path.join(appSrc, 'modules', 'ipc'), { recursive: true });

    for (const entry of [
        'VCPDistributedServer/Plugin/ProjectForge',
        'VCPDistributedServer/shared',
        'ProjectForgemodules',
        'preloads',
        'node_modules/codemirror',
        'vendor/marked.min.js',
        'Canvasmodules/vendor/diff_match_patch.js',
        'styles/themes.css',
        'assets/wallpaper/vcp_editorial_ink_light.jpg',
        'assets/wallpaper/vcp_industrial_core_dark.jpg',
        'modules/ipc/projectForgeHandlers.js',
    ]) {
        await copyEntry(entry);
    }

    await fs.writeFile(path.join(appSrc, 'package.json'), JSON.stringify({
        name: 'vcpchat-projectforge-asar-smoke',
        version: '0.0.0',
        private: true,
        main: 'smoke-main.cjs',
    }, null, 2));
    await fs.writeFile(path.join(appSrc, 'smoke-main.cjs'),
        `'use strict';\n(${smokeMain.toString()})().catch(error => {\n` +
        `    console.error('[PF-ASAR-SMOKE] fatal:', error && error.stack || error);\n` +
        `    process.exitCode = 1;\n});\n`);

    const sourcePattern = appSrc.split(path.sep).join('/');
    const unpackPattern = `{${sourcePattern}/VCPDistributedServer/Plugin/ProjectForge/**/*,` +
        `${sourcePattern}/VCPDistributedServer/shared/**/*}`;
    await fs.mkdir(resourcesDir, { recursive: true });
    await asar.createPackageWithOptions(appSrc, appAsar, { unpack: unpackPattern });
    return { unpackPattern };
}

async function smokeMain() {
    const { app, BrowserWindow, ipcMain } = require('electron');
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { spawnSync } = require('node:child_process');

    const smokeRoot = process.env.PF_SMOKE_ROOT;
    if (!smokeRoot) throw new Error('PF_SMOKE_ROOT is required');
    const resultFile = path.join(smokeRoot, 'smoke-result.json');
    const progressFile = path.join(smokeRoot, 'progress.log');
    const progress = (name, detail) => {
        try {
            fs.appendFileSync(progressFile, JSON.stringify({
                at: new Date().toISOString(), name, detail: detail === undefined ? null : detail,
            }) + '\n');
        } catch { /* progress is diagnostic only */ }
    };
    progress('entry-start');
    app.on('window-all-closed', () => progress('window-all-closed'));
    process.on('exit', code => progress('process-exit', code));
    const userData = path.join(smokeRoot, 'userData');
    const sessionData = path.join(smokeRoot, 'sessionData');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(sessionData, { recursive: true });
    app.setPath('userData', userData);
    app.setPath('sessionData', sessionData);
    app.commandLine.appendSwitch('disable-gpu');
    app.disableHardwareAcceleration();

    const result = {
        ok: false,
        startedAt: new Date().toISOString(),
        appPath: null,
        resourcesPath: null,
        userData,
        sessionData,
        configContract: null,
        service: null,
        validation: null,
        gui: null,
        checks: [],
        console: [],
        preloadErrors: [],
        resourceErrors: [],
        didFailLoad: [],
        renderGone: [],
        serviceLogs: [],
    };
    const check = (name, ok, detail) => {
        const item = { name, ok: Boolean(ok), detail };
        result.checks.push(item);
        return item.ok;
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const logs = [];
    const logger = {
        info: (...args) => logs.push(['info', args.map(String).join(' ')]),
        log: (...args) => logs.push(['log', args.map(String).join(' ')]),
        warn: (...args) => logs.push(['warn', args.map(String).join(' ')]),
        error: (...args) => logs.push(['error', args.map(String).join(' ')]),
    };
    let win = null;
    let forge = null;

    function writeResult() {
        result.finishedAt = new Date().toISOString();
        result.serviceLogs = logs;
        result.ok = result.checks.length > 0 && result.checks.every(item => item.ok);
        progress('write-result', { ok: result.ok, failed: result.checks.filter(item => !item.ok).map(item => item.name) });
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        progress('result-written');
        console.log('[PF-ASAR-SMOKE] result ' + JSON.stringify({
            ok: result.ok,
            checks: result.checks.length,
            failed: result.checks.filter(item => !item.ok).map(item => item.name),
            guiConsoleErrors: (result.gui && result.gui.consoleErrors) || [],
        }));
        app.exit(result.ok ? 0 : 1);
    }

    try {
        await app.whenReady();
        result.appPath = app.getAppPath();
        result.resourcesPath = process.resourcesPath;
        check('Electron main is running from app.asar', /app\.asar$/i.test(result.appPath), result.appPath);

        const indexer = require('./VCPDistributedServer/Plugin/ProjectForge/indexerClient.js');
        forge = require('./VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService.js');
        const pluginDir = path.join(__dirname, 'VCPDistributedServer', 'Plugin', 'ProjectForge');
        const serviceBinary = indexer.resolveDefaultBinaryPath();
        const validationWorker = indexer.resolveNativePath(path.join(pluginDir, 'validationWorker.cjs'));
        const validationCwd = indexer.resolveNativePath(path.resolve(pluginDir, '../../..'));
        result.configContract = {
            pluginDir,
            serviceBinary,
            validationWorker,
            validationCwd,
            workerInsideUnpacked: validationWorker.includes('app.asar.unpacked'),
            binaryInsideUnpacked: serviceBinary.includes('app.asar.unpacked'),
        };
        check('default Rust service binary maps to app.asar.unpacked',
            result.configContract.binaryInsideUnpacked && fs.existsSync(serviceBinary), serviceBinary);
        check('validationWorker maps to app.asar.unpacked',
            result.configContract.workerInsideUnpacked && fs.existsSync(validationWorker), validationWorker);
        check('validation cwd exists', fs.existsSync(validationCwd) && fs.statSync(validationCwd).isDirectory(), validationCwd);

        const workspaceRoot = path.join(smokeRoot, 'workspace');
        const dbPath = path.join(smokeRoot, 'db', 'projectforge.db');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const workspace = { id: 'pf-smoke-ws', alias: 'smoke', path: workspaceRoot, enabled: true };
        const workspaceService = {
            list: () => [workspace],
            getActiveWorkspaceId: () => workspace.id,
        };
        forge.initialize({ dbPath, workspaceService, logger });
        const created = await forge.processToolCall({
            command: 'CreateProject', name: 'ASAR Smoke', workspace: 'smoke',
            todos: ['packaged runtime verification'], maid: 'smoke',
        });
        const projectId = created?.details?.project?.id;
        check('temporary project created', Boolean(projectId), projectId || '(missing)');
        if (!projectId) throw new Error('CreateProject did not return a project id');

        const createdFile = await forge.processToolCall({
            command: 'CreateFile', projectId, path: 'smoke.json',
            content: '{"value":1}\n', reason: 'asar smoke fixture', maid: 'smoke',
        });
        check('fixture file created through native service', createdFile?.details?.status === 'ok',
            createdFile?.details || null);

        const good = await forge.processToolCall({
            command: 'EditCode', projectId, path: 'smoke.json',
            target: '{"value":1}', content: '{"value":2}',
            reason: 'exercise real validation worker on a valid edit', maid: 'smoke',
        });
        const filePath = path.join(workspaceRoot, 'smoke.json');
        const afterGood = fs.readFileSync(filePath, 'utf8');
        check('valid edit passed native validation and committed', afterGood === '{"value":2}\n',
            { details: good?.details || null, file: afterGood });

        const bad = await forge.processToolCall({
            command: 'EditCode', projectId, path: 'smoke.json',
            target: '{"value":2}', content: '{"value":',
            revertOnSyntaxError: true,
            reason: 'exercise real validation worker syntax rejection', maid: 'smoke',
        });
        const afterBad = fs.readFileSync(filePath, 'utf8');
        check('syntax error rejected before write',
            bad?.details?.status === 'rejected' && afterBad === '{"value":2}\n',
            { details: bad?.details || null, file: afterBad });

        const runtime = forge._test.getRuntime();
        const info = await runtime.store.info();
        check('Rust service child is live', Boolean(runtime.client?.child?.pid), runtime.client?.child?.pid || null);
        check('temporary project database exists', fs.existsSync(dbPath), dbPath);
        result.service = {
            projectId,
            dbPath,
            serviceBinary,
            validationWorker,
            validationCwd,
            runtimeBinaryPath: runtime.binaryPath,
            configPathWasCreated: Boolean(runtime.configPath) && fs.existsSync(runtime.configPath),
            serviceInfo: info,
            validEditDetails: good?.details || null,
            syntaxRejectDetails: bad?.details || null,
            fileAfterValidEdit: afterGood,
            fileAfterRejectedEdit: afterBad,
        };

        const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
        const envelope = (filePathValue, before, after) => ({
            protocolVersion: 1,
            filePath: filePathValue,
            before,
            after,
            beforeHash: hash(before),
            afterHash: hash(after),
        });
        const invokeWorker = (filePathValue, before, after) => {
            const response = spawnSync(process.execPath, [validationWorker], {
                cwd: validationCwd,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
                input: JSON.stringify(envelope(filePathValue, before, after)),
                encoding: 'utf8',
                timeout: 20000,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
            });
            let parsed = null;
            try { parsed = JSON.parse(response.stdout || '{}'); }
            catch (error) { throw new Error(`worker returned non-JSON: ${error.message}; ${response.stdout}`); }
            if (response.status !== 0 || parsed.ok !== true) {
                throw new Error(`worker failed (${response.status}): ${response.stdout || response.stderr}`);
            }
            return parsed.result;
        };
        const workerNormal = invokeWorker('smoke-normal.json', '{"ok":true}\n', '{"ok":true,"n":2}\n');
        const workerBroken = invokeWorker('smoke-broken.json', '{"ok":true}\n', '{"ok":\n');
        const brokenFatal = (workerBroken.introduced || []).some(item => item.fatal);
        check('worker direct normal review completed cleanly',
            workerNormal.state === 'completed' && (workerNormal.introduced || []).length === 0,
            workerNormal);
        check('worker direct syntax review reports fatal diagnostic',
            workerBroken.state === 'completed' && brokenFatal, workerBroken);
        result.validation = {
            workerPath: validationWorker,
            normal: workerNormal,
            syntax: workerBroken,
        };

        ipcMain.on('app-features:inactive-folders', event => { event.returnValue = []; });
        ipcMain.handle('load-settings', () => ({ currentThemeMode: 'dark' }));
        ipcMain.handle('load-forum-config', () => ({ replyUsername: 'smoke' }));
        ipcMain.handle('git:list-workspaces', () => ({ workspaces: [], activeWorkspaceId: null }));
        ipcMain.handle('is-window-pinned', () => false);
        ipcMain.handle('supports-pin-window', () => false);
        ipcMain.handle('toggle-pin-window', () => false);
        ipcMain.handle('get-platform', () => process.platform);
        ipcMain.handle('get-current-theme', () => ({}));
        ipcMain.handle('path:dirname', (_event, value) => path.dirname(String(value || '')));
        ipcMain.handle('path:extname', (_event, value) => path.extname(String(value || '')));
        ipcMain.handle('path:basename', (_event, value) => path.basename(String(value || '')));
        ipcMain.on('window-lifecycle:ready', () => {});
        ipcMain.handle('state:subscribe', () => ({ state: { degraded: false } }));
        ipcMain.handle('state:unsubscribe', () => true);

        const projectForgeHandlers = require('./modules/ipc/projectForgeHandlers.js');
        projectForgeHandlers.initialize({ ipcMain, workspaceService });

        const asarRoot = app.getAppPath();
        const htmlPath = path.join(asarRoot, 'ProjectForgemodules', 'projectforge.html');
        const preloadPath = path.join(asarRoot, 'preloads', 'utility.js');
        const unpackedHtml = htmlPath.replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked');
        check('GUI html is inside app.asar', htmlPath.includes('app.asar') && fs.existsSync(htmlPath) && !fs.existsSync(unpackedHtml), htmlPath);
        check('actual utility preload exists inside app.asar', fs.existsSync(preloadPath), preloadPath);

        win = new BrowserWindow({
            width: 1320,
            height: 860,
            show: false,
            frame: false,
            title: 'ProjectForge ASAR Smoke',
            webPreferences: {
                preload: preloadPath,
                sandbox: false,
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true,
            },
        });
        const wc = win.webContents;
        const consoleEntries = [];
        wc.on('console-message', (event, level, message, line, sourceId) => {
            let entry;
            if (event && typeof event === 'object' && typeof event.message === 'string') {
                entry = {
                    level: event.level, message: event.message,
                    line: event.lineNumber, sourceId: event.sourceId,
                };
            } else {
                entry = { level, message, line, sourceId };
            }
            consoleEntries.push(entry);
            result.console.push(entry);
        });
        wc.on('preload-error', (_event, preload, error) => {
            result.preloadErrors.push({ preload, error: String(error && error.stack || error) });
        });
        wc.on('render-process-gone', (_event, details) => {
            result.renderGone.push(details);
        });
        wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
            if (isMainFrame) result.didFailLoad.push({ code, description, url });
        });
        wc.session.webRequest.onErrorOccurred(details => {
            if (String(details.url || '').includes('app.asar')) {
                result.resourceErrors.push({ error: details.error, url: details.url });
            }
        });

        const loaded = await new Promise(resolve => {
            const timer = setTimeout(() => resolve({ ok: false, error: 'did-finish-load timeout' }), 25000);
            const done = value => { clearTimeout(timer); resolve(value); };
            wc.once('did-finish-load', () => done({ ok: true }));
            wc.once('did-fail-load', (_event, code, description, url, isMainFrame) => {
                if (isMainFrame) done({ ok: false, error: `${code} ${description}`, url });
            });
            win.loadURL(`file://${htmlPath}`).catch(error => done({ ok: false, error: String(error) }));
        });
        check('BrowserWindow main frame loaded from asar html', loaded.ok, loaded);
        if (!loaded.ok) throw new Error(`GUI load failed: ${JSON.stringify(loaded)}`);

        const snapshotScript = `(() => {
            const resourceNames = performance.getEntriesByType('resource').map(item => item.name);
            return {
                title: document.title,
                readyState: document.readyState,
                apiType: typeof window.utilityAPI?.projectForgeListProjects,
                listProjectsType: typeof window.utilityAPI?.projectForgeListProjects,
                loadSettingsType: typeof window.utilityAPI?.loadSettings,
                codeMirrorType: typeof window.CodeMirror,
                markedType: typeof window.marked,
                scriptCount: document.scripts.length,
                externalScriptCount: Array.from(document.scripts).filter(script => Boolean(script.src)).length,
                asarScriptCount: Array.from(document.scripts).filter(script => String(script.src || '').includes('app.asar')).length,
                addonSimpleModeType: typeof window.CodeMirror?.defineSimpleMode,
                styleSheetCount: document.styleSheets.length,
                asarStyleCount: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).filter(link => String(link.href || '').includes('app.asar')).length,
                asarResourceCount: resourceNames.filter(name => name.includes('app.asar')).length,
                resourceCount: resourceNames.length,
                projectItemCount: document.querySelectorAll('#project-list .project-item').length,
                firstProjectText: (document.querySelector('#project-list .project-item')?.textContent || '').replace(/\\s+/g, ' ').trim(),
                apiFallbackVisible: document.body.textContent.includes('当前窗口没有 ProjectForge API'),
                electronPathType: typeof window.electronPath,
                dateText: (document.querySelector('#project-view')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
            };
        })()`;
        let snapshot = null;
        const uiDeadline = Date.now() + 20000;
        while (Date.now() < uiDeadline) {
            snapshot = await wc.executeJavaScript(snapshotScript, true);
            if (snapshot.projectItemCount > 0 && snapshot.apiType === 'function') break;
            await sleep(250);
        }
        check('utility preload exposes ProjectForge API', snapshot?.apiType === 'function', snapshot?.apiType);
        check('GUI loaded all external scripts and styles from app.asar',
            (snapshot?.externalScriptCount || 0) >= 24 &&
            snapshot?.asarScriptCount === snapshot?.externalScriptCount &&
            (snapshot?.asarStyleCount || 0) >= 5 &&
            (snapshot?.styleSheetCount || 0) >= 5 && snapshot?.scriptCount >= 25,
            snapshot && {
                externalScriptCount: snapshot.externalScriptCount,
                asarScriptCount: snapshot.asarScriptCount, asarStyleCount: snapshot.asarStyleCount,
                asarResourceCount: snapshot.asarResourceCount, resourceCount: snapshot.resourceCount,
                styleSheetCount: snapshot.styleSheetCount, scriptCount: snapshot.scriptCount,
            });
        check('GUI third-party globals loaded (CodeMirror/marked)',
            snapshot?.codeMirrorType !== 'undefined' && snapshot?.markedType !== 'undefined',
            snapshot && { codeMirrorType: snapshot.codeMirrorType, markedType: snapshot.markedType });
        check('GUI CodeMirror simple-mode addon is available for rust.js',
            snapshot?.addonSimpleModeType === 'function', snapshot?.addonSimpleModeType);
        check('GUI real project list rendered from native service',
            (snapshot?.projectItemCount || 0) >= 1 && snapshot?.firstProjectText.includes('ASAR Smoke'),
            snapshot && { projectItemCount: snapshot.projectItemCount, firstProjectText: snapshot.firstProjectText });
        check('GUI did not fall into missing-API fallback', snapshot?.apiFallbackVisible === false, snapshot?.apiFallbackVisible);

        const clicked = await wc.executeJavaScript(`(() => {
            const item = document.querySelector('#project-list .project-item');
            if (!item) return false;
            item.click();
            return true;
        })()`, true);
        let clickedSnapshot = null;
        const clickDeadline = Date.now() + 10000;
        while (Date.now() < clickDeadline) {
            clickedSnapshot = await wc.executeJavaScript(`(() => {
                const view = document.getElementById('project-view');
                return {
                    hidden: !view || view.hidden,
                    text: (view?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 800),
                };
            })()`, true);
            if (clicked && clickedSnapshot.hidden === false && clickedSnapshot.text.includes('ASAR Smoke')) break;
            await sleep(200);
        }
        check('GUI project detail opens through actual ProjectForge IPC handler',
            clicked && clickedSnapshot?.hidden === false && clickedSnapshot?.text.includes('ASAR Smoke'),
            clickedSnapshot);

        const severeConsole = consoleEntries.filter(entry => {
            const level = entry.level;
            return level === 'error' || level === 3 || String(level).toLowerCase() === 'error';
        });
        check('no preload script errors', result.preloadErrors.length === 0, result.preloadErrors);
        check('no BrowserWindow main-frame load failure', result.didFailLoad.length === 0, result.didFailLoad);
        check('no asar resource request errors', result.resourceErrors.length === 0, result.resourceErrors);
        check('no renderer console errors', severeConsole.length === 0, severeConsole);
        check('renderer process did not crash', result.renderGone.length === 0, result.renderGone);

        result.gui = {
            url: wc.getURL(),
            htmlPath,
            preloadPath,
            unpackedHtmlExists: fs.existsSync(unpackedHtml),
            snapshot,
            clicked,
            clickedSnapshot,
            consoleErrorCount: severeConsole.length,
            consoleErrors: severeConsole,
            consoleMessages: consoleEntries,
        };
    } catch (error) {
        result.error = String(error && error.stack || error);
        progress('caught-error', result.error);
        check('smoke run completed without exception', false, String(error && error.message || error));
    } finally {
        progress('finally-start');
        if (win && !win.isDestroyed()) win.destroy();
        if (forge) {
            try {
                await forge.cleanup();
                result.serviceCleanup = 'ok';
            } catch (error) {
                result.serviceCleanup = String(error && error.message || error);
                check('ProjectForge cleanup completed', false, result.serviceCleanup);
            }
        }
        progress('cleanup-done', result.serviceCleanup || 'no-runtime');
        writeResult();
    }
}

async function runElectron() {
    const env = { ...process.env, PF_SMOKE_ROOT: smokeRoot, NODE_OPTIONS: '' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronExe, [appAsar], {
        cwd: smokeRoot,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
    }, 90000);
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    }).finally(() => clearTimeout(timeout));
    await fs.writeFile(path.join(smokeRoot, 'electron.stdout.log'), stdout);
    await fs.writeFile(path.join(smokeRoot, 'electron.stderr.log'), stderr);
    if (!fsSync.existsSync(resultPath)) {
        throw new Error(`Electron exited ${code} without smoke-result.json\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    result.electronExitCode = code;
    result.electronStdoutTail = stdout.slice(-4000);
    result.electronStderrTail = stderr.slice(-4000);
    return { code, result };
}

const buildConfig = packageConfigCheck();
const packed = await stage();
const { code, result } = await runElectron();
const archiveEntries = asar.listPackage(appAsar).map(entry => entry.replace(/\\/g, '/'));
const requiredArchiveEntries = [
    '/ProjectForgemodules/projectforge.html',
    '/ProjectForgemodules/projectforge.js',
    '/VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService.js',
    '/VCPDistributedServer/Plugin/ProjectForge/validationWorker.cjs',
    '/VCPDistributedServer/shared/fileKit/validator.js',
];
const missingArchiveEntries = requiredArchiveEntries.filter(entry => !archiveEntries.includes(entry));
const unpackedBinary = path.join(appUnpacked, 'VCPDistributedServer', 'Plugin', 'ProjectForge', 'bin', 'win32-x64', 'projectforge_indexer.exe');
const unpackedWorker = path.join(appUnpacked, 'VCPDistributedServer', 'Plugin', 'ProjectForge', 'validationWorker.cjs');
const unpackedValidator = path.join(appUnpacked, 'VCPDistributedServer', 'shared', 'fileKit', 'validator.js');
const unpackedHtml = path.join(appUnpacked, 'ProjectForgemodules', 'projectforge.html');
const artifactChecks = {
    archiveEntries: archiveEntries.length,
    missingArchiveEntries,
    unpackedBinaryExists: fsSync.existsSync(unpackedBinary),
    unpackedWorkerExists: fsSync.existsSync(unpackedWorker),
    unpackedValidatorExists: fsSync.existsSync(unpackedValidator),
    htmlRemainsInsideAsar: !fsSync.existsSync(unpackedHtml),
    appAsarBytes: fsSync.statSync(appAsar).size,
};
const harnessOk = result.ok === true && code === 0 &&
    missingArchiveEntries.length === 0 && artifactChecks.unpackedBinaryExists &&
    artifactChecks.unpackedWorkerExists && artifactChecks.unpackedValidatorExists &&
    artifactChecks.htmlRemainsInsideAsar;

console.log(JSON.stringify({
    ok: harnessOk,
    scope: 'minimal real asar runtime smoke, not full installer acceptance',
    buildConfig: {
        filesMatched: buildConfig.files.filter(entry => entry.includes('ProjectForge') || entry.includes('preloads')),
        asarUnpackMatched: buildConfig.unpack.filter(entry => entry.includes('ProjectForge') || entry.includes('shared')),
    },
    pack: {
        appAsar,
        appUnpacked,
        unpackPattern: packed.unpackPattern,
        ...artifactChecks,
    },
    electronExitCode: code,
    result,
}, null, 2));
if (!harnessOk) process.exitCode = 1;
