// 列表视图与舞台浮层的界面胶水：曲目档案卡的规格字段、声学处理抽屉的开合与摘要。
// 只读 app 的状态、只改自己加的节点，不接管播放逻辑。
(function () {
    'use strict';

    const pad = (n, width) => String(n).padStart(width, '0');

    // 同一路径永远得到同一个档案号，歌单重排或筛选后编号不跳。
    const fileNumber = (track) => {
        const key = String(track?.path || track?.title || '');
        if (!key) return 'TRK-0000';
        let h = 2166136261;
        for (let i = 0; i < key.length; i++) {
            h ^= key.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return `TRK-${pad((h >>> 0) % 10000, 4)}`;
    };

    const extensionOf = (track) => {
        const match = /\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(String(track?.path || ''));
        return match ? match[1].toUpperCase() : '';
    };

    // 解析库给的编码名比较啰嗦（如 "MPEG 1 Layer 3"、"Vorbis I"），收成常见叫法。
    const CODEC_RULES = [
        [/^MPEG[ -]?[12](\.5)?[ -]LAYER[ -]?3/, 'MP3'],
        [/AAC/, 'AAC'],
        [/^VORBIS/, 'VORBIS'],
        [/^OPUS/, 'OPUS'],
        [/^ALAC/, 'ALAC'],
        [/^PCM/, 'PCM'],
    ];
    const format = (track) => {
        const raw = String(track?.codec || '').trim().toUpperCase();
        if (raw) {
            const rule = CODEC_RULES.find(([pattern]) => pattern.test(raw));
            return rule ? rule[1] : raw;
        }
        return extensionOf(track);
    };

    const sampleRate = (track) => {
        const hz = Number(track?.sampleRate);
        if (!(hz > 0)) return '';
        const khz = hz / 1000;
        return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
    };

    const bitDepth = (track) => {
        const bits = Number(track?.bitsPerSample);
        return bits > 0 ? `${bits} bit` : '';
    };

    const bitrate = (track) => {
        const bps = Number(track?.bitrate);
        return bps > 0 ? `${Math.round(bps / 1000)} kbps` : '';
    };

    const summary = (track) => [format(track), sampleRate(track), bitDepth(track), bitrate(track)]
        .filter(Boolean).join(' · ');

    // 档案页、底栏也可以用同一套格式，保证三处显示一致。
    window.MusicTrackSpecs = { fileNumber, format, sampleRate, bitDepth, bitrate, summary };

    const DRAWER_KEY = 'musicAcousticDrawerOpen';

    window.setupMusicSkin = (app) => {
        const fieldCache = new Map();
        const fields = (name) => {
            let list = fieldCache.get(name);
            if (!list || list.some((el) => !el.isConnected)) {
                list = Array.from(document.querySelectorAll(`[data-track-field="${name}"]`));
                fieldCache.set(name, list);
            }
            return list;
        };
        const setText = (name, value, empty = '—') => {
            const text = value || empty;
            const hide = !value && (!empty || empty === '—');
            for (const el of fields(name)) {
                if (el.textContent !== text) el.textContent = text;
                // 规格栏里读不出来的项（只剩一个「—」）整格收起，不摆一排破折号
                const cell = el.closest('.track-specs > div');
                if (cell && cell.hidden !== hide) cell.hidden = hide;
            }
        };

        const currentTrack = () => {
            const track = app.playlist?.[app.currentTrackIndex];
            return track && typeof track === 'object' ? track : null;
        };

        let lastPath = null;
        const renderTrack = () => {
            const track = currentTrack();
            const path = track?.path || null;
            const hasTrack = Boolean(track) && app.trackTitle?.textContent !== '未选择歌曲';
            document.body.classList.toggle('music-has-track', hasTrack);
            if (!hasTrack) {
                setText('file-number', '', '');
                setText('album', '曲目档案', '曲目档案');
                for (const name of ['format', 'sample-rate', 'bit-depth', 'bitrate', 'specs']) setText(name, '');
                lastPath = null;
                return;
            }
            const changed = path !== lastPath;
            lastPath = path;
            // 标题上方一行写这首在列表里排第几（原来是按路径算的假档案号，用户看不出意思）
            const total = Array.isArray(app.playlist) ? app.playlist.length : 0;
            const nth = Number(app.currentTrackIndex) + 1;
            setText('file-number', total > 0 && nth > 0 ? `第 ${nth} / ${total} 首` : '', '');
            setText('album', track.album || '未分类', '未分类');
            setText('format', format(track));
            setText('sample-rate', sampleRate(track));
            setText('bit-depth', bitDepth(track), track.lossless === false ? '有损' : '—');
            setText('bitrate', bitrate(track));
            setText('specs', summary(track), '');
            if (changed) {
                const reduceMotion = Boolean(window.MusicMotion?.reduced?.()
                    ?? window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
                const archiveOnly = document.body.classList.contains('music-archive-on')
                    && !document.body.classList.contains('music-stage-active');
                if (!reduceMotion && !archiveOnly) {
                    // 换曲时编号和曲名一起向上滚入；批量读写只触发一次回流。
                    const rollers = Array.from(document.querySelectorAll('.track-file-number, .music-stage-track-file'));
                    for (const el of rollers) el.classList.remove('is-rolling');
                    if (rollers.length) void rollers[0].offsetWidth;
                    for (const el of rollers) el.classList.add('is-rolling');
                }
            }
        };

        // 曲名由播放器在换曲和状态同步时写入；跟着它刷新，不用另开轮询。
        if (app.trackTitle) {
            new MutationObserver(renderTrack).observe(app.trackTitle, { childList: true, characterData: true, subtree: true });
        }
        renderTrack();

        if (app.trackBitrate) {
            const markSpec = () => app.trackBitrate.classList.toggle('is-spec', /^\d+\s*kbps$/.test(app.trackBitrate.textContent.trim()));
            new MutationObserver(markSpec).observe(app.trackBitrate, { childList: true, characterData: true, subtree: true });
            markSpec();
        }

        // 声学处理抽屉：默认收起，记住上次的开合。
        const drawer = document.getElementById('acoustic-drawer');
        const toggle = drawer?.querySelector('.acoustic-drawer-toggle');
        const summaryEl = drawer?.querySelector('[data-acoustic-summary]');
        if (drawer && toggle) {
            let open = false;
            try { open = localStorage.getItem(DRAWER_KEY) === '1'; } catch (error) {}
            const apply = () => {
                drawer.classList.toggle('is-open', open);
                toggle.setAttribute('aria-expanded', String(open));
            };
            apply();
            toggle.addEventListener('click', () => {
                open = !open;
                apply();
                try { localStorage.setItem(DRAWER_KEY, open ? '1' : '0'); } catch (error) {}
            });

            const describe = () => {
                if (!summaryEl) return;
                const parts = [];
                const upsampling = document.getElementById('upsampling-select');
                if (upsampling && upsampling.value !== '0') parts.push(`升频 ${upsampling.selectedOptions[0]?.textContent || ''}`.trim());
                if (document.getElementById('wasapi-switch')?.checked) parts.push('独占');
                if (document.getElementById('eq-switch')?.checked) parts.push('均衡器');
                if (document.getElementById('ir-switch')?.checked) parts.push('脉冲响应');
                if (document.getElementById('loudness-switch')?.checked) parts.push('响度归一化');
                if (document.getElementById('saturation-switch')?.checked) parts.push('饱和');
                if (document.getElementById('crossfeed-switch')?.checked) parts.push('交叉馈送');
                summaryEl.textContent = parts.length ? parts.join(' · ') : '直通';
            };
            drawer.addEventListener('change', describe);
            // 设置从引擎读回后由 music.js 调一次，程序赋值不会触发 change。
            app.refreshAcousticSummary = describe;
            describe();
        }

        window.setupMusicClassicList?.(app);
        setupStageSkin();
    };

    // 舞台设置里选项不多的下拉框换成分段控件：一眼看到全部选项，点一下就切。
    // 原 <select> 保留并继续接收值和 change 事件，舞台代码不需要知道有这一层。
    const SEGMENT_MAX_OPTIONS = 4;
    const SEGMENT_MAX_CHARS = 18;
    const enhanceSelect = (select) => {
        if (select.dataset.segmented) return;
        const options = Array.from(select.options);
        const chars = options.reduce((sum, option) => sum + option.textContent.trim().length, 0);
        if (options.length < 2 || options.length > SEGMENT_MAX_OPTIONS || chars > SEGMENT_MAX_CHARS) return;
        select.dataset.segmented = '1';
        select.classList.add('music-skin-segmented-source');
        select.tabIndex = -1;
        const group = document.createElement('div');
        group.className = 'music-skin-segmented';
        group.setAttribute('role', 'group');
        const label = select.getAttribute('aria-label') || select.closest('label')?.querySelector('.music-stage-tuning-label')?.textContent;
        if (label) group.setAttribute('aria-label', label);
        const sync = () => {
            for (const button of group.children) button.setAttribute('aria-pressed', String(button.dataset.value === select.value));
        };
        for (const option of options) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.value = option.value;
            button.textContent = option.textContent.trim();
            button.disabled = option.disabled;
            button.addEventListener('click', (event) => {
                // 外层是 <label>，不拦住的话点击会转给下拉框本身。
                event.preventDefault();
                if (select.value === option.value) return;
                select.value = option.value;
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
                sync();
            });
            group.appendChild(button);
        }
        select.addEventListener('change', sync);
        select.after(group);
        sync();
    };

    const setupStageSkin = () => {
        const observers = [];
        // 设置各项所在的正文节点会被底栏整块搬进控制面板，所以盯的是这个节点本身，不是它原来的外壳。
        const settingsBody = document.querySelector('#music-stage-settings-card .music-stage-settings-body, .music-stage-settings-body');
        if (settingsBody) {
            const scan = () => settingsBody.querySelectorAll('select:not([data-segmented])').forEach(enhanceSelect);
            // 舞台切换模式时会重建「模式调制」里的控件，跟着重新替换；忽略纯文本节点变动（如拖滑块刷新数值）
            const settingsObs = new MutationObserver((records) => {
                for (let i = 0; i < records.length; i += 1) {
                    const added = records[i].addedNodes;
                    for (let j = 0; j < added.length; j += 1) {
                        if (added[j].nodeType === 1) { scan(); return; }
                    }
                }
            });
            settingsObs.observe(settingsBody, { childList: true, subtree: true });
            observers.push(settingsObs);
            scan();
        }

        // 舞台可以单独选深浅主题（stage-theme-light/dark 只挂在舞台根节点上）；
        // 同步一份到 body，舞台里的底栏和面板也能按舞台的深浅取色。
        const stage = document.getElementById('music-stage');
        if (stage) {
            const mirror = () => {
                document.body.classList.toggle('music-stage-light', stage.classList.contains('stage-theme-light'));
                document.body.classList.toggle('music-stage-dark', stage.classList.contains('stage-theme-dark'));
            };
            const stageObs = new MutationObserver(mirror);
            stageObs.observe(stage, { attributes: true, attributeFilter: ['class'] });
            observers.push(stageObs);
            mirror();
        }
        if (observers.length) {
            window.addEventListener('beforeunload', () => {
                for (const obs of observers) obs.disconnect();
                observers.length = 0;
            }, { once: true });
        }
    };
})();
