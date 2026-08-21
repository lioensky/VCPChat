'use strict';

(() => {
    const PACK_FORMAT = 'vcp-vdoc-style-pack';
    const PACK_VERSION = 1;
    const BUILTIN_PACK_ID = 'vcp.scriptorium.classics';
    const STYLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i;
    const ALLOWED_TARGETS = new Set(['inline', 'block', 'heading', 'paragraph']);
    const registry = new Map();
    const packRegistry = new Map();
    const listeners = new Set();

    const BUILTIN_PACK = {
        format: PACK_FORMAT,
        version: PACK_VERSION,
        manifest: {
            id: 'vcp.scriptorium.classics',
            name: '文坊经典样式',
            description: '适合中文原生文档的基础高级样式。',
            author: 'VCP Scriptorium',
            createdAt: '2026-08-09T00:00:00.000Z',
        },
        styles: [
            {
                id: 'vcp.emphasis.vermillion',
                version: 1,
                name: '朱砂着重',
                description: '以克制的朱砂色和笔锋式底线强调关键文字。',
                category: '文字强调',
                tags: ['中文', '强调', '朱砂'],
                targets: ['inline'],
                previewText: '真正重要的文字，应当被温柔地看见。',
                className: 'vds-vermillion',
                css: `
.vds-vermillion {
    color: #9f2d20;
    font-weight: 700;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, #c44735 58%, transparent);
    text-decoration-thickness: .12em;
    text-underline-offset: .22em;
    text-decoration-skip-ink: auto;
}`,
            },
            {
                id: 'vcp.emphasis.gold-breath',
                version: 1,
                name: '鎏金呼吸',
                description: '适合少量核心语句的低频纯 CSS 光泽动画。',
                category: '动态强调',
                tags: ['动画', '鎏金', '强调'],
                targets: ['inline', 'heading'],
                previewText: '文字与光，共同缓慢呼吸。',
                className: 'vds-gold-breath',
                css: `
.vds-gold-breath {
    color: #75501f;
    font-weight: 750;
    background: linear-gradient(105deg, #75501f 15%, #d5a94f 42%, #fff0aa 50%, #d5a94f 58%, #75501f 85%);
    background-size: 240% 100%;
    background-position: 100% 50%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: vds-gold-breath-shine 5.8s ease-in-out infinite;
}
@keyframes vds-gold-breath-shine {
    0%, 72%, 100% { background-position: 100% 50%; }
    86% { background-position: 0% 50%; }
}
@media (prefers-reduced-motion: reduce) {
    .vds-gold-breath { animation: none; background-position: 50% 50%; }
}`,
            },
            {
                id: 'vcp.block.ink-quote',
                version: 1,
                name: '墨痕引文',
                description: '将选中段落转化为具有东方纸墨气质的引文块。',
                category: '段落容器',
                tags: ['引用', '纸墨', '中文'],
                targets: ['block', 'paragraph'],
                previewText: '文化并不是静止的答案，而是每一代人继续书写的提问。',
                className: 'vds-ink-quote',
                css: `
.vds-ink-quote {
    position: relative;
    margin: 1.6em 0;
    padding: 1.15em 1.4em 1.15em 1.8em;
    border-left: .22em solid #393f3b;
    color: #303733;
    background:
        radial-gradient(circle at 92% 18%, rgba(44, 51, 47, .08), transparent 28%),
        linear-gradient(110deg, rgba(44, 51, 47, .075), rgba(139, 94, 52, .035));
    box-shadow: inset 0 0 0 1px rgba(44, 51, 47, .08);
}
.vds-ink-quote::before {
    content: "“";
    position: absolute;
    top: -.18em;
    left: .14em;
    color: rgba(44, 51, 47, .18);
    font-size: 3.6em;
    line-height: 1;
    pointer-events: none;
}`,
            },
            {
                id: 'vcp.block.scholarly-note',
                version: 1,
                name: '学者笺注',
                description: '用于补充背景、译注与 AI 润色说明的低干扰信息块。',
                category: '段落容器',
                tags: ['注释', '说明', '学术'],
                targets: ['block', 'paragraph'],
                previewText: '笺注：此处可补充概念背景、出处或译者说明。',
                className: 'vds-scholarly-note',
                css: `
.vds-scholarly-note {
    margin: 1.35em 0;
    padding: .9em 1.15em;
    border: 1px solid rgba(67, 91, 81, .2);
    border-radius: .35em;
    color: #43534c;
    background: rgba(91, 126, 109, .075);
    font-size: .92em;
    line-height: 1.75;
}
.vds-scholarly-note::before {
    content: "笺注";
    display: inline-block;
    margin-right: .75em;
    color: #526f61;
    font: 750 .72em/1.5 system-ui, sans-serif;
    letter-spacing: .16em;
}`,
            },
            {
                id: 'vcp.heading.mountain',
                version: 1,
                name: '远山章题',
                description: '以留白、细线和轻微入场动画塑造章节标题。',
                category: '标题',
                tags: ['标题', '章节', '动画'],
                targets: ['heading', 'block'],
                previewText: '第二章　群山仍在回响',
                className: 'vds-mountain-heading',
                css: `
.vds-mountain-heading {
    position: relative;
    margin: 1.8em 0 .85em;
    padding-bottom: .45em;
    color: #26332d;
    letter-spacing: .04em;
    text-wrap: balance;
    animation: vds-mountain-enter .7s cubic-bezier(.2, .75, .25, 1) both;
}
.vds-mountain-heading::after {
    content: "";
    display: block;
    width: min(9em, 72%);
    height: 1px;
    margin-top: .45em;
    background: linear-gradient(90deg, #657c70, transparent);
    transform-origin: left center;
    animation: vds-mountain-line .9s .12s cubic-bezier(.2, .75, .25, 1) both;
}
@keyframes vds-mountain-enter {
    from { opacity: 0; transform: translateY(.35em); }
    to { opacity: 1; transform: translateY(0); }
}
@keyframes vds-mountain-line {
    from { opacity: 0; transform: scaleX(.15); }
    to { opacity: 1; transform: scaleX(1); }
}`,
            },
        ],
    };

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function sanitizeCss(css) {
        const sanitizer = window.VDocCore?.sanitizeCss;
        const source = sanitizer ? sanitizer(css) : String(css || '');
        return source
            .replace(/@import\s+[^;]+;?/gi, '')
            .replace(/(?:^|[}\s])(?:html|body|:root)\s*[{,]/gi, (match) => match.replace(/(?:html|body|:root)/i, ':host'))
            .trim();
    }

    function normalizeStyle(input, packId = 'local') {
        if (!input || typeof input !== 'object') throw new Error('高级样式必须是对象。');
        const id = String(input.id || '').trim();
        if (!STYLE_ID_PATTERN.test(id)) throw new Error(`无效的高级样式 ID：${id || '（空）'}`);
        const targets = [...new Set(
            (Array.isArray(input.targets) ? input.targets : ['inline'])
                .map((target) => String(target).toLowerCase())
                .filter((target) => ALLOWED_TARGETS.has(target))
        )];
        if (!targets.length) throw new Error(`样式 ${id} 没有有效的适用目标。`);
        const className = String(input.className || `vds-${id.replace(/[^a-z0-9_-]+/gi, '-')}`)
            .replace(/[^a-z0-9_-]/gi, '-');
        const css = sanitizeCss(input.css);
        if (!css) throw new Error(`样式 ${id} 缺少 CSS。`);
        return Object.freeze({
            id,
            version: Math.max(1, Number(input.version) || 1),
            name: String(input.name || id),
            description: String(input.description || ''),
            category: String(input.category || '其他'),
            tags: [...new Set((Array.isArray(input.tags) ? input.tags : []).map(String).filter(Boolean))],
            targets,
            previewText: String(input.previewText || '高级样式预览文字'),
            className,
            css,
            packId: String(packId || 'local'),
            author: String(input.author || ''),
            createdBy: input.createdBy === 'ai' ? 'ai' : (input.createdBy === 'human' ? 'human' : 'unknown'),
        });
    }

    function validatePack(input) {
        if (!input || typeof input !== 'object') throw new Error('样式包内容无效。');
        if (input.format !== PACK_FORMAT) throw new Error('这不是 VCP 高级样式包。');
        if (Number(input.version) !== PACK_VERSION) {
            throw new Error(`不支持的样式包版本：${input.version}`);
        }
        const manifest = input.manifest && typeof input.manifest === 'object' ? input.manifest : {};
        const packId = String(manifest.id || '').trim();
        if (!STYLE_ID_PATTERN.test(packId)) throw new Error('样式包缺少有效的 manifest.id。');
        if (!Array.isArray(input.styles) || !input.styles.length) throw new Error('样式包中没有样式。');
        const styles = input.styles.map((style) => normalizeStyle(style, packId));
        const duplicateIds = styles
            .map((style) => style.id)
            .filter((id, index, ids) => ids.indexOf(id) !== index);
        if (duplicateIds.length) throw new Error(`样式包中存在重复 ID：${duplicateIds.join('、')}`);
        return {
            format: PACK_FORMAT,
            version: PACK_VERSION,
            manifest: {
                id: packId,
                name: String(manifest.name || packId),
                description: String(manifest.description || ''),
                author: String(manifest.author || ''),
                createdAt: manifest.createdAt || new Date().toISOString(),
            },
            styles,
        };
    }

    function emit(type, detail) {
        const event = Object.freeze({ type, detail, styles: list() });
        listeners.forEach((listener) => {
            try {
                listener(event);
            } catch (error) {
                console.error('[VDocStyleLibrary] Listener failed:', error);
            }
        });
    }

    function assertPackMutable(packId, options = {}) {
        if (packId === BUILTIN_PACK_ID && options.internal !== true) {
            throw new Error('Scriptorium 内置经典样式包是只读的。');
        }
    }

    function register(styleInput, options = {}) {
        const style = normalizeStyle(styleInput, options.packId);
        const existing = registry.get(style.id);
        if (existing?.packId === BUILTIN_PACK_ID && options.internal !== true) {
            throw new Error(`内置高级样式 ${style.id} 是只读的。`);
        }
        if (existing && existing.packId !== style.packId) {
            throw new Error(
                `高级样式 ${style.id} 已属于样式包 ${existing.packId}。`
            );
        }
        if (existing && options.conflict !== 'replace') {
            if (options.conflict === 'keep'
                || existing.version >= style.version) {
                return existing;
            }
            throw new Error(`高级样式 ${style.id} 已存在。`);
        }
        registry.set(style.id, style);
        emit(existing ? 'replace' : 'register', style);
        return style;
    }

    function registerPack(packInput, options = {}) {
        const pack = validatePack(packInput);
        const packId = pack.manifest.id;
        assertPackMutable(packId, options);
        const previous = packRegistry.get(packId);
        const conflict = options.conflict || 'keep';
        if (previous && conflict !== 'replace') {
            if (conflict === 'keep') return getPack(packId);
            throw new Error(`高级样式包 ${packId} 已存在。`);
        }

        // 先完成整包冲突检查，再修改注册表，避免批量生成过程中只写入半包。
        pack.styles.forEach((style) => {
            const existing = registry.get(style.id);
            if (existing?.packId === BUILTIN_PACK_ID
                && options.internal !== true) {
                throw new Error(`内置高级样式 ${style.id} 是只读的。`);
            }
            if (existing && existing.packId !== packId) {
                throw new Error(
                    `高级样式 ${style.id} 已属于样式包 ${existing.packId}。`
                );
            }
        });

        const nextIds = new Set(pack.styles.map((style) => style.id));
        (previous?.styleIds || []).forEach((styleId) => {
            if (!nextIds.has(styleId)) registry.delete(styleId);
        });
        const registered = pack.styles.map((style) =>
            register(style, {
                packId,
                conflict: 'replace',
                internal: options.internal,
            })
        );
        packRegistry.set(packId, Object.freeze({
            manifest: Object.freeze({ ...pack.manifest }),
            styleIds: Object.freeze(registered.map((style) => style.id)),
            builtin: packId === BUILTIN_PACK_ID,
        }));
        emit(previous ? 'pack-replace' : 'pack-register', {
            manifest: pack.manifest,
            count: registered.length,
        });
        return getPack(packId);
    }

    function unregister(styleId, options = {}) {
        const style = registry.get(styleId);
        if (!style) return false;
        assertPackMutable(style.packId, options);
        registry.delete(styleId);
        const pack = packRegistry.get(style.packId);
        if (pack) {
            packRegistry.set(style.packId, Object.freeze({
                ...pack,
                styleIds: Object.freeze(
                    pack.styleIds.filter((id) => id !== style.id)
                ),
            }));
        }
        emit('unregister', style);
        return true;
    }

    function getPack(packId) {
        const record = packRegistry.get(String(packId));
        if (!record) return null;
        return clone({
            format: PACK_FORMAT,
            version: PACK_VERSION,
            manifest: record.manifest,
            builtin: record.builtin,
            editable: !record.builtin,
            styles: record.styleIds.map((styleId) => registry.get(styleId))
                .filter(Boolean)
                .map((style) => {
                    const output = { ...style };
                    delete output.packId;
                    return output;
                }),
        });
    }

    function listPacks() {
        return [...packRegistry.keys()].map((packId) => {
            const pack = getPack(packId);
            return {
                format: pack.format,
                version: pack.version,
                manifest: pack.manifest,
                builtin: pack.builtin,
                editable: pack.editable,
                styleCount: pack.styles.length,
                styles: pack.styles.map((style) => ({
                    id: style.id,
                    version: style.version,
                    name: style.name,
                    description: style.description,
                    category: style.category,
                    tags: style.tags,
                    targets: style.targets,
                    className: style.className,
                })),
            };
        }).sort((left, right) =>
            Number(right.builtin) - Number(left.builtin)
            || left.manifest.name.localeCompare(
                right.manifest.name,
                'zh-CN'
            )
        );
    }

    function unregisterPack(packId, options = {}) {
        const id = String(packId || '');
        const pack = packRegistry.get(id);
        if (!pack) return false;
        assertPackMutable(id, options);
        pack.styleIds.forEach((styleId) => registry.delete(styleId));
        packRegistry.delete(id);
        emit('pack-unregister', {
            manifest: pack.manifest,
            count: pack.styleIds.length,
        });
        return true;
    }

    function get(styleId) {
        return registry.get(String(styleId)) || null;
    }

    function list(filter = {}) {
        const query = String(filter.query || '').trim().toLowerCase();
        return [...registry.values()]
            .filter((style) => !filter.target || style.targets.includes(filter.target))
            .filter((style) => !filter.category || style.category === filter.category)
            .filter((style) => !query || [
                style.name,
                style.description,
                style.category,
                ...style.tags,
            ].some((value) => String(value).toLowerCase().includes(query)))
            .sort((a, b) => a.category.localeCompare(b.category, 'zh-CN')
                || a.name.localeCompare(b.name, 'zh-CN'))
            .map(clone);
    }

    function categories(target = null) {
        return [...new Set(
            [...registry.values()]
                .filter((style) => !target || style.targets.includes(target))
                .map((style) => style.category)
        )].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    }

    function compileCss(styleIds = null) {
        const selected = styleIds
            ? [...new Set(styleIds)].map(get).filter(Boolean)
            : [...registry.values()];
        return selected.map((style) => `/* ${style.name} · ${style.id}@${style.version} */\n${style.css}`).join('\n\n');
    }

    function exportPack(styleIds = null, manifest = {}) {
        const selected = styleIds
            ? [...new Set(styleIds)].map(get).filter(Boolean)
            : [...registry.values()];
        if (!selected.length) throw new Error('没有可导出的高级样式。');
        return {
            format: PACK_FORMAT,
            version: PACK_VERSION,
            manifest: {
                id: String(manifest.id || `vcp.user.${Date.now().toString(36)}`),
                name: String(manifest.name || '导出的高级样式'),
                description: String(manifest.description || ''),
                author: String(manifest.author || ''),
                createdAt: new Date().toISOString(),
            },
            styles: selected.map((style) => {
                const output = clone(style);
                delete output.packId;
                return output;
            }),
        };
    }

    function serializePack(styleIds = null, manifest = {}) {
        return JSON.stringify(exportPack(styleIds, manifest), null, 2);
    }

    function parsePack(bytesOrText) {
        let text = bytesOrText;
        if (bytesOrText instanceof Uint8Array || bytesOrText instanceof ArrayBuffer) {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytesOrText);
        }
        return validatePack(JSON.parse(String(text || '')));
    }

    function exportUserPacks() {
        return [...packRegistry.keys()]
            .filter((packId) => packId !== BUILTIN_PACK_ID)
            .map((packId) => {
                const pack = getPack(packId);
                return {
                    format: pack.format,
                    version: pack.version,
                    manifest: pack.manifest,
                    styles: pack.styles,
                };
            });
    }

    function replaceUserPacks(packs = []) {
        [...packRegistry.keys()]
            .filter((packId) => packId !== BUILTIN_PACK_ID)
            .forEach((packId) => unregisterPack(packId));
        (Array.isArray(packs) ? packs : []).forEach((pack) =>
            registerPack(pack, { conflict: 'replace' })
        );
        return exportUserPacks();
    }

    function createPreviewDocument(styleId, options = {}) {
        const style = get(styleId);
        if (!style) throw new Error(`未找到高级样式：${styleId}`);
        const text = String(options.text || style.previewText);
        const tag = style.targets.includes('heading')
            ? 'h2'
            : style.targets.includes('block')
                ? 'div'
                : 'span';
        return {
            html: `<${tag} class="${style.className}"></${tag}>`,
            text,
            css: style.css,
            className: style.className,
            target: style.targets[0],
        };
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    registerPack(BUILTIN_PACK, {
        conflict: 'replace',
        internal: true,
    });

    window.VDocStyleLibrary = Object.freeze({
        PACK_FORMAT,
        PACK_VERSION,
        BUILTIN_PACK_ID,
        validatePack,
        normalizeStyle,
        register,
        registerPack,
        unregister,
        getPack,
        listPacks,
        unregisterPack,
        get,
        list,
        categories,
        compileCss,
        exportPack,
        serializePack,
        parsePack,
        exportUserPacks,
        replaceUserPacks,
        createPreviewDocument,
        subscribe,
    });
})();