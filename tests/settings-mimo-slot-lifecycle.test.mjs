import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// The MiMo director slot bound its draft editor to the long-lived settings
// scope instead of its own, so disposing the slot left those listeners
// behind and every remount added another copy.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { MimoDirectorSlot } = await import(pathToFileURL(path.join(repoRoot, 'modules/ui-system/settings/settings-sidebar-slots.js')).href);

function createScope() {
    let active = true;
    const records = new Set();
    const scope = {
        get active() { return active; },
        own(disposer) {
            const release = () => { if (records.delete(release)) disposer(); };
            records.add(release);
            return release;
        },
        listen(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            return scope.own(() => target.removeEventListener(type, handler, options));
        },
        child() {
            const child = createScope();
            scope.own(() => child.dispose());
            return child;
        },
        dispose() {
            if (!active) return;
            active = false;
            [...records].reverse().forEach(release => release());
        },
    };
    return scope;
}

test('disposing and remounting the MiMo slot leaves one set of editor listeners', () => {
    const dom = new JSDOM(`<form id="agentSettingsForm"><div class="tts-director-settings">
        <textarea id="agentTtsDirectorPromptInput"></textarea>
        <button type="button" id="fillAgentTtsDirectorTemplateBtn"></button>
        <button type="button" id="addAgentTtsDirectorPromptBtn"></button>
        <div id="agentTtsDirectorPromptsContainer"></div>
    </div></form>`);
    try {
        const form = dom.window.document.querySelector('form');
        const input = form.querySelector('#agentTtsDirectorPromptInput');
        let writes = 0;
        const manager = {
            getTtsDirectorPrompts: () => ['已有提示'],
            setTtsDirectorPrompts: () => { writes += 1; },
        };
        const settingsScope = createScope();
        const type = target => target.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

        const first = new MimoDirectorSlot({ form, scope: settingsScope, manager }).mount();
        type(input);
        assert.equal(writes, 1);

        first.dispose();
        writes = 0;
        type(input);
        assert.equal(writes, 0, 'a disposed slot no longer reacts to the draft editor');

        new MimoDirectorSlot({ form, scope: settingsScope, manager }).mount();
        type(input);
        assert.equal(writes, 1, 'a remounted slot writes once per edit');

        writes = 0;
        type(form.querySelector('.tts-director-editor'));
        assert.equal(writes, 1, 'existing prompt rows are bound once as well');
    } finally {
        dom.window.close();
    }
});
