const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sequentialMode = require('../Groupmodules/modes/sequentialMode');
const natureRandomMode = require('../Groupmodules/modes/natureRandomMode');
const inviteOnlyMode = require('../Groupmodules/modes/inviteOnlyMode');

const projectRoot = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

test('all group chat modes obey the engine-owned cancellation context', () => {
    const members = [
        { id: 'agent-a', name: 'Agent A' },
        { id: 'agent-b', name: 'Agent B' }
    ];
    const cancelledContext = { isAborted: () => true };
    const groupConfig = {
        sequentialSpeakerOrder: ['agent-a', 'agent-b'],
        tagMatchMode: 'strict',
        memberTags: {}
    };
    const userMessage = { role: 'user', content: 'hello' };
    const history = [userMessage];

    assert.deepEqual(
        sequentialMode.determineSpeakers(members, history, groupConfig, userMessage, cancelledContext),
        []
    );
    assert.deepEqual(
        natureRandomMode.determineSpeakers(members, history, groupConfig, userMessage, cancelledContext),
        []
    );
    assert.deepEqual(
        inviteOnlyMode.determineSpeakers(members, history, groupConfig, userMessage, cancelledContext),
        []
    );
});

test('group queue interruption is exposed from engine through IPC and chat preload', () => {
    const engine = read('Groupmodules/groupchat.js');
    const handlers = read('modules/ipc/groupChatHandlers.js');
    const preload = read('preloads/chat.js');
    const roles = read('preloads/shared/roles.js');
    const contextMenu = read('modules/renderer/messageContextMenu.js');

    assert.match(engine, /async function interruptGroupChatQueue\(groupId, topicId\)/);
    assert.match(engine, /groupQueueCancellationVersions\.set/);
    const queueInterruptBody = engine.slice(
        engine.indexOf('async function interruptGroupChatQueue'),
        engine.indexOf('\n\nmodule.exports')
    );
    assert.doesNotMatch(queueInterruptBody, /request\.controller\.abort\(\)/);
    assert.doesNotMatch(queueInterruptBody, /sendRemoteGroupInterrupt/);
    assert.match(queueInterruptBody, /currentReplyContinues/);
    assert.match(queueInterruptBody, /active reply\/replies continue to completion/);
    assert.match(engine, /interruptGroupChatQueue,/);

    assert.match(handlers, /ipcMain\.handle\('interrupt-group-chat-queue'/);
    assert.match(preload, /interruptGroupChatQueue: query\(\(groupId, topicId\)/);
    assert.match(roles, /'interruptGroupChatQueue'/);
    assert.match(contextMenu, /中止群聊/);
    assert.match(contextMenu, /GroupRenderer\?\.interruptGroupChatQueue/);
});

test('group user bubbles enter current history before DOM projection', () => {
    const renderer = read('renderer.js');
    const groupRenderer = read('Groupmodules/grouprenderer.js');
    const messageRenderer = read('modules/messageRenderer.js');
    const chatManager = read('modules/chatManager.js');

    assert.match(renderer, /currentChatHistoryRef:\s*mainHistoryRef/);
    assert.match(groupRenderer, /currentChatHistoryRef\s*=\s*dependencies\.currentChatHistoryRef/);
    assert.match(groupRenderer, /pendingGroupUserMessageIds\.add\(userMessageForUI\.id\)/);
    assert.match(chatManager, /groupRenderer\?\.isPendingUserMessage\?\.\(oldMsg\.id\)/);
    assert.match(messageRenderer, /messageItem\._vcpMessageModel\s*=\s*message/);
    assert.match(
        messageRenderer,
        /\.find\(m => m\.id === messageId\)\s*\|\|\s*messageItem\._vcpMessageModel/,
        'visible bubbles must retain a context-menu model during JEV history replacement'
    );

    const historyCommitIndex = groupRenderer.indexOf(
        'currentChatHistoryRef.set([...currentHistory, userMessageForUI])'
    );
    const renderIndex = groupRenderer.indexOf(
        'messageRenderer.renderMessage(userMessageForUI)'
    );

    assert.notEqual(historyCommitIndex, -1, 'group user message must be committed to current history');
    assert.notEqual(renderIndex, -1, 'group user message must still be rendered');
    assert.ok(
        historyCommitIndex < renderIndex,
        'history must own the group user message before the context-menu-capable DOM bubble is rendered'
    );
});

test('default invitation prompt carries the central group-chat system indicator', () => {
    const engine = read('Groupmodules/groupchat.js');
    const renderer = read('Groupmodules/grouprenderer.js');
    const centralDefaults = read('VCPDistributedServer/Plugin/VCPMobileSync/config/defaults.js');
    const marker = '[系统邀请指令:]';

    assert.ok(engine.includes(`invitePrompt: '${marker}`));
    assert.ok(engine.match(new RegExp(`groupConfig\\.invitePrompt \\|\\| \\\`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)));
    assert.ok(renderer.includes(`groupConfig.invitePrompt ?? '${marker}`));
    assert.ok(centralDefaults.includes(`"${marker}`));
});