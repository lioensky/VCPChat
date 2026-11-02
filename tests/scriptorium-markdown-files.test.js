'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const fs = require('fs-extra');
const iconv = require('iconv-lite');
const JSZip = require('jszip');
const markdownFiles = require('../modules/scriptorium/markdownFiles');

async function workspace(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scriptorium-md-'));
    t.after(() => fs.remove(dir));
    return dir;
}

// 页面保存时发送的是整份工程；这里在读到的工程里换掉正文，模拟一次编辑。
async function edited(bytes, change) {
    const zip = await JSZip.loadAsync(Buffer.from(bytes));
    const source = await zip.file('source/document.md').async('string');
    zip.file('source/document.md', change(source));
    return zip.generateAsync({ type: 'uint8array' });
}

const deps = (dir) => ({ dataDir: () => path.join(dir, 'AppData') });

test('opening keeps the file where it is and packs a project with the upstream default style', async (t) => {
    const dir = await workspace(t);
    const file = path.join(dir, '说明.md');
    await fs.writeFile(file, '# 标题\n\n正文。\n');
    const result = await markdownFiles.read(file, deps(dir));
    assert.equal(result.kind, 'vdocx');
    assert.equal(result.filePath, file);
    assert.equal(result.markdownFile, true);
    const zip = await JSZip.loadAsync(Buffer.from(result.bytes));
    const model = JSON.parse(await zip.file('manifest.json').async('string'));
    assert.equal(model.manifest.generator, 'VCP Scriptorium');
    assert.deepEqual(model.manifest.markdownFile.dir, dir);
    assert.equal(await zip.file('source/document.md').async('string'), '# 标题\n\n正文。\n');
    const css = await zip.file('source/document.css').async('string');
    assert.ok(css.includes('--vdoc-ink'), 'the default style comes from vdoc-core.js');
    assert.equal(css, markdownFiles.documentCss());
});

test('saving writes back the original encoding, line endings and BOM', async (t) => {
    const dir = await workspace(t);
    const cases = [
        { name: 'gbk.md', bytes: iconv.encode('# 中文\r\n\r\n第一行\r\n', 'gb18030') },
        { name: 'utf16.md', bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('# 标题\n正文\n', 'utf-16le')]) },
        { name: 'bom-cr.md', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\r正文\r', 'utf8')]) },
    ];
    for (const item of cases) {
        const file = path.join(dir, item.name);
        await fs.writeFile(file, item.bytes);
        const opened = await markdownFiles.read(file, deps(dir));
        // 不改正文保存：字节与原文件完全相同。
        await markdownFiles.save(null, { filePath: file, bytes: opened.bytes }, deps(dir));
        assert.deepEqual(await fs.readFile(file), item.bytes, `${item.name} unchanged`);
        // 改一行再保存：编码、换行和 BOM 照旧。
        const reopened = await markdownFiles.read(file, deps(dir));
        await markdownFiles.save(null, { filePath: file, bytes: await edited(reopened.bytes, (text) => `${text}追加\n`) }, deps(dir));
        const decoded = markdownFiles.decode(await fs.readFile(file));
        const original = markdownFiles.decode(item.bytes);
        assert.equal(decoded.encoding, original.encoding, `${item.name} encoding`);
        assert.equal(decoded.bom, original.bom, `${item.name} BOM`);
        assert.equal(decoded.lineEnding, original.lineEnding, `${item.name} line ending`);
        assert.ok(decoded.text.endsWith('追加\n'), `${item.name} edit saved`);
    }
});

test('a file changed on disk after opening is not overwritten', async (t) => {
    const dir = await workspace(t);
    const file = path.join(dir, '共享.md');
    await fs.writeFile(file, '原文\n');
    const sender = { id: 101, once() {}, isDestroyed: () => false, send() {} };
    const opened = await markdownFiles.read(file, { ...deps(dir), sender });
    await fs.writeFile(file, '别处改过\n');
    await assert.rejects(
        markdownFiles.save({ sender }, { filePath: file, bytes: await edited(opened.bytes, () => '我的修改\n') }, deps(dir)),
        /被别处修改过/
    );
    assert.equal(await fs.readFile(file, 'utf8'), '别处改过\n');
});

test('normalizeDocument keeps manifest.markdownFile and adds nothing to other projects', () => {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    require('node:vm').createContext(sandbox);
    require('node:vm').runInContext(fs.readFileSync(path.join(__dirname, '..', 'ScriptoriumModules', 'vdoc-core.js'), 'utf8'), sandbox);
    const core = sandbox.VDocCore;
    const plain = core.normalizeDocument(core.createDocument());
    assert.equal('markdownFile' in plain.manifest, false);
    const fromFile = core.createDocument();
    fromFile.manifest.markdownFile = { encoding: 'gb18030', lineEnding: 'crlf', bom: false, dir: 'D:/docs', root: 'D:/docs' };
    assert.deepEqual(JSON.parse(JSON.stringify(core.normalizeDocument(fromFile).manifest.markdownFile)), fromFile.manifest.markdownFile);
});

test('lineage checkpoints are kept beside the AppData folder, not next to the file', async (t) => {
    const dir = await workspace(t);
    const file = path.join(dir, '历史.md');
    await fs.writeFile(file, '一\n');
    const opened = await markdownFiles.read(file, deps(dir));
    const zip = await JSZip.loadAsync(Buffer.from(opened.bytes));
    zip.file('lineage/checkpoints.json', JSON.stringify([{ id: 'c1', createdAt: 1, label: '保存点' }]));
    await markdownFiles.save(null, { filePath: file, bytes: await zip.generateAsync({ type: 'uint8array' }) }, deps(dir));
    assert.deepEqual(await fs.readdir(dir).then((names) => names.filter((name) => name !== 'AppData')), ['历史.md']);
    const reopened = await markdownFiles.read(file, deps(dir));
    const lineage = JSON.parse(await (await JSZip.loadAsync(Buffer.from(reopened.bytes))).file('lineage/checkpoints.json').async('string'));
    assert.equal(lineage[0].id, 'c1');
});
