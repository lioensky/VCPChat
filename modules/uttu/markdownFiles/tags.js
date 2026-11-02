'use strict';
// 文坊的标签。标签写在文件里，不另存：
// - 正文里的 #标签（前面是行首、空白或中文标点；代码块、行内代码、链接、标题开头的 # 不算；纯数字的 #12 不算，那多半是编号）；
// - 属性段的 tags:（行内列表 [甲, 乙]、分行列表、逗号隔开的一串都认，前面带不带 # 都行）。
// 标签里可以有 /（Obsidian 的嵌套写法，原样当一个标签）。大小写不同算同一个，显示用第一次见到的写法。
const path = require('path');
const fs = require('fs-extra');

const SCAN_ENTRIES = 20000;
const SCAN_MS = 3000;
const FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build', 'out', 'coverage']);
const INLINE = /(^|[\s（(，。；：、“”‘’！？,;:!?])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

function frontTags(lines) {
    if (lines[0]?.replace(/^﻿/, '').trim() !== '---') return { tags: [], end: 0 };
    const tags = [];
    let end = 0;
    let inList = false;
    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index].replace(/\r$/, '');
        if (/^(---|\.\.\.)\s*$/.test(line)) { end = index + 1; break; }
        const key = /^(tags?|标签)\s*:\s*(.*)$/i.exec(line);
        if (key) {
            inList = !key[2].trim();
            const value = key[2].trim().replace(/^\[|\]$/g, '');
            if (value) value.split(/[,，]/).forEach((part) => tags.push(part));
            continue;
        }
        if (inList && /^\s*-\s+/.test(line)) { tags.push(line.replace(/^\s*-\s+/, '')); continue; }
        if (!/^\s/.test(line)) inList = false;
    }
    if (!end) return { tags: [], end: 0 };
    return { tags: tags.map((tag) => tag.trim().replace(/^["']|["']$/g, '').replace(/^#/, '').trim()).filter(Boolean), end };
}

// 一份文字里的标签（去重，保留写法）。
function tagsIn(text) {
    const lines = String(text).split('\n');
    const front = frontTags(lines);
    const found = [...front.tags];
    let fence = false;
    for (let index = front.end; index < lines.length; index += 1) {
        let line = lines[index].replace(/\r$/, '');
        if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
        if (fence) continue;
        line = line.replace(/^\s{0,3}#{1,6}\s/, ' ') // 标题开头的 # 不算，标题里写的 #标签 照算
            .replace(/`[^`]*`/g, ' ')
            .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/https?:\/\/\S+/g, ' ');
        for (const match of line.matchAll(INLINE)) found.push(match[2].replace(/[/-]+$/, ''));
    }
    const seen = new Map();
    for (const tag of found) if (tag && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    return [...seen.values()];
}

const skipDir = (name) => name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());

// 工作区和笔记里的全部标签：[{ name, files: [{ path, rel, root }] }]，按份数多到少。
async function scan({ roots } = {}, deps = {}) {
    const list = (Array.isArray(roots) ? roots : []).filter((root) => typeof root === 'string' && path.isAbsolute(root));
    const byTag = new Map();
    let seen = 0;
    let truncated = false;
    const started = Date.now();
    for (const root of list) {
        if (deps.isRoot && !(await deps.isRoot(root))) continue;
        const queue = [root];
        while (queue.length && !truncated) {
            const dir = queue.shift();
            let entries = [];
            try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) {
                seen += 1;
                if (seen > SCAN_ENTRIES || Date.now() - started > SCAN_MS) { truncated = true; break; }
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (!skipDir(entry.name)) queue.push(full); continue; }
                if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) continue;
                const stat = await fs.stat(full).catch(() => null);
                if (!stat || stat.size > FILE_BYTES) continue;
                const text = await fs.readFile(full, 'utf8').catch(() => '');
                for (const tag of tagsIn(text)) {
                    const key = tag.toLowerCase();
                    if (!byTag.has(key)) byTag.set(key, { name: tag, files: [] });
                    byTag.get(key).files.push({ path: full, root, rel: path.relative(root, full).split(path.sep).join('/') });
                }
            }
        }
        if (truncated) break;
    }
    const tags = [...byTag.values()].sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name, 'zh-CN'));
    return { tags, truncated };
}

module.exports = { scan, tagsIn, frontTags };
