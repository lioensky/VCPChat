'use strict';
// 旧文件写命令参数 → Rust file.execute 的纯协议适配。
// 本文件不读盘、不写盘、不持数据库；只把旧工具字段收缩成固定请求并渲染通用回执。

const A = require('./args');
const SR = require('./symbolResolver');

const BLOCK_FIELDS = ['target', 'start', 'end', 'lines', 'symbol', 'range', 'line', 'pick', 'expect'];
const KIND_BY_COMMAND = {
    createfile: 'create',
    removefile: 'remove',
    movefile: 'move',
    movecode: 'moveCode',
    copycode: 'copyCode',
    rollback: 'rollback',
    revertfile: 'revertFile',
};
const LABEL_BY_COMMAND = {
    createfile: 'CreateFile',
    removefile: 'RemoveFile',
    movefile: 'MoveFile',
    movecode: 'MoveCode',
    copycode: 'CopyCode',
    rollback: 'Rollback',
    revertfile: 'RevertFile',
};

function requiredText(value, name) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error(`native file 命令缺少 ${name}。`);
    return text;
}

function operationIdOf(value) {
    const id = requiredText(value, 'operationId');
    if (id.length > 128) throw new Error('native file 命令的 operationId 超过 128 字符。');
    return id;
}

function textValue(value) {
    return value === undefined || value === null ? '' : String(value);
}

function splitPathRange(entry) {
    const m = String(entry ?? '').match(/^(.*?):(\d+(?:\s*-\s*\d+)?)$/);
    return m ? { path: m[1], lines: m[2].replace(/\s/g, '') } : { path: String(entry ?? ''), lines: undefined };
}

function positiveInteger(value, name) {
    const n = Number(String(value ?? '').trim().replace(/^[bn#]/i, ''));
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} 必须是正整数：${value}`);
    return n;
}

function collectBlock(args) {
    const out = {};
    const nested = args.block && typeof args.block === 'object' && !Array.isArray(args.block) ? args.block : null;
    if (nested) {
        const lower = A.lowerKeys(nested);
        for (const key of BLOCK_FIELDS) if (lower[key] !== undefined) out[key] = lower[key];
    }
    for (const key of BLOCK_FIELDS) if (args[key] !== undefined) out[key] = args[key];
    for (const key of ['start', 'end', 'line', 'pick']) {
        if (out[key] !== undefined) out[key] = positiveInteger(out[key], `block.${key}`);
    }
    return out;
}

function withBlockRange(block, range) {
    if (!range || block.target !== undefined || block.start !== undefined || block.end !== undefined
        || block.lines !== undefined || block.symbol !== undefined) return block;
    return { ...block, lines: range };
}

function splitSource(raw) {
    const ranged = splitPathRange(raw);
    const split = SR.splitPathSymbol(ranged.path);
    return { path: split.path, symbol: split.symbol || null, lines: ranged.lines || null };
}

function edgeValue(value, side) {
    if (value === undefined || value === null || value === '') return undefined;
    const raw = String(value).trim();
    if (/^symbol\s*:/i.test(raw)) return raw;
    const low = raw.toLowerCase();
    if (low === 'end' || low === 'eof' || low === '$') return 'end';
    if (low === 'start' || low === 'begin' || low === 'bof' || low === '^') return side === 'before' ? 1 : 0;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < (side === 'before' ? 1 : 0)) {
        throw new Error(`${side} 需要有效行号、end 或 symbol:名称：${value}`);
    }
    return n;
}

function common(command, context) {
    const key = String(command || '').toLowerCase();
    const kind = KIND_BY_COMMAND[key];
    if (!kind) throw new Error(`未识别的原生文件命令：${command}`);
    const params = {
        operationId: operationIdOf(context.operationId),
        projectId: requiredText(context.projectId, 'projectId'),
        kind,
        reason: requiredText(context.reason, 'reason'),
    };
    if (context.maid !== undefined && context.maid !== null && String(context.maid).trim() !== '') {
        params.maid = String(context.maid).trim();
    }
    if (context.todo !== undefined && context.todo !== null) params.todo = context.todo;
    return { key, params };
}

/** 旧 CreateFile/RemoveFile/MoveFile/MoveCode/CopyCode/Rollback 参数 → file.execute 请求。 */
function buildFileRequest(command, context, rawArgs) {
    const args = A.lowerKeys(rawArgs || {});
    const { key, params } = common(command, context);

    if (key === 'createfile') {
        params.filePath = requiredText(A.str(args, 'path', 'file', 'filePath'), 'filePath');
        params.content = textValue(A.pick(args, 'content'));
        params.overwrite = A.bool(A.pick(args, 'overwrite'), false);
        params.rejectNewSyntax = A.bool(A.pick(args, 'revertOnSyntaxError'), false);
        return { method: 'file.execute', params };
    }

    if (key === 'removefile') {
        const inputs = [A.str(args, 'path', 'file', 'filePath'), ...A.list(A.pick(args, 'paths', 'files'))]
            .filter(Boolean);
        if (!inputs.length) throw new Error('RemoveFile 需要 path 或 paths。');
        params.paths = [...new Set(inputs)];
        params.rejectNewSyntax = false;
        return { method: 'file.execute', params };
    }

    if (key === 'movefile') {
        params.from = requiredText(A.str(args, 'from', 'source', 'path'), 'from');
        params.to = requiredText(A.str(args, 'to', 'destination', 'target'), 'to');
        return { method: 'file.execute', params };
    }

    if (key === 'movecode' || key === 'copycode') {
        const fromRaw = requiredText(A.str(args, 'from', 'source', 'path', 'file'), 'from');
        const source = splitSource(fromRaw);
        params.from = requiredText(source.path, 'from 文件路径');
        const toRaw = A.str(args, 'to', 'dest', 'destination');
        if (toRaw) params.to = toRaw;
        const block = withBlockRange(collectBlock(args), source.lines);
        if (source.symbol && block.symbol === undefined) block.symbol = source.symbol;
        if (Object.keys(block).length) params.block = block;
        const after = edgeValue(A.pick(args, 'after'), 'after');
        const before = edgeValue(A.pick(args, 'before'), 'before');
        if (after !== undefined) params.after = after;
        if (before !== undefined) params.before = before;
        if (A.pick(args, 'indent') !== undefined) params.indent = A.pick(args, 'indent');
        params.create = A.bool(A.pick(args, 'create'), true);
        params.rejectNewSyntax = A.bool(A.pick(args, 'revertOnSyntaxError'), false);
        return { method: 'file.execute', params };
    }

    if (key === 'rollback') {
        const batchRef = A.str(args, 'batch', 'batchId');
        const nodeRef = A.str(args, 'toNode', 'node', 'nodeId');
        if (batchRef) params.batch = /^last$/i.test(batchRef) ? 'last' : positiveInteger(batchRef, 'batch');
        else if (nodeRef) params.toNode = positiveInteger(nodeRef, 'toNode');
        else throw new Error('Rollback 需要 batch（bX 或 last）或 toNode（nX）。');
        const filePath = A.str(args, 'path', 'file', 'filePath');
        if (filePath) params.filePath = filePath;
        params.force = A.bool(A.pick(args, 'force'), false);
        params.dryRun = A.bool(A.pick(args, 'dryRun'), false);
        return { method: 'file.execute', params };
    }

    params.nodeId = positiveInteger(A.pick(args, 'nodeId', 'node'), 'nodeId');
    params.mode = A.str(args, 'mode').toLowerCase() === 'after' ? 'after' : 'before';
    params.dryRun = A.bool(A.pick(args, 'dryRun'), false);
    params.force = A.bool(A.pick(args, 'force'), false);
    if (Object.prototype.hasOwnProperty.call(args, 'expectedhash')) params.expectedHash = args.expectedhash;
    return { method: 'file.execute', params };
}

function renderReview(review) {
    if (!review || typeof review !== 'object') return '';
    const lines = ['### 代码审查'];
    const version = review.validatorVersion ?? review.validator_version;
    if (version) lines.push(`- 校验器：${version}`);
    if (review.supported === false) {
        lines.push('- 当前语言未执行语法校验');
        return lines.join('\n');
    }
    const introduced = Array.isArray(review.introduced) ? review.introduced : [];
    lines.push(`- 新增问题：${introduced.length}${Number.isInteger(review.existing) ? ` · 原有 ${review.existing}` : ''}`);
    for (const item of introduced) {
        const icon = item.severity === 'error' || item.fatal ? '❌' : '⚠️';
        const rule = item.ruleId ? ` \`${item.ruleId}\`` : '';
        lines.push(`  - ${icon} L${item.line || '?'}:${item.column || '?'}${rule} ${item.message}`);
    }
    return lines.join('\n');
}

function statusOf(result) {
    if (result?.status === 'planningRejected' && result.candidates?.length) return 'ambiguous';
    return String(result?.status || result?.state || '').trim() || 'unknown';
}

function filesOf(result) {
    return Array.isArray(result?.files) ? result.files : [];
}

function filePathLabel(params) {
    const value = params?.filePath;
    if (Array.isArray(value)) return value.map(item => `\`${item}\``).join('、');
    if (value) return `\`${value}\``;
    if (params?.from && params?.to) return `\`${params.from}\` → \`${params.to}\``;
    if (params?.from) return `\`${params.from}\``;
    return '';
}

function detailsFor(command, result, context) {
    const status = statusOf(result);
    const files = filesOf(result);
    const details = {
        command,
        projectId: result?.projectId || context.projectId || null,
        status,
        operationId: result?.operationId || context.operationId || null,
        batchId: result?.batchId ?? null,
        nodeId: result?.nodeId ?? result?.nodeIds?.[0] ?? null,
        nodeIds: result?.nodeIds || (result?.nodeId !== undefined ? [result.nodeId] : []),
        files,
        review: result?.review || null,
    };
    if (result?.filePath || context.filePath) details.filePath = result.filePath || context.filePath;
    if (result?.action) details.action = result.action;
    if (Array.isArray(result?.conflicts)) details.conflicts = result.conflicts;
    if (Array.isArray(result?.errors)) details.errors = result.errors;
    if (Array.isArray(result?.failed)) details.failed = result.failed;
    if (Array.isArray(result?.items)) details.items = result.items;
    if (result?.source) details.source = result.source;
    if (result?.placed) details.placed = result.placed;
    if (Number.isInteger(result?.removed)) details.removed = result.removed;
    else if (String(command).toLowerCase() === 'removefile' && status === 'ok') details.removed = files.length;
    if (result?.mode) details.mode = result.mode;
    return details;
}

/** 原生 file.execute 结果 → 旧工具可读 Markdown；不伪造 diff 或未回传字段。 */
function renderFileResult(command, result, context = {}) {
    const commandKey = String(command || '').toLowerCase();
    const label = LABEL_BY_COMMAND[commandKey] || String(command || 'File');
    const status = statusOf(result);
    const params = context.params || {};
    const where = context.filePath || filePathLabel(params);
    const icon = status === 'ok' ? '✅'
        : status === 'unchanged' || status === 'noop' || status === 'dryRun' ? 'ℹ️'
            : '❌';
    const title = status === 'ok' ? (commandKey === 'removefile' ? '删除（履历可回退）' : '已提交')
        : status === 'unchanged' ? '内容无变化，未写入'
            : status === 'dryRun' ? '回退预演（dryRun）'
                : status === 'conflict' ? '存在冲突，未执行'
                    : status === 'noop' ? '无需操作'
                        : status === 'rejected' ? '已拒绝写入'
                            : status === 'unknown' ? '结果未回传' : '执行失败';
    const lines = [`## ${icon} ${label} · ${title}${where ? ` · ${where}` : ''}`];
    if (result?.operationId || context.operationId) lines.push(`- operationId：\`${result.operationId || context.operationId}\``);
    if (result?.batchId !== undefined && result?.batchId !== null) lines.push(`- 批次：\`b${result.batchId}\``);
    const nodeIds = detailsFor(command, result, context).nodeIds;
    if (nodeIds.length) lines.push(`- 节点：${nodeIds.map(id => `\`n${id}\``).join('、')}`);
    if (result?.status === 'unchanged') lines.push('- 内容与提交后快照一致，未创建文件写入。');
    if (result?.action) lines.push(`- 动作：${result.action}`);
    const files = filesOf(result);
    if (files.length) {
        lines.push('### 文件');
        for (const file of files) {
            const pathLabel = file.filePath || file.file_path || '（未回传路径）';
            const op = file.op || 'edit';
            const before = file.beforeHash ? ` · before \`${file.beforeHash.slice(0, 12)}\`` : '';
            const after = file.afterHash ? ` · after \`${file.afterHash.slice(0, 12)}\`` : '';
            lines.push(`- \`${pathLabel}\` · ${op}${before}${after}${file.summary ? ` · ${file.summary}` : ''}`);
        }
    }
    if (result?.source) {
        const source = result.source;
        lines.push(`- 源块：\`${source.path || '?'}\` L${source.startLine ?? '?'}-${source.endLine ?? '?'}`);
    }
    if (result?.placed) lines.push(`- 落点：${result.placed}`);
    if (Array.isArray(result?.items) && result.items.length) {
        lines.push('### 回退项');
        for (const item of result.items) {
            const filePath = item.rel || item.file || item.filePath || item.file_path || '（未回传路径）';
            const action = item.action || '（未回传动作）';
            const conflicts = Array.isArray(item.conflicts) && item.conflicts.length ? ` · 冲突：${item.conflicts.join('；')}` : '';
            lines.push(`- \`${filePath}\` · ${action}${conflicts}`);
        }
    }
    if (Array.isArray(result?.conflicts) && result.conflicts.length) {
        lines.push(`### 冲突\n${result.conflicts.map(item => `- ${item}`).join('\n')}`);
    }
    if (Array.isArray(result?.failed) && result.failed.length) {
        lines.push(`### 失败\n${result.failed.map(item => `- ${item}`).join('\n')}`);
    }
    if (Array.isArray(result?.errors) && result.errors.length) {
        lines.push(`### 错误\n${result.errors.map(item => `- ${typeof item === 'string' ? item : item.message || JSON.stringify(item)}`).join('\n')}`);
    }
    if (result?.message) lines.push(`- ${result.message}`);
    const review = renderReview(result?.review);
    if (review) lines.push(review);
    if (status === 'conflict') lines.push('- 确认覆盖请加 force=true；文件当前内容会先进入快照，仍可再回退。');
    if (status === 'dryRun') lines.push('- 去掉 dryRun 即可执行。');
    return { text: lines.join('\n'), details: detailsFor(command, result, context) };
}

module.exports = { buildFileRequest, renderFileResult, statusOf, LABEL_BY_COMMAND };
