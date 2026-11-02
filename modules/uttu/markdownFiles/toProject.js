'use strict';
// turn the .md open in 文坊 into a project file (.vdocx), for when it should get 文坊's layout,
// pictures and the rest. The .md itself stays as it is; the project is a new file, by default in the 文库 folder.
// Local pictures the text points to (Markdown images, reference definitions, <img>/<video>/<audio>/<source> src and
// poster) are copied into the project and the text points to them there (vdoc-resource://media/<sha256>), so the
// project still shows them after it moves. Only files inside the same reach as the reading view (the Git repository
// the .md is in, or its folder) are taken; web addresses stay links; the rest is counted and left as written.
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const JSZip = require('jszip');

const MEDIA_TYPES = Object.freeze({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
});
const MAX_MEDIA_BYTES = 80 * 1024 * 1024; // same cap as other project resources (docxHandlers MAX_RESOURCE_BYTES)
const CONTAINER = Object.freeze({
    format: 'vcp-vdoc-container',
    version: 2,
    manifestEntry: 'manifest.json',
    sourceEntry: 'source/document.md',
    styleEntry: 'source/document.css',
    checkpointsEntry: 'lineage/checkpoints.json',
});

// Places in Markdown text that point at a file: [start, end) of the address inside the text.
function mediaReferences(text) {
    const found = [];
    const add = (index, raw) => { if (raw) found.push({ start: index, end: index + raw.length, raw }); };
    // ![alt](address "title") and ![alt](<address with spaces>)
    for (const match of text.matchAll(/!\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)/g)) {
        const target = match[1];
        const offset = match.index + match[0].length - target.length;
        if (target.startsWith('<')) add(offset + 1, target.slice(1, -1));
        else add(offset, target);
    }
    // [name]: address   (reference definitions; only media files are taken below)
    for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]+>|\S+)/gm)) {
        const target = match[1];
        const offset = match.index + match[0].length - target.length;
        if (target.startsWith('<')) add(offset + 1, target.slice(1, -1));
        else add(offset, target);
    }
    // <img src="…">, <source src>, <video src|poster>, <audio src>
    for (const match of text.matchAll(/<(?:img|source|video|audio)\b[^>]*?\s(?:src|poster)\s*=\s*(["'])([^"'\n]*)\1/gi)) {
        const quoteAt = match.index + match[0].length - match[2].length - 1;
        add(quoteAt, match[2]);
    }
    return found.sort((left, right) => left.start - right.start);
}

const isAbsoluteAddress = (raw) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw);
const inside = (target, root) => {
    const relative = path.relative(root, target);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

// Copy the local media the text points to; returns the new text, the resources and what was left out.
async function embedMedia(text, { dir, root }) {
    const resources = new Map();
    const skipped = [];
    let output = '';
    let cursor = 0;
    for (const reference of mediaReferences(text)) {
        if (reference.start < cursor) continue; // overlapping finds (a reference inside an earlier one)
        const raw = reference.raw.trim();
        let replacement = null;
        if (raw && !isAbsoluteAddress(raw) && !raw.startsWith('vdoc-resource://')) {
            let decoded = raw;
            try { decoded = decodeURI(raw); } catch { /* keep as written */ }
            const target = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(dir, decoded);
            const extension = path.extname(target).slice(1).toLowerCase();
            if (MEDIA_TYPES[extension]) {
                const stat = inside(target, root || dir) ? await fs.stat(target).catch(() => null) : null;
                if (stat?.isFile() && stat.size > 0 && stat.size <= MAX_MEDIA_BYTES) {
                    const bytes = await fs.readFile(target);
                    const id = crypto.createHash('sha256').update(bytes).digest('hex');
                    if (!resources.has(id)) {
                        resources.set(id, {
                            bytes,
                            meta: {
                                id, kind: 'media', category: 'media', path: `resources/media/${id}.${extension}`,
                                name: path.basename(target), mime: MEDIA_TYPES[extension], sourceUrl: '', size: bytes.length,
                                sha256: id, description: '', nativeWidth: null, nativeHeight: null, duration: null,
                                durationText: '', createdAt: new Date().toISOString(),
                            },
                        });
                    }
                    replacement = `vdoc-resource://media/${id}`;
                } else {
                    skipped.push(raw);
                }
            }
        }
        if (replacement) {
            output += text.slice(cursor, reference.start) + replacement;
            cursor = reference.end;
        }
    }
    output += text.slice(cursor);
    return { text: output, resources: [...resources.values()], skipped };
}

async function packProject({ title, text, css, resources }) {
    const now = new Date().toISOString();
    const model = {
        format: 'vcp-vdocx',
        version: CONTAINER.version,
        container: CONTAINER,
        manifest: {
            id: `document-${crypto.randomUUID()}`,
            title,
            language: 'zh-CN',
            sourceFormat: 'markdown-hybrid',
            createdAt: now,
            modifiedAt: now,
            generator: 'VCP Scriptorium',
            fonts: [],
            resources: resources.map((resource) => resource.meta),
            styleDependencies: [],
            embeddedStyles: [],
            programmableDependencies: [],
            scene: { kind: 'flow-document', pagination: { mode: 'continuous' } },
            import: null,
        },
        source: { format: 'markdown-hybrid', content: null, documentCss: null, lineEnding: 'lf', deckCss: '', slides: [] },
        checkpoints: null,
    };
    const zip = new JSZip();
    zip.file(CONTAINER.manifestEntry, JSON.stringify(model, null, 2));
    zip.file(CONTAINER.sourceEntry, text);
    zip.file(CONTAINER.styleEntry, css || '');
    zip.file(CONTAINER.checkpointsEntry, '[]');
    zip.file('mimetype', CONTAINER.format, { compression: 'STORE' });
    for (const resource of resources) {
        zip.file(resource.meta.path, resource.bytes, { binary: true, compression: 'DEFLATE', compressionOptions: { level: 6 } });
    }
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// payload: { text, css, title, markdownFile: { dir, root } } from the page (what is on screen, edits included).
// deps: dialog, ownerOf, atomicWrite (docxHandlers: one-step replace, remembers the recent file), libraryDir.
async function toProject(event, payload = {}, deps = {}) {
    const markdownFile = payload.markdownFile || {};
    if (!markdownFile.dir) throw new Error('这份文档不是从 .md 打开的。');
    const title = String(payload.title || '').trim().replace(/\.(md|markdown)$/i, '') || '未命名';
    const folder = deps.libraryDir?.() || markdownFile.dir;
    await fs.ensureDir(folder).catch(() => {});
    const result = await deps.dialog.showSaveDialog(deps.ownerOf?.(event), {
        title: '转成文稿工程',
        defaultPath: path.join(folder, `${title.replace(/[\\/:*?"<>|]/g, '_')}.vdocx`),
        filters: [{ name: '文稿工程（VDOCX）', extensions: ['vdocx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    let target = path.resolve(result.filePath);
    if (path.extname(target).toLowerCase() !== '.vdocx') target = `${target}.vdocx`;
    const embedded = await embedMedia(String(payload.text || ''), { dir: markdownFile.dir, root: markdownFile.root || markdownFile.dir });
    const bytes = await packProject({ title, text: embedded.text, css: payload.css, resources: embedded.resources });
    await deps.atomicWrite(target, bytes);
    return { success: true, filePath: target, embedded: embedded.resources.length, skipped: embedded.skipped };
}

module.exports = { toProject, embedMedia, mediaReferences };
