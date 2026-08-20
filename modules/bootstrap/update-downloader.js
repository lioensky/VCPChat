'use strict';

const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { resolveContainedPath } = require('./runtime-closure');
const { validateUpdateManifest, validateUpdateSignature } = require('./update-manager');

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

function safeHttpsUrl(value, base = undefined) {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password) {
        const error = new Error(`只允许无凭据的 HTTPS 更新地址：${url.href}`); error.code = 'E_UPDATE_URL_INVALID'; throw error;
    }
    return url;
}

async function fetchChecked(url, options, { fetchImpl = globalThis.fetch, expectedOrigin = null } = {}) {
    if (typeof fetchImpl !== 'function') throw Object.assign(new Error('当前 Node 运行时不支持 fetch。'), { code: 'E_UPDATE_DOWNLOAD' });
    const response = await fetchImpl(url, { redirect: 'follow', ...options });
    const finalUrl = safeHttpsUrl(response.url || url.href);
    if (expectedOrigin && finalUrl.origin !== expectedOrigin) {
        throw Object.assign(new Error('更新下载发生跨源重定向。'), { code: 'E_UPDATE_URL_INVALID' });
    }
    if (!response.ok) throw Object.assign(new Error(`更新下载失败：HTTP ${response.status}`), { code: 'E_UPDATE_DOWNLOAD', status: response.status });
    return response;
}

async function downloadEntry({ entry, baseUrl, stagingRoot, fetchImpl } = {}) {
    const destination = resolveContainedPath(stagingRoot, entry.path);
    const part = `${destination}.part`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const url = safeHttpsUrl(entry.path, baseUrl);
    if (url.origin !== baseUrl.origin) throw Object.assign(new Error('更新文件必须与 manifest 同源。'), { code: 'E_UPDATE_URL_INVALID' });
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    const response = await fetchChecked(url, { headers }, { fetchImpl, expectedOrigin: baseUrl.origin });
    const append = offset > 0 && response.status === 206;
    if (offset > 0 && response.status === 206) {
        const range = response.headers.get('content-range') || '';
        if (!range.startsWith(`bytes ${offset}-`)) throw Object.assign(new Error('续传响应的 Content-Range 与本地偏移不一致。'), { code: 'E_UPDATE_DOWNLOAD' });
    }
    const stream = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    if (!response.body) throw Object.assign(new Error('更新响应没有 body。'), { code: 'E_UPDATE_DOWNLOAD' });
    const expectedSize = Number.isFinite(entry.size) ? Math.max(0, entry.size) : null;
    let received = append ? offset : 0;
    const limiter = new Transform({
        transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (expectedSize != null && received > expectedSize) return callback(Object.assign(new Error('更新文件超过 manifest 声明大小。'), { code: 'E_UPDATE_INTEGRITY_FAILED' }));
            callback(null, chunk);
        },
    });
    try { await pipeline(Readable.fromWeb(response.body), limiter, stream); } catch (error) {
        try { fs.unlinkSync(part); } catch { /* best effort */ }
        throw error;
    }
    if (expectedSize != null && received !== expectedSize) {
        try { fs.unlinkSync(part); } catch { /* best effort */ }
        throw Object.assign(new Error('更新文件大小与 manifest 不一致。'), { code: 'E_UPDATE_INTEGRITY_FAILED' });
    }
    fs.renameSync(part, destination);
    return { path: entry.path, resumedFrom: append ? offset : 0, bytes: fs.statSync(destination).size };
}

async function downloadSignedUpdate({ manifestUrl, publicKey, stagingRoot, fetchImpl = globalThis.fetch } = {}) {
    if (!publicKey) throw Object.assign(new Error('网络更新必须提供可信公钥。'), { code: 'E_UPDATE_SIGNATURE_INVALID' });
    const url = safeHttpsUrl(manifestUrl);
    const response = await fetchChecked(url, {}, { fetchImpl, expectedOrigin: url.origin });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MANIFEST_BYTES) throw Object.assign(new Error('更新 manifest 过大。'), { code: 'E_UPDATE_MANIFEST_INVALID' });
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw Object.assign(new Error('更新 manifest 不是有效 JSON。'), { code: 'E_UPDATE_MANIFEST_INVALID' }); }
    validateUpdateSignature({ manifest, publicKey });
    const version = String(manifest.version || '').replace(/[^a-z0-9._-]/gi, '');
    if (!version || !Array.isArray(manifest.files) || !manifest.files.length) throw Object.assign(new Error('更新 manifest 缺少版本或文件。'), { code: 'E_UPDATE_MANIFEST_INVALID' });
    fs.mkdirSync(stagingRoot, { recursive: true });
    const results = [];
    for (const entry of manifest.files) results.push(await downloadEntry({ entry, baseUrl: url, stagingRoot, fetchImpl }));
    validateUpdateManifest({ sourceRoot: stagingRoot, manifest, publicKey });
    return { manifest, sourceRoot: stagingRoot, files: results };
}

module.exports = { MAX_MANIFEST_BYTES, safeHttpsUrl, fetchChecked, downloadEntry, downloadSignedUpdate };
