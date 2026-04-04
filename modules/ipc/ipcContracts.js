const CHANNEL_TYPES = Object.freeze({
    COMMAND: 'command',
    QUERY: 'query',
    STREAM: 'stream',
    LIFECYCLE: 'lifecycle',
});

const CHANNELS = Object.freeze({
    WINDOW_READY: 'window-lifecycle:ready',
    DESKTOP_REMOTE_REQUEST: 'desktop-remote:request',
    DESKTOP_REMOTE_RESPONSE: 'desktop-remote:response',
    FLOWLOCK_REQUEST: 'flowlock:request',
    FLOWLOCK_RESPONSE: 'flowlock:response',
    DESKTOP_LAUNCH: 'desktop-launch-vchat-app',
});

const channelRegistry = new Map([
    [CHANNELS.WINDOW_READY, {
        channelName: CHANNELS.WINDOW_READY,
        channelType: CHANNEL_TYPES.LIFECYCLE,
        owner: 'VChat Shell',
        requestSchema: { appId: 'string', payload: 'object?' },
        responseSchema: null,
        supportsConcurrent: true,
    }],
    [CHANNELS.DESKTOP_REMOTE_REQUEST, {
        channelName: CHANNELS.DESKTOP_REMOTE_REQUEST,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VDesktop Platform',
        requestSchema: { requestId: 'string', command: 'string', payload: 'object?' },
        responseSchema: { requestId: 'string', ok: 'boolean', data: 'object?', error: 'string?' },
        supportsConcurrent: true,
    }],
    [CHANNELS.DESKTOP_REMOTE_RESPONSE, {
        channelName: CHANNELS.DESKTOP_REMOTE_RESPONSE,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VDesktop Platform',
        requestSchema: { requestId: 'string', ok: 'boolean', data: 'object?', error: 'string?' },
        responseSchema: null,
        supportsConcurrent: true,
    }],
    [CHANNELS.FLOWLOCK_REQUEST, {
        channelName: CHANNELS.FLOWLOCK_REQUEST,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VChat Shell',
        requestSchema: { requestId: 'string', command: 'string', payload: 'object?' },
        responseSchema: { requestId: 'string', ok: 'boolean', data: 'object?', error: 'string?' },
        supportsConcurrent: true,
    }],
    [CHANNELS.FLOWLOCK_RESPONSE, {
        channelName: CHANNELS.FLOWLOCK_RESPONSE,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VChat Shell',
        requestSchema: { requestId: 'string', ok: 'boolean', data: 'object?', error: 'string?' },
        responseSchema: null,
        supportsConcurrent: true,
    }],
    [CHANNELS.DESKTOP_LAUNCH, {
        channelName: CHANNELS.DESKTOP_LAUNCH,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VChat Shell',
        requestSchema: { appAction: 'string' },
        responseSchema: { success: 'boolean', appId: 'string?' },
        supportsConcurrent: true,
    }],
]);

function getChannelMeta(channelName) {
    return channelRegistry.get(channelName) || null;
}

function listChannels() {
    return Array.from(channelRegistry.values());
}

module.exports = {
    CHANNELS,
    CHANNEL_TYPES,
    getChannelMeta,
    listChannels,
};
