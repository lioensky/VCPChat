(function () {
    'use strict';
    function install() {
        const root = document.querySelector('.music-capsule');
        const api = window.electronAPI;
        if (!root || !api?.onMusicCapsuleState) return;
        const title = root.querySelector('.music-capsule-title');
        const toggle = root.querySelector('[data-music-command="toggle"]');
        const trigger = root.querySelector('.music-capsule-trigger');
        const details = root.querySelector('.music-capsule-details');
        const surface = root.querySelector('.music-capsule-surface');
        const measure = document.createElement('span');
        measure.className = 'music-capsule-title music-capsule-measure';
        measure.setAttribute('aria-hidden', 'true');
        surface.appendChild(measure);
        let state = { open: false, trackKey: '', playing: false };
        let timer;
        let received = false;
        let disposed = false;
        let hovering = false;
        let focused = false;
        let previewing = false;
        let injectionPending = false;
        const renderInjection = () => {
            const enabled = state.musicInfoInjectionEnabled !== false;
            root.classList.toggle('is-injection-disabled', !enabled);
            trigger.title = injectionPending ? '正在保存音乐信息注入状态…'
                : `音乐信息注入已${enabled ? '开启' : '关闭'}；右键${enabled ? '关闭' : '开启'}`;
            trigger.setAttribute('aria-label', `当前音乐；${trigger.title}`);
            trigger.setAttribute('aria-busy', String(injectionPending));
        };
        const updateWidth = () => {
            if (disposed || root.hidden) return;
            measure.textContent = title.textContent;
            const number = value => parseFloat(value) || 0;
            const titleStyle = getComputedStyle(title);
            const detailsStyle = getComputedStyle(details);
            const surfaceStyle = getComputedStyle(surface);
            const buttons = [...surface.querySelectorAll('button')];
            const buttonWidth = buttons.reduce((sum, button) =>
                sum + button.getBoundingClientRect().width, 0);
            const width = Math.ceil(measure.getBoundingClientRect().width + buttonWidth
                + number(titleStyle.paddingLeft) + number(titleStyle.paddingRight)
                + number(detailsStyle.columnGap) * (details.children.length - 1)
                + number(surfaceStyle.borderLeftWidth) + number(surfaceStyle.borderRightWidth)
                + number(surfaceStyle.paddingLeft) + number(surfaceStyle.paddingRight));
            root.style.setProperty('--music-capsule-expanded-width', `${width}px`);
        };
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateWidth) : null;
        resizeObserver?.observe(root);
        document.fonts?.addEventListener('loadingdone', updateWidth);
        document.fonts?.ready.then(() => { if (!disposed) updateWidth(); });
        const renderExpansion = () => {
            const expanded = state.open && (hovering || focused || previewing);
            root.classList.toggle('is-expanded', expanded);
            trigger.setAttribute('aria-expanded', String(expanded));
            details.inert = !expanded;
        };
        const apply = next => {
            if (disposed || !next) return;
            const changed = next.open && next.trackKey && next.trackKey !== state.trackKey;
            state = next;
            root.hidden = !state.open;
            renderInjection();
            const nextTitle = state.title || '尚未选择曲目';
            const needsMeasure = title.textContent !== nextTitle || !measure.textContent;
            title.textContent = nextTitle;
            title.title = nextTitle;
            if (state.open && needsMeasure) updateWidth();
            toggle.setAttribute('aria-label', state.playing ? '暂停' : '播放');
            toggle.querySelector('.music-capsule-play').hidden = state.playing;
            toggle.querySelector('.music-capsule-pause').hidden = !state.playing;
            root.classList.toggle('is-playing', state.playing);
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
            if (event.key !== 'Escape') return;
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
            unsubscribe?.();
            resizeObserver?.disconnect();
            document.fonts?.removeEventListener('loadingdone', updateWidth);
            measure.remove();
        }, { once: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else install();
})();