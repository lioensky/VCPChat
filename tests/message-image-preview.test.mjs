import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { openPreview } from '../modules/messageImage/renderer/preview.js';

const defaults = { width: null, tools: true, thoughts: true, timestamps: true, pad: 16, scale: 1.25 };
const first = Uint8Array.of(1);
const second = Uint8Array.of(2);

async function until(check) {
    const deadline = Date.now() + 2000;
    while (!check()) {
        assert.ok(Date.now() < deadline, '等待面板状态超时');
        await pause(10);
    }
}

const teardownByTest = new WeakMap();

function fixture(t, overrides = {}, storage = new Map()) {
    const dom = new JSDOM('<button type="button">来源</button>');
    const { window } = dom;
    const { document } = window;
    const source = document.querySelector('button');
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    window.HTMLImageElement.prototype.decode = async function () {};
    const urls = new Map();
    let count = 0;
    const restore = [];
    function install(target, key, value) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, { configurable: true, writable: true, value });
        restore.push(() => {
            if (descriptor) Object.defineProperty(target, key, descriptor);
            else delete target[key];
        });
    }
    Object.defineProperty(window, 'localStorage', { value: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
    } });
    install(globalThis, 'window', window);
    install(globalThis, 'document', document);
    install(globalThis, 'Image', window.Image);
    install(URL, 'createObjectURL', (blob) => {
        const value = `blob:test-${++count}`;
        urls.set(value, blob);
        return value;
    });
    install(URL, 'revokeObjectURL', (value) => {
        assert.ok(urls.delete(value), '只能释放已创建的 URL');
    });
    source.focus();
    const key = (value, init = {}, target = window) => target.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: value, cancelable: true, bubbles: true, ...init,
    }));
    const previousTeardown = teardownByTest.get(t);
    if (!previousTeardown) t.after(() => teardownByTest.get(t)());
    teardownByTest.set(t, () => {
        key('Escape');
        window.close();
        for (const undo of restore.reverse()) undo();
        previousTeardown?.();
    });

    const result = openPreview({
        initialWidth: 821.375,
        initialScale: 1.25,
        primaryAction: 'copy',
        render: async () => first,
        output: async () => ({ ok: true }),
        isCurrent: () => true,
        ...overrides,
    });
    const $ = (selector) => document.querySelector(`dialog ${selector}`);
    const action = (name) => $(`[data-action="${name}"]`);
    const input = (name, value, type = 'input') => {
        const element = $(`[data-setting="${name}"]`);
        if (typeof value === 'boolean') element.checked = value;
        else element.value = String(value);
        element.dispatchEvent(new window.Event(type, { bubbles: true }));
    };
    const shownBytes = async () => new Uint8Array(await urls.get($('img').getAttribute('src')).arrayBuffer());
    return { window, document, source, result, key, $, action, input, urls, shownBytes };
}

test('原宽沿用小数宽度交给渲染，读数取整；按 Enter 导出预览使用的同一份字节', async (t) => {
    let rendered;
    const outputs = [];
    const f = fixture(t, {
        render: async (settings) => {
            rendered = settings;
            return first;
        },
        output: async (action, bytes) => {
            outputs.push([action, bytes]);
            return { ok: true, width: 822 };
        },
    });
    assert.equal(f.$('[data-value="width"]').textContent, '821 px');
    assert.equal(f.$('[data-mode="original"]').getAttribute('aria-pressed'), 'true');
    assert.equal(f.document.querySelectorAll('link[rel=stylesheet]').length, 1);
    await until(() => !f.action('copy').disabled);
    assert.deepEqual(rendered, defaults);
    const blob = f.urls.get(f.$('img').getAttribute('src'));
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(await f.shownBytes(), first);
    assert.equal(f.key('Enter'), false);
    assert.deepEqual(await f.result, { ok: true, width: 822, action: 'copy' });
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0][0], 'copy');
    assert.equal(outputs[0][1], first);
    assert.equal(f.document.querySelector('dialog'), null);
    assert.equal(f.document.activeElement, f.source);
    assert.equal(f.urls.size, 0);
    assert.equal(f.key('Escape'), true);
});

test('合并快速改动，丢弃过时渲染，并把最终参数一次交给渲染器', async (t) => {
    const renders = [];
    let finishFirst;
    const running = new Promise((resolve) => { finishFirst = resolve; });
    t.after(() => finishFirst(first));
    const f = fixture(t, {
        render: (settings) => {
            renders.push(settings);
            return renders.length === 1 ? running : second;
        },
    });
    await until(() => renders.length === 1);
    f.input('width', 990);
    f.input('width', 991);
    f.input('tools', false);
    f.input('thoughts', false);
    f.input('pad', 64);
    f.$('[data-scale="2"]').click();
    await pause(200);
    assert.equal(renders.length, 1);
    assert.equal(f.$('img').hidden, true);
    assert.ok(f.action('copy').disabled && f.action('save').disabled);
    f.key('Enter');
    finishFirst(first);
    await until(() => !f.action('copy').disabled);
    assert.deepEqual(renders, [defaults, { ...defaults, width: 991, tools: false, thoughts: false, pad: 64, scale: 2 }]);
    assert.deepEqual(await f.shownBytes(), second);
    assert.equal(f.urls.size, 1, '过时的那张没有留下 URL');
    f.key('Escape');
    assert.deepEqual(await f.result, { canceled: true });
    assert.equal(f.urls.size, 0);
});

// 管理员 2026-11-27：拖动宽度时预览要跟着走。原来每动一下就把图清空，拖的过程中一直是空白。
test('重画期间旧图留在原处并标为过时，导出停用；新图画好才整张换上', async (t) => {
    const renders = [];
    let finishSecond;
    const f = fixture(t, {
        render: (settings) => {
            renders.push(settings);
            if (renders.length === 1) return first;
            return new Promise((resolve) => { finishSecond = resolve; });
        },
    });
    await until(() => !f.action('copy').disabled);
    const firstSrc = f.$('img').getAttribute('src');
    f.$('[data-mode="custom"]').click();
    await until(() => renders.length === 2);
    assert.equal(f.$('img').hidden, false, '旧图还在');
    assert.equal(f.$('img').getAttribute('src'), firstSrc);
    assert.equal(f.$('.message-image-preview-stage').dataset.state, 'updating');
    assert.equal(f.$('.message-image-preview-busy').hidden, false);
    assert.ok(f.action('copy').disabled && f.action('save').disabled, '过时的图不能导出');
    f.key('Enter');
    f.key('s', { ctrlKey: true });
    finishSecond(second);
    await until(() => !f.action('copy').disabled);
    assert.notEqual(f.$('img').getAttribute('src'), firstSrc);
    assert.deepEqual(await f.shownBytes(), second);
    assert.equal(f.urls.size, 1, '旧图的 URL 已释放');
    assert.equal(f.$('.message-image-preview-stage').dataset.state, 'ready');
    assert.equal(renders.length, 2);
});

test('原宽模式下直接拖宽度滑块就是自定义宽度，松开立即重画；点原宽回到小数原宽', async (t) => {
    const renders = [];
    const f = fixture(t, {
        render: async (settings) => {
            renders.push(settings);
            return renders.length % 2 ? first : second;
        },
    });
    await until(() => !f.action('copy').disabled);
    assert.equal(f.$('[data-setting="width"]').disabled, false);
    f.input('width', 640);
    assert.equal(f.$('[data-mode="custom"]').getAttribute('aria-pressed'), 'true');
    assert.equal(f.$('[data-value="width"]').textContent, '640 px');
    f.input('width', 640, 'change');
    await until(() => renders.length === 2);
    assert.equal(renders[1].width, 640);
    await until(() => !f.action('copy').disabled);
    f.$('[data-mode="original"]').click();
    await until(() => renders.length === 3);
    assert.equal(renders[2].width, null);
    assert.equal(f.$('[data-value="width"]').textContent, '821 px');
});

test('焦点在取消按钮上按 Enter 不会复制；Ctrl+S 保存当前预览', async (t) => {
    const outputs = [];
    const f = fixture(t, {
        output: async (action, bytes) => {
            outputs.push([action, bytes]);
            return { ok: true, filePath: 'a.png' };
        },
    });
    await until(() => !f.action('copy').disabled);
    const cancel = f.action('cancel');
    cancel.focus();
    assert.equal(f.key('Enter', {}, cancel), true, '交给按钮自己处理');
    await pause(20);
    assert.equal(outputs.length, 0);
    assert.equal(f.key('s', { ctrlKey: true }), false);
    assert.deepEqual(await f.result, { ok: true, filePath: 'a.png', action: 'save' });
    assert.deepEqual(outputs, [['save', first]]);
});

test('所选消息不含工具调用或思考过程时，对应开关停用并注明原因', async (t) => {
    const f = fixture(t, { available: { tools: false, thoughts: true }, count: 3 });
    await until(() => !f.action('copy').disabled);
    assert.equal(f.$('[data-setting="tools"]').disabled, true);
    assert.equal(f.$('[data-setting="thoughts"]').disabled, false);
    assert.match(f.$('[data-setting="tools"]').closest('label').textContent, /所选消息不含工具调用/);
    assert.match(f.$('h2').textContent, /3 条消息/);
});

test('保存取消和输出错误均保留预览，可重新导出', async (t) => {
    let saves = 0;
    let renders = 0;
    const f = fixture(t, {
        primaryAction: 'save',
        render: () => {
            renders++;
            return first;
        },
        output: async (action, bytes) => {
            assert.equal(action, 'save');
            assert.equal(bytes, first);
            saves++;
            if (saves === 1) return { ok: false, canceled: true };
            if (saves === 2) return { ok: false, error: '路径不可写' };
            return { ok: true, filePath: 'image.png' };
        },
    });
    await until(() => !f.action('save').disabled);
    f.key('Enter');
    await until(() => !f.action('save').disabled);
    assert.match(f.$('[role="status"]').textContent, /已取消保存/);
    f.action('save').click();
    await until(() => !f.action('save').disabled);
    assert.match(f.$('[role="status"]').textContent, /路径不可写/);
    assert.equal(f.urls.size, 1);
    f.action('save').click();
    assert.deepEqual(await f.result, { ok: true, filePath: 'image.png', action: 'save' });
    assert.equal(renders, 1);
});

test('预览失败给出原因且可重试；切话题主动清理已生成图片', async (t) => {
    let current = true;
    let renders = 0;
    const f = fixture(t, {
        isCurrent: () => current,
        render: async () => {
            if (++renders === 1) throw new Error('图片超过像素上限');
            return first;
        },
    });
    await until(() => !f.action('retry').hidden);
    assert.ok(f.action('copy').disabled);
    assert.match(f.$('[role="status"]').textContent, /图片超过像素上限/);
    f.action('retry').click();
    await until(() => !f.action('copy').disabled);
    current = false;
    assert.deepEqual(await f.result, { canceled: true });
    assert.equal(f.urls.size, 0);
    assert.equal(f.key('Enter'), true);
});

test('关闭后旧渲染不可回填，下一面板等旧渲染结束', async (t) => {
    let finish;
    let started = false;
    let reopened = false;
    const running = new Promise((resolve) => { finish = resolve; });
    t.after(() => finish(first));
    const f = fixture(t, {
        render: () => {
            started = true;
            return running;
        },
    });
    await until(() => started);
    f.key('Escape');
    assert.deepEqual(await f.result, { canceled: true });
    const next = openPreview({
        initialWidth: 410, initialScale: 2, primaryAction: 'copy',
        render: async () => {
            reopened = true;
            return second;
        },
        output: async () => ({ ok: true }),
        isCurrent: () => true,
    });
    await pause(30);
    assert.equal(reopened, false);
    finish(first);
    await until(() => !f.action('copy').disabled);
    assert.equal(reopened, true);
    assert.equal(f.document.querySelectorAll('link[rel=stylesheet]').length, 1);
    assert.deepEqual(await f.shownBytes(), second);
    f.key('Escape');
    assert.deepEqual(await next, { canceled: true });
});

test('成功导出的内容与版式下次沿用；无时间的消息不覆盖偏好，取消不写入', async (t) => {
    const storage = new Map();
    const waitReady = (panel) => until(() => !panel.action('copy').disabled);
    const firstPanel = fixture(t, {}, storage);
    await waitReady(firstPanel);
    firstPanel.input('tools', false);
    firstPanel.input('timestamps', false);
    firstPanel.input('width', 760);
    firstPanel.input('pad', 30);
    firstPanel.$('[data-scale="2"]').click();
    await waitReady(firstPanel);
    firstPanel.action('copy').click();
    await firstPanel.result;
    const saved = () => JSON.parse([...storage.values()][0]);
    const expected = { ...defaults, width: 760, pad: 30, scale: 2, tools: false, timestamps: false };
    assert.deepEqual(saved(), expected);

    const withoutTime = fixture(t, { available: { timestamps: false } }, storage);
    assert.equal(withoutTime.$('[data-setting="timestamps"]').disabled, true);
    assert.equal(withoutTime.$('[data-setting="tools"]').checked, false);
    assert.equal(withoutTime.$('[data-value="preferences"]').textContent, '已沿用上次导出设置');
    assert.equal(withoutTime.$('[data-value="width"]').textContent, '760 px');
    await waitReady(withoutTime);
    withoutTime.action('copy').click();
    await withoutTime.result;
    assert.deepEqual(saved(), expected);

    const canceled = fixture(t, { output: async () => ({ canceled: true }) }, storage);
    assert.equal(canceled.$('[data-setting="timestamps"]').checked, false);
    canceled.action('reset').click();
    assert.equal(canceled.$('[data-setting="timestamps"]').checked, true);
    assert.equal(canceled.$('[data-value="width"]').textContent, '821 px');
    await waitReady(canceled);
    canceled.action('save').click();
    await until(() => !canceled.action('save').disabled);
    canceled.key('Escape');
    await canceled.result;
    assert.deepEqual(saved(), expected);

    const reset = fixture(t, {}, storage);
    reset.action('reset').click();
    await waitReady(reset);
    reset.action('copy').click();
    await reset.result;
    assert.deepEqual(saved(), defaults);
});
