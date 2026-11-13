'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('DeepMemo loads HTML dependencies only for HTML conversion', () => {
    const script = `
        const assert = require('node:assert/strict');
        const memo = require('./VCPDistributedServer/Plugin/DeepMemo/DeepMemoService');
        const ids = ['cheerio', 'turndown'].map(id => require.resolve(id));
        const assertCold = () => ids.forEach(id => assert.equal(require.cache[id], undefined));
        assertCold();
        memo.initialize({});
        assertCold();
        assert.equal(memo._test.cleanMemoryOutput('  plain text  '), 'plain text');
        assert.equal(memo._test.cleanMemoryOutput(''), '');
        assertCold();
        assert.equal(memo._test.cleanMemoryOutput('<p>Hello <strong>world</strong></p><script>bad()</script>'),
            'Hello **world**');
        ids.forEach(id => assert.ok(require.cache[id]));
        assert.equal(memo._test.cleanMemoryOutput('<p>Again</p>'), 'Again');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000,
        maxBuffer: 1024 * 1024
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
});