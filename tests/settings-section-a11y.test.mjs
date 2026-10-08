import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const schema = await import(pathToFileURL(path.join(repoRoot, 'modules/settings/schema/sidebar-surfaces.js')).href);
const labelable = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'METER', 'OUTPUT', 'PROGRESS']);

function surfaces() {
    const dom = new JSDOM('<!doctype html><html><body><div id="agent"></div><div id="group"></div></body></html>');
    const { document } = dom.window;
    schema.renderAgentSettingsSurface(document.getElementById('agent'), document);
    schema.renderGroupSettingsSurface(document.getElementById('group'), document);
    return { dom, document };
}

test('section headers hold one keyboard control, the chevron button, which names what it controls', () => {
    const { dom, document } = surfaces();
    const headers = document.querySelectorAll('.agent-settings-section-header, .group-settings-section-header');
    assert.ok(headers.length >= 10);
    for (const header of headers) {
        assert.equal(header.getAttribute('role'), null, `${header.id} must not wrap its button in another button`);
        assert.equal(header.getAttribute('tabindex'), null, `${header.id} must not add a second tab stop`);
        const toggle = header.querySelector('button.agent-settings-section-toggle, button.group-settings-section-toggle');
        assert.ok(toggle, `${header.id} keeps its chevron button`);
        const controlled = document.getElementById(toggle.getAttribute('aria-controls'));
        assert.ok(controlled?.classList.contains(header.id.startsWith('group') ? 'group-settings-section-content' : 'agent-settings-section-content'),
            `${toggle.id} aria-controls points at its section content`);
    }
    dom.window.close();
});

test('every label for= points at a form control', () => {
    const { dom, document } = surfaces();
    for (const label of document.querySelectorAll('label[for]')) {
        const target = document.getElementById(label.htmlFor);
        assert.ok(target, `label for="${label.htmlFor}" has a target`);
        assert.ok(labelable.has(target.tagName), `label for="${label.htmlFor}" points at a <${target.tagName.toLowerCase()}>`);
    }
    for (const id of ['groupMembersList', 'memberTagsInputs', 'jevMemberStylesInputs']) {
        const group = document.getElementById(id);
        assert.equal(group.getAttribute('role'), 'group');
        assert.ok(document.getElementById(group.getAttribute('aria-labelledby'))?.textContent.trim(), `${id} has a visible name`);
    }
    dom.window.close();
});
