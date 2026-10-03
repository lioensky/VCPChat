'use strict';

/**
 * ProjectForge OmniLink - 语言模块解析器 SPI (LanguageResolver SPI)
 * 遵循代数图论正交解耦原则：
 * 1. 语法事实 (Facts) 负责由 Tree-Sitter 提取规范符号；
 * 2. 语言解析驱动 (Resolvers) 负责各语言规范级路径寻道；
 * 3. 图求解器 (LinkGraph) 负责拓扑闭包装配。
 */

const path = require('path');

// 语言扩展名亲和定义
const JS_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
const C_CPP_EXT = ['.h', '.hpp', '.c', '.cpp', '.cc', '.cxx', '.inl', '.cppm'];
// 基础扩展名定义已按驱动就地内聚维护

/**
 * 语言解析驱动抽象基类
 */
class BaseLanguageResolver {
    constructor(name) {
        this.name = name;
    }

    /**
     * @param {string} fromRel 调用者文件相对路径（如 src/main.cpp）
     * @param {string} spec 导入/包含声明字符串（如 ./helper, crate::pipeline, <vector>）
     * @param {object} ctx 工程级上下文 (isFile, isDir, virtualModules, etc.)
     * @returns {string|null} 解析出的目标文件相对路径，无法解析时返回 null
     */
    resolve() {
        throw new Error(`[LanguageResolver] ${this.name} must implement resolve()`);
    }
}

/**
 * 1. Node.js / TypeScript 模块解析驱动 (Tier 1)
 */
class NodeLanguageResolver extends BaseLanguageResolver {
    constructor() {
        super('Node/TypeScript');
    }

    resolve(fromRel, spec, ctx) {
        // 虚拟模块直接映射（如 TypeScript 的 declare module "vcp-virtual-kernel"）
        if (ctx.virtualModules && ctx.virtualModules.has(spec)) {
            return ctx.virtualModules.get(spec);
        }

        const fromDir = path.posix.dirname(fromRel);
        const candidates = [];

        if (spec.startsWith('.')) {
            // 相对路径导入
            const norm = path.posix.normalize(path.posix.join(fromDir, spec));
            candidates.push(norm);
            for (const ext of JS_EXT) {
                candidates.push(norm + ext);
                candidates.push(path.posix.join(norm, `index${ext}`));
            }
        } else {
            // 根级绝对或别名导入
            candidates.push(spec);
            for (const ext of JS_EXT) {
                candidates.push(spec + ext);
                candidates.push(path.posix.join(spec, `index${ext}`));
            }
        }

        for (const cand of candidates) {
            if (ctx.isFile(cand)) return cand;
        }
        return null;
    }
}

/**
 * 2. C / C++ 头文件与模块包含解析驱动 (Tier 1)
 */
class CppLanguageResolver extends BaseLanguageResolver {
    constructor() {
        super('C/C++');
    }

    resolve(fromRel, spec, ctx) {
        // 系统/标准库尖括号包含（如 <vector>, <stdio.h>）直接滤除，不入本地代码拓扑
        if (spec.startsWith('<') && spec.endsWith('>')) {
            return null;
        }

        const clean = spec.replace(/^["']|["']$/g, '').trim();
        const fromDir = path.posix.dirname(fromRel);

        // C/C++ 常见包含搜索根
        const searchRoots = [
            fromDir,
            '',
            'include',
            'src',
            'src/include',
        ];

        for (const root of searchRoots) {
            const cand = path.posix.normalize(root ? path.posix.join(root, clean) : clean);
            if (ctx.isFile(cand)) return cand;
            for (const ext of C_CPP_EXT) {
                if (ctx.isFile(cand + ext)) return cand + ext;
            }
        }
        return null;
    }
}

/**
 * 3. Rust 模块树与 Crate 双冒号寻道驱动 (Tier 1)
 */
class RustLanguageResolver extends BaseLanguageResolver {
    constructor() {
        super('Rust');
    }

    resolve(fromRel, spec, ctx) {
        const fromDir = path.posix.dirname(fromRel);

        if (spec.includes('::')) {
            const parts = spec.split('::').filter(Boolean);
            const roots = [];
            let segs = parts;

            if (parts[0] === 'crate') {
                roots.push('', 'src', fromDir);
                segs = parts.slice(1);
            } else if (parts[0] === 'super') {
                // 在子模块文件（如 core/session.rs）中，super::worker::Task 指代所属父模块目录下的 worker.rs 或 worker/mod.rs
                segs = parts.slice(1);
                if (segs.length > 0) {
                    // 后续有具体子项（如 super::worker::Task），以当前模块所属目录 fromDir 作为第一探测根
                    roots.push(fromDir, path.posix.dirname(fromDir));
                } else {
                    // 裸 super 指代当前模块父入口
                    if (ctx.isFile(path.posix.join(fromDir, 'mod.rs'))) {
                        return path.posix.normalize(path.posix.join(fromDir, 'mod.rs'));
                    }
                    roots.push(fromDir, path.posix.dirname(fromDir));
                }
            } else {
                roots.push(fromDir, '', 'src');
            }
            // 逐级回退：如 crate::pipeline::executor 依次探测 pipeline/executor.rs 与 pipeline.rs
            const minLen = Math.max(1, segs.length - 8);
            for (let len = segs.length; len >= minLen; len--) {
                const subPath = segs.slice(0, len).join('/');
                for (const r of roots) {
                    const base = path.posix.normalize(r ? path.posix.join(r, subPath) : subPath);
                    if (ctx.isFile(`${base}.rs`)) return `${base}.rs`;
                    if (ctx.isFile(`${base}/mod.rs`)) return `${base}/mod.rs`;
                }
            }
            if (parts[0] === 'super') {
                if (ctx.isFile(path.posix.join(fromDir, 'mod.rs'))) {
                    return path.posix.normalize(path.posix.join(fromDir, 'mod.rs'));
                }
            }
        } else if (spec.startsWith('.')) {
            const norm = path.posix.normalize(path.posix.join(fromDir, spec));
            if (ctx.isFile(`${norm}.rs`)) return `${norm}.rs`;
            if (ctx.isFile(`${norm}/mod.rs`)) return `${norm}/mod.rs`;
        } else {
            // 普通单标识符模块声明（如 lib.rs 里的 pub mod core; 或 core/mod.rs 里的 pub mod session;）
            // 优先在当前源文件所在目录下探测同名 .rs 单文件模块或同名目录包入口 /mod.rs
            const cand = path.posix.normalize(path.posix.join(fromDir, spec));
            if (ctx.isFile(`${cand}.rs`)) return `${cand}.rs`;
            if (ctx.isFile(`${cand}/mod.rs`)) return `${cand}/mod.rs`;
            // 次级在工程根或 src 目录下探测
            if (ctx.isFile(`${spec}.rs`)) return `${spec}.rs`;
            if (ctx.isFile(`${spec}/mod.rs`)) return `${spec}/mod.rs`;
            if (ctx.isFile(`src/${spec}.rs`)) return `src/${spec}.rs`;
            if (ctx.isFile(`src/${spec}/mod.rs`)) return `src/${spec}/mod.rs`;
        }
        return null;
    }
}

/**
 * 4. Python 包与模块解析驱动 (Tier 2)
 */
class PythonLanguageResolver extends BaseLanguageResolver {
    constructor() {
        super('Python');
    }

    resolve(fromRel, spec, ctx) {
        const fromDir = path.posix.dirname(fromRel);

        // 相对导入：from . import core, from ..pkg import util
        if (spec.startsWith('.')) {
            let dotCount = 0;
            while (dotCount < spec.length && spec[dotCount] === '.') {
                dotCount++;
            }
            const remainder = spec.slice(dotCount);
            let targetDir = fromDir;
            for (let i = 1; i < dotCount; i++) {
                targetDir = path.posix.dirname(targetDir);
            }

            if (!remainder) {
                // from . import ... 当前目录包入口探测
                if (ctx.isFile(path.posix.join(targetDir, '__init__.py'))) {
                    return path.posix.normalize(path.posix.join(targetDir, '__init__.py'));
                }
                return null;
            }

            const parts = remainder.split('.').filter(Boolean);
            // 逐级回退
            for (let len = parts.length; len >= 1; len--) {
                const relPath = parts.slice(0, len).join('/');
                const base = path.posix.normalize(path.posix.join(targetDir, relPath));
                // 规范亲和阶梯（PEP 420）：包目录入口（core/__init__.py）优先于同名单文件模块（core.py）
                if (ctx.isFile(`${base}/__init__.py`)) return `${base}/__init__.py`;
                if (ctx.isFile(`${base}.py`)) return `${base}.py`;
            }
        } else {
            // 点分导入或同级直接导入：import core 或 from core import run
            const parts = spec.split('.').filter(Boolean);
            const searchRoots = [fromDir, ''];
            for (const r of searchRoots) {
                for (let len = parts.length; len >= 1; len--) {
                    const relPath = parts.slice(0, len).join('/');
                    const base = path.posix.normalize(r ? path.posix.join(r, relPath) : relPath);
                    // 规范亲和阶梯（PEP 420）：包目录入口优先于单文件模块
                    if (ctx.isFile(`${base}/__init__.py`)) return `${base}/__init__.py`;
                    if (ctx.isFile(`${base}.py`)) return `${base}.py`;
                }
            }
        }
        return null;
    }
}

/**
 * 5. Java 类路径与包解析驱动 (Tier 3)
 */
class JavaLanguageResolver extends BaseLanguageResolver {
    constructor() {
        super('Java');
    }

    resolve(fromRel, spec, ctx) {
        const fromDir = path.posix.dirname(fromRel);
        // 0. 同目录同包隐式类名探测（Package-private / Same-package implicit resolution）
        if (!spec.includes('.')) {
            const samePkgCand = path.posix.normalize(path.posix.join(fromDir, `${spec}.java`));
            if (ctx.isFile(samePkgCand)) {
                return samePkgCand;
            }
        }
        // 1. 全限定名瞬时对账
        if (ctx.javaFqns && ctx.javaFqns.has(spec)) {
            return ctx.javaFqns.get(spec);
        }
        // 1.1 静态导入（import static pkg.Cls.method）剥离末尾成员方法/字段后对账
        const strippedStatic = spec.replace(/\.[a-zA-Z0-9_$]+$/, '');
        if (strippedStatic && ctx.javaFqns && ctx.javaFqns.has(strippedStatic)) {
            return ctx.javaFqns.get(strippedStatic);
        }

        // 2. 简单类名对账（如 permits DefaultPlugin 或 import static MathUtil.add）
        if (ctx.javaClasses && ctx.javaClasses.has(spec)) {
            return ctx.javaClasses.get(spec);
        }
        const lastPart = spec.split('.').pop();
        if (lastPart && ctx.javaClasses && ctx.javaClasses.has(lastPart)) {
            return ctx.javaClasses.get(lastPart);
        }
        const secondLastPart = strippedStatic.split('.').pop();
        if (secondLastPart && ctx.javaClasses && ctx.javaClasses.has(secondLastPart)) {
            return ctx.javaClasses.get(secondLastPart);
        }

        // 3. 点分包转路径对账
        const clean = (strippedStatic || spec).replace(/\.\*$/, '');
        const asPath = clean.replace(/\./g, '/');
        const roots = ['', 'src/main/java', 'src', 'src_java', path.posix.dirname(fromRel)];
        for (const r of roots) {
            const cand = path.posix.normalize(r ? path.posix.join(r, asPath) : asPath);
            if (ctx.isFile(`${cand}.java`)) return `${cand}.java`;
            if (ctx.javaDirs && ctx.javaDirs.has(cand)) return ctx.javaDirs.get(cand);
        }
        return null;
    }
}

/**
 * 6. Go 模块与目录包解析驱动 (Tier 3)
 */
class GoLanguageResolver extends BaseLanguageResolver {
    constructor() {
        super('Go');
    }

    resolve(fromRel, spec, ctx) {
        const fromDir = path.posix.dirname(fromRel);
        if (spec.startsWith('.')) {
            const norm = path.posix.normalize(path.posix.join(fromDir, spec));
            if (ctx.goDirs && ctx.goDirs.has(norm)) return ctx.goDirs.get(norm);
            return null;
        }

        // go.mod 前缀匹配映射
        if (ctx.goModules) {
            for (const [modName, modSubDir] of ctx.goModules) {
                if (spec === modName || spec.startsWith(`${modName}/`)) {
                    const rem = spec.slice(modName.length).replace(/^\/+/, '');
                    const mapped = modSubDir ? (rem ? path.posix.join(modSubDir, rem) : modSubDir) : rem;
                    if (mapped && ctx.goDirs && ctx.goDirs.has(mapped)) {
                        return ctx.goDirs.get(mapped);
                    }
                }
            }
        }
        return null;
    }
}

/**
 * 7. Lua 模块解析驱动 (Tier 3)
 */
class LuaLanguageResolver extends BaseLanguageResolver {
    constructor() {
        super('Lua');
    }

    resolve(fromRel, spec, ctx) {
        // Lua 惯例：require("vcp.network") -> vcp/network.lua 或 vcp/network/init.lua
        const clean = spec.replace(/\\/g, '/');
        const asPath = clean.replace(/\./g, '/');
        const roots = ['', path.posix.dirname(fromRel), 'src', 'src_lua'];
        for (const r of roots) {
            const base = path.posix.normalize(r ? path.posix.join(r, asPath) : asPath);
            if (ctx.isFile(`${base}.lua`)) return `${base}.lua`;
            if (ctx.isFile(`${base}/init.lua`)) return `${base}/init.lua`;
        }
        return null;
    }
}
/**
 * OmniLink 统一解析器注册中心 (Resolver Registry)
 */
class LanguageResolverRegistry {
    constructor() {
        this.resolvers = new Map();
        this.extensionMap = new Map();

        // 实例化各语言驱动
        const nodeRes = new NodeLanguageResolver();
        const cppRes = new CppLanguageResolver();
        const rustRes = new RustLanguageResolver();
        const pyRes = new PythonLanguageResolver();
        const javaRes = new JavaLanguageResolver();
        const goRes = new GoLanguageResolver();
        const luaRes = new LuaLanguageResolver();

        // 注册扩展名与驱动绑定
        this.register(nodeRes, ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html']);
        this.register(cppRes, ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.inl', '.cppm']);
        this.register(rustRes, ['.rs']);
        this.register(pyRes, ['.py']);
        this.register(javaRes, ['.java']);
        this.register(goRes, ['.go']);
        this.register(luaRes, ['.lua']);
    }
    register(resolver, extensions) {
        this.resolvers.set(resolver.name, resolver);
        for (const ext of extensions) {
            this.extensionMap.set(ext.toLowerCase(), resolver);
        }
    }

    /**
     * 统一入口：根据调用者语言自适应路由
     */
    resolve(fromRel, spec, ctx) {
        if (!spec) return null;
        const ext = path.posix.extname(fromRel).toLowerCase();
        const resolver = this.extensionMap.get(ext);
        if (resolver) {
            const hit = resolver.resolve(fromRel, spec, ctx);
            if (hit) return hit;
        }

        // 通用兜底探测（容错未识别扩展名或通用相对包含）
        if (spec.startsWith('.')) {
            const fromDir = path.posix.dirname(fromRel);
            const direct = path.posix.normalize(path.posix.join(fromDir, spec));
            if (ctx.isFile(direct)) return direct;
        }
        return null;
    }
}

const defaultRegistry = new LanguageResolverRegistry();

module.exports = {
    BaseLanguageResolver,
    NodeLanguageResolver,
    CppLanguageResolver,
    RustLanguageResolver,
    PythonLanguageResolver,
    JavaLanguageResolver,
    GoLanguageResolver,
    LanguageResolverRegistry,
    defaultRegistry,
};