import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolActivityTracker, describeActivity } from '../DeskPetmodules/toolActivity.js';

const REQUEST = (fields) => `<<<[TOOL_REQUEST]>>>\n${Object.entries(fields).map(([k, v]) => `${k}:「始」${v}「末」`).join(',\n')}\n<<<[END_TOOL_REQUEST]>>>`;
const RESULT = (tool, status) => `[[VCP调用结果信息汇总:\n- 工具名称: ${tool}\n- 执行状态: ${status}\n- 返回内容: ...\nVCP调用结果结束]]`;

function feed(tracker, text, size) {
    for (let i = 0; i < text.length; i += size) tracker.push(text.slice(i, i + size));
}

test('a search call reads as "searching · query" while running and gets its result status', () => {
    const tracker = createToolActivityTracker();
    const reply = `我查一下。${REQUEST({ tool_name: 'TavilySearch', query: '明天上海天气' })}`;
    feed(tracker, reply, 7);
    assert.equal(tracker.activities.length, 1);
    assert.deepEqual(describeActivity(tracker.latest), { icon: '🔍', text: '正在搜索 · 明天上海天气', status: 'running', kind: 'search' });
    feed(tracker, `\n${RESULT('TavilySearch', '✅ SUCCESS')}\n查到了：晴。`, 5);
    assert.equal(tracker.latest.status, 'success');
    assert.equal(describeActivity(tracker.latest).text, '搜完了 · 明天上海天气');
});

test('markers split across chunks, several calls and a failure are all picked up', () => {
    const tracker = createToolActivityTracker();
    const reply = [
        REQUEST({ tool_name: 'FileOperator', command: 'ReadFile', filePath: 'C:/notes/todo.md' }),
        RESULT('FileOperator', 'success'),
        REQUEST({ tool_name: 'PowerShellExecutor', command: 'ExecutePowerShell', powershell: 'Get-Date' }),
        RESULT('PowerShellExecutor', '❌ ERROR'),
    ].join('\n');
    feed(tracker, reply, 3);
    assert.equal(tracker.activities.length, 2);
    assert.equal(describeActivity(tracker.activities[0]).text, '看完了 · C:/notes/todo.md');
    assert.equal(tracker.activities[1].status, 'failed');
    assert.equal(describeActivity(tracker.activities[1]).text, 'PowerShellExecutor 没成功 · Get-Date');
});

test('the card shows up as soon as the tool name is written, before the request block closes', () => {
    const tracker = createToolActivityTracker();
    assert.equal(tracker.push('<<<[TOOL_REQUEST]>>>\ntool_name:「始」VCPAlarm「末」,\ntime_description:「始」10分'), true);
    assert.equal(describeActivity(tracker.latest).text, '正在设闹钟 · 10分');
    tracker.push('钟后「末」\n<<<[END_TOOL_REQUEST]>>>');
    assert.equal(describeActivity(tracker.latest).text, '正在设闹钟 · 10分钟后');
});

test('unknown tools fall back to their own name; a reply that ends without a result counts as done', () => {
    const tracker = createToolActivityTracker();
    tracker.push(REQUEST({ tool_name: 'SomeCustomTool', foo: 'bar' }));
    assert.equal(describeActivity(tracker.latest).text, '正在调用 SomeCustomTool');
    assert.equal(tracker.finish(), true);
    assert.equal(describeActivity(tracker.latest).text, 'SomeCustomTool 调用完了');
});

test('ordinary text, however long, creates no activities', () => {
    const tracker = createToolActivityTracker();
    for (let i = 0; i < 2000; i++) assert.equal(tracker.push('普通的回复文字，没有工具调用。'), false);
    assert.equal(tracker.activities.length, 0);
    assert.equal(tracker.latest, null);
});

test('a long write request is read from its head and does not slow down as it streams', () => {
    const tracker = createToolActivityTracker();
    const content = 'const x = 1; // 一些代码\n'.repeat(8000);
    const reply = `我写一下。${REQUEST({ tool_name: 'FileOperator', command: 'WriteFile', filePath: 'src/a.js', content })}\n写好了。`;
    const started = performance.now();
    feed(tracker, reply, 8);
    // 二十万字逐段解析：按开头读参数，不会每来一段都把整段请求重新扫一遍
    assert.ok(performance.now() - started < 1500, `took ${Math.round(performance.now() - started)} ms`);
    assert.equal(tracker.activities.length, 1);
    assert.deepEqual(describeActivity(tracker.latest), { icon: '✏️', text: '正在修改 · src/a.js', status: 'running', kind: 'edit' });
    feed(tracker, RESULT('FileOperator', 'success'), 9);
    assert.equal(tracker.latest.status, 'success');
});
