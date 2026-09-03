import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('missing topicSummaryModel uses the settings-page default', async () => {
    const root = process.cwd();
    const managerModule = await import(`../modules/utils/appSettingsManager.js?topic-summary=${Date.now()}`);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-topic-summary-'));
    const manager = new managerModule.default(path.join(tempDir, 'settings.json'));
    const defaults = await manager.readSettings();
    assert.equal(defaults.topicSummaryModel, 'gemini-2.5-flash-preview-05-20');
    await fs.writeFile(path.join(tempDir, 'settings.json'), JSON.stringify({ vcpServerUrl: '' }));
    manager.clearCache();
    const legacySettings = await manager.readSettings({ fresh: true });
    assert.equal(legacySettings.topicSummaryModel, 'gemini-2.5-flash-preview-05-20');

    const previousWindow = globalThis.window;
    const previousFetch = globalThis.fetch;
    let requestBody;
    globalThis.window = {
        chatAPI: {
            async loadSettings() {
                return { vcpServerUrl: 'https://vcpchat.test/v1/chat/completions', vcpApiKey: 'key' };
            },
        },
    };
    globalThis.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, async json() { return { choices: [{ message: { content: '测试标题' } }] }; } };
    };
    try {
        const moduleUrl = new URL('../modules/topicSummarizer.js', import.meta.url);
        moduleUrl.search = `?topic-summary=${Date.now()}`;
        await import(moduleUrl.href);
        const title = await globalThis.window.summarizeTopicFromMessages([
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好' },
            { role: 'user', content: '请总结' },
            { role: 'assistant', content: '好的' },
        ], '助手');
        assert.equal(title, '测试标题');
        assert.equal(requestBody.model, 'gemini-2.5-flash-preview-05-20');
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        if (previousFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = previousFetch;
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
