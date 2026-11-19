'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
    const handlers = new Map();
    const children = [];
    const app = new EventEmitter();
    app.getAppPath = () => root;
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
    function spawn(executable, args, options) {
        assert.equal(executable, 'python');
        assert.equal(options.shell, false);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stdin = new PassThrough();
        child.input = '';
        child.stdin.on('data', chunk => { child.input += chunk.toString('utf8'); });
        child.kill = () => { child.killed = true; child.stdout.end(); };
        child.command = args.at(-1);
        children.push(child);
        return child;
    }
    const file = path.join(root, 'modules/ipc/mijiaHandlers.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        module, URL, setTimeout, clearTimeout,
        require: name => name === 'electron' ? { app, ipcMain }
            : name === 'node:child_process' ? { spawn } : require('node:module').createRequire(file)(name),
    }, { filename: file });
    module.exports.initialize();
    const origin = page => {
        const sender = new EventEmitter();
        sender.isDestroyed = () => false;
        sender.mainFrame = { url: pathToFileURL(path.join(root, page)).href };
        return { sender, senderFrame: sender.mainFrame };
    };
    return {
        children, app, origin,
        call: (name, event, ...args) => handlers.get(`mijia:${name}`)(event, ...args),
        send: (child, message) => child.stdout.write(`${JSON.stringify(message)}\n`),
    };
}

test('米家：双宿主共用设备读取，但只有发起扫码的页面可以取码或取消', async () => {
    const { children, origin, call, send, app } = setup();
    const chat = origin('main.html');
    const floating = origin('Mijiamodules/mijia.html');
    try {
        assert.equal(call('list', origin('other.html')).code, 'forbidden');
        assert.equal(call('list', { ...chat, senderFrame: { ...chat.senderFrame } }).code, 'forbidden');
        const list = call('list', chat);
        assert.equal(list, call('list', floating));
        assert.equal(children[0].command, 'list');
        send(children[0], { event: 'devices', devices: [{ id: 'lamp', name: '台灯' }] });
        children[0].stdout.end();
        await tick();
        children[0].emit('close', 0);
        assert.equal((await list).devices[0].name, '台灯');

        const { attemptId } = call('login-start', chat);
        assert.ok(attemptId);
        assert.equal(call('login-start', floating).code, 'login_busy');
        assert.equal(call('login-state', floating, attemptId).code, 'login_attempt_missing');
        assert.equal(call('login-cancel', floating, attemptId).code, 'login_attempt_missing');
        const job = children[1];
        send(job, { event: 'qr', png: 'AAAA' });
        assert.equal(call('login-state', chat, attemptId).phase, 'qr');
        send(job, { event: 'verifying' });
        const pending = call('login-state', chat, attemptId);
        assert.equal(pending.phase, 'verifying');
        assert.equal(pending.png, undefined);
        assert.equal(call('login-cancel', chat, attemptId).success, true);
        assert.equal(job.killed, true);
        assert.equal(call('login-state', chat, attemptId).code, 'login_attempt_missing');
    } finally {
        children.forEach(child => child.emit('close', 1));
        app.emit('before-quit');
    }
});

test('米家：安装包保留页面与外部 Python 桥，Dock 不进入顶部内嵌标签', () => {
    const { build } = require('../package.json');
    assert.ok(build.files.includes('Mijiamodules/**/*'));
    assert.ok(build.asarUnpack.includes('Mijiamodules/mijia_bridge.py'));
    assert.equal(require('../modules/shared/embeddedAppAllowlist').isEmbeddable('open-mijia-window'), false);
    assert.match(fs.readFileSync(path.join(root, 'Mijiamodules/mijia.html'), 'utf8'), /href="\.\.\/styles\/themes\.css"/);
});

test('米家：数值输入和松手不写，应用只提交草稿，失败项单独保留', async () => {
    const { JSDOM } = require('jsdom');
    const source = fs.readFileSync(path.join(root, 'Mijiamodules/device-controls.js'), 'utf8');
    const { mountDeviceControls } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const spec = require('../Mijiamodules/capabilities.json');
    const dom = new JSDOM('<main></main>');
    const host = dom.window.document.querySelector('main');
    const model = 'yeelink.light.lamp2';
    const calls = [];
    const card = mountDeviceControls(host, { id: 'lamp', model, online: true, properties: spec[model].properties }, {
        mijiaReadProperties: async () => ({ success: true, model, values: { power: false, brightness: 80, colorTemperature: 4000 } }),
        mijiaWriteProperties: async (id, mode, changes) => {
            calls.push({ id, mode, changes });
            return { success: true, results: mode === 'immediate'
                ? { power: { status: 'confirmed', value: true } }
                : { brightness: { status: 'confirmed', value: 60 }, colorTemperature: { status: 'rejected' } } };
        },
    });
    try {
        await card.reload();
        const [brightness, temperature] = host.querySelectorAll('input');
        const button = label => [...host.querySelectorAll('button')].find(node => node.textContent === label);
        assert.equal(button('应用').disabled, true);
        const edit = (field, value) => {
            field.value = value;
            for (const name of ['input', 'change', 'blur']) field.dispatchEvent(new dom.window.Event(name));
        };
        edit(brightness, '60');
        edit(temperature, '3500');
        await card.reload();
        assert.equal(calls.length, 0);
        assert.equal(brightness.value, '60');
        button('应用').click();
        await tick();
        assert.deepEqual(calls, [{ id: 'lamp', mode: 'apply', changes: { brightness: 60, colorTemperature: 3500 } }]);
        assert.match(host.textContent, /待应用：3500 K/);
        assert.doesNotMatch(host.textContent, /待应用：60%/);
        assert.match(host.textContent, /设备拒绝/);
        button('撤销').click();
        assert.equal(temperature.value, '4000');
        assert.equal(calls.length, 1);
        button('开灯').click();
        await tick();
        assert.deepEqual(calls[1], { id: 'lamp', mode: 'immediate', changes: { power: true } });
        assert.ok(button('关灯'));

        const fridge = 'midjd6.fridge.610';
        card.dispose();
        const fridgeCard = mountDeviceControls(host, { id: 'fridge', model: fridge, online: true, properties: spec[fridge].properties }, {
            mijiaReadProperties: async () => ({ success: true, model: fridge, values: { fridgeTemperature: 3, fridgeTarget: 4 } }),
        });
        await fridgeCard.reload();
        const zones = [...host.querySelectorAll('.mijia-zone')];
        assert.deepEqual(zones.map(zone => zone.querySelector('h3').textContent), ['冷藏', '冷冻']);
        const readings = zone => [...zone.querySelectorAll('.mijia-property')].map(row => row.textContent);
        assert.deepEqual(readings(zones[0]), ['当前温度3 °C', '设定温度4 °C']);
        assert.deepEqual(readings(zones[1]), ['当前温度暂不可读', '设定温度暂不可读']);
        assert.equal(host.querySelectorAll('input').length, 0);
        assert.equal(button('应用'), undefined);
        fridgeCard.dispose();
    } finally {
        card.dispose();
        dom.window.close();
    }
});

test('米家：浮窗写入未完成时，右栏的同设备读取排队', async () => {
    const { children, origin, call, send } = setup();
    const floating = origin('Mijiamodules/mijia.html');
    const chat = origin('main.html');
    assert.equal(call('properties-write', floating, 'lamp', 'apply', { brightness: 1.5 }).code, 'invalid_request');
    const write = call('properties-write', floating, 'lamp', 'apply', { brightness: 60 });
    const read = call('properties-read', chat, 'lamp');
    try {
        await tick();
        assert.equal(children.length, 1);
        assert.equal(children[0].command, 'write');
        assert.deepEqual(JSON.parse(children[0].input), { id: 'lamp', mode: 'apply', changes: { brightness: 60 } });
        send(children[0], { event: 'properties', results: { brightness: { status: 'confirmed', value: 60 } } });
        await tick();
        assert.equal(children.length, 1);
        children[0].emit('close', 0);
        assert.equal((await write).results.brightness.status, 'confirmed');
        await tick();
        assert.equal(children.length, 2);
        assert.equal(children[1].command, 'read');
        send(children[1], { event: 'properties', model: 'yeelink.light.lamp2', values: { brightness: 60 } });
        children[1].emit('close', 0);
        assert.equal((await read).values.brightness, 60);
    } finally {
        for (const child of children) child.emit('close', 1);
        await tick();
        for (const child of children) child.emit('close', 1);
    }
});
test('米家面板：六类插图、未知回退；刷新复用控件且不提交草稿', async () => {
    const { JSDOM } = require('jsdom');
    const { mountMijiaPanel } = await import('../Mijiamodules/panel.js');
    const spec = require('../Mijiamodules/capabilities.json');
    const models = ['yeelink.light.lamp2', 'test.tv.demo', 'test.washer.demo', 'test.aircondition.demo',
        'test.dishwasher.demo', 'midjd6.fridge.610', 'unknown'];
    const devices = models.map((model, i) => ({
        id: String(i), model, name: '测试设备', online: true, properties: spec[model]?.properties || [],
    }));
    const dom = new JSDOM('<main></main>');
    const host = dom.window.document.querySelector('main');
    let writes = 0;
    const panel = mountMijiaPanel(host, {
        mijiaListDevices: async () => ({ success: true, devices }),
        mijiaReadProperties: async id => ({
            success: true, model: devices[Number(id)].model,
            values: id === '0' ? { power: false, brightness: 54, colorTemperature: 4000 } : {},
        }),
        mijiaWriteProperties: async () => { writes++; },
    });
    try {
        await new Promise(resolve => setImmediate(resolve));
        const icons = [...host.querySelectorAll('.mijia-device-art')];
        assert.deepEqual(icons.map(node => node.dataset.kind), ['lamp', 'tv', 'washer', 'ac', 'dishwasher', 'fridge', 'generic']);
        assert.ok(icons.every(node => node.querySelector('svg > :is(path, rect)')));
        assert.equal(host.querySelector('[data-device-id="6"] .mijia-controls'), null);
        const selector = 'input[aria-label="亮度"]';
        const slider = host.querySelector(selector);
        slider.value = '68';
        slider.dispatchEvent(new dom.window.Event('input'));
        host.querySelector('.mijia-heading button').click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(host.querySelector(selector), slider);
        assert.equal(slider.value, '68');
        assert.equal(writes, 0);
    } finally {
        panel.dispose();
        dom.window.close();
    }
});