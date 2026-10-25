import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../modules/messageRenderer.js', import.meta.url), 'utf8');
const start = source.indexOf('function enhanceMermaidDiagram(');
const end = source.indexOf('\nfunction cleanupMermaidViewers(', start);
const enhance = new Function(`${source.slice(start, end)}; return enhanceMermaidDiagram;`)();

function fixture(width, height, renderedScale = 1) {
    const dom = new JSDOM('<div class="mermaid"><svg></svg></div>');
    const element = dom.window.document.querySelector('.mermaid');
    const svg = element.querySelector('svg');
    enhance(element);
    const wrapper = element.querySelector('.mermaid-viewer');
    const viewport = element.querySelector('.mermaid-viewer-viewport');
    const canvas = element.querySelector('.mermaid-viewer-canvas');
    Object.defineProperty(viewport, 'clientWidth', { value: 800 });
    Object.defineProperty(viewport, 'clientHeight', { value: 400 });
    Object.defineProperty(canvas, 'offsetWidth', { value: 1000 });
    canvas.getBoundingClientRect = () => ({
        left: -100, top: 70, width: 1000 * renderedScale
    });
    svg.getBoundingClientRect = () => ({
        left: -100 + 24 * renderedScale,
        top: 70 + 24 * renderedScale,
        width: width * renderedScale,
        height: height * renderedScale
    });
    const fit = () => element.querySelector('[data-mermaid-action="fit"]').click();
    return { dom, wrapper, fit };
}

for (const [label, width, height, expected] of [
    ['wide diagram fits width', 1600, 200, 768 / 1600],
    ['tall diagram fits height', 200, 1600, 368 / 1600],
    ['landscape diagram can still be height constrained', 900, 800, 368 / 800],
    ['very tall diagram fits below manual minimum', 200, 10000, 368 / 10000],
    ['small diagram respects enlargement cap', 100, 100, 1.8]
]) {
    test(label, () => {
        const { dom, wrapper, fit } = fixture(width, height);
        assert.equal(wrapper.dataset.scale, '1', 'initial view stays at 100%');
        fit();
        const scale = Number(wrapper.dataset.scale);
        assert.equal(scale, expected);
        const x = Number(wrapper.dataset.translateX) + 24 * scale;
        const y = Number(wrapper.dataset.translateY) + 24 * scale;
        assert.ok(Math.abs(x - (800 - width * scale) / 2) < 1e-8);
        assert.ok(Math.abs(y - (400 - height * scale) / 2) < 1e-8);
        dom.window.close();
    });
}

test('measurement ignores existing zoom, pan and intermediate transition scale', () => {
    const { dom, wrapper, fit } = fixture(200, 1600, 2.4);
    wrapper.dataset.scale = '3';
    wrapper.dataset.translateX = '-100';
    fit();
    assert.equal(Number(wrapper.dataset.scale), 368 / 1600);
    dom.window.close();
});