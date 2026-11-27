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
        const tokens = String(raw || '').split(/\s+/).filter(Boolean);
        const free = [];
        let current = null;
        for (const token of tokens) {
            // 「歌手:周杰伦」「专辑：叶惠美」这种写法和 --歌手 一样（冒号后面可以空一格再写名字）
            const colon = /^([^:：\s]+)[:：](.*)$/.exec(token);
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
        if (/\s$/.test(raw || '') === false && last.startsWith('--') && !FLAG_LOOKUP.has(last.slice(2))) {
            out.pendingFlag = last.slice(2);
        }
        return out;
    };

    const hasSongFilter = (q) => Boolean(q.text || q.artist || q.album || q.title);

    /* 歌是否匹配：自由文字在标题/歌手/专辑里找，过滤只在对应字段里找；越靠前的命中分越高。 */
    const scoreTrack = (track, q, stripExtension) => {
        if (!track) return -1;
        const title = lower(stripExtension ? stripExtension(track.title) : track.title);
        const artist = lower(track.artist);
        const album = lower(track.album);
        if (q.artist && !artist.includes(lower(q.artist))) return -1;
        if (q.album && !album.includes(lower(q.album))) return -1;
        if (q.title && !title.includes(lower(q.title))) return -1;
        let score = 1;
        if (q.text) {
            const words = lower(q.text).split(/\s+/).filter(Boolean);
            for (const word of words) {
                if (title.startsWith(word)) score += 6;
                else if (title.includes(word)) score += 4;
                else if (artist.includes(word)) score += 2;
                else if (album.includes(word)) score += 1;
                else return -1;
            }
        }
        return score;
    };

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

        const state = { open: false, items: [], active: 0, lastFocus: null, closeTimer: null };

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

        // 「音量 40」「vol 40」这种直接给数字的。
        const volumeCommand = (text) => {
            const m = /^(?:音量|vol(?:ume)?|yinliang)\s*(\d{1,3})\s*%?$/i.exec(String(text || '').trim());
            if (!m) return null;
            const value = Math.min(100, Number(m[1]));
            return { id: 'volume-set', group: '音量', icon: 'volume-2', title: `把音量设为 ${value}%`, run: () => setVolume(value / 100), noRecent: true };
        };

        const matchCommand = (cmd, text) => {
            const words = lower(text).split(/\s+/).filter(Boolean);
            if (!words.length) return 0;
            const hay = lower(`${cmd.title} ${cmd.words || ''} ${cmd.group}`);
            let score = 0;
            for (const word of words) {
                if (lower(cmd.title).startsWith(word)) score += 3;
                else if (hay.includes(word)) score += 1;
                else return 0;
            }
            return score;
        };

        const notify = (message) => { try { global.MusicToast?.show({ id: 'queue', kind: 'success', message }); } catch (error) {} };
        const queueTracks = (tracks, front, label) => {
            const list = tracks.filter(Boolean);
            if (!list.length || typeof app.queueAdd !== 'function') return;
            // 「下一首播放」一组歌：倒着插到最前，放出来还是原来的顺序。
            if (front) list.slice().reverse().forEach((t) => app.queuePlayNext?.(t));
            else list.forEach((t) => app.queueAdd(t));
            notify(`${front ? '下一首播放' : '已加入队列'}：${label}`);
        };

        const songItem = (track, group, knownIndex) => {
            const index = Number.isInteger(knownIndex) ? knownIndex : app.playlist.indexOf(track);
            const isCurrent = index === app.currentTrackIndex;
            return {
                id: `song:${track.path}`,
                section: '歌曲',
                group,
                icon: isCurrent && app.isPlaying ? 'audio-lines' : 'music',
                title: trackTitle(track),
                desc: [trackArtist(track), track.album].filter(Boolean).join(' · '),
                current: isCurrent,
                queueable: true,
                run: () => { if (index !== -1) app.loadTrack?.(index); },
                playNext: () => queueTracks([track], true, trackTitle(track)),
                addToQueue: () => queueTracks([track], false, trackTitle(track))
            };
        };

        // 曲目路径映射缓存：避免每次打开面板或每次按键都重建整份 O(N) 曲库 Map
        let cachedPathList = null;
        let cachedPathLen = -1;
        let cachedPathFirst = null;
        let cachedPathLast = null;
        let cachedByPath = null;
        let cachedBySongId = null;
        const getTrackMaps = () => {
            const tracks = app.playlist || [];
            const len = tracks.length;
            const first = len ? tracks[0] : null;
            const last = len ? tracks[len - 1] : null;
            if (cachedByPath && cachedPathList === app.playlist && cachedPathLen === len
                && cachedPathFirst === first && cachedPathLast === last) {
                return { byPath: cachedByPath, bySongId: cachedBySongId };
            }
            const byPath = new Map();
            const bySongId = new Map();
            for (let i = 0; i < len; i++) {
                const t = tracks[i];
                if (!t) continue;
                byPath.set(t.path, t);
                bySongId.set(`song:${t.path}`, { track: t, index: i });
            }
            cachedPathList = app.playlist;
            cachedPathLen = len;
            cachedPathFirst = first;
            cachedPathLast = last;
            cachedByPath = byPath;
            cachedBySongId = bySongId;
            return { byPath, bySongId };
        };

        const playlistTracks = (pl, byPath) => {
            const map = byPath || getTrackMaps().byPath;
            return (pl.tracks || []).map((p) => map.get(p)).filter(Boolean);
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
        let searchIndex = null;
        let indexedList = null;
        let indexedLength = -1;
        let indexedPinyin = false;
        const pinyinCache = new Map();
        const pinyinFn = () => {
            const lib = global.pinyinPro;
            if (!lib || typeof lib.pinyin !== 'function') return null;
            return (c) => {
                if (!pinyinCache.has(c)) {
                    let p = '';
                    try { p = lib.pinyin(c, { toneType: 'none' }); } catch (error) { p = ''; }
                    pinyinCache.set(c, p);
                }
                return pinyinCache.get(c);
            };
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
        const nameMatches = (name, text) => {
            const words = lower(text).split(/\s+/).filter(Boolean);
            if (!words.length) return 0;
            const plain = lower(name);
            let romanized = null;
            const Lib = global.MusicArchiveIndex;
            let score = 0;
            for (const word of words) {
                if (plain.startsWith(word)) { score += 3; continue; }
                if (plain.includes(word)) { score += 2; continue; }
                if (/^[a-z0-9]+$/.test(word) && Lib?.romanize) {
                    romanized = romanized || Lib.romanize(name, pinyinFn());
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
                return tracks.map((track, idx) => ({ track, index: idx, s: scoreTrack(track, q, strip) }))
                    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
            }
            let order = q.text ? index.query(q.text, { limit: Math.max(limit * 4, 400) }) : tracks.map((_, i) => i);
            const keep = (kind, value) => {
                if (!value) return;
                const hits = new Set(index.query(value, { kind }));
                order = order.filter((i) => hits.has(i));
            };
            keep('artist', q.artist);
            keep('album', q.album);
            if (q.title) {
                const want = lower(q.title);
                const strip = app.stripAudioExtension;
                order = order.filter((i) => lower(strip ? strip(tracks[i]?.title) : tracks[i]?.title).includes(want));
            }
            return order.slice(0, limit).map((i) => (tracks[i] ? { track: tracks[i], index: i } : null)).filter(Boolean);
        };

        const recentItems = () => {
            const all = commands();
            const { byPath, bySongId } = getTrackMaps();
            return readRecent().map((id) => {
                if (id.startsWith('song:')) { const hit = bySongId.get(id); return hit ? { ...songItem(hit.track, '最近', hit.index), section: '最近' } : null; }
                if (id.startsWith('playlist:')) {
                    const pl = (app.customPlaylists || []).find((p) => `playlist:${p.id}` === id);
                    return pl ? { ...playlistItem(pl, '最近', byPath), section: '最近' } : null;
                }
                const cmd = all.find((c) => c.id === id);
                return cmd ? { ...cmd, group: '最近', section: '最近' } : null;
            }).filter(Boolean);
        };

        const build = () => {
            const raw = input.value;
            const q = parseQuery(raw);
            let items = [];
            if (!raw.trim()) {
                // 没输入时只放最近找过的歌和歌单；播放、切歌这些底栏上都有，不在这里列一排。
                items.push(...recentItems().filter((it) => !String(it.id).startsWith('cmd') && (it.queueable || String(it.id).startsWith('playlist:'))).slice(0, 8));
            } else {
                const songs = [];
                const playlists = [];
                const cmds = [];
                const vol = volumeCommand(raw);
                if (vol) cmds.push({ ...vol, section: '命令' });
                const onlyText = q.text && !q.artist && !q.album && !q.title;
                let commandPrefix = false;
                if (onlyText) {
                    commands()
                        .map((c) => ({ c, s: matchCommand(c, q.text) }))
                        .filter((x) => x.s > 0)
                        .sort((a, b) => b.s - a.s)
                        .slice(0, 6)
                        .forEach((x) => { if (x.s >= 3) commandPrefix = true; cmds.push({ ...x.c, section: '命令' }); });
                    const matchedPlaylists = (app.customPlaylists || [])
                        .map((pl) => ({ pl, s: nameMatches(pl.name || '', q.text) }))
                        .filter((x) => x.s > 0)
                        .sort((a, b) => b.s - a.s)
                        .slice(0, 6);
                    if (matchedPlaylists.length) {
                        const { byPath } = getTrackMaps();
                        matchedPlaylists.forEach((x) => playlists.push(playlistItem(x.pl, '歌单', byPath)));
                    }
                }
                if (hasSongFilter(q)) {
                    const found = findSongs(q, MAX_SONGS);
                    const queue = app.currentFilteredTracks && app.currentFilteredTracks !== app.playlist ? new Set(app.currentFilteredTracks) : null;
                    // 当前列表里的排前面，其余按得分。
                    const inQueue = queue ? found.filter((hit) => queue.has(hit.track)).slice(0, 20) : [];
                    const picked = new Set(inQueue.map((hit) => hit.track));
                    inQueue.forEach((hit) => songs.push(songItem(hit.track, '队列', hit.index)));
                    found.forEach((hit) => { if (!picked.has(hit.track)) songs.push(songItem(hit.track, '曲库', hit.index)); });
                }
                // 默认歌曲贴着输入框；输入像是在找操作（命令名开头命中、又没有歌名开头命中）时命令排前。
                const songPrefix = songs.some((it) => lower(it.title).startsWith(lower(q.text)));
                const groups = commandPrefix && !songPrefix ? [cmds, songs, playlists] : [songs, playlists, cmds];
                items = groups.flat();
            }
            state.items = items;
            state.active = 0;
            renderHints(raw, q);
            render();
        };

        const renderHints = (raw, q) => {
            const last = String(raw || '').split(/\s+/).pop() || '';
            const show = last.startsWith('--') && !FLAG_LOOKUP.has(last.slice(2));
            hints.hidden = !show;
            if (!show) { hints.innerHTML = ''; return; }
            const typed = lower(last.slice(2));
            const options = FILTERS.filter((f) => !typed || f.flag.startsWith(typed) || f.aliases.some((a) => a.startsWith(typed)));
            hints.innerHTML = '<div class="md-cmd-hints-k">过滤</div>' + (options.length ? options : FILTERS).map((f) => (
                `<button type="button" class="md-cmd-hint" data-flag="${f.flag}"><b>--${f.flag}</b><span>${f.hint}</span><i>${f.aliases.map((a) => `--${a}`).join(' ')}</i></button>`
            )).join('');
            void q;
        };

        const render = () => {
            if (!state.items.length) {
                list.innerHTML = input.value.trim()
                    ? `<div class="md-cmd-empty"><span>没有找到匹配的歌、歌单或操作</span></div>`
                    : `<div class="md-cmd-empty"><span>输入歌名、歌手或专辑</span><span class="md-cmd-tip">只找某个歌手或专辑：写「歌手:周杰伦」「专辑:叶惠美」</span><span class="md-cmd-tip">也可以直接输入「暂停」「音量 50」这样的指令</span></div>`;
                input.removeAttribute('aria-activedescendant');
                foot.hidden = true;
                return;
            }
            // 列表是倒着排的（column-reverse），所以每组的标题写在这组最后一项后面，显示出来就在上方。
            const parts = [];
            state.items.forEach((item, i) => {
                parts.push(rowHtml(item, i));
                const next = state.items[i + 1];
                if (item.section && (!next || next.section !== item.section)) parts.push(`<div class="md-cmd-sec" role="presentation">${escapeHtml(item.section)}</div>`);
            });
            list.innerHTML = parts.join('');
            // 第一条（贴着输入框）最清楚，往上越远越淡；选中的那条和悬停的那条总是清楚。
            list.querySelectorAll('.md-cmd-row').forEach((row, i) => { row.dataset.mdDist = String(Math.min(4, i)); });
            syncActive(false);
        };

        const rowHtml = (item, i) => (
                `<button type="button" class="md-cmd-row${i === state.active ? ' md-act' : ''}${item.current ? ' md-cur' : ''}" role="option" id="md-cmd-opt-${i}" aria-selected="${i === state.active}" data-i="${i}">`
                + `<span class="md-cmd-ri">${icon(item.icon || 'command', 16)}</span>`
                + `<span class="md-cmd-rt"><span class="md-cmd-l1"><span class="md-cmd-title">${escapeHtml(item.title)}</span>`
                + (item.hint ? `<kbd class="md-cmd-chip">${escapeHtml(item.hint)}</kbd>` : '')
                + `<span class="md-cmd-grp">${escapeHtml(item.group)}</span></span>`
                + (item.desc ? `<span class="md-cmd-desc">${escapeHtml(item.desc)}</span>` : '')
                + `</span><span class="md-cmd-run">${icon('corner-down-left', 13)}${item.queueable ? '播放' : '运行'}</span></button>`
        );

        const syncActive = (scroll = true) => {
            const prev = list.querySelector('.md-cmd-row.md-act');
            if (prev) { prev.classList.remove('md-act'); prev.setAttribute('aria-selected', 'false'); }
            const row = list.querySelector(`[data-i="${state.active}"]`);
            if (!row) return;
            row.classList.add('md-act');
            row.setAttribute('aria-selected', 'true');
            input.setAttribute('aria-activedescendant', row.id);
            // 选中的那一行背后是一滴玻璃，上下键换行时流过去（共用套件；列表重画也接着上一次的位置流）
            if (global.MusicFluid?.slide) {
                let drop = list.querySelector(':scope > .md-cmd-drop');
                if (!drop) { drop = document.createElement('i'); drop.className = 'md-cmd-drop'; drop.setAttribute('aria-hidden', 'true'); list.appendChild(drop); }
                global.MusicFluid.slide(drop, { top: row.offsetTop, height: row.offsetHeight }, { key: 'md-cmd', axis: 'y', lead: 140, trail: 300 });
            }
            foot.hidden = !state.items[state.active]?.queueable;
            if (scroll) row.scrollIntoView?.({ block: 'nearest' });
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
        const place = () => {
            const cap = host.querySelector('.md-cap');
            const rect = cap?.getBoundingClientRect();
            // 搜索框从播放条上方鼓出来：底边贴着播放条上沿再留 14px，播放条本身留在原处、不被遮。
            const gap = rect && rect.height ? Math.max(12, global.innerHeight - rect.top + 14) : 110;
            root.style.setProperty('--md-cmd-bottom', `${Math.round(gap)}px`);
            if (rect && rect.width) root.style.setProperty('--md-cmd-origin-x', `${Math.round(rect.left + rect.width / 2)}px`);
        };
        function open(initial = '') {
            if (state.open) { input.focus(); input.select(); return; }
            closeOthers?.();
            state.open = true;
            state.lastFocus = document.activeElement;
            if (state.closeTimer) { clearTimeout(state.closeTimer); state.closeTimer = null; }
            place();
            root.hidden = false;
            document.body.classList.add('music-dock-cmd-open');
            input.value = initial;
            build();
            requestAnimationFrame(() => {
                root.classList.add('md-open');
                // 搜索面板从播放条顶边长出来
                const cap = host.querySelector('.md-cap')?.getBoundingClientRect();
                if (cap && cap.width) global.MusicFluid?.bud(box, { x: cap.left + cap.width / 2, y: cap.top + 6 });
            });
            input.focus();
        }
        function close(restoreFocus = true) {
            if (!state.open) return;
            state.open = false;
            root.classList.remove('md-open');
            document.body.classList.remove('music-dock-cmd-open');
            state.closeTimer = setTimeout(() => { state.closeTimer = null; if (!state.open) root.hidden = true; }, 200);
            if (restoreFocus && state.lastFocus?.isConnected) state.lastFocus.focus?.({ preventScroll: true });
            // 关掉后输入框不能还占着焦点，否则下一次 Ctrl+K 会落进已关闭的面板里。
            if (root.contains(document.activeElement)) document.activeElement.blur();
            state.lastFocus = null;
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
            else if (event.key === 'Escape') { event.preventDefault(); if (input.value) { input.value = ''; build(); } else close(); }
            else if (event.key === 'Tab') {
                event.preventDefault();
                const hint = hints.hidden ? null : hints.querySelector('.md-cmd-hint');
                if (hint) acceptFlag(hint.dataset.flag);
            } else if ((event.ctrlKey || event.metaKey) && lower(event.key) === 'k') { event.preventDefault(); toggle(); }
        });
        const acceptFlag = (flag) => {
            input.value = input.value.replace(/--\S*$/, `--${flag} `);
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
                if (state.closeTimer) { clearTimeout(state.closeTimer); state.closeTimer = null; }
                if (resizeRaf) { global.cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
                document.removeEventListener('keydown', onGlobalKey, true);
                global.removeEventListener('resize', onResize);
                cachedPathList = cachedPathFirst = cachedPathLast = cachedByPath = cachedBySongId = null;
                searchIndex = indexedList = null;
                pinyinCache.clear();
                root.remove();
            }
        };
    }

    global.createMusicDockPalette = createMusicDockPalette;
    global.MusicDockPaletteQuery = Object.freeze({ parseQuery, scoreTrack });
})(window);
