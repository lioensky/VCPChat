'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const FONT_MIME_BY_SIGNATURE = Object.freeze({
    wOFF: { mime: 'font/woff', extension: 'woff' },
    wOF2: { mime: 'font/woff2', extension: 'woff2' },
    OTTO: { mime: 'font/otf', extension: 'otf' },
    true: { mime: 'font/ttf', extension: 'ttf' },
});
const MAX_STYLESHEET_BYTES = 512 * 1024;
const MAX_FONT_BYTES = 20 * 1024 * 1024;
const MAX_FONTS_PER_STYLESHEET = 48;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 20000;

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeUrl(value) {
    const parsed = new URL(String(value || '').trim());
    parsed.hash = '';
    return parsed.href;
}

function isPrivateAddress(address) {
    const normalized = String(address || '').replace(/^::ffff:/i, '');
    if (net.isIPv4(normalized)) {
        const parts = normalized.split('.').map(Number);
        return parts[0] === 10
            || parts[0] === 127
            || (parts[0] === 169 && parts[1] === 254)
            || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
            || (parts[0] === 192 && parts[1] === 168)
            || parts[0] === 0;
    }
    if (net.isIPv6(normalized)) {
        const lower = normalized.toLowerCase();
        return lower === '::1'
            || lower === '::'
            || lower.startsWith('fc')
            || lower.startsWith('fd')
            || /^fe[89ab]/.test(lower);
    }
    return true;
}

async function assertPublicHttps(resourceUrl) {
    const parsed = new URL(resourceUrl);
    if (parsed.protocol !== 'https:') {
        throw new Error('网络字体仅允许 HTTPS 地址。');
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
        throw new Error('网络字体地址无效。');
    }
    const addresses = await dns.lookup(parsed.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) =>
        isPrivateAddress(address)
    )) {
        throw new Error('网络字体地址解析到本机或私有网络，已拒绝。');
    }
    return parsed;
}

function requestBytes(resourceUrl, options = {}, redirects = 0) {
    return new Promise(async (resolve, reject) => {
        try {
            if (redirects > MAX_REDIRECTS) {
                throw new Error('网络字体重定向次数过多。');
            }
            const parsed = await assertPublicHttps(resourceUrl);
            const maxBytes = Math.max(1, Number(options.maxBytes) || 1);
            const request = (parsed.protocol === 'https:' ? https : http).get(
                parsed,
                {
                    timeout: REQUEST_TIMEOUT_MS,
                    headers: {
                        'User-Agent': 'VCP-Scriptorium/3',
                        Accept: options.accept || '*/*',
                    },
                },
                (response) => {
                    const status = Number(response.statusCode) || 0;
                    if ([301, 302, 303, 307, 308].includes(status)
                        && response.headers.location) {
                        response.resume();
                        const redirected = new URL(
                            response.headers.location,
                            parsed
                        ).href;
                        resolve(requestBytes(
                            redirected,
                            options,
                            redirects + 1
                        ));
                        return;
                    }
                    if (status < 200 || status >= 300) {
                        response.resume();
                        reject(new Error(`网络字体读取失败：HTTP ${status}`));
                        return;
                    }
                    const declared = Number(response.headers['content-length']);
                    if (Number.isFinite(declared) && declared > maxBytes) {
                        response.resume();
                        reject(new Error('网络字体资源超过安全上限。'));
                        return;
                    }
                    const chunks = [];
                    let size = 0;
                    response.on('data', (chunk) => {
                        size += chunk.length;
                        if (size > maxBytes) {
                            request.destroy(
                                new Error('网络字体资源超过安全上限。')
                            );
                            return;
                        }
                        chunks.push(chunk);
                    });
                    response.on('end', () => resolve({
                        bytes: Buffer.concat(chunks),
                        finalUrl: parsed.href,
                        contentType: String(
                            response.headers['content-type'] || ''
                        ).split(';', 1)[0].trim().toLowerCase(),
                    }));
                    response.on('error', reject);
                }
            );
            request.on('timeout', () =>
                request.destroy(new Error('网络字体读取超时。'))
            );
            request.on('error', reject);
        } catch (error) {
            reject(error);
        }
    });
}

function classifyFont(bytes) {
    const data = Buffer.from(bytes || []);
    const signature = data.subarray(0, 4).toString('ascii');
    if (FONT_MIME_BY_SIGNATURE[signature]) {
        return FONT_MIME_BY_SIGNATURE[signature];
    }
    if (data.length >= 4
        && data[0] === 0x00
        && data[1] === 0x01
        && data[2] === 0x00
        && data[3] === 0x00) {
        return { mime: 'font/ttf', extension: 'ttf' };
    }
    throw new Error('下载内容不是受支持的 WOFF、WOFF2、OTF 或 TTF 字体。');
}

function stylesheetFontUrls(css, stylesheetUrl) {
    const urls = [];
    const pattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s]+))\s*\)/gi;
    let match;
    while ((match = pattern.exec(String(css || '')))) {
        const supplied = match[1] || match[2] || match[3] || '';
        if (!supplied || /^(?:data|vdoc-resource):/i.test(supplied)) continue;
        urls.push({
            supplied,
            absolute: new URL(supplied, stylesheetUrl).href,
        });
    }
    return urls;
}

class ScriptoriumFontCacheService {
    constructor(options = {}) {
        this.root = path.join(
            options.appDataRoot,
            'Scriptorium',
            'font-cache'
        );
        this.blobRoot = path.join(this.root, 'blobs');
        this.indexPath = path.join(this.root, 'index.json');
        this.urlIndex = new Map();
        this.stylesheetIndex = new Map();
        this.pending = new Map();
        this.indexWriteQueue = Promise.resolve();
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return this;
        await fs.ensureDir(this.blobRoot);
        try {
            const stored = await fs.readJson(this.indexPath);
            Object.entries(stored?.urls || {}).forEach(([url, record]) => {
                if (/^[a-f0-9]{64}$/.test(record?.hash || '')) {
                    this.urlIndex.set(url, record);
                }
            });
            Object.entries(stored?.stylesheets || {})
                .forEach(([url, record]) => {
                    if (typeof record?.css === 'string'
                        && Array.isArray(record.resources)) {
                        this.stylesheetIndex.set(url, record);
                    }
                });
        } catch {}
        this.initialized = true;
        return this;
    }

    blobPath(record) {
        return path.join(
            this.blobRoot,
            `${record.hash}.${record.extension}`
        );
    }

    async persistIndex() {
        this.indexWriteQueue = this.indexWriteQueue
            .catch(() => {})
            .then(async () => {
                const payload = {
                    format: 'vcp-scriptorium-font-cache',
                    version: 1,
                    updatedAt: new Date().toISOString(),
                    urls: Object.fromEntries(this.urlIndex),
                    stylesheets: Object.fromEntries(this.stylesheetIndex),
                };
                const temporary = `${
                    this.indexPath
                }.writing-${process.pid}-${Date.now()}-${
                    crypto.randomBytes(4).toString('hex')
                }`;
                try {
                    await fs.writeJson(temporary, payload);
                    await fs.move(temporary, this.indexPath, {
                        overwrite: true,
                    });
                } finally {
                    await fs.remove(temporary).catch(() => {});
                }
            });
        return this.indexWriteQueue;
    }

    async cachedRecord(url) {
        const record = this.urlIndex.get(url);
        if (!record || !await fs.pathExists(this.blobPath(record))) {
            this.urlIndex.delete(url);
            return null;
        }
        return record;
    }

    async resolveFont(fontUrl) {
        await this.initialize();
        const url = normalizeUrl(fontUrl);
        const cached = await this.cachedRecord(url);
        if (cached) {
            return {
                ...cached,
                bytes: Uint8Array.from(await fs.readFile(
                    this.blobPath(cached)
                )),
                cache: 'hit',
            };
        }
        if (this.pending.has(url)) return this.pending.get(url);
        const operation = (async () => {
            const downloaded = await requestBytes(url, {
                maxBytes: MAX_FONT_BYTES,
                accept: 'font/woff2,font/woff,font/ttf,font/otf,*/*;q=0.1',
            });
            const classification = classifyFont(downloaded.bytes);
            const hash = sha256(downloaded.bytes);
            const record = {
                hash,
                mime: classification.mime,
                extension: classification.extension,
                size: downloaded.bytes.length,
                sourceUrl: url,
                finalUrl: downloaded.finalUrl,
                cachedAt: new Date().toISOString(),
            };
            const target = this.blobPath(record);
            if (!await fs.pathExists(target)) {
                const temporary = `${target}.part-${process.pid}-${Date.now()}`;
                await fs.writeFile(temporary, downloaded.bytes);
                await fs.move(temporary, target, { overwrite: false })
                    .catch(async (error) => {
                        await fs.remove(temporary).catch(() => {});
                        if (!await fs.pathExists(target)) throw error;
                    });
            }
            this.urlIndex.set(url, record);
            this.urlIndex.set(normalizeUrl(downloaded.finalUrl), record);
            await this.persistIndex();
            return {
                ...record,
                bytes: Uint8Array.from(downloaded.bytes),
                cache: 'downloaded',
            };
        })().finally(() => this.pending.delete(url));
        this.pending.set(url, operation);
        return operation;
    }

    async cachedStylesheet(url) {
        const cached = this.stylesheetIndex.get(url);
        if (!cached) return null;
        const resources = [];
        for (const reference of cached.resources) {
            const record = this.urlIndex.get(reference.url)
                || this.urlIndex.get(reference.sourceUrl);
            if (!record || record.hash !== reference.hash
                || !await fs.pathExists(this.blobPath(record))) {
                this.stylesheetIndex.delete(url);
                return null;
            }
            resources.push({
                ...record,
                ...reference,
                bytes: Uint8Array.from(await fs.readFile(
                    this.blobPath(record)
                )),
                cache: 'hit',
                reference: `vdoc-resource://fonts/${record.hash}`,
            });
        }
        return {
            success: true,
            stylesheetUrl: url,
            finalUrl: cached.finalUrl || url,
            css: cached.css,
            resources,
            cache: 'hit',
        };
    }

    async resolveStylesheet(stylesheetUrl) {
        await this.initialize();
        const url = normalizeUrl(stylesheetUrl);
        const cached = await this.cachedStylesheet(url);
        if (cached) return cached;
        const pendingKey = `stylesheet:${url}`;
        if (this.pending.has(pendingKey)) {
            return this.pending.get(pendingKey);
        }
        const operation = (async () => {
        const result = await requestBytes(url, {
            maxBytes: MAX_STYLESHEET_BYTES,
            accept: 'text/css,*/*;q=0.1',
        });
        const css = result.bytes.toString('utf8');
        const references = stylesheetFontUrls(css, result.finalUrl);
        if (references.length > MAX_FONTS_PER_STYLESHEET) {
            throw new Error(
                `字体样式表包含超过 ${MAX_FONTS_PER_STYLESHEET} 个字体资源。`
            );
        }
        const unique = new Map(
            references.map((reference) => [
                normalizeUrl(reference.absolute),
                reference,
            ])
        );
        const resources = [];
        for (const [fontUrl, reference] of unique) {
            const font = await this.resolveFont(fontUrl);
            resources.push({
                ...font,
                originalUrl: reference.supplied,
                url: fontUrl,
                reference: `vdoc-resource://fonts/${font.hash}`,
            });
        }
        let localizedCss = css;
        resources.forEach((resource) => {
            localizedCss = localizedCss
                .split(resource.originalUrl)
                .join(resource.reference)
                .split(resource.url)
                .join(resource.reference);
        });
        const stylesheetRecord = {
            finalUrl: result.finalUrl,
            css: localizedCss,
            resources: resources.map((resource) => ({
                hash: resource.hash,
                mime: resource.mime,
                extension: resource.extension,
                size: resource.size,
                sourceUrl: resource.sourceUrl,
                url: resource.url,
                originalUrl: resource.originalUrl,
            })),
            cachedAt: new Date().toISOString(),
        };
        this.stylesheetIndex.set(url, stylesheetRecord);
        this.stylesheetIndex.set(
            normalizeUrl(result.finalUrl),
            stylesheetRecord
        );
        await this.persistIndex();
        return {
            success: true,
            stylesheetUrl: url,
            finalUrl: result.finalUrl,
            css: localizedCss,
            resources,
            cache: 'downloaded',
        };
        })().finally(() => this.pending.delete(pendingKey));
        this.pending.set(pendingKey, operation);
        return operation;
    }
}

module.exports = {
    ScriptoriumFontCacheService,
    classifyFont,
    isPrivateAddress,
    normalizeUrl,
    stylesheetFontUrls,
};