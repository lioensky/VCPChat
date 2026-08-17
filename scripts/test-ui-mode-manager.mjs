import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'modules', 'uiModeManager.js'), 'utf8');
for (const persisted of [null, 'classic', 'next', 'unknown']) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://vcpchat.local/', runScripts: 'outside-only' });
    if (persisted != null) dom.window.localStorage.setItem('vcpchat.uiMode', persisted);
    dom.window.eval(source);
    assert.equal(dom.window.document.documentElement.dataset.uiMode, 'next');
    assert.equal(dom.window.uiModeManager.getCurrentMode(), 'next');
    assert.equal(await dom.window.uiModeManager.applyAsync('classic', { cache: true }), 'next');
    assert.equal(dom.window.localStorage.getItem('vcpchat.uiMode'), 'next');
    assert.equal(dom.window.uiModeManager.getTransitionState().phase, 'settled');
    dom.window.close();
}
const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'modules', 'utils', 'appSettingsManager.js'), 'utf8');
const embeddedSource = fs.readFileSync(path.join(root, 'modules', 'services', 'embeddedAppSessionManager.js'), 'utf8');
assert.match(rendererSource, /let globalSettings = \{[\s\S]*?uiMode:\s*'next'/);
assert.match(settingsSource, /this\.defaultSettings = \{[\s\S]*?uiMode:\s*'next'/);
assert.match(embeddedSource, /const uiMode = 'classic'/, 'embedded upstream applications keep their independent Classic-page policy');
console.log('Canonical UI mode compatibility contract passed.');
