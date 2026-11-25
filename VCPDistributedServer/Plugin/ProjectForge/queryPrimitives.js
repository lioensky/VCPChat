'use strict';

/**
 * ProjectForge query primitives.
 *
 * createPrimitives({ root, indexer, signal, limits }) resolves to a frozen
 * object with exactly six enumerable methods:
 *   files(glob), search(query, opts), read(target), outline(targetPath),
 *   symbols(opts), graph(glob?)
 *
 * The returned q.graph() value is deliberately plain JSON. queryWorker.cjs
 * rebuilds depsOf()/rdepsOf()/files()/ipc() on the worker side; keeping the
 * host result serializable makes the RPC boundary explicit and testable.
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const linkGraph = require('./linkGraph');
const { scanWorkspace } = require('../../../modules/services/workspaceIndex.js');

const DEFAULT_LIMITS = Object.freeze({
    maxPrimitiveSteps: 64,
    maxFiles: 5000,
    maxSearchResults: 50,
    maxContextLines: 20,
    maxFileBytes: 256 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
    maxAstFileBytes: 8 * 1024 * 1024,
    maxSymbolResults: 200,
    preloadTimeoutMs: 5000,
});

function toPosixRel(value) {
    return String(value == null ? '' : value)
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');
}

function inside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function escapesRoot(rel) {
    return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

function positiveInt(value, fallback, min = 1) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.floor(n));
}

function clampInt(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null) return value;
    }
    return undefined;
}

function normalizeLimits(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return Object.freeze({
        maxPrimitiveSteps: positiveInt(source.maxPrimitiveSteps, DEFAULT_LIMITS.maxPrimitiveSteps, 1),
        maxFiles: positiveInt(source.maxFiles, DEFAULT_LIMITS.maxFiles, 1),
        maxSearchResults: positiveInt(source.maxSearchResults, DEFAULT_LIMITS.maxSearchResults, 1),
        maxContextLines: positiveInt(source.maxContextLines, DEFAULT_LIMITS.maxContextLines, 0),
        maxFileBytes: positiveInt(source.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 1),
        maxTotalBytes: positiveInt(source.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes, 1),
        maxAstFileBytes: positiveInt(source.maxAstFileBytes, DEFAULT_LIMITS.maxAstFileBytes, 1),
        maxSymbolResults: positiveInt(source.maxSymbolResults, DEFAULT_LIMITS.maxSymbolResults, 1),
        preloadTimeoutMs: positiveInt(source.preloadTimeoutMs, DEFAULT_LIMITS.preloadTimeoutMs, 1),
    });
}

function splitGlobPatterns(glob) {
    const text = String(glob || '').trim();
    if (!text) return [];
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
        if (ch === '{') depth += 1;
        else if (ch === '}' && depth > 0) depth -= 1;
        if (ch === ',' && depth === 0) {
            if (current.trim()) parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function matchSimpleGlob(relPath, glob) {
    if (glob === undefined || glob === null) return true;
    if (typeof glob !== 'string') throw new Error('glob must be a string');
    const cleanGlob = glob.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!cleanGlob || cleanGlob === '*' || cleanGlob === '**/*') return true;
    let regexStr = '';
    for (let i = 0; i < cleanGlob.length; i++) {
        const ch = cleanGlob[i];
        if (ch === '{') {
            const close = cleanGlob.indexOf('}', i + 1);
            if (close !== -1) {
                const alts = cleanGlob.slice(i + 1, close).split(',').map((part) =>
                    part.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&'));
                regexStr += `(?:${alts.join('|')})`;
                i = close;
                continue;
            }
        }
        if (ch === '*') {
            if (cleanGlob[i + 1] === '*') {
                if (cleanGlob[i + 2] === '/') {
                    regexStr += '(?:.+/)?';
                    i += 2;
                } else {
                    regexStr += '.*';
                    i += 1;
                }
            } else {
                regexStr += '[^/]*';
            }
        } else if (ch === '?') {
            regexStr += '[^/]';
        } else if ('.+^$()|[]\\{}'.includes(ch)) {
            regexStr += '\\' + ch;
        } else {
            regexStr += ch;
        }
    }
    return new RegExp(`^${regexStr}$`, 'i').test(toPosixRel(relPath));
}

function matchGlobList(relPath, glob) {
    if (glob === undefined || glob === null) return true;
    if (typeof glob !== 'string') throw new Error('glob must be a string');
    const patterns = splitGlobPatterns(glob);
    if (patterns.length === 0) return true;
    return patterns.some((pattern) => matchSimpleGlob(relPath, pattern));
}

function escapeRegExpText(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function projectSymbol(symbol) {
    const source = symbol && typeof symbol === 'object' ? symbol : {};
    const projected = {
        name: source.name || '',
        qualifiedName: source.qualified || source.qualifiedName || source.name || '',
        kind: source.kind || 'unknown',
        startLine: Number(source.start ?? source.startLine) || 0,
        endLine: Number(source.end ?? source.endLine) || 0,
    };
    if (source.signature) projected.signature = source.signature;
    return projected;
}

async function readLineRange(absPath, displayPath, startLine, endLine, maxBytes, signal) {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
        throw new Error(`q.read: "${displayPath}" is not a regular file`);
    }
    if (stat.size === 0) {
        throw new Error(`q.read: line range ${startLine}-${endLine} is out of range for "${displayPath}" (0 lines)`);
    }

    const stream = fsSync.createReadStream(absPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const collected = [];
    let lineNo = 0;
    let bytes = 0;
    try {
        for await (const line of rl) {
            if (signal && signal.aborted) throw new Error('QUERY_ABORTED: q.read 已被取消');
            lineNo += 1;
            if (lineNo >= startLine && lineNo <= endLine) {
                const lineBytes = Buffer.byteLength(line, 'utf8');
                if (bytes + lineBytes > maxBytes) {
                    throw new Error(`q.read: line slice "${displayPath}:${startLine}-${endLine}" exceeds ${maxBytes} bytes limit`);
                }
                bytes += lineBytes;
                collected.push(line);
            }
            if (lineNo > endLine) break;
        }
    } finally {
        rl.close();
        stream.destroy();
    }
    if (startLine > lineNo) {
        throw new Error(`q.read: line range ${startLine}-${endLine} is out of range for "${displayPath}" (${lineNo} lines)`);
    }
    return { text: collected.join('\n'), bytes };
}

function extractIpc(g, filesMap) {
    const out = [];
    const pushEntry = (item, direction, defaultSide) => {
        if (!item || !item.channel || item.via === 'param' || item.via === 'dynamic') return;
        out.push({
            channel: String(item.channel),
            direction,
            side: String(item.side || defaultSide || ''),
            method: String(item.method || ''),
            path: toPosixRel(item.path),
            line: Number(item.line) || 0,
        });
    };

    if (g.registers instanceof Map || g.pushes instanceof Map || g.directCalls instanceof Map) {
        if (g.registers instanceof Map) {
            for (const list of g.registers.values()) {
                for (const item of list || []) {
                    pushEntry(item, /^on/i.test(item.method || '') ? 'on' : 'handle', 'register');
                }
            }
        }
        if (g.pushes instanceof Map) {
            for (const list of g.pushes.values()) {
                for (const item of list || []) pushEntry(item, 'send', 'push');
            }
        }
        if (g.directCalls instanceof Map) {
            for (const list of g.directCalls.values()) {
                for (const item of list || []) {
                    pushEntry(item, /^on/i.test(item.method || '') ? 'on' : 'send', 'call');
                }
            }
        }
        return out;
    }

    for (const [rel, facts] of filesMap) {
        for (const item of (facts && Array.isArray(facts.ipc) ? facts.ipc : [])) {
            if (!item || !item.channel || item.via === 'param' || item.via === 'dynamic') continue;
            const direction = item.side === 'register'
                ? (/^on/i.test(item.method || '') ? 'on' : 'handle')
                : (/^on/i.test(item.method || '') ? 'on' : 'send');
            out.push({
                channel: String(item.channel),
                direction,
                side: String(item.side || ''),
                method: String(item.method || ''),
                path: toPosixRel(rel),
                line: Number(item.line) || 0,
            });
        }
    }
    return out;
}

function setOwn(target, key, value) {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

async function createPrimitives(options = {}) {
    const { root, indexer, signal, limits: rawLimits } = options || {};
    if (typeof root !== 'string' || !root.trim()) {
        throw new Error('q.init: project root must be a non-empty string');
    }
    const absRoot = path.resolve(root.trim());
    let rootStat;
    try {
        rootStat = await fs.stat(absRoot);
    } catch (error) {
        throw new Error(`q.init: project root is unavailable: ${error.message}`);
    }
    if (!rootStat.isDirectory()) throw new Error('q.init: project root is not a directory');
    const realRoot = await fs.realpath(absRoot);
    const limits = normalizeLimits(rawLimits);

    let stepsUsed = 0;
    let totalBytesUsed = 0;

    function primitiveError(op, code, message) {
        const error = new Error(`q.${op}: ${message}`);
        error.code = code;
        return error;
    }

    function throwIfAborted(op) {
        if (signal && signal.aborted) {
            throw primitiveError(op, 'QUERY_ABORTED', `q.${op} 已被取消`);
        }
    }

    function checkStep(op) {
        throwIfAborted(op);
        stepsUsed += 1;
        if (stepsUsed > limits.maxPrimitiveSteps) {
            throw primitiveError(
                op,
                'QUERY_STEP_LIMIT_EXCEEDED',
                `step limit ${limits.maxPrimitiveSteps} exceeded`,
            );
        }
    }

    async function runPrimitive(op, fn) {
        checkStep(op);
        throwIfAborted(op);
        return await fn();
    }

    /**
     * Reserve bytes synchronously before awaiting any I/O. This is the atomic
     * point that lets Promise.all() share maxTotalBytes without oversubscribing
     * or rejecting a healthy call because of a private concurrency cap.
     */
    function reserveBytes(op, byteCount) {
        const amount = Math.max(0, Math.floor(Number(byteCount) || 0));
        if (amount === 0) return 0;
        if (totalBytesUsed + amount > limits.maxTotalBytes) {
            throw primitiveError(
                op,
                'QUERY_READ_BUDGET_EXCEEDED',
                `cumulative read budget ${limits.maxTotalBytes} bytes exceeded ` +
                `(used ${totalBytesUsed}, requested ${amount})`,
            );
        }
        totalBytesUsed += amount;
        return amount;
    }

    function requireIndexer(op, method) {
        const usable = indexer && indexer.usable !== false && typeof indexer[method] === 'function';
        if (!usable) throw new Error(`q.${op}: AST indexer is not available`);
    }

    async function assertInside(op, targetPath) {
        if (typeof targetPath !== 'string' || !targetPath.trim()) {
            throw new Error(`q.${op}: path must be a non-empty string`);
        }
        const abs = path.resolve(realRoot, targetPath.trim());
        const lexRel = path.relative(realRoot, abs);
        if (escapesRoot(lexRel)) {
            throw new Error(`q.${op}: path "${targetPath}" is outside project root`);
        }
        let realAbs;
        try {
            realAbs = await fs.realpath(abs);
        } catch (error) {
            throw new Error(`q.${op}: cannot access "${targetPath}": ${error.message}`);
        }
        if (!inside(realAbs, realRoot)) {
            throw new Error(`q.${op}: path "${targetPath}" resolves outside project root`);
        }
        return {
            abs: realAbs,
            rel: toPosixRel(path.relative(realRoot, realAbs)),
            realRoot,
        };
    }

    /**
     * Directory traversal is delegated to the VChat workspace indexer so the
     * query layer shares default ignores, nested .gitignore handling, virtual
     * environment detection and symlink refusal with the rest of the app.
     */
    async function scanProjectFiles(op, glob) {
        throwIfAborted(op);
        let scanned;
        try {
            scanned = await scanWorkspace(realRoot, {
                maxFiles: limits.maxFiles,
                shouldStop: () => Boolean(signal && signal.aborted),
            });
        } catch (error) {
            throw primitiveError(op, 'QUERY_SCAN_ERROR', `workspace scan failed: ${error.message}`);
        }
        if (scanned === null) {
            throwIfAborted(op);
            throw primitiveError(op, 'QUERY_SCAN_ABORTED', 'workspace scan stopped before completion');
        }
        if (glob !== undefined && glob !== null && typeof glob !== 'string') {
            throw primitiveError(op, 'QUERY_ARGUMENT', 'glob must be a string');
        }
        const paths = [];
        for (const rel of scanned.files.keys()) {
            let matched = true;
            if (glob !== undefined && glob !== null) {
                try {
                    matched = matchGlobList(rel, glob);
                } catch (error) {
                    throw primitiveError(op, 'QUERY_ARGUMENT', error.message);
                }
            }
            if (matched) paths.push(toPosixRel(rel));
        }
        paths.sort((a, b) => a.localeCompare(b));
        return { paths, truncated: Boolean(scanned.truncated) };
    }

    async function walkFiles(glob) {
        const { paths } = await scanProjectFiles('files', glob);
        const results = [];
        for (const rel of paths) {
            throwIfAborted('files');
            const abs = path.join(realRoot, ...rel.split('/'));
            try {
                const entry = await fs.lstat(abs);
                if (!entry.isFile()) continue;
                results.push({ path: rel, size: entry.size });
            } catch {
                continue;
            }
        }
        return results;
    }

    function normalizeSearchOptions(opts) {
        const source = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
        if (source.glob !== undefined && source.glob !== null && typeof source.glob !== 'string') {
            throw new Error('q.search: glob must be a string');
        }
        const maxResults = clampInt(
            firstDefined(source.max_results, source.maxResults),
            limits.maxSearchResults, 1, limits.maxSearchResults,
        );
        const contextLines = clampInt(
            firstDefined(source.context_lines, source.contextLines),
            0, 0, limits.maxContextLines,
        );
        return {
            glob: typeof source.glob === 'string' && source.glob.trim() ? source.glob.trim() : '',
            isRegex: source.is_regex !== false && source.isRegex !== false,
            caseSensitive: source.case_sensitive === true || source.caseSensitive === true,
            contextLines,
            maxResults,
        };
    }

    async function searchFiles(query, options) {
        let regex;
        const flags = options.caseSensitive ? '' : 'i';
        try {
            regex = options.isRegex ? new RegExp(query, flags) : new RegExp(escapeRegExpText(query), flags);
        } catch {
            regex = new RegExp(escapeRegExpText(query), flags);
        }

        const { paths } = await scanProjectFiles('search', options.glob);
        const hits = [];
        for (const rel of paths) {
            if (hits.length >= options.maxResults) break;
            throwIfAborted('search');
            const abs = path.join(realRoot, ...rel.split('/'));
            let entry;
            try {
                entry = await fs.lstat(abs);
            } catch {
                continue;
            }
            if (!entry.isFile()) continue;
            if (entry.size > limits.maxFileBytes) continue;
            reserveBytes('search', entry.size);
            let buffer;
            try {
                buffer = await fs.readFile(abs);
            } catch {
                continue;
            }
            if (buffer.length > entry.size) {
                reserveBytes('search', buffer.length - entry.size);
            }
            if (buffer.indexOf(0) !== -1) continue;
            const text = buffer.toString('utf8');
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && hits.length < options.maxResults; i += 1) {
                if (!regex.test(lines[i])) continue;
                const hit = { path: rel, line: i + 1, text: lines[i] };
                if (options.contextLines > 0) {
                    const context = [];
                    const from = Math.max(0, i - options.contextLines);
                    const to = Math.min(lines.length - 1, i + options.contextLines);
                    for (let j = from; j <= to; j += 1) {
                        if (j !== i) context.push(`${j + 1}: ${lines[j]}`);
                    }
                    if (context.length > 0) hit.context = context;
                }
                hits.push(hit);
            }
        }
        return hits;
    }

    const q = {
        async files(glob) {
            return runPrimitive('files', async () => {
                if (glob !== undefined && glob !== null && typeof glob !== 'string') {
                    throw new Error('q.files: glob must be a string');
                }
                return walkFiles(glob);
            });
        },

        async search(query, opts) {
            return runPrimitive('search', async () => {
                if (typeof query !== 'string' || !query.trim()) {
                    throw new Error('q.search: query must be a non-empty string');
                }
                const options = normalizeSearchOptions(opts);
                return searchFiles(query.trim(), options);
            });
        },

        async read(target) {
            return runPrimitive('read', async () => {
                if (typeof target !== 'string' || !target.trim()) {
                    throw new Error('q.read: target string is required');
                }
                const cleanTarget = target.trim();
                const hashIdx = cleanTarget.indexOf('#');
                if (hashIdx !== -1) {
                    const filePath = cleanTarget.slice(0, hashIdx).trim();
                    const symbolSpec = cleanTarget.slice(hashIdx + 1).trim();
                    if (!filePath || !symbolSpec) throw new Error('q.read: expected file#symbol');
                    const { abs } = await assertInside('read', filePath);
                    const stat = await fs.stat(abs);
                    if (!stat.isFile()) throw new Error(`q.read: "${filePath}" is not a regular file`);
                    if (stat.size > limits.maxAstFileBytes) {
                        throw primitiveError(
                            'read',
                            'QUERY_FILE_TOO_LARGE',
                            `file "${filePath}" exceeds ${limits.maxAstFileBytes} bytes for AST symbol slicing`,
                        );
                    }
                    requireIndexer('read', 'outline');
                    const text = await fs.readFile(abs, 'utf8');
                    const outline = await indexer.outline(text, abs);
                    if (!outline || !Array.isArray(outline.symbols)) {
                        throw new Error(`q.read: AST outline unavailable for "${filePath}"`);
                    }
                    const symbol = outline.symbols.find((candidate) => {
                        const qualified = candidate && (candidate.qualified || candidate.qualifiedName);
                        return qualified === symbolSpec || (candidate && candidate.name === symbolSpec);
                    });
                    if (!symbol) throw new Error(`q.read: symbol "${symbolSpec}" not found in "${filePath}"`);
                    const startLine = Number(symbol.start ?? symbol.startLine) || 0;
                    const endLine = Number(symbol.end ?? symbol.endLine) || 0;
                    if (!startLine || !endLine) {
                        throw new Error(`q.read: symbol "${symbolSpec}" lacks start/end line information`);
                    }
                    const snippet = text.split(/\r?\n/).slice(startLine - 1, endLine).join('\n');
                    const bytes = Buffer.byteLength(snippet, 'utf8');
                    if (bytes > limits.maxFileBytes) {
                        throw primitiveError(
                            'read',
                            'QUERY_FILE_TOO_LARGE',
                            `symbol slice "${filePath}#${symbolSpec}" exceeds ${limits.maxFileBytes} bytes limit`,
                        );
                    }
                    reserveBytes('read', bytes);
                    return snippet;
                }

                const colonMatch = /^(.*?):(\d+)(?:-(\d+))?$/.exec(cleanTarget);
                if (colonMatch) {
                    const filePath = colonMatch[1];
                    const startLine = Number(colonMatch[2]);
                    const endLine = colonMatch[3] ? Number(colonMatch[3]) : startLine;
                    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
                        throw new Error(`q.read: invalid line range "${cleanTarget}" (expected 1-based start<=end)`);
                    }
                    const { abs } = await assertInside('read', filePath);
                    const stat = await fs.stat(abs);
                    if (!stat.isFile()) throw new Error(`q.read: "${filePath}" is not a regular file`);
                    const slice = await readLineRange(abs, filePath, startLine, endLine, limits.maxFileBytes, signal);
                    reserveBytes('read', slice.bytes);
                    return slice.text;
                }

                const { abs } = await assertInside('read', cleanTarget);
                const stat = await fs.stat(abs);
                if (!stat.isFile()) throw new Error(`q.read: "${cleanTarget}" is not a regular file`);
                if (stat.size > limits.maxFileBytes) {
                    throw primitiveError(
                        'read',
                        'QUERY_FILE_TOO_LARGE',
                        `file "${cleanTarget}" exceeds ${limits.maxFileBytes} bytes. Use line or symbol slicing.`,
                    );
                }
                reserveBytes('read', stat.size);
                const buffer = await fs.readFile(abs);
                if (buffer.length > limits.maxFileBytes) {
                    throw primitiveError(
                        'read',
                        'QUERY_FILE_TOO_LARGE',
                        `file "${cleanTarget}" changed and now exceeds ${limits.maxFileBytes} bytes`,
                    );
                }
                return buffer.toString('utf8');
            });
        },

        async outline(targetPath) {
            return runPrimitive('outline', async () => {
                if (typeof targetPath !== 'string' || !targetPath.trim()) {
                    throw new Error('q.outline: targetPath must be a non-empty string');
                }
                const { abs } = await assertInside('outline', targetPath);
                const stat = await fs.stat(abs);
                if (!stat.isFile()) throw new Error(`q.outline: "${targetPath}" is not a regular file`);
                if (stat.size > limits.maxAstFileBytes) {
                    throw primitiveError(
                        'outline',
                        'QUERY_FILE_TOO_LARGE',
                        `file "${targetPath}" exceeds ${limits.maxAstFileBytes} bytes (${stat.size} bytes)`,
                    );
                }
                requireIndexer('outline', 'outline');
                const text = await fs.readFile(abs, 'utf8');
                const outline = await indexer.outline(text, abs);
                if (!outline || !Array.isArray(outline.symbols)) {
                    throw new Error(`q.outline: AST outline unavailable for "${targetPath}"`);
                }
                return outline.symbols.map(projectSymbol);
            });
        },

        async symbols(opts) {
            return runPrimitive('symbols', async () => {
                const options = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
                if (options.glob !== undefined && options.glob !== null && typeof options.glob !== 'string') {
                    throw new Error('q.symbols: glob must be a string');
                }
                requireIndexer('symbols', 'findSymbols');
                const queryName = String(options.name ?? options.query ?? '').trim();
                const limit = clampInt(
                    options.limit,
                    Math.min(50, limits.maxSymbolResults),
                    1,
                    limits.maxSymbolResults,
                );
                const raw = await indexer.findSymbols(realRoot, {
                    ...(queryName ? { name: queryName } : {}),
                    ...(options.kind ? { kind: options.kind } : {}),
                    ...(options.glob ? { glob: options.glob } : {}),
                    exact: Boolean(options.exact),
                    limit,
                });
                if (!raw || !Array.isArray(raw.hits)) {
                    throw new Error('q.symbols: AST indexer failed or returned null');
                }
                return raw.hits.map((hit) => ({
                    path: toPosixRel(hit && (hit.path ?? hit.file)),
                    ...projectSymbol(hit),
                }));
            });
        },

        async graph(glob) {
            return runPrimitive('graph', async () => {
                if (glob !== undefined && glob !== null && typeof glob !== 'string') {
                    throw new Error('q.graph: glob must be a string');
                }
                requireIndexer('graph', 'facts');
                if (!linkGraph || typeof linkGraph.buildGraph !== 'function' || typeof linkGraph.loadPreloadDecls !== 'function') {
                    throw new Error('q.graph: linkGraph module is unavailable');
                }
                let decls;
                try {
                    decls = await linkGraph.loadPreloadDecls(realRoot, { timeoutMs: limits.preloadTimeoutMs });
                } catch (error) {
                    decls = { status: 'failed', apis: [], roleGlobals: null, error: error.message };
                }
                const bridgeGlobals = typeof linkGraph.bridgeGlobalsOf === 'function'
                    ? linkGraph.bridgeGlobalsOf(decls)
                    : [];
                let facts;
                try {
                    facts = await indexer.facts(realRoot, { bridgeGlobals });
                } catch (error) {
                    throw new Error(`q.graph: indexer facts failed: ${error.message}`);
                }
                if (!facts || typeof facts !== 'object') {
                    throw new Error('q.graph: AST indexer facts unavailable');
                }
                let g;
                try {
                    g = linkGraph.buildGraph(realRoot, facts, decls);
                } catch (error) {
                    throw new Error(`q.graph: buildGraph failed: ${error.message}`);
                }
                if (!g || !(g.files instanceof Map) || !(g.deps instanceof Map) || !(g.rdeps instanceof Map)) {
                    throw new Error('q.graph: graph structure mismatch (files/deps/rdeps must be Maps)');
                }

                const filesMap = g.files;
                const filesList = [...filesMap.keys()].map(toPosixRel).sort((a, b) => a.localeCompare(b));
                const deps = {};
                for (const [key, list] of g.deps) {
                    setOwn(deps, toPosixRel(key), (list || []).map((edge) => ({
                        path: toPosixRel(edge && edge.to),
                        line: Number(edge && edge.line) || 0,
                        kind: String(edge && edge.kind || ''),
                    })));
                }
                const rdeps = {};
                for (const [key, list] of g.rdeps) {
                    setOwn(rdeps, toPosixRel(key), (list || []).map((edge) => ({
                        path: toPosixRel(edge && edge.path),
                        line: Number(edge && edge.line) || 0,
                        kind: String(edge && edge.kind || ''),
                    })));
                }

                const truncated = Boolean(g.stats && g.stats.truncated);
                const stats = g.stats && typeof g.stats === 'object'
                    ? { ...g.stats, dynamicUnresolved: Array.isArray(g.dynamic) ? g.dynamic.length : 0 }
                    : {
                        scanned: filesMap.size,
                        withFacts: filesMap.size,
                        truncated,
                        dynamicUnresolved: Array.isArray(g.dynamic) ? g.dynamic.length : 0,
                    };
                const ipc = extractIpc(g, filesMap);

                if (glob !== undefined && glob !== null && glob.trim() !== '') {
                    const matched = new Set();
                    for (const rel of filesList) {
                        try {
                            if (matchGlobList(rel, glob)) matched.add(rel);
                        } catch (error) {
                            throw primitiveError('graph', 'QUERY_ARGUMENT', error.message);
                        }
                    }
                    const filteredDeps = {};
                    const filteredRdeps = {};
                    for (const rel of matched) {
                        setOwn(filteredDeps, rel, Object.prototype.hasOwnProperty.call(deps, rel) ? deps[rel] : []);
                        setOwn(filteredRdeps, rel, Object.prototype.hasOwnProperty.call(rdeps, rel) ? rdeps[rel] : []);
                    }
                    return {
                        files: [...matched].sort((a, b) => a.localeCompare(b)),
                        deps: filteredDeps,
                        rdeps: filteredRdeps,
                        ipc: ipc.filter((item) => matched.has(item.path)),
                        truncated,
                        stats: {
                            ...stats,
                            filtered: true,
                            glob,
                            matchedFiles: matched.size,
                            totalFiles: filesList.length,
                        },
                    };
                }

                return {
                    files: filesList,
                    deps,
                    rdeps,
                    ipc,
                    truncated,
                    stats,
                };
            });
        },
    };

    Object.defineProperty(q, 'limits', {
        value: limits,
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return Object.freeze(q);
}

module.exports = {
    createPrimitives,
    DEFAULT_LIMITS,
    normalizeLimits,
    _test: {
        toPosixRel,
        inside,
        matchSimpleGlob,
        matchGlobList,
        splitGlobPatterns,
        normalizeLimits,
    },
};
