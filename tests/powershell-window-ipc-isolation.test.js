const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const executorPath = path.join(
    projectRoot,
    'VCPDistributedServer',
    'Plugin',
    'PowerShellExecutor',
    'PowerShellExecutor.js'
);
const preloadPath = path.join(
    projectRoot,
    'VCPDistributedServer',
    'Plugin',
    'PowerShellExecutor',
    'gui',
    'preload.js'
);

test('PowerShell executor does not subscribe to application-wide window control channels', () => {
    const source = fs.readFileSync(executorPath, 'utf8');

    for (const channel of ['minimize-window', 'maximize-window', 'close-window']) {
        assert.doesNotMatch(
            source,
            new RegExp(`ipcMain\\.on\\(['"]${channel}['"]`),
            `PowerShell executor must not subscribe to global channel "${channel}"`
        );
    }

    for (const channel of [
        'powershell-window:minimize',
        'powershell-window:toggle-maximize',
        'powershell-window:close'
    ]) {
        assert.match(
            source,
            new RegExp(`ipcMain\\.on\\(['"]${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
            `PowerShell executor must subscribe to isolated channel "${channel}"`
        );
    }

    assert.match(
        source,
        /event\.sender\s*===\s*guiWindow\.webContents/,
        'PowerShell window controls must authenticate the sender webContents'
    );
});

test('PowerShell preload sends only namespaced window control messages', () => {
    const exposed = {};
    const sent = [];
    const contextBridge = {
        exposeInMainWorld(name, value) {
            exposed[name] = value;
        }
    };
    const ipcRenderer = {
        on() {},
        removeListener() {},
        invoke() {},
        send(channel, ...args) {
            sent.push([channel, ...args]);
        }
    };

    vm.runInNewContext(fs.readFileSync(preloadPath, 'utf8'), {
        require(moduleName) {
            assert.equal(moduleName, 'electron');
            return { contextBridge, ipcRenderer };
        },
        Set,
        Error
    }, { filename: preloadPath });

    exposed.electronAPI.minimizeWindow();
    exposed.electronAPI.maximizeWindow();
    exposed.electronAPI.closeWindow();

    assert.deepEqual(sent, [
        ['powershell-window:minimize'],
        ['powershell-window:toggle-maximize'],
        ['powershell-window:close']
    ]);
    assert.equal(
        sent.some(([channel]) => ['minimize-window', 'maximize-window', 'close-window'].includes(channel)),
        false
    );
});