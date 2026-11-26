#!/usr/bin/env node
// VMusic 结构守卫与阅读包。
//
//   node scripts/music-arch.mjs check            校验（npm run check:music）
//   node scripts/music-arch.mjs context <id|文件>  打印一个模块的阅读包（npm run music:context -- dock）
//   node scripts/music-arch.mjs modules          列出全部模块
//   node scripts/music-arch.mjs baseline         按当前代码重写 architecture.json 里的两份基线
//
// 规则写在 Musicmodules/architecture.json，说明在 Musicmodules/AGENTS.md。
// 只用 Node 自带模块，不依赖 electron，可在任何环境跑。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_FILE = 'Musicmodules/architecture.json';
const SHELL_HTML = 'Musicmodules/music.html';
// 基线文件允许在基线大小上再长这么多，超过就要拆文件或在评审里更新基线。
const GROWTH_SLACK = 0.1;

const rel = (p) => p.split(path.sep).join('/');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(ROOT, file));
const loadRegistry = () => JSON.parse(read(REGISTRY_FILE));

function globToRegExp(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === '*' && glob[i + 1] === '*') { out += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; }
        else if (ch === '*') out += '[^/]*';
        else if ('.+?^${}()|[]\\'.includes(ch)) out += '\\' + ch;
        else out += ch;
    }
    return new RegExp('^' + out + '$');
}

function trackedFiles() {
    let list;
    try {
        list = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
            .split('\n').filter(Boolean);
    } catch {
        list = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                const p = dir ? `${dir}/${entry.name}` : entry.name;
                if (entry.isDirectory()) walk(p); else list.push(p);
            }
        };
        walk('');
    }
    return list.filter((f) => exists(f));
}

// 音乐相关文件：Musicmodules 目录，加上登记表里明确列出的目录外路径。
function musicFiles(registry, all) {
    const patterns = registry.modules.flatMap((m) => m.paths.map(globToRegExp));
    // modules/、preloads/ 下文件名带 music 的也算音乐文件，没登记就报出来
    const named = (f) => /^(modules|preloads)\/(.*\/)?[^/]*music[^/]*$/i.test(f);
    return all.filter((f) => f.startsWith('Musicmodules/') || f.startsWith('Musicmodules-legacy/') || named(f) || patterns.some((re) => re.test(f)));
}

function ownerIndex(registry, files) {
    const compiled = registry.modules.map((m) => ({ m, res: m.paths.map(globToRegExp) }));
    const owners = new Map();
    for (const f of files) owners.set(f, compiled.filter(({ res }) => res.some((re) => re.test(f))).map(({ m }) => m));
    return owners;
}

const isCode = (f) => /\.(c|m)?js$/.test(f) && !f.endsWith('.min.js');
const isRendererCode = (f) => f.startsWith('Musicmodules/') && isCode(f);

// window.X = / global.X = 形式的全局导出（只认首字母大写或 setup/init/create 开头的名字）
function exportedGlobals(src) {
    const names = new Set();
    const re = /\b(?:window|global|globalThis)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g;
    let m;
    while ((m = re.exec(src))) {
        if (/^(?:[A-Z]|setup|init|create)/.test(m[1])) names.add(m[1]);
    }
    // 顶层 function setupX(app) 也是全局（经典脚本）
    const fn = /^(?:async\s+)?function\s+(setup[A-Z]\w*)\s*\(/gm;
    while ((m = fn.exec(src))) names.add(m[1]);
    const cls = /^class\s+([A-Z]\w*)/gm;
    while ((m = cls.exec(src))) names.add(m[1]);
    return [...names];
}

function appWrites(src) {
    const names = new Set();
    const re = /\bapp\.([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\?\?=|\|\|=)/g;
    let m;
    while ((m = re.exec(src))) names.add(m[1]);
    return names;
}

function appReads(src) {
    const names = new Set();
    const re = /\bapp\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(src))) names.add(m[1]);
    return names;
}

// 手写的方法包装：const base = app.foo; ... app.foo = (...) => { ... base(...) ... }
// 应改用 MusicAppHooks（Musicmodules/music-app-hooks.js），这样包装顺序能用 MusicAppHooks.list(app) 查到。
function handWrappedMethods(src) {
    const found = [];
    const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*app\.([A-Za-z_$][\w$]*)\s*;/g;
    let m;
    while ((m = re.exec(src))) {
        const [, local, name] = m;
        const rest = src.slice(m.index + m[0].length);
        const assign = new RegExp(`\\bapp\\.${name}\\s*=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`).exec(rest);
        if (!assign) continue;
        const body = rest.slice(assign.index, assign.index + 4000);
        if (new RegExp(`\\b${local}\\s*(?:\\(|\\.apply\\b|\\.call\\b)`).test(body)) found.push(name);
    }
    return found;
}

function htmlRefs(file) {
    const src = read(file);
    const dir = path.posix.dirname(file);
    const refs = [];
    const re = /<(script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g;
    let m;
    while ((m = re.exec(src))) {
        if (/^(https?:|data:)/.test(m[2])) continue;
        refs.push({ tag: m[1], raw: m[2], file: path.posix.normalize(path.posix.join(dir, m[2])) });
    }
    return refs;
}

function analyse(registry) {
    const all = trackedFiles();
    const files = musicFiles(registry, all);
    const owners = ownerIndex(registry, files);
    const code = files.filter(isCode).filter((f) => !f.startsWith('Musicmodules-legacy/'));
    const info = new Map();
    for (const f of code) {
        const src = read(f);
        info.set(f, {
            bytes: Buffer.byteLength(src),
            lines: src.split('\n').length,
            globals: exportedGlobals(src),
            writes: isRendererCode(f) ? appWrites(src) : new Set(),
            reads: isRendererCode(f) ? appReads(src) : new Set(),
            wrapped: isRendererCode(f) && !f.endsWith('/music-app-hooks.js') ? handWrappedMethods(src) : [],
            src
        });
    }
    return { all, files, owners, code, info };
}

function appWriterMap(info) {
    const writers = new Map();
    for (const [f, data] of info) {
        for (const name of data.writes) {
            if (!writers.has(name)) writers.set(name, new Set());
            writers.get(name).add(f);
        }
    }
    return writers;
}

// ---- 舞台模式登记一致性 ----
function stageModeIds() {
    const ids = (src, re) => [...src.matchAll(re)].map((m) => m[1]);
    const core = ids(read('Musicmodules/music-stage/music-stage-modes.js').split('const registry')[0], /\{\s*id:\s*'([a-z]+)'/g);
    const advanced = ids(read('Musicmodules/music-stage/music-stage-advanced-modes.js').split('const definitions')[1] || '', /\{\s*id:\s*'([a-z]+)'/g);
    const configSrc = read('Musicmodules/music-stage/music-stage-config.js');
    const meta = ids(configSrc.split('MODE_META')[1]?.split(']);')[0] || '', /\{\s*id:\s*'([a-z]+)'/g);
    const defaultsLine = configSrc.match(/enabledModes:\s*\[([^\]]+)\]/);
    const enabled = defaultsLine ? ids(defaultsLine[1], /'([a-z]+)'/g) : [];
    const handlersSrc = read('modules/ipc/musicHandlers.js');
    const supported = handlersSrc.match(/supportedStageModes\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    const handlers = supported ? ids(supported[1], /'([a-z]+)'/g) : [];
    const controllerSrc = read('VCPDistributedServer/Plugin/MusicController/music-controller.js');
    const aliasBlock = controllerSrc.match(/stageModeAliases\s*=\s*\{([\s\S]*?)\};/);
    const controller = aliasBlock ? [...new Set(ids(aliasBlock[1], /:\s*'([a-z]+)'/g))] : [];
    return { core, advanced, meta, enabled, handlers, controller };
}

function checkStageModes(errors) {
    const s = stageModeIds();
    const registered = new Set([...s.core, ...s.advanced, 'starborn']);
    const compare = (label, list) => {
        const set = new Set(list);
        const missing = [...registered].filter((id) => !set.has(id));
        const extra = [...set].filter((id) => !registered.has(id));
        if (missing.length || extra.length) {
            errors.push(`舞台模式登记不一致：${label} 缺 [${missing.join(', ')}] 多 [${extra.join(', ')}]（登记表 = music-stage-modes.js 核心 + music-stage-advanced-modes.js + starborn）`);
        }
    };
    compare('music-stage-config.js MODE_META', s.meta);
    compare('music-stage-config.js DEFAULTS.enabledModes', s.enabled);
    compare('modules/ipc/musicHandlers.js supportedStageModes', s.handlers);
    compare('MusicController stageModeAliases', s.controller);
    const html = read(SHELL_HTML);
    for (const id of s.advanced) {
        if (!new RegExp(`modes/${id}-manager\\.js`).test(html) && !new RegExp(`modes/${id}-`).test(html)) {
            errors.push(`舞台模式 ${id} 的脚本没有在 music.html 里加载`);
        }
    }
    return s;
}

function check() {
    const registry = loadRegistry();
    const { files, owners, code, info } = analyse(registry);
    const errors = [];
    const notes = [];

    // 1. 每个文件恰好属于一个模块
    for (const f of files) {
        const list = owners.get(f) || [];
        if (!list.length) errors.push(`未登记的文件：${f}（在 ${REGISTRY_FILE} 里给它找个模块）`);
        else if (list.length > 1) errors.push(`文件同时属于多个模块：${f} → ${list.map((m) => m.id).join(', ')}`);
    }
    for (const m of registry.modules) {
        for (const doc of [...(m.docs || []), ...(m.tests || []), ...(m.tools || [])]) {
            if (!exists(doc)) errors.push(`模块 ${m.id} 引用的文件不存在：${doc}`);
        }
    }
    // 音乐测试都要登记到某个模块（tests 或 tools），npm run test:music 才会跑到它
    const listed = new Set(registry.modules.flatMap((m) => [...(m.tests || []), ...(m.tools || [])]));
    const musicTest = /^tests\/[^/]*(music|stage|starbloom|diorama|kowloon|tunnel)[^/]*\.(test\.)?(c|m)?js$/;
    for (const f of trackedFiles().filter((x) => musicTest.test(x))) {
        if (!listed.has(f)) errors.push(`测试没登记到任何模块：${f}（加到 architecture.json 对应模块的 tests）`);
    }

    // 2. music.html 引用都存在；Musicmodules 下的脚本/样式都被加载（死文件）
    const shellRefs = htmlRefs(SHELL_HTML);
    for (const ref of shellRefs) {
        if (!ref.file.startsWith('node_modules/') && !exists(ref.file)) errors.push(`music.html 引用了不存在的文件：${ref.raw}`);
    }
    const loaded = new Set(shellRefs.map((r) => r.file));
    for (const html of files.filter((f) => f.endsWith('.html') && f.startsWith('Musicmodules/') && f !== SHELL_HTML)) {
        htmlRefs(html).forEach((r) => loaded.add(r.file));
    }
    for (const f of files) {
        if (!f.startsWith('Musicmodules/') || !/\.(js|css)$/.test(f)) continue;
        if (loaded.has(f) || registry.unloadedAllowed?.[f]) continue;
        errors.push(`没有页面加载的脚本/样式：${f}（是死代码就删掉；确实有用就登记到 unloadedAllowed 并写明谁在用）`);
    }

    // 3. 全局名不重复
    const globalOwners = new Map();
    for (const [f, data] of info) {
        if (!f.startsWith('Musicmodules/')) continue;
        for (const g of data.globals) {
            if (!globalOwners.has(g)) globalOwners.set(g, []);
            globalOwners.get(g).push(f);
        }
    }
    for (const [g, list] of globalOwners) {
        if (list.length > 1) errors.push(`全局名 ${g} 被多个文件导出：${list.join(', ')}`);
    }

    // 4. 文件体积棘轮
    const budget = registry.sizeBudgetBytes;
    for (const f of files.filter((x) => /\.(js|css|html)$/.test(x) && !x.startsWith('Musicmodules-legacy/') && !x.endsWith('.min.js'))) {
        const bytes = fs.statSync(path.join(ROOT, f)).size;
        const base = registry.sizeBaseline?.[f];
        if (base === undefined) {
            if (bytes > budget) errors.push(`新文件超过 ${Math.round(budget / 1024)} KB：${f}（${Math.round(bytes / 1024)} KB），拆成几个职责单一的文件`);
        } else if (bytes > base * (1 + GROWTH_SLACK)) {
            errors.push(`巨型文件继续长大：${f} ${Math.round(base / 1024)} → ${Math.round(bytes / 1024)} KB（上限 +${GROWTH_SLACK * 100}%）。新功能放进新文件，或先拆分`);
        } else if (bytes <= budget) {
            notes.push(`${f} 已降到预算以内（${Math.round(bytes / 1024)} KB），可以跑 baseline 把它移出基线`);
        }
    }

    // 5. app 多处写入棘轮：一个 app 属性只该有一个主人
    const writers = appWriterMap(info);
    const baseline = registry.appWriterBaseline || {};
    for (const [name, set] of writers) {
        if (set.size < 2) continue;
        const allowed = new Set(baseline[name] || []);
        const added = [...set].filter((f) => !allowed.has(f));
        if (added.length) {
            errors.push(`app.${name} 多了写入方：${added.join(', ')}（现有：${[...allowed].join(', ') || '无'}）。改成调用主人提供的方法或用 app 事件，见 AGENTS.md「app 对象」`);
        }
    }

    // 5b. app 方法不手写包装，统一走 MusicAppHooks
    for (const [f, d] of info) {
        for (const name of d.wrapped) {
            errors.push(`${f} 手写包装了 app.${name}（先存旧方法再覆盖）。改用 MusicAppHooks.before / after / wrap，见 Musicmodules/music-app-hooks.js`);
        }
    }

    // 6. 按段拆开的样式表在 music.html 里按登记顺序紧挨着加载（顺序就是层叠顺序）
    const cssOrder = shellRefs.filter((r) => r.tag === 'link').map((r) => r.file);
    for (const [name, chain] of Object.entries(registry.cssChains || {})) {
        if (name.startsWith('$')) continue;
        const at = cssOrder.indexOf(chain[0]);
        const actual = at < 0 ? [] : cssOrder.slice(at, at + chain.length);
        if (actual.join('|') !== chain.join('|')) {
            errors.push(`样式链 ${name} 在 music.html 里的加载顺序不对，应当紧挨着依次是：${chain.map((f) => path.posix.basename(f)).join(' → ')}`);
        }
    }

    // 7. 舞台模式登记一致
    checkStageModes(errors);

    // 8. 旧版界面冻结
    if (exists('Musicmodules-legacy/UPSTREAM.sha256')) notes.push('旧版界面逐字节核对由 tests/music-legacy.test.js 负责');

    const giant = Object.keys(registry.sizeBaseline || {}).length;
    const multi = [...writers.values()].filter((s) => s.size > 1).length;
    console.log(`VMusic 结构检查：${files.length} 个文件，${registry.modules.length} 个模块，${code.length} 个脚本；基线里的巨型文件 ${giant} 个，多处写入的 app 属性 ${multi} 个`);
    notes.forEach((n) => console.log(`  提示：${n}`));
    if (errors.length) {
        errors.forEach((e) => console.error(`  ✗ ${e}`));
        console.error(`\n${errors.length} 个问题。说明见 Musicmodules/AGENTS.md`);
        process.exitCode = 1;
    } else {
        console.log('  ✓ 通过');
    }
}

function baselineCmd() {
    const registry = loadRegistry();
    const { files, info } = analyse(registry);
    const sizes = {};
    for (const f of files.filter((x) => /\.(js|css|html)$/.test(x) && !x.startsWith('Musicmodules-legacy/') && !x.endsWith('.min.js')).sort()) {
        const bytes = fs.statSync(path.join(ROOT, f)).size;
        if (bytes > registry.sizeBudgetBytes) sizes[f] = bytes;
    }
    const writers = {};
    for (const [name, set] of [...appWriterMap(info)].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (set.size > 1) writers[name] = [...set].sort();
    }
    registry.sizeBaseline = sizes;
    registry.appWriterBaseline = writers;
    fs.writeFileSync(path.join(ROOT, REGISTRY_FILE), JSON.stringify(registry, null, 2) + '\n');
    console.log(`已写入基线：巨型文件 ${Object.keys(sizes).length} 个，多处写入的 app 属性 ${Object.keys(writers).length} 个`);
}

function listModules() {
    const registry = loadRegistry();
    const { files, owners } = analyse(registry);
    for (const m of registry.modules) {
        const mine = files.filter((f) => (owners.get(f) || []).includes(m));
        const kb = mine.reduce((sum, f) => sum + fs.statSync(path.join(ROOT, f)).size, 0) / 1024;
        console.log(`${m.id.padEnd(12)} ${m.title}（${mine.length} 个文件，${Math.round(kb)} KB）${m.frozen ? ' [冻结]' : ''}`);
    }
}

function context(target) {
    const registry = loadRegistry();
    const { files, owners, info } = analyse(registry);
    let mod = registry.modules.find((m) => m.id === target);
    let focus = null;
    if (!mod && target) {
        const norm = rel(target).replace(/^\.\//, '');
        const hit = files.find((f) => f === norm || f.endsWith('/' + norm));
        if (hit) { focus = hit; mod = (owners.get(hit) || [])[0]; }
    }
    if (!mod) {
        console.error(`没找到模块或文件：${target || '(空)'}。可用模块：${registry.modules.map((m) => m.id).join(', ')}`);
        process.exitCode = 1;
        return;
    }
    const mine = files.filter((f) => (owners.get(f) || []).includes(mod));
    const globalOwner = new Map();
    const propOwner = new Map();
    for (const [f, data] of info) {
        const ownerId = (owners.get(f) || [])[0]?.id || '?';
        data.globals.forEach((g) => globalOwner.set(g, { f, ownerId }));
    }
    const writers = appWriterMap(info);
    for (const [name, set] of writers) propOwner.set(name, [...set]);

    console.log(`# ${mod.id} — ${mod.title}${mod.frozen ? '（冻结，不能改）' : ''}\n`);
    console.log(mod.purpose + '\n');
    console.log('## 先读');
    [...(mod.docs || [])].forEach((d) => console.log(`- ${d}`));
    // 指定了文件时只列同一族的文件（同前缀，如 inkdraft-*），模块里其余文件给个数
    const family = focus ? path.posix.basename(focus).split(/[-.]/)[0] : null;
    const listed = family ? mine.filter((f) => path.posix.basename(f).startsWith(family + '-') || path.posix.basename(f).startsWith(family + '.') || f === focus) : mine;
    console.log(`\n## 文件${family && listed.length < mine.length ? `（只列 ${family}-* 一族；模块里另有 ${mine.length - listed.length} 个，去掉文件名看全部）` : ''}`);
    for (const f of listed) {
        const d = info.get(f);
        const bytes = fs.statSync(path.join(ROOT, f)).size;
        const flag = registry.sizeBaseline?.[f] ? '  ← 巨型文件，别再往里加' : '';
        console.log(`- ${f}  ${Math.round(bytes / 1024)} KB${d ? `, ${d.lines} 行` : ''}${focus === f ? '  ← 目标' : ''}${flag}`);
    }
    const exported = listed.flatMap((f) => info.get(f)?.globals || []);
    if (exported.length) console.log(`\n## 导出的全局\n${exported.join(', ')}`);
    const scope = focus ? [focus] : mine;
    const used = new Set();
    for (const f of scope) {
        const src = info.get(f)?.src || '';
        for (const [g, o] of globalOwner) {
            if ((focus ? o.f !== focus : o.ownerId !== mod.id) && new RegExp(`\\b${g.replace(/\$/g, '\\$')}\\b`).test(src)) used.add(`${g}（${o.ownerId}: ${path.posix.basename(o.f)}）`);
        }
    }
    if (used.size) console.log(`\n## 用到的别处的全局\n${[...used].join('\n')}`);
    const owned = [];
    const shared = [];
    const borrowed = new Map();
    for (const f of scope) {
        const d = info.get(f);
        if (!d) continue;
        d.writes.forEach((p) => ((propOwner.get(p) || []).length > 1 ? shared : owned).push(p));
        d.reads.forEach((p) => {
            const w = propOwner.get(p) || [];
            if (!d.writes.has(p) && w.length) {
                const ownerIds = [...new Set(w.map((x) => (owners.get(x) || [])[0]?.id))].filter((id) => id !== mod.id);
                if (ownerIds.length) borrowed.set(p, ownerIds.join('/'));
            }
        });
    }
    const uniq = (a) => [...new Set(a)].sort();
    if (owned.length) console.log(`\n## 在 app 上定义（只有这里写）\n${uniq(owned).join(', ')}`);
    if (shared.length) console.log(`\n## 在 app 上与别处共写（历史遗留，改动前看清所有写入方）\n${uniq(shared).map((p) => `${p} ← ${propOwner.get(p).map((x) => path.posix.basename(x)).join(', ')}`).join('\n')}`);
    if (borrowed.size) console.log(`\n## 读取别的模块定义的 app 属性\n${[...borrowed].sort().map(([p, o]) => `${p}（${o}）`).join(', ')}`);
    if (mod.tests?.length) console.log(`\n## 相关测试\n${mod.tests.map((t) => `- ${t}`).join('\n')}\n\n跑法：node scripts/test-music.mjs --module ${mod.id}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'check') check();
else if (cmd === 'context') context(arg);
else if (cmd === 'baseline') baselineCmd();
else if (cmd === 'modules') listModules();
else {
    console.log('用法：node scripts/music-arch.mjs check | context <模块id|文件> | modules | baseline');
    process.exitCode = cmd ? 1 : 0;
}
