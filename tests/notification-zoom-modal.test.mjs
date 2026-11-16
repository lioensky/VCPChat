import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const notificationRendererSource = fs.readFileSync(path.join(root, 'modules/notificationRenderer.js'), 'utf8');

test('通知项包含居中放大按钮，点击弹出居中放大模态窗', async () => {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="floating-toast-notifications-container"></div>
        <div id="notificationsSidebar" class="sidebar active">
            <ul id="notificationsList"></ul>
        </div>
    </body></html>`, { url: 'https://vcpchat.local/main.html', runScripts: 'outside-only' });

    const { window } = dom;
    window.eval(notificationRendererSource);

    const listUl = window.document.getElementById('notificationsList');
    const logData = {
        type: 'vcp_log',
        data: {
            tool_name: 'ToolCallRecordQuery',
            status: 'error',
            content: 'The module better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 127.'
        }
    };

    window.renderVCPLogNotification(logData, JSON.stringify(logData), listUl);

    const card = listUl.querySelector('.notification-item');
    assert.ok(card, '应成功渲染通知卡片');

    const zoomBtn = card.querySelector('.notification-zoom-btn');
    assert.ok(zoomBtn, '卡片中应存在放大按钮 (.notification-zoom-btn)');
    assert.equal(zoomBtn.title, '居中放大查看');

    // 点击放大按钮触发弹窗
    zoomBtn.click();

    const modal = window.document.getElementById('notificationZoomModal');
    assert.ok(modal, '点击后应在页面中挂载 #notificationZoomModal 弹窗');
    assert.ok(modal.classList.contains('active'), '弹窗应带有 active 类');

    const content = modal.querySelector('.notification-zoom-content');
    assert.ok(content, '弹窗内应有内容容器 .notification-zoom-content');
    assert.ok(content.textContent.includes('better_sqlite3.node'), '弹窗内容应包含日志信息');
    assert.ok(content.classList.contains('is-wrapped'), '默认应开启自动换行');

    // 验证换行切换
    const wrapBtn = modal.querySelector('.notification-zoom-wrap-btn');
    assert.ok(wrapBtn, '应提供换行切换按钮');
    wrapBtn.click();
    assert.equal(content.classList.contains('is-wrapped'), false, '点击后应关闭自动换行');

    // 验证 Esc 快捷键关闭
    const escEvent = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    window.document.dispatchEvent(escEvent);
    assert.equal(window.document.getElementById('notificationZoomModal'), null, '按 Esc 键后弹窗应被关闭移除');

    dom.window.close();
});

test('白天主题下弹窗自适应携带 light-theme 与 data-vcp-theme="light"', async () => {
    const dom = new JSDOM(`<!doctype html><html class="light-theme"><body class="light-theme" data-vcp-theme="light">
        <div id="notificationsSidebar" class="sidebar active">
            <ul id="notificationsList"></ul>
        </div>
    </body></html>`, { url: 'https://vcpchat.local/main.html', runScripts: 'outside-only' });

    const { window } = dom;
    window.eval(notificationRendererSource);

    const listUl = window.document.getElementById('notificationsList');
    const logData = {
        type: 'vcp_log',
        data: {
            tool_name: 'TestTool',
            status: 'info',
            content: 'Hello light mode'
        }
    };

    window.renderVCPLogNotification(logData, JSON.stringify(logData), listUl);
    const card = listUl.querySelector('.notification-item');
    const zoomBtn = card.querySelector('.notification-zoom-btn');
    zoomBtn.click();

    const modal = window.document.getElementById('notificationZoomModal');
    assert.ok(modal, '弹窗应成功打开');
    assert.ok(modal.classList.contains('light-theme'), '弹窗应带有 light-theme 类');
    assert.equal(modal.dataset.vcpTheme, 'light', '弹窗应带有 data-vcp-theme="light" 属性');

    dom.window.close();
});

