import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';

test('ordinary export extracts panel labels without stripping HTML code examples', async () => {
    const { window } = new JSDOM('', { runScripts: 'outside-only' });
    try {
        window.marked = marked;
        window.eval(readFileSync(new URL('../modules/topicListManager.js', import.meta.url), 'utf8'));
        const panel = '<div><style>.panel{color:red}</style><div style="color:red">面板标题</div><svg><polygon points="0,1 1,0"/><text>交集收缩核</text></svg><p>保留 $n$ 张图。</p></div>';
        const example = '```html\n' + panel + '\n```';
        const inline = '`<div>行内代码</div>`';
        const image = '<img src="https://example.invalid/private/image.png" width="105">';
        const media = `前${image}后，示例：\`${image}\`。`;
        let exported;
        window.topicListManager.init({
            elements: { topicListContainer: window.document.createElement('section') },
            refs: {}, mainRendererFunctions: {}, topicSelectionReadiness: {},
            chatRepository: { getHistory: () => [
                { role: 'user', content: [example, panel, inline, media].join('\n\n') },
                { role: 'assistant', content: image },
            ] },
            electronAPI: { exportTopicAsMarkdown: payload => { exported = payload; return { success: true }; } },
            uiHelper: { showToastNotification() {} },
        });
        await window.topicListManager.handleExportTopic('a', 'agent', 't', '测试', {});
        assert.equal(exported.markdownContent,
            `# 话题: 测试\n\n**用户**: ${example}\n\n面板标题\n交集收缩核\n保留 $n$ 张图。\n\n${inline}\n\n前后，示例：\`${image}\`。\n\n---\n\n`);
    } finally {
        window.close();
    }
});