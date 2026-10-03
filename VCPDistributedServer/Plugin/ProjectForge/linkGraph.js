'use strict';
// P3 链路地图：把索引器 facts（语言层事实）与 preload 声明表装配成模块 / 页面 / IPC / 全局四张图，供 Trace 查询。
//
// 置信度：
// - literal：字面量直连（ipcMain.handle('x') ↔ ipcRenderer.invoke('x')）；const：同文件常量解析；
// - declared：经 preload 声明表（describeApis：API 名 → 通道）或 exposeInMainWorld 键；
// - unresolved：动态参数，列出位置供人工查看。
// 本模块不做函数级调用图，也不做类型推断；页面归属只按 <script> 顺序 + require/import 闭包计算。

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { defaultRegistry: resolverRegistry } = require('./resolvers');

const JS_EXT = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
const CPP_MODULE_EXT = ['.cppm', '.ixx', '.mxx', '.cxxm'];
const MULTI_EXT = [
    ...JS_EXT,
    '.c', '.h', '.cpp', '.cxx', '.cc', '.hpp', '.hxx', '.hh',
    ...CPP_MODULE_EXT,
    '.go', '.rs', '.py', '.java', '.cs', '.lua',
];

// 强类型语言扩展名亲和度优先寻道映射（Language Affinity Matrix）
const LANG_AFFINITY = Object.freeze({
    '.py': ['.py', '.pyi'],
    '.rs': ['.rs'],
    '.go': ['.go'],
    '.java': ['.java'],
    '.cs': ['.cs'],
    '.js': ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
    '.ts': ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.d.ts'],
    '.cpp': ['.cpp', '.hpp', '.cc', '.cxx', '.h', ...CPP_MODULE_EXT],
    '.cppm': ['.cppm', '.cpp', '.hpp', '.ixx'],
    '.c': ['.c', '.h'],
    '.lua': ['.lua'],
});
const DEFAULT_ROLE_GLOBALS = Object.freeze({ chat: 'chatAPI', utility: 'utilityAPI', desktop: 'desktopAPI' });
const COMPAT_GLOBAL = 'electronAPI';
const LIMIT = 30;

// ---------------- preload 声明表（子进程取数，不在插件进程执行被分析工程的代码） ----------------

const declCache = new Map();
const DECL_SCRIPT = 'const r=require(process.argv[1]);process.stdout.write(JSON.stringify({apis:r.describeApis(),roleGlobals:r.ROLE_GLOBALS||null}))';

function registrySignature(root) {
    const reg = path.join(root, 'preloads', 'core', 'registry.js');
    if (!fs.existsSync(reg)) return null;
    const parts = [];
    const add = f => { try { const s = fs.statSync(f); parts.push(`${path.basename(f)}:${s.mtimeMs}:${s.size}`); } catch (_e) { /* 忽略 */ } };
    add(reg);
    add(path.join(root, 'preloads', 'core', 'define.js'));
    const apiDir = path.join(root, 'preloads', 'api');
    try { for (const n of fs.readdirSync(apiDir).sort()) if (n.endsWith('.js')) add(path.join(apiDir, n)); } catch (_e) { /* 无 api 目录 */ }
    return { reg, key: parts.join('|') };
}

/** @returns {Promise<{status:'ok'|'absent'|'failed', apis:Array, roleGlobals:object|null, error?:string}>} */
function loadPreloadDecls(root, { timeoutMs = 5000 } = {}) {
    const sig = registrySignature(root);
    if (!sig) return Promise.resolve({ status: 'absent', apis: [], roleGlobals: null });
    const hit = declCache.get(root);
    if (hit && hit.key === sig.key) return Promise.resolve(hit.value);
    return new Promise(resolve => {
        execFile(process.execPath, ['-e', DECL_SCRIPT, sig.reg], {
            cwd: root, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
        }, (err, stdout, stderr) => {
            let value;
            if (err) {
                value = { status: 'failed', error: String(stderr || err.message).trim().split('\n').slice(-3).join(' | '), apis: [], roleGlobals: null };
            } else {
                try {
                    const d = JSON.parse(stdout);
                    value = { status: 'ok', apis: Array.isArray(d.apis) ? d.apis : [], roleGlobals: d.roleGlobals || null };
                } catch (e) {
                    value = { status: 'failed', error: `输出不是 JSON：${e.message}`, apis: [], roleGlobals: null };
                }
            }
            if (value.status === 'ok') declCache.set(root, { key: sig.key, value });
            resolve(value);
        });
    });
}

function bridgeGlobalsOf(decls) {
    return [...new Set([...Object.values(decls?.roleGlobals || DEFAULT_ROLE_GLOBALS), COMPAT_GLOBAL])];
}

/** facts 中所有顶层桥接别名的名字（超集；是否真为页面级别名由 buildGraph 按经典脚本 + 同页判断）。 */
function aliasNames(factsResult) {
    const names = new Set();
    for (const f of factsResult?.files || []) for (const a of f.bridgeAliases || []) if (a.topLevel) names.add(a.name);
    return [...names];
}

// ---------------- 图装配 ----------------

function push(map, key, val) {
    let a = map.get(key);
    if (!a) map.set(key, (a = []));
    a.push(val);
}

function buildGraph(root, factsResult, decls = { status: 'absent', apis: [], roleGlobals: null }) {
    const files = new Map((factsResult?.files || []).map(f => [f.path, f]));
    const statCache = new Map();

    // 性能大跃迁（Stage 3 空间哈希索引）：
    // 1. files 集合中的文件天然真实存在，直接预热 statCache，避免百万次 fs.statSync 磁盘 I/O
    const goDirs = new Map(); // dir -> first .go file
    const javaDirs = new Map(); // dir -> first .java file
    const javaClasses = new Map(); // simple class name -> file path (如 "DefaultPlugin" -> ".../DefaultPlugin.java")
    const javaFqns = new Map(); // fully qualified class name -> file path (如 "com.vcp.plugins.impl.DefaultPlugin" -> ".../DefaultPlugin.java")
    const virtualModules = new Map(); // ambient_module name -> defining file path (如 "vcp-virtual-kernel" -> "cataclysm/types.d.ts")
    for (const [p, f] of files.entries()) {
        statCache.set(p, true);
        if (p.endsWith('.go')) {
            const d = path.posix.dirname(p);
            if (!goDirs.has(d)) goDirs.set(d, p);
        } else if (p.endsWith('.java') && !p.endsWith('module-info.java')) {
            const d = path.posix.dirname(p);
            if (!javaDirs.has(d)) javaDirs.set(d, p);
            const className = path.posix.basename(p, '.java');
            if (!javaClasses.has(className)) javaClasses.set(className, p);
            // 依据 package 路径特征智能匹配全限定类名
            const parts = p.split('/');
            for (let i = 0; i < parts.length - 1; i++) {
                if (parts[i] === 'com' || parts[i] === 'org' || parts[i] === 'net' || parts[i] === 'io') {
                    const fqn = parts.slice(i).join('.').replace(/\.java$/, '');
                    javaFqns.set(fqn, p);
                    break;
                }
            }
        }
        for (const g of f.globalsDefined || []) {
            if (g.how === 'ambient_module' && g.name) {
                virtualModules.set(g.name, p);
            }
        }
    }

    // 2. 高性能 go.mod 嗅探：仅检索已由索引器发现的 go.mod 或工程根目录，彻底消灭同步全盘深度扫描！
    const goModules = new Map();
    try {
        const rootMod = path.join(root, 'go.mod');
        if (fs.existsSync(rootMod)) {
            const txt = fs.readFileSync(rootMod, 'utf8');
            const m = /^\s*module\s+([^\s\r\n]+)/m.exec(txt);
            if (m) goModules.set(m[1].trim(), '');
        }
        for (const p of files.keys()) {
            if (p.endsWith('/go.mod') || p === 'go.mod') {
                try {
                    const txt = fs.readFileSync(path.join(root, ...p.split('/')), 'utf8');
                    const m = /^\s*module\s+([^\s\r\n]+)/m.exec(txt);
                    if (m) {
                        const modDir = p === 'go.mod' ? '' : path.posix.dirname(p);
                        goModules.set(m[1].trim(), modDir);
                    }
                } catch (_e) { /* ignore */ }
            }
        }
    } catch (_e) { /* ignore */ }

    // 建立已知工程文件的所有祖先目录集合（O(1) 瞬时剪枝）
    const knownDirs = new Set(['', '.']);
    for (const p of files.keys()) {
        let cur = path.posix.dirname(p);
        while (cur && cur !== '.' && !knownDirs.has(cur)) {
            knownDirs.add(cur);
            cur = path.posix.dirname(cur);
        }
    }

    const isFile = rel => {
        // 纯内存 O(1) 极速短路：已知文件必为 true
        if (files.has(rel)) return true;
        // 剪枝 1：如果其父目录根本不在工程已知目录树中，绝不可能存在，直接 false！
        const parentDir = path.posix.dirname(rel);
        if (!knownDirs.has(parentDir)) return false;

        if (!statCache.has(rel)) {
            let ok = false;
            try { ok = fs.statSync(path.join(root, ...rel.split('/'))).isFile(); } catch (_e) { ok = false; }
            statCache.set(rel, ok);
        }
        return statCache.get(rel);
    };
    // OmniLink 架构跃迁：委托给统一的 LanguageResolver SPI 注册表进行语言自适应寻道
    const resolverContext = {
        isFile,
        virtualModules,
        javaFqns,
        javaClasses,
        javaDirs,
        goDirs,
        goModules,
    };

    const resolveSpec = (fromRel, spec) => {
        return resolverRegistry.resolve(fromRel, spec, resolverContext);
    };
    const resolveSrc = (htmlRel, src) => {
        let s = String(src || '').trim().replace(/[?#].*$/, '');
        try { s = decodeURIComponent(s); } catch (_e) { /* 保留原样 */ }
        if (!s || /^[a-z][a-z0-9+.-]+:/i.test(s) || s.startsWith('//')) return { external: true, spec: src };
        const rel = path.posix.normalize(s.startsWith('/') ? s.slice(1) : path.posix.join(path.posix.dirname(htmlRel), s));
        if (rel.startsWith('../')) return { outside: true, spec: src };
        return { rel, exists: isFile(rel), spec: src };
    };

    // 模块图（Stage 4 边级自洽规范化与严格去重）
    const deps = new Map();
    const rdeps = new Map();
    const unresolvedModules = [];
    const edgeSeen = new Set(); // 边唯一性哈希集合 `${from}->${to}:${line}:${kind}`

    for (const f of files.values()) {
        for (const [kind, list] of [['require', f.requires || []], ['import', f.imports || []]]) {
            for (const r of list) {
                // 过滤标准库尖括号包含（如 <vector>、<iostream>）
                if (r.spec.startsWith('<') && r.spec.endsWith('>')) continue;
                const to = resolveSpec(f.path, r.spec);
                if (to) {
                    // 同一源文件到同一目标文件且在同一行的同类型引用，做严格边去重，彻底铲除循环依赖与多 spec 导致的多重边
                    const edgeKey = `${f.path}->${to}:${r.line}:${kind}`;
                    if (!edgeSeen.has(edgeKey)) {
                        edgeSeen.add(edgeKey);
                        push(deps, f.path, { to, line: r.line, kind });
                        push(rdeps, to, { path: f.path, line: r.line, kind });
                    }
                } else {
                    // 对未在本地找到对应物理文件的相对路径引用、动态导入或虚拟模块，保留为 unresolved 边入图
                    const isRelativeOrDynamic = /^\.\.?(\/|$)/.test(r.spec)
                        || r.spec.endsWith('.h')
                        || r.spec.endsWith('.hpp')
                        || r.spec.startsWith('.')
                        || r.spec.startsWith('virtual:')
                        || r.spec.includes(':')
                        || r.dynamic
                        || f.path.endsWith('.lua');
                    if (isRelativeOrDynamic) {
                        unresolvedModules.push({ path: f.path, line: r.line, spec: r.spec });
                        const unresKey = `${f.path}->unresolved:${r.spec}:${r.line}`;
                        if (!edgeSeen.has(unresKey)) {
                            edgeSeen.add(unresKey);
                            push(deps, f.path, { to: r.spec, line: r.line, kind: r.dynamic ? 'dynamic_import' : `${kind} (unresolved)` });
                        }
                    }
                }
            }
        }
    }

    // 页面图：脚本顺序 + 每个文件属于哪些页面（经由第几个脚本）
    const pages = new Map();
    const membership = new Map();
    const classic = new Map();
    for (const f of files.values()) {
        if (f.kind !== 'html') continue;
        const scripts = (f.scripts || []).map((s, i) => {
            const base = { index: i + 1, line: s.line, module: Boolean(s.module), inline: Boolean(s.inline) };
            return s.inline ? { ...base, rel: f.path, exists: true } : { ...base, ...resolveSrc(f.path, s.src) };
        });
        pages.set(f.path, scripts);
        for (const s of scripts) {
            if (!s.rel || !s.exists) continue;
            if (!s.module && !s.inline) {
                if (!classic.has(s.rel)) classic.set(s.rel, new Set());
                classic.get(s.rel).add(f.path);
            }
            const queue = [s.rel];
            const seen = new Set();
            while (queue.length) {
                const cur = queue.shift();
                if (seen.has(cur)) continue;
                seen.add(cur);
                if (!membership.has(cur)) membership.set(cur, new Map());
                const m = membership.get(cur);
                if (!m.has(f.path)) m.set(f.path, { index: s.index, direct: cur === s.rel });
                for (const d of deps.get(cur) || []) queue.push(d.to);
            }
        }
    }

    // IPC 与桥接
    const registers = new Map();
    const pushes = new Map();
    const directCalls = new Map();
    const dynamic = [];
    const apis = decls?.apis || [];
    const apisByName = new Map(apis.map(a => [a.name, a]));
    const apisByChannel = new Map();
    for (const a of apis) if (a.channel) push(apisByChannel, a.channel, a);
    const roleGlobals = decls?.roleGlobals || DEFAULT_ROLE_GLOBALS;
    const roleByGlobal = Object.fromEntries(Object.entries(roleGlobals).map(([role, g]) => [g, role]));
    const bridgeRefs = new Map();
    const unknownBridge = [];
    const gdefs = new Map();
    const guses = new Map();
    const ffiExports = new Map(); // name -> [{ path, line, lang }]
    for (const f of files.values()) {
        for (const exp of f.ffiExports || []) {
            push(ffiExports, exp.name, { path: f.path, line: exp.line, lang: exp.lang });
        }
    }
    // 页面级桥接别名：经典 <script> / 内联脚本顶层的 `const api = window.utilityAPI || …`，同页其他经典脚本可直接使用
    const rootGlobals = new Set([...Object.values(roleGlobals), COMPAT_GLOBAL]);
    const pageAlias = new Map();
    for (const f of files.values()) {
        for (const a of f.bridgeAliases || []) {
            if (a.topLevel && (f.kind === 'html' || classic.has(f.path))) push(pageAlias, a.name, { object: a.object, path: f.path });
        }
    }
    const pagesOfRel = rel => new Set([...(pages.has(rel) ? [rel] : []), ...(membership.get(rel)?.keys() || [])]);
    const resolveAliasRef = (f, b) => {
        if (rootGlobals.has(b.object)) return b;
        const mine = pagesOfRel(f.path);
        const def = (pageAlias.get(b.object) || []).find(d => d.path === f.path || [...pagesOfRel(d.path)].some(p => mine.has(p)));
        return def ? { ...b, alias: b.object, object: def.object } : null; // 不同页（如主进程里的 api.x）不采纳
    };
    for (const f of files.values()) {
        for (const i of f.ipc || []) {
            const item = { ...i, path: f.path };
            if (i.via === 'param') continue; // 包装函数内部的透传，真实通道已由同文件的 wrapper 调用记录
            if (i.via === 'dynamic' || !i.channel) { dynamic.push(item); continue; }
            if (i.side === 'register') push(registers, i.channel, item);
            else if (i.side === 'push') push(pushes, i.channel, item);
            else push(directCalls, i.channel, item);
        }
        for (const raw of f.bridge || []) {
            const b = resolveAliasRef(f, raw);
            if (!b) continue;
            const item = { ...b, path: f.path };
            if (apisByName.has(b.name)) push(bridgeRefs, b.name, item);
            else if (decls?.status === 'ok') unknownBridge.push(item);
        }
        const isHtml = f.kind === 'html';
        for (const d of f.globalsDefined || []) {
            // window.X 永远是全局；顶层声明只在经典 <script>（非 module、非 require）或页面内联脚本中才是全局
            if (d.how === 'window' || isHtml || classic.has(f.path)) push(gdefs, d.name, { ...d, path: f.path });
        }
        for (const u of f.globalsUsed || []) push(guses, u.name, { ...u, path: f.path });
    }

    return {
        root, files, deps, rdeps, unresolvedModules, pages, membership, classic,
        registers, pushes, directCalls, dynamic, apisByName, apisByChannel, roleGlobals, roleByGlobal,
        bridgeRefs, unknownBridge, gdefs, guses, ffiExports, decls: decls || { status: 'absent' },
        stats: { scanned: factsResult?.scanned || 0, withFacts: files.size, pages: pages.size, truncated: Boolean(factsResult?.truncated) },
    };
}

// ---------------- 查询辅助 ----------------

function loc(x) {
    return `\`${x.path}:${x.line}\`${x.symbol ? ` · in ${x.symbol}` : ''}`;
}

function capped(list, fmt, limit = LIMIT) {
    if (!list.length) return '- 无';
    const rows = list.slice(0, limit).map(fmt);
    if (list.length > limit) rows.push(`- …另有 ${list.length - limit} 处`);
    return rows.join('\n');
}

/** x 在页面中的加载位置（第几个脚本）；x 在页面自身内联脚本中时按行号定位。 */
function positionIn(g, page, x) {
    if (x.path === page) {
        const scripts = g.pages.get(page) || [];
        let idx = null;
        for (const s of scripts) if (s.line <= x.line) idx = s.index;
        return idx;
    }
    return g.membership.get(x.path)?.get(page)?.index ?? null;
}

function pagesOf(g, rel) {
    const own = g.pages.has(rel) ? [rel] : [];
    return [...new Set([...own, ...(g.membership.get(rel)?.keys() || [])])];
}

function pageSuffix(g, rel) {
    const ps = pagesOf(g, rel);
    if (!ps.length) return '';
    return ` · 页面：${ps.slice(0, 4).join('、')}${ps.length > 4 ? ` 等 ${ps.length} 个` : ''}`;
}

function bridgeFlag(g, ref, api) {
    const role = g.roleByGlobal[ref.object];
    if (role) return api.roles.includes(role) ? '' : ` · ⚠️ \`${ref.object}\` 属于 ${role} 角色，该 API 只对 ${api.roles.join('/')} 可见（调用得到 undefined）`;
    return ref.object === COMPAT_GLOBAL ? ` · 兼容层（可见角色：${api.roles.join('/')}；其他角色为隔离桩）` : '';
}

function suggest(keys, q, limit = 10) {
    const lq = String(q).toLowerCase();
    return [...keys].filter(k => k.toLowerCase().includes(lq)).slice(0, limit);
}

// ---------------- Trace ----------------

function traceIpc(g, query) {
    const notes = [];
    let channel = query;
    const known = ch => g.registers.has(ch) || g.apisByChannel.has(ch) || g.pushes.has(ch) || g.directCalls.has(ch);
    if (!known(channel) && g.apisByName.get(query)?.channel) {
        channel = g.apisByName.get(query).channel;
        notes.push(`\`${query}\` 是 preload API 名，对应通道 \`${channel}\``);
    }
    if (!known(channel)) {
        const pool = new Set([...g.registers.keys(), ...g.apisByChannel.keys(), ...g.pushes.keys(), ...g.directCalls.keys(), ...g.apisByName.keys()]);
        const near = suggest(pool, query);
        return {
            found: false,
            text: `## Trace ipc:${query}\n- 未找到该通道或 API。${near.length ? `\n- 相近的：${near.map(n => `\`${n}\``).join('、')}` : ''}\n- 动态通道参数 ${g.dynamic.length} 处无法静态解析（Trace file:… 可查看某文件内的具体位置）。`,
            details: { found: false, suggestions: near },
        };
    }
    const handlers = g.registers.get(channel) || [];
    const apis = g.apisByChannel.get(channel) || [];
    const pushes = g.pushes.get(channel) || [];
    const direct = g.directCalls.get(channel) || [];
    const apiBlocks = apis.map(api => {
        const refs = g.bridgeRefs.get(api.name) || [];
        const label = api.kind === 'subscription' ? '订阅方' : '调用方';
        return [
            `- \`${api.name}\` · ${api.kind} · 角色 ${api.roles.join('/')} · 领域 ${api.domain}（declared）`,
            `  - ${label} ${refs.length} 处：`,
            capped(refs, r => `    - ${loc(r)} · via \`${r.alias ? `${r.alias}（= ${r.object}）` : r.object}\`${bridgeFlag(g, r, api)}${pageSuffix(g, r.path)}`, 20),
        ].join('\n');
    });
    const warnings = [];
    const callers = apis.filter(a => a.kind !== 'subscription').reduce((n, a) => n + (g.bridgeRefs.get(a.name) || []).length, 0)
        + direct.filter(d => d.method !== 'on' && d.method !== 'once').length;
    if (callers && !handlers.length) warnings.push('⚠️ 有调用方但未找到 `ipcMain` 注册（也可能经动态通道注册，见文末）');
    if (!callers && !handlers.length && apis.some(a => a.kind !== 'subscription')) {
        warnings.push('ℹ️ preload 声明了该通道，但既没有主进程 handler 也没有调用方（疑似遗留声明）');
    }
    const handles = handlers.filter(h => /^handle/.test(h.method));
    const listens = handlers.filter(h => !/^handle/.test(h.method));
    if (apis.some(a => a.kind === 'query') && handlers.length && !handles.length) warnings.push('⚠️ preload 以 invoke 调用，但主进程只有 on/once 注册，invoke 会一直等不到返回');
    if (apis.some(a => a.kind === 'command') && handlers.length && !listens.length) warnings.push('⚠️ preload 以 send 调用，但主进程只有 handle 注册，send 不会被处理');
    if (handles.length > 1) warnings.push(`⚠️ 同一通道有 ${handles.length} 处 handle 注册（同时生效时第二次会抛错，请确认是互斥分支）`);
    if (apis.some(a => a.kind === 'subscription') && !pushes.length) warnings.push('⚠️ 有订阅方但未找到 `webContents.send` 推送方（可能经动态通道或其他对象推送）');
    const totalCallers = apis.reduce((n, a) => n + (g.bridgeRefs.get(a.name) || []).length, 0) + direct.length;
    if (!totalCallers && handlers.length) warnings.push('ℹ️ 未找到任何渲染端调用方（可能是死 handler，或由动态通道 / 非桥接写法调用）');
    const text = [
        `## Trace ipc:${channel}`,
        ...notes.map(n => `- ${n}`),
        `### 主进程 handler（${handlers.length}）`,
        capped(handlers, h => `- ${loc(h)} · ipcMain.${h.method}（${h.via}${h.expr ? ` ${h.expr}` : ''}）`),
        `### preload 暴露（${apis.length}）`,
        apiBlocks.join('\n') || (g.decls.status === 'ok' ? '- 无（该通道未进入 preload 声明表）' : `- 声明表不可用（${g.decls.status}${g.decls.error ? `：${g.decls.error}` : ''}）`),
        `### 直接 ipcRenderer 调用（${direct.length}）`,
        capped(direct, d => `- ${loc(d)} · ipcRenderer.${d.method}（${d.via}）${pageSuffix(g, d.path)}`),
        `### 推送方 webContents.send（${pushes.length}）`,
        capped(pushes, p => `- ${loc(p)} · ${p.method}（${p.via}）`),
        warnings.length ? `### 检查\n${warnings.map(w => `- ${w}`).join('\n')}` : '',
        g.dynamic.length ? `- 全局另有 ${g.dynamic.length} 处动态通道参数无法静态解析（unresolved），不计入上表。` : '',
    ].filter(Boolean).join('\n');
    return {
        found: true, text,
        details: { channel, handlers, apis: apis.map(a => ({ ...a, callers: g.bridgeRefs.get(a.name) || [] })), direct, pushes, warnings },
    };
}

function traceGlobal(g, name) {
    const defs = g.gdefs.get(name) || [];
    const uses = g.guses.get(name) || [];
    if (!defs.length && !uses.length) {
        const near = suggest(new Set([...g.gdefs.keys(), ...g.guses.keys()]), name);
        return { found: false, text: `## Trace global:${name}\n- 未找到 \`window.${name}\` 的定义或使用。${near.length ? `\n- 相近的：${near.map(n => `\`${n}\``).join('、')}` : ''}`, details: { found: false, suggestions: near } };
    }
    const warnings = [];
    const pageSet = new Set([...defs, ...uses].flatMap(x => pagesOf(g, x.path)));
    const perPage = [];
    for (const page of [...pageSet].sort()) {
        const defPos = defs.map(d => positionIn(g, page, d)).filter(v => v !== null);
        const usePos = uses.map(u => ({ u, pos: positionIn(g, page, u) })).filter(x => x.pos !== null);
        const first = defPos.length ? Math.min(...defPos) : null;
        perPage.push(`- \`${page}\`：定义于第 ${first ?? '—'} 个脚本 · 本页使用 ${usePos.length} 处`);
        if (usePos.length && first === null && defs.length) warnings.push(`⚠️ \`${page}\` 使用了 \`${name}\`，但本页未加载任何定义它的脚本`);
        for (const { u, pos } of usePos) {
            if (first !== null && pos < first) warnings.push(`⚠️ \`${page}\`：${loc(u)} 所在脚本（第 ${pos} 个）早于定义脚本（第 ${first} 个）加载；若在顶层同步执行会取到 undefined`);
        }
    }
    const text = [
        `## Trace global:${name}`,
        `### 定义（${defs.length}）`,
        capped(defs, d => `- ${loc(d)} · ${d.how === 'window' ? `window.${name} =` : `顶层 ${d.how}`}${pageSuffix(g, d.path)}`),
        `### 使用 \`window.${name}\`（${uses.length}，只统计显式 window./globalThis. 访问）`,
        capped(uses, u => `- ${loc(u)}${pageSuffix(g, u.path)}`),
        perPage.length ? `### 按页面\n${perPage.join('\n')}` : '',
        warnings.length ? `### 检查\n${capped(warnings, w => `- ${w}`)}` : '',
        !defs.length ? '- ⚠️ 未找到定义（可能由第三方库、非 window.X 写法或 module 脚本定义）' : '',
    ].filter(Boolean).join('\n');
    return { found: true, text, details: { name, defs, uses, warnings } };
}

function findPage(g, q) {
    const target = String(q).replace(/\\/g, '/').replace(/^\.\//, '');
    if (g.pages.has(target)) return { page: target };
    const cands = [...g.pages.keys()].filter(p => p.endsWith(`/${target}`) || path.posix.basename(p) === target);
    if (cands.length === 1) return { page: cands[0] };
    return { candidates: cands.length ? cands : suggest(g.pages.keys(), path.posix.basename(target)) };
}

function closure(g, start) {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
        const cur = queue.shift();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const d of g.deps.get(cur) || []) queue.push(d.to);
    }
    seen.delete(start);
    return seen;
}

function tracePage(g, q) {
    const { page, candidates } = findPage(g, q);
    if (!page) {
        return { found: false, text: `## Trace page:${q}\n- ${candidates.length ? `未唯一确定页面，候选：${candidates.map(c => `\`${c}\``).join('、')}` : '未找到该 HTML 页面（或页面内没有 <script>）'}`, details: { found: false, candidates } };
    }
    const scripts = g.pages.get(page);
    const rows = scripts.map(s => {
        if (s.inline) return `${s.index}. （内联${s.module ? ' module' : ''}脚本）· L${s.line}`;
        if (s.external) return `${s.index}. ${s.spec} · 外部资源 · L${s.line}`;
        if (s.outside) return `${s.index}. ${s.spec} · ⚠️ 越出扫描根 · L${s.line}`;
        const dep = s.exists ? closure(g, s.rel).size : 0;
        return `${s.index}. \`${s.rel}\`${s.module ? ' · module' : ''} · L${s.line}${s.exists ? (dep ? ` · 依赖闭包 ${dep} 个文件` : '') : ' · ⚠️ 文件不存在'}`;
    });
    const members = [...g.membership.entries()].filter(([, m]) => m.has(page)).map(([rel]) => rel);
    const memberSet = new Set([...members, page]);
    const injected = [];
    for (const [name, defs] of g.gdefs) {
        const d = defs.find(x => memberSet.has(x.path));
        if (d) injected.push({ name, ...d, pos: positionIn(g, page, d) });
    }
    injected.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.name.localeCompare(b.name));
    const bridgeUsed = new Map();
    const unknown = [];
    for (const rel of memberSet) {
        for (const b of g.files.get(rel)?.bridge || []) {
            const api = g.apisByName.get(b.name);
            if (!api) { if (g.decls.status === 'ok') unknown.push({ ...b, path: rel }); continue; }
            push(bridgeUsed, b.object, b.name);
        }
    }
    const text = [
        `## Trace page:${page}`,
        `### 脚本加载顺序（${scripts.length}）`,
        rows.join('\n') || '- 无',
        `- 页面共加载 ${members.length} 个本地文件（含 require/import 闭包）。`,
        `### 页面内注入的全局（${injected.length}，按加载位置）`,
        capped(injected, x => `- \`${x.name}\` · 第 ${x.pos ?? '?'} 个脚本 · ${loc(x)}`, 60),
        `### preload 桥接使用`,
        [...bridgeUsed].map(([obj, names]) => `- \`${obj}\`：${new Set(names).size} 个 API（${names.length} 处调用）`).join('\n') || '- 无',
        unknown.length ? `### ⚠️ 调用了声明表中不存在的 API（${unknown.length}）\n${capped(unknown, u => `- ${loc(u)} · \`${u.object}.${u.name}\``)}` : '',
    ].filter(Boolean).join('\n');
    return { found: true, text, details: { page, scripts, members, injected: injected.map(x => x.name), unknownBridge: unknown } };
}

function traceFile(g, rel) {
    const f = g.files.get(rel);
    if (!f) {
        // 兼容 go.mod 与 module-info.java 等纯模块顶层事实文件
        try {
            const rawAbs = path.join(g.root, ...rel.split('/'));
            if (fs.existsSync(rawAbs)) {
                const txt = fs.readFileSync(rawAbs, 'utf8');
                if (txt.includes('module ')) {
                    return {
                        found: true,
                        text: `## Trace file:${rel}\n### 模块声明\n- ${txt.split('\n').find(l => l.trim().startsWith('module ')) || txt.slice(0, 100)}`,
                        details: { path: rel }
                    };
                }
            }
        } catch (_e) { /* ignore */ }
        return { found: false, text: `## Trace file:${rel}\n- 该文件没有可提取的链路事实（或被忽略规则排除，或没有任何引用/导出/全局声明）。`, details: { found: false } };
    }
    const ipc = f.ipc || [];
    const ch = i => i.channel ? `\`${i.channel}\`` : `⚠️ 动态 \`${i.expr}\``;
    const bridge = (f.bridge || []).map(b => {
        const api = g.apisByName.get(b.name);
        const tail = api ? ` → \`${api.channel || '（非 IPC）'}\` · ${api.kind}${bridgeFlag(g, b, api)}` : (g.decls.status === 'ok' ? ' · ⚠️ 声明表中不存在' : '');
        return `- \`${b.alias || b.object}.${b.name}\`${b.alias ? `（${b.alias} = ${b.object}）` : ''} · L${b.line}${b.symbol ? ` · in ${b.symbol}` : ''}${tail}`;
    });
    const members = [...(g.membership.get(rel) || new Map())].map(([page, m]) => `- \`${page}\` · 第 ${m.index} 个脚本${m.direct ? '（直接）' : '（经 require/import）'}`);
    const text = [
        `## Trace file:${rel}`,
        `### 被页面加载（${members.length}）`,
        members.join('\n') || '- 无（主进程文件、preload 或未被任何页面引用）',
        (() => {
            const rawDeps = g.deps.get(rel) || [];
            const rawRdeps = g.rdeps.get(rel) || [];
            const normDeps = [];
            const seenD = new Set();
            for (const d of rawDeps) {
                const k = `${d.to}:${d.line}:${d.kind}`;
                if (!seenD.has(k)) { seenD.add(k); normDeps.push(d); }
            }
            const normRdeps = [];
            const seenR = new Set();
            for (const d of rawRdeps) {
                const k = `${d.path}:${d.line}:${d.kind}`;
                if (!seenR.has(k)) { seenR.add(k); normRdeps.push(d); }
            }
            return [
                `### 依赖（${normDeps.length}） / 被依赖（${normRdeps.length}）`,
                capped(normDeps, d => `- → \`${d.to}\` · L${d.line} · ${d.kind}`, 20),
                capped(normRdeps, d => `- ← \`${d.path}:${d.line}\` · ${d.kind}`, 20),
            ].join('\n');
        })(),
        `### IPC 注册（${ipc.filter(i => i.side === 'register').length}）`,
        capped(ipc.filter(i => i.side === 'register'), i => `- ${ch(i)} · ipcMain.${i.method} · L${i.line}${i.symbol ? ` · in ${i.symbol}` : ''}`, 60),
        `### IPC 推送 / 直接调用（${ipc.filter(i => i.side !== 'register').length}）`,
        capped(ipc.filter(i => i.side !== 'register'), i => `- ${ch(i)} · ${i.side === 'push' ? i.method : `ipcRenderer.${i.method}`} · L${i.line}${i.symbol ? ` · in ${i.symbol}` : ''}`),
        `### preload 桥接调用（${bridge.length}）`,
        capped(bridge, x => x),
        `### 全局 定义 ${(f.globalsDefined || []).filter(d => d.how === 'window' || d.how === 'module' || f.kind === 'html' || g.classic.has(rel)).length} / 使用 ${(f.globalsUsed || []).length}`,
        capped((f.globalsDefined || []).filter(d => d.how === 'window' || d.how === 'module' || f.kind === 'html' || g.classic.has(rel)), d => `- 定义 \`${d.name}\` · ${d.how} · L${d.line}`, 20),
        capped(f.globalsUsed || [], u => `- 使用 \`window.${u.name}\` · L${u.line}`, 20),
        (f.exposes || []).length ? `### exposeInMainWorld\n${f.exposes.map(e => `- \`${e.name}\` · L${e.line} · 键：${e.keys.join('、') || '（非字面量对象）'}`).join('\n')}` : '',
        (f.ffiExports || []).length ? `### FFI 导出符号声明（${f.ffiExports.length}）\n${f.ffiExports.map(e => `- \`${e.name}\` · L${e.line} · extern "C"`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    return { found: true, text, details: { path: rel, facts: f, pages: [...(g.membership.get(rel)?.keys() || [])] } };
}

function traceFfi(g, name) {
    const hits = g.ffiExports.get(name) || [];
    if (!hits.length) {
        return {
            found: false,
            text: `## Trace ffi:${name}\n- 未找到导出名为 \`${name}\` 的 FFI 符号（需声明为 Rust \`extern "C"\` 或 C/C++ \`extern "C"\`）。`,
            details: { found: false, name },
        };
    }
    const lines = hits.map(h => `- \`${h.path}:${h.line}\` · \`${h.lang}\` · extern "C"`);
    const text = [
        `## Trace ffi:${name}`,
        `### FFI 导出符号声明（${hits.length} 处）`,
        lines.join('\n'),
    ].join('\n');
    return { found: true, text, details: { found: true, name, hits } };
}

const TRACE_KINDS = ['ipc', 'api', 'global', 'page', 'file', 'ffi'];
exports.TRACE_KINDS = TRACE_KINDS;

function parseTarget(raw) {
    const m = /^\s*([a-z]+)\s*:\s*(.+?)\s*$/i.exec(String(raw || ''));
    if (!m || !TRACE_KINDS.includes(m[1].toLowerCase())) return null;
    return { kind: m[1].toLowerCase(), value: m[2] };
}

function trace(g, kind, value) {
    if (kind === 'ipc' || kind === 'api') return traceIpc(g, value);
    if (kind === 'global') return traceGlobal(g, value.replace(/^window\./, ''));
    if (kind === 'page') return tracePage(g, value);
    if (kind === 'file') return traceFile(g, value);
    if (kind === 'ffi') return traceFfi(g, value);
    throw new Error(`未知 Trace 类型：${kind}`);
}

module.exports = {
    TRACE_KINDS, COMPAT_GLOBAL, DEFAULT_ROLE_GLOBALS,
    loadPreloadDecls, bridgeGlobalsOf, aliasNames, buildGraph, parseTarget, trace,
    _test: { declCache, positionIn, findPage },
};