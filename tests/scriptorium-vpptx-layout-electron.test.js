'use strict';

// Run: node --test tests/scriptorium-vpptx-layout-electron.test.js
// This validates local Chromium HTML layout, not PowerPoint/OOXML line-breaking rules.
if (require('./helpers/electron-test-entry.cjs').runFromNode(__filename)) return;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app, BrowserWindow } = require('electron');
const projectRoot = path.resolve(__dirname, '..');
const outputPath = path.join(projectRoot, 'artifacts', 'vpptx-enter-stress-20261115', 'layout-results.json');
const moduleNames = ['vdoc-core.js', 'scriptorium-document-store.js', 'scriptorium-deck-adapter.js'];
const CYCLES = 10;
const cases = [];
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stacks = [
    'Arial, "Microsoft YaHei", sans-serif',
    '"Times New Roman", SimSun, serif',
];
function add(category, name, html, options = {}) {
    cases.push({ id: `${category}/${name}`, category, html, width: 180, fontFamily: stacks[0], ...options });
}

const mixed = [
    '中文 Latin 2026：你好，world！比例99.5%。',
    '日本語・English 123「混在する文章」を検証。',
    '한국어 Latin 123 中文 punctuation，끝。',
    '中文 e\u0301 a\u0308\u0323 English \u2067עברית العربية\u2069 2026',
];
for (const [index, value] of mixed.entries()) for (const [font, fontFamily] of stacks.entries()) {
    for (const width of [125, 245]) add('mixed', `${index}/font-${font}/${width}`, escape(value), { fontFamily, width });
}
const kinsoku = ['「先頭禁則」、句読点。小書きゃゅょっ！？終わり。',
    '（中文开括号）《标点》、，。：；！？末尾', '前文——中点・連続……「次の句」、終。'];
for (const [index, value] of kinsoku.entries()) for (const lineBreak of ['normal', 'strict']) {
    for (const width of [90, 145]) add('kinsoku', `${index}/${lineBreak}/${width}`, escape(value),
        { width, css: `line-break:${lineBreak};word-break:normal;overflow-wrap:normal;`, lang: index === 1 ? 'zh-CN' : 'ja' });
}
const thresholds = ['中文 Latin 123 临界宽度尾', 'Alpha Beta Gamma Delta', '「混排」ABC・123 終',
    '汉字<strong>粗体</strong> <em>Italic</em> End 尾'];
for (const [index, html] of thresholds.entries()) for (const [font, fontFamily] of stacks.entries()) {
    for (const ratio of [0.995, 1, 1.005]) add('threshold', `${index}/font-${font}/${ratio}`, html,
        { fontFamily, ratio, thresholdGroup: `${index}/font-${font}` });
}
const spaces = ['A<br><br><br>B<br>', '  Alpha  \tBeta\n\n  Gamma  ',
    'A&nbsp;&nbsp;B &#10;&#9; C\nD', '<strong>A<br><br>B</strong>  <em>C\n\nD</em>'];
for (const [index, html] of spaces.entries()) for (const whiteSpace of ['normal', 'pre-wrap', 'break-spaces']) {
    add('explicit-whitespace', `${index}/${whiteSpace}`, html, { width: 130, css: `white-space:${whiteSpace};` });
}
const styled = ['基线<span style="font-size:36px">大字</span><span style="font-size:12px">小字</span>End',
    '中文<strong>Bold 粗体</strong><em> Italic 斜体</em> tail',
    '公式 H<sub>2</sub>O + x<sup>2</sup> = y<sup>n+1</sup> 中文',
    '<strong><em><span style="font-size:28px;color:rgb(20,70,110)">嵌套 Large</span></em></strong> e\u0301'];
for (const [index, html] of styled.entries()) for (const width of [120, 230]) {
    add('inline-styles', `${index}/${width}`, html, { width });
}
const emoji = ['ABC 👩🏽‍💻 中文 👨‍👩‍👧‍👦 END', '🇨🇳🇺🇳 1️⃣ 2️⃣ 🏳️‍🌈 尾', 'e\u0301 a\u0308\u0323 🙂☀️✈️ 中文'];
const emojiStacks = ['Arial, "Segoe UI Emoji", "Microsoft YaHei", sans-serif',
    '"VPPTX Deliberately Missing Font", "Segoe UI Emoji", "Times New Roman", serif'];
for (const [index, value] of emoji.entries()) for (const [font, fontFamily] of emojiStacks.entries()) {
    for (const width of [100, 225]) add('emoji-fallback', `${index}/font-${font}/${width}`, escape(value), { width, fontFamily });
}
const longTokens = ['https://example.invalid/verylongunbrokenpathsegment0123456789abcdef?query=abcdefghijklmnopqrstuvwxyz',
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'];
const wrapping = { normal: 'overflow-wrap:normal;word-break:normal;',
    anywhere: 'overflow-wrap:anywhere;word-break:normal;', 'break-all': 'overflow-wrap:normal;word-break:break-all;' };
for (const [index, value] of longTokens.entries()) for (const [policy, css] of Object.entries(wrapping)) {
    for (const width of [18, 40]) add('narrow-token', `${index}/${policy}/${width}`, escape(value), { width, css, policy });
}
for (const mode of ['fixed-height', 'auto-height', 'clamp-font-size']) for (const width of [100, 240]) {
    for (const [index, html] of ['自动高度 中文 Mixed words repeated repeated repeated 尾',
        'Line one<br><br>Line three 👩🏽‍💻<br>Final line'].entries()) {
        const css = mode === 'auto-height' ? 'height:auto;'
            : `height:76px;overflow:hidden;${mode === 'clamp-font-size' ? 'font-size:clamp(12px,10cqw,28px);' : ''}`;
        add('css-sizing', `${mode}/${width}/${index}`, html, { width, css, sizingMode: mode });
    }
}
assert.equal(cases.length, 108);

const report = { schema: 1, startedAt: new Date().toISOString(), environment: {
    platform: process.platform, arch: process.arch, versions: process.versions,
}, moduleSha256: {}, scope: {
    engine: 'Local Electron Chromium HTML/CSS', cyclesPerCase: CYCLES,
    semanticOracle: 'Original input rendered before any VDocCore call',
    geometryOracle: 'Per-grapheme native Range.getClientRects, relative to original target box',
    geometryPrecision: '0.001 CSS pixels; no character-width estimates',
    lineGrouping: 'Connected vertical bands of native grapheme and BR rectangles; full rectangles compared in memory',
    limitations: [
        'Only fonts installed on this machine are exercised; no cross-OS font equivalence claim.',
        'CSS line-break normal/strict results are Chromium behavior, not PowerPoint kinsoku conformance.',
        'CSS fixed/auto height and clamp font size test HTML persistence; they do not implement OOXML autoFit.',
        'PPTX import property support, including autoFit, is diagnosed separately by the parent task.',
    ],
}, cases: [] };

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: {
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    const evaluate = (fn, value) => win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value) ?? 'undefined'})`);
    let fatal;
    let debuggerAttached = false;
    try {
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#original,#production{position:absolute;left:20px;top:20px}</style></head><body><div id="original"></div><div id="production"></div></body></html>'
        ));
        for (const name of moduleNames) {
            const source = fs.readFileSync(path.join(projectRoot, 'ScriptoriumModules', name), 'utf8');
            report.moduleSha256[name] = createHash('sha256').update(source).digest('hex');
            await win.webContents.executeJavaScript(source);
        }
        await evaluate(() => {
            const editorAttributes = new Set(['data-vdoc-text', 'data-vdoc-block', 'data-vdoc-removable',
                'data-vdoc-container', 'data-vdoc-preserve']);
            const round = value => Math.round(value * 1000) / 1000;
            const semantic = node => {
                if (node.nodeType === Node.TEXT_NODE) return { text: node.nodeValue };
                const children = [];
                for (const child of node.childNodes) {
                    if (child.nodeType !== Node.TEXT_NODE && child.nodeType !== Node.ELEMENT_NODE) continue;
                    const value = semantic(child);
                    if ('text' in value && children.at(-1) && 'text' in children.at(-1)) children.at(-1).text += value.text;
                    else children.push(value);
                }
                return { tag: node.tagName, attrs: Object.fromEntries([...node.attributes]
                    .filter(attr => !editorAttributes.has(attr.name)).map(attr => [attr.name, attr.value])
                    .sort(([a], [b]) => a.localeCompare(b))), children };
            };
            const styleRecord = node => {
                const style = getComputedStyle(node);
                return Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
                    'verticalAlign', 'whiteSpace', 'lineBreak', 'wordBreak', 'overflowWrap', 'direction', 'writingMode']
                    .map(key => [key, style[key]]));
            };
            const snapshot = target => {
                const rect = target.getBoundingClientRect();
                const style = getComputedStyle(target);
                const rectData = item => ({ x: round(item.x - rect.x), y: round(item.y - rect.y),
                    width: round(item.width), height: round(item.height) });
                const glyphs = [];
                const segmenter = new Intl.Segmenter(target.lang || 'zh-CN', { granularity: 'grapheme' });
                const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                    const font = styleRecord(node.parentElement);
                    for (const { segment, index } of segmenter.segment(node.data)) {
                        const range = document.createRange();
                        range.setStart(node, index); range.setEnd(node, index + segment.length);
                        glyphs.push({ text: segment, font, rects: [...range.getClientRects()].map(rectData) });
                    }
                }
                const breaks = [...target.querySelectorAll('br')].map(node => {
                    const range = document.createRange(); range.selectNode(node);
                    return [...range.getClientRects()].map(rectData);
                });
                const items = glyphs.flatMap((glyph, index) => glyph.rects.filter(item => item.height > 0)
                    .map(item => ({ ...item, index }))).concat(breaks.flat().map(item => ({ ...item, index: null })))
                    .filter(item => item.height > 0).sort((a, b) => a.y - b.y);
                const lines = [];
                for (const item of items) {
                    let line = lines.at(-1);
                    if (!line || item.y >= line.bottom - 0.01) {
                        line = { top: item.y, bottom: round(item.y + item.height), indices: [] }; lines.push(line);
                    } else line.bottom = Math.max(line.bottom, round(item.y + item.height));
                    if (item.index !== null && !line.indices.includes(item.index)) line.indices.push(item.index);
                }
                lines.forEach(line => { line.indices.sort((a, b) => a - b); line.text = line.indices.map(index => glyphs[index].text).join(''); });
                const contentWidth = rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
                    - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
                const ink = items.filter(item => item.width > 0.01);
                const minX = ink.length ? Math.min(...ink.map(item => item.x)) : 0;
                const maxX = ink.length ? Math.max(...ink.map(item => item.x + item.width)) : 0;
                const contentLeft = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
                const contentRight = contentLeft + contentWidth;
                return { semantic: { tree: semantic(target), textContent: target.textContent, innerText: target.innerText,
                    breakCount: breaks.length }, layout: {
                    box: { width: round(rect.width), height: round(rect.height), contentWidth: round(contentWidth),
                        clientWidth: target.clientWidth, clientHeight: target.clientHeight,
                        scrollWidth: target.scrollWidth, scrollHeight: target.scrollHeight },
                    style: styleRecord(target), glyphs, breaks, lines, lineCount: lines.length,
                    overflowX: minX < contentLeft - 0.1 || maxX > contentRight + 0.1,
                    overflowY: target.scrollHeight > target.clientHeight,
                    paintedBounds: { minX: round(minX), maxX: round(maxX), contentLeft, contentRight: round(contentRight) },
                } };
            };
            window.layoutCase = async (sample, cycles) => {
                const original = document.getElementById('original');
                const production = document.getElementById('production');
                original.replaceChildren(); production.replaceChildren();
                const target = document.createElement('p');
                target.dataset.probe = sample.id;
                target.lang = sample.lang || 'zh-CN';
                target.style.cssText = `margin:0;box-sizing:border-box;padding:7px;border:1px solid black;font-family:${sample.fontFamily};font-size:22px;line-height:1.6;white-space:normal;${sample.css || ''}`;
                target.innerHTML = sample.html;
                const section = document.createElement('section');
                section.className = 'vdoc-slide-scene';
                section.style.cssText = `container-type:inline-size;width:${sample.width + 16}px;`;
                original.appendChild(section); section.appendChild(target);
                await document.fonts.ready;
                const probe = target.cloneNode(true);
                probe.removeAttribute('data-probe');
                probe.style.cssText += ';display:inline-block;width:max-content;min-width:0;max-width:none;height:auto;max-height:none;white-space:nowrap;overflow:visible;';
                section.appendChild(probe);
                const probeStyle = getComputedStyle(probe);
                const measured = probe.getBoundingClientRect().width - parseFloat(probeStyle.paddingLeft)
                    - parseFloat(probeStyle.paddingRight) - parseFloat(probeStyle.borderLeftWidth) - parseFloat(probeStyle.borderRightWidth);
                probe.remove();
                const contentWidth = sample.ratio ? measured / sample.ratio : sample.width;
                target.style.width = `${contentWidth + 16}px`;
                section.style.width = `${contentWidth + 16}px`;
                await document.fonts.ready;
                const originalSource = section.outerHTML;
                const constructed = snapshot(target);
                // CSSOM serialization may round subpixels before core sees the HTML.
                // Compare raw HTML against production HTML, with no production call
                // involved in this independent parse. Preserve the construction delta.
                original.innerHTML = originalSource;
                await document.fonts.ready;
                const baseline = snapshot(original.querySelector('[data-probe]'));
                const cssomSerialization = {
                    geometryChanged: JSON.stringify(constructed.layout) !== JSON.stringify(baseline.layout),
                    constructedBox: constructed.layout.box, rawHtmlBox: baseline.layout.box,
                    constructedLineCount: constructed.layout.lineCount, rawHtmlLineCount: baseline.layout.lineCount,
                };
                const violations = [];
                const observations = [];
                let final;
                const compare = (stage, source) => {
                    production.innerHTML = source;
                    const rendered = production.querySelector('[data-probe]');
                    if (!rendered || production.querySelectorAll('[data-probe]').length !== 1) throw new Error(`${stage}: payload missing or duplicated`);
                    const current = snapshot(rendered);
                    const semanticEqual = JSON.stringify(current.semantic) === JSON.stringify(baseline.semantic);
                    const layoutEqual = JSON.stringify(current.layout) === JSON.stringify(baseline.layout);
                    observations.push({ stage, semanticEqual, layoutEqual, lineCount: current.layout.lineCount,
                        box: current.layout.box, overflowX: current.layout.overflowX, overflowY: current.layout.overflowY });
                    if (!semanticEqual || !layoutEqual) violations.push({ stage, semanticEqual, layoutEqual,
                        actual: violations.length < 2 ? current : undefined });
                    final = current;
                };
                const core = window.VDocCore;
                const model = core.createDocument({ kind: core.PROJECT_KINDS.SLIDE_DECK,
                    slides: [{ id: 'layout-slide', source: originalSource }] });
                const store = window.ScriptoriumDocumentStore.createDocumentStore({ core });
                const adapter = window.ScriptoriumDeckAdapter.createDeckAdapter({ core, documentPort: store });
                try {
                    compare('core.createDocument', model.source.slides[0].source);
                    store.replaceDocument(model);
                    compare('document-store.replaceDocument', adapter.currentSource());
                    compare('deck-adapter.parsedSlide', adapter.parsedSlide().html);
                    const canonicalSource = adapter.currentSource();
                    let stableSource = true;
                    for (let cycle = 1; cycle <= cycles; cycle += 1) {
                        store.replaceDocument(core.parse(store.serialize()));
                        stableSource &&= adapter.currentSource() === canonicalSource;
                        compare(`save/parse/read ${cycle}`, adapter.parsedSlide().html);
                    }
                    return { id: sample.id, category: sample.category, options: sample,
                        passed: violations.length === 0 && stableSource,
                        originalSource, finalSource: adapter.currentSource(), stableSource,
                        fontReady: document.fonts.status, nowrapMeasuredWidth: measured,
                        requestedContentWidth: contentWidth, actualUtilization: measured / baseline.layout.box.contentWidth,
                        baseline, final, observations, violations, cssomSerialization };
                } finally { adapter.dispose(); store.dispose(); }
            };
            window.layoutEnvironment = { userAgent: navigator.userAgent, devicePixelRatio,
                viewport: { width: innerWidth, height: innerHeight }, fontStatus: document.fonts.status,
                cssSupport: { strictLineBreak: CSS.supports('line-break', 'strict'),
                    overflowAnywhere: CSS.supports('overflow-wrap', 'anywhere'),
                    containerUnits: CSS.supports('font-size', '10cqw'),
                    clamp: CSS.supports('font-size', 'clamp(12px,10cqw,28px)') } };
        });
        report.environment.renderer = await evaluate(() => window.layoutEnvironment);
        win.webContents.debugger.attach('1.3'); debuggerAttached = true;
        await win.webContents.debugger.sendCommand('DOM.enable');
        await win.webContents.debugger.sendCommand('CSS.enable');
        const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
        const platformFonts = async selector => {
            const { nodeIds } = await win.webContents.debugger.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId,
                selector: `${selector} [data-probe], ${selector} [data-probe] *` });
            const merged = new Map();
            for (const nodeId of nodeIds) {
                const { fonts } = await win.webContents.debugger.sendCommand('CSS.getPlatformFontsForNode', { nodeId });
                for (const font of fonts) {
                    const key = `${font.familyName}/${font.postScriptName}/${font.isCustomFont}`;
                    const existing = merged.get(key);
                    if (existing) existing.glyphCount += font.glyphCount;
                    else merged.set(key, { ...font });
                }
            }
            return [...merged.values()].sort((a, b) => a.familyName.localeCompare(b.familyName)
                || a.postScriptName.localeCompare(b.postScriptName));
        };
        for (const sample of cases) {
            const started = performance.now();
            try {
                const result = await evaluate(({ sample, cycles }) => window.layoutCase(sample, cycles), { sample, cycles: CYCLES });
                result.platformFonts = { original: await platformFonts('#original'), final: await platformFonts('#production') };
                result.platformFontsStable = JSON.stringify(result.platformFonts.original) === JSON.stringify(result.platformFonts.final);
                result.passed &&= result.platformFontsStable;
                result.elapsedMs = Math.round(performance.now() - started);
                report.cases.push(result);
            } catch (error) {
                report.cases.push({ id: sample.id, category: sample.category, passed: false, error: error.stack });
            }
        }
    } catch (error) { fatal = error; report.fatal = error.stack; }
    finally {
        if (debuggerAttached) win.webContents.debugger.detach();
        win.destroy();
    }
    const groups = {};
    for (const result of report.cases.filter(item => item.category === 'threshold' && item.baseline)) {
        (groups[result.options.thresholdGroup] ||= []).push({ ratio: result.options.ratio,
            measured: result.nowrapMeasuredWidth, requestedContentWidth: result.requestedContentWidth,
            actualContentWidth: result.baseline.layout.box.contentWidth, actualUtilization: result.actualUtilization,
            lineCount: result.baseline.layout.lineCount, overflowX: result.baseline.layout.overflowX });
    }
    report.thresholdGroups = Object.entries(groups).map(([id, values]) => ({ id, values,
        crossedBoundary: new Set(values.map(value => value.lineCount)).size > 1 }));
    report.summary = { cases: report.cases.length, passed: report.cases.filter(item => item.passed).length,
        failed: report.cases.filter(item => !item.passed).length, cyclesPerCase: CYCLES,
        completedSaveParseReadCycles: report.cases.filter(item => item.observations?.length === CYCLES + 3).length * CYCLES,
        originalSemanticComparisons: report.cases.reduce((sum, item) => sum + (item.observations?.length || 0), 0),
        originalLayoutComparisons: report.cases.reduce((sum, item) => sum + (item.observations?.length || 0), 0),
        categories: Object.fromEntries([...new Set(cases.map(item => item.category))].map(category => {
            const matches = report.cases.filter(item => item.category === category);
            return [category, { cases: matches.length, passed: matches.filter(item => item.passed).length,
                originalLineCounts: [...new Set(matches.flatMap(item => item.baseline ? [item.baseline.layout.lineCount] : []))].sort((a, b) => a - b) }];
        })),
        thresholdGroups: report.thresholdGroups.length,
        thresholdGroupsCrossed: report.thresholdGroups.filter(item => item.crossedBoundary).length,
        cssomSerializationGeometryChanges: report.cases.filter(item => item.cssomSerialization?.geometryChanged).length,
        platformFontFamilies: [...new Set(report.cases.flatMap(item => item.platformFonts?.original.map(font => font.familyName) || []))],
    };
    report.finishedAt = new Date().toISOString();
    console.log('[VPPTXLayout] ' + JSON.stringify(report.summary));
    const summarizeSnapshot = value => value && ({
        textContent: value.semantic.textContent, innerText: value.semantic.innerText,
        breakCount: value.semantic.breakCount, box: value.layout.box, style: value.layout.style,
        lineCount: value.layout.lineCount, lines: value.layout.lines.map(({ top, bottom, text }) => ({ top, bottom, text })),
        overflowX: value.layout.overflowX, overflowY: value.layout.overflowY,
        paintedBounds: value.layout.paintedBounds, graphemes: value.layout.glyphs.length,
        fonts: [...new Map(value.layout.glyphs.map(item => [JSON.stringify(item.font), item.font])).values()],
    });
    const artifact = { ...report, cases: report.cases.map(result => {
        const witnesses = (result.violations || []).filter(item => item.actual).slice(0, 2).map(item => {
            const index = item.actual.layout.glyphs.findIndex((glyph, i) =>
                JSON.stringify(glyph) !== JSON.stringify(result.baseline.layout.glyphs[i]));
            return { stage: item.stage, semanticEqual: item.semanticEqual, layoutEqual: item.layoutEqual,
                actual: summarizeSnapshot(item.actual), firstDifferentGlyph: index < 0 ? null : {
                    index, expected: result.baseline.layout.glyphs[index], actual: item.actual.layout.glyphs[index] } };
        });
        return { id: result.id, category: result.category, options: result.options, passed: result.passed,
            elapsedMs: result.elapsedMs, error: result.error, stableSource: result.stableSource,
            cssomSerialization: result.cssomSerialization,
            fontReady: result.fontReady, nowrapMeasuredWidth: result.nowrapMeasuredWidth,
            requestedContentWidth: result.requestedContentWidth, actualUtilization: result.actualUtilization,
            baseline: summarizeSnapshot(result.baseline), final: result.passed ? { sameAs: 'baseline' } : summarizeSnapshot(result.final),
            comparisons: result.observations?.map(({ stage, semanticEqual, layoutEqual, lineCount }) =>
                ({ stage, semanticEqual, layoutEqual, lineCount })),
            violationCount: result.violations?.length, witnesses, platformFonts: result.platformFonts,
            platformFontsStable: result.platformFontsStable,
            ...(result.violations?.length ? { originalSource: result.originalSource, finalSource: result.finalSource } : {}),
        };
    }) };
    const serialized = JSON.stringify(artifact) + '\n';
    assert.ok(Buffer.byteLength(serialized) <= 1024 * 1024, 'Evidence must remain below one MiB');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized);
    console.log('[VPPTXLayout] evidence=' + outputPath);
    try {
        if (fatal) throw fatal;
        assert.equal(report.summary.cases, 108);
        assert.equal(report.summary.failed, 0, JSON.stringify(report.cases.filter(item => !item.passed)
            .map(item => ({ id: item.id, error: item.error, stableSource: item.stableSource,
                platformFontsStable: item.platformFontsStable, violations: item.violations?.map(value => ({ stage: value.stage,
                    semanticEqual: value.semanticEqual, layoutEqual: value.layoutEqual })) }))));
        assert.equal(report.summary.thresholdGroups, 8);
        assert.ok(report.summary.thresholdGroupsCrossed > 0, 'The measured width matrix never crossed an actual line boundary');
        assert.ok(report.cases.every(item => item.fontReady === 'loaded'), 'Font loading must settle before measurement');
        app.quit();
    } catch (error) { console.error(error.stack); app.exit(1); }
}).catch(error => { console.error(error.stack); app.exit(1); });
