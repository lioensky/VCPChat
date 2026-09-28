'use strict';
// 歧义票据：EditCode 遇到 target 多处命中时签发，AI 用 ResolveEdit(ticketId, pick) 选择，无需重发内容。
// 票据只存内存（常驻进程），带 TTL；进程重启丢失的代价只是 AI 重发一次。
// 解析时若文件 hash 已变：重新匹配，候选签名（各命中起始行）一致才放行，否则作废并返回新候选。

const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TICKETS = 200;

class TicketStore {
    constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
        this.ttlMs = ttlMs;
        this.tickets = new Map();
    }

    _sweep() {
        const now = Date.now();
        for (const [id, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(id);
        // 容量保护：删除最旧的
        while (this.tickets.size > MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value);
    }

    /**
     * @param {object} data { projectId, relPath, fileHash, steps, options, reason, todoId, ambiguities }
     */
    issue(data) {
        this._sweep();
        let id;
        do { id = `t${crypto.randomBytes(3).toString('hex')}`; } while (this.tickets.has(id));
        const signatures = Object.fromEntries(data.ambiguities.map(a => [a.step, a.signature]));
        this.tickets.set(id, { ...data, id, signatures, expiresAt: Date.now() + this.ttlMs });
        return id;
    }

    get(id) {
        this._sweep();
        const t = this.tickets.get(String(id || '').trim());
        return t || null;
    }

    consume(id) {
        this.tickets.delete(String(id || '').trim());
    }

    /** 以新的歧义结果替换旧票据（文件变化后重签） */
    reissue(oldId, data) {
        this.consume(oldId);
        return this.issue(data);
    }

    clear() {
        this.tickets.clear();
    }
}

/**
 * 解析 pick 参数：
 * - 单步歧义："2" / "1,3" / "all"
 * - 多步歧义："2:1,5:3" 或 "2:1;5:all"（步骤:候选）
 * @returns {Map<number, string>} step -> pick 字符串
 */
function parsePickSpec(pick, ambiguousSteps) {
    const raw = String(pick ?? '').trim();
    if (!raw) throw new Error('缺少 pick。');
    const result = new Map();
    if (!raw.includes(':')) {
        if (ambiguousSteps.length !== 1) {
            throw new Error(`有 ${ambiguousSteps.length} 个步骤存在歧义（步骤 ${ambiguousSteps.join('、')}），请用“步骤:候选”格式，例如 pick=${ambiguousSteps.map(s => `${s}:1`).join(';')}`);
        }
        result.set(ambiguousSteps[0], raw);
        return result;
    }
    // 形如 "2:1,3;5:2" 或 "2:1,5:3"（后者逗号后紧跟 "数字:" 视为新步骤）
    const parts = raw.split(/;|,(?=\s*\d+\s*:)/).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
        const m = part.match(/^(\d+)\s*:\s*(.+)$/);
        if (!m) throw new Error(`pick 片段“${part}”无效，应为 步骤:候选`);
        const step = Number(m[1]);
        if (!ambiguousSteps.includes(step)) throw new Error(`步骤 ${step} 没有歧义，可选步骤：${ambiguousSteps.join('、')}`);
        result.set(step, m[2].trim());
    }
    const missing = ambiguousSteps.filter(s => !result.has(s));
    if (missing.length) throw new Error(`还需为步骤 ${missing.join('、')} 选择候选。`);
    return result;
}

module.exports = { TicketStore, parsePickSpec };