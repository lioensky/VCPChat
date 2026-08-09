import fs from 'node:fs';
import path from 'node:path';

function readCssWithImports(entryPath, seen = new Set()) {
    const absolute = path.resolve(entryPath);
    if (seen.has(absolute)) throw new Error(`CSS import cycle: ${absolute}`);
    seen.add(absolute);
    const source = fs.readFileSync(absolute, 'utf8');
    const expanded = source.replace(/@import\s+url\(['"](.+?)['"]\);/g, (match, relative) => {
        if (!relative.startsWith('.')) return match;
        return readCssWithImports(path.resolve(path.dirname(absolute), relative), seen);
    });
    seen.delete(absolute);
    return expanded;
}

export { readCssWithImports };
