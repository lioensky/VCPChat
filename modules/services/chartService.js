'use strict';

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CHART_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const ALLOWED_LIBRARIES = new Set(['anime', 'three', 'pixi']);
const SOURCE_FILES = Object.freeze({
    manifest: 'chart.json',
    template: 'template.html',
    style: 'style.css',
    runtime: 'runtime.js',
    data: 'data.json',
});
const SOURCE_LIMITS = Object.freeze({
    manifest: 128 * 1024,
    template: 256 * 1024,
    style: 256 * 1024,
    runtime: 512 * 1024,
    data: 2 * 1024 * 1024,
});
const MAX_OPERATIONS = 100;
const MAX_JSON_DEPTH = 32;
const MAX_HISTORY_VERSIONS = 20;

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function byteLength(value) {
    return Buffer.byteLength(String(value), 'utf8');
}

function nowIso() {
    return new Date().toISOString();
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function createError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function normalizeChartId(value) {
    const chartId = String(value || '').trim().toLowerCase();
    if (!CHART_ID_PATTERN.test(chartId)) {
        throw createError(
            'chartId 必须为 2-64 位小写字母、数字、短横线或下划线，并以字母或数字开头。',
            'CHART_INVALID_ID'
        );
    }
    return chartId;
}

function parseObject(value, fieldName, fallback = undefined) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object' && !Array.isArray(value)) return clone(value);
    if (typeof value !== 'string') {
        throw createError(`${fieldName} 必须是 JSON 对象。`, 'CHART_INVALID_JSON');
    }
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('根值不是对象');
        }
        return parsed;
    } catch (error) {
        throw createError(`${fieldName} 不是有效的 JSON 对象：${error.message}`, 'CHART_INVALID_JSON');
    }
}

function parseJsonValue(value, fieldName = 'value') {
    if (typeof value !== 'string') return clone(value);
    const trimmed = value.trim();
    if (!trimmed) return value;
    try {
        return JSON.parse(trimmed);
    } catch (_error) {
        return value;
    }
}

function assertJsonDepth(value, maxDepth = MAX_JSON_DEPTH, depth = 0) {
    if (depth > maxDepth) {
        throw createError(`数据 JSON 深度超过限制 ${maxDepth}。`, 'CHART_DATA_TOO_DEEP');
    }
    if (Array.isArray(value)) {
        value.forEach(item => assertJsonDepth(item, maxDepth, depth + 1));
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(item => assertJsonDepth(item, maxDepth, depth + 1));
    }
}

function decodePointerToken(token) {
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(pointer) {
    if (pointer === '' || pointer === undefined || pointer === null) return [];
    if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
        throw createError(`无效 JSON Pointer：${pointer}`, 'CHART_INVALID_DATA_PATH');
    }
    return pointer.slice(1).split('/').map(decodePointerToken);
}

function getAtPointer(root, pointer) {
    const tokens = parsePointer(pointer);
    let current = root;
    for (const token of tokens) {
        if (current === null || current === undefined || typeof current !== 'object') {
            throw createError(`数据路径不存在：${pointer}`, 'CHART_DATA_PATH_NOT_FOUND');
        }
        const key = Array.isArray(current) ? normalizeArrayIndex(token, current, false) : token;
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
            throw createError(`数据路径不存在：${pointer}`, 'CHART_DATA_PATH_NOT_FOUND');
        }
        current = current[key];
    }
    return current;
}

function normalizeArrayIndex(token, array, allowAppend) {
    if (allowAppend && token === '-') return array.length;
    if (!/^(0|[1-9]\d*)$/.test(token)) {
        throw createError(`无效数组索引：${token}`, 'CHART_INVALID_DATA_PATH');
    }
    const index = Number(token);
    if (!Number.isSafeInteger(index) || index < 0 || index > array.length || (!allowAppend && index >= array.length)) {
        throw createError(`数组索引越界：${token}`, 'CHART_DATA_PATH_NOT_FOUND');
    }
    return index;
}

function resolveParent(root, pointer, allowAppend = false) {
    const tokens = parsePointer(pointer);
    if (!tokens.length) return { parent: null, key: null };
    let parent = root;
    for (const token of tokens.slice(0, -1)) {
        if (!parent || typeof parent !== 'object') {
            throw createError(`数据路径不存在：${pointer}`, 'CHART_DATA_PATH_NOT_FOUND');
        }
        const key = Array.isArray(parent) ? normalizeArrayIndex(token, parent, false) : token;
        if (!Object.prototype.hasOwnProperty.call(parent, key)) {
            throw createError(`数据路径不存在：${pointer}`, 'CHART_DATA_PATH_NOT_FOUND');
        }
        parent = parent[key];
    }
    const finalToken = tokens[tokens.length - 1];
    const key = Array.isArray(parent)
        ? normalizeArrayIndex(finalToken, parent, allowAppend)
        : finalToken;
    return { parent, key };
}

function setAtPointer(root, pointer, value, mode = 'replace') {
    if (pointer === '' || pointer === undefined || pointer === null) return clone(value);
    const { parent, key } = resolveParent(root, pointer, mode === 'add');
    if (!parent || typeof parent !== 'object') {
        throw createError(`数据路径不存在：${pointer}`, 'CHART_DATA_PATH_NOT_FOUND');
    }
    if (Array.isArray(parent)) {
        if (mode === 'add') parent.splice(key, 0, clone(value));
        else {
            if (key >= parent.length) {
                throw createError(`数据路径不存在：${pointer}`, 'CHART_DATA_PATH_NOT_FOUND');
            }
            parent[key] = clone(value);
        }
    } else {
        if (mode === 'replace' && !Object.prototype.hasOwnProperty.call(parent, key)) {
            throw createError(`数据路径不存在：${pointer}`, 'CHART_DATA_PATH_NOT_FOUND');
        }
        parent[key] = clone(value);
    }
    return root;
}

function removeAtPointer(root, pointer) {
    if (!pointer) {
        throw createError('不允许删除数据根节点。', 'CHART_INVALID_DATA_PATH');
    }
    const { parent, key } = resolveParent(root, pointer, false);
    if (!parent || !Object.prototype.hasOwnProperty.call(parent, key)) {
        throw createError(`数据路径不存在：${pointer}`, 'CHART_DATA_PATH_NOT_FOUND');
    }
    const oldValue = clone(parent[key]);
    if (Array.isArray(parent)) parent.splice(key, 1);
    else delete parent[key];
    return oldValue;
}

function deepMerge(target, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
    const result = target && typeof target === 'object' && !Array.isArray(target) ? clone(target) : {};
    for (const [key, value] of Object.entries(patch)) {
        result[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? deepMerge(result[key], value)
            : clone(value);
    }
    return result;
}

function applyDataOperation(root, rawOperation) {
    const operation = { ...rawOperation };
    const op = String(operation.op || '').trim().toLowerCase();
    const pointer = operation.path ?? '';
    const value = parseJsonValue(operation.value);
    switch (op) {
        case 'test':
            if (JSON.stringify(getAtPointer(root, pointer)) !== JSON.stringify(value)) {
                throw createError(`test 操作失败：${pointer}`, 'CHART_DATA_TEST_FAILED');
            }
            return root;
        case 'add':
            return setAtPointer(root, pointer, value, 'add');
        case 'replace':
        case 'set':
            return setAtPointer(root, pointer, value, op === 'set' ? 'add' : 'replace');
        case 'remove':
            removeAtPointer(root, pointer);
            return root;
        case 'copy':
            return setAtPointer(root, pointer, getAtPointer(root, operation.from), 'add');
        case 'move': {
            const moved = removeAtPointer(root, operation.from);
            return setAtPointer(root, pointer, moved, 'add');
        }
        case 'append': {
            const target = getAtPointer(root, pointer);
            if (!Array.isArray(target)) {
                throw createError(`append 目标不是数组：${pointer}`, 'CHART_DATA_TYPE_MISMATCH');
            }
            if (Array.isArray(value) && operation.spread === true) target.push(...clone(value));
            else target.push(clone(value));
            const maxItems = Number(operation.maxItems);
            if (Number.isInteger(maxItems) && maxItems >= 0 && target.length > maxItems) {
                target.splice(0, target.length - maxItems);
            }
            return root;
        }
        case 'prepend': {
            const target = getAtPointer(root, pointer);
            if (!Array.isArray(target)) {
                throw createError(`prepend 目标不是数组：${pointer}`, 'CHART_DATA_TYPE_MISMATCH');
            }
            if (Array.isArray(value) && operation.spread === true) target.unshift(...clone(value));
            else target.unshift(clone(value));
            const maxItems = Number(operation.maxItems);
            if (Number.isInteger(maxItems) && maxItems >= 0 && target.length > maxItems) {
                target.splice(maxItems);
            }
            return root;
        }
        case 'splice': {
            const target = getAtPointer(root, pointer);
            if (!Array.isArray(target)) {
                throw createError(`splice 目标不是数组：${pointer}`, 'CHART_DATA_TYPE_MISMATCH');
            }
            const start = Number(operation.start);
            const deleteCount = Number(operation.deleteCount ?? 0);
            if (!Number.isInteger(start) || !Number.isInteger(deleteCount) || deleteCount < 0) {
                throw createError('splice 需要整数 start 和非负整数 deleteCount。', 'CHART_INVALID_OPERATION');
            }
            const items = Array.isArray(operation.items) ? clone(operation.items) : [];
            target.splice(start, deleteCount, ...items);
            return root;
        }
        case 'merge': {
            const current = getAtPointer(root, pointer);
            return setAtPointer(root, pointer, deepMerge(current, value), 'replace');
        }
        case 'increment': {
            const current = getAtPointer(root, pointer);
            const delta = Number(value ?? 1);
            if (typeof current !== 'number' || !Number.isFinite(delta)) {
                throw createError(`increment 目标和值必须是数字：${pointer}`, 'CHART_DATA_TYPE_MISMATCH');
            }
            return setAtPointer(root, pointer, current + delta, 'replace');
        }
        case 'toggle': {
            const current = getAtPointer(root, pointer);
            if (typeof current !== 'boolean') {
                throw createError(`toggle 目标必须是布尔值：${pointer}`, 'CHART_DATA_TYPE_MISMATCH');
            }
            return setAtPointer(root, pointer, !current, 'replace');
        }
        default:
            throw createError(`不支持的数据操作：${op || '(empty)'}`, 'CHART_INVALID_OPERATION');
    }
}

function detectLineEnding(content) {
    const crlf = (content.match(/\r\n/g) || []).length;
    const bareLf = (content.match(/(^|[^\r])\n/g) || []).length;
    const bareCr = (content.match(/\r(?!\n)/g) || []).length;
    if (crlf > bareLf && crlf >= bareCr) return '\r\n';
    if (bareCr > bareLf && bareCr > crlf) return '\r';
    return '\n';
}

function normalizeLineEndings(content) {
    return String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function restoreLineEndings(content, lineEnding) {
    if (lineEnding === '\n') return content;
    return content.replace(/\n/g, lineEnding);
}

function countOccurrences(content, target) {
    if (!target) return 0;
    let count = 0;
    let offset = 0;
    while ((offset = content.indexOf(target, offset)) !== -1) {
        count += 1;
        offset += Math.max(target.length, 1);
    }
    return count;
}

function validateSource(kind, content) {
    const diagnostics = [];
    const limit = SOURCE_LIMITS[kind];
    if (limit && byteLength(content) > limit) {
        throw createError(`${kind} 超过 ${limit} 字节限制。`, 'CHART_SOURCE_TOO_LARGE');
    }
    if (kind === 'runtime') {
        try {
            new Function(content);
        } catch (error) {
            throw createError(`runtime.js 语法错误：${error.message}`, 'CHART_RUNTIME_SYNTAX_ERROR');
        }
        if (!/\bupdate\s*[:=(]/.test(content)) {
            diagnostics.push({ level: 'warning', code: 'MISSING_UPDATE', message: '运行时未显式实现 update。' });
        }
        if (!/\bdestroy\s*[:=(]/.test(content)) {
            diagnostics.push({ level: 'warning', code: 'MISSING_DESTROY', message: '运行时未显式实现 destroy。' });
        }
    }
    if (kind === 'template') {
        if (/<script\b[^>]*\bsrc\s*=/i.test(content)) {
            throw createError('template.html 不允许声明外部 script src。', 'CHART_REMOTE_SCRIPT_FORBIDDEN');
        }
        if (/<(?:iframe|webview)\b/i.test(content)) {
            throw createError('template.html 不允许嵌套 iframe 或 webview。', 'CHART_EMBED_FORBIDDEN');
        }
    }
    return diagnostics;
}

function parseLineRange(content, linesSpec) {
    if (linesSpec === undefined || linesSpec === null || linesSpec === '') {
        return { content, lines: null };
    }
    const lines = normalizeLineEndings(content).split('\n');
    const requested = String(linesSpec).trim();
    let start;
    let end;
    let match;
    if ((match = requested.match(/^head:(\d+)$/i))) {
        start = 1;
        end = Number(match[1]);
    } else if ((match = requested.match(/^tail:(\d+)$/i))) {
        start = Math.max(1, lines.length - Number(match[1]) + 1);
        end = lines.length;
    } else if ((match = requested.match(/^(\d+)\s*[-:]\s*(\d+)$/))) {
        start = Number(match[1]);
        end = Number(match[2]);
    } else if ((match = requested.match(/^(\d+)$/))) {
        start = Number(match[1]);
        end = start;
    } else {
        throw createError(`无效行范围：${requested}`, 'CHART_INVALID_LINE_RANGE');
    }
    if (start < 1 || end < start) {
        throw createError(`无效行范围：${requested}`, 'CHART_INVALID_LINE_RANGE');
    }
    const actualStart = Math.min(start, lines.length);
    const actualEnd = Math.min(end, lines.length);
    return {
        content: lines.slice(actualStart - 1, actualEnd).join('\n'),
        lines: {
            requested,
            start,
            end,
            actualStart,
            actualEnd,
            totalLines: lines.length,
            selectedCount: Math.max(0, actualEnd - actualStart + 1),
        },
    };
}

class ChartService extends EventEmitter {
    constructor(options = {}) {
        super();
        this.root = path.resolve(options.appDataRoot || path.join(__dirname, '..', '..', 'AppData'), 'Charts');
        this.trashRoot = path.resolve(options.appDataRoot || path.join(__dirname, '..', '..', 'AppData'), 'ChartsTrash');
        this.logger = options.logger || console;
        this.windowAdapter = options.windowAdapter || null;
        this.dataSourceAdapter = options.dataSourceAdapter || null;
        this.queues = new Map();
        this.operationReceipts = new Map();
    }

    async initialize() {
        await fs.mkdir(this.root, { recursive: true });
        await fs.mkdir(this.trashRoot, { recursive: true });
        return this;
    }

    setWindowAdapter(adapter) {
        this.windowAdapter = adapter;
    }

    setDataSourceAdapter(adapter) {
        this.dataSourceAdapter = adapter;
    }

    async readDataSource(chartId, request = {}) {
        const manifest = await this.readManifest(chartId);
        if (!this.dataSourceAdapter?.read) {
            throw createError(
                '图表只读数据源服务当前不可用。',
                'CHART_DATA_SOURCE_UNAVAILABLE'
            );
        }
        return this.dataSourceAdapter.read({
            ...request,
            chartId: manifest.id,
        });
    }

    chartDir(chartId) {
        return path.join(this.root, normalizeChartId(chartId));
    }

    async exists(chartId) {
        try {
            const stat = await fs.stat(this.chartDir(chartId));
            return stat.isDirectory();
        } catch (_error) {
            return false;
        }
    }

    async atomicWrite(filePath, content) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporary, content, 'utf8');
        await fs.rename(temporary, filePath);
    }

    enqueue(chartId, task) {
        const key = normalizeChartId(chartId);
        const previous = this.queues.get(key) || Promise.resolve();
        const current = previous.catch(() => undefined).then(task);
        this.queues.set(key, current);
        current.finally(() => {
            if (this.queues.get(key) === current) this.queues.delete(key);
        }).catch(() => undefined);
        return current;
    }

    async readManifest(chartId) {
        const id = normalizeChartId(chartId);
        try {
            return JSON.parse(await fs.readFile(path.join(this.chartDir(id), SOURCE_FILES.manifest), 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw createError(`图表不存在：${id}`, 'CHART_NOT_FOUND');
            }
            throw error;
        }
    }

    async readData(chartId) {
        await this.readManifest(chartId);
        return JSON.parse(await fs.readFile(path.join(this.chartDir(chartId), SOURCE_FILES.data), 'utf8'));
    }

    async readSources(chartId) {
        const manifest = await this.readManifest(chartId);
        const dir = this.chartDir(chartId);
        const [template, style, runtime, data] = await Promise.all([
            fs.readFile(path.join(dir, SOURCE_FILES.template), 'utf8'),
            fs.readFile(path.join(dir, SOURCE_FILES.style), 'utf8'),
            fs.readFile(path.join(dir, SOURCE_FILES.runtime), 'utf8'),
            fs.readFile(path.join(dir, SOURCE_FILES.data), 'utf8'),
        ]);
        return { manifest, template, style, runtime, data: JSON.parse(data) };
    }

    async listCharts(options = {}) {
        await this.initialize();
        const query = String(options.query || '').trim().toLowerCase();
        const entries = await fs.readdir(this.root, { withFileTypes: true });
        const charts = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !CHART_ID_PATTERN.test(entry.name)) continue;
            try {
                const manifest = await this.readManifest(entry.name);
                if (query && !`${manifest.id} ${manifest.name} ${manifest.description || ''}`.toLowerCase().includes(query)) {
                    continue;
                }
                charts.push({
                    ...manifest,
                    opened: Boolean(this.windowAdapter?.isOpen?.(manifest.id)),
                });
            } catch (error) {
                this.logger.warn?.(`[ChartService] 跳过无效图表 ${entry.name}: ${error.message}`);
            }
        }
        return charts.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    normalizeManifest(input, existing = null, owner = null) {
        const id = normalizeChartId(input.id || existing?.id);
        const libraries = Array.isArray(input.libraries)
            ? [...new Set(input.libraries.map(String))]
            : existing?.libraries || [];
        for (const library of libraries) {
            if (!ALLOWED_LIBRARIES.has(library)) {
                throw createError(`不支持的图表依赖：${library}`, 'CHART_LIBRARY_NOT_ALLOWED');
            }
        }
        const width = Math.min(3840, Math.max(280, Number(input.window?.width ?? existing?.window?.width ?? 960)));
        const height = Math.min(2160, Math.max(180, Number(input.window?.height ?? existing?.window?.height ?? 640)));
        return {
            schemaVersion: 1,
            id,
            name: String(input.name || existing?.name || id).trim().slice(0, 120),
            description: String(input.description ?? existing?.description ?? '').trim().slice(0, 1000),
            revision: existing?.revision || 1,
            codeRevision: existing?.codeRevision || 1,
            dataRevision: existing?.dataRevision || 1,
            createdAt: existing?.createdAt || nowIso(),
            updatedAt: nowIso(),
            libraries,
            dataSources: Array.isArray(input.dataSources)
                ? clone(input.dataSources)
                : clone(existing?.dataSources || []),
            window: {
                width,
                height,
                alwaysOnTop: input.window?.alwaysOnTop ?? existing?.window?.alwaysOnTop ?? false,
                transparent: input.window?.transparent ?? existing?.window?.transparent ?? false,
            },
            owner: existing?.owner || owner || { scope: 'shared' },
            access: {
                scope: input.access?.scope || existing?.access?.scope || 'shared',
            },
        };
    }

    async createChart(input = {}, context = {}) {
        const parsedManifest = parseObject(input.manifest, 'manifest', input.manifest) || input;
        const id = normalizeChartId(parsedManifest.id || input.chartId);
        return this.enqueue(id, async () => {
            if (await this.exists(id)) {
                throw createError(`图表已存在：${id}`, 'CHART_ALREADY_EXISTS');
            }
            const owner = {
                agentId: context.vcpContext?.agentId || null,
                topicId: context.vcpContext?.topicId || null,
                scope: parsedManifest.access?.scope || 'shared',
            };
            const manifest = this.normalizeManifest({ ...parsedManifest, id }, null, owner);
            const template = String(input.template ?? '<div class="chart-root"></div>');
            const style = String(input.style ?? input.css ?? ':root, body { margin: 0; width: 100%; height: 100%; }');
            const runtime = String(input.runtime ?? input.js ?? 'return { mount() {}, update() {}, resize() {}, destroy() {} };');
            const data = parseObject(input.initialData ?? input.data, 'initialData', {}) || {};
            const diagnostics = [
                ...validateSource('template', template),
                ...validateSource('style', style),
                ...validateSource('runtime', runtime),
            ];
            assertJsonDepth(data);
            if (byteLength(JSON.stringify(data)) > SOURCE_LIMITS.data) {
                throw createError('初始数据超过大小限制。', 'CHART_SOURCE_TOO_LARGE');
            }
            const dir = this.chartDir(id);
            await fs.mkdir(dir, { recursive: false });
            try {
                await Promise.all([
                    this.atomicWrite(path.join(dir, SOURCE_FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`),
                    this.atomicWrite(path.join(dir, SOURCE_FILES.template), template),
                    this.atomicWrite(path.join(dir, SOURCE_FILES.style), style),
                    this.atomicWrite(path.join(dir, SOURCE_FILES.runtime), runtime),
                    this.atomicWrite(path.join(dir, SOURCE_FILES.data), `${JSON.stringify(data, null, 2)}\n`),
                ]);
            } catch (error) {
                await fs.rm(dir, { recursive: true, force: true });
                throw error;
            }
            this.emitChange('created', manifest, { diagnostics });
            if (input.open === true) await this.openChart(id);
            return { manifest, diagnostics, opened: input.open === true };
        });
    }

    assertRevision(actual, expected, type) {
        if (expected === undefined || expected === null || expected === '') return;
        const parsed = Number(expected);
        if (parsed !== actual) {
            throw createError(
                `${type} 版本冲突：期望 ${parsed}，实际 ${actual}。`,
                'CHART_REVISION_CONFLICT',
                { expected: parsed, actual, revisionType: type }
            );
        }
    }

    async applyDataOperations(chartId, operations, options = {}, context = {}) {
        const id = normalizeChartId(chartId);
        const normalizedOperations = Array.isArray(operations) ? operations.map(clone) : [];
        if (!normalizedOperations.length || normalizedOperations.length > MAX_OPERATIONS) {
            throw createError(`数据操作数量必须为 1-${MAX_OPERATIONS}。`, 'CHART_INVALID_OPERATION');
        }
        const operationId = String(options.operationId || '').trim();
        if (operationId && this.operationReceipts.has(operationId)) {
            return clone(this.operationReceipts.get(operationId));
        }
        return this.enqueue(id, async () => {
            const manifest = await this.readManifest(id);
            this.assertRevision(manifest.dataRevision, options.expectedDataRevision, 'dataRevision');
            this.assertRevision(manifest.revision, options.expectedRevision, 'revision');
            let data = await this.readData(id);
            for (const operation of normalizedOperations) {
                data = applyDataOperation(data, operation);
            }
            assertJsonDepth(data);
            const serialized = `${JSON.stringify(data, null, 2)}\n`;
            if (byteLength(serialized) > SOURCE_LIMITS.data) {
                throw createError('更新后的图表数据超过大小限制。', 'CHART_SOURCE_TOO_LARGE');
            }
            const oldDataRevision = manifest.dataRevision;
            manifest.dataRevision += 1;
            manifest.revision += 1;
            manifest.updatedAt = nowIso();
            await this.atomicWrite(path.join(this.chartDir(id), SOURCE_FILES.data), serialized);
            await this.atomicWrite(
                path.join(this.chartDir(id), SOURCE_FILES.manifest),
                `${JSON.stringify(manifest, null, 2)}\n`
            );
            const result = {
                chartId: id,
                revision: manifest.revision,
                oldDataRevision,
                dataRevision: manifest.dataRevision,
                operations: normalizedOperations,
                changedPaths: [...new Set(normalizedOperations.map(item => item.path || ''))],
                actor: context.vcpContext?.agentId || null,
            };
            if (operationId) {
                this.operationReceipts.set(operationId, clone(result));
                if (this.operationReceipts.size > 500) {
                    this.operationReceipts.delete(this.operationReceipts.keys().next().value);
                }
            }
            this.emitChange('data-patched', manifest, result);
            return result;
        });
    }

    async replaceData(chartId, dataInput, options = {}, context = {}) {
        const data = typeof dataInput === 'string' ? JSON.parse(dataInput) : clone(dataInput);
        if (!data || typeof data !== 'object') {
            throw createError('data 必须是 JSON 对象或数组。', 'CHART_INVALID_JSON');
        }
        return this.enqueue(chartId, async () => {
            const manifest = await this.readManifest(chartId);
            this.assertRevision(manifest.dataRevision, options.expectedDataRevision, 'dataRevision');
            assertJsonDepth(data);
            const serialized = `${JSON.stringify(data, null, 2)}\n`;
            if (byteLength(serialized) > SOURCE_LIMITS.data) {
                throw createError('图表数据超过大小限制。', 'CHART_SOURCE_TOO_LARGE');
            }
            manifest.dataRevision += 1;
            manifest.revision += 1;
            manifest.updatedAt = nowIso();
            await this.atomicWrite(path.join(this.chartDir(chartId), SOURCE_FILES.data), serialized);
            await this.atomicWrite(
                path.join(this.chartDir(chartId), SOURCE_FILES.manifest),
                `${JSON.stringify(manifest, null, 2)}\n`
            );
            const result = {
                chartId: manifest.id,
                revision: manifest.revision,
                dataRevision: manifest.dataRevision,
                actor: context.vcpContext?.agentId || null,
            };
            this.emitChange('data-replaced', manifest, result);
            return result;
        });
    }

    resolveSourceKind(file) {
        const normalized = String(file || '').trim().toLowerCase();
        const aliases = {
            'chart.json': 'manifest',
            manifest: 'manifest',
            'template.html': 'template',
            html: 'template',
            template: 'template',
            'style.css': 'style',
            css: 'style',
            style: 'style',
            'runtime.js': 'runtime',
            js: 'runtime',
            javascript: 'runtime',
            runtime: 'runtime',
            'data.json': 'data',
            data: 'data',
        };
        const kind = aliases[normalized];
        if (!kind) throw createError(`不支持的图表文件：${file}`, 'CHART_INVALID_SOURCE_FILE');
        return kind;
    }

    async getSource(chartId, file, options = {}) {
        const manifest = await this.readManifest(chartId);
        const kind = this.resolveSourceKind(file);
        const filePath = path.join(this.chartDir(chartId), SOURCE_FILES[kind]);
        const raw = await fs.readFile(filePath, 'utf8');
        const ranged = parseLineRange(raw, options.lines);
        return {
            chartId: manifest.id,
            file: SOURCE_FILES[kind],
            kind,
            content: ranged.content,
            lines: ranged.lines,
            totalBytes: byteLength(raw),
            hash: sha256(raw),
            codeRevision: manifest.codeRevision,
            dataRevision: manifest.dataRevision,
        };
    }

    async backupSource(chartId, kind, content, codeRevision) {
        const historyDir = path.join(this.chartDir(chartId), '.history');
        await fs.mkdir(historyDir, { recursive: true });
        const fileName = `${String(codeRevision).padStart(8, '0')}-${SOURCE_FILES[kind]}`;
        await this.atomicWrite(path.join(historyDir, fileName), content);
        const entries = (await fs.readdir(historyDir))
            .filter(name => name.endsWith(`-${SOURCE_FILES[kind]}`))
            .sort();
        for (const stale of entries.slice(0, Math.max(0, entries.length - MAX_HISTORY_VERSIONS))) {
            await fs.rm(path.join(historyDir, stale), { force: true });
        }
    }

    async editSource(chartId, edit = {}, context = {}) {
        const id = normalizeChartId(chartId);
        return this.enqueue(id, async () => {
            const manifest = await this.readManifest(id);
            this.assertRevision(manifest.codeRevision, edit.expectedCodeRevision, 'codeRevision');
            this.assertRevision(manifest.revision, edit.expectedRevision, 'revision');
            const kind = this.resolveSourceKind(edit.file);
            if (kind === 'data') {
                throw createError('请使用数据更新命令修改 data.json。', 'CHART_DATA_SOURCE_READONLY');
            }
            const filePath = path.join(this.chartDir(id), SOURCE_FILES[kind]);
            const original = await fs.readFile(filePath, 'utf8');
            const lineEnding = detectLineEnding(original);
            const normalizedOriginal = normalizeLineEndings(original);
            let normalizedNew;
            let matchCount = null;
            if (edit.content !== undefined) {
                normalizedNew = normalizeLineEndings(String(edit.content));
            } else {
                const target = normalizeLineEndings(String(edit.target ?? ''));
                const replacement = normalizeLineEndings(String(edit.replace ?? ''));
                if (!target) {
                    throw createError('target 必须是非空字符串。', 'CHART_EDIT_EMPTY_TARGET');
                }
                matchCount = countOccurrences(normalizedOriginal, target);
                if (matchCount === 0) {
                    throw createError('target 未在源码中找到。', 'CHART_EDIT_TARGET_NOT_FOUND');
                }
                if (matchCount !== 1) {
                    throw createError(
                        `target 命中 ${matchCount} 次，请提供更完整的上下文。`,
                        'CHART_EDIT_AMBIGUOUS_TARGET',
                        { matchCount }
                    );
                }
                normalizedNew = normalizedOriginal.replace(target, replacement);
            }
            const finalContent = restoreLineEndings(normalizedNew, lineEnding);
            const diagnostics = kind === 'manifest'
                ? []
                : validateSource(kind, finalContent);
            let nextManifest = manifest;
            if (kind === 'manifest') {
                const parsed = JSON.parse(finalContent);
                if (normalizeChartId(parsed.id) !== id) {
                    throw createError('不能通过源码编辑修改图表 ID。', 'CHART_ID_IMMUTABLE');
                }
                nextManifest = this.normalizeManifest(parsed, manifest, manifest.owner);
            }
            await this.backupSource(id, kind, original, manifest.codeRevision);
            nextManifest.codeRevision = manifest.codeRevision + 1;
            nextManifest.revision = manifest.revision + 1;
            nextManifest.updatedAt = nowIso();
            if (kind !== 'manifest') await this.atomicWrite(filePath, finalContent);
            await this.atomicWrite(
                path.join(this.chartDir(id), SOURCE_FILES.manifest),
                `${JSON.stringify(nextManifest, null, 2)}\n`
            );
            const result = {
                chartId: id,
                file: SOURCE_FILES[kind],
                oldCodeRevision: manifest.codeRevision,
                codeRevision: nextManifest.codeRevision,
                revision: nextManifest.revision,
                matchCount,
                lineEnding: lineEnding === '\r\n' ? 'CRLF' : lineEnding === '\r' ? 'CR' : 'LF',
                hash: sha256(kind === 'manifest' ? JSON.stringify(nextManifest) : finalContent),
                diagnostics,
                actor: context.vcpContext?.agentId || null,
            };
            this.emitChange('source-changed', nextManifest, result);
            return result;
        });
    }

    async rollbackSource(chartId, file, targetRevision, context = {}) {
        const id = normalizeChartId(chartId);
        const kind = this.resolveSourceKind(file);
        if (kind === 'data') throw createError('data 不支持源码回滚。', 'CHART_INVALID_SOURCE_FILE');
        const revision = Number(targetRevision);
        if (!Number.isInteger(revision) || revision < 1) {
            throw createError('targetRevision 必须是正整数。', 'CHART_INVALID_REVISION');
        }
        const historyPath = path.join(
            this.chartDir(id),
            '.history',
            `${String(revision).padStart(8, '0')}-${SOURCE_FILES[kind]}`
        );
        let historical;
        try {
            historical = await fs.readFile(historyPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw createError(`未找到源码历史版本 ${revision}。`, 'CHART_HISTORY_NOT_FOUND');
            }
            throw error;
        }
        // editSource 已负责同一图表的串行化；这里不能再次入队，否则会等待自身。
        return this.editSource(id, {
            file: kind,
            content: historical,
        }, context);
    }

    async deleteChart(chartId, options = {}, context = {}) {
        const id = normalizeChartId(chartId);
        return this.enqueue(id, async () => {
            const manifest = await this.readManifest(id);
            this.assertRevision(manifest.revision, options.expectedRevision, 'revision');
            await this.closeChart(id);
            const deletedAt = nowIso();
            const trashId = `${id}-${Date.now()}`;
            const destination = path.join(this.trashRoot, trashId);
            await fs.rename(this.chartDir(id), destination);
            await this.atomicWrite(path.join(destination, '.deleted.json'), `${JSON.stringify({
                chartId: id,
                trashId,
                deletedAt,
                actor: context.vcpContext?.agentId || null,
            }, null, 2)}\n`);
            this.emit('change', { type: 'deleted', chartId: id, trashId, deletedAt });
            return { chartId: id, trashId, deletedAt, recoverable: true };
        });
    }

    async listDeletedCharts() {
        await this.initialize();
        const entries = await fs.readdir(this.trashRoot, { withFileTypes: true });
        const deleted = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            try {
                const metadata = JSON.parse(await fs.readFile(path.join(this.trashRoot, entry.name, '.deleted.json'), 'utf8'));
                const manifest = JSON.parse(await fs.readFile(path.join(this.trashRoot, entry.name, SOURCE_FILES.manifest), 'utf8'));
                deleted.push({ ...metadata, name: manifest.name, description: manifest.description });
            } catch (_error) {
                // Ignore incomplete trash entries.
            }
        }
        return deleted.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    }

    async restoreChart(trashId) {
        const safeTrashId = path.basename(String(trashId || ''));
        if (!safeTrashId || safeTrashId !== String(trashId)) {
            throw createError('无效 trashId。', 'CHART_INVALID_TRASH_ID');
        }
        const source = path.join(this.trashRoot, safeTrashId);
        const metadata = JSON.parse(await fs.readFile(path.join(source, '.deleted.json'), 'utf8'));
        const id = normalizeChartId(metadata.chartId);
        return this.enqueue(id, async () => {
            if (await this.exists(id)) {
                throw createError(`无法恢复，图表 ID 已存在：${id}`, 'CHART_ALREADY_EXISTS');
            }
            await fs.rm(path.join(source, '.deleted.json'), { force: true });
            await fs.rename(source, this.chartDir(id));
            const manifest = await this.readManifest(id);
            manifest.revision += 1;
            manifest.updatedAt = nowIso();
            await this.atomicWrite(
                path.join(this.chartDir(id), SOURCE_FILES.manifest),
                `${JSON.stringify(manifest, null, 2)}\n`
            );
            this.emitChange('restored', manifest, { trashId: safeTrashId });
            return { chartId: id, trashId: safeTrashId, manifest };
        });
    }

    async purgeChart(trashId) {
        const safeTrashId = path.basename(String(trashId || ''));
        if (!safeTrashId || safeTrashId !== String(trashId)) {
            throw createError('无效 trashId。', 'CHART_INVALID_TRASH_ID');
        }
        await fs.rm(path.join(this.trashRoot, safeTrashId), { recursive: true, force: true });
        return { trashId: safeTrashId, purged: true };
    }

    async openChart(chartId, options = {}) {
        const manifest = await this.readManifest(chartId);
        if (!this.windowAdapter?.open) {
            return { chartId: manifest.id, opened: false, reason: 'window-adapter-unavailable' };
        }
        await this.windowAdapter.open(manifest.id, options);
        return { chartId: manifest.id, opened: true };
    }

    async closeChart(chartId) {
        const id = normalizeChartId(chartId);
        if (!this.windowAdapter?.close) return { chartId: id, closed: false };
        await this.windowAdapter.close(id);
        return { chartId: id, closed: true };
    }

    async observeChart(chartId, options = {}) {
        const manifest = await this.readManifest(chartId);
        if (!this.windowAdapter?.observe) {
            throw createError('图表窗口观察服务当前不可用。', 'CHART_OBSERVER_UNAVAILABLE');
        }
        return this.windowAdapter.observe(manifest.id, options);
    }

    async getRuntimeStatus(chartId) {
        const manifest = await this.readManifest(chartId);
        const status = this.windowAdapter?.getRuntimeStatus
            ? await this.windowAdapter.getRuntimeStatus(manifest.id)
            : { status: 'closed' };
        return {
            chartId: manifest.id,
            codeRevision: manifest.codeRevision,
            dataRevision: manifest.dataRevision,
            ...status,
        };
    }

    emitChange(type, manifest, details = {}) {
        this.emit('change', {
            type,
            chartId: manifest.id,
            revision: manifest.revision,
            codeRevision: manifest.codeRevision,
            dataRevision: manifest.dataRevision,
            emittedAt: nowIso(),
            ...clone(details),
        });
    }

    async shutdown() {
        await this.windowAdapter?.shutdown?.();
        this.dataSourceAdapter = null;
        this.removeAllListeners();
        this.queues.clear();
        this.operationReceipts.clear();
    }
}

module.exports = {
    ChartService,
    CHART_ID_PATTERN,
    ALLOWED_LIBRARIES,
    SOURCE_FILES,
    _test: {
        parsePointer,
        getAtPointer,
        setAtPointer,
        removeAtPointer,
        applyDataOperation,
        detectLineEnding,
        normalizeLineEndings,
        restoreLineEndings,
        countOccurrences,
        validateSource,
        parseLineRange,
        normalizeChartId,
    },
};