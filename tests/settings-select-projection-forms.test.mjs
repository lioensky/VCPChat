import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// The Agent and group settings forms stay mounted side by side. Rebuilding
// one form's dropdowns after its options change (for example when an Agent's
// voice list loads) used to tear down every form's dropdowns and observers
// and remount only its own, so the other form fell back to bare native
// selects until something else refreshed the surface.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function createScope() {
    let active = true;
    const records = new Set();
    const scope = {
        get active() { return active; },
        own(disposer) {
            let released = false;
            const release = () => {
                if (released) return Promise.resolve();
                released = true;
                records.delete(release);
                return Promise.resolve(disposer());
            };
            records.add(release);
            return release;
        },
        child() {
            const child = createScope();
            scope.own(() => child.dispose());
            return child;
        },
        async dispose() {
            if (!active) return;
            active = false;
            await Promise.all([...records].reverse().map(release => release()));
        },
    };
    return scope;
}

test('rebuilding one form\'s dropdowns leaves the other form\'s dropdowns mounted', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <form id="agentSettingsForm"><select id="voice"><option value="a">A</option><option value="b">B</option></select></form>
        <form id="groupSettingsForm"><select id="groupMode"><option value="seq">Seq</option><option value="free">Free</option></select></form>
    </body>`);
    const keys = ['window', 'document', 'Element', 'Node', 'Event', 'MutationObserver', 'Option', 'HTMLElement'];
    const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
    const scope = createScope();
    try {
        Object.assign(globalThis, Object.fromEntries(keys.map(key => [key, dom.window[key]])));
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;
        dom.window.VCPUIUX = {
            mountSelect(select, _props, selectScope) {
                const parent = select.parentNode;
                const wrap = dom.window.document.createElement('span');
                wrap.className = 'vcp-uiux-select';
                parent.insertBefore(wrap, select);
                wrap.append(select);
                return selectScope.own(() => {
                    if (select.parentNode === wrap) parent.insertBefore(select, wrap);
                    wrap.remove();
                });
            },
        };
        const { createSelectProjection } = await import(pathToFileURL(path.join(repoRoot, 'modules/ui-system/settings/select-projection.js')).href);
        const projection = createSelectProjection({ ensurePresentationScope: () => scope });
        const doc = dom.window.document;
        const agentForm = doc.getElementById('agentSettingsForm');
        const groupForm = doc.getElementById('groupSettingsForm');
        projection.mount(agentForm);
        projection.mount(groupForm);
        const wrapped = form => form.querySelectorAll('.vcp-uiux-select').length;
        assert.equal(wrapped(agentForm), 1);
        assert.equal(wrapped(groupForm), 1);

        doc.getElementById('voice').append(new dom.window.Option('C', 'c'));
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(wrapped(agentForm), 1, 'the Agent form is remounted with its new options');
        assert.equal(wrapped(groupForm), 1, 'the group form keeps its dropdown');

        doc.getElementById('groupMode').append(new dom.window.Option('Host', 'host'));
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(wrapped(groupForm), 1, 'the group form still reacts to its own option changes');
        assert.equal(doc.getElementById('groupMode').options.length, 3);
        assert.equal(wrapped(agentForm), 1, 'and the Agent form is left alone in turn');
    } finally {
        await scope.dispose();
        Object.entries(previous).forEach(([key, value]) => {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        });
        dom.window.close();
    }
});
