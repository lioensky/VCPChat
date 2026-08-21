'use strict';

(() => {
    const PACK_FORMAT = 'vcp-vdoc-svg-asset-pack';
    const PACK_VERSION = 1;
    const BUILTIN_PACK_ID = 'vcp.scriptorium.basic-shapes';
    const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i;
    const MAX_SOURCE_BYTES = 512 * 1024;
    const MAX_NODES = 3000;
    const MAX_ANIMATIONS = 120;
    const registry = new Map();
    const packRegistry = new Map();
    const listeners = new Set();

    const BUILTIN_ASSETS = [
        ['rectangle', '矩形', '<rect x="3" y="3" width="94" height="94" rx="3" fill="#4f8f80" stroke="#245c50" stroke-width="3"/>'],
        ['rounded', '圆角矩形', '<rect x="3" y="3" width="94" height="94" rx="18" fill="#d9a441" stroke="#7f5d1e" stroke-width="3"/>'],
        ['ellipse', '椭圆', '<ellipse cx="50" cy="50" rx="47" ry="38" fill="#8b6fb1" stroke="#514069" stroke-width="3"/>'],
        ['triangle', '三角形', '<polygon points="50,4 97,96 3,96" fill="#d66e57" stroke="#79382d" stroke-width="3" stroke-linejoin="round"/>'],
        ['star', '星形', '<polygon points="50,3 61,36 96,36 68,57 79,92 50,71 21,92 32,57 4,36 39,36" fill="#e0b63f" stroke="#806417" stroke-width="3" stroke-linejoin="round"/>'],
        ['arrow', '箭头', '<polygon points="3,38 62,38 62,17 97,50 62,83 62,62 3,62" fill="#4b82bd" stroke="#285178" stroke-width="3" stroke-linejoin="round"/>'],
        ['line', '直线', '<line x1="5" y1="50" x2="95" y2="50" stroke="#315e55" stroke-width="6" stroke-linecap="round"/>'],
    ].map(([key, name, geometry]) => ({
        id: `vcp.scriptorium.shape.${key}`,
        version: 1,
        name,
        description: `${name}基础图形`,
        category: '基础形状',
        tags: ['内置', '基础', name],
        kind: 'static',
        source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${geometry}</svg>`,
        defaultSize: {
            width: key === 'line' ? 300 : 260,
            height: key === 'line' ? 80 : 180,
        },
    }));

    const BUILTIN_PACK = {
        format: PACK_FORMAT,
        version: PACK_VERSION,
        manifest: {
            id: BUILTIN_PACK_ID,
            name: 'Scriptorium 基础图形',
            description: 'Scriptorium 内置只读 SVG 基础图形。',
            author: 'VCP Scriptorium',
            createdAt: '2026-08-13T00:00:00.000Z',
        },
        assets: BUILTIN_ASSETS,
    };

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function sourceBytes(source) {
        return new TextEncoder().encode(String(source || '')).length;
    }

    function inspectSvg(source) {
        const text = String(source || '').trim();
        if (!text) throw new Error('SVG 源码不能为空。');
        if (sourceBytes(text) > MAX_SOURCE_BYTES) {
            throw new Error('SVG 源码超过 512 KB 安全上限。');
        }
        const sanitizer = window.ScriptoriumObjects?.sanitizeSvgSource;
        if (typeof sanitizer !== 'function') {
            throw new Error('SVG 安全清洗器尚未加载。');
        }
        const sanitized = sanitizer(text);
        if (!sanitized.valid) throw new Error(sanitized.message);
        const parsed = new DOMParser().parseFromString(
            sanitized.source,
            'image/svg+xml'
        );
        if (parsed.querySelector('parsererror')) {
            throw new Error('清洗后的 SVG 无法解析。');
        }
        const svg = parsed.documentElement;
        const nodes = svg.querySelectorAll('*').length + 1;
        const animationElements = svg.querySelectorAll(
            'animate,animateMotion,animateTransform,set'
        ).length;
        const cssAnimation = /(?:animation|@keyframes)\s*[:{]/i.test(
            sanitized.source
        );
        if (nodes > MAX_NODES) {
            throw new Error(`SVG 节点数 ${nodes} 超过 ${MAX_NODES} 安全上限。`);
        }
        if (animationElements > MAX_ANIMATIONS) {
            throw new Error(
                `SVG 动画节点数 ${animationElements} 超过 ${MAX_ANIMATIONS} 安全上限。`
            );
        }
        return {
            source: sanitized.source,
            animated: animationElements > 0 || cssAnimation,
            diagnostics: {
                sourceBytes: sourceBytes(sanitized.source),
                nodes,
                animationElements,
                cssAnimation,
                scriptsRemoved: /<script\b/i.test(text)
                    && !/<script\b/i.test(sanitized.source),
            },
        };
    }

    function normalizeAsset(input, packId = 'local') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error('SVG 资产必须是对象。');
        }
        const id = String(input.id || '').trim();
        if (!ID_PATTERN.test(id)) {
            throw new Error(`无效的 SVG 资产 ID：${id || '（空）'}`);
        }
        const inspected = inspectSvg(input.source || input.svg);
        const requestedKind = String(input.kind || '').toLowerCase();
        const kind = inspected.animated || requestedKind === 'animated'
            ? 'animated'
            : 'static';
        const width = Math.max(
            24,
            Math.min(4096, Number(input.defaultSize?.width) || 260)
        );
        const height = Math.max(
            24,
            Math.min(4096, Number(input.defaultSize?.height) || 180)
        );
        return Object.freeze({
            id,
            version: Math.max(1, Number(input.version) || 1),
            name: String(input.name || id).slice(0, 120),
            description: String(input.description || '').slice(0, 1200),
            category: String(input.category || '其他').slice(0, 80),
            tags: [...new Set(
                (Array.isArray(input.tags) ? input.tags : [])
                    .map(String)
                    .map((tag) => tag.trim())
                    .filter(Boolean)
                    .slice(0, 40)
            )],
            kind,
            source: inspected.source,
            defaultSize: Object.freeze({ width, height }),
            diagnostics: Object.freeze(inspected.diagnostics),
            packId: String(packId || 'local'),
            author: String(input.author || ''),
            createdBy: input.createdBy === 'ai'
                ? 'ai'
                : input.createdBy === 'human'
                    ? 'human'
                    : 'unknown',
        });
    }

    function validatePack(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error('SVG 资产包内容无效。');
        }
        if (input.format !== PACK_FORMAT) {
            throw new Error('这不是 VCP SVG 资产包。');
        }
        if (Number(input.version) !== PACK_VERSION) {
            throw new Error(`不支持的 SVG 资产包版本：${input.version}`);
        }
        const manifest = input.manifest && typeof input.manifest === 'object'
            ? input.manifest
            : {};
        const packId = String(manifest.id || '').trim();
        if (!ID_PATTERN.test(packId)) {
            throw new Error('SVG 资产包缺少有效的 manifest.id。');
        }
        if (!Array.isArray(input.assets) || !input.assets.length) {
            throw new Error('SVG 资产包中没有资产。');
        }
        const assets = input.assets.map((asset) =>
            normalizeAsset(asset, packId)
        );
        const ids = assets.map((asset) => asset.id);
        const duplicates = ids.filter((id, index) =>
            ids.indexOf(id) !== index
        );
        if (duplicates.length) {
            throw new Error(`SVG 资产包中存在重复 ID：${duplicates.join('、')}`);
        }
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
            assets,
        };
    }

    function emit(type, detail) {
        const event = Object.freeze({ type, detail, assets: list() });
        listeners.forEach((listener) => {
            try {
                listener(event);
            } catch (error) {
                console.error('[VDocSvgAssetLibrary] Listener failed:', error);
            }
        });
    }

    function assertMutable(packId, options = {}) {
        if (packId === BUILTIN_PACK_ID && options.internal !== true) {
            throw new Error('Scriptorium 内置 SVG 资产包是只读的。');
        }
    }

    function get(assetId) {
        const asset = registry.get(String(assetId));
        return asset ? clone(asset) : null;
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
            assets: record.assetIds.map((assetId) => registry.get(assetId))
                .filter(Boolean)
                .map((asset) => {
                    const output = { ...asset };
                    delete output.packId;
                    return output;
                }),
        });
    }

    function registerPack(packInput, options = {}) {
        const pack = validatePack(packInput);
        const packId = pack.manifest.id;
        assertMutable(packId, options);
        const previous = packRegistry.get(packId);
        if (previous && options.conflict !== 'replace') {
            if (options.conflict === 'keep') return getPack(packId);
            throw new Error(`SVG 资产包 ${packId} 已存在。`);
        }
        pack.assets.forEach((asset) => {
            const existing = registry.get(asset.id);
            if (existing?.packId === BUILTIN_PACK_ID
                && options.internal !== true) {
                throw new Error(`内置 SVG 资产 ${asset.id} 是只读的。`);
            }
            if (existing && existing.packId !== packId) {
                throw new Error(
                    `SVG 资产 ${asset.id} 已属于资产包 ${existing.packId}。`
                );
            }
        });
        const nextIds = new Set(pack.assets.map((asset) => asset.id));
        (previous?.assetIds || []).forEach((assetId) => {
            if (!nextIds.has(assetId)) registry.delete(assetId);
        });
        pack.assets.forEach((asset) => registry.set(asset.id, asset));
        packRegistry.set(packId, Object.freeze({
            manifest: Object.freeze({ ...pack.manifest }),
            assetIds: Object.freeze(pack.assets.map((asset) => asset.id)),
            builtin: packId === BUILTIN_PACK_ID,
        }));
        const result = getPack(packId);
        emit(previous ? 'pack-replace' : 'pack-register', result);
        return result;
    }

    function unregisterPack(packId, options = {}) {
        const id = String(packId || '');
        const record = packRegistry.get(id);
        if (!record) return false;
        assertMutable(id, options);
        record.assetIds.forEach((assetId) => registry.delete(assetId));
        packRegistry.delete(id);
        emit('pack-unregister', { packId: id });
        return true;
    }

    function list(filter = {}) {
        const query = String(filter.query || '').trim().toLowerCase();
        return [...registry.values()]
            .filter((asset) =>
                !filter.packId || asset.packId === filter.packId
            )
            .filter((asset) =>
                !filter.category || asset.category === filter.category
            )
            .filter((asset) => !filter.kind || asset.kind === filter.kind)
            .filter((asset) => !query || [
                asset.id,
                asset.name,
                asset.description,
                asset.category,
                ...asset.tags,
            ].some((value) =>
                String(value || '').toLowerCase().includes(query)
            ))
            .sort((left, right) =>
                left.category.localeCompare(right.category, 'zh-CN')
                || left.name.localeCompare(right.name, 'zh-CN')
            )
            .map(clone);
    }

    function listPacks() {
        return [...packRegistry.keys()].map((packId) => {
            const pack = getPack(packId);
            return {
                manifest: pack.manifest,
                builtin: pack.builtin,
                editable: pack.editable,
                assetCount: pack.assets.length,
                animatedCount: pack.assets.filter(
                    (asset) => asset.kind === 'animated'
                ).length,
                assets: pack.assets.map((asset) => ({
                    id: asset.id,
                    version: asset.version,
                    name: asset.name,
                    description: asset.description,
                    category: asset.category,
                    tags: asset.tags,
                    kind: asset.kind,
                    defaultSize: asset.defaultSize,
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

    function categories() {
        return [...new Set(
            [...registry.values()].map((asset) => asset.category)
        )].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    }

    function parsePack(text) {
        return validatePack(JSON.parse(String(text || '')));
    }

    function serializePack(packId) {
        const pack = getPack(packId);
        if (!pack) throw new Error(`未找到 SVG 资产包：${packId}`);
        return JSON.stringify({
            format: pack.format,
            version: pack.version,
            manifest: pack.manifest,
            assets: pack.assets,
        }, null, 2);
    }

    function rewriteInstanceIds(source, prefix) {
        const parsed = new DOMParser().parseFromString(
            String(source || ''),
            'image/svg+xml'
        );
        if (parsed.querySelector('parsererror')) {
            throw new Error('SVG 实例源码无法解析。');
        }
        const svg = parsed.documentElement;
        const mapping = new Map();
        svg.querySelectorAll('[id]').forEach((node) => {
            const original = node.getAttribute('id');
            const replacement = `${prefix}-${original.replace(
                /[^a-zA-Z0-9_-]/g,
                '-'
            )}`;
            mapping.set(original, replacement);
            node.setAttribute('id', replacement);
        });
        [svg, ...svg.querySelectorAll('*')].forEach((node) => {
            [...node.attributes].forEach((attribute) => {
                let value = attribute.value;
                mapping.forEach((replacement, original) => {
                    value = value
                        .replaceAll(`url(#${original})`, `url(#${replacement})`)
                        .replace(
                            new RegExp(`^#${original.replace(
                                /[.*+?^${}()|[\]\\]/g,
                                '\\$&'
                            )}$`),
                            `#${replacement}`
                        );
                });
                if (value !== attribute.value) {
                    node.setAttribute(attribute.name, value);
                }
            });
        });
        return new XMLSerializer().serializeToString(svg);
    }

    function instantiate(assetId, options = {}) {
        const asset = registry.get(String(assetId));
        if (!asset) throw new Error(`未找到 SVG 资产：${assetId}`);
        const prefix = `vsvg-${
            globalThis.crypto?.randomUUID?.()
            || `${Date.now().toString(36)}-${Math.random()
                .toString(36).slice(2, 9)}`
        }`;
        return {
            asset: clone(asset),
            source: rewriteInstanceIds(asset.source, prefix),
            width: Number(options.width) || asset.defaultSize.width,
            height: Number(options.height) || asset.defaultSize.height,
        };
    }

    function exportUserPacks() {
        return listPacks()
            .filter((pack) => pack.editable)
            .map((pack) => {
                const full = getPack(pack.manifest.id);
                return {
                    format: full.format,
                    version: full.version,
                    manifest: full.manifest,
                    assets: full.assets,
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

    function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    registerPack(BUILTIN_PACK, {
        conflict: 'replace',
        internal: true,
    });

    window.VDocSvgAssetLibrary = Object.freeze({
        PACK_FORMAT,
        PACK_VERSION,
        BUILTIN_PACK_ID,
        MAX_SOURCE_BYTES,
        MAX_NODES,
        MAX_ANIMATIONS,
        inspectSvg,
        normalizeAsset,
        validatePack,
        registerPack,
        unregisterPack,
        get,
        getPack,
        list,
        listPacks,
        categories,
        parsePack,
        serializePack,
        instantiate,
        exportUserPacks,
        replaceUserPacks,
        subscribe,
    });
})();