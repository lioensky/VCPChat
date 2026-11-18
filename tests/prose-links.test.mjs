import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { linkProseUrls } from '../modules/renderer/proseLinks.js';
import { createContentProcessor } from '../modules/renderer/contentProcessor.js';

const hrefs = root => [...root.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'));

test('bare URLs in AI-written HTML prose become links that end at Chinese punctuation', () => {
    const dom = new JSDOM('<div class="md-content"><div style="border:1px solid"><h3>参考资料</h3>'
        + '<p>项目主页：https://github.com/lioensky/VCPChat</p>'
        + '<p>安装说明在 https://github.com/lioensky/VCPChat/blob/main/README.md，先看第一节。</p>'
        + '<p>两个地址 https://a.org/x，https://b.org/y。</p>'
        + '<p>(见 https://en.wikipedia.org/wiki/Foo_(bar)) 和 https://x.org/p.</p></div></div>');
    const root = dom.window.document.querySelector('.md-content');
    linkProseUrls(root);
    assert.deepEqual(hrefs(root), [
        'https://github.com/lioensky/VCPChat',
        'https://github.com/lioensky/VCPChat/blob/main/README.md',
        'https://a.org/x',
        'https://b.org/y',
        'https://en.wikipedia.org/wiki/Foo_(bar)',
        'https://x.org/p',
    ]);
    assert.match(root.textContent, /README\.md，先看第一节。/);
    linkProseUrls(root);
    assert.equal(root.querySelectorAll('a').length, 6, 'running again adds nothing');
    dom.window.close();
});

test('code, existing links, controls, scripts, tool blocks and other schemes stay untouched', () => {
    const dom = new JSDOM('<div class="md-content"><pre>https://example.org/pre</pre>'
        + '<p><code>https://example.org/code</code></p><button>https://example.org/button</button>'
        + '<script>const x = "https://example.org/script";</script><textarea>https://example.org/t</textarea>'
        + '<div class="vcp-tool-result-bubble">https://example.org/tool</div>'
        + '<a href="https://example.org/existing">existing</a><p>javascript:alert(1) ftp://example.org/f</p></div>');
    const root = dom.window.document.querySelector('.md-content');
    linkProseUrls(root);
    assert.deepEqual(hrefs(root), ['https://example.org/existing']);
    dom.window.close();
});

test('post-render processing links bare URLs in HTML prose', () => {
    const dom = new JSDOM('<div class="md-content"><div><p>项目主页：https://github.com/lioensky/VCPChat</p></div></div>');
    const root = dom.window.document.querySelector('.md-content');
    const processor = createContentProcessor();
    processor.initializeContentProcessor({ chatMessagesDiv: root, messageCommands: {}, uiHelper: {} });
    processor.processRenderedContent(root, {}, { skipMath: true });
    assert.deepEqual(hrefs(root), ['https://github.com/lioensky/VCPChat']);
    processor.dispose();
    dom.window.close();
});
