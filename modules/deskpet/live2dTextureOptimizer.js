'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const MAX_EDGE = 1280;
const MAX_PIXELS = 128 * 1024 * 1024;
let sharp;
let tail = Promise.resolve();
const checked = new Map();
const inside = (root, file) => {
    const rel = path.relative(root, file);
    return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const stamp = stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;

function animatedPng(bytes) {
    for (let pos = 8; pos + 12 <= bytes.length;) {
        const type = bytes.toString('ascii', pos + 4, pos + 8);
        if (type === 'acTL') return true;
        if (type === 'IDAT' || type === 'IEND') return false;
        pos += bytes.readUInt32BE(pos) + 12;
    }
    return false;
}

async function optimizeFile(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) return;
    const before = stamp(stat);
    if (checked.get(file) === before) return;
    let temp;
    try {
        const bytes = await fs.readFile(file);
        if (animatedPng(bytes)) return;
        if (!sharp) {
            sharp = require('sharp');
            sharp.cache(false);
        }
        const meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
        if (meta.format !== 'png' || !meta.width || !meta.height || (meta.pages || 1) > 1) return;
        if (Math.max(meta.width, meta.height) <= MAX_EDGE) {
            checked.set(file, before);
            return;
        }
        // Texture UVs are normalized: preserve orientation/layout, never apply EXIF rotation.
        const output = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
            .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
            .png({ compressionLevel: 9, palette: false })
            .toBuffer();
        temp = `${file}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temp, output, { flag: 'wx' });
        const result = await sharp(temp).metadata();
        await sharp(temp).raw().toBuffer();
        if (result.format !== 'png' || !result.width || !result.height
            || Math.max(result.width, result.height) > MAX_EDGE
            || (meta.hasAlpha && !result.hasAlpha)) throw new Error('PNG贴图验证失败');
        const current = await fs.lstat(file);
        if (current.isSymbolicLink() || stamp(current) !== before) return;
        await fs.rename(temp, file);
        checked.set(file, stamp(await fs.stat(file)));
    } finally {
        if (temp) await fs.remove(temp).catch(() => {});
    }
}

/** Only user-owned models under allowedRoot; no recursive directory rewriting. */
async function optimizeModel(modelPath, allowedRoot) {
    try {
        const root = path.resolve(allowedRoot);
        const model = path.resolve(modelPath);
        if (!inside(root, model)) return;
        const [realRoot, realModel, stat] = await Promise.all([fs.realpath(root), fs.realpath(model), fs.stat(model)]);
        // Reject linked model paths, including directory junction escapes.
        if (path.relative(realRoot, realModel) !== path.relative(root, model)
            || !stat.isFile() || stat.size > 2 * 1024 * 1024) return;
        const definition = await fs.readJson(realModel);
        const refs = definition?.FileReferences?.Textures;
        if (!Array.isArray(refs)) return;
        const base = path.dirname(realModel);
        for (const ref of [...new Set(refs)].slice(0, 64)) {
            if (typeof ref !== 'string' || /[:\0]/.test(ref) || !/\.png$/i.test(ref)) continue;
            const file = path.resolve(base, ref.replaceAll('\\', '/'));
            if (!inside(base, file)) continue;
            try {
                const realFile = await fs.realpath(file);
                if (path.relative(realRoot, realFile) !== path.relative(realRoot, file)) continue;
                await optimizeFile(file);
            } catch (error) {
                console.warn('[Live2DTexture] 保留原贴图:', file, error.message);
            }
        }
    } catch (error) {
        console.warn('[Live2DTexture] 跳过模型:', error.message);
    }
    if (checked.size > 4096) checked.clear();
}

function optimizeLive2DTextures(modelPath, allowedRoot) {
    // Across all models/windows: never decode several 8K atlases simultaneously.
    const job = tail.catch(() => {}).then(() => optimizeModel(modelPath, allowedRoot));
    tail = job;
    return job;
}

module.exports = { optimizeLive2DTextures, MAX_EDGE };