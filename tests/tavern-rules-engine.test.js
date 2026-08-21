'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../modules/tavernRulesEngine');

test('official presets expose only the approved capability switches', () => {
    const names = engine.BUILTIN_RULES.map(rule => rule.name);

    assert.equal(engine.BUILTIN_RULES.length, 9);
    assert.deepEqual(names, [
        'Agent输出动画气泡',
        '心流锁系统',
        'Loom权限',
        '文坊权限',
        '禁用所有工具',
        'VCP桌面权限',
        '获取服务器验证码',
        '窗口控制权限',
        '启用HTML多媒体权限'
    ]);
    assert.equal(names.includes('插件管理员'), false);
});

test('only the base DivRender capability is enabled by default', () => {
    const store = engine.mergeBuiltinRules({ version: 2, rules: [] });
    const enabled = store.rules.filter(rule => rule.enabled !== false);

    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].builtinKey, 'agent-div-render');

    const systemPrompt = engine.applySystemSuffix('base', store.rules, 'agent');
    assert.match(systemPrompt, /\{\{VarDivRender\}\}/);
    assert.doesNotMatch(systemPrompt, /\{\{USER_AUTH_CODE\}\}/);
    assert.doesNotMatch(systemPrompt, /\{\{VCPScreenPilot\}\}/);
    assert.doesNotMatch(systemPrompt, /\{\{VCPLoomController\}\}/);
    assert.doesNotMatch(systemPrompt, /\[\[Flowlock::Start\]\]/);
});

test('a legacy same-name user rule overrides its official preset', () => {
    const store = engine.mergeBuiltinRules({
        version: 1,
        rules: [{
            id: 'legacy_flowlock',
            name: '心流锁系统',
            type: 'system_suffix',
            enabled: true,
            content: '用户自定义心流说明',
            scope: 'group',
            wrap: true
        }]
    });
    const flowlock = store.rules.find(rule => rule.builtinKey === 'flowlock');

    assert.ok(flowlock);
    assert.equal(flowlock.id, 'legacy_flowlock');
    assert.equal(flowlock.enabled, true);
    assert.equal(flowlock.content, '用户自定义心流说明');
    assert.equal(flowlock.scope, 'group');
    assert.equal(flowlock.isBuiltin, true);
});

test('builtinKey remains authoritative after the user renames an override', () => {
    const store = engine.mergeBuiltinRules({
        version: 2,
        rules: [{
            id: 'renamed_window_control',
            builtinKey: 'window-control',
            name: '我的窗口工具',
            type: 'system_suffix',
            enabled: true,
            content: '自定义窗口权限',
            scope: 'agent',
            wrap: false
        }]
    });
    const rule = store.rules.find(candidate => candidate.builtinKey === 'window-control');

    assert.equal(rule.name, '我的窗口工具');
    assert.equal(rule.content, '自定义窗口权限');
    assert.equal(rule.enabled, true);
});

test('unchanged presets are not persisted to the user store', () => {
    const runtimeStore = engine.mergeBuiltinRules({ version: 2, rules: [] });
    const compacted = engine.compactRuleStore(runtimeStore);

    assert.deepEqual(compacted, { version: 2, rules: [] });
});

test('changed preset state is persisted as a user override', () => {
    const runtimeStore = engine.mergeBuiltinRules({ version: 2, rules: [] });
    const flowlock = runtimeStore.rules.find(rule => rule.builtinKey === 'flowlock');
    flowlock.enabled = true;

    const compacted = engine.compactRuleStore(runtimeStore);
    assert.equal(compacted.rules.length, 1);
    assert.equal(compacted.rules[0].builtinKey, 'flowlock');
    assert.equal(compacted.rules[0].enabled, true);
    assert.equal(compacted.rules[0].isBuiltin, undefined);

    const restored = engine.mergeBuiltinRules(compacted);
    const restoredFlowlock = restored.rules.find(rule => rule.builtinKey === 'flowlock');
    assert.equal(restoredFlowlock.enabled, true);
});

test('explicitly disabling DivRender overrides its enabled official default', () => {
    const runtimeStore = engine.mergeBuiltinRules({ version: 2, rules: [] });
    const divRender = runtimeStore.rules.find(rule => rule.builtinKey === 'agent-div-render');
    divRender.enabled = false;

    const compacted = engine.compactRuleStore(runtimeStore);
    assert.equal(compacted.rules.length, 1);
    assert.equal(compacted.rules[0].builtinKey, 'agent-div-render');
    assert.equal(compacted.rules[0].enabled, false);

    const restored = engine.mergeBuiltinRules(compacted);
    assert.equal(
        restored.rules.find(rule => rule.builtinKey === 'agent-div-render').enabled,
        false
    );
});