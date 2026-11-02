'use strict';
// 文坊左栏的“笔记”。笔记一直是 AppData/Notemodules 里的 .md / .txt，不转换：文坊把这个文件夹当固定文件夹列出来，
// 头上能新建待办和备忘（两种起始模板）。笔记窗口照旧可用。
const path = require('path');
const fs = require('fs-extra');

let notesRoot = null;
let openScriptorium = null;

// main.js: appDataRoot is chat/AppData; open is docxHandlers.openScriptorium (loads 文坊 on first use).
function configure({ appDataRoot, open } = {}) {
    if (appDataRoot) notesRoot = path.join(appDataRoot, 'Notemodules');
    if (typeof open === 'function') openScriptorium = open;
}

async function notesDir() {
    if (!notesRoot) throw new Error('笔记目录还没准备好。');
    await fs.ensureDir(notesRoot);
    return notesRoot;
}

// inPane: the pane's 文坊 in Chat; otherwise the 文坊 window.
async function openNotes({ inPane = false, filePath = null } = {}) {
    if (!openScriptorium) throw new Error('文坊还没准备好。');
    const folder = await notesDir();
    await openScriptorium({ folder, ...(filePath ? { filePath } : {}), window: !inPane, reveal: true });
    return { success: true, folder };
}

const pad = (n) => String(n).padStart(2, '0');
function stampOf(date = new Date()) {
    return {
        day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        time: `${pad(date.getHours())}${pad(date.getMinutes())}`,
        label: `${date.getMonth() + 1}月${date.getDate()}日`,
        clock: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    };
}
// A new note each time.
const TEMPLATES = Object.freeze({
    memo: (stamp) => ({ name: `笔记 ${stamp.day} ${stamp.time}`, text: `# 笔记 ${stamp.label} ${stamp.clock}\n\n`, reuse: false }),
});

function safeName(name) {
    return String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '笔记';
}

// kind: memo, or shared (title and content from “share to notes”). Returns { path, created }.
async function newNote({ kind = 'memo', title = '', content = '', now = new Date() } = {}) {
    const dir = await notesDir();
    const stamp = stampOf(now);
    const made = kind === 'shared'
        ? { name: title || `分享 ${stamp.day} ${stamp.time}`, text: String(content ?? ''), reuse: false }
        : (TEMPLATES[kind] || TEMPLATES.memo)(stamp);
    const base = safeName(made.name);
    let file = path.join(dir, `${base}.md`);
    if (made.reuse && await fs.pathExists(file)) return { path: file, created: false };
    for (let n = 2; await fs.pathExists(file); n += 1) file = path.join(dir, `${base} (${n}).md`);
    await fs.writeFile(file, made.text, { flag: 'wx' });
    return { path: file, created: true };
}

// “Share to notes” (Chat's text viewer, the selection assistant): a new note with that text, opened in 文坊.
async function shareNote({ title = '', content = '' } = {}, { inPane = false } = {}) {
    const made = await newNote({ kind: 'shared', title, content });
    await openNotes({ inPane, filePath: made.path });
    return made;
}

module.exports = { configure, notesDir, openNotes, newNote, shareNote, TEMPLATES };
