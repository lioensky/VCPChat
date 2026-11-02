'use strict';
// 设计画布。
// .design 是一份 JSON，列出画框：{ "version": 1, "frames": [{ "file": "设计名/画框.html", "x": 0, "y": 0, "width": 1280, "height": 800 }] }。
// 每个画框就是磁盘上的一份 HTML，Agent 和编辑器直接改文件，画布自己刷新（思路同 Frameground：文件在原处，磁盘是真相）。
// 这里只管把相对路径换成 uttu-page:// 地址、建新画框。路径出不了这份设计所在的范围（仓库，或它所在的文件夹）。
const fs = require('fs');
const path = require('path');

const key = (value) => path.resolve(value).toLowerCase();
const within = (target, root) => key(target) === key(root) || key(target).startsWith(`${key(root)}${path.sep}`);
const relativeTo = (design, target) => path.relative(path.dirname(design), target).split(path.sep).join('/');

async function frames({ file, list }, { grant, handles }) {
    const design = path.resolve(String(file || ''));
    const { root } = await grant(design);
    const items = await Promise.all((Array.isArray(list) ? list : []).map(async (relative) => {
        const target = path.resolve(path.dirname(design), String(relative));
        if (!handles(target) || !within(target, root)) return { file: relative, refused: true };
        const stat = await fs.promises.stat(target).catch(() => null);
        if (!stat?.isFile()) return { file: relative, missing: true };
        return { file: relative, filePath: target, url: (await grant(target)).url, mtime: stat.mtimeMs };
    }));
    return { success: true, frames: items };
}

function freeName(dir, base) {
    for (let index = 1; index < 1000; index += 1) {
        const candidate = path.join(dir, `${base}${index === 1 ? '' : ` ${index}`}.html`);
        if (!fs.existsSync(candidate)) return candidate;
    }
    throw new Error('没能分配文件名。');
}
const blankPage = (title) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; }
</style>
</head>
<body>
</body>
</html>
`;

// 新画框放在设计旁边、和设计同名的文件夹里。
async function newFrame({ file }) {
    const design = path.resolve(String(file || ''));
    const dir = path.join(path.dirname(design), path.basename(design, path.extname(design)));
    await fs.promises.mkdir(dir, { recursive: true });
    const target = freeName(dir, '画框');
    await fs.promises.writeFile(target, blankPage(path.basename(target, '.html')), { flag: 'wx' });
    return { success: true, file: relativeTo(design, target) };
}

async function copyFrame({ file, source }, { handles }) {
    const design = path.resolve(String(file || ''));
    const from = path.resolve(path.dirname(design), String(source));
    if (!handles(from)) throw new Error('只能复制网页。');
    const target = freeName(path.dirname(from), `${path.basename(from, path.extname(from))} 副本`);
    await fs.promises.copyFile(from, target, fs.constants.COPYFILE_EXCL);
    return { success: true, file: relativeTo(design, target) };
}

module.exports = { frames, newFrame, copyFrame };
