'use strict';

const fs = require('fs-extra');
const path = require('path');
const { randomUUID } = require('crypto');

function createTopicMessageAdmissionStore(filePath) {
    if (!path.isAbsolute(filePath)) throw new TypeError('Admission journal requires absolute path');
    const validateLeases = leases => {
        if (!Array.isArray(leases)) throw new TypeError('Invalid standalone lease journal');
        const { conversationKey } = require('./historyMutationQueue');
        const seen = new Set();
        for (const lease of leases) {
            const key = conversationKey(lease?.scope || {});
            if (typeof lease.token !== 'string' || !lease.token || seen.has(key)) {
                throw new TypeError('Invalid or duplicate standalone lease');
            }
            seen.add(key);
        }
    };
    const loadState = async () => {
        let data;
        try { data = await fs.readJson(filePath); }
        catch (error) {
            if (error.code === 'ENOENT') return { entries: [], standaloneLeases: [] };
            throw error;
        }
        if (![1, 2].includes(data?.version) || !Array.isArray(data.entries)) {
            throw new Error('Unsupported or corrupt admission journal');
        }
        const standaloneLeases = data.version === 1 ? [] : data.standaloneLeases;
        validateLeases(standaloneLeases);
        return { entries: data.entries, standaloneLeases };
    };
    return {
        loadState,
        // Legacy consumers read messages only. The central owner uses loadState.
        async load() { return (await loadState()).entries; },
        async save(entries, standaloneLeases = []) {
            if (!Array.isArray(entries)) throw new TypeError('Admission entries must be an array');
            validateLeases(standaloneLeases);
            // Freeze before the first await; caller mutation cannot alter the transaction.
            const snapshot = structuredClone({ version: 2, entries, standaloneLeases });
            await fs.ensureDir(path.dirname(filePath));
            const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
            try {
                await fs.writeJson(temporary, snapshot, { spaces: 2 });
                await fs.rename(temporary, filePath);
            } finally {
                await fs.remove(temporary);
            }
        },
    };
}

module.exports = { createTopicMessageAdmissionStore };