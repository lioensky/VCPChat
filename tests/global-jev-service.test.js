'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    GlobalJevService,
    normalizeProvider
} = require('../modules/services/globalJevService');

function createService(initialSettings = {}) {
    let settings = { ...initialSettings };
    const calls = [];
    const client = {
        getStatus(config) {
            calls.push({ method: 'getStatus', config });
            return {
                configured: Boolean(config.url && config.apiKey && config.model),
                provider: config.provider,
                url: config.url,
                model: config.model,
                timeoutMs: config.timeoutMs,
                maxRetries: config.maxRetries,
                proxyEnabled: Boolean(config.proxyUrl)
            };
        },
        async decide(state, questions, options) {
            calls.push({ method: 'decide', state, questions, options });
            return { answers: { accepted: { type: 'noul', noul: 0.9 } } };
        }
    };
    const settingsManager = {
        async readSettings() {
            return { ...settings };
        }
    };

    return {
        service: new GlobalJevService({ settingsManager, client }),
        calls,
        update(next) {
            settings = { ...settings, ...next };
        }
    };
}

test('normalizeProvider 只接受已支持的提供商', () => {
    assert.equal(normalizeProvider('OpenRouter'), 'openrouter');
    assert.equal(normalizeProvider('typesafe'), 'typesafe');
    assert.equal(normalizeProvider('unknown'), 'typesafe');
});

test('状态查询使用提供商默认值且不暴露 API Key', async () => {
    const { service } = createService({
        jevEnabled: true,
        jevProvider: 'openrouter',
        jevApiKey: 'secret-key'
    });

    const status = await service.getStatus();
    assert.deepEqual(status, {
        enabled: true,
        configured: true,
        provider: 'openrouter',
        url: 'https://openrouter.ai/api/alpha/decisions',
        model: '~typesafe/jev-latest',
        timeoutMs: 30000,
        maxRetries: 2,
        proxyEnabled: false
    });
    assert.equal('apiKey' in status, false);
    assert.equal(JSON.stringify(status).includes('secret-key'), false);
});

test('禁用状态拒绝决策且不调用底层客户端', async () => {
    const { service, calls } = createService({
        jevEnabled: false,
        jevApiKey: 'secret-key'
    });

    await assert.rejects(
        service.decide('state', {
            accepted: { type: 'noul', instructions: 'Is accepted?' }
        }),
        error => error.code === 'JEV_DISABLED'
    );
    assert.equal(calls.some(call => call.method === 'decide'), false);
});

test('每次决策读取最新全局设置并归一化可靠性参数', async () => {
    const fixture = createService({
        jevEnabled: true,
        jevProvider: 'typesafe',
        jevApiKey: 'first-key',
        jevTimeoutMs: 1,
        jevMaxRetries: 99,
        jevRetryBaseDelayMs: 0
    });
    fixture.update({
        jevProvider: 'openrouter',
        jevApiKey: 'latest-key',
        jevApiUrl: ' https://gateway.example/decisions ',
        jevModel: ' custom-jev ',
        jevTimeoutMs: 45000,
        jevMaxRetries: 4,
        jevRetryBaseDelayMs: 750,
        jevProxyUrl: ' http://127.0.0.1:7890 ',
        jevHttpReferer: ' https://vcp.example ',
        jevAppTitle: ' VCPChat Test '
    });

    const questions = {
        route: {
            type: 'choice',
            instructions: 'Choose route',
            criteria: { a: 'A', b: 'B' }
        }
    };
    const result = await fixture.service.decide({ text: 'hello' }, questions);
    assert.equal(result.answers.accepted.noul, 0.9);

    const call = fixture.calls.find(item => item.method === 'decide');
    assert.equal(call.options.provider, 'openrouter');
    assert.equal(call.options.url, 'https://gateway.example/decisions');
    assert.equal(call.options.apiKey, 'latest-key');
    assert.equal(call.options.model, 'custom-jev');
    assert.equal(call.options.timeoutMs, 45000);
    assert.equal(call.options.maxRetries, 4);
    assert.equal(call.options.retryBaseDelayMs, 750);
    assert.equal(call.options.proxyUrl, 'http://127.0.0.1:7890');
    assert.equal(call.options.referer, 'https://vcp.example');
    assert.equal(call.options.title, 'VCPChat Test');
});