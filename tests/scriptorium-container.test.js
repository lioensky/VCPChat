'use strict';

const assert = require('assert');
const path = require('path');
const JSZip = require('jszip');

global.window = global;
global.JSZip = JSZip;
global.btoa = (value) => Buffer.from(value, 'binary').toString('base64');

require(path.resolve(__dirname, '..', 'ScriptoriumModules', 'vdoc-container.js'));

async function run() {
    const container = global.VDocContainer;
    assert(container, 'VDocContainer should be exposed');

    const documentModel = {
        format: 'vcp-vdocx',
        version: 1,
        manifest: {
            id: 'container-test',
            title: '容器测试',
            resources: [],
        },
        source: {
            content: '<main><img src="RESOURCE_PLACEHOLDER" description="红色测试图"></main>',
        },
        checkpoints: [],
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
        description: '红色测试图',
        nativeWidth: 40,
        nativeHeight: 20,
    });
    const duplicate = await container.registerResource(documentModel, resourceData, {
        bytes: svgBytes,
        kind: 'media',
        name: 'duplicate.svg',
        mime: 'image/svg+xml',
        description: '同内容重复资源',
        nativeWidth: 40,
        nativeHeight: 20,
    });

    assert.strictEqual(first.id, duplicate.id, 'same bytes should have the same SHA-256 id');
    assert.strictEqual(
        documentModel.manifest.resources.length,
        1,
        'same bytes should be deduplicated in the manifest'
    );
    assert.strictEqual(resourceData.size, 1, 'same bytes should be deduplicated in storage');

    const reference = container.resourceReference(first);
    documentModel.source.content = documentModel.source.content.replace(
        'RESOURCE_PLACEHOLDER',
        reference
    );

    const packed = await container.pack(documentModel, resourceData);
    assert.strictEqual(packed[0], 0x50, 'container should start with ZIP P signature');
    assert.strictEqual(packed[1], 0x4b, 'container should start with ZIP K signature');

    const zip = await JSZip.loadAsync(packed);
    assert(zip.file('document.json'), 'ZIP should contain document.json');
    assert(zip.file('mimetype'), 'ZIP should contain mimetype');
    assert(
        zip.file(`resources/media/${first.id}.svg`),
        'ZIP should contain the content-addressed media entry'
    );

    const storedText = await zip.file('document.json').async('string');
    const stored = JSON.parse(storedText);
    assert.strictEqual(stored.container.format, 'vcp-vdoc-container');
    assert.strictEqual(stored.container.version, 2);
    assert(stored.source.content.includes(reference), 'source should retain short resource URI');
    assert(!storedText.includes(';base64,'), 'document.json should not contain base64 resources');
    assert(!storedText.includes(Buffer.from(svgBytes).toString('base64')));

    const core = {
        normalizeDocument: (value) => value,
    };
    const unpacked = await container.unpack(packed, core);
    assert.strictEqual(unpacked.document.manifest.resources.length, 1);
    assert.deepStrictEqual(
        Buffer.from(unpacked.resourceData.get(first.id)),
        Buffer.from(svgBytes),
        'unpacked resource bytes should round-trip exactly'
    );

    const resolver = container.createRuntimeResolver(
        unpacked.document,
        unpacked.resourceData,
        new Map()
    );
    const exported = resolver.resolveExportHtml(unpacked.document.source.content);
    assert(
        exported.includes('data:image/svg+xml;base64,'),
        'export copy should inline internal media as a data URL'
    );
    assert(
        unpacked.document.source.content.includes(reference),
        'export resolution must not mutate document source'
    );

    await assert.rejects(
        () => container.unpack(new TextEncoder().encode('{"legacy":true}'), core),
        /ZIP 工程/,
        'legacy bare JSON should be rejected'
    );

    console.log('Scriptorium container tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});