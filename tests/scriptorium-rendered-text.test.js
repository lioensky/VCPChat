'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function loadRenderedTextModule() {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://scriptorium.local/',
    });
    const source = fs.readFileSync(
        path.join(
            __dirname,
            '..',
            'ScriptoriumModules',
            'scriptorium-rendered-text.js'
        ),
        'utf8'
    );
    const context = vm.createContext({
        console,
        window: dom.window,
        document: dom.window.document,
        Node: dom.window.Node,
        NodeFilter: dom.window.NodeFilter,
        MutationObserver: dom.window.MutationObserver,
        AbortController: dom.window.AbortController,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    });
    vm.runInContext(source, context, {
        filename: 'scriptorium-rendered-text.js',
    });
    return context.window.ScriptoriumRenderedText;
}

test('island sequence mapping disambiguates short JS-injected text', () => {
    const renderedText = loadRenderedTextModule();
    const islandSource = `
<div data-vdoc-island="three-dimensional-text-card">
    <style>
        .three-d-title { transform: translateZ(72px); }
        .three-d-cube { animation: spin 10s linear infinite; }
    </style>
    <div class="three-d-title">文字也可以拥有空间</div>
    <p class="three-d-copy">移动鼠标观察景深</p>
    <div class="cube-front"></div>
    <div class="cube-back"></div>
    <script>
    (() => {
        const cubeTexts = [
            ['cube-front', '文字'],
            ['cube-back', '空间'],
            ['cube-right', '旋转'],
            ['cube-left', '注入'],
            ['cube-top', 'CSS 3D'],
            ['cube-bottom', 'JS TEXT']
        ];
        cubeTexts.forEach(([faceClass, text]) => {
            const face = document.querySelector('.' + faceClass);
            if (face) face.textContent = text;
        });
    })();
    </script>
</div>`;

    const visibleTexts = [
        '文字也可以拥有空间',
        '移动鼠标观察景深',
        '文字',
        '空间',
        '旋转',
        '注入',
        'CSS 3D',
        'JS TEXT',
    ];
    const targetOrdinal = visibleTexts.indexOf('文字');
    const range = renderedText.sequenceSourceRange(
        islandSource,
        {
            text: '文字',
            ordinal: targetOrdinal,
            sameTextOrdinal: 0,
            previousText: visibleTexts[targetOrdinal - 1],
            nextText: visibleTexts[targetOrdinal + 1],
        },
        { textNodeCount: visibleTexts.length }
    );

    assert.ok(range, 'the injected short text must be mapped');
    assert.equal(range.reason, 'island-text-sequence');
    assert.equal(islandSource.slice(range.start, range.end), '文字');

    const titleOffset = islandSource.indexOf('文字也可以拥有空间');
    const scriptFieldOffset = islandSource.indexOf(
        "'文字'",
        islandSource.indexOf('const cubeTexts')
    ) + 1;
    assert.notEqual(range.start, titleOffset);
    assert.equal(range.start, scriptFieldOffset);
});

test('source field extraction preserves offsets after style blocks', () => {
    const renderedText = loadRenderedTextModule();
    const islandSource = [
        '<div data-vdoc-island="offset-test">',
        '<style>.label::after { content: "not visible"; }</style>',
        '<div>静态锚点</div>',
        '<script>const labels = ["动态文字", "后续锚点"];</script>',
        '</div>',
    ].join('\n');

    const fields = renderedText.sourceTextFields(islandSource);
    const dynamicField = fields.find((field) => field.text === '动态文字');

    assert.ok(dynamicField);
    assert.equal(
        islandSource.slice(
            dynamicField.start,
            dynamicField.start + dynamicField.text.length
        ),
        '动态文字'
    );
});