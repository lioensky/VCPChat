import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(import.meta.dirname, '..');

async function createRenderer(dom) {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Image = dom.window.Image;

    const moduleUrl = pathToFileURL(path.join(root, 'modules/messageRenderer.js')).href;
    const { createMessageRenderer } = await import(moduleUrl);
    return createMessageRenderer({
        streamManager: {
            dispose: async () => {},
        },
        enableContextMenu: false,
        enableMiddleClick: false,
        initializeStreamProjection: false,
        exposeGlobalCommands: false,
    });
}

test('共享 TTS 提取器跳过所有协议块、@tag 与无换行工具协议残留', async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const content = dom.window.document.createElement('div');
    content.className = 'md-content';
    content.innerHTML = `
        <p>可朗读前文 @Nova 继续正文 <span class="highlighted-alert-tag">@!紧急</span></p>
        <div data-vcp-block-type="tool-use">工具请求机密</div>
        <div data-vcp-block-type="tool-result">工具返回机密</div>
        <div data-vcp-block-type="tool-call-summary">工具摘要机密</div>
        <div data-vcp-block-type="role-divider">角色分割机密</div>
        <div data-vcp-block-type="flowlock">心流锁机密</div>
        <div data-vcp-block-type="maid-diary-update">日记更新机密</div>
        <div data-vcp-block-type="thought-chain">思维链机密</div>
        <p>前文紧贴<<<[TOOL_REQUEST]>>>tool_name:「始」Demo「末」,command:「始」Run「末」<<<[END_TOOL_REQUEST]>>>后文保留</p>
        <p>[[VCP调用结果信息汇总:- 工具名称: Demo
        - 返回内容: 原始返回机密VCP调用结果结束]]</p>
        <p>[本轮工具调用摘要:]原始摘要机密[本轮工具调用摘要结束]</p>
        <p><<<[ROLE_DIVIDE_SYSTEM]>>>角色协议正文<<<[END_ROLE_DIVIDE_SYSTEM]>>></p>
    `;

    const renderer = await createRenderer(dom);
    const text = renderer.extractSpeakableTextFromContentElement(content);

    assert.match(text, /可朗读前文/);
    assert.match(text, /继续正文/);
    assert.match(text, /前文紧贴/);
    assert.match(text, /后文保留/);
    assert.match(text, /角色协议正文/);
    assert.doesNotMatch(
        text,
        /Nova|紧急|工具请求机密|工具返回机密|工具摘要机密|角色分割机密|心流锁机密|日记更新机密|思维链机密|原始返回机密|原始摘要机密|TOOL_REQUEST|VCP调用结果|工具调用摘要|ROLE_DIVIDE/
    );

    renderer.disposeRendererResources();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Image;
});

test('消息渲染器将中键朗读接入共享提取器并兼容真实头像类停止 TTS', () => {
    const source = fs.readFileSync(
        path.join(root, 'modules/messageRenderer.js'),
        'utf8'
    );
    const middleClickSource = fs.readFileSync(
        path.join(root, 'modules/renderer/middleClickHandler.js'),
        'utf8'
    );

    assert.match(
        source,
        /e\.target\.closest\(['"]\.chat-avatar,\s*\.message-avatar['"]\)/
    );
    assert.match(
        source,
        /middleClickHandler\.initialize\([\s\S]*?extractSpeakableTextFromContentElement/
    );
    assert.match(
        middleClickSource,
        /callbacks\.extractSpeakableTextFromContentElement\(contentDiv\)/
    );
});