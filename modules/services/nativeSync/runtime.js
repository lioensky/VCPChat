'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { NativeSyncAdapter } = require('./adapter');
const { fail } = require('./protocol');

async function createNativeSyncRuntime({ queue, appDataRoot, args = [], isolated = false, notify, intervalMs = 250, readSettings, readAgentConfig, thumbnail, request }) {
    const poc = args.includes('--native-sync-poc');
    if (poc && !isolated) throw fail('ISOLATED_APP_DATA_REQUIRED');
    if (!poc && !appDataRoot) return null;
    const connection = poc ? null : await require('./connection').readConnection({ appDataRoot, readSettings });
    if (!poc && !connection) return null;
    const statePath = path.join(appDataRoot, '.native-sync', 'state.json');
    let existingState = false, prepared = !connection;
    if (connection) {
        try {
            const stat = await fs.lstat(statePath);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('SYNC_STATE_ALIAS');
            existingState = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const send = request || (async (route, { body } = {}) => {
        let response;
        try {
            response = await fetch(connection.url + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(8000) });
        } catch { throw fail('NETWORK_UNAVAILABLE'); }
        if (!response.ok) throw fail('SYNC_SERVER_UNAVAILABLE');
        return response.json();
    });
    const prepare = async () => {
        if (connection) {
            await require('./initialImport').initialImport({ queue, appDataRoot, connection, request: (route, body) => send(route, { body }) });
            if (connection.publishCatalog) {
                const metadata = await require('./catalog').catalog({ appDataRoot, topics: connection.topics, readAgentConfig, thumbnail });
                await send('/api/plugins/NativeSync/mobile/catalog', { body: metadata });
            }
        }
        prepared = true;
    };
    // Existing shared histories attach Queue policy locally before network work.
    // First attachment still requires the approved online comparison.
    if (!existingState) await prepare();
    const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (poc) {
        let endpoint;
        try { endpoint = new URL(option('native-sync-url')); } catch { throw fail('ISOLATED_LOOPBACK_REQUIRED'); }
        if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw fail('ISOLATED_LOOPBACK_REQUIRED');
    }
    const adapter = await NativeSyncAdapter.open({ queue, statePath, ...(connection || { url: option('native-sync-url'), deviceId: option('native-sync-device'), topics: JSON.parse(option('native-sync-topics') || '[]'), token: 'isolated-poc-token' }), ...((connection || request) ? { request: send } : {}), notify });
    let stopped = false, running = null;
    const timer = setInterval(() => {
        if (stopped || running) return;
        running = (async () => { if (!prepared) await prepare(); await adapter.synchronize(); })().catch(error => {
            adapter.degraded = error.code || 'SYNC_FAILED';
        }).finally(() => { running = null; });
    }, intervalMs);
    timer.unref?.();
    return { adapter, async close() { stopped = true; clearInterval(timer); await running; await adapter.close(); } };
}
module.exports = { createNativeSyncRuntime };
