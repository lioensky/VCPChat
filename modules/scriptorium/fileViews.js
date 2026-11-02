'use strict';
// 文坊原位打开各类文件的主进程接入。docxHandlers.js 只在三处调用这里：
// - 初始化时 register：登记各模块的处理函数（Markdown、网页、PDF、表格、文本与图片、文件访问、拖放）；
// - “打开”对话框和按路径读取（docx:read-path）时先调用 open：属于这里的文件返回结果，其余（文稿工程、导入格式）返回 null，
//   仍按原有流程处理。“导入”不经过这里，仍新建工程；
// - 保存时先调用 saves：从 .md 打开的文稿保存回 .md。
// deps：shell、dialog、ownerOf(event)、dataDir()、libraryDir()、libraryRoots()、recentFiles()、rememberRecentFile(path)、
//       atomicWrite(path, bytes)、importable(path)。
const path = require('path');
const types = require('./fileTypes');
const markdownFiles = require('./markdownFiles');
const webPages = require('./webPages');
const fileAccess = require('./fileAccess');

let deps = {};

function register(ipcMain, value) {
    deps = value;
    fileAccess.register(ipcMain, deps);
    markdownFiles.register(ipcMain, deps);
    webPages.register(ipcMain, deps);
    require('./pdfFiles').register(ipcMain, deps);
    require('./sheetFiles').register(ipcMain, deps);
    require('./viewFiles').register(ipcMain, deps);
    require('./dropOpen').register(ipcMain, deps);
}

// filePath：要打开的文件。options.sender：发起请求的页面（Markdown 按页面记录内容指纹）；
// options.grant：路径由主进程选出（对话框）时为 true，加入本次运行允许读写的范围。页面传来的路径不加入。
async function open(filePath, options = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
    const resolved = path.resolve(filePath);
    if (deps.importable?.(resolved) && !types.opensInPlace(resolved)) return null;
    if (options.grant) fileAccess.grant(resolved);
    if (markdownFiles.handles(resolved)) return markdownFiles.read(resolved, { ...deps, sender: options.sender });
    if (webPages.handles(resolved)) return webPages.describe(resolved);
    const name = path.basename(resolved);
    if (types.isOverlay(resolved)) return { success: true, kind: 'overlay', filePath: resolved, name };
    if (!deps.importable?.(resolved) && await require('./viewFiles').looksLikeText(resolved)) {
        return { success: true, kind: 'overlay', asText: true, filePath: resolved, name };
    }
    return null;
}

const saves = (filePath) => markdownFiles.handles(filePath);
const save = (event, payload) => markdownFiles.save(event, payload, deps);

// “打开”对话框的过滤器：第一项列出全部可打开的类型。
function openFilters(original = []) {
    const extensions = [...new Set([
        ...original.flatMap((filter) => filter.extensions || []),
        ...types.TYPES.flatMap((type) => type.exts.map((extension) => extension.slice(1))),
    ])];
    const byKind = types.TYPES.filter((type) => type.kind !== 'project')
        .map((type) => ({ name: type.name, extensions: type.exts.map((extension) => extension.slice(1)) }));
    return [{ name: '所有可打开的文件', extensions }, ...original, ...byKind];
}

module.exports = { register, open, saves, save, openFilters };
