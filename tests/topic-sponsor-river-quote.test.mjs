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

test('TopicSponsor delivers a text quote before the return address without image bytes', async () => {
    const submitted = [];
    const deliver = createTopicSponsorDelivery({
        admission: { submit: async entry => (submitted.push(entry), { success: true }) },
        resolver: { resolve: async ({ topicId }) => ({ scope: { itemType: 'agent', itemId: 'nova', topicId } }) },
        findAgent: async name => ({ id: 'kerr', name }),
    });
    const nested = formatTopicRiverQuote([{ role: 'user', content: 'old quote' }]);
    await deliver({
        sender_name: 'Kerr', topic_id: 'topic_target', source_topic_id: 'topic_source', message: '请排查',
        river_context: [
            { role: 'system', content: 'do not forward' },
            { role: 'user', content: [{ type: 'text', text: `图片\n[附加图片: ${image}]` }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
            { role: 'assistant', content: `答复<style>.bad {}</style><script>bad()</script> data:image/png;base64,BBBB\n\n${nested}` },
        ],
    });
    const { role, content, attachments } = submitted[0].message;
    assert.equal(role, 'assistant');
    assert.equal(attachments, undefined);
    const parsed = extractTopicRiverQuote(content);
    assert.equal(parsed.source, '[Kerr的发言]:\n请排查\n\n[该发言发送自topic_source话题]');
    assert.deepEqual(parsed.rows, [
        { role: 'user', content: `图片\n[附加图片: ${image}]` },
        { role: 'assistant', content: '答复' },
    ]);
});

test('history worker composes a closed two-level quote without executing or expanding quoted markup', async () => {
    const rows = [{ role: 'user', content: `看图 ${image}\n<b>文本</b>` }];
    const quote = formatTopicRiverQuote(rows);
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
        assert.equal(card.querySelector('.vcp-topic-river-text')?.textContent, rows[0].content);
        assert.equal(card.querySelector('img,b'), null);
        assert.doesNotMatch(root.textContent, /该发言发送自/);
    } finally {
        dom.window.close();
    }
});

test('only the last complete suffix is interpreted', () => {
    const quote = formatTopicRiverQuote([{ role: 'assistant', content: 'ok' }]);
    const body = '先解释标记：\n\n[VCP_TOPIC_RIVER_V1]\n它是一个例子';
    assert.equal(extractTopicRiverQuote(`${body}\n\n${quote}`).source, body);
    assert.equal(extractTopicRiverQuote(`${body}\n\n${quote}\n恢复正文`), null);
});