import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const tavernManagerSource = fs.readFileSync(path.join(root, 'Tavernmodules/tavern-manager.js'), 'utf8');

function setupTestDOM(html = '<!doctype html><html><body></body></html>') {
    const dom = new JSDOM(html, {
        url: 'https://vcpchat.local/main.html',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.chatAPI = {
        readTavernRules: async () => ({ version: 1, rules: [] }),
        saveTavernRules: async () => ({ success: true })
    };
    window.eval(tavernManagerSource);
    return { dom, window };
}

test('高级回复规则管理界面中包含注入内容放大编辑按钮，点击可弹出居中放大弹窗', async () => {
    const { dom, window } = setupTestDOM();
    const manager = window.TavernManager;

    manager.store = {
        version: 1,
        rules: [
            {
                id: 'rule_test_1',
                name: '测试注入规则',
                type: 'system_suffix',
                enabled: true,
                content: 'Line 1: 提示词第一行\nLine 2: 提示词第二行\nLine 3: 提示词第三行',
                scope: 'global'
            }
        ]
    };
    manager.selectedRuleId = 'rule_test_1';
    manager._buildManagerModal();

    const modal = window.document.getElementById('tavernManagerModal');
    assert.ok(modal, '管理模态窗应成功挂载');

    const zoomBtn = modal.querySelector('[data-action="zoom-content"]');
    assert.ok(zoomBtn, '编辑区中应渲染放大编辑按钮 [data-action="zoom-content"]');
    assert.ok(zoomBtn.textContent.includes('放大编辑'), '放大按钮文案应包含“放大编辑”');

    const originalTextarea = modal.querySelector('textarea[data-field="content"]');
    assert.ok(originalTextarea, '应存在原始注入内容输入框');
    assert.ok(originalTextarea.value.includes('提示词第一行'), '原始输入框内容应正确回显');

    // 点击放大按钮触发弹窗
    zoomBtn.click();

    const zoomModal = window.document.getElementById('tavernContentZoomModal');
    assert.ok(zoomModal, '点击后应在页面中挂载 #tavernContentZoomModal 弹窗');
    assert.ok(zoomModal.classList.contains('active'), '弹窗应带有 active 类');

    const dialog = zoomModal.querySelector('.tavern-content-zoom-dialog');
    assert.ok(dialog, '应渲染 dialog 容器');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'tavernContentZoomTitle', '应具有正确的无障碍 aria-labelledby 关联');

    const editor = zoomModal.querySelector('.tavern-content-zoom-editor');
    assert.ok(editor, '弹窗内应有大屏编辑器 .tavern-content-zoom-editor');
    assert.equal(editor.value, originalTextarea.value, '大屏编辑器应载入原始输入框的内容');

    // 统计字符和行数
    const stats = zoomModal.querySelector('.tavern-content-zoom-stats');
    assert.ok(stats, '应展示行数和字符数统计');
    assert.ok(stats.textContent.includes('3 行'), '应准确统计行数');

    // 实时双向同步与事件冒泡分发测试
    let inputDispatchedCount = 0;
    originalTextarea.addEventListener('input', () => {
        inputDispatchedCount++;
    });

    editor.value = '更新后的超长自定义系统设定提示词\n第二行内容';
    editor.dispatchEvent(new window.Event('input'));

    assert.equal(originalTextarea.value, editor.value, '在放大窗口输入内容应实时同步回原输入框');
    assert.equal(inputDispatchedCount, 1, '原输入框应收到冒泡的 input 事件以驱动外部响应式逻辑');
    assert.ok(stats.textContent.includes('2 行'), '输入后统计信息应实时刷新');

    // 换行切换测试
    const wrapBtn = zoomModal.querySelector('.tavern-zoom-wrap-btn');
    assert.ok(wrapBtn, '应提供换行切换按钮');
    assert.ok(editor.classList.contains('is-wrapped'), '默认应开启自动换行');
    wrapBtn.click();
    assert.equal(editor.classList.contains('is-wrapped'), false, '点击后应关闭自动换行');

    // 确认完成关闭
    const confirmBtn = zoomModal.querySelector('.tavern-content-zoom-btn-confirm');
    confirmBtn.click();
    assert.equal(window.document.getElementById('tavernContentZoomModal'), null, '点击完成后弹窗应关闭并移除');
    assert.equal(originalTextarea.value, '更新后的超长自定义系统设定提示词\n第二行内容', '关闭后原输入框保留修改结果');

    // 双击原始文本框也能打开放大弹窗
    originalTextarea.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    const zoomModal2 = window.document.getElementById('tavernContentZoomModal');
    assert.ok(zoomModal2, '双击原输入框也应能唤起放大弹窗');

    // IME 输入法候选词状态下按 Esc 不应关闭弹窗
    const imeComposingEsc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true });
    window.dispatchEvent(imeComposingEsc);
    assert.ok(window.document.getElementById('tavernContentZoomModal'), 'isComposing 为 true 时按 Esc 不应误关弹窗');

    const ime229Esc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 229 });
    window.dispatchEvent(ime229Esc);
    assert.ok(window.document.getElementById('tavernContentZoomModal'), 'keyCode 为 229 时按 Esc 不应误关弹窗');

    // 正常按 Esc 键关闭
    const escEvent = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    window.dispatchEvent(escEvent);
    assert.equal(window.document.getElementById('tavernContentZoomModal'), null, '按 Esc 键后弹窗应安全关闭');

    // 测试父级模态窗关闭时级联清理放大弹窗
    zoomBtn.click();
    assert.ok(window.document.getElementById('tavernContentZoomModal'), '重新打开放大弹窗');
    manager.closeManagerModal();
    assert.equal(window.document.getElementById('tavernContentZoomModal'), null, '父级管理器关闭时应同步销毁放大弹窗');
    dom.window.close();
});

test('白天主题下注入内容放大弹窗自适应携带 light-theme 与 data-vcp-theme="light"', async () => {
    const { dom, window } = setupTestDOM(`<!doctype html><html class="light-theme"><body class="light-theme" data-vcp-theme="light"></body></html>`);
    const manager = window.TavernManager;

    manager.store = {
        version: 1,
        rules: [
            {
                id: 'rule_light_test',
                name: '白天测试规则',
                type: 'system_suffix',
                enabled: true,
                content: 'Daylight content',
                scope: 'global'
            }
        ]
    };
    manager.selectedRuleId = 'rule_light_test';
    manager._buildManagerModal();

    const zoomBtn = window.document.querySelector('[data-action="zoom-content"]');
    zoomBtn.click();

    const zoomModal = window.document.getElementById('tavernContentZoomModal');
    assert.ok(zoomModal, '弹窗应成功打开');
    assert.ok(zoomModal.classList.contains('light-theme'), '弹窗应带有 light-theme 类');
    assert.equal(zoomModal.dataset.vcpTheme, 'light', '弹窗应带有 data-vcp-theme="light" 属性');

    manager.closeManagerModal();
    dom.window.close();
});
