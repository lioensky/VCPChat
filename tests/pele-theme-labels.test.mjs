import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('styles/messageRenderer.css', root), 'utf8');
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('vendor/pele.global.js', root), 'utf8'), context);
const code = `timeline
    title 两个割裂的印度平行宇宙
    10% 顶层高种姓掠夺者 : 纯正英音/美音 : 垄断欧美科技高管/政客席位 : 在推特用抽象民主价值观高谈阔论
    90% 底层达利特/首陀罗 : 露天排便与假牛奶 : 人肉清理下水道与种姓压迫 : 被完全剥夺国际英文发声通道`;
const svg = context.pele.render(code).svg;

test('chat Pele background token retains a concrete theme color and fallback', () => {
    const block = css.match(/\.mermaid\s*\{([^}]+)\}/)?.[1];
    assert.ok(block);
    assert.match(block, /--pele-bg:\s*var\(--bg-color,\s*#20252A\)\s*;/);
    assert.doesNotMatch(block, /--pele-bg:\s*(transparent|none)\s*;/);
});

test('real timeline period labels use the background token, not the foreground token', () => {
    const dom = new JSDOM(`<div class="mermaid">${svg}</div>`);
    try {
        const labels = [...dom.window.document.querySelectorAll('.pele-period > text')];
        assert.equal(labels.length, 2);
        assert.ok(labels[0].textContent.includes('10%'));
        assert.ok(labels[1].textContent.includes('90%'));
        for (const label of labels) assert.equal(label.getAttribute('fill'), 'var(--_bg)');
        assert.match(dom.window.document.querySelector('svg').getAttribute('style'),
            /--_bg:var\(--pele-bg,#fff\)/);
        // A nontransparent palette token does not itself paint the SVG canvas.
        assert.equal(dom.window.document.querySelector('svg > rect'), null);
    } finally {
        dom.window.close();
    }
});

test('chat viewport enhancement preserves real timeline labels and inline palette', () => {
    const source = readFileSync(new URL('modules/messageRenderer.js', root), 'utf8');
    const start = source.indexOf('function enhanceMermaidDiagram(');
    const end = source.indexOf('\nfunction cleanupMermaidViewers(', start);
    assert.ok(start >= 0 && end > start);
    const enhance = new Function(`${source.slice(start, end)}; return enhanceMermaidDiagram;`)();
    const dom = new JSDOM(`<div class="mermaid">${svg}</div>`);
    try {
        const element = dom.window.document.querySelector('.mermaid');
        const before = element.querySelector('svg');
        const text = before.textContent;
        const palette = before.style.getPropertyValue('--_bg');
        enhance(element);
        assert.equal(element.querySelector('.mermaid-viewer-canvas > svg'), before);
        assert.equal(before.textContent, text);
        assert.equal(before.style.getPropertyValue('--_bg'), palette);
        assert.equal(before.querySelectorAll('.pele-period > text').length, 2);
    } finally {
        dom.window.close();
    }
});