'use strict';

const defaultClient = require('./jevClient');

const PROVIDER_DEFAULTS = Object.freeze({
    typesafe: Object.freeze({
        url: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-latest'
    }),
    openrouter: Object.freeze({
        url: 'https://openrouter.ai/api/alpha/decisions',
        model: '~typesafe/jev-latest'
    })
});

function normalizeProvider(value) {
    const provider = String(value || 'typesafe').trim().toLowerCase();
    return Object.hasOwn(PROVIDER_DEFAULTS, provider) ? provider : 'typesafe';
}

function parseInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

class GlobalJevService {
    constructor({ settingsManager, client = defaultClient, logger = console } = {}) {
        if (!settingsManager || typeof settingsManager.readSettings !== 'function') {
            throw new TypeError('GlobalJevService requires a settingsManager.');
        }
        this.settingsManager = settingsManager;
        this.client = client;
        this.logger = logger;
    }

    async _resolveConfig() {
        const settings = await this.settingsManager.readSettings();
        const provider = normalizeProvider(settings?.jevProvider);
        const defaults = PROVIDER_DEFAULTS[provider];

        return {
            enabled: settings?.jevEnabled === true,
            provider,
            url: String(settings?.jevApiUrl || defaults.url).trim(),
            apiKey: String(settings?.jevApiKey || '').trim(),
            model: String(settings?.jevModel || defaults.model).trim(),
            timeoutMs: parseInteger(settings?.jevTimeoutMs, 30000, 1000, 300000),
            maxRetries: parseInteger(settings?.jevMaxRetries, 2, 0, 10),
            retryBaseDelayMs: parseInteger(settings?.jevRetryBaseDelayMs, 500, 1, 30000),
            proxyUrl: String(settings?.jevProxyUrl || '').trim(),
            referer: String(settings?.jevHttpReferer || '').trim(),
            title: String(settings?.jevAppTitle || 'VCPChat').trim() || 'VCPChat'
        };
    }

    async getStatus() {
        const config = await this._resolveConfig();
        const clientStatus = this.client.getStatus(config);
        return Object.freeze({
            enabled: config.enabled,
            configured: config.enabled && clientStatus.configured,
            provider: clientStatus.provider,
            url: clientStatus.url,
            model: clientStatus.model,
            timeoutMs: clientStatus.timeoutMs,
            maxRetries: clientStatus.maxRetries,
            proxyEnabled: clientStatus.proxyEnabled
        });
    }

    async decide(state, questions, options = {}) {
        const config = await this._resolveConfig();
        if (!config.enabled) {
            const error = new Error('Jev 服务未启用，请先在全局设置的“Jev 服务”面板中启用。');
            error.name = 'JevServiceDisabledError';
            error.code = 'JEV_DISABLED';
            throw error;
        }

        return this.client.decide(state, questions, {
            ...config,
            signal: options.signal,
            headers: options.headers
        });
    }
}

module.exports = {
    GlobalJevService,
    PROVIDER_DEFAULTS,
    normalizeProvider
};