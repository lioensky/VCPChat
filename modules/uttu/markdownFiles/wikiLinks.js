'use strict';
// VCP : [[wiki links]] between .md files.
// resolve: [[name]] names a file by its name without .md, or by a path inside the folder (“notes/plan”). Look in the
// folder that is open in 文坊, else in the file's repository (or its own folder): a path match wins, then the same name,
// shortest path first (Obsidian does the same). Missing: say where a new one would go (next to the current file).
// create: write that new file (only beside the current file, never over an existing one).
// backlinks: the files in the folder that link to this one, with [[name]] or a relative Markdown link, a few places each.
const path = require('path');
const fs = require('fs-extra');

const MARKDOWN_EXT = /\.(md|markdown)$/i;
const strip = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(MARKDOWN_EXT, '').trim();
const safeName = (value) => String(value || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

async function searchRoot({ from, root }, { rootOf }) {
    if (root && path.isAbsolute(root)) return root;
    const dir = path.dirname(String(from || ''));
    return path.isAbsolute(dir) ? rootOf(dir) : null;
}

async function resolve({ name, from, root } = {}, { allFiles, rootOf }) {
    const wanted = strip(name).toLowerCase();
    if (!wanted) throw new Error('链接里没有名字。');
    const base = await searchRoot({ from, root }, { rootOf });
    const listing = base ? await allFiles({ root: base }) : { files: [] };
    const files = listing.files.map((file) => ({ ...file, key: strip(file.rel).toLowerCase() }));
    const byPath = files.find((file) => file.key === wanted)
        || files.find((file) => wanted.includes('/') && file.key.endsWith(`/${wanted}`));
    const byName = files.filter((file) => file.key.split('/').pop() === wanted.split('/').pop())
        .sort((a, b) => a.key.split('/').length - b.key.split('/').length || a.key.length - b.key.length);
    const found = byPath || byName[0];
    if (found) return { path: found.path, truncated: Boolean(listing.truncated) };
    const dir = path.dirname(String(from || ''));
    const fileName = `${safeName(strip(name).split('/').pop()) || '新笔记'}.md`;
    return { missing: true, suggest: path.isAbsolute(dir) ? path.join(dir, fileName) : null, truncated: Boolean(listing.truncated) };
}

async function create({ name, from } = {}) {
    const dir = path.dirname(String(from || ''));
    if (!path.isAbsolute(dir)) throw new Error('当前文件没有位置，不知道建在哪。');
    const title = safeName(strip(name).split('/').pop()) || '新笔记';
    const target = path.join(dir, `${title}.md`);
    await fs.writeFile(target, `# ${title}\n\n`, { flag: 'wx' });
    return { path: target };
}

// [[name]] / [[name|label]] / [[name#heading]] → name; relative Markdown links (not http:, not #anchors) → the path.
const WIKI = /\[\[([^\[\]\n|#]+)(?:#[^\[\]\n|]*)?(?:\|[^\[\]\n]*)?\]\]/g;
const LINK = /\]\(\s*<?([^)\s>]+?\.(?:md|markdown))(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\s*\)/gi;

// Code is not a link: fenced blocks and inline code are blanked out first (same length, so positions and lines stay).
function maskCode(text) {
    const blank = (part) => part.replace(/[^\n]/g, ' ');
    return String(text || '')
        .replace(/^(\s{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[`~]*[ \t]*(?=\n|$)|$)/gm, blank)
        .replace(/(`+)[^`\n][\s\S]*?\1/g, blank);
}

function linksIn(text) {
    const out = [];
    const source = maskCode(text);
    for (const match of source.matchAll(WIKI)) out.push({ kind: 'wiki', target: match[1].trim(), index: match.index, raw: match[0] });
    for (const match of source.matchAll(LINK)) {
        if (/^[a-z][\w+.-]*:/i.test(match[1])) continue;
        let target = match[1];
        try { target = decodeURIComponent(target); } catch { /* as written */ }
        out.push({ kind: 'link', target, index: match.index, raw: match[0] });
    }
    return out.sort((a, b) => a.index - b.index);
}

function lineAt(text, index) {
    const start = text.lastIndexOf('\n', index - 1) + 1;
    const end = text.indexOf('\n', index);
    return { line: text.slice(0, index).split('\n').length, text: text.slice(start, end < 0 ? text.length : end).trim().slice(0, 160) };
}

// Links out of this file (from its text) and links into it (from the other Markdown files in the folder).
async function backlinks({ path: target, root, text } = {}, { allFiles, rootOf }) {
    if (!path.isAbsolute(String(target || ''))) throw new Error('当前文件没有位置。');
    const started = Date.now();
    const base = await searchRoot({ from: target, root }, { rootOf });
    const listing = base ? await allFiles({ root: base }) : { files: [] };
    const own = strip(path.basename(target)).toLowerCase();
    const ownRel = base ? strip(path.relative(base, target)).toLowerCase() : own;
    const outgoing = [];
    const source = typeof text === 'string' ? text : await fs.readFile(target, 'utf8').catch(() => '');
    for (const link of linksIn(source)) {
        const resolved = link.kind === 'wiki'
            ? await resolve({ name: link.target, from: target, root: base }, { allFiles: async () => listing, rootOf })
            : { path: path.resolve(path.dirname(target), link.target) };
        outgoing.push({ target: link.target, path: resolved.path || null, missing: Boolean(resolved.missing), ...lineAt(source, link.index) });
    }
    const incoming = [];
    let truncated = Boolean(listing.truncated);
    for (const file of listing.files) {
        if (file.path === target) continue;
        if (incoming.length >= 200 || Date.now() - started > 3000) { truncated = true; break; }
        let content = '';
        try {
            const stat = await fs.stat(file.path);
            if (stat.size > 2 * 1024 * 1024) continue;
            content = await fs.readFile(file.path, 'utf8');
        } catch { continue; }
        if (!content.includes('[[') && !/\.(md|markdown)/i.test(content)) continue;
        const places = [];
        for (const link of linksIn(content)) {
            const key = link.kind === 'wiki'
                ? strip(link.target).toLowerCase()
                : strip(path.relative(base || path.dirname(target), path.resolve(path.dirname(file.path), link.target))).toLowerCase();
            const hit = link.kind === 'wiki' ? (key === own || key === ownRel || ownRel.endsWith(`/${key}`)) : key === ownRel;
            if (hit) places.push(lineAt(content, link.index));
            if (places.length >= 5) break;
        }
        if (places.length) incoming.push({ path: file.path, rel: file.rel, places });
    }
    return { outgoing, incoming, truncated };
}

module.exports = { resolve, create, backlinks, linksIn };
