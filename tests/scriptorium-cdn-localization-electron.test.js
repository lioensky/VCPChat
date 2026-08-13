'use strict';

const assert = require('assert');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const CDN_URL =
    'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js';
const LOCAL_URL = '../vendor/three.min.js';

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(callback, timeout = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        const result = await callback();
        if (result) return result;
        await delay(50);
    }
    throw new Error(`等待条件超时（${timeout} ms）`);
}

function registerMinimalIpc() {
    ipcMain.handle('get-current-theme', () =>
        nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    );
    ipcMain.handle('docx:recent-list', () => []);
    ipcMain.handle('docx:fonts-list', () => ['Arial', 'Microsoft YaHei']);
    ipcMain.handle('load-agents-list', () => []);
    ipcMain.handle('load-user-avatar', () => null);
    ipcMain.handle('load-agent-avatar', () => null);
    ipcMain.handle('docx:choose-open', () => ({ success: false, canceled: true }));
    ipcMain.handle('scriptorium:choose-import', () =>
        ({ success: false, canceled: true })
    );
    ipcMain.handle('docx:read-path', () => ({ success: false, canceled: true }));
    ipcMain.handle('docx:save', () => ({ success: false, canceled: true }));
    ipcMain.handle('scriptorium:export-rich-document', () =>
        ({ success: false, canceled: true })
    );
    ipcMain.handle('scriptorium:svg-assets-load', () => []);
    ipcMain.handle('scriptorium:svg-assets-save', (_event, packs = []) => ({
        success: true,
        count: packs.length,
        size: 0,
    }));
    ipcMain.on('window-lifecycle:ready', () => {});
    ipcMain.on('minimize-window', () => {});
    ipcMain.on('maximize-window', () => {});
    ipcMain.on('unmaximize-window', () => {});
    ipcMain.on('close-window', () => {});
    ipcMain.on('open-dev-tools', () => {});
}

async function run() {
    await app.whenReady();
    registerMinimalIpc();

    const windowRef = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        frame: false,
        webPreferences: {
            preload: path.join(projectRoot, 'preloads', 'docx.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    const rendererErrors = [];
    windowRef.webContents.on('console-message', (...args) => {
        const details = args.find((value) =>
            value && typeof value === 'object' && typeof value.message === 'string'
        );
        const level = details?.level ?? args[1];
        const message = details?.message ?? args[2] ?? '';
        if (level === 'error' || level === 3) rendererErrors.push(message);
    });

    try {
        await windowRef.loadFile(
            path.join(projectRoot, 'ScriptoriumModules', 'scriptorium.html')
        );
        await delay(500);
        await windowRef.webContents.executeJavaScript(
            `document.getElementById('new-deck-btn').click()`
        );
        await delay(500);

        await windowRef.webContents.executeJavaScript(`(() => {
            const info = window.ScriptoriumAgent.pptx.getDocumentInfo();
            const payload = {
                requestId: 'cdn-localization-add-slide-test',
                expectedRevision: info.revision,
                author: {
                    id: 'nova',
                    name: 'Nova',
                    type: 'agent'
                },
                summary: '新增最小 Three.js 本地 URL 转换测试页',
                name: 'Mini 3D 本地化测试',
                source: \`<style>
*{box-sizing:border-box}.mini-stage{width:600px;height:600px}
</style>
<section class="vdoc-slide-scene mini-three-test">
  <script src="${CDN_URL}"><\\/script>
  <div class="mini-copy">
    <span>LOCAL RUNTIME TEST</span>
    <h1>Mini 3D</h1>
    <p class="mini-state">等待 Three.js 本地运行时……</p>
  </div>
  <div class="mini-stage"></div>
</section>
<script>
(()=>{
  const root=document.querySelector(".mini-three-test");
  if(!root||root.dataset.bound)return;
  root.dataset.bound="1";
  const state=root.querySelector(".mini-state");
  if(typeof THREE==="undefined"){
    state.textContent="FAILED · THREE 未注入";
    return;
  }
  state.textContent="OK · THREE 本地运行时已加载";
})();
<\\/script>\`,
                notes: '检查 Three.js CDN 是否转换为本地 URL。'
            };
            window.__cdnLocalizationPromise =
                window.ScriptoriumAgent.pptx.addSlide(payload);
        })()`);

        const pending = await waitUntil(async () =>
            windowRef.webContents.executeJavaScript(`(() => {
                const records = window.ScriptoriumAgent.review.listPending();
                const record = records.find((item) =>
                    item.requestId === 'cdn-localization-add-slide-test'
                    || item.summary === '新增最小 Three.js 本地 URL 转换测试页'
                );
                return record || null;
            })()`)
        );

        assert.strictEqual(pending.status, 'pending');
        assert.ok(
            pending.proposal.source.includes(`src="${LOCAL_URL}"`),
            `待审 AddSlide PR 未转换为本地 URL：${pending.proposal.source}`
        );
        assert.ok(
            pending.proposal.source.includes(
                `data-vdoc-original-src="${CDN_URL}"`
            ),
            '待审 AddSlide PR 应保留原始 Three.js CDN URL 作为审计元数据'
        );
        assert.ok(
            !new RegExp(
                `<script\\b[^>]*\\ssrc="${CDN_URL.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&'
                )}"`
            ).test(pending.proposal.source),
            '待审 AddSlide PR 的可执行 src 仍指向原始 Three.js CDN'
        );
        assert.deepStrictEqual(
            pending.proposal.programmableContent.dependencies,
            ['three']
        );
        assert.ok(
            pending.proposal.programmableContent.diagnostics.some((item) =>
                item.ruleId === 'cdn-localized'
                && item.library === 'three'
                && item.source === CDN_URL
                && item.localUrl === LOCAL_URL
            ),
            '待审 AddSlide PR 缺少 Three.js CDN 本地化诊断'
        );

        const approved = await windowRef.webContents.executeJavaScript(
            `window.ScriptoriumAgent.review.approvePr(${JSON.stringify(pending.id)}, {
                message: '自动化测试批准'
            })`
        );
        assert.strictEqual(approved.success, true);

        const result = await windowRef.webContents.executeJavaScript(`(async () => {
            const approvalOutcome = await window.__cdnLocalizationPromise;
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
            const source = window.ScriptoriumAgent.pptx.getSource({
                sourceKind: 'html',
                slideIndex: 1
            }).source;
            const root = document.getElementById('page-stream').shadowRoot;
            return {
                source,
                dependencies:
                    approvalOutcome.result?.programmableContent?.dependencies || [],
                hasGlobalThree: typeof window.THREE !== 'undefined',
                runtimeText:
                    root.querySelector('.mini-state')?.textContent || ''
            };
        })()`);

        assert.ok(
            result.source.includes(`src="${LOCAL_URL}"`),
            `批准后的页面源码未保留本地 URL：${result.source}`
        );
        assert.ok(
            result.source.includes(`data-vdoc-original-src="${CDN_URL}"`),
            '批准后的页面源码应保留原始 Three.js CDN URL 作为审计元数据'
        );
        assert.ok(
            !new RegExp(
                `<script\\b[^>]*\\ssrc="${CDN_URL.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&'
                )}"`
            ).test(result.source),
            '批准后的页面可执行 src 仍指向原始 Three.js CDN'
        );
        assert.ok(
            result.dependencies.includes('three'),
            '文档 programmableDependencies 未登记 three'
        );
        assert.strictEqual(
            result.hasGlobalThree,
            true,
            'Scriptorium 宿主页未预加载本地 Three.js'
        );
        assert.strictEqual(
            result.runtimeText,
            'OK · THREE 本地运行时已加载',
            `页面脚本未使用本地 Three.js 运行时：${result.runtimeText}`
        );

        const relevantErrors = rendererErrors.filter((message) =>
            /cdn-localization|THREE 未注入|Scriptorium.*runtime failed/i.test(message)
        );
        assert.deepStrictEqual(relevantErrors, []);

        console.log('[ScriptoriumCDNLocalization] PASSED');
    } finally {
        if (!windowRef.isDestroyed()) windowRef.destroy();
        app.quit();
    }
}

run().catch((error) => {
    console.error('[ScriptoriumCDNLocalization] FAILED:', error);
    app.exitCode = 1;
    app.quit();
});