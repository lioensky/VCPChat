import test from 'node:test';
import assert from 'node:assert/strict';
import { StartupThemeGate, loadSettingsWithTimeout, withTimeout } from '../modules/ui-system/startup-theme-gate.js';

test('startup theme gate releases once and surfaces a non-blocking error', () => {
    const calls = [];
    const status = { hidden: true, textContent: '' };
    const gate = new StartupThemeGate({
        applyTheme: mode => calls.push(mode),
        statusElement: status,
    });

    gate.release({ mode: 'system' });
    gate.release({ mode: 'dark', message: '设置加载超时' });

    assert.deepEqual(calls, ['system']);
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, '设置加载超时');
});

test('withTimeout settles a slow settings request with a bounded error', async () => {
    await assert.rejects(
        withTimeout(new Promise(() => {}), 5, 'settings timeout'),
        /settings timeout/
    );
});

test('withTimeout preserves a successful settings result', async () => {
    await assert.doesNotReject(async () => {
        const value = await withTimeout(Promise.resolve({ currentThemeMode: 'dark' }), 50);
        assert.deepEqual(value, { currentThemeMode: 'dark' });
    });
});

test('loadSettingsWithTimeout rejects a missing API and a failed IPC call', async () => {
    await assert.rejects(
        loadSettingsWithTimeout(undefined, 10),
        /Settings API unavailable/
    );
    await assert.rejects(
        loadSettingsWithTimeout(() => Promise.reject(new Error('ipc failed')), 10),
        /ipc failed/
    );
});
