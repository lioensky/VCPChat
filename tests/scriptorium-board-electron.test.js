'use strict';

if (require('./helpers/electron-test-entry.cjs').runFromNode(__filename)) return;

// 白板与 Agent 读写文件：使用真实的 docxHandlers 与页面中的 Agent 请求通路（scriptorium:agent-request → scriptorium.js →
// scriptorium-file-agent.js），在离屏窗口中打开白板，检查 GetBoard、UpdateBoard、白板导出的图片、修订号冲突、保存回原文件，
// 以及其他文件视图打开时 Agent 的读取跟随该文件、修改文稿的命令被拒绝。白板的修改需要等待画面帧，因此使用离屏渲染而不是隐藏窗口。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, protocol } = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const webPages = require('../modules/scriptorium/webPages');
protocol.registerSchemesAsPrivileged([webPages.PRIVILEGE]);

const dataRoot = process.env.VCP_ELECTRON_TEST_DATA;
const library = path.join(dataRoot, 'ScriptoriumDocument', 'VDOCX');
const file = (name) => path.join(library, name);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const EMPTY_BOARD = JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements: [], appState: {}, files: {} });

function registerWindowIpc() {
    ipcMain.handle('get-current-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
    ipcMain.on('window-lifecycle:ready', () => {});
    ipcMain.on('minimize-window', () => {});
    ipcMain.on('maximize-window', () => {});
    ipcMain.on('unmaximize-window', () => {});
    ipcMain.on('close-window', () => {});
    ipcMain.on('open-dev-tools', () => {});
}

let windowRef = null;
const page = (body) => windowRef.webContents.executeJavaScript(`(async () => { ${body} })()`, true);
async function until(expression, what, timeout = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await page(`return Boolean(${expression});`)) return;
        await delay(100);
    }
    throw new Error(`等待超时：${what}`);
}
const open = (name) => page(`void window.ScriptoriumFileSession.openPath(${JSON.stringify(file(name))}); return true;`);

// 与 docxHandlers.requestAgentOperation 相同的通道：主进程发出请求，页面经 scriptorium.js 应答。
let requestCount = 0;
const answers = new Map();
function agent(method, payload = {}) {
    const requestId = `board-test-${++requestCount}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { answers.delete(requestId); reject(new Error(`Agent 请求超时：${method}`)); }, 20000);
        answers.set(requestId, (response) => {
            clearTimeout(timer);
            if (response.error) reject(new Error(response.error.message || String(response.error)));
            else resolve(response.result);
        });
        windowRef.webContents.send('scriptorium:agent-request', { requestId, endpoint: 'common', method, payload });
    });
}

app.whenReady().then(async () => {
    const errors = [];
    try {
        fs.mkdirSync(library, { recursive: true });
        fs.writeFileSync(file('plan.excalidraw'), EMPTY_BOARD);
        fs.writeFileSync(file('notes.txt'), '第一行\n第二行\n');
        registerWindowIpc();
        require('../modules/ipc/docxHandlers').initialize({ mainWindow: null, openChildWindows: [], projectRoot, appDataRoot: dataRoot });
        ipcMain.on('scriptorium:agent-response', (_event, response) => answers.get(response?.requestId)?.(response));
        webPages.installProtocol();

        windowRef = new BrowserWindow({
            width: 1440,
            height: 900,
            show: false,
            frame: false,
            webPreferences: { preload: path.join(projectRoot, 'preloads', 'docx.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true },
        });
        windowRef.webContents.setAudioMuted(true);
        windowRef.webContents.on('console-message', (...args) => {
            const details = args.find((value) => value && typeof value === 'object' && typeof value.message === 'string');
            const level = details?.level ?? args[1];
            const message = details?.message ?? args[2] ?? '';
            if (level === 'error' || level === 3) errors.push(message);
        });
        windowRef.webContents.on('render-process-gone', (_event, details) => errors.push(`render-process-gone: ${details.reason}`));
        await windowRef.loadFile(path.join(projectRoot, 'ScriptoriumModules', 'scriptorium.html'));
        await until(`window.ScriptoriumFileViews && window.ScriptoriumFileAgent && window.ScriptoriumBoardView`, '页面载入');

        // 没有打开白板时，白板命令说明原因。
        await assert.rejects(agent('getBoard'), /不是白板/);

        // 打开白板。
        await open('plan.excalidraw');
        await until(`window.ScriptoriumBoardView.doc()?.kind === 'board'`, '白板打开');
        assert.equal(await page(`return document.getElementById('document-title').textContent;`), 'plan.excalidraw');
        const empty = await agent('getBoard');
        assert.equal(empty.documentKind, 'board');
        assert.equal(empty.total, 0);

        // UpdateBoard：两张卡片与一条连接箭头，箭头位置自动计算，第二张卡片相对第一张放置。
        const written = await agent('updateBoard', {
            expectedRevision: empty.revision,
            add: [
                { id: 'a', type: 'rectangle', x: 0, y: 0, label: { text: '读取配置', fontSize: 22 } },
                { id: 'b', type: 'rectangle', right: 'a', label: { text: '启动服务', fontSize: 22 } },
                { id: 'link', type: 'arrow', start: { id: 'a' }, end: { id: 'b' }, label: { text: '然后' } },
            ],
        });
        assert.deepEqual([...written.added].sort(), ['a', 'b', 'link']);
        assert.deepEqual(written.crowded, []);
        assert.deepEqual(written.loose, []);
        assert.equal(written.saved, false);
        assert.equal(await page(`return document.getElementById('save-state').textContent;`), '未保存');

        const board = await agent('getBoard');
        assert.equal(board.total, 3);
        const byId = Object.fromEntries(board.elements.map((element) => [element.id, element]));
        assert.equal(byId.a.label, '读取配置');
        assert.equal(byId.a.by, 'agent');
        assert.equal(byId.link.start, 'a');
        assert.equal(byId.link.end, 'b');
        assert.ok(byId.b.x > byId.a.x + byId.a.width, '第二张卡片放在第一张右侧');
        const onlyA = await agent('getBoard', { ids: ['a'] });
        assert.deepEqual(onlyA.elements.map((element) => element.id), ['a']);

        // 修订号不一致时拒绝修改，白板不变。
        await assert.rejects(agent('updateBoard', { expectedRevision: empty.revision, delete: ['a'] }), /白板已变化/);
        assert.equal((await agent('getBoard')).total, 3);

        // 移动卡片后，连接的箭头随之移动。
        const moved = await agent('updateBoard', { expectedRevision: board.revision, update: [{ id: 'b', y: 300 }] });
        assert.deepEqual(moved.updated, ['b']);
        const after = Object.fromEntries((await agent('getBoard')).elements.map((element) => [element.id, element]));
        assert.ok(after.link.y + after.link.points[1][1] > 250, '箭头终点随卡片下移');

        // GetVisualContext：白板导出图片，不截取窗口。
        const visual = await agent('getVisualContext', { ids: ['a', 'b'] });
        assert.equal(visual.scope, 'board');
        assert.match(visual.imageDataUrl, /^data:image\/png;base64,/);

        // 保存回原文件（Ctrl+S）。
        {
            await page(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); return true;`);
            const started = Date.now();
            let saved = null;
            while (Date.now() - started < 10000) {
                saved = JSON.parse(fs.readFileSync(file('plan.excalidraw'), 'utf8'));
                if (saved.elements.length) break;
                await delay(100);
            }
            assert.equal(saved.type, 'excalidraw');
            assert.ok(saved.elements.some((element) => element.id === 'a' && !element.isDeleted));
            assert.ok(saved.elements.some((element) => element.type === 'text' && element.originalText === '读取配置'));
            await until(`document.getElementById('save-state').textContent === '已保存'`, '白板已保存');
        }

        // 其他文件视图：Agent 读取当前文件，修改文稿的命令被拒绝。
        await open('notes.txt');
        await until(`window.ScriptoriumTextView.doc()?.kind === 'text'`, '文本打开');
        const info = await agent('getDocumentInfo');
        assert.equal(info.documentKind, 'text');
        assert.equal(info.filePath, file('notes.txt'));
        assert.equal((await agent('getRenderedText')).text, '第一行\n第二行\n');
        assert.equal((await agent('searchSource', { query: '第二' })).results[0].line, 2);
        await assert.rejects(agent('submitSourcePr', { replacements: [] }), /未执行/);
        await assert.rejects(agent('getOutline'), /只适用于文稿和演示/);

        // “开始”菜单中的“新白板”：在文库的 Boards 文件夹中新建并打开。
        await page(`document.getElementById('new-board-btn').click(); return true;`);
        await until(`window.ScriptoriumBoardView.doc()?.name === '未命名白板.excalidraw'`, '新白板打开');
        assert.ok(fs.existsSync(path.join(library, 'Boards', '未命名白板.excalidraw')));

        assert.deepEqual(errors, [], '页面没有报错');
        console.log('Scriptorium board Electron test passed');
        app.exit(0);
    } catch (error) {
        console.error(error);
        if (errors.length) console.error('页面报错：', errors);
        app.exit(1);
    }
});
