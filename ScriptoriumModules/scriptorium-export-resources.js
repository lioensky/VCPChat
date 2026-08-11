'use strict';

(() => {
    const DEFAULT_MAX_ITEM_BYTES = 40 * 1024 * 1024;
    const DEFAULT_MAX_TOTAL_BYTES = 60 * 1024 * 1024;
    const PORTABLE_PROTOCOLS = new Set(['file:', 'http:']);

    function candidateProtocol(value) {
        try {
            return new URL(String(value || '').trim()).protocol.toLowerCase();
        } catch {
            return '';
        }
    }

    function isPortableExportCandidate(value) {
        return PORTABLE_PROTOCOLS.has(candidateProtocol(value));
    }

    function splitSrcset(value) {
        return String(value || '').split(',').map((entry) => {
            const trimmed = entry.trim();
            const separator = trimmed.search(/\s/);
            return separator < 0
                ? { url: trimmed, descriptor: '' }
                : {
                    url: trimmed.slice(0, separator),
                    descriptor: trimmed.slice(separator).trim(),
                };
        });
    }

    function joinSrcset(entries) {
        return entries.map((entry) =>
            `${entry.url}${entry.descriptor ? ` ${entry.descriptor}` : ''}`
        ).join(', ');
    }

    function collectAttributeReference(references, node, attribute, expectedKind) {
        const url = node.getAttribute(attribute) || '';
        if (!isPortableExportCandidate(url)) return;
        references.push({
            url,
            expectedKind,
            apply(dataUrl) {
                node.setAttribute(attribute, dataUrl);
            },
        });
    }

    function collectSrcsetReferences(references, node, expectedKind) {
        const entries = splitSrcset(node.getAttribute('srcset'));
        entries.forEach((entry, index) => {
            if (!isPortableExportCandidate(entry.url)) return;
            references.push({
                url: entry.url,
                expectedKind,
                apply(dataUrl) {
                    entries[index].url = dataUrl;
                    node.setAttribute('srcset', joinSrcset(entries));
                },
            });
        });
    }

    function collectExportReferences(documentNode) {
        const references = [];
        documentNode.querySelectorAll('img[src]').forEach((node) =>
            collectAttributeReference(references, node, 'src', 'image')
        );
        documentNode.querySelectorAll('img[srcset]').forEach((node) =>
            collectSrcsetReferences(references, node, 'image')
        );
        documentNode.querySelectorAll('picture source[src]').forEach((node) =>
            collectAttributeReference(references, node, 'src', 'image')
        );
        documentNode.querySelectorAll('picture source[srcset]').forEach((node) =>
            collectSrcsetReferences(references, node, 'image')
        );
        documentNode.querySelectorAll('video[poster]').forEach((node) =>
            collectAttributeReference(references, node, 'poster', 'image')
        );
        documentNode.querySelectorAll('audio[src]').forEach((node) =>
            collectAttributeReference(references, node, 'src', 'audio')
        );
        documentNode.querySelectorAll('audio source[src]').forEach((node) =>
            collectAttributeReference(references, node, 'src', 'audio')
        );
        documentNode.querySelectorAll('svg image').forEach((node) => {
            if (node.hasAttribute('href')) {
                collectAttributeReference(references, node, 'href', 'image');
            }
            if (node.hasAttribute('xlink:href')) {
                collectAttributeReference(references, node, 'xlink:href', 'image');
            }
        });
        return references;
    }

    function mediaKindFromMime(mime) {
        return String(mime || '').trim().toLowerCase().match(/^(image|audio)\//)?.[1] || '';
    }

    function serializeDocument(documentNode, originalHtml) {
        const doctype = String(originalHtml || '').match(/^\s*(<!doctype[^>]*>)/i)?.[1]
            || '<!doctype html>';
        return `${doctype}\n${documentNode.documentElement.outerHTML}`;
    }

    async function localizeHtmlMedia(html, options = {}) {
        if (typeof options.readExternalResource !== 'function') {
            throw new TypeError('导出资源适配器缺少 readExternalResource。');
        }
        if (typeof options.bytesToBase64 !== 'function') {
            throw new TypeError('导出资源适配器缺少 bytesToBase64。');
        }

        const parser = options.domParser || new DOMParser();
        const documentNode = parser.parseFromString(String(html || ''), 'text/html');
        const references = collectExportReferences(documentNode);
        const referencesByUrl = new Map();
        references.forEach((reference) => {
            const grouped = referencesByUrl.get(reference.url) || [];
            grouped.push(reference);
            referencesByUrl.set(reference.url, grouped);
        });

        const maxItemBytes = Number.isFinite(options.maxItemBytes)
            ? Math.max(0, options.maxItemBytes)
            : DEFAULT_MAX_ITEM_BYTES;
        const maxTotalBytes = Number.isFinite(options.maxTotalBytes)
            ? Math.max(0, options.maxTotalBytes)
            : DEFAULT_MAX_TOTAL_BYTES;
        const failures = [];
        let localized = 0;
        let localizedReferences = 0;
        let originalBytes = 0;

        for (const [url, groupedReferences] of referencesByUrl) {
            try {
                const result = await options.readExternalResource({ url });
                if (!result?.success || !result.collectable || !result.bytes) {
                    failures.push({
                        url,
                        protocol: candidateProtocol(url),
                        reason: result?.reason || '资源不可内联',
                    });
                    continue;
                }

                const kind = mediaKindFromMime(result.mime);
                const expectedKinds = new Set(
                    groupedReferences.map((reference) => reference.expectedKind)
                );
                if (!kind || !expectedKinds.has(kind)) {
                    failures.push({
                        url,
                        protocol: candidateProtocol(url),
                        reason: `资源类型不匹配：${result.mime || '未知 MIME'}`,
                    });
                    continue;
                }

                const bytes = result.bytes instanceof Uint8Array
                    ? result.bytes
                    : Uint8Array.from(result.bytes || []);
                const size = Number(result.size) || bytes.byteLength;
                if (size > maxItemBytes) {
                    failures.push({
                        url,
                        protocol: candidateProtocol(url),
                        reason: `单项资源超过 ${maxItemBytes} 字节内联上限`,
                    });
                    continue;
                }
                if (originalBytes + size > maxTotalBytes) {
                    failures.push({
                        url,
                        protocol: candidateProtocol(url),
                        reason: `资源累计超过 ${maxTotalBytes} 字节内联上限`,
                    });
                    continue;
                }

                const dataUrl = `data:${result.mime};base64,${
                    options.bytesToBase64(bytes)
                }`;
                groupedReferences
                    .filter((reference) => reference.expectedKind === kind)
                    .forEach((reference) => {
                        reference.apply(dataUrl);
                        localizedReferences += 1;
                    });
                originalBytes += size;
                localized += 1;
            } catch (error) {
                failures.push({
                    url,
                    protocol: candidateProtocol(url),
                    reason: error?.message || String(error),
                });
            }
        }

        return {
            html: serializeDocument(documentNode, html),
            localized,
            localizedReferences,
            retained: failures.length,
            failures,
            originalBytes,
            estimatedBase64Bytes: Math.ceil(originalBytes / 3) * 4,
        };
    }

    window.ScriptoriumExportResources = Object.freeze({
        DEFAULT_MAX_ITEM_BYTES,
        DEFAULT_MAX_TOTAL_BYTES,
        isPortableExportCandidate,
        localizeHtmlMedia,
    });
})();