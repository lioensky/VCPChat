'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const SettingsManager = require('../modules/utils/appSettingsManager');

async function sandbox(t) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'settings-atomic-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'settings.json');
    return { dir, file, backup: `${file}.backup` };
}
const order = [{ id: 'a', type: 'agent' }];
const setOrder = settings => ({ ...settings, combinedItemOrder: order });
const leftovers = async dir => (await fsp.readdir(dir)).filter(name => name.endsWith('.tmp'));

test('主配置缺失但备份存在：更新基于备份，绝不回写默认值', async t => {
    const s = await sandbox(t);
    await fsp.writeFile(s.backup, JSON.stringify({ userName: '莱恩', vcpServerUrl: 'http://keep', combinedItemOrder: [] }));
    const manager = new SettingsManager(s.file);
    assert.equal((await manager.readSettings()).userName, '莱恩');
    const result = await manager.updateSettings(setOrder);
    assert.equal(result.success, true);
    const saved = JSON.parse(await fsp.readFile(s.file, 'utf8'));
    assert.equal(saved.userName, '莱恩');
    assert.equal(saved.vcpServerUrl, 'http://keep');
    assert.deepEqual(saved.combinedItemOrder, order);
});

test('主配置缺失且备份损坏：拒绝基于默认值写入', async t => {
    const s = await sandbox(t);
    await fsp.writeFile(s.backup, '{broken');
    const manager = new SettingsManager(s.file);
    await assert.rejects(manager.updateSettings(setOrder), { code: 'SETTINGS_MISSING' });
    await assert.rejects(fsp.access(s.file), { code: 'ENOENT' });
    assert.equal(await fsp.readFile(s.backup, 'utf8'), '{broken');
});

test('首次运行两者都不存在：允许初始化', async t => {
    const s = await sandbox(t);
    const result = await new SettingsManager(s.file).updateSettings(setOrder);
    assert.equal(result.success, true);
    assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).userName, '用户');
});

test('主配置损坏：从备份恢复写入，且坏内容不覆盖有效备份', async t => {
    const s = await sandbox(t);
    const good = JSON.stringify({ userName: '莱恩', combinedItemOrder: [{ id: 'old', type: 'agent' }] });
    await fsp.writeFile(s.file, '{broken');
    await fsp.writeFile(s.backup, good);
    const result = await new SettingsManager(s.file).updateSettings(setOrder);
    assert.equal(result.success, true);
    assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).userName, '莱恩');
    assert.equal(await fsp.readFile(s.backup, 'utf8'), good);
});

test('备份为写入前的完整原字节', async t => {
    const s = await sandbox(t);
    const original = JSON.stringify({ userName: '莱恩', marker: 'v1' }, null, 2);
    await fsp.writeFile(s.file, original);
    await new SettingsManager(s.file).updateSettings(setOrder);
    assert.equal(await fsp.readFile(s.backup, 'utf8'), original);
    const saved = JSON.parse(await fsp.readFile(s.file, 'utf8'));
    assert.equal(saved.marker, 'v1');
    assert.deepEqual(saved.combinedItemOrder, order);
});

test('替换主配置的改名失败：原文件字节不变，临时文件已清理', async t => {
    const s = await sandbox(t);
    const original = JSON.stringify({ userName: '莱恩', marker: 'keep' });
    await fsp.writeFile(s.file, original);
    const rename = fsp.rename;
    fsp.rename = async (from, to) => {
        if (path.resolve(to) === path.resolve(s.file)) throw Object.assign(new Error('injected'), { code: 'EIO' });
        return rename(from, to);
    };
    try {
        await assert.rejects(new SettingsManager(s.file).updateSettings(setOrder), { code: 'EIO' });
    } finally { fsp.rename = rename; }
    assert.equal(await fsp.readFile(s.file, 'utf8'), original);
    assert.deepEqual(await leftovers(s.dir), []);
});

test('短暂占用（EBUSY）退避重试后成功', async t => {
    const s = await sandbox(t);
    await fsp.writeFile(s.file, JSON.stringify({ userName: '莱恩' }));
    const rename = fsp.rename;
    let failures = 2;
    fsp.rename = async (from, to) => {
        if (path.resolve(to) === path.resolve(s.file) && failures-- > 0) {
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        return rename(from, to);
    };
    try {
        assert.equal((await new SettingsManager(s.file).updateSettings(setOrder)).success, true);
    } finally { fsp.rename = rename; }
    assert.equal(failures, -1);
    assert.deepEqual(JSON.parse(await fsp.readFile(s.file, 'utf8')).combinedItemOrder, order);
    assert.deepEqual(await leftovers(s.dir), []);
});

test('拖拽排序与普通设置并发更新：两边修改都保留', async t => {
    const s = await sandbox(t);
    await fsp.writeFile(s.file, JSON.stringify({ userName: '莱恩' }));
    const manager = new SettingsManager(s.file);
    await Promise.all([
        manager.updateSettings(setOrder),
        manager.updateSettings(settings => ({ ...settings, sidebarWidth: 333 })),
    ]);
    const saved = JSON.parse(await fsp.readFile(s.file, 'utf8'));
    assert.deepEqual(saved.combinedItemOrder, order);
    assert.equal(saved.sidebarWidth, 333);
    assert.equal(saved.userName, '莱恩');
});