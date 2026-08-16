'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'ScriptoriumModules', 'scriptorium-pr-diff.js'),
    'utf8'
);
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, {
    filename: 'scriptorium-pr-diff.js',
});

const { applyReplacements } = sandbox.window.ScriptoriumPrDiff;

const thousandLines = Array.from(
    { length: 1000 },
    (_value, index) => `第 ${index + 1} 行`
).join('\n');
const appended = applyReplacements(thousandLines, [{
    insert: '第 1004 行续写',
    line: 1004,
}]);
assert.strictEqual(appended.success, true);
const appendedLines = appended.source.split('\n');
assert.strictEqual(appendedLines.length, 1004);
assert.strictEqual(appendedLines[999], '第 1000 行');
assert.strictEqual(appendedLines[1000], '');
assert.strictEqual(appendedLines[1001], '');
assert.strictEqual(appendedLines[1002], '');
assert.strictEqual(appendedLines[1003], '第 1004 行续写');
assert.strictEqual(appended.applied[0].type, 'insert');
assert.strictEqual(appended.applied[0].line, 1004);

const insertedBefore = applyReplacements('第一行\n第二行\n第三行', [{
    insert: '新第二行',
    line: 2,
}]);
assert.strictEqual(
    insertedBefore.source,
    '第一行\n新第二行\n第二行\n第三行'
);

const multiline = applyReplacements('第一行', [{
    insert: '第二行\n第三行',
    line: 2,
}]);
assert.strictEqual(multiline.source, '第一行\n第二行\n第三行');

const invalidZero = applyReplacements('正文', [{
    insert: '无效',
    line: 0,
}]);
assert.strictEqual(invalidZero.success, false);
assert.strictEqual(invalidZero.code, 'INVALID_INSERT_LINE');
assert.strictEqual(invalidZero.source, '正文');

const invalidFraction = applyReplacements('正文', [{
    insert: '无效',
    line: 1.5,
}]);
assert.strictEqual(invalidFraction.success, false);
assert.strictEqual(invalidFraction.code, 'INVALID_INSERT_LINE');

const replaced = applyReplacements('旧标题\n正文', [{
    target: '旧标题',
    replace: '新标题',
    startLine: 1,
}]);
assert.strictEqual(replaced.success, true);
assert.strictEqual(replaced.source, '新标题\n正文');

console.log('Scriptorium PR diff tests passed');