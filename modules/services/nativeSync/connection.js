'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { identity, fail } = require('./protocol');

// Explicit, non-secret selection. Authentication stays in existing desktop
// backend settings and may only be sent to that same HTTPS origin.
async function readConnection({ appDataRoot, readSettings }) {
    const file = path.join(path.resolve(appDataRoot), '.native-sync', 'connection.json');
    try {
        const directory = await fs.lstat(path.dirname(file));
        if (directory.isSymbolicLink() || !directory.isDirectory()) throw fail('SYNC_CONNECTION_ALIAS');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let config;
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw fail('SYNC_CONNECTION_ALIAS');
        config = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (config.enabled !== true) return null;
    const fields = ['version', 'enabled', 'historySelectionApproved', 'deviceId', 'topics', 'serverUrl', 'credentialSource', 'approvedHistory', 'publishCatalog'];
    if (Object.keys(config).some(key => !fields.includes(key))) throw fail('UNEXPECTED_SYNC_CONNECTION_FIELD');
    if (config.version !== 1 || config.historySelectionApproved !== true || typeof config.deviceId !== 'string' || !config.deviceId || !Array.isArray(config.topics) || !config.topics.length || config.topics.length > 8 || (config.publishCatalog !== undefined && typeof config.publishCatalog !== 'boolean')) throw fail('INVALID_SYNC_CONNECTION');
    for (const topic of config.topics) identity({ ownerType: topic.itemType || 'agent', ownerId: topic.itemId, topicId: topic.topicId, msgId: '_' });
    if (config.topics.some(topic => (topic.itemType || 'agent') !== 'agent')) throw fail('MOBILE_AGENT_TOPICS_ONLY');
    let endpoint;
    try { endpoint = new URL(config.serverUrl); } catch { throw fail('SYNC_HTTPS_REQUIRED'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw fail('SYNC_HTTPS_REQUIRED');
    if (config.credentialSource !== 'existing-vcp-settings' || typeof readSettings !== 'function') throw fail('DESKTOP_SETTINGS_AUTHORITY_REQUIRED');
    const settings = await readSettings();
    let backend;
    try { backend = new URL(settings.vcpServerUrl); } catch { throw fail('DESKTOP_BACKEND_IDENTITY_MISMATCH'); }
    if (backend.origin !== endpoint.origin || backend.username || backend.password || backend.search || backend.hash) throw fail('DESKTOP_BACKEND_IDENTITY_MISMATCH');
    if (typeof settings.vcpApiKey !== 'string' || !settings.vcpApiKey) throw fail('EXISTING_DESKTOP_KEY_REQUIRED');
    return { url: endpoint.origin, token: settings.vcpApiKey, deviceId: config.deviceId, topics: config.topics, approvedHistory: config.approvedHistory, publishCatalog: config.publishCatalog !== false };
}
module.exports = { readConnection };
