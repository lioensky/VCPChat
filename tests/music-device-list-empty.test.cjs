// 列设备失败（引擎没起来、返回出错）时，声音页的设备下拉框不能一个选项都没有。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function load(getMusicDevices) {
    const dom = new JSDOM('<select id="device-select"></select>', { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync('Musicmodules/music-output.js', 'utf8'));
    const app = { deviceSelect: dom.window.document.getElementById('device-select'), currentDeviceId: null, api: { getMusicDevices } };
    dom.window.setupOutput(app);
    return { dom, app };
}

for (const [name, fn] of [
    ['the engine is not running', async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:43789'); }],
    ['the engine answers with an error', async () => ({ status: 'error', message: 'no host' })],
]) {
    test(`when ${name}, the device list still offers the default device`, async () => {
        const { dom, app } = load(fn);
        const quiet = console.error; console.error = () => {};
        try { await app.populateDeviceList(); } finally { console.error = quiet; }
        assert.deepEqual([...app.deviceSelect.options].map((o) => o.textContent), ['默认设备']);
        assert.equal(app.deviceSelect.value, 'default');
        dom.window.close();
    });
}

test('a later failure keeps the devices already listed', async () => {
    let fail = false;
    const { dom, app } = load(async () => {
        if (fail) return { status: 'error' };
        return { status: 'success', devices: { preferred: [{ id: 3, name: '扬声器' }], other: [] } };
    });
    await app.populateDeviceList();
    fail = true;
    await app.populateDeviceList(true);
    assert.deepEqual([...app.deviceSelect.options].map((o) => o.textContent), ['默认设备', '扬声器']);
    dom.window.close();
});
