'use strict';

const { ChatDataServiceClient, ChatDataServiceError } = require('./client');
const {
    ChatDataServiceLifecycle,
    PROTOCOL_VERSION,
    SCHEMA_VERSION
} = require('./lifecycle');

class ChatDataServiceFacade {
    constructor(options) {
        this.lifecycle = new ChatDataServiceLifecycle(options);
        this.logger = options?.logger || console;
        // 消费者迁移开关随 Electron 持有的共享 facade 注入插件，
        // 不把 CDS 临时令牌或端口写入全局环境变量。
        this.mobileSyncUseCentralIndex = options?.mobileSyncUseCentralIndex !== false;
    }

    async startShadowMode() {
        try {
            return await this.lifecycle.start();
        } catch (error) {
            this.logger.error?.(
                '[VCP-CDS] Shadow service failed to start; existing chat features remain active:',
                error
            );
            return null;
        }
    }

    get client() {
        return this.lifecycle.client;
    }

    get isAvailable() {
        return this.lifecycle.isReady;
    }

    async withClient(operation, fallback = null) {
        const client = this.client;
        if (!client) return fallback;
        try {
            return await operation(client);
        } catch (error) {
            this.logger.warn?.('[VCP-CDS] Shadow operation failed:', error);
            return fallback;
        }
    }

    ingestHistoryPath(path, origin = 'electron') {
        return this.withClient(
            client => client.ingestHistoryPath(path, origin),
            { accepted: false, changed: false, degraded: true }
        );
    }

    searchMessages(request) {
        return this.withClient(client => client.searchMessages(request), {
            hits: [],
            degraded: true
        });
    }

    searchMemories(request) {
        return this.withClient(client => client.searchMemories(request), {
            windows: [],
            formattedResult: '',
            degraded: true
        });
    }

    status() {
        return this.withClient(client => client.status(), {
            status: 'unavailable',
            searchAvailable: false,
            degraded: true
        });
    }

    stop() {
        return this.lifecycle.stop();
    }
}

module.exports = {
    ChatDataServiceFacade,
    ChatDataServiceLifecycle,
    ChatDataServiceClient,
    ChatDataServiceError,
    PROTOCOL_VERSION,
    SCHEMA_VERSION
};
