'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { review } = require('../VCPDistributedServer/Plugin/ProjectForge/validationWorker.cjs');
const worker = path.resolve(__dirname, '../VCPDistributedServer/Plugin/ProjectForge/validationWorker.cjs');
function request(filePath, before, after) {
    const hash = text => crypto.createHash('sha256').update(text).digest('hex');
    return { protocolVersion: 1, filePath, before, after, beforeHash: hash(before), afterHash: hash(after) };
}
test('validation worker is bound to exact text and distinguishes unsupported', async () => {
    const input = request('a.json', '{"x":1}', '{"x":');
    const result = await review(input);
    assert.equal(result.state, 'completed');
    assert.equal(result.afterHash, input.afterHash);
    assert.ok(result.introduced.some(d => d.fatal));
    assert.equal((await review(request('a.txt', 'a', 'b'))).state, 'unsupported');
    await assert.rejects(review({ ...input, after: '{}' }), /hash mismatch/);
    await assert.rejects(review(request('a.json', '{}\r\n', '{}')), /normalized/);
});
test('one-shot child protocol reports invalid input as failure, not empty diagnostics', () => {
    const good = spawnSync(process.execPath, [worker], {
        input: JSON.stringify(request('a.json', '{}', '{"a":2}')),
        encoding: 'utf8', timeout: 10000, maxBuffer: 3 * 1024 * 1024,
    });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).result.state, 'completed');
    const bad = spawnSync(process.execPath, [worker], {
        input: '{invalid', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).error.code, 'VALIDATION_FAILED');
});
test('real ESLint validates a supported JS path instead of silently skipping it', () => {
    const run = spawnSync(process.execPath, [worker], {
        input: JSON.stringify(request('native-validation-fixture.cjs',
            'module.exports = 1;\n', 'module.exports = ;\n')),
        encoding: 'utf8', timeout: 10000, maxBuffer: 3 * 1024 * 1024,
        cwd: path.resolve(__dirname, '..'),
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const response = JSON.parse(run.stdout);
    assert.equal(response.result.state, 'completed');
    assert.ok(response.result.introduced.some(d => d.fatal));
});