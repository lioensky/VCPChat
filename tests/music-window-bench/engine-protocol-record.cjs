// 录下一个音频引擎对音乐窗口用到的那些接口的真实回应，给「新窗口配旧引擎」测试当样本。
// 用法：node tests/music-window-bench/engine-protocol-record.cjs <audio_server 路径> <输出.json>
// 没有声卡也能跑：引擎照样启动、加载、回应，只是 is_playing 不会变成 true。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

async function recordEngine(bin, { port = 47000 + Math.floor(Math.random() * 900) } = {}) {
    const child = spawn(bin, ['--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('engine did not start')), 15000);
            child.stdout.on('data', (chunk) => {
                if (String(chunk).includes('RUST_AUDIO_ENGINE_READY')) { clearTimeout(timer); resolve(); }
            });
            child.on('exit', (code) => reject(new Error(`engine exited ${code}`)));
        });
        const base = `http://127.0.0.1:${port}`;
        const call = async (route, method = 'GET', body) => {
            const res = await fetch(base + route, {
                method,
                headers: body ? { 'content-type': 'application/json' } : undefined,
                body: body ? JSON.stringify(body) : undefined
            });
            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) {}
            return { http: res.status, json };
        };

        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const ws = [];
        socket.on('message', (data, isBinary) => {
            if (isBinary) ws.push({ binary: true, bytes: data.length });
            else ws.push(JSON.parse(String(data)));
        });
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        await new Promise((resolve) => setTimeout(resolve, 600));
        const beforeLoad = ws.length;

        const fixture = path.resolve(__dirname, '../../rust_audio_engine/tests/fixtures/gapless/ref.flac');
        const out = {
            state: await call('/state'),
            settings: await call('/settings'),
            load: await call('/load', 'POST', { path: fixture })
        };
        await new Promise((resolve) => setTimeout(resolve, 800));
        out.play = await call('/play', 'POST');
        out.seek = await call('/seek', 'POST', { position: 0.1 });
        out.pause = await call('/pause', 'POST');
        // 新窗口保存设置时多带了 crossfade_ms；旧引擎得照样收下其他字段。
        out.saveSettings = await call('/save_settings', 'POST', { settings: { crossfade_ms: 0, volume: 0.7 } });
        out.stateAfter = await call('/state');
        await new Promise((resolve) => setTimeout(resolve, 400));
        out.wsBeforeLoad = ws.slice(0, beforeLoad);
        out.ws = ws.slice(beforeLoad);
        socket.close();
        return out;
    } finally {
        child.kill();
    }
}

module.exports = { recordEngine };

if (require.main === module) {
    const [bin, outFile] = process.argv.slice(2);
    recordEngine(bin).then((out) => {
        // 频谱帧每秒几十条，只留每种类型的第一条，样本才小。
        const seen = new Set();
        const keep = (list) => list.filter((m) => {
            const key = m.binary ? 'binary' : m.type;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        out.wsBeforeLoad = keep(out.wsBeforeLoad);
        out.ws = keep(out.ws);
        fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
        console.log('wrote', outFile);
    }).catch((e) => { console.error(e); process.exit(1); });
}
