const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function setup() {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="globalSettingsModal" class="active" tabindex="-1">
            <form id="globalSettingsForm" data-vcp-settings-dirty="true"><input value="draft"></form>
        </div>
    </body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.eval(fs.readFileSync('modules/ui-helpers.js', 'utf8'));
    return { dom, window, helpers: window.uiHelperFunctions,
        modal: window.document.getElementById('globalSettingsModal'),
        form: window.document.getElementById('globalSettingsForm') };
}

test('settings hide immediately while one background flush retains the connected draft', async () => {
    const { dom, window, helpers, modal, form } = setup();
    const barrier = Promise.withResolvers();
    let calls = 0;
    window.VCPUISettingsBridge = { flush() { calls++; return barrier.promise; } };
    try {
        assert.equal(helpers.closeModal('globalSettingsModal'), true);
        assert.equal(helpers.closeModal('globalSettingsModal'), true);
        assert.equal(modal.classList.contains('active'), false, 'visibility must not wait for a slow save');
        assert.equal(form.isConnected, true);
        assert.equal(form.querySelector('input').value, 'draft');
        assert.equal(form.dataset.vcpSettingsDirty, 'true');
        await Promise.resolve();
        assert.equal(calls, 1, 'repeated closes of an already hidden surface do not restart its flush');
        barrier.resolve({ status: 'saved' });
        await barrier.promise;
        assert.equal(modal.classList.contains('active'), false);
    } finally {
        barrier.resolve({ status: 'saved' });
        dom.window.close();
    }
});

for (const outcome of ['error', 'conflict', 'rejected']) {
    test(`a late ${outcome} flush does not close a reopened settings draft`, async () => {
        const { dom, window, helpers, modal, form } = setup();
        const barrier = Promise.withResolvers();
        const warnings = [];
        window.console.warn = (...args) => warnings.push(args);
        window.VCPUISettingsBridge = { flush: () => barrier.promise };
        try {
            assert.equal(helpers.closeModal('globalSettingsModal'), true);
            await Promise.resolve();
            helpers.openModal('globalSettingsModal');
            form.querySelector('input').value = 'newer draft';
            if (outcome === 'rejected') barrier.reject(new Error('save failed'));
            else barrier.resolve({ status: outcome });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(modal.classList.contains('active'), true);
            assert.equal(window.document.getElementById('globalSettingsForm'), form);
            assert.equal(form.querySelector('input').value, 'newer draft');
            assert.equal(form.dataset.vcpSettingsDirty, 'true');
            assert.equal(warnings.length, outcome === 'rejected' ? 1 : 0, 'background rejection is contained');
        } finally {
            barrier.resolve({ status: 'saved' });
            dom.window.close();
        }
    });
}
