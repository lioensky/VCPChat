'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadStyleLibrary() {
    const window = {
        VDocCore: {
            sanitizeCss: (css) => String(css || ''),
        },
    };
    const context = vm.createContext({
        window,
        console,
        TextDecoder,
        Uint8Array,
        ArrayBuffer,
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
    });
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'ScriptoriumModules', 'vdoc-style-library.js'),
        'utf8'
    );
    vm.runInContext(source, context, {
        filename: 'vdoc-style-library.js',
    });
    return window.VDocStyleLibrary;
}

function makePack(id, styles) {
    return {
        format: 'vcp-vdoc-style-pack',
        version: 1,
        manifest: {
            id,
            name: `测试主题 ${id}`,
            author: 'Agent Test',
        },
        styles,
    };
}

function makeStyle(id, color) {
    const className = `vds-${id.replace(/[^a-z0-9_-]+/gi, '-')}`;
    return {
        id,
        version: 1,
        name: id,
        category: '自动化测试',
        targets: ['inline'],
        className,
        css: `.${className}{color:${color}}`,
    };
}

function run() {
    const library = loadStyleLibrary();

    assert.strictEqual(
        library.BUILTIN_PACK_ID,
        'vcp.scriptorium.classics'
    );
    const builtin = library.getPack(library.BUILTIN_PACK_ID);
    assert.ok(builtin);
    assert.strictEqual(builtin.builtin, true);
    assert.strictEqual(builtin.editable, false);
    assert.ok(builtin.styles.length > 0);

    assert.throws(
        () => library.registerPack(
            makePack(library.BUILTIN_PACK_ID, [
                makeStyle('vcp.test.illegal-builtin', '#000'),
            ]),
            { conflict: 'replace' }
        ),
        /只读/
    );
    assert.throws(
        () => library.unregisterPack(library.BUILTIN_PACK_ID),
        /只读/
    );

    const packId = 'vcp.test.agent-theme';
    const first = library.registerPack(makePack(packId, [
        makeStyle('vcp.test.agent-theme.first', '#123456'),
        makeStyle('vcp.test.agent-theme.second', '#654321'),
    ]), {
        conflict: 'replace',
    });
    assert.strictEqual(first.editable, true);
    assert.strictEqual(first.styles.length, 2);
    assert.strictEqual(library.listPacks().length, 2);

    const replaced = library.registerPack(makePack(packId, [
        makeStyle('vcp.test.agent-theme.first', '#abcdef'),
        makeStyle('vcp.test.agent-theme.third', '#fedcba'),
    ]), {
        conflict: 'replace',
    });
    assert.strictEqual(replaced.styles.length, 2);
    assert.strictEqual(
        library.get('vcp.test.agent-theme.second'),
        null
    );
    assert.ok(library.get('vcp.test.agent-theme.third'));
    assert.ok(
        library.get('vcp.test.agent-theme.first').css.includes('#abcdef')
    );

    assert.throws(
        () => library.registerPack(makePack('vcp.test.other-theme', [
            makeStyle('vcp.test.agent-theme.first', '#111111'),
        ]), {
            conflict: 'replace',
        }),
        /已属于样式包/
    );

    const exported = library.exportUserPacks();
    assert.strictEqual(exported.length, 1);
    assert.strictEqual(exported[0].manifest.id, packId);
    assert.strictEqual(exported[0].styles.length, 2);
    assert.ok(!Object.hasOwn(exported[0], 'builtin'));
    assert.ok(!Object.hasOwn(exported[0], 'editable'));

    const restoredPackId = 'vcp.test.restored-theme';
    const restored = library.replaceUserPacks([
        makePack(restoredPackId, [
            makeStyle('vcp.test.restored-theme.first', '#246810'),
        ]),
    ]);
    assert.strictEqual(restored.length, 1);
    assert.strictEqual(restored[0].manifest.id, restoredPackId);
    assert.strictEqual(library.getPack(packId), null);
    assert.ok(library.get('vcp.test.restored-theme.first'));
    assert.ok(library.getPack(library.BUILTIN_PACK_ID));

    assert.strictEqual(library.unregisterPack(restoredPackId), true);
    assert.strictEqual(library.getPack(restoredPackId), null);
    assert.strictEqual(
        library.get('vcp.test.restored-theme.first'),
        null
    );
    assert.ok(library.getPack(library.BUILTIN_PACK_ID));

    console.log('Scriptorium style library tests passed');
}

run();