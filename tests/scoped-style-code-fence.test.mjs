import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import { replaceMarkdownCodeDomains } from '../modules/renderer/markdownCodeDomainScanner.js';

const STYLE_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const RUNTIME_STYLE_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

/**
 * 复刻 messageRenderer.processAssistantScopedHtmlContent() 的关键顺序：
 * 1. Markdown code domain 整体替换为保护占位符；
 * 2. 仅在剩余普通域中提取运行态 style；
 * 3. 用 split/join 原样恢复 code domain。
 */
function protectThenExtractStyles(source) {
    const protectedBlocks = [];
    const selectedCodeDomains = [];

    const protectedSource = replaceMarkdownCodeDomains(source, (domain, metadata) => {
        const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
        protectedBlocks.push(domain);
        selectedCodeDomains.push({ domain, metadata, placeholder });
        return placeholder;
    });

    const selectedRuntimeStyles = [];
    const sourceWithoutRuntimeStyles = protectedSource.replace(RUNTIME_STYLE_REGEX, (match, css) => {
        selectedRuntimeStyles.push({ match, css });
        return '<!-- VCP-SCOPED-STYLE-EXTRACTED -->';
    });

    let restoredSource = sourceWithoutRuntimeStyles;
    // 嵌套保护域必须遵循 LIFO：先展开外层代码围栏，再恢复围栏内部注释。
    for (let index = protectedBlocks.length - 1; index >= 0; index--) {
        restoredSource = restoredSource
            .split(`__VCP_STYLE_PROTECT_${index}__`)
            .join(protectedBlocks[index]);
    }

    return {
        protectedSource,
        restoredSource,
        selectedCodeDomains,
        selectedRuntimeStyles
    };
}

test('HTML fenced demo protects its style as code and restores it byte-for-byte', () => {
    const source = [
        '下面是一个完整网页演示：',
        '',
        '```html',
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '<style>',
        '  :root { --accent: #7c3aed; }',
        '  body { margin: 0; background: #111827; }',
        '  .card:hover { transform: translateY(-2px); }',
        '</style>',
        '</head>',
        '<body><article class="card">Demo</article></body>',
        '</html>',
        '```',
        '',
        '围栏后的正文仍然存在。'
    ].join('\n');

    const result = protectThenExtractStyles(source);

    assert.equal(
        result.selectedCodeDomains.length,
        1,
        '完整 ```html 围栏应被 Markdown code-domain 扫描器整体选中'
    );
    assert.equal(result.selectedCodeDomains[0].metadata.kind, 'fence');
    assert.equal(result.selectedCodeDomains[0].metadata.closed, true);
    assert.equal(
        result.selectedRuntimeStyles.length,
        0,
        '围栏内部 <style> 不得被运行态 CSS 提取器选中'
    );
    assert.equal(
        result.protectedSource.includes('<style>'),
        false,
        'CSS 提取阶段不应看见围栏内部的 <style>'
    );
    assert.equal(
        result.restoredSource,
        source,
        '保护占位符必须恢复为逐字节相同的原始 Markdown'
    );
    assert.equal(
        result.restoredSource.includes('VCP-SCOPED-STYLE-EXTRACTED'),
        false,
        '恢复结果中不得出现 style 提取注释'
    );

    const renderedHtml = marked.parse(result.restoredSource);
    const dom = new JSDOM(`<body><main id="content">${renderedHtml}</main></body>`);
    const code = dom.window.document.querySelector('pre > code.language-html');

    assert.ok(code, '恢复后的 Markdown 应生成 language-html 代码块');
    assert.equal(
        code.textContent.includes('<style>'),
        true,
        '最终 HTML 代码节点必须保留 <style> 开始标签'
    );
    assert.equal(
        code.textContent.includes('</style>'),
        true,
        '最终 HTML 代码节点必须保留 </style> 结束标签'
    );
    assert.equal(
        dom.window.document.querySelector('#content > style'),
        null,
        '示例 style 不得成为聊天消息 DOM 中的可执行 style 节点'
    );

    dom.window.close();
});

test('real assistant HTML outside a code fence is still selected for scoped CSS extraction', () => {
    const source = [
        '<style>.live-card { color: tomato; }</style>',
        '<div class="live-card">Live HTML</div>',
        '',
        '```html',
        '<style>.demo-card { color: rebeccapurple; }</style>',
        '<div class="demo-card">Demo source</div>',
        '```'
    ].join('\n');

    const result = protectThenExtractStyles(source);

    assert.equal(result.selectedCodeDomains.length, 1);
    assert.equal(
        result.selectedRuntimeStyles.length,
        1,
        '只有围栏外的真实 assistant style 应被提取'
    );
    assert.match(result.selectedRuntimeStyles[0].css, /\.live-card/);
    assert.doesNotMatch(result.selectedRuntimeStyles[0].css, /\.demo-card/);
    assert.match(result.restoredSource, /<!-- VCP-SCOPED-STYLE-EXTRACTED -->/);
    assert.match(result.restoredSource, /<style>\.demo-card/);
});

test('unclosed streaming HTML fence owns the tail and prevents premature style extraction', () => {
    const source = [
        '```html',
        '<!DOCTYPE html>',
        '<style>',
        'body { color: cyan; }',
        '</style>',
        '<body>still streaming'
    ].join('\n');

    const result = protectThenExtractStyles(source);

    assert.equal(result.selectedCodeDomains.length, 1);
    assert.equal(result.selectedCodeDomains[0].metadata.kind, 'fence');
    assert.equal(result.selectedCodeDomains[0].metadata.closed, false);
    assert.equal(
        result.selectedRuntimeStyles.length,
        0,
        '未闭合流式围栏中的完整 style 也不得提前产生 CSS 副作用'
    );
    assert.equal(result.restoredSource, source);
});

test('inline code style literal is protected while a following real style remains extractable', () => {
    const source = [
        '正文提及 `<style>.literal { color: red; }</style>` 不应执行。',
        '<style>.real { color: green; }</style>',
        '<div class="real">Real HTML</div>'
    ].join('\n');

    const result = protectThenExtractStyles(source);

    assert.equal(result.selectedCodeDomains.length, 1);
    assert.equal(result.selectedCodeDomains[0].metadata.kind, 'inline');
    assert.equal(result.selectedRuntimeStyles.length, 1);
    assert.match(result.selectedRuntimeStyles[0].css, /\.real/);
    assert.doesNotMatch(result.selectedRuntimeStyles[0].css, /\.literal/);
    assert.equal(result.restoredSource.includes('`<style>.literal'), true);
});

// 与用户实测相同的关键拓扑：HTML 注释先被保护，随后整个 fenced code
// 又被保护，形成嵌套占位符。恢复必须遵循 LIFO，否则内部注释不可恢复。
test('fenced cursor demo restores nested HTML comments without leaking protection placeholders', () => {
    const source = [
        '```html',
        '<div class="vcp-cursor-preview-container">',
        '  <!-- 1. Normal -->',
        '  <div class="normal"><svg></svg></div>',
        '',
        '  <!-- 2. Working -->',
        '  <div class="working"><div class="spinner"></div></div>',
        '',
        '  <style>',
        '    @keyframes vcp-spin {',
        '      0% { transform: rotate(0deg); }',
        '      100% { transform: rotate(360deg); }',
        '    }',
        '  </style>',
        '</div>',
        '```'
    ].join('\n');

    const protectedBlocks = [];
    let protectedSource = source.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => {
        const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
        protectedBlocks.push(comment);
        return placeholder;
    });
    protectedSource = replaceMarkdownCodeDomains(protectedSource, (domain) => {
        const placeholder = `__VCP_STYLE_PROTECT_${protectedBlocks.length}__`;
        protectedBlocks.push(domain);
        return placeholder;
    });

    const selectedRuntimeStyles = [];
    protectedSource = protectedSource.replace(RUNTIME_STYLE_REGEX, (match, css) => {
        selectedRuntimeStyles.push(css);
        return '<!-- VCP-SCOPED-STYLE-EXTRACTED -->';
    });

    let restoredSource = protectedSource;
    for (let index = protectedBlocks.length - 1; index >= 0; index--) {
        restoredSource = restoredSource
            .split(`__VCP_STYLE_PROTECT_${index}__`)
            .join(protectedBlocks[index]);
    }

    assert.equal(
        selectedRuntimeStyles.length,
        0,
        'fenced cursor demo style must never reach runtime CSS extraction'
    );
    assert.equal(
        restoredSource,
        source,
        'nested comment and fence placeholders must restore byte-for-byte'
    );
    assert.doesNotMatch(
        restoredSource,
        /__VCP_STYLE_PROTECT_\d+__/,
        'no internal protection placeholder may leak into rendered code'
    );
});

// 防止测试本身误用 HTML entity 版本的标签正则。
test('test harness style selector only targets literal runtime tags', () => {
    assert.equal(RUNTIME_STYLE_REGEX.test('<style>.x{}</style>'), true);
    RUNTIME_STYLE_REGEX.lastIndex = 0;
    assert.equal(STYLE_REGEX.test('<style>.x{}</style>'), true);
});