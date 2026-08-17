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
const { SequenceCoverage, createInitialModel, createTrace, runTrace, serializeTrace } = require('../tests/support/main-chat-sequence.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const timeout = 45_000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const safeFilePart = value => String(value).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'unknown';
const requestedUiMode = process.env.VCPCHAT_SEQUENCE_UI_MODE || 'next';
if (!['classic', 'next'].includes(requestedUiMode)) {
    throw new Error(`Unsupported VCPCHAT_SEQUENCE_UI_MODE: ${requestedUiMode}`);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function regressionSlope(values) {
    if (values.length < 2) return 0;
    const xMean = (values.length - 1) / 2;
    const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    let numerator = 0;
    let denominator = 0;
    values.forEach((value, index) => {
        numerator += (index - xMean) * (value - yMean);
        denominator += (index - xMean) ** 2;
    });
    return denominator ? numerator / denominator : 0;
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
    const pending = new Map();
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
        const latestUserMessage = [...(body.messages || [])].reverse().find(message => message?.role === 'user');
        const requestText = JSON.stringify(latestUserMessage?.content || '');
        const holdMatch = requestText.match(/sequence-hold-([a-z0-9-]+)/i);
        let heldRequest = null;
        if (holdMatch) {
            heldRequest = deferred();
            pending.set(holdMatch[1], heldRequest);
            await heldRequest.promise;
            pending.delete(holdMatch[1]);
        }
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
            const responsePrefix = holdMatch ? `${holdMatch[1]} ` : 'fixture ';
            for (const content of [responsePrefix, 'stream ', 'complete']) {
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
        pending,
        release(key) {
            const heldRequest = pending.get(key);
            if (!heldRequest) throw new Error(`No held VCP request: ${key}`);
            heldRequest.resolve();
        },
        async waitPending(key, waitMs = 8_000) {
            const deadline = Date.now() + waitMs;
            while (!pending.has(key) && Date.now() < deadline) await sleep(10);
            assert.ok(pending.has(key), `VCP request did not enter hold state: ${key}`);
        },
        close: () => {
            for (const heldRequest of pending.values()) heldRequest.resolve();
            pending.clear();
            return new Promise(resolve => server.close(resolve));
        },
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
let remainingCrashScenarioBudget = positiveInteger(process.env.VCPCHAT_SEQUENCE_CRASH_BUDGET, 2);
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
        id: 'concurrent-streams-reverse', weight: 2,
        canRun: model => Boolean(model.identity && model.topicId),
        generate: (random, model) => ({
            target: topics[model.identity.id].find(topicId => topicId !== model.topicId) || model.topicId,
            nonce: random.integer(0, 0xFFFFFFFF).toString(36),
        }),
        transition: (model, { target }) => ({
            ...model,
            topicId: target,
            lastTopics: { ...(model.lastTopics || {}), [model.identity.id]: target },
        }),
        run: ({ driver, params }) => driver.concurrentStreamsReverse(params.target, params.nonce),
    },
    {
        id: 'create-delete-topic-roundtrip', weight: 1,
        canRun: model => Boolean(model.identity && model.topicId),
        generate: (_random, model) => ({ target: topics[model.identity.id][1] }),
        transition: (model, { target }) => ({
            ...model,
            topicId: target,
            lastTopics: { ...(model.lastTopics || {}), [model.identity.id]: target },
        }),
        run: ({ driver, params }) => driver.createDeleteTopicRoundtrip(params.target),
    },
    {
        id: 'send-failure', weight: 1,
        fault: true,
        canRun: model => Boolean(model.identity && model.topicId),
        transition: model => model,
        run: ({ driver }) => driver.sendFault('fail'),
    },
    {
        id: 'send-disconnect', weight: 1,
        fault: true,
        canRun: model => Boolean(model.identity && model.topicId),
        transition: model => model,
        run: ({ driver }) => driver.sendFault('disconnect'),
    },
    {
        id: 'reload-during-stream', weight: 1,
        fault: true,
        canRun: model => Boolean(model.identity && model.topicId) && Number(model.rendererReloads || 0) < 1,
        generate: random => ({ nonce: random.integer(0, 0xFFFFFFFF).toString(36) }),
        transition: model => ({ ...model, rendererReloads: Number(model.rendererReloads || 0) + 1 }),
        run: ({ driver, params }) => driver.recoverDuringHeldStream('reload', params.nonce),
    },
    {
        id: 'crash-during-stream', weight: 1,
        fault: true,
        canRun: model => Boolean(model.identity && model.topicId)
            && Number(model.rendererCrashes || 0) < 1
            && Number(model.crashBudget || 0) > 0,
        generate: random => ({ nonce: random.integer(0, 0xFFFFFFFF).toString(36) }),
        transition: model => ({
            ...model,
            rendererCrashes: Number(model.rendererCrashes || 0) + 1,
            crashBudget: Math.max(0, Number(model.crashBudget || 0) - 1),
        }),
        run: ({ driver, params }) => driver.recoverDuringHeldStream('crash', params.nonce),
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
    {
        id: 'embedded-open-close-reverse', weight: 1,
        canRun: () => requestedUiMode === 'next',
        transition: model => model,
        run: ({ driver }) => driver.embeddedOpenCloseReverse(),
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
    const consoleMessages = [];
    const trackedPages = new WeakSet();
    const trackPage = candidate => {
        if (!candidate || trackedPages.has(candidate)) return;
        trackedPages.add(candidate);
        candidate.on('pageerror', error => errors.push(error?.stack || String(error)));
        candidate.on('console', message => {
            const entry = { at: Date.now(), type: message.type(), text: message.text().slice(0, 2_000) };
            consoleMessages.push(entry);
            if (consoleMessages.length > 200) consoleMessages.splice(0, consoleMessages.length - 200);
        });
    };
    trackPage(page);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout });
    await page.waitForFunction(ids => ids.every(id => document.querySelector(`#agentList > [data-item-id="${id}"][data-item-type="agent"]`)), { timeout }, identities);

    const click = async selector => page.evaluate(value => document.querySelector(value)?.click(), selector);
    const waitForRecoveredMainPage = async () => {
        const recoveryDeadline = Date.now() + 12_000;
        while (Date.now() < recoveryDeadline) {
            for (const candidate of await browser.pages()) {
                if (candidate.isClosed() || !candidate.url().includes('main.html')) continue;
                try {
                    const ready = await candidate.evaluate(() => document.documentElement.dataset.vcpRendererReady === 'true');
                    if (ready) {
                        trackPage(candidate);
                        return candidate;
                    }
                } catch {
                    // The old execution context can disappear while recovery is loading.
                }
            }
            await sleep(100);
        }
        throw new Error('Main renderer did not recover after reload/crash.');
    };
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
    const openCloseSettings = async () => {
        await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
        await page.waitForFunction(() => document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout });
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
            if (document.getElementById('globalSettingsModal')?.classList.contains('active')) {
                window.uiHelperFunctions.closeModal('globalSettingsModal');
            }
        });
        await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout });
    };
    const warmRendererLifecycleBaseline = async () => {
        await openCloseSettings();
        await click('#toggleNotificationsBtn');
        await sleep(20);
        await click('#toggleNotificationsBtn');
    };
    const waitForStreamQuiescence = async () => {
        await page.waitForFunction(() => {
            const streams = window.streamManager?.getDiagnostics?.();
            return !streams
                || (
                    streams.activeMessageId === null
                    && streams.activeInitializations === 0
                    && streams.prebuffered === 0
                    && streams.pendingFinalizations === 0
                );
        }, { timeout: 8_000 });
        return page.evaluate(() => window.streamManager?.getDiagnostics?.() || null);
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
        async concurrentStreamsReverse(targetTopic, nonce) {
            const itemId = await page.evaluate(() => window.currentSelectedItem.id);
            const sourceTopic = await page.evaluate(() => window.currentTopicId);
            const firstKey = `first-${nonce}`;
            const secondKey = `second-${nonce}`;
            const sendHeld = key => page.evaluate(holdKey => {
                const input = document.getElementById('messageInput');
                input.value = `sequence-hold-${holdKey}`;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('sendMessageBtn').click();
            }, key);

            await sendHeld(firstKey);
            await fixture.waitPending(firstKey);
            await click(`[data-topic-id="${targetTopic}"][data-item-id="${itemId}"]`);
            await waitState(itemId, targetTopic);

            await sendHeld(secondKey);
            await fixture.waitPending(secondKey);
            fixture.release(secondKey);
            const secondDeadline = Date.now() + 8_000;
            while (fixture.pending.has(secondKey) && Date.now() < secondDeadline) await sleep(10);
            assert.equal(fixture.pending.has(secondKey), false, 'second stream did not complete after release');

            fixture.release(firstKey);
            const firstDeadline = Date.now() + 8_000;
            while (fixture.pending.has(firstKey) && Date.now() < firstDeadline) await sleep(10);
            assert.equal(fixture.pending.has(firstKey), false, 'first stream did not complete after release');
            await page.waitForFunction(() => (
                document.getElementById('sendMessageBtn')?.dataset.mode !== 'interrupt'
                && document.querySelectorAll('.message-item.streaming').length === 0
            ), { timeout: 8_000 });

            const readHistories = () => Promise.all([sourceTopic, targetTopic].map(async topicId => {
                const source = await fs.readFile(path.join(appData, 'UserData', itemId, 'topics', topicId, 'history.json'), 'utf8');
                // The unchanged upstream persistence handler writes JSON in
                // place. An external observer can therefore sample the brief
                // truncate/write window even though the renderer-side save
                // promise has not settled yet. Treat that sample as pending;
                // the deadline below still requires two complete histories.
                try { return JSON.parse(source); } catch { return null; }
            }));
            let histories = await readHistories();
            const persistenceDeadline = Date.now() + 4_000;
            const historiesAreSettled = () => histories.every(topicHistory => (
                Array.isArray(topicHistory)
                && !topicHistory.some(message => message.isThinking || message.isPendingStream)
                && topicHistory.some(message => message.role === 'assistant' && /complete/.test(message.content || ''))
            ));
            while (!historiesAreSettled() && Date.now() < persistenceDeadline) {
                await sleep(50);
                histories = await readHistories();
            }
            for (const topicHistory of histories) {
                assert.ok(Array.isArray(topicHistory), `concurrent stream history was not readable after settlement: ${JSON.stringify(histories)}`);
                assert.equal(
                    topicHistory.some(message => message.isThinking || message.isPendingStream),
                    false,
                    'concurrent stream left a transient message on disk'
                );
                assert.ok(
                    topicHistory.some(message => message.role === 'assistant' && /complete/.test(message.content || '')),
                    `concurrent stream response was not persisted: ${JSON.stringify(histories)}`
                );
            }
        },
        async createDeleteTopicRoundtrip(expectedTopic) {
            const item = await page.evaluate(() => ({
                id: window.currentSelectedItem.id,
                type: window.currentSelectedItem.type,
            }));
            const createdTopicId = await page.evaluate(async ({ itemId, itemType }) => {
                const before = new Set((await window.chatAPI.getAgentTopics(itemId)).map(topic => topic.id));
                await window.chatManager.createNewTopicForItem(itemId, itemType);
                const after = await window.chatAPI.getAgentTopics(itemId);
                return after.find(topic => !before.has(topic.id))?.id || null;
            }, { itemId: item.id, itemType: item.type });
            assert.ok(createdTopicId, 'topic creation roundtrip did not produce a topic');
            await waitState(item.id, createdTopicId);

            const deletion = await page.evaluate(async ({ itemId, itemType, topicId }) => {
                const result = await window.chatAPI.deleteTopic(itemId, topicId);
                if (!result?.success) return result;
                await window.chatManager.handleTopicDeletion(result.remainingTopics, { id: itemId, type: itemType });
                return result;
            }, { itemId: item.id, itemType: item.type, topicId: createdTopicId });
            assert.equal(deletion?.success, true, `topic deletion roundtrip failed: ${JSON.stringify(deletion)}`);
            await waitState(item.id, expectedTopic);
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
        async recoverDuringHeldStream(kind, nonce) {
            const expected = await page.evaluate(() => ({
                id: window.currentSelectedItem?.id,
                topicId: window.currentTopicId,
            }));
            assert.ok(expected.id && expected.topicId, `${kind}: no selected conversation`);
            const key = `${kind}-${nonce}`;
            await page.evaluate(holdKey => {
                const input = document.getElementById('messageInput');
                input.value = `sequence-hold-${holdKey}`;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('sendMessageBtn').click();
            }, key);
            await fixture.waitPending(key);

            try {
                if (kind === 'reload') {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 12_000 });
                } else {
                    const crashSession = await page.createCDPSession();
                    try {
                        await crashSession.send('Page.crash');
                    } catch (error) {
                        if (!/Target closed|Session closed|crash/i.test(String(error?.message || error))) throw error;
                    }
                    try { await crashSession.detach(); } catch { /* crashed target */ }
                }
                page = await waitForRecoveredMainPage();
                await page.waitForFunction(ids => ids.every(id => document.querySelector(`#agentList > [data-item-id="${id}"][data-item-type="agent"]`)), { timeout: 12_000 }, identities);
                await waitState(expected.id, expected.topicId);
                // A reload creates a new renderer epoch. Re-open every lazily
                // registered surface used by the baseline before comparing
                // ownership counts across epochs.
                await warmRendererLifecycleBaseline();
            } finally {
                if (fixture.pending.has(key)) fixture.release(key);
            }

            const settleDeadline = Date.now() + 8_000;
            while (fixture.pending.has(key) && Date.now() < settleDeadline) await sleep(20);
            assert.equal(fixture.pending.has(key), false, `${kind}: held request did not settle`);
            await page.waitForFunction(() => (
                document.getElementById('sendMessageBtn')?.dataset.mode !== 'interrupt'
                && document.querySelectorAll('.message-item.streaming').length === 0
                && !window.streamManager?.getActiveStreamingMessageId?.()
            ), { timeout: 8_000 });

            const historySource = await fs.readFile(
                path.join(appData, 'UserData', expected.id, 'topics', expected.topicId, 'history.json'),
                'utf8'
            );
            const durableHistory = JSON.parse(historySource);
            assert.equal(
                durableHistory.some(message => message.isThinking || message.isPendingStream),
                false,
                `${kind}: transient stream state survived renderer recovery`
            );
        },
        async settingsEscape() {
            await openCloseSettings();
        },
        async notificationRoundtrip() {
            await click('#toggleNotificationsBtn');
            await sleep(20);
            await click('#toggleNotificationsBtn');
        },
        async embeddedOpenCloseReverse() {
            const result = await page.evaluate(async () => {
                const app = window.trayManager?.getApps?.().find(candidate => candidate.id === 'vchat-app-notes');
                if (!app) return { error: 'notes app missing' };
                const opening = window.topTabManager.openEmbeddedApp(app);
                window.topTabManager.closeView(`app:${app.id}`);
                await opening;
                await window.topTabManager.whenSettled({ timeoutMs: 8_000 });
                return {
                    viewPresent: Boolean(document.querySelector(`[data-view-id="app:${app.id}"]`)),
                    internalPresent: Boolean(document.querySelector(`[data-app-id="${app.id}"]`)),
                    main: await window.VCPLifecycleInspector?.snapshotMain?.(),
                };
            });
            assert.equal(result.error, undefined, result.error);
            assert.equal(result.viewPresent, false, 'reverse embedded completion restored a closed tab');
            assert.equal(result.internalPresent, false, 'reverse embedded completion restored a closed host');
            assert.deepEqual(result.main?.embeddedSessions || [], [], 'reverse embedded completion retained a main-process session');
            assert.equal(result.main?.activeEmbeddedAction || null, null, 'reverse embedded completion retained overlay ownership');
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
        streams: window.streamManager?.getDiagnostics?.() || null,
        lifecycle: window.VCPLifecycle?.diagnostics?.summary?.() || null,
    }));
    const collectResourceCheckpoint = async label => {
        const rendererSession = await page.createCDPSession();
        const browserSession = await browser.target().createCDPSession();
        try {
            for (let pass = 0; pass < 3; pass += 1) {
                await rendererSession.send('HeapProfiler.collectGarbage');
                await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
                await sleep(25);
            }
            const [heap, dom, processInfo, snapshot, mainLifecycle, pages] = await Promise.all([
                rendererSession.send('Runtime.getHeapUsage'),
                rendererSession.send('Memory.getDOMCounters'),
                browserSession.send('SystemInfo.getProcessInfo'),
                observe(),
                page.evaluate(() => window.VCPLifecycleInspector?.snapshotMain?.() || null),
                browser.pages(),
            ]);
            const processes = processInfo.processInfo || [];
            return {
                label,
                heapUsed: heap.usedSize,
                documents: dom.documents,
                nodes: dom.nodes,
                listeners: dom.jsEventListeners,
                pages: pages.filter(candidate => !candidate.isClosed()).length,
                processes: processes.length,
                rendererProcesses: processes.filter(process => /renderer/i.test(process.type || '')).length,
                lifecycle: snapshot.lifecycle,
                mainLifecycle,
            };
        } finally {
            await rendererSession.detach().catch(() => {});
            await browserSession.detach().catch(() => {});
        }
    };
    let sequenceCoverage = null;
    const writeFailureArtifacts = async ({ error, trace, seed, runIndex = 0, snapshot = null }) => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const directory = path.join(
            root,
            'screenshots',
            'main-chat-sequences',
            `${timestamp}-${safeFilePart(seed)}-run-${runIndex + 1}`
        );
        await fs.mkdir(directory, { recursive: true });

        let rendererLifecycle = null;
        let mainLifecycle = null;
        let pageUrls = [];
        try { rendererLifecycle = await page.evaluate(() => window.VCPLifecycleInspector?.snapshot?.() || null); } catch { /* renderer unavailable */ }
        try { mainLifecycle = await page.evaluate(() => window.VCPLifecycleInspector?.snapshotMain?.() || null); } catch { /* main bridge unavailable */ }
        try { pageUrls = (await browser.pages()).filter(candidate => !candidate.isClosed()).map(candidate => candidate.url()); } catch { /* browser unavailable */ }
        try { await page.screenshot({ path: path.join(directory, 'main-renderer.png'), fullPage: true }); } catch { /* renderer unavailable */ }

        const errorText = `${error?.stack || error}\n`;
        await Promise.all([
            fs.writeFile(path.join(directory, 'trace.json'), serializeTrace(trace), 'utf8'),
            fs.writeFile(path.join(directory, 'error.txt'), errorText, 'utf8'),
            fs.writeFile(path.join(directory, 'business-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'),
            fs.writeFile(path.join(directory, 'renderer-lifecycle.json'), `${JSON.stringify(rendererLifecycle, null, 2)}\n`, 'utf8'),
            fs.writeFile(path.join(directory, 'main-lifecycle.json'), `${JSON.stringify(mainLifecycle, null, 2)}\n`, 'utf8'),
            fs.writeFile(path.join(directory, 'page-urls.json'), `${JSON.stringify(pageUrls, null, 2)}\n`, 'utf8'),
            fs.writeFile(path.join(directory, 'renderer-console-tail.json'), `${JSON.stringify(consoleMessages.slice(-100), null, 2)}\n`, 'utf8'),
            fs.writeFile(path.join(directory, 'renderer-errors.txt'), `${errors.join('\n\n')}\n`, 'utf8'),
            fs.writeFile(path.join(directory, 'electron-stderr.txt'), `${stderr.value}\n`, 'utf8'),
            fs.writeFile(path.join(directory, 'coverage.json'), `${JSON.stringify(sequenceCoverage?.report?.() || null, null, 2)}\n`, 'utf8'),
        ]);
        console.error(`Main-chat sequence failure artifacts: ${directory}`);
        return directory;
    };
    // Freeze the resource baseline only after lazy settings, notification and
    // streaming paths have each initialized once. Measuring at renderer-ready
    // would classify legitimate first-use registration as a leak.
    const ensureInitialConversation = async () => {
        const itemId = identities[0];
        const topicId = topics[itemId][0];
        await click(`#agentList > [data-item-id="${itemId}"][data-item-type="agent"]`);
        await page.waitForFunction(expectedId => window.currentSelectedItem?.id === expectedId, { timeout: 8_000 }, itemId);
        const activeTopic = await page.evaluate(() => window.currentTopicId);
        if (activeTopic !== topicId) {
            await page.evaluate(expectedTopicId => window.chatManager.selectTopic(expectedTopicId), topicId);
        }
        await waitState(itemId, topicId);
    };
    const resetFixtureConversationState = async () => {
        await page.evaluate(async fixtureTopics => {
            for (const [itemId, topicIds] of Object.entries(fixtureTopics)) {
                window.localStorage.setItem(`lastActiveTopic_${itemId}_agent`, topicIds[0]);
                for (const topicId of topicIds) {
                    await window.chatAPI.saveChatHistory(itemId, topicId, [{
                        id: `history-${itemId}-${topicId}`,
                        role: 'assistant',
                        content: `${itemId}/${topicId}`,
                        timestamp: 1,
                    }]);
                }
            }
        }, topics);
        await ensureInitialConversation();
        await page.evaluate(({ itemId, topicId }) => (
            window.chatManager.loadChatHistory(itemId, 'agent', topicId)
        ), { itemId: identities[0], topicId: topics[identities[0]][0] });
        await page.evaluate(() => window.streamManager?.cleanupTransientState?.());
    };
    await ensureInitialConversation();
    await warmRendererLifecycleBaseline();
    await driver.sendFault('fail');
    await resetFixtureConversationState();
    const baselineSnapshot = await observe();
    const baselineLifecycleDetails = await page.evaluate(() => window.VCPLifecycleInspector?.snapshot?.() || null);
    const baseResourceCheckpoint = await collectResourceCheckpoint('baseline');
    const seed = process.env.VCPCHAT_SEQUENCE_SEED || `${requestedUiMode}-main-chat-default`;
    const runCount = positiveInteger(process.env.VCPCHAT_SEQUENCE_RUNS, 1);
    const stepCount = positiveInteger(process.env.VCPCHAT_SEQUENCE_STEPS, 24);
    const fullCoverageGate = runCount >= 20;
    const requiredEdges = fullCoverageGate ? [
        'action:select-agent',
        'action:race-agents',
        'action:race-topics',
        'action:send-failure',
        'action:send-disconnect',
        'action:reload-during-stream',
        'action:settings-escape',
        'action:notification-roundtrip',
        'pair:settings-escape->notification-roundtrip',
        'fault:send-failure',
        'fault:send-disconnect',
        'fault:reload-during-stream',
        'outcome:completed',
        ...(requestedUiMode === 'next' ? ['action:embedded-open-close-reverse'] : []),
    ] : ['outcome:completed'];
    sequenceCoverage = new SequenceCoverage({ requiredEdges });
    const checkpoints = [];
    let totalActions = 0;
    let lastTrace = null;
    let lastRunSeed = seed;
    let lastRunIndex = 0;
    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
        await resetFixtureConversationState();
        const runSeed = runCount === 1 ? seed : `${seed}:${runIndex + 1}`;
        let trace = createTrace({
            seed: runSeed,
            steps: stepCount,
            initialModel: createInitialModel({
                identity: { id: identities[0], type: 'agent' },
                topicId: topics[identities[0]][0],
                lastTopics: { [identities[0]]: topics[identities[0]][0] },
                conversation: 'history',
                crashBudget: remainingCrashScenarioBudget > 0 ? 1 : 0,
            }),
            catalog,
        });
        if (fullCoverageGate && runIndex === 0) {
            const prefix = [
                { id: 'select-agent', params: { id: identities[1], topicId: topics[identities[1]][0] } },
                { id: 'race-agents', params: { first: identities[0], last: identities[1], topicId: topics[identities[1]][0] } },
                { id: 'race-topics', params: { first: topics[identities[1]][1], last: topics[identities[1]][0] } },
                { id: 'settings-escape', params: {} },
                { id: 'notification-roundtrip', params: {} },
                { id: 'send-failure', params: {} },
                { id: 'send-disconnect', params: {} },
                { id: 'reload-during-stream', params: { nonce: 'required-edge' } },
                ...(requestedUiMode === 'next' ? [{ id: 'embedded-open-close-reverse', params: {} }] : []),
                { id: 'select-agent', params: { id: identities[0], topicId: topics[identities[0]][0] } },
            ];
            trace = Object.freeze({
                ...trace,
                actions: Object.freeze([...prefix, ...trace.actions.filter(action => action.id !== 'reload-during-stream')]),
            });
        }
        lastTrace = trace;
        lastRunSeed = runSeed;
        lastRunIndex = runIndex;
        if (trace.actions.some(action => action.id === 'crash-during-stream')) {
            remainingCrashScenarioBudget -= 1;
        }
        totalActions += trace.actions.length;
        try {
            await runTrace({
                trace, catalog, driver, observe, coverage: sequenceCoverage,
                assertInvariant: async ({ model, snapshot, index }) => {
                    const settledStreams = await waitForStreamQuiescence();
                    assert.equal(snapshot.rendererReady, 'true', `run ${runIndex + 1}, step ${index}: renderer lost readiness`);
                    assert.equal(snapshot.mode, requestedUiMode, `run ${runIndex + 1}, step ${index}: mode changed`);
                    assert.equal(snapshot.settingsActive, false, `run ${runIndex + 1}, step ${index}: modal retained`);
                    assert.equal(snapshot.mainConnected, true, `run ${runIndex + 1}, step ${index}: main chat surface disappeared`);
                    assert.equal(snapshot.streamingMessages, 0, `run ${runIndex + 1}, step ${index}: stream owner survived settle`);
                    assert.equal(settledStreams?.activeInitializations || 0, 0, `run ${runIndex + 1}, step ${index}: active stream initialization survived settle`);
                    assert.equal(settledStreams?.prebuffered || 0, 0, `run ${runIndex + 1}, step ${index}: stream prebuffer survived settle`);
                    assert.equal(settledStreams?.pendingFinalizations || 0, 0, `run ${runIndex + 1}, step ${index}: deferred finalization survived settle`);
                    if (model.identity) {
                        assert.equal(snapshot.identity, model.identity.id, `run ${runIndex + 1}, step ${index}: selected identity diverged`);
                        assert.equal(snapshot.topicId, model.topicId, `run ${runIndex + 1}, step ${index}: selected topic diverged`);
                        assert.deepEqual(snapshot.activeItems, [model.identity.id], `run ${runIndex + 1}, step ${index}: active item DOM diverged`);
                        assert.deepEqual(snapshot.activeTopics, [model.topicId], `run ${runIndex + 1}, step ${index}: active topic DOM diverged`);
                    }
                },
            });
        } catch (error) {
            const failedSnapshot = await observe().catch(() => null);
            await writeFailureArtifacts({ error, trace, seed: runSeed, runIndex, snapshot: failedSnapshot }).catch(artifactError => {
                error.message += `\nFailure artifact capture also failed: ${artifactError?.stack || artifactError}`;
            });
            error.message += `\nReplay trace (${runSeed}):\n${serializeTrace(trace)}`;
            throw error;
        }
        await waitForStreamQuiescence();
        await resetFixtureConversationState();
        const checkpoint = await collectResourceCheckpoint(`run-${runIndex + 1}`);
        checkpoints.push(checkpoint);
        if (
            process.env.VCPCHAT_SEQUENCE_DEBUG === '1'
            && checkpoint.lifecycle?.activeResources !== baselineSnapshot.lifecycle?.activeResources
        ) {
            const finalLifecycleDetails = await page.evaluate(() => window.VCPLifecycleInspector?.snapshot?.() || null);
            console.error(JSON.stringify({ baselineLifecycleDetails, finalLifecycleDetails }, null, 2));
        }
        try {
            assert.equal(checkpoint.lifecycle?.activeScopes, baselineSnapshot.lifecycle?.activeScopes, 'lifecycle scope count drifted across a trace');
            assert.equal(checkpoint.lifecycle?.activeResources, baselineSnapshot.lifecycle?.activeResources, 'managed resource count drifted across a trace');
            assert.equal(checkpoint.pages, baseResourceCheckpoint.pages, 'WebContents/page count drifted across a trace');
            assert.equal(checkpoint.processes, baseResourceCheckpoint.processes, 'Electron process count drifted across a trace');
            assert.equal(checkpoint.rendererProcesses, baseResourceCheckpoint.rendererProcesses, 'renderer process count drifted across a trace');
            assert.deepEqual(checkpoint.mainLifecycle?.embeddedSessions || [], [], 'main-process embedded sessions survived a trace');
            assert.equal(checkpoint.mainLifecycle?.activeEmbeddedAction || null, null, 'main-process overlay ownership survived a trace');
            assert.deepEqual(checkpoint.mainLifecycle?.tasks || [], [], 'main-process IPC tasks survived a trace');
            assert.deepEqual(checkpoint.mainLifecycle?.chatTasks || [], [], 'main-process chat stream tasks survived a trace');
        } catch (error) {
            await writeFailureArtifacts({ error, trace, seed: runSeed, runIndex, snapshot: checkpoint }).catch(artifactError => {
                error.message += `\nFailure artifact capture also failed: ${artifactError?.stack || artifactError}`;
            });
            throw error;
        }
    }
    try {
        if (checkpoints.length > 1) {
            const finalCheckpoint = checkpoints.at(-1);
            const heapAllowance = Math.max(16 * 1024 * 1024, baseResourceCheckpoint.heapUsed * 0.5);
            assert.ok(finalCheckpoint.heapUsed <= baseResourceCheckpoint.heapUsed + heapAllowance,
                `renderer heap retained too much memory: ${baseResourceCheckpoint.heapUsed} -> ${finalCheckpoint.heapUsed}`);
            if (checkpoints.length >= 5) {
                assert.ok(regressionSlope(checkpoints.map(checkpoint => checkpoint.heapUsed)) < 2 * 1024 * 1024,
                    'renderer heap shows sustained multi-seed growth');
                const listenerValues = checkpoints.map(checkpoint => checkpoint.listeners);
                const nodeValues = checkpoints.map(checkpoint => checkpoint.nodes);
                assert.ok(regressionSlope(listenerValues) < 4,
                    `renderer listeners show sustained multi-seed growth: ${listenerValues.join(' -> ')}`);
                assert.ok(regressionSlope(nodeValues) < 120,
                    `renderer DOM nodes show sustained multi-seed growth: ${nodeValues.join(' -> ')}`);
            }
        }
        assert.deepEqual(errors, [], `Renderer errors:\n${errors.join('\n')}`);
        assert.ok(fixture.requests.length > 0, 'default sequence must exercise the controlled VCP fixture');
        sequenceCoverage.assertRequiredEdges();
    } catch (error) {
        await writeFailureArtifacts({
            error,
            trace: lastTrace,
            seed: lastRunSeed,
            runIndex: lastRunIndex,
            snapshot: { baseline: baseResourceCheckpoint, checkpoints },
        }).catch(artifactError => {
            error.message += `\nFailure artifact capture also failed: ${artifactError?.stack || artifactError}`;
        });
        throw error;
    }
    const coverageReport = sequenceCoverage.report();
    console.log(`Main-chat Electron sequence passed: mode=${requestedUiMode}, seed=${seed}, runs=${runCount}, actions=${totalActions}, VCP requests=${fixture.requests.length}`);
    console.log(`Sequence coverage: actions=${Object.keys(coverageReport.actions).length}, pairs=${Object.keys(coverageReport.actionPairs).length}, transitions=${Object.keys(coverageReport.transitions).length}, faults=${Object.keys(coverageReport.faults).length}, required=${coverageReport.passedRequiredEdges.length}/${coverageReport.requiredEdges.length}`);
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
