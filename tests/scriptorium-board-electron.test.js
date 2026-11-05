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
    if (method === 'updateBoard') payload = { requestId, author: { name: 'Kerr', type: 'agent' },
        summary: '测试白板编辑', save: false, ...payload };
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
        const geometry = await page(`const stage=document.querySelector('.scriptorium-board-stage').getBoundingClientRect();const head=document.querySelector('.scriptorium-pane-head').getBoundingClientRect();return {height:stage.height,top:stage.top,headBottom:head.bottom,viewport:innerHeight};`);
        assert.ok(geometry.height > geometry.viewport * 0.6, JSON.stringify(geometry));
        assert.ok(geometry.top >= geometry.headBottom - 1, '画布不能覆盖白板工具栏');
        windowRef.setSize(800, 585);
        await delay(300);
        const compact = await page(`const stage=document.querySelector('.scriptorium-board-stage').getBoundingClientRect();const head=document.querySelector('.scriptorium-pane-head').getBoundingClientRect();return {height:stage.height,top:stage.top,headBottom:head.bottom,viewport:innerHeight};`);
        assert.ok(compact.height > compact.viewport * 0.6, JSON.stringify(compact));
        assert.ok(compact.top >= compact.headBottom - 1, '小窗口画布不能覆盖工具栏');
        windowRef.setSize(1440, 900);
        await delay(300);
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
        const conflicted = await agent('updateBoard', { expectedRevision: empty.revision, delete: ['a'] });
        assert.equal(conflicted.success, false);
        assert.equal(conflicted.status, 'conflict');
        assert.match(conflicted.message, /白板已变化/);
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
        await until(`document.querySelector('input[aria-label="白板名称"]')`, '白板命名');
        await page(`document.querySelector('input[aria-label="白板名称"]').closest('form').requestSubmit(); return true;`);
        await until(`window.ScriptoriumBoardView.doc()?.name === '未命名白板.excalidraw'`, '新白板打开');
        assert.ok(fs.existsSync(path.join(library, 'Boards', '未命名白板.excalidraw')));

        const artifact = await agent('createBoard', {
            name: 'HTML测试白板',
            elements: [{ id: 'html-demo', type: 'html', x: 0, y: 0,
                source: '<div class="demo" style="height:100%;background:#182030">初始</div><script>document.querySelector(".demo").textContent="脚本已执行";</script>' },
                { id: 'hub-create', type: 'rectangle', x: -340, y: 80, width: 240, label: { text: '白板全面升维', fontSize: 22 } },
                { id: 'flow-create', type: 'arrow', start: { id: 'hub-create' }, end: { id: 'html-demo' }, label: { text: '创生节点' } }],
        });
        assert.equal(artifact.saved, true);
        assert.equal(artifact.opened, true);
        await until(`document.querySelector('.scriptorium-board-html-node iframe')`, 'HTML节点显示');
        const htmlBoard = await agent('getBoard');
        assert.equal(htmlBoard.elements.find(element => element.id === 'html-demo').type, 'html');
        const createdArrow = htmlBoard.elements.find(element => element.id === 'flow-create');
        assert.ok(createdArrow.width > 20, JSON.stringify(createdArrow));
        assert.equal(createdArrow.start, 'hub-create');
        assert.equal(createdArrow.end, 'html-demo');
        const diskArrow = JSON.parse(fs.readFileSync(artifact.filePath, 'utf8')).elements.find(element => element.id === 'flow-create');
        assert.ok(Math.hypot(...diskArrow.points[1]) > 20, '落盘前箭头就必须完成布局');
        const src = await agent('getBoardNodeSource', { id: 'html-demo' });
        assert.match(src.source, /初始/);
        await delay(300);
        const frame = windowRef.webContents.mainFrame.framesInSubtree.find((item) => item.url.startsWith('scriptorium-page://board-'));
        assert.ok(frame, 'HTML iframe存在');
        assert.equal(await page(`return getComputedStyle(document.querySelector('.scriptorium-board-html-tools')).visibility;`), 'hidden');
        await page(`const stage=document.querySelector('.scriptorium-board-stage');const r=document.querySelector('.scriptorium-board-html-node').getBoundingClientRect();stage.dispatchEvent(new PointerEvent('pointermove',{clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true}));return true;`);
        assert.equal(await page(`return getComputedStyle(document.querySelector('.scriptorium-board-html-tools')).visibility;`), 'visible');
        assert.equal(await page(`const button=document.querySelector('.scriptorium-board-html-tools button');const r=button.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===button;`), true, 'HTML交互按钮必须实际可见且可点击');
        assert.equal(await frame.executeJavaScript('document.querySelector(".demo").textContent'), '脚本已执行');
        assert.equal(await frame.executeJavaScript('typeof window.scriptoriumAPI'), 'undefined');
        assert.ok(await frame.executeJavaScript('Math.abs(document.querySelector(".demo").getBoundingClientRect().height-innerHeight)<1'), '百分比高度必须撑满iframe');
        await page(`document.querySelector('.scriptorium-board-html-tools button').click();return true;`);
        assert.equal(await page(`return document.querySelector('.scriptorium-board-html-tools button').textContent;`), '✕ 退出');
        assert.equal(await page(`return document.querySelector('.scriptorium-board-html-node iframe').style.pointerEvents;`), 'auto');
        await page(`document.querySelector('.scriptorium-board-html-tools button').click();document.querySelector('.scriptorium-board-stage').dispatchEvent(new PointerEvent('pointerleave'));return true;`);
        assert.equal(await page(`return document.querySelector('.scriptorium-board-html-node iframe').style.pointerEvents;`), 'none');
        assert.equal(await page(`return getComputedStyle(document.querySelector('.scriptorium-board-html-tools')).visibility;`), 'hidden');
        assert.equal(await frame.executeJavaScript('(()=>{try{return Boolean(parent.scriptoriumAPI)}catch(e){return false}})()'), false);
        const edit = await agent('updateBoard', { expectedRevision: htmlBoard.revision, save: true,
            update: [{ id: 'html-demo', replacements: [{ target: '初始', replace: '修改后' }] }] });
        assert.equal(edit.saved, true);
        const persisted = JSON.parse(fs.readFileSync(artifact.filePath, 'utf8'));
        assert.match(persisted.elements.find((item) => item.id === 'html-demo').customData.vcpHtml.source, /修改后/);
        assert.ok(persisted.vcpBoard.records.some((record) => record.status === 'applied' && record.source === 'agent'));
        const history = await agent('getBoardHistory');
        assert.equal(history.autoAllow, true);
        assert.ok(history.records.some((record) => record.receipt?.automatic === true));
        const visualHtml = await agent('getVisualContext');
        assert.equal(visualHtml.scope, 'viewport');
        assert.ok(visualHtml.captureRect.width > 0);
        await page(`const toggle = document.querySelector('.scriptorium-board-lineage input'); toggle.checked=false; toggle.dispatchEvent(new Event('change')); return true;`);
        const beforePending = await agent('getBoard');
        const pending = await agent('updateBoard', { expectedRevision: beforePending.revision, save: true,
            update: [{ id: 'html-demo', replacements: [{ target: '修改后', replace: '人工批准后' }] }] });
        assert.equal(pending.status, 'pending');
        assert.match((await agent('getBoardNodeSource', { id: 'html-demo' })).source, /修改后/);
        await page(`const buttons = [...document.querySelectorAll('.scriptorium-board-lineage-row button')]; buttons.find(b=>b.textContent==='允许').click(); return true;`);
        await until(`window.ScriptoriumBoardView.agent.board.getNodeSource({id:'html-demo'}).source.includes('人工批准后') && !window.ScriptoriumBoardView.doc().dirty`, '人工审批并保存');
        await page(`const toggle = document.querySelector('.scriptorium-board-lineage input'); toggle.checked=true; toggle.dispatchEvent(new Event('change')); return true;`);
        await open('notes.txt');
        await until(`window.ScriptoriumFileViews.doc()?.name === 'notes.txt'`, '切换文本完成');
        await page(`return window.ScriptoriumFileSession.openPath(${JSON.stringify(artifact.filePath)});`);
        await until(`window.ScriptoriumBoardView.doc()?.name === 'HTML测试白板.excalidraw'`, '重开HTML白板');
        assert.match((await agent('getBoardNodeSource', { id: 'html-demo' })).source, /人工批准后/);
        assert.ok((await agent('getBoardHistory')).records.some(record => record.receipt?.automatic === false));
        const libraryResult = await page('return window.scriptoriumAPI.listDocumentLibrary();');
        const boardsRoot = libraryResult.roots.find(root => root.id === 'boards');
        assert.ok(boardsRoot.children.some(entry => entry.name === 'HTML测试白板.excalidraw'));
        assert.ok(!libraryResult.roots.find(root => root.id === 'documents').children.some(entry => entry.name === 'Boards'));
        await page(`document.querySelector('button[aria-label="重命名白板"]').click(); return true;`);
        await page(`const input=document.querySelector('input[aria-label="新白板名称"]');input.value='改名后的白板';input.closest('form').requestSubmit();return true;`);
        await until(`window.ScriptoriumBoardView.doc()?.name==='改名后的白板.excalidraw' && !window.ScriptoriumBoardView.doc()?.saving`, '重命名完成');
        assert.equal(fs.existsSync(artifact.filePath), false);
        assert.ok(fs.existsSync(path.join(library, 'Boards', '改名后的白板.excalidraw')));
        const beforeRestore = (await agent('getBoardHistory')).records.length;
        await page(`window.confirm=()=>true;const rows=[...document.querySelectorAll('.scriptorium-board-lineage-row')];rows.find(row=>row.textContent.includes('修改前基线')).querySelector('button').click();return true;`);
        await until(`window.ScriptoriumBoardView.agent.board.getNodeSource({id:'html-demo'}).source.includes('初始') && !window.ScriptoriumBoardView.doc().dirty`, '回溯并保存');
        assert.ok((await agent('getBoardHistory')).records.length >= beforeRestore + 2);

        assert.deepEqual(errors, [], '页面没有报错');
        console.log('Scriptorium board Electron test passed');
        app.exit(0);
    } catch (error) {
        console.error(error);
        if (errors.length) console.error('页面报错：', errors);
        app.exit(1);
    }
});
