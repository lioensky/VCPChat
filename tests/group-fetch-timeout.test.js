const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeGroupFetchError, getGroupErrorMessage } = require('../Groupmodules/streamWatchdog');

test('real fetch header timeout becomes TimeoutError, not user cancellation or undefined', async (t) => {
    const server = http.createServer(() => {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('ttft_timeout'), 50);
    t.after(() => clearTimeout(timer));
    await assert.rejects(
        fetch(`http://127.0.0.1:${server.address().port}`, { signal: controller.signal }),
        raw => {
            const error = normalizeGroupFetchError(raw, controller, 120000);
            assert.equal(error.name, 'TimeoutError');
            assert.equal(error.cause, raw);
            assert.match(error.message, /响应头超过 120 秒/);
            assert.doesNotMatch(error.message, /undefined|用户中止/);
            return true;
        }
    );
});

test('user abort stays AbortError, network errors retain their stack and identity', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetch('http://127.0.0.1:1', { signal: controller.signal }), raw => {
        assert.equal(normalizeGroupFetchError(raw, controller, 120000).name, 'AbortError');
        return true;
    });
    const network = new TypeError('fetch failed');
    assert.equal(normalizeGroupFetchError(network, new AbortController(), 120000), network);
});

test('timeout classification uses signal reason even when runtime throws AbortError', () => {
    const controller = new AbortController();
    controller.abort('ttft_timeout');
    assert.equal(normalizeGroupFetchError(new DOMException('aborted', 'AbortError'), controller, 120000).name, 'TimeoutError');
});

test('non Error rejection values keep diagnostic text', () => {
    assert.equal(getGroupErrorMessage('upstream failed'), 'upstream failed');
    assert.equal(getGroupErrorMessage({ error: 'busy' }), '{"error":"busy"}');
    assert.equal(getGroupErrorMessage(undefined), '未知错误');
    const circular = {}; circular.self = circular;
    assert.equal(getGroupErrorMessage(circular), '无法序列化的错误');
    assert.equal(normalizeGroupFetchError('network failure', new AbortController(), 120000).message, 'network failure');
});

test('both group request paths normalize errors before AbortError classification', () => {
    const source = fs.readFileSync(path.join(__dirname, '../Groupmodules/groupchat.js'), 'utf8');
    assert.equal(source.match(/fetchError = normalizeGroupFetchError\(fetchError, controller, GROUP_TTFT_TIMEOUT_MS\);/g)?.length, 2);
    assert.equal(source.match(/if \(!\(error instanceof Error\)\) error = new Error\(getGroupErrorMessage\(error\), \{ cause: error \}\);/g)?.length, 2);
});