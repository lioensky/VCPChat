'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const rules = require('../game/doudizhu/rules');

function error(code, message) {
    return Object.assign(new Error(message), { code });
}
function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
// Internal main-process API. IPC/tool adapters must bind seat authority before calling.
class GameService {
    constructor({ appDataRoot, integer, onCommitted = () => {} } = {}) {
        if (!appDataRoot) throw new TypeError('appDataRoot is required.');
        this.root = path.join(appDataRoot, 'games');
        this.integer = integer;
        this.onCommitted = onCommitted;
        this.queues = new Map();
    }
    file(matchId) {
        if (!/^match-[a-f0-9-]{36}$/.test(matchId)) throw error('INVALID_MATCH', '对局ID无效。');
        return path.join(this.root, matchId, 'state.json');
    }
    async initialize() { await fs.mkdir(this.root, { recursive: true }); }
    async serial(matchId, operation) {
        const previous = this.queues.get(matchId) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.queues.set(matchId, current);
        try { return await current; }
        finally { if (this.queues.get(matchId) === current) this.queues.delete(matchId); }
    }
    async read(matchId) {
        const record = JSON.parse(await fs.readFile(this.file(matchId), 'utf8'));
        if (record.schemaVersion !== 1 || record.matchId !== matchId
            || record.gameTypeId !== 'doudizhu' || !Array.isArray(record.pendingEvents)
            || !record.submissions || !record.state
            || record.state.rulesVersion !== require('../game/doudizhu/cards').RULES_VERSION) {
            throw error('CORRUPT_SAVE', '对局存档格式或规则版本不匹配，拒绝作为空局恢复。');
        }
        return record;
    }
    async write(record) {
        const destination = this.file(record.matchId);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
            const handle = await fs.open(temporary, 'wx');
            try {
                await handle.writeFile(JSON.stringify(record), 'utf8');
                await handle.sync();
            } finally { await handle.close(); }
            await fs.rename(temporary, destination);
        } finally { await fs.rm(temporary, { force: true }); }
    }
    async createMatch({ seats, groupId, topicId, firstSeat = 0 }) {
        if (!Array.isArray(seats) || seats.length !== 3 || seats[0]?.kind !== 'human'
            || seats.slice(1).some(seat => seat?.kind !== 'agent'
                || typeof seat.agentId !== 'string' || !seat.agentId)
            || seats[1].agentId === seats[2].agentId) {
            throw error('INVALID_SEATS', '需要一个用户和两个不同的Agent座位。');
        }
        if (typeof groupId !== 'string' || !groupId || typeof topicId !== 'string' || !topicId) {
            throw error('INVALID_SESSION', '开局需要绑定后台会话。');
        }
        const matchId = `match-${randomUUID()}`;
        const record = {
            schemaVersion: 1, gameTypeId: 'doudizhu', matchId,
            seats: structuredClone(seats), groupId, topicId,
            state: rules.create({ firstSeat, integer: this.integer }),
            submissions: {}, pendingEvents: [], createdAt: Date.now(),
        };
        await this.write(record);
        return { matchId, observation: rules.observation(record.state, 0) };
    }
    async nextMatch(previousMatchId) {
        return this.serial(previousMatchId, async () => {
            const previous = await this.read(previousMatchId);
            if (previous.state.phase !== 'finished') {
                throw error('MATCH_NOT_FINISHED', '当前对局尚未结束，不能开始下一局。');
            }
            // Deterministic successor survives a crash between child save and parent link.
            const hex = createHash('sha256').update(`vgame-next:${previousMatchId}`).digest('hex').slice(0, 32);
            const matchId = `match-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            let record;
            try {
                record = await this.read(matchId);
                if (record.previousMatchId !== previousMatchId
                    || record.groupId !== previous.groupId || record.topicId !== previous.topicId) {
                    throw error('SUCCESSOR_CONFLICT', '下一局存档关联不一致。');
                }
            } catch (failure) {
                if (failure.code !== 'ENOENT') throw failure;
                const state = rules.create({ firstSeat: 0, integer: this.integer });
                const event = { id: 'event-1', phase: 'bidding', type: 'new-match', matchId, previousMatchId };
                state.events.push(event);
                record = {
                    schemaVersion: 1, gameTypeId: 'doudizhu', matchId, previousMatchId,
                    seats: structuredClone(previous.seats),
                    groupId: previous.groupId, topicId: previous.topicId,
                    state, submissions: {}, pendingEvents: [event], createdAt: Date.now(),
                };
                await this.write(record);
            }
            if (previous.nextMatchId !== matchId) {
                previous.nextMatchId = matchId;
                await this.write(previous);
            }
            return { matchId, groupId: record.groupId, topicId: record.topicId,
                observation: await this.getObservation(matchId, 0) };
        });
    }
    summary(record) {
        return {
            matchId: record.matchId, gameTypeId: record.gameTypeId,
            createdAt: record.createdAt, phase: record.state.phase,
            winner: record.state.winner || null,
            players: record.seats.map((seat, index) => seat.name || `座位${index + 1}`),
        };
    }
    async listRecords() {
        let entries;
        try { entries = await fs.readdir(this.root, { withFileTypes: true }); }
        catch (failure) { if (failure.code === 'ENOENT') return { records: [], unavailable: [] }; throw failure; }
        const records = [], unavailable = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !/^match-[a-f0-9-]{36}$/.test(entry.name)) continue;
            try { records.push(this.summary(await this.read(entry.name))); }
            catch (failure) { unavailable.push({ matchId: entry.name, error: failure.message }); }
        }
        records.sort((a, b) => b.createdAt - a.createdAt || a.matchId.localeCompare(b.matchId));
        return { records, unavailable };
    }
    async getPublicRecord(matchId) {
        const record = await this.read(matchId);
        // Public event history only: never expose hands, submissions or private invitations.
        return { ...this.summary(record), events: structuredClone(record.state.events) };
    }
    async getObservation(matchId, authorizedSeat) {
        const record = await this.read(matchId);
        return {
            matchId, decisionId: `${matchId}:${record.state.revision}`,
            ...rules.observation(record.state, authorizedSeat),
            players: record.seats.map((player, seat) => ({ seat, name: player.name || `座位${seat + 1}` })),
        };
    }
    async submit(matchId, authorizedSeat, request) {
        let committed = false;
        const result = await this.serial(matchId, async () => {
            const record = await this.read(matchId);
            const { submissionId, decisionId, revision, action } = request || {};
            if (typeof submissionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(submissionId)) {
                throw error('INVALID_SUBMISSION', '提交ID无效。');
            }
            const fingerprint = createHash('sha256').update(stable({
                seat: authorizedSeat, decisionId, revision, action,
            })).digest('hex');
            const previous = Object.hasOwn(record.submissions, submissionId)
                ? record.submissions[submissionId] : null;
            if (previous) {
                if (previous.fingerprint !== fingerprint) throw error('SUBMISSION_CONFLICT', '同一提交ID不能用于不同动作。');
                return structuredClone(previous.result);
            }
            if (revision !== record.state.revision
                || decisionId !== `${matchId}:${record.state.revision}`) {
                throw error('STALE_DECISION', '决策已过期，请使用当前邀请状态。');
            }
            const transition = rules.apply(record.state, authorizedSeat, action, { integer: this.integer });
            record.state = transition.state;
            const events = transition.events.map(event => ({ ...event, matchId }));
            record.pendingEvents.push(...events);
            const result = { accepted: true, matchId, submissionId, revision: record.state.revision, events };
            Object.defineProperty(record.submissions, submissionId, {
                value: { fingerprint, result }, enumerable: true, configurable: true, writable: true,
            });
            await this.write(record);
            committed = true;
            return structuredClone(result);
        });
        // Release the match lock before the adapter acknowledges events or schedules work.
        if (committed) {
            try { await this.onCommitted({ matchId, revision: result.revision }); }
            catch { /* Pending events survive adapter failure and can be retried. */ }
        }
        return result;
    }
    async getPendingEvents(matchId) {
        return structuredClone((await this.read(matchId)).pendingEvents);
    }
    async acknowledgeEvents(matchId, eventIds) {
        if (!Array.isArray(eventIds) || eventIds.some(id => typeof id !== 'string')) {
            throw new TypeError('eventIds must be strings.');
        }
        return this.serial(matchId, async () => {
            const record = await this.read(matchId);
            const acknowledged = new Set(eventIds);
            record.pendingEvents = record.pendingEvents.filter(event => !acknowledged.has(event.id));
            await this.write(record);
        });
    }
}
module.exports = { GameService };