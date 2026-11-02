'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
// 文档样式库和版式（和文坊页面的新建面板共用一份）。
const docThemes = require('../../ScriptoriumModules/uttu-doc-themes.js');
const { kindOf, isOverlay } = require('../uttu/scriptoriumTypes');
const { looksLikeText } = require('../uttu/viewFiles');

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

// agents' throwaway work (an interactive demo, a small tool) goes to its own folder, shown under
// 文库 → 临时, so it does not crowd the user's documents. Both kinds of project live there.
const TEMPORARY_DIRECTORY = '临时';

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

    // 文坊可以在主窗口右栏，也可以在独立窗口（docxHandlers.openScriptorium 选宿主）；
    // 这里拿到的是宿主的 webContents，右栏里没有时会在后台建一份，不切换用户正在看的标签。
    async ensureHost(options = {}) {
        this.assertReady();
        const contents = await this.documentHandlers.openScriptorium(options);
        if (!contents || contents.isDestroyed()) {
            throw new Error('文坊无法打开。');
        }
        const startedAt = Date.now();
        while (Date.now() - startedAt < 20000) {
            const ready = await contents.executeJavaScript(
                'Boolean(window.ScriptoriumAgent && window.ScriptoriumAgent.current)',
                true
            ).catch(() => false);
            if (ready) return contents;
            await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error('Scriptorium Agent 渲染内核未在限定时间内就绪。');
    }

    async call(request = {}) {
        this.assertReady();
        await this.ensureHost();
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
        const contents = await this.ensureHost();
        // 先滚到指定的章节或可编程岛再截，Agent 能自己核对文档后面的图和交互（之前只能截当前视口）。
        let scrolledTo = null;
        if (request.section || request.island) {
            scrolledTo = await contents.executeJavaScript(`(() => {
                const section = ${JSON.stringify(String(request.section || '').trim())};
                const island = ${JSON.stringify(String(request.island || '').trim())};
                const roots = ['page-stream', 'read-page-stream']
                    .map((id) => document.getElementById(id))
                    .filter((host) => host && host.closest('[hidden]') === null && host.shadowRoot)
                    .map((host) => host.shadowRoot);
                for (const root of roots) {
                    const target = island
                        ? [...root.querySelectorAll('[data-vdoc-island]')].find((node) => node.dataset.vdocIsland === island)
                        : [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].find((node) => node.textContent.includes(section));
                    if (target) {
                        target.scrollIntoView({ block: 'start' });
                        return island ? 'island:' + island : 'section:' + target.textContent.trim().slice(0, 80);
                    }
                }
                return null;
            })()`, true).catch(() => null);
            if (!scrolledTo) {
                const error = new Error(request.island
                    ? `当前文档里没有可编程岛 ${request.island}。`
                    : `当前文档里没有标题包含“${request.section}”的章节。`);
                error.code = 'TARGET_NOT_FOUND';
                throw error;
            }
            // 滚动后等两帧和一点时间，让懒加载的图、岛脚本和布局稳定下来。
            await new Promise((resolve) => setTimeout(resolve, 400));
        }
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
                ids: request.ids, // 白板只看这些元素或这一块
                region: request.region,
            },
        });
        // 白板自己导出一张图（uttu-scriptorium-agent.js），不截窗口。
        const { imageDataUrl, ...semanticFields } = semantic || {};
        if (imageDataUrl) {
            return {
                content: [
                    { type: 'text', text: ['# Scriptorium 白板', '', `- 文件：${semantic.title || semantic.name || '未命名'}`, `- 修订：${semantic.revision}`, '', semantic.renderedText || ''].join('\n') },
                    { type: 'image_url', image_url: { url: imageDataUrl } },
                ],
                details: { ...semanticFields, imageFormat: 'png' },
            };
        }
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
        const image = await contents.capturePage(rect);
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
                        scrolledTo ? `- 已滚到：${scrolledTo.replace(/^section:/, '章节 ').replace(/^island:/, '岛 ')}` : '',
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

    async resolveTargetPath(fileName, projectType, conflictPolicy, expectedFileHash, { temporary = false } = {}) {
        const config = PROJECT_TYPES[projectType];
        const directory = path.join(this.documentRoot, temporary ? TEMPORARY_DIRECTORY : config.directory);
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
        const temporary = payload.temporary === true || String(payload.temporary || '').toLowerCase() === 'true';
        // 文稿默认长页（屏幕上看的讲解、图解）；给了 theme 或没写 documentCss 时用样式库，Agent 只补局部样式。
        const layout = String(payload.layout || 'long').toLowerCase() === 'page' ? 'page' : 'long';
        const themeId = docThemes.theme(payload.theme)?.id || (payload.documentCss ? null : 'uttu-ink');
        const documentCss = themeId
            ? [docThemes.cssFor(themeId), payload.documentCss || ''].join('\n')
            : payload.documentCss;
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
                    ? documentCss
                    : undefined,
                pagination: projectType === 'docx'
                    ? { mode: layout === 'page' ? 'flow' : 'continuous' }
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
            payload.expectedFileHash,
            { temporary }
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

        // 新建的工程默认在右栏打开给用户看；Agent 明确 openAfterCreate: false 才只落盘。
        const openRequested = payload.openAfterCreate !== false;
        if (openRequested) {
            await this.documentHandlers.openScriptorium({ filePath: targetPath, reveal: true });
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
                    temporary ? '- 位置：临时文稿（文库的“临时”里，不混进正式文稿）' : '- 位置：正式文稿',
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
                temporary,
                maid,
                openRequested,
                currentWindowDocumentReplaced: false,
                programmableContent,
            },
        };
    }

    // Agent 找回已有文档、在原文档上继续改。
    async listDocuments() {
        this.assertReady();
        const documents = [];
        for (const [projectType, config] of Object.entries(PROJECT_TYPES)) {
            const directory = path.join(this.documentRoot, config.directory);
            const names = await fs.readdir(directory).catch(() => []);
            for (const name of names) {
                if (path.extname(name).toLowerCase() !== config.extension) continue;
                const filePath = path.join(directory, name);
                const stats = await fs.stat(filePath).catch(() => null);
                if (!stats?.isFile()) continue;
                documents.push({
                    fileName: name,
                    projectType,
                    path: filePath,
                    size: stats.size,
                    modifiedAt: stats.mtime.toISOString(),
                });
            }
        }
        const temporaryDirectory = path.join(this.documentRoot, TEMPORARY_DIRECTORY);
        for (const name of await fs.readdir(temporaryDirectory).catch(() => [])) {
            const projectType = Object.keys(PROJECT_TYPES)
                .find((type) => PROJECT_TYPES[type].extension === path.extname(name).toLowerCase());
            if (!projectType) continue;
            const filePath = path.join(temporaryDirectory, name);
            const stats = await fs.stat(filePath).catch(() => null);
            if (!stats?.isFile()) continue;
            documents.push({
                fileName: name,
                projectType,
                temporary: true,
                path: filePath,
                size: stats.size,
                modifiedAt: stats.mtime.toISOString(),
            });
        }
        documents.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
        return { root: this.documentRoot, documents };
    }

    // 打开文档目录里的工程（按文件名或完整路径找），或本机任意位置的 Markdown（完整路径，原地打开，改动审批合入后存回原文件）；
    // 打开后切到文坊标签给用户看。
    async openDocument(options = {}) {
        this.assertReady();
        const requested = String(options.path || options.fileName || '').trim();
        if (!requested) throw new Error('OpenDocument 需要 fileName 或 path。');
        const { documents } = await this.listDocuments();
        const wanted = path.isAbsolute(requested) ? path.resolve(requested).toLowerCase() : null;
        let match = documents.find((item) => (wanted
            ? path.resolve(item.path).toLowerCase() === wanted
            : item.fileName.toLowerCase() === requested.toLowerCase()));
        // .html 也原地打开，文坊当网页开。
        // PDF、表格也能开；读命令答开着的这份（ScriptoriumModules/uttu-scriptorium-agent.js）。
        let outsideType = kindOf(requested) === 'project' ? null : kindOf(requested);
        // Word、PowerPoint、RTF 导入成新工程；扩展名没登记的文本当文本开。
        if (!outsideType && wanted && /\.(docx|pptx|rtf)$/i.test(requested)) outsideType = 'imported';
        // 文档目录以外的工程写完整路径也能开；.vdocx 里是文字也不当文本，坏了让页面说打不开。
        if (!outsideType && wanted && kindOf(requested) === 'project') outsideType = /\.vpptx$/i.test(requested) ? 'pptx' : 'docx';
        if (!outsideType && wanted && await looksLikeText(requested)) outsideType = 'text';
        if (!match && wanted && outsideType) {
            const stats = await fs.stat(requested).catch(() => null);
            if (stats?.isFile()) {
                match = { fileName: path.basename(requested), projectType: outsideType,
                    path: path.resolve(requested), size: stats.size, modifiedAt: stats.mtime.toISOString() };
            }
        }
        if (!match) {
            const present = wanted && await fs.stat(requested).catch(() => null);
            const error = new Error(present
                ? `文坊打不开 ${path.extname(requested) || '没有扩展名的'} 文件。`
                : outsideType
                ? `找不到 ${requested}。工程以外的文件要写完整路径（比如 D:/notes/plan.md），文件要存在。`
                : `文档目录里没有 ${requested}。先用 ListDocuments 查文件名。`);
            error.code = 'DOCUMENT_NOT_FOUND';
            throw error;
        }
        await this.ensureHost({ filePath: match.path, reveal: options.reveal !== false });
        // 打开是异步的；当前文档有未保存的修改时还要等用户确认，等不到就照实说。
        const target = path.resolve(match.path).toLowerCase();
        const startedAt = Date.now();
        // 网页、PDF、表格盖在文稿上面：问页面现在开着的是不是这份。
        if (isOverlay(match.path) || outsideType === 'text') {
            const answer = `(() => { const UI = window.UTTUScriptoriumUI; return { shown: UI?.overlay?.()?.doc?.()?.filePath || '', refused: UI?.refused?.(${JSON.stringify(match.path)}) || '' }; })()`;
            while (Date.now() - startedAt < 8000) {
                const { shown, refused } = await this.documentHandlers.getHostContents?.()
                    ?.executeJavaScript(answer).catch(() => ({})) || {};
                if (shown && path.resolve(shown).toLowerCase() === target) return { ...match, opened: true, revision: null };
                if (refused) throw new Error(refused); // 页面说打不开，照实说，不等到超时
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            return { ...match, opened: false };
        }
        const importedTitle = outsideType === 'imported' ? path.parse(match.path).name.toLowerCase() : '';
        while (Date.now() - startedAt < 8000) {
            const info = await this.documentHandlers.requestAgentOperation({
                endpoint: 'common',
                method: 'getDocumentInfo',
            }).catch(() => null);
            // 网页、PDF、表格开着时 getDocumentInfo 答的是它们，这里的路径对不上，文稿露出来才算开好。
            if (info?.filePath && path.resolve(info.filePath).toLowerCase() === target) {
                return { ...match, opened: true, revision: info.revision ?? null };
            }
            if (importedTitle && !info?.filePath && String(info?.name || '').toLowerCase().startsWith(importedTitle)) {
                return { ...match, opened: true, imported: true, revision: info.revision ?? null };
            }
            const refused = await this.documentHandlers.getHostContents?.()
                ?.executeJavaScript(`window.UTTUScriptoriumUI?.refused?.(${JSON.stringify(match.path)}) || ''`).catch(() => '');
            if (refused) throw new Error(refused);
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return { ...match, opened: false };
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