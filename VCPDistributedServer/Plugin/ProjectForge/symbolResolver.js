'use strict';
// 符号地址解析（纯函数，无 IO）。
//
// - 地址语法：symbol=Store.putBlob、path=src/store.js#Store.putBlob、Rust 写法 Store::put_blob（:: 与 . 等价）。
// - 输入是 indexer.outline() 针对"本次读到的文本"给出的符号表：区间与内容严格对应，不依赖任何持久索引。
// - 打分与索引器 findSymbols 一致：限定名全等 > 名称全等 > 限定名后缀 > 前缀 > 包含 > 限定名包含。
//   只有 ≥ 限定名后缀（含大小写不敏感的全等）才算命中；同分多处时绝不猜测，返回候选。
// - 行号 1 起算，基于去 BOM、LF 归一化后的文本（与 engine / decodeText 口径一致）。

const SCORE = {
    QUALIFIED_EXACT: 1000,
    QUALIFIED_EXACT_CI: 990,
    NAME_EXACT: 900,
    NAME_EXACT_CI: 890,
    QUALIFIED_SUFFIX: 800,
    QUALIFIED_SUFFIX_CI: 790,
    PREFIX: 500,
    CONTAINS: 300,
    QUALIFIED_CONTAINS: 200,
};
const RESOLVE_MIN = SCORE.QUALIFIED_SUFFIX_CI;
const MAX_CANDIDATES = 8;
const SUGGESTIONS = 5;
const CONTAINER_KINDS = new Set(['function', 'method', 'class', 'object', 'interface', 'namespace', 'struct', 'trait', 'impl', 'module', 'enum', 'union']);

/** 规范化符号地址：去空白、:: → .、去掉尾部 ()。 */
function normalizeRef(raw) {
    return String(raw ?? '')
        .trim()
        .replace(/^symbol:/i, '')
        .replace(/\s*::\s*/g, '.')
        .replace(/\s*\.\s*/g, '.')
        .replace(/\(\s*\)$/, '')
        .replace(/^\.+|\.+$/g, '');
}

const SYMBOL_REF_RE = /^[\p{L}\p{N}_$.:<>\s()]+$/u;

/**
 * `src/a.js#Foo.bar` → { path, symbol }；无 # 或 # 后不像符号名时 symbol 为 null
 * （避免误拆文件名本身带 # 的路径）。
 */
function splitPathSymbol(input) {
    const raw = String(input ?? '').trim();
    const i = raw.lastIndexOf('#');
    if (i <= 0 || i === raw.length - 1) return { path: raw, symbol: null };
    const symbol = raw.slice(i + 1).trim();
    if (!SYMBOL_REF_RE.test(symbol) || !/[\p{L}_$]/u.test(symbol)) return { path: raw, symbol: null };
    return { path: raw.slice(0, i).trim(), symbol };
}

function qualifiedOf(sym) {
    return normalizeRef(sym.qualified || sym.name || '');
}

function scoreSymbol(sym, query) {
    const q = normalizeRef(query);
    if (!q) return 0;
    const qual = qualifiedOf(sym);
    const name = String(sym.name || '');
    if (qual === q) return SCORE.QUALIFIED_EXACT;
    if (name === q) return SCORE.NAME_EXACT;
    if (qual.endsWith(`.${q}`)) return SCORE.QUALIFIED_SUFFIX;
    const lq = q.toLowerCase();
    const lqual = qual.toLowerCase();
    const lname = name.toLowerCase();
    if (lqual === lq) return SCORE.QUALIFIED_EXACT_CI;
    if (lname === lq) return SCORE.NAME_EXACT_CI;
    if (lqual.endsWith(`.${lq}`)) return SCORE.QUALIFIED_SUFFIX_CI;
    if (lname.startsWith(lq)) return SCORE.PREFIX;
    if (lname.includes(lq)) return SCORE.CONTAINS;
    if (lqual.includes(lq)) return SCORE.QUALIFIED_CONTAINS;
    return 0;
}

function bigrams(s) {
    const str = String(s).toLowerCase();
    const out = new Map();
    for (let i = 0; i < str.length - 1; i++) {
        const g = str.slice(i, i + 2);
        out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
}

function similarity(a, b) {
    const A = bigrams(a);
    const B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    let total = 0;
    for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n; }
    for (const n of B.values()) total += n;
    return (2 * inter) / total;
}

/** 同文件最相似的若干限定名（未命中时提示）。 */
function suggestSymbols(symbols, query, limit = SUGGESTIONS) {
    const q = normalizeRef(query);
    return symbols
        .map((sym, index) => ({ sym, index, score: Math.max(scoreSymbol(sym, q), similarity(qualifiedOf(sym), q) * 400, similarity(sym.name || '', q) * 400) }))
        .filter(item => item.score >= 120)
        .sort((a, b) => b.score - a.score || a.sym.start - b.sym.start)
        .slice(0, limit)
        .map(item => describeSymbol(symbols, item.index));
}

function describeSymbol(symbols, index) {
    const sym = symbols[index];
    const parent = Number.isInteger(sym.parent) ? symbols[sym.parent] : null;
    return {
        index,
        name: sym.name,
        qualified: sym.qualified || sym.name,
        kind: sym.kind,
        fullStart: sym.fullStart ?? sym.start,
        start: sym.start,
        end: sym.end,
        signature: sym.signature || '',
        parent: parent ? (parent.qualified || parent.name) : null,
    };
}

function parsePickNumber(pick, total) {
    if (pick === undefined || pick === null || pick === '') return null;
    const n = Number(String(pick).trim());
    if (!Number.isInteger(n) || n < 1 || n > total) {
        throw new Error(`pick “${pick}” 无效：符号候选只能单选，有效范围 1-${total}`);
    }
    return n;
}

/**
 * 在 outline 中解析符号地址。
 * @param {{symbols: Array}} outline indexer.outline() 结果
 * @param {string} ref 符号地址
 * @param {{pick?, line?}} options pick=候选序号（1 起），line=近似行号（优先取区间包含该行的候选）
 * @returns {{status:'ok', symbol, note}|{status:'ambiguous', query, total, tooMany, signature, candidates}|{status:'notFound', query, suggestions}}
 */
function resolveInOutline(outline, ref, options = {}) {
    const query = normalizeRef(ref);
    if (!query) throw new Error('符号地址为空');
    const symbols = Array.isArray(outline?.symbols) ? outline.symbols : [];
    let best = 0;
    let hits = [];
    symbols.forEach((sym, index) => {
        const score = scoreSymbol(sym, query);
        if (score < RESOLVE_MIN) return;
        if (score > best) { best = score; hits = [index]; } else if (score === best) hits.push(index);
    });
    if (!hits.length) return { status: 'notFound', query, suggestions: suggestSymbols(symbols, query) };

    const ciNote = best % 100 !== 0 ? `大小写不敏感匹配到 ${symbols[hits[0]].qualified || symbols[hits[0]].name}` : null;
    const described = hits.map(i => describeSymbol(symbols, i));
    if (described.length === 1) return { status: 'ok', symbol: described[0], note: ciNote };

    const pick = parsePickNumber(options.pick, described.length);
    if (pick) return { status: 'ok', symbol: described[pick - 1], note: `同名符号 ${described.length} 处，按 pick=${pick} 选择 L${described[pick - 1].start}` };
    if (options.line !== undefined && options.line !== null && options.line !== '') {
        const hint = Number(options.line);
        if (!Number.isInteger(hint)) throw new Error(`line 提示无效：“${options.line}”`);
        const containing = described.filter(s => hint >= s.fullStart && hint <= s.end).sort((a, b) => (a.end - a.fullStart) - (b.end - b.fullStart));
        const chosen = containing[0] || [...described].sort((a, b) => Math.abs(a.start - hint) - Math.abs(b.start - hint))[0];
        return { status: 'ok', symbol: chosen, note: `同名符号 ${described.length} 处，按 line=${hint} 选择 L${chosen.start}` };
    }
    return {
        status: 'ambiguous',
        query,
        total: described.length,
        tooMany: described.length > MAX_CANDIDATES,
        signature: described.map(s => s.start).join(','),
        candidates: described.slice(0, MAX_CANDIDATES).map((s, i) => ({ ...s, candidate: i + 1 })),
    };
}

/**
 * 符号对应的行区间。range=full（默认，含前置注释/装饰器）或 body（签名行起）；context=N 前后各扩 N 行。
 */
function symbolRange(symbol, { range = 'full', context = 0, lineCount = Infinity } = {}) {
    const mode = String(range || 'full').trim().toLowerCase();
    if (!['full', 'body'].includes(mode)) throw new Error(`range “${range}” 无效，可用 full（含前置注释，默认）或 body（从签名行起）`);
    const ctx = Math.max(0, Number(context) || 0);
    const from = mode === 'body' ? symbol.start : symbol.fullStart;
    return {
        startLine: Math.max(1, from - ctx),
        endLine: Math.min(lineCount, symbol.end + ctx),
        mode,
    };
}

/**
 * 包含 lineNo 的最内层符号链（按区间包含关系），格式与 engine.enclosingScope 一致："Store > putBlob"。
 * 只取容器类符号（函数/类/对象/…）；没有时返回 null，由调用方退回正则。
 */
function enclosingChain(symbols, lineNo, maxDepth = 3) {
    if (!Array.isArray(symbols) || !symbols.length) return null;
    const chain = symbols
        .filter(s => CONTAINER_KINDS.has(s.kind) && lineNo >= s.start && lineNo <= s.end)
        .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.start - b.start);
    if (!chain.length) return null;
    return chain.slice(-maxDepth).map(s => s.name).join(' > ');
}

// ---------------- 渲染 ----------------

function lineLabel(sym) {
    const full = sym.fullStart ?? sym.start;
    return `L${sym.start}-${sym.end}${full < sym.start ? `（注释自 L${full}）` : ''}`;
}

function oneLine(text, max = 140) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 符号树（按 depth 缩进）。depth=N 只显示前 N 层；kinds 非空时只显示这些 kind（扁平列出，保留限定名）。
 */
function renderOutline(outline, { depth, kinds } = {}) {
    const symbols = Array.isArray(outline?.symbols) ? outline.symbols : [];
    const kindSet = kinds && kinds.length ? new Set(kinds.map(k => String(k).toLowerCase())) : null;
    const maxDepth = Number.isInteger(depth) && depth > 0 ? depth : Infinity;
    const rows = [];
    for (const sym of symbols) {
        const d = sym.depth ?? 0;
        if (d >= maxDepth) continue;
        if (kindSet && !kindSet.has(String(sym.kind).toLowerCase())) continue;
        const indent = kindSet ? '' : '  '.repeat(d);
        const label = kindSet ? (sym.qualified || sym.name) : sym.name;
        rows.push(`${indent}- ${lineLabel(sym)} · ${sym.kind} · \`${label}\` — ${oneLine(sym.signature)}`);
    }
    return { text: rows.join('\n'), shown: rows.length, total: symbols.length };
}

function renderCandidateLines(candidates) {
    return candidates.map(c => `- 候选 ${c.candidate} · ${lineLabel(c)} · ${c.kind} · \`${c.qualified}\`${c.parent ? ` · in ${c.parent}` : ''} — ${oneLine(c.signature)}`).join('\n');
}

function renderSuggestions(suggestions) {
    if (!suggestions.length) return '- 同文件没有相近的符号。';
    return suggestions.map(s => `- \`${s.qualified}\` · ${s.kind} · ${lineLabel(s)}`).join('\n');
}

module.exports = {
    SCORE,
    RESOLVE_MIN,
    MAX_CANDIDATES,
    normalizeRef,
    splitPathSymbol,
    scoreSymbol,
    resolveInOutline,
    symbolRange,
    enclosingChain,
    suggestSymbols,
    renderOutline,
    renderCandidateLines,
    renderSuggestions,
    lineLabel,
    oneLine,
};