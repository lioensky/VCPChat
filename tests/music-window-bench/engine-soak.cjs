// 引擎长时间续播的内存和句柄：反复「加载 → 等 load_complete → 预载下一首 → 再加载」几百轮，
// 每 N 轮记一次引擎进程的 RSS、线程数、打开的文件数。没有声卡也能跑（只测加载/解码/预载这条路）。
// 用法：node tests/music-window-bench/engine-soak.cjs <audio_server> [轮数=300] [曲目目录]
// 曲目目录不给时用 ffmpeg 在临时目录生成 6 首 30 秒的 flac/mp3。
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const [bin, roundsArg, dirArg] = process.argv.slice(2);
const rounds = Number(roundsArg) || 300;

function makeTracks() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-soak-'));
    const files = [];
    for (let i = 0; i < 6; i++) {
        const ext = i % 2 ? 'mp3' : 'flac';
        const file = path.join(dir, `t${i}.${ext}`);
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${220 + i * 110}:duration=30:sample_rate=${i % 3 ? 44100 : 48000}`,
            '-ac', '2', file]);
        files.push(file);
    }
    return files;
}

const proc = (pid) => {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const field = (name) => Number((status.match(new RegExp(`${name}:\\s+(\\d+)`)) || [])[1]);
    return { rssMb: +(field('VmRSS') / 1024).toFixed(1), threads: field('Threads'), fds: fs.readdirSync(`/proc/${pid}/fd`).length };
};

(async () => {
    const tracks = dirArg
        ? fs.readdirSync(dirArg).filter((f) => /\.(flac|mp3|m4a|wav|ogg)$/i.test(f)).map((f) => path.join(dirArg, f))
        : makeTracks();
    const port = 47000 + Math.floor(Math.random() * 900);
    const child = spawn(bin, ['--port', String(port)], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve) => child.stdout.on('data', (c) => String(c).includes('READY') && resolve()));
    const base = `http://127.0.0.1:${port}`;
    const post = (route, body) => fetch(base + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
    }).then((r) => r.json());

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let loaded = null;
    socket.on('message', (data, binary) => {
        if (binary) return;
        const m = JSON.parse(String(data));
        if ((m.type === 'load_complete' || m.type === 'load_error') && loaded) loaded(m);
    });
    await new Promise((resolve) => socket.once('open', resolve));

    const samples = [{ round: 0, ...proc(child.pid) }];
    const started = Date.now();
    for (let i = 1; i <= rounds; i++) {
        const done = new Promise((resolve) => { loaded = resolve; });
        await post('/load', { path: tracks[i % tracks.length] });
        const m = await Promise.race([done, new Promise((r) => setTimeout(() => r({ type: 'timeout' }), 20000))]);
        if (m.type !== 'load_complete') console.log('round', i, m.type, m.error || '');
        await post('/play');
        if (process.env.SOAK_FULL) {
            // 等整首解码完，和真实续播一样每首都完整进内存。
            for (let t = 0; t < 400; t++) {
                const st = await fetch(base + '/state').then((r) => r.json());
                if (st.state?.decode_complete !== false && !st.state?.is_loading) break;
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        await post('/queue_next', { path: tracks[(i + 1) % tracks.length] });
        await post('/seek', { position: 12 });
        if (i % 3 === 0) await post('/cancel_preload');
        if (i % Math.max(1, Math.floor(rounds / 10)) === 0) samples.push({ round: i, ...proc(child.pid) });
    }
    await new Promise((r) => setTimeout(r, 1500));
    samples.push({ round: 'idle+1.5s', ...proc(child.pid) });
    console.log(`${rounds} loads in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.table(samples);
    socket.close();
    child.kill();
})().catch((e) => { console.error(e); process.exit(1); });
