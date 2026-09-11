// Musicmodules/music-lyrics.js
// 歌词获取、解析、渲染、动画

function setupLyrics(app) {
    app.fetchAndDisplayLyrics = async (artist, title, options = {}) => {
        const requestToken = ++app.lyricsRequestToken;
        app.resetLyrics();
        if (!app.api?.getMusicLyrics) return;

        const duration = options.duration || app.lastKnownDuration || 0;
        const album = options.album || '';

        // 尝试从本地缓存读取（兼容结构化 LyricData 对象与旧版文本）
        const cached = await app.api.getMusicLyrics({ artist, title, rawObject: true });
        if (requestToken !== app.lyricsRequestToken) return;

        if (cached) {
            if (typeof cached === 'object' && Array.isArray(cached.lines)) {
                app.currentLyricsData = cached;
                app.currentLyrics = app.normalizeStructuredLyrics(cached);
            } else if (typeof cached === 'string') {
                app.currentLyrics = app.parseLrc(cached);
            }
            app.renderLyrics();
        } else {
            // 尝试从多平台聚合网络获取歌词
            app.lyricsList.innerHTML = '<li class="no-lyrics">正在自动匹配高精度网络歌词...</li>';
            try {
                const fetched = await app.api.fetchMusicLyrics({
                    artist,
                    title,
                    duration,
                    durationMs: Math.round(duration * 1000),
                    album,
                    rawObject: true
                });
                if (requestToken !== app.lyricsRequestToken) return;

                if (fetched) {
                    if (typeof fetched === 'object' && Array.isArray(fetched.lines)) {
                        app.currentLyricsData = fetched;
                        app.currentLyrics = app.normalizeStructuredLyrics(fetched);
                    } else if (typeof fetched === 'string') {
                        app.currentLyrics = app.parseLrc(fetched);
                    }
                    app.renderLyrics();
                } else {
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
                time: line.startTime * app.lyricSpeedFactor + app.lyricOffset,
                endTime: line.endTime * app.lyricSpeedFactor + app.lyricOffset,
                original: line.fullText,
                translation: line.translation || '',
                romanization: line.romanization || '',
                words: Array.isArray(line.words) ? line.words.map(w => ({
                    text: w.text,
                    startTime: w.startTime * app.lyricSpeedFactor + app.lyricOffset,
                    endTime: w.endTime * app.lyricSpeedFactor + app.lyricOffset
                })) : [],
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
                line.words.forEach((w, wIdx) => {
                    const wordSpan = document.createElement('span');
                    wordSpan.textContent = w.text;
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
                    app.api.seekMusic(line.time);
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
        if (app.currentLyrics.length === 0 || !app.isPlaying) return;

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

        for (let i = 0; i < totalLines; i++) {
            const li = allLi[i];
            const distance = Math.abs(i - app.currentLyricIndex);
            const isCurrent = (i === app.currentLyricIndex);

            if (isCurrent) {
                if (!li.classList.contains('active')) li.classList.add('active');
                li.style.opacity = '1';

                // 处理逐字 (Word-by-Word) 实时流光平滑染色
                const lineData = app.currentLyrics[i];
                if (lineData && lineData.isWordByWord && lineData.words && lineData.words.length > 0) {
                    const wordSpans = li.querySelectorAll('.lyric-word');
                    const wordCount = wordSpans.length;

                    for (let w = 0; w < wordCount; w++) {
                        const wordSpan = wordSpans[w];
                        const wordStart = parseFloat(wordSpan.dataset.start);
                        const wordEnd = parseFloat(wordSpan.dataset.end);

                        if (estimatedTime >= wordEnd) {
                            // 已经唱完此字
                            wordSpan.style.setProperty('--word-progress', '100%');
                            wordSpan.classList.remove('singing');
                            wordSpan.classList.add('finished');
                        } else if (estimatedTime <= wordStart) {
                            // 尚未唱到此字
                            wordSpan.style.setProperty('--word-progress', '0%');
                            wordSpan.classList.remove('singing', 'finished');
                        } else {
                            // 正处于演唱过程中 -> 计算精细毫秒百分比
                            const wordDuration = Math.max(0.001, wordEnd - wordStart);
                            const progress = Math.min(1, Math.max(0, (estimatedTime - wordStart) / wordDuration));
                            wordSpan.style.setProperty('--word-progress', `${(progress * 100).toFixed(1)}%`);
                            wordSpan.classList.add('singing');
                            wordSpan.classList.remove('finished');
                        }
                    }
                }
            } else {
                if (li.classList.contains('active')) li.classList.remove('active');
                li.style.opacity = Math.max(0.1, 1 - distance * 0.22).toFixed(2);

                // 已唱过或未唱到的行统一重置 word 状态，避免跳播时状态错乱
                if (i < app.currentLyricIndex) {
                    const finishedWords = li.querySelectorAll('.lyric-word:not(.finished)');
                    finishedWords.forEach(w => {
                        w.style.setProperty('--word-progress', '100%');
                        w.classList.remove('singing');
                        w.classList.add('finished');
                    });
                } else if (i > app.currentLyricIndex) {
                    const pendingWords = li.querySelectorAll('.lyric-word.singing, .lyric-word.finished');
                    pendingWords.forEach(w => {
                        w.style.setProperty('--word-progress', '0%');
                        w.classList.remove('singing', 'finished');
                    });
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

                const nextLineLi = nextLine ? allLi[app.currentLyricIndex + 1] : null;
                const currentOffset = currentLineLi.offsetTop;
                const nextOffset = nextLineLi ? nextLineLi.offsetTop : currentOffset;
                const interpolatedOffset = currentOffset + (nextOffset - currentOffset) * progress;

                const goldenRatioPoint = app.lyricsContainer.clientHeight * 0.382;
                app.targetScrollY = interpolatedOffset - goldenRatioPoint + (currentLineLi.clientHeight / 2);
            }
        }

        // Lerp 阻尼平滑逼近目标位置，杜绝 CSS 竞态抖动
        if (app.currentScrollY === undefined) app.currentScrollY = 0;
        if (app.targetScrollY === undefined) app.targetScrollY = 0;

        if (!app.lyricUserScrolling) {
            app.currentScrollY += (app.targetScrollY - app.currentScrollY) * 0.12;
            app.lyricsList.style.transform = `translate3d(0, -${app.currentScrollY.toFixed(2)}px, 0)`;
        }
    };

    app.resetLyrics = () => {
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
