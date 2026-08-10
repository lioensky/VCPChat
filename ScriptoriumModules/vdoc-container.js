'use strict';

(() => {
    const CONTAINER_FORMAT = 'vcp-vdoc-container';
    const CONTAINER_VERSION = 2;
    const DOCUMENT_ENTRY = 'document.json';
    const RESOURCE_SCHEME = 'vdoc-resource://';
    const RESOURCE_PATTERN = /vdoc-resource:\/\/(media|fonts)\/([a-f0-9]{64})/gi;

    function extensionFromName(name, mime = '') {
        const supplied = String(name || '').match(/\.([a-z0-9]{1,12})$/i)?.[1];
        if (supplied) return supplied.toLowerCase();
        const subtype = String(mime || '').split('/')[1]?.split(/[;+]/)[0]
            ?.replace(/^svg\+xml$/, 'svg')
            ?.replace(/^jpeg$/, 'jpg');
        return subtype && /^[a-z0-9]{1,12}$/i.test(subtype) ? subtype.toLowerCase() : 'bin';
    }

    async function sha256(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return [...new Uint8Array(digest)]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('');
    }

    function normalizeResource(resource = {}) {
        const kind = resource.kind === 'font' || resource.category === 'fonts'
            ? 'font'
            : 'media';
        const category = kind === 'font' ? 'fonts' : 'media';
        const id = String(resource.id || resource.sha256 || '').toLowerCase();
        const extension = extensionFromName(resource.name, resource.mime);
        return {
            id,
            kind,
            category,
            path: String(resource.path || `resources/${category}/${id}.${extension}`),
            name: String(resource.name || `${id}.${extension}`),
            mime: String(resource.mime || 'application/octet-stream'),
            size: Math.max(0, Number(resource.size) || 0),
            sha256: String(resource.sha256 || id).toLowerCase(),
            description: String(resource.description || ''),
            nativeWidth: Number(resource.nativeWidth) || null,
            nativeHeight: Number(resource.nativeHeight) || null,
            duration: Number.isFinite(Number(resource.duration))
                ? Number(resource.duration)
                : null,
            durationText: String(resource.durationText || ''),
            createdAt: resource.createdAt || new Date().toISOString(),
        };
    }

    async function registerResource(documentModel, resourceData, input = {}) {
        const bytes = input.bytes instanceof Uint8Array
            ? input.bytes
            : new Uint8Array(input.bytes || []);
        if (!bytes.length) throw new Error('不能注册空资源。');
        const id = await sha256(bytes);
        const kind = input.kind === 'font' ? 'font' : 'media';
        const category = kind === 'font' ? 'fonts' : 'media';
        const metadata = normalizeResource({
            ...input,
            id,
            sha256: id,
            kind,
            category,
            size: bytes.byteLength,
        });
        documentModel.manifest.resources = Array.isArray(documentModel.manifest.resources)
            ? documentModel.manifest.resources
            : [];
        const existing = documentModel.manifest.resources.find((item) => item.id === id);
        if (existing) Object.assign(existing, metadata);
        else documentModel.manifest.resources.push(metadata);
        resourceData.set(id, bytes);
        return existing || metadata;
    }

    async function pack(documentModel, resourceData = new Map()) {
        if (!globalThis.JSZip) throw new Error('JSZip 尚未载入。');
        const zip = new globalThis.JSZip();
        const model = JSON.parse(JSON.stringify(documentModel));
        model.format = model.format || 'vcp-vdocx';
        model.version = CONTAINER_VERSION;
        model.container = {
            format: CONTAINER_FORMAT,
            version: CONTAINER_VERSION,
            documentEntry: DOCUMENT_ENTRY,
        };
        model.manifest.resources = (model.manifest.resources || []).map(normalizeResource);
        for (const resource of model.manifest.resources) {
            const bytes = resourceData.get(resource.id);
            if (!bytes?.length) {
                throw new Error(`工程资源缺失：${resource.name || resource.id}`);
            }
            zip.file(resource.path, bytes, {
                binary: true,
                compression: 'DEFLATE',
                compressionOptions: { level: 6 },
            });
        }
        zip.file(DOCUMENT_ENTRY, JSON.stringify(model, null, 2), {
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });
        zip.file('mimetype', CONTAINER_FORMAT, { compression: 'STORE' });
        return zip.generateAsync({
            type: 'uint8array',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
            mimeType: 'application/vnd.vcp.vdoc+zip',
        });
    }

    async function unpack(bytes, core) {
        if (!globalThis.JSZip) throw new Error('JSZip 尚未载入。');
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        if (data[0] !== 0x50 || data[1] !== 0x4b) {
            throw new Error('这不是有效的 VDOCX / VPPTX ZIP 工程。');
        }
        const zip = await globalThis.JSZip.loadAsync(data);
        const documentFile = zip.file(DOCUMENT_ENTRY);
        if (!documentFile) throw new Error('工程缺少 document.json。');
        const stored = JSON.parse(await documentFile.async('string'));
        if (stored.container?.format !== CONTAINER_FORMAT
            || Number(stored.container?.version) !== CONTAINER_VERSION) {
            throw new Error('不支持的 VDOCX / VPPTX 容器版本。');
        }
        const documentModel = core.normalizeDocument(stored);
        const resourceData = new Map();
        for (const rawResource of documentModel.manifest.resources || []) {
            const resource = normalizeResource(rawResource);
            const file = zip.file(resource.path);
            if (!file) throw new Error(`工程资源文件缺失：${resource.path}`);
            const resourceBytes = await file.async('uint8array');
            const digest = await sha256(resourceBytes);
            if (digest !== resource.sha256 || digest !== resource.id) {
                throw new Error(`工程资源校验失败：${resource.name}`);
            }
            resourceData.set(resource.id, resourceBytes);
            Object.assign(rawResource, resource);
        }
        return { document: documentModel, resourceData };
    }

    function bytesToBase64(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const chunkSize = 0x8000;
        let binary = '';
        for (let offset = 0; offset < data.length; offset += chunkSize) {
            binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
    }

    function createRuntimeResolver(documentModel, resourceData, objectUrls = new Map()) {
        const urlFor = (category, id) => {
            // 清单会在编辑期间动态增加资源，因此不能在创建解析器时复制成静态 Map。
            const resource = resourceMetadata(documentModel, id);
            const bytes = resourceData.get(id);
            if (!resource || !bytes || resource.category !== category) return '';
            if (objectUrls.has(id)) return objectUrls.get(id);
            const url = URL.createObjectURL(new Blob([bytes], { type: resource.mime }));
            objectUrls.set(id, url);
            return url;
        };
        const resolveHtml = (html) => String(html || '').replace(
            RESOURCE_PATTERN,
            (_match, category, id) => urlFor(category.toLowerCase(), id.toLowerCase())
                || _match
        );
        const dataUrlFor = (category, id) => {
            const resource = resourceMetadata(documentModel, id);
            const bytes = resourceData.get(id);
            if (!resource || !bytes || resource.category !== category) return '';
            return `data:${resource.mime || 'application/octet-stream'};base64,${
                bytesToBase64(bytes)
            }`;
        };
        const resolveExportHtml = (html) => {
            let output = String(html || '').replace(
                RESOURCE_PATTERN,
                (_match, category, id) =>
                    dataUrlFor(category.toLowerCase(), id.toLowerCase()) || _match
            );
            objectUrls.forEach((objectUrl, id) => {
                const resource = resourceMetadata(documentModel, id);
                const dataUrl = resource
                    ? dataUrlFor(resource.category, id)
                    : '';
                if (dataUrl) output = output.split(objectUrl).join(dataUrl);
            });
            return output;
        };
        const revoke = () => {
            objectUrls.forEach((url) => URL.revokeObjectURL(url));
            objectUrls.clear();
        };
        return { resolveHtml, resolveExportHtml, revoke, objectUrls };
    }

    function resourceReference(resource) {
        const category = resource.kind === 'font' || resource.category === 'fonts'
            ? 'fonts'
            : 'media';
        return `${RESOURCE_SCHEME}${category}/${resource.id}`;
    }

    function resourceMetadata(documentModel, id) {
        return (documentModel?.manifest?.resources || [])
            .find((resource) => resource.id === id) || null;
    }

    window.VDocContainer = Object.freeze({
        CONTAINER_FORMAT,
        CONTAINER_VERSION,
        DOCUMENT_ENTRY,
        RESOURCE_SCHEME,
        RESOURCE_PATTERN,
        bytesToBase64,
        createRuntimeResolver,
        extensionFromName,
        normalizeResource,
        pack,
        registerResource,
        resourceMetadata,
        resourceReference,
        sha256,
        unpack,
    });
})();