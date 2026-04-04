// Musicmodules/music-utils.js
// 通用辅助函数，挂载到 app 上下文

function setupUtils(app) {
    const api = app.api || window.utilityAPI || window.electronAPI;
    app.formatTime = (seconds) => {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
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

        try {
            const settings = await api.loadSettings();
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
            
            // 灵活处理返回格式
            let output = '';
            if (data.original_plugin_output) {
                output = data.original_plugin_output;
            } else if (data.status === 'success' && data.content) {
                try {
                    const content = JSON.parse(data.content);
                    output = content.original_plugin_output || data.content;
                } catch (e) {
                    output = data.content;
                }
            } else if (typeof data === 'string') {
                output = data;
            }

            if (output) {
                app.processSemanticSearchResults(output);
            } else {
                console.error('[Music] Semantic search failed or returned empty:', data);
            }
        } catch (err) {
            console.error('[Music] Semantic search error:', err);
        } finally {
            app.isSemanticSearching = false;
            app.semanticSearchBtn.classList.remove('loading');
        }
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
