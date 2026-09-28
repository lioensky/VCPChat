'use strict';
// ProjectForge 行级编辑引擎（纯函数，无 IO）。
//
// 核心约定：
// 1. 串内所有行号以“调用前的原始快照”为坐标，不随前序步骤漂移。
// 2. 所有步骤先换算为原文上的字符区间 [start, end)，统一做重叠检测，
//    最后按升序一次性拼接生成新文本。
// 3. target 多处命中且未给 line / pick 时绝不猜测，返回候选供 AI 选择。
// 4. 行号前缀（`  12 | code`）自动剥除；expect 锚点允许在 ±drift 行内漂移重定位。

const { normalizeEol, stripLineNumberPrefixes, numberLines } = require('../../shared/fileKit/text');

const DEFAULT_DRIFT = 20;
const MAX_CANDIDATES = 8;
const CONTEXT_LINES = 2;

// ---------------- 行索引 ----------------

function buildIndex(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    const trailing = text.endsWith('\n');
    const lines = text === '' ? [] : (trailing ? text.slice(0, -1) : text).split('\n');
    return { text, starts, lines, count: lines.length, trailing };
}

/** 第 i 行（1 起算）起始偏移 */
function startOf(idx, i) {
    return idx.starts[i - 1] ?? idx.text.length;
}

/** 第 i 行结束偏移（含换行符） */
function endOf(idx, i) {
    return i < idx.starts.length ? idx.starts[i] : idx.text.length;
}

function lineOfOffset(idx, offset) {
    let lo = 0;
    let hi = idx.starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (idx.starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
}

// ---------------- 辅助 ----------------

function cleanText(value, notes, label) {
    if (value === undefined || value === null) return value;
    const { text, stripped } = stripLineNumberPrefixes(normalizeEol(value));
    if (stripped) notes.push(`${label}：已自动剥除行号前缀`);
    return text;
}

function bodyOf(content) {
    return content.endsWith('\n') ? content.slice(0, -1) : content;
}

function bigrams(s) {
    const str = s.trim().toLowerCase();
    const out = new Map();
    for (let i = 0; i < str.length - 1; i++) {
        const g = str.slice(i, i + 2);
        out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
}

function similarity(a, b) {
    if (a.trim() === b.trim()) return 1;
    const A = bigrams(a);
    const B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    let total = 0;
    for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n; }
    for (const n of B.values()) total += n;
    return (2 * inter) / total;
}

/** 与 probe 最相似的若干行，用于“找不到”时给出可执行建议。 */
function similarLines(idx, probe, limit = 3) {
    if (!probe || !probe.trim()) return [];
    return idx.lines
        .map((line, i) => ({ line: i + 1, text: line, score: similarity(line, probe) }))
        .filter(item => item.score >= 0.4)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(item => ({ line: item.line, text: item.text.trim().slice(0, 160), score: Math.round(item.score * 100) }));
}

const SCOPE_PATTERNS = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/,
    /^\s*(?:(?:public|private|protected|static|async|get|set|override)\s+)*([\w$]+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
    /^\s*([\w$]+)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/,
    /^\s*(?:async\s+)?def\s+(\w+)/,
    /^\s*class\s+(\w+)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/,
    /^\s*(?:impl|struct|enum|trait)\s+(?:<[^>]*>\s*)?(\w+)/,
    /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/,
];
const NOT_SCOPE = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'else']);

function indentOf(line) {
    return line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
}

function matchScope(line) {
    for (const re of SCOPE_PATTERNS) {
        const m = line.match(re);
        if (m && m[1] && !NOT_SCOPE.has(m[1])) return m[1];
    }
    return null;
}

/** 轻量识别所在定义：向上寻找缩进更浅的函数/类定义，返回如 "Store > putBlob"。 */
function enclosingScope(idx, lineNo) {
    const chain = [];
    let limitIndent = Infinity;
    const selfName = matchScope(idx.lines[lineNo - 1] || '');
    if (selfName) {
        chain.unshift(selfName);
        limitIndent = indentOf(idx.lines[lineNo - 1]);
    } else {
        const cur = idx.lines[lineNo - 1] || '';
        limitIndent = cur.trim() ? indentOf(cur) : Infinity;
    }
    for (let i = lineNo - 1; i >= 1 && chain.length < 3; i--) {
        const line = idx.lines[i - 1];
        if (!line.trim()) continue;
        const ind = indentOf(line);
        if (ind >= limitIndent) continue;
        const name = matchScope(line);
        if (name) {
            chain.unshift(name);
            limitIndent = ind;
            if (ind === 0) break;
        }
    }
    return chain.join(' > ') || null;
}

function contextBlock(idx, startLine, endLine) {
    const from = Math.max(1, startLine - CONTEXT_LINES);
    const to = Math.min(idx.count, endLine + CONTEXT_LINES);
    const mark = new Set();
    for (let i = startLine; i <= endLine; i++) mark.add(i);
    return numberLines(idx.lines.slice(from - 1, to), from, mark);
}

// ---------------- 步骤解析 ----------------

function parseLineSpec(step) {
    let start = step.start;
    let end = step.end;
    if ((start === undefined || start === null || start === '') && step.lines) {
        const m = String(step.lines).trim().match(/^(\d+)(?:\s*[-:]\s*(\d+))?$/);
        if (!m) throw new Error(`lines 格式无效：“${step.lines}”，应为 M-N 或 N`);
        start = m[1];
        end = m[2] ?? m[1];
    }
    start = Number(start);
    end = end === undefined || end === null || end === '' ? start : Number(end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error('缺少有效的 start/end（或 lines）行号');
    if (start > end) throw new Error(`起始行 ${start} 大于结束行 ${end}`);
    return { start, end };
}

function checkRange(idx, start, end) {
    if (start < 1 || end > idx.count) {
        throw new Error(`行号 ${start}-${end} 超出范围（文件共 ${idx.count} 行）`);
    }
}

/**
 * expect 锚点：expect 的各行（去首尾空白）须与 start 起的若干行一致；
 * 不一致时在 ±drift 行内就近搜索。返回位移 delta 或抛出带建议的错误。
 */
function resolveAnchor(idx, start, expect, drift) {
    const exp = bodyOf(expect).split('\n').map(s => s.trim());
    while (exp.length && exp[exp.length - 1] === '') exp.pop();
    if (!exp.length) return 0;
    const matchAt = s => s >= 1 && s + exp.length - 1 <= idx.count
        && exp.every((line, k) => idx.lines[s - 1 + k].trim() === line);
    if (matchAt(start)) return 0;
    for (let d = 1; d <= drift; d++) {
        if (matchAt(start + d)) return d;
        if (matchAt(start - d)) return -d;
    }
    const hints = similarLines(idx, exp[0]);
    const err = new Error(`expect 锚点在 L${start}±${drift} 内未找到：“${exp[0].slice(0, 80)}”`);
    err.hints = hints;
    throw err;
}

/** 在原文中查找 target 的全部命中，返回 [{start, end, startLine, endLine, fuzzy}] */
function findTarget(idx, target) {
    const text = idx.text;
    const hits = [];
    if (target) {
        let i = text.indexOf(target);
        while (i !== -1) {
            hits.push({ start: i, end: i + target.length, fuzzy: false });
            i = text.indexOf(target, i + Math.max(target.length, 1));
        }
    }
    if (!hits.length && (target.includes('\n') || target.trim() !== target)) {
        // 容错：忽略每行首尾空白（缩进差异、行尾空格），仅整行匹配。
        const tl = bodyOf(target).split('\n').map(s => s.trim());
        while (tl.length && tl[0] === '') tl.shift();
        while (tl.length && tl[tl.length - 1] === '') tl.pop();
        if (tl.length && tl.some(Boolean)) {
            for (let s = 1; s + tl.length - 1 <= idx.count; s++) {
                if (tl.every((line, k) => idx.lines[s - 1 + k].trim() === line)) {
                    const e = s + tl.length - 1;
                    const endOffset = startOf(idx, e) + idx.lines[e - 1].length;
                    hits.push({ start: startOf(idx, s), end: endOffset, fuzzy: true, indent: idx.lines[s - 1].match(/^\s*/)[0] });
                }
            }
        }
    }
    return hits.map(h => ({
        ...h,
        startLine: lineOfOffset(idx, h.start),
        endLine: lineOfOffset(idx, Math.max(h.start, h.end - 1)),
    }));
}

/** 模糊命中时，把 replace 的缩进从 target 的缩进平移到实际缩进。 */
function reindent(replace, fromIndent, toIndent) {
    if (fromIndent === toIndent) return replace;
    return replace.split('\n').map(line => {
        if (!line.trim()) return line;
        return line.startsWith(fromIndent) ? toIndent + line.slice(fromIndent.length) : line;
    }).join('\n');
}

function parsePick(pick, total) {
    if (pick === undefined || pick === null || pick === '') return null;
    const raw = String(pick).trim().toLowerCase();
    if (raw === 'all' || raw === '*') return Array.from({ length: total }, (_, i) => i + 1);
    const picks = raw.split(/[,\s]+/).filter(Boolean).map(Number);
    if (!picks.length || picks.some(n => !Number.isInteger(n) || n < 1 || n > total)) {
        throw new Error(`pick “${pick}” 无效，有效候选为 1-${total} 或 all`);
    }
    return [...new Set(picks)].sort((a, b) => a - b);
}

function describeCandidates(idx, hits) {
    return hits.slice(0, MAX_CANDIDATES).map((h, i) => ({
        index: i + 1,
        startLine: h.startLine,
        endLine: h.endLine,
        scope: enclosingScope(idx, h.startLine),
        context: contextBlock(idx, h.startLine, h.endLine),
    }));
}

/**
 * 将单个步骤换算为原文区间编辑。
 * 返回 { edits:[...], note? } 或 { ambiguity:{...} }；错误以异常抛出。
 */
function planStep(idx, step, notes, drift) {
    const op = String(step.op || '').toLowerCase();
    const label = `步骤${step.step}`;

    if (op === 'replace' || op === 'delete') {
        let { start, end } = parseLineSpec(step);
        checkRange(idx, start, end);
        let note = null;
        if (step.expect) {
            const delta = resolveAnchor(idx, start, cleanText(step.expect, notes, `${label} expect`), drift);
            if (delta) {
                note = `行号已从 L${start} 漂移校正到 L${start + delta}`;
                start += delta;
                end += delta;
                checkRange(idx, start, end);
            }
        }
        const content = op === 'delete' ? '' : cleanText(step.content ?? '', notes, `${label} content`);
        const rangeEnd = endOf(idx, end);
        const hasNewline = rangeEnd > 0 && idx.text[rangeEnd - 1] === '\n';
        const replacement = content === '' ? '' : bodyOf(content) + (hasNewline ? '\n' : '');
        return {
            edits: [{ start: startOf(idx, start), end: rangeEnd, replacement, origStartLine: start, origEndLine: end }],
            note,
        };
    }

    if (op === 'insert') {
        let after = Number(step.after ?? step.line ?? step.start);
        if (!Number.isInteger(after) || after < 0 || after > idx.count) {
            throw new Error(`insert 需要 after=0..${idx.count}（0 表示文件开头），收到“${step.after ?? step.line ?? ''}”`);
        }
        let note = null;
        if (step.expect && after > 0) {
            const delta = resolveAnchor(idx, after, cleanText(step.expect, notes, `${label} expect`), drift);
            if (delta) {
                note = `插入位置已从 L${after} 之后漂移校正到 L${after + delta} 之后`;
                after += delta;
            }
        }
        const body = bodyOf(cleanText(step.content ?? '', notes, `${label} content`));
        const offset = after === 0 ? 0 : endOf(idx, after);
        const atEofNoNewline = after === idx.count && idx.count > 0 && !idx.trailing;
        const replacement = atEofNoNewline ? `\n${body}` : `${body}\n`;
        return { edits: [{ start: offset, end: offset, replacement, origStartLine: after, origEndLine: after, insert: true }], note };
    }

    if (op === 'target') {
        const target = cleanText(step.target ?? '', notes, `${label} target`);
        if (!target) throw new Error('target 不能为空');
        const replace = cleanText(step.replace ?? '', notes, `${label} replace`);
        const hits = findTarget(idx, target);
        if (!hits.length) {
            const err = new Error(`target 未找到：“${bodyOf(target).split('\n')[0].trim().slice(0, 80)}”`);
            err.hints = similarLines(idx, bodyOf(target).split('\n').find(l => l.trim()) || target);
            throw err;
        }
        let chosen;
        let note = hits[0].fuzzy ? '已按忽略行首尾空白的方式匹配' : null;
        const picks = parsePick(step.pick, hits.length);
        if (picks) {
            chosen = picks.map(n => hits[n - 1]);
        } else if (hits.length === 1) {
            chosen = hits;
        } else if (step.line !== undefined && step.line !== null && step.line !== '') {
            const hint = Number(step.line);
            if (!Number.isInteger(hint)) throw new Error(`line 提示无效：“${step.line}”`);
            const best = [...hits].sort((a, b) => Math.abs(a.startLine - hint) - Math.abs(b.startLine - hint))[0];
            chosen = [best];
            note = `命中 ${hits.length} 处，按 line=${hint} 选择 L${best.startLine}`;
        } else {
            return {
                ambiguity: {
                    step: step.step,
                    total: hits.length,
                    tooMany: hits.length > MAX_CANDIDATES,
                    signature: hits.map(h => h.startLine).join(','),
                    candidates: describeCandidates(idx, hits),
                },
            };
        }
        const targetIndent = (bodyOf(target).split('\n').find(l => l.trim()) || '').match(/^\s*/)[0];
        if (chosen.some(h => h.fuzzy && h.indent !== targetIndent)) {
            note = `${note ? `${note}；` : ''}已按实际缩进对齐 replace`;
        }
        return {
            edits: chosen.map(h => ({
                start: h.start,
                end: h.end,
                replacement: h.fuzzy ? reindent(bodyOf(replace), targetIndent, h.indent) : replace,
                origStartLine: h.startLine,
                origEndLine: h.endLine,
            })),
            note,
        };
    }

    throw new Error(`未知 op“${step.op}”，可用：replace、insert、delete、target`);
}

// ---------------- 应用 ----------------

function applyEdits(original, edits) {
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
    let out = '';
    let cursor = 0;
    const placements = [];
    for (const edit of sorted) {
        out += original.slice(cursor, edit.start);
        const newStart = (out.match(/\n/g) || []).length + 1;
        const body = bodyOf(edit.replacement.startsWith('\n') ? edit.replacement.slice(1) : edit.replacement);
        const lineCount = edit.replacement === '' ? 0 : body.split('\n').length;
        const offsetLines = edit.replacement.startsWith('\n') ? 1 : 0;
        placements.push({
            step: edit.step,
            newStartLine: newStart + offsetLines,
            newEndLine: newStart + offsetLines + lineCount - 1,
            removedAll: lineCount === 0,
        });
        out += edit.replacement;
        cursor = edit.end;
    }
    out += original.slice(cursor);
    return { text: out, placements };
}

/**
 * 执行一串编辑。
 * @param {string} original 原文（任意换行，内部归一化为 LF）
 * @param {Array} steps 规范化步骤 [{ step, op, start, end, lines, after, content, target, replace, expect, line, pick }]
 * @param {{ mode?: 'atomic'|'bestEffort', drift?: number }} options
 * @returns {{ status: 'ok'|'error'|'ambiguous', text?, applied?, errors, ambiguities?, notes }}
 */
function runEditString(original, steps, options = {}) {
    const mode = options.mode === 'bestEffort' ? 'bestEffort' : 'atomic';
    const drift = Number.isInteger(options.drift) ? options.drift : DEFAULT_DRIFT;
    const text = normalizeEol(original);
    const idx = buildIndex(text);
    const notes = [];
    const errors = [];
    const ambiguities = [];
    const planned = [];

    steps.forEach((step, order) => {
        try {
            const result = planStep(idx, step, notes, drift);
            if (result.ambiguity) { ambiguities.push(result.ambiguity); return; }
            planned.push({ step, order, note: result.note, edits: result.edits.map(e => ({ ...e, step: step.step, order })) });
        } catch (error) {
            errors.push({ step: step.step, op: step.op, message: error.message, hints: error.hints || [] });
        }
    });

    // 重叠检测：所有区间都基于原始快照
    const flat = planned.flatMap(p => p.edits).sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
    const dropped = new Set();
    let maxEnd = -1;
    let maxEdit = null;
    for (const edit of flat) {
        if (dropped.has(edit.step)) continue;
        if (maxEdit && maxEnd > edit.start && maxEdit.step !== edit.step) {
            const later = edit.order > maxEdit.order ? edit : maxEdit;
            const earlier = later === edit ? maxEdit : edit;
            errors.push({
                step: later.step,
                op: steps[later.order].op,
                message: `与步骤${earlier.step}的区间重叠（原始 L${earlier.origStartLine}-${earlier.origEndLine} 与 L${later.origStartLine}-${later.origEndLine}）。串内行号均以原始快照为准，请合并为一步或调整范围。`,
                hints: [],
            });
            dropped.add(later.step);
            if (later === maxEdit) { maxEnd = edit.end; maxEdit = edit; }
            continue;
        }
        if (edit.end > maxEnd) { maxEnd = edit.end; maxEdit = edit; }
    }

    if (ambiguities.length) {
        return { status: 'ambiguous', ambiguities, errors, notes };
    }
    if (errors.length && mode === 'atomic') {
        return { status: 'error', errors, notes };
    }

    const kept = planned.filter(p => !dropped.has(p.step.step));
    if (!kept.length) {
        return { status: 'error', errors, notes };
    }

    const { text: newText, placements } = applyEdits(text, kept.flatMap(p => p.edits));
    const applied = kept.map(p => {
        const place = placements.filter(pl => pl.step === p.step.step);
        return {
            step: p.step.step,
            op: p.step.op,
            origRanges: p.edits.map(e => e.insert ? `L${e.origStartLine}之后` : `L${e.origStartLine}-${e.origEndLine}`),
            newRanges: place.map(pl => pl.removedAll ? '(已删除)' : `L${pl.newStartLine}-${pl.newEndLine}`),
            note: p.note,
        };
    });
    return { status: 'ok', text: newText, applied, errors, notes, changed: newText !== text };
}

module.exports = {
    runEditString,
    enclosingScope,
    buildIndex,
    findTarget,
    contextBlock,
    MAX_CANDIDATES,
    _test: { findTarget, applyEdits, parsePick, similarity, resolveAnchor, reindent },
};