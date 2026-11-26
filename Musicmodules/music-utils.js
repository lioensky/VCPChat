// Musicmodules/music-utils.js
// 通用辅助函数，挂载到 app 上下文

function setupUtils(app) {
    const api = app.api || window.utilityAPI || window.electronAPI;

    // 去除标题尾部的音频文件扩展名（如 .mp3, .flac, .wav 等）
    app.stripAudioExtension = (title) => {
        if (!title) return title;
        return title.replace(/\.(mp3|flac|wav|m4a|ogg|aac|wma|ape|dsf|dff|alac|aiff|opus|wv)$/i, '');
    };

    // 列表搜索框和歌单编辑框共用的匹配：全角半角、大小写、合字统一（NFKC），标题去掉扩展名，
    // 歌手和专辑也算；空格分开的几个词都要命中（顺序不限）。
    const searchKey = (text) => String(text || '').normalize('NFKC').toLowerCase();
    app.searchTracks = (tracks, query) => {
        const words = searchKey(query).split(/\s+/).filter(Boolean);
        const list = Array.isArray(tracks) ? tracks : [];
        if (!words.length) return list;
        return list.filter((t) => {
            if (!t) return false;
            const hay = searchKey(`${app.stripAudioExtension(t.title || '')}\n${t.artist || ''}\n${t.album || ''}`);
            return words.every((w) => hay.includes(w));
        });
    };

    // 分享当前曲目到聊天；分享不了（远程曲目、文件已不在）时给个提示。
    app.shareCurrentTrack = async () => {
        if (!app.pendingTrackPath || !app.api?.shareMusicTrack) return;
        try {
            const result = await app.api.shareMusicTrack(app.pendingTrackPath);
            if (result && result.success === false && result.message) window.MusicToast?.show?.({ message: result.message });
        } catch (error) {
            console.error('[Music] Share failed:', error);
        }
    };

    // 本地文件路径转 file:// 地址：空格、中文、%、#、? 都要编码，不然用户名或缓存目录里带这些字符时封面出不来；
    // 结果里没有引号，可以直接放进 CSS 的 url("...")。
    app.fileUrl = (filePath) => {
        if (!filePath) return '';
        let p = String(filePath).replace(/\\/g, '/');
        if (!p.startsWith('/')) p = '/' + p;
        return 'file://' + encodeURI(p).replace(/[?#']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
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
        let normalized = inputPath.replace(/\\/g, '/');
        if (normalized.startsWith('//?/')) {
            normalized = normalized.substring(4);
        }
        return normalized;
    };

    app.hexToRgb = (hex) => {
        if (!hex) return null;
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    };

    app.performSemanticSearch = async (query) => {
        if (app.isSemanticSearching) return;
        app.isSemanticSearching = true;
        app.semanticSearchBtn.classList.add('loading');
        // 结果回来时语义搜索已经关掉、或者框里已经换了别的字：这份结果不用了，不能盖掉现在的列表。
        const stillWanted = () => app.isSemanticSearchActive && String(app.searchInput?.value || '').trim() === query;
        const tell = (message) => { try { (globalThis.MusicToast?.show || (() => {}))({ message, kind: 'error' }); } catch (e) { /* 没有提示层 */ } };

        try {
            const settings = await api.loadSettings();
            // 没配 VCP 服务器地址时以前在这里抛 TypeError，按钮转一下就没了下文。
            if (!settings?.vcpServerUrl) throw new Error('还没有设置 VCP 服务器地址');
            let serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
            if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';

            const toolRequest = `<<<[TOOL_REQUEST]>>>
maid:「始」MusicPlay「末」,
tool_name:「始」LightMemo「末」,
query:「始」[音乐检索]${query}「末」,
k:「始」10「末」,
tag_boost:「始」0.95「末」
<<<[END_TOOL_REQUEST]>>>`;

            const res = await fetch(`${serverBaseUrl}v1/human/tool`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Authorization': `Bearer ${settings.vcpApiKey}`
                },
                body: toolRequest
            });

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
                const raw = err?.message || String(err);
                const reason = /^还没有设置/.test(raw) ? raw
                    : /failed to fetch|networkerror|econnrefused/i.test(raw) ? '连不上 VCP 服务器'
                    : /status: (401|403)/.test(raw) ? 'VCP 服务器拒绝了请求，检查 API Key'
                    : (globalThis.MusicErrorText ? globalThis.MusicErrorText(raw, '原因不明') : raw);
                tell(`语义搜索没有完成：${reason}`);
            }
        } finally {
            app.isSemanticSearching = false;
            app.semanticSearchBtn.classList.remove('loading');
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
        
        sections.forEach(section => {
            if (!section.trim()) return;
            
            // 提取路径
            const pathMatch = section.match(/\[路径: (.*?)\]/);
            if (pathMatch) {
                let path = pathMatch[1];
                // 处理 file:/// 协议
                if (path.startsWith('file:///')) {
                    path = path.substring(8);
                }
                
                // 提取文件名（不含扩展名）作为搜索关键词
                const fileName = path.split('/').pop().replace(/\.txt$/, '');
                results.push({
                    path: path,
                    fileName: fileName,
                    originalSection: section
                });
            }
        });

        console.log('[Music] Parsed semantic results:', results);

        // 与本地播放列表匹配
        const matchedTracks = [];
        const seenPaths = new Set();

        results.forEach(res => {
            // 1. 尝试通过文件名匹配 (处理歌单中的逐行扫描逻辑)
            const query = res.fileName.toLowerCase();
            const queryParts = query.split('-').map(p => p.trim()).filter(p => p.length > 1);
            
            app.playlist.forEach(track => {
                if (seenPaths.has(track.path)) return;

                const title = (track.title || '').toLowerCase();
                const artist = (track.artist || '').toLowerCase();
                const trackPath = track.path.toLowerCase();

                let isMatch = false;
                
                // A. 精确匹配标题或标题包含在查询中（要求标题长度大于2以避免误伤）
                if (title && (title === query || (query.includes(title) && title.length > 2))) {
                    isMatch = true;
                }
                // B. 匹配 歌曲-歌手 结构：要求同时匹配标题和艺术家
                else if (queryParts.length >= 2) {
                    const matchesTitle = queryParts.some(p => title && (title.includes(p) || p.includes(title)));
                    const matchesArtist = queryParts.some(p => artist && (artist.includes(p) || p.includes(artist)));
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
            });
            
            // 2. 处理歌单文件内容 (逐行扫描)
            const lines = res.originalSection.split(/[\r\n]+/);
            lines.forEach(line => {
                const trimmedLine = line.trim();
                // 过滤掉元数据行
                if (!trimmedLine || trimmedLine.startsWith('[') || trimmedLine.startsWith('---')) return;

                const isAudioFile = /\.(mp3|flac|wav|m4a|ogg|aac|dsf|dff|ape)$/i.test(trimmedLine);
                if (isAudioFile) {
                    const songQuery = trimmedLine.replace(/\.[^.]+$/, '').toLowerCase();
                    app.playlist.forEach(track => {
                        if (seenPaths.has(track.path)) return;
                        
                        const title = (track.title || '').toLowerCase();
                        const trackPath = track.path.toLowerCase();

                        // 歌单行匹配要求更高，避免误伤
                        if (title === songQuery || (title && songQuery.includes(title) && title.length > 2)) {
                            matchedTracks.push(track);
                            seenPaths.add(track.path);
                        }
                    });
                }
            });
        });

        console.log('[Music] Matched tracks count:', matchedTracks.length);

        // 强制切换到 "全部" 视图并渲染结果
        app.currentSidebarView = 'all';
        app.sidebarTabs.forEach(t => t.classList.remove('active'));
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
