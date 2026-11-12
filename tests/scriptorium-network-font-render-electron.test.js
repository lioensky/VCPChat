'use strict';

if (require('./helpers/electron-test-entry.cjs').runFromNode(__filename)) return;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, nativeTheme, session } = require('electron');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const GOOGLE_FONT_URL =
    'https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng'
    + '&family=Noto+Serif+SC:wght@400;600;800&display=swap';
const GOOGLE_FONT_BINARY_URL =
    'https://fonts.gstatic.com/s/mashanzheng/v1/MaShanZheng-Fixture.woff2';
const LOCAL_FIXTURE_WOFF2 = path.join(
    projectRoot,
    'vendor',
    'excalidraw',
    'fonts',
    'Assistant',
    'Assistant-Regular.woff2'
);

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function registerMinimalIpc() {
    ipcMain.handle('get-current-theme', () =>
        nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    );
    ipcMain.handle('docx:recent-list', () => []);
    ipcMain.handle('scriptorium:document-library', () => ({
        success: true,
        extensions: ['vdocx', 'docx', 'vpptx', 'pptx', 'txt', 'html', 'md'],
        roots: [],
    }));
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

function registerDeterministicGoogleFontProtocol(fontBytes) {
    const fontCss = [
        '@font-face {',
        '  font-family: "Ma Shan Zheng";',
        '  font-style: normal;',
        '  font-weight: 400;',
        '  font-display: swap;',
        `  src: url("${GOOGLE_FONT_BINARY_URL}") format("woff2");`,
        '}',
        '@font-face {',
        '  font-family: "Noto Serif SC";',
        '  font-style: normal;',
        '  font-weight: 400;',
        '  font-display: swap;',
        `  src: url("${GOOGLE_FONT_BINARY_URL}") format("woff2");`,
        '}',
    ].join('\n');

    session.defaultSession.protocol.handle('https', (request) => {
        if (request.url === GOOGLE_FONT_URL) {
            return new Response(fontCss, {
                status: 200,
                headers: {
                    'content-type': 'text/css; charset=utf-8',
                    'access-control-allow-origin': '*',
                },
            });
        }
        if (request.url === GOOGLE_FONT_BINARY_URL) {
            return new Response(fontBytes, {
                status: 200,
                headers: {
                    'content-type': 'font/woff2',
                    'access-control-allow-origin': '*',
                },
            });
        }
        return new Response('Unexpected external HTTPS request in isolated test', {
            status: 404,
        });
    });
}

async function run() {
    await app.whenReady();
    const fixtureFontBytes = fs.readFileSync(LOCAL_FIXTURE_WOFF2);
    registerMinimalIpc();
    registerDeterministicGoogleFontProtocol(fixtureFontBytes);

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
                const deadline = Date.now() + 12000;
                while (Date.now() < deadline && loadedFaceCount === 0) {
                    const faces = await Promise.race([
                        document.fonts.load(
                            '32px "Ma Shan Zheng"',
                            '网络字体内部渲染测试'
                        ),
                        new Promise((_, reject) => setTimeout(
                            () => reject(new Error('字体加载等待超时')),
                            4000
                        ))
                    ]);
                    if (faces.length > 0) {
                        loadedFaceCount = faces.length;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 40));
                }
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
    }
}

run().then(() => app.exit(0)).catch((error) => {
    console.error(
        '[ScriptoriumNetworkFontRender] FAILED:',
        error?.stack || error
    );
    app.exit(1);
});