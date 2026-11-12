'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { JevClient } = require('../modules/services/jevClient');

const question = instructions => ({ type: 'noul', instructions });
const estimate = value => Math.ceil(Array.from(JSON.stringify(value))
    .reduce((sum, char) => sum + (char.codePointAt(0) > 127 ? 1 : 0.3), 0));

test('单题32k边界及中英文字符权重', () => {
    const client = new JevClient();
    const config = { provider: 'typesafe' };
    const base = { state: '', questions: { q: question('') } };
    const overhead = estimate(base);
    const atLimit = { q: question('中'.repeat(32000 - overhead)) };
    assert.equal(estimate({ state: '', questions: atLimit }), 32000);
    assert.deepEqual(client._contextHeaders('', atLimit, config), {});
    assert.equal(client._contextHeaders('', {
        q: question(atLimit.q.instructions + '中')
    }, config)['TypeSafe-Danger-Zone-Long-Context'], 'true');
    assert.deepEqual(client._contextHeaders('', { q: question('a'.repeat(100000)) }, config), {});
    assert.equal(client._contextHeaders('', {
        q: question('中'.repeat(100000))
    }, config)['TypeSafe-Danger-Zone-Long-Context'], 'true');
});

test('整次64k预算及state参与单题预算', () => {
    const client = new JevClient();
    const config = { provider: 'typesafe' };
    const questions = Object.fromEntries(['a', 'b', 'c'].map(key =>
        [key, question('中'.repeat(22000))]));
    assert.equal(client._contextHeaders('', questions, config)
        ['TypeSafe-Danger-Zone-Long-Context'], 'true');
    assert.equal(client._contextHeaders('中'.repeat(33000), { q: question('short') }, config)
        ['TypeSafe-Danger-Zone-Long-Context'], 'true');
});

test('240k边界与非TypeSafe长请求拒绝', () => {
    const client = new JevClient();
    const overhead = estimate({ state: '', questions: { q: question('') } });
    const questions = { q: question('中'.repeat(240000 - overhead)) };
    assert.equal(client._contextHeaders('', questions, { provider: 'typesafe' })
        ['TypeSafe-Danger-Zone-Long-Context'], 'true');
    assert.throws(() => client._contextHeaders('', {
        q: question(questions.q.instructions + '中')
    }, { provider: 'typesafe' }), { code: 'JEV_CONTEXT_TOO_LARGE' });
    assert.throws(() => client._contextHeaders('', {
        q: question('中'.repeat(33000))
    }, { provider: 'openrouter' }), { code: 'JEV_LONG_CONTEXT_UNSUPPORTED' });
});

test('decide自动添加长上下文头且拒绝请求不触网', async t => {
    const original = axios.post;
    t.after(() => { axios.post = original; });
    const headers = [];
    axios.post = async (_url, _body, options) => {
        headers.push(options.headers);
        return { data: { answers: {} } };
    };
    const client = new JevClient({ apiKey: 'fixture', provider: 'typesafe', maxRetries: 0 });
    await client.decide('', { q: question('short') }, { headers: { 'X-Test': 'kept' } });
    await client.decide('', { q: question('中'.repeat(33000)) }, {
        headers: { 'TypeSafe-Danger-Zone-Long-Context': 'false' }
    });
    assert.equal(headers[0]['TypeSafe-Danger-Zone-Long-Context'], undefined);
    assert.equal(headers[0]['X-Test'], 'kept');
    assert.equal(headers[1]['TypeSafe-Danger-Zone-Long-Context'], 'true');
    await assert.rejects(client.decide('', { q: question('中'.repeat(241000)) }),
        { code: 'JEV_CONTEXT_TOO_LARGE' });
    await assert.rejects(client.decide('', { q: question('中'.repeat(33000)) },
        { provider: 'openrouter' }), { code: 'JEV_LONG_CONTEXT_UNSUPPORTED' });
    assert.equal(headers.length, 2);
});