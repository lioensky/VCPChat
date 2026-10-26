// modules/services/minerU/minerUProtocol.js
// 只读资产协议：vcp-mineru://image/{paper_id}/{相对路径}
// 只允许访问 image/mineru/{该论文目录} 内的图片；路径穿越、盘符与目录外符号链接全部拒绝。
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const service = require('./minerUService');

const SCHEME = 'vcp-mineru';
const PAPER_ID_RE = /^paper_[A-Za-z0-9_-]+$/;
let installed = false;

function registerScheme(protocol) {
    protocol.registerSchemesAsPrivileged([{
        scheme: SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
        },
    }]);
}

function parseAssetUrl(rawUrl) {
    try {
        if (typeof rawUrl !== 'string' || rawUrl.length > 8192) return null;
        const url = new URL(rawUrl);
        if (url.protocol !== `${SCHEME}:` || url.host !== 'image') return null;
        if (url.username || url.password || url.search) return null;
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (parts.length < 2) return null;
        const paperId = parts.shift();
        if (!PAPER_ID_RE.test(paperId)) return null;
        const rel = parts.join('/');
        if (!rel) return null;
        return { paperId, rel };
    } catch {
        return null;
    }
}

function install({ protocol, net }) {
    if (installed) return;
    installed = true;
    protocol.handle(SCHEME, request => {
        if (request.method !== 'GET') {
            return new Response('Method Not Allowed', { status: 405 });
        }
        const parsed = parseAssetUrl(request.url);
        if (!parsed) return new Response('Not Found', { status: 404 });
        try {
            const filePath = service.resolveImagePath(parsed.paperId, parsed.rel);
            return net.fetch(pathToFileURL(filePath).href);
        } catch (error) {
            return new Response(error?.message || 'Not Found', { status: 404 });
        }
    });
}

module.exports = {
    SCHEME,
    registerScheme,
    install,
    parseAssetUrl,
    imageUrl(paperId, rel) {
        const normalized = String(rel || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter(Boolean)
            .map(encodeURIComponent)
            .join('/');
        return `${SCHEME}://image/${encodeURIComponent(paperId)}/${normalized}`;
    },
};
