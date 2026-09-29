'use strict';
// 基准：node rust_projectforge_indexer/bench.js [root]
// 冷扫描（全量解析）→ 热扫描（mtime+size 命中缓存）→ 进程内存（工作集 / RSS）。

const path = require('path');
const readline = require('readline');
const { spawn, execSync } = require('child_process');
const { resolveDefaultBinaryPath } = require('../VCPDistributedServer/Plugin/ProjectForge/indexerClient');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const child = spawn(resolveDefaultBinaryPath(), [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const waiters = new Map();
let nextId = 1;
let ready;
const readyP = new Promise(r => { ready = r; });

readline.createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.type === 'ready') return ready(msg);
    waiters.get(msg.id)?.(msg);
});

function call(method, params) {
    const id = nextId++;
    return new Promise(resolve => {
        waiters.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
}

function memoryMB() {
    try {
        if (process.platform === 'win32') {
            const out = execSync(`tasklist /FI "PID eq ${child.pid}" /FO CSV /NH`).toString();
            const kb = Number(out.split('","')[4].replace(/[^\d]/g, ''));
            return (kb / 1024).toFixed(1);
        }
        return (Number(execSync(`ps -o rss= -p ${child.pid}`).toString().trim()) / 1024).toFixed(1);
    } catch (_e) {
        return '?';
    }
}

(async () => {
    await readyP;
    console.log(`root: ${root}`);
    console.log(`idle memory: ${memoryMB()} MB`);
    for (const label of ['cold', 'warm']) {
        const t0 = process.hrtime.bigint();
        // 'e' 几乎命中所有符号名，total 近似为符号总数
        const r = await call('findSymbols', { root, name: 'e', limit: 1 });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (!r.ok) { console.log(label, r.error); break; }
        const { scanned, parsed, total, truncated } = r.result;
        console.log(`${label}: ${ms.toFixed(0)} ms · files scanned=${scanned} parsed=${parsed} · symbols≈${total}${truncated ? ' · TRUNCATED' : ''} · memory ${memoryMB()} MB`);
    }
    await call('shutdown', {});
})();