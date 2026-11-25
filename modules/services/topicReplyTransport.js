'use strict';

const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { TopicReplyError } = require('./topicReplyStore');

const MAX_BYTES = 64 * 1024;
const REPLY = '/v1/topic-replies';
const STATUS = '/v1/topic-replies/status';

function createTopicReplyTransport({ dispatcher, credentials, port }) {
    const budgets = new Map(credentials.map(auth => [auth.credentialId, {
        active: 0, tokens: 12, updated: process.hrtime.bigint()
    }]));
    let closing = false;
    let pending = 0;
    let closePromise;
    const sockets = new Set();

    function authenticate(req) {
        const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(req.headers.authorization || '');
        if (!match) return null;
        const digest = createHash('sha256').update(match[1]).digest();
        let found = null;
        for (const auth of credentials) {
            if (timingSafeEqual(digest, auth.tokenDigest)) found = auth;
        }
        return found;
    }

    function respond(res, status, body) {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close'
        });
        res.end(JSON.stringify(body));
    }

    async function readBody(req) {
        if (Number(req.headers['content-length']) > MAX_BYTES) throw new TopicReplyError('BODY_TOO_LARGE', 413);
        const parts = [];
        let bytes = 0;
        // Do not destroy the stream from the iterator on overflow: the 413 needs the socket.
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) throw new TopicReplyError('BODY_TOO_LARGE', 413);
            parts.push(chunk);
        }
        try {
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, bytes)));
        } catch {
            throw new TopicReplyError('INVALID_JSON', 400);
        }
    }

    async function handle(req, res) {
        let slot;
        let timer;
        try {
            if (closing) throw new TopicReplyError('TOPIC_CLOSING', 503);
            if (req.socket.remoteAddress !== '127.0.0.1'
                || 'origin' in req.headers || 'sec-fetch-site' in req.headers) {
                throw new TopicReplyError('ACCESS_DENIED', 403);
            }
            const auth = authenticate(req);
            if (!auth) throw new TopicReplyError('AUTH_REQUIRED', 401);
            if (req.method !== 'POST' || ![REPLY, STATUS].includes(req.url)) {
                throw new TopicReplyError('UNKNOWN_ENDPOINT', 404);
            }
            if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')
                || req.headers['content-encoding']) throw new TopicReplyError('JSON_REQUIRED', 415);
            const budget = budgets.get(auth.credentialId);
            const now = process.hrtime.bigint();
            budget.tokens = Math.min(12, budget.tokens + Number(now - budget.updated) / 1e9 * 2);
            budget.updated = now;
            if (budget.tokens < 1 || budget.active >= 4 || pending >= 32) {
                throw new TopicReplyError('TOPIC_BUSY', 429);
            }
            budget.tokens--;
            budget.active++;
            pending++;
            slot = budget;
            timer = setTimeout(() => req.destroy(), 5000);
            const input = await readBody(req);
            clearTimeout(timer);
            const receipt = req.url === STATUS ? await dispatcher.inspect(auth, input)
                : await dispatcher.dispatch(auth, input);
            respond(res, 200, receipt);
        } catch (error) {
            if (error instanceof TopicReplyError) respond(res, error.status, { error: error.code });
            else respond(res, 500, { error: 'TOPIC_INTERNAL_ERROR' });
        } finally {
            clearTimeout(timer);
            if (slot) {
                slot.active--;
                pending--;
            }
        }
    }

    const server = http.createServer({ headersTimeout: 5000, requestTimeout: 10000,
        connectionsCheckingInterval: 1000, maxHeaderSize: 8192 }, (req, res) => { void handle(req, res); });
    server.maxConnections = 64;
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });

    return Object.freeze({
        async start() {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, '127.0.0.1', () => {
                    server.removeListener('error', reject);
                    server.on('error', () => { closing = true; });
                    resolve(server.address().port);
                });
            });
        },
        stop() {
            closing = true;
            closePromise ||= new Promise(resolve => {
                if (!server.listening) return resolve();
                server.close(() => resolve());
                server.closeIdleConnections?.();
            });
            return closePromise;
        },
        destroyConnections() {
            for (const socket of sockets) socket.destroy();
        }
    });
}

module.exports = { createTopicReplyTransport };