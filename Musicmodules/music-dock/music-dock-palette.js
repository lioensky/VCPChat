// Musicmodules/music-dock/music-dock-palette.js
// 命令面板（Ctrl+K / ⌘K，或快捷行最后那个按钮）：从底部胶囊的位置往上长出来，
// 一个输入框同时搜歌（当前队列优先，再到全部曲目）、歌单和常用操作，记住最近用过的十项。
// 结果分「歌曲 / 歌单 / 命令」三组。歌和歌单：回车播放，Shift+回车下一首播放，Ctrl+回车加入队列。
// 有档案目录的拼音索引（MusicArchiveIndex + pinyin-pro）就用它，能按拼音、首字母找；没有时退回简单匹配。
// 过滤写法：歌手:名字、专辑:名字、标题:名字（冒号中英文都行），或 --歌手 名字（也认 --artist / --album / --title 和 --a / --al / --t），
// 输入 -- 时列出可用的过滤。主界面和舞台里都能用。
(function (global) {
    'use strict';

    const RECENT_KEY = 'musicDockRecentCommands';
    const MAX_RECENT = 10;
    const MAX_SONGS = 60;
    const WS_SPLIT_RE = /\s+/;
    const COLON_RE = /^([^:：\s]+)[:：](.*)$/;
    const TRAIL_WS_RE = /\s$/;
    const VOL_CMD_RE = /^(?:音量|vol(?:ume)?|yinliang)\s*(\d{1,3})\s*%?$/i;
    const ASCII_WORD_RE = /^[a-z0-9]+$/;
    const BSLASH_RE = /\\/g;
    const END_FLAG_RE = /--\S*$/;
    const FILTERS = Object.freeze([
        { key: 'artist', flag: '歌手', aliases: ['artist', 'a'], hint: '只在歌手里找' },
        { key: 'album', flag: '专辑', aliases: ['album', 'al'], hint: '只在专辑里找' },
        { key: 'title', flag: '标题', aliases: ['title', 't'], hint: '只在歌名里找' }
    ]);
    const FLAG_LOOKUP = new Map();
    for (const f of FILTERS) {
        FLAG_LOOKUP.set(f.flag, f.key);
        for (const alias of f.aliases) FLAG_LOOKUP.set(alias, f.key);
    }

    const lower = (value) => String(value || '').toLowerCase();

    /* 把输入拆成自由文字和 --过滤。"夜 --歌手 远舟" → { text: '夜', artist: '远舟' }。 */
    const parseQuery = (raw) => {
        const out = { text: '', artist: '', album: '', title: '', pendingFlag: null };
        const tokens = String(raw || '').split(WS_SPLIT_RE).filter(Boolean);
        const free = [];
        let current = null;
        for (const token of tokens) {
            // 「歌手:周杰伦」「专辑：叶惠美」这种写法和 --歌手 一样（冒号后面可以空一格再写名字）
            const colon = COLON_RE.exec(token);
            const colonKey = colon && (FLAG_LOOKUP.get(colon[1]) || FLAG_LOOKUP.get(lower(colon[1])));
            if (colonKey) {
                if (colon[2]) { out[colonKey] = out[colonKey] ? `${out[colonKey]} ${colon[2]}` : colon[2]; current = colonKey; }
                else current = colonKey;
                continue;
            }
            if (token.startsWith('--')) {
                const name = token.slice(2);
                const key = FLAG_LOOKUP.get(name) || FLAG_LOOKUP.get(lower(name));
                if (key) { current = key; continue; }
                out.pendingFlag = name;
                current = null;
                continue;
            }
            if (current) out[current] = out[current] ? `${out[current]} ${token}` : token;
            else free.push(token);
        }
        out.text = free.join(' ');
        const last = tokens[tokens.length - 1] || '';
        if (TRAIL_WS_RE.test(raw || '') === false && last.startsWith('--') && !FLAG_LOOKUP.has(last.slice(2))) {
            out.pendingFlag = last.slice(2);
        }
        return out;
    };

    const hasSongFilter = (q) => Boolean(q.text || q.artist || q.album || q.title);

    const compileQuery = (q) => ({
        artist: q.artist ? lower(q.artist) : '',
        album: q.album ? lower(q.album) : '',
        title: q.title ? lower(q.title) : '',
        words: q.text ? lower(q.text).split(WS_SPLIT_RE).filter(Boolean) : []
    });

    /* 歌是否匹配：自由文字在标题/歌手/专辑里找，过滤只在对应字段里找；越靠前的命中分越高。 */
    const scoreTrackCompiled = (track, cq, stripExtension) => {
        if (!track) return -1;
        const title = lower(stripExtension ? stripExtension(track.title) : track.title);
        const artist = lower(track.artist);
        const album = lower(track.album);
        if (cq.artist && !artist.includes(cq.artist)) return -1;
        if (cq.album && !album.includes(cq.album)) return -1;
        if (cq.title && !title.includes(cq.title)) return -1;
        let score = 1;
        if (cq.words.length) {
            for (let i = 0; i < cq.words.length; i++) {
                const word = cq.words[i];
                if (title.startsWith(word)) score += 6;
                else if (title.includes(word)) score += 4;
                else if (artist.includes(word)) score += 2;
                else if (album.includes(word)) score += 1;
                else return -1;
            }
        }
        return score;
    };

    const scoreTrack = (track, q, stripExtension) => scoreTrackCompiled(track, compileQuery(q), stripExtension);

    const readRecent = () => {
        try {
            const value = JSON.parse(global.localStorage.getItem(RECENT_KEY) || '[]');
            return Array.isArray(value) ? value.filter((id) => typeof id === 'string').slice(0, MAX_RECENT) : [];
        } catch (error) { return []; }
    };
    const writeRecent = (list) => {
        try { global.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch (error) {}
    };

    function createMusicDockPalette(app, deps) {
        const { host, icon, escapeHtml, trackTitle, trackArtist, openPanel, openSheet, toggleStage, cycleMode, setVolume, readVolume, toggleMute, openHelp, closeOthers } = deps;

        const root = document.createElement('div');
        root.className = 'md-cmd';
        root.hidden = true;
        root.innerHTML = `
<div class="md-cmd-scrim" data-cmd="scrim"></div>
<div class="md-cmd-wrap">
  <section class="md-cmd-box" role="dialog" aria-modal="true" aria-label="搜索歌曲">
    <div class="md-cmd-body">
      <div class="md-cmd-hints" hidden></div>
      <div class="md-cmd-list" role="listbox" id="music-dock-cmd-list" aria-label="结果"></div>
      <div class="md-cmd-foot" hidden><span><kbd>↵</kbd> 播放</span><span><kbd>Shift</kbd><kbd>↵</kbd> 下一首播放</span><span><kbd>Ctrl</kbd><kbd>↵</kbd> 加入队列</span></div>
    </div>
    <div class="md-cmd-hd">
      <span class="md-cmd-ic">${icon('search', 18)}</span>
      <input class="md-cmd-in" type="text" spellcheck="false" autocomplete="off" placeholder="搜索歌曲、歌手、专辑"
        role="combobox" aria-expanded="true" aria-controls="music-dock-cmd-list" aria-autocomplete="list">
      <kbd class="md-cmd-kbd">Esc</kbd>
    </div>
  </section>
</div>`;
        host.appendChild(root);
        const input = root.querySelector('.md-cmd-in');
        const list = root.querySelector('.md-cmd-list');
        const hints = root.querySelector('.md-cmd-hints');
        const box = root.querySelector('.md-cmd-box');
        const foot = root.querySelector('.md-cmd-foot');

        const state = { open: false, items: [], active: 0, lastFocus: null, closeTimer: null, openRaf: 0, slideRaf: 0, capRect: null };

        // ───────── 命令表 ─────────
        const panelCmd = (tab, iconName, words) => ({
            id: `panel:${tab}`, group: '面板', icon: iconName, title: `打开面板 · ${tab}`, words, run: () => openPanel(tab)
        });
        const commands = () => {
            const playing = app.isPlaying === true;
            const inStage = app.isStageActive === true;
            const mode = app.playModes?.[app.currentPlayMode] || 'repeat';
            const light = document.body.classList.contains('light-theme');
            const v = readVolume();
            return [
                { id: 'toggle-play', group: '播放', icon: playing ? 'pause' : 'play', title: playing ? '暂停' : '播放', hint: 'Space', words: 'play pause 播放 暂停 bofang zanting', run: () => (playing ? app.pauseTrack?.() : app.playTrack?.()) },
                { id: 'next', group: '播放', icon: 'skip-forward', title: '下一首', words: 'next 下一首 xiayishou 切歌', run: () => app.nextTrack?.() },
                { id: 'prev', group: '播放', icon: 'skip-back', title: '上一首', words: 'prev previous 上一首 shangyishou', run: () => app.prevTrack?.() },
                { id: 'mode', group: '播放', icon: mode === 'repeat-one' ? 'repeat-1' : mode === 'shuffle' ? 'shuffle' : 'repeat', title: '切换循环方式', desc: `现在：${{ repeat: '列表循环', 'repeat-one': '单曲循环', shuffle: '随机播放' }[mode]}`, words: 'loop repeat shuffle 循环 单曲 随机 xunhuan', run: cycleMode },
                { id: 'shuffle', group: '播放', icon: 'shuffle', title: mode === 'shuffle' ? '关闭随机播放' : '随机播放', words: 'shuffle random 随机 suiji', run: () => app.setPlayMode?.(mode === 'shuffle' ? 'repeat' : 'shuffle') },
                { id: 'volume-up', group: '音量', icon: 'volume-2', title: '音量 +10%', desc: `现在 ${Math.round(v * 100)}%`, words: 'volume up louder 音量 大 yinliang', run: () => setVolume(readVolume() + 0.1), keepOpen: true },
                { id: 'volume-down', group: '音量', icon: 'volume-1', title: '音量 −10%', desc: `现在 ${Math.round(v * 100)}%`, words: 'volume down quieter 音量 小 yinliang', run: () => setVolume(readVolume() - 0.1), keepOpen: true },
                { id: 'mute', group: '音量', icon: v > 0.001 ? 'volume-x' : 'volume-2', title: v > 0.001 ? '静音' : '取消静音', words: 'mute 静音 jingyin', run: () => (toggleMute ? toggleMute() : setVolume(v > 0.001 ? 0 : 0.7)) },
                ...(app.startRadio && app.playlist?.[app.currentTrackIndex] ? [{ id: 'radio', group: '播放', icon: 'radio', title: '从当前这首开电台', desc: '接着放曲库里相似的歌', words: 'radio station 电台 相似 diantai', run: () => app.startRadio(app.currentTrackIndex) }] : []),
                ...(app.autoplay ? [{ id: 'autoplay', group: '播放', icon: 'infinity', title: app.autoplay.enabled ? '关闭自动续播' : '打开自动续播', desc: '一组放完接着放相似的歌', words: 'autoplay continue 续播 自动 xubo', run: () => { app.autoplay.enabled = !app.autoplay.enabled; } }] : []),
                ...(app.lyricsAi ? [{ id: 'lyrics-ai', group: '歌词', icon: 'languages', title: app.lyricsAi.enabled ? '关闭 AI 翻译外语歌词' : '打开 AI 翻译外语歌词', desc: '外语歌没有中文翻译时，用 VCP 的模型翻好', words: 'ai translate translation lyrics 翻译 歌词 fanyi', run: () => { app.lyricsAi.enabled = !app.lyricsAi.enabled; } },
                    ...(app.lyricsAi.needsTranslation() ? [{ id: 'lyrics-ai-now', group: '歌词', icon: 'languages', title: '用 AI 翻译这首的歌词', words: 'ai translate 翻译 这首 fanyi', run: () => app.lyricsAi.translateNow() }] : [])] : []),
                ...(typeof app.m3u?.commands === 'function' ? app.m3u.commands() : []),
                ...(app.channels?.supported ? [{ id: 'channels', group: '声音', icon: 'sliders-horizontal', title: '声道：左右平衡、互换、单声道', desc: `现在：${app.channels.describe()}`, words: 'channels balance swap mono stereo 声道 平衡 左右 互换 单声道 立体声 shengdao', run: () => app.channels.open() }] : []),
                ...(typeof app.eqUserPresets?.promptSave === 'function' ? [{ id: 'eq-save-preset', group: '声音', icon: 'sliders-horizontal', title: '把当前 EQ 存为预设', desc: '起个名字，以后在均衡器的预设里一点就回来', words: 'eq preset save equalizer 均衡 预设 保存 存 junheng yushe', run: () => app.eqUserPresets.promptSave() }] : []),
                ...(typeof app.openLibraryFolders === 'function' ? [{ id: 'library-folders', group: '曲库', icon: 'list-music', title: '曲库文件夹', desc: '曲库从哪些文件夹来：打开、整个移出、加新的、立即重扫', words: 'folders library folder sync rescan 曲库 文件夹 同步 扫描 移除 wenjianjia', run: () => app.openLibraryFolders() }] : []),
                ...(typeof app.openTrackInfo === 'function' && app.playlist?.[app.currentTrackIndex] ? [{ id: 'track-info', group: '播放', icon: 'file-text', title: '这首歌的信息', desc: '格式、采样率、码率、大小、听过几次、文件在哪', words: 'info properties details format bitrate 信息 属性 格式 码率 文件 xinxi shuxing', run: () => app.openTrackInfo(app.currentTrackIndex) }] : []),
                ...(global.MusicDupes ? [{ id: 'dupes', group: '曲库', icon: 'list-music', title: '整理重复的歌', desc: '同一首有好几个文件时只留最好的那份（不删磁盘文件）', words: 'duplicate dupes dedupe 重复 副本 整理 chongfu', run: () => global.MusicDupes.open(app) }] : []),
                ...(typeof app.dailyMix?.reshuffle === 'function' ? [{ id: 'daily-reshuffle', group: '播放', icon: 'shuffle', title: '每日推荐换一批', desc: '刚推过的几批往后放，换一批没那么熟的', words: 'daily mix reshuffle refresh 每日推荐 换一批 推荐 huanyipi tuijian', run: () => app.dailyMix.reshuffle() }] : []),
                ...(global.MusicSpectrum && app.api?.readMusicAudioFile && app.playlist?.[app.currentTrackIndex] ? [{ id: 'spectrum', group: '播放', icon: 'audio-lines', title: '看这首的频谱（真假无损）', desc: '画出整首的频谱，看高频是不是被切掉过', words: 'spectrum spectrogram lossless fake 频谱 真假无损 假无损 pinpu', run: () => global.MusicSpectrum.open(app) }] : []),
                ...(app.deviceSound ? [{ id: 'device-sound', group: '声音', icon: 'sliders-horizontal', title: app.deviceSound.enabled ? '不再按输出设备记住 EQ' : '按输出设备记住 EQ', desc: app.deviceSound.device ? `现在的输出：${app.deviceSound.device}` : '耳机和音箱各用各的 EQ，换设备时自动换回', words: 'device eq headphone speaker 设备 耳机 音箱 均衡 shebei', run: () => { app.deviceSound.enabled = !app.deviceSound.enabled; } }] : []),
                ...(global.MusicStatsView && app.musicStats?.summary ? [{ id: 'stats', group: '播放', icon: 'clock', title: '听歌统计', desc: '听了多久、几点听得最多、最常听的歌和歌手', words: 'stats statistics history 统计 听歌记录 时长 排行 tongji', run: () => global.MusicStatsView.open(app) }] : []),
                ...(app.desktopLyrics?.available ? [{ id: 'desktop-lyrics', group: '歌词', icon: 'picture-in-picture-2', title: app.desktopLyrics.on ? '关闭桌面歌词' : '打开桌面歌词', desc: '切到别的程序也能看到唱到哪一句', words: 'desktop lyrics floating 桌面歌词 悬浮 zhuomian geci', run: () => app.desktopLyrics.toggle() }] : []),
                { id: 'stage', group: '舞台', icon: 'sparkle', title: inStage ? '离开歌词舞台' : '进入歌词舞台', words: 'stage lyrics 舞台 歌词 wutai geci', run: toggleStage },
                panelCmd('封面', 'image', 'cover 封面 fengmian'),
                panelCmd('歌词', 'file-text', 'lyrics 歌词 geci'),
                panelCmd('控制', 'settings-2', 'controls 控制 kongzhi'),
                panelCmd('播放列表', 'list-music', 'queue playlist 播放列表 队列 bofangliebiao'),
                panelCmd('声音', 'audio-lines', 'sound quality eq effects dsp 声音 音质 音效 均衡 shengyin yinzhi yinxiao'),
                ...(typeof global.MusicIntro?.replay === 'function'
                    ? [{ id: 'intro', group: '外观', icon: 'clapperboard', title: '播放完整开场', words: 'intro opening replay 开场 过场 动画 kaichang', run: () => global.MusicIntro.replay() }]
                    : []),
                ...(openHelp ? [{ id: 'shortcuts', group: '帮助', icon: 'command', title: '快捷键', hint: '?', words: 'keys shortcuts help 快捷键 按键 帮助 kuaijiejian', run: () => openHelp() }] : []),
                { id: 'theme', group: '外观', icon: light ? 'moon' : 'sun', title: light ? '切到深色' : '切到浅色', words: 'theme dark light 深色 浅色 主题 zhuti', run: () => { app.applyTheme?.(light ? 'dark' : 'light'); app.stageHost?.updateTheme?.(); } }
            ];
        };

        let cachedCmdSig = '';
        let cachedCmdList = null;
        const getCommands = () => {
            const sig = `${app.isPlaying === true ? 1 : 0}|${app.isStageActive === true ? 1 : 0}|${app.currentPlayMode ?? ''}`
                + `|${document.body.classList.contains('light-theme') ? 1 : 0}|${Math.round(readVolume() * 100)}`
                + `|${app.currentTrackIndex ?? -1}|${app.autoplay?.enabled === true ? 1 : 0}`
                + `|${app.lyricsAi?.enabled === true ? 1 : 0}|${app.deviceSound?.enabled === true ? 1 : 0}`
                + `|${app.deviceSound?.device || ''}|${app.desktopLyrics?.on === true ? 1 : 0}`;
            if (cachedCmdList && cachedCmdSig === sig) return cachedCmdList;
            cachedCmdSig = sig;
            const list = commands();
            for (let i = 0; i < list.length; i += 1) {
                const c = list[i];
                c._tl = lower(c.title);
                c._hay = lower(`${c.title} ${c.words || ''} ${c.group}`);
            }
            cachedCmdList = list;
            return list;
        };

        // 「音量 40」「vol 40」这种直接给数字的。
        const volumeCommand = (text) => {
            const m = VOL_CMD_RE.exec(String(text || '').trim());
            if (!m) return null;
            const value = Math.min(100, Number(m[1]));
            return { id: 'volume-set', group: '音量', icon: 'volume-2', title: `把音量设为 ${value}%`, run: () => setVolume(value / 100), noRecent: true };
        };

        const matchCommand = (cmd, words) => {
            if (!words.length) return 0;
            const titleLower = cmd._tl !== undefined ? cmd._tl : lower(cmd.title);
            const hay = cmd._hay !== undefined ? cmd._hay : lower(`${cmd.title} ${cmd.words || ''} ${cmd.group}`);
            let score = 0;
            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                if (titleLower.startsWith(word)) score += 3;
                else if (hay.includes(word)) score += 1;
                else return 0;
            }
            return score;
        };

        const notify = (message) => { try { global.MusicToast?.show({ id: 'queue', kind: 'success', message }); } catch (error) {} };
        const queueTracks = (tracks, front, label) => {
            const list = tracks.filter(Boolean);
            if (!list.length || typeof app.queueAdd !== 'function') return;
            // 「下一首播放」一组歌：倒着插到最前，放出来还是原来的顺序；批量入队合并成一次通知避免 N 倍重绘。
            const run = () => {
                if (front) list.slice().reverse().forEach((t) => app.queuePlayNext?.(t));
                else list.forEach((t) => app.queueAdd(t));
            };
            if (list.length > 1 && typeof app.queueBatch === 'function') app.queueBatch(run); else run();
            notify(`${front ? '下一首播放' : '已加入队列'}：${label}`);
        };

        const iconCache = new Map();
        const iconTplCache = new Map();
        const iconHtml = (name, size) => {
            const k = `${name}:${size}`;
            let s = iconCache.get(k);
            if (s === undefined) { s = icon(name, size); iconCache.set(k, s); }
            return s;
        };
        const cloneIconInto = (target, name, size) => {
            const k = `${name}:${size}`;
            let tpl = iconTplCache.get(k);
            if (!tpl) {
                tpl = document.createElement('span');
                tpl.innerHTML = iconHtml(name, size);
                iconTplCache.set(k, tpl);
            }
            target.textContent = '';
            for (let n = tpl.firstChild; n; n = n.nextSibling) target.appendChild(n.cloneNode(true));
        };

        const songItem = (track, group, knownIndex) => {
            const index = Number.isInteger(knownIndex) ? knownIndex : app.playlist.indexOf(track);
            const isCurrent = index === app.currentTrackIndex;
            const artist = trackArtist(track);
            const album = track.album;
            return {
                id: `song:${track.path}`,
                section: '歌曲',
                group,
                icon: isCurrent && app.isPlaying ? 'audio-lines' : 'music',
                title: trackTitle(track),
                desc: artist && album ? `${artist} · ${album}` : (artist || album || ''),
                current: isCurrent,
                queueable: true,
                run: () => { if (index !== -1) app.loadTrack?.(index); },
                playNext: () => queueTracks([track], true, trackTitle(track)),
                addToQueue: () => queueTracks([track], false, trackTitle(track))
            };
        };

        // 曲目路径映射缓存：单表存 { track, index }，省去 5000+ 条 `song:` 前缀字符串与第二张 Map 的构造和 GC
        let cachedPathList = null;
        let cachedPathLen = -1;
        let cachedPathFirst = null;
        let cachedPathLast = null;
        let cachedByPath = null;
        const getTrackByPath = () => {
            const tracks = app.playlist || [];
            const len = tracks.length;
            const first = len ? tracks[0] : null;
            const last = len ? tracks[len - 1] : null;
            if (cachedByPath && cachedPathList === app.playlist && cachedPathLen === len
                && cachedPathFirst === first && cachedPathLast === last) {
                return cachedByPath;
            }
            const byPath = new Map();
            for (let i = 0; i < len; i++) {
                const t = tracks[i];
                if (!t) continue;
                byPath.set(t.path, { track: t, index: i });
            }
            cachedPathList = app.playlist;
            cachedPathLen = len;
            cachedPathFirst = first;
            cachedPathLast = last;
            cachedByPath = byPath;
            return byPath;
        };

        const normPath = (p) => String(p ?? '').replace(BSLASH_RE, '/').toLowerCase();
        const lookupTrack = (byPath, rawPath) => {
            if (!rawPath) return null;
            const exact = byPath.get(rawPath);
            if (exact) return exact;
            let byNorm = byPath._norm;
            if (!byNorm) {
                byNorm = new Map();
                for (const [k, v] of byPath) {
                    const nk = normPath(k);
                    if (nk && !byNorm.has(nk)) byNorm.set(nk, v);
                }
                byPath._norm = byNorm;
            }
            return byNorm.get(normPath(rawPath)) || null;
        };

        const playlistTracks = (pl, byPath) => {
            const map = byPath || getTrackByPath();
            const raw = pl.tracks || [];
            const out = [];
            for (let i = 0; i < raw.length; i += 1) {
                const hit = lookupTrack(map, raw[i]);
                if (hit) out.push(hit.track);
            }
            return out;
        };
        const playlistItem = (pl, group = '歌单', byPath) => {
            const tracks = playlistTracks(pl, byPath);
            return {
                id: `playlist:${pl.id}`,
                section: '歌单',
                group,
                icon: 'list-music',
                title: pl.name || '未命名歌单',
                desc: `${tracks.length} 首`,
                queueable: tracks.length > 0,
                run: () => {
                    // 和经典侧栏点歌单一样：把这个歌单设成当前列表，从第一首放起。
                    if (!tracks.length) return;
                    app.filteredPlaylistSource = { type: 'playlist', name: pl.name, id: pl.id };
                    app.currentFilteredTracks = tracks;
                    try { app.renderPlaylist?.(tracks); } catch (error) { /* 旧列表只是同步显示 */ }
                    const index = app.playlist.indexOf(tracks[0]);
                    if (index !== -1) app.loadTrack?.(index);
                },
                playNext: () => queueTracks(tracks, true, `歌单「${pl.name}」`),
                addToQueue: () => queueTracks(tracks, false, `歌单「${pl.name}」`)
            };
        };

        // 拼音索引：跟曲库同一份，曲库换了（数组或长度变了）才重建。
        // 稳定包装函数引用（按 global.pinyinPro 复用），让 archive-index 的 WeakMap 缓存能够持续命中。
        let searchIndex = null;
        let indexedList = null;
        let indexedLength = -1;
        let indexedPinyin = false;
        const pinyinCache = new Map();
        let cachedPinyinLib = null;
        let cachedPinyinFn = null;
        const pinyinFn = () => {
            const lib = global.pinyinPro;
            if (!lib || typeof lib.pinyin !== 'function') return null;
            if (cachedPinyinLib === lib && cachedPinyinFn) return cachedPinyinFn;
            pinyinCache.clear();
            cachedPinyinLib = lib;
            cachedPinyinFn = (c) => {
                let p = pinyinCache.get(c);
                if (p === undefined) {
                    try { p = lib.pinyin(c, { toneType: 'none' }); } catch (error) { p = ''; }
                    pinyinCache.set(c, p);
                }
                return p;
            };
            return cachedPinyinFn;
        };
        const getIndex = () => {
            const tracks = app.playlist || [];
            // 优先复用首页已经预热好的拼音检索索引，避免首次按 Ctrl+K 同步重建整份曲库索引卡顿且占双倍内存
            const shared = app.archiveView?.getSearchIndex?.();
            if (shared && shared.size === tracks.length) return shared;
            const Lib = global.MusicArchiveIndex;
            if (!Lib || typeof Lib.createIndex !== 'function') return null;
            const pinyin = pinyinFn();
            if (searchIndex && indexedList === app.playlist && indexedLength === tracks.length && indexedPinyin === Boolean(pinyin)) return searchIndex;
            try { searchIndex = Lib.createIndex(tracks, { pinyin }); } catch (error) { searchIndex = null; }
            indexedList = app.playlist;
            indexedLength = tracks.length;
            indexedPinyin = Boolean(pinyin);
            return searchIndex;
        };
        const playlistRomanCache = new Map();
        let playlistRomanFn = null;
        const getPlaylistRoman = (name, Lib) => {
            const fn = pinyinFn();
            if (fn !== playlistRomanFn) {
                playlistRomanFn = fn;
                playlistRomanCache.clear();
            }
            let r = playlistRomanCache.get(name);
            if (r === undefined) {
                r = Lib.romanize(name, fn);
                if (playlistRomanCache.size > 512) playlistRomanCache.clear();
                playlistRomanCache.set(name, r);
            }
            return r;
        };
        const nameMatches = (name, words) => {
            if (!words.length) return 0;
            const plain = lower(name);
            let romanized = null;
            const Lib = global.MusicArchiveIndex;
            let score = 0;
            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                if (plain.startsWith(word)) { score += 3; continue; }
                if (plain.includes(word)) { score += 2; continue; }
                if (ASCII_WORD_RE.test(word) && Lib?.romanize) {
                    romanized = romanized || getPlaylistRoman(name, Lib);
                    if (romanized.py.includes(word) || romanized.ini.includes(word)) { score += 1; continue; }
                }
                return 0;
            }
            return score;
        };

        /* 按检索词找歌，返回 { track, index }（按得分排好），避免后续 60 次 O(N) indexOf。 */
        const findSongs = (q, limit) => {
            const tracks = app.playlist || [];
            const index = getIndex();
            if (!index) {
                const strip = app.stripAudioExtension;
                const cq = compileQuery(q);
                const scored = [];
                for (let idx = 0; idx < tracks.length; idx++) {
                    const track = tracks[idx];
                    const s = scoreTrackCompiled(track, cq, strip);
                    if (s > 0) scored.push({ track, index: idx, s });
                }
                scored.sort((a, b) => b.s - a.s);
                return scored.slice(0, limit);
            }
            let order;
            let skipArtist = false;
            let skipAlbum = false;
            if (q.text) {
                order = index.query(q.text, { limit: Math.max(limit * 4, 400) });
            } else if (q.artist) {
                const singleFilter = !q.album && !q.title;
                order = index.query(q.artist, singleFilter ? { kind: 'artist', limit: Math.max(limit * 4, 400) } : { kind: 'artist' });
                skipArtist = true;
            } else if (q.album) {
                const singleFilter = !q.artist && !q.title;
                order = index.query(q.album, singleFilter ? { kind: 'album', limit: Math.max(limit * 4, 400) } : { kind: 'album' });
                skipAlbum = true;
            } else {
                order = tracks.map((_, i) => i);
            }
            const keep = (kind, value) => {
                if (!value) return;
                const hits = new Set(index.query(value, { kind }));
                order = order.filter((i) => hits.has(i));
            };
            if (!skipArtist) keep('artist', q.artist);
            if (!skipAlbum) keep('album', q.album);
            if (q.title) {
                const want = lower(q.title);
                const strip = app.stripAudioExtension;
                order = order.filter((i) => lower(strip ? strip(tracks[i]?.title) : tracks[i]?.title).includes(want));
            }
            const out = [];
            const take = Math.min(limit, order.length);
            for (let k = 0; k < take; k += 1) {
                const idx = order[k];
                const track = tracks[idx];
                if (track) out.push({ track, index: idx });
            }
            return out;
        };

        let cachedQueueList = null;
        let cachedQueueLen = -1;
        let cachedQueueFirst = null;
        let cachedQueueLast = null;
        let cachedQueueSet = null;
        const getFilteredQueueSet = () => {
            const list = app.currentFilteredTracks;
            if (!list || list === app.playlist) return null;
            const len = list.length;
            const first = len ? list[0] : null;
            const last = len ? list[len - 1] : null;
            if (cachedQueueSet && cachedQueueList === list && cachedQueueLen === len
                && cachedQueueFirst === first && cachedQueueLast === last) {
                return cachedQueueSet;
            }
            cachedQueueList = list;
            cachedQueueLen = len;
            cachedQueueFirst = first;
            cachedQueueLast = last;
            cachedQueueSet = new Set(list);
            return cachedQueueSet;
        };

        const recentItems = ({ songsAndPlaylistsOnly = false } = {}) => {
            const recent = readRecent();
            if (!recent.length) return [];
            let all = null;
            let byPath = null;
            const out = [];
            for (let i = 0; i < recent.length; i += 1) {
                const id = recent[i];
                if (id.startsWith('song:')) {
                    if (!byPath) byPath = getTrackByPath();
                    const hit = lookupTrack(byPath, id.slice(5));
                    if (hit) out.push({ ...songItem(hit.track, '最近', hit.index), section: '最近' });
                    continue;
                }
                if (id.startsWith('playlist:')) {
                    const pl = (app.customPlaylists || []).find((p) => `playlist:${p.id}` === id);
                    if (pl) {
                        if (!byPath) byPath = getTrackByPath();
                        out.push({ ...playlistItem(pl, '最近', byPath), section: '最近' });
                    }
                    continue;
                }
                if (songsAndPlaylistsOnly) continue;
                if (!all) all = getCommands();
                const cmd = all.find((c) => c.id === id);
                if (cmd) out.push({ ...cmd, group: '最近', section: '最近' });
            }
            return out;
        };

        const build = () => {
            const raw = input.value;
            const q = parseQuery(raw);
            let items = [];
            if (!raw.trim()) {
                // 没输入时只放最近找过的歌和歌单；播放、切歌这些底栏上都有，不在这里列一排。
                items.push(...recentItems({ songsAndPlaylistsOnly: true }).filter((it) => !String(it.id).startsWith('cmd') && (it.queueable || String(it.id).startsWith('playlist:'))).slice(0, 8));
            } else {
                const songs = [];
                const playlists = [];
                const cmds = [];
                const vol = volumeCommand(raw);
                if (vol) cmds.push({ ...vol, section: '命令' });
                const onlyText = q.text && !q.artist && !q.album && !q.title;
                const qTextLower = q.text ? lower(q.text) : '';
                let commandPrefix = false;
                if (onlyText) {
                    const textWords = qTextLower.split(WS_SPLIT_RE).filter(Boolean);
                    getCommands()
                        .map((c) => ({ c, s: matchCommand(c, textWords) }))
                        .filter((x) => x.s > 0)
                        .sort((a, b) => b.s - a.s)
                        .slice(0, 6)
                        .forEach((x) => { if (x.s >= 3) commandPrefix = true; cmds.push({ ...x.c, section: '命令' }); });
                    const matchedPlaylists = (app.customPlaylists || [])
                        .map((pl) => ({ pl, s: nameMatches(pl.name || '', textWords) }))
                        .filter((x) => x.s > 0)
                        .sort((a, b) => b.s - a.s)
                        .slice(0, 6);
                    if (matchedPlaylists.length) {
                        const byPath = getTrackByPath();
                        matchedPlaylists.forEach((x) => playlists.push(playlistItem(x.pl, '歌单', byPath)));
                    }
                }
                if (hasSongFilter(q)) {
                    const found = findSongs(q, MAX_SONGS);
                    const queue = getFilteredQueueSet();
                    // 当前列表里的排前面，其余按得分。
                    const inQueue = queue ? found.filter((hit) => queue.has(hit.track)).slice(0, 20) : [];
                    const picked = inQueue.length ? new Set(inQueue.map((hit) => hit.track)) : null;
                    for (let i = 0; i < inQueue.length; i += 1) songs.push(songItem(inQueue[i].track, '队列', inQueue[i].index));
                    for (let i = 0; i < found.length; i += 1) {
                        const hit = found[i];
                        if (!picked || !picked.has(hit.track)) songs.push(songItem(hit.track, '曲库', hit.index));
                    }
                }
                // 默认歌曲贴着输入框；输入像是在找操作（命令名开头命中、又没有歌名开头命中）时命令排前。
                const songPrefix = Boolean(qTextLower) && songs.some((it) => lower(it.title).startsWith(qTextLower));
                const groups = commandPrefix && !songPrefix ? [cmds, songs, playlists] : [songs, playlists, cmds];
                items = groups.flat();
            }
            state.items = items;
            state.active = 0;
            renderHints(raw, q);
            render();
        };

        let lastHintsKey = '';
        const renderHints = (raw, q) => {
            const last = String(raw || '').split(WS_SPLIT_RE).pop() || '';
            const show = last.startsWith('--') && !FLAG_LOOKUP.has(last.slice(2));
            if (!show) {
                if (lastHintsKey !== '') {
                    lastHintsKey = '';
                    hints.hidden = true;
                    hints.innerHTML = '';
                } else if (!hints.hidden) {
                    hints.hidden = true;
                }
                return;
            }
            const typed = lower(last.slice(2));
            const key = `1:${typed}`;
            if (key === lastHintsKey && !hints.hidden) return;
            lastHintsKey = key;
            hints.hidden = false;
            const options = FILTERS.filter((f) => !typed || f.flag.startsWith(typed) || f.aliases.some((a) => a.startsWith(typed)));
            hints.innerHTML = '<div class="md-cmd-hints-k">过滤</div>' + (options.length ? options : FILTERS).map((f) => (
                `<button type="button" class="md-cmd-hint" data-flag="${f.flag}"><b>--${f.flag}</b><span>${f.hint}</span><i>${f.aliases.map((a) => `--${a}`).join(' ')}</i></button>`
            )).join('');
            void q;
        };

        // 复用结果行与分组标题 DOM 节点，并按整行原型单次 cloneNode 建槽（预置默认音符与回车图标），避免首次搜索建 60 行时反复 createElement 与双倍 SVG 克隆
        const rowPool = [];
        const secPool = [];
        let rowProto = null;
        const getRowProto = () => {
            if (rowProto) return rowProto;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('role', 'option');
            const ri = document.createElement('span');
            ri.className = 'md-cmd-ri';
            cloneIconInto(ri, 'music', 16);
            const rt = document.createElement('span');
            rt.className = 'md-cmd-rt';
            const l1 = document.createElement('span');
            l1.className = 'md-cmd-l1';
            const titleEl = document.createElement('span');
            titleEl.className = 'md-cmd-title';
            const grpEl = document.createElement('span');
            grpEl.className = 'md-cmd-grp';
            const runEl = document.createElement('span');
            runEl.className = 'md-cmd-run';
            cloneIconInto(runEl, 'corner-down-left', 13);
            runEl.appendChild(document.createTextNode(''));
            l1.append(titleEl, grpEl);
            rt.appendChild(l1);
            btn.append(ri, rt, runEl);
            rowProto = btn;
            return rowProto;
        };
        const createRowSlot = () => {
            const btn = getRowProto().cloneNode(true);
            const ri = btn.firstChild;
            const rt = ri.nextSibling;
            const runEl = rt.nextSibling;
            const l1 = rt.firstChild;
            const titleEl = l1.firstChild;
            const grpEl = titleEl.nextSibling;
            const runText = runEl.lastChild;
            return {
                btn, ri, rt, l1, titleEl, chipEl: null, grpEl, descEl: null, runText,
                iconName: 'music', hasChip: false, hasDesc: false,
                lastCls: '', lastId: '', lastSel: '', lastIdx: '', lastDist: '',
                lastTitle: null, lastHint: null, lastGrp: null, lastDesc: null, lastRun: null
            };
        };
        const hydrateRowSlot = (slot, item, i) => {
            const active = i === state.active;
            const cls = `md-cmd-row${active ? ' md-act' : ''}${item.current ? ' md-cur' : ''}`;
            if (slot.lastCls !== cls) { slot.lastCls = cls; slot.btn.className = cls; }
            const id = `md-cmd-opt-${i}`;
            if (slot.lastId !== id) { slot.lastId = id; slot.btn.id = id; }
            const selStr = active ? 'true' : 'false';
            if (slot.lastSel !== selStr) { slot.lastSel = selStr; slot.btn.setAttribute('aria-selected', selStr); }
            const idxStr = String(i);
            if (slot.lastIdx !== idxStr) { slot.lastIdx = idxStr; slot.btn.dataset.i = idxStr; }
            const distStr = String(Math.min(4, i));
            if (slot.lastDist !== distStr) { slot.lastDist = distStr; slot.btn.dataset.mdDist = distStr; }
            const iconName = item.icon || 'command';
            if (slot.iconName !== iconName) {
                slot.iconName = iconName;
                cloneIconInto(slot.ri, iconName, 16);
            }
            const nextTitle = String(item.title ?? '');
            if (slot.lastTitle !== nextTitle) { slot.lastTitle = nextTitle; slot.titleEl.textContent = nextTitle; }
            if (item.hint) {
                if (!slot.chipEl) {
                    slot.chipEl = document.createElement('kbd');
                    slot.chipEl.className = 'md-cmd-chip';
                }
                const nextHint = String(item.hint);
                if (slot.lastHint !== nextHint) { slot.lastHint = nextHint; slot.chipEl.textContent = nextHint; }
                if (!slot.hasChip) { slot.l1.insertBefore(slot.chipEl, slot.grpEl); slot.hasChip = true; }
            } else if (slot.hasChip) {
                slot.chipEl.remove();
                slot.hasChip = false;
            }
            const nextGrp = String(item.group ?? '');
            if (slot.lastGrp !== nextGrp) { slot.lastGrp = nextGrp; slot.grpEl.textContent = nextGrp; }
            if (item.desc) {
                if (!slot.descEl) {
                    slot.descEl = document.createElement('span');
                    slot.descEl.className = 'md-cmd-desc';
                }
                const nextDesc = String(item.desc);
                if (slot.lastDesc !== nextDesc) { slot.lastDesc = nextDesc; slot.descEl.textContent = nextDesc; }
                if (!slot.hasDesc) { slot.rt.appendChild(slot.descEl); slot.hasDesc = true; }
            } else if (slot.hasDesc) {
                slot.descEl.remove();
                slot.hasDesc = false;
            }
            const nextRun = item.queueable ? '播放' : '运行';
            if (slot.lastRun !== nextRun) { slot.lastRun = nextRun; slot.runText.nodeValue = nextRun; }
            return slot.btn;
        };
        let emptyEl = null;
        let lastEmptyMode = '';
        let activeRowEl = null;
        let dropEl = null;
        const ensureDrop = () => {
            if (dropEl) return dropEl;
            const existing = list.querySelector(':scope > .md-cmd-drop');
            if (existing) { dropEl = existing; return dropEl; }
            if (!global.MusicFluid?.slide) return null;
            dropEl = document.createElement('i');
            dropEl.className = 'md-cmd-drop';
            dropEl.setAttribute('aria-hidden', 'true');
            return dropEl;
        };
        let lastActiveId = '';
        let lastFootHidden = null;
        const setActiveMeta = (id, hideFoot) => {
            if (id !== lastActiveId) {
                lastActiveId = id;
                if (id) input.setAttribute('aria-activedescendant', id);
                else input.removeAttribute('aria-activedescendant');
            }
            if (hideFoot !== lastFootHidden) {
                lastFootHidden = hideFoot;
                foot.hidden = hideFoot;
            }
        };
        const render = () => {
            activeRowEl = null;
            if (!state.items.length) {
                const mode = input.value.trim() ? 'nomatch' : 'idle';
                if (!emptyEl) {
                    emptyEl = document.createElement('div');
                    emptyEl.className = 'md-cmd-empty';
                }
                if (lastEmptyMode !== mode) {
                    lastEmptyMode = mode;
                    emptyEl.innerHTML = mode === 'nomatch'
                        ? '<span>没有找到匹配的歌、歌单或操作</span>'
                        : '<span>输入歌名、歌手或专辑</span><span class="md-cmd-tip">只找某个歌手或专辑：写「歌手:周杰伦」「专辑:叶惠美」</span><span class="md-cmd-tip">也可以直接输入「暂停」「音量 50」这样的指令</span>';
                }
                if (list.childNodes.length !== 1 || list.firstChild !== emptyEl) list.replaceChildren(emptyEl);
                setActiveMeta('', true);
                return;
            }
            const drop = ensureDrop();
            // 列表是倒着排的（column-reverse），所以每组的标题写在这组最后一项后面，显示出来就在上方。
            // 就地对齐列表子节点，保留已在 DOM 中的行按钮避免每次按键全量拆装触发 800+ 节点样式重算。
            const desired = [];
            let secUsed = 0;
            for (let i = 0; i < state.items.length; i += 1) {
                const item = state.items[i];
                let slot = rowPool[i];
                if (!slot) { slot = createRowSlot(); rowPool[i] = slot; }
                desired.push(hydrateRowSlot(slot, item, i));
                const next = state.items[i + 1];
                if (item.section && (!next || next.section !== item.section)) {
                    let sec = secPool[secUsed];
                    if (!sec) {
                        sec = document.createElement('div');
                        sec.className = 'md-cmd-sec';
                        sec.setAttribute('role', 'presentation');
                        secPool[secUsed] = sec;
                    }
                    secUsed += 1;
                    const secText = String(item.section);
                    if (sec.textContent !== secText) sec.textContent = secText;
                    desired.push(sec);
                }
            }
            if (drop) desired.push(drop);
            let cursor = list.firstChild;
            for (let i = 0; i < desired.length; i += 1) {
                const node = desired[i];
                if (cursor === node) {
                    cursor = cursor.nextSibling;
                } else {
                    list.insertBefore(node, cursor);
                }
            }
            while (cursor) {
                const next = cursor.nextSibling;
                cursor.remove();
                cursor = next;
            }
            syncActive(false, true);
        };

        const flushSlide = (scroll, pre = null) => {
            if (!state.open) return;
            const row = pre?.row || (activeRowEl && activeRowEl.isConnected ? activeRowEl : list.querySelector(`[data-i="${state.active}"]`));
            if (!row) return;
            // 选中的那一行背后是一滴玻璃，上下键换行时流过去（drop 已在 render 阶段挂好，避免在读 offsetTop 前写入 DOM 触发同步回流）
            if (global.MusicFluid?.slide) {
                const top = pre ? pre.top : row.offsetTop;
                const height = pre ? pre.height : row.offsetHeight;
                const drop = ensureDrop();
                if (drop && !drop.isConnected) list.appendChild(drop);
                if (drop) global.MusicFluid.slide(drop, { top, height }, { key: 'md-cmd', axis: 'y', lead: 140, trail: 300 });
            }
            if (scroll) row.scrollIntoView?.({ block: 'nearest' });
        };

        const syncActive = (scroll = true, fromRender = false) => {
            if (fromRender) {
                const row = list.firstElementChild?.dataset?.i === String(state.active)
                    ? list.firstElementChild
                    : list.querySelector(`[data-i="${state.active}"]`);
                if (!row) return;
                activeRowEl = row;
                setActiveMeta(row.id, !state.items[state.active]?.queueable);
            } else {
                const prev = activeRowEl && activeRowEl.isConnected ? activeRowEl : list.querySelector('.md-cmd-row.md-act');
                if (prev) { prev.classList.remove('md-act'); prev.setAttribute('aria-selected', 'false'); }
                const row = list.querySelector(`[data-i="${state.active}"]`);
                if (!row) { activeRowEl = null; return; }
                activeRowEl = row;
                row.classList.add('md-act');
                row.setAttribute('aria-selected', 'true');
                setActiveMeta(row.id, !state.items[state.active]?.queueable);
            }
            if (state.slideRaf) { cancelAnimationFrame(state.slideRaf); state.slideRaf = 0; }
            if (global.MusicFluid?.slide || scroll) {
                state.slideRaf = requestAnimationFrame(() => {
                    state.slideRaf = 0;
                    flushSlide(scroll);
                });
            }
        };

        const remember = (item) => {
            if (item.noRecent) return;
            writeRecent([item.id, ...readRecent().filter((id) => id !== item.id)]);
        };

        const execute = (index, how = 'run') => {
            const item = state.items[index];
            if (!item) return;
            if (how !== 'run' && item.queueable) {
                // 入队后面板留着，方便接着挑下一首。
                if (how === 'next') item.playNext(); else item.addToQueue();
                input.focus();
                return;
            }
            remember(item);
            if (item.keepOpen) {
                item.run();
                cachedCmdList = null;
                cachedCmdSig = '';
                const keep = state.active;
                build();
                state.active = Math.min(keep, state.items.length - 1);
                syncActive(false);
                input.focus();
                return;
            }
            close(false);
            item.run();
        };

        // ───────── 打开 / 关闭 ─────────
        const readCapRect = () => {
            const cap = host.querySelector('.md-cap');
            const rect = cap?.getBoundingClientRect();
            state.capRect = rect && rect.width ? rect : null;
            return rect;
        };
        const applyPlace = (rect) => {
            // 搜索框从播放条上方鼓出来：底边贴着播放条上沿再留 14px，播放条本身留在原处、不被遮。
            const gap = rect && rect.height ? Math.max(12, global.innerHeight - rect.top + 14) : 110;
            root.style.setProperty('--md-cmd-bottom', `${Math.round(gap)}px`);
            if (rect && rect.width) root.style.setProperty('--md-cmd-origin-x', `${Math.round(rect.left + rect.width / 2)}px`);
        };
        const place = () => applyPlace(readCapRect());
        function open(initial = '') {
            cachedCmdList = null;
            cachedCmdSig = '';
            if (state.open) { input.focus({ preventScroll: true }); input.select(); return; }
            closeOthers?.();
            state.open = true;
            state.lastFocus = document.activeElement;
            if (state.closeTimer) { clearTimeout(state.closeTimer); state.closeTimer = null; }
            const capRect = readCapRect();
            root.hidden = false;
            input.value = initial;
            // 先在仅解隐 .md-cmd（contain: layout style）且未改动 #music-dock-root / body 类名时聚焦，
            // 避免 focus() 触发整个底栏与抽屉子树的同步样式重算。
            input.focus({ preventScroll: true });
            applyPlace(capRect);
            host.classList.add('md-cmd-open');
            document.body.classList.add('music-dock-cmd-open');
            build();
            if (state.slideRaf) { cancelAnimationFrame(state.slideRaf); state.slideRaf = 0; }
            if (state.openRaf) { cancelAnimationFrame(state.openRaf); state.openRaf = 0; }
            state.openRaf = requestAnimationFrame(() => {
                state.openRaf = 0;
                if (!state.open) return;
                // 合并首帧的 slide 读取与 bud 几何读取，再统一写入 md-open / bud / slide，避免同帧二次回流
                const row = activeRowEl && activeRowEl.isConnected ? activeRowEl : list.querySelector(`[data-i="${state.active}"]`);
                const pre = row && global.MusicFluid?.slide ? { row, top: row.offsetTop, height: row.offsetHeight } : null;
                // 搜索面板从播放条顶边长出来；复用 place() 已量好的播放条位置，避免写完 md-open 立刻重排
                const cap = state.capRect || host.querySelector('.md-cap')?.getBoundingClientRect();
                if (cap && cap.width) global.MusicFluid?.bud(box, { x: cap.left + cap.width / 2, y: cap.top + 6 });
                root.classList.add('md-open');
                if (pre) flushSlide(false, pre);
            });
        }
        function close(restoreFocus = true) {
            cachedCmdList = null;
            cachedCmdSig = '';
            if (!state.open) return;
            state.open = false;
            if (state.openRaf) { cancelAnimationFrame(state.openRaf); state.openRaf = 0; }
            if (state.slideRaf) { cancelAnimationFrame(state.slideRaf); state.slideRaf = 0; }
            state.capRect = null;
            const back = restoreFocus && state.lastFocus?.isConnected ? state.lastFocus : null;
            state.lastFocus = null;
            // 在切换 body 类之前还回焦点，避免写完 music-dock-cmd-open 立刻 focus() 触发整页强制重排
            if (back) back.focus?.({ preventScroll: true });
            else if (root.contains(document.activeElement)) document.activeElement.blur();
            root.classList.remove('md-open');
            host.classList.remove('md-cmd-open');
            document.body.classList.remove('music-dock-cmd-open');
            state.closeTimer = setTimeout(() => { state.closeTimer = null; if (!state.open) root.hidden = true; }, 200);
            if (back && document.activeElement !== back) back.focus?.({ preventScroll: true });
            // 关掉后输入框不能还占着焦点，否则下一次 Ctrl+K 会落进已关闭的面板里。
            if (root.contains(document.activeElement)) document.activeElement.blur();
        }
        const toggle = () => (state.open ? close() : open());

        // ───────── 事件 ─────────
        input.addEventListener('input', build);
        input.addEventListener('keydown', (event) => {
            event.stopPropagation(); // 别让档案页、舞台的快捷键收到输入框里的按键
            const n = state.items.length;
            // 列表倒着排（最好的结果贴着输入框），所以 ↑ 是往后、↓ 是往前。
            if (event.key === 'ArrowUp') { event.preventDefault(); if (n) { state.active = (state.active + 1) % n; syncActive(); } }
            else if (event.key === 'ArrowDown') { event.preventDefault(); if (n) { state.active = (state.active - 1 + n) % n; syncActive(); } }
            else if (event.key === 'Enter') {
                event.preventDefault();
                if (!event.isComposing) execute(state.active, event.shiftKey ? 'next' : (event.ctrlKey || event.metaKey) ? 'queue' : 'run');
            }
            else if (event.key === 'Escape') {
                if (event.isComposing) return;
                event.preventDefault();
                if (input.value) { input.value = ''; build(); } else close();
            }
            else if (event.key === 'Tab') {
                event.preventDefault();
                const hint = hints.hidden ? null : hints.querySelector('.md-cmd-hint');
                if (hint) acceptFlag(hint.dataset.flag);
            } else if ((event.ctrlKey || event.metaKey) && lower(event.key) === 'k') { event.preventDefault(); toggle(); }
        });
        const acceptFlag = (flag) => {
            input.value = input.value.replace(END_FLAG_RE, `--${flag} `);
            input.focus();
            build();
        };
        hints.addEventListener('mousedown', (event) => event.preventDefault());
        hints.addEventListener('click', (event) => {
            const button = event.target.closest('[data-flag]');
            if (button) acceptFlag(button.dataset.flag);
        });
        list.addEventListener('mousedown', (event) => event.preventDefault());
        list.addEventListener('pointermove', (event) => {
            const row = event.target.closest('.md-cmd-row');
            if (!row) return;
            const i = Number(row.dataset.i);
            if (i !== state.active) { state.active = i; syncActive(false); }
        });
        list.addEventListener('click', (event) => {
            const row = event.target.closest('.md-cmd-row');
            if (row) execute(Number(row.dataset.i), event.shiftKey ? 'next' : (event.ctrlKey || event.metaKey) ? 'queue' : 'run');
        });
        root.querySelector('[data-cmd="scrim"]').addEventListener('pointerdown', () => close());
        box.addEventListener('keydown', (event) => event.stopPropagation());

        const onGlobalKey = (event) => {
            if (!((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && lower(event.key) === 'k')) return;
            if (state.open && event.target?.closest?.('.md-cmd')) return;
            event.preventDefault();
            event.stopPropagation();
            toggle();
        };
        let resizeRaf = 0;
        const onResize = () => {
            if (!state.open || resizeRaf) return;
            resizeRaf = global.requestAnimationFrame(() => { resizeRaf = 0; if (state.open) place(); });
        };
        document.addEventListener('keydown', onGlobalKey, true);
        global.addEventListener('resize', onResize);

        return {
            open,
            close,
            toggle,
            get isOpen() { return state.open; },
            destroy() {
                close(false);
                if (state.openRaf) { cancelAnimationFrame(state.openRaf); state.openRaf = 0; }
                if (state.slideRaf) { cancelAnimationFrame(state.slideRaf); state.slideRaf = 0; }
                if (state.closeTimer) { clearTimeout(state.closeTimer); state.closeTimer = null; }
                if (resizeRaf) { global.cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
                document.removeEventListener('keydown', onGlobalKey, true);
                global.removeEventListener('resize', onResize);
                cachedPathList = cachedPathFirst = cachedPathLast = cachedByPath = null;
                cachedQueueList = cachedQueueFirst = cachedQueueLast = cachedQueueSet = null;
                activeRowEl = null;
                dropEl = null;
                rowPool.length = 0;
                secPool.length = 0;
                rowProto = null;
                emptyEl = null;
                iconCache.clear();
                iconTplCache.clear();
                searchIndex = indexedList = null;
                cachedPinyinLib = cachedPinyinFn = null;
                pinyinCache.clear();
                playlistRomanFn = null;
                playlistRomanCache.clear();
                root.remove();
            }
        };
    }

    global.createMusicDockPalette = createMusicDockPalette;
    global.MusicDockPaletteQuery = Object.freeze({ parseQuery, scoreTrack });
})(window);
