// 旧版音乐界面（上游原版）必须原样保留、能打开、能切回新版。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LEGACY = path.join(ROOT, 'Musicmodules-legacy');
const BRIDGE_LINE = '    <script src="legacy-bridge.js"></script>\n';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('旧版文件夹和上游原版逐个一致（music.html 只多一行接线脚本）', () => {
    const manifest = fs.readFileSync(path.join(LEGACY, 'UPSTREAM.sha256'), 'utf8').trim().split('\n');
    assert.ok(manifest.length > 50);
    for (const line of manifest) {
        const [hash, rel] = line.split(/\s+/);
        let buf = fs.readFileSync(path.join(LEGACY, rel));
        // Windows 上检出可能把换行换成 CRLF；文本文件按 LF 比
        if (!/\.(webp|png|jpe?g)$/i.test(rel)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
        if (rel === 'music.html') {
            const text = buf.toString('utf8');
            assert.strictEqual(text.split(BRIDGE_LINE).length, 2, 'music.html 里接线脚本只引一次');
            buf = Buffer.from(text.replace(BRIDGE_LINE, ''), 'utf8');
        }
        assert.strictEqual(sha(buf), hash, `${rel} 和上游原版不一致`);
    }
});

test('旧版页面引用的文件都在', () => {
    const html = fs.readFileSync(path.join(LEGACY, 'music.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:)/.test(u));
    assert.ok(refs.length > 30);
    for (const ref of refs) assert.ok(fs.existsSync(path.join(LEGACY, ref)), `缺少 ${ref}`);
    // 接线脚本要在频谱之前，才能换掉写死的引擎端口
    assert.ok(html.indexOf('legacy-bridge.js') < html.indexOf('music-visualizer.js'));
});

test('主进程按设置打开新版或旧版，预加载给了切换接口，新版有开关', () => {
    const handlers = fs.readFileSync(path.join(ROOT, 'modules/ipc/musicHandlers.js'), 'utf8');
    assert.match(handlers, /'Musicmodules-legacy', 'music\.html'/);
    assert.match(handlers, /'Musicmodules', 'music\.html'/);
    assert.match(handlers, /ipcMain\.handle\('music-set-legacy-ui'/);
    const preload = require(path.join(ROOT, 'preloads/api/music.js'));
    assert.ok(preload.api.setMusicLegacyUI && preload.api.getMusicLegacyUI);
    const current = fs.readFileSync(path.join(ROOT, 'Musicmodules/music.html'), 'utf8');
    assert.match(current, /id="legacy-ui-switch"/);
    assert.match(current, /music-legacy-switch\.js/);
});

test('旧版页面调用的每个接口，音乐窗口的预加载里都有', () => {
    const used = new Set();
    for (const f of fs.readdirSync(LEGACY).filter((n) => n.endsWith('.js'))) {
        for (const m of fs.readFileSync(path.join(LEGACY, f), 'utf8').matchAll(/api\??\.([a-zA-Z]+)\??\(/g)) used.add(m[1]);
    }
    const visible = new Set();
    for (const f of fs.readdirSync(path.join(ROOT, 'preloads/api'))) {
        let mod; try { mod = require(path.join(ROOT, 'preloads/api', f)); } catch (e) { continue; }
        for (const [k, d] of Object.entries(mod.api || {})) if (((d && d.allowedRoles) || mod.roles || []).includes('utility')) visible.add(k);
    }
    assert.ok(used.size > 40);
    assert.deepStrictEqual([...used].filter((k) => !visible.has(k)), []);
});
