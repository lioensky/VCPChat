'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { GsvPresetStore, synthesize, LANGUAGES, endpoint } = require('../modules/voice/gsvPresets');
function createManager({ store = new GsvPresetStore(), port = 9885 } = {}) {
    let busy = false;
    const server = http.createServer(async (req, res) => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const send = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(value));
        };
        try {
            if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) {
                return send(403, { error: '仅允许本机同源访问' });
            }
            if (req.method !== 'GET' && req.headers['x-gsv-manager'] !== '1') return send(403, { error: '缺少管理器请求标记' });
            const url = new URL(req.url, origin);
            const body = async () => {
                const chunks = []; let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 21 * 1024 * 1024) throw new Error('请求超过 21 MB');
                    chunks.push(chunk);
                }
                return Buffer.concat(chunks);
            };
            const json = async () => JSON.parse((await body()).toString('utf8'));
            if (req.method === 'GET' && url.pathname === '/api/presets') return send(200, { ...await store.read(), languages: LANGUAGES });
            if (req.method === 'POST' && url.pathname === '/api/audio') return send(200, await store.importAudio(await body()));
            if (req.method === 'POST' && url.pathname === '/api/presets') return send(200, await store.save(await json()));
            if (req.method === 'DELETE' && url.pathname === '/api/presets') return send(200, await store.remove(url.searchParams.get('id')));
            if (req.method === 'POST' && url.pathname === '/api/preview') {
                if (busy) return send(409, { error: '管理器正在试听合成，请等待' });
                const input = await json();
                const baseUrl = endpoint(input.baseUrl || 'http://127.0.0.1:9880');
                const host = new URL(baseUrl).hostname;
                if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('管理器试听仅支持本机引擎');
                if (!String(input.text || '').trim() || input.text.length > 2000) throw new Error('试听文本长度须为 1–2000 字');
                busy = true;
                try {
                    const preset = await store.resolve(input.id);
                    const audio = await synthesize({ store, preset, baseUrl, text: input.text });
                    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
                    res.end(audio);
                } finally { busy = false; }
                return;
            }
            const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
            if (req.method === 'GET' && assets[url.pathname]) {
                const [file, type] = assets[url.pathname];
                res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'", 'Cache-Control': 'no-store' });
                return res.end(await fs.readFile(path.join(__dirname, file)));
            }
            send(404, { error: 'Not found' });
        } catch (error) {
            if (!res.headersSent) send(400, { error: error.message });
            else res.destroy();
        }
    });
    server.requestTimeout = 130000;
    server.headersTimeout = 10000;
    return server;
}
if (require.main === module) {
    const port = Number(process.env.GSV_MANAGER_PORT || 9885);
    const server = createManager({ port });
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`sovits5cppmanager: http://127.0.0.1:${port}`));
}
module.exports = { createManager };