'use strict';

const crypto = require('crypto');

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

function compactDetails(value) {
    if (!value || typeof value !== 'object') return {};
    const { serialized, snapshot, ...rest } = value;
    return rest;
}

function resultText(title, result) {
    return {
        content: [{
            type: 'text',
            text: [
                `# ${title}`,
                '',
                '```json',
                JSON.stringify(compactDetails(result), null, 2),
                '```',
            ].join('\n'),
        }],
        details: result,
    };
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
        payload,
    });
    return resultText(`Scriptorium · ${method}`, result);
}

async function getDocumentInfo(args) {
    return call(args, 'getDocumentInfo');
}

async function getRenderedText(args) {
    return call(args, 'getRenderedText', {
        slideIndex: args.slideIndex,
    });
}

async function getOutline(args) {
    return call(args, 'getOutline');
}

async function getSection(args) {
    return call(args, 'getSection', {
        id: args.id,
        index: args.index,
    }, 'docx');
}

async function getSource(args) {
    return call(args, 'getSource', {
        sourceKind: args.sourceKind || 'html',
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
        sourceKind: args.sourceKind || 'html',
        radius: args.radius,
    });
}

async function getVisualContext(args) {
    return requireControl().captureVisualContext({
        requestId: requestIdOf(args),
        endpoint: endpointFor(args),
        scope: args.scope || 'viewport',
        slideIndex: args.slideIndex,
        format: args.format || args.imageFormat,
        quality: args.quality,
    });
}

async function getPrHistory(args) {
    return call(args, 'getPrHistory', {
        limit: args.limit,
        status: args.status,
    });
}

async function submitSourcePr(args, executionContext = {}) {
    const replacements = args.replacements === undefined
        ? [{
            target: args.target,
            replace: args.replace ?? args.replacement ?? '',
            startLine: args.startLine,
        }]
        : parseArray(args.replacements, 'replacements');
    const maid = authorFromMaid(args, executionContext);
    return call(args, 'submitSourcePr', {
        requestId: requestIdOf(args, executionContext),
        sourceKind: args.sourceKind || 'html',
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
    const payload = {
        requestId: requestIdOf(args, executionContext),
        slideIndex: args.slideIndex,
        name: args.name,
        html: args.html,
        css: args.css,
        script: args.script,
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

async function createProject(args, executionContext = {}) {
    return requireControl().createProjectArtifact({
        requestId: requestIdOf(args, executionContext),
        projectType: args.projectType || args.type,
        fileName: args.fileName,
        title: args.title,
        html: args.html,
        css: args.css,
        slides: parseArray(args.slides, 'slides'),
        page: parseObject(args.page, 'page'),
        presentation: parseObject(args.presentation, 'presentation'),
        maid: authorFromMaid(args, executionContext),
        summary: args.summary,
        conflictPolicy: args.conflictPolicy || 'rename',
        expectedFileHash: args.expectedFileHash,
        openAfterCreate: booleanOf(args.openAfterCreate, false),
    });
}

async function processToolCall(args = {}, executionContext = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('[ScriptoriumCollaborator] 无效的工具参数。');
    }
    switch (commandOf(args)) {
        case 'getdocumentinfo':
            return getDocumentInfo(args);
        case 'getrenderedtext':
        case 'getfulltext':
            return getRenderedText(args);
        case 'getoutline':
            return getOutline(args);
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
            return getVisualContext(args);
        case 'getprhistory':
            return getPrHistory(args);
        case 'submitsourcepr':
            return submitSourcePr(args, executionContext);
        case 'addslide':
            return mutateSlide(args, 'addSlide', executionContext);
        case 'insertslide':
            return mutateSlide(args, 'insertSlide', executionContext);
        case 'deleteslide':
            return mutateSlide(args, 'deleteSlide', executionContext);
        case 'createscriptoriumproject':
        case 'createproject':
            return createProject(args, executionContext);
        case 'getstorageinfo':
            return resultText(
                'Scriptorium 工程存储约定',
                requireControl().getStorageInfo()
            );
        default:
            throw new Error(
                '[ScriptoriumCollaborator] 不支持的 command。可用值：GetDocumentInfo、GetRenderedText、GetOutline、GetSection、GetSource、SearchSource、GetViewportSource、GetVisualContext、GetPrHistory、SubmitSourcePr、AddSlide、InsertSlide、DeleteSlide、CreateProject、GetStorageInfo。'
            );
    }
}

function resetForTests() {
    runtime = { control: null, logger: console };
}

module.exports = {
    initialize,
    processToolCall,
    _test: {
        commandOf,
        parseObject,
        parseArray,
        booleanOf,
        authorFromMaid,
        endpointFor,
        resetForTests,
    },
};