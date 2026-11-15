import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.env.VCPCHAT_BROWSER_EXECUTABLE
    || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const files = new Set([
    '/modules/renderer/mathRenderer.js',
    '/modules/renderer/contentProcessor.js',
    '/modules/renderer/markdownCodeDomainScanner.js',
    '/node_modules/css-tree/dist/csstree.esm.js',
    '/vendor/katex.min.js',
    '/vendor/katex.min.css',
]);
const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    try {
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end('<!doctype html><link rel="stylesheet" href="/vendor/katex.min.css">'
                + '<script src="/vendor/katex.min.js"></script>'
                + '<style>main{width:800px}p{line-height:1.7}</style><main></main>');
        } else if (files.has(pathname) || /^\/vendor\/fonts\/[\w.-]+\.woff2?$/.test(pathname)) {
            response.setHeader('Content-Type', pathname.endsWith('.js') ? 'application/javascript'
                : pathname.endsWith('.css') ? 'text/css' : 'font/woff2');
            response.end(await fs.readFile(path.join(root, pathname.slice(1))));
        } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await puppeteer.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async () => {
        const { createContentProcessor } = await import('/modules/renderer/contentProcessor.js');
        const processor = createContentProcessor();
        const root = document.querySelector('main');
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const formulas = Array.from({ length: 760 }, (_, i) => [
            `\\Gamma^{${i}}_{jk}`,
            `\\int_0^{${i}} K\\,dA`,
            `\\omega^{${i}}_j`,
            `\\frac{x_${i}}{1+x^2}`,
        ][i % 4]);
        const mount = () => {
            root.replaceChildren();
            return [formulas.slice(0, 380), formulas.slice(380)].map(items => {
                const content = document.createElement('p');
                content.textContent = items.map(source => `\\(${source}\\)`).join(' ');
                root.append(content);
                return content;
            });
        };
        const measure = async () => {
            const contents = mount();
            let frames = 0;
            let maxFrameGapMs = 0;
            let lastFrame = performance.now();
            let handle;
            const tick = time => {
                frames++;
                maxFrameGapMs = Math.max(maxFrameGapMs, time - lastFrame);
                lastFrame = time;
                handle = requestAnimationFrame(tick);
            };
            handle = requestAnimationFrame(tick);
            const start = performance.now();
            await Promise.all(contents.map(content => processor.processRenderedContentAsync(content, {
                enableAiMessageButtons: false,
            })));
            const elapsedMs = performance.now() - start;
            cancelAnimationFrame(handle);
            check(root.querySelectorAll('.katex').length === 760, 'missing formulas');
            const beforeHighlights = root.querySelectorAll('.katex').length;
            const highlightStart = performance.now();
            contents.forEach(content => processor.highlightAllPatternsInMessage(content));
            const highlightMs = performance.now() - highlightStart;
            check(root.querySelectorAll('.katex').length === beforeHighlights, 'highlight changed formulas');
            return {
                elapsedMs: Math.round(elapsedMs), frames,
                maxFrameGapMs: Math.round(maxFrameGapMs),
                highlightMs: Number(highlightMs.toFixed(2)),
                elements: root.querySelectorAll('*').length,
                cache: processor.getMathRenderStats(),
            };
        };
        try {
            const cold = await measure();
            const warm = await measure();
            check(cold.frames > 0 && warm.frames > 0, 'math work starved rendering');
            check(warm.cache.hits > cold.cache.hits, 'warm remount did not reuse formula strings');
            check(warm.cache.bytes <= 12 * 1024 * 1024, 'formula cache exceeded its byte budget');
            return { syntheticFormulas: 760, cold, warm };
        } finally { processor.dispose(); }
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: await browser.version(), ...result }, null, 2));
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}