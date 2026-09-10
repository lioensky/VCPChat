import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AgentConfigManager = require('../modules/utils/agentConfigManager.js');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-agent-config-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const manager = new AgentConfigManager(root);
    await manager.writeAgentConfig('a', {
        name: 'A',
        originalSystemPrompt: 'original',
        topics: [{ id: 'keep-topic' }],
    });
    return { manager, ...manager.getAgentPaths('a') };
}

test('update fresh-reads an externally restored config with an older timestamp', async t => {
    const { manager, configPath } = await fixture(t);
    await manager.readAgentConfig('a');
    await fs.writeFile(configPath, JSON.stringify({
        name: 'restored',
        originalSystemPrompt: 'recovered prompt',
        topics: [{ id: 'restored-topic' }],
    }));
    const oldTime = new Date('2000-01-01T00:00:00Z');
    await fs.utimes(configPath, oldTime, oldTime);
    await manager.updateAgentConfig('a', { temperature: 0.4 });
    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.originalSystemPrompt, 'recovered prompt');
    assert.deepEqual(saved.topics, [{ id: 'restored-topic' }]);
    assert.equal(saved.temperature, 0.4);
});

test('stale CAS rejects without modifying the current config', async t => {
    const { manager, configPath } = await fixture(t);
    const revision = manager.getRevision(await manager.readAgentConfig('a'));
    await manager.updateAgentConfig('a', { name: 'external' });
    const before = await fs.readFile(configPath);
    await assert.rejects(
        manager.updateAgentConfig('a', { name: 'stale' }, {
            expectedRevision: revision, operationId: 'stale-operation',
        }),
        error => error.code === 'AGENT_CONFIG_CONFLICT'
            && error.operationId === 'stale-operation',
    );
    assert.deepEqual(await fs.readFile(configPath), before);
});

test('lock timeout preserves another writer lock and release checks ownership', async t => {
    const { manager, lockFile } = await fixture(t);
    await fs.writeFile(lockFile, 'other-writer-token');
    await assert.rejects(manager.acquireLock('a', 0), {
        code: 'AGENT_CONFIG_LOCK_BUSY',
    });
    await manager.releaseLock('a', 'wrong-token');
    assert.equal(await fs.readFile(lockFile, 'utf8'), 'other-writer-token');
    await manager.releaseLock('a', 'other-writer-token');
    await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
});

test('successive saves retain exact earlier recovery points', async t => {
    const { manager, configPath } = await fixture(t);
    const original = await fs.readFile(configPath, 'utf8');
    await manager.updateAgentConfig('a', { name: 'second' });
    const second = await fs.readFile(configPath, 'utf8');
    await manager.updateAgentConfig('a', { name: 'third' });
    await manager.updateAgentConfig('a', { name: 'fourth' });
    const directory = `${configPath}.versions`;
    const snapshots = await Promise.all(
        (await fs.readdir(directory)).map(file => fs.readFile(path.join(directory, file), 'utf8')),
    );
    assert.ok(snapshots.includes(original));
    assert.ok(snapshots.includes(second));
});

test('corrupt disk config is never replaced using the cache or backup', async t => {
    const { manager, configPath } = await fixture(t);
    await manager.updateAgentConfig('a', { name: 'cached' });
    const damaged = '{ broken configuration';
    await fs.writeFile(configPath, damaged);
    await assert.rejects(manager.updateAgentConfig('a', { name: 'unsafe' }), {
        code: 'AGENT_CONFIG_READ_FAILED',
    });
    assert.equal(await fs.readFile(configPath, 'utf8'), damaged);
});

test('revision acknowledgement matches the serialized disk object', async t => {
    const { manager, configPath } = await fixture(t);
    const result = await manager.updateAgentConfig('a', {
        advancedSystemPrompt: { blocks: [{ content: 'text', variants: undefined }] },
    });
    const disk = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(result.currentRevision, manager.getRevision(disk));
    assert.deepEqual(result.config, disk);
    assert.deepEqual(disk.topics, [{ id: 'keep-topic' }]);
});