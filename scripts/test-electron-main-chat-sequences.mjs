// Seeded, replayable Electron sequences focused on the real main-chat surface.
// Reproduce with: VCPCHAT_SEQUENCE_SEED=<seed> npm run test:electron-main-chat-sequences

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const require = createRequire(import.meta.url);
const { createInitialModel, createTrace, runTrace, serializeTrace } = require('../tests/support/main-chat-sequence.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const timeout = 45_000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const requestedUiMode = process.env.VCPCHAT_SEQUENCE_UI_MODE || 'next';
if (!['classic', 'next'].includes(requestedUiMode)) {
    throw new Error(`Unsupported VCPCHAT_SEQUENCE_UI_MODE: ${requestedUiMode}`);
}

async function waitForChildExit(child, waitMs = 3_000) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise(resolve => {
        const onExit = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, waitMs);
        child.once('exit', onExit);
    });
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function startVcpFixture() {
    const requests = [];
    const server = http.createServer(async (request, response) => {
        if (request.url === '/v1/interrupt') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ success: true, message: 'interrupted' }));
            return;
        }
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw || '{}');
        requests.push(body);
        const requestText = JSON.stringify(body.messages || []);
        if (requestText.includes('sequence-fail')) {
            response.writeHead(503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'controlled fixture failure' } }));
            return;
        }
        if (requestText.includes('sequence-disconnect')) {
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
            setTimeout(() => response.socket?.destroy(), 25);
            return;
        }
        if (body.stream) {
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            for (const content of ['fixture ', 'stream ', 'complete']) {
                response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
                await sleep(120);
            }
            response.end('data: [DONE]\n\n');
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fixture response' } }] }));
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        requests,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

async function writeAgent(appData, id, topics) {
    const agentDir = path.join(appData, 'Agents', id);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'config.json'), JSON.stringify({
        name: id,
        model: 'sequence-model',
        streamOutput: true,
        promptMode: 'original',
        originalSystemPrompt: 'Sequence fixture',
        systemPrompt: 'Sequence fixture',
        stripRegexes: [],
        topics: topics.map((topicId, index) => ({ id: topicId, name: topicId, createdAt: index + 1, locked: true })),
    }), 'utf8');
    for (const topicId of topics) {
        const historyDir = path.join(appData, 'UserData', id, 'topics', topicId);
        await fs.mkdir(historyDir, { recursive: true });
        await fs.writeFile(path.join(historyDir, 'history.json'), JSON.stringify([{
            id: `history-${id}-${topicId}`,
            role: 'assistant',
            content: `${id}/${topicId}`,
            timestamp: 1,
        }]), 'utf8');
    }
}

function requestJson(url) {
    return new Promise((resolve, reject) => http.get(url, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject));
}

const identities = ['SequenceAgentA', 'SequenceAgentB'];
const topics = {
    SequenceAgentA: ['a-one', 'a-two'],
    SequenceAgentB: ['b-one', 'b-two'],
};
const catalog = [
    {
        id: 'select-agent', weight: 5,
        generate: (random, model) => {
            const id = random.pick(identities);
            return { id, topicId: model.lastTopics?.[id] || topics[id][0] };
        },
        transition: (model, { id, topicId }) => ({ ...model, identity: { id, type: 'agent' }, topicId }),
        run: ({ driver, params }) => driver.selectAgent(params.id, params.topicId),
    },
    {
        id: 'race-agents', weight: 4,
        generate: (random, model) => {
            const last = random.pick(identities);
            return { first: identities.find(id => id !== last), last, topicId: model.lastTopics?.[last] || topics[last][0] };
        },
        transition: (model, { last, topicId }) => ({ ...model, identity: { id: last, type: 'agent' }, topicId }),
        run: ({ driver, params }) => driver.raceAgents(params.first, params.last, params.topicId),
    },
    {
        id: 'select-topic', weight: 5,
        canRun: model => Boolean(model.identity),
        generate: (random, model) => ({ id: random.pick(topics[model.identity.id]) }),
        transition: (model, { id }) => ({ ...model, topicId: id, lastTopics: { ...(model.lastTopics || {}), [model.identity.id]: id } }),
        run: ({ driver, params }) => driver.selectTopic(params.id),
    },
    {
        id: 'race-topics', weight: 4,
        canRun: model => Boolean(model.identity),
        generate: (_random, model) => ({ first: topics[model.identity.id][1], last: topics[model.identity.id][0] }),
        transition: (model, { last }) => ({ ...model, topicId: last, lastTopics: { ...(model.lastTopics || {}), [model.identity.id]: last } }),
        run: ({ driver, params }) => driver.raceTopics(params.first, params.last),
    },
    {
        id: 'send-stream-switch', weight: 2,
        canRun: model => Boolean(model.identity && model.topicId),
        generate: (_random, model) => ({
            target: topics[model.identity.id].find(topicId => topicId !== model.topicId) || model.topicId,
        }),
        transition: (model, { target }) => ({
            ...model,
            topicId: target,
            lastTopics: { ...(model.lastTopics || {}), [model.identity.id]: target },
        }),
        run: ({ driver, params }) => driver.sendStreamThenSwitch(params.target),
    },
    {
        id: 'send-stream-cancel', weight: 1,
        canRun: model => Boolean(model.identity && model.topicId),
        transition: model => model,
        run: ({ driver }) => driver.sendStreamThenCancel(),
    },
    {
        id: 'send-failure', weight: 1,
        canRun: model => Boolean(model.identity && model.topicId),
        transition: model => model,
        run: ({ driver }) => driver.sendFault('fail'),
    },
    {
        id: 'send-disconnect', weight: 1,
        canRun: model => Boolean(model.identity && model.topicId),
        transition: model => model,
        run: ({ driver }) => driver.sendFault('disconnect'),
    },
    {
        id: 'settings-escape', weight: 2,
        transition: model => model,
        run: ({ driver }) => driver.settingsEscape(),
    },
    {
        id: 'notification-roundtrip', weight: 2,
        transition: model => model,
        run: ({ driver }) => driver.notificationRoundtrip(),
    },
];

const fixture = await startVcpFixture();
const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-main-sequence-'));
await Promise.all(identities.map(id => writeAgent(appData, id, topics[id])));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: requestedUiMode, enableDistributedServer: false, vcpServerUrl: fixture.url, vcpApiKey: 'sequence-key',
}), 'utf8');
const debugPort = await freePort();
const stderr = { value: '' };
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${debugPort}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', chunk => { stderr.value = `${stderr.value}${chunk}`.slice(-12_000); });

let browser;
try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Electron exited: ${stderr.value}`);
        try { await requestJson(`http://127.0.0.1:${debugPort}/json/version`); break; } catch { await sleep(100); }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
    let page;
    while (Date.now() < deadline && !page) {
        page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
        if (!page) await sleep(100);
    }
    assert.ok(page, `Main renderer missing: ${stderr.value}`);
    const errors = [];
    page.on('pageerror', error => errors.push(error?.stack || String(error)));
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout });
    await page.waitForFunction(ids => ids.every(id => document.querySelector(`#agentList > [data-item-id="${id}"][data-item-type="agent"]`)), { timeout }, identities);

    const click = async selector => page.evaluate(value => document.querySelector(value)?.click(), selector);
    const waitState = async (id, topicId) => {
        try {
            await page.waitForFunction((expectedId, expectedTopic) => (
                window.currentSelectedItem?.id === expectedId
                && window.currentTopicId === expectedTopic
                && document.querySelector(`#agentList > [data-item-id="${expectedId}"][data-item-type="agent"].active`)
                && document.querySelector(`[data-topic-id="${expectedTopic}"].active`)
            ), { timeout: 8_000 }, id, topicId);
        } catch (error) {
            const actual = await page.evaluate(() => ({
                id: window.currentSelectedItem?.id,
                topicId: window.currentTopicId,
                activeItems: [...document.querySelectorAll('#agentList > .active')].map(node => node.dataset.itemId),
                activeTopics: [...document.querySelectorAll('.topic-item.active')].map(node => node.dataset.topicId),
            }));
            throw new Error(`Timed out waiting for ${id}/${topicId}; actual=${JSON.stringify(actual)}`, { cause: error });
        }
    };
    const driver = {
        async selectAgent(id, topicId) {
            await click(`#agentList > [data-item-id="${id}"][data-item-type="agent"]`);
            await waitState(id, topicId);
        },
        async raceAgents(first, last, topicId) {
            await page.evaluate(({ firstId, lastId }) => {
                document.querySelector(`#agentList > [data-item-id="${firstId}"][data-item-type="agent"]`)?.click();
                document.querySelector(`#agentList > [data-item-id="${lastId}"][data-item-type="agent"]`)?.click();
            }, { firstId: first, lastId: last });
            await waitState(last, topicId);
        },
        async selectTopic(topicId) {
            const id = await page.evaluate(() => window.currentSelectedItem.id);
            await click(`[data-topic-id="${topicId}"][data-item-id="${id}"]`);
            await waitState(id, topicId);
        },
        async raceTopics(first, last) {
            const id = await page.evaluate(() => window.currentSelectedItem.id);
            await page.evaluate(({ firstId, lastId, itemId }) => {
                document.querySelector(`[data-topic-id="${firstId}"][data-item-id="${itemId}"]`)?.click();
                document.querySelector(`[data-topic-id="${lastId}"][data-item-id="${itemId}"]`)?.click();
            }, { firstId: first, lastId: last, itemId: id });
            await waitState(id, last);
        },
        async sendStreamThenSwitch(targetTopic) {
            const before = fixture.requests.length;
            await page.evaluate(() => {
                const input = document.getElementById('messageInput');
                input.value = `sequence-switch-${Date.now()}`;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('sendMessageBtn').click();
            });
            const requestDeadline = Date.now() + 5_000;
            while (fixture.requests.length === before && Date.now() < requestDeadline) await sleep(10);
            assert.ok(fixture.requests.length > before, 'stream request did not reach the controlled VCP fixture');
            const id = await page.evaluate(() => window.currentSelectedItem.id);
            await click(`[data-topic-id="${targetTopic}"][data-item-id="${id}"]`);
            await waitState(id, targetTopic);
            await sleep(500);
        },
        async sendStreamThenCancel() {
            const before = fixture.requests.length;
            await page.evaluate(() => {
                const input = document.getElementById('messageInput');
                input.value = `sequence-cancel-${Date.now()}`;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('sendMessageBtn').click();
            });
            await page.waitForFunction(() => document.getElementById('sendMessageBtn')?.dataset.mode === 'interrupt', { timeout: 5_000 });
            await click('#sendMessageBtn');
            const requestDeadline = Date.now() + 5_000;
            while (fixture.requests.length === before && Date.now() < requestDeadline) await sleep(10);
            assert.ok(fixture.requests.length > before, 'cancelled stream never reached the controlled VCP fixture');
            try {
                await page.waitForFunction(() => document.getElementById('sendMessageBtn')?.dataset.mode !== 'interrupt', { timeout: 8_000 });
            } catch (error) {
                const state = await page.evaluate(() => ({
                    mode: document.getElementById('sendMessageBtn')?.dataset.mode,
                    activeStreamId: window.streamManager?.getActiveStreamingMessageId?.(),
                    activeContext: window.streamManager?.getActiveStreamingContext?.(),
                    streamingDom: [...document.querySelectorAll('.message-item.streaming')].map(node => node.dataset.messageId),
                }));
                throw new Error(`cancel did not settle: ${JSON.stringify(state)}`, { cause: error });
            }
        },
        async sendFault(kind) {
            const before = fixture.requests.length;
            await page.evaluate(faultKind => {
                const input = document.getElementById('messageInput');
                input.value = `sequence-${faultKind}-${Date.now()}`;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('sendMessageBtn').click();
            }, kind);
            const requestDeadline = Date.now() + 5_000;
            while (fixture.requests.length === before && Date.now() < requestDeadline) await sleep(10);
            assert.ok(fixture.requests.length > before, `${kind} request did not reach the controlled VCP fixture`);
            await page.waitForFunction(() => (
                document.getElementById('sendMessageBtn')?.dataset.mode !== 'interrupt'
                && document.querySelectorAll('.message-item.streaming').length === 0
            ), { timeout: 8_000 });
        },
        async settingsEscape() {
            await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
            await page.waitForFunction(() => document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout });
            await page.keyboard.press('Escape');
            await page.evaluate(() => {
                if (document.getElementById('globalSettingsModal')?.classList.contains('active')) {
                    window.uiHelperFunctions.closeModal('globalSettingsModal');
                }
            });
            await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout });
        },
        async notificationRoundtrip() {
            await click('#toggleNotificationsBtn');
            await sleep(20);
            await click('#toggleNotificationsBtn');
        },
    };
    const observe = () => page.evaluate(() => ({
        identity: window.currentSelectedItem?.id || null,
        topicId: window.currentTopicId || null,
        activeItems: [...document.querySelectorAll('#agentList > [data-item-id][data-item-type].active')].map(node => node.dataset.itemId),
        activeTopics: [...document.querySelectorAll('.topic-item.active')].map(node => node.dataset.topicId),
        rendererReady: document.documentElement.dataset.vcpRendererReady,
        mode: document.documentElement.dataset.uiMode,
        settingsActive: document.getElementById('globalSettingsModal')?.classList.contains('active') === true,
        mainConnected: Boolean(document.querySelector('.container')?.isConnected && document.querySelector('.main-content')?.isConnected),
        streamingMessages: document.querySelectorAll('.message-item.streaming').length,
        lifecycle: window.VCPLifecycle?.diagnostics?.summary?.() || null,
    }));
    // Freeze the resource baseline only after lazy settings, notification and
    // streaming paths have each initialized once. Measuring at renderer-ready
    // would classify legitimate first-use registration as a leak.
    await driver.selectAgent(identities[0], topics[identities[0]][0]);
    await driver.settingsEscape();
    await driver.notificationRoundtrip();
    await driver.sendFault('fail');
    const baselineSnapshot = await observe();
    const seed = process.env.VCPCHAT_SEQUENCE_SEED || `${requestedUiMode}-main-chat-default`;
    const trace = createTrace({
        seed,
        steps: Number.parseInt(process.env.VCPCHAT_SEQUENCE_STEPS || '24', 10),
        initialModel: createInitialModel({
            identity: { id: identities[0], type: 'agent' },
            topicId: topics[identities[0]][0],
            lastTopics: { [identities[0]]: topics[identities[0]][0] },
            conversation: 'history',
        }),
        catalog,
    });
    try {
        await runTrace({
            trace, catalog, driver, observe,
            assertInvariant: ({ model, snapshot, index }) => {
                assert.equal(snapshot.rendererReady, 'true', `step ${index}: renderer lost readiness`);
                assert.equal(snapshot.mode, requestedUiMode, `step ${index}: mode changed`);
                assert.equal(snapshot.settingsActive, false, `step ${index}: modal retained`);
                assert.equal(snapshot.mainConnected, true, `step ${index}: main chat surface disappeared`);
                assert.equal(snapshot.streamingMessages, 0, `step ${index}: stream owner survived settle`);
                if (model.identity) {
                    assert.equal(snapshot.identity, model.identity.id, `step ${index}: selected identity diverged`);
                    assert.equal(snapshot.topicId, model.topicId, `step ${index}: selected topic diverged`);
                    assert.deepEqual(snapshot.activeItems, [model.identity.id], `step ${index}: active item DOM diverged`);
                    assert.deepEqual(snapshot.activeTopics, [model.topicId], `step ${index}: active topic DOM diverged`);
                }
            },
        });
    } catch (error) {
        error.message += `\nReplay trace (${seed}):\n${serializeTrace(trace)}`;
        throw error;
    }
    const finalSnapshot = await observe();
    assert.equal(finalSnapshot.lifecycle?.activeScopes, baselineSnapshot.lifecycle?.activeScopes, 'lifecycle scope count drifted across the trace');
    assert.equal(finalSnapshot.lifecycle?.activeResources, baselineSnapshot.lifecycle?.activeResources, 'managed resource count drifted across the trace');
    assert.deepEqual(errors, [], `Renderer errors:\n${errors.join('\n')}`);
    assert.ok(fixture.requests.length > 0, 'default sequence must exercise the controlled VCP fixture');
    console.log(`Main-chat Electron sequence passed: mode=${requestedUiMode}, seed=${trace.seed}, steps=${trace.actions.length}, VCP requests=${fixture.requests.length}`);
} finally {
    try { await browser?.disconnect(); } catch { /* noop */ }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (!await waitForChildExit(child)) {
        child.kill('SIGKILL');
        await waitForChildExit(child);
    }
    await fixture.close();
    await fs.rm(appData, { recursive: true, force: true });
}
