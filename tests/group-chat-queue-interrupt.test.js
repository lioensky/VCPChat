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
    const { describeApis } = require('../preloads/core/registry');
    const queueApi = describeApis().find(api => api.name === 'interruptGroupChatQueue');
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
    assert.ok(queueApi, 'preloads/api 中缺少 interruptGroupChatQueue');
    assert.equal(queueApi.channel, 'interrupt-group-chat-queue');
    assert.equal(queueApi.kind, 'query');
    assert.ok(queueApi.roles.includes('chat'));
    assert.match(contextMenu, /中止群聊/);
    assert.match(contextMenu, /GroupRenderer\?\.interruptGroupChatQueue/);
});

test('group user messages enter central admission before any bubble projection', () => {
    const renderer = read('renderer.js');
    const groupRenderer = read('Groupmodules/grouprenderer.js');
    const messageRenderer = read('modules/messageRenderer.js');
    const sendBody = groupRenderer.slice(
        groupRenderer.indexOf('async function handleSendGroupMessage()'),
        groupRenderer.indexOf('async function loadGroupChatHistory('));
    assert.match(renderer, /currentChatHistoryRef:\s*mainHistoryRef/);
    assert.match(sendBody, /await electronAPI\.topicAdmissionSubmit/);
    assert.match(sendBody, /triggerPolicy: 'reply'/);
    assert.match(sendBody, /groupRequestText: combinedTextContent/);
    assert.doesNotMatch(sendBody, /sendGroupChatMessage|messageRenderer\.renderMessage|pendingGroupUserMessageIds\.add/);
    assert.ok(sendBody.indexOf("if (!result?.success)") < sendBody.indexOf("messageInput.value = ''"));
    assert.match(messageRenderer, /messageItem\._vcpMessageModel\s*=\s*message/);
    assert.match(messageRenderer, /\.find\(m => m\.id === messageId\)\s*\|\|\s*messageItem\._vcpMessageModel/);
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