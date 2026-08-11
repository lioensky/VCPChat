'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const JSZip = require('jszip');

global.window = global;
global.JSZip = JSZip;
global.btoa = (value) => Buffer.from(value, 'binary').toString('base64');

require(path.resolve(__dirname, '..', 'ScriptoriumModules', 'vdoc-container.js'));

async function run() {
    const container = global.VDocContainer;
    assert(container, 'VDocContainer should be exposed');

    const originalSource = [
        '# 容器测试',
        '',
        '![红色测试图](https://example.test/first.svg)',
        '',
        '<div data-vdoc-island="sample"><strong>岛内容</strong></div>',
        '',
    ].join('\r\n');
    const documentCss = 'body { color: #222; }\n';
    const documentModel = {
        format: 'vcp-vdocx',
        version: 2,
        manifest: {
            id: 'container-test',
            title: '容器测试',
            sourceFormat: 'markdown-hybrid',
            resources: [],
            scene: { kind: 'flow-document' },
        },
        source: {
            format: 'markdown-hybrid',
            content: originalSource,
            documentCss,
            lineEnding: 'crlf',
            deckCss: '',
            slides: [],
        },
        anchors: [],
        islands: [],
        checkpoints: [{ id: 'checkpoint-1', name: '初稿' }],
    };
    const resourceData = new Map();
    const svgBytes = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">'
        + '<rect width="40" height="20" fill="red"/></svg>'
    );

    const first = await container.registerResource(documentModel, resourceData, {
        bytes: svgBytes,
        kind: 'media',
        name: 'first.svg',
        mime: 'image/svg+xml',
        sourceUrl: 'https://example.test/first.svg',
        description: '红色测试图',
        nativeWidth: 40,
        nativeHeight: 20,
    });
    const duplicate = await container.registerResource(documentModel, resourceData, {
        bytes: svgBytes,
        kind: 'media',
        name: 'duplicate.svg',
        mime: 'image/svg+xml',
        sourceUrl: 'https://example.test/first.svg',
    });

    assert.equal(first.id, duplicate.id);
    assert.equal(documentModel.manifest.resources.length, 1);
    assert.equal(resourceData.size, 1);

    const packed = await container.pack(documentModel, resourceData);
    assert.equal(packed[0], 0x50);
    assert.equal(packed[1], 0x4b);

    const zip = await JSZip.loadAsync(packed);
    assert(zip.file('manifest.json'));
    assert(zip.file('source/document.md'));
    assert(zip.file('source/document.css'));
    assert(zip.file('lineage/checkpoints.json'));
    assert(zip.file('mimetype'));
    assert.equal(zip.file('document.json'), null, 'old monolithic entry must not exist');
    assert(zip.file(`resources/media/${first.id}.svg`));

    const storedSource = await zip.file('source/document.md').async('string');
    const storedCss = await zip.file('source/document.css').async('string');
    const storedManifestText = await zip.file('manifest.json').async('string');
    const storedManifest = JSON.parse(storedManifestText);
    assert.equal(storedSource, originalSource, 'Markdown source must round-trip exactly');
    assert.equal(storedCss, documentCss);
    assert.equal(storedManifest.source.content, null);
    assert.equal(storedManifest.source.documentCss, null);
    assert(!storedManifestText.includes(originalSource));
    assert(!storedManifestText.includes(';base64,'));

    const core = {
        normalizeDocument(value) {
            assert.equal(value.version, 2);
            assert.equal(value.source.format, 'markdown-hybrid');
            return value;
        },
    };
    const unpacked = await container.unpack(packed, core);
    assert.equal(unpacked.document.source.content, originalSource);
    assert.equal(unpacked.document.source.documentCss, documentCss);
    assert.equal(unpacked.document.checkpoints[0].id, 'checkpoint-1');
    assert.equal(unpacked.document.manifest.resources[0].sourceUrl,
        'https://example.test/first.svg');
    assert.deepEqual(
        Buffer.from(unpacked.resourceData.get(first.id)),
        Buffer.from(svgBytes)
    );

    const resolver = container.createRuntimeResolver(
        unpacked.document,
        unpacked.resourceData,
        new Map()
    );
    const rendered = resolver.resolveHtml(
        '<img src="https://example.test/first.svg">'
    );
    assert.match(rendered, /^<img src="blob:/);
    const exported = resolver.resolveExportHtml(
        '<img src="https://example.test/first.svg">'
    );
    assert.match(exported, /data:image\/svg\+xml;base64,/);
    assert.equal(
        unpacked.document.source.content,
        originalSource,
        'runtime and export resolution must not mutate Markdown source'
    );

    await assert.rejects(
        () => container.unpack(new TextEncoder().encode('{"legacy":true}'), core),
        /ZIP 工程/
    );

    console.log('[ScriptoriumContainerV2] PASSED');
}

run().catch((error) => {
    console.error('[ScriptoriumContainerV2] FAILED', error);
    process.exitCode = 1;
});