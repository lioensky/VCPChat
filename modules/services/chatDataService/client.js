'use strict';

const { TextDecoder } = require('node:util');

const DEFAULT_TIMEOUT_MS = 15_000;

class ChatDataServiceError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'ChatDataServiceError';
        this.code = options.code || 'CDS_ERROR';
        this.status = options.status || null;
        this.retryable = options.retryable === true;
        this.cause = options.cause;
    }
}

function hasJsonContent(line) {
    for (const byte of line) {
        if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return true;
    }
    return false;
}

function parseNdjsonLine(line, decoder, label) {
    let text;
    try {
        text = decoder.decode(line);
    } catch (error) {
        throw new ChatDataServiceError(`VCP-CDS returned invalid UTF-8 in ${label}.`, {
            code: 'INVALID_RESPONSE',
            cause: error
        });
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new ChatDataServiceError(`VCP-CDS returned invalid JSON in ${label}.`, {
            code: 'INVALID_RESPONSE',
            cause: error
        });
    }
}

async function* decodeNdjsonBody(body, { maxLineBytes, maxTotalBytes }) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let fragments = [];
    let lineBytes = 0;
    let totalBytes = 0;

    for await (const rawChunk of body) {
        const chunk = Buffer.from(rawChunk);
        totalBytes += chunk.length;
        if (totalBytes > maxTotalBytes) {
            throw new ChatDataServiceError('VCP-CDS NDJSON response exceeds total budget.', {
                code: 'RESPONSE_TOO_LARGE'
            });
        }
        let start = 0;
        while (start < chunk.length) {
            const newline = chunk.indexOf(0x0a, start);
            if (newline === -1) break;
            const part = chunk.subarray(start, newline);
            if (lineBytes + part.length > maxLineBytes) {
                throw new ChatDataServiceError('VCP-CDS NDJSON frame exceeds line budget.', {
                    code: 'RESPONSE_TOO_LARGE'
                });
            }
            const length = lineBytes + part.length;
            const line = fragments.length
                ? Buffer.concat([...fragments, part], length)
                : part;
            fragments = [];
            lineBytes = 0;
            if (hasJsonContent(line)) {
                yield parseNdjsonLine(line, decoder, 'NDJSON frame');
            }
            start = newline + 1;
        }
        if (start < chunk.length) {
            const remainder = chunk.subarray(start);
            lineBytes += remainder.length;
            if (lineBytes > maxLineBytes) {
                throw new ChatDataServiceError('VCP-CDS NDJSON frame exceeds line budget.', {
                    code: 'RESPONSE_TOO_LARGE'
                });
            }
            // Copy only the bounded residual frame bytes. Retaining a subarray
            // must not pin an arbitrarily large transport chunk in memory.
            fragments.push(Buffer.from(remainder));
        }
    }

    if (lineBytes > 0) {
        const line = fragments.length === 1
            ? fragments[0]
            : Buffer.concat(fragments, lineBytes);
        if (hasJsonContent(line)) {
            yield parseNdjsonLine(line, decoder, 'trailing NDJSON frame');
        }
    }
}

class ChatDataServiceClient {
    constructor({ port, authToken, protocolVersion = 2, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new ChatDataServiceError('Invalid VCP-CDS port.', { code: 'INVALID_CONFIGURATION' });
        }
        if (!authToken || typeof authToken !== 'string') {
            throw new ChatDataServiceError('Missing VCP-CDS auth token.', { code: 'INVALID_CONFIGURATION' });
        }

        this.baseUrl = `http://127.0.0.1:${port}`;
        this.authToken = authToken;
        this.protocolVersion = protocolVersion;
        this.timeoutMs = timeoutMs;
    }

    async request(method, pathname, body, options = {}) {
        const controller = new AbortController();
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        let didTimeout = false;
        const timeout = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeoutMs);

        const abortFromCaller = () => controller.abort();
        if (options.signal) {
            if (options.signal.aborted) {
                clearTimeout(timeout);
                throw new ChatDataServiceError('VCP-CDS request was cancelled.', {
                    code: 'CANCELLED',
                    retryable: false
                });
            }
            options.signal.addEventListener('abort', abortFromCaller, { once: true });
        }

        try {
            const response = await fetch(`${this.baseUrl}${pathname}`, {
                method,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${this.authToken}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });

            const text = await response.text();
            let payload = null;
            if (text) {
                try {
                    payload = JSON.parse(text);
                } catch (error) {
                    throw new ChatDataServiceError('VCP-CDS returned invalid JSON.', {
                        code: 'INVALID_RESPONSE',
                        status: response.status,
                        retryable: response.status >= 500,
                        cause: error
                    });
                }
            }

            if (!response.ok) {
                const detail = payload?.error || {};
                throw new ChatDataServiceError(
                    detail.message || `VCP-CDS request failed with HTTP ${response.status}.`,
                    {
                        code: detail.code || 'HTTP_ERROR',
                        status: response.status,
                        retryable: detail.retryable === true || response.status >= 500
                    }
                );
            }
            return payload;
        } catch (error) {
            if (error instanceof ChatDataServiceError) throw error;
            if (error?.name === 'AbortError') {
                throw new ChatDataServiceError(
                    didTimeout ? 'VCP-CDS request timed out.' : 'VCP-CDS request was cancelled.',
                    {
                        code: didTimeout ? 'TIMEOUT' : 'CANCELLED',
                        retryable: didTimeout,
                        cause: error
                    }
                );
            }
            throw new ChatDataServiceError('Unable to connect to VCP-CDS.', {
                code: 'UNAVAILABLE',
                retryable: true,
                cause: error
            });
        } finally {
            clearTimeout(timeout);
            if (options.signal) {
                options.signal.removeEventListener('abort', abortFromCaller);
            }
        }
    }

    async *requestNdjson(method, pathname, body, options = {}) {
        const controller = new AbortController();
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        const maxLineBytes = options.maxLineBytes ?? 32 * 1024 * 1024;
        const maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
        let didTimeout = false;
        const timeout = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeoutMs);
        const abortFromCaller = () => controller.abort();
        if (options.signal) {
            if (options.signal.aborted) {
                clearTimeout(timeout);
                throw new ChatDataServiceError('VCP-CDS request was cancelled.', {
                    code: 'CANCELLED',
                    retryable: false
                });
            }
            options.signal.addEventListener('abort', abortFromCaller, { once: true });
        }

        try {
            const response = await fetch(`${this.baseUrl}${pathname}`, {
                method,
                headers: {
                    Accept: 'application/x-ndjson',
                    Authorization: `Bearer ${this.authToken}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });
            if (!response.ok) {
                const text = await response.text();
                let detail = null;
                try {
                    detail = text ? JSON.parse(text)?.error : null;
                } catch {}
                throw new ChatDataServiceError(
                    detail?.message || `VCP-CDS request failed with HTTP ${response.status}.`,
                    {
                        code: detail?.code || 'HTTP_ERROR',
                        status: response.status,
                        retryable: detail?.retryable === true || response.status >= 500
                    }
                );
            }
            if (!response.body) {
                throw new ChatDataServiceError('VCP-CDS returned an empty NDJSON body.', {
                    code: 'INVALID_RESPONSE'
                });
            }

            for await (const frame of decodeNdjsonBody(response.body, {
                maxLineBytes,
                maxTotalBytes
            })) {
                yield frame;
            }
        } catch (error) {
            if (error instanceof ChatDataServiceError) throw error;
            if (error?.name === 'AbortError') {
                throw new ChatDataServiceError(
                    didTimeout ? 'VCP-CDS request timed out.' : 'VCP-CDS request was cancelled.',
                    {
                        code: didTimeout ? 'TIMEOUT' : 'CANCELLED',
                        retryable: didTimeout,
                        cause: error
                    }
                );
            }
            throw new ChatDataServiceError('Unable to stream from VCP-CDS.', {
                code: 'UNAVAILABLE',
                retryable: true,
                cause: error
            });
        } finally {
            controller.abort();
            clearTimeout(timeout);
            if (options.signal) {
                options.signal.removeEventListener('abort', abortFromCaller);
            }
        }
    }

    async health(options) {
        const response = await fetch(`${this.baseUrl}/v1/health`, {
            signal: options?.signal
        }).catch(error => {
            throw new ChatDataServiceError('Unable to connect to VCP-CDS.', {
                code: 'UNAVAILABLE',
                retryable: true,
                cause: error
            });
        });
        if (!response.ok) {
            throw new ChatDataServiceError(`VCP-CDS health check failed with HTTP ${response.status}.`, {
                code: 'HEALTH_CHECK_FAILED',
                status: response.status,
                retryable: true
            });
        }
        const health = await response.json();
        // 版本门禁已收敛到 READY 握手（lifecycle.js validateHandshake，
        // protocol+schema 双校验）；health() 只做连通性/形状验证，
        // 不再对同一进程毫秒级重复比较同一版本号。
        if (!health || typeof health !== 'object' || health.status !== 'ready') {
            throw new ChatDataServiceError('VCP-CDS health check returned an unexpected payload.', {
                code: 'HEALTH_CHECK_FAILED',
                retryable: true
            });
        }
        return health;
    }

    status(options) {
        return this.request('GET', '/v1/status', undefined, options);
    }

    reconcile(options) {
        return this.request('POST', '/v1/reconcile', {}, {
            timeoutMs: 270_000,
            ...options
        });
    }

    rebuildSearchIndex(options) {
        return this.request('POST', '/v1/rebuild-search-index', {}, {
            timeoutMs: 300_000,
            ...options
        });
    }

    ingestHistoryPath(path, origin = 'electron', options) {
        return this.request('POST', '/v1/ingest/history-path', { path, origin }, options);
    }

    searchMessages(request, options) {
        return this.request('POST', '/v1/search/messages', request, options);
    }

    searchMemories(request, options) {
        return this.request('POST', '/v1/search/memories', request, options);
    }

    syncManifest(request, options) {
        return this.request('POST', '/v1/sync/manifest', request, options);
    }

    syncMessageManifest(request, options) {
        return this.request('POST', '/v1/sync/message-manifest', request, options);
    }

    syncTopicIdentity(request, options) {
        return this.request('POST', '/v2/sync/topic-identity', request, options);
    }

    syncTopicDiff(request, options) {
        return this.request('POST', '/v1/sync/topic-diff', request, {
            timeoutMs: 270_000,
            ...options
        });
    }

    syncMessageDiff(request, options) {
        return this.request('POST', '/v1/sync/message-diff', request, {
            timeoutMs: 270_000,
            ...options
        });
    }

    syncEntityDelete(request, options) {
        return this.request('POST', '/v1/sync/entity-delete', request, options);
    }

    // v1 `/v1/sync/messages/pull` 已随 CDS 端一同弃用移除（S3-δ）：全有或全无
    // 且无活调用方；消息拉取统一走 v2 流式（per-topic `_error` 帧隔离）。
    syncMessagesPullStream(request, options) {
        return this.requestNdjson('POST', '/v2/sync/messages/pull', request, {
            timeoutMs: 270_000,
            ...options
        });
    }

    syncMessagesPush(request, options) {
        return this.request('POST', '/v1/sync/messages/push', request, {
            timeoutMs: 270_000,
            ...options
        });
    }

    syncMessagesPushTopic(topic, options) {
        return this.request('POST', '/v2/sync/messages/push-topic', topic, {
            timeoutMs: 270_000,
            ...options
        });
    }

    changes(after = 0, limit = 200, options) {
        const query = new URLSearchParams({
            after: String(after),
            limit: String(limit)
        });
        return this.request('GET', `/v1/changes?${query}`, undefined, options);
    }

    flush(options) {
        return this.request('POST', '/v1/flush', {}, options);
    }

    shutdown(options) {
        return this.request('POST', '/v1/shutdown', {}, {
            timeoutMs: 3_000,
            ...options
        });
    }
}

module.exports = {
    ChatDataServiceClient,
    ChatDataServiceError,
    DEFAULT_TIMEOUT_MS
};
