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
    const context = { app, document: { getElementById: () => slider } };
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
