import assert from 'node:assert/strict';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { findExplicitStablePrefix } from '../modules/renderer/streamStableBoundary.js';

const sizes = [32, 100, 200];
const chunkChars = 1024;
const rounds = 5;
const percentile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * ratio))];
const results = [];
for (const kib of sizes) {
    const block = '<div class="demo"><style>.demo { color: red; }</style>stable</div>\n\n';
    const source = block.repeat(Math.ceil(kib * 1024 / block.length));
    const runs = {};
    for (const mode of ['full-rescan', 'stable-tail']) {
        const elapsed = [];
        const calls = [];
        let finalCutoff = 0;
        for (let round = 0; round < rounds + 1; round++) {
            let cutoff = 0;
            const begin = performance.now();
            for (let end = chunkChars; end < source.length + chunkChars; end += chunkChars) {
                const visible = source.slice(0, Math.min(end, source.length));
                const start = performance.now();
                cutoff = findExplicitStablePrefix(visible, mode === 'stable-tail' ? cutoff : 0);
                if (round > 0) calls.push(performance.now() - start);
            }
            if (round > 0) elapsed.push(performance.now() - begin);
            finalCutoff = cutoff;
        }
        runs[mode] = {
            finalCutoff,
            medianTotalMs: Number(percentile(elapsed, 0.5).toFixed(3)),
            p50ScanMs: Number(percentile(calls, 0.5).toFixed(3)),
            p95ScanMs: Number(percentile(calls, 0.95).toFixed(3)),
            maxScanMs: Number(Math.max(...calls).toFixed(3)),
        };
    }
    assert.equal(runs['full-rescan'].finalCutoff, runs['stable-tail'].finalCutoff);
    results.push({ requestedKiB: kib, sourceChars: source.length, runs });
}
console.log(JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, chunkChars, measuredRounds: rounds, warmupRounds: 1,
    scope: 'Stable boundary scanner only; not browser frame, DOM, CSS AST or full pipeline latency.',
    results,
}, null, 2));