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
        let state = { open: false, trackKey: '', playing: false };
        let timer;
        let received = false;
        let disposed = false;
        let hovering = false;
        let focused = false;
        let previewing = false;
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
            title.textContent = state.title || '尚未选择曲目';
            title.title = title.textContent;
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
        root.addEventListener('mouseenter', () => { hovering = true; renderExpansion(); });
        root.addEventListener('mouseleave', () => { hovering = false; renderExpansion(); });
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
        const unsubscribe = api.onMusicCapsuleState(next => { received = true; apply(next); });
        Promise.resolve(api.getMusicCapsuleState()).then(next => {
            if (!received) apply(next);
        }).catch(error => console.warn('[MusicCapsule] Initial snapshot failed:', error));
        window.addEventListener('beforeunload', () => {
            disposed = true;
            clearTimeout(timer);
            unsubscribe?.();
        }, { once: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else install();
})();