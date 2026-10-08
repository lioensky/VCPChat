import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

/** Exercise the shipped icon startup without loading the Next component runtime. */
export async function assertSharedComposerIcons(html, mode) {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    try {
        const { document } = dom.window;
        document.documentElement.dataset.uiMode = mode;
        const sources = [...document.querySelectorAll('script[src]')].map(script => script.getAttribute('src'));
        const bundle = 'node_modules/lucide/dist/umd/lucide.min.js';
        const adapter = 'modules/ui-system/lucide-adapter.js';
        assert.ok(sources.includes(bundle) && sources.indexOf(bundle) < sources.indexOf(adapter),
            'the shared Lucide bundle must load before its adapter');
        const ready = new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        for (const source of [bundle, adapter]) dom.window.eval(fs.readFileSync(path.resolve(source), 'utf8'));
        await ready;
        for (const id of ['quickNewTopicBtn', 'attachFileBtn', 'emoticonTriggerBtn', 'sendMessageBtn']) {
            const button = document.getElementById(id);
            assert.ok(button, `${id} must remain in the shared composer DOM`);
            const icon = button.querySelector('svg');
            assert.ok(icon?.querySelector('path, circle, line, polyline, rect'),
                `${id} must render an SVG icon in ${mode} without the Next runtime`);
            assert.equal(button.querySelector('.material-symbols-outlined'), null,
                `${id} must not depend on a mode-specific icon font`);
            assert.equal(icon.getAttribute('aria-hidden'), 'true', `${id} icon must remain decorative`);
            assert.ok(button.getAttribute('aria-label') || button.getAttribute('title'), `${id} must retain its accessible name`);
        }
    } finally {
        dom.window.close();
    }
}
