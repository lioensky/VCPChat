'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPluginSettingsService } = require('../modules/services/pluginSettingsService');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-plugin-settings-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = path.join(root, 'VCPDistributedServer/Plugin/Fixture');
    await fs.mkdir(dir, { recursive: true });
    const manifest = { name: 'Fixture', pluginType: 'synchronous', entryPoint: { script: 'fixture.js' }, configSchema: { COUNT: { type: 'integer', default: 1 } } };
    await fs.writeFile(path.join(dir, 'plugin-manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(dir, 'config.env'), '# preserved\nCOUNT=2\nTOKEN=private-secret\n');
    let runtime = {};
    const service = createPluginSettingsService({ root, readSettings: () => ({ vcpServerUrl: 'http://localhost:6005/v1/chat/completions' }), getRuntime: () => runtime });
    return { root, dir, service, manifest, setRuntime: value => { runtime = value; } };
}
test('inventory strips config secrets and distinguishes enabled from actual loaded state', async t => {
    const f = await fixture(t);
    let inventory = await f.service.list('local');
    assert.equal(inventory[0].enabled, true); assert.equal(inventory[0].runtime, 'unloaded');
    assert.ok(!JSON.stringify(inventory).includes('private-secret'));
    f.setRuntime({ plugins: new Map([['Fixture', { ...f.manifest, basePath: f.dir, pluginSpecificEnvConfig: { COUNT: '2', TOKEN: 'private-secret' } }]]), connected: true });
    inventory = await f.service.list('local'); assert.equal(inventory[0].runtime, 'loaded');
    const data = await f.service.detail('local', 'Fixture');
    await f.service.save({ category: 'local', id: 'Fixture', revision: data.revision, config: 'COUNT=3' });
    inventory = await f.service.list('local'); assert.equal(inventory[0].runtime, 'restart');
    assert.equal(inventory[0].pendingRestart, true);
});
test('toggle is reversible, stale edits cannot overwrite changes, unrelated keys persist', async t => {
    const { dir, service } = await fixture(t);
    const old = await service.detail('local', 'Fixture');
    await service.toggle({ category: 'local', id: 'Fixture', enabled: false });
    assert.equal((await service.list('local'))[0].enabled, false);
    await assert.rejects(service.save({ category: 'local', id: 'Fixture', revision: old.revision, config: 'COUNT=4' }), /其他窗口/);
    await service.toggle({ category: 'local', id: 'Fixture', enabled: true });
    assert.equal((await service.list('local'))[0].enabled, true);
    assert.equal(await fs.readFile(path.join(dir, 'config.env'), 'utf8'), old.config);
    await assert.rejects(service.detail('local', '../Fixture'), /无效/);
    await assert.rejects(service.toggle({ category: 'backend', id: 'Fixture', enabled: 'true' }), /布尔/);
});
test('JSON-config plugins save the actual plugin-config.json and reject malformed JSON', async t => {
    const { dir, service } = await fixture(t);
    await fs.writeFile(path.join(dir, 'plugin-config.json'), '{"IgnoreApps":["safe"]}');
    const data = await service.detail('local', 'Fixture'); assert.equal(data.configFormat, 'json');
    await assert.rejects(service.save({ category: 'local', id: 'Fixture', revision: data.revision, config: '{broken' }), /有效的 JSON/);
    assert.equal(await fs.readFile(path.join(dir, 'plugin-config.json'), 'utf8'), data.config);
    await service.save({ category: 'local', id: 'Fixture', revision: data.revision, config: '{"IgnoreApps":["changed"]}' });
    assert.ok((await fs.readFile(path.join(dir, 'config.env'), 'utf8')).includes('private-secret'));
    assert.ok((await fs.readFile(path.join(dir, 'plugin-config.json'), 'utf8')).includes('changed'));
});
test('backend auth is session scoped, follows settings origin, distributed rows are read-only', async () => {
    let origin = 'http://localhost:6005/v1/chat/completions';
    const requests = [];
    let enabled = true;
    const service = createPluginSettingsService({ root: '', readSettings: () => ({ vcpServerUrl: origin }), fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/toggle')) { enabled = JSON.parse(options.body).enable; return { ok: true, json: async () => ({}) }; }
        if (url.endsWith('/config')) return { ok: true, json: async () => ({}) };
        return { ok: true, json: async () => [{ name: 'Backend', enabled, manifest: { name: 'Backend', pluginType: 'synchronous' }, configEnvContent: 'API_KEY=backend-secret' }, { name: 'Remote', enabled: true, isDistributed: true, manifest: { name: 'Remote' } }] };
    } });
    await assert.rejects(service.list('backend'), /登录/);
    await service.connect({ username: 'admin', password: 'password' });
    assert.equal(requests[0].url, 'http://localhost:6005/admin_api/plugins'); assert.equal(requests[0].options.redirect, 'error');
    const inventory = await service.list('backend'); assert.ok(!JSON.stringify(inventory).includes('backend-secret'));
    await assert.rejects(service.toggle({ category: 'backend', id: 'Remote', enabled: false }), /其他节点/);
    await service.toggle({ category: 'backend', id: 'Backend', enabled: false }); assert.equal((await service.list('backend'))[0].enabled, false);
    const detail = await service.detail('backend', 'Backend');
    await service.save({ category: 'backend', id: 'Backend', revision: detail.revision, config: 'API_KEY=new' });
    origin = 'http://localhost:6006'; await assert.rejects(service.list('backend'), /当前/);
    assert.ok(!requests.some(r => r.url.includes('6006')));
    await service.connect({ username: 'admin', password: 'password' });
    await assert.rejects(service.save({ category: 'backend', id: 'Backend', revision: detail.revision, config: 'API_KEY=old-server-draft' }), /其他窗口/);
    assert.ok(!requests.some(r => r.url.includes('6006') && r.url.endsWith('/config')));
});

test('reverting a local toggle clears restart state and stale inventory cannot toggle another revision', async t => {
    const { service } = await fixture(t); const old = (await service.list('local'))[0];
    assert.equal((await service.toggle({ category: 'local', id: 'Fixture', enabled: false, revision: old.revision })).requiresRestart, true);
    await assert.rejects(service.toggle({ category: 'local', id: 'Fixture', enabled: true, revision: old.revision }), /其他窗口/);
    assert.equal((await service.toggle({ category: 'local', id: 'Fixture', enabled: true })).requiresRestart, false);
    assert.equal((await service.list('local'))[0].pendingRestart, false);
});

test('empty JSON remains JSON for repair; null manifests cannot crash inventory; Unicode folders work', async t => {
    const { service, dir } = await fixture(t);
    await fs.writeFile(path.join(dir, 'plugin-config.json'), '');
    const detail = await service.detail('local', 'Fixture'); assert.equal(detail.configFormat, 'json'); assert.equal(detail.config, '');
    await service.save({ category: 'local', id: 'Fixture', revision: detail.revision, config: '{}' });
    assert.equal(await fs.readFile(path.join(dir, 'plugin-config.json'), 'utf8'), '{}');
    await fs.writeFile(path.join(dir, 'plugin-manifest.json'), 'null'); assert.match((await service.list('local'))[0].error, /JSON 对象/);
    const unicode = path.join(path.dirname(dir), '中文工具'); await fs.rename(dir, unicode);
    assert.equal((await service.detail('local', '中文工具')).id, '中文工具');
});
