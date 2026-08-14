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