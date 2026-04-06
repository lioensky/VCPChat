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
    if (!user || !pass) return showError(loginError, 'Please enter username and password');

    loginButton.textContent = 'Verifying...';
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
        showError(loginError, error.message);
    } finally {
        loginButton.textContent = 'Enter Forum';
        loginButton.disabled = false;
    }
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
    } catch (error) {
        showError(settingsError, '保存失败: ' + error.message);
    } finally {
        saveSettingsBtn.textContent = '💾 保存';
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
            updateBoardFilter(allPosts);
            updateBoardDatalist(allPosts);
            renderCurrentFilteredPosts({ force: true });
        })
        .catch(error => {
            // Log errors immediately as well.
            console.error('Load posts failed:', error);
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
    boardFilter.innerHTML = '<option value="all">✨ 全部板块</option>';
    boards.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = `📂 ${b}`;
        boardFilter.appendChild(opt);
    });
    boardFilter.value = currentVal;
    if (boardFilter.value === '') boardFilter.value = 'all';
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

    if (!force && renderKey === lastRenderedPostKeys) {
        return;
    }

    renderWaterfall(filtered);
}

function renderWaterfall(postsToRender) {
    masonryContainer.innerHTML = '';

    if (!postsToRender || postsToRender.length === 0) {
        lastRenderedPostKeys = '';
        return;
    }

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
    el.className = 'post-card glass glass-hover';
    // Limit staggered animation to first 20 items to avoid massive delays on large lists
    const delay = index < 20 ? index * 0.05 : 0;
    el.style.animationDelay = `${delay}s`;
    
    // Backend returns lastReplyBy and lastReplyAt
    const displayDate = post.mtime || post.lastReplyAt || post.timestamp;
    const hasReply = post.lastReplyAt && post.timestamp && post.lastReplyAt !== post.timestamp;
    
    // Use lastReplyBy from backend API
    const lastReplier = post.lastReplyBy;
    const hasNewReplier = hasReply && lastReplier && lastReplier !== post.author;

    let metaHTML = '';

    if (hasNewReplier) {
        const authorHue = post.author.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
        const authorAvatarColor = `hsl(${authorHue}, 70%, 60%)`;
        const replierHue = lastReplier.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
        const replierAvatarColor = `hsl(${replierHue}, 70%, 60%)`;

        metaHTML = `
            <div class="author-info-with-time">
                <div class="author-avatar loading-avatar" style="background: ${authorAvatarColor}" data-author="${escapeHtml(post.author)}">${post.author.slice(0,1).toUpperCase()}</div>
                <div class="time-info">
                    <div style="font-size: 0.8em; opacity: 0.7;">发帖于</div>
                    <div>${formatDate(post.timestamp)}</div>
                </div>
            </div>
            <div class="meta-separator"></div>
            <div class="author-info-with-time">
                <div class="author-avatar loading-avatar" style="background: ${replierAvatarColor}" data-author="${escapeHtml(lastReplier)}">${lastReplier.slice(0,1).toUpperCase()}</div>
                <div class="time-info">
                    <div style="font-size: 0.8em; opacity: 0.7;">最后回复</div>
                    <div>${formatDate(displayDate)}</div>
                </div>
            </div>
        `;
    } else {
        const authorHue = post.author.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
        const authorAvatarColor = `hsl(${authorHue}, 70%, 60%)`;
        const timestampLabel = hasReply ? '最后回复' : '发帖于';

        metaHTML = `
            <div class="meta-left">
                <div class="author-avatar loading-avatar" style="background: ${authorAvatarColor}" data-author="${escapeHtml(post.author)}">${post.author.slice(0,1).toUpperCase()}</div>
                <span>${escapeHtml(post.author)}</span>
            </div>
            <div style="text-align: right;">
                <div style="font-size: 0.8em; opacity: 0.7;">${timestampLabel}</div>
                <div>${formatDate(displayDate)}</div>
            </div>
        `;
    }

    el.innerHTML = `
        <div class="post-card-header">
            <h3 class="post-title">${escapeHtml(post.title)}</h3>
            ${post.board ? `<span class="post-badge">${escapeHtml(post.board)}</span>` : ''}
        </div>
        <div class="post-preview" style="font-style: italic; opacity: 0.6;">
            点击展开查看详情...
        </div>
        <div class="post-meta">
            ${metaHTML}
        </div>
    `;

    el.addEventListener('click', (e) => expandPost(post, el));
    
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
    expanded.className = 'post-card glass expanded-card';
    expanded.style.position = 'fixed';
    expanded.style.top = `${rect.top}px`;
    expanded.style.left = `${rect.left}px`;
    expanded.style.width = `${rect.width}px`;
    expanded.style.height = `${rect.height}px`;
    expanded.style.margin = '0';
    expanded.style.zIndex = '2001';
    expanded.style.transition = 'all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)';

    activePostOverlay.innerHTML = '';
    activePostOverlay.appendChild(expanded);

    expanded.offsetHeight; // Force reflow
    
    // Animate to center with auto height
    expanded.style.position = 'relative';
    expanded.style.top = 'auto';
    expanded.style.left = 'auto';
    expanded.style.width = '90%';
    expanded.style.maxWidth = '1000px';
    expanded.style.height = 'auto';
    expanded.style.margin = '0 auto';
    expanded.style.borderRadius = '30px';
    expanded.style.cursor = 'default';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'expanded-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = closeExpandedPost;
    expanded.appendChild(closeBtn);

    try {
        const previewEl = expanded.querySelector('.post-preview');
        previewEl.innerHTML = '<div style="text-align:center; padding: 20px;">Loading content...</div>';
        previewEl.style.maskImage = 'none';
        previewEl.style.maxHeight = 'none';
        previewEl.style.fontStyle = 'normal'; // <-- 修正：移除内联斜体
        previewEl.style.opacity = '1';       // <-- 修正：恢复不透明度

        const data = await apiFetch(`/post/${post.uid}`);
        renderFullContent(expanded, data.content, post.uid);
    } catch (error) {
        expanded.querySelector('.post-preview').innerHTML = `<div style="color: var(--danger-color)">Failed to load: ${error.message}</div>`;
    }
}

function closeExpandedPost() {
    const expanded = activePostOverlay.querySelector('.expanded-card');
    if (expanded) {
        activePostOverlay.classList.remove('active');
        expanded.style.opacity = '0';
        expanded.style.transform = 'scale(0.9)';
    }
    setTimeout(() => {
        activePostOverlay.innerHTML = '';
        document.body.style.overflow = '';
    }, 300);
}

activePostOverlay.addEventListener('click', (e) => {
    if (e.target === activePostOverlay) closeExpandedPost();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePostOverlay.classList.contains('active')) {
        const activeEditingArea = activePostOverlay.querySelector('.edit-textarea');
        if (activeEditingArea) {
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

    // --- NEW: Precisely extract and display specific meta fields as per user request ---
    const metaItems = [];
    const authorMatch = markdown.match(/\*\*作者[:：]\*\*\s*(.*)/);
    const uidMatch = markdown.match(/\*\*UID[:：]\*\*\s*(.*)/);
    const timestampMatch = markdown.match(/\*\*时间戳[:：]\*\*\s*(.*)/);

    if (authorMatch) {
        metaItems.push(`<span class="meta-item"><span class="meta-key">作者:</span> <span class="meta-value">${escapeHtml(authorMatch[1].trim())}</span></span>`);
    }
    if (uidMatch) {
        metaItems.push(`<span class="meta-item"><span class="meta-key">UID:</span> <span class="meta-value">${escapeHtml(uidMatch[1].trim())}</span></span>`);
    }
    if (timestampMatch) {
        metaItems.push(`<span class="meta-item"><span class="meta-key">时间戳:</span> <span class="meta-value">${escapeHtml(timestampMatch[1].trim())}</span></span>`);
    }

    // Remove any existing meta header before adding a new one
    const existingMetaHeader = container.querySelector('.post-meta-header');
    if (existingMetaHeader) {
        existingMetaHeader.remove();
    }

    // If we found any meta items, create and insert the header
    if (metaItems.length > 0) {
        const metaHeaderEl = document.createElement('div');
        metaHeaderEl.className = 'post-meta-header';
        metaHeaderEl.innerHTML = metaItems.join('&nbsp;&nbsp;');
        container.insertBefore(metaHeaderEl, previewEl);
    }

    // Prepare the main content by stripping the entire meta block
    const postContentMd = mainMd.replace(/^(.|\n)*?---\n?/, '');
    // --- END NEW ---

    previewEl.innerHTML = window.marked ? marked.parse(enhanceMarkdown(postContentMd)) : `<pre>${escapeHtml(postContentMd)}</pre>`;
    previewEl.dataset.rawContent = postContentMd; // Store raw content for editing

    requestDeferredWork(() => {
        applyBoldFormatting(previewEl);

        if (window.renderMathInElement) {
            renderMathInElement(previewEl, {
                delimiters: [
                    {left: "$$", right: "$$", display: true},
                    {left: "$", right: "$", display: false},
                    {left: "\\(", right: "\\)", display: false},
                    {left: "\\[", right: "\\]", display: true}
                ]
            });
        }

        setupEmoticonFixer(previewEl);
        setupImageViewer(previewEl);
    });

    // Add post actions (edit/delete)
    const postActions = document.createElement('div');
    postActions.className = 'post-actions';
    postActions.innerHTML = `
        <button class="jelly-btn delete-post-btn">🗑️ 删除帖子</button>
        <button class="edit-btn">✏️ 编辑正文</button>
    `;
    postActions.querySelector('.delete-post-btn').addEventListener('click', () => handleDeletePost(uid));
    postActions.querySelector('.edit-btn').addEventListener('click', (e) => toggleEditMode(e.currentTarget.closest('.expanded-card'), previewEl, uid));
    previewEl.appendChild(postActions);


    if (repliesMd.trim()) {
        const replyList = document.createElement('div');
        replyList.className = 'reply-list';
        replyList.innerHTML = '<h3>💬 评论</h3>';
        
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
            
            const hue = replyUsername.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
            const avatarColor = `hsl(${hue}, 70%, 60%)`;
            
            const replyItem = document.createElement('div');
            replyItem.className = 'reply-item glass';
            replyItem.style.animationDelay = `${i * 0.1}s`;

            const metadataEndIndex = replyMd.indexOf('\n\n');
            const replyRawContent = metadataEndIndex !== -1 ? replyMd.substring(metadataEndIndex + 2) : replyMd;

            replyItem.innerHTML = `
                <div class="reply-header">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div class="reply-avatar loading-avatar" style="background: ${avatarColor}" data-author="${escapeHtml(replyUsername)}">${replyUsername ? replyUsername.slice(0,1).toUpperCase() : '#'}</div>
                        <span>#${floor}</span>
                    </div>
                    <div>
                        <button class="delete-floor-btn" data-uid="${uid}" data-floor="${floor}">删除</button>
                        <button class="edit-btn" data-uid="${uid}" data-floor="${floor}">编辑</button>
                    </div>
                </div>
                <div class="reply-content">${window.marked ? marked.parse(enhanceMarkdown(replyMd.trim())) : `<pre>${escapeHtml(replyMd.trim())}</pre>`}</div>
            `;
            replyItem.querySelector('.reply-content').dataset.rawContent = replyRawContent; // Store raw content
            replyList.appendChild(replyItem);
            
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
                            delimiters: [
                                {left: "$$", right: "$$", display: true},
                                {left: "$", right: "$", display: false},
                                {left: "\\(", right: "\\)", display: false},
                                {left: "\\[", right: "\\]", display: true}
                            ]
                        });
                    }
                });
            }
            
            // Add event listeners for action buttons
            replyItem.querySelector('.delete-floor-btn').addEventListener('click', (e) => handleDeleteFloor(uid, floor, container));
            replyItem.querySelector('.edit-btn').addEventListener('click', (e) => toggleEditMode(e.currentTarget.closest('.expanded-card'), replyContentEl, uid, floor));
        });
        container.appendChild(replyList);
    }

    const replyBox = document.createElement('div');
    replyBox.className = 'reply-area-fixed';
    replyBox.innerHTML = `
        <input type="text" id="quick-reply-name" class="glass-input" placeholder="昵称" style="width: 120px; margin-bottom:0;">
        <div class="textarea-container" style="position: relative; flex-grow: 1;">
            <textarea id="quick-reply-text" class="glass-input reply-input" placeholder="写下你的评论... (Ctrl+Enter 发送)" style="margin-bottom:0; height: 50px; resize: vertical; width: 100%;"></textarea>
            <button class="emoticon-btn" id="reply-emoticon-btn" style="position: absolute; bottom: 10px; right: 10px; z-index: 10;">😀</button>
        </div>
        <button id="quick-reply-btn" class="jelly-btn" style="width: auto; padding: 15px 25px;">发送</button>
    `;
    container.appendChild(replyBox);
    const nameInput = container.querySelector('#quick-reply-name');
    const textInput = container.querySelector('#quick-reply-text');
    nameInput.value = forumConfig.replyUsername || forumConfig.username || '';
    if (!nameInput.value) nameInput.placeholder = "请先在设置中指定署名";
    
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

    // Store the parent of the content element before we change it
    const contentParent = contentEl.parentNode;

    contentEl.innerHTML = `
        <textarea class="edit-textarea">${escapeHtml(rawContent)}</textarea>
        <div class="edit-controls">
            <button class="jelly-btn cancel-edit-btn" style="width: auto; padding: 8px 20px; background: var(--glass-bg);">取消</button>
            <button class="jelly-btn save-edit-btn" style="width: auto; padding: 8px 20px;">确认</button>
        </div>
    `;

    contentEl.querySelector('.cancel-edit-btn').addEventListener('click', () => {
        contentEl.innerHTML = originalHtml;
        // After restoring HTML, we MUST re-find the button and re-attach the listener
        // because the old button element was destroyed.
        let editBtn;
        if (floor) {
            // Find the specific edit button for this floor
            editBtn = contentParent.querySelector(`.edit-btn[data-floor="${floor}"]`);
        } else {
            // Find the main post's edit button
            editBtn = contentParent.querySelector('.post-actions .edit-btn');
        }
        
        if (editBtn) {
            editBtn.addEventListener('click', (e) => toggleEditMode(card, contentEl, uid, floor));
        }
    });

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
        await customAlert('内容已成功更新', '✅ 编辑成功');

    } catch (error) {
        await customAlert('保存失败: ' + error.message, '❌ 编辑失败');
        // Re-enable button on failure
        const btn = card.querySelector('.save-edit-btn');
        if (btn) {
            btn.textContent = '确认';
            btn.disabled = false;
        }
    }
}


async function handleDeletePost(uid) {
    const confirmed = await customConfirm('您确定要删除整个帖子吗？此操作无法撤销！', '⚠️ 删除帖子');
    if (!confirmed) return;
    
    try {
        await apiFetch(`/post/${uid}`, {
            method: 'DELETE',
            body: JSON.stringify({})
        });
        closeExpandedPost();
        loadPosts(); // Refresh the post list
        await customAlert('帖子已成功删除', '✅ 删除成功');
    } catch (error) {
        await customAlert('删除失败: ' + error.message, '❌ 删除失败');
    }
}

async function handleDeleteFloor(uid, floor, container) {
    const confirmed = await customConfirm(`您确定要删除第 ${floor} 楼吗？此操作无法撤销！`, '⚠️ 删除楼层');
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
        await customAlert('楼层已成功删除', '✅ 删除成功');
    } catch (error) {
        await customAlert('删除失败: ' + error.message, '❌ 删除失败');
    }
}

async function handleQuickReply(uid, container) {
    const nameInput = container.querySelector('#quick-reply-name');
    const textInput = container.querySelector('#quick-reply-text');
    const btn = container.querySelector('#quick-reply-btn');

    if (!nameInput.value.trim() || !textInput.value.trim()) {
        textInput.placeholder = '昵称和内容都不能为空！';
        return;
    }
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
        alert('Reply failed: ' + error.message);
        btn.disabled = false;
        btn.textContent = '发送';
    }
}

function applyFilters() {
    renderCurrentFilteredPosts({ force: true });
}

searchInput.addEventListener('input', debounce(() => applyFilters(), 120));
boardFilter.addEventListener('change', applyFilters);
refreshBtn.addEventListener('click', loadPosts);

createPostBtn.addEventListener('click', () => {
    const authorInput = document.getElementById('post-author-input');
    if (authorInput) {
        // Pre-fill author name from settings, prioritizing reply name
        authorInput.value = forumConfig.replyUsername || forumConfig.username || '';
    }
    createPostModal.style.display = 'flex';

    // Add emoticon button listener for create post modal
    const createPostEmoticonBtn = document.getElementById('create-post-emoticon-btn');
    const postContentInput = document.getElementById('post-content-input');
    if (createPostEmoticonBtn && postContentInput) {
        createPostEmoticonBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.emoticonManager.togglePanel(createPostEmoticonBtn, postContentInput);
        });
    }
});
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
        submitPostBtn.textContent = '🚀 发布';
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
