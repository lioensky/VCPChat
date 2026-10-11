'use strict';

// These patches target the compiled UV layout recorded in manifest.json.
// A new model export must be reviewed instead of silently reusing old UVs.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const sourceDir = path.join(__dirname, 'materials/nova-maid-20261011');
const root = path.resolve(__dirname, '../..');
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

async function main() {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const override = args.indexOf('--texture');
    if (override >= 0 && !args[override + 1]) throw new Error('--texture requires a path');
    const texture = override >= 0 ? path.resolve(args[override + 1])
        : path.join(root, 'assets/deskpet/nova/maid/NovaMaid.2048/texture_00.png');
    const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, 'manifest.json'), 'utf8'));
    const moc = await fs.readFile(path.join(root, 'assets/deskpet/nova/maid/NovaMaid.moc3'));
    if (hash(moc) !== manifest.mocSha256) throw new Error('Model changed; review the UV layout before applying materials.');
    const input = await fs.readFile(texture);
    if (hash(input) === manifest.finalTextureSha256) {
        console.log('Nova maid clean materials already applied.');
        return;
    }
    if (check) throw new Error('Nova maid texture does not match the reviewed result.');
    if (hash(input) !== manifest.originalTextureSha256) throw new Error('Unexpected source atlas; refusing to overwrite it.');
    const decoded = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== manifest.width || decoded.info.height !== manifest.height) throw new Error('Unexpected atlas size.');
    const raw = decoded.data;
    for (const region of manifest.regions) {
        const { id, left, top, width, height } = region;
        if (![left, top, width, height].every(Number.isInteger) || left < 0 || top < 0
            || width <= 0 || height <= 0 || left + width > manifest.width || top + height > manifest.height) {
            throw new Error(`Invalid UV region: ${id}`);
        }
        const patch = await sharp(path.join(sourceDir, `${id}-replacement.png`))
            .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (patch.info.width !== width || patch.info.height !== height) throw new Error(`Patch size mismatch: ${id}`);
        for (let y = 0; y < height; y++) {
            patch.data.copy(raw, ((top + y) * manifest.width + left) * 4, y * width * 4, (y + 1) * width * 4);
        }
    }
    const output = await sharp(raw, { raw: { width: manifest.width, height: manifest.height, channels: 4 } }).png().toBuffer();
    if (hash(output) !== manifest.finalTextureSha256) throw new Error('Rebuilt atlas differs from the reviewed result.');
    const temporary = `${texture}.maid-cleanup.tmp`;
    await fs.writeFile(temporary, output);
    await fs.rename(temporary, texture);
    console.log('Nova maid clean materials applied.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
