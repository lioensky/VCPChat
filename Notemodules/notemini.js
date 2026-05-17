const api = window.utilityAPI || window.electronAPI;

document.addEventListener('DOMContentLoaded', async () => {
    const titleInput = document.getElementById('miniNoteTitle');
    const contentInput = document.getElementById('miniNoteContent');
    const saveStatus = document.getElementById('saveStatus');
    const minimizeBtn = document.getElementById('minimizeMiniBtn');
    const closeBtn = document.getElementById('closeMiniBtn');

    let saveTimer = null;
    let isSaving = false;
    let hasSaved = false;
    let currentFilePath = null;
    let lastSavedSnapshot = '';

    function applyTheme(theme) {
        document.body.classList.toggle('light-theme', theme === 'light');
    }

    function setStatus(text, isError = false) {
        saveStatus.textContent = text;
        saveStatus.style.color = isError ? 'var(--danger-color)' : '';
    }

    function getSnapshot() {
        return JSON.stringify({
            title: titleInput.value,
            content: contentInput.value
        });
    }

    function hasMeaningfulContent() {
        return titleInput.value.trim().length > 0 || contentInput.value.trim().length > 0;
    }

    function scheduleSave() {
        setStatus('编辑中...');
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveCurrentNote();
        }, 800);
    }

    async function saveCurrentNote({ force = false } = {}) {
        if (isSaving) return;
        if (!hasMeaningfulContent()) {
            setStatus('空便签');
            return;
        }

        const snapshot = getSnapshot();
        if (!force && snapshot === lastSavedSnapshot) {
            setStatus(hasSaved ? '已保存' : '未保存');
            return;
        }

        isSaving = true;
        setStatus('保存中...');

        try {
            const result = await api.saveMiniNote({
                title: titleInput.value,
                content: contentInput.value,
                filePath: currentFilePath
            });

            if (result?.success) {
                hasSaved = true;
                currentFilePath = result.path || currentFilePath;
                lastSavedSnapshot = snapshot;
                setStatus('已保存');
            } else {
                setStatus(result?.error || '保存失败', true);
            }
        } catch (error) {
            setStatus(error.message || '保存失败', true);
        } finally {
            isSaving = false;
        }
    }

    async function initializeTheme() {
        try {
            const theme = await api.getCurrentTheme?.();
            applyTheme(theme || 'dark');
            api.onThemeUpdated?.(applyTheme);
        } catch (error) {
            applyTheme('dark');
        }
    }

    titleInput.addEventListener('input', scheduleSave);
    contentInput.addEventListener('input', scheduleSave);

    document.addEventListener('keydown', async (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (saveTimer) clearTimeout(saveTimer);
            await saveCurrentNote({ force: true });
        }

        if (event.key === 'Escape') {
            if (saveTimer) clearTimeout(saveTimer);
            await saveCurrentNote({ force: true });
            api.closeWindow();
        }
    });

    minimizeBtn.addEventListener('click', () => api.minimizeWindow());
    closeBtn.addEventListener('click', async () => {
        if (saveTimer) clearTimeout(saveTimer);
        await saveCurrentNote({ force: true });
        api.closeWindow();
    });

    window.addEventListener('beforeunload', () => {
        if (saveTimer) clearTimeout(saveTimer);
    });

    await initializeTheme();
    setStatus('未保存');
    titleInput.focus();
});