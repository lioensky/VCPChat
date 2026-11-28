import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const mainFile = new URL('../VCPHumanToolBox/main.js', import.meta.url);
const workflowFile = new URL('../VCPHumanToolBox/WorkflowEditormodules/WorkflowEditor_ExecutionEngine.js', import.meta.url);
const requireMain = createRequire(mainFile);
const vcpServerRoutes = requireMain('../modules/utils/vcpServerRoutes');
const vcpServerUrl = 'http://127.0.0.1:5050';
const url = `${vcpServerUrl}/v1/human/tool`;
const apiKey = 'test-key';
const quiet = { log() {}, warn() {}, error() {} };
const channel = 'vcp-ht-execute-tool-proxy';

function createProxy(fetch) {
    const handlers = new Map();
    const electron = {
        app: { whenReady: () => ({ then() {} }), on() {} },
        ipcMain: { handle: (name, callback) => handlers.set(name, callback), on() {} }
    };
    runInNewContext(readFileSync(mainFile, 'utf8'), {
        require(id) {
            if (id === 'electron') return electron;
            if (id === 'sharp' || id === './ComfyUImodules/comfyui-ipc') return {};
            return requireMain(id);
        },
        fetch,
        console: quiet
    });
    return args => handlers.get(channel)(null, { url, apiKey, ...args });
}

async function createWorkflow(fetch) {
    const window = {
        electronAPI: {
            invoke: async () => ({ vcpServerUrl, vcpApiKey: apiKey, userName: 'Human' })
        }
    };
    runInNewContext(readFileSync(workflowFile, 'utf8'), {
        window, fetch, vcpServerRoutes, console: quiet
    });
    await window.WorkflowEditor_ExecutionEngine.loadSettings();
    return window.WorkflowEditor_ExecutionEngine;
}

function captureRequest(response, status = 200) {
    const requests = [];
    return {
        requests,
        fetch: async (endpoint, init) => {
            requests.push({
                endpoint, method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body)
            });
            return Response.json(response, { status });
        }
    };
}

function expectRequest(requests, name, args) {
    assert.deepEqual(requests, [{
        endpoint: url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: { name, arguments: args }
    }]);
}

test('tool card IPC sends JRC without coercing arguments or inventing a maid scope', async () => {
    const response = { result: { content: [{ type: 'text', text: 'ok' }] } };
    const http = captureRequest(response);
    const proxy = createProxy(http.fetch);
    const args = {
        command: 'memory_ab', folder: '公共的知识', compare_jev: false,
        choices: ['a,b', 'c'], query: '首行\n  「末」'
    };
    const result = await proxy({ toolName: 'LightMemo', args });
    expectRequest(http.requests, 'LightMemo', args);
    assert.equal(result.success, true);
    assert.deepEqual(structuredClone(result.data), response);
});

test('tool card IPC does not replay an HTTP failure as a legacy text request', async () => {
    const http = captureRequest({ error: 'rejected' }, 400);
    const result = await createProxy(http.fetch)({ toolName: 'Example', args: {} });
    expectRequest(http.requests, 'Example', {});
    assert.equal(result.success, false);
    assert.match(result.error, /HTTP 400.*rejected/);
});

test('workflow node sends resolved native values with existing command and maid precedence', async () => {
    const http = captureRequest({ result: { content: [{ type: 'text', text: 'ok' }] } });
    const engine = await createWorkflow(http.fetch);
    engine.pluginManager = {
        getPluginInfo: () => ({ commands: [{ id: 'List', command: 'List', needsCommand: true }] })
    };
    engine.nodeInputData.set('node-1', { options: { nested: ['a', false] }, ignored: 'not a parameter' });
    const result = await engine.executePluginNode({
        id: 'node-1', category: 'vcp', pluginId: 'Example', selectedCommand: 'List',
        config: { maid: 'Kerr', options: '{{options}}', enabled: false, limit: 0, empty: '', absent: null }
    });
    expectRequest(http.requests, 'Example', {
        maid: 'Kerr', command: 'List', options: { nested: ['a', false] }, enabled: false, limit: 0
    });
    assert.equal(result.text, 'ok');
});

test('workflow node keeps an explicit command override and does not replay failed requests', async () => {
    const http = captureRequest({ error: 'rejected' }, 400);
    const engine = await createWorkflow(http.fetch);
    engine.pluginManager = {
        getPluginInfo: () => ({ commands: [{ id: 'chosen', command: 'default', needsCommand: true }] })
    };
    await assert.rejects(engine.executePluginNode({
        id: 'node-1', category: 'vcp', pluginId: 'Example', config: { command: 'chosen' }
    }), /HTTP 400.*rejected/);
    expectRequest(http.requests, 'Example', { maid: 'Human', command: 'chosen' });
});
