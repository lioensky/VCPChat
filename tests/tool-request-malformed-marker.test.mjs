import test from 'node:test';
import assert from 'node:assert/strict';
import {
    findMalformedToolFields,
    describeToolRequestMarkerProblem,
} from '../modules/renderer/toolRequestMarkers.js';

const S = '「' + '始」';
const E = '「' + '末」';
const S_ESC = '「' + '始ESCAPE」';
const E_ESC = '「' + '末ESCAPE」';
const BAD_S = '「' + '始»';
const BAD_E = '«' + '末」';

test('detects malformed tool_name marker and describes error', () => {
    const content = [
        `maid:${S}Nova${E},`,
        `tool_name:${BAD_S}ProjectForge${BAD_E},`,
        `command:${S}ReadCode${E}`
    ].join('\n');

    const malformed = findMalformedToolFields(content);
    assert.deepEqual(malformed, ['tool_name']);

    const problem = describeToolRequestMarkerProblem({
        toolName: '',
        malformedFields: malformed,
    });

    assert.equal(problem.isMalformed, true);
    assert.equal(problem.displayName, '格式错误');
    assert.ok(problem.hint.includes('未识别 tool_name，服务器不会执行这次调用'));
    assert.ok(problem.hint.includes('tool_name'));
});

test('detects malformed command marker when tool_name is valid', () => {
    const content = [
        `maid:${S}Nova${E},`,
        `tool_name:${S}ProjectForge${E},`,
        `command:${BAD_S}ReadCode${BAD_E},`,
        `path:${S}modules/test.js${E}`
    ].join('\n');

    const malformed = findMalformedToolFields(content);
    assert.deepEqual(malformed, ['command']);

    const problem = describeToolRequestMarkerProblem({
        toolName: 'ProjectForge',
        malformedFields: malformed,
    });

    assert.equal(problem.isMalformed, true);
    assert.equal(problem.displayName, 'ProjectForge');
    assert.ok(problem.hint.includes('以下字段标记写法有误，服务器会忽略：command'));
    assert.ok(!problem.hint.includes('未识别 tool_name'));
});

test('returns no malformed fields and not malformed for completely normal syntax', () => {
    const content = [
        `maid:${S}Nova${E},`,
        `tool_name:${S}ProjectForge${E},`,
        `command:${S}ReadCode${E},`,
        `path:${S}modules/test.js${E}`
    ].join('\n');

    const malformed = findMalformedToolFields(content);
    assert.deepEqual(malformed, []);

    const problem = describeToolRequestMarkerProblem({
        toolName: 'ProjectForge',
        malformedFields: malformed,
    });

    assert.equal(problem.isMalformed, false);
    assert.equal(problem.displayName, 'ProjectForge');
    assert.equal(problem.hint, '');
});

test('handles missing tool_name even when no markers are malformed', () => {
    const content = [
        `maid:${S}Nova${E},`,
        `command:${S}ReadCode${E}`
    ].join('\n');

    const malformed = findMalformedToolFields(content);
    assert.deepEqual(malformed, []);

    const problem = describeToolRequestMarkerProblem({
        toolName: '',
        malformedFields: malformed,
    });

    assert.equal(problem.isMalformed, true);
    assert.equal(problem.displayName, '格式错误');
    assert.equal(problem.hint, '未识别 tool_name，服务器不会执行这次调用');
});

test('does not falsely flag malformed syntax inside regular bracket value section', () => {
    const content = [
        `maid:${S}Nova${E},`,
        `tool_name:${S}ProjectForge${E},`,
        `command:${S}EditCode${E},`,
        `replace:${S}const sample = "command:${BAD_S}test${BAD_E}";${E}`
    ].join('\n');

    const malformed = findMalformedToolFields(content);
    assert.deepEqual(malformed, []);

    const problem = describeToolRequestMarkerProblem({
        toolName: 'ProjectForge',
        malformedFields: malformed,
    });

    assert.equal(problem.isMalformed, false);
    assert.equal(problem.displayName, 'ProjectForge');
    assert.equal(problem.hint, '');
});

test('does not falsely flag malformed syntax inside ESCAPE value section', () => {
    const content = [
        `maid:${S}Nova${E},`,
        `tool_name:${S}ProjectForge${E},`,
        `command:${S}CreateFile${E},`,
        `content:${S_ESC}Here is demo: tool_name:${BAD_S}Bad${BAD_E}, command:${BAD_S}Run${BAD_E}${E_ESC}`
    ].join('\n');

    const malformed = findMalformedToolFields(content);
    assert.deepEqual(malformed, []);

    const problem = describeToolRequestMarkerProblem({
        toolName: 'ProjectForge',
        malformedFields: malformed,
    });

    assert.equal(problem.isMalformed, false);
    assert.equal(problem.displayName, 'ProjectForge');
    assert.equal(problem.hint, '');
});