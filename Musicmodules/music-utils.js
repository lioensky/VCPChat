// Musicmodules/music-utils.js
// 通用辅助函数，挂载到 app 上下文

function setupUtils(app) {
    const api = app.api || window.utilityAPI || window.electronAPI;

    const AUDIO_EXT_RE = /\.(mp3|flac|wav|m4a|ogg|aac|wma|ape|dsf|dff|alac|aiff?|opus|wv)$/i;
    const HEX_RE = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
    const PATH_MATCH_RE = /\[路径: (.*?)\]/;
    const LINE_SPLIT_RE = /[\r\n]+/;
    const EXT_TRIM_RE = /\.[^.]+$/;
    const WS_SPLIT_RE = /\s+/;
    const FILE_BSLASH_RE = /\\/g;
    const FILE_ENC_RE = /[?#']/g;
    const VCP_CHAT_URL_RE = /\/v1\/chat\/completions\/?$/;
    const SEM_ERR_SELF_RE = /^还没有设置|^VCP 服务器响应超时/;
    const SEM_ERR_NET_RE = /failed to fetch|networkerror|econnrefused/i;
    const SEM_ERR_AUTH_RE = /status: (401|403)/;
    const TXT_EXT_RE = /\.txt$/;

    // 去除标题尾部的音频文件扩展名（如 .mp3, .flac, .wav 等）
    app.stripAudioExtension = (title) => {
        if (!title || typeof title !== 'string') return title;
        const dot = title.lastIndexOf('.');
        if (dot === -1 || title.length - dot > 5) return title;
        return title.replace(AUDIO_EXT_RE, '');
    };

    // 列表搜索框和歌单编辑框共用的匹配：全角半角、大小写、合字统一（NFKC），标题去掉扩展名，
    // 歌手和专辑也算；空格分开的几个词都要命中（顺序不限）。
    // ASCII、常用汉字（U+4E00–U+9FFF）和基础平假名（U+3041–U+3096）均为 NFKC 不变量，跳过昂贵的 ICU normalize('NFKC')。
    const NEEDS_NFKC_RE = /[^\x00-\x7f\u4e00-\u9fff\u3041-\u3096]/;
    const searchKey = (text) => {
        const s = String(text || '');
        return NEEDS_NFKC_RE.test(s) ? s.normalize('NFKC').toLowerCase() : s.toLowerCase();
    };
    const searchFieldCache = new Map();
    const cachedFieldKey = (raw) => {
        if (!raw) return '';
        let hit = searchFieldCache.get(raw);
        if (hit === undefined) {
            hit = searchKey(raw);
            if (searchFieldCache.size >= 4096) searchFieldCache.clear();
            searchFieldCache.set(raw, hit);
        }
        return hit;
    };
    const searchHayCache = new WeakMap();
    const hayOfTrack = (t) => {
        const title = t.title || '';
        const artist = t.artist || '';
        const album = t.album || '';
        const hit = searchHayCache.get(t);
        if (hit && hit.title === title && hit.artist === artist && hit.album === album) return hit.hay;
        const hay = `${searchKey(app.stripAudioExtension(title))}\n${cachedFieldKey(artist)}\n${cachedFieldKey(album)}`;
        searchHayCache.set(t, { title, artist, album, hay });
        return hay;
    };
    let lastSearchSrc = null;
    let lastSearchLen = -1;
    let lastSearchFirst = null;
    let lastSearchLast = null;
    let lastSearchWords = null;
    let lastSearchHits = null;
    const canNarrowWords = (prevWords, nextWords) => {
        if (!prevWords || nextWords.length < prevWords.length) return false;
        for (let i = 0; i < prevWords.length; i += 1) {
            const pw = prevWords[i];
            let covered = false;
            for (let j = 0; j < nextWords.length; j += 1) {
                if (nextWords[j].includes(pw)) { covered = true; break; }
            }
            if (!covered) return false;
        }
        return true;
    };
    app.searchTracks = (tracks, query) => {
        const words = searchKey(query).split(WS_SPLIT_RE).filter(Boolean);
        const list = Array.isArray(tracks) ? tracks : [];
        const wLen = words.length;
        if (!wLen) return list;
        const len = list.length;
        const first = len ? list[0] : null;
        const last = len ? list[len - 1] : null;
        const scan = (lastSearchHits && lastSearchSrc === list && lastSearchLen === len
            && lastSearchFirst === first && lastSearchLast === last
            && canNarrowWords(lastSearchWords, words))
            ? lastSearchHits
            : list;
        const out = [];
        if (wLen === 1) {
            const w0 = words[0];
            for (let i = 0, n = scan.length; i < n; i += 1) {
                const t = scan[i];
                if (t && hayOfTrack(t).includes(w0)) out.push(t);
            }
        } else {
            for (let i = 0, n = scan.length; i < n; i += 1) {
                const t = scan[i];
                if (!t) continue;
                const hay = hayOfTrack(t);
                let ok = true;
                for (let j = 0; j < wLen; j += 1) {
                    if (!hay.includes(words[j])) { ok = false; break; }
                }
                if (ok) out.push(t);
            }
        }
        lastSearchSrc = list;
        lastSearchLen = len;
        lastSearchFirst = first;
        lastSearchLast = last;
        lastSearchWords = words;
        lastSearchHits = out.slice();
        return out;
    };

    // 分享当前曲目到聊天；分享不了（远程曲目、文件已不在）时给个提示。
    app.shareCurrentTrack = async () => {
        if (!app.pendingTrackPath || !app.api?.shareMusicTrack) return;
        try {
            const result = await app.api.shareMusicTrack(app.pendingTrackPath);
            if (result && result.success === false && result.message) window.MusicToast?.show?.({ message: result.message });
        } catch (error) {
            console.error('[Music] Share failed:', error);
            window.MusicToast?.show?.({ kind: 'error', message: window.MusicErrorText ? window.MusicErrorText(error, '分享失败') : '分享失败' });
        }
    };

    // 本地文件路径转 file:// 地址：空格、中文、%、#、? 都要编码，不然用户名或缓存目录里带这些字符时封面出不来；
    // 结果里没有引号，可以直接放进 CSS 的 url("...")。
    app.fileUrl = (filePath) => {
        if (!filePath) return '';
        let p = String(filePath).replace(FILE_BSLASH_RE, '/');
        if (!p.startsWith('/')) p = '/' + p;
        return 'file://' + encodeURI(p).replace(FILE_ENC_RE, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    };

    // 和列表、档案页一样：一小时以上写成 1:02:03（以前写 62:03）；引擎还没报时长（undefined）时写 0:00，不是 NaN:NaN
    app.formatTime = (seconds) => {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const secs = String(total % 60).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${secs}` : `${m}:${secs}`;
    };

    app.normalizePathForCompare = (inputPath) => {
        if (!inputPath) return null;
        let normalized = inputPath.replace(FILE_BSLASH_RE, '/');
        if (normalized.startsWith('//?/')) {
            normalized = normalized.substring(4);
        }
        return normalized;
    };

    app.hexToRgb = (hex) => {
        if (!hex) return null;
        const result = HEX_RE.exec(hex.trim());
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    };

    app.performSemanticSearch = async (query) => {
        if (app.isSemanticSearching) return;
        app.isSemanticSearching = true;
        app.semanticSearchBtn?.classList.add('loading');
        // 结果回来时语义搜索已经关掉、或者框里已经换了别的字：这份结果不用了，不能盖掉现在的列表。
        const stillWanted = () => app.isSemanticSearchActive && String(app.searchInput?.value || '').trim() === query;
        const tell = (message) => { try { (globalThis.MusicToast?.show || (() => {}))({ message, kind: 'error' }); } catch (e) { /* 没有提示层 */ } };

        try {
            const settings = await api.loadSettings();
            // 没配 VCP 服务器地址时以前在这里抛 TypeError，按钮转一下就没了下文。
            if (!settings?.vcpServerUrl) throw new Error('还没有设置 VCP 服务器地址');
            let serverBaseUrl = settings.vcpServerUrl.replace(VCP_CHAT_URL_RE, '');
            if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';

            const toolRequest = `<<<[TOOL_REQUEST]>>>
maid:「始」MusicPlay「末」,
tool_name:「始」LightMemo「末」,
query:「始」[音乐检索]${query}「末」,
k:「始」10「末」,
tag_boost:「始」0.95「末」
<<<[END_TOOL_REQUEST]>>>`;

            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const fetchTimer = controller ? setTimeout(() => controller.abort(), 20000) : null;
            let res;
            try {
                res = await fetch(`${serverBaseUrl}v1/human/tool`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'Authorization': `Bearer ${settings.vcpApiKey}`
                    },
                    body: toolRequest,
                    ...(controller ? { signal: controller.signal } : {})
                });
            } finally {
                if (fetchTimer) clearTimeout(fetchTimer);
            }

            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            
            const data = await res.json();
            console.log('[Music] Semantic search result:', data);
            
            // 兼容 LightMemo 旧格式与新版内部 JSON / MCP content 数组格式
            const output = app.extractLightMemoOutput(data);

            if (!stillWanted()) return;
            if (output) {
                app.processSemanticSearchResults(output);
            } else {
                console.error('[Music] Semantic search failed or returned empty:', data);
                tell('语义搜索没有返回结果，检查 VCP 服务器和 LightMemo 插件');
            }
        } catch (err) {
            console.error('[Music] Semantic search error:', err);
            if (stillWanted()) {
                const raw = err?.name === 'AbortError' ? 'VCP 服务器响应超时' : (err?.message || String(err));
                const reason = SEM_ERR_SELF_RE.test(raw) ? raw
                    : SEM_ERR_NET_RE.test(raw) ? '连不上 VCP 服务器'
                    : SEM_ERR_AUTH_RE.test(raw) ? 'VCP 服务器拒绝了请求，检查 API Key'
                    : (globalThis.MusicErrorText ? globalThis.MusicErrorText(raw, '原因不明') : raw);
                tell(`语义搜索没有完成：${reason}`);
            }
        } finally {
            app.isSemanticSearching = false;
            app.semanticSearchBtn?.classList.remove('loading');
        }
    };

    app.extractLightMemoOutput = (payload) => {
        if (!payload) return '';
        if (typeof payload === 'string') return payload;

        if (typeof payload.original_plugin_output !== 'undefined') {
            return app.normalizeLightMemoContent(payload.original_plugin_output);
        }

        if (payload.result) {
            const resultOutput = app.extractLightMemoOutput(payload.result);
            if (resultOutput) return resultOutput;
        }

        if (typeof payload.content !== 'undefined') {
            return app.normalizeLightMemoContent(payload.content);
        }

        if (typeof payload.text === 'string') {
            return payload.text;
        }

        return '';
    };

    app.normalizeLightMemoContent = (content) => {
        if (content == null) return '';
        if (typeof content === 'string') {
            try {
                const parsedContent = JSON.parse(content);
                const nestedOutput = app.extractLightMemoOutput(parsedContent);
                return nestedOutput || content;
            } catch (e) {
                return content;
            }
        }

        if (Array.isArray(content)) {
            return content
                .map(item => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item.text === 'string') return item.text;
                    return app.extractLightMemoOutput(item);
                })
                .filter(Boolean)
                .join('\n');
        }

        if (typeof content === 'object') {
            return app.extractLightMemoOutput(content);
        }

        return String(content);
    };

    app.processSemanticSearchResults = (output) => {
        // 解析 LightMemo 输出
        // 格式示例:
        // --- (来源: MusicDiary, 相关性: 70.7%(混合))
        // [路径: file:///MusicDiary/Ebb and Flow (5 years after remix)-Tamame-Ebb and Flow (5 years after remix).txt]
        // [TagMemo 增强: 赛博朋克, VCP, 日记, 图像生成,提示词工程]
        // Ebb and Flow (5 years after remix)
        
        const results = [];
        const sections = output.split('--- (来源:');
        for (let si = 0; si < sections.length; si += 1) {
            const section = sections[si];
            if (!section.trim()) continue;
            // 提取路径
            const pathMatch = PATH_MATCH_RE.exec(section);
            if (pathMatch) {
                let p = pathMatch[1];
                // 处理 file:/// 协议
                if (p.startsWith('file:///')) p = p.substring(8);
                // 提取文件名（不含扩展名）作为搜索关键词
                const slash = p.lastIndexOf('/');
                const fileName = (slash >= 0 ? p.slice(slash + 1) : p).replace(TXT_EXT_RE, '');
                results.push({ path: p, fileName, originalSection: section });
            }
        }

        console.log('[Music] Parsed semantic results:', results);

        // 与本地播放列表匹配（预计算小写字段，避免每条结果/每行歌单重复扫全库转小写）
        const matchedTracks = [];
        const seenPaths = new Set();
        const pl = app.playlist || [];
        const indexedPlaylist = new Array(pl.length);
        for (let i = 0; i < pl.length; i += 1) {
            const track = pl[i];
            indexedPlaylist[i] = {
                track,
                title: (track.title || '').toLowerCase(),
                artist: (track.artist || '').toLowerCase(),
                path: (track.path || '').toLowerCase()
            };
        }

        for (let ri = 0; ri < results.length; ri += 1) {
            const res = results[ri];
            // 1. 尝试通过文件名匹配 (处理歌单中的逐行扫描逻辑)
            const query = res.fileName.toLowerCase();
            const rawParts = query.split('-');
            const queryParts = [];
            for (let pi = 0; pi < rawParts.length; pi += 1) {
                const part = rawParts[pi].trim();
                if (part.length > 1) queryParts.push(part);
            }
            const qPartsLen = queryParts.length;

            for (let i = 0; i < indexedPlaylist.length; i++) {
                const item = indexedPlaylist[i];
                const track = item.track;
                if (seenPaths.has(track.path)) continue;

                const title = item.title;
                const artist = item.artist;
                const trackPath = item.path;

                let isMatch = false;

                // A. 精确匹配标题或标题包含在查询中（要求标题长度大于2以避免误伤）
                if (title && (title === query || (query.includes(title) && title.length > 2))) {
                    isMatch = true;
                }
                // B. 匹配 歌曲-歌手 结构：要求同时匹配标题和艺术家
                else if (qPartsLen >= 2) {
                    let matchesTitle = false;
                    let matchesArtist = false;
                    for (let pi = 0; pi < qPartsLen; pi += 1) {
                        const part = queryParts[pi];
                        if (!matchesTitle && title && (title.includes(part) || part.includes(title))) matchesTitle = true;
                        if (!matchesArtist && artist && (artist.includes(part) || part.includes(artist))) matchesArtist = true;
                        if (matchesTitle && matchesArtist) break;
                    }
                    if (matchesTitle && matchesArtist) isMatch = true;
                }
                // C. 路径匹配 (要求查询词有一定长度)
                else if (trackPath.includes(query) && query.length > 3) {
                    isMatch = true;
                }

                if (isMatch) {
                    matchedTracks.push(track);
                    seenPaths.add(track.path);
                }
            }

            // 2. 处理歌单文件内容 (逐行扫描)
            const lines = res.originalSection.split(LINE_SPLIT_RE);
            for (let li = 0; li < lines.length; li += 1) {
                const trimmedLine = lines[li].trim();
                // 过滤掉元数据行
                if (!trimmedLine || trimmedLine.startsWith('[') || trimmedLine.startsWith('---')) continue;

                if (AUDIO_EXT_RE.test(trimmedLine)) {
                    const songQuery = trimmedLine.replace(EXT_TRIM_RE, '').toLowerCase();
                    for (let i = 0; i < indexedPlaylist.length; i++) {
                        const item = indexedPlaylist[i];
                        const track = item.track;
                        if (seenPaths.has(track.path)) continue;

                        const title = item.title;
                        // 歌单行匹配要求更高，避免误伤
                        if (title === songQuery || (title && songQuery.includes(title) && title.length > 2)) {
                            matchedTracks.push(track);
                            seenPaths.add(track.path);
                        }
                    }
                }
            }
        }

        console.log('[Music] Matched tracks count:', matchedTracks.length);

        // 强制切换到 "全部" 视图并渲染结果
        app.currentSidebarView = 'all';
        app.sidebarTabs?.forEach(t => t.classList.remove('active'));
        const allTab = document.querySelector('.sidebar-tab[data-view="all"]');
        if (allTab) allTab.classList.add('active');
        
        const categoryView = document.getElementById('sidebar-category-view');
        if (categoryView) categoryView.style.display = 'none';
        if (app.playlistEl) app.playlistEl.style.display = 'block';

        app.filteredPlaylistSource = null; // 搜索结果是整个曲库里找的，不再算某个歌单
        if (matchedTracks.length > 0) {
            app.currentFilteredTracks = matchedTracks;
            app.renderPlaylist(matchedTracks);
        } else {
            // 如果没有匹配到，显示空列表或提示
            app.currentFilteredTracks = [];
            app.renderPlaylist([]);
            console.log('[Music] No local tracks matched semantic search results');
        }
    };
}
