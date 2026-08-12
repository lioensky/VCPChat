(() => {
    'use strict';

    const ID = 'vchat-dynamic-wallpaper';
    if (window.VCPFrontendPlugins?.get(ID)) return;

    const STORE_KEY = 'vchatDynamicWallpaper.settings.v1';
    const state = {
        files: [],
        index: 0,
        currentTime: 0,
        playing: false,
        mode: 'sequence',
        muted: true,
        volume: 0.5,
        collapsed: true,
        enabled: true,
        wallpaperVisible: true,
        directoryPath: '',
        objectUrl: '',
        failedIndexes: new Set(),
        switching: false
    };

    let video;
    let panel;
    let classicPanel;
    let classicTitleGroup;
    let classicVisibleInput;
    let classicVolumeSlider;
    let accountMenu;
    let menuButton;
    let menuEnabledInput;
    let menuValue;
    let modeLabel;
    let globalControl;
    let globalEnabledInput;
    let wallpaperVisibleInput;
    let playIcon;
    let pauseIcon;
    let volumeIcon;
    let muteIcon;
    let sequenceIcon;
    let randomIcon;
    let loopIcon;
    let volumeSlider;
    let settingsObserver;
    let accountMenuObserver;
    let accountMenuClickHandler;
    let uiModeChangeHandler;
    let beforeUnloadHandler;

    const icons = {
        movie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/></svg>',
        prev: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.75 19.5 8.25 12l7.5-7.5v15z"/></svg>',
        play: '<svg data-icon="play" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>',
        pause: '<svg data-icon="pause" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
        next: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="m8.25 4.5 7.5 7.5-7.5 7.5v-15z"/></svg>',
        sequence: '<svg data-icon="sequence" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path stroke-linecap="round" d="M4 7h16M4 12h16M4 17h16"/></svg>',
        random: '<svg data-icon="random" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M4 7h3c5 0 5 10 10 10h3M17 14l3 3-3 3M4 17h3c2 0 3-1 4-3M16 7h4M17 4l3 3-3 3"/></svg>',
        loop: '<svg data-icon="loop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/></svg>',
        volume: '<svg data-icon="volume" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 5 6 9H2v6h4l5 4V5zm4 5a3 3 0 0 1 0 4m2-7a7 7 0 0 1 0 10"/></svg>',
        mute: '<svg data-icon="mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 5 6 9H2v6h4l5 4V5zm5 4 6 6m0-6-6 6"/></svg>'
    };

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
            state.index = Number.isInteger(saved.index) && saved.index >= 0 ? saved.index : 0;
            state.currentTime = Number.isFinite(saved.currentTime) && saved.currentTime >= 0 ? saved.currentTime : 0;
            state.playing = saved.playing === true;
            state.mode = saved.mode || 'sequence';
            state.muted = saved.muted !== false;
            state.volume = Number.isFinite(saved.volume) ? saved.volume : 0.5;
            state.collapsed = saved.collapsed !== false;
            state.enabled = saved.enabled !== false;
            state.wallpaperVisible = saved.wallpaperVisible !== false;
            state.directoryPath = typeof saved.directoryPath === 'string' ? saved.directoryPath : '';
        } catch {}
    }

    function capturePlayback() {
        if (!video || !Number.isFinite(video.currentTime)) return;
        state.currentTime = Math.max(0, video.currentTime);
    }

    function saveSettings() {
        localStorage.setItem(STORE_KEY, JSON.stringify({
            index: state.index,
            currentTime: state.currentTime,
            playing: state.playing,
            mode: state.mode,
            muted: state.muted,
            volume: state.volume,
            collapsed: state.collapsed,
            enabled: state.enabled,
            wallpaperVisible: state.wallpaperVisible,
            directoryPath: state.directoryPath
        }));
    }

    function releaseUrl() {
        if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
        state.objectUrl = '';
    }

    function applyVisibility({ resume = false } = {}) {
        if (globalEnabledInput) globalEnabledInput.checked = state.enabled;
        if (menuEnabledInput) menuEnabledInput.checked = state.enabled;
        if (wallpaperVisibleInput) wallpaperVisibleInput.checked = state.wallpaperVisible;
        if (classicVisibleInput) classicVisibleInput.checked = state.wallpaperVisible;
        if (!video) return;
        const visible = Boolean(state.enabled && state.wallpaperVisible && state.files.length);
        video.style.display = visible ? 'block' : 'none';
        document.body.classList.toggle('vchat-dynamic-wallpaper-visible', visible);
        if (!visible && !video.paused) {
            video.pause();
        } else if (visible && resume && state.playing && video.paused) {
            video.play().catch(() => {});
        }
    }

    function updateIcons() {
        const playing = !video.paused && !video.ended && Boolean(video.src);
        if (panel) {
            playIcon.style.display = playing ? 'none' : '';
            pauseIcon.style.display = playing ? '' : 'none';
            sequenceIcon.style.display = state.mode === 'sequence' ? '' : 'none';
            randomIcon.style.display = state.mode === 'random' ? '' : 'none';
            loopIcon.style.display = state.mode === 'loop' ? '' : 'none';
            volumeIcon.style.display = state.muted || state.volume === 0 ? 'none' : '';
            muteIcon.style.display = state.muted || state.volume === 0 ? '' : 'none';
            volumeSlider.value = String(state.volume);
            volumeSlider.style.backgroundSize = `${state.volume * 100}% 100%`;
            panel.querySelectorAll('[data-requires-files]').forEach((control) => {
                control.disabled = !state.files.length;
            });
            panel.querySelectorAll('[data-requires-visible]').forEach((control) => {
                control.disabled = !state.enabled || !state.wallpaperVisible || !state.files.length;
            });
            if (wallpaperVisibleInput) wallpaperVisibleInput.disabled = !state.enabled;
            if (modeLabel) {
                modeLabel.textContent = state.mode === 'random' ? '随机播放'
                    : state.mode === 'loop' ? '单曲循环' : '顺序播放';
            }
        }
        if (classicPanel) {
            const setClassicIcon = (name, visible) => {
                const icon = classicPanel.querySelector(`[data-icon="${name}"]`);
                if (icon) icon.style.display = visible ? '' : 'none';
            };
            setClassicIcon('play', !playing);
            setClassicIcon('pause', playing);
            setClassicIcon('sequence', state.mode === 'sequence');
            setClassicIcon('random', state.mode === 'random');
            setClassicIcon('loop', state.mode === 'loop');
            setClassicIcon('volume', !state.muted && state.volume > 0);
            setClassicIcon('mute', state.muted || state.volume === 0);
            if (classicVolumeSlider) {
                classicVolumeSlider.value = String(state.volume);
                classicVolumeSlider.style.backgroundSize = `${state.volume * 100}% 100%`;
            }
            classicPanel.querySelectorAll('[data-requires-files]').forEach(control => {
                control.disabled = !state.files.length;
            });
            classicPanel.querySelectorAll('[data-requires-visible]').forEach(control => {
                control.disabled = !state.enabled || !state.wallpaperVisible || !state.files.length;
            });
            if (classicVisibleInput) classicVisibleInput.disabled = !state.enabled;
        }
        if (menuValue) {
            menuValue.textContent = !state.enabled ? '已禁用'
                : !state.files.length ? '未选择'
                    : !state.wallpaperVisible ? '已隐藏'
                        : playing ? '播放中' : '已暂停';
        }
        applyVisibility();
    }

    function setEnabled(enabled) {
        capturePlayback();
        state.enabled = Boolean(enabled);
        applyVisibility({ resume: state.enabled });
        saveSettings();
        updateIcons();
    }

    function setMenuExpanded(expanded) {
        if (!panel || !menuButton) return;
        panel.hidden = !expanded;
        menuButton.setAttribute('aria-expanded', String(expanded));
    }

    function handlePanelAction(action) {
        if (action === 'select-folder') {
            selectFolder();
        } else if (action === 'prev') {
            playAt(state.index - 1);
        } else if (action === 'next') {
            next(true);
        } else if (action === 'play') {
            if (!state.enabled || !state.wallpaperVisible) return;
            state.playing = video.paused;
            saveSettings();
            if (state.playing) {
                video.play().catch(() => {
                    state.playing = false;
                    saveSettings();
                });
            } else {
                video.pause();
            }
        } else if (action === 'mode') {
            state.mode = state.mode === 'sequence' ? 'random' : state.mode === 'random' ? 'loop' : 'sequence';
            video.loop = state.mode === 'loop';
            saveSettings();
            updateIcons();
        } else if (action === 'mute') {
            state.muted = !state.muted;
            video.muted = state.muted;
            saveSettings();
            updateIcons();
        }
    }

    function updateVolume(value) {
        state.volume = Math.max(0, Math.min(1, Number(value)));
        video.volume = state.volume;
        state.muted = state.volume === 0;
        video.muted = state.muted;
        saveSettings();
        updateIcons();
    }

    async function playAt(index, { autoplay = true, startTime = 0, resetFailures = true } = {}) {
        if (!state.files.length || state.switching) return false;
        state.switching = true;
        if (resetFailures) state.failedIndexes.clear();
        state.index = ((index % state.files.length) + state.files.length) % state.files.length;
        state.currentTime = Number.isFinite(startTime) ? Math.max(0, startTime) : 0;
        state.playing = Boolean(autoplay);
        releaseUrl();
        const item = state.files[state.index];
        if (item && typeof item.url === 'string') {
            video.src = item.url;
        } else {
            state.objectUrl = URL.createObjectURL(item);
            video.src = state.objectUrl;
        }
        const restoreTime = () => {
            if (!Number.isFinite(state.currentTime) || state.currentTime <= 0) return;
            try {
                video.currentTime = Math.min(state.currentTime, Number.isFinite(video.duration) ? video.duration : state.currentTime);
            } catch {}
        };
        video.addEventListener('loadedmetadata', restoreTime, { once: true });
        video.load();
        restoreTime();
        state.switching = false;
        applyVisibility();
        saveSettings();
        if (state.playing && state.enabled && state.wallpaperVisible) {
            try {
                await video.play();
                updateIcons();
                return true;
            } catch (error) {
                state.playing = false;
                saveSettings();
                console.warn('[DynamicWallpaper] 浏览器拒绝播放当前视频。', error);
            }
        }
        updateIcons();
        return false;
    }

    function setPlaylist(files, { restore = false } = {}) {
        const savedIndex = state.index;
        const savedTime = state.currentTime;
        const savedPlaying = state.playing;
        state.files = files;
        state.failedIndexes.clear();
        if (!files.length) {
            state.index = 0;
            state.currentTime = 0;
            state.playing = false;
            releaseUrl();
            video.removeAttribute('src');
            video.load();
            saveSettings();
            updateIcons();
            return;
        }
        if (restore) {
            playAt(Math.min(savedIndex, files.length - 1), {
                autoplay: savedPlaying,
                startTime: savedTime
            });
        } else {
            playAt(0, { autoplay: true, startTime: 0 });
        }
    }

    function nextIndex(manual = false) {
        if (state.mode === 'random' && state.files.length > 1) {
            let next = state.index;
            while (next === state.index) next = Math.floor(Math.random() * state.files.length);
            return next;
        }
        if (!manual && state.mode === 'loop') return state.index;
        return state.index + 1;
    }

    function next(manual = false) {
        if (state.files.length) playAt(nextIndex(manual));
    }

    async function loadDirectory(directoryPath = '', { restore = false } = {}) {
        const api = window.chatAPI || window.electronAPI;
        if (typeof api?.selectVchatWallpaperDirectory !== 'function') {
            console.error('[DynamicWallpaper] 原生目录选择接口不可用。');
            return false;
        }
        try {
            const result = await api.selectVchatWallpaperDirectory(directoryPath);
            if (!result?.success) {
                if (!result?.canceled && result?.error) console.error('[DynamicWallpaper] 读取视频目录失败。', result.error);
                return false;
            }
            state.directoryPath = result.directoryPath || '';
            setPlaylist(Array.isArray(result.files) ? result.files : [], { restore });
            return true;
        } catch (error) {
            console.error('[DynamicWallpaper] 选择或读取视频目录失败。', error);
            return false;
        }
    }

    function selectFolder() {
        return loadDirectory('');
    }

    function restoreFolder() {
        if (state.directoryPath) loadDirectory(state.directoryPath, { restore: true });
    }

    function injectGlobalControl() {
        const section = document.getElementById('section-quick-actions');
        const existing = document.getElementById('vchat-dynamic-wallpaper-global-control');
        if (existing) {
            globalControl = existing;
            globalEnabledInput = existing.querySelector('input');
            applyVisibility();
            return;
        }
        if (!section) return;
        globalControl = document.createElement('div');
        globalControl.id = 'vchat-dynamic-wallpaper-global-control';
        globalControl.className = 'form-group-inline';
        globalControl.innerHTML = `
            <label for="vchatDynamicWallpaperEnabled">启用动态壁纸</label>
            <label class="switch">
                <input type="checkbox" id="vchatDynamicWallpaperEnabled">
                <span class="slider round"></span>
            </label>`;
        section.insertBefore(globalControl, section.children[1] || null);
        globalEnabledInput = globalControl.querySelector('input');
        globalEnabledInput.addEventListener('change', () => {
            setEnabled(globalEnabledInput.checked);
        });
        applyVisibility();
    }

    function injectAccountMenu() {
        const nextAccountMenu = document.getElementById('nextUiAccountMenu');
        if (!nextAccountMenu) return;
        if (accountMenu && accountMenu !== nextAccountMenu) {
            if (accountMenuClickHandler) accountMenu.removeEventListener('click', accountMenuClickHandler);
            accountMenuObserver?.disconnect();
        }
        const existingButton = document.getElementById('vchatDynamicWallpaperMenuButton');
        const existingPanel = document.getElementById('vchat-dynamic-wallpaper-menu');
        if (existingButton && existingPanel) {
            accountMenu = nextAccountMenu;
            menuButton = existingButton;
            panel = existingPanel;
            return;
        }

        accountMenu = nextAccountMenu;
        menuButton = document.createElement('button');
        menuButton.id = 'vchatDynamicWallpaperMenuButton';
        menuButton.className = 'next-ui-account-menu-item';
        menuButton.type = 'button';
        menuButton.setAttribute('role', 'menuitem');
        menuButton.setAttribute('aria-controls', 'vchat-dynamic-wallpaper-menu');
        menuButton.setAttribute('aria-expanded', 'false');
        menuButton.innerHTML = `
            <span class="vcp-ui-icon" aria-hidden="true">movie</span>
            <span class="next-ui-account-menu-label">视频壁纸</span>
            <span class="next-ui-account-menu-value vchat-wallpaper-menu-value">未选择</span>
            <span class="vcp-ui-icon next-ui-account-menu-chevron" aria-hidden="true">chevron_right</span>`;

        panel = document.createElement('div');
        panel.id = 'vchat-dynamic-wallpaper-menu';
        panel.className = 'next-ui-account-submenu vchat-wallpaper-menu';
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', '视频壁纸控制');
        panel.hidden = true;
        panel.innerHTML = `
            <label class="vchat-wallpaper-menu-row">
                <span>启用动态壁纸</span>
                <input id="vchatDynamicWallpaperMenuEnabled" type="checkbox" aria-label="启用动态壁纸">
            </label>
            <label class="vchat-wallpaper-menu-row vchat-wallpaper-visible">
                <span>显示视频壁纸</span>
                <input type="checkbox" aria-label="显示动态壁纸">
            </label>
            <button type="button" class="next-ui-account-submenu-item vchat-wallpaper-folder" data-action="select-folder">
                <span class="vcp-ui-icon" aria-hidden="true">folder_open</span>
                <span>选择视频文件夹</span>
            </button>
            <div class="vchat-wallpaper-playback" aria-label="视频播放控制">
                <button type="button" class="vchat-wallpaper-control" data-action="prev" data-requires-visible title="上一个" aria-label="上一个">${icons.prev}</button>
                <button type="button" class="vchat-wallpaper-control" data-action="play" data-requires-visible title="暂停或播放" aria-label="暂停或播放">${icons.pause}${icons.play}</button>
                <button type="button" class="vchat-wallpaper-control" data-action="next" data-requires-visible title="下一个" aria-label="下一个">${icons.next}</button>
                <button type="button" class="vchat-wallpaper-control vchat-wallpaper-mode" data-action="mode" data-requires-files title="切换播放模式">${icons.sequence}${icons.random}${icons.loop}<span class="vchat-wallpaper-mode-label">顺序播放</span></button>
            </div>
            <div class="vchat-wallpaper-volume">
                <button type="button" class="vchat-wallpaper-control" data-action="mute" data-requires-files title="静音或取消静音" aria-label="静音或取消静音">${icons.volume}${icons.mute}</button>
                <div class="vchat-wallpaper-volume-slider"><input type="range" min="0" max="1" step="0.05" value="${state.volume}" data-requires-files aria-label="视频壁纸音量"></div>
            </div>`;

        const themeStore = document.getElementById('nextUiAccountThemeStoreBtn');
        accountMenu.insertBefore(menuButton, themeStore || null);
        accountMenu.insertBefore(panel, themeStore || null);

        menuEnabledInput = panel.querySelector('#vchatDynamicWallpaperMenuEnabled');
        wallpaperVisibleInput = panel.querySelector('.vchat-wallpaper-visible input');
        menuValue = menuButton.querySelector('.vchat-wallpaper-menu-value');
        modeLabel = panel.querySelector('.vchat-wallpaper-mode-label');
        playIcon = panel.querySelector('[data-icon="play"]');
        pauseIcon = panel.querySelector('[data-icon="pause"]');
        sequenceIcon = panel.querySelector('[data-icon="sequence"]');
        randomIcon = panel.querySelector('[data-icon="random"]');
        loopIcon = panel.querySelector('[data-icon="loop"]');
        volumeIcon = panel.querySelector('[data-icon="volume"]');
        muteIcon = panel.querySelector('[data-icon="mute"]');
        volumeSlider = panel.querySelector('input[type="range"]');

        accountMenuClickHandler = (event) => {
            if (menuButton.contains(event.target)) {
                const presentationOptions = document.getElementById('nextUiAccountPresentationOptions');
                const presentationButton = document.getElementById('nextUiAccountPresentationBtn');
                if (presentationOptions) presentationOptions.hidden = true;
                presentationButton?.setAttribute('aria-expanded', 'false');
                setMenuExpanded(panel.hidden);
                return;
            }
            if (!panel.contains(event.target)) setMenuExpanded(false);
        };
        accountMenu.addEventListener('click', accountMenuClickHandler);
        accountMenuObserver = new MutationObserver(() => {
            if (accountMenu.hidden) setMenuExpanded(false);
        });
        accountMenuObserver.observe(accountMenu, { attributes: true, attributeFilter: ['hidden'] });

        panel.addEventListener('click', (event) => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            handlePanelAction(action);
        });
        menuEnabledInput.addEventListener('change', () => setEnabled(menuEnabledInput.checked));
        wallpaperVisibleInput.addEventListener('change', () => {
            capturePlayback();
            state.wallpaperVisible = wallpaperVisibleInput.checked;
            applyVisibility({ resume: state.wallpaperVisible });
            saveSettings();
            updateIcons();
        });
        volumeSlider.addEventListener('input', (event) => {
            updateVolume(event.target.value);
        });
        panel.querySelector('.vchat-wallpaper-volume').addEventListener('wheel', (event) => {
            event.preventDefault();
            updateVolume(state.volume + (event.deltaY > 0 ? -0.05 : 0.05));
        }, { passive: false });
        updateIcons();
    }

    function removeClassicControls() {
        if (!classicTitleGroup) return;
        const title = classicTitleGroup.querySelector('#currentChatAgentName');
        if (title) classicTitleGroup.replaceWith(title);
        else classicTitleGroup.remove();
        classicPanel = null;
        classicTitleGroup = null;
        classicVisibleInput = null;
        classicVolumeSlider = null;
    }

    function injectClassicControls() {
        if (document.documentElement.dataset.uiMode === 'next') {
            removeClassicControls();
            return;
        }
        if (classicPanel) return;
        const header = document.querySelector('.chat-header');
        const title = document.getElementById('currentChatAgentName');
        if (!header || !title) return;

        classicTitleGroup = document.createElement('div');
        classicTitleGroup.id = 'vchat-wallpaper-title-group';
        header.insertBefore(classicTitleGroup, title);
        classicTitleGroup.append(title);

        classicPanel = document.createElement('div');
        classicPanel.id = 'vchat-dynamic-wallpaper-panel';
        classicPanel.className = state.collapsed ? 'collapsed' : '';
        classicPanel.innerHTML = `
            <button type="button" class="vchat-wallpaper-toggle" data-action="collapse"
                title="视频壁纸控制（右键选择文件夹）" aria-label="展开或收起视频壁纸控制">
                ${icons.movie}
            </button>
            <div class="vchat-wallpaper-controls">
                <label class="vchat-wallpaper-visible" title="显示动态壁纸"><input type="checkbox" aria-label="显示动态壁纸"></label>
                <div class="vchat-wallpaper-group">
                    <button type="button" class="vchat-wallpaper-control" data-action="prev" data-requires-visible title="上一个" aria-label="上一个">${icons.prev}</button>
                    <button type="button" class="vchat-wallpaper-control" data-action="play" data-requires-visible title="暂停或播放" aria-label="暂停或播放">${icons.pause}${icons.play}</button>
                    <button type="button" class="vchat-wallpaper-control" data-action="next" data-requires-visible title="下一个" aria-label="下一个">${icons.next}</button>
                </div>
                <span class="vchat-wallpaper-divider"></span>
                <button type="button" class="vchat-wallpaper-control" data-action="mode" data-requires-files title="切换播放模式" aria-label="切换播放模式">${icons.sequence}${icons.random}${icons.loop}</button>
                <div class="vchat-wallpaper-volume">
                    <button type="button" class="vchat-wallpaper-control" data-action="mute" data-requires-files title="静音或取消静音" aria-label="静音或取消静音">${icons.volume}${icons.mute}</button>
                    <div class="vchat-wallpaper-volume-slider"><input type="range" min="0" max="1" step="0.05" value="${state.volume}" data-requires-files aria-label="视频壁纸音量"></div>
                </div>
            </div>`;
        classicTitleGroup.append(classicPanel);
        classicVisibleInput = classicPanel.querySelector('.vchat-wallpaper-visible input');
        classicVolumeSlider = classicPanel.querySelector('input[type="range"]');

        classicPanel.addEventListener('click', event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'collapse') {
                state.collapsed = !state.collapsed;
                classicPanel.classList.toggle('collapsed', state.collapsed);
                saveSettings();
                return;
            }
            handlePanelAction(action);
        });
        classicPanel.querySelector('[data-action="collapse"]').addEventListener('contextmenu', event => {
            event.preventDefault();
            selectFolder();
        });
        classicVisibleInput.addEventListener('change', () => {
            capturePlayback();
            state.wallpaperVisible = classicVisibleInput.checked;
            applyVisibility({ resume: state.wallpaperVisible });
            saveSettings();
            updateIcons();
        });
        classicVolumeSlider.addEventListener('input', event => updateVolume(event.target.value));
        classicPanel.querySelector('.vchat-wallpaper-volume').addEventListener('wheel', event => {
            event.preventDefault();
            updateVolume(state.volume + (event.deltaY > 0 ? -0.05 : 0.05));
        }, { passive: false });
        updateIcons();
    }

    function observeUiMounts() {
        injectGlobalControl();
        injectAccountMenu();
        injectClassicControls();
        settingsObserver = new MutationObserver(() => {
            injectGlobalControl();
            injectAccountMenu();
            injectClassicControls();
        });
        settingsObserver.observe(document.body, { childList: true, subtree: true });
    }

    function createUi() {
        video = document.createElement('video');
        video.id = 'vchat-dynamic-wallpaper-video';
        video.playsInline = true;
        video.muted = state.muted;
        video.volume = state.volume;
        document.body.prepend(video);

        video.addEventListener('play', () => {
            if (!state.enabled || !state.wallpaperVisible) {
                video.pause();
                return;
            }
            state.playing = true;
            saveSettings();
            updateIcons();
        });
        video.addEventListener('pause', () => {
            capturePlayback();
            saveSettings();
            updateIcons();
        });
        video.addEventListener('timeupdate', () => {
            capturePlayback();
            saveSettings();
        });
        video.addEventListener('ended', () => next(false));
        video.addEventListener('error', () => {
            if (!state.files.length || state.switching) return;
            state.failedIndexes.add(state.index);
            updateIcons();
            if (state.failedIndexes.size >= state.files.length) {
                console.error('[DynamicWallpaper] 所选目录中的视频均无法播放，已停止自动切换。');
                state.playing = false;
                saveSettings();
                video.pause();
                return;
            }
            let candidate = (state.index + 1) % state.files.length;
            while (state.failedIndexes.has(candidate)) candidate = (candidate + 1) % state.files.length;
            setTimeout(() => playAt(candidate, { resetFailures: false }), 800);
        });
        video.loop = state.mode === 'loop';
        uiModeChangeHandler = () => injectClassicControls();
        window.addEventListener('ui-mode-changed', uiModeChangeHandler);
        beforeUnloadHandler = () => {
            capturePlayback();
            saveSettings();
        };
        window.addEventListener('beforeunload', beforeUnloadHandler);
        observeUiMounts();
        updateIcons();
    }

    function destroy() {
        settingsObserver?.disconnect();
        accountMenuObserver?.disconnect();
        if (uiModeChangeHandler) window.removeEventListener('ui-mode-changed', uiModeChangeHandler);
        if (beforeUnloadHandler) window.removeEventListener('beforeunload', beforeUnloadHandler);
        if (accountMenu && accountMenuClickHandler) accountMenu.removeEventListener('click', accountMenuClickHandler);
        document.body.classList.remove('vchat-dynamic-wallpaper-visible');
        releaseUrl();
        video?.remove();
        panel?.remove();
        removeClassicControls();
        menuButton?.remove();
        globalControl?.remove();
    }

    function openMenu() {
        if (!menuButton || !panel) return false;
        setMenuExpanded(true);
        menuButton.focus();
        return true;
    }

    loadSettings();
    createUi();
    restoreFolder();
    window.VCPFrontendPlugins?.register(ID, { destroy, selectFolder, setPlaylist, state, applyVisibility, openMenu });
})();
