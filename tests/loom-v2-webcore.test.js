'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../modules/loom/webcore');
const { GlobalJevService } = require('../modules/services/globalJevService');

function page(html) {
    const dom = new JSDOM(html, { url: 'https://www.bing.com/', pretendToBeVisual: true });
    const { window } = dom;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
        const y = Number(this.dataset.y || 20);
        return { x: 20, y, top: y, left: 20, right: 220, bottom: y + 30, width: 200, height: 30 };
    };
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.document.elementFromPoint = () => window.document.querySelector('input,button,textarea,main') || window.document.body;
    const runtime = core.createPageRuntime({ window, document: window.document, Node: window.Node });
    return { dom, window, document: window.document, runtime };
}

function adapterFor(runtime, document, calls, native = true) {
    return Object.assign(new core.adapterContract.WebAgentAdapter({ id: 'test', backend: 'test-page' }), {
        id: 'test', backend: 'test-page',
        async getCapabilities() { return native ? ['page', 'nativeInput'] : ['page']; },
        async getTargetIdentity() { return {}; },
        async getDocumentState() { return {}; },
        async getTarget() { return { url: document.URL }; },
        async executePageOperation(command, params, request) {
            calls.push(command);
            return runtime.execute(command, params, request.options);
        },
        async dispatchNativeInput(plan) {
            calls.push(plan.type);
            const element = document.activeElement;
            if (plan.type === 'insert-text') {
                element.value = plan.text;
            } else if (plan.type === 'mouse-sequence' && plan.events.some(event => event.type === 'up')) {
                element.click();
            }
            return {};
        }
    });
}

test('持久化签名跨路由、跨标签重绑定且兼容旧版 v1', () => {
    const fixture = page('<form><textarea name="q" aria-label="搜索" data-y="360"></textarea><button>搜索</button></form>');
    try {
        const { runtime, document, window } = fixture;
        const target = runtime.createPersistentTarget('q');
        assert.equal(target.version, 1);
        assert.equal(target.signature.containerKind, 'form');
        assert.equal(target.signature.siblingButtonHint, true);
        document.body.innerHTML = '<header><form><input name="q" aria-label="搜索"><button>搜索</button></form></header><input name="email">';
        window.history.pushState({}, '', '/search?q=hello');
        const rebound = runtime.resolveTarget(target);
        assert.equal(rebound.rebound, true);
        assert.equal(rebound.element.name, 'q');
        assert.ok(rebound.confidence >= 0.68);
        assert.equal(rebound.source, 'skill-persistent-rebound');
        const old = { ...target, selectors: ['#removed'], tagName: 'input' };
        delete old.signature;
        assert.equal(runtime.resolveTarget(old).element.name, 'q');
        const signatureOnly = { ...target, selectors: [] };
        assert.equal(runtime.resolveTarget(signatureOnly).rebound, true);
    } finally { fixture.dom.window.close(); }
});

test('中文 Bigram、缺失维度不赠分与功能角色等价', () => {
    assert.ok(core.pageCore.computeTextSimilarity('搜索网页内容', '搜索相关网页内容') > 0.42);
    assert.equal(core.pageCore.computeTextSimilarity('', '搜索'), 0);
    const fixture = page('<textarea name="other"></textarea><input name="q"><button></button><a></a>');
    try {
        const { pageCore } = fixture.runtime;
        const textarea = fixture.document.querySelector('textarea');
        assert.equal(pageCore.validateElementAgainstSignature(textarea, { name: 'q' }).score, 0);
        assert.equal(pageCore.validateElementAgainstSignature(textarea, { name: '' }).score, 0);
        const signature = pageCore.createElementSignature(fixture.document.querySelector('input'));
        textarea.name = 'q';
        const match = pageCore.validateElementAgainstSignature(textarea, signature);
        assert.equal(match.valid, true);
        assert.ok(match.score >= 0.68);
        assert.equal(pageCore.validateElementAgainstSignature(fixture.document.querySelector('a'),
            { tagName: 'button' }).score, 0.85);
    } finally { fixture.dom.window.close(); }
});

test('拓扑、SVG 指纹与视口区域被保存', () => {
    const fixture = page('<nav><button data-y="700"><svg viewBox="0 0 24 24"><path d="M12345678901234567890123456789"/></svg></button></nav>');
    try {
        const signature = fixture.runtime.pageCore.createElementSignature(fixture.document.querySelector('button'));
        assert.equal(signature.containerKind, 'nav');
        assert.equal(signature.viewportZone, 'bottom');
        assert.match(signature.svgHint, /^0 0 24 24\|/);
    } finally { fixture.dom.window.close(); }
});

for (const command of ['page_click', 'page_send_keys', 'page_hover', 'page_check', 'page_type']) {
    test(`${command} 使用 prepare -> CDP -> verify，真实回执后端`, async () => {
        const fixture = page('<input id="target" type="checkbox">');
        try {
            if (command === 'page_type' || command === 'page_send_keys') {
                fixture.document.querySelector('input').type = 'text';
            }
            const calls = [];
            const runtime = core.createRuntime(adapterFor(fixture.runtime, fixture.document, calls));
            const response = await runtime.execute({ command, params: { target: 'target', keys: 'Enter', text: '你好' },
                options: { backend: command === 'page_type' ? 'cdp-input' : 'auto' } });
            assert.equal(response.status, 'success', JSON.stringify(response));
            assert.deepEqual(calls, ['page_prepare_action',
                command === 'page_type' ? 'insert-text' : command === 'page_send_keys' ? 'keyboard-sequence' : 'mouse-sequence',
                'page_verify_action']);
            assert.equal(response.execution.backendUsed, 'test-cdp-input');
            assert.equal(response.result.result.backendUsed, 'test-cdp-input');
        } finally { fixture.dom.window.close(); }
    });
}

test('check 幂等不产生物理点击；page-core 显式选择不走 CDP', async () => {
    const fixture = page('<input id="target" type="checkbox" checked>');
    try {
        const calls = [];
        const runtime = core.createRuntime(adapterFor(fixture.runtime, fixture.document, calls));
        const response = await runtime.execute({ command: 'check', params: { target: 'target', checked: true } });
        assert.equal(response.result.result.idempotentNoop, true);
        assert.deepEqual(calls, ['page_prepare_action', 'page_verify_action']);
        calls.length = 0;
        await runtime.execute({ command: 'send_keys', params: { target: 'target', keys: 'Enter' },
            options: { backend: 'page-core' } });
        assert.deepEqual(calls, ['page_send_keys']);
    } finally { fixture.dom.window.close(); }
});

test('原生 type 自动回退；子 frame 可回退但禁止错误坐标击发', async () => {
    const fixture = page('<input id="target">');
    try {
        const calls = [];
        const adapter = adapterFor(fixture.runtime, fixture.document, calls);
        const original = adapter.executePageOperation;
        adapter.executePageOperation = async (command, params, request) => {
            if (command === 'page_type') {
                calls.push(command);
                return { status: 'error', code: 'ACTION_VERIFICATION_FAILED' };
            }
            return original(command, params, request);
        };
        const runtime = core.createRuntime(adapter);
        const response = await runtime.execute({ command: 'type', params: { target: 'target', text: 'retry' } });
        assert.equal(response.status, 'success');
        assert.equal(response.result.result.fallbackUsed, true);
        assert.deepEqual(calls, ['page_type', 'page_prepare_action', 'insert-text', 'page_verify_action']);
        adapter.executePageOperation = async (command, params, request) => {
            const result = await original(command, params, request);
            if (command === 'page_prepare_action') result.result.isTopFrame = false;
            return result;
        };
        calls.length = 0;
        const denied = await runtime.execute({ command: 'click', params: { target: 'target' },
            options: { allowFallback: false } });
        assert.equal(denied.status, 'error');
        assert.deepEqual(calls, ['page_prepare_action']);
        const fallback = await runtime.execute({ command: 'click', params: { target: 'target' } });
        assert.equal(fallback.execution.fallbackUsed, true);
    } finally { fixture.dom.window.close(); }
});

test('真实歧义候选注册严格句柄，Jev 仲裁重试与缓存命中', async () => {
    const fixture = page('<button>提交</button><button>提交</button>');
    try {
        let candidates;
        assert.throws(() => fixture.runtime.resolveTarget('提交'), error => {
            candidates = error.details.candidates;
            return error.code === 'TARGET_AMBIGUOUS' && candidates.length === 2;
        });
        for (const candidate of candidates) {
            assert.match(candidate.handleId, /^vcp-h-/);
            assert.ok(fixture.runtime.resolveTarget(candidate.handleId).element);
        }
        let decisions = 0;
        const arbiter = core.createEntityArbiter({
            decide: async (state, questions, options) => {
                decisions++;
                assert.equal(typeof state, 'string');
                assert.equal(questions.c_0.type, 'noul');
                assert.deepEqual(options, { timeoutMs: 3500, maxRetries: 0 });
                return { answers: { c_0: { noul: 0.91 }, c_1: { noul: 0.15 } } };
            }
        });
        const calls = [];
        const runtime = core.createRuntime(adapterFor(fixture.runtime, fixture.document, calls), { arbiter });
        for (let i = 0; i < 2; i++) {
            const result = await runtime.execute({ command: 'click', params: { target: '提交' } });
            assert.equal(result.status, 'success', JSON.stringify(result));
            assert.equal(result.result.result.targetResolution.arbiterUsed, true);
            assert.equal(result.result.result.targetResolution.arbiterProbability, 0.91);
        }
        assert.equal(decisions, 1);
    } finally { fixture.dom.window.close(); }
});

test('持久化灰区与重复精确选择器返回 Top-8 脱水候选', () => {
    const fixture = page('<button name="send">发送</button><button name="send">发送</button>');
    try {
        const target = { kind: 'loom-persistent-target', version: 1, origin: 'https://www.bing.com',
            selectors: ['button'], tagName: 'button', attributes: {}, text: '发送' };
        assert.throws(() => fixture.runtime.resolveTarget(target), error => {
            assert.equal(error.code, 'TARGET_AMBIGUOUS');
            assert.equal(error.details.candidates.length, 2);
            assert.ok(error.details.candidates.every(candidate => candidate.handleId && !candidate.element));
            return true;
        });
    } finally { fixture.dom.window.close(); }
});

test('仲裁器拒绝低置信、异常、未配置和超时，并使 TTL 过期', async () => {
    const payload = { command: 'click', target: '发送', pageUrl: 'https://example.com',
        candidates: [{ handleId: 'a' }, { handleId: 'b' }] };
    assert.equal((await core.createEntityArbiter().arbitrate(payload)).resolved, false);
    for (const decide of [
        async () => ({ answers: { c_0: { noul: 0.6 }, c_1: { noul: 0.59 } } }),
        async () => { throw new Error('offline'); },
        () => new Promise(() => {})
    ]) {
        assert.equal((await core.createEntityArbiter({ decide, timeoutMs: 20 }).arbitrate(payload)).resolved, false);
    }
    let calls = 0;
    const arbiter = core.createEntityArbiter({ cacheTtlMs: 1, decide: async () => {
        calls++;
        return { answers: { c_0: { noul: 0.9 }, c_1: { noul: 0.1 } } };
    } });
    await arbiter.arbitrate(payload);
    await new Promise(resolve => setTimeout(resolve, 10));
    await arbiter.arbitrate(payload);
    assert.equal(calls, 2);
});

test('高频时钟降噪，局部 dom_stable 不被外部动画打断', async () => {
    const fixture = page('<span id="clock">0</span><main id="answer">静态内容</main>');
    let counter = 0;
    const timer = setInterval(() => {
        fixture.document.querySelector('#clock').textContent = String(++counter);
    }, 8);
    try {
        const global = await fixture.runtime.waitFor({ condition: 'dom_stable', stableMs: 80, pollMs: 25, timeoutMs: 800 });
        assert.equal(global.code, 'WAIT_CONDITION_MET');
        const local = await fixture.runtime.waitFor({ condition: 'dom_stable', target: 'answer',
            stableMs: 80, pollMs: 25, timeoutMs: 800 });
        assert.equal(local.code, 'WAIT_CONDITION_MET');
    } finally { clearInterval(timer); fixture.dom.window.close(); }
});

test('settled 等待流式文本停止与 busy 消失，不提前完成', async () => {
    const fixture = page('<main id="answer" aria-busy="true">开始</main>');
    const element = fixture.document.querySelector('main');
    let chunks = 0;
    const timer = setInterval(() => {
        element.append('流式回答');
        if (++chunks === 4) {
            clearInterval(timer);
            element.removeAttribute('aria-busy');
        }
    }, 35);
    try {
        const result = await fixture.runtime.waitFor({ condition: 'settled', target: 'answer',
            stableMs: 80, pollMs: 25, timeoutMs: 1000 });
        assert.equal(chunks, 4);
        assert.equal(result.code, 'WAIT_CONDITION_MET');
        assert.equal(result.result.actual.busy, false);
        assert.ok(result.result.elapsedMs >= 200);
        await assert.rejects(fixture.runtime.waitFor({ condition: 'settled', target: 'absent',
            timeoutMs: 75, pollMs: 25 }), error => error.code === 'WAIT_TIMEOUT');
    } finally { clearInterval(timer); fixture.dom.window.close(); }
});

test('Jev 服务允许单次覆盖 timeout 与零重试', async () => {
    let received;
    const service = new GlobalJevService({
        settingsManager: { async readSettings() { return { jevEnabled: true, jevMaxRetries: 5 }; } },
        client: { async decide(state, questions, options) { received = options; return {}; } }
    });
    await service.decide('state', {}, { timeoutMs: 3500, maxRetries: 0 });
    assert.equal(received.timeoutMs, 3500);
    assert.equal(received.maxRetries, 0);
});

test('共享 UMD 在无 require/module 环境加载，导出接口保持一致', () => {
    const context = vm.createContext({ setTimeout, clearTimeout });
    for (const file of ['web-agent-protocol.js', 'adapter-contract.js', 'web-agent-page-core.js',
        'comfyui-page-adapter.js', 'web-agent-page-runtime-core.js', 'web-agent-runtime-core.js',
        'chrome-adapter.js', 'web-agent-entity-arbiter.js', 'index.js']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../modules/loom/webcore/${file}`), 'utf8'), context);
    }
    assert.equal(typeof context.VCPWebAgentCore.createEntityArbiter, 'function');
    assert.equal(typeof context.VCPWebAgentPageCore.computeTextSimilarity, 'function');
    assert.equal(context.VCPWebAgentProtocol.COMMANDS.page_prepare_action.internal, true);
});

for (const adapterKind of ['electron', 'chrome']) {
    test(`${adapterKind} 正式适配器闭环调用实际 CDP 方法`, async () => {
        const fixture = page('<input id="target">');
        const commands = [];
        try {
            let adapter;
            if (adapterKind === 'electron') {
                const { EventEmitter } = require('node:events');
                const debuggerApi = Object.assign(new EventEmitter(), {
                    attached: false,
                    isAttached() { return this.attached; },
                    attach() { this.attached = true; },
                    async sendCommand(method, params) { commands.push([method, params]); return {}; }
                });
                const { createElectronWebAgentAdapter } = require('../modules/loom/webcore/electron-adapter');
                adapter = createElectronWebAgentAdapter({
                    id: 1, debugger: debuggerApi, isDestroyed: () => false
                }, {
                    executePageOperation: (command, params, request) =>
                        fixture.runtime.execute(command, params, request.options)
                });
            } else {
                adapter = core.adapters.chrome.createChromeWebAgentAdapter({
                    debugger: {
                        attach(target, version, callback) { callback(); },
                        sendCommand(target, method, params, callback) { commands.push([method, params]); callback({}); }
                    },
                    tabs: {
                        async sendMessage(target, message) {
                            return fixture.runtime.execute(message.data.command, message.data, message.data.options);
                        }
                    }
                }, { currentActiveTabId: 1 });
            }
            const runtime = core.createRuntime(adapter);
            const response = await runtime.execute({ command: 'send_keys',
                params: { target: 'target', keys: 'Enter' } });
            assert.equal(response.status, 'success', JSON.stringify(response));
            assert.equal(response.execution.backendUsed, `${adapter.id}-cdp-input`);
            assert.ok(commands.some(([method, params]) =>
                method === 'Input.dispatchKeyEvent' && params.key === 'Enter'));
        } finally { fixture.dom.window.close(); }
    });
}

test('只读恢复不覆盖注册表原始引用', () => {
    const fixture = page('<input id="target" name="q">');
    try {
        const snapshot = fixture.runtime.snapshot();
        const handle = snapshot.elements[0].snapshotHandleId;
        const original = fixture.document.querySelector('input');
        original.remove();
        const replacement = fixture.document.createElement('input');
        replacement.id = 'target';
        replacement.name = 'q';
        fixture.document.body.append(replacement);
        assert.equal(fixture.runtime.resolveTarget(handle, { readOnly: true }).element, replacement);
        replacement.remove();
        fixture.document.body.append(original);
        assert.equal(fixture.runtime.resolveTarget(handle).source, 'registry-exact');
    } finally { fixture.dom.window.close(); }
});

test('长文本容器仅 style/class 持续动画也可稳定', async () => {
    const fixture = page(`<main id="animated">${'正文'.repeat(40)}</main>`);
    let tick = 0;
    const timer = setInterval(() => {
        fixture.document.querySelector('main').className = `frame-${++tick}`;
    }, 8);
    try {
        const response = await fixture.runtime.waitFor({
            condition: 'dom_stable', stableMs: 80, pollMs: 25, timeoutMs: 800
        });
        assert.equal(response.code, 'WAIT_CONDITION_MET');
    } finally { clearInterval(timer); fixture.dom.window.close(); }
});