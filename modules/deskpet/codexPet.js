'use strict';

const path = require('node:path');
const fs = require('fs-extra');
let sharp;

const MAX_SHEET_BYTES = 20 * 1024 * 1024;
const cache = new Map();
const inside = (root, file) => {
    const rel = path.relative(root, file);
    return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** Read a local Codex pet package. No code, external URLs or files outside its folder are loaded. */
async function readCodexPet(dir) {
    try {
        const manifest = path.join(dir, 'pet.json');
        const manifestStat = await fs.stat(manifest).catch(() => null);
        let info = {};
        let manifestPath = null;
        if (manifestStat) {
            if (!manifestStat.isFile() || manifestStat.size > 65536) return null;
            info = await fs.readJson(manifest);
            if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
            manifestPath = manifest;
        }
        const relative = manifestPath ? info.spritesheetPath : (await fs.pathExists(path.join(dir, 'spritesheet.webp')) ? 'spritesheet.webp' : 'spritesheet.png');
        if (typeof relative !== 'string' || !relative || /[:\0]/.test(relative) || !/\.(png|webp)$/i.test(relative)) return null;
        const sheet = path.resolve(dir, relative.replaceAll('\\', '/'));
        if (!inside(path.resolve(dir), sheet)) return null;
        const [realDir, realSheet, stat] = await Promise.all([fs.realpath(dir), fs.realpath(sheet), fs.stat(sheet)]);
        if (!inside(realDir, realSheet) || !stat.isFile() || stat.size < 1 || stat.size > MAX_SHEET_BYTES) return null;
        const key = `${realSheet}:${stat.size}:${stat.mtimeMs}:${manifestStat?.mtimeMs || 0}:${manifestStat?.size || 0}`;
        if (cache.has(key)) return cache.get(key);
        sharp ||= require('sharp');
        const metadata = await sharp(sheet, { limitInputPixels: 1536 * 2288 }).metadata();
        const inferred = metadata.width === 1536 ? ({ 1872: 1, 2288: 2 })[metadata.height] : null;
        const version = info.spriteVersionNumber === undefined ? inferred : info.spriteVersionNumber;
        if (!inferred || !['png', 'webp'].includes(metadata.format) || !metadata.hasAlpha || version !== inferred) return null;
        const result = {
            manifest: manifestPath, sheet, version, width: metadata.width, height: metadata.height,
            name: typeof info.displayName === 'string' ? info.displayName.trim().slice(0, 40) : null,
            description: typeof info.description === 'string' ? info.description.trim().slice(0, 120) : null,
        };
        if (cache.size >= 80) cache.clear();
        cache.set(key, result);
        return result;
    } catch {
        return null;
    }
}

module.exports = { readCodexPet };
