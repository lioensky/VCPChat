'use strict';
// 参数解析：命令名、布尔/数字/JSON、reason 必填校验、串语法（编号参数）解析。
// 所有参数名大小写不敏感（VCP 工具调用中 AI 常混用大小写）。

const STEP_FIELDS = ['op', 'start', 'end', 'lines', 'after', 'content', 'target', 'replace', 'expect', 'line', 'pick', 'reason', 'todo'];

/** 返回键名全部小写的浅拷贝，便于大小写不敏感取值。 */
function lowerKeys(args) {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
        const key = k.toLowerCase();
        if (!(key in out)) out[key] = v;
    }
    return out;
}

function pick(args, ...names) {
    for (const name of names) {
        const v = args[name.toLowerCase()];
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
}

function str(args, ...names) {
    const v = pick(args, ...names);
    return v === undefined ? '' : String(v).trim();
}

function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', '是'].includes(s)) return true;
    if (['false', '0', 'no', 'n', '否'].includes(s)) return false;
    throw new Error(`布尔参数必须为 true 或 false：${value}`);
}

function num(value, name) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字：${value}`);
    return n;
}

function json(value, name, fallback = undefined) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch (error) {
        throw new Error(`${name} 不是有效 JSON：${error.message}`);
    }
}

/** 列表参数：JSON 数组、换行分隔或逗号分隔均可。 */
function list(value) {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    const s = String(value).trim();
    if (s.startsWith('[')) {
        const parsed = json(s, 'list');
        if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
    }
    return s.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean);
}

/** reason 必填：缺失时给出可直接照抄的修正提示。 */
function requireReason(args, command) {
    const reason = str(args, 'reason');
    if (!reason) {
        throw new Error(`${command} 需要 reason（本次变动的原因，一句话即可），用于记录开发脉络。请补充参数：\nreason:「始」说明为什么要做这个改动「末」`);
    }
    return reason.slice(0, 500);
}

function inferOp(step) {
    if (step.op) return String(step.op).trim().toLowerCase();
    if (step.target !== undefined) return 'target';
    if (step.after !== undefined) return 'insert';
    return 'replace';
}

/**
 * 解析编辑串。
 * - 编号形式：op1/start1/end1/content1、op2/target2/replace2 …（按编号升序；只要出现任一编号字段即视为串）
 * - 平铺形式：op/start/end/content 或 target/replace（单步）
 * - edits：JSON 数组形式
 * @returns {Array<object>} 规范化步骤，step 字段为 1 起的序号
 */
function parseEditSteps(args) {
    const direct = pick(args, 'edits');
    if (direct !== undefined) {
        const arr = json(direct, 'edits');
        if (!Array.isArray(arr) || !arr.length) throw new Error('edits 必须是非空 JSON 数组。');
        return arr.map((raw, i) => {
            const s = lowerKeys(raw);
            const step = { step: i + 1 };
            for (const f of STEP_FIELDS) if (s[f] !== undefined) step[f] = s[f];
            step.op = inferOp(step);
            return step;
        });
    }

    const numbered = new Map();
    const re = new RegExp(`^(${STEP_FIELDS.join('|')})(\\d+)$`);
    for (const [key, value] of Object.entries(args)) {
        const m = key.match(re);
        if (!m) continue;
        const n = Number(m[2]);
        if (!numbered.has(n)) numbered.set(n, {});
        numbered.get(n)[m[1]] = value;
    }
    if (numbered.size) {
        return [...numbered.keys()].sort((a, b) => a - b).map(n => {
            const step = { step: n, ...numbered.get(n) };
            step.op = inferOp(step);
            return step;
        });
    }

    const single = { step: 1 };
    for (const f of STEP_FIELDS) {
        if (f === 'reason' || f === 'todo') continue; // 平铺形式下 reason/todo 属于批次级
        if (args[f] !== undefined) single[f] = args[f];
    }
    if (single.op === undefined && single.target === undefined && single.start === undefined
        && single.lines === undefined && single.after === undefined) {
        throw new Error('EditCode 缺少编辑内容。单步示例：start/end/content 或 target/replace；多步用 op1/start1/content1、op2/target2/replace2 …');
    }
    single.op = inferOp(single);
    return [single];
}

module.exports = { lowerKeys, pick, str, bool, num, json, list, requireReason, parseEditSteps };