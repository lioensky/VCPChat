import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

test('global settings saves the server URL once with canonical presentation', async () => {
    const root = process.cwd();
    const mainHtml = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
    const source = new JSDOM(mainHtml, { url: 'https://vcpchat.local/' });
    const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body></body></html>', {
        url: 'https://vcpchat.local/',
    });
    const template = source.window.document.getElementById('globalSettingsModalTemplate');
    dom.window.document.body.appendChild(dom.window.document.importNode(template.content, true));

    const previousGlobals = {};
    for (const name of ['window', 'document', 'CustomEvent']) {
        previousGlobals[name] = globalThis[name];
    }
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        CustomEvent: dom.window.CustomEvent,
    });

    let resolveSave;
    let saveCalls = 0;
    let savedPayload;
    let normalizeMode;
    const savePromise = new Promise(resolve => { resolveSave = resolve; });
    dom.window.chatAPI = {
        saveSettings(payload) {
            saveCalls += 1;
            savedPayload = payload;
            return savePromise;
        },
        async saveRustAssistantConfig() { return { success: true }; },
        connectVCPLog() {},
        disconnectVCPLog() {},
    };
    dom.window.VCPAppearance = {
        normalize(profile, mode) {
            normalizeMode = mode;
            return profile;
        },
        commit: profile => profile,
    };
    dom.window.normalizeChatPresentationMode = () => 'bubble';

    const currentSettings = {};
    const deps = {
        refs: { globalSettings: { get: () => currentSettings } },
        getCroppedFile: () => null,
        setCroppedFile() {},
        uiHelperFunctions: { showToastNotification() {}, closeModal() {} },
        settingsManager: { completeVcpUrl: url => url },
    };
    const form = dom.window.document.getElementById('globalSettingsForm');
    dom.window.document.getElementById('vcpServerUrl').value = 'http://localhost:6005';

    try {
        const moduleUrl = `${pathToFileURL(path.join(root, 'modules/global-settings-manager.js')).href}?save-regression=${Date.now()}`;
        const { handleSaveGlobalSettings } = await import(moduleUrl);
        const event = { preventDefault() {}, currentTarget: form };
        const firstSave = handleSaveGlobalSettings(event, deps);
        await handleSaveGlobalSettings(event, deps);

        assert.equal(saveCalls, 1, 'an in-flight form cannot submit twice');
        assert.equal(normalizeMode, 'next', 'appearance normalization uses the canonical mode');
        assert.equal(savedPayload.vcpServerUrl, 'http://localhost:6005');
        assert.equal(form.dataset.globalSettingsSaving, 'true');

        resolveSave({ success: true });
        await firstSave;
        assert.equal(form.dataset.globalSettingsSaving, undefined, 'the submit lock is released after completion');

        dom.window.chatAPI.saveSettings = () => new Promise(() => {});
        deps.saveTimeoutMs = 5;
        await assert.rejects(
            handleSaveGlobalSettings(event, deps),
            /保存设置超时/,
            'a permanently pending save must become a recoverable terminal state'
        );
        assert.equal(form.dataset.globalSettingsSaving, undefined, 'timeout must release the submit lock');
    } finally {
        for (const [name, value] of Object.entries(previousGlobals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
        dom.window.close();
        source.window.close();
    }
});
