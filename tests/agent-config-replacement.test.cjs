const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const AgentConfigManager = require('../modules/utils/agentConfigManager');

test('failed config publication preserves the readable previous version', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-config-replace-'));
    const manager = new AgentConfigManager(dir);
    const { configPath } = manager.getAgentPaths('fixture');
    try {
        await manager.writeAgentConfig('fixture', { version: 1 });
        const rename = t.mock.method(fs, 'rename', async (from, to) => {
            assert.equal(to, configPath);
            assert.deepEqual(await fs.readJson(to), { version: 1 });
            throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
        });
        await assert.rejects(manager.writeAgentConfig('fixture', { version: 2 }), /injected write failure/);
        rename.mock.restore();
        assert.deepEqual(await fs.readJson(configPath), { version: 1 });
        await manager.writeAgentConfig('fixture', { version: 2 });
        assert.deepEqual(await fs.readJson(configPath), { version: 2 });
        assert.deepEqual(await fs.readJson(configPath + '.backup'), { version: 1 });
    } finally { await fs.remove(dir); }
});