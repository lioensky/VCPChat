'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
    classifyFont,
    isPrivateAddress,
    normalizeUrl,
    stylesheetFontUrls,
} = require('../modules/services/scriptoriumFontCacheService');

test('font cache validates supported binary signatures', () => {
    assert.deepEqual(
        classifyFont(Buffer.from('wOF2font-data')),
        { mime: 'font/woff2', extension: 'woff2' }
    );
    assert.deepEqual(
        classifyFont(Buffer.from('wOFFfont-data')),
        { mime: 'font/woff', extension: 'woff' }
    );
    assert.deepEqual(
        classifyFont(Buffer.from('OTTOfont-data')),
        { mime: 'font/otf', extension: 'otf' }
    );
    assert.deepEqual(
        classifyFont(Buffer.from([0x00, 0x01, 0x00, 0x00, 1, 2, 3])),
        { mime: 'font/ttf', extension: 'ttf' }
    );
    assert.throws(
        () => classifyFont(Buffer.from('<html>not a font</html>')),
        /不是受支持/
    );
});

test('font cache rejects private and loopback network addresses', () => {
    [
        '127.0.0.1',
        '10.0.0.8',
        '172.16.0.1',
        '172.31.255.254',
        '192.168.1.2',
        '169.254.1.1',
        '::1',
        'fc00::1',
        'fd00::1',
        'fe80::1',
    ].forEach((address) => assert.equal(isPrivateAddress(address), true));

    [
        '8.8.8.8',
        '1.1.1.1',
        '2606:4700:4700::1111',
    ].forEach((address) => assert.equal(isPrivateAddress(address), false));
});

test('font URL normalization drops fragments and preserves query semantics', () => {
    assert.equal(
        normalizeUrl('https://EXAMPLE.com/font.woff2?v=2#fragment'),
        'https://example.com/font.woff2?v=2'
    );
});

test('font stylesheet resolves relative font URLs', () => {
    const references = stylesheetFontUrls(`
@font-face {
    font-family: "Example";
    src: url("../fonts/example.woff2") format("woff2");
}
`, 'https://cdn.example.com/css/fonts.css');
    assert.deepEqual(references, [{
        supplied: '../fonts/example.woff2',
        absolute: 'https://cdn.example.com/fonts/example.woff2',
    }]);
});

function loadBrowserModule(relativePath, globals = {}) {
    const source = fs.readFileSync(
        path.join(__dirname, '..', relativePath),
        'utf8'
    );
    const context = vm.createContext({
        console,
        Uint8Array,
        URL,
        window: {},
        ...globals,
    });
    vm.runInContext(source, context, { filename: relativePath });
    return context.window;
}

test('network font CSS parser extracts and removes only remote imports', () => {
    const windowObject = loadBrowserModule(
        'ScriptoriumModules/scriptorium-network-fonts.js'
    );
    const module = windowObject.ScriptoriumNetworkFonts;
    const css = `
@import url("https://fonts.googleapis.com/css2?family=Example");
@import url("./local.css");
@font-face {
    font-family: "Direct";
    src: url("https://cdn.example.com/direct.woff2") format("woff2");
}
body { font-family: "Example"; }
`;
    assert.deepEqual(
        [...module.importUrls(css)],
        ['https://fonts.googleapis.com/css2?family=Example']
    );
    assert.deepEqual(
        [...module.remoteFontFaceUrls(css)],
        ['https://cdn.example.com/direct.woff2']
    );
    const cleaned = module.removeRemoteImports(css);
    assert.doesNotMatch(cleaned, /fonts\.googleapis\.com/);
    assert.match(cleaned, /@import url\("\.\/local\.css"\)/);
});

test('imported Markdown localizes fonts inside embedded style elements', async () => {
    const windowObject = loadBrowserModule(
        'ScriptoriumModules/scriptorium-network-fonts.js'
    );
    const module = windowObject.ScriptoriumNetworkFonts;
    const hash = 'b'.repeat(64);
    const model = {
        manifest: {
            fonts: [],
        },
    };
    const resources = new Map();
    const documentPort = {
        document: () => model,
        resourceData: () => resources,
    };
    const source = [
        '<style>',
        '@import url("https://fonts.googleapis.com/css2?family=Example");',
        '.title { font-family: "Example", serif; }',
        '</style>',
        '',
        '# 保持原样的 Markdown 标题',
        '',
        '<style>.local { color: red; }</style>',
    ].join('\n');
    let currentSource = source;
    let currentCss = '';
    const adapter = {
        currentSource: () => currentSource,
        currentCss: () => currentCss,
        replaceCurrentSource(nextSource) {
            currentSource = nextSource;
            return true;
        },
        replaceCurrentCss(nextCss) {
            currentCss = nextCss;
            return true;
        },
    };
    const controller = module.createNetworkFontController({
        documentPort,
        containerModule: {
            async registerResource(_document, resourceData, input) {
                resourceData.set(hash, input.bytes);
                model.manifest.resources = [{
                    id: hash,
                    sha256: hash,
                    kind: 'font',
                    category: 'fonts',
                    mime: input.mime,
                }];
                return model.manifest.resources[0];
            },
        },
        persistencePort: {
            async resolveFontStylesheet({ url }) {
                assert.match(url, /fonts\.googleapis\.com/);
                return {
                    css: [
                        '@font-face {',
                        'font-family: "Example";',
                        `src: url("vdoc-resource://fonts/${hash}") format("woff2");`,
                        '}',
                    ].join('\n'),
                    resources: [{
                        hash,
                        mime: 'font/woff2',
                        extension: 'woff2',
                        size: 4,
                        bytes: [0x77, 0x4f, 0x46, 0x32],
                        url: 'https://fonts.example.com/example.woff2',
                    }],
                };
            },
            async resolveFontUrl() {
                throw new Error('Unexpected direct font request');
            },
        },
    });

    const result = await controller.processDocument(adapter, {
        dirty: false,
        notify: false,
    });

    assert.equal(result.changed, true);
    assert.doesNotMatch(currentSource, /fonts\.googleapis\.com/);
    assert.match(
        currentSource,
        new RegExp(`vdoc-resource://fonts/${hash}`)
    );
    assert.match(currentSource, /# 保持原样的 Markdown 标题/);
    assert.match(currentSource, /<style>\.local \{ color: red; \}<\/style>/);
    assert.equal(resources.has(hash), true);
    assert.equal(model.manifest.fonts[0].hash, hash);
});

test('trusted network fonts bypass localization and preserve CSS URLs', async () => {
    const windowObject = loadBrowserModule(
        'ScriptoriumModules/scriptorium-network-fonts.js'
    );
    const module = windowObject.ScriptoriumNetworkFonts;
    const css = [
        '@import url("https://fonts.example.com/family.css");',
        '@font-face {',
        'font-family: "Direct";',
        'src: url("https://cdn.example.com/direct.woff2");',
        '}',
    ].join('\n');
    let stylesheetRequests = 0;
    let fontRequests = 0;
    let registered = 0;
    const controller = module.createNetworkFontController({
        documentPort: {
            document: () => ({ manifest: {} }),
            resourceData: () => new Map(),
        },
        containerModule: {
            async registerResource() {
                registered += 1;
            },
        },
        persistencePort: {
            async resolveFontStylesheet() {
                stylesheetRequests += 1;
            },
            async resolveFontUrl() {
                fontRequests += 1;
            },
        },
        settingsPort: {
            get: (name) => name === 'trustNetworkFonts',
        },
    });

    const result = await controller.processCss(css);

    assert.equal(result.css, css);
    assert.equal(result.changed, false);
    assert.equal(result.trusted, true);
    assert.equal(stylesheetRequests, 0);
    assert.equal(fontRequests, 0);
    assert.equal(registered, 0);
});

test('document font resources resolve to Blob URLs and export Base64 URLs', () => {
    const created = [];
    const revoked = [];
    class TestBlob {
        constructor(parts, options) {
            this.parts = parts;
            this.type = options.type;
        }
    }
    const windowObject = loadBrowserModule(
        'ScriptoriumModules/vdoc-container.js',
        {
            Blob: TestBlob,
            URL: {
                createObjectURL(blob) {
                    created.push(blob);
                    return 'blob:vdoc-font';
                },
                revokeObjectURL(url) {
                    revoked.push(url);
                },
            },
            btoa(value) {
                return Buffer.from(value, 'binary').toString('base64');
            },
            crypto: {
                subtle: {
                    digest: async () => new ArrayBuffer(32),
                },
            },
        }
    );
    const container = windowObject.VDocContainer;
    const hash = 'a'.repeat(64);
    const bytes = Uint8Array.from([0x77, 0x4f, 0x46, 0x32]);
    const documentModel = {
        manifest: {
            resources: [{
                id: hash,
                sha256: hash,
                kind: 'font',
                category: 'fonts',
                mime: 'font/woff2',
                sourceUrl: '',
            }],
        },
    };
    const resolver = container.createRuntimeResolver(
        documentModel,
        new Map([[hash, bytes]])
    );
    const css = `src:url("vdoc-resource://fonts/${hash}") format("woff2")`;
    assert.match(resolver.resolveHtml(css), /blob:vdoc-font/);
    assert.match(
        resolver.resolveExportHtml(css),
        /data:font\/woff2;base64,d09GMg==/
    );
    assert.equal(created.length, 1);
    resolver.revoke();
    assert.deepEqual(revoked, ['blob:vdoc-font']);
});

test('trusted Google Fonts imports are hoisted before internal Shadow DOM rules', () => {
    const windowObject = loadBrowserModule(
        'ScriptoriumModules/scriptorium-render-primitives.js'
    );
    const module = windowObject.ScriptoriumRenderPrimitives;
    let trusted = true;
    const primitives = module.createRenderPrimitives({
        core: {
            createSceneConfig: (scene) => scene,
        },
        hybridCompiler: {
            simpleHash: () => 'hash',
        },
        settingsPort: {
            get: (name) => name === 'trustNetworkFonts' && trusted,
        },
    });
    const googleImport =
        '@import url("https://fonts.googleapis.com/css2?'
        + 'family=Ma+Shan+Zheng&family=Noto+Serif+SC:'
        + 'wght@400;600;800&display=swap");';
    const combinedCss = [
        ':host { display: block; }',
        '.internal-rule { color: red; }',
        googleImport,
        '.document-rule { font-family: "Ma Shan Zheng"; }',
    ].join('\n');

    const trustedCss = primitives.hoistTrustedImports(combinedCss);
    assert.equal(trustedCss.indexOf('@import'), 0);
    assert.ok(
        trustedCss.indexOf('@import') < trustedCss.indexOf(':host'),
        'Google Fonts import must precede internal rules'
    );
    assert.equal(
        (trustedCss.match(/fonts\.googleapis\.com/g) || []).length,
        1
    );

    const embeddedImports = primitives.trustedNetworkFontImports([
        `<style>${googleImport}</style>`,
    ]);
    assert.match(embeddedImports, /^@import url\("https:\/\/fonts\.googleapis/);

    trusted = false;
    assert.equal(
        primitives.trustedNetworkFontImports([googleImport]),
        ''
    );
    assert.doesNotMatch(
        primitives.hoistTrustedImports(combinedCss),
        /fonts\.googleapis\.com/
    );
});

test('trusted cached fonts dynamically resolve and export as HTTPS URLs', () => {
    let trusted = false;
    let base64Calls = 0;
    class TestBlob {
        constructor(parts, options) {
            this.parts = parts;
            this.type = options.type;
        }
    }
    const windowObject = loadBrowserModule(
        'ScriptoriumModules/vdoc-container.js',
        {
            Blob: TestBlob,
            URL: {
                createObjectURL() {
                    return 'blob:vdoc-cached-font';
                },
                revokeObjectURL() {},
            },
            btoa(value) {
                base64Calls += 1;
                return Buffer.from(value, 'binary').toString('base64');
            },
            crypto: {
                subtle: {
                    digest: async () => new ArrayBuffer(32),
                },
            },
        }
    );
    const container = windowObject.VDocContainer;
    const hash = 'c'.repeat(64);
    const sourceUrl = 'https://cdn.example.com/cached.woff2';
    const resolver = container.createRuntimeResolver(
        {
            manifest: {
                resources: [{
                    id: hash,
                    sha256: hash,
                    kind: 'font',
                    category: 'fonts',
                    mime: 'font/woff2',
                    sourceUrl,
                }],
            },
        },
        new Map([[hash, Uint8Array.from([0x77, 0x4f, 0x46, 0x32])]]),
        new Map(),
        {
            trustNetworkFonts: () => trusted,
        }
    );
    const css = `src:url("vdoc-resource://fonts/${hash}")`;

    assert.match(resolver.resolveHtml(css), /blob:vdoc-cached-font/);
    assert.match(resolver.resolveExportHtml(css), /data:font\/woff2;base64/);
    const untrustedBase64Calls = base64Calls;
    assert.ok(untrustedBase64Calls > 0);

    trusted = true;
    assert.equal(resolver.resolveHtml(css), `src:url("${sourceUrl}")`);
    assert.equal(resolver.resolveExportHtml(css), `src:url("${sourceUrl}")`);
    assert.equal(base64Calls, untrustedBase64Calls);
});

test('Scriptorium settings persist network font trust and default to off', () => {
    const values = new Map();
    const storage = {
        getItem(key) {
            return values.get(key) || null;
        },
        setItem(key, value) {
            values.set(key, value);
        },
    };
    const windowObject = loadBrowserModule(
        'ScriptoriumModules/scriptorium-settings.js',
        {
            localStorage: storage,
        }
    );
    const settingsModule = windowObject.ScriptoriumSettings;
    const settings = settingsModule.createSettingsStore({ storage });
    const changes = [];
    settings.subscribe(
        'trustNetworkFonts',
        (value) => changes.push(value)
    );

    assert.equal(settings.get('trustNetworkFonts'), false);
    assert.equal(settings.set('trustNetworkFonts', true), true);
    assert.deepEqual(changes, [true]);
    assert.equal(
        JSON.parse(values.get(settingsModule.STORAGE_KEY)).trustNetworkFonts,
        true
    );

    const restored = settingsModule.createSettingsStore({ storage });
    assert.equal(restored.get('trustNetworkFonts'), true);
});