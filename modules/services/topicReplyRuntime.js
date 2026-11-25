'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { openTopicReplyStore, TOPIC_ID, valid } = require('./topicReplyStore');
const { createTopicReplyDispatcher } = require('./topicReplyDispatcher');
const { createTopicReplyTransport } = require('./topicReplyTransport');

const CONFIG_FIELDS = new Set(['enabled', 'port', 'credentials']);
const AUTH_FIELDS = new Set(['credentialId', 'tokenHash', 'senderId', 'allowedTopicIds',
    'allowAdvance', 'defaultAdvance']);

function hasOnly(data, keys) {
    return data && typeof data === 'object' && !Array.isArray(data)
        && Object.keys(data).every(key => keys.has(key));
}

function validateConfig(config) {
    const invalid = () => new Error('INVALID_TOPIC_REPLY_CONFIG');
    if (!hasOnly(config, CONFIG_FIELDS)
        || (Object.hasOwn(config, 'enabled') && typeof config.enabled !== 'boolean')) throw invalid();
    if (config.enabled !== true) return null;
    const { port = 6200, credentials } = config;
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || [6198, 6199].includes(port)
        || !Array.isArray(credentials) || !credentials.length || credentials.length > 64) throw invalid();
    const ids = new Set();
    const digests = new Set();
    const auth = credentials.map(row => {
        if (!hasOnly(row, AUTH_FIELDS) || !valid(/^[A-Za-z0-9_-]{1,64}$/, row.credentialId)
            || !valid(/^[a-f0-9]{64}$/i, row.tokenHash)
            || !valid(/^[A-Za-z0-9_-]{1,160}$/, row.senderId)
            || typeof row.allowAdvance !== 'boolean' || typeof row.defaultAdvance !== 'boolean'
            || (row.defaultAdvance && !row.allowAdvance) || !Array.isArray(row.allowedTopicIds)
            || !row.allowedTopicIds.length || row.allowedTopicIds.length > 256
            || row.allowedTopicIds.some(id => !valid(TOPIC_ID, id) || id.length > 160)) throw invalid();
        const digest = row.tokenHash.toLowerCase();
        if (ids.has(row.credentialId) || digests.has(digest)) throw invalid();
        ids.add(row.credentialId);
        digests.add(digest);
        return {
            credentialId: row.credentialId, tokenDigest: Buffer.from(digest, 'hex'), senderId: row.senderId,
            allowedTopicIds: new Set(row.allowedTopicIds), allowAdvance: row.allowAdvance,
            defaultAdvance: row.defaultAdvance
        };
    });
    return { port, credentials: auth };
}

async function within(promise, ms) {
    let timer;
    try {
        return await Promise.race([promise.then(() => true), new Promise(resolve => {
            timer = setTimeout(() => resolve(false), ms);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

async function createTopicReplyRuntime({ appDataRoot, processToolCall }) {
    const dir = path.join(appDataRoot, 'TopicReply');
    let config;
    try {
        config = validateConfig(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        // Do not propagate JSON parse excerpts that could include credentials.
        throw new Error('INVALID_TOPIC_REPLY_CONFIG');
    }
    if (!config) return null;
    if (typeof processToolCall !== 'function') throw new Error('TOPIC_REPLY_HOST_UNAVAILABLE');

    const store = await openTopicReplyStore(path.join(dir, 'records.json'));
    const dispatcher = createTopicReplyDispatcher({ store, processToolCall });
    const transport = createTopicReplyTransport({ dispatcher, ...config });
    await transport.start();
    let disposal;
    return Object.freeze({
        dispose() {
            if (disposal) return disposal;
            dispatcher.fence();
            const closing = transport.stop();
            disposal = (async () => {
                if (!await within(dispatcher.drain(), 1000)) {
                    dispatcher.interrupt();
                    await within(dispatcher.drain(), 1500);
                }
                transport.destroyConnections();
                await within(closing, 500);
            })();
            return disposal;
        }
    });
}

module.exports = { createTopicReplyRuntime };