// Musicmodules/music-lyrics.js
// 歌词获取、解析、渲染、动画

function getScrollingLyricWordTexts(line) {
    const texts = line.words.map(word => word.text ?? '');
    const original = (line.original || line.fullText || '').trim();
    const joined = texts.join('');
    const collapse = text => text.trim().replace(/\s+/g, ' ');
    const strip = text => text.replace(/\s+/g, '');

    // 模拟逐词计时可能丢掉空格。只在正文和词元逐字符对齐时借用正文的词界。
    if (/\s/.test(original) && collapse(joined) !== collapse(original) && strip(joined) === strip(original)) {
        const characters = original.match(/\S\s*/gu);
        let cursor = 0;
        return texts.map(text => strip(text).replace(/\S/gu, () => characters[cursor++]));
    }
    return texts;
}

function setupLyrics(app) {
    app.disposeCurrentLyricsQuery = app.api?.onMusicCurrentLyricsRequest?.(({ requestId }) => {
        const track = app.pendingTrackPath
            ? app.playlist.find(candidate => candidate.path === app.pendingTrackPath)
            : null;
        // 只选取正文，避免把逐字词元、音源路径或凭据带入工具结果。
        app.api?.sendMusicCurrentLyricsResponse?.({
            requestId,
            snapshot: {
                track: track ? {
                    title: app.stripAudioExtension?.(track.title) || track.title || '',
                    artist: track.artist || '',
                    album: track.album || ''
                } : null,
                lines: track ? app.currentLyrics.map(line => ({
                    original: line.original || line.fullText || '',
                    translation: line.translation || '',
                    romanization: line.romanization || ''
                })) : []
            }
        });
    });

    const lyricSearchMisses = new Map();
    const LYRIC_MISS_TTL_MS = 10 * 60 * 1000;
    const LYRIC_SEARCH_SETTLE_MS = 500;

    app.fetchAndDisplayLyrics = async (artist, title, options = {}) => {
        app.resetLyrics();
        const requestToken = app.lyricsRequestToken;
        if (!app.api?.getMusicLyrics) return;

        const rawTitle = String(title || '').trim();
        const normalizedTitle = app.stripAudioExtension?.(rawTitle) || rawTitle;
        // 未知时长保持未知，不能借用上一首的播放状态参与匹配评分。
        const duration = Number.isFinite(Number(options.duration)) && Number(options.duration) > 0
            ? Number(options.duration) : 0;
        const album = options.album || '';

        // 先按原始标题读取，兼容历史上以“歌名.flac”保存的缓存；
        // 未命中时再读取规范化标题，新下载一律不携带音频扩展名。
        let cached = await app.api.getMusicLyrics({
            artist,
            title: rawTitle,
            rawObject: true
        });
        if (requestToken !== app.lyricsRequestToken) return;
        if (!cached && normalizedTitle && normalizedTitle !== rawTitle) {
            cached = await app.api.getMusicLyrics({
                artist,
                title: normalizedTitle,
                rawObject: true
            });
            if (requestToken !== app.lyricsRequestToken) return;
        }

        if (cached) {
            if (typeof cached === 'object' && Array.isArray(cached.lines)) {
                app.currentLyricsData = cached;
                app.currentLyrics = app.normalizeStructuredLyrics(cached);
            } else if (typeof cached === 'string') {
                app.currentLyrics = app.parseLrc(cached);
            }
            app.renderLyrics();
        } else {
            // 这首歌刚搜过且没有结果：短时间内不再重复联网搜一遍。
            const missKey = `${artist || ''}\u0000${normalizedTitle}`;
            if ((lyricSearchMisses.get(missKey) || 0) > Date.now()) {
                app.lyricsList.innerHTML = '<li class="no-lyrics">暂无歌词</li>';
                return;
            }

            // 自动下载与手动搜索严格复用同一条候选搜索、解析和写盘链路。
            // 这避免单体 fetchMusicLyrics 接口与手动候选接口出现 provider 行为差异。
            app.lyricsList.innerHTML = '<li class="no-lyrics">正在跨平台审计高精度歌词...</li>';
            // 连续切歌时路过的歌不联网：停留片刻仍是这首才开始搜索。
            await new Promise(resolve => setTimeout(resolve, LYRIC_SEARCH_SETTLE_MS));
            if (requestToken !== app.lyricsRequestToken) return;
            try {
                let fetched = null;
                if (app.api.searchMusicLyricsCandidates && app.api.applyMusicLyricsCandidate) {
                    const searchResult = await app.api.searchMusicLyricsCandidates({
                        artist,
                        title: normalizedTitle,
                        durationMs: Math.round(duration * 1000),
                        album
                    });
                    if (requestToken !== app.lyricsRequestToken) return;

                    const durationDifference = candidate => duration > 0 && candidate.durationMs > 0
                        ? Math.abs(candidate.durationMs - duration * 1000) : Infinity;
                    // 不依赖接口返回顺序；质量特性只能在匹配分相同时打破平局。
                    const bestCandidate = (searchResult?.success ? [...(searchResult.candidates || [])] : [])
                        .filter(candidate => candidate?.candidateKey
                            && Number.isFinite(Number(candidate.matchScore))
                            && Number(candidate.matchScore) >= 60)
                        .sort((a, b) => b.matchScore - a.matchScore
                            || Number(b.isWordByWord) - Number(a.isWordByWord)
                            || durationDifference(a) - durationDifference(b))[0];
                    if (bestCandidate?.candidateKey) {
                        const applyResult = await app.api.applyMusicLyricsCandidate({
                            candidateKey: bestCandidate.candidateKey,
                            artist,
                            title: normalizedTitle
                        });
                        if (requestToken !== app.lyricsRequestToken) return;
                        if (applyResult?.success && applyResult.lyrics) {
                            fetched = applyResult.lyrics;
                            console.log(
                                '[MusicLyrics] Automatic candidate applied:',
                                bestCandidate.sourceLabel || bestCandidate.source,
                                `${bestCandidate.matchScore}%`,
                                bestCandidate.isWordByWord ? 'word-by-word' : 'line-level'
                            );
                        }
                    }
                } else if (app.api.fetchMusicLyrics) {
                    // 兼容尚未暴露候选 IPC 的旧预加载环境。
                    fetched = await app.api.fetchMusicLyrics({
                        artist,
                        title: normalizedTitle,
                        duration,
                        durationMs: Math.round(duration * 1000),
                        album,
                        rawObject: true
                    });
                    if (requestToken !== app.lyricsRequestToken) return;
                }

                if (fetched) {
                    if (typeof fetched === 'object' && Array.isArray(fetched.lines)) {
                        app.currentLyricsData = fetched;
                        app.currentLyrics = app.normalizeStructuredLyrics(fetched);
                    } else if (typeof fetched === 'string') {
                        app.currentLyrics = app.parseLrc(fetched);
                    }
                    app.renderLyrics();
                } else {
                    lyricSearchMisses.set(missKey, Date.now() + LYRIC_MISS_TTL_MS);
                    app.lyricsList.innerHTML = '<li class="no-lyrics">暂无歌词</li>';
                }
            } catch (error) {
                if (requestToken !== app.lyricsRequestToken) return;
                console.error('Failed to fetch lyrics from network:', error);
                app.lyricsList.innerHTML = '<li class="no-lyrics">歌词获取失败</li>';
            }
        }
    };

    /**
     * 将后端返回的结构化 LyricData 转换为前端播放兼容的 currentLyrics 数组，
     * 同时保留 words 逐字元数据以供后续视觉特效与逐字渲染使用。
     */
    app.normalizeStructuredLyrics = (lyricData) => {
        if (!lyricData || !Array.isArray(lyricData.lines)) return [];
        return lyricData.lines
            // 某些上游迁移数据会插入正文严格为“//”的独立占位行。
            // 仅过滤完整独立行，避免误伤 AC/DC、A/B 等正常歌词。
            .filter(line => String(line?.fullText || '').trim() !== '//')
            .map(line => ({
                ...line,
                startTime: line.startTime * app.lyricSpeedFactor + app.lyricOffset,
                time: line.startTime * app.lyricSpeedFactor + app.lyricOffset,
                endTime: line.endTime * app.lyricSpeedFactor + app.lyricOffset,
                original: line.fullText,
                translation: line.translation || '',
                romanization: line.romanization || '',
                words: Array.isArray(line.words) ? line.words.map(w => ({
                    ...w,
                    text: w.text,
                    startTime: w.startTime * app.lyricSpeedFactor + app.lyricOffset,
                    endTime: w.endTime * app.lyricSpeedFactor + app.lyricOffset,
                    syllables: Array.isArray(w.syllables) ? w.syllables.map(syllable => ({
                        ...syllable,
                        startTime: syllable.startTime * app.lyricSpeedFactor + app.lyricOffset,
                        endTime: syllable.endTime * app.lyricSpeedFactor + app.lyricOffset
                    })) : undefined
                })) : [],
                renderHints: line.renderHints ? {
                    ...line.renderHints,
                    rawDuration: (line.endTime - line.startTime) * app.lyricSpeedFactor,
                    renderEndTime: Number.isFinite(line.renderHints.renderEndTime)
                        ? line.renderHints.renderEndTime * app.lyricSpeedFactor + app.lyricOffset
                        : line.endTime * app.lyricSpeedFactor + app.lyricOffset
                } : undefined,
                isWordByWord: Boolean(lyricData.isWordByWord)
            }));
    };

    /**
     * 增强型传统 LRC 解析器：完美兼容单语、同时间戳双语、微小时差双语以及前后分段式双语歌词
     */
    app.parseLrc = (lrcContent) => {
        if (!lrcContent || typeof lrcContent !== 'string') return [];

        const lines = lrcContent.replace(/^\uFEFF/, '').split(/\r?\n/);
        const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;
        const rawEntries = [];

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            // 忽略头部元数据（如 [ti:...], [ar:...] 等）
            if (/^\[[a-zA-Z]+:/.test(trimmedLine)) continue;

            const text = trimmedLine.replace(timeRegex, '').trim();
            if (!text || text === '//') continue;

            let match;
            timeRegex.lastIndex = 0;
            while ((match = timeRegex.exec(trimmedLine)) !== null) {
                const minutes = parseInt(match[1], 10);
                const seconds = parseInt(match[2], 10);
                const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
                const time = (minutes * 60 + seconds + milliseconds / 1000) * app.lyricSpeedFactor + app.lyricOffset;

                rawEntries.push({
                    time: Number(time.toFixed(3)),
                    text
                });
            }
        }

        if (rawEntries.length === 0) return [];

        // 判定是否是前后分段式双语（前半段全部为原语言，后半段是全部翻译）
        // 比如前半段按时间升序排到结尾，后半段又从 0 附近重新升序排到结尾
        const isTimeDecreasingAtSomePoint = () => {
            let dropCount = 0;
            for (let i = 1; i < rawEntries.length; i++) {
                if (rawEntries[i].time < rawEntries[i - 1].time - 5.0) {
                    dropCount++;
                }
            }
            return dropCount === 1;
        };

        const resultLines = [];

        if (isTimeDecreasingAtSomePoint()) {
            // 前后分段型：找到分割点
            let splitIndex = -1;
            for (let i = 1; i < rawEntries.length; i++) {
                if (rawEntries[i].time < rawEntries[i - 1].time - 5.0) {
                    splitIndex = i;
                    break;
                }
            }

            const originalEntries = rawEntries.slice(0, splitIndex).sort((a, b) => a.time - b.time);
            const translationEntries = rawEntries.slice(splitIndex).sort((a, b) => a.time - b.time);

            for (const orig of originalEntries) {
                // 在翻译列表中寻找时间差在 1.2 秒以内的最佳匹配项
                let bestTrans = '';
                let minDiff = 1.2;
                let foundIndex = -1;

                for (let j = 0; j < translationEntries.length; j++) {
                    const diff = Math.abs(translationEntries[j].time - orig.time);
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestTrans = translationEntries[j].text;
                        foundIndex = j;
                    }
                }

                if (foundIndex !== -1) {
                    translationEntries.splice(foundIndex, 1);
                }

                resultLines.push({
                    time: orig.time,
                    original: orig.text,
                    translation: bestTrans,
                    romanization: '',
                    words: [],
                    isWordByWord: false
                });
            }
        } else {
            // 相邻型或同时间戳型：按时间升序排序
            rawEntries.sort((a, b) => a.time - b.time);

            // 遍历并智能聚合同时间或微小时差 (<= 0.8s) 的相邻行
            let i = 0;
            while (i < rawEntries.length) {
                const current = rawEntries[i];
                const next = rawEntries[i + 1];

                // 如果下一行的时间差在 0.8 秒之内，且下一行与当前行大概率为 原文 + 翻译 的关系
                if (next && Math.abs(next.time - current.time) <= 0.8) {
                    resultLines.push({
                        time: current.time,
                        original: current.text,
                        translation: next.text,
                        romanization: '',
                        words: [],
                        isWordByWord: false
                    });
                    i += 2; // 合并处理两条
                } else {
                    resultLines.push({
                        time: current.time,
                        original: current.text,
                        translation: '',
                        romanization: '',
                        words: [],
                        isWordByWord: false
                    });
                    i += 1;
                }
            }
        }

        // 统一补全 endTime（方便后续计算）
        for (let idx = 0; idx < resultLines.length; idx++) {
            const next = resultLines[idx + 1];
            resultLines[idx].endTime = next ? next.time : resultLines[idx].time + 5.0;
        }

        return resultLines;
    };

    app.renderLyrics = () => {
        app.lyricsList.innerHTML = '';
        const fragment = document.createDocumentFragment();
        app.currentLyrics.forEach((line, index) => {
            const li = document.createElement('li');
            li.dataset.index = index;

            // 1. 罗马音 / 拼音注音行
            if (line.romanization) {
                const romaSpan = document.createElement('span');
                romaSpan.textContent = line.romanization;
                romaSpan.className = 'lyric-romanization';
                li.appendChild(romaSpan);
            }

            // 2. 原文主歌词行（支持逐字词元 span）
            const originalSpan = document.createElement('span');
            originalSpan.className = 'lyric-original';

            if (line.isWordByWord && line.words && line.words.length > 0) {
                originalSpan.classList.add('is-wbyw');
                const wordTexts = getScrollingLyricWordTexts(line);
                line.words.forEach((w, wIdx) => {
                    const wordSpan = document.createElement('span');
                    wordSpan.textContent = wordTexts[wIdx];
                    wordSpan.className = 'lyric-word';
                    wordSpan.dataset.wordIndex = wIdx;
                    wordSpan.dataset.start = w.startTime;
                    wordSpan.dataset.end = w.endTime;
                    originalSpan.appendChild(wordSpan);
                });
            } else {
                originalSpan.textContent = line.original;
            }
            li.appendChild(originalSpan);

            // 3. 翻译行
            if (line.translation) {
                const translationSpan = document.createElement('span');
                translationSpan.textContent = line.translation;
                translationSpan.className = 'lyric-translation';
                li.appendChild(translationSpan);
            }

            // 4. 点击跳转播放 (Seek-on-Click)
            li.onclick = (e) => {
                e.stopPropagation();
                if (typeof line.time === 'number' && app.api?.seekMusic) {
                    if (app.seekTo) app.seekTo(line.time); else app.api.seekMusic(line.time);
                    if (app.lastKnownDuration > 0) {
                        app.progress.style.width = `${(line.time / app.lastKnownDuration) * 100}%`;
                        app.currentTimeEl.textContent = app.formatTime(line.time);
                    }
                    app.lastKnownCurrentTime = line.time;
                    app.lastStateUpdateTime = Date.now();
                    app.currentLyricIndex = index;
                    // 用户点击后暂时锁定手动滚动，强制恢复自动跟踪
                    app.lyricUserScrolling = false;
                    if (app.lyricUserScrollTimer) clearTimeout(app.lyricUserScrollTimer);
                }
            };

            fragment.appendChild(li);
        });
        app.lyricsList.appendChild(fragment);

        // 重置滚动物理状态
        app.currentScrollY = 0;
        app.targetScrollY = 0;
    };

    // 监听用户在歌词容器的手动滚动，暂停自动视口吸附
    if (!app._lyricScrollListenersAttached && app.lyricsContainer) {
        app._lyricScrollListenersAttached = true;
        const handleUserScroll = () => {
            app.lyricUserScrolling = true;
            if (app.lyricUserScrollTimer) clearTimeout(app.lyricUserScrollTimer);
            // 用户停止滑动 3.5 秒后恢复自动居中跟随
            app.lyricUserScrollTimer = setTimeout(() => {
                app.lyricUserScrolling = false;
            }, 3500);
        };

        app.lyricsContainer.addEventListener('wheel', handleUserScroll, { passive: true });
        app.lyricsContainer.addEventListener('touchstart', handleUserScroll, { passive: true });
    }

    app.animateLyrics = () => {
        if (app.currentLyrics.length === 0 || !app.isPlaying || app.isTrackLoading) return;

        const elapsedTime = (Date.now() - app.lastStateUpdateTime) / 1000;
        const estimatedTime = app.lastKnownCurrentTime + elapsedTime;

        let newLyricIndex = -1;
        for (let i = 0; i < app.currentLyrics.length; i++) {
            if (estimatedTime >= app.currentLyrics[i].time) {
                newLyricIndex = i;
            } else {
                break;
            }
        }

        // 防回滚保护：当音乐正常向前播放时，如果只是一两帧估计时间的微小扰动，禁止行索引后退
        if (newLyricIndex < app.currentLyricIndex) {
            const currentLine = app.currentLyrics[app.currentLyricIndex];
            // 只有当播放进度比当前行开始时间倒退超过 1.5 秒（即用户确实做了拖动进度条倒退 Seek）时才允许回退
            if (currentLine && estimatedTime >= currentLine.time - 1.5) {
                newLyricIndex = app.currentLyricIndex;
            }
        }

        const prevLyricIndex = app.currentLyricIndex;
        if (newLyricIndex !== app.currentLyricIndex) {
            app.currentLyricIndex = newLyricIndex;
        }

        const allLi = app.lyricsList.children;
        const totalLines = allLi.length;
        const now = Date.now();

        // 整表的透明度、高亮和逐字复位只在“当前行变了”或“歌词重新渲染了”时做一遍。
        // 以前每一帧都对每一行写样式并查两次选择器，随后又读 offsetTop，
        // 等于每帧强制一次样式重算加布局，是播放时界面发卡的主要来源。
        const layout = app._lyricLayout || (app._lyricLayout = {});
        if (layout.head !== allLi[0] || layout.index !== app.currentLyricIndex || layout.count !== totalLines) {
            layout.head = allLi[0];
            layout.index = app.currentLyricIndex;
            layout.count = totalLines;
            layout.changedAt = now;
            layout.wordSpans = null;

            for (let i = 0; i < totalLines; i++) {
                const li = allLi[i];
                if (i === app.currentLyricIndex) {
                    li.classList.add('active');
                    li.style.opacity = '1';
                    const lineData = app.currentLyrics[i];
                    if (lineData && lineData.isWordByWord && lineData.words && lineData.words.length > 0) {
                        layout.wordSpans = Array.from(li.querySelectorAll('.lyric-word'), span => ({
                            span,
                            start: parseFloat(span.dataset.start),
                            end: parseFloat(span.dataset.end),
                            state: ''
                        }));
                    }
                    continue;
                }
                li.classList.remove('active');
                li.style.opacity = Math.max(0.1, 1 - Math.abs(i - app.currentLyricIndex) * 0.22).toFixed(2);

                // 已唱过或未唱到的行统一重置 word 状态，避免跳播时状态错乱
                if (i < app.currentLyricIndex) {
                    li.querySelectorAll('.lyric-word:not(.finished)').forEach(w => {
                        w.style.setProperty('--word-progress', '100%');
                        w.classList.remove('singing');
                        w.classList.add('finished');
                    });
                } else {
                    li.querySelectorAll('.lyric-word.singing, .lyric-word.finished').forEach(w => {
                        w.style.setProperty('--word-progress', '0%');
                        w.classList.remove('singing', 'finished');
                    });
                }
            }
        }

        // 逐字 (Word-by-Word) 流光：每帧只动当前行，而且只写状态真的变了的字。
        if (layout.wordSpans) {
            for (const word of layout.wordSpans) {
                if (estimatedTime >= word.end) {
                    if (word.state === 'finished') continue;
                    word.state = 'finished';
                    word.span.style.setProperty('--word-progress', '100%');
                    word.span.classList.remove('singing');
                    word.span.classList.add('finished');
                } else if (estimatedTime <= word.start) {
                    if (word.state === 'pending') continue;
                    word.state = 'pending';
                    word.span.style.setProperty('--word-progress', '0%');
                    word.span.classList.remove('singing', 'finished');
                } else {
                    const wordDuration = Math.max(0.001, word.end - word.start);
                    const progress = Math.min(1, Math.max(0, (estimatedTime - word.start) / wordDuration));
                    word.span.style.setProperty('--word-progress', `${(progress * 100).toFixed(1)}%`);
                    if (word.state !== 'singing') {
                        word.state = 'singing';
                        word.span.classList.add('singing');
                        word.span.classList.remove('finished');
                    }
                }
            }
        }

        // --- 弹性阻尼平滑滚动引擎 (Spring Lerp Physics) ---
        if (app.currentLyricIndex > -1 && !app.lyricUserScrolling) {
            const currentLine = app.currentLyrics[app.currentLyricIndex];
            const nextLine = app.currentLyrics[app.currentLyricIndex + 1];
            const currentLineLi = allLi[app.currentLyricIndex];

            if (currentLineLi) {
                let progress = 0;
                if (nextLine) {
                    const timeIntoLine = estimatedTime - currentLine.time;
                    const lineDuration = nextLine.time - currentLine.time;
                    // 若两行时间相同或极度接近（如传统双语由于分行未完全聚合），progress 直接置 0，防止除以 0 导致突变
                    if (lineDuration > 0.3) {
                        progress = Math.max(0, Math.min(1, timeIntoLine / lineDuration));
                    }
                }

                // 行高只在换行后的字号过渡期间（0.35s）和窗口尺寸变化后会变，
                // 其余时间用上次量到的位置，不再每帧触发布局。
                const viewportWidth = app.lyricsContainer.clientWidth;
                const viewportHeight = app.lyricsContainer.clientHeight;
                if (layout.measuredIndex !== app.currentLyricIndex
                    || now - layout.changedAt < 600
                    || layout.viewportWidth !== viewportWidth
                    || layout.viewportHeight !== viewportHeight) {
                    const nextLineLi = nextLine ? allLi[app.currentLyricIndex + 1] : null;
                    layout.measuredIndex = app.currentLyricIndex;
                    layout.viewportWidth = viewportWidth;
                    layout.viewportHeight = viewportHeight;
                    layout.currentOffset = currentLineLi.offsetTop;
                    layout.nextOffset = nextLineLi ? nextLineLi.offsetTop : layout.currentOffset;
                    layout.currentHeight = currentLineLi.clientHeight;
                }
                const interpolatedOffset = layout.currentOffset + (layout.nextOffset - layout.currentOffset) * progress;

                const goldenRatioPoint = viewportHeight * 0.382;
                app.targetScrollY = interpolatedOffset - goldenRatioPoint + (layout.currentHeight / 2);
            }
        }

        // Lerp 阻尼平滑逼近目标位置，杜绝 CSS 竞态抖动
        if (app.currentScrollY === undefined) app.currentScrollY = 0;
        if (app.targetScrollY === undefined) app.targetScrollY = 0;

        if (!app.lyricUserScrolling) {
            app.currentScrollY += (app.targetScrollY - app.currentScrollY) * 0.12;
            const transform = `translate3d(0, -${app.currentScrollY.toFixed(2)}px, 0)`;
            if (transform !== layout.transform) {
                layout.transform = transform;
                app.lyricsList.style.transform = transform;
            }
        }
    };

    app.resetLyrics = () => {
        app.lyricsRequestToken = (app.lyricsRequestToken || 0) + 1;
        app.currentLyricsData = null;
        app.currentLyrics = [];
        app.currentLyricIndex = -1;
        app.currentScrollY = 0;
        app.targetScrollY = 0;
        app.lyricUserScrolling = false;
        if (app.lyricUserScrollTimer) clearTimeout(app.lyricUserScrollTimer);
        app.lyricsList.innerHTML = '<li class="no-lyrics">加载歌词中...</li>';
        app.lyricsList.style.transform = 'translate3d(0, 0px, 0)';
    };
}
