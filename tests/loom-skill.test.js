'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
    LoomSkillService,
    normalizePlaceholders,
    resolveVariables,
    validateSteps,
} = require('../VCPDistributedServer/Plugin/LoomController/LoomSkillService');
const controller = require('../VCPDistributedServer/Plugin/LoomController/LoomControllerService');
const manifest = require('../VCPDistributedServer/Plugin/LoomController/plugin-manifest.json');

const persistentTarget = {
    kind: 'loom-persistent-target',
    version: 1,
    origin: 'https://example.com',
    tagName: 'textarea',
    selectors: ['textarea[placeholder="输入消息"]'],
    attributes: { placeholder: '输入消息' },
    text: null,
};

function steps() {
    return [
        { index: 1, command: 'OpenApp', appId: 'test-app' },
        { index: 2, command: 'wait', waitMs: 0 },
        { index: 3, command: 'type', params: { target: persistentTarget, text: '{{question}}' }, options: {} },
        { index: 4, command: 'send_keys', params: { target: persistentTarget, keys: 'Enter' }, options: {} },
        { index: 5, command: 'GetRenderedText', params: {} },
    ];
}

async function run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-skills-v2-'));
    const calls = [];
    const service = new LoomSkillService({
        root,
        ttlMs: 1000,
        timeoutMs: 50,
        execute: async args => {
            calls.push(args);
            return { content: [{ type: 'text', text: args.command }] };
        },
    });
    try {
        assert.equal(validateSteps(steps()).length, 5);
        assert.equal(
            validateSteps([{ index: 1, command: 'wait', waitMs: 3600000 }])[0].waitMs,
            3600000,
            '异步 Skill 应允许长等待步骤'
        );
        assert.throws(() => validateSteps([{
            index: 1,
            command: 'wait',
            waitMs: 2147483648,
        }]));
        assert.throws(() => normalizePlaceholders({}, steps()), /未声明占位符/);
        const placeholderCheck = normalizePlaceholders({
            question: { description: '提问内容', required: true, example: '验证问题' },
        }, steps());
        assert.deepEqual(placeholderCheck.used, ['question']);
        assert.throws(
            () => resolveVariables(steps(), placeholderCheck.definitions, {}),
            /缺少必填/
        );
        const complexText = '第一行\ncommand2: click,\n{{not_a_command}}';
        const resolved = resolveVariables(steps(), placeholderCheck.definitions, {
            question: complexText,
        });
        assert.equal(resolved[2].params.text, complexText);
        assert.equal(resolved.length, 5);

        const saved = await service.save({
            skillId: 'test-skill',
            appId: 'test-app',
            title: '提问',
            description: '输入问题并获取结果',
            placeholders: {
                question: { description: '问题', required: true },
            },
            steps: steps(),
        });
        assert.equal(saved.schemaVersion, 2);
        assert.equal(calls.length, 0, '保存不得执行');
        await assert.rejects(service.save({
            skillId: 'test-skill',
            appId: 'test-app',
            placeholders: saved.placeholders,
            steps: steps(),
        }), /EEXIST/);
        assert.equal((await service.manage({})).skills[0].stepCount, 5);
        assert.equal((await service.manage({
            operation: 'get',
            skillId: 'test-skill',
        })).steps[2].params.target.kind, 'loom-persistent-target');

        const beforeMissing = calls.length;
        await assert.rejects(
            service.run({ skillId: 'test-skill', inputs: {} }),
            /缺少必填/
        );
        assert.equal(calls.length, beforeMissing, '缺少变量必须在任何动作前失败');

        const sync = await service.run({
            skillId: 'test-skill',
            inputs: { question: complexText },
        });
        assert.equal(sync.status, 'success');
        assert.equal(sync.completedCount, 5);
        assert.equal(calls[1].text, complexText);
        assert.deepEqual(calls[1].target, persistentTarget);
        assert.equal(calls[2].keys, 'Enter');

        await service.save({
            skillId: 'test-skill',
            title: '新标题',
        }, true);
        assert.equal((await service.read('test-skill')).steps.length, 5);
        await assert.rejects(service.save({ skillId: 'test-skill' }, true), /没有提供/);

        let finish;
        service.execute = () => new Promise(resolve => { finish = resolve; });
        const created = await service.run({
            skillId: 'test-skill',
            mode: 'async',
            inputs: { question: '异步问题' },
        });
        assert.deepEqual(Object.keys(created), ['taskId']);
        assert.equal(service.query(created.taskId).status, 'running');
        await assert.rejects(service.run({
            skillId: 'test-skill',
            inputs: { question: '并发问题' },
        }), /已有 Skill/);
        finish({});
        await new Promise(resolve => setImmediate(resolve));

        const managerCalls = [];
        const manager = {
            appDataRoot: root,
            async createPersistentWebAgentTarget(appId, target, context) {
                managerCalls.push(['persist', appId, target, context]);
                return persistentTarget;
            },
            async openApp(appId) {
                managerCalls.push(['open', appId]);
                return { id: appId, name: appId };
            },
            async executeWebAgentAction(appId, actionId, params, options) {
                managerCalls.push(['action', appId, actionId, params, options]);
                return {
                    appId,
                    actionId: `page_${actionId}`,
                    executedAt: new Date().toISOString(),
                    response: {
                        status: 'success',
                        code: 'ACTION_VERIFIED',
                        result: { verified: true },
                    },
                };
            },
            async readRenderedText(appId) {
                managerCalls.push(['result', appId]);
                return { appId, title: '结果', text: '回答' };
            },
        };
        const integrationRoot = path.join(root, 'integration');
        controller.initialize({ skillsRoot: integrationRoot, loomManager: manager });
        const create = await controller.processToolCall({
            command: 'CreateSkill',
            skillId: 'ask-skill',
            appId: 'test-app',
            title: '提问技能',
            description: '输入任意问题',
            placeholders: {
                question: { description: '本次问题', required: true, example: '验证问题' },
            },
            validationMode: 'current',
            command1: 'type',
            target1: 'vcp-h-1-3-9-abcd1234',
            text1: '{{question}}',
            snapshotId1: 3,
            documentGeneration1: 1,
            command2: 'send_keys',
            target2: 'vcp-h-1-3-9-abcd1234',
            keys2: 'Enter',
            command3: 'getrenderedtext',
        });
        assert.equal(create.details.skillId, 'ask-skill');
        assert.equal(create.details.validation.placeholders.valid, true);
        assert.equal(create.details.validation.targets.length, 2);
        assert.equal(create.details.validation.targets.every(item => item.validated), true);
        assert.equal(create.details.validation.executed, false);
        assert.equal(managerCalls.filter(call => call[0] === 'persist').length, 2);
        assert.equal(managerCalls.some(call => ['action', 'result'].includes(call[0])), false);

        const originalCreatePersistentTarget = manager.createPersistentWebAgentTarget;
        manager.createPersistentWebAgentTarget = async () => {
            throw new Error('当前 DOM 找不到该元素');
        };
        const fallback = await controller.processToolCall({
            command: 'CreateSkill',
            skillId: 'fallback-skill',
            appId: 'test-app',
            title: '原始句柄兜底',
            validationMode: 'current',
            command1: 'click',
            target1: 'vcp-h-1-99-1-expired',
        });
        assert.equal(fallback.details.validation.valid, false);
        assert.equal(fallback.details.validation.targets[0].validated, false);
        assert.equal(fallback.details.validation.targets[0].fallback, 'raw-vcp-id');
        assert.equal(fallback.details.steps[0].params.target, 'vcp-h-1-99-1-expired');
        manager.createPersistentWebAgentTarget = originalCreatePersistentTarget;

        await assert.rejects(
            controller.processToolCall({
                command: 'ExecuteSkill',
                skillId: 'ask-skill',
            }),
            /缺少必填/
        );
        const execution = await controller.processToolCall({
            command: 'ExecuteSkill',
            skillId: 'ask-skill',
            inputs: { question: complexText },
        });
        assert.equal(execution.details.status, 'success');
        const inputCall = managerCalls.find(call => call[0] === 'action' && call[2] === 'type');
        assert.equal(inputCall[3].text, complexText);
        assert.deepEqual(inputCall[3].target, persistentTarget);

        managerCalls.length = 0;
        const trial = await controller.processToolCall({
            command: 'CreateSkill',
            skillId: 'trial-skill',
            appId: 'test-app',
            title: '试跑',
            placeholders: {
                question: { required: true, example: '仅用于创建验证' },
            },
            validationMode: 'trial',
            command1: 'type',
            target1: '输入消息',
            text1: '{{question}}',
            command2: 'getrenderedtext',
        });
        assert.equal(trial.details.validation.executed, true);
        assert(managerCalls.some(call => call[0] === 'action' && call[3].text === '仅用于创建验证'));
        assert(managerCalls.some(call => call[0] === 'result'));

        await controller.processToolCall({
            command: 'EditSkill',
            skillId: 'ask-skill',
            title: '编辑后标题',
        });
        const managed = await controller.processToolCall({
            command: 'ManageSkill',
            operation: 'get',
            skillId: 'ask-skill',
        });
        assert.equal(managed.details.title, '编辑后标题');
        await controller.processToolCall({
            command: 'ManageSkill',
            operation: 'delete',
            skillId: 'ask-skill',
        });

        assert.equal(manifest.communication.timeout, 120000);
        for (const command of ['CreateSkill', 'ManageSkill', 'EditSkill', 'ExecuteSkill', 'GetSkillTask']) {
            assert(manifest.capabilities.invocationCommands.some(item => item.command === command));
        }
        console.log('loom-skill.test.js: all assertions passed');
    } finally {
        controller._test.resetForTests();
        service.dispose();
        await fs.rm(root, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});