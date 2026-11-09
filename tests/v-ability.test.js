'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { execute, loadAbilities } = require('../VCPDistributedServer/Plugin/VAbility/v-ability');

async function fixture(t, official = [], user = []) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v-ability-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    for (const [file, rules] of [['VCPChatTarven.official.json', official], ['VCPChatTarven.json', user]]) {
        await fs.writeFile(path.join(dir, file), JSON.stringify({ version: 3, rules }));
    }
    return dir;
}
const rule = (id, name, content = '正文 {{TOKEN}}') => ({ id, name, content, enabled: false });
function body(result) {
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'text');
    assert.equal(typeof result[0].text, 'string');
    return result[0].text;
}

test('list merges both stores, includes disabled rules, omits content', async t => {
    const dir = await fixture(t, [rule('a', '官方', 'SECRET')], [rule('b', '用户', 'SECRET')]);
    const result = body(await execute({ command: 'list' }, dir));
    assert.match(result, /官方/); assert.match(result, /用户/);
    assert.doesNotMatch(result, /SECRET/);
    assert.deepEqual(Object.keys((await loadAbilities(dir))[0]).sort(), ['content', 'id', 'name']);
});
test('read exact name preserves raw content and does not write files', async t => {
    const dir = await fixture(t, [rule('a', '能力')]);
    const before = await fs.readFile(path.join(dir, 'VCPChatTarven.official.json'), 'utf8');
    assert.match(body(await execute({ command: 'read', name: '能力' }, dir)), /正文 \{\{TOKEN\}\}/);
    assert.equal(await fs.readFile(path.join(dir, 'VCPChatTarven.official.json'), 'utf8'), before);
    assert.match(body(await execute({ command: 'read', name: '能' }, dir)), /未找到/);
});
test('name takes precedence over conflicting id; missing name never falls back', async t => {
    const dir = await fixture(t, [rule('a', '甲', 'AAA'), rule('b', '乙', 'BBB')]);
    assert.match(body(await execute({ command: 'read', name: '甲', id: 'b' }, dir)), /AAA/);
    assert.match(body(await execute({ command: 'read', name: '不存在', id: 'b' }, dir)), /未找到/);
});
test('duplicate names enumerate ids without content, then resolve by id', async t => {
    const dir = await fixture(t, [rule('a', '重名', 'AAA')], [rule('b', '重名', 'BBB')]);
    const result = body(await execute({ command: 'read', name: '重名' }, dir));
    assert.match(result, /重名/); assert.match(result, /a/); assert.match(result, /b/);
    assert.doesNotMatch(result, /AAA|BBB/);
    assert.match(body(await execute({ command: 'read', id: 'b' }, dir)), /BBB/);
    assert.match(body(await execute({ command: 'read', name: '重名', id: 'a' }, dir)), /AAA/);
});
test('cross-store duplicate ids become source-qualified', async t => {
    const dir = await fixture(t, [rule('x', '重名', 'AAA')], [rule('x', '重名', 'BBB')]);
    assert.deepEqual((await loadAbilities(dir)).map(a => a.id), ['official:x', 'user:x']);
    assert.match(body(await execute({ command: 'read', id: 'user:x' }, dir)), /BBB/);
});
test('missing files are empty and never created; malformed file fails visibly', async t => {
    const dir = await fixture(t);
    await fs.unlink(path.join(dir, 'VCPChatTarven.json'));
    assert.match(body(await execute({ command: 'list' }, dir)), /共 0 项/);
    await assert.rejects(fs.stat(path.join(dir, 'VCPChatTarven.json')), { code: 'ENOENT' });
    await fs.writeFile(path.join(dir, 'VCPChatTarven.official.json'), '{broken');
    assert.match(body(await execute({ command: 'list' }, dir)), /读取失败/);
});
test('invalid rules and duplicate ids in same store fail closed', async t => {
    for (const rules of [[{ id: 'x', name: '坏' }], [rule('x', '甲'), rule('x', '乙')]]) {
        const dir = await fixture(t, rules);
        assert.match(body(await execute({ command: 'list' }, dir)), /读取失败/);
    }
});
test('invalid parameters return text errors', async t => {
    const dir = await fixture(t);
    for (const args of [null, [], {}, { command: 'delete' }, { command: 'read' }, { command: 'read', name: 2 }]) {
        assert.match(body(await execute(args, dir)), /读取失败/);
    }
});
test('metadata escaped while content is unchanged', async t => {
    const dir = await fixture(t, [rule('x', '<script>\n*name*', '**raw**')]);
    const result = body(await execute({ command: 'read', id: 'x' }, dir));
    assert.ok(result.includes('\\<script\\>'));
    assert.ok(result.endsWith('**raw**'));
});
test('real CLI emits one standard text array for list and invalid JSON', () => {
    const script = path.join(__dirname, '../VCPDistributedServer/Plugin/VAbility/v-ability.js');
    for (const input of ['{"command":"list"}', '{broken']) {
        const run = spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 5000 });
        assert.equal(run.status, 0); assert.equal(run.stderr, '');
        const payload = JSON.parse(run.stdout);
        if (input === '{broken') {
            assert.equal(payload.status, 'error');
            assert.equal(typeof payload.error, 'string');
        } else {
            assert.equal(payload.status, 'success');
            assert.match(body(payload.result.content), /^## /);
        }
    }
});
test('shorthand get/name/id infer read and trim selectors', async t => {
    const dir = await fixture(t, [rule('a', '甲', 'AAA')]);
    for (const args of [{ get: ' 甲 ' }, { get: 'a' }, { name: '甲' }, { id: 'a' }, { command: 'read', get: '甲' }]) {
        assert.ok(body(await execute(args, dir)).endsWith('AAA'));
    }
});
test('get prefers exact name over id and preserves duplicate-name disambiguation', async t => {
    const dir = await fixture(t, [rule('a', '甲', 'AAA'), rule('b', 'a', 'BBB'), rule('c', '重名', 'CCC')], [rule('d', '重名', 'DDD')]);
    assert.ok(body(await execute({ get: 'a' }, dir)).endsWith('BBB'));
    const duplicate = body(await execute({ get: '重名' }, dir));
    assert.match(duplicate, /请指定 id/);
    assert.doesNotMatch(duplicate, /CCC|DDD/);
    assert.ok(body(await execute({ id: 'd' }, dir)).endsWith('DDD'));
    assert.match(body(await execute({ get: '缺失' }, dir)), /未找到/);
});
test('shorthand rejects invalid and conflicting selectors and explicit unknown commands', async t => {
    const dir = await fixture(t);
    for (const args of [
        { get: '' }, { get: 2 }, { get: null }, { name: '' }, { id: false },
        { get: 'a', name: '甲' }, { get: 'a', id: 'a' },
        { command: 'delete', get: 'a' }, { command: 2, get: 'a' }
    ]) {
        assert.match(body(await execute(args, dir)), /读取失败/);
    }
});
test('shorthand CLI retains stdio envelope and text array', () => {
    const script = path.join(__dirname, '../VCPDistributedServer/Plugin/VAbility/v-ability.js');
    const run = spawnSync(process.execPath, [script], {
        input: JSON.stringify({ get: '__vability_missing_test__' }), encoding: 'utf8', timeout: 5000
    });
    assert.equal(run.status, 0);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.status, 'success');
    assert.match(body(payload.result.content), /未找到/);
});