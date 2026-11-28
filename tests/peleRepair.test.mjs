import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import {
    normalizePeleSource,
    buildMermaidRepairMessages,
    extractMermaidCodeFromReply,
    replaceMermaidBlockInMessageContent,
    patchMessageMermaidContent,
    repairMermaidDiagram,
} from '../modules/renderer/peleRepair.js';

function loadPele() {
    const code = readFileSync(new URL('../vendor/pele.global.js', import.meta.url), 'utf8');
    const sandbox = { window: {}, globalThis: {} };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);
    return sandbox.pele || sandbox.window.pele;
}

const pele = loadPele();

const USER_FAILING_DIAGRAM = `flowchart TD
    subgraph 传统 Agent 的死穴（上下文污染）
        A1["模型写错工具格式"] --> B1["返回冗长报错日志"]
        B1 --> C1["重试成功"]
        C1 --> D1["丑陋的报错和残骸永久留在 History 里"]
        D1 --> E1["⚠️ 浪费 Token<br/>⚠️ 注意力分散<br/>⚠️ 诱导后续轮次反复模仿错误语法"]
    end

    subgraph 主人的 VCP 优雅闭环（清洗 + 药丸）
        A2["发生错误"] --> B2["轮内 0ms 精准拦截提示"]
        B2 --> C2["模型自愈完成任务"]
        C2 --> D2["主人新发言触发轮间清洗 ($ToolProtocolHistoryCleanse)"]
        D2 --> E2["✨ 报错残骸彻底从历史抹平<br/>✨ 提炼规则注入全局唯一常驻药丸<br/>✨ 保证后续对话拥有长期抗体且上下文极度纯净"]
    end`;

test('Layer 1 normalizePeleSource fixes bare subgraph titles with spaces/parentheses and renders via real pele', () => {
    assert.throws(() => pele.render(USER_FAILING_DIAGRAM), /Lexical error|Parse error/i);

    const normalized = normalizePeleSource(USER_FAILING_DIAGRAM);
    assert.match(normalized, /subgraph "传统 Agent 的死穴（上下文污染）"/);
    assert.match(normalized, /subgraph "主人的 VCP 优雅闭环（清洗 \+ 药丸）"/);

    const result = pele.render(normalized);
    assert.ok(result && typeof result.svg === 'string' && result.svg.includes('<svg'));
});

test('normalizePeleSource preserves valid subgraph syntax and converts smart dashes', () => {
    const valid = [
        'flowchart TD',
        '    subgraph "已经带引号（标题）"',
        '        A[Start] —> B[End]',
        '    end',
        '    subgraph explicitId [显式容器]',
        '        B –> C',
        '    end',
        '    subgraph plain_id',
        '        C －> D',
        '    end',
    ].join('\n');

    const normalized = normalizePeleSource(valid);
    assert.ok(normalized.includes('subgraph "已经带引号（标题）"'));
    assert.ok(normalized.includes('subgraph explicitId [显式容器]'));
    assert.ok(normalized.includes('subgraph plain_id'));
    assert.ok(normalized.includes('A[Start] --> B[End]'));
    assert.ok(normalized.includes('B --> C'));
    assert.ok(normalized.includes('C --> D'));
});

test('normalizePeleSource preserves inline %% comments on subgraph lines', () => {
    const src = [
        'flowchart TD',
        '  subgraph sg1 %% keep comment',
        '    A --> B',
        '  end',
        '  subgraph 传统 Agent 的死穴（评论保留） %% trailing note',
        '    C --> D',
        '  end',
    ].join('\n');

    const normalized = normalizePeleSource(src);
    assert.ok(normalized.includes('subgraph sg1 %% keep comment'));
    assert.ok(normalized.includes('subgraph "传统 Agent 的死穴（评论保留）" %% trailing note'));
});

test('normalizePeleSource limits subgraph rewrite to flowchart/graph and handles Chinese/dotted IDs & bracket parens', () => {
    const mindmap = 'mindmap\n  root((中心))\n    subgraph child (note)';
    assert.equal(normalizePeleSource(mindmap), mindmap);

    const flowchart = [
        'flowchart TD',
        '  subgraph 阶段一 [初始化阶段]',
        '    A --> B',
        '  end',
        '  subgraph api.v1 [API v1]',
        '    B --> C',
        '  end',
        '  subgraph sg1 [模块（说明）]',
        '    C --> D',
        '  end',
    ].join('\n');
    const fixed = normalizePeleSource(flowchart);
    assert.ok(fixed.includes('subgraph 阶段一 [初始化阶段]'));
    assert.ok(fixed.includes('subgraph api.v1 [API v1]'));
    assert.ok(fixed.includes('subgraph sg1 ["模块（说明）"]'));
    const rendered = pele.render(fixed);
    assert.ok(rendered.svg.includes('<svg'));

    const multilineLabel = 'flowchart TD\n  A["line1\n  subgraph inside label"] --> B';
    assert.equal(normalizePeleSource(multilineLabel), multilineLabel);
});

test('buildMermaidRepairMessages forbids VCP tool use in the system message', () => {
    const messages = buildMermaidRepairMessages('flowchart TD\n  A -> B', 'Parse error on line 2');
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content.split('\n')[0], '[[VCPToolUse=Forbidden]]');
    assert.equal(messages[1].role, 'user');
    assert.doesNotMatch(messages[1].content, /\[\[VCPToolUse=Forbidden\]\]/);
    assert.match(messages[1].content, /Parse error on line 2/);
    assert.match(messages[1].content, /A -> B/);
});

test('extractMermaidCodeFromReply extracts fenced or raw Mermaid source cleanly', () => {
    assert.equal(
        extractMermaidCodeFromReply('```mermaid\nflowchart TD\n  A --> B\n```'),
        'flowchart TD\n  A --> B'
    );
    assert.equal(
        extractMermaidCodeFromReply('说明文字：\n```\nflowchart LR\n  X --> Y\n```'),
        'flowchart LR\n  X --> Y'
    );
    assert.equal(
        extractMermaidCodeFromReply('flowchart TD\n  P --> Q'),
        'flowchart TD\n  P --> Q'
    );
    assert.equal(
        extractMermaidCodeFromReply(
            '<think>\n草稿：\n```mermaid\nflowchart TD\n  BAD\n```\n</think>\n'
            + '```text\nParse error\n```\n'
            + '````mermaid\nsequenceDiagram\n  Alice->>Bob: Hi\n````'
        ),
        'sequenceDiagram\n  Alice->>Bob: Hi'
    );
    assert.equal(
        extractMermaidCodeFromReply('说明如下：\n```mermaid\nflowchart TD\n  X --> Y'),
        'flowchart TD\n  X --> Y'
    );
    assert.equal(
        extractMermaidCodeFromReply('```mermaid\nflowchart TD\n  A["</think>"] --> B\n```'),
        'flowchart TD\n  A["</think>"] --> B'
    );
});

test('replaceMermaidBlockInMessageContent updates only matching block in string or { text } content including smart-dash source', () => {
    const rawMarkdown = [
        '前文说明',
        '',
        '```mermaid',
        'flowchart TD',
        '  A[开始] —> B[结束]',
        '```',
        '',
        '```mermaid',
        'flowchart LR',
        '  OK1 --> OK2',
        '```',
    ].join('\n');

    // DOM stored dash-normalized originalCode (`-->`)
    const res = replaceMermaidBlockInMessageContent(
        rawMarkdown,
        'flowchart TD\n  A[开始] --> B[结束]',
        'flowchart TD\n  A["开始"] --> B["结束"]'
    );
    assert.equal(res.updated, true);
    assert.ok(res.content.includes('A["开始"] --> B["结束"]'));
    assert.ok(res.content.includes('OK1 --> OK2'));
    assert.ok(res.content.startsWith('前文说明'));

    const objRes = replaceMermaidBlockInMessageContent(
        { text: '<code>\nflowchart TD\n  X -> Y\n</code>', extra: 42 },
        'flowchart TD\n  X -> Y',
        'flowchart TD\n  X --> Y'
    );
    assert.equal(objRes.updated, true);
    assert.equal(objRes.content.extra, 42);
    assert.ok(objRes.content.text.includes('X --&gt; Y'));

    // Handles <code class="language-mermaid">mermaid ...</code> with HTML entities and ignores <think>/tool regions.
    const protectedMsg = [
        '<think>',
        '```mermaid',
        'flowchart TD',
        '  A -> B',
        '```',
        '</think>',
        '[[VCP调用结果信息汇总:tool=FileOperator',
        '```mermaid',
        'flowchart TD',
        '  A -> B',
        '```',
        'VCP调用结果结束]]',
        '正文图表：',
        '<code class="language-mermaid">mermaid\nflowchart TD\n  A -&gt; B\n</code>',
    ].join('\n');
    const protectedRes = replaceMermaidBlockInMessageContent(
        protectedMsg,
        'flowchart TD\n  A -> B',
        'flowchart TD\n  A --> B'
    );
    assert.equal(protectedRes.updated, true);
    assert.ok(protectedRes.content.includes('<think>\n```mermaid\nflowchart TD\n  A -> B\n```\n</think>'));
    assert.ok(protectedRes.content.includes('[[VCP调用结果信息汇总:tool=FileOperator\n```mermaid\nflowchart TD\n  A -> B\n```'));
    assert.ok(protectedRes.content.includes('<code class="language-mermaid">mermaid\nflowchart TD\n  A --&gt; B\n</code>'));

    // Exact offset alignment when inline TOOL_REQUEST precedes Mermaid block + 4-backtick / nested markdown fence guard.
    const sameLineRequestMsg = [
        '前缀<<<[TOOL_REQUEST]>>>tool:「始」x「末」<<<[END_TOOL_REQUEST]>>>后缀',
        '````markdown',
        '```mermaid',
        'flowchart TD',
        '  A -> B',
        '```',
        '````',
        '````mermaid',
        'flowchart TD',
        '  A -> B',
        '````',
    ].join('\n');
    const alignedRes = replaceMermaidBlockInMessageContent(
        sameLineRequestMsg,
        'flowchart TD\n  A -> B',
        'flowchart TD\n  A --> B'
    );
    assert.equal(alignedRes.updated, true);
    assert.ok(alignedRes.content.startsWith('前缀<<<[TOOL_REQUEST]>>>tool:「始」x「末」<<<[END_TOOL_REQUEST]>>>后缀\n````markdown\n```mermaid\nflowchart TD\n  A -> B\n```\n````\n````mermaid\nflowchart TD\n  A --> B\n````'));

    // Quote-aware attribute '>' in <code> and safe HTML escaping on writeback.
    const attrGreaterRes = replaceMermaidBlockInMessageContent(
        '<code data-x="a>b" class="language-mermaid">flowchart TD\n  A -&gt; B\n</code>',
        'flowchart TD\n  A -> B',
        'flowchart TD\n  A["<style>.x{}</style>"] --> B'
    );
    assert.equal(attrGreaterRes.updated, true);
    assert.ok(attrGreaterRes.content.includes('<code data-x="a>b" class="language-mermaid">mermaid\nflowchart TD\n  A["&lt;style&gt;.x{}&lt;/style&gt;"] --&gt; B\n</code>'));

    // CRLF fenced blocks repair and preserve \r\n endings.
    const crlfRes = replaceMermaidBlockInMessageContent(
        '前文\r\n\r\n```mermaid\r\nflowchart TD\r\n  A -> B\r\n```\r\n\r\n后文',
        'flowchart TD\n  A -> B',
        'flowchart TD\n  A --> B'
    );
    assert.equal(crlfRes.updated, true);
    assert.equal(crlfRes.content, '前文\r\n\r\n```mermaid\r\nflowchart TD\r\n  A --> B\r\n```\r\n\r\n后文');

    // Inline HTML <code> prose phrases must never be rewritten as Mermaid charts.
    const proseCodeRes = replaceMermaidBlockInMessageContent(
        '<td><code>graph database</code></td>',
        'graph database',
        'graph TD\n  A --> B'
    );
    assert.equal(proseCodeRes.updated, false);
});

test('patchMessageMermaidContent synchronizes assistantSegments and content for hosted tool messages', () => {
    const seg0 = { content: '前置分析\n' };
    const seg1 = { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }] };
    const seg2 = { content: '<<<[VCP_TOOL_BATCH_START:1]>>>\n```mermaid\nflowchart TD\n  A -> B\n```\n<<<[VCP_TOOL_BATCH_END:1]>>>', receipt: true };
    const seg3 = { content: '\n最终总结图表：\n```mermaid\nflowchart TD\n  A -> B\n```' };
    const msg = {
        id: 'm1',
        role: 'assistant',
        content: [seg0.content, seg2.content, seg3.content].join(''),
        assistantSegments: [seg0, seg1, seg2, seg3],
    };

    const patched = patchMessageMermaidContent(msg, 'flowchart TD\n  A -> B', 'flowchart TD\n  A --> B');
    assert.equal(patched.updated, true);
    assert.equal(patched.message.assistantSegments[2].content, seg2.content);
    assert.ok(patched.message.assistantSegments[3].content.includes('A --> B'));
    const flat = patched.message.assistantSegments.map((s) => s.content ?? '').join('');
    assert.equal(flat, patched.message.content);
});

test('repairMermaidDiagram disables AI call when mermaidRepairModel is empty', async () => {
    let called = false;
    const res = await repairMermaidDiagram({
        code: 'flowchart TD\n  A -> B',
        errorMessage: 'Parse error',
        settings: { mermaidRepairModel: '   ', vcpServerUrl: 'http://127.0.0.1:6005/v1/chat/completions' },
        pele,
        vcpChatUrlFn: (url) => url,
        fetchImpl: async () => {
            called = true;
            throw new Error('should not be called');
        },
    });
    assert.equal(called, false);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'disabled');
});

test('repairMermaidDiagram calls configured small model and validates fixed source with pele.render', async () => {
    let capturedRequest = null;
    const res = await repairMermaidDiagram({
        code: 'flowchart TD\n  A -> B',
        errorMessage: 'Parse error on line 2',
        settings: {
            mermaidRepairModel: 'gpt-4o-mini',
            vcpServerUrl: 'http://127.0.0.1:6005',
            vcpApiKey: 'test-key',
        },
        pele,
        vcpChatUrlFn: (base) => `${base}/v1/chat/completions`,
        fetchImpl: async (url, init) => {
            capturedRequest = { url, init, body: JSON.parse(init.body) };
            return {
                ok: true,
                json: async () => ({
                    choices: [{
                        message: {
                            content: '```mermaid\nflowchart TD\n  A --> B\n```',
                        },
                    }],
                }),
            };
        },
    });

    assert.equal(res.ok, true);
    assert.equal(res.code, 'flowchart TD\n  A --> B');
    assert.ok(res.svg.includes('<svg'));
    assert.equal(capturedRequest.url, 'http://127.0.0.1:6005/v1/chat/completions');
    assert.equal(capturedRequest.init.headers.Authorization, 'Bearer test-key');
    assert.equal(capturedRequest.body.model, 'gpt-4o-mini');
    assert.equal(capturedRequest.body.stream, false);
});

test('repairMermaidDiagram rejects fixed output if local pele.render still fails', async () => {
    const res = await repairMermaidDiagram({
        code: 'flowchart TD\n  A -> B',
        errorMessage: 'Parse error',
        settings: {
            mermaidRepairModel: 'gpt-4o-mini',
            vcpServerUrl: 'http://127.0.0.1:6005',
        },
        pele,
        vcpChatUrlFn: (base) => `${base}/v1/chat/completions`,
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({
                choices: [{
                    message: {
                        content: '```mermaid\nflowchart TD\n  A ->->-> B\n```',
                    },
                }],
            }),
        }),
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid-syntax');
});

test('repairMermaidDiagram feeds secondary Pele compiler error into second attempt and recovers', async () => {
    const requests = [];
    const res = await repairMermaidDiagram({
        code: 'flowchart TD\n  A[标签(1)] ->-> B',
        errorMessage: 'Initial parse error',
        settings: {
            mermaidRepairModel: 'Qwen3-8B',
            vcpServerUrl: 'http://127.0.0.1:6005',
        },
        pele,
        vcpChatUrlFn: (base) => `${base}/v1/chat/completions`,
        fetchImpl: async (_url, init) => {
            const body = JSON.parse(init.body);
            requests.push(body);
            const reply = requests.length === 1
                ? '```mermaid\nflowchart TD\n  A["标签(1)"] ->-> B\n```'
                : '```mermaid\nflowchart TD\n  A["标签(1)"] --> B\n```';
            return {
                ok: true,
                json: async () => ({ choices: [{ message: { content: reply } }] }),
            };
        },
    });

    assert.equal(requests.length, 2);
    for (const body of requests) {
        assert.equal(body.messages[0].role, 'system');
        assert.equal(body.messages[0].content.split('\n')[0], '[[VCPToolUse=Forbidden]]');
        assert.equal(body.tool_choice, 'none');
        assert.equal(body.function_call, null);
        assert.equal(Object.hasOwn(body, 'tools'), false);
        assert.equal(Object.hasOwn(body, 'functions'), false);
    }
    assert.equal(requests[1].messages.length, 4);
    assert.match(requests[1].messages[3].content, /最新报错如下/);
    assert.equal(res.ok, true);
    assert.equal(res.code, 'flowchart TD\n  A["标签(1)"] --> B');
    assert.ok(res.svg.includes('<svg'));
});

test('repairMermaidDiagram handles AbortError and HTTP errors cleanly', async () => {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    const aborted = await repairMermaidDiagram({
        code: 'flowchart TD\n  A -> B',
        errorMessage: 'Parse error',
        settings: { mermaidRepairModel: 'mini', vcpServerUrl: 'http://127.0.0.1:6005' },
        pele,
        vcpChatUrlFn: (base) => `${base}/v1/chat/completions`,
        fetchImpl: async () => { throw abortErr; },
    });
    assert.equal(aborted.ok, false);
    assert.equal(aborted.reason, 'aborted');

    const httpErr = await repairMermaidDiagram({
        code: 'flowchart TD\n  A -> B',
        errorMessage: 'Parse error',
        settings: { mermaidRepairModel: 'mini', vcpServerUrl: 'http://127.0.0.1:6005' },
        pele,
        vcpChatUrlFn: (base) => `${base}/v1/chat/completions`,
        fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    assert.equal(httpErr.ok, false);
    assert.equal(httpErr.reason, 'http-error');

    const badUrlErr = await repairMermaidDiagram({
        code: 'flowchart TD\n  A -> B',
        errorMessage: 'Parse error',
        settings: { mermaidRepairModel: 'mini', vcpServerUrl: 'not-a-valid-url' },
        pele,
        vcpChatUrlFn: () => { throw new TypeError('Invalid URL'); },
    });
    assert.equal(badUrlErr.ok, false);
    assert.equal(badUrlErr.reason, 'missing-endpoint');

    const timeoutErr = await repairMermaidDiagram({
        code: 'flowchart TD\n  A -> B',
        errorMessage: 'Parse error',
        settings: { mermaidRepairModel: 'mini', vcpServerUrl: 'http://127.0.0.1:6005' },
        pele,
        timeoutMs: 25,
        vcpChatUrlFn: (base) => `${base}/v1/chat/completions`,
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
            }, { once: true });
        }),
    });
    assert.equal(timeoutErr.ok, false);
    assert.equal(timeoutErr.reason, 'timeout');
});
