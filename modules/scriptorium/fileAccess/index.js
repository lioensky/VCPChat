'use strict';
// 文坊可读写的文件范围。页面递来的任意路径不予认可，只认：
// - 文库目录内的文件；
// - 最近打开的文件本身（docxHandlers 的 recent.json）；
// - 本次运行中由主进程交给文坊的文件：“打开”对话框选中的、拖放进来的、Agent 请求打开的。
// PDF、表格、文本、图片等视图读写文件前都先经过 allowed()。
const path = require('path');

let deps = null;
const norm = (target) => {
    const resolved = path.resolve(String(target || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const sameOrInside = (target, root) => {
    const t = norm(target);
    const r = norm(root);
    return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

const granted = new Set();
const grant = (target) => { if (target && path.isAbsolute(String(target))) granted.add(norm(path.resolve(target))); };
async function allowed(target) {
    if (!target || !path.isAbsolute(String(target))) return false;
    if (granted.has(norm(path.resolve(target)))) return true;
    if ((deps?.libraryRoots?.() || []).some((root) => sameOrInside(target, root))) return true;
    const recent = (await deps?.recentFiles?.().catch?.(() => [])) || [];
    return recent.some((item) => item?.path && norm(item.path) === norm(target));
}
async function mustAllow(target) {
    if (!(await allowed(target))) throw new Error('这个文件不在文库或最近打开的文件中，文坊不对它进行操作。');
    return path.resolve(target);
}

// 可运行的文件（双击即运行的类型）不交给默认程序打开，只在资源管理器中显示。
const RUNNABLE = new Set(['.bat', '.cmd', '.exe', '.com', '.ps1', '.psm1', '.psd1', '.lnk', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
    '.msi', '.msp', '.scr', '.pif', '.hta', '.cpl', '.msc', '.jar', '.reg', '.url', '.appref-ms', '.sh', '.py', '.pyw', '.application', '.gadget']);
const runnable = (file) => RUNNABLE.has(path.extname(String(file || '')).toLowerCase());

async function act(_event, payload = {}) {
    switch (payload.command) {
        case 'open-default': {
            const target = await mustAllow(payload.path);
            if (runnable(target)) {
                deps.shell.showItemInFolder(target);
                return { ok: true, revealed: true };
            }
            const error = await deps.shell.openPath(target);
            if (error) throw new Error(`系统未能打开该文件：${error}`);
            return { ok: true };
        }
        default: throw new Error(`未知的文件操作：${payload.command}`);
    }
}

function configure(value) {
    deps = value;
}

function register(ipcMain, value) {
    configure(value);
    ipcMain.removeHandler('scriptorium:file');
    ipcMain.handle('scriptorium:file', (event, payload) => act(event, payload));
}

module.exports = { register, configure, allowed, grant, runnable, sameOrInside };
