'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

global.marked = require('marked');

const compiler = require('../ScriptoriumModules/vdoc-hybrid-compiler.js');

function testHtmlSelectOptions() {
    const htmlPath = path.resolve(__dirname, '..', 'ScriptoriumModules', 'scriptorium.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const dom = new JSDOM(htmlContent);
    const document = dom.window.document;

    const select = document.getElementById('block-type-select');
    assert.ok(select, 'scriptorium.html 应存在 block-type-select 元素');

    const options = [...select.options].map((opt) => ({
        value: opt.value,
        text: opt.textContent.trim(),
    }));

    const h1Center = options.find((opt) => opt.value === 'heading-1-center');
    const h2Center = options.find((opt) => opt.value === 'heading-2-center');
    const h3Center = options.find((opt) => opt.value === 'heading-3-center');

    assert.ok(h1Center, '应存在 heading-1-center 选项');
    assert.equal(h1Center.text, '一级标题(居中)');

    assert.ok(h2Center, '应存在 heading-2-center 选项');
    assert.equal(h2Center.text, '二级标题(居中)');

    assert.ok(h3Center, '应存在 heading-3-center 选项');
    assert.equal(h3Center.text, '三级标题(居中)');

    // 确保已有的选项仍然保留
    const h1 = options.find((opt) => opt.value === 'heading-1');
    const h2 = options.find((opt) => opt.value === 'heading-2');
    const h3 = options.find((opt) => opt.value === 'heading-3');
    assert.ok(h1 && h2 && h3, '原有的 Markdown 标题选项应保留');
}

function testFlowEditorStructureSource() {
    const flowEditorPath = path.resolve(
        __dirname,
        '..',
        'ScriptoriumModules',
        'scriptorium-flow-editor.js'
    );
    const flowEditorSource = fs.readFileSync(flowEditorPath, 'utf8');

    // 提取 structureSource 函数或通过 vm 实例化
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
        runScripts: 'dangerously',
    });
    const window = dom.window;

    window.ScriptoriumInputSync = {
        createInputSync: () => ({ markInput: () => {}, flush: () => {}, dispose: () => {} }),
    };

    vm.runInContext(flowEditorSource, dom.getInternalVMContext());

    const mockAdapter = {
        kind: 'flow',
        currentSource: () => '',
        compile: () => ({ editRegions: [] }),
        replaceCurrentSource: () => true,
        insertContent: (content) => content,
    };
    const mockDocumentPort = {
        document: () => ({}),
        status: () => ({ revision: 1 }),
        mutate: () => true,
    };
    const mockSelectionPrimitives = {
        cloneLiveRange: () => null,
        selectionFor: () => null,
    };

    let capturedInserted = '';
    mockAdapter.insertContent = (source) => {
        capturedInserted = source;
        return true;
    };

    const flowEditor = window.ScriptoriumFlowEditor.createFlowEditor({
        adapter: mockAdapter,
        documentPort: mockDocumentPort,
        selectionPrimitives: mockSelectionPrimitives,
        hybridCompiler: compiler,
    });

    flowEditor.insertStructure('heading-1-center');
    assert.equal(capturedInserted, '<h1 style="text-align: center;">新标题</h1>');

    flowEditor.insertStructure('heading-2-center');
    assert.equal(capturedInserted, '<h2 style="text-align: center;">新标题</h2>');

    flowEditor.insertStructure('heading-3-center');
    assert.equal(capturedInserted, '<h3 style="text-align: center;">新标题</h3>');

    // 兼容 heading-X-center-html
    flowEditor.insertStructure('heading-1-center-html');
    assert.equal(capturedInserted, '<h1 style="text-align: center;">新标题</h1>');

    // 原有的 md 标题继续保持
    flowEditor.insertStructure('heading-1');
    assert.equal(capturedInserted, '# 新标题');
    flowEditor.insertStructure('heading-2');
    assert.equal(capturedInserted, '## 新标题');
    flowEditor.insertStructure('heading-3');
    assert.equal(capturedInserted, '### 新标题');
}

function testDeckEditorStructureHtml() {
    const deckEditorPath = path.resolve(
        __dirname,
        '..',
        'ScriptoriumModules',
        'scriptorium-deck-editor.js'
    );
    const deckEditorSource = fs.readFileSync(deckEditorPath, 'utf8');

    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
        runScripts: 'dangerously',
    });
    const window = dom.window;

    window.CSS = { escape: (s) => s };
    window.ScriptoriumInputSync = {
        createInputSync: () => ({ markInput: () => {}, flush: () => {}, dispose: () => {} }),
    };

    const vdocCorePath = path.resolve(__dirname, '..', 'ScriptoriumModules', 'vdoc-core.js');
    vm.runInContext(fs.readFileSync(vdocCorePath, 'utf8'), dom.getInternalVMContext());
    vm.runInContext(deckEditorSource, dom.getInternalVMContext());

    let insertedHtml = '';
    const mockDeckAdapter = {
        kind: 'deck',
        currentSource: () => '<section class="vdoc-slide-scene"></section>',
        replaceCurrentSource: (source) => {
            insertedHtml = source;
            return true;
        },
    };
    const mockDocumentPort = {
        document: () => ({}),
        status: () => ({ revision: 1 }),
    };
    const mockSelectionPrimitives = {
        selectionFor: () => null,
        cloneLiveRange: () => null,
    };

    const deckEditor = window.ScriptoriumDeckEditor.createDeckEditor({
        adapter: mockDeckAdapter,
        documentPort: mockDocumentPort,
        selectionPrimitives: mockSelectionPrimitives,
        core: window.VDocCore,
    });

    const root = dom.window.document.getElementById('root');
    const scene = dom.window.document.createElement('section');
    scene.className = 'vdoc-slide-scene';
    root.appendChild(scene);
    deckEditor.bindSurface(root);

    deckEditor.insertStructure('heading-1-center');
    assert.match(insertedHtml, /<h1[^>]*style="text-align:\s*center;?"[^>]*>新标题<\/h1>/i);

    deckEditor.insertStructure('heading-2-center');
    assert.match(insertedHtml, /<h2[^>]*style="text-align:\s*center;?"[^>]*>新标题<\/h2>/i);

    deckEditor.insertStructure('heading-3-center');
    assert.match(insertedHtml, /<h3[^>]*style="text-align:\s*center;?"[^>]*>新标题<\/h3>/i);
}

function testHybridCompilerHeadingNavigation() {
    const source = [
        '# Markdown 一级大纲',
        '',
        '这是文档开头的第一段文字。',
        '',
        '<h1 style="text-align: center;">HTML 居中一级标题</h1>',
        '',
        '段落内容一。',
        '',
        '<h2 style="text-align: center;">HTML 居中二级标题</h2>',
        '',
        '段落内容二。',
        '',
        '<h3 style="text-align: center;">HTML 居中三级标题</h3>',
        '',
        '段落内容三。',
        '',
        '## Markdown 二级标题',
        '',
        '正文内容。',
        '',
        '```html',
        '<h1 style="text-align: center;">代码中的伪标题不应进入目录</h1>',
        '```',
        '',
        '这是行内代码 `<h2 style="text-align: center;">行内伪标题</h2>` 也不应进入目录。',
        '',
        '### Markdown 三级标题',
        '',
        '结尾内容。',
    ].join('\n');

    const compiled = compiler.compile(source);
    const headings = compiled.headings;

    assert.equal(headings.length, 6, '应精准解析 6 个真实标题（排除围栏代码和行内代码中的伪标题）');

    assert.deepEqual(
        headings.map((h) => ({ level: h.level, text: h.text })),
        [
            { level: 1, text: 'Markdown 一级大纲' },
            { level: 1, text: 'HTML 居中一级标题' },
            { level: 2, text: 'HTML 居中二级标题' },
            { level: 3, text: 'HTML 居中三级标题' },
            { level: 2, text: 'Markdown 二级标题' },
            { level: 3, text: 'Markdown 三级标题' },
        ],
        '标题导航应严格保留层次 level 与纯文本 text（不带 HTML 标签或 style 属性）'
    );

    headings.forEach((heading, idx) => {
        assert.equal(heading.index, idx);
        assert.equal(heading.kind, 'heading');
        assert.ok(heading.id.startsWith(`heading-${heading.sourceRange.start}-`));
        assert.ok(Number.isInteger(heading.editRegionOrdinal), '每个标题必须携带关联编辑块的 ordinal 供导航跳转定位');
        assert.ok(heading.startLine >= 1);
        assert.ok(heading.endLine >= heading.startLine);
        assert.ok(heading.characterCount > 0);
        assert.ok(heading.contentCharacterCount >= 0);

        // 验证 headingRange 提取出的源码片段确实包含该标题文字
        const headingSnippet = source.slice(heading.headingRange.start, heading.headingRange.end);
        assert.ok(
            headingSnippet.includes(heading.text.split(' ')[0]),
            `源码切片 ${headingSnippet} 应包含标题关键字 ${heading.text.split(' ')[0]}`
        );
    });

    // 验证 HTML 居中一级标题的范围：应该在下一个一级标题之前或到文档结束
    const htmlH1 = headings[1];
    assert.equal(htmlH1.level, 1);
    assert.equal(htmlH1.text, 'HTML 居中一级标题');
    const htmlH1Slice = source.slice(htmlH1.sourceRange.start, htmlH1.sourceRange.end);
    assert.ok(htmlH1Slice.includes('HTML 居中二级标题'), '一级标题章节范围应涵盖下属二级标题');
}

function runAll() {
    testHtmlSelectOptions();
    testFlowEditorStructureSource();
    testDeckEditorStructureHtml();
    testHybridCompilerHeadingNavigation();
    console.log('[ScriptoriumHtmlCenterHeading] All tests passed successfully.');
}

runAll();