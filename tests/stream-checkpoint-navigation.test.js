'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const OPEN_REQ = '<<<[' + 'TOOL_REQUEST]>>>';
const CLOSE_REQ = '<<<[' + 'END_TOOL_REQUEST]>>>';
const OPEN_ROLE = '<<<[' + 'ROLE_DIVIDE_USER]>>>';
const CLOSE_ROLE = '<<<[' + 'END_ROLE_DIVIDE_USER]>>>';
const OPEN_BATCH = '<<<[' + 'VCP_TOOL_BATCH_START:2026-11-14T21:00:00+08:00]>>>';
const CLOSE_BATCH = '<<<[' + 'VCP_TOOL_BATCH_END:2026-11-14T21:00:01+08:00]>>>';
const OPEN_RES = '[[' + 'VCP调用结果信息汇总:';
const CLOSE_RES = 'VCP调用结果结束' + ']]';

function loadFreshChatHandlers(tmpRoot, handlers, contextOverrides = {}) {
    const origLoad = Module._load;
    const fakeIpcMain = {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: () => {},
        removeHandler: () => {},
    };
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
            return {
                ipcMain: fakeIpcMain,
                dialog: {},
                BrowserWindow: { getAllWindows: () => [] },
                app: { getPath: () => tmpRoot },
            };
        }
        return origLoad.call(this, request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../modules/ipc/chatHandlers')];
        const chatHandlers = require('../modules/ipc/chatHandlers');
        chatHandlers.initialize(
            { isDestroyed: () => false, webContents: { id: 1, send: () => {}, isDestroyed: () => false } },
            contextOverrides
        );
        return chatHandlers;
    } finally {
        Module._load = origLoad;
    }
}

function createFakeSender(id = 77) {
    const emitter = new EventEmitter();
    let destroyed = false;
    const events = [];
    return Object.assign(emitter, {
        id,
        events,
        isDestroyed: () => destroyed,
        markDestroyed() {
            destroyed = true;
            emitter.emit('destroyed');
        },
        send(channel, payload) {
            if (!destroyed) events.push({ channel, payload });
        },
    });
}

test('extractStreamChunkText 与 findCompletedToolCheckpointBoundary 精确识别完整工具批次边界', () => {
    const chatHandlers = require('../modules/ipc/chatHandlers');
    assert.equal(chatHandlers.extractStreamChunkText({ choices: [{ delta: { content: 'hello' } }] }), 'hello');
    assert.equal(chatHandlers.extractStreamChunkText({ error: 'json_parse_error', raw: 'bad' }), '');

    const unclosedReq = `准备调用\n${OPEN_REQ}\ntool_name: test`;
    assert.equal(chatHandlers.findCompletedToolCheckpointBoundary(unclosedReq), 0);

    const unclosedBatch = `准备调用\n${OPEN_REQ}\nx\n${CLOSE_REQ}\n${OPEN_ROLE}\n${OPEN_BATCH}\n${OPEN_RES}\nok\n${CLOSE_RES}`;
    assert.equal(chatHandlers.findCompletedToolCheckpointBoundary(unclosedBatch), 0);

    const closedBatch = `${unclosedBatch}\n${CLOSE_BATCH}\n${CLOSE_ROLE}`;
    assert.equal(chatHandlers.findCompletedToolCheckpointBoundary(closedBatch), closedBatch.length);

    const nextTurnUnclosed = `${closedBatch}\n继续下一轮\n${OPEN_REQ}\nnext`;
    assert.equal(chatHandlers.findCompletedToolCheckpointBoundary(nextTurnUnclosed), 0);
});

test('send-to-vcp 在工具批次闭合时自动落盘检查点，并在页面刷新(sender-navigation)时保存已收内容与释放租约', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcp-stream-ckpt-'));
    const agentDir = path.join(tmpRoot, 'Agents');
    const userDataDir = path.join(tmpRoot, 'UserData');
    const agentId = 'kerr_test';
    const topicId = 'topic_nav_1';
    const historyDir = path.join(userDataDir, agentId, 'topics', topicId);

    let sseRes = null;
    const server = http.createServer((req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.flushHeaders();
        res.write(': stream-open\n\n');
        sseRes = res;
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        await fsp.mkdir(path.join(agentDir, agentId), { recursive: true });
        await fsp.mkdir(historyDir, { recursive: true });
        await fsp.writeFile(
            path.join(tmpRoot, 'settings.json'),
            JSON.stringify({ enableVcpToolInjection: false }, null, 2)
        );
        const initialHistory = [
            { id: 'msg_user_1', role: 'user', content: '修一下bug', timestamp: 1000 },
        ];
        const historyFile = path.join(historyDir, 'history.json');
        await fsp.writeFile(historyFile, JSON.stringify(initialHistory, null, 2));

        const releaseCalls = [];
        const failCalls = [];
        const fakeAdmission = {
            subscribe: () => () => {},
            release: async (scope, token, outcome) => {
                releaseCalls.push({ scope, token, outcome });
                return { success: true };
            },
            fail: async (scope, token, error) => {
                failCalls.push({ scope, token, error });
                return { success: true };
            },
        };

        const handlers = new Map();
        loadFreshChatHandlers(tmpRoot, handlers, {
            AGENT_DIR: agentDir,
            USER_DATA_DIR: userDataDir,
            APP_DATA_ROOT_IN_PROJECT: tmpRoot,
            topicAdmission: fakeAdmission,
        });

        const sendToVcp = handlers.get('send-to-vcp');
        assert.equal(typeof sendToVcp, 'function');

        const sender = createFakeSender(101);
        const messageId = 'admission_msg_nav_test_1';
        const context = {
            agentId,
            agentName: 'Kerr',
            topicId,
            admissionToken: 'token_nav_1',
            isGroupMessage: false,
        };

        const startRes = await sendToVcp(
            { sender },
            `http://127.0.0.1:${port}/v1/chat/completions`,
            'test-key',
            [{ role: 'user', content: '修一下bug' }],
            { model: 'gemini-test', stream: true },
            messageId,
            false,
            context
        );
        assert.equal(startRes.streamingStarted, true);
        assert.ok(sseRes, 'SSE connection should be established');

        // 1. 发送完整的一轮工具调用与回执块，验证主进程自动写入检查点
        const toolTurnBlock = `先读文件\n${OPEN_REQ}\ntool_name:ReadFile\n${CLOSE_REQ}\n${OPEN_ROLE}\n${OPEN_BATCH}\n${OPEN_RES}\n文件内容OK\n${CLOSE_RES}\n${CLOSE_BATCH}\n${CLOSE_ROLE}\n`;
        sseRes.write(`data: ${JSON.stringify({ choices: [{ delta: { content: toolTurnBlock } }] })}\n\n`);

        // 等待异步队列落盘检查点
        for (let i = 0; i < 30; i += 1) {
            const disk = JSON.parse(await fsp.readFile(historyFile, 'utf8'));
            if (disk.length === 2) break;
            await new Promise(r => setTimeout(r, 25));
        }

        const checkpointHistory = JSON.parse(await fsp.readFile(historyFile, 'utf8'));
        assert.equal(checkpointHistory.length, 2);
        assert.equal(checkpointHistory[1].id, messageId);
        assert.equal(checkpointHistory[1].finishReason, 'tool_checkpoint');
        assert.equal(checkpointHistory[1].admissionTerminal, undefined);
        assert.ok(checkpointHistory[1].content.includes('文件内容OK'));

        // 2. 继续输出第二段总结文字，此时用户按下窗口刷新（触发主框架 did-start-navigation）
        sseRes.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '正在生成总结方案...' } }] })}\n\n`);
        await new Promise(r => setTimeout(r, 30));

        sender.emit('did-start-navigation', {}, 'file:///main.html', false, true);

        for (let i = 0; i < 40; i += 1) {
            if (releaseCalls.length > 0) break;
            await new Promise(r => setTimeout(r, 25));
        }

        assert.equal(releaseCalls.length, 1);
        assert.equal(releaseCalls[0].token, 'token_nav_1');
        assert.deepEqual(releaseCalls[0].outcome, { saved: true });
        assert.equal(failCalls.length, 0);

        const finalHistory = JSON.parse(await fsp.readFile(historyFile, 'utf8'));
        assert.equal(finalHistory.length, 2);
        assert.equal(finalHistory[1].id, messageId);
        assert.equal(finalHistory[1].finishReason, 'cancelled');
        assert.equal(finalHistory[1].admissionTerminal, true);
        assert.ok(finalHistory[1].content.includes('正在生成总结方案...'));
        assert.ok(finalHistory[1].content.includes('流式响应中断（页面刷新或窗口重载）'));
    } finally {
        sseRes?.destroy();
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
        await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
});