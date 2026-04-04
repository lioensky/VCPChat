// modules/emoticonManager.js

var emoticonManagerApi = window.chatAPI || window.utilityAPI || window.electronAPI;

const emoticonManager = (() => {
    let userEmoticons = [];
    let isInitialized = false;
    let emoticonPanel = null;
    let messageInput = null;
    let currentTargetInput = null;
    let lastLoadStatus = 'idle';
    let lastLoadReason = '';

    function setLoadStatus(status, reason = '') {
        lastLoadStatus = status;
        lastLoadReason = reason;
    }

    async function initialize(elements) {
        if (isInitialized) return;

        emoticonPanel = elements.emoticonPanel;
        messageInput = elements.messageInput || null;

        if (!emoticonPanel) {
            console.error('[EmoticonManager] Emoticon panel element not provided.');
            return;
        }

        await loadUserEmoticons();
        isInitialized = true;
        console.log('[EmoticonManager] Initialized successfully.');
    }

    async function loadUserEmoticons() {
        userEmoticons = [];
        setLoadStatus('loading');

        try {
            if (!emoticonManagerApi?.loadSettings || !emoticonManagerApi?.getEmoticonLibrary) {
                setLoadStatus('degraded', 'emoticon api unavailable');
                return;
            }

            const settings = await emoticonManagerApi.loadSettings();
            const userName = settings?.userName?.trim();
            if (!userName) {
                setLoadStatus('empty', 'user name unavailable');
                return;
            }

            const emoticonLibrary = await emoticonManagerApi.getEmoticonLibrary();
            if (!Array.isArray(emoticonLibrary)) {
                setLoadStatus('degraded', 'emoticon library unavailable');
                return;
            }

            const userCategory = `${userName}表情包`;
            userEmoticons = emoticonLibrary.filter((emoticon) => emoticon.category === userCategory);
            setLoadStatus(
                userEmoticons.length > 0 ? 'ready' : 'empty',
                userEmoticons.length > 0 ? '' : `no emoticons for ${userCategory}`
            );
            console.log(`[EmoticonManager] Loaded ${userEmoticons.length} emoticons for user "${userName}".`);
        } catch (error) {
            userEmoticons = [];
            setLoadStatus('degraded', error?.message || 'unknown error');
        }
    }

    function populateAndShowPanel(x, y) {
        if (!emoticonPanel) return;

        emoticonPanel.innerHTML = '';

        const title = document.createElement('div');
        title.className = 'emoticon-panel-title';
        title.textContent = '- VChat 表情包系统 -';
        emoticonPanel.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'emoticon-grid';
        emoticonPanel.appendChild(grid);

        if (userEmoticons.length === 0) {
            grid.innerHTML = '<div class="emoticon-item-placeholder">没有找到您的表情包</div>';
        } else {
            userEmoticons.forEach((emoticon) => {
                const img = document.createElement('img');
                img.src = emoticon.url;
                img.title = emoticon.filename;
                img.className = 'emoticon-item';
                img.onclick = () => insertEmoticon(emoticon);
                grid.appendChild(img);
            });
        }

        emoticonPanel.style.left = `${x}px`;
        emoticonPanel.style.top = `${y}px`;
        emoticonPanel.style.display = 'flex';

        setTimeout(() => {
            document.addEventListener('click', hidePanelOnClickOutside, { once: true });
        }, 100);
    }

    function hidePanel() {
        if (emoticonPanel) {
            emoticonPanel.style.display = 'none';
        }
        document.removeEventListener('click', hidePanelOnClickOutside);
        currentTargetInput = null;
    }

    function hidePanelOnClickOutside(event) {
        if (emoticonPanel && !emoticonPanel.contains(event.target) && event.target.id !== 'attachFileBtn') {
            hidePanel();
        } else {
            document.addEventListener('click', hidePanelOnClickOutside, { once: true });
        }
    }

    function insertEmoticon(emoticon) {
        if (!currentTargetInput) return;

        const decodedUrl = decodeURIComponent(emoticon.url);
        const imgTag = `<img src="${decodedUrl}" width="80">`;
        const currentValue = currentTargetInput.value;
        const separator = currentValue.length > 0 && !/\s$/.test(currentValue) ? ' ' : '';

        currentTargetInput.value += separator + imgTag;
        currentTargetInput.focus();
        currentTargetInput.dispatchEvent(new Event('input', { bubbles: true }));

        hidePanel();
    }

    function togglePanel(attachBtn, targetInput) {
        const input = targetInput || messageInput;
        if (!emoticonPanel || !input) {
            console.error('[EmoticonManager] No target input specified or found.');
            return;
        }

        if (emoticonPanel.style.display === 'flex' && input === currentTargetInput) {
            hidePanel();
            return;
        }

        currentTargetInput = input;

        const rect = attachBtn.getBoundingClientRect();
        const panelWidth = 270;
        const panelHeight = 240;
        let x = rect.left - panelWidth + rect.width;
        let y = rect.top - panelHeight - 10;

        if (x < 0) x = 10;
        if (y < 0) y = rect.bottom + 10;

        populateAndShowPanel(x, y);
    }

    return {
        initialize,
        togglePanel,
        reload: loadUserEmoticons,
        getStatus: () => ({
            isInitialized,
            lastLoadStatus,
            lastLoadReason,
            emoticonCount: userEmoticons.length
        })
    };
})();

window.emoticonManager = emoticonManager;
