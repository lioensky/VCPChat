'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('JEV 群聊从主进程服务注入到群聊运行时', () => {
    const main = read('main.js');
    const handlers = read('modules/ipc/groupChatHandlers.js');
    const engine = read('Groupmodules/groupchat.js');

    assert.match(main, /jevService:\s*globalJevService/);
    assert.match(handlers, /groupChat\.initializeRuntimeServices\(\{/);
    assert.match(handlers, /jevService/);
    assert.match(engine, /function initializeRuntimeServices\(/);
    assert.match(engine, /new JevGroupSessionOrchestrator\(/);
});

test('JEV 发起、继续、插队和状态查询 IPC 完整暴露给聊天 preload', () => {
    const handlers = read('modules/ipc/groupChatHandlers.js');
    const catalog = read('preloads/shared/catalog.js');
    const roles = read('preloads/shared/roles.js');
    const chatPreload = read('preloads/chat.js');

    const contracts = [
        ['start-jev-group-chat', 'startJevGroupChat'],
        ['continue-jev-group-chat', 'continueJevGroupChat'],
        ['enqueue-jev-group-agent', 'enqueueJevGroupAgent'],
        ['get-jev-group-chat-state', 'getJevGroupChatState']
    ];

    for (const [channel, apiName] of contracts) {
        assert.ok(handlers.includes(`ipcMain.handle('${channel}'`), `missing IPC ${channel}`);
        assert.ok(catalog.includes(`${apiName}:`), `missing shared catalog API ${apiName}`);
        assert.ok(roles.includes(`'${apiName}'`), `missing role API ${apiName}`);
        assert.ok(chatPreload.includes(`${apiName}:`), `missing generated chat preload API ${apiName}`);
        assert.ok(chatPreload.includes(`"${apiName}"`), `missing generated chat preload allowlist ${apiName}`);
    }
});

test('JEV 继续群聊仅向 IPC 返回可结构化克隆的数据', () => {
    const engine = read('Groupmodules/groupchat.js');
    const continueBody = engine.slice(
        engine.indexOf('async function continueJevGroupChat'),
        engine.indexOf('\n\nasync function enqueueJevGroupAgent')
    );

    assert.match(continueBody, /const result = await ensureJevSessionOrchestrator\(\)\.continue/);
    assert.match(continueBody, /success:\s*result\.success/);
    assert.match(continueBody, /state:\s*result\.state/);
    assert.doesNotMatch(continueBody, /return ensureJevSessionOrchestrator\(\)\.continue/);
    assert.doesNotMatch(continueBody, /promise:\s*result\.promise/);
});

test('JEV 模式配置包含权重截断、K 上限、自治保护和成员风格', () => {
    const decision = read('Groupmodules/modes/jevDecisionMode.js');
    const engine = read('Groupmodules/groupchat.js');
    const schema = read('modules/settings/schema/sidebar-surfaces.js');
    const slots = read('modules/ui-system/settings/group-slots.js');
    const renderer = read('Groupmodules/grouprenderer.js');

    for (const field of [
        'speakerThreshold',
        'continueThreshold',
        'stopThreshold',
        'maxSpeakersPerRound',
        'maxAutonomousRounds',
        'historyWindow',
        'continueDebounceMs',
        'memberStyles'
    ]) {
        assert.ok(decision.includes(field), `decision defaults missing ${field}`);
        assert.ok(renderer.includes(field), `renderer persistence missing ${field}`);
    }

    assert.match(engine, /normalizeJevModeSettings\(existingModeSettings\.jev,\s*members\)/);
    assert.match(schema, /\['jev', 'JEV 智能群聊'\]/);
    assert.match(schema, /id:\s*'jevModeSettingsContainer'/);
    assert.match(slots, /function renderJevMemberStyles\(/);
    assert.match(slots, /function readJevMemberStyles\(/);
});

test('JEV 用户与 Agent 消息通过共享历史队列原子追加', () => {
    const engine = read('Groupmodules/groupchat.js');

    assert.match(engine, /groupHistoryMutationQueue\.mutate\(/);
    assert.match(engine, /groupHistory = await appendGroupHistoryMessage\(groupId, topicId, userMessageEntry\)/);
    assert.match(engine, /await appendGroupHistoryMessage\(groupId, topicId, finalAiResponseEntry\)/);
    assert.match(engine, /await appendGroupHistoryMessage\(groupId, topicId, aiResponseEntry\)/);
});

test('JEV 模式复用成员按钮并提供发起和继续入口', () => {
    const slots = read('modules/ui-system/settings/group-slots.js');
    const renderer = read('Groupmodules/grouprenderer.js');
    const handlers = read('modules/ipc/groupChatHandlers.js');

    assert.match(slots, /'发起群聊'/);
    assert.match(slots, /'继续群聊'/);
    assert.match(slots, /\['invite_only', 'jev'\]\.includes\(groupConfig\.mode\)/);
    assert.match(renderer, /handleStartJevGroupChat/);
    assert.match(renderer, /handleContinueJevGroupChat/);
    assert.match(renderer, /onStartJev:\s*handleStartJevGroupChat/);
    assert.match(renderer, /onContinueJev:\s*handleContinueJevGroupChat/);
    assert.match(handlers, /groupConfig\?\.mode === 'jev'/);
    assert.match(handlers, /enqueueJevGroupAgent/);
});

test('JEV 控制事件不会误入消息流投影', () => {
    const orchestrator = read('Groupmodules/jevGroupSessionOrchestrator.js');
    const consumer = read('modules/renderer/nonStreamingEventConsumer.js');

    assert.match(orchestrator, /messageId:\s*`jev_session_/);
    for (const type of [
        'group_queue_state',
        'group_queue_updated',
        'group_queue_stopped',
        'jev_arbitration_started',
        'jev_arbitration_result'
    ]) {
        assert.ok(consumer.includes(`'${type}'`), `non-stream consumer missing ${type}`);
    }
});

test('整队停止覆盖所有群聊模式但保留当前活动回复', () => {
    const engine = read('Groupmodules/groupchat.js');
    const queueStopBody = engine.slice(
        engine.indexOf('async function interruptGroupChatQueue'),
        engine.indexOf('\n\nmodule.exports')
    );

    assert.match(engine, /async function interruptGroupRequest\(messageId\)/);
    assert.match(engine, /request\.controller\.abort\(\)/);
    assert.match(queueStopBody, /groupQueueCancellationVersions\.set/);
    assert.match(queueStopBody, /jevSessionOrchestrator\.interrupt\(groupId, topicId\)/);
    assert.doesNotMatch(queueStopBody, /request\.controller\.abort\(\)/);
    assert.doesNotMatch(queueStopBody, /sendRemoteGroupInterrupt/);
    assert.match(queueStopBody, /currentReplyContinues/);
    assert.match(queueStopBody, /continuingMessageIds/);
});