// Musicmodules/music-spectrum.js
// 频谱检查（真假无损）：把正在放的这首解码一遍，画出整首歌的频谱图，并看高频在哪里被「齐刷刷切掉」——
// 有损文件（MP3/AAC）编码时会把 16–20 kHz 以上砍掉，转成 FLAC 之后这道切口还在；
// 高采样率文件如果 22 kHz 以上什么都没有，多半是从 CD 规格升上来的。
// 只在本机算，不联网；结果只是按频谱估计，老录音、某些母带本身高频就少，可能误判。
//
// 对外：命令面板「看这首的频谱（真假无损）」→ MusicSpectrum.open(app)；纯函数 fft、spectrumColumns、findCutoff、verdict 供测试。

(function (global) {
    'use strict';

    const FFT_SIZE = 4096;
    const COLUMNS = 560;
    const ROWS = 220;
    const LOSSLESS_EXT = /\.(flac|wav|aiff?|alac|ape|wv)$/i;

    // 原地 radix-2 FFT（re、im 长度为 2 的幂）
    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            const wr = Math.cos(ang);
            const wi = Math.sin(ang);
            const half = len >> 1;
            for (let i = 0; i < n; i += len) {
                let cr = 1;
                let ci = 0;
                for (let k = 0; k < half; k++) {
                    const a = i + k;
                    const b = a + half;
                    const xr = re[b] * cr - im[b] * ci;
                    const xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                    const nr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = nr;
                }
            }
        }
    }

    let hannCacheSize = 0;
    let hannCache = null;
    function getHannWindow(size) {
        if (hannCacheSize === size && hannCache) return hannCache;
        const win = new Float32Array(size);
        const factor = (2 * Math.PI) / (size - 1);
        for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos(factor * i);
        if (size === FFT_SIZE) { hannCacheSize = size; hannCache = win; }
        return win;
    }

    /*
     * channels: Float32Array[]（各声道采样），返回 { columns: Float32Array[]（每列 FFT_SIZE/2 个 dB 值）, average: Float32Array }。
     * average 只算有声音的列（安静的片头片尾不拉低高频）。
     */
    function spectrumColumns(channels, { columns = COLUMNS, size = FFT_SIZE } = {}) {
        const length = channels[0] ? channels[0].length : 0;
        const bins = size >> 1;
        const window = getHannWindow(size);
        const count = Math.max(1, Math.min(columns, Math.floor(length / size)));
        const step = count > 1 ? (length - size) / (count - 1) : 0;
        const out = [];
        const power = new Float64Array(bins);
        let loud = 0;
        const re = new Float32Array(size);
        const im = new Float32Array(size);
        const chCount = channels.length;
        const ch0 = channels[0];
        const ch1 = channels[1];
        const invCh = chCount > 0 ? 1 / chCount : 0;
        for (let c = 0; c < count; c++) {
            const start = Math.floor(c * step);
            let energy = 0;
            if (chCount === 1) {
                for (let i = 0; i < size; i++) {
                    const v = ch0[start + i] || 0;
                    energy += v * v;
                    re[i] = v * window[i];
                    im[i] = 0;
                }
            } else if (chCount === 2) {
                for (let i = 0; i < size; i++) {
                    const v = ((ch0[start + i] || 0) + (ch1[start + i] || 0)) * 0.5;
                    energy += v * v;
                    re[i] = v * window[i];
                    im[i] = 0;
                }
            } else {
                for (let i = 0; i < size; i++) {
                    let v = 0;
                    for (let j = 0; j < chCount; j++) v += channels[j][start + i] || 0;
                    v *= invCh;
                    energy += v * v;
                    re[i] = v * window[i];
                    im[i] = 0;
                }
            }
            fft(re, im);
            const col = new Float32Array(bins);
            const isLoud = energy / size > 1e-5; // 大约 -50 dBFS 以上才算有声音
            const invN2 = 1 / (size * size);
            if (isLoud) loud++;
            for (let k = 0; k < bins; k++) {
                const p = (re[k] * re[k] + im[k] * im[k]) * invN2;
                col[k] = 10 * Math.log10(p + 1e-20);
                if (isLoud) power[k] += p + 1e-20;
            }
            out.push(col);
        }
        const average = new Float32Array(bins);
        for (let k = 0; k < bins; k++) average[k] = loud ? 10 * Math.log10(power[k] / loud + 1e-20) : -200;
        return { columns: out, average, loud };
    }

    /*
     * 找「切口」：某个频率上下两侧平均电平差 20 dB 以上，而且切口上方一直到奈奎斯特都很安静。
     * 返回切口频率（Hz），没有切口返回 0。只看 11 kHz 以上。
     */
    function findCutoff(average, sampleRate, { minHz = 11000, drop = 20 } = {}) {
        const bins = average.length;
        const hz = (k) => k * sampleRate / (2 * bins);
        const binOf = (f) => Math.round(f * 2 * bins / sampleRate);
        const span = Math.max(3, binOf(250));
        const gap = Math.max(1, binOf(60));
        const mean = (a, b) => {
            let s = 0; let n = 0;
            for (let k = Math.max(0, a); k < Math.min(bins, b); k++) { s += average[k]; n++; }
            return n ? s / n : -200;
        };
        const ref = mean(binOf(1000), binOf(6000));
        let best = 0;
        let bestDrop = drop;
        for (let k = binOf(minHz); k < bins - span - gap; k++) {
            const below = mean(k - gap - span, k - gap);
            const above = mean(k + gap, k + gap + span);
            const d = below - above;
            if (d <= bestDrop) continue;
            // 上方到顶都要安静：比中频低 50 dB 以上，或者和紧挨着的上方一样低
            const rest = mean(k + gap, bins - 1);
            if (rest > ref - 50 && rest > above + 6) continue;
            bestDrop = d;
            best = k;
        }
        return best ? Math.round(hz(best)) : 0;
    }

    const kHz = (f) => (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.0+$/, '') + ' kHz';

    // 按切口和文件规格给一句话结论；level: good / warn / info。
    // 常见编码器的低通：128 kbps 约 16–17 kHz，192 kbps 约 18.5–19 kHz，256 kbps 约 19.5–20 kHz，320 kbps 约 20–20.5 kHz
    // （找到的切口会比编码器设的低通略高一点，阈值留了余量）
    const LOSSY_GUESS = [[17800, '128 kbps 左右'], [19400, '160–192 kbps'], [20300, '256 kbps 左右'], [21000, '320 kbps']];
    function verdict({ cutoff, sampleRate, lossless }) {
        const nyquist = sampleRate / 2;
        if (!lossless) {
            return { level: 'info', text: cutoff ? `这是有损文件，频谱到 ${kHz(cutoff)} 为止，属于正常。` : `这是有损文件，频谱一直到 ${kHz(nyquist)}。` };
        }
        const guess = cutoff ? LOSSY_GUESS.find(([limit]) => cutoff < limit) : null;
        if (guess) return { level: 'warn', text: `频谱在 ${kHz(cutoff)} 处被齐刷刷切掉，像是 ${guess[1]}${/[a-z0-9]$/i.test(guess[1]) ? ' ' : ''}的有损文件转成的${sampleRate > 50000 ? '高采样率文件' : '无损'}。` };
        if (sampleRate > 50000) {
            if (cutoff && cutoff < 24500) return { level: 'warn', text: `标的是 ${kHz(sampleRate)} 高采样率，但 ${kHz(cutoff)} 以上几乎没有内容，像是从 CD 规格（44.1/48 kHz）升上来的。` };
            return { level: 'good', text: cutoff ? `频谱到 ${kHz(cutoff)}，高于 CD 规格，看着是真的高解析度。` : `频谱一直到 ${kHz(nyquist)}，看着是真的高解析度。` };
        }
        return { level: 'good', text: cutoff ? `频谱到 ${kHz(cutoff)}，基本完整，看着是真无损。` : `频谱一直到 ${kHz(nyquist)}，看着是真无损。` };
    }

    // dB → 颜色（暗紫 → 品红 → 橙 → 浅黄，和常见的频谱软件一样，暗色亮色主题下都看得清）
    const STOPS = [[0, [8, 6, 22]], [0.3, [70, 18, 110]], [0.55, [190, 40, 110]], [0.78, [245, 130, 40]], [1, [252, 245, 180]]];
    function colorOf(t) {
        const x = Math.max(0, Math.min(1, t));
        for (let i = 1; i < STOPS.length; i++) {
            if (x <= STOPS[i][0]) {
                const [a, ca] = STOPS[i - 1];
                const [b, cb] = STOPS[i];
                const u = (x - a) / (b - a);
                return [0, 1, 2].map((j) => Math.round(ca[j] + (cb[j] - ca[j]) * u));
            }
        }
        return STOPS[STOPS.length - 1][1];
    }

    const COLOR_LUT = (() => {
        const lut = new Uint8Array(256 * 3);
        for (let i = 0; i < 256; i++) {
            const [r, g, b] = colorOf(i / 255);
            lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
        }
        return lut;
    })();

    function setupMusicSpectrum(app) {
        if (!app || app.openSpectrum) return;
        const doc = global.document;
        let overlay = null;
        let previousFocus = null;
        let openRaf = 0;
        const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const title = (t) => (app.stripAudioExtension ? app.stripAudioExtension(t.title || '') : String(t.title || '')) || '未知标题';
        const close = () => {
            if (!overlay) return;
            if (openRaf && typeof global.cancelAnimationFrame === 'function') { global.cancelAnimationFrame(openRaf); openRaf = 0; }
            const o = overlay;
            overlay = null;
            global.removeEventListener('keydown', onKey, true);
            o.classList.remove('visible');
            setTimeout(() => {
                const cv = o.querySelector('.mspec-canvas');
                if (cv) { cv.width = 1; cv.height = 1; }
                o.remove();
            }, 320);
            const back = previousFocus;
            previousFocus = null;
            if (back && back.isConnected && typeof back.focus === 'function') {
                try { back.focus({ preventScroll: true }); } catch (e) { /* 还不回去就算了 */ }
            }
        };
        const onKey = (e) => {
            if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'Tab' && overlay) {
                const focusables = [...overlay.querySelectorAll('button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])')];
                if (focusables.length) {
                    const first = focusables[0], last = focusables[focusables.length - 1];
                    const active = doc.activeElement;
                    if (e.shiftKey ? (active === first || !overlay.contains(active)) : (active === last || !overlay.contains(active))) {
                        e.preventDefault();
                        (e.shiftKey ? last : first).focus({ preventScroll: true });
                    }
                }
                return;
            }
            if (NAV_KEYS.has(e.key)) { e.stopPropagation(); return; }
            if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) e.stopPropagation();
        };
        global.addEventListener?.('beforeunload', close, { once: true });
        const setStatus = (target, text) => {
            if (overlay !== target) return;
            const s = target && target.querySelector('.mspec-status');
            if (s) s.textContent = text;
        };

        const draw = (canvas, result, sampleRate) => {
            const { columns } = result;
            const bins = columns[0].length;
            const nyquist = sampleRate / 2;
            const w = columns.length;
            canvas.width = w;
            canvas.height = ROWS;
            const ctx = canvas.getContext('2d');
            const img = ctx.createImageData(w, ROWS);
            // 颜色范围：取整首的最大值往下 100 dB
            let top = -200;
            for (const col of columns) for (let k = 4; k < bins; k++) if (col[k] > top) top = col[k];
            const floor = top - 100;
            const invRange = 255 / (top - floor);
            const data = img.data;
            const k0Lut = new Int32Array(ROWS);
            const k1Lut = new Int32Array(ROWS);
            for (let y = 0; y < ROWS; y++) {
                const k0 = Math.floor(((ROWS - 1 - y) / ROWS) * bins);
                const k1 = Math.min(bins, Math.max(k0 + 1, Math.floor(((ROWS - y) / ROWS) * bins)));
                k0Lut[y] = k0;
                k1Lut[y] = k1;
            }
            for (let x = 0; x < w; x++) {
                const col = columns[x];
                for (let y = 0; y < ROWS; y++) {
                    const k0 = k0Lut[y];
                    const k1 = k1Lut[y];
                    let m = -200;
                    for (let k = k0; k < k1; k++) if (col[k] > m) m = col[k];
                    const idx = Math.max(0, Math.min(255, Math.round((m - floor) * invRange))) * 3;
                    const o = (y * w + x) * 4;
                    data[o] = COLOR_LUT[idx]; data[o + 1] = COLOR_LUT[idx + 1]; data[o + 2] = COLOR_LUT[idx + 2]; data[o + 3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);
        };

        const analyse = async (track, cur) => {
            const res = await app.api?.readMusicAudioFile?.({ path: track.path });
            if (overlay !== cur) return;
            if (!res || !res.ok) { setStatus(cur, res && res.message ? res.message : '读不到这个文件'); return; }
            setStatus(cur, '正在解码…');
            const bytes = res.data instanceof ArrayBuffer ? res.data : res.data.buffer.slice(res.data.byteOffset, res.data.byteOffset + res.data.byteLength);
            const wanted = Math.max(8000, Math.min(384000, Number(track.sampleRate) || 44100));
            let audio;
            try {
                const Offline = global.OfflineAudioContext || global.webkitOfflineAudioContext;
                audio = await new Offline(1, 1, wanted).decodeAudioData(bytes);
            } catch (e) {
                setStatus(cur, '这个格式窗口里解不开（APE、DSD、部分 ALAC 不支持），换一首试试。');
                return;
            }
            if (overlay !== cur) return;
            setStatus(cur, '正在分析…');
            await new Promise((r) => setTimeout(r, 30));
            if (overlay !== cur) return;
            const channels = [];
            for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(audio.getChannelData(c));
            const result = spectrumColumns(channels);
            if (overlay !== cur) return;
            const sampleRate = audio.sampleRate;
            const cutoff = findCutoff(result.average, sampleRate);
            const lossless = track.lossless === true || LOSSLESS_EXT.test(String(track.path || ''));
            const v = verdict({ cutoff, sampleRate, lossless });
            const body = cur.querySelector('.mspec-body');
            body.innerHTML = '';
            const verdictBox = el('p', 'mspec-verdict ' + v.level, v.text);
            body.appendChild(verdictBox);
            const figure = el('div', 'mspec-figure');
            const axis = el('div', 'mspec-yaxis');
            const nyquist = sampleRate / 2;
            const marks = nyquist > 30000 ? [0, 20000, 40000, 60000, 80000].filter((f) => f <= nyquist) : [0, 5000, 10000, 15000, 20000].filter((f) => f <= nyquist);
            for (const f of marks) {
                const m = el('span', '', f ? `${f / 1000}k` : '0');
                m.style.bottom = `${(f / nyquist) * 100}%`;
                axis.appendChild(m);
            }
            const canvas = el('canvas', 'mspec-canvas');
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', `频谱图：${v.text}`);
            const plot = el('div', 'mspec-plot');
            plot.appendChild(canvas);
            if (cutoff) {
                const line = el('i', 'mspec-cut');
                line.style.bottom = `${(cutoff / nyquist) * 100}%`;
                line.title = `切口 ${kHz(cutoff)}`;
                plot.appendChild(line);
            }
            figure.appendChild(axis);
            figure.appendChild(plot);
            body.appendChild(figure);
            const totalSec = Math.max(0, Math.round(audio.duration));
            const mins = Math.floor(totalSec / 60);
            const secs = String(totalSec % 60).padStart(2, '0');
            const spec = [String(track.path || '').split('.').pop().toUpperCase(), `${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz`, track.bitsPerSample ? `${track.bitsPerSample} bit` : '', track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '', `${mins}:${secs}`].filter(Boolean).join(' · ');
            body.appendChild(el('p', 'mspec-spec', spec));
            body.appendChild(el('p', 'mstats-note', '只是按频谱估计：老录音、某些母带本身高频就少，也会显示成被切掉。'));
            draw(canvas, result, sampleRate);
        };

        app.openSpectrum = async (ref) => {
            if (overlay) return;
            const track = ref && typeof ref === 'object' ? ref : app.playlist?.[typeof ref === 'number' ? ref : app.currentTrackIndex];
            const toast = (message) => { try { global.MusicToast?.show?.({ message }); } catch (e) { /* 没有提示层 */ } };
            if (!track || !track.path) { toast('先放一首歌再看频谱'); return; }
            if (/^[a-z][a-z0-9+.-]{2,}:\/\//i.test(String(track.path))) { toast('网络上的歌没法看频谱'); return; }
            previousFocus = doc.activeElement;
            const cur = el('div', 'dialog-overlay music-stats-dialog');
            overlay = cur;
            const dialog = el('div', 'dialog glass-panel mstats mspec');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'mspec-title');
            const head = el('header', 'mstats-head');
            const h = el('h3', '', '频谱');
            h.id = 'mspec-title';
            head.appendChild(h);
            head.appendChild(el('span', 'mspec-track', `${title(track)}${track.artist ? ' · ' + track.artist : ''}`));
            const x = el('button', 'mstats-close', '×');
            x.type = 'button';
            x.setAttribute('aria-label', '关闭');
            x.addEventListener('click', close);
            head.appendChild(x);
            dialog.appendChild(head);
            const body = el('div', 'mstats-body mspec-body');
            body.appendChild(el('p', 'mspec-status', '正在读取文件…'));
            dialog.appendChild(body);
            cur.appendChild(dialog);
            cur.addEventListener('mousedown', (e) => { if (e.target === cur) close(); });
            doc.body.appendChild(cur);
            global.addEventListener('keydown', onKey, true);
            openRaf = global.requestAnimationFrame?.(() => { openRaf = 0; if (overlay === cur) cur.classList.add('visible'); }) || 0;
            try { x.focus({ preventScroll: true }); } catch (e) { /* 没关系 */ }
            try { await analyse(track, cur); } catch (e) { setStatus(cur, '分析失败：' + (e && e.message || e)); }
        };

        // 右键菜单：看这首的频谱
        const menu = app.contextMenu;
        if (menu && doc && !menu.querySelector('[data-action="spectrum"]')) {
            const item = el('div', 'context-menu-item');
            item.dataset.action = 'spectrum';
            item.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3"/></svg><span>看频谱（真假无损）</span>';
            const anchor = menu.querySelector('[data-action="start-radio"]') || menu.querySelector('[data-action="add-to-queue"]');
            if (anchor && anchor.parentNode === menu) menu.insertBefore(item, anchor.nextSibling); else menu.appendChild(item);
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.classList.remove('visible');
                app.openSpectrum(app.contextMenuTrackIndex);
            });
        }
    }

    const open = (app, ref) => { setupMusicSpectrum(app); return app?.openSpectrum?.(ref); };
    const exported = { setupMusicSpectrum, open, fft, spectrumColumns, findCutoff, verdict };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicSpectrum = exported;
})(typeof window !== 'undefined' ? window : globalThis);
