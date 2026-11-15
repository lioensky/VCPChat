import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderWorkerClient } from '../modules/renderer/renderWorkerClient.js';
import { compileRenderJob } from '../modules/renderer/renderWorkerRuntime.js';

function fixture(options = {}) {
    const workers = [];
    const client = createRenderWorkerClient({
        createWorker() {
            const worker = { sent: [], terminated: false, postMessage(data) { this.sent.push(data); }, terminate() { this.terminated = true; } };
            workers.push(worker);
            return worker;
        },
        ...options,
    });
    return { client, workers };
}
test('worker client snapshots queued inputs and sends one job at a time', async () => {
    const { client, workers } = fixture();
    const scope = {};
    const first = client.submit(scope, { text: 'one' });
    const input = { text: 'two', settings: { value: 1 } };
    const second = client.submit(scope, input);
    input.settings.value = 2;
    assert.equal(workers[0].sent.length, 1);
    workers[0].onmessage({ data: { id: 1, result: 'first' } });
    assert.equal(workers[0].sent[1].job.settings.value, 1);
    workers[0].onmessage({ data: { id: 2, result: 'second' } });
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.equal(client.getStats().chars, 0);
    client.dispose();
});
test('scope cancellation terminates active parsing but preserves other roots', async () => {
    const { client, workers } = fixture();
    const a = {}, b = {};
    const first = client.submit(a, { text: 'one' });
    const second = client.submit(b, { text: 'two' });
    const staleReply = workers[0].onmessage;
    client.cancel(a);
    assert.equal(await first, null);
    assert.equal(workers[0].terminated, true);
    staleReply({ data: { id: 1, result: 'stale' } });
    workers[1].onmessage({ data: { id: 2, result: 'fresh' } });
    assert.equal(await second, 'fresh');
    client.dispose();
});
test('queue/input bounds and dispose settle every waiter', async () => {
    const { client } = fixture({ maxJobs: 1, maxChars: 5 });
    const first = client.submit({}, { text: '12345' });
    assert.equal(await client.submit({}, { text: 'x' }), null);
    client.dispose();
    assert.equal(await first, null);
    assert.equal(client.getStats().pending, 0);
    assert.equal(client.getStats().chars, 0);
    assert.equal(await client.submit({}, { text: 'x' }), null);
});
test('crash disables worker and falls back without hanging queued tasks', async () => {
    const { client, workers } = fixture();
    const jobs = [client.submit({}, { text: 'a' }), client.submit({}, { text: 'b' })];
    workers[0].onerror(new Error('crash'));
    assert.deepEqual(await Promise.all(jobs), [null, null]);
    assert.equal(client.getStats().unavailable, true);
    client.dispose();
});
test('timeout interrupts parsing', async () => {
    const { client, workers } = fixture({ timeout: 5 });
    assert.equal(await client.submit({}, { text: 'a' }), null);
    assert.equal(workers[0].terminated, true);
    client.dispose();
});
const base = { role: 'assistant', depth: 0, markdown: { gfm: true, breaks: true }, settings: {} };
test('worker compiler runs without window and keeps code and scripts inert', async () => {
    const result = await compileRenderJob({ ...base, text: '## 标题\n\n```js\nconst x = `<style>x</style>`;\n```\n\n<script>globalThis.BAD=true</script>' });
    assert.match(result.parts[0], /<h2>标题/);
    assert.match(result.parts[0], /\x26lt;style\x26gt;/);
    assert.equal(globalThis.BAD, undefined);
});
test('worker compiler returns independent lazy descriptors and isolated batch domains', async () => {
    const text = '```js\nopen\n<<<[VCP_TOOL_BATCH_START:test]>>>\n'
        + '[[VCP调用结果信息汇总:\n- 工具名称: Demo\n- 返回内容: <script>bad()</script>\nVCP调用结果结束]]\n'
        + '<<<[VCP_TOOL_BATCH_END:test]>>>\n\n## 后文';
    const result = await compileRenderJob({ ...base, text });
    assert.equal(result.isolatedDomains, true);
    assert.equal(result.tools.length, 1);
    assert.match(result.tools[0].raw, /<script>/);
    assert.match(result.parts.at(-1), /<h2>后文/);
    assert.ok(!result.parts.join('').includes('<script>bad()'));
});
test('Flowlock shares the production protocol parser', async () => {
    const result = await compileRenderJob({ ...base, flowlock: true, text: '[[Flowlock::Complete]]' });
    assert.doesNotMatch(result.parts[0], /\[\[Flowlock::Complete\]\]/);
});