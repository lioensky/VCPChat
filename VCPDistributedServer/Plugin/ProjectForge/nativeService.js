'use strict';
// 异步原生服务门面：工具与 GUI 只通过传入的 RustProjectStore 和 service client 访问权威状态。
// 本文件不 require 旧 engine/tickets/store，不写磁盘，不持 better-sqlite3。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const A = require('./args');
const SR = require('./symbolResolver');
const nativeEdit = require('./nativeEdit');
const nativeFiles = require('./nativeFiles');
const LG = require('./linkGraph');
const ES = require('./evalSymbol');
const { isPathInside, toPosixRelative } = require('../../shared/fileKit/paths');
const T = require('../../shared/fileKit/text');
const { readFilesAsContent } = require('../../shared/fileKit/reader');
const { isBinaryExtension, parseBinaryBuffer } = require('../../shared/fileKit/binaryReader');
const { textResult, partsResult } = require('../../shared/fileKit/output');
const { buildReport, reportFilename } = require('./exportReport');

const P = '[ProjectForge]';
const TODO_ICON = { pending: '[ ]', doing: '[~]', done: '[x]', blocked: '[!]' };
const KIND_LABEL = { edit: '编辑', create: '新建', remove: '删除', move: '移动', rollback: '回退', external: '外部修改' };
const MUTATING_COMMANDS = new Set([
    'createproject', 'updatetodos', 'submitreport', 'deleteprojects', 'restoreprojects', 'purgeprojects',
    'editcode', 'resolveedit', 'createfile', 'removefile', 'movefile', 'movecode', 'copycode', 'rollback',
]);

function posInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function idNum(ref, prefix, label) {
    const raw = String(ref ?? '').trim();
    const n = Number(raw.replace(new RegExp(`^${prefix}`, 'i'), ''));
    if (!Number.isInteger(n) || n < 1) throw new Error(`${P} ${label} 无效：“${raw}”，应形如 ${prefix}12`);
    return n;
}
function todoProgress(todos) {
    const done = todos.filter(t => t.status === 'done').length;
    return { done, total: todos.length, text: todos.length ? `${done}/${todos.length}` : '无' };
}
function renderTodos(todos) {
    if (!todos.length) return '- （暂无 todo）';
    return todos.map(t => `- ${TODO_ICON[t.status] || '[ ]'} #${t.seq} ${t.title}${t.note ? ` — ${t.note}` : ''}`).join('\n');
}
function whoOf(maid, kind) {
    if (maid) return `@${maid}`;
    return kind === 'external' ? '@外部' : '@未署名';
}
function escapeCell(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
}
function renderTimeline(rows) {
    if (!rows.length) return '- （暂无改动）';
    return rows.map(r => {
        if (Array.isArray(r.nodes)) {
            return `- b${r.id} · ${escapeCell(KIND_LABEL[r.kind] || r.kind)} · ${escapeCell(whoOf(r.maid, r.kind))} · ${escapeCell(r.created_at)} · ${escapeCell(r.reason || '（未记录原因）')}\n` +
                (r.nodes.length ? r.nodes.map(n => `  - n${n.id} · ${escapeCell(n.created_at)} · ${escapeCell(n.op)} · ${escapeCell(n.file_path)} · ${escapeCell(n.reason || n.summary || '（未记录原因）')} · +${n.added}/-${n.removed}`).join('\n') : '  - 无文件节点');
        }
        const files = String(r.files || '').split(',').filter(Boolean);
        const shown = files.slice(0, 5).map(f => `\`${f}\``).join('、') + (files.length > 5 ? ` 等 ${files.length} 个` : '');
        return `- \`b${r.id}\` · ${KIND_LABEL[r.kind] || r.kind} · ${whoOf(r.maid, r.kind)} · ${fmtTime(r.created_at)} · ${r.reason || '（未记录原因）'}\n  - ${shown || '-'} (+${r.added || 0}/-${r.removed || 0})`;
    }).join('\n');
}
function renderContributors(rows) {
    if (!rows.length) return '- （暂无）';
    return rows.map(r => `- ${whoOf(r.maid, r.maid ? null : 'external')}：${r.batches} 次改动 · +${r.added}/-${r.removed} · 最近 ${fmtTime(r.last_at)}`).join('\n');
}
function projectHeader(project, rootInfo) {
    return `- 工程：${project.name}（\`${project.id}\`）· 状态 ${project.status}\n- 根目录：${rootInfo.root}${rootInfo.workspaceAlias ? `（工作区 \`${rootInfo.workspaceAlias}\`）` : ''}${rootInfo.writable ? '' : `\n- ⚠️ ${rootInfo.blockedReason}`}`;
}
function maidOf(args) {
    let raw = args.maid;
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
        try { raw = JSON.parse(raw); } catch { /* 普通字符串 */ }
    }
    const name = typeof raw === 'object' ? (raw.name || raw.signature || raw.id || '') : raw;
    const value = String(name).trim();
    return value ? value.slice(0, 100) : null;
}
function splitPathRange(entry) {
    const m = String(entry ?? '').match(/^(.*?):(\d+(?:\s*-\s*\d+)?)$/);
    return m ? { path: m[1], lines: m[2].replace(/\s/g, '') } : { path: String(entry ?? ''), lines: undefined };
}
function splitFindQuery(raw) {
    const text = String(raw);
    if (text.includes('\n') || !text.includes('|')) return [text];
    const parts = [];
    let cur = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\' && text[i + 1] === '|') { cur += '|'; i++; continue; }
        if (ch === '|') {
            if (text[i + 1] === '|') { cur += '||'; i++; continue; }
            parts.push(cur); cur = ''; continue;
        }
        cur += ch;
    }
    parts.push(cur);
    const frags = [...new Set(parts.map(p => p.trim()).filter(Boolean))];
    return frags.length ? frags : [text];
}
function swapQualifier(name) {
    const text = String(name || '');
    if (text.includes('::')) return text.replace(/::/g, '.');
    if (text.includes('.')) return text.replace(/\./g, '::');
    return null;
}
function newOperationId() {
    return `pf-${crypto.randomUUID()}`;
}

function createNativeService(options = {}) {
    const runtime = {
        store: options.store || null,
        client: options.client || options.store?.client || null,
        resolver: options.resolver || null,
        indexer: options.indexer || null,
        logger: options.logger || console,
        maxEditSize: options.maxEditSize ?? 5 * 1024 * 1024,
        readMaxFiles: options.readMaxFiles ?? 20,
        readMaxBytes: options.readMaxBytes ?? 30 * 1024 * 1024,
        initialized: true,
        events: new EventEmitter(),
        traceBridgeCache: new Map(),
    };
    runtime.events.setMaxListeners(50);
    if (!runtime.store) throw new Error('createNativeService 需要 store（RustProjectStore）。');
    if (!runtime.resolver) throw new Error('createNativeService 需要 resolver（WorkspaceResolver）。');

    function store() { return runtime.store; }
    function clientRequest(method, params = {}) {
        if (!runtime.client || typeof runtime.client.request !== 'function') {
            throw new Error(`${P} 原生服务 client 不可用，无法发送 ${method}。`);
        }
        return runtime.client.request(method, params);
    }
    function emitProjectChanged(payload = {}) {
        try { runtime.events.emit('changed', { timestamp: Date.now(), ...payload }); }
        catch (error) { runtime.logger?.warn?.(`${P} 广播工程变更事件失败:`, error?.message || error); }
    }

    async function projectOf(args, { write = false } = {}) {
        const id = A.str(args, 'projectId', 'project', 'id');
        if (!id) throw new Error(`${P} 缺少 projectId。可用 ListProjects 查询已有工程。`);
        const project = await store().getProject(id);
        if (!project) throw new Error(`${P} 工程 ${id} 不存在或已删除。可用 ListProjects 查询。`);
        const rootInfo = runtime.resolver.projectRoot(project);
        if (write && !rootInfo.writable) throw new Error(`${P} ${rootInfo.blockedReason}`);
        return { project, rootInfo };
    }
    function fileOf(ctx, input, { write = false } = {}) {
        const file = runtime.resolver.resolveInProject(ctx.rootInfo, input);
        if (write && !runtime.resolver.isWritable(file.abs)) {
            throw new Error(`${P} 路径不在已启用工作区或允许目录内：${file.abs}`);
        }
        return file;
    }
    function todoRefsOf(args) {
        const raw = A.pick(args, 'todo', 'todoId');
        if (raw === undefined) return { value: undefined, refs: [] };
        const refs = A.list(raw)
            .flatMap(v => String(v).split(/[\s，、;；]+/))
            .map(v => v.replace(/^#/, '').trim())
            .filter(Boolean);
        return { value: refs.length === 1 ? Number(refs[0]) : refs.map(Number), refs };
    }
    async function todoOf(project, args) {
        const { value, refs } = todoRefsOf(args);
        if (!refs.length) return { todo: null, value: undefined };
        const todos = [];
        const missing = [];
        for (const ref of refs) {
            const seq = Number(ref);
            const todo = Number.isInteger(seq) ? await store().getTodoBySeq(project.id, seq) : null;
            if (!todo) missing.push(`#${ref}`);
            else if (!todos.some(t => t.id === todo.id)) todos.push(todo);
        }
        if (missing.length) throw new Error(`${P} todo ${missing.join('、')} 不存在（收到 todo=“${args.todo ?? args.todoid}”）。可用 GetProject 查看 todo 列表。`);
        for (const todo of todos) {
            if (todo.status === 'pending') await store().updateTodo(project.id, todo.seq, { status: 'doing' });
        }
        return { todo: todos[0], value };
    }

    function readDisk(abs) {
        return fsp.stat(abs).then(async stat => {
            if (stat.isDirectory()) throw new Error(`${P} ${abs} 是目录，不是文件。`);
            const buffer = await fsp.readFile(abs);
            return { exists: true, buffer, hash: crypto.createHash('sha256').update(buffer).digest('hex') };
        }).catch(error => {
            if (error.code === 'ENOENT') return { exists: false, buffer: null, hash: null };
            throw error;
        });
    }
    function decodeText(buffer, rel) {
        if (buffer.length > runtime.maxEditSize) {
            throw new Error(`${P} ${rel} 超过可编辑上限 ${T.formatFileSize(runtime.maxEditSize)}。`);
        }
        if (buffer.subarray(0, 8000).includes(0)) {
            throw new Error(`${P} ${rel} 是二进制或 UTF-16 文件，不能按文本编辑。`);
        }
        const bom = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
        const raw = buffer.toString('utf8', bom ? 3 : 0);
        return { bom, lineEnding: T.detectLineEnding(raw), text: T.normalizeEol(raw) };
    }
    async function blobBuffer(hash) {
        if (!hash) return null;
        return store().getBlob(hash);
    }
    async function blobText(hash) {
        const buf = await blobBuffer(hash);
        if (!buf) return '';
        if (buf.subarray(0, 8000).includes(0)) return null;
        return T.normalizeEol(buf.toString('utf8').replace(/^\uFEFF/, ''));
    }
    async function guiBlobText(hash) {
        if (!hash) return { exists: false, binary: false, truncated: false, size: 0, text: '' };
        const buf = await blobBuffer(hash);
        if (!buf) return { exists: false, binary: false, truncated: false, size: 0, text: '' };
        if (buf.subarray(0, 8000).includes(0)) return { exists: true, binary: true, truncated: false, size: buf.length, text: '' };
        const truncated = buf.length > 2 * 1024 * 1024;
        const text = T.normalizeEol(buf.subarray(0, truncated ? 2 * 1024 * 1024 : buf.length).toString('utf8').replace(/^\uFEFF/, ''));
        return { exists: true, binary: false, truncated, size: buf.length, text };
    }

    function astStatusNote() {
        const indexer = runtime.indexer;
        if (!indexer) return '索引器未初始化';
        if (indexer.disabled) return '已通过配置 AST_INDEX_ENABLED=false 关闭';
        const st = typeof indexer.status === 'function' ? indexer.status() : null;
        if (st?.circuit) return st.circuit;
        return null;
    }
    function astUnavailableReason(rel) {
        if (runtime.indexer && typeof runtime.indexer.supports === 'function' && !runtime.indexer.supports(rel)) {
            return '该文件类型不支持 AST 符号（支持 JS/TS/TSX/Python/Rust 及几何 Outline 等），请用 lines / target 定位';
        }
        return `AST 索引器不可用（${astStatusNote() || '启动失败或暂时降级'}），请用 lines / target 定位`;
    }
    async function outlineOf(rel, text) {
        const indexer = runtime.indexer;
        if (!indexer || typeof indexer.supports === 'function' && !indexer.supports(rel)) return null;
        return indexer.outline(text, rel);
    }
    async function resolveSymbolInFile(file, ref, options = {}) {
        const disk = await readDisk(file.abs);
        if (!disk.exists) throw new Error(`${P} 文件不存在：${file.rel}`);
        const meta = decodeText(disk.buffer, file.rel);
        const outline = await outlineOf(file.rel, meta.text);
        if (!outline) throw new Error(`${P} ${file.rel}：${astUnavailableReason(file.rel)}。`);
        const res = SR.resolveInOutline(outline, ref, options);
        return { disk, meta, outline, res };
    }
    function renderSymbolMiss(file, res, command) {
        if (res.status === 'notFound') {
            return `## ❌ 未找到符号 \`${res.query}\` · \`${file.rel}\`\n- 最相似的符号：\n${SR.renderSuggestions(res.suggestions)}\n- 可用 Outline path=${file.rel} 查看全部符号，或用 FindSymbol 在工程内查找。`;
        }
        return `## ⚠️ 符号 \`${res.query}\` 在 \`${file.rel}\` 中有 ${res.total} 处同名定义，未执行 ${command}${res.tooMany ? `（仅列出前 ${res.candidates.length} 处）` : ''}\n${SR.renderCandidateLines(res.candidates)}\n- 下一步：保留原参数，加 pick=候选序号 或 line=近似行号 重发；也可写更完整的限定名。`;
    }

    function collectReadTargets(ctx, args) {
        const targets = [];
        const single = A.str(args, 'path', 'file', 'filePath');
        const symbolArg = A.str(args, 'symbol');
        if (single) {
            const { path: p0, lines } = splitPathRange(single);
            const { path: p, symbol } = SR.splitPathSymbol(p0);
            targets.push({ ...fileOf(ctx, p), lines: A.str(args, 'lines') || lines, symbol: symbol || symbolArg || null });
        } else if (symbolArg) {
            throw new Error(`${P} ReadCode 的 symbol= 需要配合 path（或直接写 path=文件#符号）。不知道在哪个文件时先用 FindSymbol。`);
        }
        for (const entry of A.list(A.pick(args, 'paths', 'files'))) {
            const { path: p0, lines } = splitPathRange(entry);
            const { path: p, symbol } = SR.splitPathSymbol(p0);
            targets.push({ ...fileOf(ctx, p), lines, symbol });
        }
        const pattern = A.str(args, 'glob', 'pattern');
        if (pattern) {
            const { globSync } = require('glob');
            const matches = globSync(pattern.replace(/\\/g, '/'), {
                cwd: ctx.rootInfo.root, nodir: true, dot: false, absolute: true,
                ignore: ['**/node_modules/**', '**/.git/**'],
            }).sort().slice(0, 200);
            for (const abs of matches) targets.push({ ...fileOf(ctx, abs), lines: A.str(args, 'lines') || undefined });
        }
        if (!targets.length) throw new Error(`${P} ReadCode 需要 path、paths 或 glob。`);
        const seen = new Set();
        return targets.filter(t => {
            const key = `${t.rel}|${t.lines || ''}|${t.symbol || ''}`;
            return seen.has(key) ? false : (seen.add(key), true);
        });
    }
    async function findInFiles(ctx, targets, needle) {
        const fragments = splitFindQuery(T.normalizeEol(needle));
        const multi = fragments.length > 1;
        const counts = new Map(fragments.map(fragment => [fragment, 0]));
        const out = [];
        let total = 0;
        for (const target of targets) {
            const disk = await readDisk(target.abs);
            if (!disk.exists) { out.push(`- \`${target.rel}\`：文件不存在`); continue; }
            let meta;
            try { meta = decodeText(disk.buffer, target.rel); } catch { continue; }
            const lines = T.splitLines(meta.text).lines;
            const seen = new Set();
            const hits = [];
            for (const fragment of fragments) {
                const query = String(fragment).trim();
                if (!query) continue;
                if (query.includes('\n')) {
                    let from = 0;
                    for (;;) {
                        const at = meta.text.indexOf(query, from);
                        if (at < 0) break;
                        const line = meta.text.slice(0, at).split('\n').length;
                        const endLine = line + query.split('\n').length - 1;
                        const key = `${line}-${endLine}`;
                        if (!seen.has(key)) { seen.add(key); hits.push({ startLine: line, endLine }); }
                        counts.set(fragment, counts.get(fragment) + 1);
                        from = at + Math.max(1, query.length);
                    }
                } else {
                    lines.forEach((line, index) => {
                        if (!line.includes(query)) return;
                        const key = `${index + 1}-${index + 1}`;
                        if (!seen.has(key)) { seen.add(key); hits.push({ startLine: index + 1, endLine: index + 1 }); }
                        counts.set(fragment, counts.get(fragment) + 1);
                    });
                }
            }
            hits.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
            const outline = hits.length ? await outlineOf(target.rel, meta.text) : null;
            total += hits.length;
            for (const hit of hits.slice(0, Math.max(0, 30 - out.length))) {
                const from = Math.max(1, hit.startLine - 2);
                const to = Math.min(lines.length, hit.endLine + 2);
                const body = T.numberLines(lines.slice(from - 1, to), from);
                const scope = SR.enclosingChain(outline?.symbols, hit.startLine);
                out.push(`#### \`${target.rel}\` · L${hit.startLine}-${hit.endLine}${scope ? ` · in ${scope}` : ''}\n${T.markdownFence(body, T.languageOf(target.rel))}`);
            }
        }
        const head = `## Find “${String(needle).split('\n')[0].slice(0, 60)}” · 共 ${total} 处${total > 30 ? '（仅显示前 30 处）' : ''}\n${projectHeader(ctx.project, ctx.rootInfo)}`;
        return textResult(`${head}\n\n${out.join('\n\n') || '- 未找到。'}`, {
            command: 'ReadCode', mode: 'find', total,
            fragments: multi ? Object.fromEntries(counts) : undefined,
        });
    }
    async function readCode(args) {
        const ctx = await projectOf(args);
        const targets = collectReadTargets(ctx, args);
        const needle = A.pick(args, 'find', 'search');
        if (needle !== undefined) return findInFiles(ctx, targets, String(needle));
        const showLine = A.bool(A.pick(args, 'showLine', 'showLines', 'lineNumbers'), true);
        const range = A.str(args, 'range') || 'full';
        const context = Math.max(0, Math.floor(Number(A.pick(args, 'context')) || 0));
        const symNotes = [];
        const misses = [];
        const symbols = [];
        const readable = [];
        for (const target of targets) {
            if (!target.symbol) { readable.push(target); continue; }
            try {
                const resolved = await resolveSymbolInFile(target, target.symbol, { pick: A.pick(args, 'pick'), line: A.pick(args, 'line') });
                if (resolved.res.status !== 'ok') { misses.push(renderSymbolMiss(target, resolved.res, 'ReadCode')); continue; }
                const sym = resolved.res.symbol;
                const rg = SR.symbolRange(sym, { range, context, lineCount: T.splitLines(resolved.meta.text).lines.length });
                symNotes.push(`- \`${target.rel}#${sym.qualified}\` · ${sym.kind} · 读取 L${rg.startLine}-${rg.endLine}${context ? `，上下文 ±${context} 行` : ''}`);
                symbols.push({ path: target.rel, ...sym, readStart: rg.startLine, readEnd: rg.endLine });
                readable.push({ ...target, lines: `${rg.startLine}-${rg.endLine}` });
            } catch (error) {
                misses.push(`## ❌ \`${target.rel}#${target.symbol}\`\n- ${error.message}`);
            }
        }
        const result = await readFilesAsContent(
            readable.map(t => ({ absPath: t.abs, displayPath: t.symbol ? `${t.rel}#${t.symbol}` : t.rel, lines: t.lines })),
            { withLineNumbers: showLine, maxFiles: runtime.readMaxFiles, maxTotalBytes: runtime.readMaxBytes, maxFileSize: runtime.maxEditSize * 4 },
        );
        const head = {
            type: 'text',
            text: [
                `## ReadCode · ${result.read.length} 个文件`,
                projectHeader(ctx.project, ctx.rootInfo),
                showLine ? '- 行号前缀 `N | ` 仅供定位，EditCode 时可直接粘贴，插件会自动剥除。' : '',
                symNotes.length ? `### 符号\n${symNotes.join('\n')}` : '',
            ].filter(Boolean).join('\n'),
        };
        const parts = [head, ...result.parts];
        if (misses.length) parts.push({ type: 'text', text: misses.join('\n\n') });
        return partsResult(parts, { command: 'ReadCode', read: result.read, skipped: result.skipped, failed: result.failed, symbols, symbolMisses: misses.length });
    }

    async function outlineCmd(args) {
        const ctx = await projectOf(args);
        const inputs = [A.str(args, 'path', 'file', 'filePath'), ...A.list(A.pick(args, 'paths', 'files'))].filter(Boolean);
        if (!inputs.length) throw new Error(`${P} Outline 需要 path 或 paths（多个用换行或逗号分隔）。`);
        const depth = posInt(A.pick(args, 'depth'), undefined);
        const kinds = A.list(A.pick(args, 'kind', 'kinds'));
        const seen = new Set();
        const files = [];
        for (const input of inputs) {
            const file = fileOf(ctx, SR.splitPathSymbol(splitPathRange(input).path).path);
            if (seen.has(file.rel)) continue;
            seen.add(file.rel);
            files.push(file);
        }
        const blocks = [];
        const details = [];
        for (const file of files.slice(0, runtime.readMaxFiles)) {
            const disk = await readDisk(file.abs);
            if (!disk.exists) { blocks.push(`### \`${file.rel}\`\n- 文件不存在`); continue; }
            if (isBinaryExtension(file.rel)) {
                let outline = await outlineOf(file.rel, null);
                if (!outline) {
                    try { outline = parseBinaryBuffer(disk.buffer, file.rel, disk.buffer.length); } catch { /* 后面统一报错 */ }
                }
                if (!outline) { blocks.push(`### \`${file.rel}\`\n- ${astUnavailableReason(file.rel)}`); continue; }
                if (outline.isBinary) {
                    const secLines = (outline.sections || []).map(s => `  - 节区 \`${s.name}\` · VAddr: ${s.virtualAddress} | Raw: ${(s.rawSize / 1024).toFixed(1)} KB | Perm: ${s.permissions}`);
                    const symLines = (outline.symbols || []).map(s => `  - 导出 \`${s.name}\` · RVA: ${s.rva}${s.demangled && s.demangled !== s.name ? ` (${s.demangled})` : ''}`);
                    blocks.push([`### \`${file.rel}\` · ${outline.format || 'Binary'} / ${outline.architecture || 'unknown'} · 节区 ${outline.sections?.length || 0} / 导出 ${outline.symbols?.length || 0}`, secLines.join('\n') || '- （无节区信息）', symLines.join('\n') || '- （无导出符号）'].join('\n'));
                    details.push({ path: file.rel, isBinary: true, format: outline.format, architecture: outline.architecture, sections: outline.sections, symbols: outline.symbols });
                    continue;
                }
            }
            let meta;
            try { meta = decodeText(disk.buffer, file.rel); } catch (error) { blocks.push(`### \`${file.rel}\`\n- ${error.message}`); continue; }
            const outline = await outlineOf(file.rel, meta.text);
            if (!outline) { blocks.push(`### \`${file.rel}\`\n- ${astUnavailableReason(file.rel)}`); continue; }
            const rendered = SR.renderOutline(outline, { depth, kinds });
            blocks.push([`### \`${file.rel}\` · ${outline.lang} · ${outline.lineCount} 行 · 显示 ${rendered.shown}/${rendered.total} 个符号${outline.hasError ? ' · ⚠️ 文件存在语法错误，区间为尽力提取' : ''}`, rendered.text || '- （无符号）'].join('\n'));
            details.push({ path: file.rel, lang: outline.lang, hasError: outline.hasError, lineCount: outline.lineCount, symbols: outline.symbols });
        }
        if (files.length > runtime.readMaxFiles) blocks.push(`- ⚠️ 仅处理前 ${runtime.readMaxFiles} 个文件（共 ${files.length} 个）。`);
        const head = [`## Outline · ${files.length} 个文件`, projectHeader(ctx.project, ctx.rootInfo), '- `L起-止` 为签名行到结束行，`注释自 L` 为含前置注释 / 装饰器的起点。可用 `path#限定名` 回填 ReadCode / EditCode / MoveCode / CopyCode。'].join('\n');
        return textResult(`${head}\n\n${blocks.join('\n\n')}`, { command: 'Outline', files: details });
    }

    async function findSymbolCmd(args) {
        const ctx = await projectOf(args);
        const name = A.str(args, 'name', 'symbol', 'query');
        if (!name) throw new Error(`${P} FindSymbol 需要 name（符号名或限定名）。`);
        if (!runtime.indexer?.usable) throw new Error(`${P} FindSymbol 需要 AST 索引器：${astStatusNote() || '不可用'}。可改用 ReadCode glob=… find=… 做文本查找。`);
        const scopeArg = A.str(args, 'scope').toLowerCase();
        let root = ctx.rootInfo.root;
        let scopeLabel = '工程根';
        if (scopeArg === 'workspace') {
            const ws = runtime.resolver.list().filter(item => isPathInside(root, item.path) || path.resolve(item.path) === path.resolve(root))
                .sort((a, b) => b.path.length - a.path.length)[0];
            if (ws) { root = path.resolve(ws.path); scopeLabel = `工作区 \`${ws.alias}\`（工程外的结果只读）`; }
            else scopeLabel = '工程根（未找到所属工作区）';
        } else if (scopeArg && scopeArg !== 'project') {
            throw new Error(`${P} scope 只能是 project（默认）或 workspace。`);
        }
        const query = {
            kind: A.str(args, 'kind') || undefined,
            glob: A.str(args, 'glob', 'pattern') || undefined,
            exact: A.bool(A.pick(args, 'exact'), false),
            limit: Math.min(posInt(A.pick(args, 'limit'), 20), 500),
        };
        let usedName = name;
        let result = await runtime.indexer.findSymbols(root, { ...query, name });
        const alt = swapQualifier(name);
        if (result && !result.total && alt) {
            const retry = await runtime.indexer.findSymbols(root, { ...query, name: alt });
            if (retry && retry.total) { result = retry; usedName = alt; }
        }
        if (!result) throw new Error(`${P} FindSymbol 失败：${astStatusNote() || 'AST 索引器暂时不可用'}。`);
        const hits = (result.hits || []).map(hit => {
            const abs = path.resolve(root, ...String(hit.path).split(/[\\/]+/));
            const inProject = isPathInside(abs, ctx.rootInfo.root);
            const rel = inProject ? toPosixRelative(ctx.rootInfo.root, abs) : toPosixRelative(root, abs);
            return { ...hit, rel, inProject };
        });
        const lines = hits.map(hit => `- \`${hit.rel}#${hit.qualified || hit.name}\` · ${SR.lineLabel(hit)} · ${hit.kind}${hit.inProject ? '' : ' · （工程外，只读）'} — ${SR.oneLine(hit.signature)}`);
        const stats = `- 范围：${scopeLabel} · 扫描 ${result.scanned} 个文件 · 解析 ${result.parsed} · ${result.lines} 行 · 命中 ${result.total}${result.total > hits.length ? `（显示前 ${hits.length}）` : ''}${result.truncated ? ' · ⚠️ 扫描已截断' : ''}`;
        return textResult([
            `## FindSymbol “${usedName}”${usedName !== name ? `（按 ${usedName} 重试后命中）` : ''}${query.kind ? ` · kind=${query.kind}` : ''}${query.exact ? ' · exact' : ''}`,
            projectHeader(ctx.project, ctx.rootInfo), stats,
            lines.join('\n') || '- 未找到。',
            hits.length ? '- 每条结果可直接写成 `path=文件#限定名` 交给 ReadCode / EditCode。' : '',
        ].filter(Boolean).join('\n'), {
            command: 'FindSymbol', total: result.total, scanned: result.scanned, parsed: result.parsed, truncated: result.truncated,
            hits: hits.map(({ rel, inProject, name: n, qualified, kind, fullStart, start, end, signature, lang }) => ({ path: rel, inProject, name: n, qualified, kind, fullStart, start, end, signature, lang })),
        });
    }

    function scanRootOf(ctx, args) {
        const scopeArg = A.str(args, 'scope').toLowerCase();
        const root = ctx.rootInfo.root;
        if (!scopeArg || scopeArg === 'project') return { root, label: '工程根' };
        if (scopeArg !== 'workspace') throw new Error(`${P} scope 只能是 project（默认）或 workspace。`);
        const ws = runtime.resolver.list().filter(item => isPathInside(root, item.path))
            .sort((a, b) => b.path.length - a.path.length)[0];
        return ws ? { root: path.resolve(ws.path), label: `工作区 \`${ws.alias}\`` } : { root, label: '工程根（未找到所属工作区）' };
    }
    async function traceCmd(args) {
        const ctx = await projectOf(args);
        const raw = A.str(args, 'target', 'query');
        const target = LG.parseTarget(raw);
        if (!target) throw new Error(`${P} Trace 需要 target，形如 ipc:通道名、global:名称、page:xxx.html、file:相对路径。`);
        if (!runtime.indexer?.usable) throw new Error(`${P} Trace 需要 AST 索引器：${astStatusNote() || '不可用'}。`);
        const scan = scanRootOf(ctx, args);
        const started = Date.now();
        const decls = await LG.loadPreloadDecls(scan.root);
        const base = LG.bridgeGlobalsOf(decls);
        const query = { glob: A.str(args, 'glob') || undefined };
        let bridge = runtime.traceBridgeCache.get(scan.root) || base;
        let facts = await runtime.indexer.facts(scan.root, { ...query, bridgeGlobals: bridge });
        if (facts) {
            const extended = [...new Set([...base, ...LG.aliasNames(facts)])].sort();
            if (extended.some(name => !bridge.includes(name))) {
                bridge = [...new Set([...bridge, ...extended])].sort();
                runtime.traceBridgeCache.set(scan.root, bridge);
                facts = await runtime.indexer.facts(scan.root, { ...query, bridgeGlobals: bridge });
            }
        }
        if (!facts) throw new Error(`${P} Trace 失败：${astStatusNote() || 'AST 索引器暂时不可用'}。`);
        const graph = LG.buildGraph(scan.root, facts, decls);
        let value = target.value;
        if (target.kind === 'file' || target.kind === 'page') {
            const file = fileOf(ctx, value);
            value = isPathInside(file.abs, scan.root) ? toPosixRelative(scan.root, file.abs) : file.rel;
        }
        const result = LG.trace(graph, target.kind, value);
        const declNote = decls.status === 'ok' ? `preload 声明表 ${decls.apis.length} 个 API` : decls.status === 'absent' ? '无 preload 声明表（只有字面量边）' : `⚠️ preload 声明表读取失败：${decls.error}`;
        const head = [projectHeader(ctx.project, ctx.rootInfo), `- 范围：${scan.label} · ${graph.stats.scanned} 个 JS/HTML 文件 · ${graph.stats.pages} 个页面 · ${declNote} · ${Date.now() - started} ms${graph.stats.truncated ? ' · ⚠️ 扫描已截断' : ''}`, '- 置信度：literal / const 为字面量或同文件常量直连，declared 经 preload 声明表；动态参数不入边。'].join('\n');
        const [title, ...rest] = result.text.split('\n');
        return textResult([title, head, ...rest].join('\n'), { command: 'Trace', kind: target.kind, found: result.found, ...result.details });
    }

    async function evalSymbolCmd(args) {
        const ctx = await projectOf(args, { write: true });
        const parsed = SR.splitPathSymbol(A.str(args, 'path'));
        const ref = parsed.symbol || A.str(args, 'symbol');
        if (!ref) throw new Error('EvalSymbol requires path=file#symbol');
        const file = fileOf(ctx, parsed.path, { write: true });
        const [realRoot, realFile] = await Promise.all([fsp.realpath(ctx.rootInfo.root), fsp.realpath(file.abs)]);
        if (!isPathInside(realFile, realRoot)) throw new Error('EvalSymbol target resolves outside project root');
        const resolved = await resolveSymbolInFile(file, ref, { pick: A.pick(args, 'pick'), line: A.pick(args, 'line') });
        if (resolved.res.status !== 'ok') {
            return textResult(renderSymbolMiss(file, resolved.res, 'EvalSymbol'), { command: 'EvalSymbol', status: resolved.res.status, candidates: resolved.res.candidates, suggestions: resolved.res.suggestions });
        }
        if (resolved.outline.hasError) return textResult('EvalSymbol: source contains syntax errors; execution rejected', { command: 'EvalSymbol', status: 'syntax_error' });
        const result = await ES.evaluate({ root: ctx.rootInfo.root, file: realFile, symbol: resolved.res.symbol.qualified, sourceHash: resolved.disk.hash, args });
        return textResult(ES.render(result, file.rel), { command: 'EvalSymbol', projectId: ctx.project.id, path: file.rel, valueEncoding: 'typed-v1', ...result });
    }

    async function projectSummaryPage(args, command = 'ListProjects') {
        const ws = A.str(args, 'workspace', 'workspaceAlias');
        const all = !ws || ws.toLowerCase() === 'all';
        let workspace = null;
        if (!all) {
            workspace = runtime.resolver.find(ws, { includeDisabled: true });
            if (command === 'SearchProjects' && !workspace) throw new Error(`${P} 工作区“${ws}”不存在。可用 ListWorkspaces 查询。`);
        }
        const rawLimit = A.pick(args, 'limit');
        const limit = rawLimit === undefined ? 10 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`${P} limit 必须是正整数（默认 10）。`);
        const page = await store().listProjectSummaries({
            workspaceId: workspace?.id || null,
            workspaceAlias: all ? null : (workspace?.alias || ws.toLowerCase()),
            includeDeleted: A.bool(A.pick(args, 'includeDeleted'), false),
            query: A.str(args, 'query') || null,
            limit,
        });
        return { page, all, ws, limit };
    }
    function summaryToToolRow(item) {
        const total = Number(item.todo_total) || 0;
        const done = Number(item.todo_done) || 0;
        return {
            ...item,
            todo_progress: total ? `${done}/${total}` : '无',
        };
    }
    async function listWorkspaces() {
        const list = runtime.resolver.list();
        const activeId = typeof runtime.resolver.active === 'function' ? runtime.resolver.active()?.id : null;
        const lines = list.map(ws => `- \`${ws.alias}\`${ws.id === activeId ? '（当前）' : ''} · ${ws.enabled ? '启用' : '停用'} · ${ws.path}`);
        return textResult(`## 工作区\n${lines.join('\n') || '- （无）请先在“全局设置 → 工作区管理”中登记工作区。'}`, { command: 'ListWorkspaces', workspaces: list });
    }
    async function createProject(args) {
        const name = A.str(args, 'name', 'projectName');
        if (!name) throw new Error(`${P} CreateProject 需要 name。`);
        const target = runtime.resolver.resolveNewProjectRoot(A.str(args, 'workspace', 'workspaceAlias'), A.str(args, 'dir', 'directory', 'root'));
        const maid = maidOf(args);
        const project = await store().createProject({
            createRoot: true,
            createdBy: maid,
            name: name.slice(0, 200),
            workspaceId: target.workspace?.id || null,
            workspaceAlias: target.workspace?.alias || null,
            root: target.root,
            subpath: target.subpath || '',
        });
        const titles = A.list(A.pick(args, 'todos', 'todo'));
        if (titles.length) await store().addTodos(project.id, titles, maid);
        const todos = await store().listTodos(project.id);
        return textResult([
            `## ✅ 工程已创建：${project.name}`,
            `- projectId：\`${project.id}\`（后续所有施工命令只需传这个 ID）`,
            `- 创建者：${whoOf(maid)}`,
            `- 根目录：${target.root}${target.workspace ? `（工作区 \`${target.workspace.alias}\`）` : ''}`,
            '- 文件路径请相对根目录书写，例如 `src/index.js`',
            '- 工程目录由原生服务创建；目录已存在时保留原内容。',
            '### Todo', renderTodos(todos),
        ].join('\n'), { command: 'CreateProject', project, todos });
    }
    async function listProjects(args, command = 'ListProjects') {
        const { page, all, ws, limit } = await projectSummaryPage(args, command);
        const rows = page.items.map(summaryToToolRow);
        const lines = rows.map(p => `| \`${p.id}\` | ${p.name} | ${p.workspace_alias || '-'} | ${p.deleted_at ? '已删除' : p.status} | ${p.todo_progress} | ${p.report ? '有' : '-'} | ${fmtTime(p.updated_at)} |`);
        const text = rows.length
            ? `## 工程列表（${all ? '全部工作区' : `工作区 ${ws}`}，${rows.length} 个，按最近更新排序，最多 ${limit} 个）\n| ID | 名称 | 工作区 | 状态 | Todo | 报告 | 更新 |\n|---|---|---|---|---|---|---|\n${lines.join('\n')}\n- 默认显示最新 10 个；可用 limit 指定返回数量。`
            : '## 工程列表\n- 没有匹配的工程。可用 CreateProject 创建。';
        return textResult(text, { command, count: rows.length, limit, total: page.total, projects: rows });
    }
    async function searchProjects(args) {
        const ws = A.str(args, 'workspace', 'workspaceAlias');
        if (!ws || ws.toLowerCase() === 'all') throw new Error(`${P} SearchProjects 需要 workspace（指定工作区别名或 ID，不能为 all）。`);
        if (!runtime.resolver.find(ws, { includeDisabled: true })) throw new Error(`${P} 工作区“${ws}”不存在。可用 ListWorkspaces 查询。`);
        const query = A.str(args, 'query', 'keyword');
        if (!query) throw new Error(`${P} SearchProjects 需要 query（工程名称关键字或完整工程 ID）。`);
        return listProjects({ ...args, query }, 'SearchProjects');
    }
    async function getProject(args) {
        const { project, rootInfo } = await projectOf(args);
        const todos = await store().listTodos(project.id);
        const stats = await store().projectStats(project.id);
        const limit = posInt(A.pick(args, 'timeline', 'limit'), 8);
        const contributors = await store().contributors(project.id);
        const timeline = await store().timeline(project.id, { limit });
        const parts = [
            `## 工程：${project.name}（\`${project.id}\`）`,
            projectHeader(project, rootInfo),
            `- 改动：${stats.nodeCount} 个节点 · ${stats.fileCount} 个文件 · +${stats.added}/-${stats.removed} · 最近 ${fmtTime(stats.lastAt)}`,
            `- 创建者：${whoOf(project.created_by)}${project.report_by ? ` · 报告提交者：@${project.report_by}` : ''}`,
            '### 参与者', renderContributors(contributors),
            `### Todo（${todoProgress(todos).text}）`, renderTodos(todos),
            `### 最近开发脉络（${limit} 条）`, renderTimeline(timeline),
        ];
        if (project.report) parts.push('### 验收报告', project.report);
        return textResult(parts.join('\n'), { command: 'GetProject', project, todos, stats, timeline });
    }
    async function updateTodos(args) {
        const { project } = await projectOf(args);
        const maid = maidOf(args);
        const changes = [];
        const titles = A.list(A.pick(args, 'add'));
        if (titles.length) { await store().addTodos(project.id, titles, maid); changes.push(`新增 ${titles.length} 项`); }
        const seqs = key => A.list(A.pick(args, key)).map(v => Number(String(v).replace(/^#/, '')));
        const missing = [];
        for (const status of ['done', 'doing', 'pending', 'blocked']) {
            for (const seq of seqs(status)) {
                if (await store().updateTodo(project.id, seq, { status, updatedBy: maid })) changes.push(`#${seq}→${status}`);
                else missing.push(seq);
            }
        }
        for (const seq of seqs('remove')) {
            if (await store().removeTodo(project.id, seq)) changes.push(`删除 #${seq}`);
            else missing.push(seq);
        }
        const seq = A.pick(args, 'seq');
        if (seq !== undefined) {
            const patch = { updatedBy: maid };
            if (A.pick(args, 'title') !== undefined) patch.title = A.str(args, 'title');
            if (A.pick(args, 'note') !== undefined) patch.note = A.str(args, 'note');
            if (await store().updateTodo(project.id, Number(seq), patch)) changes.push(`#${seq} 已更新`);
            else missing.push(seq);
        }
        if (!changes.length && !missing.length) {
            throw new Error(`${P} UpdateTodos 没有任何操作。可用参数：add、done/doing/pending/blocked/remove、seq + title/note。`);
        }
        await store().touchProject(project.id);
        const todos = await store().listTodos(project.id);
        return textResult([
            `## Todo 已更新 · ${project.name}（\`${project.id}\`）`,
            `- 变更：${changes.join('，') || '无'}`,
            missing.length ? `- ⚠️ 未找到的序号：${[...new Set(missing)].join('、')}` : '',
            `### Todo（${todoProgress(todos).text}）`, renderTodos(todos),
        ].filter(Boolean).join('\n'), { command: 'UpdateTodos', todos });
    }
    async function submitReport(args) {
        const { project, rootInfo } = await projectOf(args);
        const conclusion = A.str(args, 'conclusion', 'summary', 'report');
        if (!conclusion) throw new Error(`${P} SubmitReport 需要 conclusion（验收结论）。`);
        const status = (A.str(args, 'status') || 'review').toLowerCase();
        if (!['review', 'accepted', 'active'].includes(status)) throw new Error(`${P} status 只能是 review、accepted 或 active。`);
        const todos = await store().listTodos(project.id);
        const files = await store().changedFiles(project.id);
        const stats = await store().projectStats(project.id);
        const contributors = await store().contributors(project.id);
        const history = await store().exportHistory(project.id);
        const issues = A.str(args, 'issues');
        const maid = maidOf(args);
        const report = [
            `# 验收报告：${project.name}（${project.id}）`,
            `- 生成时间：${fmtTime(new Date().toISOString())} · 状态：${status} · 提交者：${whoOf(maid)}`,
            `- 根目录：${rootInfo.root}`,
            `- 改动统计：${stats.nodeCount} 个节点 · ${stats.fileCount} 个文件 · +${stats.added}/-${stats.removed}`,
            `## Todo 完成情况（${todoProgress(todos).text}）`, renderTodos(todos),
            `## 改动文件（${files.length}）`,
            files.length ? `| 文件 | 改动次数 | 增删 |\n|---|---|---|\n${files.map(f => `| \`${f.file_path}\` | ${f.edits} | +${f.added}/-${f.removed} |`).join('\n')}` : '- 无',
            '## 参与者', renderContributors(contributors),
            '## 开发脉络', renderTimeline(history),
            '## 结论', conclusion,
            '## 遗留问题', issues || '- 无',
        ].join('\n');
        await store().updateProject(project.id, { report, status, reportBy: maid });
        return textResult(report, { command: 'SubmitReport', projectId: project.id, status });
    }
    function projectIdsOf(args) {
        const ids = A.list(A.pick(args, 'projectIds', 'projectId', 'ids'));
        if (!ids.length) throw new Error(`${P} 需要 projectIds（多个用逗号或换行分隔）。`);
        return [...new Set(ids)];
    }
    async function deleteProjects(args) {
        const ids = projectIdsOf(args);
        const done = await store().softDeleteProjects(ids, maidOf(args));
        const skipped = ids.filter(id => !done.includes(id));
        return textResult([
            '## 工程已删除（仅数据库记录）',
            `- 已删除：${done.map(id => `\`${id}\``).join('、') || '无'}`,
            skipped.length ? `- 未找到或已删除：${skipped.join('、')}` : '',
            '- 磁盘上的任何文件都未改动。可用 RestoreProjects 恢复；PurgeProjects 可永久清除记录与历史快照。',
        ].filter(Boolean).join('\n'), { command: 'DeleteProjects', deleted: done, skipped });
    }
    async function restoreProjects(args) {
        const ids = projectIdsOf(args);
        const done = await store().restoreProjects(ids);
        return textResult(`## 工程已恢复\n- ${done.map(id => `\`${id}\``).join('、') || '无（需先被 DeleteProjects 删除）'}`, { command: 'RestoreProjects', restored: done });
    }
    async function purgeProjects(args) {
        const ids = projectIdsOf(args);
        if (!A.bool(A.pick(args, 'confirm'), false)) {
            throw new Error(`${P} PurgeProjects 会永久清除工程记录、todo、报告与全部历史快照（无法回退），需要 confirm=true。磁盘文件不受影响。`);
        }
        const notDeleted = [];
        for (const id of ids) {
            const project = await store().getProject(id, { includeDeleted: true });
            if (project && !project.deleted_at) notDeleted.push(id);
        }
        if (notDeleted.length) throw new Error(`${P} 以下工程尚未删除：${notDeleted.join('、')}。请先 DeleteProjects，再 PurgeProjects。`);
        const { purged, freedBlobs } = await store().purgeProjects(ids);
        return textResult(`## 工程已永久清除（仅数据库）\n- 已清除：${purged.map(id => `\`${id}\``).join('、') || '无'}\n- 回收快照：${freedBlobs} 个\n- 磁盘文件未改动。`, { command: 'PurgeProjects', purged, freedBlobs });
    }

    async function searchHistory(args) {
        const projectId = A.str(args, 'projectId', 'project');
        if (projectId && !await store().getProject(projectId)) throw new Error(`${P} 工程 ${projectId} 不存在。`);
        const glob = A.str(args, 'file', 'path', 'glob');
        const todoRaw = A.pick(args, 'todo');
        let todoId = null;
        if (todoRaw !== undefined) {
            if (!projectId) throw new Error(`${P} 按 todo 过滤时需要 projectId。`);
            todoId = (await store().getTodoBySeq(projectId, Number(String(todoRaw).replace(/^#/, ''))))?.id ?? -1;
        }
        const contentKw = A.str(args, 'content');
        const limit = posInt(A.pick(args, 'limit'), 30);
        let rows = await store().searchNodes({
            projectId: projectId || null,
            filePattern: glob ? glob.replace(/\\/g, '/').replace(/\*\*\/?/g, '%').replace(/\*/g, '%').replace(/\?/g, '_') : null,
            since: A.str(args, 'since') || null,
            until: A.str(args, 'until') || null,
            todoId,
            op: A.str(args, 'op') || null,
            batchId: A.pick(args, 'batch') !== undefined ? idNum(A.pick(args, 'batch'), 'b', 'batch') : null,
            maid: A.str(args, 'byMaid', 'author') || null,
            keyword: A.str(args, 'keyword', 'query') || null,
            limit: contentKw ? 500 : limit,
        });
        if (contentKw) {
            const filtered = [];
            for (const row of rows) {
                const text = await blobText(row.after_hash);
                if (text !== null && text.includes(contentKw)) filtered.push(row);
                if (filtered.length >= limit) break;
            }
            rows = filtered;
        }
        const lines = rows.map(r => `- \`n${r.id}\` · \`b${r.batch_id}\`${projectId ? '' : ` · \`${r.project_id}\``} · ${whoOf(r.maid, r.batch_kind)} · ${r.op} · \`${r.file_path}\` · +${r.added}/-${r.removed} · ${fmtTime(r.created_at)}\n  - ${r.effective_reason || r.summary || '（未记录原因）'}`);
        return textResult(`## 改动历史（${rows.length} 条）\n${lines.join('\n') || '- 没有匹配的记录。'}\n- 查看具体改动：GetNodeDiff node=nX 或 batch=bX`, { command: 'SearchHistory', count: rows.length, nodes: rows });
    }
    const DIFF_TRUNCATION_NOTE = (total, shown) => `... [diff 已截断，共 ${total} 行，仅显示前 ${shown} 行]`;

    /**
     * 直接由 Rust 只读池按有界预算计算前后快照 unified diff，不再把完整快照拉回 JS 重算。
     */
    async function nativeNodeDiff(beforeHash, afterHash, options = {}) {
        const maxLines = Number.isFinite(options.maxLines) && options.maxLines > 0 ? Math.floor(options.maxLines) : 400;
        const diff = await store().diffBlobs({
            beforeHash,
            afterHash,
            oldLabel: options.oldLabel || 'a',
            newLabel: options.newLabel || 'b',
            context: options.context ?? 3,
            maxLines,
            maxBytes: options.maxBytes,
        });
        if (diff.binary) return null;
        const text = diff.truncated && diff.omittedLines > 0 && diff.text
            ? `${diff.text}\n${DIFF_TRUNCATION_NOTE(diff.totalLines, diff.shownLines)}`
            : diff.text;
        return { ...diff, text };
    }

    async function getNodeDiff(args) {
        const { project } = await projectOf(args);
        let nodes;
        let title;
        const nodeRef = A.pick(args, 'node', 'nodeId');
        const batchRef = A.pick(args, 'batch', 'batchId');
        if (nodeRef !== undefined) {
            const node = await store().getNode(project.id, idNum(nodeRef, 'n', 'node'));
            if (!node) throw new Error(`${P} 节点 ${nodeRef} 不存在。`);
            nodes = [node]; title = `节点 n${node.id}`;
        } else if (batchRef !== undefined) {
            const batch = await store().getBatch(project.id, idNum(batchRef, 'b', 'batch'));
            if (!batch) throw new Error(`${P} 批次 ${batchRef} 不存在。`);
            nodes = await store().getBatchNodes(project.id, batch.id);
            title = `批次 b${batch.id} · ${batch.reason || batch.kind}`;
        } else {
            throw new Error(`${P} GetNodeDiff 需要 node（nX）或 batch（bX）。`);
        }
        const maxLines = posInt(A.pick(args, 'maxLines'), 400);
        const blocks = [];
        const diffs = [];
        for (const node of nodes) {
            const head = `### \`n${node.id}\` · ${node.op} · \`${node.file_path}\` · ${fmtTime(node.created_at)}${node.reason ? `\n- ${node.reason}` : ''}`;
            const diff = await nativeNodeDiff(node.before_hash, node.after_hash, {
                oldLabel: `a/${node.file_path}`,
                newLabel: `b/${node.file_path}`,
                maxLines,
            });
            if (diff === null) { blocks.push(`${head}\n- 二进制内容，省略 diff。`); continue; }
            diffs.push({
                nodeId: node.id, filePath: node.file_path,
                truncated: diff.truncated, totalLines: diff.totalLines,
                shownLines: diff.shownLines, omittedLines: diff.omittedLines,
                hunksTotal: diff.hunksTotal, hunksShown: diff.hunksShown,
                truncationReason: diff.truncationReason,
            });
            blocks.push(`${head}\n${diff.text ? T.markdownFence(diff.text, 'diff') : '- 内容无差异'}`);
            if (diff.truncated) blocks.push(`- ⚠️ diff 已截断：共 ${diff.totalLines} 行，显示 ${diff.shownLines} 行，省略 ${diff.omittedLines} 行（reason=${diff.truncationReason || 'max_lines'}，maxLines=${maxLines}）。`);
        }
        const truncated = diffs.some(item => item.truncated);
        const totalLines = diffs.reduce((sum, item) => sum + item.totalLines, 0);
        const shownLines = diffs.reduce((sum, item) => sum + item.shownLines, 0);
        const omittedLines = diffs.reduce((sum, item) => sum + item.omittedLines, 0);
        const nearest = diffs.find(item => item.truncated) || null;
        return textResult(`## ${title}\n${blocks.join('\n\n')}`, {
            command: 'GetNodeDiff', count: nodes.length,
            truncated, totalLines, shownLines, omittedLines,
            truncationReason: nearest ? nearest.truncationReason : null,
            diffs,
        });
    }

    function assertWritableRequest(ctx, request) {
        const params = request.params;
        const values = [];
        if (params.filePath) {
            if (Array.isArray(params.filePath)) values.push(...params.filePath);
            else values.push(params.filePath);
        }
        if (Array.isArray(params.paths)) values.push(...params.paths);
        if (params.from) values.push(params.from);
        if (params.to) values.push(params.to);
        for (const value of values) fileOf(ctx, value, { write: true });
    }
    async function runFileCommand(command, args) {
        const isRollback = String(command).toLowerCase() === 'rollback';
        const reason = isRollback
            ? (A.str(args, 'reason') || '回退到历史快照')
            : A.requireReason(args, command);
        const ctx = await projectOf(args, { write: true });
        const maid = maidOf(args);
        let todo = { value: undefined, todo: null };
        if (!isRollback) todo = await todoOf(ctx.project, args);
        const operationId = A.str(args, 'operationId') || newOperationId();
        const request = nativeFiles.buildFileRequest(command, {
            operationId, projectId: ctx.project.id, reason, maid, todo: todo.value,
        }, args);
        assertWritableRequest(ctx, request);
        const result = await clientRequest(request.method, request.params);
        const rendered = nativeFiles.renderFileResult(command, result, {
            projectId: ctx.project.id, operationId, reason, maid, params: request.params,
        });
        return textResult(rendered.text, rendered.details);
    }
    async function committedDiff(result, projectId) {
        if (result.status !== 'ok' || !result.nodeId || !projectId) return null;
        const node = await store().getNode(projectId, result.nodeId);
        if (!node) return null;
        return nativeNodeDiff(node.before_hash, node.after_hash, {
            oldLabel: `a/${node.file_path}`,
            newLabel: `b/${node.file_path}`,
            maxLines: 400,
        });
    }
    function mergeDiffDetails(details, diff) {
        if (!diff) return details;
        return {
            ...details,
            diff: {
                truncated: diff.truncated, totalLines: diff.totalLines,
                shownLines: diff.shownLines, omittedLines: diff.omittedLines,
                hunksTotal: diff.hunksTotal, hunksShown: diff.hunksShown,
                truncationReason: diff.truncationReason,
            },
        };
    }
    async function editCode(args) {
        const reason = A.requireReason(args, 'EditCode');
        const ctx = await projectOf(args, { write: true });
        const rawPath = A.str(args, 'path', 'file', 'filePath');
        const parsed = SR.splitPathSymbol(rawPath);
        if (!parsed.path) throw new Error(`${P} EditCode 需要 path。`);
        const file = fileOf(ctx, parsed.path, { write: true });
        const maid = maidOf(args);
        const todo = await todoOf(ctx.project, args);
        const operationId = A.str(args, 'operationId') || newOperationId();
        const request = nativeEdit.buildEditRequest({
            projectId: ctx.project.id, filePath: rawPath, reason, maid, todo: todo.value, operationId,
        }, args);
        const result = await clientRequest(request.method, request.params);
        const diff = await committedDiff(result, ctx.project.id);
        const rendered = nativeEdit.renderEditResult(result, {
            command: 'EditCode', projectId: ctx.project.id, filePath: result.filePath || file.rel,
            reason, maid, operationId, steps: request.params.steps,
            diff,
        });
        return textResult(rendered.result, mergeDiffDetails(rendered.details, diff));
    }
    async function resolveEdit(args) {
        const maid = maidOf(args);
        const operationId = A.str(args, 'operationId') || newOperationId();
        const request = nativeEdit.buildResolveRequest(args, operationId);
        if (maid) request.params.maid = maid;
        const result = await clientRequest(request.method, request.params);
        const resolvedProjectId = result.projectId || A.str(args, 'projectId');
        const diff = await committedDiff(result, resolvedProjectId);
        const rendered = nativeEdit.renderEditResult(result, {
            command: 'ResolveEdit', projectId: resolvedProjectId,
            filePath: result.filePath || '', reason: result.reason ?? A.str(args, 'reason'), maid: maid || request.params.maid, operationId,
            diff,
        });
        return textResult(rendered.result, mergeDiffDetails(rendered.details, diff));
    }

    const COMMANDS = {
        listworkspaces: listWorkspaces,
        createproject: createProject,
        listprojects: listProjects,
        searchprojects: searchProjects,
        getproject: getProject,
        updatetodos: updateTodos,
        submitreport: submitReport,
        deleteprojects: deleteProjects,
        restoreprojects: restoreProjects,
        purgeprojects: purgeProjects,
        readcode: readCode,
        editcode: editCode,
        resolveedit: resolveEdit,
        createfile: args => runFileCommand('CreateFile', args),
        removefile: args => runFileCommand('RemoveFile', args),
        movefile: args => runFileCommand('MoveFile', args),
        movecode: args => runFileCommand('MoveCode', args),
        copycode: args => runFileCommand('CopyCode', args),
        rollback: args => runFileCommand('Rollback', args),
        searchhistory: searchHistory,
        getnodediff: getNodeDiff,
        outline: outlineCmd,
        findsymbol: findSymbolCmd,
        trace: traceCmd,
        evalsymbol: evalSymbolCmd,
    };
    const COMMAND_NAMES = 'ListWorkspaces、CreateProject、ListProjects、SearchProjects、GetProject、UpdateTodos、SubmitReport、DeleteProjects、RestoreProjects、PurgeProjects、ReadCode、EditCode、ResolveEdit、CreateFile、RemoveFile、MoveFile、MoveCode、CopyCode、Rollback、SearchHistory、GetNodeDiff、Outline、FindSymbol、Trace、EvalSymbol';

    async function processToolCall(rawArgs = {}) {
        if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) throw new Error(`${P} 无效的工具参数。`);
        const args = A.lowerKeys(rawArgs);
        const command = A.str(args, 'command', 'action').toLowerCase();
        const handler = COMMANDS[command];
        if (!handler) throw new Error(`${P} 不支持的 command“${command || '(空)'}”。可用：${COMMAND_NAMES}。`);
        const result = await handler(args);
        if (MUTATING_COMMANDS.has(command)) {
            const affectedIds = result?.details?.deleted || result?.details?.restored || result?.details?.purged || null;
            emitProjectChanged({
                action: command,
                projectId: result?.details?.projectId || result?.details?.project?.id || args.projectid || (Array.isArray(affectedIds) && affectedIds.length === 1 ? affectedIds[0] : null),
                projectIds: Array.isArray(affectedIds) ? affectedIds : null,
                details: result?.details || null,
            });
        }
        return result;
    }

    function guiProjectSummary(project, rootInfo) {
        const total = Number(project.todo_total) || 0;
        const done = Number(project.todo_done) || 0;
        return {
            ...project,
            report: undefined,
            hasReport: Boolean(project.report),
            rootInfo,
            progress: { done, total, text: total ? `${done}/${total}` : '无' },
            stats: {
                nodeCount: Number(project.node_count) || 0,
                fileCount: Number(project.file_count) || 0,
                added: Number(project.added) || 0,
                removed: Number(project.removed) || 0,
                lastAt: project.last_at || null,
            },
            maids: Array.isArray(project.maids) ? project.maids.map(maid => maid || null) : [],
        };
    }
    function summaryWithAggregates(project, todos, stats, contributors) {
        return guiProjectSummary({
            ...project,
            todo_total: todos.length,
            todo_done: todos.filter(todo => todo.status === 'done').length,
            node_count: stats.nodeCount || 0,
            file_count: stats.fileCount || 0,
            added: stats.added || 0,
            removed: stats.removed || 0,
            last_at: stats.lastAt || null,
            maids: contributors.map(item => item.maid || null),
        }, runtime.resolver.projectRoot(project));
    }
    async function guiProjectOf(projectId) {
        const id = String(projectId || '').trim();
        const project = await store().getProject(id, { includeDeleted: true });
        if (!project) throw new Error(`${P} 工程 ${id || '(空)'} 不存在。`);
        return project;
    }
    async function timelineOf(projectId, { limit = 100, beforeBatch = null } = {}) {
        const project = await guiProjectOf(String(projectId || '').trim());
        const pageSize = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 100);
        const cursor = beforeBatch === null ? null : Number(beforeBatch);
        if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor <= 0)) throw new Error('非法脉络游标。');
        const rows = await store().timeline(project.id, { limit: pageSize + 1, beforeBatch: cursor });
        return {
            timeline: rows.slice(0, pageSize).map(row => ({ ...row, files: String(row.files || '').split(',').filter(Boolean) })),
            timelineHasMore: rows.length > pageSize,
            timelineBeforeBatch: rows.slice(0, pageSize).at(-1)?.id || null,
        };
    }
    async function guiSearchHistory(filters = {}) {
        const contentKw = String(filters.content || '').trim();
        const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
        const glob = String(filters.file || '').trim();
        let rows = await store().searchNodes({
            projectId: filters.projectId || null,
            filePattern: glob ? `%${glob.replace(/\\/g, '/').replace(/\*/g, '%').replace(/\?/g, '_')}%` : null,
            op: filters.op || null,
            batchId: filters.batchId ? Number(filters.batchId) : null,
            maid: String(filters.byMaid || '').trim() || null,
            keyword: String(filters.keyword || '').trim() || null,
            since: filters.since || null,
            until: filters.until || null,
            limit: contentKw ? 500 : limit,
        });
        if (contentKw) {
            const filtered = [];
            for (const row of rows) {
                const text = await blobText(row.after_hash);
                if (text !== null && text.includes(contentKw)) filtered.push(row);
                if (filtered.length >= limit) break;
            }
            rows = filtered;
        }
        return rows;
    }

    const gui = {
        async listProjects({ includeDeleted = false, query = '' } = {}) {
            const page = await store().listAllProjectSummaries({
                includeDeleted: Boolean(includeDeleted),
                query: String(query || '').trim() || null,
            });
            return page.items.map(project => guiProjectSummary(project, runtime.resolver.projectRoot(project)));
        },
        async exportReport(projectId) {
            const id = String(projectId || '').trim();
            await guiProjectOf(id);
            const snapshot = await store().exportSnapshot(id);
            const contributors = await store().contributors(id);
            return {
                filename: reportFilename(snapshot.project),
                markdown: buildReport({
                    project: snapshot.project,
                    todos: snapshot.todos,
                    contributors,
                    batches: snapshot.history,
                }),
            };
        },
        async getProject(projectId, { timelineLimit = 100 } = {}) {
            const id = String(projectId || '').trim();
            const project = await guiProjectOf(id);
            const todos = await store().listTodos(project.id);
            const contributors = await store().contributors(project.id);
            const files = await store().changedFiles(project.id);
            const stats = await store().projectStats(project.id);
            const summary = summaryWithAggregates(project, todos, stats, contributors);
            return {
                project: { ...summary, report: project.report || null },
                todos,
                contributors,
                files,
                ...await timelineOf(project.id, { limit: timelineLimit }),
            };
        },
        async getTimeline(projectId, options = {}) {
            return timelineOf(projectId, options || {});
        },
        async searchHistory(filters = {}) {
            return guiSearchHistory(filters || {});
        },
        async getBatchNodes(projectId, batchId) {
            const id = String(projectId || '').trim();
            const batch = await store().getBatch(id, Number(batchId));
            if (!batch) throw new Error(`${P} 批次 b${batchId} 不存在。`);
            return { batch, nodes: await store().getBatchNodes(id, batch.id) };
        },
        async getNodeDetail(projectId, nodeId) {
            const id = String(projectId || '').trim();
            const node = await store().getNode(id, Number(nodeId));
            if (!node) throw new Error(`${P} 节点 n${nodeId} 不存在。`);
            const batch = node.batch_id ? await store().getBatch(id, node.batch_id) : null;
            const todos = node.todo_id ? await store().listTodos(id) : [];
            const before = await guiBlobText(node.before_hash);
            const after = await guiBlobText(node.after_hash);
            const laterChanges = (await store().nodesAfter(id, node.id, node.file_path)).length;
            return {
                node,
                batch,
                todo: node.todo_id ? todos.find(todo => todo.id === node.todo_id) || null : null,
                before,
                after,
                laterChanges,
            };
        },
        async revertFileChange({ projectId, nodeId, mode = 'before', signature, reason = '', dryRun = false, force = false, expectedHash } = {}) {
            const maid = String(signature || '').trim().slice(0, 100);
            if (!maid) throw new Error(`${P} 回退需要署名。`);
            if (expectedHash !== undefined && expectedHash !== null
                && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))) {
                throw new Error(`${P} 回退预检的文件 hash 无效，请重新预检。`);
            }
            const ctx = await projectOf({ projectid: projectId }, { write: true });
            const node = await store().getNode(ctx.project.id, Number(nodeId));
            if (!node) throw new Error(`${P} 节点 n${nodeId} 不存在。`);
            // 只做路径授权，不读磁盘、不自行判断 conflict/noop；权威预检在 Rust file.execute。
            fileOf(ctx, node.file_path, { write: true });
            const normalizedMode = mode === 'after' ? 'after' : 'before';
            const label = `${normalizedMode === 'after' ? '恢复到' : '撤销'}节点 n${node.id} · ${node.file_path}（GUI 人工回退）`;
            const params = {
                operationId: newOperationId(),
                projectId: ctx.project.id,
                kind: 'revertFile',
                nodeId: node.id,
                mode: normalizedMode,
                reason: String(reason || '').trim().slice(0, 500) || label,
                maid,
                dryRun: Boolean(dryRun),
                force: Boolean(force),
            };
            // 旧 GUI 的 expectedHash 语义：undefined=未预检，null=预检时文件不存在；null 必须保留。
            if (expectedHash !== undefined) params.expectedHash = expectedHash;
            const result = await clientRequest('file.execute', params);
            const value = result && typeof result === 'object' ? result : { status: 'unknown', value: result };
            const changes = Array.isArray(value.changes) ? value.changes : [];
            const first = changes[0] || {};
            const conflictDetails = Array.isArray(value.conflicts) ? value.conflicts : [];
            const conflicts = conflictDetails.flatMap(item => {
                if (typeof item === 'string') return [item];
                if (Array.isArray(item?.reasons)) return item.reasons.map(String);
                return item?.reason ? [String(item.reason)] : [];
            });
            const hasAfter = Object.prototype.hasOwnProperty.call(first, 'afterHash');
            const hasBefore = Object.prototype.hasOwnProperty.call(first, 'beforeHash');
            const target = (normalizedMode === 'after' ? node.after_hash : node.before_hash) ?? null;
            let action = first.action || value.action;
            if (!action) {
                if (hasAfter) action = first.afterHash === null ? '删除（履历可回退）' : (first.beforeHash === null ? '重建文件' : '恢复内容');
                else if (value.status === 'ok') {
                    const file = Array.isArray(value.files) ? value.files[0] : null;
                    action = file && (file.op === 'delete' || file.afterHash === null) ? '删除（履历可回退）' : '恢复内容';
                } else action = target === null ? '删除（履历可回退）' : '恢复内容';
            }
            const status = value.status === 'unchanged' ? 'noop' : (value.status || value.state || 'unknown');
            const expected = hasBefore ? first.beforeHash : (Object.prototype.hasOwnProperty.call(value, 'expectedHash') ? value.expectedHash : undefined);
            const mapped = {
                ...value,
                status,
                label: first.summary || value.label || label,
                file: first.filePath || value.filePath || node.file_path,
                action,
                conflicts,
                conflictDetails,
                changes,
                mode: normalizedMode,
                nodeId: value.nodeId ?? (Array.isArray(value.nodeIds) ? value.nodeIds[0] : undefined),
                expectedHash: expected,
                maid: value.maid ?? maid,
            };
            emitProjectChanged({ action: 'gui:revert', projectId: ctx.project.id, batchId: mapped.batchId || null, nodeId: mapped.nodeId || null, maid });
            return mapped;
        },
        async acceptProject(projectId, signature = '') {
            const id = String(projectId || '').trim();
            const project = await guiProjectOf(id);
            if (project.deleted_at) throw new Error(`${P} 已删除工程不能验收。`);
            if (project.status === 'accepted') return { accepted: true, projectId: id };
            if (project.status !== 'review') throw new Error(`${P} 只有待验收工程可以手动验收，请刷新列表。`);
            const user = String(signature || '').trim() || '用户';
            const record = `## 用户手动验收\n\n已由用户手动验收该工程。\n\n署名：${user} · 时间：${new Date().toISOString()}`;
            await store().updateProject(id, {
                status: 'accepted',
                report: [project.report, record].filter(Boolean).join('\n\n---\n\n'),
            }, { touch: false });
            emitProjectChanged({ action: 'gui:accept', projectId: id, maid: user });
            return { accepted: true, projectId: id };
        },
        async deleteProject(projectId, maid = '') {
            const id = String(projectId || '').trim();
            if (!id) throw new Error(`${P} 删除工程需要指定 projectId。`);
            const done = await store().softDeleteProjects([id], String(maid || '').trim());
            emitProjectChanged({ action: 'gui:delete', projectId: id, maid: maid || null });
            return { deleted: done.includes(id), projectId: id };
        },
    };

    return { processToolCall, gui, runtime };
}

module.exports = { createNativeService };
