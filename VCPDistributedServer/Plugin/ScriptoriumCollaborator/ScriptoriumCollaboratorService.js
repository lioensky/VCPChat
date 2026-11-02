'use strict';

const crypto = require('crypto');
// 数据图表块的解析和只改数据（UpdateChartData）。
const DataChart = require('../../../modules/uttu/dataChart');

let runtime = {
    control: null,
    logger: console,
};

function initialize(options = {}) {
    runtime = {
        control: options.services?.scriptoriumAgentControl
            || options.scriptoriumAgentControl
            || null,
        logger: options.logger || console,
    };
}

function requireControl() {
    if (!runtime.control) {
        throw new Error('[ScriptoriumCollaborator] Scriptorium Agent 控制服务当前不可用。');
    }
    return runtime.control;
}

function commandOf(args = {}) {
    return String(args.command || args.action || '').trim().toLowerCase();
}

function getSerialCommandEntries(args = {}) {
    return Object.entries(args)
        .map(([key, value]) => {
            const match = key.match(/^command(\d+)$/i);
            return match
                ? { index: Number(match[1]), command: String(value || '').trim() }
                : null;
        })
        .filter((entry) => entry && entry.index > 0 && entry.command)
        .sort((a, b) => a.index - b.index);
}

function extractSerialStepArgs(rawArgs, index) {
    const step = {};
    for (const [key, value] of Object.entries(rawArgs)) {
        const match = key.match(/^(.+?)(\d+)$/);
        if (!match || Number(match[2]) !== index || match[1].toLowerCase() === 'command') {
            continue;
        }
        step[match[1]] = value;
    }

    // 未编号字段是串行请求的公共参数，例如 endpoint、maid 与截图延迟。
    // command/action 和所有编号字段不能泄漏到单步参数中。
    for (const [key, value] of Object.entries(rawArgs)) {
        if (
            key.toLowerCase() === 'command'
            || key.toLowerCase() === 'action'
            || /\d+$/.test(key)
            || Object.prototype.hasOwnProperty.call(step, key)
        ) {
            continue;
        }
        step[key] = value;
    }
    step.command = String(rawArgs[`command${index}`] || '').trim();
    return step;
}

function parseWaitMs(args = {}, fallback = 1000) {
    let value = args.waitMs ?? args.durationMs ?? args.delayMs;
    if (value === undefined && args.seconds !== undefined) {
        value = Number(args.seconds) * 1000;
    }
    const parsed = value === undefined || value === ''
        ? fallback
        : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error('[ScriptoriumCollaborator] 等待时长必须是非负数。');
    }
    return Math.min(Math.round(parsed), 30000);
}

function parseVisualDelayMs(args = {}) {
    const value = args.visualDelayMs
        ?? args.captureDelayMs
        ?? args.screenshotDelayMs;
    return parseWaitMs({ waitMs: value }, 750);
}

function delay(waitMs) {
    return new Promise((resolve) => setTimeout(resolve, waitMs));
}

function isWaitCommand(command) {
    return ['wait', 'sleep', 'delay'].includes(String(command || '').trim().toLowerCase());
}

function isVisualCommand(command) {
    return [
        'getvisualcontext',
        'getviewportimage',
        'getslidevisual',
    ].includes(String(command || '').trim().toLowerCase());
}

function parseObject(value, fieldName, fallback = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('根值不是对象');
        }
        return parsed;
    } catch (error) {
        throw new Error(`[ScriptoriumCollaborator] ${fieldName} 必须是 JSON 对象：${error.message}`);
    }
}

function parseArray(value, fieldName, fallback = []) {
    if (value === undefined || value === null || value === '') return fallback;
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        if (!Array.isArray(parsed)) throw new Error('根值不是数组');
        return parsed;
    } catch (error) {
        throw new Error(`[ScriptoriumCollaborator] ${fieldName} 必须是 JSON 数组：${error.message}`);
    }
}

function booleanOf(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    throw new Error('[ScriptoriumCollaborator] 布尔参数必须为 true 或 false。');
}

function authorFromMaid(args = {}, executionContext = {}) {
    const supplied = executionContext?.vcpContext
        && typeof executionContext.vcpContext === 'object'
        ? executionContext.vcpContext
        : executionContext;
    const rawMaid = args.maid ?? args.author ?? args.signature;
    const maid = typeof rawMaid === 'string'
        ? { name: rawMaid.trim() }
        : parseObject(rawMaid, 'maid', null);
    const name = String(
        maid?.name || maid?.signature || maid?.id || ''
    ).trim();
    if (!name) {
        throw new Error('[ScriptoriumCollaborator] 写操作缺少 maid 署名字段。');
    }
    return {
        id: String(
            maid?.id || supplied?.agentId || supplied?.ownerId || name
        ).trim(),
        name,
        type: 'agent',
    };
}

function requestIdOf(args = {}, executionContext = {}) {
    const trustedRequestId = String(executionContext?.requestId || '').trim();
    if (trustedRequestId) return trustedRequestId;
    return String(args.requestId || crypto.randomUUID());
}

function endpointFor(args = {}) {
    const explicit = String(args.endpoint || args.documentType || '').toLowerCase();
    if (['docx', 'vdocx'].includes(explicit)) return 'docx';
    if (['pptx', 'vpptx'].includes(explicit)) return 'pptx';
    return 'common';
}

const MARKDOWN_FIELD_LABELS = Object.freeze({
    success: '成功',
    code: '状态码',
    message: '消息',
    documentId: '文档 ID',
    documentKind: '文档类型',
    revision: '修订号',
    title: '标题',
    name: '名称',
    dirty: '存在未保存修改',
    activeSlideIndex: '当前幻灯片页码',
    slideCount: '幻灯片总数',
    scene: '场景配置',
    programmableContent: '可编程内容',
    status: '状态',
    dependencies: '依赖',
    diagnostics: '诊断信息',
    text: '渲染文本',
    renderedText: '渲染文本',
    pages: '页面',
    items: '目录项',
    count: '数量',
    totalCharacters: '文档总字符数',
    index: '目录索引',
    level: '标题级别',
    characterCount: '章节字符数',
    contentCharacterCount: '章节正文字数',
    sourceRange: '章节源码范围',
    headingRange: '标题源码范围',
    records: '历史记录',
    results: '检索结果',
    query: '检索词',
    sourceKind: '源码类型',
    slideIndex: '幻灯片页码',
    line: '插入行号',
    startLine: '起始行',
    endLine: '结束行',
    totalLines: '总行数',
    source: '源码',
    html: 'HTML',
    documentCss: '文档 CSS',
    deckCss: '演示共享 CSS',
    context: '上下文源码',
    target: '目标源码',
    insert: '插入源码',
    append: '末尾追加源码',
    replace: '替换源码',
    replacement: '替换源码',
    heading: '章节标题',
    visibleBlockIds: '可见文本块 ID',
    media: '媒体',
    notes: '备注',
    note: '备注',
    summary: '摘要',
    packs: '样式主题包',
    pack: '样式主题包',
    packId: '样式主题包 ID',
    styleCount: '样式数量',
    deletedStyleCount: '已删除样式数量',
    assets: 'SVG 资产',
    asset: 'SVG 资产',
    assetId: 'SVG 资产 ID',
    assetCount: 'SVG 资产数量',
    animatedCount: '动画资产数量',
    deletedAssetCount: '已删除 SVG 资产数量',
    kind: '类型',
    category: '分类',
    tags: '标签',
    description: '描述',
    defaultSize: '默认尺寸',
    builtin: '内置只读',
    editable: '允许编辑',
    builtinPackId: '内置包 ID',
    format: '格式',
    version: '版本',
    maid: 'Maid 署名',
    author: '作者',
    reviewer: '审阅者',
    receipt: '审批回执',
    decision: '审批决定',
    automatic: '自动审批',
    createdAt: '创建时间',
    reviewedAt: '审阅时间',
    baseRevision: '基础修订号',
    operation: '操作',
    proposal: '提案',
    changeSet: '变更集',
    pr: 'PR',
    result: '执行结果',
    root: '根目录',
    docxDirectory: 'VDOCX 目录',
    pptxDirectory: 'VPPTX 目录',
    defaultConflictPolicy: '默认重名策略',
    overwriteRequiresExpectedFileHash: '覆盖需要预期文件哈希',
});

const MARKDOWN_CODE_FIELDS = new Set([
    'source',
    'html',
    'documentCss',
    'deckCss',
    'context',
    'target',
    'insert',
    'append',
    'replace',
    'replacement',
]);

function compactDetails(value) {
    if (!value || typeof value !== 'object') return {};
    const { serialized, snapshot, ...rest } = value;
    return rest;
}

function markdownLabel(key) {
    return MARKDOWN_FIELD_LABELS[key] || String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/^./, (character) => character.toUpperCase());
}

function escapeMarkdownInline(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/([`*_[\]<>])/g, '\\$1')
        .replace(/\r?\n/g, ' ');
}

function markdownFence(content, language = 'text') {
    const text = String(content ?? '').replace(/\r\n?/g, '\n');
    const longestFence = Math.max(
        0,
        ...([...text.matchAll(/`+/g)].map((match) => match[0].length))
    );
    const fence = '`'.repeat(Math.max(3, longestFence + 1));
    return `${fence}${language}\n${text}\n${fence}`;
}

function codeLanguage(key, parent = {}) {
    if (key === 'deckCss' || key === 'documentCss') return 'css';
    if (key === 'html') return 'html';
    const sourceKind = String(parent.sourceKind || '').toLowerCase();
    if (['deck-css', 'document-css'].includes(sourceKind)) return 'css';
    if (sourceKind === 'markdown-hybrid') return 'markdown';
    if ([
        'source',
        'context',
        'target',
        'insert',
        'append',
        'replace',
        'replacement',
    ].includes(key)) {
        return sourceKind === 'html' || /<\/?[a-z][\s\S]*>/i.test(String(parent[key] || ''))
            ? 'html'
            : 'text';
    }
    return 'text';
}

function markdownScalar(value) {
    if (value === null) return '无';
    if (value === undefined) return '未提供';
    if (typeof value === 'boolean') return value ? '是' : '否';
    return escapeMarkdownInline(value);
}

function markdownValue(key, value, parent, depth = 2) {
    const label = markdownLabel(key);
    const heading = '#'.repeat(Math.min(6, depth));

    if (MARKDOWN_CODE_FIELDS.has(key) && typeof value === 'string') {
        return [`${heading} ${label}`, '', markdownFence(value, codeLanguage(key, parent))];
    }

    if (typeof value === 'string' && value.includes('\n')) {
        return [`${heading} ${label}`, '', markdownFence(value, 'text')];
    }

    if (Array.isArray(value)) {
        if (!value.length) return [`- **${label}**：无`];
        if (value.every((item) =>
            item === null || ['string', 'number', 'boolean'].includes(typeof item)
        )) {
            return [
                `${heading} ${label}`,
                '',
                ...value.map((item) => `- ${markdownScalar(item)}`),
            ];
        }
        const lines = [`${heading} ${label}`, ''];
        value.forEach((item, index) => {
            const itemHeading = '#'.repeat(Math.min(6, depth + 1));
            lines.push(`${itemHeading} ${label} ${index + 1}`, '');
            if (item && typeof item === 'object') {
                lines.push(...markdownObject(item, depth + 2), '');
            } else {
                lines.push(markdownScalar(item), '');
            }
        });
        return lines.slice(0, -1);
    }

    if (value && typeof value === 'object') {
        return [
            `${heading} ${label}`,
            '',
            ...markdownObject(value, depth + 1),
        ];
    }

    return [`- **${label}**：${markdownScalar(value)}`];
}

function markdownObject(value, depth = 2) {
    const lines = [];
    for (const [key, fieldValue] of Object.entries(value || {})) {
        if (key === 'serialized' || key === 'snapshot') continue;
        const block = markdownValue(key, fieldValue, value, depth);
        const blockLike = block[0]?.startsWith('#');
        if (blockLike && lines.length && lines.at(-1) !== '') lines.push('');
        lines.push(...block);
        if (blockLike) lines.push('');
    }
    while (lines.at(-1) === '') lines.pop();
    return lines;
}

function resultText(title, result) {
    const markdown = [
        `# ${title}`,
        '',
        ...markdownObject(compactDetails(result)),
    ].join('\n');
    return {
        content: [{
            type: 'text',
            text: markdown,
        }],
        details: result,
    };
}

function outlineResultText(result = {}) {
    const items = Array.isArray(result.items) ? result.items : [];
    const docx = result.sourceKind === 'markdown-hybrid';
    if (!docx) return resultText('Scriptorium · getOutline', result);

    const lines = [
        '# Scriptorium · 分层章节目录',
        '',
        `- **章节数**：${Number(result.count ?? items.length)}`,
        `- **文档总字符数**：${Number(result.totalCharacters || 0)}`,
        `- **修订号**：${Number(result.revision || 0)}`,
        '',
        '> 建议先按标题层级和章节字符数选择少量关键章节，再用 GetSection 按 ID 读取；需要人物、地点或情节细节时使用 SearchSource 全文检索。',
        '',
        '## 章节',
        '',
    ];
    if (!items.length) {
        lines.push('（未识别到章节标题）');
    } else {
        items.forEach((item) => {
            const level = Math.max(1, Number(item.level) || 1);
            const startLine = Number(item.startLine) || 1;
            const endLine = Number(item.endLine) || startLine;
            const characters = Number(item.characterCount) || 0;
            lines.push(
                `${'  '.repeat(level - 1)}- [${Number(item.index)}] ${
                    escapeMarkdownInline(item.text || '未命名章节')
                } · L${startLine}-${endLine} · ${characters} 字 · ID: \`${
                    String(item.id || '').replace(/`/g, '')
                }\``
            );
        });
    }
    return {
        content: [{
            type: 'text',
            text: lines.join('\n'),
        }],
        details: result,
    };
}

function internalSlideIndex(value, fieldName = 'slideIndex') {
    if (value === undefined || value === null || value === '') return undefined;
    const pageNumber = Number(value);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error(
            `[ScriptoriumCollaborator] ${fieldName} 必须是从 1 开始的整数页码。`
        );
    }
    return pageNumber - 1;
}

function internalizePagePayload(payload = {}, endpoint = 'common') {
    if (endpoint === 'docx'
        || !Object.prototype.hasOwnProperty.call(payload, 'slideIndex')) {
        return payload;
    }
    return {
        ...payload,
        slideIndex: internalSlideIndex(payload.slideIndex),
    };
}

function externalizePageNumbers(value, context = {}) {
    if (Array.isArray(value)) {
        return value.map((item) => externalizePageNumbers(item, context));
    }
    if (!value || typeof value !== 'object') return value;

    const deck = context.deck || value.documentKind === 'pptx';
    const result = {};
    for (const [key, fieldValue] of Object.entries(value)) {
        const numberedIndex = deck
            && Number.isInteger(fieldValue)
            && (
                key === 'slideIndex'
                || key === 'activeSlideIndex'
                || (
                    key === 'index'
                    && (
                        context.collection === 'pages'
                        || context.collection === 'items'
                        || Object.prototype.hasOwnProperty.call(value, 'slideId')
                    )
                )
            );
        result[key] = numberedIndex
            ? fieldValue + 1
            : externalizePageNumbers(fieldValue, {
                deck,
                collection: Array.isArray(fieldValue) ? key : context.collection,
            });
    }
    return result;
}

async function call(
    args,
    method,
    payload = {},
    endpoint = endpointFor(args),
    executionContext = {}
) {
    const result = await requireControl().call({
        requestId: requestIdOf(args, executionContext),
        endpoint,
        method,
        payload: internalizePagePayload(payload, endpoint),
    });
    return resultText(
        `Scriptorium · ${method}`,
        externalizePageNumbers(result, {
            deck: endpoint === 'pptx' || result?.documentKind === 'pptx',
        })
    );
}

async function listFonts(args = {}) {
    const result = await requireControl().listFonts({
        language: args.language || args.locale || 'all',
        forceRefresh: booleanOf(args.forceRefresh, false),
    });
    const labels = {
        'zh-CN': '中文字体',
        en: '英文字体 / 拉丁字体',
        all: '全部系统字体',
    };
    const fonts = Array.isArray(result.fonts) ? result.fonts : [];
    return {
        content: [{
            type: 'text',
            text: [
                `# Scriptorium 可用字体 · ${labels[result.language] || result.language}`,
                '',
                `共 ${fonts.length} 种已安装字体。以下名称可直接用于 CSS font-family：`,
                '',
                ...fonts.map((font) => `- ${font}`),
            ].join('\n'),
        }],
    };
}

async function getDocumentInfo(args) {
    return call(args, 'getDocumentInfo');
}

async function getRenderedText(args) {
    return call(args, 'getRenderedText', {
        slideIndex: args.slideIndex,
    });
}

async function getOutline(args, executionContext = {}) {
    const endpoint = endpointFor(args);
    const result = await requireControl().call({
        requestId: requestIdOf(args, executionContext),
        endpoint,
        method: 'getOutline',
        payload: {},
    });
    const externalized = externalizePageNumbers(result, {
        deck: endpoint === 'pptx' || result?.documentKind === 'pptx',
    });
    return outlineResultText(externalized);
}

async function getSection(args) {
    return call(args, 'getSection', {
        id: args.id,
        index: args.index,
    }, 'docx');
}

function defaultSourceKind(args = {}) {
    const endpoint = endpointFor(args);
    if (endpoint === 'docx') return 'markdown-hybrid';
    if (endpoint === 'pptx') return 'html';
    // 未指定端点时不强加旧范式，让窗口端口按当前文档类型选择真源。
    return undefined;
}

async function getSource(args) {
    return call(args, 'getSource', {
        sourceKind: args.sourceKind || defaultSourceKind(args),
        slideIndex: args.slideIndex,
        startLine: args.startLine,
        endLine: args.endLine,
    });
}

async function searchSource(args) {
    if (!String(args.query || '').trim()) {
        throw new Error('[ScriptoriumCollaborator] SearchSource 缺少 query。');
    }
    return call(args, 'searchSource', {
        query: String(args.query),
        sourceKind: args.sourceKind || 'all',
        slideIndex: args.slideIndex,
        regex: booleanOf(args.regex, false),
        caseSensitive: booleanOf(args.caseSensitive, false),
    });
}

async function getViewportSource(args) {
    return call(args, 'getViewportSource', {
        sourceKind: args.sourceKind || defaultSourceKind(args),
        radius: args.radius,
    });
}

async function getVisualContext(args, executionContext = {}) {
    const endpoint = endpointFor(args);
    const result = await requireControl().captureVisualContext({
        requestId: requestIdOf(args, executionContext),
        endpoint,
        scope: args.scope || 'viewport',
        slideIndex: endpoint === 'docx'
            ? args.slideIndex
            : internalSlideIndex(args.slideIndex),
        format: args.format || args.imageFormat,
        quality: args.quality,
        // 截图前先滚到这一节（标题文字）或这个可编程岛（data-vdoc-island），只对文稿。
        section: args.section || args.heading,
        island: args.island,
        // 白板只看这些元素或这一块（文坊 uttu-scriptorium-board.js）。
        ids: parseArray(args.ids, 'ids', null),
        region: parseObject(args.region, 'region', null),
        stabilizationMs: args.stabilizationMs
            ?? args.renderStabilizationMs
            ?? args.visualDelayMs
            ?? args.captureDelayMs
            ?? args.screenshotDelayMs,
    });
    return externalizePageNumbers(result, {
        deck: endpoint === 'pptx'
            || result?.details?.documentKind === 'pptx',
    });
}

// 白板按元素读写。
async function getBoard(args) {
    return call(args, 'getBoard', {
        ids: parseArray(args.ids, 'ids', null),
        region: parseObject(args.region, 'region', null),
        sinceRevision: args.sinceRevision,
        limit: args.limit,
    });
}

async function updateBoard(args) {
    return call(args, 'updateBoard', {
        expectedRevision: args.expectedRevision,
        add: parseArray(args.add, 'add'),
        update: parseArray(args.update, 'update'),
        delete: parseArray(args.delete, 'delete'),
        background: args.background,
    });
}

async function getPrHistory(args) {
    return call(args, 'getPrHistory', {
        limit: args.limit,
        status: args.status,
    });
}

async function listStylePacks(args) {
    return call(args, 'listStylePacks', {
        query: args.query,
        editableOnly: booleanOf(args.editableOnly, false),
    }, 'common');
}

async function getStylePack(args) {
    const packId = String(args.packId || args.id || '').trim();
    if (!packId) {
        throw new Error('[ScriptoriumCollaborator] GetStylePack 缺少 packId。');
    }
    return call(args, 'getStylePack', { packId }, 'common');
}

async function upsertStylePack(args, executionContext = {}) {
    const supplied = args.pack ?? args.source;
    if (supplied === undefined || supplied === null || supplied === '') {
        throw new Error(
            '[ScriptoriumCollaborator] UpsertStylePack 缺少 pack 或 source。'
        );
    }
    const pack = typeof supplied === 'object'
        ? parseObject(supplied, 'pack')
        : parseObject(String(supplied), 'source');
    const maid = authorFromMaid(args, executionContext);
    return call(args, 'upsertStylePack', {
        requestId: requestIdOf(args, executionContext),
        pack,
        maid,
        author: maid,
    }, 'common', executionContext);
}

async function deleteStylePack(args, executionContext = {}) {
    const packId = String(args.packId || args.id || '').trim();
    if (!packId) {
        throw new Error(
            '[ScriptoriumCollaborator] DeleteStylePack 缺少 packId。'
        );
    }
    const maid = authorFromMaid(args, executionContext);
    return call(args, 'deleteStylePack', {
        requestId: requestIdOf(args, executionContext),
        packId,
        maid,
        author: maid,
    }, 'common', executionContext);
}

async function listSvgAssetPacks(args) {
    return call(args, 'listSvgAssetPacks', {
        query: args.query,
        editableOnly: booleanOf(args.editableOnly, false),
    }, 'common');
}

async function listSvgAssets(args) {
    return call(args, 'listSvgAssets', {
        query: args.query,
        packId: args.packId,
        category: args.category,
        kind: args.kind,
    }, 'common');
}

async function getSvgAsset(args) {
    const assetId = String(args.assetId || args.id || '').trim();
    if (!assetId) {
        throw new Error(
            '[ScriptoriumCollaborator] GetSvgAsset 缺少 assetId。'
        );
    }
    return call(args, 'getSvgAsset', { assetId }, 'common');
}

async function getSvgAssetPack(args) {
    const packId = String(args.packId || args.id || '').trim();
    if (!packId) {
        throw new Error(
            '[ScriptoriumCollaborator] GetSvgAssetPack 缺少 packId。'
        );
    }
    return call(args, 'getSvgAssetPack', { packId }, 'common');
}

async function upsertSvgAssetPack(args, executionContext = {}) {
    const supplied = args.pack ?? args.source;
    if (supplied === undefined || supplied === null || supplied === '') {
        throw new Error(
            '[ScriptoriumCollaborator] UpsertSvgAssetPack 缺少 pack 或 source。'
        );
    }
    const pack = typeof supplied === 'object'
        ? parseObject(supplied, 'pack')
        : parseObject(String(supplied), 'source');
    const maid = authorFromMaid(args, executionContext);
    return call(args, 'upsertSvgAssetPack', {
        requestId: requestIdOf(args, executionContext),
        pack,
        maid,
        author: maid,
    }, 'common', executionContext);
}

async function deleteSvgAssetPack(args, executionContext = {}) {
    const packId = String(args.packId || args.id || '').trim();
    if (!packId) {
        throw new Error(
            '[ScriptoriumCollaborator] DeleteSvgAssetPack 缺少 packId。'
        );
    }
    const maid = authorFromMaid(args, executionContext);
    return call(args, 'deleteSvgAssetPack', {
        requestId: requestIdOf(args, executionContext),
        packId,
        maid,
        author: maid,
    }, 'common', executionContext);
}

async function submitSourcePr(args, executionContext = {}) {
    const hasAppend = Object.prototype.hasOwnProperty.call(args, 'append');
    const hasInsert = Object.prototype.hasOwnProperty.call(args, 'insert');
    const replacements = args.replacements === undefined
        ? [
            hasAppend
                ? {
                    append: args.append,
                }
                : hasInsert
                    ? {
                        insert: args.insert,
                        line: args.line,
                    }
                    : {
                        target: args.target,
                        replace: args.replace ?? args.replacement ?? '',
                        startLine: args.startLine,
                    },
        ]
        : parseArray(args.replacements, 'replacements');
    const maid = authorFromMaid(args, executionContext);
    return call(args, 'submitSourcePr', {
        requestId: requestIdOf(args, executionContext),
        sourceKind: args.sourceKind || defaultSourceKind(args),
        slideIndex: args.slideIndex,
        replacements,
        expectedRevision: args.expectedRevision,
        maid,
        author: maid,
        summary: String(args.summary || '').trim(),
        name: args.name,
        note: args.note,
    }, endpointFor(args), executionContext);
}

async function mutateSlide(args, method, executionContext = {}) {
    const maid = authorFromMaid(args, executionContext);
    const deleting = method === 'deleteSlide';
    const source = String(args.source || '');
    if (!deleting && !source.trim()) {
        throw new Error(
            '[ScriptoriumCollaborator] AddSlide/InsertSlide 必须通过 source 一次提交包含 <style>、页面 HTML、依赖声明和内联 <script> 的完整单页源码。'
        );
    }
    const payload = {
        requestId: requestIdOf(args, executionContext),
        slideIndex: args.slideIndex,
        name: args.name,
        source: deleting ? undefined : source,
        notes: args.notes,
        transition: args.transition,
        resources: parseArray(args.resources, 'resources'),
        expectedRevision: args.expectedRevision,
        maid,
        author: maid,
        summary: String(args.summary || '').trim(),
        note: args.note,
    };
    return call(args, method, payload, 'pptx', executionContext);
}

function presentationConfigFromArgs(args = {}) {
    const page = {
        ...parseObject(args.page, 'page'),
    };
    const presentation = {
        ...parseObject(args.presentation, 'presentation'),
    };

    if (args.width !== undefined) page.width = args.width;
    if (args.height !== undefined) page.height = args.height;
    if (args.gap !== undefined) page.gap = args.gap;
    if (args.aspectRatio !== undefined) presentation.aspectRatio = args.aspectRatio;
    if (args.theme !== undefined) presentation.theme = args.theme;
    if (args.navigation !== undefined) presentation.navigation = args.navigation;
    if (args.loop !== undefined) presentation.loop = booleanOf(args.loop, false);
    if (args.defaultTransition !== undefined) {
        presentation.defaultTransition = parseObject(
            args.defaultTransition,
            'defaultTransition'
        );
    } else if (args.transition !== undefined) {
        presentation.defaultTransition = typeof args.transition === 'object'
            ? args.transition
            : { type: args.transition, duration: args.transitionDuration };
    }

    return { page, presentation };
}

async function updatePresentationConfig(args, executionContext = {}) {
    const maid = authorFromMaid(args, executionContext);
    const config = presentationConfigFromArgs(args);
    return call(args, 'updatePresentationConfig', {
        requestId: requestIdOf(args, executionContext),
        ...config,
        expectedRevision: args.expectedRevision,
        maid,
        author: maid,
        summary: String(args.summary || '').trim(),
        name: args.name,
        note: args.note,
    }, 'pptx', executionContext);
}

async function createProject(args, executionContext = {}) {
    const config = presentationConfigFromArgs(args);
    const projectType = String(args.projectType || args.type || '').trim().toLowerCase();
    const deck = ['pptx', 'vpptx', 'presentation', 'slide-deck'].includes(projectType);
    const source = String(args.source || '');
    const slides = parseArray(args.slides, 'slides');

    if (!deck && !source.trim()) {
        throw new Error(
            '[ScriptoriumCollaborator] 创建 VDOCX 必须通过 source 提交非空 Markdown-first 混合源码；文档级样式请使用 documentCss。'
        );
    }
    if (deck && (!slides.length || slides.some((slide) =>
        !slide || typeof slide !== 'object' || !String(slide.source || '').trim()
    ))) {
        throw new Error(
            '[ScriptoriumCollaborator] 创建 PPTX 必须提供 slides，且每页都必须包含唯一完整 source。'
        );
    }

    return requireControl().createProjectArtifact({
        requestId: requestIdOf(args, executionContext),
        projectType,
        fileName: args.fileName,
        title: args.title,
        source: deck ? undefined : source,
        documentCss: deck ? undefined : String(args.documentCss || ''),
        deckCss: deck ? String(args.deckCss || '') : undefined,
        slides: deck ? slides : undefined,
        page: config.page,
        presentation: config.presentation,
        maid: authorFromMaid(args, executionContext),
        summary: args.summary,
        conflictPolicy: args.conflictPolicy || 'rename',
        expectedFileHash: args.expectedFileHash,
        // 版式、样式库，新建后默认在右栏打开（ScriptoriumAgentControlService.createProjectArtifact）。
        layout: args.layout,
        theme: args.theme,
        openAfterCreate: booleanOf(args.openAfterCreate, true),
        // 临时演示和小工具存进文库的“临时”里，不混进正式文稿。
        temporary: booleanOf(args.temporary, false),
    });
}

// 找回已有文档、在原文档上继续改。
async function listDocuments() {
    const result = await requireControl().listDocuments();
    const documents = Array.isArray(result.documents) ? result.documents : [];
    return {
        content: [{
            type: 'text',
            text: [
                '# 文坊文档目录',
                '',
                `目录：${result.root}`,
                '',
                documents.length
                    ? '要改其中一份时用 OpenDocument 打开它，在原文档上改。'
                    : '目录里还没有文档。',
                '',
                ...documents.map((item) => `- ${item.fileName}（${item.temporary ? '临时' : ''}${item.projectType === 'pptx' ? '演示' : '文档'}，`
                    + `${Math.max(1, Math.round(item.size / 1024))} KB，修改于 ${item.modifiedAt}）`),
            ].join('\n'),
        }],
        details: result,
    };
}

async function openDocument(args) {
    const result = await requireControl().openDocument({
        fileName: args.fileName || args.name,
        path: args.path || args.filePath,
    });
    const text = result.opened && result.projectType === 'web-page'
        ? [
            '# 已在文坊打开网页',
            '',
            `- 文件：${result.fileName}`,
            '',
            '网页是给用户看的：GetSource、SubmitSourcePr 这些仍作用于后面的文稿。要改网页就直接改这个文件，文坊会自己刷新。',
        ]
        : result.opened
        ? [
            '# 已在文坊打开',
            '',
            `- 文件：${result.fileName}`,
            `- 修订：${result.revision ?? '—'}`,
            '',
            '之后的读取和提交都作用于这份文档。',
        ]
        : [
            '# 已请求打开，但还没切过去',
            '',
            `- 文件：${result.fileName}`,
            '',
            '当前文档可能有未保存的修改，正在等用户确认。先不要提交修改，稍后用 GetDocumentInfo 确认 filePath。',
        ];
    return {
        content: [{
            type: 'text',
            text: text.join('\n'),
        }],
        details: result,
    };
}

// 数据图表块只改数据：读出源码、找到 ```chart 图ID、
// 换掉 data 那一段，再按 SubmitSourcePr 提交（同一条自动合入或审批、文脉快照、回退）。图形部分一个字节不动。
async function readFlowSource(requestId) {
    const pages = [];
    let startLine = 1;
    let revision = null;
    for (let page = 1; page <= 100; page += 1) {
        const result = await requireControl().call({
            requestId: `${requestId}:chart-source-${page}`,
            endpoint: 'docx',
            method: 'getSource',
            payload: { sourceKind: 'markdown-hybrid', startLine, endLine: startLine + 1999 },
        });
        if (!result || result.success === false) {
            throw new Error(`[ScriptoriumCollaborator] 读不到当前文稿的源码：${result?.message || result?.code || '未知原因'}`);
        }
        if (revision !== null && result.revision !== revision) {
            throw new Error('[ScriptoriumCollaborator] 读源码时文档被改了，请重试。');
        }
        revision = result.revision;
        pages.push(result.source);
        if (result.endLine >= result.totalLines) break;
        startLine = result.endLine + 1;
    }
    return { source: pages.join('\n'), revision };
}

async function updateChartData(args, executionContext = {}) {
    const chartId = String(args.chart || args.chartId || args.island || '').trim();
    if (!chartId) throw new Error('[ScriptoriumCollaborator] UpdateChartData 缺少 chart（图表 ID）。');
    const maid = authorFromMaid(args, executionContext);
    const requestId = requestIdOf(args, executionContext);
    const { source, revision } = await readFlowSource(requestId);
    const blocks = DataChart.findBlocks(source);
    const matches = blocks.filter((block) => block.id === chartId);
    if (!matches.length) {
        const ids = blocks.map((block) => block.id).filter(Boolean);
        throw new Error(`[ScriptoriumCollaborator] 当前文档里没有图表 ${chartId}。`
            + `${ids.length ? `现有图表：${ids.join('、')}。` : '文档里还没有 ```chart 图表块。'}`);
    }
    if (matches.length > 1) {
        throw new Error(`[ScriptoriumCollaborator] 图表 ID ${chartId} 出现了 ${matches.length} 次，`
            + '先用 SubmitSourcePr 改成不重复的 ID。');
    }
    const block = matches[0];
    const updated = DataChart.updateBody(block.body, {
        data: args.data,
        rows: args.rows,
        removeX: args.removeX,
        keepLast: args.keepLast,
    });
    if (updated.error) throw new Error(`[ScriptoriumCollaborator] 图表 ${chartId}：${updated.error}`);
    if (updated.body === block.body) {
        return resultText('Scriptorium · UpdateChartData', {
            success: true,
            changed: false,
            chart: chartId,
            rows: updated.after,
            revision,
            message: '数据和原来一样，没有提交。',
        });
    }
    const summary = String(args.summary || '').trim() || `更新图表数据：${chartId}`;
    const result = await requireControl().call({
        requestId,
        endpoint: 'docx',
        method: 'submitSourcePr',
        payload: {
            requestId,
            sourceKind: 'markdown-hybrid',
            replacements: [{ target: block.body, replace: updated.body, startLine: block.bodyLine }],
            expectedRevision: args.expectedRevision ?? revision,
            maid,
            author: maid,
            summary,
        },
    });
    // 回执里的提案、已执行操作都带着整段新旧图表文本（数据多时很长），Agent 用不上，去掉。
    const { operation, ...receipt } = result || {};
    if (receipt.pr) {
        const { proposal, operation: prOperation, changeSet, ...pr } = receipt.pr;
        receipt.pr = pr;
    }
    if (receipt.result && typeof receipt.result === 'object') {
        const { operation: applied, ...rest } = receipt.result;
        receipt.result = rest;
    }
    return resultText('Scriptorium · UpdateChartData', {
        ...receipt,
        chart: chartId,
        rows: `${updated.before} → ${updated.after}`,
        summary,
    });
}

async function processSingleToolCall(args, executionContext = {}) {
    switch (commandOf(args)) {
        case 'listfonts':
        case 'getfonts':
            return listFonts(args);
        case 'getdocumentinfo':
            return getDocumentInfo(args);
        case 'getrenderedtext':
        case 'getfulltext':
            return getRenderedText(args);
        case 'getoutline':
            return getOutline(args, executionContext);
        case 'getsection':
            return getSection(args);
        case 'getsource':
            return getSource(args);
        case 'searchsource':
            return searchSource(args);
        case 'getviewportsource':
            return getViewportSource(args);
        case 'getvisualcontext':
        case 'getviewportimage':
        case 'getslidevisual':
            return getVisualContext(args, executionContext);
        case 'getboard':
            return getBoard(args);
        case 'updateboard':
            return updateBoard(args);
        case 'getprhistory':
            return getPrHistory(args);
        case 'liststylepacks':
        case 'liststyles':
            return listStylePacks(args);
        case 'getstylepack':
        case 'getstylesource':
            return getStylePack(args);
        case 'upsertstylepack':
        case 'savestylepack':
            return upsertStylePack(args, executionContext);
        case 'deletestylepack':
            return deleteStylePack(args, executionContext);
        case 'listsvgassetpacks':
            return listSvgAssetPacks(args);
        case 'listsvgassets':
            return listSvgAssets(args);
        case 'getsvgasset':
            return getSvgAsset(args);
        case 'getsvgassetpack':
            return getSvgAssetPack(args);
        case 'upsertsvgassetpack':
        case 'savesvgassetpack':
            return upsertSvgAssetPack(args, executionContext);
        case 'deletesvgassetpack':
            return deleteSvgAssetPack(args, executionContext);
        case 'submitsourcepr':
            return submitSourcePr(args, executionContext);
        case 'updatechartdata':
            return updateChartData(args, executionContext);
        case 'addslide':
            return mutateSlide(args, 'addSlide', executionContext);
        case 'insertslide':
            return mutateSlide(args, 'insertSlide', executionContext);
        case 'deleteslide':
            return mutateSlide(args, 'deleteSlide', executionContext);
        case 'updatepresentationconfig':
        case 'updatesceneconfig':
        case 'setpresentationconfig':
            return updatePresentationConfig(args, executionContext);
        case 'createscriptoriumproject':
        case 'createproject':
            return createProject(args, executionContext);
        case 'listdocuments':
            return listDocuments();
        case 'opendocument':
            return openDocument(args);
        case 'getstorageinfo':
            return resultText(
                'Scriptorium 工程存储约定',
                requireControl().getStorageInfo()
            );
        default:
            throw new Error(
                '[ScriptoriumCollaborator] 不支持的 command。可用值：ListFonts、GetDocumentInfo、GetRenderedText、GetOutline、GetSection、GetSource、SearchSource、GetViewportSource、GetVisualContext、GetBoard、UpdateBoard、GetPrHistory、ListStylePacks、GetStylePack、UpsertStylePack、DeleteStylePack、ListSvgAssetPacks、ListSvgAssets、GetSvgAsset、GetSvgAssetPack、UpsertSvgAssetPack、DeleteSvgAssetPack、SubmitSourcePr、UpdateChartData、AddSlide、InsertSlide、DeleteSlide、UpdatePresentationConfig、CreateProject、ListDocuments、OpenDocument、GetStorageInfo。'
            );
    }
}

function serialStepSummary(step) {
    if (step.status === 'failed') {
        return `- 步骤 ${step.index} · ${step.command}：失败 — ${step.error}`;
    }
    if (step.type === 'wait') {
        return `- 步骤 ${step.index} · ${step.command}：已等待 ${step.waitMs} ms`;
    }
    const stability = step.output?.details?.visualStability;
    const stabilization = stability?.slideChanged
        ? `（切页后渲染稳定等待 ${stability.stabilizationMs} ms 上限）`
        : '';
    return `- 步骤 ${step.index} · ${step.command}：成功${stabilization}`;
}

async function processSerialToolCall(rawArgs, executionContext = {}) {
    const entries = getSerialCommandEntries(rawArgs);
    const steps = [];
    let failedStep = null;

    for (const entry of entries) {
        const stepArgs = extractSerialStepArgs(rawArgs, entry.index);
        const stepContext = {
            ...executionContext,
            requestId: executionContext.requestId
                ? `${executionContext.requestId}:${entry.index}`
                : undefined,
        };

        try {
            if (isWaitCommand(entry.command)) {
                const waitMs = parseWaitMs(stepArgs);
                await delay(waitMs);
                steps.push({
                    index: entry.index,
                    command: entry.command,
                    type: 'wait',
                    status: 'success',
                    waitMs,
                });
                continue;
            }

            const output = await processSingleToolCall(stepArgs, stepContext);
            steps.push({
                index: entry.index,
                command: entry.command,
                type: 'command',
                status: 'success',
                output,
            });
        } catch (error) {
            failedStep = {
                index: entry.index,
                command: entry.command,
                type: isWaitCommand(entry.command) ? 'wait' : 'command',
                status: 'failed',
                error: error.message,
            };
            steps.push(failedStep);
            break;
        }
    }

    const completedSteps = steps.filter((step) => step.status === 'success');
    const content = [{
        type: 'text',
        text: [
            failedStep
                ? '# Scriptorium 串行指令部分完成'
                : '# Scriptorium 串行指令执行完成',
            '',
            ...steps.map(serialStepSummary),
            failedStep ? '' : null,
            failedStep ? `步骤 ${failedStep.index} 失败，后续步骤已停止；此前 ${completedSteps.length} 个步骤的回执保留如下。` : null,
        ].filter((line) => line !== null).join('\n'),
    }];

    // 保留每个成功步骤的完整多模态回执，包括多张截图。
    for (const step of completedSteps) {
        if (!Array.isArray(step.output?.content)) continue;
        content.push({
            type: 'text',
            text: `## 步骤 ${step.index} · ${step.command} 回执`,
        });
        content.push(...step.output.content);
    }

    return {
        content,
        details: {
            command: 'SerialExecute',
            status: failedStep ? 'partial_failure' : 'success',
            requestedCount: entries.length,
            completedCount: completedSteps.length,
            stopped: Boolean(failedStep),
            failedStep,
            steps: steps.map((step) => ({
                index: step.index,
                command: step.command,
                type: step.type,
                status: step.status,
                waitMs: step.waitMs,
                error: step.error,
                details: step.output?.details || null,
            })),
        },
    };
}

async function processToolCall(args = {}, executionContext = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('[ScriptoriumCollaborator] 无效的工具参数。');
    }
    if (getSerialCommandEntries(args).length) {
        return processSerialToolCall(args, executionContext);
    }
    return processSingleToolCall(args, executionContext);
}

function resetForTests() {
    runtime = { control: null, logger: console };
}

module.exports = {
    initialize,
    processToolCall,
    _test: {
        commandOf,
        internalSlideIndex,
        internalizePagePayload,
        externalizePageNumbers,
        markdownFence,
        markdownObject,
        resultText,
        outlineResultText,
        getSerialCommandEntries,
        extractSerialStepArgs,
        parseWaitMs,
        parseVisualDelayMs,
        isVisualCommand,
        parseObject,
        parseArray,
        booleanOf,
        presentationConfigFromArgs,
        defaultSourceKind,
        authorFromMaid,
        endpointFor,
        resetForTests,
    },
};