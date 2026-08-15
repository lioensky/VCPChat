'use strict';

const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const GOOGLE_FONT_URL =
    'https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng'
    + '&family=Noto+Serif+SC:wght@400;600;800&display=swap';

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    ipcMain.handle('docx:choose-open', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('scriptorium:choose-import', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('docx:read-path', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('docx:save', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('scriptorium:export-rich-document', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('scriptorium:style-packs-load', () => []);
    ipcMain.handle('scriptorium:style-packs-save', () => ({
        success: true,
        count: 0,
    }));
    ipcMain.handle('scriptorium:svg-assets-load', () => []);
    ipcMain.handle('scriptorium:svg-assets-save', () => ({
        success: true,
        count: 0,
    }));
    ipcMain.on('window-lifecycle:ready', () => {});
    ipcMain.on('minimize-window', () => {});
    ipcMain.on('maximize-window', () => {});
    ipcMain.on('unmaximize-window', () => {});
    ipcMain.on('close-window', () => {});
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

    try {
        await windowRef.loadFile(path.join(
            projectRoot,
            'ScriptoriumModules',
            'scriptorium.html'
        ));
        await delay(500);

        const result = await windowRef.webContents.executeJavaScript(`(async () => {
            document.getElementById('welcome-new-btn').click();
            await new Promise((resolve) => setTimeout(resolve, 300));

            const toggle =
                document.getElementById('trust-network-fonts-toggle');
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));

            document.getElementById('html-mode-btn').click();
            await new Promise((resolve) => setTimeout(resolve, 100));
            const editor = document.querySelector(
                '.source-editor-shell .CodeMirror'
            )?.CodeMirror;
            const fixture = [
                '<style>',
                '@import url("${GOOGLE_FONT_URL}");',
                '.network-font-proof {',
                '    font-family: "Ma Shan Zheng", cursive;',
                '}',
                '</style>',
                '',
                '<p class="network-font-proof">网络字体内部渲染测试</p>'
            ].join('\\n');
            editor.setValue(fixture);
            await new Promise((resolve) => setTimeout(resolve, 350));

            document.getElementById('render-mode-btn').click();
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );

            const root = document.getElementById('page-stream').shadowRoot;
            const hostFontStyle = document.getElementById(
                'scriptorium-trusted-network-font-imports'
            );
            let loadedFaceCount = 0;
            let fontLoadError = '';
            try {
                const faces = await Promise.race([
                    document.fonts.load(
                        '32px "Ma Shan Zheng"',
                        '网络字体内部渲染测试'
                    ),
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error('字体加载等待超时')),
                        12000
                    ))
                ]);
                loadedFaceCount = faces.length;
            } catch (error) {
                fontLoadError = error.message;
            }
            const styles = [...root.querySelectorAll('style')];
            const primaryStyle = styles[0] || null;
            let rules = [];
            let cssomError = '';
            try {
                rules = [...(primaryStyle?.sheet?.cssRules || [])];
            } catch (error) {
                cssomError = error.message;
            }
            const importRule = rules.find((rule) =>
                rule.constructor?.name === 'CSSImportRule'
            );
            const proof = root.querySelector('.network-font-proof');
            return {
                trusted: toggle.checked,
                sourceRetained:
                    editor.getValue().includes('fonts.googleapis.com'),
                hostFontStyleExists: Boolean(hostFontStyle),
                hostFontStyleHasGoogle:
                    String(hostFontStyle?.textContent || '')
                        .includes('fonts.googleapis.com'),
                loadedFaceCount,
                fontLoadError,
                fontSetCheck:
                    document.fonts.check(
                        '32px "Ma Shan Zheng"',
                        '网络字体内部渲染测试'
                    ),
                styleCount: styles.length,
                primaryStylePrefix:
                    String(primaryStyle?.textContent || '').slice(0, 500),
                primaryStyleHasGoogle:
                    String(primaryStyle?.textContent || '')
                        .includes('fonts.googleapis.com'),
                ruleCount: rules.length,
                cssomError,
                firstRuleType: rules[0]?.constructor?.name || '',
                importHref: importRule?.href || '',
                importPrecedesHost:
                    rules.indexOf(importRule)
                    < rules.findIndex((rule) =>
                        String(rule.cssText || '').includes(':host')
                    ),
                proofExists: Boolean(proof),
                computedFamily: proof
                    ? getComputedStyle(proof).fontFamily
                    : ''
            };
        })()`);

        console.log(
            '[ScriptoriumNetworkFontRender] Snapshot:',
            JSON.stringify(result, null, 2)
        );
        assert.equal(result.trusted, true);
        assert.equal(result.sourceRetained, true);
        assert.equal(result.hostFontStyleExists, true);
        assert.equal(result.hostFontStyleHasGoogle, true);
        assert.equal(
            result.fontLoadError,
            '',
            `字体面加载失败：${result.fontLoadError}`
        );
        assert.ok(
            result.loadedFaceCount > 0,
            'Google 字体样式已请求，但没有字体面进入 document.fonts'
        );
        assert.equal(result.fontSetCheck, true);
        assert.equal(result.firstRuleType, 'CSSImportRule');
        assert.equal(result.importHref, GOOGLE_FONT_URL);
        assert.equal(result.importPrecedesHost, true);
        assert.equal(result.proofExists, true);
        assert.match(result.computedFamily, /Ma Shan Zheng/i);

        console.log(
            '[ScriptoriumNetworkFontRender] PASSED',
            JSON.stringify(result)
        );
    } finally {
        if (!windowRef.isDestroyed()) windowRef.destroy();
        app.quit();
    }
}

run().catch((error) => {
    console.error(
        '[ScriptoriumNetworkFontRender] FAILED:',
        error?.stack || error
    );
    app.exit(1);
});