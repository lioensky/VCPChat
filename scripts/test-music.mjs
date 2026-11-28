#!/usr/bin/env node
// 跑 VMusic 的全部（或某个模块的）测试，并和已知失败清单比对。
//
//   node scripts/test-music.mjs                    全部音乐测试（npm run test:music）
//   node scripts/test-music.mjs --module dock      只跑登记在 dock 模块下的测试
//   node scripts/test-music.mjs tests/x.test.js    只跑指定文件
//   node scripts/test-music.mjs --update-known     把当前失败写成已知失败（只在评审过的改动里用）
//
// 测试清单来自 Musicmodules/architecture.json 各模块的 tests。
// 已知失败在 tests/music-known-failures.json：按旧界面写、本机新版界面已经改掉的断言。
// 退出码只看「新失败」：已知失败继续失败不算回归；已知失败变成通过会提示把它从清单删掉。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KNOWN_FILE = 'tests/music-known-failures.json';
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'Musicmodules/architecture.json'), 'utf8'));

const args = process.argv.slice(2);
const update = args.includes('--update-known');
const modIdx = args.indexOf('--module');
const moduleId = modIdx >= 0 ? args[modIdx + 1] : null;
const explicit = args.filter((a, i) => !a.startsWith('--') && (modIdx < 0 || i !== modIdx + 1));

let files;
if (explicit.length) files = explicit.map((f) => f.replace(/\\/g, '/'));
else if (moduleId) {
    const mod = registry.modules.find((m) => m.id === moduleId);
    if (!mod) {
        console.error(`没有模块 ${moduleId}。可用：${registry.modules.map((m) => m.id).join(', ')}`);
        process.exit(2);
    }
    files = mod.tests || [];
} else files = [...new Set(registry.modules.flatMap((m) => m.tests || []))];
files = files.filter((f) => fs.existsSync(path.join(ROOT, f)));

const known = fs.existsSync(path.join(ROOT, KNOWN_FILE))
    ? JSON.parse(fs.readFileSync(path.join(ROOT, KNOWN_FILE), 'utf8'))
    : { failures: {} };

// 用 TAP 拿到每条测试的名字和结果；嵌套 subtest 用「父 > 子」表示。
function runFile(file) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0' } });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', () => {});
        const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
        child.on('close', (code) => {
            clearTimeout(timer);
            const results = [];
            const stack = [];
            // node 的 TAP：先出「# Subtest: 名字」，子测试缩进 4 格，父测试的结果行在子测试之后。
            for (const line of out.split('\n')) {
                const sub = line.match(/^(\s*)# Subtest: (.*)$/);
                if (sub) { const depth = sub[1].length / 4; stack.length = depth; stack[depth] = sub[2].trim(); continue; }
                const m = line.match(/^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/);
                if (!m) continue;
                const depth = m[1].length / 4;
                const name = m[3].trim();
                // 文件级的汇总行（名字就是文件路径）不算一条测试
                if (depth === 0 && (name === file || name.endsWith(path.basename(file)))) continue;
                results.push({ name: [...stack.slice(0, depth), name].join(' > '), ok: m[2] === 'ok' });
            }
            if (!results.length && code !== 0) results.push({ name: '(整个文件没跑起来)', ok: false });
            resolve({ file, results });
        });
    });
}

async function pool(items, size, fn) {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
    }));
    return out;
}

const started = Date.now();
const runs = await pool(files, Math.max(2, Math.min(6, os.cpus().length)), runFile);
let pass = 0;
const fresh = [];
const stillKnown = [];
const fixed = [];
const nextKnown = { ...known.failures };
for (const { file, results } of runs) {
    const knownHere = new Set(known.failures[file] || []);
    const failedHere = [];
    for (const r of results) {
        // 有子测试的父节点结果由子测试决定，避免一处失败算两遍
        if (results.some((o) => o.name.startsWith(r.name + ' > '))) continue;
        if (r.ok) {
            pass += 1;
            if (knownHere.has(r.name)) fixed.push(`${file} :: ${r.name}`);
        } else {
            failedHere.push(r.name);
            (knownHere.has(r.name) ? stillKnown : fresh).push(`${file} :: ${r.name}`);
        }
    }
    if (failedHere.length) nextKnown[file] = failedHere; else delete nextKnown[file];
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`VMusic 测试：${files.length} 个文件，${pass} 过，已知失败 ${stillKnown.length}，新失败 ${fresh.length}（${secs} 秒）`);
if (fixed.length) {
    console.log('\n这些已知失败现在通过了，从 tests/music-known-failures.json 删掉：');
    fixed.forEach((f) => console.log(`  ✓ ${f}`));
}
if (fresh.length) {
    console.log('\n新失败（回归，必须修）：');
    fresh.forEach((f) => console.log(`  ✗ ${f}`));
}
if (update) {
    const scoped = explicit.length || moduleId;
    const body = {
        $comment: '按旧界面写、本机新版界面已经改掉的断言。修好一条就删一条；不要往里加新的回归。由 node scripts/test-music.mjs --update-known 生成。',
        failures: scoped ? nextKnown : Object.fromEntries(Object.entries(nextKnown).filter(([f]) => files.includes(f)))
    };
    fs.writeFileSync(path.join(ROOT, KNOWN_FILE), JSON.stringify(body, null, 2) + '\n');
    console.log(`\n已写入 ${KNOWN_FILE}`);
}
process.exitCode = fresh.length && !update ? 1 : 0;
