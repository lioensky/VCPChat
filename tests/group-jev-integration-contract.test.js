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
    const { describeApis } = require('../preloads/core/registry');
    const apis = new Map(describeApis().map(api => [api.name, api]));

    const contracts = [
        ['start-jev-group-chat', 'startJevGroupChat'],
        ['continue-jev-group-chat', 'continueJevGroupChat'],
        ['enqueue-jev-group-agent', 'enqueueJevGroupAgent'],
        ['get-jev-group-chat-state', 'getJevGroupChatState']
    ];

    for (const [channel, apiName] of contracts) {
        assert.ok(handlers.includes(`ipcMain.handle('${channel}'`), `missing IPC ${channel}`);
        const api = apis.get(apiName);
        assert.ok(api, `missing preload API ${apiName}`);
        assert.equal(api.channel, channel, `${apiName} 通道不一致`);
        assert.ok(api.roles.includes('chat'), `${apiName} 未对 chat 角色开放`);
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
    assert.match(engine, /const persistResponse = gameRequest\s*\? async \(\) => groupHistory\s*: async/);
    assert.match(engine, /const history = await appendGroupHistoryMessage\(targetGroupId, targetTopicId, terminal\);\s*options\.admissionLifecycle\?\.committed\(\);\s*return history;/);
    assert.match(engine, /admissionToken: token, admissionTerminal: true/);
    assert.match(engine, /await persistResponse\(groupId, topicId, finalAiResponseEntry\)/);
    assert.match(engine, /await persistResponse\(groupId, topicId, aiResponseEntry\)/);
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

test('群组设置槽位按会话作用域隔离跨群 DOM 草稿，且在同一会话内保留成员重勾草稿', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
    const { window } = dom;
    const { document } = window;
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    globalThis.window = window;
    globalThis.document = document;

    try {
        window.eval(read('modules/ui-system/settings/group-slots.js'));
        const slots = window.VCPGroupSettingsSlots;

        const membersContainer = document.createElement('div');
        membersContainer.id = 'groupMembersList';
        const stylesContainer = document.createElement('div');
        stylesContainer.id = 'jevMemberStylesInputs';
        const tagsContainer = document.createElement('div');
        tagsContainer.id = 'memberTagsInputs';
        const sequentialList = document.createElement('div');
        sequentialList.id = 'sequentialSpeakerOrderList';
        document.body.append(membersContainer, stylesContainer, tagsContainer, sequentialList);

        const agents = [
            { id: 'agent-alpha', name: 'Alpha Reviewer' },
            { id: 'agent-beta', name: 'Beta Planner' },
            { id: 'agent-gamma', name: 'Gamma Builder' }
        ];

        // 模拟历史 config.json 未显式携带 id 字段的真实场景
        const groupOneConfig = {
            name: 'Architecture Group',
            mode: 'jev',
            members: ['agent-alpha', 'agent-beta'],
            modeSettings: {
                sequential: { speakerOrder: ['agent-beta', 'agent-alpha'] },
                naturerandom: { tagMatchMode: 'strict', memberTags: { 'agent-alpha': 'backend,review', 'agent-beta': 'roadmap' } },
                jev: {
                    memberStyles: {
                        'agent-alpha': '负责服务端接口审查与边界校验',
                        'agent-beta': '负责里程碑拆解与收敛判定'
                    }
                }
            }
        };

        const groupTwoConfig = {
            name: 'Frontend Triage Group',
            mode: 'jev',
            members: ['agent-alpha', 'agent-beta'],
            modeSettings: {
                sequential: { speakerOrder: ['agent-alpha', 'agent-beta'] },
                naturerandom: { tagMatchMode: 'strict', memberTags: { 'agent-alpha': 'ui,css', 'agent-beta': 'triage' } },
                jev: {
                    memberStyles: {
                        'agent-alpha': '负责样式与无障碍问题排查',
                        'agent-beta': '负责缺陷优先级归类'
                    }
                }
            }
        };

        const nonJevGroupConfig = {
            name: 'Sequential Daily Standup',
            mode: 'sequential',
            members: ['agent-alpha', 'agent-beta'],
            modeSettings: {
                sequential: { speakerOrder: ['agent-alpha', 'agent-beta'] },
                naturerandom: { tagMatchMode: 'strict', memberTags: {} },
                jev: { memberStyles: {} }
            }
        };

        const mountGroupSlots = (config, scopeKey) => {
            slots.renderMemberList({
                container: membersContainer,
                tagsContainer,
                jevStylesContainer: stylesContainer,
                sequentialList,
                agents,
                groupConfig: config
            });
            slots.renderJevMemberStyles({
                container: stylesContainer,
                membersContainer,
                agents,
                groupConfig: config,
                scopeKey
            });
            slots.renderMemberTags({
                container: tagsContainer,
                membersContainer,
                agents,
                groupConfig: config,
                scopeKey
            });
            slots.renderSequentialSpeakerOrder({
                list: sequentialList,
                membersContainer,
                agents,
                groupConfig: config,
                scopeKey
            });
        };

        // 1. 打开群组 1 并在未保存状态下修改草稿
        mountGroupSlots(groupOneConfig, 'group-1:1');
        assert.deepEqual(slots.readJevMemberStyles(stylesContainer), {
            'agent-alpha': '负责服务端接口审查与边界校验',
            'agent-beta': '负责里程碑拆解与收敛判定'
        });
        const groupOneAlphaTextarea = stylesContainer.querySelector('textarea[data-agent-id="agent-alpha"]');
        groupOneAlphaTextarea.value = '群组 1 未保存的临时草稿';
        groupOneAlphaTextarea.dispatchEvent(new window.Event('input', { bubbles: true }));

        // 2. 切换到群组 2：即使不依赖外层手动清空 DOM，新 scopeKey 也绝不能继承群组 1 的残影
        slots.renderJevMemberStyles({
            container: stylesContainer,
            membersContainer,
            agents,
            groupConfig: groupTwoConfig,
            scopeKey: 'group-2:2'
        });
        slots.renderMemberTags({
            container: tagsContainer,
            membersContainer,
            agents,
            groupConfig: groupTwoConfig,
            scopeKey: 'group-2:2'
        });
        assert.deepEqual(slots.readJevMemberStyles(stylesContainer), {
            'agent-alpha': '负责样式与无障碍问题排查',
            'agent-beta': '负责缺陷优先级归类'
        });
        assert.deepEqual(slots.readMemberTags(tagsContainer), {
            'agent-alpha': 'ui,css',
            'agent-beta': 'triage'
        });

        // 3. 从未配置 JEV 提示词（全空字符串）的顺序群切向 JEV 群：绝不能被空串抹成白板
        mountGroupSlots(nonJevGroupConfig, 'group-seq:3');
        assert.deepEqual(slots.readJevMemberStyles(stylesContainer), {
            'agent-alpha': '',
            'agent-beta': ''
        });
        slots.renderJevMemberStyles({
            container: stylesContainer,
            membersContainer,
            agents,
            groupConfig: groupOneConfig,
            scopeKey: 'group-1:4'
        });
        assert.deepEqual(slots.readJevMemberStyles(stylesContainer), {
            'agent-alpha': '负责服务端接口审查与边界校验',
            'agent-beta': '负责里程碑拆解与收敛判定'
        });

        // 4. 同一会话（同 scopeKey）内编辑提示词后取消勾选再重新勾选：草稿无损保留
        const editedAlpha = stylesContainer.querySelector('textarea[data-agent-id="agent-alpha"]');
        editedAlpha.value = '同一会话内编辑后的新触发词';
        editedAlpha.dispatchEvent(new window.Event('input', { bubbles: true }));

        const alphaCheckbox = membersContainer.querySelector('input[type="checkbox"][value="agent-alpha"]');
        alphaCheckbox.checked = false;
        slots.renderJevMemberStyles({
            container: stylesContainer,
            membersContainer,
            agents,
            groupConfig: groupOneConfig,
            scopeKey: 'group-1:4'
        });
        assert.deepEqual(slots.readJevMemberStyles(stylesContainer), {
            'agent-beta': '负责里程碑拆解与收敛判定'
        });

        alphaCheckbox.checked = true;
        slots.renderJevMemberStyles({
            container: stylesContainer,
            membersContainer,
            agents,
            groupConfig: groupOneConfig,
            scopeKey: 'group-1:4'
        });
        assert.deepEqual(slots.readJevMemberStyles(stylesContainer), {
            'agent-alpha': '同一会话内编辑后的新触发词',
            'agent-beta': '负责里程碑拆解与收敛判定'
        });

        // 5. 放弃未保存更改重新打开同一群组（generation 递增）：丢弃脏草稿，回退磁盘持久化值
        slots.renderJevMemberStyles({
            container: stylesContainer,
            membersContainer,
            agents,
            groupConfig: groupOneConfig,
            scopeKey: 'group-1:5'
        });
        assert.deepEqual(slots.readJevMemberStyles(stylesContainer), {
            'agent-alpha': '负责服务端接口审查与边界校验',
            'agent-beta': '负责里程碑拆解与收敛判定'
        });

        // 6. 验证顺序发言列表同样受 scopeKey 隔离保护（群组 1 为 beta->alpha，切到群组 2 必须变为 alpha->beta）
        slots.renderSequentialSpeakerOrder({
            list: sequentialList,
            membersContainer,
            agents,
            groupConfig: groupOneConfig,
            scopeKey: 'group-1:6'
        });
        assert.deepEqual(slots.readSequentialSpeakerOrder(sequentialList), ['agent-beta', 'agent-alpha']);
        slots.renderSequentialSpeakerOrder({
            list: sequentialList,
            membersContainer,
            agents,
            groupConfig: groupTwoConfig,
            scopeKey: 'group-2:7'
        });
        assert.deepEqual(slots.readSequentialSpeakerOrder(sequentialList), ['agent-alpha', 'agent-beta']);
    } finally {
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        delete window.VCPGroupSettingsSlots;
        dom.window.close();
    }
});

test('GroupRenderer 跨群切换与保存互不串写各自的 JEV 成员触发风格', async () => {
    const { JSDOM } = require('jsdom');
    const { pathToFileURL } = require('node:url');
    const schema = await import(pathToFileURL(path.join(root, 'modules/settings/schema/sidebar-surfaces.js')).href);
    const surfaceModule = await import(pathToFileURL(path.join(root, 'modules/ui-system/settings/settings-sidebar-surface.js')).href);

    const dom = new JSDOM(
        '<!doctype html><html><body><main id="tabContentSettings" class="active" aria-hidden="false"><div id="agentSettingsContainer"></div><p id="selectAgentPromptForSettings">请选择</p></main></body></html>',
        { url: 'http://localhost' }
    );
    const { window } = dom;
    const { document } = window;
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevCE = globalThis.CustomEvent;
    const prevMO = globalThis.MutationObserver;
    const prevRAF = globalThis.requestAnimationFrame;

    globalThis.window = window;
    globalThis.document = document;
    globalThis.CustomEvent = window.CustomEvent;
    globalThis.MutationObserver = window.MutationObserver;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);

    try {
        const settingsRoot = document.getElementById('tabContentSettings');
        window.VCPSettingsSidebar = surfaceModule.createSettingsSidebarSurface({ document, root: settingsRoot });
        window.VCPSettingsSchema = schema;
        window.eval(read('modules/ui-system/settings/group-slots.js'));
        window.VCPGroupSettingsSlots.ensureSettingsSurface({ document, settingsTab: settingsRoot });
        window.eval(read('Groupmodules/grouprenderer.js'));

        const agents = [
            { id: 'member-1', name: 'Analyst One' },
            { id: 'member-2', name: 'Builder Two' }
        ];
        const persistedGroups = {
            'group-alpha': {
                name: 'Alpha Workspace',
                mode: 'jev',
                members: ['member-1', 'member-2'],
                modeSettings: {
                    sequential: { speakerOrder: ['member-1', 'member-2'] },
                    naturerandom: { tagMatchMode: 'strict', memberTags: {} },
                    invite_only: {},
                    jev: {
                        navigatorPrompt: '默认导航规则',
                        speakerThreshold: 0.16,
                        continueThreshold: 0.45,
                        stopThreshold: 0.55,
                        maxSpeakersPerRound: 3,
                        maxAutonomousRounds: 12,
                        historyWindow: 12,
                        continueDebounceMs: 800,
                        fallbackPolicy: 'stop',
                        memberStyles: {
                            'member-1': 'Alpha 群专属分析触发词',
                            'member-2': 'Alpha 群专属构建触发词'
                        }
                    }
                }
            },
            'group-beta': {
                name: 'Beta Workspace',
                mode: 'jev',
                members: ['member-1', 'member-2'],
                modeSettings: {
                    sequential: { speakerOrder: ['member-2', 'member-1'] },
                    naturerandom: { tagMatchMode: 'strict', memberTags: {} },
                    invite_only: {},
                    jev: {
                        navigatorPrompt: '默认导航规则',
                        speakerThreshold: 0.16,
                        continueThreshold: 0.45,
                        stopThreshold: 0.55,
                        maxSpeakersPerRound: 3,
                        maxAutonomousRounds: 12,
                        historyWindow: 12,
                        continueDebounceMs: 800,
                        fallbackPolicy: 'stop',
                        memberStyles: {
                            'member-1': 'Beta 群专属分析触发词',
                            'member-2': 'Beta 群专属构建触发词'
                        }
                    }
                }
            }
        };

        let selected = { id: 'group-alpha', type: 'group' };
        window.GroupRenderer.init({
            electronAPI: {
                getAgentGroupConfig: async id => structuredClone(persistedGroups[id]),
                getAgents: async () => structuredClone(agents),
                saveAgentGroupConfig: async (id, nextConfig) => {
                    persistedGroups[id] = structuredClone(nextConfig);
                    return { success: true, agentGroup: { ...structuredClone(nextConfig), id } };
                },
                getAgentConfig: async id => agents.find(agent => agent.id === id) || null
            },
            globalSettingsRef: { get: () => ({}) },
            currentSelectedItemRef: { get: () => selected, set: value => { selected = value; } },
            currentTopicIdRef: { get: () => 'topic-1', set() {} },
            currentChatHistoryRef: { get: () => [], set() {} },
            messageRenderer: { setCurrentItemAvatar() {}, setCurrentItemAvatarColor() {} },
            uiHelper: { showToastNotification() {}, showSaveFeedback() {} },
            mainRendererElements: {},
            mainRendererFunctions: { setCroppedFile() {}, getCroppedFile: () => null, loadItems: async () => {} }
        });

        const submitCurrentGroupForm = async () => {
            const form = document.getElementById('groupSettingsForm');
            const saved = new Promise(resolve => {
                form.addEventListener('vcp-settings-save-result', event => resolve(event.detail), { once: true });
            });
            form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
            return saved;
        };

        // 在群 Alpha 修改成员 1 的提示词并保存
        selected = { id: 'group-alpha', type: 'group' };
        await window.GroupRenderer.displayGroupSettingsPage('group-alpha');
        const alphaInputInGroupA = document.querySelector('#jevMemberStylesInputs textarea[data-agent-id="member-1"]');
        assert.equal(alphaInputInGroupA.value, 'Alpha 群专属分析触发词');
        alphaInputInGroupA.value = 'Alpha 群更新后的分析触发词';
        alphaInputInGroupA.dispatchEvent(new window.Event('input', { bubbles: true }));
        const saveAlpha = await submitCurrentGroupForm();
        assert.equal(saveAlpha.success, true);

        // 切换到群 Beta：界面必须展示 Beta 自己的配置，保存群名修改后亦不得被 Alpha 覆盖
        selected = { id: 'group-beta', type: 'group' };
        await window.GroupRenderer.displayGroupSettingsPage('group-beta');
        const alphaInputInGroupB = document.querySelector('#jevMemberStylesInputs textarea[data-agent-id="member-1"]');
        const betaInputInGroupB = document.querySelector('#jevMemberStylesInputs textarea[data-agent-id="member-2"]');
        assert.equal(alphaInputInGroupB.value, 'Beta 群专属分析触发词');
        assert.equal(betaInputInGroupB.value, 'Beta 群专属构建触发词');

        document.getElementById('groupNameInput').value = 'Beta Workspace Renamed';
        const saveBeta = await submitCurrentGroupForm();
        assert.equal(saveBeta.success, true);

        assert.deepEqual(persistedGroups['group-alpha'].modeSettings.jev.memberStyles, {
            'member-1': 'Alpha 群更新后的分析触发词',
            'member-2': 'Alpha 群专属构建触发词'
        });
        assert.deepEqual(persistedGroups['group-beta'].modeSettings.jev.memberStyles, {
            'member-1': 'Beta 群专属分析触发词',
            'member-2': 'Beta 群专属构建触发词'
        });

        // 反向在 Beta 更新成员 2 后再切回 Alpha，确认双向零污染
        const betaInputToUpdate = document.querySelector('#jevMemberStylesInputs textarea[data-agent-id="member-2"]');
        betaInputToUpdate.value = 'Beta 群二次更新后的构建触发词';
        betaInputToUpdate.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal((await submitCurrentGroupForm()).success, true);

        selected = { id: 'group-alpha', type: 'group' };
        await window.GroupRenderer.displayGroupSettingsPage('group-alpha');
        assert.equal(
            document.querySelector('#jevMemberStylesInputs textarea[data-agent-id="member-1"]').value,
            'Alpha 群更新后的分析触发词'
        );
        assert.equal(
            document.querySelector('#jevMemberStylesInputs textarea[data-agent-id="member-2"]').value,
            'Alpha 群专属构建触发词'
        );
    } finally {
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        globalThis.CustomEvent = prevCE;
        globalThis.MutationObserver = prevMO;
        globalThis.requestAnimationFrame = prevRAF;
        delete window.GroupRenderer;
        delete window.VCPGroupSettingsSlots;
        delete window.VCPSettingsSidebar;
        delete window.VCPSettingsSchema;
        dom.window.close();
    }
});