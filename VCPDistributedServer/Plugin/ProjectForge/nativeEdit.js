'use strict';
// 旧 EditCode / ResolveEdit 参数 → Rust edit.execute / edit.resolve 的纯协议适配。
// 本文件不读写文件、不持数据库、不执行编辑；只做一次参数归一化和 Markdown 回执渲染。
//
// 插入点、symbol、all/line 候选选择均由 Rust 在同一快照上解析。
// 本层只转换旧字段和显示结果，不接管文件内容或候选定位。

const A = require('./args');
const SR = require('./symbolResolver');
const { stripLineNumberPrefixes } = require('../../shared/fileKit/text');

const END = new Set(['end', 'eof', '$']);
const START = new Set(['start', 'begin', 'bof', '^']);
const SYMBOL_POS_RE = /^\s*symbol\s*:\s*(.+?)\s*$/i;

function requiredText(value, name) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error(`native EditCode 缺少 ${name}。`);
    return text;
}

function operationIdOf(value) {
    const id = requiredText(value, 'operationId');
    if (id.length > 128) throw new Error('native EditCode 的 operationId 超过 128 字符。');
    return id;
}

function textValue(value) {
    return value === undefined || value === null ? '' : String(value);
}

/** 候选证据层级的展示名：原生层回传 kind，这里只翻译，不重排优先级。 */
const TIER_LABEL = {
    exact: '逐字节',
    elision: '省略号',
    token: '词法',
    structure: '结构',
    symbol: '符号',
};
const tierLabel = kind => TIER_LABEL[kind] || kind;

/** expectedHash 与旧别名 sourceHash 同义；两个都没给才表示「未预检」。 */
function expectedHashOf(lower) {
    const value = A.pick(lower, 'expectedHash', 'sourceHash');
    if (value === undefined || String(value).trim() === '') return undefined;
    const hash = String(value).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
        throw new Error(`native EditCode 的 expectedHash/sourceHash 必须是 64 位小写 sha256，收到“${value}”。`);
    }
    return hash;
}

function symbolPosOf(value) {
    const m = SYMBOL_POS_RE.exec(textValue(value));
    return m ? m[1] : null;
}

function positiveInteger(value, what) {
    const n = Number(String(value ?? '').trim());
    if (!Number.isInteger(n) || n < 1) throw new Error(`${what} 必须是正整数：${value}`);
    return n;
}

/** 旧 lines=5 / 5-7 / 5:7 与 start/end 统一成原生行区间。 */
function lineRange(step) {
    let start = step.start;
    let end = step.end;
    if ((start === undefined || start === null || start === '') && step.lines !== undefined) {
        const m = String(step.lines).trim().match(/^(\d+)(?:\s*[-:]\s*(\d+))?$/);
        if (!m) throw new Error(`步骤${step.step} lines 格式无效：“${step.lines}”，应为 M-N 或 N`);
        start = m[1];
        end = m[2] ?? m[1];
    }
    if (start === undefined || start === null || start === '') {
        throw new Error(`步骤${step.step} 缺少有效的 start/end（或 lines）行号`);
    }
    start = positiveInteger(start, `步骤${step.step} start`);
    end = end === undefined || end === null || end === '' ? start : positiveInteger(end, `步骤${step.step} end`);
    if (start > end) throw new Error(`步骤${step.step} 起始行 ${start} 大于结束行 ${end}`);
    return { start, end };
}

function insertPoint(step) {
    const side = step.before !== undefined ? 'before' : 'after';
    const value = step.before ?? step.after ?? step.line ?? step.start;
    if (value === undefined) throw new Error(`步骤${step.step} insert 缺少 after/before 插入点`);
    const symbol = symbolPosOf(value);
    const raw = String(value).trim().toLowerCase();
    let point;
    if (symbol) point = `symbol:${symbol}`;
    else if (END.has(raw)) point = 'end';
    else if (START.has(raw)) point = side === 'before' ? 1 : 0;
    else {
        point = Number(value);
        if (!Number.isInteger(point) || point < (side === 'before' ? 1 : 0)) {
            throw new Error(`步骤${step.step} ${side} 需要有效行号、end 或 symbol:名称`);
        }
    }
    return { [side]: point };
}

/** 旧 symbol pick 是单选；原生 Symbol.pick 是 Option<usize>。 */
function singlePick(value, step) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(String(value).trim());
    if (!Number.isInteger(n) || n < 1) {
        throw new Error(`步骤${step} 的 pick 无效：符号候选只能单选，收到“${value}”`);
    }
    return n;
}

function targetPick(value, step) {
    if (value === undefined || value === null || value === '') return { pick: [] };
    const raw = String(value).trim().toLowerCase();
    if (raw === 'all' || raw === '*') return { pick: [], all: true };
    const values = Array.isArray(value) ? value : raw.split(/[,\s]+/).filter(Boolean);
    return { pick: [...new Set(values.map(v => positiveInteger(v, `步骤${step} target pick`)))] };
}

/** 旧 range=full/body → 原生 Symbol.body。 */
function symbolBody(step) {
    const mode = String(step.range || 'full').trim().toLowerCase();
    if (mode === 'body') return true;
    if (mode === 'full') return false;
    throw new Error(`步骤${step.step} range “${step.range}” 无效，可用 full 或 body`);
}

function commonStepFields(step, drift) {
    const out = { step: step.step };
    if (step.reason !== undefined && textValue(step.reason) !== '') out.reason = textValue(step.reason);
    if (drift !== undefined) out.drift = drift;
    if (step.expect !== undefined && textValue(step.expect) !== '' && step.op !== 'target') out.expect = textValue(step.expect);
    return out;
}

/** 单个旧步骤→Rust Step；不做 IO，不猜测未回传的行数或候选。 */
function nativeStep(step, drift) {
    const op = String(step.op || '').trim().toLowerCase();
    const base = commonStepFields(step, drift);
    const hasSymbol = step.symbol !== undefined && textValue(step.symbol).trim() !== '';

    if (op === 'target') {
        if (hasSymbol) throw new Error(`步骤${step.step} op=target 不能与 symbol 同时使用；请改用 op=symbol 或去掉 symbol。`);
        const target = textValue(step.target);
        if (!target) throw new Error(`步骤${step.step} target 不能为空。`);
        const hasContent = step.content !== undefined;
        const hasReplace = step.replace !== undefined;
        if (hasContent && hasReplace && textValue(step.content) !== textValue(step.replace)) {
            throw new Error(`步骤${step.step} target 同时给了 content 与 replace 且内容不同；新内容主字段只用 content（replace 为兼容别名），这次没有构建请求。`);
        }
        return {
            ...base,
            op: 'target',
            target,
            replace: hasContent ? textValue(step.content) : hasReplace ? textValue(step.replace) : '',
            ...targetPick(step.pick, step.step),
            ...(step.line !== undefined ? { line: positiveInteger(step.line, `步骤${step.step} line`) } : {}),
        };
    }

    if (op === 'symbol' || (hasSymbol && (op === 'replace' || op === 'delete'))) {
        if (!hasSymbol) throw new Error(`步骤${step.step} op=symbol 需要 symbol（符号名或限定名）。`);
        if (op !== 'delete' && step.content === undefined) {
            throw new Error(`步骤${step.step} 按符号替换需要 content（新的完整代码块）；删除请用 op=delete。`);
        }
        const next = {
            ...base,
            op: 'symbol',
            symbol: textValue(step.symbol).trim(),
            content: op === 'delete' ? '' : textValue(step.content),
            body: symbolBody(step),
        };
        const pick = singlePick(step.pick, step.step);
        if (pick !== undefined) next.pick = pick;
        if (step.line !== undefined && step.line !== null && step.line !== '') {
            next.line = positiveInteger(step.line, `步骤${step.step} line`);
        }
        return next;
    }

    if (op === 'insert') {
        const point = insertPoint(hasSymbol && step.after === undefined && step.before === undefined
            ? { ...step, after: `symbol:${step.symbol}` } : step);
        const pick = singlePick(step.pick, step.step);
        return {
            ...base, ...point, op: 'insert', content: textValue(step.content),
            ...(pick !== undefined ? { pick } : {}),
            ...(step.line !== undefined && (symbolPosOf(step.before) || symbolPosOf(step.after) || hasSymbol)
                ? { line: positiveInteger(step.line, `步骤${step.step} line`) } : {}),
        };
    }

    if (op === 'replace' || op === 'delete') {
        const { start, end } = lineRange(step);
        if (op === 'delete') return { ...base, op: 'delete', start, end };
        return { ...base, op: 'replace', start, end, content: textValue(step.content) };
    }

    throw new Error(`步骤${step.step} 不支持的 op “${step.op}”；原生支持 replace/delete/symbol/insert/target。`);
}

/**
 * 旧 EditCode 工具参数 → 原生 edit.execute 请求。
 * @param {{projectId:string,filePath:string,reason:string,maid?:string,todo?:*,operationId:string}} context
 * @param {object} args 旧 EditCode 原始参数（大小写不敏感）
 * @returns {{method:'edit.execute', params:object}}
 */
function buildEditRequest(context, args) {
    const ctx = context || {};
    const operationId = operationIdOf(ctx.operationId);
    const projectId = requiredText(ctx.projectId, 'projectId');
    const reason = requiredText(ctx.reason, 'reason');
    const lower = A.lowerKeys(args || {});

    // 与旧 ProjectForgeService 一致：仅平铺单步时才把 file#symbol 注入 symbol；
    // 编号串保持原样，避免未编号 symbol 被 parseEditSteps 当成步骤 1。
    const split = SR.splitPathSymbol(requiredText(ctx.filePath, 'filePath'));
    const filePath = requiredText(split.path, 'filePath');
    const stepArgs = split.symbol && A.pick(lower, 'symbol') === undefined && !A.hasNumberedSteps(lower)
        ? { ...lower, symbol: split.symbol }
        : lower;

    const steps = A.parseEditSteps(stepArgs);
    const driftValue = A.num(A.pick(lower, 'drift'), 'drift');
    const drift = Number.isInteger(driftValue) ? driftValue : undefined;
    if (drift !== undefined && drift < 0) throw new Error(`native EditCode 的 drift 必须是非负整数：${drift}`);
    const mode = A.str(lower, 'mode').toLowerCase();
    const expectedHash = expectedHashOf(lower);
    const params = {
        operationId,
        projectId,
        filePath,
        reason,
        steps: steps.map(step => nativeStep(step, drift)),
        bestEffort: mode === 'besteffort',
        rejectNewSyntax: A.bool(A.pick(lower, 'revertOnSyntaxError'), false),
    };
    // expectedHash 仅保留为可选内部透传字段；外层 EditCode 不要求调用方提供。
    if (expectedHash !== undefined) params.expectedHash = expectedHash;
    if (ctx.maid !== undefined && ctx.maid !== null && String(ctx.maid).trim() !== '') {
        params.maid = String(ctx.maid).trim();
    }
    if (ctx.todo !== undefined && ctx.todo !== null) params.todo = ctx.todo;
    return { method: 'edit.execute', params };
}

function buildResolveRequest(args, operationId) {
    const lower = A.lowerKeys(args || {});
    const ticketId = requiredText(A.str(lower, 'ticketId', 'ticket'), 'ticketId');
    const pick = requiredText(A.str(lower, 'pick'), 'pick');
    const params = {
        operationId: operationIdOf(operationId),
        ticketId,
        pick,
    };
    const maid = A.str(lower, 'maid');
    if (maid) params.maid = maid;
    return {
        method: 'edit.resolve',
        params,
    };
}

function renderIssue(issue) {
    const op = issue.op ? `（${issue.op}）` : '';
    return `- 步骤${issue.step}${op}：${issue.message}`;
}

function renderPlacement(placement, steps = []) {
    const original = placement.insertion
        ? `L${placement.originalStartLine} 后`
        : `L${placement.originalStartLine}-${placement.originalEndLine}`;
    const next = placement.newStartLine === undefined || placement.newStartLine === null
        ? '（已删除）'
        : `L${placement.newStartLine}${placement.newEndLine === placement.newStartLine ? '' : `-${placement.newEndLine}`}`;
    const step = steps.find(item => item.step === placement.step);
    const requested = step?.start ?? (Number.isInteger(step?.before) ? step.before - 1 : step?.after);
    const drift = Number.isInteger(requested) && requested !== placement.originalStartLine
        ? ` · 漂移校正（请求 L${requested} → 原快照 L${placement.originalStartLine}）` : '';
    return `- 步骤${placement.step} · ${placement.op} · 原 ${original} [${placement.originalStartByte},${placement.originalEndByte}) → ${next} [${placement.newStartByte},${placement.newEndByte})${drift}`;
}

function renderReview(review) {
    if (!review) return '';
    const version = review.validatorVersion ?? review.validator_version ?? '未回传';
    const lines = ['### 代码审查'];
    lines.push(`- 校验器：${version}${review.supported === false ? ' · 当前语言未支持' : ''}`);
    const introduced = Array.isArray(review.introduced) ? review.introduced : [];
    if (review.supported === false) {
        lines.push('- 新增问题：未执行语言校验');
    } else {
        lines.push(`- 新增问题：${introduced.length}${Number.isInteger(review.existing) ? ` · 原有 ${review.existing}` : ''}`);
        for (const d of introduced) {
            const icon = d.severity === 'error' || d.fatal ? '❌' : '⚠️';
            const rule = d.ruleId ? ` \`${d.ruleId}\`` : '';
            lines.push(`  - ${icon} L${d.line || '?'}:${d.column || '?'}${rule} ${d.message}`);
        }
    }
    return lines.join('\n');
}

function renderAmbiguities(ambiguities, ticketId, steps = []) {
    const lines = ['### 多处命中'];
    if (ticketId) {
        lines.push(`- 票据：\`${ticketId}\`（30 分钟内有效，实际 TTL 以原生票据实现为准）`);
        const example = ambiguities.length === 1
            ? 'pick=1（单选）或 pick=1,3（多选）'
            : `pick=${ambiguities.map(a => `${a.step}:1`).join(';')}（步骤:候选）`;
        lines.push(`- 下一步：调用 ResolveEdit，只需 ticketId=${ticketId} 与 ${example}，无需重发内容。`);
    } else {
        lines.push('- 票据：当前 Rust 结果未回传 ticketId；父入口需接通原生票据签发/ResolveEdit RPC 后才能让 AI 只回传选择。');
    }
    for (const ambiguity of ambiguities) {
        const step = steps.find(item => item.step === ambiguity.step);
        if (step?.symbol) lines.push(`- 符号 \`${step.symbol}\` 有 ${ambiguity.total} 处同名定义`);
        const tier = ambiguity.kind ? ` · ${tierLabel(ambiguity.kind)}命中` : '';
        lines.push(`#### 步骤 ${ambiguity.step} · 共 ${ambiguity.total} 处候选${tier}`);
        for (const candidate of ambiguity.candidates || []) {
            const index = candidate.index ?? candidate.candidate;
            const kind = candidate.kind ? ` · ${tierLabel(candidate.kind)}` : '';
            const scope = candidate.scope ? ` · ${candidate.scope}` : '';
            lines.push(`- 候选 ${index} · L${candidate.startLine}-${candidate.endLine}${kind}${scope}`);
        }
    }
    return lines.join('\n');
}

function resultHeader(statusText, filePath, operationId, projectId, reason, maid) {
    return [
        `## ${statusText} · \`${filePath || '（未回传路径）'}\``,
        `- operationId：${operationId ? `\`${operationId}\`` : '（未回传）'}`,
        `- 工程：${projectId ? `\`${projectId}\`` : '（未回传）'}`,
        `- reason：${reason || '（未回传）'}`,
        maid ? `- 署名：@${maid}` : '',
    ].filter(Boolean).join('\n');
}

function renderCommitted(result, context) {
    const filePath = result.filePath || context.filePath || '';
    const lines = [
        resultHeader('✅ 已写入', filePath, result.operationId || context.operationId, context.projectId, context.reason, context.maid),
        `- 节点 \`n${result.nodeId}\` · 批次 \`b${result.batchId}\``,
        `- 已应用步骤：${(result.applied || []).join('、') || '（未回传）'}`,
    ];
    if (result.sourceHash) lines.push(`- sourceHash：\`${result.sourceHash}\`（本次规划基于该原始快照）`);
    const placements = result.placements || [];
    if ((context.steps || []).some(step => ['target', 'content', 'replace', 'expect'].some(key =>
        typeof step[key] === 'string' && stripLineNumberPrefixes(step[key]).stripped))) {
        lines.push('- 原生输入规范化：已剥除行号前缀（原快照未清洗）。');
    }
    lines.push(placements.length ? `- placements（原快照 → 新快照）：\n${placements.map(p => renderPlacement(p, context.steps)).join('\n')}` : '- placements：（无）');
    const skipped = result.skipped || [];
    if (skipped.length) lines.push(`### 跳过的步骤（bestEffort）\n${skipped.map(renderIssue).join('\n')}`);
    if (context.diff?.text) lines.push(`### Diff (+${context.diff.added} -${context.diff.removed})\n\`\`\`diff\n${context.diff.text}\n\`\`\``);
    const review = renderReview(result.review);
    if (review) lines.push(review);
    return lines.filter(Boolean).join('\n');
}

function renderUnchanged(result, context) {
    const lines = [
        resultHeader('ℹ️ 内容无变化，未写入', result.filePath || context.filePath, result.operationId || context.operationId, context.projectId, context.reason, context.maid),
        `- 已应用步骤：${(result.applied || []).join('、') || '（无）'}`,
        result.sourceHash ? `- sourceHash：\`${result.sourceHash}\`` : '',
        result.afterHash ? `- afterHash：\`${result.afterHash}\`` : '',
    ].filter(Boolean);
    const placements = result.placements || [];
    if (placements.length) lines.push(`- placements（原快照 → 新快照）：\n${placements.map(p => renderPlacement(p, context.steps)).join('\n')}`);
    const skipped = result.skipped || [];
    if (skipped.length) lines.push(`### 跳过的步骤（bestEffort）\n${skipped.map(renderIssue).join('\n')}`);
    const review = renderReview(result.review);
    if (review) lines.push(review);
    return lines.join('\n');
}

function renderPlanningRejected(result, context) {
    const outcome = result.outcome || result;
    const ambiguities = outcome.ambiguities || [];
    const errors = outcome.errors || [];
    const ticketId = outcome.ticketId || result.ticketId || null;
    const lines = [
        resultHeader('❌ 未写入', result.filePath || context.filePath, result.operationId || result.outcome?.operationId || context.operationId, context.projectId, context.reason, context.maid),
    ];
    const sourceHash = outcome.sourceHash || result.sourceHash || null;
    if (sourceHash) lines.push(`- sourceHash：\`${sourceHash}\`（本次规划基于该原始快照，票据/服务内部绑定用于漂移校验）`);
    if (errors.length) lines.push(`### 错误\n${errors.map(error => {
        const step = context.steps?.find(item => item.step === error.step);
        return renderIssue(step?.symbol && error.message === 'symbol not found in snapshot outline'
            ? { ...error, message: `未找到符号 \`${step.symbol}\`（原生快照 outline 无此定义）` } : error);
    }).join('\n')}`);
    if (ambiguities.length) lines.push(renderAmbiguities(ambiguities, ticketId, context.steps));
    if (!errors.length && !ambiguities.length) lines.push('- 原生规划未产生可执行步骤。');
    if (outcome.status === 'error') {
        lines.push('- 未被接受的步骤不会写入：atomic 模式整串不写，bestEffort 模式仅跳过失败步骤；修正后可重发。');
    }
    return lines.filter(Boolean).join('\n');
}

function renderSyntaxRejected(result, context) {
    const review = renderReview(result.review);
    return [
        resultHeader('❌ 编辑会引入语法错误，已拒绝写入', result.filePath || context.filePath, result.operationId || context.operationId, context.projectId, context.reason, context.maid),
        review || '- 代码审查：（未回传）',
    ].filter(Boolean).join('\n');
}

/**
 * 原生编辑结果 → 旧工具兼容 Markdown 回执。
 * 不伪造 diff：只展示原生回传的 applied / placements / skipped / review / 歧义候选。
 * @returns {{status:'success', result:string, details:object}}
 */
function renderEditResult(result, context = {}) {
    if (!result || typeof result !== 'object') throw new Error('renderEditResult 需要原生编辑结果对象。');
    const command = context.command || 'EditCode';
    const projectId = context.projectId || result.projectId || null;
    const filePath = result.filePath || context.filePath || '';
    const reason = context.reason || '';
    const maid = context.maid ? String(context.maid) : null;
    const baseDetails = { command, projectId, filePath, reason, maid };

    if (result.status === 'ok' || result.state === 'committed') {
        const details = {
            ...baseDetails,
            status: 'ok',
            operationId: result.operationId || context.operationId || null,
            nodeId: result.nodeId ?? null,
            batchId: result.batchId ?? null,
            afterHash: result.afterHash || null,
            sourceHash: result.sourceHash || null,
            applied: result.applied || [],
            placements: result.placements || [],
            skipped: result.skipped || [],
            review: result.review || null,
        };
        return { status: 'success', result: renderCommitted(result, { ...context, projectId, filePath, reason, maid }), details };
    }

    if (result.status === 'unchanged') {
        const details = {
            ...baseDetails,
            status: 'unchanged',
            operationId: result.operationId || context.operationId || null,
            afterHash: result.afterHash || null,
            sourceHash: result.sourceHash || null,
            applied: result.applied || [],
            placements: result.placements || [],
            skipped: result.skipped || [],
            review: result.review || null,
        };
        return { status: 'success', result: renderUnchanged(result, { ...context, projectId, filePath, reason, maid }), details };
    }

    if (result.state === 'planningRejected' || result.status === 'ambiguous' || result.status === 'error') {
        const outcome = result.outcome || result;
        const ticketId = outcome.ticketId || result.ticketId || null;
        const details = {
            ...baseDetails,
            status: outcome.status || result.status || 'error',
            operationId: result.operationId || outcome.operationId || context.operationId || null,
            ticketId,
            sourceHash: outcome.sourceHash || result.sourceHash || null,
            errors: outcome.errors || [],
            ambiguities: outcome.ambiguities || [],
        };
        return { status: 'success', result: renderPlanningRejected(result, { ...context, projectId, filePath, reason, maid }), details };
    }

    if (result.state === 'syntaxRejected') {
        const details = {
            ...baseDetails,
            status: 'rejected',
            operationId: result.operationId || context.operationId || null,
            review: result.review || null,
        };
        return { status: 'success', result: renderSyntaxRejected(result, { ...context, projectId, filePath, reason, maid }), details };
    }

    throw new Error(`未识别的原生编辑结果状态：${result.state || result.status || '(empty)'}`);
}

module.exports = { buildEditRequest, buildResolveRequest, renderEditResult };
