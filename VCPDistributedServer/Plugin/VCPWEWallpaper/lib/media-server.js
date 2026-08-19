/**
 * media-server.js - inventory / media / preview / web 四条 Express 路由
 *
 * 媒体路由模型移植自 elysia395/dsh-wallpaper-engine (MIT)，从 Cordis webServer
 * 适配为 VCPDistributedServer 的 Express app.registerRoutes 协议。
 *
 * 安全模型：
 *   - token = base64url(绝对路径)，仅 inventory 枚举过的文件进入服务 Map
 *   - 未注册 token 一律 404，不暴露任意文件系统
 *   - inventory 带 5 分钟 LRU 缓存，巨型库存重复扫描不卡 Express 事件循环
 *
 * web 壁纸目录托管（路线 B）：
 *   web 类型壁纸是完整静态站点（index.html + css/ + js/ + img/），相对引用无法
 *   靠"单文件白名单"满足，必须开放目录子树。安全模型因此从"逐文件白名单"
 *   收敛为"逐目录白名单 + 路径归一化校验"：
 *     1. token 只能是 inventory 枚举出的 web 壁纸目录（webMap 之外一律 404）
 *     2. 归一化后必须仍在该目录内，否则 403（阻断 ../../ 穿越）
 *     3. 只服务普通文件，lstat 拒绝目录与符号链接（阻断软链逃逸）
 *   入口 HTML 会被注入 WE API 垫片，见 we-api-shim.js。
 */
'use strict';

const { existsSync, statSync, lstatSync, createReadStream, readFileSync } = require('node:fs');
const { resolve, sep, relative } = require('node:path');

const { locateWallpaperEngine, owningLibraries } = require('./locate');
const { enumerateWallpapers, mimeFor } = require('./inventory');
const { injectShim } = require('./we-api-shim');

/** 路由前缀（UI 插件 fetch 的基地址）。 */
const BASE = '/vcp-we-wallpaper';

/** inventory 缓存有效期（毫秒）。 */
const INVENTORY_TTL_MS = 5 * 60 * 1000;

/**
 * 路由注册器。
 * @param {import('express').Express} app VCPDistributedServer 主 Express 应用
 * @param {object} _config 插件配置（本插件暂不使用 config.env）
 * @param {string} _projectBasePath 项目根（未使用，保留协议签名）
 */
function registerRoutes(app, _config, _projectBasePath) {
    // token -> 绝对路径。URL 不暴露文件系统字符串，Map 只收 inventory 内文件。
    const mediaMap = new Map();
    const tokenFor = (absPath) => {
        const token = Buffer.from(absPath, 'utf8').toString('base64url');
        mediaMap.set(token, absPath);
        return token;
    };

    // token -> { dirAbs, entryAbs, properties }。仅 web 类型壁纸的目录进入此表。
    const webMap = new Map();
    const webTokenFor = (proj) => {
        const token = Buffer.from(proj.dirAbs, 'utf8').toString('base64url');
        webMap.set(token, {
            dirAbs: proj.dirAbs,
            entryAbs: proj.fileAbs,
            properties: proj.properties || null,
        });
        return token;
    };

    // ── inventory 构建与缓存 ─────────────────────────────────
    let cache = { at: 0, payload: null };

    function buildInventory() {
        const installDir = locateWallpaperEngine();
        if (!installDir) {
            return {
                status: 503,
                payload: { error: 'Wallpaper Engine installation not found on this machine.' },
            };
        }
        const libraryDirs = owningLibraries();
        const all = enumerateWallpapers(installDir, libraryDirs);
        const wallpapers = all.map((w) => {
            const hasMedia = (w.type === 'video' || w.type === 'web')
                ? existsSync(w.fileAbs) : false;
            const hasPreview = w.previewAbs && existsSync(w.previewAbs);
            // web 壁纸额外给出目录托管入口；入口 URL 以 / 结尾，
            // 这样 iframe 内的相对引用会正确解析到 /web/<token>/xxx
            const isWeb = w.type === 'web' && hasMedia && w.dirAbs;
            return {
                id: w.id,
                title: w.title,
                type: w.type,
                playable: hasMedia,
                media: hasMedia ? `${BASE}/media/${tokenFor(w.fileAbs)}` : null,
                preview: hasPreview ? `${BASE}/preview/${tokenFor(w.previewAbs)}` : null,
                web: isWeb ? `${BASE}/web/${webTokenFor(w)}/` : null,
            };
        });
        return {
            status: 200,
            payload: {
                installDir,
                total: wallpapers.length,
                portableCount: wallpapers.filter((w) => w.playable).length,
                webCount: wallpapers.filter((w) => w.web).length,
                wallpapers,
                playlists: [], // v1.1 占位
            },
        };
    }

    function inventoryWithCache() {
        const now = Date.now();
        if (cache.payload && now - cache.at < INVENTORY_TTL_MS) {
            return cache;
        }
        return rebuildInventory();
    }

    /** 无条件重扫并刷新缓存（供 ?refresh=1 使用）。 */
    function rebuildInventory() {
        cache = { at: Date.now(), ...buildInventory() };
        return cache;
    }

    /** web 路由需要 webMap 已填充；冷启动直接命中 /web/... 时先建一次 inventory。 */
    function ensureWebMap() {
        if (webMap.size === 0) inventoryWithCache();
    }

    // ── 路由 1: inventory JSON ────────────────────────────────
    app.get(`${BASE}/inventory`, (req, res) => {
        try {
            // ?refresh=1 绕过 5 分钟缓存重扫目录。主人在 Steam 新订阅壁纸后
            // 不该被迫等一个 TTL 或重启服务器才能看到它。
            const bust = req.query.refresh === '1' || req.query.refresh === 'true';
            const { status, payload } = bust ? rebuildInventory() : inventoryWithCache();
            res.status(status)
                .setHeader('Content-Type', 'application/json; charset=utf-8')
                .setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(payload));
        } catch (err) {
            res.status(500)
                .setHeader('Content-Type', 'application/json')
                .end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
        }
    });

    // ── 路由 2/3: media + preview（流式，Range 支持 video 拖动） ──
    function serveFile(absPath, req, res) {
        if (!absPath || !existsSync(absPath)) {
            res.status(404).end('not found');
            return;
        }
        const st = statSync(absPath);
        res.setHeader('Content-Type', mimeFor(absPath));
        res.setHeader('Accept-Ranges', 'bytes');

        const range = req.headers.range;
        if (range) {
            const m = /bytes=(\d*)-(\d*)/.exec(range);
            let start = m && m[1] ? parseInt(m[1], 10) : 0;
            let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
            if (Number.isNaN(start)) start = 0;
            if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
            if (start > end) {
                res.status(416)
                    .setHeader('Content-Range', `bytes */${st.size}`)
                    .end();
                return;
            }
            res.status(206)
                .setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`)
                .setHeader('Content-Length', String(end - start + 1));
            createReadStream(absPath, { start, end }).pipe(res);
            return;
        }
        res.setHeader('Content-Length', String(st.size));
        createReadStream(absPath).pipe(res);
    }

    for (const seg of ['media', 'preview']) {
        app.get(`${BASE}/${seg}/:token`, (req, res) => {
            serveFile(mediaMap.get(req.params.token), req, res);
        });
    }

    // ── 路由 4: web 壁纸目录托管 ───────────────────────────────

    /**
     * 把请求的相对路径解析成绝对路径，并确认它仍在壁纸目录内。
     * @returns {string|null} 安全的绝对路径；越界返回 null
     */
    function safeResolve(dirAbs, relPath) {
        let decoded;
        try {
            decoded = decodeURIComponent(relPath || '');
        } catch {
            return null;      // 非法百分号编码
        }
        if (decoded.includes('\0')) return null;   // NUL 截断攻击

        const abs = resolve(dirAbs, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
        const rootAbs = resolve(dirAbs);
        // 归一化后必须等于根目录或位于根目录之下
        if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
        // 双保险：relative 不得回溯
        const rel = relative(rootAbs, abs);
        if (rel.startsWith('..')) return null;
        return abs;
    }

    /**
     * app.use 挂前缀（而非 app.get 通配符）：Express 4/5 语义一致，
     * 且 req.path 自动剥掉前缀，省去手工切串的差异。
     */
    app.use(`${BASE}/web`, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();

        ensureWebMap();

        // req.path 形如 /<token>/relative/path 或 /<token>/
        const parts = req.path.split('/').filter(Boolean);
        const token = parts.shift();
        const entry = token ? webMap.get(token) : null;
        if (!entry) {
            res.status(404).end('unknown web wallpaper token');
            return;
        }

        // 空路径 = 入口页：注入 WE API 垫片后返回
        if (parts.length === 0) {
            if (!existsSync(entry.entryAbs)) {
                res.status(404).end('entry not found');
                return;
            }
            let html;
            try {
                html = readFileSync(entry.entryAbs, 'utf8');
            } catch (err) {
                res.status(500).end('failed to read entry: ' + (err && err.message));
                return;
            }
            const body = injectShim(html, entry.properties);
            res.status(200)
                .setHeader('Content-Type', 'text/html; charset=utf-8')
                .setHeader('Cache-Control', 'no-store')
                .end(body);
            return;
        }

        const abs = safeResolve(entry.dirAbs, parts.join('/'));
        if (!abs) {
            res.status(403).end('path outside wallpaper directory');
            return;
        }

        // lstat 而非 stat：符号链接不跟随，避免软链指向目录外
        let st;
        try {
            st = lstatSync(abs);
        } catch {
            res.status(404).end('not found');
            return;
        }
        if (!st.isFile()) {
            res.status(404).end('not a file');
            return;
        }

        // 壁纸目录内的 .html 也注入垫片（部分壁纸有 index2.html 之类的子页面）
        if (/\.html?$/i.test(abs)) {
            try {
                const body = injectShim(readFileSync(abs, 'utf8'), entry.properties);
                res.status(200)
                    .setHeader('Content-Type', 'text/html; charset=utf-8')
                    .end(body);
                return;
            } catch {
                // 读取失败则退回二进制流式
            }
        }

        res.setHeader('Content-Type', mimeFor(abs));
        res.setHeader('Content-Length', String(st.size));
        createReadStream(abs).pipe(res);
    });

    console.log(`[VCPWEWallpaper] 路由已注册: ${BASE}/inventory, ${BASE}/media/:token, ${BASE}/preview/:token, ${BASE}/web/:token/*`);
}

module.exports = { registerRoutes, BASE };
