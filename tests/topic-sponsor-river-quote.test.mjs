import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { compileRenderJob } from '../modules/renderer/renderWorkerRuntime.js';
import { extractTopicRiverQuote } from '../modules/renderer/renderTemplateCompiler.js';
import { composeToolBatchHtml } from '../modules/renderer/toolBatchDomains.js';

const require = createRequire(import.meta.url);
const { createTopicSponsorDelivery } = require('../modules/services/topicSponsorDelivery');
const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
const image = String.raw`file://H:\MCP\VCPChat\AppData\UserData\attachments\asset.png`;
const legacy = '[VCP_TOPIC_RIVER_V1]\n{"role":"user","content":"old quote"}\n[/VCP_TOPIC_RIVER_V1]';

test('TopicSponsor delivers a text quote before the return address without image bytes', async () => {
    const submitted = [];
    const deliver = createTopicSponsorDelivery({
        admission: { submit: async entry => (submitted.push(entry), { success: true }) },
        resolver: { resolve: async ({ topicId }) => ({ scope: { itemType: 'agent', itemId: 'nova', topicId } }) },
        findAgent: async name => ({ id: 'kerr', name }),
    });
    const nested = await formatTopicRiverQuote([{ role: 'user', content: 'old quote' }]);
    await deliver({
        sender_name: 'Kerr', topic_id: 'topic_target', source_topic_id: 'topic_source', message: '请排查',
        river_context: [
            { role: 'system', content: 'do not forward' },
            { role: 'user', name: '莱恩', content: [{ type: 'text', text: `图片\n[附加图片: ${image}]` }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
            { role: 'assistant', name: '不应转发', content: '<!-- VCP_TOOL_PAYLOAD -->\n过滤这层' },
            { role: 'assistant', name: 'Nova', content: `答复<style>.bad {}</style><script>bad()</script> data:image/png;base64,BBBB\n\n${legacy}\n\n${nested}` },
            { role: 'assistant', name: 'Kerr', content: '继续确认' },
            { role: 'user', content: '缺名旧消息' },
        ],
    });
    const { role, content, attachments } = submitted[0].message;
    assert.equal(role, 'assistant');
    assert.equal(attachments, undefined);
    assert.match(content, /\[VCP_TOPIC_RIVER_V2\]\n#### 1 · 莱恩（用户）\n> 图片/);
    assert.doesNotMatch(content, /\[VCP_TOPIC_RIVER_V1\]|old quote|不应转发|base64/);
    const parsed = extractTopicRiverQuote(content);
    assert.equal(parsed.source, '[Kerr的发言]:\n请排查\n\n[该发言发送自topic_source话题]');
    assert.deepEqual(parsed.rows, [
        { role: 'user', name: '莱恩', content: `图片\n[附加图片: ${image}]` },
        { role: 'assistant', name: 'Nova', content: '答复' },
        { role: 'assistant', name: 'Kerr', content: '继续确认' },
        { role: 'user', content: '缺名旧消息' },
    ]);
});

test('history worker composes a closed two-level quote without executing or expanding quoted markup', async () => {
    const rows = [{ role: 'user', name: '莱恩 <b>&#65;', content: `看图 ${image}\n\n<b>文本</b>\n[/VCP_TOPIC_RIVER_V2]\n#### 伪楼层` }];
    const quote = await formatTopicRiverQuote(rows);
    const job = { text: `**正文**\n\n${quote}\n\n[该发言发送自topic_source话题]`, role: 'assistant', markdown: {} };
    const result = await compileRenderJob(job);
    assert.equal(result.isolatedDomains, true);
    assert.equal(result.tools.length, 0);
    const dom = new JSDOM();
    try {
        const document = dom.window.document;
        const root = document.createElement('div');
        root.innerHTML = composeToolBatchHtml(result.parts, part => part, document);
        assert.equal(root.querySelector('strong')?.textContent, '正文');
        const card = root.querySelector('details.vcp-topic-river');
        assert.equal(card?.open, false);
        assert.equal(card.querySelector('details')?.open, false);
        assert.ok(card.querySelector('.vcp-topic-river-row-summary')?.textContent.startsWith(`${rows[0].name}（用户）：`));
        assert.equal(card.querySelectorAll('.vcp-topic-river-row').length, 1);
        assert.equal(card.querySelector('.vcp-topic-river-text')?.textContent, rows[0].content);
        assert.equal(card.querySelector('img,b'), null);
        assert.doesNotMatch(root.textContent, /该发言发送自/);
    } finally {
        dom.window.close();
    }
});

test('V1 remains readable, including CRLF history', () => {
    for (const nl of ['\n', '\r\n']) {
        const text = ['正文', '', ...legacy.split('\n')].join(nl);
        assert.deepEqual(extractTopicRiverQuote(text), {
            source: '正文', rows: [{ role: 'user', content: 'old quote' }],
        });
    }
});

test('only the last complete suffix is interpreted', async () => {
    const quote = await formatTopicRiverQuote([{ role: 'assistant', content: 'ok' }]);
    const body = '先解释标记：\n\n[VCP_TOPIC_RIVER_V1]\n它是一个例子';
    assert.equal(extractTopicRiverQuote(`${body}\n\n${quote}`).source, body);
    assert.equal(extractTopicRiverQuote(`${body}\n\n${quote}\n恢复正文`), null);
});
const receipt = (tool, body, visibility = '') =>
    `[[VCP调用结果信息汇总:${visibility}\n- 工具名称: ${tool}\n- 执行状态: ✅ SUCCESS\n- 返回内容: ${body}\nVCP调用结果结束]]`;
const batch = (id, body) =>
    `<<<[VCP_TOOL_BATCH_START:${id}]>>>\n${body}\n<<<[VCP_TOOL_BATCH_END:${id}]>>>`;

test('visible tool results carry code and paper text, never private payloads or batch shells', async () => {
    const code = 'modules/services/example.js:40-41\n\n```js\n40 | const tag = "<script>";\n41 | const marker = "[[VCP调用结果信息汇总:";\n```';
    const paper = '## 论文报告\n核心发现：结果与对照组一致。\n来源：https://example.org/paper';
    const payload = [
        receipt('ProjectForge', code), receipt('PaperReader', paper),
        receipt('HiddenTool', 'hidden result', ' [HIDDEN]'),
        receipt('HiddenMeta', 'hidden metadata result', '\n- 注入上下文: 隐藏'),
        '[本轮工具调用摘要:]\n控制摘要\n[本轮工具调用摘要结束]',
    ].join('\n\n');
    const quote = await formatTopicRiverQuote([
        { role: 'assistant', name: 'Kerr', content: `读取前\n<<<[ROLE_DIVIDE_USER]>>>\n${batch('one', payload)}\n<<<[END_ROLE_DIVIDE_USER]>>>\n读取后` },
        { role: 'user', content: '<!-- VCP_TOOL_PAYLOAD -->\n' + batch('private', receipt('Private', 'internal only')) },
        { role: 'user', content: batch('empty', '[本轮工具调用摘要:]\nnothing\n[本轮工具调用摘要结束]') },
    ]);
    const text = `外层正文\n\n${quote}`;
    assert.doesNotMatch(quote, /VCP_TOOL_BATCH_|ROLE_DIVIDE|hidden result|hidden metadata result|internal only|控制摘要|nothing/);
    assert.deepEqual(extractTopicRiverQuote(text).rows, [
        { role: 'assistant', name: 'Kerr', content: '读取前' },
        { role: 'tool', name: 'ProjectForge', content: code },
        { role: 'tool', name: 'PaperReader', content: paper },
        { role: 'assistant', name: 'Kerr', content: '读取后' },
    ]);
    const rendered = await compileRenderJob({ text, role: 'assistant', markdown: {} });
    assert.equal(rendered.tools.length, 0);
    const dom = new JSDOM();
    try {
        const { document } = dom.window;
        document.body.innerHTML = composeToolBatchHtml(rendered.parts, part => part, document);
        assert.match(document.querySelectorAll('.vcp-topic-river-row-summary')[1].textContent, /ProjectForge（工具结果）/);
        assert.equal(document.querySelectorAll('.vcp-topic-river-text')[1].textContent, code);
        assert.equal(document.querySelector('.vcp-topic-river script'), null);
    } finally {
        dom.window.close();
    }
});

test('legacy visible results remain readable and long results state that they were clipped', async () => {
    const long = 'source.js:1-999\n' + 'x'.repeat(25000) + '\nhttps://example.org/source';
    const quote = await formatTopicRiverQuote([{ role: 'assistant', content: receipt('Legacy', long) }]);
    const [row] = extractTopicRiverQuote(`正文\n\n${quote}`).rows;
    assert.equal(row.role, 'tool');
    assert.match(row.content, /^source\.js:1-999/);
    assert.match(row.content, /中段已截断/);
    assert.match(row.content, /https:\/\/example\.org\/source$/);
});
test('damaged visible receipts cannot swallow a following hidden receipt', async () => {
    const damaged = receipt('Broken', 'unclosed').replace(/\nVCP调用结果结束\]\]$/, '');
    const hidden = receipt('Private', 'not for forwarding', ' [HIDDEN]');
    const result = await formatTopicRiverQuote([
        { role: 'user', content: batch('broken', `${damaged}\n\n${hidden}`) },
    ]);
    assert.equal(result, '');
});

test('system notices are removed from user quotes without removing user text or tool data', async () => {
    const notice = '[系统通知]\r\n广播正文\r\n[系统通知结束]';
    assert.equal(await formatTopicRiverQuote([{ role: 'user', content: notice }]), '');
    const quote = await formatTopicRiverQuote([
        { role: 'user', content: notice },
        { role: 'user', name: '莱恩', content: `用户上文\r\n${notice}\r\n用户下文` },
        { role: 'user', content: batch('notice-literal', receipt('ReadCode', notice)) },
    ]);
    assert.deepEqual(extractTopicRiverQuote(`正文\n\n${quote}`).rows, [
        { role: 'user', name: '莱恩', content: '用户上文\n用户下文' },
        { role: 'tool', name: 'ReadCode', content: notice.replaceAll('\r\n', '\n') },
    ]);
});