'use strict';

const http = require('node:http');
const { validateArguments } = require('./tools.cjs');

const requestIdSchema = { type: 'string', pattern: '^[A-Za-z0-9:_-]{1,128}$' };
const requestIdPattern = new RegExp(requestIdSchema.pattern);
const entryIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const definitions = new Map([
    ['topic_reply', {
        path: '/v1/topic-replies',
        tool: {
            name: 'topic_reply',
            description: 'Reply to an authorized existing topic. Choose requestId before sending; after an uncertain result call topic_reply_status with that ID. queued means admitted, not model completion.',
            inputSchema: object({
                requestId: requestIdSchema,
                topicId: { type: 'string', pattern: '^topic_[A-Za-z0-9_-]+$', maxLength: 160 },
                message: { type: 'string', pattern: '\\S', maxLength: 16000 },
                advance: { type: 'boolean', description: 'Request continuation; omit to use the host credential policy.' }
            }, ['topicId', 'message', 'requestId'])
        }
    }],
    ['topic_reply_status', {
        path: '/v1/topic-replies/status',
        tool: {
            name: 'topic_reply_status',
            description: 'Inspect a Topic reply by its original requestId using the configured credential.',
            inputSchema: object({ requestId: requestIdSchema }, ['requestId']),
            annotations: { readOnlyHint: true }
        }
    }]
]);

const ERRORS = new Map([
    [400, ['INVALID_REQUEST', 'INVALID_JSON']], [401, ['AUTH_REQUIRED']],
    [403, ['ACCESS_DENIED', 'TOPIC_DENIED', 'ADVANCE_DENIED']], [404, ['UNKNOWN_ENDPOINT']],
    [409, ['REQUEST_CONFLICT']], [413, ['BODY_TOO_LARGE']], [415, ['JSON_REQUIRED']],
    [429, ['TOPIC_BUSY']], [503, ['TOPIC_CLOSING', 'LEDGER_FULL', 'LEDGER_UNAVAILABLE', 'DELIVERY_UNCONFIRMED']]
]);

function parseConfig(config) {
    if (config === undefined) return null;
    const invalid = () => {
        console.warn('[TopicReply MCP] Invalid topic configuration; Topic tools disabled.');
        return null;
    };
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || typeof config.enabled !== 'boolean'
        || Object.keys(config).some(key => !['enabled', 'baseUrl', 'tokenEnv', 'timeoutMs'].includes(key))) return invalid();
    const { enabled, baseUrl, tokenEnv, timeoutMs = 14000 } = config;
    const match = typeof baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(baseUrl);
    const port = match ? Number(match[1]) : 0;
    if (((enabled || Object.hasOwn(config, 'baseUrl')) && (port < 1024 || port > 65535 || [6198, 6199].includes(port)))
        || ((enabled || Object.hasOwn(config, 'tokenEnv'))
            && (typeof tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(tokenEnv)))
        || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) return invalid();
    return config.enabled ? { port, tokenEnv, timeoutMs } : null;
}

function failed(error, requestId, uncertain = false) {
    const result = { error, ...(requestId ? { requestId } : {}), ...(uncertain ? { uncertain: true } : {}) };
    const guidance = uncertain ? ' Check topic_reply_status with the same requestId; do not blindly resend.' : '';
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) + guidance }], structuredContent: result };
}

function receipt(data, requestId) {
    if (data?.requestId !== requestId || !['inflight', 'queued', 'uncertain', 'not_found'].includes(data.state)
        || ![null, true, false].includes(data.advanceRequested)
        || (data.state === 'not_found'
            ? data.advanceEffective !== null || data.advanceRequested !== null
            : typeof data.advanceEffective !== 'boolean')
        || (data.state === 'queued'
            ? typeof data.entryId !== 'string' || !entryIdPattern.test(data.entryId)
            : data.entryId !== undefined)) return null;
    const { state, entryId, advanceRequested, advanceEffective } = data;
    return { requestId, state, advanceRequested, advanceEffective, ...(entryId ? { entryId } : {}) };
}

function post(port, path, token, payload, signal) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1', port, path, method: 'POST', agent: false, signal,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
                'Content-Length': payload.length }
        }, response => {
            response.once('error', reject);
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > 8192) {
                    reject(new Error('TOPIC_RESPONSE_TOO_LARGE'));
                    response.destroy();
                } else chunks.push(chunk);
            });
            response.once('end', () => {
                try {
                    resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
                } catch (error) { reject(error); }
            });
        });
        request.once('error', reject);
        request.end(payload);
    });
}

function createTopicClient(raw) {
    const config = parseConfig(raw);
    if (!config) return null;
    const active = new Set();
    let closed = false;
    return Object.freeze({
        tools: [...definitions.values()].map(({ tool }) => tool),
        has: name => definitions.has(name),
        async call(name, args) {
            const { tool, path } = definitions.get(name);
            const requestId = typeof args?.requestId === 'string' && requestIdPattern.test(args.requestId)
                ? args.requestId : undefined;
            const submitting = name === 'topic_reply';
            let payload;
            try {
                validateArguments(tool, args);
                payload = Buffer.from(JSON.stringify(args));
                if (payload.length > 64 * 1024 || (submitting && args.message.length > 16000)) {
                    return failed('INVALID_REQUEST', requestId);
                }
            } catch { return failed('INVALID_REQUEST', requestId); }
            if (closed) return failed('TOPIC_CLOSING', requestId);
            if (active.size >= 4) return failed('TOPIC_BUSY', requestId);
            const token = process.env[config.tokenEnv];
            if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return failed('TOPIC_CREDENTIAL_UNAVAILABLE', requestId);

            const controller = new AbortController();
            active.add(controller);
            const timer = setTimeout(() => controller.abort(), config.timeoutMs);
            try {
                const { status, data } = await post(config.port, path, token, payload, controller.signal);
                if (ERRORS.get(status)?.includes(data?.error)) {
                    return failed(data.error, requestId, submitting && data.error === 'DELIVERY_UNCONFIRMED');
                }
                const result = status === 200 && receipt(data, requestId);
                if (!result || (submitting && result.state === 'not_found')) {
                    return failed('TOPIC_BAD_RESPONSE', requestId, submitting);
                }
                return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
            } catch {
                return failed('TOPIC_UNAVAILABLE', requestId, submitting);
            } finally {
                clearTimeout(timer);
                active.delete(controller);
            }
        },
        close() {
            closed = true;
            for (const controller of active) controller.abort();
        }
    });
}

module.exports = { createTopicClient };