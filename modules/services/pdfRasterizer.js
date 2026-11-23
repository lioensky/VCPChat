const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const LEGACY_SCALE = 1024;

// The caller owns a fresh output directory and removes it after reading the pages.
async function rasterizePdf(pdfPath, outDir, prefix) {
    const platform = os.platform();

    if (platform === 'linux') {
        // Match the existing backend's longest-edge setting, not pdftoppm's default DPI.
        try {
            await execFileAsync('pdftoppm', [
                '-jpeg', '-scale-to', String(LEGACY_SCALE),
                path.resolve(pdfPath), path.resolve(outDir, prefix)
            ], { timeout: 120_000 });
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new Error('PDF 转图需要 pdftoppm；请安装 poppler-utils，并确保 pdftoppm 在 PATH 中。', { cause: error });
            }
            throw error;
        }
    } else if (platform === 'win32' || platform === 'darwin') {
        // pdf-poppler exits at import time on all other platforms.
        const poppler = require('pdf-poppler');
        await poppler.convert(pdfPath, { format: 'jpeg', out_dir: outDir, out_prefix: prefix, page: null });
    } else {
        throw new Error(`当前平台不支持 PDF 转图：${platform}`);
    }

    return (await fs.readdir(outDir))
        .map(name => ({ name, page: name.match(/-(\d+)\.jpe?g$/i) }))
        .filter(({ name, page }) => page && name.slice(0, page.index) === prefix)
        .sort((a, b) => Number(a.page[1]) - Number(b.page[1]))
        .map(({ name }) => name);
}

module.exports = { rasterizePdf };