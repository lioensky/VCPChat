/*
 * Serves the music window's markup and stage scripts from a checkout, with
 * the player replaced by harness.js. Shared by the offline profilers.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
    '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.json': 'application/json',
    '.woff2': 'font/woff2', '.svg': 'image/svg+xml'
};
module.exports = (ROOT) => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (url === '/blank.html') {
            res.writeHead(200, { 'content-type': TYPES['.html'] });
            return res.end('<!doctype html><title>profile</title>');
        }
        if (url === '/Musicmodules/harness.html') {
            let html = fs.readFileSync(path.join(ROOT, 'Musicmodules/music.html'), 'utf8');
            const cut = html.indexOf('<script src="music-utils.js">');
            const end = html.indexOf('</body>');
            html = `${html.slice(0, cut)}<script src="/__bench/harness.js"></script>\n${html.slice(end)}`;
            res.writeHead(200, { 'content-type': TYPES['.html'] });
            return res.end(html);
        }
        let file;
        if (url.startsWith('/__bench/')) file = path.join(__dirname, url.slice(9));
        else if (url === '/node_modules/pixi.js/dist/pixi.min.js') file = path.join(ROOT, 'vendor/pixi.min.js');
        else file = path.join(ROOT, url);
        fs.readFile(file, (error, body) => {
            if (error) { res.writeHead(404); return res.end('not found'); }
            res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
            res.end(body);
        });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
});

