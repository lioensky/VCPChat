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