import test from 'node:test';
import assert from 'node:assert/strict';
import { createVcpSourceIndex } from '../modules/renderer/vcpDocumentScanner.js';
import { createVcpParseContext, createVcpPlaceholderRegistry } from '../modules/renderer/vcpParseContext.js';
import { createContentPipeline, PIPELINE_MODES } from '../modules/renderer/contentPipeline.js';
import { collectMarkdownCodeDomains } from '../modules/renderer/markdownCodeDomainScanner.js';
import { collectToolDataRanges, collectToolResultRanges, collectCodeDomainsOutsideToolResults } from '../modules/renderer/toolResultRegions.js';
import { replaceToolRequestBlocks } from '../modules/renderer/toolRequestScanner.js';

const receipt = body => `[[VCP调用结果信息汇总:\n${body}\nVCP调用结果结束]]`;
const request = body => `<<<[TOOL_REQUEST]>>>text:「始ESCAPE」${body}「末ESCAPE」<<<[END_TOOL_REQUEST]>>>`;

test('source index is lazy, frozen and shares tool primitives with document consumers', () => {
    const events = [];
    const source = receipt('`opaque`') + '\n![image](old.png)\n<style>.real{}</style>';
    const index = createVcpSourceIndex(source, { onWork: event => events.push(event) });
    assert.equal(events.length, 0);
    const tools = index.toolResults();
    assert.strictEqual(index.toolData(), tools);
    assert.ok(!events.some(event => event.operation.startsWith('code')));
    const regions = index.regions();
    assert.strictEqual(index.regions(), regions);
    assert.strictEqual(index.ofKind('style'), index.ofKind('style'));
    assert.equal(index.ofKind('style').length, 1);
    assert.equal(events.filter(event => event.operation === 'tool-data' && !event.reused).length, 1);
    assert.ok(Object.isFrozen(regions) && Object.isFrozen(regions[0]));
    assert.throws(() => { regions[0].start = 10; }, TypeError);
});

test('exact revisions and shorter source rebuild instead of applying stale positions', () => {
    const context = createVcpParseContext('');
    const first = context.index('<style>a</style>');
    assert.strictEqual(context.index(first.source), first);
    const revised = context.index('<style>b</style>');
    assert.notStrictEqual(revised, first);
    assert.notStrictEqual(context.index('x'), revised);
    assert.deepEqual(context.index('x').regions().map(region => region.kind), ['markdown']);
    assert.equal(context.getDiagnostics().invalidations, 2);
    assert.deepEqual(context.getDiagnostics().invalidationReasons, {
        sameLengthSourceChanged: 1, sourceLengthChanged: 1,
    });
    context.release();
    assert.equal(context.getDiagnostics().retainedSourceChars, 0);
    assert.notStrictEqual(context.index(first.source), first);
});

test('explicit code policies match legacy scanners at every input split', () => {
    const source = '`multiline\nspan`\n' + request('<<<[END_TOOL_REQUEST]>>> `data`')
        + '\n' + receipt('~~~\n`payload`') + '\n~~~js\nx\n~~~\n`tail';
    for (let end = 0; end <= source.length; end++) {
        const text = source.slice(0, end);
        const tools = collectToolDataRanges(text);
        for (const mode of ['stream', 'final']) {
            const index = createVcpSourceIndex(text, { mode });
            assert.deepEqual(index.codes('document'), collectCodeDomainsOutsideToolResults(text, tools, {
                includeUnclosedInline: mode === 'stream',
            }));
            assert.deepEqual(index.codes('markdown'), collectMarkdownCodeDomains(text));
            assert.deepEqual(index.codes('protocol'), collectCodeDomainsOutsideToolResults(text, tools)
                .filter(range => range.kind === 'fence' || !text.slice(range.start, range.end).includes('\n')));
        }
    }
});

test('document and protocol code policies retain their intentional multiline difference', () => {
    const source = '`line\n' + request('payload') + '\nend`';
    const index = createVcpSourceIndex(source);
    assert.equal(index.codes('document').length, 1);
    assert.equal(index.codes('protocol').length, 0);
    assert.throws(() => index.codes('unknown'), TypeError);
    assert.throws(() => createVcpSourceIndex(source, { mode: 'unknown' }), TypeError);
    assert.notDeepEqual(createVcpSourceIndex('`tail', { mode: 'stream' }).regions(),
        createVcpSourceIndex('`tail').regions());
});

test('atomic outer domains and inner receipt queries preserve distinct semantics', () => {
    const source = '<!-- unfinished\n<<<[VCP_TOOL_BATCH_START:a]>>>\n'
        + receipt('data') + '\n[[VCP调用结果信息汇总:\nunclosed\n'
        + '<<<[VCP_TOOL_BATCH_END:a]>>>\n<style>.after{}</style>';
    const index = createVcpSourceIndex(source);
    assert.deepEqual(index.toolData(), collectToolDataRanges(source));
    assert.deepEqual(index.toolResults(), collectToolResultRanges(source));
    assert.equal(index.toolData()[0].batchId, 'a');
    assert.equal(index.toolResults().length, 2);
    assert.equal(index.ofKind('style').length, 1);
});

test('indexed request replacements match the legacy path including malformed fields and boundary whitespace', () => {
    const samples = [
        'prefix' + request('<<<[END_TOOL_REQUEST]>>>') + 'suffix',
        '`line\n' + request('x') + '\nend`',
        '~~~\n' + request('literal') + '\n~~~\n' + request('real'),
        receipt(request('opaque')) + '\n' + request('real'),
        '<!-- ' + request('legacy-comment-policy') + ' -->',
        '<<<[TOOL_REQUEST]>>>text:「始」missing field close<<<[END_TOOL_REQUEST]>>>',
    ];
    for (const source of samples) {
        for (let end = 1; end <= source.length; end++) {
            const text = source.slice(0, end);
            const replace = (_match, content) => `[${content}]`;
            assert.equal(replaceToolRequestBlocks(text, replace, { sourceIndex: createVcpSourceIndex(text) }),
                replaceToolRequestBlocks(text, replace));
        }
    }
    assert.throws(() => replaceToolRequestBlocks(request('a'), () => '', {
        sourceIndex: createVcpSourceIndex(request('b')),
    }), /different source version/);
});

test('registration avoids all same-shaped source tokens including opaque payload literals', () => {
    const tokens = {
        thought: '<!--VCP_THOUGHT_CHAIN_0-->',
        result: '<!--VCP_TOOL_RESULT_0-->',
        request: '<!--VCP_TOOL_REQUEST_0-->',
        script: '<!--VCP_RAW_SCRIPT_0-->',
        code: '__VCP_CODE_BLOCK_PLACEHOLDER_0__',
    };
    const source = receipt(Object.values(tokens).join('\n'));
    const registry = createVcpPlaceholderRegistry(source);
    for (const [kind, literal] of Object.entries(tokens)) {
        const token = registry.register(kind, `value:${kind}`);
        assert.notEqual(token, literal);
        assert.equal(registry.replace(literal + token, kind), literal + `value:${kind}`);
        assert.equal(registry.references(literal, kind).length, 0);
    }
});

test('reference recognition shares one text scan, invalidates edits and new registration', () => {
    const registry = createVcpPlaceholderRegistry('');
    const code = registry.register('code', 'code');
    const result = registry.register('result', 'result');
    const text = code + result;
    assert.equal(registry.references(text, 'code')[0].start, 0);
    assert.equal(registry.references(text, 'result')[0].start, code.length);
    assert.equal(registry.getDiagnostics().scans, 1);
    assert.equal(registry.getDiagnostics().hits, 1);
    registry.references('x' + text.slice(1), 'code');
    assert.equal(registry.getDiagnostics().scans, 2);
    const future = '<!--VCP_RAW_SCRIPT_0-->';
    assert.equal(registry.references(future, 'script').length, 0);
    assert.equal(registry.register('script', 'script'), future);
    assert.equal(registry.references(future, 'script').length, 1);
    registry.releaseReferences();
    assert.equal(registry.getDiagnostics().retainedReferenceChars, 0);
});

test('replacement snapshots never recursively recognize restored payloads', () => {
    const registry = createVcpPlaceholderRegistry('');
    const first = registry.register('code', '__VCP_CODE_BLOCK_PLACEHOLDER_1__');
    registry.register('code', 'must-not-expand-recursively');
    assert.equal(registry.replace(first, 'code'), '__VCP_CODE_BLOCK_PLACEHOLDER_1__');
    const script = registry.register('script', 'const value = `literal`;');
    const result = registry.register('result', 'opaque');
    const html = `<p> \n${result}\n </p>${script}<p>${result} prose</p>`;
    assert.equal(registry.replace(html, 'result', () => '<div>card</div>', { unwrapParagraph: true }),
        `<div>card</div>${script}<p><div>card</div> prose</p>`);
});

test('pipeline demonstrably shares one tool-data scan across unchanged consumers and releases source indexes', () => {
    const pipeline = createContentPipeline({ getToolResultRegex: () => /unused/g });
    const source = 'persona_literal ![image](old.png)\n<!-- ordinary -->\n' + receipt('opaque');
    const result = pipeline.process(source);
    const diagnostics = result.meta.recognition;
    assert.equal(diagnostics.operations['tool-data'].scans, 1);
    assert.ok(diagnostics.operations['tool-data'].hits >= 2);
    assert.equal(diagnostics.operations['tool-data'].inputChars, source.length);
    assert.equal(diagnostics.retainedSourceChars, 0);
    assert.equal(diagnostics.placeholders.retainedReferenceChars, 0);
    assert.equal(diagnostics.placeholders.reservationInputChars, source.length);
    assert.equal(result.state.toolResultMap.values().next().value, receipt('opaque'));
});

test('pipeline preserves literal source tokens while protecting real code, requests, thoughts and scripts', () => {
    const literal = '__VCP_CODE_BLOCK_PLACEHOLDER_0__ <!--VCP_TOOL_REQUEST_0--> '
        + '<!--VCP_TOOL_RESULT_0--> <!--VCP_THOUGHT_CHAIN_0--> <!--VCP_RAW_SCRIPT_0-->';
    const pipeline = createContentPipeline({
        getToolResultRegex: () => /unused/g,
        replaceToolRequestBlocks,
        transformSpecialBlocks(text, _codes, _thoughts, _requests, placeholders) {
            return placeholders.replace(text, 'thought');
        },
    });
    const source = literal + '\n\n`code`\n\n' + request(literal)
        + '\n' + receipt(literal) + '\n<think>\nprivate\n</think>\n'
        + '<script>const s = `template`; const literal = "<!--VCP_RAW_SCRIPT_0-->";</script>';
    const result = pipeline.process(source);
    assert.ok(result.text.startsWith(literal));
    assert.ok(result.text.includes('`code`'));
    assert.ok(result.text.includes(request(literal)));
    assert.ok(result.text.includes('<think>\nprivate\n</think>'));
    assert.equal(result.state.toolResultMap.get('<!--VCP_TOOL_RESULT_1-->'), receipt(literal));
    const script = result.state.rawScriptMap.get('<!--VCP_RAW_SCRIPT_1-->');
    assert.equal(script, '<script>const s = `template`; const literal = "<!--VCP_RAW_SCRIPT_0-->";</script>');
    assert.equal(result.state.placeholders.references(literal, 'code').length, 0);
});

test('parse state and registry ownership do not leak across messages or streaming and final modes', () => {
    const pipeline = createContentPipeline({});
    const first = pipeline.process('`one`');
    const second = pipeline.process('`two`');
    assert.notStrictEqual(first.state.placeholders, second.state.placeholders);
    assert.equal([...first.state.codeBlockMap.values()][0], '`one`');
    assert.equal([...second.state.codeBlockMap.values()][0], '`two`');
    const stream = pipeline.process('![x](old.png) `tail', { mode: PIPELINE_MODES.STREAM_FAST });
    assert.equal(stream.state.toolResultMap, null);
    assert.equal(stream.meta.recognition.retainedSourceChars, 0);
    assert.equal(stream.text, '![x](old.png) `tail');
});

test('document and request consumers share field scans only for identical source extents', () => {
    const context = createVcpParseContext('');
    const source = '![pic](old.png)\n' + request('<<<[END_TOOL_REQUEST]>>>');
    const index = context.index(source);
    index.regions();
    replaceToolRequestBlocks(source, () => 'card', { sourceIndex: index });
    const diagnostics = context.getDiagnostics().operations;
    assert.equal(diagnostics['request-end'].scans, 1);
    assert.equal(diagnostics['request-end'].hits, 1);
    assert.equal(diagnostics['code-data-final'].scans, 1);

    const crossing = '<<<[TOOL_REQUEST]>>>text:「始」open\n' + receipt('data')
        + '\n「末」<<<[END_TOOL_REQUEST]>>>';
    const bounded = context.index(crossing);
    assert.equal(bounded.ofKind('tool-request')[0].closed, false);
    assert.equal(bounded.requestEnd('<<<[TOOL_REQUEST]>>>'.length).status, 'complete');
    assert.equal(context.getDiagnostics().operations['request-end'].scans, 3);
    assert.throws(() => bounded.requestEnd(-1), RangeError);
    context.release();
});

test('explicit request masks preserve their legacy meaning even when an index is supplied', () => {
    const source = receipt('`line\n' + request('masked-policy') + '\nend`');
    const replace = () => 'card';
    assert.equal(replaceToolRequestBlocks(source, replace, {
        sourceIndex: createVcpSourceIndex(source), toolResultRanges: [],
    }), replaceToolRequestBlocks(source, replace, { toolResultRanges: [] }));
});