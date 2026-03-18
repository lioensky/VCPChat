// Musicmodules/music-lyrics.js
// 歌词获取、解析、渲染、动画

function setupLyrics(app) {
    app.fetchAndDisplayLyrics = async (artist, title) => {
        const requestToken = ++app.lyricsRequestToken;
        app.resetLyrics();
        if (!window.electron) return;

        const lrcContent = await window.electron.invoke('music-get-lyrics', { artist, title });
        if (requestToken !== app.lyricsRequestToken) return;

        if (lrcContent) {
            app.currentLyrics = app.parseLrc(lrcContent);
            app.renderLyrics();
        } else {
            // 尝试从网络获取歌词
            app.lyricsList.innerHTML = '<li class="no-lyrics">正在网络上搜索歌词...</li>';
            try {
                const fetchedLrc = await window.electron.invoke('music-fetch-lyrics', { artist, title });
                if (requestToken !== app.lyricsRequestToken) return;
                if (fetchedLrc) {
                    app.currentLyrics = app.parseLrc(fetchedLrc);
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

    app.parseLrc = (lrcContent) => {
        const lyricsMap = new Map();
        const lines = lrcContent.split('\n');
        const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            const text = trimmedLine.replace(timeRegex, '').trim();
            if (text) {
                let match;
                timeRegex.lastIndex = 0;
                while ((match = timeRegex.exec(trimmedLine)) !== null) {
                    const minutes = parseInt(match[1], 10);
                    const seconds = parseInt(match[2], 10);
                    const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
                    const time = (minutes * 60 + seconds + milliseconds / 1000) * app.lyricSpeedFactor + app.lyricOffset;
                    const timeKey = time.toFixed(4);

                    if (lyricsMap.has(timeKey)) {
                        if (!lyricsMap.get(timeKey).translation) {
                            lyricsMap.get(timeKey).translation = text;
                        }
                    } else {
                        lyricsMap.set(timeKey, { time, original: text, translation: '' });
                    }
                }
            }
        }

        return Array.from(lyricsMap.values()).sort((a, b) => a.time - b.time);
    };

    app.renderLyrics = () => {
        app.lyricsList.innerHTML = '';
        const fragment = document.createDocumentFragment();
        app.currentLyrics.forEach((line, index) => {
            const li = document.createElement('li');

            const originalSpan = document.createElement('span');
            originalSpan.textContent = line.original;
            originalSpan.className = 'lyric-original';
            li.appendChild(originalSpan);

            if (line.translation) {
                const translationSpan = document.createElement('span');
                translationSpan.textContent = line.translation;
                translationSpan.className = 'lyric-translation';
                li.appendChild(translationSpan);
            }

            li.dataset.index = index;
            fragment.appendChild(li);
        });
        app.lyricsList.appendChild(fragment);
    };

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

        if (newLyricIndex !== app.currentLyricIndex) {
            app.currentLyricIndex = newLyricIndex;
        }

        const allLi = app.lyricsList.querySelectorAll('li');
        allLi.forEach((li, index) => {
            const distance = Math.abs(index - app.currentLyricIndex);
            if (index === app.currentLyricIndex) {
                li.classList.add('active');
                li.style.opacity = 1;
            } else {
                li.classList.remove('active');
                li.style.opacity = Math.max(0.1, 1 - distance * 0.22).toFixed(2);
            }
        });

        // 平滑滚动
        if (app.currentLyricIndex > -1) {
            const currentLine = app.currentLyrics[app.currentLyricIndex];
            const nextLine = app.currentLyrics[app.currentLyricIndex + 1];
            const currentLineLi = app.lyricsList.querySelector(`li[data-index='${app.currentLyricIndex}']`);
            if (!currentLineLi) return;

            let progress = 0;
            if (nextLine) {
                const timeIntoLine = estimatedTime - currentLine.time;
                const lineDuration = nextLine.time - currentLine.time;
                if (lineDuration > 0) {
                    progress = Math.max(0, Math.min(1, timeIntoLine / lineDuration));
                }
            }

            const nextLineLi = nextLine ? app.lyricsList.querySelector(`li[data-index='${app.currentLyricIndex + 1}']`) : null;
            const currentOffset = currentLineLi.offsetTop;
            const nextOffset = nextLineLi ? nextLineLi.offsetTop : currentOffset;
            const interpolatedOffset = currentOffset + (nextOffset - currentOffset) * progress;

            const goldenRatioPoint = app.lyricsContainer.clientHeight * 0.382;
            const scrollOffset = interpolatedOffset - goldenRatioPoint + (currentLineLi.clientHeight / 2);
            app.lyricsList.style.transform = `translateY(-${scrollOffset}px)`;
        }
    };

    app.resetLyrics = () => {
        app.currentLyrics = [];
        app.currentLyricIndex = -1;
        app.lyricsList.innerHTML = '<li class="no-lyrics">加载歌词中...</li>';
        app.lyricsList.style.transform = 'translateY(0px)';
    };
}
