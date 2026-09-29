'use strict';
// ProjectForge 行级编辑引擎（纯函数，无 IO）。
//
// 核心约定：
// 1. 串内所有行号以“调用前的原始快照”为坐标，不随前序步骤漂移。
// 2. 所有步骤先换算为原文上的字符区间 [start, end)，统一做重叠检测，
//    最后按升序一次性拼接生成新文本。
// 3. target 多处命中且未给 line / pick 时绝不猜测，返回候选供 AI 选择。
// 4. 行号前缀（`  12 | code`）自动剥除；expect 锚点允许在 ±drift 行内漂移重定位。
// 5. target 首尾锚定：字面找不到、且 target 中恰有一行省略标记（`...` / `…` / `⋮`）时，
//    按“首行块 … 尾行块”匹配整行区间。首尾块可带 `N | ` 行号（按行号 ±drift 定位），
//    不带行号则按内容配对，尾行优先选与首行缩进一致的那一处（避免配到内层的 `}`）。
// 6. resolveBlock / insertPoint / shiftIndent / autoIndent 供 MoveCode / CopyCode 复用。

const { normalizeEol, stripLineNumberPrefixes } = require('../../shared/fileKit/text');

const DEFAULT_DRIFT = 20;
const MAX_CANDIDATES = 8;
const CONTEXT_LINES = 2;
const FOLD_LINES = 12;
const FOLD_KEEP = 3;
const MAX_ELIDED_HEADS = 100;

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

function joinNotes(...items) {
    const list = items.filter(Boolean);
    return list.length ? list.join('；') : null;
}

function hasValue(v) {
    return v !== undefined && v !== null && v !== '';
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

const AST_CONTAINER_KINDS = new Set(['function', 'method', 'class', 'object', 'interface', 'namespace', 'struct', 'trait', 'impl', 'module', 'enum', 'union']);

/** AST 符号表（outline.symbols）中包含 lineNo 的最内层容器链；没有则返回 null。 */
function astScope(symbols, lineNo) {
    if (!Array.isArray(symbols) || !symbols.length) return null;
    const chain = symbols
        .filter(s => AST_CONTAINER_KINDS.has(s.kind) && lineNo >= s.start && lineNo <= s.end)
        .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.start - b.start);
    return chain.length ? chain.slice(-3).map(s => s.name).join(' > ') : null;
}

/**
 * 识别所在定义，返回如 "Store > putBlob"。
 * 传入 symbols（与 idx 同一份文本的 outline.symbols）时按 AST 区间包含关系取最内层符号链；
 * 否则（或 AST 未覆盖该行）向上寻找缩进更浅的函数/类定义（正则启发式）。
 */
function enclosingScope(idx, lineNo, symbols = null) {
    const fromAst = astScope(symbols, lineNo);
    if (fromAst) return fromAst;
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

/** 命中区间及前后若干行的带行号上下文；区间过长时折叠中段。 */
function contextBlock(idx, startLine, endLine) {
    const from = Math.max(1, startLine - CONTEXT_LINES);
    const to = Math.min(idx.count, endLine + CONTEXT_LINES);
    const width = String(to).length;
    const fold = endLine - startLine + 1 > FOLD_LINES;
    const out = [];
    for (let i = from; i <= to; i++) {
        if (fold && i === startLine + FOLD_KEEP) {
            out.push(`${' '.repeat(width + 1)} ⋮ （省略 ${endLine - startLine + 1 - FOLD_KEEP * 2} 行）`);
            i = endLine - FOLD_KEEP;
            continue;
        }
        const mark = i >= startLine && i <= endLine ? '>' : ' ';
        out.push(`${mark}${String(i).padStart(width, ' ')} | ${idx.lines[i - 1]}`);
    }
    return out.join('\n');
}

// ---------------- 步骤解析 ----------------

function parseLineSpec(step) {
    let start = step.start;
    let end = step.end;
    if (!hasValue(start) && step.lines) {
        const m = String(step.lines).trim().match(/^(\d+)(?:\s*[-:]\s*(\d+))?$/);
        if (!m) throw new Error(`lines 格式无效：“${step.lines}”，应为 M-N 或 N`);
        start = m[1];
        end = m[2] ?? m[1];
    }
    start = Number(start);
    end = hasValue(end) ? Number(end) : start;
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

/**
 * 插入点：after=N（0 或 start 为文件开头，end 为文件末尾）或 before=N（end 等价于末尾）。
 * 返回 { after, anchor, kind }；anchor 为 expect 应对齐的行（无则为 null）。
 */
function insertPoint(idx, step) {
    const norm = v => (hasValue(v) ? String(v).trim().toLowerCase() : undefined);
    const END = ['end', 'eof', '$'];
    const before = norm(step.before);
    if (before !== undefined) {
        const n = END.includes(before) ? idx.count + 1 : Number(before);
        if (!Number.isInteger(n) || n < 1 || n > idx.count + 1) {
            throw new Error(`before 需要 1..${idx.count + 1}（或 end），收到“${step.before}”`);
        }
        return { after: n - 1, anchor: n <= idx.count ? n : null, kind: 'before' };
    }
    const raw = norm(step.after ?? step.line ?? step.start);
    let n;
    if (raw !== undefined && END.includes(raw)) n = idx.count;
    else if (raw !== undefined && ['start', 'begin', 'bof', '^'].includes(raw)) n = 0;
    else n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > idx.count) {
        throw new Error(`insert 需要 after=0..${idx.count}（0 表示文件开头，end 表示末尾）或 before=1..${idx.count + 1}，收到“${step.after ?? step.line ?? step.start ?? ''}”`);
    }
    return { after: n, anchor: n > 0 ? n : null, kind: 'after' };
}

function pointLabel(kind, after) {
    return kind === 'before' ? `L${after + 1}之前` : `L${after}之后`;
}

// ---------------- target 匹配 ----------------

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

// 省略标记行：...、…、⋮，可带注释符（// # -- /* <!--），可带 ReadCode 折叠提示（“（省略 N 行）”）。
const ELLIPSIS_RE = /^\s*(?:(?:\/\/|#|--|\/\*|<!--)\s*)?(?:\.{3,}|…+|⋮)\s*(?:[（(][^）)]*[）)])?\s*(?:\*\/|-->)?\s*$/;
const SIDE_PREFIX_RE = /^[ >]?\s*(\d+)\s\|\s?(.*)$/;

function parseSide(rawLines) {
    const arr = [...rawLines];
    while (arr.length && !arr[0].trim()) arr.shift();
    while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
    if (!arr.length) return null;
    let lineNo = null;
    const lines = arr.map((line, i) => {
        const m = line.match(SIDE_PREFIX_RE);
        if (!m) return line;
        if (lineNo === null) lineNo = Number(m[1]) - i;
        return m[2];
    });
    const first = lines.find(l => l.trim());
    if (first === undefined) return null;
    return { lines, lineNo: lineNo !== null && lineNo >= 1 ? lineNo : null, indent: first.match(/^\s*/)[0] };
}

/** 解析首尾锚定语法；不符合（无省略行、多个省略行、首或尾为空）时返回 null。 */
function parseElision(target) {
    const lines = bodyOf(normalizeEol(target)).split('\n');
    const marks = [];
    lines.forEach((line, i) => { if (ELLIPSIS_RE.test(line)) marks.push(i); });
    if (marks.length !== 1) return null;
    const head = parseSide(lines.slice(0, marks[0]));
    const tail = parseSide(lines.slice(marks[0] + 1));
    return head && tail ? { head, tail } : null;
}

function blockAt(idx, s, lines) {
    return s >= 1 && s + lines.length - 1 <= idx.count
        && lines.every((line, k) => idx.lines[s - 1 + k].trim() === line.trim());
}

function nearestBlock(idx, lineNo, lines, drift) {
    for (let d = 0; d <= drift; d++) {
        if (blockAt(idx, lineNo + d, lines)) return lineNo + d;
        if (d && blockAt(idx, lineNo - d, lines)) return lineNo - d;
    }
    return null;
}

function sideError(idx, side, what, drift) {
    const probe = side.lines.find(l => l.trim()).trim();
    const where = side.lineNo ? `在 L${side.lineNo}±${drift} 内` : '';
    const err = new Error(`首尾锚定：${what}${where}未找到：“${probe.slice(0, 80)}”`);
    err.hints = similarLines(idx, probe);
    return err;
}

/** 首尾锚定匹配，返回整行命中（wholeLines）。找不到时抛出带建议的错误。 */
function findElided(idx, spec, drift = DEFAULT_DRIFT) {
    const { head, tail } = spec;
    let heads;
    if (head.lineNo) {
        const s = nearestBlock(idx, head.lineNo, head.lines, drift);
        if (s === null) throw sideError(idx, head, '首行', drift);
        heads = [s];
    } else {
        heads = [];
        for (let s = 1; s + head.lines.length - 1 <= idx.count && heads.length < MAX_ELIDED_HEADS; s++) {
            if (blockAt(idx, s, head.lines)) heads.push(s);
        }
        if (!heads.length) throw sideError(idx, head, '首行', drift);
    }
    let fixedTail = null;
    if (tail.lineNo) {
        fixedTail = nearestBlock(idx, tail.lineNo, tail.lines, drift);
        if (fixedTail === null) throw sideError(idx, tail, '尾行', drift);
    }
    const hits = [];
    for (const s of heads) {
        const minT = s + head.lines.length;
        let t = null;
        if (fixedTail !== null) {
            if (fixedTail >= minT) t = fixedTail;
        } else {
            const baseIndent = indentOf(idx.lines[s - 1]);
            let first = null;
            for (let x = minT; x + tail.lines.length - 1 <= idx.count; x++) {
                if (!blockAt(idx, x, tail.lines)) continue;
                if (first === null) first = x;
                if (indentOf(idx.lines[x - 1]) === baseIndent) { t = x; break; }
            }
            if (t === null) t = first;
        }
        if (t === null) continue;
        const e = t + tail.lines.length - 1;
        hits.push({
            start: startOf(idx, s), end: endOf(idx, e), startLine: s, endLine: e,
            fuzzy: true, wholeLines: true, elided: true, indent: idx.lines[s - 1].match(/^\s*/)[0],
        });
    }
    if (!hits.length) {
        if (fixedTail !== null) {
            throw new Error(`首尾锚定：尾行 L${fixedTail} 不在首行 L${heads[0]} 之后`);
        }
        throw sideError(idx, tail, `尾行（须位于首行 L${heads[0]} 之后）`, drift);
    }
    return hits;
}

/** 先按字面（含忽略空白）查找；找不到且符合首尾锚定语法时再按首尾匹配。 */
function locateTarget(idx, target, drift = DEFAULT_DRIFT) {
    const hits = findTarget(idx, target);
    if (hits.length) return { hits, elided: null };
    const spec = parseElision(target);
    if (!spec) return { hits: [], elided: null };
    return { hits: findElided(idx, spec, drift), elided: spec };
}

function targetNotFound(idx, target) {
    const err = new Error(`target 未找到：“${bodyOf(target).split('\n')[0].trim().slice(0, 80)}”`);
    err.hints = similarLines(idx, bodyOf(target).split('\n').find(l => l.trim()) || target);
    return err;
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
    if (!hasValue(pick)) return null;
    const raw = String(pick).trim().toLowerCase();
    if (raw === 'all' || raw === '*') return Array.from({ length: total }, (_, i) => i + 1);
    const picks = raw.split(/[,\s]+/).filter(Boolean).map(Number);
    if (!picks.length || picks.some(n => !Number.isInteger(n) || n < 1 || n > total)) {
        throw new Error(`pick “${pick}” 无效，有效候选为 1-${total} 或 all`);
    }
    return [...new Set(picks)].sort((a, b) => a - b);
}

function describeCandidates(idx, hits, symbols = null) {
    return hits.slice(0, MAX_CANDIDATES).map((h, i) => ({
        index: i + 1,
        startLine: h.startLine,
        endLine: h.endLine,
        scope: enclosingScope(idx, h.startLine, symbols),
        context: contextBlock(idx, h.startLine, h.endLine),
    }));
}

/** 多处命中时按 pick / line 选择；都没有则返回 ambiguity。 */
function chooseHits(idx, hits, step, symbols = null) {
    const picks = parsePick(step.pick, hits.length);
    if (picks) return { chosen: picks.map(n => hits[n - 1]), note: null };
    if (hits.length === 1) return { chosen: hits, note: null };
    if (hasValue(step.line)) {
        const hint = Number(step.line);
        if (!Number.isInteger(hint)) throw new Error(`line 提示无效：“${step.line}”`);
        const best = [...hits].sort((a, b) => Math.abs(a.startLine - hint) - Math.abs(b.startLine - hint))[0];
        return { chosen: [best], note: `命中 ${hits.length} 处，按 line=${hint} 选择 L${best.startLine}` };
    }
    return {
        ambiguity: {
            step: step.step,
            total: hits.length,
            tooMany: hits.length > MAX_CANDIDATES,
            signature: hits.map(h => h.startLine).join(','),
            candidates: describeCandidates(idx, hits, symbols),
        },
    };
}

// ---------------- 缩进 ----------------

/** 各非空行共同的前导空白。 */
function commonIndent(lines) {
    let common = null;
    for (const line of lines) {
        if (!line.trim()) continue;
        const ws = line.match(/^[ \t]*/)[0];
        if (common === null) { common = ws; continue; }
        let k = 0;
        while (k < common.length && k < ws.length && common[k] === ws[k]) k++;
        common = common.slice(0, k);
    }
    return common ?? '';
}

/**
 * 调整代码块缩进。spec：auto（对齐到 refIndent）、keep、N（绝对 N 个空格）、+N / -N（相对调整，
 * 块以 Tab 缩进时单位为 Tab）。返回 { text, from, to }，text 以换行结尾。
 */
function shiftIndent(block, spec, refIndent = null) {
    const body = bodyOf(normalizeEol(block));
    const lines = body.split('\n');
    const from = commonIndent(lines);
    const raw = String(spec ?? '').trim().toLowerCase();
    let to;
    if (!raw || raw === 'keep') {
        to = from;
    } else if (raw === 'auto') {
        to = refIndent ?? from;
    } else {
        const m = raw.match(/^([+-])?(\d+)$/);
        if (!m) throw new Error(`indent “${spec}” 无效，可用 auto、keep、N（绝对空格数）、+N / -N（相对调整）`);
        const n = Number(m[2]);
        const unit = from.startsWith('\t') ? '\t' : ' ';
        if (!m[1]) to = ' '.repeat(n);
        else if (m[1] === '+') to = from + unit.repeat(n);
        else to = from.slice(0, Math.max(0, from.length - n));
    }
    if (to === from) return { text: `${body}\n`, from, to };
    const text = lines.map(line => (line.trim() ? to + line.slice(from.length) : '')).join('\n');
    return { text: `${text}\n`, from, to };
}

const CLOSER_RE = /^\s*(?:[}\])]|<\/|end\b|fi\b|done\b|esac\b)/;
const OPENER_RE = /[{([:]\s*$/;

/**
 * 推断插入到 after 行之后的代码应有的缩进：优先取下一非空行；下一行是闭合符时取上一非空行，
 * 若上一行是开启符（空块）则再加一级。skip=[s,e] 为需忽略的行（同文件移动时的源块）。
 */
function autoIndent(idx, after, skip = null) {
    const skipped = i => skip && i >= skip[0] && i <= skip[1];
    const ws = i => idx.lines[i - 1].match(/^[ \t]*/)[0];
    let next = null;
    for (let i = after + 1; i <= idx.count; i++) if (!skipped(i) && idx.lines[i - 1].trim()) { next = i; break; }
    let prev = null;
    for (let i = after; i >= 1; i--) if (!skipped(i) && idx.lines[i - 1].trim()) { prev = i; break; }
    if (next && !CLOSER_RE.test(idx.lines[next - 1])) return ws(next);
    if (prev && next && OPENER_RE.test(idx.lines[prev - 1])) {
        const base = ws(prev);
        return base + (base.startsWith('\t') ? '\t' : '    ');
    }
    if (prev) return ws(prev);
    return next ? ws(next) : '';
}

// ---------------- 步骤规划 ----------------

/**
 * 将单个步骤换算为原文区间编辑。
 * 返回 { edits:[...], note? } 或 { ambiguity:{...} }；错误以异常抛出。
 * step.raw=true 时 content 不做行号前缀剥除（插件内部搬运原文时使用）。
 */
function planStep(idx, step, notes, drift, symbols = null) {
    const op = String(step.op || '').toLowerCase();
    const label = `步骤${step.step}`;
    const clean = (value, what) => (step.raw ? normalizeEol(value ?? '') : cleanText(value ?? '', notes, `${label} ${what}`));

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
        const content = op === 'delete' ? '' : clean(step.content, 'content');
        const rangeEnd = endOf(idx, end);
        const hasNewline = rangeEnd > 0 && idx.text[rangeEnd - 1] === '\n';
        const replacement = content === '' ? '' : bodyOf(content) + (hasNewline ? '\n' : '');
        return {
            edits: [{ start: startOf(idx, start), end: rangeEnd, replacement, origStartLine: start, origEndLine: end }],
            note,
        };
    }

    if (op === 'insert') {
        const point = insertPoint(idx, step);
        let after = point.after;
        let note = null;
        if (step.expect && point.anchor) {
            const delta = resolveAnchor(idx, point.anchor, cleanText(step.expect, notes, `${label} expect`), drift);
            if (delta) {
                note = `插入位置已从 ${pointLabel(point.kind, after)} 漂移校正到 ${pointLabel(point.kind, after + delta)}`;
                after += delta;
            }
        }
        const body = bodyOf(clean(step.content, 'content'));
        const offset = after === 0 ? 0 : endOf(idx, after);
        const atEofNoNewline = after === idx.count && idx.count > 0 && !idx.trailing;
        const replacement = atEofNoNewline ? `\n${body}` : `${body}\n`;
        return { edits: [{ start: offset, end: offset, replacement, origStartLine: after, origEndLine: after, insert: true }], note };
    }

    if (op === 'target') {
        const target = cleanText(step.target ?? '', notes, `${label} target`);
        if (!target) throw new Error('target 不能为空');
        const replace = cleanText(step.replace ?? '', notes, `${label} replace`);
        const { hits, elided } = locateTarget(idx, target, drift);
        if (!hits.length) throw targetNotFound(idx, target);
        const choice = chooseHits(idx, hits, step, symbols);
        if (choice.ambiguity) return { ambiguity: choice.ambiguity };
        const chosen = choice.chosen;
        let note;
        if (elided) {
            note = joinNotes(`首尾锚定命中 ${chosen.map(h => `L${h.startLine}-${h.endLine}`).join('、')}`, choice.note);
        } else {
            note = choice.note || (hits[0].fuzzy ? '已按忽略行首尾空白的方式匹配' : null);
        }
        const targetIndent = elided
            ? elided.head.indent
            : (bodyOf(target).split('\n').find(l => l.trim()) || '').match(/^\s*/)[0];
        if (chosen.some(h => h.fuzzy && h.indent !== targetIndent)) {
            note = joinNotes(note, '已按实际缩进对齐 replace');
        }
        return {
            edits: chosen.map(h => {
                let replacement;
                if (h.wholeLines) {
                    const hasNewline = h.end > 0 && idx.text[h.end - 1] === '\n';
                    replacement = replace === '' ? '' : reindent(bodyOf(replace), targetIndent, h.indent) + (hasNewline ? '\n' : '');
                } else {
                    replacement = h.fuzzy ? reindent(bodyOf(replace), targetIndent, h.indent) : replace;
                }
                return { start: h.start, end: h.end, replacement, origStartLine: h.startLine, origEndLine: h.endLine };
            }),
            note,
        };
    }

    throw new Error(`未知 op“${step.op}”，可用：replace、insert、delete、target`);
}

// ---------------- 代码块定位（MoveCode / CopyCode） ----------------

/**
 * 定位一段整行代码块。spec：lines / start+end（可带 expect），或 target（支持首尾锚定，可带 line / pick）。
 * 返回 { status:'ok', startLine, endLine, text, lineCount, scope, notes, note }
 *   或 { status:'ambiguous', ambiguity, notes }；错误以异常抛出（可能带 hints）。
 */
function resolveBlock(original, spec = {}, options = {}) {
    const drift = Number.isInteger(options.drift) ? options.drift : DEFAULT_DRIFT;
    const symbols = options.symbols || null;
    const idx = buildIndex(normalizeEol(original));
    const notes = [];
    let startLine;
    let endLine;
    let note = null;
    if (hasValue(spec.target)) {
        const target = cleanText(spec.target, notes, '源 target');
        const { hits, elided } = locateTarget(idx, target, drift);
        if (!hits.length) throw targetNotFound(idx, target);
        const choice = chooseHits(idx, hits, { ...spec, step: 1 }, symbols);
        if (choice.ambiguity) return { status: 'ambiguous', ambiguity: choice.ambiguity, notes };
        if (choice.chosen.length !== 1) throw new Error('源代码块只能选择一处（pick 只给一个序号）');
        const hit = choice.chosen[0];
        startLine = hit.startLine;
        endLine = hit.endLine;
        note = joinNotes(elided ? `首尾锚定命中 L${startLine}-${endLine}` : null, choice.note);
        if (!elided && !hit.wholeLines) {
            const whole = hit.start === startOf(idx, startLine)
                && hit.end >= startOf(idx, endLine) + idx.lines[endLine - 1].length;
            if (!whole) note = joinNotes(note, `target 为行内片段，已扩展为整行 L${startLine}-${endLine}`);
        }
    } else {
        ({ start: startLine, end: endLine } = parseLineSpec(spec));
        checkRange(idx, startLine, endLine);
        if (hasValue(spec.expect)) {
            const delta = resolveAnchor(idx, startLine, cleanText(spec.expect, notes, 'expect'), drift);
            if (delta) {
                note = `行号已从 L${startLine} 漂移校正到 L${startLine + delta}`;
                startLine += delta;
                endLine += delta;
                checkRange(idx, startLine, endLine);
            }
        }
    }
    const lines = idx.lines.slice(startLine - 1, endLine);
    return {
        status: 'ok', startLine, endLine, text: `${lines.join('\n')}\n`, lineCount: lines.length,
        scope: enclosingScope(idx, startLine, symbols), notes, note,
    };
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
 * @param {Array} steps 规范化步骤 [{ step, op, start, end, lines, after, before, content, target, replace, expect, line, pick, raw }]
 * @param {{ mode?: 'atomic'|'bestEffort', drift?: number, symbols?: Array }} options
 *   symbols：与 original 同一份文本的 outline.symbols，仅用于歧义候选的 scope 显示
 * @returns {{ status: 'ok'|'error'|'ambiguous', text?, applied?, errors, ambiguities?, notes }}
 */
function runEditString(original, steps, options = {}) {
    const mode = options.mode === 'bestEffort' ? 'bestEffort' : 'atomic';
    const drift = Number.isInteger(options.drift) ? options.drift : DEFAULT_DRIFT;
    const symbols = options.symbols || null;
    const text = normalizeEol(original);
    const idx = buildIndex(text);
    const notes = [];
    const errors = [];
    const ambiguities = [];
    const planned = [];

    steps.forEach((step, order) => {
        try {
            const result = planStep(idx, step, notes, drift, symbols);
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
    locateTarget,
    contextBlock,
    resolveBlock,
    insertPoint,
    shiftIndent,
    autoIndent,
    MAX_CANDIDATES,
    _test: { findTarget, applyEdits, parsePick, similarity, resolveAnchor, reindent, parseElision, findElided, commonIndent, astScope },
};