'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TOPIC_ID = /^topic_[A-Za-z0-9_-]+$/;
const REQUEST_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RECORDS = 20000;
const MAX_BYTES = 16 * 1024 * 1024;

class TopicReplyError extends Error {
    constructor(code, status) {
        super(code);
        this.code = code;
        this.status = status;
    }
}

function publicReceipt(row) {
    const { requestId, state, advanceRequested, advanceEffective, entryId } = row;
    return { requestId, state, advanceRequested, advanceEffective, ...(entryId ? { entryId } : {}) };
}

async function openTopicReplyStore(filename) {
    const dir = path.dirname(filename);
    await fs.mkdir(dir, { recursive: true });
    let records = new Map();
    const read = await fs.open(filename, 'r').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
    });
    if (read) {
        try {
            const stat = await read.stat();
            if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('INVALID_TOPIC_REPLY_LEDGER');
            const data = JSON.parse(await read.readFile('utf8'));
            if (data?.version !== 1 || !Array.isArray(data.records)
                || data.records.length > MAX_RECORDS) throw new Error('INVALID_TOPIC_REPLY_LEDGER');
            for (const row of data.records) {
                if (!row || !valid(HASH, row.key) || records.has(row.key) || !valid(HASH, row.fingerprint)
                    || !valid(REQUEST_ID, row.requestId) || !valid(TOPIC_ID, row.topicId) || row.topicId.length > 160
                    || !['inflight', 'queued', 'uncertain'].includes(row.state)
                    || ![null, true, false].includes(row.advanceRequested) || typeof row.advanceEffective !== 'boolean'
                    || (row.advanceRequested !== null && row.advanceRequested !== row.advanceEffective)
                    || (row.state === 'queued' ? !valid(ENTRY_ID, row.entryId) : row.entryId !== undefined)) {
                    throw new Error('INVALID_TOPIC_REPLY_LEDGER');
                }
                records.set(row.key, row);
            }
        } finally {
            await read.close();
        }
    }

    let failed = false;
    async function persist(next) {
        const tmp = `${filename}.${randomUUID()}.tmp`;
        try {
            const encoded = JSON.stringify({ version: 1, records: [...next.values()] });
            if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('TOPIC_REPLY_LEDGER_FULL');
            const file = await fs.open(tmp, 'wx', 0o600);
            try {
                await file.writeFile(encoded);
                await file.sync();
            } finally {
                await file.close();
            }
            await fs.rename(tmp, filename);
            if (process.platform !== 'win32') {
                const folder = await fs.open(dir, 'r');
                try { await folder.sync(); } finally { await folder.close(); }
            }
            records = next;
        } catch {
            failed = true;
            await fs.unlink(tmp).catch(() => {});
            throw new TopicReplyError('LEDGER_UNAVAILABLE', 503);
        }
    }

    const recovery = new Map(records);
    let recovered = false;
    for (const [key, row] of records) {
        if (row.state !== 'inflight') continue;
        recovery.set(key, { ...row, state: 'uncertain' });
        recovered = true;
    }
    if (recovered) await persist(recovery);

    let tail = Promise.resolve();
    function serial(operation) {
        const result = tail.then(() => {
            if (failed) throw new TopicReplyError('LEDGER_UNAVAILABLE', 503);
            return operation();
        });
        tail = result.catch(() => {});
        return result;
    }

    return Object.freeze({
        reserve(row, allowedTopics) {
            return serial(async () => {
                const previous = records.get(row.key);
                if (previous) {
                    if (!allowedTopics.has(previous.topicId)) throw new TopicReplyError('TOPIC_DENIED', 403);
                    if (previous.fingerprint !== row.fingerprint) throw new TopicReplyError('REQUEST_CONFLICT', 409);
                    return { fresh: false, receipt: publicReceipt(previous) };
                }
                if (records.size >= MAX_RECORDS) throw new TopicReplyError('LEDGER_FULL', 503);
                const next = { ...row, state: 'inflight' };
                await persist(new Map(records).set(row.key, next));
                return { fresh: true };
            });
        },
        finish(key, entryId) {
            return serial(async () => {
                const row = records.get(key);
                if (row?.state !== 'inflight') throw new TopicReplyError('LEDGER_UNAVAILABLE', 503);
                const next = entryId ? { ...row, state: 'queued', entryId } : { ...row, state: 'uncertain' };
                await persist(new Map(records).set(key, next));
                return publicReceipt(next);
            });
        },
        inspect(key, requestId, allowedTopics) {
            return serial(() => {
                const row = records.get(key);
                return row && allowedTopics.has(row.topicId) ? publicReceipt(row)
                    : { requestId, state: 'not_found', advanceRequested: null, advanceEffective: null };
            });
        }
    });
}

function valid(pattern, value) {
    return typeof value === 'string' && pattern.test(value);
}

module.exports = { openTopicReplyStore, TopicReplyError, TOPIC_ID, REQUEST_ID, ENTRY_ID, valid };