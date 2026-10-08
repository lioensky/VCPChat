const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    noteToolApprovalMessage, isWaitingForToolApproval, clearToolApprovals,
    isWatchdogAbort, withWatchdogNote, MAX_HOLD_MS
} = require('../Groupmodules/streamWatchdog');

// 真实 VCPLog 消息形状
const request = (requestId, maid) => ({ type: 'tool_approval_request', data: { requestId, toolName: 'ProjectForge', maid, args: { command: 'CreateFile' } } });
const response = (requestId) => ({ type: 'tool_approval_response', data: { requestId, approved: true } });

test('an agent waiting for a tool approval holds the watchdog until the approval is answered', () => {
    clearToolApprovals();
    assert.equal(isWaitingForToolApproval('Nova'), false);
    noteToolApprovalMessage(request('r1', 'Nova'));
    assert.equal(isWaitingForToolApproval('Nova'), true);
    assert.equal(isWaitingForToolApproval(' nova '), true, 'maid matching ignores case and padding');
    assert.equal(isWaitingForToolApproval('Ulka'), false, "another agent's approval does not hold this one");
    noteToolApprovalMessage(response('r1'));
    assert.equal(isWaitingForToolApproval('Nova'), false);
});

test('approvals without a maid hold everyone, stale ones expire, junk is ignored', () => {
    clearToolApprovals();
    noteToolApprovalMessage(request('r2', ''));
    assert.equal(isWaitingForToolApproval('Ulka'), true);
    const now = Date.now();
    assert.equal(isWaitingForToolApproval('Ulka', now + MAX_HOLD_MS + 1), false, 'answered elsewhere and never reported: give up eventually');
    noteToolApprovalMessage(null);
    noteToolApprovalMessage({ type: 'vcp_log', data: 'x' });
    noteToolApprovalMessage({ type: 'tool_approval_request', data: {} });
    assert.equal(isWaitingForToolApproval('Nova'), false);
});

test('a reader aborted by the watchdog throws the string reason; a user interrupt throws AbortError', async (t) => {
    // 和群聊一样：真实 fetch，服务端发完响应头和一个块就不说话了（等审批时就是这样）
    const http = require('node:http');
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const pendingRead = async (reason) => {
        const controller = new AbortController();
        const reader = (await fetch(url, { signal: controller.signal })).body.getReader();
        await reader.read();
        const stalled = reader.read();
        if (reason === undefined) controller.abort(); else controller.abort(reason);
        return stalled.then(() => ({ err: null, controller }), err => ({ err, controller }));
    };
    t.after(() => { server.closeAllConnections(); server.close(); });
    const watchdog = await pendingRead('chunk_idle_timeout');
    assert.equal(watchdog.err, 'chunk_idle_timeout');
    assert.equal(watchdog.err.message, undefined, 'this is why the old message read "error: undefined"');
    assert.equal(isWatchdogAbort(watchdog.err, watchdog.controller), true);
    const user = await pendingRead(undefined);
    assert.equal(user.err.name, 'AbortError');
    assert.equal(isWatchdogAbort(user.err, user.controller), false);
    const network = new TypeError('terminated');
    assert.equal(isWatchdogAbort(network, new AbortController()), false);
});

test('the watchdog note keeps what was received and says why it stopped', () => {
    const partial = '好的，我来建文件。\n<<<[TOOL_REQUEST]>>>…<<<[END_TOOL_REQUEST]>>>\n[[VCP调用结果信息汇总: …]]';
    const saved = withWatchdogNote(partial, 62000);
    assert.ok(saved.startsWith(partial));
    assert.match(saved, /连续 62 秒没有收到 VCP 的数据.*上面是已收到的部分/);
    assert.doesNotMatch(saved, /undefined/);
    assert.doesNotMatch(withWatchdogNote('', 62000), /上面/);
});

test('groupchat wires the hold into both watchdogs and both catch blocks, main.js feeds it both directions', () => {
    const root = path.resolve(__dirname, '..');
    const groupchat = fs.readFileSync(path.join(root, 'Groupmodules/groupchat.js'), 'utf8');
    assert.equal(groupchat.match(/if \(isWaitingForToolApproval\(agentName\)\) \{ resetIdleTimer\(\); return; \}/g)?.length, 2);
    assert.equal(groupchat.match(/if \(isWatchdogAbort\(streamError, controller\)\)/g)?.length, 2);
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.equal(main.match(/groupChat\.noteToolApprovalMessage\?\.\(data\)/g)?.length, 2);
});
