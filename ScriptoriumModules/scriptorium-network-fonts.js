'use strict';

(() => {
    const IMPORT_PATTERN =
        /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^'")\s;]+))\s*\)?[^;]*;?/gi;
    const FONT_FACE_PATTERN = /@font-face\s*\{[\s\S]*?\}/gi;
    const URL_PATTERN =
        /url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s]+))\s*\)/gi;

    function importUrls(css) {
        const urls = [];
        let match;
        while ((match = IMPORT_PATTERN.exec(String(css || '')))) {
            const url = match[1] || match[2] || match[3] || '';
            if (/^https:\/\//i.test(url)) urls.push(url);
        }
        return [...new Set(urls)];
    }

    function remoteFontFaceUrls(css) {
        const urls = [];
        String(css || '').match(FONT_FACE_PATTERN)?.forEach((face) => {
            let match;
            while ((match = URL_PATTERN.exec(face))) {
                const url = match[1] || match[2] || match[3] || '';
                if (/^https:\/\//i.test(url)) urls.push(url);
            }
        });
        return [...new Set(urls)];
    }

    function removeRemoteImports(css) {
        return String(css || '').replace(IMPORT_PATTERN, (source, ...groups) => {
            const url = groups[0] || groups[1] || groups[2] || '';
            return /^https:\/\//i.test(url) ? '' : source;
        });
    }

    async function localizeStyleElements(source, localize) {
        const input = String(source || '');
        const pattern = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
        let output = '';
        let cursor = 0;
        let changed = false;
        const resources = [];
        const failures = [];
        let match;

        while ((match = pattern.exec(input))) {
            output += input.slice(cursor, match.index);
            const css = match[2];
            const hasRemoteFonts = /https:\/\//i.test(css)
                && /@import|@font-face/i.test(css);
            if (!hasRemoteFonts) {
                output += match[0];
            } else {
                const result = await localize(css);
                if (!result) return null;
                output += `<style${match[1]}>${result.css}</style>`;
                changed ||= result.changed === true;
                resources.push(...(result.resources || []));
                failures.push(...(result.failures || []));
            }
            cursor = pattern.lastIndex;
        }

        return {
            source: output + input.slice(cursor),
            changed,
            resources,
            failures,
        };
    }

    function familyNames(css) {
        const names = [];
        const pattern =
            /font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;}]+))/gi;
        let match;
        while ((match = pattern.exec(String(css || '')))) {
            const family = String(
                match[1] || match[2] || match[3] || ''
            ).trim();
            if (family) names.push(family);
        }
        return [...new Set(names)];
    }

    function createNetworkFontController(context = {}) {
        const documentPort = context.documentPort;
        const containerModule = context.containerModule;
        const persistencePort = context.persistencePort;
        const notificationPort = context.notificationPort || {};
        const settingsPort = context.settingsPort || {};
        if (!documentPort || !containerModule || !persistencePort) {
            throw new TypeError(
                'Network font controller requires document, container and persistence ports.'
            );
        }

        let sequence = 0;
        let disposed = false;
        const settingsDisposer = settingsPort.subscribe?.(
            'trustNetworkFonts',
            () => cancel()
        ) || null;

        function trustsNetworkFonts() {
            return settingsPort.get?.('trustNetworkFonts') === true;
        }

        async function registerFont(resource) {
            const bytes = resource?.bytes instanceof Uint8Array
                ? resource.bytes
                : Uint8Array.from(resource?.bytes || []);
            if (!bytes.length || !/^[a-f0-9]{64}$/i.test(resource?.hash || '')) {
                throw new Error('字体缓存没有返回有效的字体数据。');
            }
            const metadata = await containerModule.registerResource(
                documentPort.document(),
                documentPort.resourceData(),
                {
                    bytes,
                    kind: 'font',
                    category: 'fonts',
                    name: `${resource.hash}.${resource.extension || 'bin'}`,
                    mime: resource.mime,
                    sourceUrl: resource.url || resource.sourceUrl || '',
                    description: '受控网络字体缓存',
                }
            );
            return metadata;
        }

        async function processCss(css, options = {}) {
            if (disposed) return null;
            const source = String(css || '');
            const operation = ++sequence;
            if (trustsNetworkFonts()) {
                return {
                    css: source,
                    resources: [],
                    failures: [],
                    changed: false,
                    trusted: true,
                };
            }
            const imports = importUrls(source);
            const directUrls = remoteFontFaceUrls(source);
            let localizedCss = removeRemoteImports(source);
            const resources = [];
            const failures = [];

            for (const url of imports) {
                try {
                    const result =
                        await persistencePort.resolveFontStylesheet({ url });
                    if (disposed || operation !== sequence) return null;
                    for (const resource of result?.resources || []) {
                        await registerFont(resource);
                        resources.push(resource);
                    }
                    if (result?.css) {
                        localizedCss += `\n\n/* Localized network font */\n${
                            result.css
                        }`;
                    }
                } catch (error) {
                    failures.push({ url, reason: error.message });
                }
            }

            for (const url of directUrls) {
                try {
                    const resource = await persistencePort.resolveFontUrl({
                        url,
                    });
                    if (disposed || operation !== sequence) return null;
                    await registerFont({ ...resource, url });
                    resources.push({ ...resource, url });
                    localizedCss = localizedCss
                        .split(url)
                        .join(`vdoc-resource://fonts/${resource.hash}`);
                } catch (error) {
                    failures.push({ url, reason: error.message });
                    localizedCss = localizedCss.split(url).join('');
                }
            }

            if (disposed || operation !== sequence) return null;
            const model = documentPort.document();
            if (model) {
                const existing = Array.isArray(model.manifest.fonts)
                    ? model.manifest.fonts
                    : [];
                const byHash = new Map(
                    existing
                        .filter((font) => font?.hash)
                        .map((font) => [font.hash, font])
                );
                resources.forEach((resource) => {
                    byHash.set(resource.hash, {
                        hash: resource.hash,
                        family: familyNames(localizedCss),
                        mime: resource.mime,
                        size: resource.size,
                        sourceUrl:
                            resource.url || resource.sourceUrl || '',
                        reference:
                            `vdoc-resource://fonts/${resource.hash}`,
                    });
                });
                model.manifest.fonts = [...byHash.values()];
            }

            if (failures.length && options.notify !== false) {
                notificationPort.show?.(
                    `${failures.length} 项网络字体未能本地化`,
                    'info',
                    5000
                );
                console.warn(
                    '[ScriptoriumNetworkFonts] Font localization failures:',
                    failures
                );
            }
            return {
                css: localizedCss,
                resources,
                failures,
                changed: imports.length > 0 || directUrls.length > 0,
            };
        }

        async function processDocument(adapter, options = {}) {
            if (disposed || !adapter) return null;
            const resources = [];
            const failures = [];
            let changed = false;

            const documentCss = String(adapter.currentCss?.() || '');
            if (/@import|@font-face/i.test(documentCss)
                && /https:\/\//i.test(documentCss)) {
                const cssResult = await processCss(documentCss, options);
                if (!cssResult) return null;
                resources.push(...cssResult.resources);
                failures.push(...cssResult.failures);
                if (cssResult.changed) {
                    adapter.replaceCurrentCss(cssResult.css, {
                        reason: 'network-fonts-document-css',
                        dirty: options.dirty !== false,
                    });
                    changed = true;
                }
            }

            const currentSource = String(adapter.currentSource?.() || '');
            const sourceResult = await localizeStyleElements(
                currentSource,
                (css) => processCss(css, options)
            );
            if (!sourceResult) return null;
            resources.push(...sourceResult.resources);
            failures.push(...sourceResult.failures);
            if (sourceResult.changed && sourceResult.source !== currentSource) {
                adapter.replaceCurrentSource(sourceResult.source, {
                    reason: 'network-fonts-embedded-css',
                    dirty: options.dirty !== false,
                });
                changed = true;
            }

            return {
                changed,
                resources,
                failures,
            };
        }

        function cancel() {
            sequence += 1;
        }

        function dispose() {
            cancel();
            settingsDisposer?.();
            disposed = true;
        }

        return Object.freeze({
            processCss,
            processDocument,
            cancel,
            dispose,
        });
    }

    window.ScriptoriumNetworkFonts = Object.freeze({
        createNetworkFontController,
        importUrls,
        remoteFontFaceUrls,
        removeRemoteImports,
        localizeStyleElements,
    });
})();