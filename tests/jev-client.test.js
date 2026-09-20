'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {
    JevClient,
    parseApiKeys
} = require('../modules/services/jevClient');

const QUESTIONS = Object.freeze({
    accepted: Object.freeze({
        type: 'noul',
        instructions: 'Is accepted?'
    })
});

function successResponse() {
    return {
        data: {
            answers: {
                accepted: {
                    type: 'noul',
                    noul: 0.9
                }
            }
        }
    };
}

test('parseApiKeys 支持英文逗号、中文逗号和竖线并忽略空项', () => {
    assert.deepEqual(
        parseApiKeys(' key-a, key-b，key-c | key-d || ，, '),
        ['key-a', 'key-b', 'key-c', 'key-d']
    );
    assert.deepEqual(parseApiKeys(' single-key '), ['single-key']);
    assert.deepEqual(parseApiKeys(' ,，|| '), []);
    assert.deepEqual(parseApiKeys(null), []);
});

test('单 Key 配置保持兼容', async t => {
    const originalPost = axios.post;
    t.after(() => {
        axios.post = originalPost;
    });

    const authorizations = [];
    axios.post = async (_url, _body, requestConfig) => {
        authorizations.push(requestConfig.headers.Authorization);
        return successResponse();
    };

    const client = new JevClient({
        apiKey: 'single-key',
        maxRetries: 0
    });

    await client.decide('state-1', QUESTIONS);
    await client.decide('state-2', QUESTIONS);

    assert.deepEqual(authorizations, [
        'Bearer single-key',
        'Bearer single-key'
    ]);
});

test('并发调用按 Key 池顺序进行简单轮询', async t => {
    const originalPost = axios.post;
    t.after(() => {
        axios.post = originalPost;
    });

    const authorizations = [];
    axios.post = async (_url, _body, requestConfig) => {
        authorizations.push(requestConfig.headers.Authorization);
        await new Promise(resolve => setImmediate(resolve));
        return successResponse();
    };

    const client = new JevClient({
        apiKey: 'key-a,key-b，key-c|key-d',
        maxRetries: 0
    });

    await Promise.all([
        client.decide('state-1', QUESTIONS),
        client.decide('state-2', QUESTIONS),
        client.decide('state-3', QUESTIONS),
        client.decide('state-4', QUESTIONS),
        client.decide('state-5', QUESTIONS)
    ]);

    assert.deepEqual(authorizations, [
        'Bearer key-a',
        'Bearer key-b',
        'Bearer key-c',
        'Bearer key-d',
        'Bearer key-a'
    ]);
});

test('同一次 decide 的重试固定使用首次选中的 Key', async t => {
    const originalPost = axios.post;
    t.after(() => {
        axios.post = originalPost;
    });

    const authorizations = [];
    let requestCount = 0;
    axios.post = async (_url, _body, requestConfig) => {
        authorizations.push(requestConfig.headers.Authorization);
        requestCount += 1;
        if (requestCount === 1) {
            const error = new Error('rate limited');
            error.response = {
                status: 429,
                data: 'rate limited',
                headers: { 'retry-after': '0' }
            };
            throw error;
        }
        return successResponse();
    };

    const client = new JevClient({
        apiKey: 'key-a|key-b',
        maxRetries: 1
    });

    await client.decide('state-1', QUESTIONS);
    await client.decide('state-2', QUESTIONS);

    assert.deepEqual(authorizations, [
        'Bearer key-a',
        'Bearer key-a',
        'Bearer key-b'
    ]);
});

test('仅含分隔符和空白的 Key 配置视为未配置', () => {
    const client = new JevClient({
        apiKey: ' ,，|| ',
        model: 'jev-latest'
    });

    assert.equal(client.isConfigured(), false);
    assert.equal(client.getStatus().configured, false);
});