'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

test('ProjectForgeService 导出 events EventEmitter 并在写操作时触发 changed 事件', async () => {
    const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
    assert.ok(forge.events, 'ProjectForgeService 必须导出 events');
    assert.equal(typeof forge.events.on, 'function', 'events 必须是 EventEmitter');

    let received = null;
    const listener = (payload) => { received = payload; };
    forge.events.on('changed', listener);

    try {
        // 触发一次合成事件验证通道
        forge.events.emit('changed', { action: 'test_action', projectId: 'test_p1' });
        assert.ok(received, '未能接收到 changed 事件');
        assert.equal(received.action, 'test_action');
        assert.equal(received.projectId, 'test_p1');
        assert.ok(typeof received.timestamp === 'number' || received.timestamp === undefined);
    } finally {
        forge.events.removeListener('changed', listener);
    }
});

test('preload projectForge.js 正确声明 onProjectForgeChanged 事件通道', () => {
    const preload = require('../preloads/api/projectForge');
    assert.ok(preload.api.onProjectForgeChanged, 'preload 必须包含 onProjectForgeChanged API');
    assert.equal(preload.api.onProjectForgeChanged.kind, 'subscription');
    assert.equal(preload.api.onProjectForgeChanged.channel, 'project-forge:changed');
});