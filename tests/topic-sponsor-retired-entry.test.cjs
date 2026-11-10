'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const entry = path.join(root, 'VCPDistributedServer/Plugin/TopicSponsor/topicsponsor.js');

test('retired stdio entry rejects execution and require without invoking historical implementation', () => {
    const executed = spawnSync(process.execPath, [entry], {
        input: JSON.stringify({ command: 'ReplyToTopic', message: 'must not write' }),
        encoding: 'utf8', timeout: 3000,
    });
    assert.ifError(executed.error);
    assert.equal(executed.status, 1);
    assert.equal(executed.stdout, '');
    assert.equal(JSON.parse(executed.stderr.trim()).code, 'TOPIC_SPONSOR_STDIO_RETIRED');
    assert.throws(() => require(entry), error => error.code === 'TOPIC_SPONSOR_STDIO_RETIRED');
    const source = fs.readFileSync(entry, 'utf8');
    assert.doesNotMatch(source, /require\(['"](?:node:)?fs['"]\)|readStdin|handleReplyToTopic/);
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'plugin-manifest.json'), 'utf8'));
    assert.equal(manifest.entryPoint.script, 'topicsponsor-service.js');
    assert.equal(manifest.communication.protocol, 'direct');
    assert.ok(fs.existsSync(path.join(root, 'docs/archive/topicsponsor-legacy.js.txt')));
});