const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

test('global settings close reuses the in-flight flush barrier on repeated clicks', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="globalSettingsModal" class="active">
            <form id="globalSettingsForm" data-vcp-settings-dirty="true"></form>
        </div>
    </body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    let release;
    window.VCPUISettingsBridge = {
        flush: () => new Promise(resolve => { release = () => resolve({ status: 'saved' }); })
    };
    window.eval(fs.readFileSync('modules/ui-helpers.js', 'utf8'));

    const first = window.uiHelperFunctions.closeModal('globalSettingsModal');
    const second = window.uiHelperFunctions.closeModal('globalSettingsModal');
    assert.strictEqual(second, first, 'repeated close must await the same barrier');
    assert.equal(window.document.getElementById('globalSettingsModal').classList.contains('active'), true);

    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    assert.equal(await first, true);
    assert.equal(window.document.getElementById('globalSettingsModal').classList.contains('active'), false);
});

test('failed global settings close remains actionable and can retry', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="globalSettingsModal" class="active">
            <form id="globalSettingsForm" data-vcp-settings-dirty="true"></form>
        </div>
    </body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    let attempts = 0;
    window.VCPUISettingsBridge = {
        flush: async () => ({ status: attempts++ === 0 ? 'error' : 'saved' })
    };
    window.eval(fs.readFileSync('modules/ui-helpers.js', 'utf8'));

    assert.equal(await window.uiHelperFunctions.closeModal('globalSettingsModal'), false);
    const modal = window.document.getElementById('globalSettingsModal');
    assert.equal(modal.classList.contains('active'), true);
    assert.equal(await window.uiHelperFunctions.closeModal('globalSettingsModal'), true);
    assert.equal(modal.classList.contains('active'), false);
});
