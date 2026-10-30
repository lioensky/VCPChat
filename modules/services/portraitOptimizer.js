'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { forgetPortraitDisplayImages } = require('./agentPortraitImages');
const queues = new Map();
const checked = new Map();
const PATTERN = /^portrait(?:\.([a-z0-9_-]{1,32}))?\.(png|jpe?g|webp)$/i;
let sharp;

function withPortraitLock(dir, operation) {
    const key = path.resolve(dir);
    const previous = queues.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(operation);
    queues.set(key, job);
    return job.finally(() => { if (queues.get(key) === job) queues.delete(key); });
}

function imageLibrary() {
    if (!sharp) {
        sharp = require('sharp');
        sharp.cache(false);
    }
    return sharp;
}

function containsAnimation(buffer) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!buffer.subarray(0, 8).equals(signature)) return false;
    for (let position = 8; position + 12 <= buffer.length;) {
        const size = buffer.readUInt32BE(position);
        const type = buffer.toString('ascii', position + 4, position + 8);
        if (type === 'acTL') return true;
        if (type === 'IDAT' || type === 'IEND') return false;
        position += size + 12;
    }
    return false;
}

/** null means an animation/unsupported format or an already bounded WebP. */
async function optimizePortraitBuffer(buffer) {
    if (containsAnimation(buffer)) return null;
    const lib = imageLibrary();
    const meta = await lib(buffer, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) > 1) return null;
    const rotated = (meta.orientation || 1) >= 5;
    const width = rotated ? meta.height : meta.width;
    const height = rotated ? meta.width : meta.height;
    if (!width || !height) throw new Error('立绘尺寸无效');
    const maxWidth = width > height ? 1920 : 1080;
    const maxHeight = width > height ? 1080 : 1920;
    if (meta.format === 'webp' && width <= maxWidth && height <= maxHeight && (meta.orientation || 1) === 1) return null;
    const output = await lib(buffer, { limitInputPixels: 64 * 1024 * 1024 })
        .rotate()
        .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88, alphaQuality: 100 })
        .toBuffer();
    // Decode all pixels before allowing the caller to discard any source.
    const result = await lib(output).metadata();
    await lib(output).raw().toBuffer();
    if (result.format !== 'webp' || result.width > maxWidth || result.height > maxHeight
        || result.width > width || result.height > height) throw new Error('立绘转换验证失败');
    // WebP can omit a redundant all-opaque alpha channel without losing transparency.
    if (meta.hasAlpha && !result.hasAlpha
        && !(await lib(buffer, { limitInputPixels: 64 * 1024 * 1024 }).stats()).isOpaque) {
        throw new Error('立绘透明度验证失败');
    }
    return output;
}

function fingerprint(stat) {
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
}

/** Caller holds the directory lock. Conflicts are never overwritten. */
async function migratePortraitsUnlocked(dir) {
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names) {
        if (!PATTERN.test(name)) continue;
        const source = path.join(dir, name);
        const stat = await fs.lstat(source).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) continue;
        const stamp = fingerprint(stat);
        if (checked.get(source) === stamp) continue;
        const target = source.replace(/\.[^.]+$/, '.webp');
        const same = path.extname(source).toLowerCase() === '.webp';
        if (!same && names.some(other => other.toLowerCase() === path.basename(target).toLowerCase())) continue;
        let temp;
        try {
            const output = await optimizePortraitBuffer(await fs.readFile(source));
            if (!output) {
                checked.set(source, stamp);
                continue;
            }
            const current = await fs.lstat(source);
            if (fingerprint(current) !== stamp) continue;
            temp = `${target}.${crypto.randomUUID()}.tmp`;
            await fs.writeFile(temp, output, { flag: 'wx' });
            // Verify disk bytes, not only the encoder's in-memory result.
            await imageLibrary()(temp).raw().toBuffer();
            if (fingerprint(await fs.lstat(source)) !== stamp) continue;
            if (same) {
                await fs.rename(temp, source);
            } else {
                // Hard-link publication fails with EEXIST instead of clobbering a conflicting WebP.
                await fs.link(temp, target);
                await fs.remove(source);
            }
            await forgetPortraitDisplayImages([source], path.join(path.dirname(path.dirname(dir)), 'PortraitCache'));
            const published = same ? source : target;
            checked.delete(source);
            checked.set(published, fingerprint(await fs.stat(published)));
        } catch (error) {
            console.warn('[PortraitOptimizer] 保留原图:', source, error.message);
            checked.set(source, stamp);
        } finally {
            if (temp) await fs.remove(temp).catch(() => {});
        }
    }
    // Bound bookkeeping even in very long sessions.
    if (checked.size > 4096) checked.clear();
}

function migratePortraits(dir) {
    return withPortraitLock(dir, () => migratePortraitsUnlocked(dir));
}

module.exports = { optimizePortraitBuffer, withPortraitLock, migratePortraits, migratePortraitsUnlocked };