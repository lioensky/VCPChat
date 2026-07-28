'use strict';

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

class ChatDataServiceClient {
    constructor({ port, authToken, protocolVersion = 1, timeoutMs = DEFAULT_TIMEOUT_MS }) {
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
        if (health.protocolVersion !== this.protocolVersion) {
            throw new ChatDataServiceError(
                `VCP-CDS protocol mismatch: expected ${this.protocolVersion}, received ${health.protocolVersion}.`,
                { code: 'PROTOCOL_MISMATCH', retryable: false }
            );
        }
        return health;
    }

    status(options) {
        return this.request('GET', '/v1/status', undefined, options);
    }

    reconcile(options) {
        return this.request('POST', '/v1/reconcile', {}, {
            timeoutMs: 120_000,
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

    syncTopicDiff(request, options) {
        return this.request('POST', '/v1/sync/topic-diff', request, options);
    }

    syncMessageDiff(request, options) {
        return this.request('POST', '/v1/sync/message-diff', request, options);
    }

    syncMessagesPull(request, options) {
        return this.request('POST', '/v1/sync/messages/pull', request, {
            timeoutMs: 120_000,
            ...options
        });
    }

    syncMessagesPush(request, options) {
        return this.request('POST', '/v1/sync/messages/push', request, {
            timeoutMs: 120_000,
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