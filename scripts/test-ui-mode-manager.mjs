import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'modules', 'uiModeManager.js'), 'utf8');
const freshDom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://vcpchat.local/',
    runScripts: 'outside-only'
});
freshDom.window.eval(source);
assert.equal(freshDom.window.document.documentElement.dataset.uiMode, 'next', 'missing boot cache must default to Next');

const classicDom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://vcpchat.local/',
    runScripts: 'outside-only'
});
classicDom.window.localStorage.setItem('vcpchat.uiMode', 'classic');
classicDom.window.eval(source);
assert.equal(classicDom.window.document.documentElement.dataset.uiMode, 'classic', 'an explicit Classic preference must be preserved');

const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'modules', 'utils', 'appSettingsManager.js'), 'utf8');
assert.match(rendererSource, /let globalSettings = \{[\s\S]*?uiMode:\s*'next'/, 'renderer boot state must default to Next');
assert.match(settingsSource, /this\.defaultSettings = \{[\s\S]*?uiMode:\s*'next'/, 'new settings files must default to Next');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://vcpchat.local/',
    runScripts: 'outside-only'
});

dom.window.localStorage.setItem('vcpchat.uiMode', 'next');
dom.window.eval(source);

assert.equal(dom.window.document.documentElement.dataset.uiMode, 'next', 'cached mode should only be used as the initial display hint');
dom.window.uiModeManager.apply('classic');
assert.equal(dom.window.localStorage.getItem('vcpchat.uiMode'), 'next', 'ordinary display updates must not persist an independent mode source');
dom.window.uiModeManager.apply('classic', { cache: true });
assert.equal(dom.window.localStorage.getItem('vcpchat.uiMode'), 'classic', 'only an authoritative settings read/write may synchronize the boot cache');

dom.window.uiModeManager.apply('next');
let releaseTeardown;
const teardown = new Promise(resolve => { releaseTeardown = resolve; });
const lifecycle = [];
dom.window.topTabManager = {
    async prepareForMode(mode) {
        lifecycle.push(`prepare:${mode}`);
        if (mode === 'classic') await teardown;
    },
    async syncMode(mode) {
        lifecycle.push(`sync:${mode}`);
    },
};
const transition = dom.window.uiModeManager.applyAsync('classic', { cache: true });
await Promise.resolve();
assert.equal(
    dom.window.document.documentElement.dataset.uiMode,
    'next',
    'async mode changes must keep Next active until native teardown finishes',
);
releaseTeardown();
await transition;
assert.equal(dom.window.document.documentElement.dataset.uiMode, 'classic');
assert.deepEqual(lifecycle, ['prepare:classic', 'sync:classic']);

console.log('UI mode authority contract passed.');
