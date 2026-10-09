import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { renderAgentSettingsSurface } from '../modules/settings/schema/sidebar-surfaces.js';
import { createAgentPortraitSettings } from '../modules/ui-system/agent-portrait-settings.js';
import { applyPortraitDisplay, normalizePortraitDisplay, PORTRAIT_DISPLAY_DEFAULTS } from '../modules/ui-system/side-pane/portrait-display.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ portraits = null } = {}) {
    const dom = new JSDOM('<!doctype html><html><body data-vcp-theme="dark"><div id="host"></div></body></html>');
    const win = dom.window;
    let urlSeq = 0;
    const revoked = [];
    win.URL.createObjectURL = () => `blob:portrait-${++urlSeq}`;
    win.URL.revokeObjectURL = url => revoked.push(url);
    const form = renderAgentSettingsSurface(win.document.getElementById('host'), win.document);
    const host = form.querySelector('#agentPortraitSettings');
    const calls = [];
    const disk = { ...(portraits || {}) };
    const api = {
        async getAgentPortraits() { return disk.default ? { ...disk } : null; },
        async saveAgentPortrait(id, variant, data) {
            calls.push(['save', id, variant, data.type, data.buffer.byteLength]);
            disk[variant] = `file:///${variant}`;
            return { success: true, portraits: { ...disk } };
        },
        async removeAgentPortrait(id, variant) {
            calls.push(['remove', id, variant]);
            delete disk[variant];
            return { success: true, portraits: disk.default ? { ...disk } : null };
        }
    };
    const toasts = [];
    let changes = 0;
    const owner = createAgentPortraitSettings({ host, api, win, onChange: () => changes++, notify: (m, t) => toasts.push([t, m]) });
    const slot = variant => host.querySelector(`[data-portrait-variant="${variant}"]`);
    const pick = (variant, file) => {
        const input = slot(variant).querySelector('input[type="file"]');
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new win.Event('change', { bubbles: true }));
    };
    const file = (type = 'image/png', size = 4) => new File([new Uint8Array(size)], 'p.png', { type });
    return { dom, win, form, host, owner, api, calls, disk, toasts, slot, pick, file, revoked, changes: () => changes };
}

test('portrait display values are clamped and default when missing', () => {
    assert.deepEqual(normalizePortraitDisplay(null), { header: 'portrait', ...PORTRAIT_DISPLAY_DEFAULTS, lightFocusX: 50, lightFocusY: 22 });
    assert.deepEqual(normalizePortraitDisplay({ focusX: -5, focusY: 140, height: 9999 }), { header: 'portrait', focusX: 0, focusY: 100, lightFocusX: 0, lightFocusY: 100, height: 360 });
    assert.deepEqual(normalizePortraitDisplay({ header: 'avatar', focusX: '40.6', focusY: 'x', height: 100 }), { header: 'avatar', focusX: 41, focusY: 22, lightFocusX: 41, lightFocusY: 22, height: 180 });
    assert.deepEqual(normalizePortraitDisplay({ focusX: 30, focusY: 40, lightFocusX: 120, lightFocusY: -1 }), { header: 'portrait', focusX: 30, focusY: 40, lightFocusX: 100, lightFocusY: 0, height: 248 });
    assert.equal(normalizePortraitDisplay({ header: 'banner' }).header, 'portrait');
});

test('an agent without a portrait stages one, marks the form changed and writes it on commit', async () => {
    const t = setup();
    let formChanges = 0;
    t.form.addEventListener('change', () => formChanges++);
    await t.owner.load('Coco', {});
    assert.equal(t.slot('default').dataset.state, 'empty');
    assert.equal(t.slot('light').querySelector('[data-portrait-action="pick"]').disabled, true, '没有默认立绘时不能先传浅色版');
    assert.equal(t.owner.summary(), '未设置，首页显示头像');

    t.pick('default', t.file());
    assert.equal(t.slot('default').dataset.state, 'staged');
    assert.equal(t.slot('light').querySelector('[data-portrait-action="pick"]').disabled, false);
    assert.equal(formChanges, 1, '暂存的图片要让表单变成未保存');
    assert.equal(t.calls.length, 0, '保存前不写盘');
    assert.match(t.owner.summary(), /有未保存的图片/);

    const result = await t.owner.commit('Coco');
    assert.equal(result.success, true);
    assert.deepEqual(t.calls, [['save', 'Coco', 'default', 'image/png', 4]]);
    assert.equal(t.slot('default').dataset.state, 'set');
    assert.equal(t.owner.hasPendingFiles('Coco'), false);
    assert.deepEqual(t.revoked, ['blob:portrait-1']);
    t.dom.window.close();
});

test('wrong file types and oversized files are rejected before staging', async () => {
    const t = setup();
    await t.owner.load('Coco', {});
    t.pick('default', t.file('image/svg+xml'));
    t.pick('default', t.file('image/png', 20 * 1024 * 1024 + 1));
    t.pick('default', t.file('video/webm', 64 * 1024 * 1024 + 1));
    t.pick('default', t.file('video/quicktime'));
    assert.equal(t.owner.hasPendingFiles(), false);
    assert.equal(t.toasts.length, 4);
    t.dom.window.close();
});

test('animated images stay images, videos preview as a muted looping video and switch back', async () => {
    const t = setup({ portraits: { default: 'file:///portrait.mp4?v=1' } });
    const preview = () => t.host.querySelector('.agent-portrait-preview-image');
    const thumb = variant => t.slot(variant).querySelector('.agent-portrait-slot-thumb > *');
    await t.owner.load('Nova', {});
    assert.equal(preview().tagName, 'VIDEO', '磁盘上的 mp4 按扩展名认成视频');
    assert.equal(preview().getAttribute('src'), 'file:///portrait.mp4?v=1');
    assert.equal(preview().muted, true);
    assert.ok(preview().hasAttribute('loop') && preview().hasAttribute('playsinline'));
    assert.equal(thumb('default').tagName, 'VIDEO');

    // 暂存的 blob 地址看不出扩展名，按文件类型判断；GIF 照样用 img（动图自己会动）
    t.pick('default', t.file('image/gif', 4 * 1024 * 1024));
    assert.equal(preview().tagName, 'IMG');
    assert.equal(preview().getAttribute('src'), 'blob:portrait-1');
    assert.ok(preview().classList.contains('agent-portrait-preview-image'));
    assert.equal(thumb('default').tagName, 'IMG');

    t.pick('light', t.file('video/webm', 30 * 1024 * 1024));
    t.host.querySelector('[data-portrait-preview-theme="light"]').click();
    assert.equal(preview().tagName, 'VIDEO', '视频可以超过图片的 20MB');
    assert.equal(preview().getAttribute('src'), 'blob:portrait-2');
    assert.equal(t.host.querySelectorAll('.agent-portrait-preview-image').length, 1, '换元素时不留下旧的');

    await t.owner.commit('Nova');
    assert.deepEqual(t.calls.map(call => call.slice(2, 4)), [['light', 'video/webm'], ['default', 'image/gif']]);
    t.dom.window.close();
});

test('the header choice picks portrait or avatar, is saved with the display and survives reset', async () => {
    const t = setup();
    const button = mode => t.host.querySelector(`[data-portrait-header="${mode}"]`);
    await t.owner.load('Coco', {});
    // 没有立绘：只能是头像
    assert.equal(button('avatar').getAttribute('aria-pressed'), 'true');
    assert.equal(button('portrait').disabled, true);

    const n = setup({ portraits: { default: 'file:///default' } });
    const pick = mode => n.host.querySelector(`[data-portrait-header="${mode}"]`);
    let formChanges = 0;
    n.form.addEventListener('change', () => formChanges++);
    await n.owner.load('Nova', { portraitDisplay: { focusX: 30 } });
    assert.equal(pick('portrait').getAttribute('aria-pressed'), 'true', '有立绘时默认显示立绘');
    pick('avatar').click();
    assert.equal(pick('avatar').getAttribute('aria-pressed'), 'true');
    assert.equal(n.host.dataset.header, 'avatar');
    assert.equal(formChanges, 1, '换选项要让表单变成未保存');
    assert.equal(n.owner.getDisplay().header, 'avatar');
    assert.match(n.owner.summary(), /首页显示头像/);
    n.host.querySelector('#agentPortraitResetBtn').click();
    assert.deepEqual(n.owner.getDisplay(), { header: 'avatar', focusX: 50, focusY: 22, lightFocusX: 30, lightFocusY: 22, height: 248 }, '重置位置不动显示选项或另一主题位置');
    t.dom.window.close();
    n.dom.window.close();
});

test('removing the default portrait also removes the light one, and undo restores both', async () => {
    const t = setup({ portraits: { default: 'file:///default', light: 'file:///light' } });
    await t.owner.load('Nova', {});
    assert.equal(t.owner.summary(), '已设置 · 含浅色版');
    const remove = t.slot('default').querySelector('[data-portrait-action="remove"]');

    remove.click();
    assert.equal(t.slot('default').dataset.state, 'removing');
    assert.equal(t.slot('light').dataset.state, 'removing');
    assert.equal(remove.textContent, '撤销');

    remove.click();
    assert.equal(t.slot('default').dataset.state, 'set');
    assert.equal(t.slot('light').dataset.state, 'set');
    assert.equal(t.owner.hasPendingFiles(), false);

    remove.click();
    await t.owner.commit('Nova');
    assert.deepEqual(t.calls.map(call => call.slice(0, 3)), [['remove', 'Nova', 'default'], ['remove', 'Nova', 'light']]);
    assert.equal(t.slot('default').dataset.state, 'empty');
    t.dom.window.close();
});

test('staged images are kept per agent across switching', async () => {
    const t = setup();
    await t.owner.load('A', {});
    t.pick('default', t.file());
    await t.owner.load('B', {});
    assert.equal(t.owner.hasPendingFiles(), false);
    assert.equal(t.slot('default').dataset.state, 'empty');
    await t.owner.load('A', {});
    assert.equal(t.owner.hasPendingFiles(), true);
    assert.equal(t.slot('default').dataset.state, 'staged');
    t.dom.window.close();
});

test('focus moves with the arrow keys and height and reset feed the saved display', async () => {
    const t = setup({ portraits: { default: 'file:///default' } });
    await t.owner.load('Nova', { portraitDisplay: { focusX: 50, focusY: 20, height: 260 } });
    const preview = t.host.querySelector('#agentPortraitPreview');
    const key = k => preview.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowRight'); key('ArrowDown');
    assert.deepEqual(t.owner.getDisplay(), { header: 'portrait', focusX: 52, focusY: 22, lightFocusX: 50, lightFocusY: 20, height: 260 });
    assert.equal(preview.style.getPropertyValue('--side-pane-portrait-position'), '52% 22%');

    const height = t.host.querySelector('#agentPortraitHeight');
    height.value = '320';
    height.dispatchEvent(new t.win.Event('input', { bubbles: true }));
    assert.equal(t.owner.getDisplay().height, 320);
    assert.equal(t.host.querySelector('#agentPortraitHeightValue').textContent, '320px');

    t.host.querySelector('#agentPortraitResetBtn').click();
    assert.deepEqual(t.owner.getDisplay(), { header: 'portrait', ...PORTRAIT_DISPLAY_DEFAULTS, lightFocusX: 50, lightFocusY: 20 });
    assert.equal(t.host.querySelector('#agentPortraitResetBtn').disabled, true);
    t.dom.window.close();
});

test('theme positions edit and reset independently and survive saving and reloading', async () => {
    for (const light of [undefined, 'file:///light']) {
        const t = setup({ portraits: { default: 'file:///default', ...(light ? { light } : {}) } });
        await t.owner.load('Nova', { portraitDisplay: { focusX: 30, focusY: 40, height: 260 } });
        const preview = t.host.querySelector('#agentPortraitPreview');
        const theme = name => t.host.querySelector(`[data-portrait-preview-theme="${name}"]`).click();
        const key = name => preview.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: name, bubbles: true }));
        const reset = () => t.host.querySelector('#agentPortraitResetBtn').click();
        let changes = 0;
        t.form.addEventListener('change', () => changes++);
        theme('light');
        assert.equal(changes, 0, '切换预览不算修改');
        key('ArrowRight');
        assert.equal(t.owner.getDisplay().lightFocusX, 32);
        assert.equal(t.owner.getDisplay().focusX, 30);
        assert.equal(preview.style.getPropertyValue('--side-pane-portrait-position'), '32% 40%');
        preview.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
        preview.dispatchEvent(new t.win.MouseEvent('pointerdown', { button: 0, clientX: 70, clientY: 80, bubbles: true }));
        assert.equal(t.owner.getDisplay().lightFocusX, 70);
        assert.equal(t.owner.getDisplay().lightFocusY, 80);
        theme('default');
        key('ArrowUp');
        assert.equal(t.owner.getDisplay().focusY, 38);
        assert.equal(t.owner.getDisplay().lightFocusY, 80);
        const saved = JSON.parse(JSON.stringify(t.owner.getDisplay()));
        await t.owner.load('Nova', { portraitDisplay: saved });
        assert.deepEqual(t.owner.getDisplay(), saved);
        theme('light');
        reset();
        assert.equal(t.owner.getDisplay().lightFocusX, 50);
        assert.equal(t.owner.getDisplay().lightFocusY, 22);
        assert.equal(t.owner.getDisplay().focusX, 30);
        assert.equal(t.owner.getDisplay().focusY, 38);
        assert.equal(t.owner.getDisplay().height, 248);
        assert.equal(t.host.querySelector('#agentPortraitResetBtn').disabled, true);
        theme('default');
        assert.equal(t.host.querySelector('#agentPortraitResetBtn').disabled, false);
        t.owner.dispose();
        t.dom.window.close();
    }
});

test('launcher display publishes both theme positions and clears them when hidden', () => {
    const dom = new JSDOM('<div id="view"></div>');
    const view = dom.window.document.getElementById('view');
    applyPortraitDisplay(view, { focusX: 30, focusY: 40, lightFocusX: 70, lightFocusY: 80 });
    assert.equal(view.style.getPropertyValue('--side-pane-portrait-position'), '30% 40%');
    assert.equal(view.style.getPropertyValue('--side-pane-portrait-position-light'), '70% 80%');
    applyPortraitDisplay(view, null);
    assert.equal(view.style.length, 0);
    dom.window.close();
});

test('the light preview shows the light image when there is one, otherwise the default', async () => {
    const t = setup({ portraits: { default: 'file:///default' } });
    await t.owner.load('Nova', {});
    const image = t.host.querySelector('.agent-portrait-preview-image');
    t.host.querySelector('[data-portrait-preview-theme="light"]').click();
    assert.equal(image.getAttribute('src'), 'file:///default');
    t.pick('light', t.file());
    assert.equal(image.getAttribute('src'), 'blob:portrait-1');
    t.host.querySelector('[data-portrait-preview-theme="default"]').click();
    assert.equal(image.getAttribute('src'), 'file:///default');
    t.dom.window.close();
});

test('the collapsed summary follows the portraits read from disk without marking the form unsaved', async () => {
    const t = setup({ portraits: { default: 'file:///portrait.png', happy: 'file:///happy.png' } });
    let formChanges = 0;
    t.form.addEventListener('change', () => formChanges++);
    const before = t.changes();
    await t.owner.load('Coco', {});
    assert.equal(t.owner.summary(), '已设置');
    assert.ok(t.changes() > before, '读完立绘后要通知设置页刷新摘要');
    assert.equal(formChanges, 0, '读盘不算改动');
});
