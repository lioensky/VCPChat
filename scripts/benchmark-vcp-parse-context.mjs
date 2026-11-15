import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createVcpParseContext } from '../modules/renderer/vcpParseContext.js';
import { tokenizeVcpDocument } from '../modules/renderer/vcpDocumentScanner.js';
import { collectToolResultRanges } from '../modules/renderer/toolResultRegions.js';
import { createContentPipeline } from '../modules/renderer/contentPipeline.js';
import { replaceToolRequestBlocks } from '../modules/renderer/toolRequestScanner.js';

const size = 200 * 1024;
const fit = unit => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const samples = {
    prose: fit('persona_literal ![pic](old.png) ordinary prose\n\n'),
    dense: fit('![pic](old.png) `inline` <div><style>.a{color:red}</style><script>const s=`x`;</script></div>\n'),
    nested: '<div>'.repeat(64) + '\n' + '[[VCP调用结果信息汇总:\n'.repeat(64)
        + fit('literal `code`\n') + '\n' + 'VCP调用结果结束]]\n'.repeat(64) + '</div>'.repeat(64),
    unclosed: '~~~js\n' + fit('const line = "<style>";\n'),
    tools: fit('<<<[TOOL_REQUEST]>>>text:「始ESCAPE」literal end <<<[END_TOOL_REQUEST]>>>「末ESCAPE」<<<[END_TOOL_REQUEST]>>>\n'
        + '[[VCP调用结果信息汇总:\n- 返回内容: literal `code`\nVCP调用结果结束]]\n'),
};

function measure(run) {
    for (let i = 0; i < 5; i++) run();
    const times = [];
    for (let i = 0; i < 20; i++) {
        const start = performance.now();
        run();
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return {
        medianMs: Number(times[10].toFixed(3)),
        p95Ms: Number(times[18].toFixed(3)),
    };
}

// Equivalent query workload, NOT a before/after benchmark of the entire renderer.
// The unshared path intentionally represents three independent consumers.
function unshared(source) {
    const first = collectToolResultRanges(source);
    const second = collectToolResultRanges(source);
    const regions = tokenizeVcpDocument(source);
    return [first, second, regions];
}

function shared(source) {
    const context = createVcpParseContext(source);
    const index = context.index(source);
    const first = index.toolResults();
    const second = context.index(source).toolResults();
    const regions = context.index(source).regions();
    const result = [first, second, regions];
    context.release();
    return { result, diagnostics: context.getDiagnostics() };
}

const pipeline = createContentPipeline({
    getToolResultRegex: () => /unused/g,
    replaceToolRequestBlocks,
});
const results = Object.entries(samples).map(([name, source]) => {
    const indexed = shared(source);
    assert.deepEqual(indexed.result, unshared(source));
    const processed = pipeline.process(source);
    return {
        name, chars: source.length, regions: indexed.result[2].length,
        unsharedQueries: measure(() => unshared(source)),
        sharedQueriesIncludingReservation: measure(() => shared(source)),
        queryDiagnostics: indexed.diagnostics,
        currentPipeline: measure(() => pipeline.process(source)),
        pipelineDiagnostics: processed.meta.recognition,
        registeredPayloads: processed.state.placeholders.getDiagnostics().entries,
    };
});
console.log(JSON.stringify({
    node: process.version,
    note: 'Pure synchronous source/query/pipeline workloads only. Input extents are not actual character visits. '
        + 'No DOM, CSS AST, heap peak or Electron frame measurement. Nested sample is not an HTML tree benchmark. '
        + 'No claim of single-pass, strict incrementality or whole-renderer speedup.',
    results,
}, null, 2));