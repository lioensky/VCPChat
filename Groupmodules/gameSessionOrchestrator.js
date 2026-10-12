'use strict';

class GameSessionOrchestrator {
    constructor({ gameService, appendEvent, runAgent, maxReminders = 2 } = {}) {
        if (!gameService || typeof appendEvent !== 'function' || typeof runAgent !== 'function') {
            throw new TypeError('gameService, appendEvent and runAgent are required.');
        }
        if (!Number.isInteger(maxReminders) || maxReminders < 0 || maxReminders > 5) {
            throw new RangeError('maxReminders must be 0..5.');
        }
        this.gameService = gameService;
        this.appendEvent = appendEvent;
        this.runAgent = runAgent;
        this.maxReminders = maxReminders;
        this.sessions = new Map();
    }
    getState(matchId) {
        const session = this.sessions.get(matchId);
        return session ? {
            running: Boolean(session.promise), status: session.status,
            reason: session.reason, seat: session.seat,
        } : { running: false, status: 'idle', reason: null, seat: null };
    }
    start(matchId) {
        let session = this.sessions.get(matchId);
        if (session?.promise) return session.promise;
        session = { promise: null, status: 'starting', reason: null, seat: null, stop: false };
        this.sessions.set(matchId, session);
        // Defer execution so the run owns its slot before any adapter is invoked.
        session.promise = Promise.resolve().then(() => this.run(matchId, session))
            .catch(error => {
                session.status = 'paused';
                session.reason = error?.code || 'request_failed';
                throw error;
            })
            .finally(() => { session.promise = null; session.seat = null; });
        return session.promise;
    }
    stop(matchId) {
        const session = this.sessions.get(matchId);
        if (session) session.stop = true;
        // Existing VCP request completes; no new seat will be invited.
    }
    async syncEvents(matchId) {
        const record = await this.gameService.read(matchId);
        for (const event of record.pendingEvents) {
            await this.appendEvent({
                groupId: record.groupId, topicId: record.topicId,
                seats: record.seats, event,
                messageId: `${matchId}:${event.id}`,
            });
            await this.gameService.acknowledgeEvents(matchId, [event.id]);
        }
    }
    async run(matchId, session) {
        let decision = null, attempts = 0;
        while (!session.stop) {
            session.status = 'syncing';
            await this.syncEvents(matchId);
            const record = await this.gameService.read(matchId);
            if (record.state.phase === 'finished') {
                session.status = 'finished';
                return this.getState(matchId);
            }
            const seat = record.state.turn;
            if (record.seats[seat]?.kind === 'human') {
                session.status = 'waiting-human';
                return this.getState(matchId);
            }
            const observation = await this.gameService.getObservation(matchId, seat);
            if (decision !== observation.decisionId) {
                decision = observation.decisionId;
                attempts = 0;
            }
            if (attempts > this.maxReminders) {
                session.status = 'paused';
                session.reason = 'decision_not_submitted';
                return this.getState(matchId);
            }
            // Recheck after async observation loading; never invite a stale decision.
            const latest = await this.gameService.read(matchId);
            if (latest.state.revision !== observation.revision || latest.state.turn !== seat) continue;
            if (session.stop) break;
            session.status = 'requesting';
            session.seat = seat;
            await this.runAgent({
                matchId, groupId: record.groupId, topicId: record.topicId,
                agentId: record.seats[seat].agentId, seat,
                observation, reminder: attempts > 0,
            });
            attempts++;
        }
        await this.syncEvents(matchId);
        session.status = 'paused';
        session.reason = 'stopped';
        return this.getState(matchId);
    }
}
module.exports = { GameSessionOrchestrator };