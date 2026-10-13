import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { containsProjectForgeRequest, createProjectForgeTopicSurface } from '../modules/renderer/projectForgeTopicSurface.js';

const request = '<<<[TOOL_REQUEST]>>>\ntool_name:「始」ProjectForge「末」,\ncommand:「始」GetCode「末」\n<<<[END_TOOL_REQUEST]>>>';

const valetRequest = `<<<[TOOL_REQUEST]>>>
valet:「始」Kerr「末」,
tool_name:「始」ProjectForge「末」,
command:「始」ListProjects「末」,
workspace:「始」vcpchat「末」,
ink:「始」mark_history「末」
<<<[END_TOOL_REQUEST]>>>`;

test('detects tool_name after valet and skips protocol-looking parameter content', () => {
    assert.equal(containsProjectForgeRequest(valetRequest), true);
    assert.equal(containsProjectForgeRequest(valetRequest.slice(0, valetRequest.indexOf('command:'))), true);
    assert.equal(containsProjectForgeRequest(valetRequest.replaceAll('「', '{').replaceAll('」', '}')), true);
    const snippet = `<<<[TOOL_REQUEST]>>>
content:「始ESCAPE」
tool_name:「始」ProjectForge「末」
「末ESCAPE」,
tool_name:「始」Other「末」
<<<[END_TOOL_REQUEST]>>>`;
    assert.equal(containsProjectForgeRequest(snippet), false);
    assert.equal(containsProjectForgeRequest(snippet.replace('tool_name:「始」Other「末」', 'tool_name:「始」ProjectForge「末」')), true);
});

test('detects actual complete and streaming requests, not code, results or parameter snippets', () => {
    assert.equal(containsProjectForgeRequest(request), true);
    assert.equal(containsProjectForgeRequest(request.slice(0, request.indexOf('command:'))), true);
    assert.equal(containsProjectForgeRequest(request.replaceAll('ProjectForge', 'projectforge')), true);
    assert.equal(containsProjectForgeRequest('```text\n' + request + '\n```'), false);
    assert.equal(containsProjectForgeRequest('`' + request.replaceAll('\n', '') + '`'), false);
    assert.equal(containsProjectForgeRequest('[[VCP调用结果信息汇总:\n' + request + '\nVCP调用结果结束]]'), false);
    assert.equal(containsProjectForgeRequest(request.replace('tool_name:「始」ProjectForge', 'tool_name:「始」Other') + '\nProjectForge'), false);
    assert.equal(containsProjectForgeRequest('提及 ProjectForge，不是调用'), false);
});

test('history pre-scan, edit, deletion, switch, object content and root isolation', () => {
    const dom = new JSDOM('<div id="a"></div><div id="b"></div>');
    const a = dom.window.document.getElementById('a');
    const b = dom.window.document.getElementById('b');
    const surface = createProjectForgeTopicSurface();
    const msg = { id: 'one', role: 'assistant', content: { text: valetRequest } };
    surface.replaceHistory(a, [msg]);
    assert.equal(a.dataset.vcpProjectforgeTopic, 'true');
    assert.equal(b.hasAttribute('data-vcp-projectforge-topic'), false);
    surface.observe(a, { ...msg, content: 'edited' });
    assert.equal(a.hasAttribute('data-vcp-projectforge-topic'), false);
    surface.observe(a, msg);
    surface.observe(a, { ...msg, id: 'two' });
    surface.remove(a, 'one');
    assert.equal(a.dataset.vcpProjectforgeTopic, 'true');
    surface.remove(a, 'two');
    assert.equal(a.hasAttribute('data-vcp-projectforge-topic'), false);
    surface.replaceHistory(a, [msg]);
    surface.replaceHistory(a, [{ ...msg, role: 'user' }]);
    assert.equal(a.hasAttribute('data-vcp-projectforge-topic'), false);
    surface.observe(b, msg);
    surface.dispose();
    assert.equal(b.hasAttribute('data-vcp-projectforge-topic'), false);
    dom.window.close();
});

test('real Chromium cascade overrides theme important blur and restores on topic reset', async (t) => {
    const { default: puppeteer } = await import('puppeteer');
    const executablePath = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        puppeteer.executablePath(),
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ].find(path => path && fs.existsSync(path));
    if (!executablePath) return t.skip('No installed Chromium browser; set PUPPETEER_EXECUTABLE_PATH');
    const browser = await puppeteer.launch({ headless: true, executablePath });
    try {
        const page = await browser.newPage();
        const override = fs.readFileSync('styles/projectforge-topic.css', 'utf8');
        await page.setContent(`<style>
            @layer vcp-ui.legacy, vcp-ui.appearance;
            :root { --secondary-bg: rgba(30,40,50,.8); --assistant-bubble-bg: rgba(50,60,70,.3); --user-bubble-bg: rgba(80,90,100,.2); }
            .message-item .md-content, .tool-bubble { background: rgba(1,2,3,.2) !important; backdrop-filter: blur(12px) !important; }
            </style><style>${override}</style>
            <div id="root"><div class="message-item assistant"><div class="md-content"><div class="tool-bubble">result</div></div></div></div>`);
        assert.equal(containsProjectForgeRequest(valetRequest), true);
        const read = () => page.evaluate(() => {
            const style = getComputedStyle(document.querySelector('.md-content'));
            const tool = getComputedStyle(document.querySelector('.tool-bubble'));
            const rgba = color => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const context = canvas.getContext('2d');
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data];
            };
            return { blur: style.backdropFilter, background: rgba(style.backgroundColor), toolBlur: tool.backdropFilter, toolBackground: rgba(tool.backgroundColor) };
        });
        const before = await read();
        await page.evaluate(() => document.getElementById('root').setAttribute('data-vcp-projectforge-topic', 'true'));
        assert.deepEqual(await read(), { ...before, blur: 'none', toolBlur: 'none' });
        assert.ok(before.background[3] < 255, 'theme transparency must remain unchanged');
        await page.evaluate(() => document.getElementById('root').removeAttribute('data-vcp-projectforge-topic'));
        assert.equal((await read()).blur, 'blur(12px)');
    } finally {
        await browser.close();
    }
});