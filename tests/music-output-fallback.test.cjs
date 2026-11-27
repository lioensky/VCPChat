// 独占模式打不开、选的声卡被拔掉时，引擎会自己退回共享模式 / 默认设备继续放。
// 以前界面照旧显示「独占」「某某声卡」，用户以为在用独占输出；现在设备下面要说清实际在用什么。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ engineState } = {}) {
    const note = { textContent: '', hidden: true };
    const context = vm.createContext({
        console, setTimeout, clearTimeout,
        document: { getElementById: (id) => (id === 'output-fallback-note' ? note : null), createElement: () => ({}) }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-output.js'), 'utf8'), context);
    const app = {
        deviceSelect: { value: 'default', disabled: false, innerHTML: '', appendChild() {} },
        wasapiSwitch: { checked: true, disabled: false },
        currentDeviceId: null, useWasapiExclusive: false,
        api: {
            configureMusicOutput: async () => ({ status: 'success', state: engineState }),
            getMusicState: async () => ({ status: 'success', state: engineState }),
            getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } })
        }
    };
    context.setupOutput(app);
    return { app, note };
}

test('turning on exclusive mode that the device refuses says it is playing shared', async () => {
    const { app, note } = setup({ engineState: { exclusive_mode: true, output_fallback: ['exclusive'] } });
    await app.configureOutput();
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /独占模式没能打开.*共享模式/);
});

test('a missing device says the default one is playing', () => {
    const { app, note } = setup();
    app.syncOutputFallback({ output_fallback: ['device'] });
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /默认设备/);
});

test('once exclusive mode is switched off the exclusive note goes away', () => {
    const { app, note } = setup();
    app.syncOutputFallback({ output_fallback: ['exclusive'] });
    app.wasapiSwitch.checked = false;
    app.syncOutputFallback({ output_fallback: ['exclusive'] });
    assert.equal(note.hidden, true);
});

test('an old engine without the field shows nothing', () => {
    const { app, note } = setup();
    app.syncOutputFallback({ exclusive_mode: true });
    assert.equal(note.hidden, true);
    assert.equal(note.textContent, '');
});

test('the window asks the engine where the sound actually went after play starts', () => {
    const player = fs.readFileSync(path.join(__dirname, '../Musicmodules/music-player.js'), 'utf8');
    const music = fs.readFileSync(path.join(__dirname, '../Musicmodules/music.js'), 'utf8');
    assert.match(player, /app\.startStatePolling\(\);\s*app\.checkOutputFallbackSoon\?\.\(\);/);
    assert.match(music, /app\.updateUIWithState = \(state, options = \{\}\) => \{\s*if \(!state\) return;\s*app\.syncOutputFallback\?\.\(state\);/);
    const html = fs.readFileSync(path.join(__dirname, '../Musicmodules/music.html'), 'utf8');
    assert.match(html, /id="output-fallback-note"[^>]*hidden/);
});

test('refreshing the device list keeps the device the engine is using selected', async () => {
    // 打开窗口时先按引擎状态选中设备，再拉设备列表；以前拉完列表选中项就回到「默认设备」。
    const options = [];
    const groups = [];
    const select = {
        value: 'default', disabled: false,
        set innerHTML(v) { options.length = 0; },
        appendChild(node) { if (node.tag === 'optgroup') { groups.push(node); node.children.forEach((c) => options.push(c)); } else options.push(node); },
        querySelectorAll: () => options
    };
    const context = vm.createContext({
        console, setTimeout, clearTimeout,
        document: {
            getElementById: () => null,
            createElement: (tag) => {
                const el = { tag, children: [], value: '', textContent: '' };
                el.appendChild = (c) => { el.children.push(c); if (groups.includes(el)) options.push(c); };
                return el;
            }
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-output.js'), 'utf8'), context);
    const app = {
        deviceSelect: select, wasapiSwitch: { checked: false }, currentDeviceId: 2,
        api: { getMusicDevices: async () => ({ status: 'success', devices: { preferred: [{ id: 2, name: 'USB DAC' }], other: [{ id: 0, name: 'Speakers' }] } }) }
    };
    context.setupOutput(app);
    await app.populateDeviceList(false);
    assert.equal(String(select.value), '2');
    app.currentDeviceId = 9; // 引擎报的设备已经不在列表里
    await app.populateDeviceList(false);
    assert.equal(select.value, 'default');
});

test('an output change the engine rejects puts the old device and switch back, and choosing it again retries', async () => {
    const { app } = setup();
    const sent = [];
    const notices = [];
    app.showPlaybackNotice = (m) => notices.push(m);
    app.api.configureMusicOutput = async (cfg) => { sent.push(cfg); return { status: 'error', message: 'fetch failed' }; };
    app.populateDeviceList = async () => {}; // 列表重建另有测试，这里只看选中项
    app.currentDeviceId = null; app.useWasapiExclusive = false;
    app.deviceSelect.value = '3'; app.wasapiSwitch.checked = true;
    await app.configureOutput();
    assert.equal(app.currentDeviceId, null, 'still on the default device');
    assert.equal(app.useWasapiExclusive, false);
    assert.equal(app.wasapiSwitch.checked, false, 'the exclusive switch springs back');
    assert.equal(String(app.deviceSelect.value), 'default', 'the list shows the device that is really playing');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^切换输出没有成功：/);
    app.deviceSelect.value = '3';
    await app.configureOutput();
    assert.equal(sent.length, 2, 'choosing the same device again sends it again');
});

test('throwing configureMusicOutput and configureMusicUpsampling roll back UI and state cleanly', async () => {
    const { app } = setup();
    const notices = [];
    app.showPlaybackNotice = (m) => notices.push(m);
    app.api.configureMusicOutput = async () => { throw new Error('IPC channel closed'); };
    app.api.configureMusicUpsampling = async () => { throw new Error('engine offline'); };
    app.saveSettings = () => { throw new Error('should not save on failure'); };
    app.currentDeviceId = 1;
    app.useWasapiExclusive = false;
    app.deviceSelect.value = '4';
    app.wasapiSwitch.checked = true;
    await app.configureOutput();
    assert.equal(app.currentDeviceId, 1, 'device rolls back on thrown IPC error');
    assert.equal(app.useWasapiExclusive, false, 'exclusive flag rolls back on thrown IPC error');
    assert.equal(app.wasapiSwitch.checked, false, 'exclusive switch rolls back');
    assert.equal(String(app.deviceSelect.value), '1', 'device select value rolls back');
    assert.equal(notices.length, 1);

    app.targetUpsamplingRate = 48000;
    app.upsamplingSelect = { value: '96000' };
    await app.configureUpsampling();
    assert.equal(app.targetUpsamplingRate, 48000, 'upsampling rate rolls back on error');
    assert.equal(app.upsamplingSelect.value, '48000', 'upsampling select rolls back on error');
});
