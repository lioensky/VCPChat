'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../modules/ipc/projectForgeHandlers.js'), 'utf8');

function fixture({ cancel = false, writeError = false, exportError = false } = {}) {
    const handlers = new Map(), writes = [], exported = [], dialogs = [];
    const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
    const owner = {};
    const context = {
        __dirname: path.join(__dirname, '../modules/ipc'), console, module: { exports: {} },
        require(name) {
            if (name === 'electron') return {
                ipcMain, BrowserWindow: { fromWebContents: () => owner },
                dialog: { async showSaveDialog(...args) { dialogs.push(args); return { canceled: cancel, filePath: 'chosen.md' }; } },
            };
            if (name === 'path') return path;
            if (name === 'fs') return {
                existsSync: () => false,
                promises: { async writeFile(...args) { if (writeError) throw new Error('磁盘只读'); writes.push(args); } },
            };
            if (name.endsWith('ProjectForgeService.js')) return {
                ensureRuntime() {}, gui: { exportReport(id) {
                    if (exportError) throw new Error('工程不存在');
                    exported.push(id);
                    return { filename: '工程履历.md', markdown: '# 完整报告' };
                } },
            };
            throw new Error(`Unexpected require: ${name}`);
        },
    };
    vm.runInNewContext(source, context);
    context.module.exports.initialize();
    return { writes, exported, dialogs, run: () => handlers.get('project-forge:export-report')({ sender: {} }, 'p1') };
}
test('导出只按主进程生成内容写UTF8，用户对话框决定保存位置', async () => {
    const f = fixture();
    const result = await f.run();
    assert.equal(result.success, true);
    assert.equal(result.data.filePath, 'chosen.md');
    assert.deepEqual(f.exported, ['p1']);
    assert.deepEqual(f.writes, [['chosen.md', '# 完整报告', 'utf8']]);
    assert.equal(f.dialogs[0][1].defaultPath, '工程履历.md');
});
test('取消不写入；生成失败和磁盘失败正常回传', async () => {
    const canceled = fixture({ cancel: true });
    assert.equal((await canceled.run()).data.canceled, true);
    assert.equal(canceled.writes.length, 0);
    for (const options of [{ writeError: true }, { exportError: true }]) {
        const f = fixture(options);
        assert.equal((await f.run()).success, false);
        assert.equal(f.writes.length, 0);
        if (options.exportError) assert.equal(f.dialogs.length, 0);
    }
});