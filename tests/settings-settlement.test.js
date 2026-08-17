const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const settlement = require('../modules/ui-system/settlement.js');

function loadTracker() {
    const dom = new JSDOM('<!doctype html><form id="agentSettingsForm"></form><form id="globalSettingsForm"></form>');
    dom.window.VCPSettlement = settlement;
    const path = require.resolve('../modules/ui-system/settings-settlement.js');
    delete require.cache[path];
    const previousWindow = global.window;
    const previousDocument = global.document;
    const previousSettlement = global.VCPSettlement;
    global.window = dom.window;
    global.document = dom.window.document;
    global.VCPSettlement = settlement;
    const tracker = require(path);
    global.window = previousWindow;
    global.document = previousDocument;
    global.VCPSettlement = previousSettlement;
    tracker.install();
    return { dom, tracker };
}

test('settings settlement is scoped by form and operation', async () => {
    const { dom, tracker } = loadTracker();
    const agent = dom.window.document.getElementById('agentSettingsForm');
    const globalForm = dom.window.document.getElementById('globalSettingsForm');
    agent.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    const operationId = tracker.getSnapshot().forms.agent.operationId;
    const pending = tracker.whenSettled({ form: 'agent', operationId });
    globalForm.dispatchEvent(new dom.window.CustomEvent('vcp-settings-save-result', { detail: { success: true } }));
    assert.equal(tracker.getSnapshot().forms.agent.status, 'saving');
    agent.dispatchEvent(new dom.window.CustomEvent('vcp-settings-save-result', { detail: { success: false, error: 'injected' } }));
    const snapshot = await pending;
    assert.equal(snapshot.forms.agent.status, 'failed');
    assert.equal(snapshot.forms.agent.error, 'injected');
    tracker.dispose();
});
