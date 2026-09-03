// settings-schema 迁移的像素对比工具（exp/settings-schema）。
// 用法：node scripts/compare-settings-schema-pixels.mjs <schema面.png> <静态面.png> [容差=8]
// 对两张同尺寸截图做逐通道像素比对，输出差异占比与差异区域分组；
// 差异非零时退出码为 1（迁移验收要求 0）。
// 依赖 sharp（从主工作区的 node_modules 解析，缺失时提示安装）。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const [schemaShot, staticShot, toleranceArg] = process.argv.slice(2);
if (!schemaShot || !staticShot) {
    console.error('用法：node scripts/compare-settings-schema-pixels.mjs <schema面.png> <静态面.png> [容差=8]');
    process.exit(2);
}
const tolerance = Number(toleranceArg || 8);
const require = createRequire(import.meta.url);
let sharp;
for (const base of [process.cwd(), path.dirname(process.argv[1])]) {
    const candidate = path.join(base, 'node_modules', 'sharp');
    if (fs.existsSync(candidate)) { sharp = require(candidate); break; }
}
if (!sharp) {
    console.error('未找到 sharp 依赖：请在含 node_modules/sharp 的工作区内运行，或 npm i -D sharp');
    process.exit(2);
}

const [a, b] = await Promise.all([
    sharp(schemaShot).raw().toBuffer({ resolveWithObject: true }),
    sharp(staticShot).raw().toBuffer({ resolveWithObject: true }),
]);
if (a.info.width !== b.info.width || a.info.height !== b.info.height || a.data.length !== b.data.length) {
    console.error(`尺寸不一致：${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}`);
    process.exit(1);
}

const width = a.info.width;
const rowHits = new Map();
let diff = 0;
for (let p = 0; p < a.data.length / 4; p++) {
    let delta = 0;
    for (let c = 0; c < 4; c++) {
        const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]);
        if (d > delta) delta = d;
    }
    if (delta > tolerance) {
        diff += 1;
        const y = Math.floor(p / width);
        const x = p % width;
        const hit = rowHits.get(y) || { count: 0, x0: Infinity, x1: 0 };
        hit.count += 1;
        hit.x0 = Math.min(hit.x0, x);
        hit.x1 = Math.max(hit.x1, x);
        rowHits.set(y, hit);
    }
}

const rows = [...rowHits.keys()].sort((m, n) => m - n);
const groups = [];
for (const y of rows) {
    const last = groups[groups.length - 1];
    if (last && y <= last.y1 + 2) { last.y1 = y; last.pixels += rowHits.get(y).count; }
    else groups.push({ y0: y, y1: y, pixels: rowHits.get(y).count });
}

console.log(`尺寸 ${width}x${a.info.height} · 容差 ${tolerance}`);
console.log(`差异字节 ${diff} / ${a.data.length}（${(100 * diff / a.data.length).toFixed(4)}%）`);
for (const group of groups) {
    const x0 = Math.min(...rows.filter(y => y >= group.y0 && y <= group.y1).map(y => rowHits.get(y).x0));
    const x1 = Math.max(...rows.filter(y => y >= group.y0 && y <= group.y1).map(y => rowHits.get(y).x1));
    console.log(`差异区域 y ${group.y0}-${group.y1} · x ${x0}-${x1} · ${group.pixels} 像素`);
}
process.exit(diff === 0 ? 0 : 1);
