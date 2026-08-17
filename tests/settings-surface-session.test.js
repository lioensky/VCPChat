import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('global settings sessions invalidate late work across close and reopen', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="globalSettingsModal"></div></body></html>');
    const previous = { window: globalThis.window, document: globalThis.document };
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    try {
        const {
            captureSettingsSurfaceSession,
            isCurrentSettingsSurfaceSession,
        } = await import(`../modules/ui-system/settings-surface-session.js?session-test=${Date.now()}`);
        const modal = document.getElementById('globalSettingsModal');

        modal.classList.add('active');
        document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
            detail: { modalId: 'globalSettingsModal', active: true },
        }));
        const first = captureSettingsSurfaceSession();
        assert.ok(isCurrentSettingsSurfaceSession(first));

        modal.classList.remove('active');
        document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
            detail: { modalId: 'globalSettingsModal', active: false },
        }));
        assert.equal(isCurrentSettingsSurfaceSession(first), false);

        modal.classList.add('active');
        document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
            detail: { modalId: 'globalSettingsModal', active: true },
        }));
        const second = captureSettingsSurfaceSession();
        assert.ok(second.generation > first.generation);
        assert.equal(isCurrentSettingsSurfaceSession(first), false);
        assert.ok(isCurrentSettingsSurfaceSession(second));

        modal.remove();
        assert.equal(isCurrentSettingsSurfaceSession(second), false);
    } finally {
        globalThis.window = previous.window;
        globalThis.document = previous.document;
    }
});

