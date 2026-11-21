const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '../modules/ipc/assistantHandlers.js');
const source = fs.readFileSync(filename, 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ enabled = true, rustEnabled = true, settingsStat, startError } = {}) {
    const events = [];
    const channels = new Map();
    const warnings = [];
    const errors = [];
    let active = false;
    let finishReady;
    const ready = new Promise(resolve => { finishReady = resolve; });
    const adapter = {
        initialize: async () => { events.push('initialize'); },
        onSelection: callback => {
            assert.equal(typeof callback, 'function');
            events.push('onSelection');
        },
        start: () => {
            events.push('start');
            if (startError) throw startError;
            return true;
        },
        waitUntilReady: () => { events.push('wait'); return ready; },
        isActive: () => active,
        setGuardRules: async rules => { events.push(`rules:${rules.blacklist.join(',')}`); },
        stop: () => { active = false; events.push('stop'); },
    };
    class BrowserWindow {
        static getAllWindows() { return []; }
        isDestroyed() { return false; }
        isVisible() { return false; }
        loadFile() { events.push('bar'); }
        once() {}
        on() {}
    }
    const modules = {
        electron: {
            BrowserWindow,
            ipcMain: {
                on: (channel, callback) => channels.set(channel, callback),
                handle: (channel, callback) => channels.set(channel, callback),
            },
            globalShortcut: {
                register: () => { events.push('hotkey'); return true; },
                unregister: () => { events.push('unregister'); },
            },
        },
        path,
        'fs-extra': {
            pathExists: async () => true,
            stat: settingsStat || (async () => ({ mtimeMs: 1 })),
            readJson: async file => file === 'settings.json'
                ? { assistantEnabled: enabled }
                : { useRustAssistant: rustEnabled, blacklist: ['fixture.exe'] },
        },
        './agentHandlers': {},
        '../assistant/assistant-rust-adapter': { createRustAssistantAdapter: () => adapter },
        '../services/windowService': {},
        '../services/windowAppIds': {},
        '../services/preloadPaths': { PRELOAD_ROLES: {}, resolveProjectPreload: () => 'fixture-preload.js' },
    };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        require: name => {
            assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`);
            return modules[name];
        },
        __dirname: path.dirname(filename),
        process: { pid: 123 },
        console: {
            log() {},
            warn: (...args) => warnings.push(args),
            error: (...args) => errors.push(args),
        },
        setInterval: () => { events.push('monitor'); return 1; },
        clearInterval: () => { events.push('clear-monitor'); },
    }, { filename });
    return {
        api: module.exports, events, warnings, errors,
        initialize: () => module.exports.initialize({ SETTINGS_FILE: 'settings.json' }),
        toggle: enable => channels.get('toggle-selection-listener')({}, enable),
        finish: result => { active = result; finishReady(result); },
    };
}

test('cold startup restores saved enabled listener without waiting for Rust READY', async () => {
    const f = fixture();
    await f.initialize();
    await flush();
    assert.deepEqual(f.events, ['initialize', 'onSelection', 'bar', 'start', 'wait']);
    assert.equal(f.api.getSelectionListenerStatus(), false);

    f.finish(true);
    await flush();
    assert.deepEqual(f.events.slice(5), ['rules:fixture.exe', 'monitor', 'hotkey']);
    assert.equal(f.api.getSelectionListenerStatus(), true);
    assert.deepEqual(f.warnings, []);
    assert.deepEqual(f.errors, []);
});

test('both the saved assistant switch and Rust config can prevent startup', async () => {
    for (const options of [{ enabled: false }, { rustEnabled: false }]) {
        const f = fixture(options);
        await f.initialize();
        await flush();
        assert.ok(!f.events.includes('start'));
        assert.equal(f.api.getSelectionListenerStatus(), false);
    }
});

test('manual enable still works after a disabled cold startup', async () => {
    const f = fixture({ enabled: false });
    await f.initialize();
    await flush();
    const starting = f.toggle(true);
    await flush();
    assert.equal(f.events.filter(event => event === 'start').length, 1);
    f.finish(true);
    await starting;
    assert.equal(f.api.getSelectionListenerStatus(), true);
});

test('manual disable wins over a pending startup settings read', async () => {
    let finishStat;
    const blockedStat = new Promise(resolve => { finishStat = resolve; });
    const f = fixture({ settingsStat: () => blockedStat });
    await f.initialize();
    await f.toggle(false);
    finishStat({ mtimeMs: 1 });
    await flush();
    assert.ok(!f.events.includes('start'));
});

test('manual disable during READY wait does not run fallback or activate monitoring', async () => {
    const f = fixture();
    await f.initialize();
    await flush();
    assert.ok(f.events.includes('wait'));
    await f.toggle(false);
    f.finish(false);
    await flush();
    assert.deepEqual(f.events, ['initialize', 'onSelection', 'bar', 'start', 'wait', 'stop']);
    assert.equal(f.api.getSelectionListenerStatus(), false);
});

test('missing binary stays a listener failure, not a main startup failure', async () => {
    const f = fixture({ startError: new Error('Rust assistant binary not found') });
    await f.initialize();
    await flush();
    assert.equal(f.api.getSelectionListenerStatus(), false);
    assert.ok(!f.events.includes('monitor'));
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0][1].message, /binary not found/);
});