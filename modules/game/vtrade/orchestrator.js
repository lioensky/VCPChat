'use strict';

// Asks Chat Agents to play their VTrade 对决 seats. VTrade keeps the rounds and the rules; this only finds Agent
// seats that are waiting, invites the Agent in a background game group with VTrade's invitation (the turn and a
// one-turn decision ticket), and lets the Agent submit through the VTrade tool. An Agent that does not submit after
// the reminders keeps its position for the day, so a round never stalls.
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const IDLE_STOP_MS = 10 * 60 * 1000;
const AVATAR_PX = 96, AVATAR_MAX = 90 * 1024;

// A Chat avatar (a file URL) as a small data URL, since the VTrade page cannot load local files; null if unreadable.
function readAvatar(avatarUrl) {
    if (!avatarUrl) return null;
    try {
        const { nativeImage } = require('electron');
        const image = nativeImage.createFromPath(fileURLToPath(new URL(avatarUrl)));
        if (image.isEmpty()) return null;
        const small = image.resize({ width: AVATAR_PX, quality: 'good' });
        const png = small.toDataURL();
        return png.length <= AVATAR_MAX ? png : `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}`;
    } catch { return null; }
}

class VTradeOrchestrator {
    // client: VTradeClient. groupChat: createAgentGroup / getAgentGroupConfig. listAgents(): [{ id, name, avatarUrl }].
    // runAgent({ groupId, topicId, agentId, invitePrompt }) runs one invited reply. sessionsFile keeps the background
    // group of each round and Agent across restarts. readAvatar(avatarUrl) gives an avatar as a data URL or null.
    // maxParallel: how many seats may be answering at once (each Agent answers in its own background group).
    constructor({ client, groupChat, listAgents, runAgent, sessionsFile, pollMs = 3000, maxReminders = 2, maxParallel = 4,
        log = console, readAvatar: avatar = readAvatar } = {}) {
        if (!client || !groupChat || typeof listAgents !== 'function' || typeof runAgent !== 'function' || !sessionsFile) {
            throw new TypeError('VTradeOrchestrator requires client, groupChat, listAgents, runAgent and sessionsFile.');
        }
        Object.assign(this, { client, groupChat, listAgents, runAgent, sessionsFile, pollMs, maxReminders, maxParallel, log, readAvatar: avatar });
        this.timer = null; this.polling = false; this.running = new Set(); this.attempts = new Map(); this.idleSince = null;
        this.sessionWrites = Promise.resolve();
        this.status = { state: 'stopped', error: null, current: null };
    }
    // Polls while the VTrade window is open or Agent seats are waiting; stops after a quiet spell with no window.
    start({ windowOpen = () => false } = {}) {
        this.windowOpen = windowOpen;
        if (this.timer) return;
        this.status.state = 'running';
        this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
        void this.tick();
    }
    stop() { clearInterval(this.timer); this.timer = null; this.status.state = 'stopped'; }
    // At Chat startup: rounds left with Agent seats waiting (e.g. across a restart) carry on without opening a window.
    // One request; when VTrade is not used or not reachable, nothing more is sent.
    async resumeIfWaiting({ windowOpen } = {}) {
        try {
            const { invites } = await this.client.duel('invites');
            if (invites.length) this.start({ windowOpen });
        } catch { /* nothing to resume */ }
    }
    // Gives VTrade the Agents Chat can invite, with small avatars, so the page offers them however it was opened.
    async syncRoster() {
        const agents = (await this.listAgents()).slice(0, 200);
        const roster = await Promise.all(agents.map(async agent => {
            const avatar = await this.readAvatar(agent.avatarUrl);
            return avatar ? { name: agent.name, avatar } : { name: agent.name };
        }));
        return this.client.duel('syncRoster', { agents: roster });
    }
    // Every tick asks VTrade for invites, also while Agents are answering: that is how its page knows the orchestrator
    // is running. A seat is handled once at a time; different seats answer in parallel, each in its own background
    // group, so a round with two Agents does not wait for one before inviting the other.
    async tick() {
        if (this.polling) return;
        this.polling = true;
        const started = [];
        try {
            const { invites } = await this.client.duel('invites');
            this.status.error = null;
            if (!invites.length) {
                this.idleSince ??= Date.now();
                if (!this.windowOpen() && Date.now() - this.idleSince > IDLE_STOP_MS) this.stop();
                return;
            }
            this.idleSince = null;
            for (const invite of invites) {
                const seat = `${invite.roundId}:${invite.seatId}`;
                if (!this.timer || this.running.has(seat) || this.running.size >= this.maxParallel) continue;
                this.running.add(seat);
                started.push(this.handle(invite).catch(error => this.fail(error)).finally(() => {
                    this.running.delete(seat);
                    if (!this.running.size) this.status.current = null;
                }));
            }
        } catch (error) {
            this.fail(error);
        } finally { this.polling = false; }
        await Promise.all(started);
    }
    fail(error) {
        this.status.error = error.message;
        // Without the plugin or the account there is nothing to orchestrate until the user fixes it.
        if (['PLUGIN_MISSING', 'NO_ADMIN_ACCOUNT', 'NOT_CONFIGURED', 'UNAUTHORIZED'].includes(error.code)) this.stop();
    }
    async handle(invite) {
        const key = `${invite.roundId}:${invite.seatId}:${invite.day}`, attempts = this.attempts.get(key) || 0;
        for (const stale of this.attempts.keys()) if (stale.startsWith(`${invite.roundId}:${invite.seatId}:`) && stale !== key) this.attempts.delete(stale);
        if (attempts > this.maxReminders) {
            await this.hold(invite, `${invite.label} 在 ${attempts} 次邀请后仍未提交，维持原仓位`);
            this.attempts.delete(key);
            return;
        }
        const agent = await this.resolve(invite.agent);
        if (!agent) { await this.hold(invite, `VCPChat 中没有名为 ${invite.agent} 的 Agent，维持原仓位`); return; }
        const { turn } = await this.client.duel('turn', { roundId: invite.roundId, seatId: invite.seatId, reminder: attempts > 0 });
        if (turn.decided || turn.status !== 'active' || turn.day !== invite.day || !turn.invitation) return;
        const session = await this.session(invite.roundId, agent);
        this.attempts.set(key, attempts + 1);
        this.status.current = { roundId: invite.roundId, agent: agent.name, day: invite.day };
        try {
            await this.runAgent({ groupId: session.groupId, topicId: session.topicId, agentId: agent.id,
                invitePrompt: `[系统邀请指令:]\n${turn.invitation}` });
        } catch (error) {
            this.log.warn?.('[VTrade] 邀请 Agent 失败:', error?.message || error);
        }
    }
    async hold(invite, reason) {
        try { await this.client.duel('hold', { roundId: invite.roundId, seatId: invite.seatId, day: invite.day, reason: reason.slice(0, 120) }); }
        catch (error) { if (error.code !== 'STALE_DAY' && error.code !== 'ALREADY_DECIDED') throw error; }
    }
    async resolve(name) {
        const agents = await this.listAgents(), wanted = String(name).trim().toLowerCase();
        return agents.find(a => a.name.toLowerCase() === wanted) || agents.find(a => a.id.toLowerCase() === wanted) || null;
    }
    // One background game group per round and Agent: invitations are private to it and replies stay out of history.
    // Seats answer in parallel but share the sessions file, so groups are looked up and created one at a time.
    session(roundId, agent) {
        const next = this.sessionWrites.then(() => this.openSession(roundId, agent));
        this.sessionWrites = next.catch(() => {});
        return next;
    }
    async openSession(roundId, agent) {
        const sessions = await fs.readFile(this.sessionsFile, 'utf8').then(JSON.parse).catch(() => ({}));
        const key = `${roundId}:${agent.id}`, saved = sessions[key];
        if (saved) {
            const group = await this.groupChat.getAgentGroupConfig(saved.groupId);
            if (group?.mode === 'game' && group.topics?.some(topic => topic.id === saved.topicId)) return saved;
        }
        const created = await this.groupChat.createAgentGroup(`VTrade 对决 · ${agent.name} · ${roundId.slice(5, 11)}`, {
            mode: 'game', members: [agent.id], modeSettings: { game: { gameTypeId: 'vtrade-duel' } },
            enableContextMessageWindow: true, contextMessageWindowSize: 20,
        });
        if (!created?.success) throw new Error(created?.error || '创建后台游戏会话失败。');
        sessions[key] = { groupId: created.agentGroup.id, topicId: created.agentGroup.topics[0].id };
        await fs.mkdir(path.dirname(this.sessionsFile), { recursive: true });
        await fs.writeFile(this.sessionsFile, JSON.stringify(sessions, null, 1));
        return sessions[key];
    }
}

module.exports = { VTradeOrchestrator };
