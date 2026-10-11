'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Engine } = require('./engine');

const COMMANDS = {
    Hammer: 'hammer', UseItem: 'use', BuyItem: 'buyItem', BuyRelic: 'buyRelic',
    Tribute: 'tribute', Watch: 'watch', Slay: 'slay'
};
function stepsOf(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须为对象');
    const numbered = Object.keys(args).filter(k => /^command[1-9]\d*$/.test(k))
        .map(k => Number(k.slice(7))).sort((a, b) => a - b);
    if (!numbered.length) return [{ ...args }];
    if (args.command) throw new Error('不能混用command与commandN');
    if (numbered.length > 32 || numbered.some((n, i) => n !== i + 1)) throw new Error('串指令须从1连续编号，最多32步');
    return numbered.map(n => {
        const step = {};
        for (const key of ['command', 'swordId', 'swordIds', 'itemId', 'relicId', 'replaceId', 'count', 'revision', 'runId', 'overwrite', 'seed', 'player']) {
            if (args[key + n] !== undefined) step[key] = args[key + n];
            else if (key !== 'command' && args[key] !== undefined) step[key] = args[key];
        }
        // A shared revision binds the start of the batch, not every succeeding step.
        if (n > 1 && args['revision' + n] === undefined) delete step.revision;
        return step;
    });
}
function normalizeAction(step) {
    const type = COMMANDS[step.command];
    if (!type) throw new Error('未知命令：' + step.command);
    const action = { type };
    for (const key of ['swordId', 'itemId', 'relicId', 'replaceId']) {
        if (step[key] !== undefined) action[key] = String(step[key]);
    }
    for (const key of ['count', 'revision']) {
        if (step[key] !== undefined) {
            const value = Number(step[key]);
            if (!Number.isSafeInteger(value) || value < 0) throw new Error(key + '必须是非负整数');
            action[key] = value;
        }
    }
    if (step.swordIds !== undefined) {
        const raw = step.swordIds;
        action.swordIds = Array.isArray(raw) ? raw.map(String)
            : String(raw).trim().startsWith('[') ? JSON.parse(raw)
            : String(raw).split(',').map(x => x.trim()).filter(Boolean);
        if (!Array.isArray(action.swordIds) || !action.swordIds.every(x => typeof x === 'string')) throw new Error('swordIds必须为剑ID数组或逗号列表');
    }
    return action;
}
class SessionStore {
    constructor(directory) {
        this.directory = directory;
        this.queues = new Map();
        this.listeners = new Set();
    }
    subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
    file(owner) {
        if (typeof owner !== 'string' || !owner.trim()) throw new Error('缺少可信对局所有者');
        return path.join(this.directory, crypto.createHash('sha256').update(owner).digest('hex') + '.json');
    }
    async load(owner) {
        try {
            const record = JSON.parse(await fs.readFile(this.file(owner), 'utf8'));
            if (record.owner !== owner) throw new Error('对局归属不一致');
            return new Engine({ save: record.save });
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error; // Corrupt saves must never be silently overwritten.
        }
    }
    async save(owner, engine) {
        await fs.mkdir(this.directory, { recursive: true });
        const file = this.file(owner), temp = file + '.' + crypto.randomUUID() + '.tmp';
        try {
            await fs.writeFile(temp, JSON.stringify({ owner, save: engine.exportSave() }), { encoding: 'utf8', flag: 'wx' });
            await fs.rename(temp, file);
        } finally { await fs.unlink(temp).catch(() => {}); }
    }
    execute(owner, args) {
        const prior = this.queues.get(owner) || Promise.resolve();
        const next = prior.catch(() => {}).then(() => this.executeSerial(owner, args));
        this.queues.set(owner, next);
        void next.finally(() => {
            if (this.queues.get(owner) === next) this.queues.delete(owner);
        }).catch(() => {});
        return next;
    }
    async executeSerial(owner, args) {
        const steps = stepsOf(args), results = [], events = [];
        let engine = await this.load(owner), failedStep = null;
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            let result;
            try {
                if (step.command === 'StartGame') {
                    if (engine && step.overwrite !== true && step.overwrite !== 'true') {
                        result = { ok: true, resumed: true, events: [], state: engine.getState() };
                    } else {
                        const created = new Engine({ player: step.player || owner, seed: step.seed === undefined ? undefined : Number(step.seed) });
                        await this.save(owner, created);
                        engine = created;
                        result = { ok: true, resumed: false, events: [{ type: 'started' }], state: engine.getState() };
                    }
                } else {
                    if (!engine) throw new Error('尚无对局，请先StartGame');
                    if (step.runId !== undefined && step.runId !== engine.s.runId) throw new Error('runId已过期');
                    if (step.revision !== undefined && Number(step.revision) !== engine.s.revision) throw new Error('状态已变化，请重新查询');
                    if (step.command === 'GetState') result = { ok: true, events: [], state: engine.getState() };
                    else {
                        const backup = engine.exportSave();
                        result = engine.dispatch(normalizeAction(step));
                        if (result.ok) {
                            try { await this.save(owner, engine); }
                            catch (error) {
                                engine = new Engine({ save: backup });
                                throw new Error('保存失败，当前步骤未提交：' + error.message);
                            }
                        }
                    }
                }
            } catch (error) {
                result = { ok: false, error: error.message, events: [], state: engine?.getState() || null };
            }
            results.push({ step: i + 1, command: step.command, ...result });
            events.push(...result.events);
            if (!result.ok) { failedStep = i + 1; break; }
        }
        const output = {
            ok: failedStep === null, partial: failedStep !== null && results.some(r => r.ok),
            failedStep, skipped: steps.slice(results.length).map((step, i) => ({ step: results.length + i + 1, command: step.command })),
            error: failedStep === null ? undefined : results.at(-1).error,
            results, events, state: engine?.getState() || null
        };
        // One publication per entire batch. Frontend aggregates its audio once.
        for (const listener of events.length ? this.listeners : []) {
            try { listener(owner, output); } catch {}
        }
        return output;
    }
}
module.exports = { SessionStore, stepsOf, normalizeAction };