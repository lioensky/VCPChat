import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    MAX_CONTENT_LENGTH,
    createDeepWikiService,
    parseSSEText,
    truncate,
    validateRequest
} = require('../modules/services/deepWikiService.js');

function response({ status = 200, contentType = 'application/json', json, text = '' } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : '' },
        json: async () => json,
        text: async () => text
    };
}

assert.throws(() => validateRequest({ target: 'arbitrary', question: 'test' }), /目标无效/);
assert.throws(() => validateRequest({ target: 'frontend', question: ' '.repeat(2) }), /不能为空/);
assert.throws(() => validateRequest({ target: 'frontend', question: 'x'.repeat(12001) }), /12000/);
assert.match(truncate('x'.repeat(MAX_CONTENT_LENGTH + 5)), /内容已截断/);
assert.equal(extractSseAnswer(parseSSEText('data: {"result":{"content":[{"type":"text","text":"old"}]}}\n\ndata: {"result":{"content":[{"type":"text","text":"new"}],"queryId":"sse-1"}}\n\ndata: [DONE]')), 'new');

function extractSseAnswer(result) {
    return result.content?.[0]?.text || '';
}

const jsonCalls = [];
const jsonService = createDeepWikiService({
    fetchImpl: async (_url, options) => {
        jsonCalls.push(JSON.parse(options.body));
        return response({ json: { result: { content: [{ type: 'text', text: 'JSON answer' }], queryId: 'json-session' } } });
    }
});
const jsonResult = await jsonService.ask({ target: 'frontend', question: 'renderer flow', deepResearch: true });
assert.equal(jsonResult.answer, 'JSON answer');
assert.equal(jsonResult.queryId, 'json-session');
assert.equal(jsonCalls[0].params.name, 'ask_question');
assert.equal(jsonCalls[0].params.arguments.repoName, 'lioensky/VCPChat');
assert.match(jsonCalls[0].params.arguments.question, /^\[DEEP RESEARCH\]/);
assert.match(jsonCalls[0].params.arguments.question, /源码导览助手 Nova/);

const sseService = createDeepWikiService({
    fetchImpl: async () => response({
        contentType: 'text/event-stream',
        text: 'data: {"result":{"content":[{"type":"text","text":"SSE answer"}],"queryId":"sse-session"}}\n\ndata: [DONE]'
    })
});
const sseResult = await sseService.ask({ target: 'backend', question: 'plugins' });
assert.equal(sseResult.answer, 'SSE answer');
assert.equal(sseResult.queryId, 'sse-session');

const contextCalls = [];
const contextService = createDeepWikiService({
    fetchImpl: async (_url, options) => {
        contextCalls.push(JSON.parse(options.body));
        return response({ json: { result: { content: [{ type: 'text', text: 'Context answer' }] } } });
    }
});
const contextResult = await contextService.ask({
    target: 'fullstack',
    question: 'continue',
    queryId: 'legacy-session',
    history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'system', content: 'must be ignored' }
    ]
});
assert.equal(contextResult.answer, 'Context answer');
assert.equal(contextCalls.length, 1);
assert.deepEqual(contextCalls[0].params.arguments.repoName, ['lioensky/VCPToolBox', 'lioensky/VCPChat']);
assert.ok(!('queryId' in contextCalls[0].params.arguments));
assert.ok(!('followUpQuestion' in contextCalls[0].params.arguments));
assert.match(contextCalls[0].params.arguments.question, /用户：first question/);
assert.match(contextCalls[0].params.arguments.question, /Nova：first answer/);
assert.doesNotMatch(contextCalls[0].params.arguments.question, /must be ignored/);

const mcpErrorService = createDeepWikiService({
    fetchImpl: async () => response({
        contentType: 'text/event-stream',
        text: 'data: {"result":{"content":[{"type":"text","text":"validation failed"}],"isError":true}}'
    })
});
await assert.rejects(() => mcpErrorService.ask({ target: 'frontend', question: 'error' }), /validation failed/);

const timeoutService = createDeepWikiService({
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })
});
await assert.rejects(() => timeoutService.ask({ target: 'frontend', question: 'timeout' }), /请求超时/);

const cancelController = new AbortController();
let cancelFetchCalls = 0;
const cancelService = createDeepWikiService({
    timeoutMs: 1000,
    fetchImpl: async (_url, options) => {
        cancelFetchCalls += 1;
        if (cancelFetchCalls > 1) {
            return response({ json: { result: { content: [{ type: 'text', text: 'Backend after cancel' }] } } });
        }
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
    }
});
const cancelled = cancelService.ask({ target: 'frontend', question: 'cancel' }, { signal: cancelController.signal });
cancelController.abort();
await assert.rejects(cancelled, error => error?.code === 'ASK_NOVA_CANCELLED');
const afterCancel = await cancelService.ask({ target: 'backend', question: 'new target' });
assert.equal(afterCancel.answer, 'Backend after cancel', 'a cancelled frontend request must not poison the next backend request');

let offline = true;
const reconnectService = createDeepWikiService({
    fetchImpl: async () => {
        if (offline) throw new TypeError('fetch failed');
        return response({ json: { result: { content: [{ type: 'text', text: 'Recovered after reconnect' }] } } });
    },
});
await assert.rejects(() => reconnectService.ask({ target: 'frontend', question: 'offline probe' }), /fetch failed/);
offline = false;
const reconnected = await reconnectService.ask({ target: 'frontend', question: 'retry after reconnect' });
assert.equal(reconnected.answer, 'Recovered after reconnect', 'an offline failure must not poison later Ask Nova requests');

console.log('Ask Nova DeepWiki service tests passed.');
