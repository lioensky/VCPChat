'use strict';

if (require('./helpers/electron-test-entry.cjs').runFromNode(__filename)) return;

// 文坊原位打开文件：使用真实的 docxHandlers、modules/scriptorium 和 scriptorium-page:// 协议，
// 在隐藏窗口中打开文库里的 Markdown、文本、表格、网页、图片和 PDF，检查显示、保存回原文件、
// 未保存修改的询问、外部修改后的重新载入，以及离开视图后原有界面的还原。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, protocol, webFrameMain } = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const webPages = require('../modules/scriptorium/webPages');
protocol.registerSchemesAsPrivileged([webPages.PRIVILEGE]);

const dataRoot = process.env.VCP_ELECTRON_TEST_DATA;
const library = path.join(dataRoot, 'ScriptoriumDocument', 'VDOCX');
const file = (name) => path.join(library, name);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function writeFixtures() {
    fs.mkdirSync(path.join(library, 'img'), { recursive: true });
    fs.writeFileSync(file('note.md'), '# 标题\r\n\r\n正文第一段。\r\n\r\n![图](img/dot.png)\r\n');
    fs.writeFileSync(file('img/dot.png'), PNG);
    fs.writeFileSync(file('plain.txt'), '第一行\n第二行\n');
    fs.writeFileSync(file('other.txt'), '另一个文件\n');
    fs.writeFileSync(file('table.csv'), '名称,数量\n甲,1\n乙,2\n');
    fs.writeFileSync(file('page.html'), '<!doctype html><html><head><meta charset="utf-8"><title>网页</title></head><body><h1>网页正文</h1></body></html>');
    fs.writeFileSync(file('dot.png'), PNG);
    const { PDFDocument } = require('../vendor/pdf-lib/pdf-lib.min.js');
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]);
    pdf.addPage([300, 400]);
    fs.writeFileSync(file('two.pdf'), await pdf.save());
}

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
async function until(expression, what, timeout = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await page(`return Boolean(${expression});`)) return;
        await delay(100);
    }
    throw new Error(`等待超时：${what}`);
}
async function untilFile(name, check, what, timeout = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (check(fs.readFileSync(file(name)))) return;
        await delay(100);
    }
    throw new Error(`等待超时：${what}`);
}
// 打开文件时不等待结果：有未保存的修改时会先显示询问对话框。
const open = (name) => page(`void window.ScriptoriumFileSession.openPath(${JSON.stringify(file(name))}); return true;`);
const click = (selector) => page(`document.querySelector(${JSON.stringify(selector)}).click(); return true;`);
const pressCtrl = (key) => page(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: true, bubbles: true, cancelable: true })); return true;`);
const title = () => page(`return document.getElementById('document-title').textContent;`);
const textEditor = `document.querySelector('.scriptorium-text-source .CodeMirror').CodeMirror`;

app.whenReady().then(async () => {
    const errors = [];
    try {
        await writeFixtures();
        registerWindowIpc();
        require('../modules/ipc/docxHandlers').initialize({ mainWindow: null, openChildWindows: [], projectRoot, appDataRoot: dataRoot });
        webPages.installProtocol();

        windowRef = new BrowserWindow({
            width: 1440,
            height: 900,
            show: false,
            frame: false,
            webPreferences: { preload: path.join(projectRoot, 'preloads', 'docx.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
        });
        windowRef.webContents.setAudioMuted(true);
        windowRef.webContents.on('console-message', (...args) => {
            const details = args.find((value) => value && typeof value === 'object' && typeof value.message === 'string');
            const level = details?.level ?? args[1];
            const message = details?.message ?? args[2] ?? '';
            // 页面卸载时原有的渲染协调器会报这一条（重新载入窗口时出现，tests/scriptorium-find-smoke.js 关窗时同样出现），与本测试无关。
            if (/Render coordinator has been disposed/.test(message)) return;
            if (level === 'error' || level === 3) errors.push(message);
        });
        windowRef.webContents.on('render-process-gone', (_event, details) => errors.push(`render-process-gone: ${details.reason}`));
        await windowRef.loadFile(path.join(projectRoot, 'ScriptoriumModules', 'scriptorium.html'));
        await until(`window.ScriptoriumFileViews && window.ScriptoriumFileSession`, '页面载入');

        // Markdown：在原有的编辑面中打开，相对图片按文件所在文件夹显示，保存时保留 CRLF。
        await open('note.md');
        await until(`window.ScriptoriumFileSession.current()?.markdownFile`, 'Markdown 打开');
        await until(`[...(document.getElementById('page-stream').shadowRoot?.querySelectorAll('img') || [])].some((img) => img.src.startsWith('file:///') && img.src.endsWith('/img/dot.png'))`, '相对图片解析');
        assert.equal(await title(), 'note.md');
        await page(`const session = window.ScriptoriumFileSession; return session.replaceSource(session.source().replace('正文第一段。', '正文第一段，已修改。'));`);
        await click('#save-btn');
        await untilFile('note.md', (bytes) => bytes.toString('utf8').includes('已修改'), 'Markdown 保存');
        const markdown = fs.readFileSync(file('note.md'), 'utf8');
        assert.equal(markdown.split('\r\n').length - 1, markdown.split('\n').length - 1, '保存后的 .md 仍全部使用 CRLF');

        // 文本：在文档区域的位置上打开；标题栏显示文件名；不支持另存为；Ctrl+S 保存回原文件。
        await open('plain.txt');
        await until(`document.body.classList.contains('scriptorium-text-mode') && document.querySelector('.scriptorium-text-source .CodeMirror')`, '文本打开');
        assert.equal(await title(), 'plain.txt');
        assert.equal(await page(`return document.getElementById('save-as-btn').disabled;`), true);
        // 视图盖在文档区域上：文档区中心点处是文本视图。
        assert.equal(await page(`const box = document.getElementById('document-workspace').getBoundingClientRect();
            return Boolean(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('.scriptorium-text-work'));`), true);
        await page(`${textEditor}.replaceRange('新增一行\\n', { line: 0, ch: 0 }); return true;`);
        await until(`document.getElementById('save-state').textContent === '未保存'`, '文本未保存状态');
        await pressCtrl('s');
        await untilFile('plain.txt', (bytes) => bytes.toString('utf8') === '新增一行\n第一行\n第二行\n', '文本保存');
        await until(`document.getElementById('save-state').textContent === '已保存'`, '文本已保存状态');

        // 未保存的修改：打开别的文件前用原有的对话框询问；留在此处时不切换，舍弃修改时不写入文件。
        await page(`${textEditor}.replaceRange('不保存的修改\\n', { line: 0, ch: 0 }); return true;`);
        await open('other.txt');
        await until(`document.getElementById('unsaved-dialog').hidden === false`, '未保存对话框');
        assert.equal(await page(`return document.getElementById('unsaved-document-name').textContent;`), 'plain.txt');
        await click('#unsaved-cancel-btn');
        await until(`document.getElementById('unsaved-dialog').hidden`, '对话框关闭');
        assert.equal(await title(), 'plain.txt');
        assert.equal(await page(`return window.ScriptoriumTextView.doc().dirty;`), true);
        await open('other.txt');
        await until(`document.getElementById('unsaved-dialog').hidden === false`, '再次询问');
        await click('#unsaved-discard-btn');
        await until(`document.getElementById('document-title').textContent === 'other.txt'`, '舍弃后打开另一个文件');
        assert.equal(fs.readFileSync(file('plain.txt'), 'utf8'), '新增一行\n第一行\n第二行\n');

        // 外部修改：没有未保存的修改时自动重新载入。
        fs.writeFileSync(file('other.txt'), '另一个文件\n外部追加\n');
        await until(`${textEditor}.getValue().includes('外部追加')`, '外部修改后重新载入');

        // 回到首页：视图离开，标题栏和“篇章”面板还原，另存为恢复可用。
        await click('#home-btn');
        await until(`!document.body.classList.contains('scriptorium-text-mode') && !document.body.classList.contains('scriptorium-file-view-open')`, '回到首页');
        assert.notEqual(await title(), 'other.txt');
        assert.equal(await page(`return document.getElementById('save-as-btn').disabled;`), false);
        assert.equal(await page(`return document.querySelector('.outline-header h2').textContent;`), '篇章');

        // 表格：工作表列表显示在“篇章”面板中。
        await open('table.csv');
        await until(`document.body.classList.contains('scriptorium-table-mode') && window.ScriptoriumTableView._state()?.rows === 2`, '表格打开');
        assert.equal(await page(`return document.querySelector('.outline-header h2').textContent;`), '工作表');

        // 网页：在 scriptorium-page:// 的框中原样显示；可切换到源码。
        await open('page.html');
        await until(`document.querySelector('.scriptorium-page-work:not([hidden]) iframe.scriptorium-page-frame')`, '网页打开');
        let heading = '';
        for (let tries = 0; tries < 100 && heading !== '网页正文'; tries += 1) {
            const frame = windowRef.webContents.mainFrame.framesInSubtree.find((item) => item.name === webPages.FRAME_NAME);
            heading = frame ? await frame.executeJavaScript(`document.querySelector('h1')?.textContent || ''`).catch(() => '') : '';
            if (heading !== '网页正文') await delay(100);
        }
        assert.equal(heading, '网页正文');
        assert.ok(webFrameMain, 'webFrameMain 可用');
        await click('.scriptorium-page-work .scriptorium-seg button[data-view="source"]');
        await until(`document.querySelector('.scriptorium-page-work').dataset.view === 'source' && document.querySelector('.scriptorium-page-source .CodeMirror')?.CodeMirror.getValue().includes('网页正文')`, '网页源码');
        // 显示方式会被记住：重新载入窗口后打开网页，仍显示源码。
        windowRef.webContents.reload();
        await delay(500);
        await until(`window.ScriptoriumFileSession && window.ScriptoriumWebPage`, '重新载入后网页视图可用');
        await open('page.html');
        await until(`document.querySelector('.scriptorium-page-work:not([hidden])')?.dataset.view === 'source'`, '重新载入后仍显示源码');

        // 图片
        await open('dot.png');
        await until(`document.body.classList.contains('scriptorium-image-mode') && document.querySelector('.scriptorium-image-stage img').naturalWidth === 1`, '图片打开');

        // PDF：两页绘制出来，缩略图在“篇章”面板中；旋转第一页后保存回原文件。
        await open('two.pdf');
        await until(`window.ScriptoriumPdfView._state()?.pages.length === 2 && document.querySelectorAll('.scriptorium-pdf-thumb').length === 2`, 'PDF 打开', 20000);
        assert.equal(await page(`return document.querySelector('.outline-header h2').textContent;`), '页面');
        await page(`const view = window.ScriptoriumPdfView; view._do.pick([view._state().pages[0].id]); view._do.rotatePages(1); return true;`);
        await until(`window.ScriptoriumPdfView.doc().dirty`, 'PDF 未保存状态');
        const before = fs.statSync(file('two.pdf')).mtimeMs;
        await pressCtrl('s');
        await untilFile('two.pdf', () => fs.statSync(file('two.pdf')).mtimeMs !== before, 'PDF 保存', 20000);
        const { PDFDocument } = require('../vendor/pdf-lib/pdf-lib.min.js');
        const saved = await PDFDocument.load(fs.readFileSync(file('two.pdf')));
        assert.equal(saved.getPageCount(), 2);
        assert.equal(saved.getPage(0).getRotation().angle, 90);
        assert.equal(saved.getPage(1).getRotation().angle, 0);

        assert.deepEqual(errors, [], '页面没有报错');
        console.log('Scriptorium file views Electron test passed');
        app.exit(0);
    } catch (error) {
        console.error(error);
        if (errors.length) console.error('页面报错：', errors);
        app.exit(1);
    }
});
