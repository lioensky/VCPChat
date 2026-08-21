'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function createSanitizer(window) {
    return function sanitizeSvgSource(source) {
        const parsed = new window.DOMParser().parseFromString(
            String(source || ''),
            'image/svg+xml'
        );
        if (parsed.querySelector('parsererror')
            || parsed.documentElement?.localName !== 'svg') {
            return {
                valid: false,
                message: 'SVG 源码无效。',
                source: '',
            };
        }
        parsed.querySelectorAll(
            'script,foreignObject,iframe,object,embed'
        ).forEach((node) => node.remove());
        [parsed.documentElement, ...parsed.querySelectorAll('*')]
            .forEach((node) => {
                [...node.attributes].forEach((attribute) => {
                    if (/^on/i.test(attribute.name)) {
                        node.removeAttribute(attribute.name);
                        return;
                    }
                    if (['href', 'src'].includes(attribute.localName)
                        && /^(?:javascript:|https?:|data:text\/html)/i.test(
                            attribute.value.trim()
                        )) {
                        node.removeAttribute(attribute.name);
                    }
                });
            });
        return {
            valid: true,
            message: '',
            source: new window.XMLSerializer().serializeToString(
                parsed.documentElement
            ),
        };
    };
}

function loadLibrary() {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://scriptorium.local/',
    });
    const browserWindow = dom.window;
    browserWindow.ScriptoriumObjects = {
        sanitizeSvgSource: createSanitizer(browserWindow),
    };
    const context = vm.createContext({
        window: browserWindow,
        globalThis: browserWindow,
        console,
        TextEncoder,
        DOMParser: browserWindow.DOMParser,
        XMLSerializer: browserWindow.XMLSerializer,
        Date,
        JSON,
        Map,
        Set,
        Object,
        String,
        Number,
        RegExp,
        Error,
        TypeError,
        Math,
    });
    const source = fs.readFileSync(
        path.join(
            __dirname,
            '..',
            'ScriptoriumModules',
            'vdoc-svg-asset-library.js'
        ),
        'utf8'
    );
    vm.runInContext(source, context, {
        filename: 'vdoc-svg-asset-library.js',
    });
    return {
        library: browserWindow.VDocSvgAssetLibrary,
        close: () => dom.window.close(),
    };
}

function asset(id, source, overrides = {}) {
    return {
        id,
        version: 1,
        name: overrides.name || id,
        description: overrides.description || '',
        category: overrides.category || '自动化测试',
        tags: overrides.tags || ['测试'],
        source,
        defaultSize: overrides.defaultSize || {
            width: 320,
            height: 180,
        },
        ...overrides,
    };
}

function pack(id, assets) {
    return {
        format: 'vcp-vdoc-svg-asset-pack',
        version: 1,
        manifest: {
            id,
            name: `测试资产包 ${id}`,
            author: 'Agent Test',
        },
        assets,
    };
}

function run() {
    const loaded = loadLibrary();
    const library = loaded.library;

    assert.strictEqual(
        library.BUILTIN_PACK_ID,
        'vcp.scriptorium.basic-shapes'
    );
    const builtin = library.getPack(library.BUILTIN_PACK_ID);
    assert.ok(builtin);
    assert.strictEqual(builtin.builtin, true);
    assert.strictEqual(builtin.editable, false);
    assert.strictEqual(builtin.assets.length, 7);
    assert.throws(
        () => library.unregisterPack(library.BUILTIN_PACK_ID),
        /只读/
    );
    assert.throws(
        () => library.registerPack(
            pack(library.BUILTIN_PACK_ID, [
                asset(
                    'vcp.test.illegal-builtin',
                    '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
                ),
            ]),
            { conflict: 'replace' }
        ),
        /只读/
    );

    const sanitized = library.inspectSvg(
        '<svg xmlns="http://www.w3.org/2000/svg">'
        + '<script>alert(1)</script>'
        + '<rect onclick="alert(2)" width="20" height="20"/>'
        + '</svg>'
    );
    assert.strictEqual(sanitized.diagnostics.scriptsRemoved, true);
    assert.ok(!sanitized.source.includes('<script'));
    assert.ok(!sanitized.source.includes('onclick='));

    const staticAsset = asset(
        'vcp.test.diagram.static',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        + '<defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/>'
        + '</linearGradient><clipPath id="crop"><circle cx="50" cy="50" r="40"/>'
        + '</clipPath></defs>'
        + '<rect id="box" width="100" height="100" fill="url(#paint)" '
        + 'clip-path="url(#crop)"/>'
        + '</svg>',
        { category: '流程图' }
    );
    const animatedAsset = asset(
        'vcp.test.diagram.animated',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        + '<circle cx="20" cy="50" r="10">'
        + '<animate attributeName="cx" from="20" to="80" dur="1s" '
        + 'repeatCount="indefinite"/>'
        + '</circle></svg>',
        { category: '动画' }
    );
    const cssAnimatedAsset = asset(
        'vcp.test.diagram.css-animated',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        + '<style>@keyframes pulse{to{opacity:.3}}'
        + '.pulse{animation:pulse 1s infinite}</style>'
        + '<circle class="pulse" cx="50" cy="50" r="30"/></svg>',
        { category: '动画' }
    );

    const packId = 'vcp.test.diagram-pack';
    const registered = library.registerPack(
        pack(packId, [staticAsset, animatedAsset, cssAnimatedAsset]),
        { conflict: 'replace' }
    );
    assert.strictEqual(registered.editable, true);
    assert.strictEqual(registered.assets.length, 3);
    assert.strictEqual(
        library.get('vcp.test.diagram.static').kind,
        'static'
    );
    assert.strictEqual(
        library.get('vcp.test.diagram.animated').kind,
        'animated'
    );
    assert.strictEqual(
        library.get('vcp.test.diagram.css-animated').kind,
        'animated'
    );
    assert.strictEqual(library.list({ kind: 'animated' }).length, 2);
    assert.strictEqual(library.list({ category: '流程图' }).length, 1);
    assert.strictEqual(library.list({ query: 'css-animated' }).length, 1);

    const summary = library.listPacks().find(
        (entry) => entry.manifest.id === packId
    );
    assert.strictEqual(summary.assetCount, 3);
    assert.strictEqual(summary.animatedCount, 2);

    const instanceA = library.instantiate(
        'vcp.test.diagram.static',
        { width: 640, height: 360 }
    );
    const instanceB = library.instantiate('vcp.test.diagram.static');
    assert.strictEqual(instanceA.width, 640);
    assert.strictEqual(instanceA.height, 360);
    assert.ok(!instanceA.source.includes('id="paint"'));
    assert.ok(!instanceA.source.includes('url(#paint)'));
    assert.notStrictEqual(instanceA.source, instanceB.source);
    const paintId = instanceA.source.match(/id="([^"]+-paint)"/)?.[1];
    assert.ok(paintId);
    assert.ok(instanceA.source.includes(`url(#${paintId})`));

    const replacement = library.registerPack(pack(packId, [
        asset(
            'vcp.test.diagram.static',
            '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="40" height="40" fill="#abcdef"/></svg>'
        ),
        asset(
            'vcp.test.diagram.replacement',
            '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<path d="M0 0L20 20"/></svg>'
        ),
    ]), {
        conflict: 'replace',
    });
    assert.strictEqual(replacement.assets.length, 2);
    assert.strictEqual(library.get('vcp.test.diagram.animated'), null);
    assert.ok(library.get('vcp.test.diagram.replacement'));

    assert.throws(
        () => library.registerPack(pack('vcp.test.conflict-pack', [
            asset(
                'vcp.test.diagram.static',
                '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>'
            ),
        ]), {
            conflict: 'replace',
        }),
        /已属于资产包/
    );

    const exported = library.exportUserPacks();
    assert.strictEqual(exported.length, 1);
    assert.strictEqual(exported[0].manifest.id, packId);
    assert.doesNotThrow(() =>
        JSON.parse(library.serializePack(packId))
    );

    library.replaceUserPacks([]);
    assert.strictEqual(library.getPack(packId), null);
    assert.ok(library.getPack(library.BUILTIN_PACK_ID));
    library.replaceUserPacks(exported);
    assert.ok(library.getPack(packId));
    assert.ok(library.get('vcp.test.diagram.replacement'));

    assert.strictEqual(library.unregisterPack(packId), true);
    assert.strictEqual(library.getPack(packId), null);
    assert.ok(library.getPack(library.BUILTIN_PACK_ID));

    loaded.close();
    console.log('Scriptorium SVG asset library tests passed');
}

run();