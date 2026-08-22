/**
 * inventory.js - 枚举 Wallpaper Engine 壁纸库存
 *
 * 移植自 elysia395/dsh-wallpaper-engine (MIT)，适配 VCPWEWallpaper service 插件。
 * 三源扫描：
 *   1. <WE>/projects/defaultprojects   官方默认
 *   2. <WE>/projects/myprojects        用户自建
 *   3. <SteamLib>/steamapps/workshop/content/431960/*   创意工坊订阅
 * 每个 wallpaper 目录含 project.json: { title, type, file, preview }
 */
'use strict';

const {
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
} = require('node:fs');
const { join, resolve, basename } = require('node:path');

const { WE_APPID } = require('./locate');

const KINDS = ['scene', 'video', 'web', 'application'];

/** project.json 缺失 type 字段时按 file 扩展名推断。 */
function inferType(file) {
    if (/\.(mp4|webm|mkv|avi|mov)$/i.test(file)) return 'video';
    if (/\.(html?|js)$/i.test(file)) return 'web';
    return 'scene';
}

/** 读取单个 wallpaper 目录的 project.json；无效则返回 null。 */
function readProject(dir) {
    const pj = join(dir, 'project.json');
    if (!existsSync(pj)) return null;
    try {
        const o = JSON.parse(readFileSync(pj, 'utf8'));
        if (!o || typeof o !== 'object' || !o.file) return null;
        let type = typeof o.type === 'string' ? o.type.toLowerCase() : inferType(o.file);
        if (!KINDS.includes(type)) type = 'scene';
        return {
            id: basename(dir),
            title: typeof o.title === 'string' ? o.title : basename(dir),
            type,
            file: o.file,
            preview: typeof o.preview === 'string' ? o.preview : null,
            // web 壁纸的用户自定义配置，交给 we-api-shim 回喂给壁纸脚本。
            // 部分壁纸的 project.json 有上百 KB 全在这里面（实测 1509243786 = 111KB）。
            properties: (o.general && typeof o.general === 'object'
                && o.general.properties && typeof o.general.properties === 'object')
                ? o.general.properties : null,
        };
    } catch {
        return null;
    }
}

/**
 * 枚举全部壁纸（去重、按标题排序）。
 * @param {string|null} installDir WE 安装目录（locateWallpaperEngine 结果）
 * @param {string[]} libraryDirs 拥有 WE 的 Steam 库目录列表
 * @returns {Array<{id,title,type,file,preview,fileAbs,previewAbs}>}
 */
function enumerateWallpapers(installDir, libraryDirs) {
    const found = new Map();
    const roots = [];

    if (installDir) {
        for (const sub of ['defaultprojects', 'myprojects']) {
            const p = join(installDir, 'projects', sub);
            if (existsSync(p)) roots.push(p);
        }
    }
    for (const lib of libraryDirs) {
        const ws = join(lib, 'steamapps', 'workshop', 'content', WE_APPID);
        if (existsSync(ws)) roots.push(ws);
    }

    for (const root of roots) {
        let entries = [];
        try {
            entries = readdirSync(root);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const dir = join(root, entry);
            let st;
            try {
                st = statSync(dir);
            } catch {
                continue;
            }
            if (!st.isDirectory()) continue;
            const proj = readProject(dir);
            if (!proj || found.has(proj.id)) continue;
            proj.dirAbs = resolve(dir);              // web 壁纸目录托管的根，用于 traversal 校验
            proj.fileAbs = resolve(dir, proj.file);
            proj.previewAbs = proj.preview ? resolve(dir, proj.preview) : null;
            found.set(proj.id, proj);
        }
    }

    return [...found.values()].sort((a, b) =>
        (a.title || '').localeCompare(b.title || ''));
}

/**
 * 文件的 MIME 类型（media / preview / web 三条路由的 Content-Type 用）。
 *
 * web 壁纸是完整的静态站点，会引用 css/字体/音频/json 等各类资源，
 * 因此这里的表必须覆盖到浏览器会挑食的所有类型（尤其字体与 css：
 * MIME 不对时 Chromium 会直接拒绝应用样式）。
 */
function mimeFor(absPath) {
    const ext = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase();
    return {
        // 视频
        mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
        avi: 'video/x-msvideo', mov: 'video/quicktime',
        // 文档与脚本
        html: 'text/html', htm: 'text/html',
        js: 'text/javascript', mjs: 'text/javascript',
        css: 'text/css', json: 'application/json',
        txt: 'text/plain', md: 'text/plain', xml: 'application/xml',
        // 图片
        jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        png: 'image/png', webp: 'image/webp', bmp: 'image/bmp',
        svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
        // 字体（MIME 错误会导致 @font-face 静默失效）
        woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
        otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
        // 音频
        mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
        m4a: 'audio/mp4', flac: 'audio/flac',
    }[ext] || 'application/octet-stream';
}

module.exports = {
    KINDS,
    inferType,
    readProject,
    enumerateWallpapers,
    mimeFor,
};
