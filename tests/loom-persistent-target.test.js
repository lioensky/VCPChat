'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const pageRuntimeModule = require('../modules/loom/webcore/web-agent-page-runtime-core');

function createRuntime() {
    const dom = new JSDOM(`<!doctype html>
        <html><body>
            <main>
                <label for="prompt">输入消息</label>
                <textarea id="prompt" placeholder="输入消息">旧内容</textarea>
                <button id="submit" aria-label="发送">发送</button>
            </main>
        </body></html>`, {
        url: 'https://example.com/chat',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value() {
            return {
                x: 10,
                y: 10,
                left: 10,
                top: 10,
                right: 210,
                bottom: 50,
                width: 200,
                height: 40,
            };
        },
    });
    window.document.elementFromPoint = () => window.document.getElementById('prompt');
    const runtime = pageRuntimeModule.createWebAgentPageRuntime({
        window,
        document: window.document,
        Node: window.Node,
    }, {
        runtimeInstanceId: 'persistent-target-test',
        documentGeneration: 1,
    });
    return { dom, window, runtime };
}

test('VCP 临时句柄可固化为不包含输入值的持久目标，并跨快照重定位', () => {
    const { window, runtime } = createRuntime();
    const first = runtime.snapshot();
    const input = first.pageGraph.elements.find(item => item.elementKind === 'textarea');
    assert(input, '快照应包含 textarea');

    const target = runtime.createPersistentTarget(input.snapshotHandleId, {
        runtimeInstanceId: first.runtimeInstanceId,
        documentGeneration: first.documentGeneration,
        snapshotId: first.snapshotId,
        strict: true,
    });

    assert.equal(target.kind, 'loom-persistent-target');
    assert.equal(target.origin, 'https://example.com');
    assert.equal(target.tagName, 'textarea');
    assert.equal(target.text, null, '输入框当前内容不得进入持久定位特征');
    assert(target.selectors.some(selector => selector === '#prompt'));

    window.document.getElementById('prompt').value = '运行时变化值';
    runtime.snapshot();
    const resolved = runtime.resolveTarget(target);
    assert.equal(resolved.element.id, 'prompt');
    assert.equal(resolved.source, 'skill-persistent');
});

test('持久目标在来源变化或候选歧义时拒绝匹配', () => {
    const { window, runtime } = createRuntime();
    const snapshot = runtime.snapshot();
    const input = snapshot.pageGraph.elements.find(item => item.elementKind === 'textarea');
    const target = runtime.createPersistentTarget(input.snapshotHandleId, {
        runtimeInstanceId: snapshot.runtimeInstanceId,
        documentGeneration: snapshot.documentGeneration,
        snapshotId: snapshot.snapshotId,
        strict: true,
    });

    assert.throws(
        () => runtime.resolveTarget({ ...target, origin: 'https://other.example' }),
        error => error.code === 'SKILL_TARGET_CONTEXT_MISMATCH'
    );

    const duplicate = window.document.createElement('textarea');
    duplicate.id = 'prompt';
    duplicate.setAttribute('placeholder', '输入消息');
    window.document.body.appendChild(duplicate);

    assert.throws(
        () => runtime.resolveTarget(target),
        error => error.code === 'TARGET_AMBIGUOUS' &&
            error.details.candidateCount === 2
    );
});

test('文本目标优先选择完整名称而不是其短子串按钮', () => {
    const { window, runtime } = createRuntime();
    const novaReply = window.document.createElement('button');
    novaReply.id = 'nova-reply';
    novaReply.textContent = 'Nova回复';
    const reply = window.document.createElement('button');
    reply.id = 'reply';
    reply.textContent = '回复';
    window.document.querySelector('main').append(novaReply, reply);

    const resolved = runtime.resolveTarget('Nova回复');

    assert.equal(resolved.element, novaReply);
    assert.equal(resolved.element.id, 'nova-reply');
    assert.equal(resolved.confidence, 1);
    assert.equal(resolved.candidateCount, 1);
});

test('持久目标不固化动态 title，输入后按钮状态变化仍可解析', () => {
    const { window, runtime } = createRuntime();
    const button = window.document.createElement('button');
    button.id = 'nova-send';
    button.setAttribute('aria-label', 'Nova 发送消息');
    button.setAttribute('title', '请先输入消息');
    button.textContent = 'Nova回复';
    window.document.querySelector('main').append(button);

    const first = runtime.snapshot();
    const handle = first.pageGraph.elements.find(item => item.label === 'Nova 发送消息');
    assert(handle, '快照应包含 Nova 发送按钮');

    const target = runtime.createPersistentTarget(handle.snapshotHandleId, {
        runtimeInstanceId: first.runtimeInstanceId,
        documentGeneration: first.documentGeneration,
        snapshotId: first.snapshotId,
        strict: true,
    });

    assert(!target.selectors.some(selector => selector.includes('[title=')));
    assert.equal(target.attributes.title, undefined);

    button.setAttribute('title', '通过 DeepSeek 原生发送控件提交消息');
    runtime.snapshot();

    const resolved = runtime.resolveTarget(target);
    assert.equal(resolved.element, button);
    assert.equal(resolved.source, 'skill-persistent');
});

test('持久目标 0 匹配时报告未找到，而不是歧义', () => {
    const { window, runtime } = createRuntime();
    const first = runtime.snapshot();
    const input = first.pageGraph.elements.find(item => item.elementKind === 'textarea');
    const target = runtime.createPersistentTarget(input.snapshotHandleId, {
        runtimeInstanceId: first.runtimeInstanceId,
        documentGeneration: first.documentGeneration,
        snapshotId: first.snapshotId,
        strict: true,
    });

    window.document.getElementById('prompt').remove();
    assert.throws(
        () => runtime.resolveTarget(target),
        error => error.code === 'TARGET_NOT_FOUND' &&
            error.details.candidateCount === 0
    );
});