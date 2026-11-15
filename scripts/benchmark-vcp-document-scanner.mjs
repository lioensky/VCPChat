import { performance } from 'node:perf_hooks';
import { tokenizeVcpDocument } from '../modules/renderer/vcpDocumentScanner.js';
import { createStableBoundaryState } from '../modules/renderer/streamStableBoundary.js';

const size = 200 * 1024;
const fit = unit => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const inputs = {
    prose: fit('普通正文 text with punctuation.\n\n'),
    fence: '~~~javascript\n' + fit('const x = 1;\n') + '\n~~~\n',
    html: fit('<div><style>.a{color:red}</style><script>const x=`value`;</script></div>\n'),
    tool: '[[VCP调用结果信息汇总:\n' + fit('literal <style>.data{}</style> `\n') + '\nVCP调用结果结束]]',
};

function measure(run, count = 20) {
    for (let i = 0; i < 5; i++) run();
    const samples = [];
    for (let i = 0; i < count; i++) {
        const start = performance.now();
        run();
        samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return {
        medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
        p95Ms: Number(samples[Math.ceil(samples.length * 0.95) - 1].toFixed(3)),
    };
}

const domains = Object.entries(inputs).map(([name, source]) => ({
    name, chars: source.length,
    regions: tokenizeVcpDocument(source).length,
    ...measure(() => tokenizeVcpDocument(source)),
}));

const source = '~~~js\n' + fit('const line = 1;\n');
const scanner = createStableBoundaryState();
const start = performance.now();
let updates = 0;
for (let end = 256; end < source.length; end += 256) {
    scanner.update(source.slice(0, end));
    updates++;
}
scanner.update(source);
updates++;
const growingTailMs = performance.now() - start;
const duplicateFrames = measure(() => scanner.update(source), 100);
console.log(JSON.stringify({
    node: process.version,
    note: 'Pure scanner only; no marked, CSS AST, DOM or Electron frame measurement. Not a single-pass/delta complexity proof.',
    domains,
    longUnclosedFence: {
        chars: source.length, updates,
        cumulativeMs: Number(growingTailMs.toFixed(3)),
        diagnostics: scanner.getDiagnostics(),
        identicalSource: duplicateFrames,
    },
}, null, 2));