const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function eqFixture({ from = 'FIR', to = 'IIR', enabled = true } = {}) {
    const engine = { type: from, fir: from === 'FIR', iir: from === 'IIR' };
    const calls = [];
    const app = {
        eqBands: { 31: 0 }, eqSwitch: { checked: enabled },
        eqTypeSelect: { value: to }, firTapsSelect: { value: '1023' },
        _syncedEqType: from, _syncedFirTaps: 1023,
        api: {
            async setMusicEqType({ type }) {
                calls.push('type:' + type);
                engine.type = type;
                engine.fir = type === 'FIR';
                if (type === 'FIR') engine.iir = false;
            },
            async setMusicEq({ enabled }) {
                calls.push('enabled:' + enabled);
                if (engine.type === 'FIR') engine.fir = enabled;
                else engine.iir = enabled;
            },
        },
        saveSettings() { calls.push('save'); },
    };
    const slider = { value: '3' };
    const context = { app, window: {}, document: { getElementById: () => slider } };
    vm.runInNewContext(fs.readFileSync('Musicmodules/music-effects.js', 'utf8') + '\nsetupEffects(app);', context);
    return { app, engine, calls, slider };
}

test('changing FIR to IIR reapplies the enabled state after selecting the engine type', async () => {
    const { app, engine, calls } = eqFixture();
    await app.sendEqSettings();
    assert.equal(engine.type, 'IIR');
    assert.equal(engine.iir, true);
    assert.equal(engine.fir, false);
    assert.deepEqual(calls, ['type:IIR', 'enabled:true', 'save']);
});

test('type changes keep disabled EQ off, and unchanged FIR sliders do not rebuild its filter', async () => {
    for (const from of ['IIR', 'FIR']) {
        const to = from === 'IIR' ? 'FIR' : 'IIR';
        const { app, engine } = eqFixture({ from, to, enabled: false });
        await app.sendEqSettings();
        assert.equal(engine.fir, false);
        assert.equal(engine.iir, false);
    }
    const { app, engine, calls } = eqFixture({ from: 'IIR', to: 'FIR' });
    await app.sendEqSettings();
    assert.equal(engine.fir, true);
    assert.equal(engine.iir, false);
    calls.length = 0;
    await app.sendEqSettings();
    assert.deepEqual(calls, ['enabled:true', 'save']);
});

test('overlapping sliders wait for one pending FIR type change and keep their snapshots', async () => {
    const { app, calls, slider } = eqFixture({ from: 'IIR', to: 'FIR' });
    const setType = app.api.setMusicEqType, setEq = app.api.setMusicEq;
    let release, attempts = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const bands = [];
    app.api.setMusicEqType = async payload => { attempts++; await gate; return setType(payload); };
    app.api.setMusicEq = async payload => { bands.push(payload.bands[31]); return setEq(payload); };
    const first = app.sendEqSettings();
    slider.value = '9'; app.eqSwitch.checked = false;
    const second = app.sendEqSettings();
    await new Promise(resolve => setImmediate(resolve));
    const inFlight = attempts;
    release(); await Promise.all([first, second]);
    assert.equal(inFlight, 1);
    assert.equal(attempts, 1, 'pending FIR synchronization is not duplicated');
    assert.deepEqual(bands, [3, 9]);
    assert.deepEqual(calls, ['type:FIR', 'enabled:true', 'save', 'enabled:false', 'save']);
});

test('overlapping different type requests cannot complete with stale sync markers', async () => {
    const { app, engine } = eqFixture({ from: 'IIR', to: 'FIR' });
    const setType = app.api.setMusicEqType, pending = [];
    app.api.setMusicEqType = payload => new Promise(resolve => {
        pending.push(async () => { await setType(payload); resolve(); });
    });
    const first = app.sendEqSettings();
    await new Promise(resolve => setImmediate(resolve));
    app.eqTypeSelect.value = 'IIR'; app.firTapsSelect.value = '2047';
    const second = app.sendEqSettings();
    await new Promise(resolve => setImmediate(resolve));
    if (pending.length === 2) {
        await pending[1](); await second;
        await pending[0](); await first;
    } else {
        await pending[0](); await first;
        await new Promise(resolve => setImmediate(resolve));
        await pending[1](); await second;
    }
    assert.equal(engine.type, 'IIR');
    assert.equal(app._syncedEqType, 'IIR');
    assert.equal(app._syncedFirTaps, 2047);
});

test('failed EQ type synchronization stays retryable for thrown and status-error failures', async () => {
    for (const throws of [true, false]) {
        const { app, calls } = eqFixture({ from: 'IIR', to: 'FIR' });
        const setType = app.api.setMusicEqType;
        let attempts = 0;
        app.api.setMusicEqType = payload => {
            if (++attempts === 1) {
                if (throws) throw new Error('synthetic type failure');
                return { status: 'error' };
            }
            return setType(payload);
        };
        if (throws) await assert.rejects(app.sendEqSettings(), /synthetic type failure/);
        else assert.equal((await app.sendEqSettings()).status, 'error');
        assert.equal(app._syncedEqType, 'IIR');
        assert.deepEqual(calls, [], 'failed type change must not apply bands or persist success');
        await app.sendEqSettings();
        assert.equal(attempts, 2);
        assert.equal(app._syncedEqType, 'FIR');
    }
});

test('a band failure is retryable without rebuilding a successfully synchronized type', async () => {
    const { app, calls } = eqFixture({ from: 'IIR', to: 'FIR' });
    const setEq = app.api.setMusicEq;
    let attempts = 0;
    app.api.setMusicEq = payload => ++attempts === 1 ? { status: 'error' } : setEq(payload);
    assert.equal((await app.sendEqSettings()).status, 'error');
    assert.deepEqual(calls, ['type:FIR']);
    await app.sendEqSettings();
    assert.deepEqual(calls, ['type:FIR', 'enabled:true', 'save']);
});

function presetFixture(bands) {
    const sliders = {};
    for (const [band, v] of Object.entries(bands)) sliders[`eq-${band}`] = { value: String(v) };
    const select = { value: '', options: [], appendChild(o) { this.options.push(o); } };
    const app = {
        eqBands: { ...bands },
        eqPresetSelect: select,
        eqPresets: {
            balance: { 32: 0, '1k': 0 },
            rock: { 32: 4, '1k': -2 }
        },
        sendEqSettings() {}
    };
    const context = { app, document: { getElementById: (id) => sliders[id] || null, createElement: () => ({}) } };
    vm.runInNewContext(fs.readFileSync('Musicmodules/music-effects.js', 'utf8') + '\nsetupEffects(app);', context);
    return { app, select, sliders };
}

test('the preset list shows the preset the sliders match, or 自定义 once a band is moved', () => {
    const { app, select, sliders } = presetFixture({ 32: 4, '1k': -2 });
    app.populateEqPresets();
    assert.equal(select.value, 'rock', 'opening the window with rock saved shows rock, not the first entry');
    const custom = select.options.find((o) => o.value === 'custom');
    assert.ok(custom && custom.disabled, '自定义 can be shown but not picked');
    sliders['eq-32'].value = '5';
    app.syncEqPresetSelect();
    assert.equal(select.value, 'custom');
    app.applyEqPreset('balance');
    assert.equal(select.value, 'balance');
});

test('sendEqSettings syncs app.eqBands in memory and unloadIr reports error status on failure', async () => {
    const { app, slider } = eqFixture({ from: 'IIR', to: 'IIR', enabled: true });
    slider.value = '-4';
    await app.sendEqSettings();
    assert.equal(app.eqBands[31], -4, 'sendEqSettings updates app.eqBands[band] in memory');

    const statuses = [];
    app.irLoadedPath = 'C:\\ir\\hall.wav';
    app.irEnabled = true;
    app.irSwitch = { checked: true };
    app.updateIrStatus = (msg, kind) => statuses.push([msg, kind]);
    app.api.musicUnloadIr = async () => ({ status: 'error', message: 'busy' });
    await app.unloadIr();
    assert.equal(statuses.at(-1)[1], 'error', 'status error from musicUnloadIr surfaces error status');
    assert.equal(app.irLoadedPath, 'C:\\ir\\hall.wav', 'failed unload preserves loaded path');

    app.api.musicUnloadIr = async () => { throw new Error('engine down'); };
    await app.unloadIr();
    assert.equal(statuses.at(-1)[1], 'error', 'rejected musicUnloadIr surfaces error status');

    app.api.musicUnloadIr = async () => ({ status: 'success' });
    await app.unloadIr();
    assert.deepEqual(statuses.at(-1), ['未加载', 'idle']);
    assert.equal(app.irLoadedPath, null);
    assert.equal(app.irSwitch.checked, false);
});

test('EQ slider cache avoids repeated getElementById lookups and recovers if a slider is detached', async () => {
    let lookups = 0;
    const sliders = {
        'eq-32': { value: '0', isConnected: true },
        'eq-1k': { value: '0', isConnected: true }
    };
    const app = {
        eqBands: { 32: 0, '1k': 0 },
        eqSwitch: { checked: true },
        eqTypeSelect: { value: 'IIR' },
        firTapsSelect: { value: '1023' },
        eqPresetSelect: { value: 'balance', options: [], appendChild(o) { this.options.push(o); } },
        eqPresets: { balance: { 32: 0, '1k': 0 }, bass: { 32: 5, '1k': 0 } },
        _syncedEqType: 'IIR',
        _syncedFirTaps: 1023,
        api: { setMusicEq: async () => ({ status: 'success' }) },
        saveSettings() {}
    };
    const context = {
        app,
        window: {},
        document: {
            getElementById(id) { lookups += 1; return sliders[id] || null; },
            createElement: () => ({})
        }
    };
    vm.runInNewContext(fs.readFileSync('Musicmodules/music-effects.js', 'utf8') + '\nsetupEffects(app);', context);

    await app.sendEqSettings();
    const afterFirst = lookups;
    assert.equal(afterFirst, 2, 'initial sendEqSettings looks up each band once');

    await app.sendEqSettings();
    app.syncEqPresetSelect();
    app.applyEqPreset('bass');
    assert.equal(lookups, afterFirst, 'cached connected sliders avoid repeated getElementById calls');
    assert.equal(sliders['eq-32'].value, 5);

    // Detach old slider and replace in DOM -> cache refreshes automatically
    sliders['eq-32'].isConnected = false;
    sliders['eq-32'] = { value: '-2', isConnected: true };
    await app.sendEqSettings();
    assert.equal(lookups, afterFirst + 1);
    assert.equal(app.eqBands[32], -2);

    // Missing app.irStatus must not throw
    assert.doesNotThrow(() => app.updateIrStatus('未加载', 'idle'));
});

test('Batch 58: music-effects deduplicates updateIrStatus, slider displays, and caches noise-shaper section lookup', () => {
    let classWrites = 0, textWrites = 0, secLookups = 0;
    const statusText = {
        isConnected: true,
        _tc: '',
        get textContent() { return this._tc; },
        set textContent(v) { textWrites += 1; this._tc = v; }
    };
    const irStatus = {
        _cn: '',
        get className() { return this._cn; },
        set className(v) { classWrites += 1; this._cn = v; },
        contains: (n) => n === statusText,
        querySelector: () => statusText
    };
    const lufsVal = { _tc: '', get textContent() { return this._tc; }, set textContent(v) { textWrites += 1; this._tc = v; } };
    const secEl = { isConnected: true, classList: { toggle() {} } };
    const app = {
        irStatus,
        loudnessLufsSlider: { value: '-14' },
        loudnessLufsValue: lufsVal,
        ditherSwitch: { checked: true },
        outputBitsSelect: { disabled: false },
        noiseShaperCurveSelect: { disabled: false }
    };
    const context = {
        app,
        window: {},
        document: {
            getElementById(id) { if (id === 'noise-shaper-section') { secLookups += 1; return secEl; } return null; }
        }
    };
    vm.runInNewContext(fs.readFileSync('Musicmodules/music-effects.js', 'utf8') + '\nsetupEffects(app);', context);

    app.updateIrStatus('加载成功', 'loaded');
    app.updateIrStatus('加载成功', 'loaded');
    assert.equal(classWrites, 1, 'unchanged updateIrStatus skips redundant className writes');
    assert.equal(textWrites, 1, 'unchanged updateIrStatus skips redundant textContent writes');

    app.updateLoudnessLufsDisplay();
    app.updateLoudnessLufsDisplay();
    assert.equal(textWrites, 2, 'unchanged slider display skips redundant textContent writes');

    app.syncDitherSection();
    app.syncDitherSection();
    assert.equal(secLookups, 1, 'syncDitherSection caches connected #noise-shaper-section element');
});

test('Batch 86: music-effects caches EQ section content lookup, deduplicates aria attrs, and matches presets without per-call Object.keys', () => {
    let qsCalls = 0, switchAttrWrites = 0, contentAttrWrites = 0;
    const attrs = new Map();
    const contentAttrs = new Map();
    const content = {
        isConnected: true,
        getAttribute: (k) => contentAttrs.get(k) ?? null,
        setAttribute: (k, v) => { contentAttrWrites += 1; contentAttrs.set(k, v); }
    };
    const eqSection = {
        classList: { toggle() {} },
        contains: (n) => n === content,
        querySelector: (sel) => { if (sel === '.block-content') qsCalls += 1; return content; }
    };
    const eqSwitch = {
        checked: true,
        getAttribute: (k) => attrs.get(k) ?? null,
        setAttribute: (k, v) => { switchAttrWrites += 1; attrs.set(k, v); }
    };
    const sliders = { 'eq-60': { value: '0', isConnected: true }, 'eq-1k': { value: '3', isConnected: true } };
    const app = {
        eqSection,
        eqSwitch,
        eqBands: { 60: 0, '1k': 3 },
        eqPresetSelect: { value: 'balance' },
        eqPresets: { balance: { 60: 0, '1k': 0 }, vocal: { 60: 0, '1k': 3 } }
    };
    let keysCalls = 0;
    const origKeys = Object.keys;
    const FakeObject = Object.create(Object);
    FakeObject.keys = (o) => { if (o === app.eqBands) keysCalls += 1; return origKeys(o); };
    const context = {
        app,
        window: {},
        Object: FakeObject,
        document: { getElementById: (id) => sliders[id] || null }
    };
    vm.runInNewContext(fs.readFileSync('Musicmodules/music-effects.js', 'utf8') + '\nsetupEffects(app);', context);

    app.updateEqSectionState();
    app.updateEqSectionState();
    assert.equal(qsCalls, 1, 'updateEqSectionState caches connected .block-content element');
    assert.equal(switchAttrWrites, 1, 'unchanged aria-expanded skips redundant setAttribute');
    assert.equal(contentAttrWrites, 1, 'unchanged aria-hidden skips redundant setAttribute');

    app.syncEqPresetSelect();
    assert.equal(app.eqPresetSelect.value, 'vocal');
    sliders['eq-1k'].value = '7';
    app.syncEqPresetSelect();
    assert.equal(app.eqPresetSelect.value, 'custom');
    assert.equal(keysCalls, 1, 'syncEqPresetSelect caches eqBands keys across slider drag updates');
});
