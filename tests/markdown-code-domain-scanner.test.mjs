import test from 'node:test';
import assert from 'node:assert/strict';

import {
    replaceMarkdownCodeDomains,
} from '../modules/renderer/markdownCodeDomainScanner.js';

test('inline code isolates HTML tag literals from downstream style extraction', () => {
    const source = [
        '3. **自包含封装**：`<style>` 标签依然内敛于 DIV 容器顶层。',
        '',
        '<div class="vcp-bh-container">',
        '  <style>',
        '    .vcp-bh-stage { width: 220px; height: 180px; }',
        '    .vcp-bh-disk-outer { animation: vcpBhSpinOuter 3s linear infinite; }',
        '    @keyframes vcpBhSpinOuter {',
        '      from { transform: rotateX(72deg) rotate(0deg); }',
        '      to { transform: rotateX(72deg) rotate(360deg); }',
        '    }',
        '  </style>',
        '  <div class="vcp-bh-stage">',
        '    <div class="vcp-bh-disk-outer"></div>',
        '  </div>',
        '</div>',
    ].join('\n');

    const protectedDomains = [];
    const protectedSource = replaceMarkdownCodeDomains(source, (domain) => {
        const placeholder = `__CODE_DOMAIN_${protectedDomains.length}__`;
        protectedDomains.push(domain);
        return placeholder;
    });

    assert.equal(protectedDomains.length, 1);
    assert.equal(protectedDomains[0], '`<style>`');
    assert.doesNotMatch(
        protectedSource.split('<div class="vcp-bh-container">')[0],
        /<style\b/i,
        'inline-code style literal must not remain visible to the CSS extractor',
    );

    const extractedCss = [];
    const withoutRealStyles = protectedSource.replace(
        /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
        (_match, css) => {
            extractedCss.push(css);
            return '<!-- VCP-SCOPED-STYLE-EXTRACTED -->';
        },
    );

    assert.equal(extractedCss.length, 1, 'only the real black-hole stylesheet may be extracted');
    assert.match(extractedCss[0], /\.vcp-bh-stage\s*\{/);
    assert.match(extractedCss[0], /@keyframes\s+vcpBhSpinOuter/);
    assert.doesNotMatch(extractedCss[0], /标签依然内敛/);
    assert.match(withoutRealStyles, /<div class="vcp-bh-container">/);
    assert.match(withoutRealStyles, /<div class="vcp-bh-disk-outer"><\/div>/);
});

test('variable-length inline code spans isolate literal div, style, and script tags', () => {
    const source = [
        '单反引号：`<div>fake</div>`。',
        '双反引号：``<style>fake</style>``。',
        '三反引号行内：```<script>"</div>"</script>```。',
        '<div class="real-island"><style>.real-island{display:block}</style></div>',
    ].join('\n');

    const domains = [];
    const protectedSource = replaceMarkdownCodeDomains(source, (domain) => {
        domains.push(domain);
        return `__INLINE_${domains.length - 1}__`;
    });

    assert.deepEqual(domains, [
        '`<div>fake</div>`',
        '``<style>fake</style>``',
        '```<script>"</div>"</script>```',
    ]);
    assert.match(protectedSource, /<div class="real-island">/);
    assert.equal(
        (protectedSource.match(/<style\b/gi) || []).length,
        1,
        'only the real island style start tag may remain',
    );
});

test('backtick and tilde fenced code domains isolate all HTML-looking content', () => {
    const source = [
        '````html',
        '<div class="fenced">',
        '  <style>.fenced { color: red; }</style>',
        '</div>',
        '````',
        '',
        '~~~javascript',
        'const fake = "</div><style>bad</style><div>";',
        '~~~',
        '',
        '<div class="real"><style>.real{color:green}</style></div>',
    ].join('\n');

    const domains = [];
    const protectedSource = replaceMarkdownCodeDomains(source, (domain, metadata) => {
        domains.push({ domain, metadata });
        return `__FENCE_${domains.length - 1}__`;
    });

    assert.equal(domains.length, 2);
    assert.equal(domains[0].metadata.kind, 'fence');
    assert.equal(domains[0].metadata.marker, '`');
    assert.equal(domains[0].metadata.length, 4);
    assert.equal(domains[1].metadata.kind, 'fence');
    assert.equal(domains[1].metadata.marker, '~');
    assert.equal(domains[1].metadata.length, 3);
    assert.equal(
        (protectedSource.match(/<style\b/gi) || []).length,
        1,
        'fenced fake styles must not be visible to downstream extraction',
    );
    assert.match(protectedSource, /<div class="real">/);
});

test('unclosed inline code is protected only in explicit streaming mode', () => {
    const inlineSource = '说明开始 `<style> 尚未闭合';

    const staticDomains = [];
    const staticOutput = replaceMarkdownCodeDomains(inlineSource, (domain, metadata) => {
        staticDomains.push({ domain, metadata });
        return '__STATIC_INLINE__';
    });
    assert.equal(staticDomains.length, 0);
    assert.equal(staticOutput, inlineSource);

    const inlineDomains = [];
    const protectedInline = replaceMarkdownCodeDomains(inlineSource, (domain, metadata) => {
        inlineDomains.push({ domain, metadata });
        return '__UNCLOSED_INLINE__';
    }, { includeUnclosedInline: true });
    assert.equal(inlineDomains.length, 1);
    assert.equal(inlineDomains[0].metadata.closed, false);
    assert.equal(protectedInline, '说明开始 __UNCLOSED_INLINE__');
});

test('unclosed fenced code is always protected through the current tail', () => {
    const fenceSource = [
        '正文',
        '```html',
        '<div><style>.partial { color: red; }</style>',
    ].join('\n');
    const fenceDomains = [];
    const protectedFence = replaceMarkdownCodeDomains(fenceSource, (domain, metadata) => {
        fenceDomains.push({ domain, metadata });
        return '__UNCLOSED_FENCE__';
    });
    assert.equal(fenceDomains.length, 1);
    assert.equal(fenceDomains[0].metadata.kind, 'fence');
    assert.equal(fenceDomains[0].metadata.closed, false);
    assert.equal(protectedFence, '正文\n__UNCLOSED_FENCE__');
});

test('ordinary real HTML outside Markdown code domains remains untouched', () => {
    const source = [
        '<div class="case-attr" data-fake="<div>not-a-node</div>">',
        '  <!-- <div>comment fake</div> -->',
        '  <style>',
        '    .case-attr::before { content: "</div><div>"; }',
        '  </style>',
        '  <script>const fake = "</div><div>";</script>',
        '  <div class="real-child"></div>',
        '</div>',
    ].join('\n');

    const domains = [];
    const output = replaceMarkdownCodeDomains(source, (domain) => {
        domains.push(domain);
        return '__UNEXPECTED__';
    });

    assert.equal(domains.length, 0);
    assert.equal(output, source);
});

test('orphan backtick does not hide later real HTML in static mode', () => {
    const source = [
        '孤立反引号 ` 不得拥有后续文档',
        '',
        '<style>.real { color: green; }</style>',
        '<div class="real"></div>',
    ].join('\n');
    const domains = [];
    const output = replaceMarkdownCodeDomains(source, (domain) => {
        domains.push(domain);
        return '__CODE__';
    });

    assert.equal(domains.length, 0);
    assert.equal(output, source);
    assert.match(output, /<style>\.real/);
    assert.match(output, /<div class="real">/);
});