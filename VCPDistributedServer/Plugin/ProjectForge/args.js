'use strict';
// 参数解析：命令名、布尔/数字/JSON、reason 必填校验、串语法（编号参数）解析。
// 所有参数名大小写不敏感（VCP 工具调用中 AI 常混用大小写）。

const STEP_FIELDS = ['op', 'start', 'end', 'lines', 'after', 'before', 'content', 'target', 'replace', 'expect', 'line', 'pick', 'symbol', 'range', 'reason', 'todo'];

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
    if (step.symbol !== undefined) return 'symbol';
    if (step.target !== undefined) return 'target';
    if (step.after !== undefined || step.before !== undefined) return 'insert';
    return 'replace';
}

// target 步骤省略 replace 表示删除匹配段；AI 常把 replace 写成 replacement 之类，
// 这种情况按删除执行会直接丢代码，必须报错让它改名重发。
const REPLACE_TYPO_RE = /^(replacement|replace[_-]?(?:with|text|content|code)|new[_-]?(?:content|text|code|string))(\d*)$/;
const TARGET_TYPO_RE = /^(old[_-]?(?:code|string|text|content)|search|find|original)\d*$/i;

// 按行替换（start/end 或 lines）缺 content 时引擎会把这些行替换成空，也就是删掉；
// 文档里删行用 op=delete，这里多半是把 content 写成了 replace 之类，同样拒绝执行。
function rejectMissingLineContent(step, suffix = '') {
    if (step.op !== 'replace' || step.symbol !== undefined || step.content !== undefined) return;
    const hint = step.replace !== undefined ? `，replace${suffix} 只配合 target 使用` : '';
    throw new Error(`EditCode 按行替换需要 content${suffix}（新的代码）${hint}。省略 content${suffix} 会删掉这些行，所以这次没有执行；确实要删请用 op${suffix}=delete。`);
}

function rejectMisnamedReplace(step, source, suffix = '') {
    if (step.op !== 'target' || step.replace !== undefined) return;
    for (const key of Object.keys(source)) {
        const m = key.toLowerCase().match(REPLACE_TYPO_RE);
        if (m && m[2] === suffix) {
            throw new Error(`EditCode 不认识参数 ${key}，target 的新内容请写 replace${suffix}。省略 replace${suffix} 会删除 target 匹配到的整段，所以这次没有执行。`);
        }
    }
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
            rejectMisnamedReplace(step, raw);
            rejectMissingLineContent(step);
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
            rejectMisnamedReplace(step, args, String(n));
            rejectMissingLineContent(step, String(n));
            return step;
        });
    }

    const single = { step: 1 };
    for (const f of STEP_FIELDS) {
        if (f === 'reason' || f === 'todo') continue; // 平铺形式下 reason/todo 属于批次级
        if (args[f] !== undefined) single[f] = args[f];
    }
    if (single.op === undefined && single.target === undefined && single.start === undefined && single.symbol === undefined
        && single.lines === undefined && single.after === undefined && single.before === undefined) {
        // AI 常沿用别的编辑工具的写法（oldCode/newCode、old_string/new_string），点名告诉它该写什么
        const misnamed = Object.keys(args).filter(key => TARGET_TYPO_RE.test(key) || REPLACE_TYPO_RE.test(key.toLowerCase()));
        if (misnamed.some(key => TARGET_TYPO_RE.test(key))) {
            throw new Error(`EditCode 不认识参数 ${misnamed.join(' / ')}：按内容替换请写 target（原来的代码）和 replace（新的代码）。这次没有执行。`);
        }
        throw new Error('EditCode 缺少编辑内容。单步示例：start/end/content、target/replace 或 symbol/content；多步用 op1/start1/content1、op2/target2/replace2、symbol3/content3 …');
    }
    single.op = inferOp(single);
    rejectMisnamedReplace(single, args);
    rejectMissingLineContent(single);
    return [single];
}

module.exports = { lowerKeys, pick, str, bool, num, json, list, requireReason, parseEditSteps };