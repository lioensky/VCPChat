// modules/deskpet/zipImport.js
// 导入形象时直接选压缩包：网上下的模型大多是 .zip。
// 只解出模型（.model3.json / .puppet.json）所在的那一层及以下；没有模型时解出图片所在那一层的图片。
// 防路径穿越（../、绝对路径）、跳过 macOS 的 __MACOSX，限制文件数和解压后的总大小；
// 没有 UTF-8 标记的文件名先按 UTF-8 试，不行再按 GBK（国内压缩软件打的包）。

const path = require('path');
const fs = require('fs-extra');

const MODEL_RE = /\.(model3|puppet)\.json$/i;

function decodeName(bytes, iconv) {
    const buf = Buffer.from(bytes);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        return iconv ? iconv.decode(buf, 'gbk') : buf.toString('latin1');
    }
}

/** 压缩包里的路径整理成 a/b/c 形式；不安全（绝对路径、..）或该跳过的返回 null。 */
function safeEntryPath(name) {
    const parts = String(name).replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
    if (!parts.length) return null;
    if (/^[a-z]:$/i.test(parts[0]) || String(name).startsWith('/')) return null;
    if (parts.some((p) => p === '..')) return null;
    if (parts[0] === '__MACOSX' || parts[parts.length - 1] === '.DS_Store' || parts[parts.length - 1] === 'Thumbs.db') return null;
    return parts.join('/');
}

function dirOf(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
}

/**
 * 看压缩包里有什么：返回 { root, kind: 'model'|'images', entries: [{ rel, entry }] }，认不出返回 null。
 * root 是要解出的那一层（'' 是压缩包根），entries 里的 rel 相对 root。
 */
function planZip(zip, imageExtensions) {
    const files = [];
    for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const p = safeEntryPath(entry.name);
        if (p) files.push({ p, entry });
    }
    const byDepth = (a, b) => a.p.split('/').length - b.p.split('/').length || a.p.localeCompare(b.p);
    const model = files.filter((f) => MODEL_RE.test(f.p)).sort(byDepth)[0];
    let root;
    let picked;
    if (model) {
        root = dirOf(model.p);
        picked = files.filter((f) => !root || f.p.startsWith(root + '/'));
    } else {
        const isImage = (f) => imageExtensions.includes(path.extname(f.p).slice(1).toLowerCase());
        const image = files.filter(isImage).sort(byDepth)[0];
        if (!image) return null;
        root = dirOf(image.p);
        picked = files.filter((f) => isImage(f) && dirOf(f.p) === root);
    }
    return {
        root,
        kind: model ? 'model' : 'images',
        entries: picked.map((f) => ({ rel: root ? f.p.slice(root.length + 1) : f.p, entry: f.entry })),
    };
}

/**
 * 解压到 targetDir（应当是还不存在的新文件夹）。
 * 返回 { success: true, name, kind } 或 { success: false, error }；失败时 targetDir 已清掉。
 */
async function extractOutfitZip(buffer, targetDir, { limits, imageExtensions, JSZip = require('jszip'), iconv = safeRequire('iconv-lite') } = {}) {
    let zip;
    try {
        zip = await JSZip.loadAsync(buffer, { decodeFileName: (bytes) => decodeName(bytes, iconv) });
    } catch {
        return { success: false, error: '压缩包打不开（可能已损坏，或不是 .zip）' };
    }
    const plan = planZip(zip, imageExtensions);
    if (!plan) return { success: false, error: '压缩包里没找到 .model3.json、.puppet.json 或图片' };
    if (plan.entries.length > limits.files) return { success: false, error: '压缩包里的文件太多了，先解压出模型所在的文件夹再导入' };
    const target = path.resolve(targetDir);
    let bytes = 0;
    try {
        await fs.ensureDir(target);
        for (const { rel, entry } of plan.entries) {
            const out = path.resolve(target, rel);
            if (!out.startsWith(target + path.sep)) continue;
            const data = await entry.async('nodebuffer');
            bytes += data.length;
            if (bytes > limits.bytes) {
                await fs.remove(target);
                return { success: false, error: '压缩包解开后太大了，先解压出模型所在的文件夹再导入' };
            }
            await fs.ensureDir(path.dirname(out));
            await fs.writeFile(out, data);
        }
    } catch (error) {
        await fs.remove(target).catch(() => {});
        return { success: false, error: `解压失败：${error.message}` };
    }
    const name = plan.root ? plan.root.split('/').pop() : null;
    return { success: true, name, kind: plan.kind };
}

function safeRequire(id) {
    try { return require(id); } catch { return null; }
}

module.exports = { extractOutfitZip, planZip, safeEntryPath, decodeName };
