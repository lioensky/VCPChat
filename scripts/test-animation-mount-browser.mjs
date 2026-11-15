import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.env.VCPCHAT_BROWSER_EXECUTABLE
    || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const files = new Set(['animation.js', 'animationMountController.js', 'visibilityOptimizer.js']
    .map(name => `/modules/renderer/${name}`));
const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'");
    try {
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end('<!doctype html><main><article class="message-item"><div class="md-content"></div></article></main>');
        } else if (files.has(pathname)) {
            response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
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
        const { processAnimationsInContent, cleanupAnimationsInContent } = await import('/modules/renderer/animation.js');
        const { createVisibilityOptimizer } = await import('/modules/renderer/visibilityOptimizer.js');
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const root = document.querySelector('main');
        const item = document.querySelector('article');
        const content = item.querySelector('.md-content');
        const owner = createVisibilityOptimizer();
        owner.initializeVisibilityOptimizer(root);
        window.staleWrites = 0;
        const originalWrite = document.write;
        let canceledAnimations = 0;
        try {
            content.innerHTML = '<span>probe</span><script id="metadata">'
                + 'window.metadata = document.currentScript.id;'
                + 'window.animation = container.querySelector("span").animate([{opacity:0},{opacity:1}], {duration:1000,iterations:Infinity});'
                + 'window.frames = 0; function draw() { window.frames++; requestAnimationFrame(draw); } requestAnimationFrame(draw);'
                + '</script>';
            const mount = processAnimationsInContent(content, owner);
            check(window.metadata === 'metadata', 'classic script did not run under inline-only CSP');
            await wait(70);
            check(window.frames > 0, 'visible frames did not run');
            root.style.height = '100px';
            root.style.overflow = 'auto';
            item.style.transform = 'translateY(3000px)';
            await wait(160); // Let the real IntersectionObserver and batch policy settle.
            const pausedFrames = window.frames;
            check(owner.isMessagePaused(item), 'offscreen geometry did not pause the message');
            await wait(70);
            check(window.frames === pausedFrames, 'offscreen frames kept waking');
            item.style.transform = '';
            await wait(160);
            check(window.frames > pausedFrames, 'frames failed to resume');
            cleanupAnimationsInContent(content);
            check(window.animation.playState === 'idle', 'body-owned Web Animation not canceled');
            canceledAnimations++;
            check(mount.getStats().tasks === 0 && mount.getStats().resources === 0, 'mount did not return to baseline');
            for (let index = 0; index < 100; index++) {
                content._vcpRenderRevision = index + 2;
                content.innerHTML = '<script>'
                    + 'setTimeout(() => { window.staleWrites++; }, 5);'
                    + 'requestAnimationFrame(() => { window.staleWrites++; });'
                    + 'addEventListener("retired-probe", () => { window.staleWrites++; });'
                    + '</script>';
                const current = processAnimationsInContent(content, owner);
                const canceled = current.api.requestAnimationFrame(() => { window.staleWrites++; });
                current.api.cancelAnimationFrame(canceled);
                cleanupAnimationsInContent(content);
                content.textContent = 'replacement';
                window.dispatchEvent(new Event('retired-probe'));
                check(current.getStats().tasks === 0 && current.getStats().resources === 0, 'cycle retained managed resources');
            }
            await wait(40);
            check(window.staleWrites === 0, 'revoked callbacks wrote into the next body');
            check(document.write === originalWrite, 'host document API was mutated');
            check(!Object.keys(window).some(key => /^_vcp_container_/.test(key)), 'temporary global handoff survived');
            return { cycles: 100, staleWrites: window.staleWrites, canceledAnimations, pausedFramesStable: true, csp: 'inline allowed; unsafe-eval absent' };
        } finally { cleanupAnimationsInContent(content); owner.destroyVisibilityOptimizer(); }
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: await browser.version(), ...result }, null, 2));
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}