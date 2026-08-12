'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');

const PROJECT_TYPES = Object.freeze({
    docx: Object.freeze({
        endpoint: 'docx',
        extension: '.vdocx',
        directory: 'VDOCX',
        kind: 'flow-document',
    }),
    pptx: Object.freeze({
        endpoint: 'pptx',
        extension: '.vpptx',
        directory: 'VPPTX',
        kind: 'slide-deck',
    }),
});

const CONFLICT_POLICIES = new Set(['rename', 'error', 'overwrite']);
const DEFAULT_SCREENSHOT_OPTIONS = Object.freeze({
    format: 'jpeg',
    quality: 85,
});

const CJK_FONT_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]|(?:cjk|source\s*han|noto\s+(?:sans|serif)\s+(?:sc|tc|hk|jp|kr)|yahei|simsun|simhei|kaiti|fangsong|dengxian|songti|heiti|pingfang|hiragino|meiryo|yu\s+(?:gothic|mincho)|malgun|batang|gulim|mingliu|jhenghei|ms\s+(?:gothic|mincho))/i;

function normalizeFontLanguage(value) {
    const normalized = String(value || 'all').trim().toLowerCase();
    if (['all', '*', 'any'].includes(normalized)) return 'all';
    if (['zh', 'zh-cn', 'zh-hans', 'chinese', 'cn', '中文'].includes(normalized)) {
        return 'zh-CN';
    }
    if (['en', 'en-us', 'en-gb', 'english', 'latin', '英文'].includes(normalized)) {
        return 'en';
    }
    const error = new Error('字体 language 仅支持 all、zh-CN（中文）或 en（英文/拉丁）。');
    error.code = 'INVALID_FONT_LANGUAGE';
    throw error;
}

function fontMatchesLanguage(font, language) {
    if (language === 'all') return true;
    const cjk = CJK_FONT_PATTERN.test(String(font || ''));
    return language === 'zh-CN' ? cjk : !cjk;
}

function normalizeMaid(value) {
    if (typeof value === 'string') {
        const name = value.trim();
        return name ? { id: name, name, type: 'agent' } : null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const name = String(value.name || value.signature || value.id || '').trim();
    if (!name) return null;
    return {
        id: String(value.id || name).trim(),
        name,
        type: value.type === 'human' ? 'human' : 'agent',
    };
}

function requireMaid(value) {
    const maid = normalizeMaid(value);
    if (!maid) {
        const error = new Error('Scriptorium Agent 写操作必须提供 maid 署名字段。');
        error.code = 'MAID_REQUIRED';
        throw error;
    }
    return maid;
}

function normalizeProjectType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['docx', 'vdocx', 'document', 'flow-document'].includes(normalized)) return 'docx';
    if (['pptx', 'vpptx', 'presentation', 'slide-deck'].includes(normalized)) return 'pptx';
    const error = new Error('projectType 必须为 docx 或 pptx。');
    error.code = 'INVALID_PROJECT_TYPE';
    throw error;
}

function safeBaseName(value, fallback) {
    const sanitized = String(value || fallback)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[.\s]+$/g, '')
        .trim();
    return sanitized || fallback;
}

function normalizeFileName(value, projectType) {
    const config = PROJECT_TYPES[projectType];
    const fallback = projectType === 'pptx' ? '未命名演示' : '未命名文稿';
    const supplied = path.basename(String(value || fallback));
    const withoutKnownExtension = supplied.replace(/\.(?:vdocx|vpptx)$/i, '');
    return `${safeBaseName(withoutKnownExtension, fallback)}${config.extension}`;
}

function sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

async function uniquePath(requestedPath) {
    if (!await fs.pathExists(requestedPath)) return requestedPath;
    const extension = path.extname(requestedPath);
    const basePath = requestedPath.slice(0, -extension.length);
    for (let index = 1; index <= 10000; index += 1) {
        const candidate = `${basePath} (${index})${extension}`;
        if (!await fs.pathExists(candidate)) return candidate;
    }
    throw new Error('无法为 Scriptorium 工程分配不重名文件名。');
}

class ScriptoriumAgentControlService {
    constructor() {
        this.appDataRoot = null;
        this.documentRoot = null;
        this.documentHandlers = null;
        this.logger = console;
        this.initialized = false;
    }

    initialize(options = {}) {
        if (this.initialized) return this;
        if (!options.appDataRoot) {
            throw new Error('[ScriptoriumAgentControl] 缺少 appDataRoot。');
        }
        if (!options.documentHandlers) {
            throw new Error('[ScriptoriumAgentControl] 缺少 documentHandlers。');
        }
        this.appDataRoot = path.resolve(options.appDataRoot);
        this.documentRoot = path.join(this.appDataRoot, 'ScriptoriumDocument');
        this.documentHandlers = options.documentHandlers;
        this.logger = options.logger || console;
        this.initialized = true;
        return this;
    }

    assertReady() {
        if (!this.initialized || !this.documentHandlers) {
            throw new Error('[ScriptoriumAgentControl] 服务尚未初始化。');
        }
    }

    async ensureWindow() {
        this.assertReady();
        const win = await this.documentHandlers.openDocxWindow();
        if (!win || win.isDestroyed()) {
            throw new Error('Scriptorium 窗口无法打开。');
        }
        const startedAt = Date.now();
        while (Date.now() - startedAt < 20000) {
            const ready = await win.webContents.executeJavaScript(
                'Boolean(window.ScriptoriumAgent && window.ScriptoriumAgent.current)',
                true
            ).catch(() => false);
            if (ready) return win;
            await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error('Scriptorium Agent 渲染内核未在限定时间内就绪。');
    }

    async call(request = {}) {
        this.assertReady();
        await this.ensureWindow();
        return this.documentHandlers.requestAgentOperation(request);
    }

    async listFonts(options = {}) {
        this.assertReady();
        const language = normalizeFontLanguage(options.language);
        const fonts = await this.documentHandlers.getSystemFonts(
            options.forceRefresh === true
        );
        return {
            language,
            fonts: fonts.filter((font) => fontMatchesLanguage(font, language)),
        };
    }

    async captureVisualContext(request = {}) {
        const win = await this.ensureWindow();
        const semantic = await this.call({
            requestId: request.requestId,
            endpoint: request.endpoint || 'common',
            method: 'getVisualContext',
            payload: {
                scope: request.scope || 'viewport',
                slideIndex: request.slideIndex,
                stabilizationMs: request.stabilizationMs
                    ?? request.renderStabilizationMs
                    ?? request.visualDelayMs
                    ?? request.captureDelayMs
                    ?? request.screenshotDelayMs,
            },
        });
        const captureRect = semantic?.captureRect;
        const rect = captureRect && Number.isFinite(Number(captureRect.width))
            && Number.isFinite(Number(captureRect.height))
            ? {
                x: Math.max(0, Math.round(Number(captureRect.x) || 0)),
                y: Math.max(0, Math.round(Number(captureRect.y) || 0)),
                width: Math.max(1, Math.round(Number(captureRect.width))),
                height: Math.max(1, Math.round(Number(captureRect.height))),
            }
            : undefined;
        const format = String(request.format || DEFAULT_SCREENSHOT_OPTIONS.format).toLowerCase();
        const image = await win.webContents.capturePage(rect);
        const dataUrl = format === 'png'
            ? `data:image/png;base64,${image.toPNG().toString('base64')}`
            : `data:image/jpeg;base64,${image.toJPEG(
                Math.max(1, Math.min(100, Number(request.quality)
                    || DEFAULT_SCREENSHOT_OPTIONS.quality))
            ).toString('base64')}`;
        return {
            content: [
                {
                    type: 'text',
                    text: [
                        '# Scriptorium 渲染后视觉上下文',
                        '',
                        `- 文档：${semantic.title || semantic.name || '未命名'}`,
                        `- 类型：${semantic.documentKind || 'unknown'}`,
                        `- 范围：${semantic.scope || request.scope || 'viewport'}`,
                        semantic.activeSlideIndex === null || semantic.activeSlideIndex === undefined
                            ? ''
                            : `- 幻灯片：第 ${semantic.activeSlideIndex + 1} 页`,
                        '',
                        semantic.renderedText || semantic.text || '',
                    ].filter(Boolean).join('\n'),
                },
                { type: 'image_url', image_url: { url: dataUrl } },
            ],
            details: {
                ...semantic,
                captureRect: rect || null,
                imageFormat: format === 'png' ? 'png' : 'jpeg',
            },
        };
    }

    async resolveTargetPath(fileName, projectType, conflictPolicy, expectedFileHash) {
        const config = PROJECT_TYPES[projectType];
        const directory = path.join(this.documentRoot, config.directory);
        const requestedPath = path.join(directory, normalizeFileName(fileName, projectType));
        await fs.ensureDir(directory);
        if (!await fs.pathExists(requestedPath)) return requestedPath;

        if (conflictPolicy === 'rename') return uniquePath(requestedPath);
        if (conflictPolicy === 'error') {
            const error = new Error(`工程文件已存在：${path.basename(requestedPath)}`);
            error.code = 'FILE_EXISTS';
            throw error;
        }

        if (!expectedFileHash) {
            const error = new Error('覆盖已有工程必须提供 expectedFileHash。');
            error.code = 'EXPECTED_FILE_HASH_REQUIRED';
            throw error;
        }
        const currentHash = sha256(await fs.readFile(requestedPath));
        if (currentHash !== String(expectedFileHash).toLowerCase()) {
            const error = new Error('目标工程已发生变化，拒绝覆盖。');
            error.code = 'FILE_HASH_CONFLICT';
            error.expectedFileHash = String(expectedFileHash).toLowerCase();
            error.actualFileHash = currentHash;
            throw error;
        }
        return requestedPath;
    }

    async createProjectArtifact(payload = {}) {
        const maid = requireMaid(payload.maid);
        const projectType = normalizeProjectType(payload.projectType || payload.type);
        const conflictPolicy = String(payload.conflictPolicy || 'rename').toLowerCase();
        if (!CONFLICT_POLICIES.has(conflictPolicy)) {
            throw new Error('conflictPolicy 必须为 rename、error 或 overwrite。');
        }
        const requestId = String(payload.requestId || crypto.randomUUID());
        const normalized = await this.call({
            requestId,
            endpoint: 'common',
            method: 'buildProjectArtifact',
            payload: {
                requestId,
                projectType,
                title: payload.title,
                source: projectType === 'docx' ? payload.source : undefined,
                documentCss: projectType === 'docx'
                    ? payload.documentCss
                    : undefined,
                deckCss: projectType === 'pptx' ? payload.deckCss : undefined,
                slides: projectType === 'pptx' ? payload.slides : undefined,
                page: payload.page,
                presentation: payload.presentation,
                maid,
                summary: String(payload.summary || '创建完整 Scriptorium 工程').trim(),
            },
        });
        if (!normalized?.success) {
            const programmableContent = normalized?.programmableContent || null;
            if (normalized?.code === 'PROGRAMMABLE_CONTENT_REFUSED') {
                return {
                    content: [{
                        type: 'text',
                        text: [
                            '# Scriptorium 工程创建已拒绝',
                            '',
                            `- 状态：${programmableContent?.status || 'refuse'}`,
                            `- 原因：${normalized.message || '可编程内容未通过安全审查。'}`,
                            ...(programmableContent?.diagnostics || []).map((item) =>
                                `- [${item.level}] ${item.ruleId || 'programmable-content'}：${item.message}`
                            ),
                            '',
                            '未创建或写入任何工程文件。',
                        ].join('\n'),
                    }],
                    details: {
                        command: 'CreateProject',
                        success: false,
                        code: normalized.code,
                        message: normalized.message,
                        projectType,
                        fileCreated: false,
                        programmableContent,
                    },
                };
            }
            throw new Error(normalized?.message || 'Scriptorium 工程规范化失败。');
        }
        if (!normalized.bytes) {
            throw new Error('Scriptorium 工程规范化未返回 ZIP 字节。');
        }

        const artifactBytes = Buffer.from(normalized.bytes);
        const maximumBytes = 100 * 1024 * 1024;
        if (!artifactBytes.length || artifactBytes.length > maximumBytes) {
            throw new Error('规范化后的 ZIP 工程为空或超过 100 MB 安全上限。');
        }
        if (artifactBytes[0] !== 0x50 || artifactBytes[1] !== 0x4b) {
            throw new Error('Scriptorium 工程规范化结果不是有效 ZIP 容器。');
        }
        const targetPath = await this.resolveTargetPath(
            payload.fileName || normalized.suggestedName || payload.title,
            projectType,
            conflictPolicy,
            payload.expectedFileHash
        );
        const writeResult = await this.documentHandlers.writeProjectArtifact(
            targetPath,
            artifactBytes
        );
        if (!writeResult?.success) {
            throw new Error(writeResult?.message || 'Scriptorium 工程写入失败。');
        }
        const fileHash = sha256(artifactBytes);
        const stats = await fs.stat(targetPath);

        const openRequested = payload.openAfterCreate === true;
        if (openRequested) {
            await this.documentHandlers.openDocxWindow({ filePath: targetPath });
        }
        const programmableContent = normalized.programmableContent || {
            status: 'allow',
            dependencies: [],
            diagnostics: [],
        };
        return {
            content: [{
                type: 'text',
                text: [
                    '# Scriptorium 工程已创建',
                    '',
                    `- 文件：${path.basename(targetPath)}`,
                    `- 类型：${projectType === 'pptx' ? 'VPPTX' : 'VDOCX'}`,
                    `- 署名：${maid.name}`,
                    `- 路径：${targetPath}`,
                    `- SHA-256：${fileHash}`,
                    `- 可编程内容审查：${programmableContent.status}`,
                    programmableContent.dependencies?.length
                        ? `- 内置动画依赖：${programmableContent.dependencies.join('、')}`
                        : '- 内置动画依赖：无',
                    ...(programmableContent.diagnostics || []).map((item) =>
                        `- [${item.level}] ${item.ruleId || 'programmable-content'}：${item.message}`
                    ),
                    openRequested
                        ? '- 打开状态：已请求在 Scriptorium 中打开；若当前文档有未保存修改，最终是否切换由人类确认。'
                        : '- 打开状态：仅完成落盘，未请求切换当前窗口文档。',
                ].join('\n'),
            }],
            details: {
                command: 'CreateProject',
                projectType,
                documentId: normalized.documentId,
                title: normalized.title,
                path: targetPath,
                fileName: path.basename(targetPath),
                fileHash,
                size: stats.size,
                conflictPolicy,
                maid,
                openRequested,
                currentWindowDocumentReplaced: false,
                programmableContent,
            },
        };
    }

    getStorageInfo() {
        this.assertReady();
        return {
            root: this.documentRoot,
            docxDirectory: path.join(this.documentRoot, PROJECT_TYPES.docx.directory),
            pptxDirectory: path.join(this.documentRoot, PROJECT_TYPES.pptx.directory),
            defaultConflictPolicy: 'rename',
            overwriteRequiresExpectedFileHash: true,
        };
    }
}

module.exports = {
    ScriptoriumAgentControlService,
    PROJECT_TYPES,
    normalizeFontLanguage,
    fontMatchesLanguage,
    normalizeMaid,
    normalizeProjectType,
    normalizeFileName,
    sha256,
};