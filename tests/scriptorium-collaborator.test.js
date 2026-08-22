'use strict';

const assert = require('assert');
const collaborator = require('../VCPDistributedServer/Plugin/ScriptoriumCollaborator/ScriptoriumCollaboratorService');

function createControl() {
    const calls = [];
    return {
        calls,
        async call(request) {
            calls.push({ type: 'call', request });
            if (request.method === 'submitSourcePr') {
                return {
                    success: true,
                    documentId: 'document-test',
                    revision: 2,
                    pr: {
                        id: 'pr-test',
                        status: 'applied',
                        author: request.payload.author,
                    },
                    receipt: {
                        decision: 'approved',
                        message: '人类确认通过。',
                        reviewer: {
                            id: 'human',
                            name: '人类审阅者',
                            type: 'human',
                        },
                    },
                };
            }
            if (request.method === 'listStylePacks') {
                return {
                    success: true,
                    builtinPackId: 'vcp.scriptorium.classics',
                    count: 1,
                    packs: [{
                        manifest: {
                            id: 'vcp.scriptorium.classics',
                            name: '文坊经典样式',
                        },
                        builtin: true,
                        editable: false,
                        styleCount: 5,
                        styles: [],
                    }],
                };
            }
            if (request.method === 'getStylePack') {
                return {
                    success: true,
                    pack: {
                        format: 'vcp-vdoc-style-pack',
                        version: 1,
                        manifest: {
                            id: request.payload.packId,
                            name: '测试主题',
                        },
                        editable: true,
                        styles: [{
                            id: 'vcp.test.accent',
                            targets: ['inline'],
                            className: 'vds-test-accent',
                            css: '.vds-test-accent{color:#7651c9}',
                        }],
                    },
                    source: '{\n  "format": "vcp-vdoc-style-pack"\n}',
                };
            }
            if (request.method === 'upsertStylePack') {
                return {
                    success: true,
                    operation: 'create',
                    maid: request.payload.maid,
                    pack: request.payload.pack,
                };
            }
            if (request.method === 'deleteStylePack') {
                return {
                    success: true,
                    operation: 'delete',
                    packId: request.payload.packId,
                    deletedStyleCount: 1,
                    maid: request.payload.maid,
                };
            }
            if (request.method === 'listSvgAssetPacks') {
                return {
                    success: true,
                    builtinPackId: 'vcp.scriptorium.basic-shapes',
                    count: 1,
                    packs: [{
                        manifest: {
                            id: 'vcp.scriptorium.basic-shapes',
                            name: 'Scriptorium 基础图形',
                        },
                        builtin: true,
                        editable: false,
                        assetCount: 7,
                        animatedCount: 0,
                        assets: [],
                    }],
                };
            }
            if (request.method === 'listSvgAssets') {
                return {
                    success: true,
                    count: 1,
                    assets: [{
                        id: 'vcp.test.motion.spinner',
                        name: '旋转加载器',
                        packId: 'vcp.test.motion',
                        category: '动画',
                        kind: 'animated',
                    }],
                };
            }
            if (request.method === 'getSvgAsset') {
                return {
                    success: true,
                    builtin: false,
                    editable: true,
                    asset: {
                        id: request.payload.assetId,
                        name: '旋转加载器',
                        packId: 'vcp.test.motion',
                        kind: 'animated',
                        source: '<svg><circle><animate/></circle></svg>',
                    },
                    source: '<svg><circle><animate/></circle></svg>',
                };
            }
            if (request.method === 'getSvgAssetPack') {
                return {
                    success: true,
                    pack: {
                        format: 'vcp-vdoc-svg-asset-pack',
                        version: 1,
                        manifest: {
                            id: request.payload.packId,
                            name: '测试 SVG 资产包',
                        },
                        editable: true,
                        assets: [],
                    },
                    source: '{\n  "format": "vcp-vdoc-svg-asset-pack"\n}',
                };
            }
            if (request.method === 'upsertSvgAssetPack') {
                return {
                    success: true,
                    operation: 'create',
                    maid: request.payload.maid,
                    pack: request.payload.pack,
                };
            }
            if (request.method === 'deleteSvgAssetPack') {
                return {
                    success: true,
                    operation: 'delete',
                    packId: request.payload.packId,
                    deletedAssetCount: 1,
                    maid: request.payload.maid,
                };
            }
            if (request.method === 'getOutline') {
                return {
                    success: true,
                    documentId: 'document-test',
                    documentKind: 'docx',
                    revision: 7,
                    sourceKind: 'markdown-hybrid',
                    count: 3,
                    totalCharacters: 380000,
                    items: [{
                        id: 'heading-0-opening',
                        index: 0,
                        kind: 'heading',
                        level: 1,
                        text: '第一卷 风起',
                        startLine: 1,
                        endLine: 4200,
                        characterCount: 128000,
                        contentCharacterCount: 127980,
                        headingRange: { start: 0, end: 12 },
                        sourceRange: { start: 0, end: 128000 },
                    }, {
                        id: 'heading-500-turn',
                        index: 1,
                        kind: 'heading',
                        level: 2,
                        text: '第十章 转折',
                        startLine: 500,
                        endLine: 930,
                        characterCount: 18000,
                        contentCharacterCount: 17982,
                        headingRange: { start: 15000, end: 15014 },
                        sourceRange: { start: 15000, end: 33000 },
                    }, {
                        id: 'heading-900-ending',
                        index: 2,
                        kind: 'heading',
                        level: 1,
                        text: '终卷 归途',
                        startLine: 9000,
                        endLine: 12000,
                        characterCount: 96000,
                        contentCharacterCount: 95980,
                        headingRange: { start: 284000, end: 284012 },
                        sourceRange: { start: 284000, end: 380000 },
                    }],
                };
            }
            if (request.method === 'getSection') {
                return {
                    success: true,
                    documentId: 'document-test',
                    documentKind: 'docx',
                    revision: 7,
                    sourceKind: 'markdown-hybrid',
                    heading: {
                        id: request.payload.id,
                        index: 1,
                        text: '第十章 转折',
                        level: 2,
                        characterCount: 18000,
                        contentCharacterCount: 17982,
                    },
                    startLine: 500,
                    endLine: 930,
                    sourceRange: { start: 15000, end: 33000 },
                    source: '## 第十章 转折\n\n关键剧情正文。',
                    renderedText: '第十章 转折\n关键剧情正文。',
                    diagnostics: [],
                };
            }
            if (request.method === 'getSource') {
                return {
                    success: true,
                    documentId: 'document-test',
                    documentKind: 'docx',
                    revision: 1,
                    sourceKind: 'html',
                    startLine: 1,
                    endLine: 2,
                    totalLines: 2,
                    source: '<article data-title="原生文本">\n  <p>无需 JSON 反转义</p>\n</article>',
                };
            }
            return {
                success: true,
                documentId: 'document-test',
                documentKind: 'docx',
                revision: 1,
            };
        },
        async captureVisualContext(request) {
            calls.push({ type: 'visual', request });
            return {
                content: [
                    { type: 'text', text: '当前可见文档区域' },
                    {
                        type: 'image_url',
                        image_url: {
                            url: 'data:image/png;base64,iVBORw0KGgo=',
                        },
                    },
                ],
                details: {
                    documentKind: 'docx',
                    captureRect: { x: 1, y: 2, width: 300, height: 200 },
                },
            };
        },
        async createProjectArtifact(payload) {
            calls.push({ type: 'create', payload });
            return {
                content: [{
                    type: 'text',
                    text: 'Scriptorium 工程已直接落盘。',
                }],
                details: {
                    command: 'CreateProject',
                    path: 'AppData/ScriptoriumDocument/VDOCX/测试文稿.vdocx',
                    maid: payload.maid,
                    fileHash: 'abc123',
                },
            };
        },
        getStorageInfo() {
            return {
                root: 'AppData/ScriptoriumDocument',
                defaultConflictPolicy: 'rename',
            };
        },
    };
}

async function run() {
    const control = createControl();
    collaborator.initialize({
        services: { scriptoriumAgentControl: control },
        logger: console,
    });

    const visual = await collaborator.processToolCall({
        command: 'GetVisualContext',
        endpoint: 'docx',
        format: 'png',
    }, {
        requestId: 'visual-request',
    });
    assert.ok(Array.isArray(visual.content));
    assert.strictEqual(visual.content[0].type, 'text');
    assert.strictEqual(visual.content[1].type, 'image_url');
    assert.ok(visual.content[1].image_url.url.startsWith('data:image/png;base64,'));

    const sourceResult = await collaborator.processToolCall({
        command: 'GetSource',
        endpoint: 'docx',
        sourceKind: 'html',
    });
    const sourceMarkdown = sourceResult.content[0].text;
    assert.ok(sourceMarkdown.startsWith('# Scriptorium · getSource'));
    assert.ok(sourceMarkdown.includes('## 源码'));
    assert.ok(sourceMarkdown.includes('```html'));
    assert.ok(sourceMarkdown.includes('<article data-title="原生文本">'));
    assert.ok(sourceMarkdown.includes('\n  <p>无需 JSON 反转义</p>\n'));
    assert.ok(!sourceMarkdown.includes('\\"原生文本\\"'));
    assert.ok(!sourceMarkdown.includes('\\n  <p>'));
    assert.strictEqual(
        sourceResult.details.source,
        '<article data-title="原生文本">\n  <p>无需 JSON 反转义</p>\n</article>'
    );

    const outline = await collaborator.processToolCall({
        command: 'GetOutline',
        endpoint: 'docx',
    }, {
        requestId: 'outline-request',
    });
    const outlineCall = control.calls.find((entry) =>
        entry.type === 'call' && entry.request.method === 'getOutline'
    );
    assert.ok(outlineCall);
    assert.strictEqual(outlineCall.request.endpoint, 'docx');
    assert.strictEqual(outlineCall.request.requestId, 'outline-request');
    assert.strictEqual(outline.details.count, 3);
    assert.strictEqual(outline.details.totalCharacters, 380000);
    assert.deepStrictEqual(
        outline.details.items[1].sourceRange,
        { start: 15000, end: 33000 }
    );
    const outlineMarkdown = outline.content[0].text;
    assert.ok(outlineMarkdown.startsWith(
        '# Scriptorium · 分层章节目录'
    ));
    assert.ok(outlineMarkdown.includes('- **章节数**：3'));
    assert.ok(outlineMarkdown.includes(
        '- [0] 第一卷 风起 · L1-4200 · 128000 字'
    ));
    assert.ok(outlineMarkdown.includes(
        '  - [1] 第十章 转折 · L500-930 · 18000 字'
    ));
    assert.ok(outlineMarkdown.includes(
        'ID: `heading-500-turn`'
    ));
    assert.ok(outlineMarkdown.includes(
        '建议先按标题层级和章节字符数选择少量关键章节'
    ));
    assert.ok(!outlineMarkdown.includes('## 目录项 1'));

    const section = await collaborator.processToolCall({
        command: 'GetSection',
        id: outline.details.items[1].id,
    });
    const sectionCall = control.calls.find((entry) =>
        entry.type === 'call' && entry.request.method === 'getSection'
    );
    assert.ok(sectionCall);
    assert.strictEqual(sectionCall.request.endpoint, 'docx');
    assert.strictEqual(
        sectionCall.request.payload.id,
        'heading-500-turn'
    );
    assert.strictEqual(section.details.heading.characterCount, 18000);
    assert.ok(section.content[0].text.includes('## 源码'));
    assert.ok(section.content[0].text.includes('```markdown'));
    assert.ok(section.content[0].text.includes('关键剧情正文'));

    const submitted = await collaborator.processToolCall({
        command: 'SubmitSourcePr',
        endpoint: 'docx',
        maid: 'Nova',
        summary: '修正文稿标题',
        target: '旧标题',
        replace: '新标题',
        startLine: 12,
        expectedRevision: 1,
    }, {
        requestId: 'trusted-request-id',
        vcpContext: {
            agentId: 'agent-nova',
            agentName: '不应覆盖 maid 显示名',
        },
    });
    const submitCall = control.calls.find((entry) =>
        entry.type === 'call' && entry.request.method === 'submitSourcePr'
    );
    assert.ok(submitCall);
    assert.strictEqual(submitCall.request.requestId, 'trusted-request-id');
    assert.deepStrictEqual(submitCall.request.payload.maid, {
        id: 'agent-nova',
        name: 'Nova',
        type: 'agent',
    });
    assert.deepStrictEqual(
        submitCall.request.payload.author,
        submitCall.request.payload.maid
    );
    assert.strictEqual(submitted.details.receipt.message, '人类确认通过。');
    assert.strictEqual(submitted.details.pr.author.name, 'Nova');
    const submittedMarkdown = submitted.content[0].text;
    assert.ok(submittedMarkdown.includes('## PR'));
    assert.ok(submittedMarkdown.includes('### 作者'));
    assert.ok(submittedMarkdown.includes('- **名称**：Nova'));
    assert.ok(submittedMarkdown.includes('## 审批回执'));
    assert.ok(submittedMarkdown.includes('- **消息**：人类确认通过。'));
    assert.ok(!submittedMarkdown.includes('```json'));

    const inserted = await collaborator.processToolCall({
        command: 'SubmitSourcePr',
        endpoint: 'docx',
        maid: 'Nova',
        summary: '在文档末尾续写',
        insert: '## 新增小节\n\n这里是续写内容。',
        line: 1004,
    }, {
        requestId: 'insert-request',
    });
    const insertCall = control.calls.find((entry) =>
        entry.type === 'call'
        && entry.request.method === 'submitSourcePr'
        && entry.request.requestId === 'insert-request'
    );
    assert.ok(insertCall);
    assert.deepStrictEqual(
        insertCall.request.payload.replacements,
        [{
            insert: '## 新增小节\n\n这里是续写内容。',
            line: 1004,
        }]
    );
    assert.strictEqual(inserted.details.receipt.decision, 'approved');

    const appendedByIntent = await collaborator.processToolCall({
        command: 'SubmitSourcePr',
        endpoint: 'docx',
        maid: 'Nova',
        summary: '在文档末尾续写',
        append: '## 继续写作\n\n这是直接追加到文档末尾的内容。',
    }, {
        requestId: 'append-request',
    });
    const appendCall = control.calls.find((entry) =>
        entry.type === 'call'
        && entry.request.method === 'submitSourcePr'
        && entry.request.requestId === 'append-request'
    );
    assert.ok(appendCall);
    assert.deepStrictEqual(
        appendCall.request.payload.replacements,
        [{
            append: '## 继续写作\n\n这是直接追加到文档末尾的内容。',
        }]
    );
    assert.strictEqual(appendedByIntent.details.receipt.decision, 'approved');

    const styleList = await collaborator.processToolCall({
        command: 'ListStylePacks',
        query: '经典',
    });
    assert.strictEqual(styleList.details.count, 1);
    assert.strictEqual(styleList.details.packs[0].editable, false);

    const styleSource = await collaborator.processToolCall({
        command: 'GetStylePack',
        packId: 'vcp.test.theme',
    });
    assert.strictEqual(
        styleSource.details.pack.manifest.id,
        'vcp.test.theme'
    );
    assert.ok(styleSource.content[0].text.includes(
        'vcp-vdoc-style-pack'
    ));

    const pack = {
        format: 'vcp-vdoc-style-pack',
        version: 1,
        manifest: {
            id: 'vcp.test.generated',
            name: 'Agent 批量生成主题',
        },
        styles: [{
            id: 'vcp.test.generated.accent',
            name: '批量强调',
            targets: ['inline'],
            className: 'vds-generated-accent',
            css: '.vds-generated-accent{color:#7651c9}',
        }],
    };
    const upserted = await collaborator.processToolCall({
        command: 'UpsertStylePack',
        maid: 'Nova',
        source: JSON.stringify(pack),
    }, {
        requestId: 'style-upsert-request',
        vcpContext: { agentId: 'agent-nova' },
    });
    const upsertCall = control.calls.find((entry) =>
        entry.type === 'call'
        && entry.request.method === 'upsertStylePack'
    );
    assert.ok(upsertCall);
    assert.strictEqual(
        upsertCall.request.requestId,
        'style-upsert-request'
    );
    assert.deepStrictEqual(upsertCall.request.payload.pack, pack);
    assert.deepStrictEqual(upsertCall.request.payload.maid, {
        id: 'agent-nova',
        name: 'Nova',
        type: 'agent',
    });
    assert.strictEqual(upserted.details.operation, 'create');

    const deleted = await collaborator.processToolCall({
        command: 'DeleteStylePack',
        packId: 'vcp.test.generated',
        maid: 'Nova',
    }, {
        requestId: 'style-delete-request',
        vcpContext: { agentId: 'agent-nova' },
    });
    const deleteCall = control.calls.find((entry) =>
        entry.type === 'call'
        && entry.request.method === 'deleteStylePack'
    );
    assert.ok(deleteCall);
    assert.strictEqual(
        deleteCall.request.payload.packId,
        'vcp.test.generated'
    );
    assert.strictEqual(deleted.details.deletedStyleCount, 1);

    const svgPackList = await collaborator.processToolCall({
        command: 'ListSvgAssetPacks',
        query: '基础',
        editableOnly: false,
    });
    assert.strictEqual(svgPackList.details.count, 1);
    assert.strictEqual(
        svgPackList.details.builtinPackId,
        'vcp.scriptorium.basic-shapes'
    );
    const svgPackListCall = control.calls.find((entry) =>
        entry.type === 'call'
        && entry.request.method === 'listSvgAssetPacks'
    );
    assert.deepStrictEqual(svgPackListCall.request.payload, {
        query: '基础',
        editableOnly: false,
    });

    const svgAssets = await collaborator.processToolCall({
        command: 'ListSvgAssets',
        query: '加载',
        packId: 'vcp.test.motion',
        category: '动画',
        kind: 'animated',
    });
    assert.strictEqual(svgAssets.details.assets[0].kind, 'animated');
    const svgAssetsCall = control.calls.find((entry) =>
        entry.type === 'call'
        && entry.request.method === 'listSvgAssets'
    );
    assert.deepStrictEqual(svgAssetsCall.request.payload, {
        query: '加载',
        packId: 'vcp.test.motion',
        category: '动画',
        kind: 'animated',
    });

    const svgAsset = await collaborator.processToolCall({
        command: 'GetSvgAsset',
        assetId: 'vcp.test.motion.spinner',
    });
    assert.strictEqual(
        svgAsset.details.asset.id,
        'vcp.test.motion.spinner'
    );
    assert.ok(svgAsset.content[0].text.includes('<animate/>'));

    const svgPackSource = await collaborator.processToolCall({
        command: 'GetSvgAssetPack',
        packId: 'vcp.test.motion',
    });
    assert.strictEqual(
        svgPackSource.details.pack.manifest.id,
        'vcp.test.motion'
    );
    assert.ok(svgPackSource.content[0].text.includes(
        'vcp-vdoc-svg-asset-pack'
    ));

    const svgPack = {
        format: 'vcp-vdoc-svg-asset-pack',
        version: 1,
        manifest: {
            id: 'vcp.test.generated-svg',
            name: 'Agent SVG 资产包',
        },
        assets: [{
            id: 'vcp.test.generated-svg.pulse',
            name: '脉冲圆',
            category: '动画',
            source: '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<circle cx="50" cy="50" r="20">'
                + '<animate attributeName="r" from="20" to="40" dur="1s"/>'
                + '</circle></svg>',
        }],
    };
    const svgUpserted = await collaborator.processToolCall({
        command: 'UpsertSvgAssetPack',
        maid: 'Nova',
        source: JSON.stringify(svgPack),
    }, {
        requestId: 'svg-upsert-request',
        vcpContext: { agentId: 'agent-nova' },
    });
    const svgUpsertCall = control.calls.find((entry) =>
        entry.type === 'call'
        && entry.request.method === 'upsertSvgAssetPack'
    );
    assert.ok(svgUpsertCall);
    assert.strictEqual(
        svgUpsertCall.request.requestId,
        'svg-upsert-request'
    );
    assert.deepStrictEqual(svgUpsertCall.request.payload.pack, svgPack);
    assert.deepStrictEqual(svgUpsertCall.request.payload.maid, {
        id: 'agent-nova',
        name: 'Nova',
        type: 'agent',
    });
    assert.strictEqual(svgUpserted.details.operation, 'create');

    const svgDeleted = await collaborator.processToolCall({
        command: 'DeleteSvgAssetPack',
        packId: 'vcp.test.generated-svg',
        maid: 'Nova',
    }, {
        requestId: 'svg-delete-request',
        vcpContext: { agentId: 'agent-nova' },
    });
    const svgDeleteCall = control.calls.find((entry) =>
        entry.type === 'call'
        && entry.request.method === 'deleteSvgAssetPack'
    );
    assert.ok(svgDeleteCall);
    assert.strictEqual(
        svgDeleteCall.request.requestId,
        'svg-delete-request'
    );
    assert.strictEqual(
        svgDeleteCall.request.payload.packId,
        'vcp.test.generated-svg'
    );
    assert.strictEqual(svgDeleted.details.deletedAssetCount, 1);

    await assert.rejects(
        collaborator.processToolCall({
            command: 'UpsertSvgAssetPack',
            pack: svgPack,
        }),
        /缺少 maid 署名字段/
    );
    await assert.rejects(
        collaborator.processToolCall({
            command: 'GetSvgAsset',
        }),
        /缺少 assetId/
    );

    const fenced = collaborator._test.markdownFence(
        'const example = `value`;\n```\nend',
        'javascript'
    );
    assert.ok(fenced.startsWith('````javascript\n'));
    assert.ok(fenced.endsWith('\n````'));

    const created = await collaborator.processToolCall({
        command: 'CreateProject',
        projectType: 'docx',
        maid: 'Mia',
        title: '测试文稿',
        source: '<style>h1{color:#315f55}</style><article><h1>测试文稿</h1></article>',
        conflictPolicy: 'rename',
    }, {
        requestId: 'create-request',
        vcpContext: { agentId: 'agent-mia' },
    });
    const createCall = control.calls.find((entry) => entry.type === 'create');
    assert.ok(createCall);
    assert.deepStrictEqual(createCall.payload.maid, {
        id: 'agent-mia',
        name: 'Mia',
        type: 'agent',
    });
    assert.strictEqual(
        createCall.payload.source,
        '<style>h1{color:#315f55}</style><article><h1>测试文稿</h1></article>'
    );
    assert.strictEqual(created.details.command, 'CreateProject');
    assert.strictEqual(created.details.maid.name, 'Mia');

    assert.throws(
        () => collaborator._test.authorFromMaid({}, {}),
        /缺少 maid 署名字段/
    );

    collaborator._test.resetForTests();
    console.log('Scriptorium collaborator tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});