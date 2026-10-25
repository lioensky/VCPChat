// modules/forum.js

const api = window.utilityAPI || window.electronAPI;

// ========== Global State ==========
let apiAuthHeader = null;
let forumConfig = {
    username: '',
    password: '',
    replyUsername: '', // New: for default reply name
    rememberCredentials: false
};
let allPosts = [];
let serverBaseUrl = '';
let resizeTimeout = null;
let avatarCache = {}; // Cache for loaded avatars
let avatarPendingCache = new Map(); // Cache pending avatar requests
let agentsList = []; // List of all agents with their names
let emoticonLibrary = []; // Emoticon library for URL fixing
let lastRenderedPostKeys = '';

// ========== DOM Elements ==========
const loginView = document.getElementById('login-view');
const forumView = document.getElementById('forum-view');
const masonryContainer = document.getElementById('masonry-container');
const activePostOverlay = document.getElementById('active-post-overlay');

// Inputs & Controls
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginButton = document.getElementById('login-button');
const loginError = document.getElementById('login-error');
const rememberMeCheckbox = document.getElementById('remember-me');
const searchInput = document.getElementById('search-posts');
const boardFilter = document.getElementById('board-filter');
const refreshBtn = document.getElementById('refresh-posts');
const boardNav = document.getElementById('board-nav');
const forumPageTitle = document.getElementById('forum-page-title');
const forumSummary = document.getElementById('forum-summary');
const forumNotice = document.getElementById('forum-notice');
const forumEmpty = document.getElementById('forum-empty');
let lastLoadError = '';
let postsLoaded = false;

// Modals
const createPostModal = document.getElementById('create-post-modal');
const createPostBtn = document.getElementById('create-post-btn');
const submitPostBtn = document.getElementById('submit-post-btn');

// Settings Modal
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingsUsernameInput = document.getElementById('settings-username');
const settingsPasswordInput = document.getElementById('settings-password');
const settingsReplyNameInput = document.getElementById('settings-reply-name');
const settingsRememberMe = document.getElementById('settings-remember-me');
const settingsError = document.getElementById('settings-error');


// ========== Window Controls ==========
document.getElementById('minimize-forum-btn')?.addEventListener('click', () => api?.minimizeWindow());
document.getElementById('maximize-forum-btn')?.addEventListener('click', () => api?.maximizeWindow());
document.getElementById('close-forum-btn')?.addEventListener('click', () => {
    if (api?.closeWindow) {
        api.closeWindow();
    } else {
        window.close();
    }
});

// ========== Initialization & Config ==========
// ========== Theme Management ==========
function applyTheme(theme) {
    document.body.classList.toggle('light-theme', theme === 'light');
}

document.addEventListener('DOMContentLoaded', async () => {
    window.addEventListener('resize', handleResize);

    const emoticonPanel = document.getElementById('emoticon-panel');
    if (window.emoticonManager && emoticonPanel) {
        await window.emoticonManager.initialize({ emoticonPanel });
    }

    await loadForumConfig();
    await loadAgentsList(); // Load agents list for avatar matching
    await loadEmoticonLibrary(); // Load emoticon library for URL fixing
    try {
        const settings = await api?.loadSettings();
        if (settings?.currentThemeMode) applyTheme(settings.currentThemeMode);
        api?.onThemeUpdated(applyTheme); // Listen for live theme changes
    } catch (e) { /* ignore */ }

    // Intercept external links and open them in the default browser
    document.body.addEventListener('click', (event) => {
        const link = event.target.closest('a');
        // Check if it's an external link
        if (link && (link.protocol === 'http:' || link.protocol === 'https:')) {
            event.preventDefault();
            api?.sendOpenExternalLink?.(link.href);
        }
    });
});

function handleResize() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        renderCurrentFilteredPosts({ force: false });
    }, 200);
}

async function loadForumConfig() {
    try {
        const config = await api?.loadForumConfig();
        if (config && !config.error) {
            forumConfig = { ...forumConfig, ...config };
            if (forumConfig.username) usernameInput.value = forumConfig.username;
            if (forumConfig.password) passwordInput.value = forumConfig.password;
            if (forumConfig.rememberCredentials) rememberMeCheckbox.checked = true;
            if (forumConfig.rememberCredentials && forumConfig.username && forumConfig.password) {
                handleLogin();
            } else {
                switchView('login');
            }
        } else {
            switchView('login');
        }
    } catch (error) {
        console.error('Config load error:', error);
        switchView('login');
    }
}

function switchView(viewName) {
    document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
    document.body.dataset.forumView = viewName;
    if (viewName === 'login') loginView.classList.add('active');
    if (viewName === 'forum') {
        forumView.classList.add('active');
        // 论坛视图显示后再做一次轻量重渲染，避免隐藏状态下读取宽度
        setTimeout(() => renderCurrentFilteredPosts({ force: false }), 50);
    }
}

// ========== API & Auth ==========
async function getServerUrl() {
    try {
        const settings = await api.loadSettings();
        if (!settings?.vcpServerUrl) throw new Error('VCP Server URL not configured');
        serverBaseUrl = settings.vcpServerUrl.replace(/\/v1\/chat\/completions\/?$/, '');
        if (!serverBaseUrl.endsWith('/')) serverBaseUrl += '/';
        return serverBaseUrl;
    } catch (error) {
        throw error;
    }
}

async function apiFetch(endpoint, options = {}) {
    if (!apiAuthHeader) throw new Error('Not logged in');
    if (!serverBaseUrl) await getServerUrl();

    const response = await fetch(`${serverBaseUrl}admin_api/forum${endpoint}`, {
        ...options,
        headers: {
            'Authorization': apiAuthHeader,
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    if (!response.ok) {
        if (response.status === 401) throw new Error('Authentication failed');
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `API Error: ${response.status}`);
    }
    return response.json();
}

async function handleLogin() {
    const user = usernameInput.value.trim();
    const pass = passwordInput.value.trim();
    if (!user || !pass) return showError(loginError, '请输入用户名和密码');

    loginButton.textContent = '验证中…';
    loginButton.disabled = true;
    loginError.textContent = '';

    try {
        await getServerUrl();
        apiAuthHeader = `Basic ${btoa(`${user}:${pass}`)}`;
        await apiFetch('/posts'); // Test auth

        // Save config by updating the existing config object, preserving all fields
        forumConfig.username = user;
        forumConfig.password = pass;
        forumConfig.rememberCredentials = rememberMeCheckbox.checked;
        api?.saveForumConfig(forumConfig);

        switchView('forum');
        loadPosts();
    } catch (error) {
        apiAuthHeader = null;
        showError(loginError, describeRequestError(error));
    } finally {
        loginButton.textContent = '进入论坛';
        loginButton.disabled = false;
    }
}

// Turns the raw fetch/auth errors into a sentence; the original text stays in
// parentheses so nothing is lost when reporting a problem.
function describeRequestError(error) {
    const message = error?.message || String(error || '');
    if (message === 'VCP Server URL not configured') return '尚未配置 VCP 服务器地址，请先在主程序设置中填写。';
    if (message === 'Authentication failed') return '用户名或密码错误。';
    if (error instanceof TypeError || /Failed to fetch|NetworkError/i.test(message)) {
        return `无法连接到 VCP 服务器，请检查服务器地址与网络（${message}）。`;
    }
    return message || '请求失败';
}

loginButton.addEventListener('click', handleLogin);
passwordInput.addEventListener('keydown', e => e.key === 'Enter' && handleLogin());

function showError(element, message) {
    element.textContent = message;
    element.style.animation = 'none';
    element.offsetHeight; /* trigger reflow */
    element.style.animation = null;
}

// ========== Avatar Loading Functions ==========
async function loadAgentsList() {
    try {
        const agentsData = await api?.loadAgentsList();
        if (agentsData && Array.isArray(agentsData)) {
            agentsList = agentsData;
            console.log('[Forum] Loaded', agentsList.length, 'agents for avatar matching');
        }
    } catch (error) {
        console.error('[Forum] Failed to load agents list:', error);
    }
}

// ========== Emoticon URL Fixer ==========
async function loadEmoticonLibrary() {
    if (!api?.getEmoticonLibrary) {
        emoticonLibrary = [];
        return;
    }

    try {
        const library = await api.getEmoticonLibrary();
        if (Array.isArray(library)) {
            emoticonLibrary = library;
            return;
        }

        emoticonLibrary = [];
    } catch (error) {
        emoticonLibrary = [];
    }
}

function getSimilarity(s1, s2) {
    let longer = s1;
    let shorter = s2;
    if (s1.length < s2.length) {
        longer = s2;
        shorter = s1;
    }
    const longerLength = longer.length;
    if (longerLength === 0) return 1.0;
    return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

function extractEmoticonInfo(url) {
    let filename = null;
    let packageName = null;
    if (!url) return { filename, packageName };

    try {
        const decodedPath = decodeURIComponent(new URL(url).pathname);
        const parts = decodedPath.split('/').filter(Boolean);
        if (parts.length > 0) filename = parts[parts.length - 1];
        if (parts.length > 1) packageName = parts[parts.length - 2];
    } catch (e) {
        try {
            const decodedUrl = decodeURIComponent(url);
            const parts = decodedUrl.split('/').filter(Boolean);
            if (parts.length > 0) filename = parts[parts.length - 1];
            if (parts.length > 1) packageName = parts[parts.length - 2];
        } catch (e2) {
            const parts = url.split('/').filter(Boolean);
            if (parts.length > 0) filename = parts[parts.length - 1];
            if (parts.length > 1) packageName = parts[parts.length - 2];
        }
    }
    return { filename, packageName };
}

function fixEmoticonUrl(originalSrc) {
    console.log(`[Forum Debug] Starting fix for: ${originalSrc}. Library size: ${emoticonLibrary.length}`);
    if (emoticonLibrary.length === 0) {
        console.log('[Forum Debug] Library is empty. Aborting.');
        return originalSrc;
    }

    // Quick check: if URL is already perfect
    try {
        const decodedOriginalSrc = decodeURIComponent(originalSrc);
        if (emoticonLibrary.some(item => decodeURIComponent(item.url) === decodedOriginalSrc)) {
            console.log('[Forum Debug] Perfect match found. Aborting.');
            return originalSrc;
        }
    } catch (e) { /* ignore */ }

    // Check if it's likely an emoticon URL
    try {
        if (!decodeURIComponent(originalSrc).includes('表情包')) {
            console.log('[Forum Debug] URL does not contain "表情包". Aborting.');
            return originalSrc;
        }
    } catch (e) {
        return originalSrc;
    }

    // Extract info and find best match
    const searchInfo = extractEmoticonInfo(originalSrc);
    if (!searchInfo.filename) {
        console.log('[Forum Debug] Could not extract filename. Aborting.');
        return originalSrc;
    }
    console.log(`[Forum Debug] Searching for package: "${searchInfo.packageName}", filename: "${searchInfo.filename}"`);

    let bestMatch = null;
    let highestScore = -1;

    for (const item of emoticonLibrary) {
        const itemPackageInfo = extractEmoticonInfo(item.url);
        
        let packageScore = 0.5;
        if (searchInfo.packageName && itemPackageInfo.packageName) {
            packageScore = getSimilarity(searchInfo.packageName, itemPackageInfo.packageName);
        } else if (!searchInfo.packageName && !itemPackageInfo.packageName) {
            packageScore = 1.0;
        } else {
            packageScore = 0.0;
        }

        const filenameScore = getSimilarity(searchInfo.filename, item.filename);
        const score = (0.7 * packageScore) + (0.3 * filenameScore);

        if (score > highestScore) {
            highestScore = score;
            bestMatch = item;
        }
    }
    
    console.log(`[Forum Debug] Best match: ${bestMatch ? bestMatch.filename : 'None'}. Score: ${highestScore.toFixed(2)}`);

    if (bestMatch && highestScore > 0.6) {
        console.log('[Forum] Fixed emoticon URL:', originalSrc, '->', bestMatch.url);
        return bestMatch.url;
    }
    
    console.log('[Forum Debug] No suitable match found.');
    return originalSrc;
}

// Setup image error handling for emoticon fixing
function setupEmoticonFixer(container) {
    const images = container.querySelectorAll('img');
    images.forEach(img => {
        // First, clean up any malformed URLs (e.g., extra backslashes from AI output)
        if (img.src) {
            // Remove escaped quotes and backslashes that might appear in URLs
            let cleanedSrc = img.src.replace(/\\"/g, '"').replace(/\\\\/g, '/').replace(/\\/g, '/');
            
            // If the URL was cleaned, update it immediately
            if (cleanedSrc !== img.src) {
                console.log('[Forum] Cleaned malformed URL:', img.src, '->', cleanedSrc);
                img.src = cleanedSrc;
            }
        }
        
        // Then set up error handling for emoticon fixing
        img.addEventListener('error', function() {
            const originalSrc = this.src;
            let isEmoticonUrl = false;
            try {
                // Decode the URL first, as the browser might have encoded special characters.
                isEmoticonUrl = decodeURIComponent(originalSrc).includes('表情包');
            } catch (e) {
                // Fallback for malformed URIs, check for the encoded version of "表情包"
                isEmoticonUrl = originalSrc.includes('%E8%A1%A8%E6%83%85%E5%8C%85');
            }

            if (originalSrc && isEmoticonUrl) {
                const fixedSrc = fixEmoticonUrl(originalSrc);
                if (fixedSrc !== originalSrc) {
                    console.log('[Forum] Attempting to fix broken emoticon:', originalSrc);
                    this.src = fixedSrc;
                }
            }
        }, { once: true }); // Only try once per image
    });
}

function setupImageViewer(container) {
    const images = container.querySelectorAll('img');
    images.forEach(img => {
        // NEW: Universal URL cleaning for file paths (e.g., Windows backslashes)
        if (img.src && img.src.includes('\\')) {
            let cleanedSrc = img.src.replace(/\\/g, '/');
            if (cleanedSrc !== img.src) {
                console.log('[Forum] Universal URL cleaning:', img.src, '->', cleanedSrc);
                img.src = cleanedSrc;
            }
        }
        
        // Exclude avatars from the image viewer functionality
        if (img.closest('.author-avatar, .reply-avatar')) {
            return;
        }

        img.style.cursor = 'pointer';
        img.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent the post from closing or other parent events
            if (api?.openImageViewer) {
                api.openImageViewer({
                    src: img.src,
                    title: '图片查看' // A generic title for the viewer window
                });
            }
        });
    });
}

async function getAvatarForUser(username) {
    if (!username) return null;
    
    // Check cache first
    if (avatarCache.hasOwnProperty(username)) {
        return avatarCache[username];
    }

    if (avatarPendingCache.has(username)) {
        return avatarPendingCache.get(username);
    }

    const avatarPromise = (async () => {
    try {
        // Check if it's the current user (check both replyUsername and username)
        const isCurrentUser = (forumConfig.replyUsername && username === forumConfig.replyUsername) ||
                             (forumConfig.username && username === forumConfig.username);
        
        if (isCurrentUser) {
            const userAvatar = await api?.loadUserAvatar();
            if (userAvatar) {
                avatarCache[username] = userAvatar;
                return userAvatar;
            }
        }

        // Check if it matches any agent (case-insensitive partial matching)
        for (const agent of agentsList) {
            const agentNameLower = agent.name.toLowerCase();
            const usernameLower = username.toLowerCase();
            
            if (agentNameLower.includes(usernameLower) || usernameLower.includes(agentNameLower)) {
                const agentAvatar = await api?.loadAgentAvatar(agent.folder);
                if (agentAvatar) {
                    avatarCache[username] = agentAvatar;
                    return agentAvatar;
                }
            }
        }

        // No avatar found, cache null to avoid repeated lookups
        avatarCache[username] = null;
        return null;
    } catch (error) {
        console.error('[Forum] Error loading avatar for', username, error);
        avatarCache[username] = null;
        return null;
    } finally {
        avatarPendingCache.delete(username);
    }
    })();

    avatarPendingCache.set(username, avatarPromise);
    return avatarPromise;
}

// ========== Settings Modal Logic ==========
function openSettingsModal() {
    settingsUsernameInput.value = forumConfig.username || '';
    settingsPasswordInput.value = forumConfig.password || '';
    settingsReplyNameInput.value = forumConfig.replyUsername || '';
    settingsRememberMe.checked = forumConfig.rememberCredentials || false;
    settingsError.textContent = '';
    settingsModal.style.display = 'flex';
}

async function saveSettings() {
    const newConfig = {
        username: settingsUsernameInput.value.trim(),
        password: settingsPasswordInput.value, // Don't trim password
        replyUsername: settingsReplyNameInput.value.trim(),
        rememberCredentials: settingsRememberMe.checked
    };

    if (!newConfig.username) {
        return showError(settingsError, '登录用户名不能为空');
    }

    // If not remembering, clear password from saved config
    if (!newConfig.rememberCredentials) {
        newConfig.password = '';
    }
    
    saveSettingsBtn.textContent = '保存中...';
    saveSettingsBtn.disabled = true;
    try {
        await api?.saveForumConfig(newConfig);
        forumConfig = newConfig;
        // Update login form fields as well, in case user logs out
        usernameInput.value = forumConfig.username;
        passwordInput.value = forumConfig.password;
        rememberMeCheckbox.checked = forumConfig.rememberCredentials;
        settingsModal.style.display = 'none';
        updateComposerIdentity(activePostOverlay);
    } catch (error) {
        showError(settingsError, '保存失败: ' + error.message);
    } finally {
        saveSettingsBtn.textContent = '保存';
        saveSettingsBtn.disabled = false;
    }
}

settingsBtn.addEventListener('click', openSettingsModal);
saveSettingsBtn.addEventListener('click', saveSettings);
settingsModal.addEventListener('click', e => {
    if (e.target === settingsModal || e.target.classList.contains('modal-close-btn')) {
        settingsModal.style.display = 'none';
    }
});


// ========== Masonry Posts Logic ==========
async function loadPosts() {
    refreshBtn.classList.add('spinning');

    // The API call promise will handle data processing as soon as it resolves.
    const apiCallPromise = apiFetch('/posts')
        .then(data => {
            // This block executes immediately when data is fetched, updating the UI without delay.
            allPosts = data.posts || [];
            postsLoaded = true;
            lastLoadError = '';
            setForumNotice('');
            updateBoardFilter(allPosts);
            updateBoardDatalist(allPosts);
            renderCurrentFilteredPosts({ force: true });
        })
        .catch(error => {
            // Log errors immediately as well.
            console.error('Load posts failed:', error);
            lastLoadError = describeRequestError(error);
            // With nothing to show, the empty state carries the error and a retry;
            // the notice only speaks when a stale list stays on screen.
            if (allPosts.length) setForumNotice(`帖子刷新失败：${lastLoadError}`, 'error');
            else setForumNotice('');
            renderCurrentFilteredPosts({ force: true });
            // We re-throw the error to ensure Promise.all can catch it if needed,
            // but the main goal is immediate logging.
            throw error;
        });

    // The minimum duration promise ensures the animation lasts at least 1 second.
    const minDurationPromise = new Promise(resolve => setTimeout(resolve, 1000));

    // Use Promise.allSettled to wait for both promises to complete (either success or failure)
    // before removing the spinning class. This ensures the animation is visible for at least
    // 1 second, and also waits for a long API call to finish.
    Promise.allSettled([apiCallPromise, minDurationPromise]).finally(() => {
        refreshBtn.classList.remove('spinning');
    });
}

function updateBoardFilter(posts) {
    const currentVal = boardFilter.value;
    const boards = [...new Set(posts.map(p => p.board).filter(Boolean))].sort();
    boardFilter.innerHTML = '<option value="all">全部板块</option>';
    boards.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b;
        boardFilter.appendChild(opt);
    });
    boardFilter.value = currentVal;
    if (boardFilter.value === '') boardFilter.value = 'all';
    renderBoardNav();
}

// ========== Board Navigation ==========
// The hidden #board-filter select stays the filter state; the sidebar list
// mirrors its options and writes back through a change event.
const BOARD_ICON_ALL = '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"></rect><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"></rect><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"></rect><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"></rect>';
const BOARD_ICON = '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"></path>';

function renderBoardNav() {
    if (!boardNav) return;
    const counts = new Map();
    allPosts.forEach(p => { if (p.board) counts.set(p.board, (counts.get(p.board) || 0) + 1); });
    const active = boardFilter.value || 'all';

    boardNav.innerHTML = [...boardFilter.options].map(opt => {
        const value = opt.value;
        const label = value === 'all' ? '全部板块' : value;
        const count = value === 'all' ? allPosts.length : (counts.get(value) || 0);
        const selected = value === active;
        return `
        <button type="button" class="nav-item" role="tab" data-board="${escapeHtml(value)}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" title="${escapeHtml(label)}">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${value === 'all' ? BOARD_ICON_ALL : BOARD_ICON}</svg>
            <span class="nav-label">${escapeHtml(label)}</span>
            <span class="nav-count">${count}</span>
        </button>`;
    }).join('');
}

function selectBoard(value) {
    if (boardFilter.value === value) return;
    boardFilter.value = value;
    boardFilter.dispatchEvent(new Event('change'));
}

function syncBoardNav() {
    const active = boardFilter.value || 'all';
    boardNav?.querySelectorAll('[data-board]').forEach(item => {
        const selected = item.dataset.board === active;
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
    });
    if (forumPageTitle) forumPageTitle.textContent = active === 'all' ? '全部板块' : active;
}

boardNav?.addEventListener('click', e => {
    const item = e.target.closest('[data-board]');
    if (item) selectBoard(item.dataset.board);
});

boardNav?.addEventListener('keydown', e => {
    const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: 'first', End: 'last' };
    if (!(e.key in keys)) return;
    const items = [...boardNav.querySelectorAll('[data-board]')];
    if (!items.length) return;
    const index = items.findIndex(item => item.dataset.board === boardFilter.value);
    const step = keys[e.key];
    const next = step === 'first' ? 0 : step === 'last' ? items.length - 1 : (index + step + items.length) % items.length;
    e.preventDefault();
    selectBoard(items[next].dataset.board);
    items[next].focus();
});

function setForumNotice(message, tone = '') {
    if (!forumNotice) return;
    forumNotice.textContent = message;
    if (tone) forumNotice.dataset.tone = tone;
    else delete forumNotice.dataset.tone;
}

function renderForumSummary(filtered) {
    if (!forumSummary) return;
    if (!postsLoaded) {
        // A failed load is explained in the empty state below, not here as well.
        forumSummary.innerHTML = lastLoadError ? '' : '<span class="intro-item">正在加载…</span>';
        return;
    }
    const boards = new Set(allPosts.map(p => p.board).filter(Boolean)).size;
    const items = [`共 ${allPosts.length} 篇帖子`, `${boards} 个板块`];
    if (boardFilter.value !== 'all' || searchInput.value.trim()) items.push(`显示 ${filtered.length} 篇`);
    forumSummary.innerHTML = items.map(text => `<span class="intro-item">${escapeHtml(text)}</span>`).join('');
}

function updateBoardDatalist(posts) {
    const boardsDatalist = document.getElementById('existing-boards');
    if (!boardsDatalist) return;
    const boards = [...new Set(posts.map(p => p.board).filter(Boolean))].sort();
    boardsDatalist.innerHTML = '';
    boards.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b;
        boardsDatalist.appendChild(opt);
    });
}

function getFilteredPosts() {
    const term = searchInput.value.toLowerCase().trim();
    const board = boardFilter.value;

    return allPosts.filter(p => {
        const matchSearch = !term || p.title.toLowerCase().includes(term) || p.author.toLowerCase().includes(term);
        const matchBoard = board === 'all' || p.board === board;
        return matchSearch && matchBoard;
    });
}

function getSortedPosts(postsToRender) {
    return [...postsToRender].sort((a, b) => {
        if (a.title.includes('[置顶]') && !b.title.includes('[置顶]')) return -1;
        if (!a.title.includes('[置顶]') && b.title.includes('[置顶]')) return 1;
        const dateB = parseForumDate(b.mtime || b.lastReplyAt || b.timestamp) || new Date(0);
        const dateA = parseForumDate(a.mtime || a.lastReplyAt || a.timestamp) || new Date(0);
        return dateB - dateA;
    });
}

function getPostRenderKey(postsToRender) {
    return postsToRender.map(post => `${post.uid}:${post.mtime || post.lastReplyAt || post.timestamp || ''}`).join('|');
}

function renderCurrentFilteredPosts({ force = false } = {}) {
    const filtered = getFilteredPosts();
    const renderKey = getPostRenderKey(filtered);
    syncBoardNav();
    renderForumSummary(filtered);
    // The page title already names the board, so the rows drop their chip.
    masonryContainer.toggleAttribute('data-board-filtered', boardFilter.value !== 'all');

    if (!force && renderKey === lastRenderedPostKeys) {
        return;
    }

    renderWaterfall(filtered);
}

function renderWaterfall(postsToRender) {
    masonryContainer.innerHTML = '';

    if (!postsToRender || postsToRender.length === 0) {
        lastRenderedPostKeys = '';
        if (forumEmpty) {
            // One place says what is wrong and offers the way out.
            if (allPosts.length) {
                forumEmpty.innerHTML = searchInput.value.trim()
                    ? '没有匹配的帖子<span class="inline-sep">·</span><button type="button" class="link-btn" data-empty-action="clear-search">清除搜索</button>'
                    : '没有匹配的帖子';
            } else if (lastLoadError) {
                forumEmpty.innerHTML = `
                    <p class="empty-title">读不到帖子</p>
                    <p class="empty-detail">${escapeHtml(lastLoadError)}</p>
                    <button type="button" class="jelly-btn" data-empty-action="retry">重试</button>`;
            } else {
                forumEmpty.textContent = postsLoaded ? '这里还没有帖子' : '正在加载帖子…';
            }
            forumEmpty.dataset.tone = !allPosts.length && lastLoadError ? 'error' : '';
            forumEmpty.hidden = false;
        }
        return;
    }
    if (forumEmpty) forumEmpty.hidden = true;

    const sorted = getSortedPosts(postsToRender);
    lastRenderedPostKeys = getPostRenderKey(postsToRender);

    const fragment = document.createDocumentFragment();
    sorted.forEach((post, index) => {
        const card = createPostCard(post, index);
        fragment.appendChild(card);
    });

    masonryContainer.appendChild(fragment);
}

function createPostCard(post, index) {
    const el = document.createElement('div');
    el.className = 'post-card';
    // Limit staggered animation to first 20 items to avoid massive delays on large lists
    const delay = index < 20 ? index * 0.05 : 0;
    el.style.animationDelay = `${delay}s`;
    
    // Backend returns lastReplyBy and lastReplyAt
    const displayDate = post.mtime || post.lastReplyAt || post.timestamp;
    const hasReply = post.lastReplyAt && post.timestamp && post.lastReplyAt !== post.timestamp;
    
    // Use lastReplyBy from backend API
    const lastReplier = post.lastReplyBy;
    const hasNewReplier = hasReply && lastReplier && lastReplier !== post.author;

    const avatarHTML = (name) => `<div class="author-avatar loading-avatar" data-tone="${avatarTone(name)}" data-author="${escapeHtml(name)}">${escapeHtml(name.slice(0,1).toUpperCase())}</div>`;

    // One quiet line: author, when it was posted and, if anyone replied, who
    // replied last. The exact time sits in the tooltip.
    const postedAt = hasReply ? post.timestamp : displayDate;
    const metaItems = [
        `<span class="post-meta-item post-author">${escapeHtml(post.author)}</span>`,
        `<span class="post-meta-item" title="${escapeHtml(formatFullDate(postedAt))}">发帖于 ${formatDate(postedAt)}</span>`
    ];
    if (hasReply) {
        const replier = hasNewReplier ? `${escapeHtml(lastReplier)} ` : '';
        metaItems.push(`<span class="post-meta-item" title="${escapeHtml(formatFullDate(displayDate))}">${replier}最后回复于 ${formatDate(displayDate)}</span>`);
    }

    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.innerHTML = `
        <div class="post-card-header">
            ${avatarHTML(post.author)}
            <div class="post-card-copy">
                <div class="post-title-row">
                    <h3 class="post-title">${escapeHtml(post.title)}</h3>
                    ${post.board ? `<span class="post-badge">${escapeHtml(post.board)}</span>` : ''}
                </div>
                <div class="post-meta">${metaItems.join('')}</div>
            </div>
        </div>
        <div class="post-preview">点击展开查看详情...</div>
    `;

    el.addEventListener('click', (e) => expandPost(post, el));
    el.addEventListener('keydown', (e) => {
        if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            expandPost(post, el);
        }
    });
    
    // Async load avatar(s)
    const avatars = el.querySelectorAll('.author-avatar');
    if (avatars.length > 0) {
        requestDeferredWork(() => {
            avatars.forEach(avatarEl => {
                loadAvatarForElement(avatarEl, avatarEl.dataset.author);
            });
        });
    }
    
    return el;
}

// Letter avatars pick one of the theme tones in forum.css by name, so the
// same person keeps the same colour in both themes.
const AVATAR_TONES = 6;

function avatarTone(name) {
    return String(name || '').split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % AVATAR_TONES;
}

async function loadAvatarForElement(avatarEl, username) {
    if (!avatarEl) return;
    
    const avatarPath = await getAvatarForUser(username);
    if (avatarPath) {
        avatarEl.style.backgroundImage = `url("${avatarPath}")`;
        avatarEl.style.backgroundSize = 'cover';
        avatarEl.style.backgroundPosition = 'center';
        avatarEl.textContent = ''; // Remove initial letter
        avatarEl.classList.remove('loading-avatar');
        avatarEl.classList.add('has-avatar');
    }
}

// ========== Jelly Expansion ==========
async function expandPost(post, originalCard) {
    document.body.style.overflow = 'hidden';
    activePostOverlay.classList.add('active');
    activePostOverlay.scrollTop = 0; // Reset scroll position

    const rect = originalCard.getBoundingClientRect();
    const expanded = originalCard.cloneNode(true);
    expanded.className = 'post-card expanded-card';
    expanded.removeAttribute('role');
    expanded.removeAttribute('tabindex');
    expanded.style.position = 'fixed';
    expanded.style.top = `${rect.top}px`;
    expanded.style.left = `${rect.left}px`;
    expanded.style.width = `${rect.width}px`;
    expanded.style.height = `${rect.height}px`;
    expanded.style.margin = '0';
    expanded.style.zIndex = '2001';
    expanded.style.transition = 'opacity 160ms ease, transform 160ms ease';

    activePostOverlay.innerHTML = '';
    activePostOverlay.appendChild(expanded);
    postPinnedToBottom = false;
    postSizeObserver.observe(expanded);

    expanded.offsetHeight; // Force reflow
    
    // Animate to center with auto height
    expanded.style.position = 'relative';
    expanded.style.top = 'auto';
    expanded.style.left = 'auto';
    expanded.style.width = '100%';
    expanded.style.maxWidth = '808px';
    expanded.style.height = 'auto';
    expanded.style.margin = '0 auto';
    expanded.style.cursor = 'default';

    // Header tools: the post menu joins once the body has loaded.
    const headActions = document.createElement('div');
    headActions.className = 'post-head-actions';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'nav-icon-btn expanded-close-btn';
    closeBtn.title = '返回列表';
    closeBtn.setAttribute('aria-label', '返回列表');
    closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
    closeBtn.onclick = closeExpandedPost;
    headActions.appendChild(closeBtn);
    expanded.querySelector('.post-card-header').appendChild(headActions);

    try {
        const previewEl = expanded.querySelector('.post-preview');
        previewEl.innerHTML = '<div class="post-loading">正在加载正文…</div>';
        previewEl.style.maskImage = 'none';
        previewEl.style.maxHeight = 'none';
        previewEl.style.fontStyle = 'normal'; // <-- 修正：移除内联斜体
        previewEl.style.opacity = '1';       // <-- 修正：恢复不透明度

        const data = await apiFetch(`/post/${post.uid}`);
        renderFullContent(expanded, data.content, post.uid);
    } catch (error) {
        expanded.querySelector('.post-preview').innerHTML = `<div class="post-loading" data-tone="error">正文加载失败：${escapeHtml(describeRequestError(error))}</div>`;
    }
}

function closeExpandedPost() {
    const expanded = activePostOverlay.querySelector('.expanded-card');
    if (expanded) {
        activePostOverlay.classList.remove('active');
        expanded.style.opacity = '0';
        expanded.style.transform = 'translateY(6px)';
    }
    if (expanded) postSizeObserver.unobserve(expanded);
    setTimeout(() => {
        activePostOverlay.innerHTML = '';
        document.body.style.overflow = '';
    }, 300);
}

activePostOverlay.addEventListener('click', (e) => {
    if (e.target === activePostOverlay) closeExpandedPost();
});

// The composer is sticky, so when the view or the composer changes height
// after the reader reached the end, the last comment would slide under it.
// Stay at the end instead.
let postPinnedToBottom = false;
activePostOverlay.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = activePostOverlay;
    postPinnedToBottom = scrollHeight > clientHeight + 1 && scrollHeight - scrollTop - clientHeight < 2;
}, { passive: true });
const postSizeObserver = new ResizeObserver(() => {
    if (postPinnedToBottom) activePostOverlay.scrollTop = activePostOverlay.scrollHeight;
});
postSizeObserver.observe(activePostOverlay);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePostOverlay.classList.contains('active')) {
        const openMenu = activePostOverlay.querySelector('.post-menu:not([hidden])');
        const activeEditingArea = activePostOverlay.querySelector('.edit-textarea');
        if (openMenu) {
            closePostMenu(openMenu, { focusButton: true });
        } else if (activeEditingArea) {
            // If in edit mode, find the corresponding cancel button and trigger it
            const cancelButton = activeEditingArea.parentElement.querySelector('.cancel-edit-btn');
            if (cancelButton) {
                cancelButton.click();
            }
        } else {
            // Otherwise, close the post
            closeExpandedPost();
        }
    }
});

// ===== Ported from text-viewer.js for advanced CSS/HTML rendering =====

function generateUniqueId() {
    const timestampPart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).substring(2, 9);
    return `vcp-forum-${timestampPart}${randomPart}`;
}

function scopeSelector(selector, scopeId) {
    if (selector.match(/^(@|from|to|\d+%|:root|html|body)/)) {
        return selector;
    }
    if (selector.match(/^::?[\w-]+$/)) {
        return `#${scopeId}${selector}`;
    }
    return `#${scopeId} ${selector}`;
}

function scopeCss(cssString, scopeId) {
    let css = cssString.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    let depth = 0;
    let currentRule = '';
    for (let i = 0; i < css.length; i++) {
        const char = css[i];
        currentRule += char;
        if (char === '{') depth++;
        else if (char === '}') {
            depth--;
            if (depth === 0) {
                rules.push(currentRule.trim());
                currentRule = '';
            }
        }
    }
    return rules.map(rule => {
        const match = rule.match(/^([^{]+)\{(.+)\}$/s);
        if (!match) return rule;
        const [, selectors, body] = match;
        const scopedSelectors = selectors.split(',').map(s => scopeSelector(s.trim(), scopeId)).join(', ');
        return `${scopedSelectors} { ${body} }`;
    }).join('\n');
}

function processAndInjectScopedCss(content, scopeId) {
    let cssContent = '';
    let styleInjected = false;
    const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

    const processedContent = content.replace(styleRegex, (match, css) => {
        cssContent += css.trim() + '\n';
        return ''; // Remove style tag from content
    });

    if (cssContent.length > 0) {
        try {
            const scopedCss = scopeCss(cssContent, scopeId);
            const styleElement = document.createElement('style');
            styleElement.type = 'text/css';
            styleElement.setAttribute('data-vcp-forum-scope', scopeId);
            styleElement.textContent = scopedCss;
            document.head.appendChild(styleElement);
            styleInjected = true;
        } catch (error) {
            console.error(`[Forum] Failed to scope CSS for ID: ${scopeId}`, error);
        }
    }
    return { processedContent, styleInjected };
}

function deIndentHtml(text) {
    const lines = text.split('\n');
    let inFence = false;
    
    return lines.map(line => {
        // Check for code fences
        if (line.trim().startsWith('```')) {
            inFence = !inFence;
            return line;
        }
        
        // Don't process lines inside code fences (keep original indentation for code)
        if (inFence) {
            return line;
        }
        
        // 🔥 关键修复：去除所有行的前导空格，防止被Markdown识别为缩进代码块
        // 只有在代码围栏内才保留缩进
        return line.trimStart();
    }).join('\n');
}

function findUnescapedDelimiter(text, delimiter, startIndex) {
    let index = startIndex;
    while (index < text.length) {
        const found = text.indexOf(delimiter, index);
        if (found === -1) return -1;

        let backslashCount = 0;
        for (let i = found - 1; i >= 0 && text[i] === '\\'; i--) {
            backslashCount++;
        }

        if (backslashCount % 2 === 0) {
            return found;
        }

        index = found + delimiter.length;
    }

    return -1;
}

function looksLikeSafeForumSingleDollarMath(content) {
    const trimmed = (content || '').trim();
    if (!trimmed || trimmed.includes('\n') || trimmed.length > 1200) return false;

    const hasExplicitMathSignal = /\\|[\^_=+\-*/<>]|[A-Za-z]\s*\(|\b(?:lim|sum|int|frac|sqrt|text|mathrm|mathbf|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty)\b/i.test(trimmed);
    const isSimpleNumericMath = /^[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:%|\\%|‰|°))?$/.test(trimmed);

    // 排除价格串、Shell 变量、模板字符串、表格跨列和普通单词。
    // 以数字开头的长句即使中间出现减号，也不能因此被判定为数学。
    if (/^\d/.test(trimmed) && !isSimpleNumericMath) {
        const isCompactNumericFormula = !/\s+[A-Za-z\u4e00-\u9fff]{2,}/u.test(trimmed) && hasExplicitMathSignal;
        if (!isCompactNumericFormula) return false;
    }
    if (trimmed.startsWith('/') || trimmed.includes('|')) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return false;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return false;

    return hasExplicitMathSignal || isSimpleNumericMath;
}

function protectMathExpressions(markdown) {
    const mathMap = new Map();
    let mathId = 0;

    const protect = (mathText) => {
        const placeholder = `@@FORUMMATH${mathId}@@`;
        mathMap.set(placeholder, mathText);
        mathId++;
        return placeholder;
    };

    const protectMathInTextSegment = (source) => {
        let output = '';
        let i = 0;

        while (i < source.length) {
            if (source.startsWith('$$', i)) {
                const end = findUnescapedDelimiter(source, '$$', i + 2);
                if (end !== -1) {
                    output += protect(source.slice(i, end + 2));
                    i = end + 2;
                    continue;
                }
            }

            if (source.startsWith('\\[', i)) {
                const end = findUnescapedDelimiter(source, '\\]', i + 2);
                if (end !== -1) {
                    output += protect(source.slice(i, end + 2));
                    i = end + 2;
                    continue;
                }
            }

            if (source.startsWith('\\(', i)) {
                const end = findUnescapedDelimiter(source, '\\)', i + 2);
                if (end !== -1) {
                    output += protect(source.slice(i, end + 2));
                    i = end + 2;
                    continue;
                }
            }

            if (source[i] === '$' && source[i + 1] !== '$') {
                const previousChar = source[i - 1] || '';
                const nextChar = source[i + 1] || '';

                if (previousChar !== '\\' && !/\w/.test(previousChar) && nextChar && !/\s/.test(nextChar)) {
                    let end = i + 1;
                    while ((end = findUnescapedDelimiter(source, '$', end)) !== -1) {
                        const nextCloseChar = source[end + 1] || '';
                        if (!/\w/.test(nextCloseChar)) break;
                        end++;
                    }

                    if (end !== -1) {
                        const content = source.slice(i + 1, end);
                        if (looksLikeSafeForumSingleDollarMath(content)) {
                            // 统一转换成明确的 KaTeX 行内定界符，后处理无需再启用宽松 `$...$`。
                            output += protect(`\\(${content.trim()}\\)`);
                            i = end + 1;
                            continue;
                        }
                    }
                }
            }

            output += source[i];
            i++;
        }

        return output;
    };

    // 先保护代码围栏，再按 HTML 标签切分。数学定界符只能在同一文本片段内闭合，
    // 不扫描标签属性，也不会把不同元素中的两个价格跨标签拼成公式。
    const protectedCodeBlocks = [];
    const withoutCodeBlocks = markdown.replace(/```[\s\S]*?(?:```|$)/g, (block) => {
        const placeholder = `@@FORUMCODE${protectedCodeBlocks.length}@@`;
        protectedCodeBlocks.push(block);
        return placeholder;
    });
    const htmlTagRegex = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'"<>])*)?\s*\/?>/g;
    let output = '';
    let cursor = 0;
    let tagMatch;

    while ((tagMatch = htmlTagRegex.exec(withoutCodeBlocks)) !== null) {
        output += protectMathInTextSegment(withoutCodeBlocks.slice(cursor, tagMatch.index));
        output += tagMatch[0];
        cursor = tagMatch.index + tagMatch[0].length;
    }
    output += protectMathInTextSegment(withoutCodeBlocks.slice(cursor));

    protectedCodeBlocks.forEach((block, index) => {
        output = output.split(`@@FORUMCODE${index}@@`).join(block);
    });

    return { markdown: output, mathMap };
}

function restoreProtectedMath(html, mathMap) {
    if (!mathMap || mathMap.size === 0) return html;

    let restored = html;
    for (const [placeholder, mathText] of mathMap.entries()) {
        restored = restored.replaceAll(placeholder, escapeHtml(mathText));
    }
    return restored;
}

function renderMarkdownWithProtectedMath(markdown) {
    if (!window.marked) {
        return `<pre>${escapeHtml(markdown)}</pre>`;
    }

    const protectedMath = protectMathExpressions(markdown);
    const enhanced = enhanceMarkdown(protectedMath.markdown);
    const html = marked.parse(enhanced);
    return restoreProtectedMath(html, protectedMath.mathMap);
}

function enhanceMarkdown(markdown) {
    // Step 1: Fix local file path images
    markdown = markdown.replace(/(!\[[^\]]*?\]\()(file:\/\/.*?)(\))/g, (match, prefix, url, suffix) => {
        return prefix + url.replace(/\\/g, '/') + suffix;
    });

    // Step 2: Protect code blocks before de-indenting (like text-viewer.js)
    const codeBlockMap = new Map();
    let placeholderId = 0;
    
    let processed = markdown.replace(/```\w*([\s\S]*?)```/g, (match) => {
        const placeholder = `__FORUM_CODE_BLOCK_PLACEHOLDER_${placeholderId}__`;
        codeBlockMap.set(placeholder, match);
        placeholderId++;
        return placeholder;
    });

    // Step 3: De-indent HTML AND CSS to prevent code block interpretation
    // Now code blocks are protected, so CSS won't be affected
    processed = deIndentHtml(processed);

    // Step 4: Detect if content contains block-level HTML
    const hasBlockHtml = /<div[\s>]|<style[\s>]/i.test(processed);
    
    if (hasBlockHtml) {
        // Restore code blocks before returning
        if (codeBlockMap.size > 0) {
            for (const [placeholder, block] of codeBlockMap.entries()) {
                processed = processed.replace(placeholder, block);
            }
        }
        // For HTML-heavy content, skip text enhancement
        return processed;
    }

    // Step 5: For regular markdown, apply text enhancements
    // Protect HTML tags during processing
    const htmlTags = [];
    const htmlTagRegexGlobal = /<[^>]+>/g;

    processed = processed.replace(htmlTagRegexGlobal, (match) => {
        htmlTags.push(match);
        return `__HTML_PLACEHOLDER_${htmlTags.length - 1}__`;
    });

    // Wrap quoted text in spans for highlighting
    processed = processed.replace(/([""][^"]+?[""]|"[^"]+")/g, '<span class="highlighted-quote">$1</span>');

    // Fix bolding for quoted text
    processed = processed.replace(/\*\*(<span class="highlighted-quote">.+?<\/span>)\*\*/g, '<strong>$1</strong>');
    processed = processed.replace(/\*\*([""][^"]+?[""]|"[^"]+")\*\*/g, '<strong>$1</strong>');

    // Restore HTML tags
    if (htmlTags.length > 0) {
        processed = processed.replace(/__HTML_PLACEHOLDER_(\d+)__/g, (match, index) => {
            return htmlTags[parseInt(index, 10)] || match;
        });
    }

    // Step 6: Restore code blocks
    if (codeBlockMap.size > 0) {
        for (const [placeholder, block] of codeBlockMap.entries()) {
            processed = processed.replace(placeholder, block);
        }
    }

    return processed;
}

function applyBoldFormatting(container) {
    const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        { acceptNode: (node) => {
            // Reject processing inside these elements
            if (node.parentElement.closest('pre, code, script, style, .vcp-tool-use-bubble, .vcp-tool-result-bubble, a')) {
                return NodeFilter.FILTER_REJECT;
            }
            // Only accept text nodes containing "**"
            if (/\*\*/.test(node.nodeValue)) {
                return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
        }},
        false
    );

    const nodesToProcess = [];
    // TreeWalker changes dynamically, so collect all nodes first
    while (walker.nextNode()) {
        nodesToProcess.push(walker.currentNode);
    }

    nodesToProcess.forEach(node => {
        const parent = node.parentElement;
        if (!parent) return;

        const fragment = document.createDocumentFragment();
        // Split text using regex, preserving delimiters
        const parts = node.nodeValue.split(/(\*\*.*?\*\*)/g);

        parts.forEach(part => {
            if (part.startsWith('**') && part.endsWith('**')) {
                const strong = document.createElement('strong');
                strong.textContent = part.slice(2, -2);
                fragment.appendChild(strong);
            } else if (part) { // Avoid adding empty text nodes
                fragment.appendChild(document.createTextNode(part));
            }
        });
        // Replace old text node with new document fragment
        parent.replaceChild(fragment, node);
    });
}

// ===== End ported functions =====

const ICON_EDIT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
const ICON_TRASH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"></path></svg>';
const ICON_COPY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path></svg>';
const ICON_MORE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>';

// ========== Post menu ==========
// Edit, copy ID and delete share one … menu in the post header, ahead of
// the close button. It is rebuilt on every render because edits and replies
// re-render the whole post.
function renderPostMenu(card, previewEl, uid, postUid) {
    const headActions = card.querySelector('.post-head-actions');
    if (!headActions) return;
    headActions.querySelector('.post-menu-wrap')?.remove();

    const wrap = document.createElement('div');
    wrap.className = 'post-menu-wrap';
    wrap.innerHTML = `
        <button type="button" class="nav-icon-btn post-menu-btn" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${ICON_MORE}</button>
        <div class="post-menu" role="menu" aria-label="帖子操作" hidden>
            <button type="button" class="menu-item edit-btn" role="menuitem">${ICON_EDIT}<span>编辑正文</span></button>
            <button type="button" class="menu-item copy-uid-btn" role="menuitem" title="${escapeHtml(postUid)}">${ICON_COPY}<span>复制帖子 ID</span></button>
            <div class="menu-separator" role="separator"></div>
            <button type="button" class="menu-item menu-item-danger delete-post-btn" role="menuitem">${ICON_TRASH}<span>删除帖子</span></button>
        </div>
    `;
    headActions.insertBefore(wrap, headActions.firstChild);

    const menuBtn = wrap.querySelector('.post-menu-btn');
    const menu = wrap.querySelector('.post-menu');
    menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (menu.hidden) openPostMenu(menu);
        else closePostMenu(menu);
    });
    menu.addEventListener('keydown', e => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...menu.querySelectorAll('.menu-item')];
        const index = items.indexOf(document.activeElement);
        const next = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
    });
    menu.querySelector('.edit-btn').addEventListener('click', () => {
        closePostMenu(menu);
        toggleEditMode(card, previewEl, uid);
    });
    menu.querySelector('.copy-uid-btn').addEventListener('click', async (e) => {
        const label = e.currentTarget.querySelector('span');
        try {
            await navigator.clipboard.writeText(postUid);
            // Confirm in place, then fold the menu away.
            label.textContent = '已复制';
            setTimeout(() => {
                label.textContent = '复制帖子 ID';
                if (!menu.hidden) closePostMenu(menu, { focusButton: true });
            }, 900);
        } catch (error) {
            closePostMenu(menu, { focusButton: true });
            await customAlert(`帖子 ID：${postUid}`, '复制失败');
        }
    });
    menu.querySelector('.delete-post-btn').addEventListener('click', () => {
        closePostMenu(menu);
        handleDeletePost(uid);
    });
}

function openPostMenu(menu) {
    menu.hidden = false;
    menu.parentElement.querySelector('.post-menu-btn').setAttribute('aria-expanded', 'true');
    menu.querySelector('.menu-item')?.focus();
}

function closePostMenu(menu, { focusButton = false } = {}) {
    const menuBtn = menu.parentElement.querySelector('.post-menu-btn');
    menu.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    if (focusButton) menuBtn.focus();
}

document.addEventListener('click', e => {
    activePostOverlay.querySelectorAll('.post-menu:not([hidden])').forEach(menu => {
        if (!menu.parentElement.contains(e.target)) closePostMenu(menu);
    });
});

// ========== Composer identity ==========
// Replies are signed with the name from settings. The footer line says which
// name that is, or, when none is set, links straight to settings.
function updateComposerIdentity(root) {
    const identity = root?.querySelector('#quick-reply-identity');
    if (!identity) return;
    const name = forumConfig.replyUsername || forumConfig.username || '';
    root.querySelector('#quick-reply-name').value = name;
    root.querySelector('#quick-reply-btn').disabled = !name;
    identity.dataset.state = name ? 'named' : 'missing';
    identity.innerHTML = name
        ? `以 <strong>${escapeHtml(name)}</strong> 的身份回复<span class="inline-sep">·</span><button type="button" class="link-btn">更改</button>`
        : `还没有设置回帖署名，<button type="button" class="link-btn">去设置</button>`;
}

function renderFullContent(container, markdown, uid) {
    const previewEl = container.querySelector('.post-preview');
    
    // Generate unique scope ID for CSS isolation (like text-viewer.js)
    const scopeId = generateUniqueId();
    previewEl.id = scopeId;
    
    // === 关键修复：使用完整预处理流程（像 text-viewer.js） ===
    const codeBlockMap = new Map();
    let placeholderId = 0;
    
    // Step 1: 保护所有代码块（包括CSS代码块）
    let processed = markdown.replace(/```\w*([\s\S]*?)```/g, (match) => {
        const placeholder = `__FORUM_RENDER_CODE_BLOCK_${placeholderId}__`;
        codeBlockMap.set(placeholder, match);
        placeholderId++;
        return placeholder;
    });
    
    // Step 2: 提取和处理CSS（代码块已被保护）
    const { processedContent: contentWithoutStyles } = processAndInjectScopedCss(processed, scopeId);
    processed = contentWithoutStyles;
    
    // Step 3: 恢复代码块
    if (codeBlockMap.size > 0) {
        for (const [placeholder, block] of codeBlockMap.entries()) {
            processed = processed.replace(placeholder, block);
        }
    }
    // === 预处理完成 ===
    
    const replyDelimiter = '\n\n---\n\n## 评论区\n---';
    const parts = processed.split(replyDelimiter);
    let mainMd = parts[0];
    const repliesMd = parts[1] || '';

    // The meta block (author, UID, timestamp) repeats the header, so it is
    // stripped; the UID stays reachable through the post menu.
    const uidMatch = markdown.match(/\*\*UID[:：]\*\*\s*(.*)/);
    const postUid = uidMatch ? uidMatch[1].trim() : String(uid);
    const postContentMd = mainMd.replace(/^(.|\n)*?---\n?/, '');

    previewEl.innerHTML = renderMarkdownWithProtectedMath(postContentMd);
    previewEl.dataset.rawContent = postContentMd; // Store raw content for editing

    requestDeferredWork(() => {
        applyBoldFormatting(previewEl);

        if (window.renderMathInElement) {
            renderMathInElement(previewEl, {
                throwOnError: false,
                delimiters: [
                    {left: "$$", right: "$$", display: true},
                    // 安全的单美元公式已转换为 \(...\)；禁止 KaTeX 绕过判断器跨价格配对。
                    {left: "\\(", right: "\\)", display: false},
                    {left: "\\[", right: "\\]", display: true}
                ],
                ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
            });
        }

        setupEmoticonFixer(previewEl);
        setupImageViewer(previewEl);
    });

    renderPostMenu(container, previewEl, uid, postUid);


    if (repliesMd.trim()) {
        const replyList = document.createElement('div');
        replyList.className = 'reply-list';
        replyList.innerHTML = '<div class="group-header"><h2>评论</h2><span class="reply-count"></span></div><div class="reply-rows"></div>';
        const replyRows = replyList.querySelector('.reply-rows');
        
        // 修复：正确解析楼层，使用 '---\n### 楼层' 作为分隔标记
        // 先移除开头的 '---' 分隔符（如果存在）
        let cleanedReplies = repliesMd.trim();
        if (cleanedReplies.startsWith('---')) {
            cleanedReplies = cleanedReplies.substring(3).trim();
        }
        
        // 使用正则表达式分割楼层：匹配 '---' 后面跟着换行和 '### 楼层'
        const floorSplitRegex = /\n---\n(?=### 楼层)/;
        const floors = cleanedReplies.split(floorSplitRegex).filter(r => r.trim());
        
        floors.forEach((replyMd, i) => {
            if (!replyMd.trim()) return;
            const floor = i + 1;
            
            // Extract username from reply markdown
            let replyUsername = '';
            const replyerMatch = replyMd.match(/\*\*回复者[：:]\*\*\s*([^\s\n*]+)/);
            if (replyerMatch) {
                replyUsername = replyerMatch[1];
            } else {
                const boldMatch = replyMd.match(/\*\*([^*]+)\*\*/);
                if (boldMatch && !boldMatch[1].includes('回复者') && !boldMatch[1].includes('时间')) {
                    replyUsername = boldMatch[1];
                }
            }
            
            const replyItem = document.createElement('div');
            replyItem.className = 'reply-item';

            const metadataEndIndex = replyMd.indexOf('\n\n');
            const replyRawContent = metadataEndIndex !== -1 ? replyMd.substring(metadataEndIndex + 2) : replyMd;

            // The floor heading and the 回复者/时间 lines move into the row
            // header. A head that holds anything else renders as before.
            const replyHead = metadataEndIndex !== -1 ? replyMd.substring(0, metadataEndIndex) : '';
            const headIsMeta = replyHead.trim() !== '' && replyHead.split('\n')
                .filter(line => line.trim())
                .every(line => /^(###\s|\*\*[^*]+[:：]\*\*)/.test(line.trim()));
            const replyBodyMd = headIsMeta ? replyRawContent.trim() : replyMd.trim();
            const replyTimeMatch = headIsMeta ? replyHead.match(/\*\*时间[:：]\*\*\s*(.+)/) : null;
            const replyTime = replyTimeMatch ? replyTimeMatch[1].trim() : '';

            replyItem.innerHTML = `
                <div class="reply-header">
                    <div class="reply-who">
                        <div class="reply-avatar loading-avatar" data-tone="${avatarTone(replyUsername)}" data-author="${escapeHtml(replyUsername)}">${replyUsername ? escapeHtml(replyUsername.slice(0,1).toUpperCase()) : '#'}</div>
                        ${replyUsername ? `<span class="reply-name">${escapeHtml(replyUsername)}</span>` : ''}
                        ${replyTime ? `<span class="reply-time" title="${escapeHtml(formatFullDate(replyTime))}">${escapeHtml(formatDate(replyTime))}</span>` : ''}
                    </div>
                    <div class="reply-actions">
                        <span class="reply-floor">#${floor}</span>
                        <button type="button" class="nav-icon-btn edit-btn" data-uid="${uid}" data-floor="${floor}" title="编辑 #${floor}" aria-label="编辑第 ${floor} 楼">${ICON_EDIT}</button>
                        <button type="button" class="nav-icon-btn delete-floor-btn" data-uid="${uid}" data-floor="${floor}" title="删除 #${floor}" aria-label="删除第 ${floor} 楼">${ICON_TRASH}</button>
                    </div>
                </div>
                <div class="reply-content">${renderMarkdownWithProtectedMath(replyBodyMd)}</div>
            `;
            replyItem.querySelector('.reply-content').dataset.rawContent = replyRawContent; // Store raw content
            replyRows.appendChild(replyItem);
            
            // Load avatar for reply
            if (replyUsername) {
                const avatarEl = replyItem.querySelector('.reply-avatar');
                loadAvatarForElement(avatarEl, replyUsername);
            }
            
            // Setup emoticon fixer and bold formatting for reply content
            const replyContentEl = replyItem.querySelector('.reply-content');
            if (replyContentEl) {
                requestDeferredWork(() => {
                    applyBoldFormatting(replyContentEl);
                    setupEmoticonFixer(replyContentEl);
                    setupImageViewer(replyContentEl);

                    if (window.renderMathInElement) {
                        renderMathInElement(replyContentEl, {
                            throwOnError: false,
                            delimiters: [
                                {left: "$$", right: "$$", display: true},
                                // 与帖子正文保持一致，不允许宽松单美元匹配破坏回复中的 HTML。
                                {left: "\\(", right: "\\)", display: false},
                                {left: "\\[", right: "\\]", display: true}
                            ],
                            ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
                        });
                    }
                });
            }
            
            // Add event listeners for action buttons
            replyItem.querySelector('.delete-floor-btn').addEventListener('click', (e) => handleDeleteFloor(uid, floor, container));
            replyItem.querySelector('.edit-btn').addEventListener('click', (e) => toggleEditMode(e.currentTarget.closest('.expanded-card'), replyContentEl, uid, floor));
        });
        replyList.querySelector('.reply-count').textContent = `${replyRows.children.length} 条`;
        container.appendChild(replyList);
    }

    // Composer: one card with the text, then a footer line that says who the
    // reply is signed as (the name comes from settings) and the send tools.
    const replyBox = document.createElement('div');
    replyBox.className = 'reply-area-fixed';
    replyBox.innerHTML = `
        <div class="composer">
            <input type="hidden" id="quick-reply-name">
            <textarea id="quick-reply-text" class="composer-input" rows="2" placeholder="写下你的评论…" aria-label="评论内容"></textarea>
            <p class="composer-error" id="quick-reply-error" role="alert" hidden></p>
            <div class="composer-footer">
                <p class="composer-identity" id="quick-reply-identity"></p>
                <div class="composer-tools">
                    <span class="composer-hint">Ctrl+Enter 发送</span>
                    <button type="button" class="nav-icon-btn" id="reply-emoticon-btn" title="表情" aria-label="插入表情"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><path d="M9 9h.01M15 9h.01"></path></svg></button>
                    <button type="button" id="quick-reply-btn" class="jelly-btn jelly-btn-primary">发送</button>
                </div>
            </div>
        </div>
    `;
    container.appendChild(replyBox);
    const textInput = container.querySelector('#quick-reply-text');
    updateComposerIdentity(container);
    container.querySelector('#quick-reply-identity').addEventListener('click', e => {
        if (e.target.closest('.link-btn')) openSettingsModal();
    });

    // Add emoticon button listener for reply box
    const replyEmoticonBtn = container.querySelector('#reply-emoticon-btn');
    if (replyEmoticonBtn) {
        replyEmoticonBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.emoticonManager.togglePanel(replyEmoticonBtn, textInput);
        });
    }

    const quickReplyHandler = () => handleQuickReply(uid, container);
    container.querySelector('#quick-reply-btn').addEventListener('click', quickReplyHandler);
    textInput.addEventListener('input', () => setComposerError(container, ''));
    textInput.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault(); // 防止在文本框中插入换行符
            quickReplyHandler();
        }
    });
}

// ========== Edit, Delete, Reply Logic ==========

function toggleEditMode(card, contentEl, uid, floor = null) {
    const isEditing = contentEl.querySelector('.edit-textarea');
    if (isEditing) return; // Already in edit mode

    const rawContent = contentEl.dataset.rawContent || '';
    const originalHtml = contentEl.innerHTML;

    contentEl.innerHTML = `
        <textarea class="edit-textarea">${escapeHtml(rawContent)}</textarea>
        <div class="edit-controls">
            <button class="jelly-btn cancel-edit-btn">取消</button>
            <button class="jelly-btn jelly-btn-primary save-edit-btn">保存</button>
        </div>
    `;

    // The edit buttons live in the post menu and the row header, outside the
    // content, so restoring the HTML is all a cancel needs.
    contentEl.querySelector('.cancel-edit-btn').addEventListener('click', () => {
        contentEl.innerHTML = originalHtml;
    });
    contentEl.querySelector('.edit-textarea').focus();

    contentEl.querySelector('.save-edit-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.textContent = '保存中...';
        btn.disabled = true;
        const newContent = contentEl.querySelector('.edit-textarea').value;
        await handleSaveEdit(uid, newContent, floor, card);
    });
}

async function handleSaveEdit(uid, content, floor, card) {
    try {
        const payload = { content };
        if (floor) {
            payload.floor = floor;
        }
        await apiFetch(`/post/${uid}`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
        });
        
        // Reload the entire post content to reflect changes
        const data = await apiFetch(`/post/${uid}`);
        card.querySelectorAll('.reply-list, .reply-area-fixed').forEach(e => e.remove());
        renderFullContent(card, data.content, uid);
        await customAlert('内容已成功更新', '编辑成功');

    } catch (error) {
        await customAlert('保存失败: ' + error.message, '编辑失败');
        // Re-enable button on failure
        const btn = card.querySelector('.save-edit-btn');
        if (btn) {
            btn.textContent = '保存';
            btn.disabled = false;
        }
    }
}


async function handleDeletePost(uid) {
    const confirmed = await customConfirm('您确定要删除整个帖子吗？此操作无法撤销！', '删除帖子');
    if (!confirmed) return;
    
    try {
        await apiFetch(`/post/${uid}`, {
            method: 'DELETE',
            body: JSON.stringify({})
        });
        closeExpandedPost();
        loadPosts(); // Refresh the post list
        await customAlert('帖子已成功删除', '删除成功');
    } catch (error) {
        await customAlert('删除失败: ' + error.message, '删除失败');
    }
}

async function handleDeleteFloor(uid, floor, container) {
    const confirmed = await customConfirm(`您确定要删除第 ${floor} 楼吗？此操作无法撤销！`, '删除楼层');
    if (!confirmed) return;
    
    try {
        await apiFetch(`/post/${uid}`, {
            method: 'DELETE',
            body: JSON.stringify({ floor })
        });
        // Reload the post content
        const data = await apiFetch(`/post/${uid}`);
        container.querySelectorAll('.reply-list, .reply-area-fixed').forEach(e => e.remove());
        renderFullContent(container, data.content, uid);
        await customAlert('楼层已成功删除', '删除成功');
    } catch (error) {
        await customAlert('删除失败: ' + error.message, '删除失败');
    }
}

async function handleQuickReply(uid, container) {
    const nameInput = container.querySelector('#quick-reply-name');
    const textInput = container.querySelector('#quick-reply-text');
    const btn = container.querySelector('#quick-reply-btn');

    if (!nameInput.value.trim()) return; // The identity line already links to settings.
    if (!textInput.value.trim()) {
        textInput.placeholder = '先写点内容再发送';
        textInput.focus();
        return;
    }
    setComposerError(container, '');
    btn.disabled = true;
    btn.textContent = '...';
    try {
        await apiFetch(`/reply/${uid}`, {
            method: 'POST',
            body: JSON.stringify({ maid: nameInput.value.trim(), content: textInput.value.trim() })
        });
        const data = await apiFetch(`/post/${uid}`);
        container.querySelectorAll('.reply-list, .reply-area-fixed').forEach(e => e.remove());
        renderFullContent(container, data.content, uid);
    } catch (error) {
        // The draft stays in the box so the reply can be sent again.
        setComposerError(container, `回复没有发出去：${describeRequestError(error)}`);
        btn.disabled = false;
        btn.textContent = '发送';
    }
}

function setComposerError(container, message) {
    const errorEl = container.querySelector('#quick-reply-error');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
    errorEl.closest('.composer')?.toggleAttribute('data-error', Boolean(message));
}

function applyFilters() {
    renderCurrentFilteredPosts({ force: true });
}

searchInput.addEventListener('input', debounce(() => applyFilters(), 120));
boardFilter.addEventListener('change', applyFilters);
refreshBtn.addEventListener('click', loadPosts);
forumEmpty?.addEventListener('click', e => {
    const action = e.target.closest('[data-empty-action]')?.dataset.emptyAction;
    if (action === 'retry') {
        loadPosts();
    } else if (action === 'clear-search') {
        searchInput.value = '';
        applyFilters();
        searchInput.focus();
    }
});

createPostBtn.addEventListener('click', () => {
    const authorInput = document.getElementById('post-author-input');
    if (authorInput) {
        // Pre-fill author name from settings, prioritizing reply name
        authorInput.value = forumConfig.replyUsername || forumConfig.username || '';
    }
    createPostModal.style.display = 'flex';
});

// Bound once: binding on every open stacked listeners, so the panel toggled
// open and shut again on the second open.
const createPostEmoticonBtn = document.getElementById('create-post-emoticon-btn');
const postContentInput = document.getElementById('post-content-input');
if (createPostEmoticonBtn && postContentInput) {
    createPostEmoticonBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.emoticonManager.togglePanel(createPostEmoticonBtn, postContentInput);
    });
}
document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.target.closest('.modal').style.display = 'none';
    });
});
// createPostModal.addEventListener('click', e => { if (e.target === createPostModal) createPostModal.style.display = 'none'; });

submitPostBtn.addEventListener('click', async () => {
    const title = document.getElementById('post-title-input').value.trim();
    const board = document.getElementById('post-board-input').value.trim();
    const author = document.getElementById('post-author-input').value.trim();
    const content = document.getElementById('post-content-input').value.trim();
    const errEl = document.getElementById('create-post-error');

    if (!title || !board || !author || !content) return showError(errEl, '请填写所有字段');
    submitPostBtn.disabled = true;
    submitPostBtn.textContent = '发布中...';
    try {
        const settings = await api.loadSettings();
        if (!settings?.vcpApiKey) throw new Error('API Key missing');
        const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPForum「末」,
command:「始」CreatePost「末」,
maid:「始」${author}「末」,
board:「始」${board}「末」,
title:「始」${title}「末」,
content:「始」${content}「末」
<<<[END_TOOL_REQUEST]>>>`;
        const res = await fetch(`${serverBaseUrl}v1/human/tool`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Authorization': `Bearer ${settings.vcpApiKey}` },
            body: toolRequest
        });
        if (!res.ok) throw new Error(await res.text());
        createPostModal.style.display = 'none';
        loadPosts();
        ['post-title-input', 'post-board-input', 'post-content-input'].forEach(id => document.getElementById(id).value = '');
    } catch (error) {
        showError(errEl, error.message || '发布失败');
    } finally {
        submitPostBtn.disabled = false;
        submitPostBtn.textContent = '发布';
    }
});

function requestDeferredWork(callback) {
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => callback(), { timeout: 250 });
        return;
    }
    setTimeout(callback, 0);
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function escapeHtml(str) {
    return (str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ========== Custom Dialog Functions ==========
function customConfirm(message, title = '确认操作') {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-confirm-modal');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');

        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.style.display = 'flex';

        const handleOk = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(true);
        };

        const handleCancel = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(false);
        };

        const cleanup = () => {
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleModalClick);
        };

        const handleModalClick = (e) => {
            if (e.target === modal) handleCancel();
        };

        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.addEventListener('click', handleModalClick);
    });
}

function customAlert(message, title = '提示') {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-alert-modal');
        const titleEl = document.getElementById('alert-title');
        const messageEl = document.getElementById('alert-message');
        const okBtn = document.getElementById('alert-ok-btn');

        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.style.display = 'flex';

        const handleOk = () => {
            modal.style.display = 'none';
            cleanup();
            resolve();
        };

        const cleanup = () => {
            okBtn.removeEventListener('click', handleOk);
            modal.removeEventListener('click', handleModalClick);
        };

        const handleModalClick = (e) => {
            if (e.target === modal) handleOk();
        };

        okBtn.addEventListener('click', handleOk);
        modal.addEventListener('click', handleModalClick);
    });
}

function parseForumDate(ts) {
    if (!ts) return null;
    let d;
    if (typeof ts === 'string') {
        // Normalize non-standard timestamps like "2025-11-12T11-57-08.749Z"
        // by replacing hyphens in the time part with colons.
        const normalizedTs = ts.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
        d = new Date(normalizedTs);

        // Fallback for other non-standard formats if the above fails
        if (isNaN(d.getTime())) {
            // This handles formats like 'YYYY-MM-DD HH:mm:ss' better on some engines
            d = new Date(ts.replace(/-/g, '/'));
        }
    } else {
        // Assumes it's already a Date object or a valid timestamp number
        d = new Date(ts);
    }
    
    // If still invalid, return null
    if (isNaN(d.getTime())) {
        return null;
    }
    return d;
}

// The exact time for tooltips, e.g. 2025-11-12 11:57.
function formatFullDate(ts) {
    const d = parseForumDate(ts);
    if (!d) return ts ? String(ts) : '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(ts) {
    if (!ts) return '';
    try {
        const d = parseForumDate(ts);

        // Check if date is valid
        if (!d) {
            console.warn('Invalid date:', ts);
            return String(ts);
        }
        
        const now = new Date();
        const diff = (now - d) / 1000;
        
        if (diff < 60) return '刚刚';
        if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
        if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}天前`;
        
        // Format as date with time, including year if it's not the current year.
        const year = d.getFullYear();
        const currentYear = now.getFullYear();
        const month = d.getMonth() + 1;
        const day = d.getDate();
        const hours = d.getHours().toString().padStart(2, '0');
        const minutes = d.getMinutes().toString().padStart(2, '0');
        
        if (year !== currentYear) {
            return `${year}年${month}月${day}日 ${hours}:${minutes}`;
        } else {
            return `${month}月${day}日 ${hours}:${minutes}`;
        }
    } catch (e) {
        console.error('Date formatting error:', e, ts);
        return String(ts);
    }
}
