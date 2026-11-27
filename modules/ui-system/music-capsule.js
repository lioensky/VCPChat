(function () {
    'use strict';
    function install() {
        const root = document.querySelector('.music-capsule');
        const api = window.electronAPI;
        if (!root || !api?.onMusicCapsuleState) return;
        const title = root.querySelector('.music-capsule-title');
        const toggle = root.querySelector('[data-music-command="toggle"]');
        const playIcon = toggle.querySelector('.music-capsule-play');
        const pauseIcon = toggle.querySelector('.music-capsule-pause');
        const trigger = root.querySelector('.music-capsule-trigger');
        const details = root.querySelector('.music-capsule-details');
        const surface = root.querySelector('.music-capsule-surface');
        const buttons = [...surface.querySelectorAll('button')];
        const measure = document.createElement('span');
        measure.className = 'music-capsule-title music-capsule-measure';
        measure.setAttribute('aria-hidden', 'true');
        surface.appendChild(measure);
        let state = { open: false, trackKey: '', playing: false };
        let timer;
        let resizeRaf = 0;
        let received = false;
        let disposed = false;
        let hovering = false;
        let focused = false;
        let previewing = false;
        let injectionPending = false;
        let lastInjectionSig = '';
        const renderInjection = () => {
            const enabled = state.musicInfoInjectionEnabled !== false;
            const sig = `${enabled ? 1 : 0}|${injectionPending ? 1 : 0}`;
            if (sig === lastInjectionSig) return;
            lastInjectionSig = sig;
            root.classList.toggle('is-injection-disabled', !enabled);
            trigger.title = injectionPending ? '正在保存音乐信息注入状态…'
                : `音乐信息注入已${enabled ? '开启' : '关闭'}；右键${enabled ? '关闭' : '开启'}`;
            trigger.setAttribute('aria-label', `当前音乐；${trigger.title}`);
            trigger.setAttribute('aria-busy', String(injectionPending));
        };
        let lastExpandedWidth = 0;
        let chromeMetricsDirty = true;
        let cachedChromeWidth = 0;
        const number = value => parseFloat(value) || 0;
        const readChromeWidth = () => {
            const titleStyle = getComputedStyle(title);
            const detailsStyle = getComputedStyle(details);
            const surfaceStyle = getComputedStyle(surface);
            let buttonWidth = 0;
            for (let i = 0; i < buttons.length; i += 1) {
                buttonWidth += buttons[i].getBoundingClientRect().width;
            }
            return buttonWidth
                + number(titleStyle.paddingLeft) + number(titleStyle.paddingRight)
                + number(detailsStyle.columnGap) * (details.children.length - 1)
                + number(surfaceStyle.borderLeftWidth) + number(surfaceStyle.borderRightWidth)
                + number(surfaceStyle.paddingLeft) + number(surfaceStyle.paddingRight);
        };
        const updateWidth = () => {
            if (disposed || root.hidden) return;
            const currentTitle = title.textContent;
            if (measure.textContent !== currentTitle) measure.textContent = currentTitle;
            if (chromeMetricsDirty) {
                const measured = readChromeWidth();
                cachedChromeWidth = measured;
                if (measured > 0) chromeMetricsDirty = false;
            }
            const width = Math.ceil(measure.getBoundingClientRect().width + cachedChromeWidth);
            if (width !== lastExpandedWidth) {
                lastExpandedWidth = width;
                root.style.setProperty('--music-capsule-expanded-width', `${width}px`);
            }
        };
        const scheduleWidth = () => {
            if (disposed || root.hidden || resizeRaf) return;
            resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; updateWidth(); });
        };
        const onWindowResize = () => {
            chromeMetricsDirty = true;
            scheduleWidth();
        };
        const onFontsDone = () => { chromeMetricsDirty = true; updateWidth(); };
        // 监听外层容器而非胶囊自身：避免展开/收起宽度过渡动画每一帧都触发 ResizeObserver 强制同步布局；
        // 侧栏自身缩放不改变胶囊按钮/边框静态度量，仅窗口缩放或字体加载完成后重新探测 chromeWidth。
        const resizeTarget = root.parentElement || document.documentElement;
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleWidth) : null;
        if (resizeTarget) resizeObserver?.observe(resizeTarget);
        window.addEventListener('resize', onWindowResize);
        document.fonts?.addEventListener('loadingdone', onFontsDone);
        document.fonts?.ready.then(() => { if (!disposed) onFontsDone(); });
        let lastExpanded = null;
        const renderExpansion = () => {
            const expanded = Boolean(state.open && (hovering || focused || previewing));
            if (expanded === lastExpanded && root.classList.contains('is-expanded') === expanded) return;
            lastExpanded = expanded;
            root.classList.toggle('is-expanded', expanded);
            trigger.setAttribute('aria-expanded', String(expanded));
            details.inert = !expanded;
        };
        let lastPlaying = null;
        let lastOpen = null;
        let lastTitleText = null;
        const apply = next => {
            if (disposed || !next) return;
            const changed = next.open && next.trackKey && next.trackKey !== state.trackKey;
            const open = Boolean(next.open);
            const reopened = open && !state.open;
            state = next;
            if (open !== lastOpen) {
                lastOpen = open;
                root.hidden = !open;
            }
            if (reopened) chromeMetricsDirty = true;
            renderInjection();
            const nextTitle = state.title || '尚未选择曲目';
            const titleChanged = nextTitle !== lastTitleText;
            const needsMeasure = titleChanged || !measure.textContent || reopened;
            if (titleChanged) {
                lastTitleText = nextTitle;
                title.textContent = nextTitle;
                title.title = nextTitle;
            }
            if (open && needsMeasure) updateWidth();
            const playing = Boolean(state.playing);
            if (playing !== lastPlaying) {
                lastPlaying = playing;
                toggle.setAttribute('aria-label', playing ? '暂停' : '播放');
                playIcon.hidden = playing;
                pauseIcon.hidden = !playing;
                root.classList.toggle('is-playing', playing);
            }
            if (!state.open) {
                clearTimeout(timer);
                previewing = hovering = focused = false;
            } else if (changed) {
                clearTimeout(timer);
                previewing = true;
                timer = setTimeout(() => { previewing = false; renderExpansion(); }, 4000);
            }
            renderExpansion();
        };
        surface.addEventListener('mouseenter', () => { hovering = true; renderExpansion(); });
        surface.addEventListener('mouseleave', () => { hovering = false; renderExpansion(); });
        root.addEventListener('focusin', () => { focused = true; renderExpansion(); });
        root.addEventListener('focusout', event => {
            focused = root.contains(event.relatedTarget);
            renderExpansion();
        });
        root.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || event.isComposing) return;
            previewing = hovering = focused = false;
            root.querySelector(':focus')?.blur();
            clearTimeout(timer);
            renderExpansion();
            event.stopPropagation();
        });
        root.addEventListener('click', event => {
            const command = event.target.closest('[data-music-command]')?.dataset.musicCommand;
            if (!state.open || !command) return;
            api.sendMusicCapsuleCommand(command === 'toggle' ? (state.playing ? 'pause' : 'play') : command);
        });
        const toggleInjection = async event => {
            event.preventDefault();
            event.stopPropagation();
            if (disposed || injectionPending || !api.toggleMusicInfoInjection) return;
            injectionPending = true;
            renderInjection();
            let failure = null;
            try {
                const next = await api.toggleMusicInfoInjection();
                apply(next);
            } catch (error) {
                failure = error;
                console.warn('[MusicCapsule] Injection toggle failed:', error);
            } finally {
                injectionPending = false;
                if (!disposed) {
                    renderInjection();
                    if (failure) {
                        lastInjectionSig = '';
                        trigger.title = '音乐信息注入状态保存失败，请右键重试';
                        trigger.setAttribute('aria-label', trigger.title);
                    }
                }
            }
        };
        trigger.addEventListener('contextmenu', toggleInjection);
        trigger.addEventListener('keydown', event => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) toggleInjection(event);
        });
        renderInjection();
        const unsubscribe = api.onMusicCapsuleState(next => { received = true; apply(next); });
        Promise.resolve(api.getMusicCapsuleState()).then(next => {
            if (!received) apply(next);
        }).catch(error => console.warn('[MusicCapsule] Initial snapshot failed:', error));
        window.addEventListener('beforeunload', () => {
            disposed = true;
            clearTimeout(timer);
            if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
            unsubscribe?.();
            resizeObserver?.disconnect();
            window.removeEventListener('resize', onWindowResize);
            document.fonts?.removeEventListener('loadingdone', onFontsDone);
            measure.remove();
        }, { once: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else install();
})();