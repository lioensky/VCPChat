'use strict';

(() => {
    const api = window.docxAPI;
    const SuperDocClass = window.SuperDoc?.SuperDoc || window.SuperDoc?.default || window.SuperDoc;

    const state = {
        superdoc: null,
        toolbar: null,
        toolbarUnsubscribe: null,
        currentPath: null,
        currentName: '未命名文稿',
        dirty: false,
        ready: false,
        saving: false,
        loading: false,
        zoom: 100,
        checkpoints: [],
        outlineItems: [],
        outlineRefreshTimer: null,
        activeOutlineNodeId: null,
        updateTimer: null,
        countTimer: null,
        themeDisposer: null,
        pathRequestDisposer: null,
        agentCheckpointDisposer: null,
        fontReportDisposer: null,
        fontFallbackObserver: null,
        systemFonts: [],
        zoomFrame: null,
        pendingZoom: null,
        zoomSettleTimer: null,
        suppressUpdatesUntil: 0,
        unsavedResolver: null,
        selectionSnapshot: null,
    };

    const elements = {};

    const $ = (id) => document.getElementById(id);

    function cacheElements() {
        [
            'document-state-dot', 'document-title', 'save-state',
            'outline-toggle-btn', 'focus-mode-btn', 'lineage-toggle-btn',
            'minimize-btn', 'maximize-btn', 'close-btn',
            'new-btn', 'open-btn', 'save-btn', 'save-as-btn',
            'font-family-select', 'font-size-select', 'text-color-input',
            'highlight-color-input', 'line-height-select', 'insert-table-btn', 'find-btn',
            'welcome-state', 'welcome-new-btn', 'welcome-open-btn', 'recent-documents',
            'superdoc-host', 'loading-state', 'outline-panel', 'outline-count',
            'outline-headings-tab', 'outline-paragraphs-tab', 'outline-headings-view',
            'outline-paragraphs-view', 'outline-tree', 'paragraph-index', 'outline-empty',
            'lineage-panel', 'lineage-flow',
            'create-checkpoint-btn', 'checkpoint-count', 'page-status', 'word-count',
            'character-count', 'font-status', 'zoom-out-btn', 'zoom-range', 'zoom-in-btn',
            'zoom-value', 'toast-region', 'selection-format-bar', 'selection-font-family',
            'selection-font-size', 'selection-text-color', 'unsaved-dialog',
            'unsaved-dialog-message', 'unsaved-document-name', 'unsaved-cancel-btn',
            'unsaved-discard-btn', 'unsaved-save-btn', 'checkpoint-dialog',
            'checkpoint-name-input', 'checkpoint-note-input', 'checkpoint-cancel-btn',
        ].forEach((id) => {
            elements[id] = $(id);
        });
    }

    function showToast(message, type = 'info', duration = 2600) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        elements['toast-region'].appendChild(toast);
        window.setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(8px)';
            window.setTimeout(() => toast.remove(), 180);
        }, duration);
    }

    function applyTheme(theme) {
        document.body.classList.toggle('light-theme', theme === 'light');
        const textColor = theme === 'light' ? '#1b211f' : '#f2f0e9';
        if (elements['text-color-input']) elements['text-color-input'].value = textColor;
    }

    async function initializeTheme() {
        try {
            applyTheme(await api.getCurrentTheme());
        } catch (error) {
            console.warn('[Scriptorium] Unable to read theme:', error);
            applyTheme('dark');
        }
        state.themeDisposer = api.onThemeUpdated(applyTheme);
    }

    function updateDocumentIdentity() {
        elements['document-title'].textContent = state.currentName || '未命名文稿';
        elements['document-title'].title = state.currentPath || '尚未保存到磁盘';
        elements['save-state'].textContent = state.loading
            ? '正在展开'
            : state.saving
                ? '正在保存'
                : state.dirty
                    ? '有未保存修改'
                    : state.ready
                        ? '已保存'
                        : '等待落笔';

        const dot = elements['document-state-dot'];
        dot.classList.toggle('dirty', state.dirty && !state.saving);
        dot.classList.toggle('saved', state.ready && !state.dirty && !state.loading);
        elements['save-btn'].disabled = !state.ready || state.saving;
        elements['save-as-btn'].disabled = !state.ready || state.saving;
        elements['create-checkpoint-btn'].disabled = !state.ready || state.saving;
    }

    function setLoading(loading) {
        state.loading = loading;
        elements['loading-state'].hidden = !loading;
        updateDocumentIdentity();
    }

    function markDirty() {
        if (!state.ready || state.loading || Date.now() < state.suppressUpdatesUntil) return;
        state.dirty = true;
        updateDocumentIdentity();
        scheduleDocumentMetrics();
    }

    function markSaved() {
        state.dirty = false;
        updateDocumentIdentity();
    }

    function getActiveEditor() {
        return state.superdoc?.activeEditor || null;
    }

    function getBodyEditor() {
        const active = getActiveEditor();
        return active?.getActiveEditor?.() || active?.editor || active || null;
    }

    function getCommandEditor(command) {
        // 字符/段落格式必须进入底层编辑器事务；撤销与重做由 Presentation
        // 历史协调器处理，才能覆盖分页表面以及页眉页脚等活动故事。
        if (command === 'undo' || command === 'redo') return getActiveEditor() || getBodyEditor();
        return getBodyEditor();
    }

    function destroyEditor() {
        window.clearTimeout(state.updateTimer);
        window.clearTimeout(state.countTimer);
        window.clearTimeout(state.outlineRefreshTimer);
        window.clearTimeout(state.zoomSettleTimer);
        state.zoomSettleTimer = null;
        hideSelectionFormatBar();
        if (state.zoomFrame !== null) window.cancelAnimationFrame(state.zoomFrame);
        state.zoomFrame = null;
        state.pendingZoom = null;
        state.fontReportDisposer?.();
        state.fontReportDisposer = null;
        state.fontFallbackObserver?.disconnect();
        state.fontFallbackObserver = null;
        state.toolbarUnsubscribe?.();
        state.toolbarUnsubscribe = null;
        state.toolbar = null;
        state.superdoc?.destroy?.();
        state.superdoc = null;
        state.ready = false;
        state.outlineItems = [];
        state.activeOutlineNodeId = null;
        renderDocumentOutline([]);
    }

    function resolveSuperDocReady(payload) {
        return payload?.superdoc || state.superdoc;
    }

    async function createEditor(documentData = null, metadata = {}) {
        if (!SuperDocClass) {
            showToast('SuperDoc 文档内核未能载入。', 'error', 5000);
            return;
        }

        setLoading(true);
        destroyEditor();
        elements['welcome-state'].hidden = true;
        elements['superdoc-host'].hidden = false;
        elements['superdoc-host'].replaceChildren();

        state.currentPath = metadata.filePath || null;
        state.currentName = metadata.name || (state.currentPath ? state.currentPath.split(/[\\/]/).pop() : '未命名文稿.docx');
        state.dirty = false;
        state.ready = false;
        state.suppressUpdatesUntil = Number.POSITIVE_INFINITY;
        updateDocumentIdentity();

        const config = {
            selector: '#superdoc-host',
            documentMode: 'editing',
            useLayoutEngine: true,
            user: {
                name: 'Human Author',
                email: 'human@vcp.local',
            },
            modules: {
                comments: false,
                ai: false,
            },
            telemetry: {
                enabled: false,
            },
            zoom: {
                initial: state.zoom,
                mode: 'manual',
            },
            onReady: async (payload) => {
                state.superdoc = resolveSuperDocReady(payload);
                state.ready = true;
                state.suppressUpdatesUntil = Date.now() + 1200;
                setLoading(false);
                markSaved();
                initializeDocumentFonts();
                window.setTimeout(() => {
                    if (state.ready && !state.dirty) markSaved();
                }, 1300);
                await initializeHeadlessToolbar();
                getBodyEditor()?.on?.('selectionUpdate', () => {
                    refreshDirectCommandStates();
                    syncActiveOutlineFromSelection();
                });
                scheduleDocumentMetrics(true);
                scheduleOutlineRefresh(true);
                elements['font-status'].textContent = 'DOCX 排版内核就绪';
                showToast(documentData ? '文档已展开' : '空白文稿已建立', 'success');
            },
            onEditorUpdate: () => {
                window.clearTimeout(state.updateTimer);
                state.updateTimer = window.setTimeout(markDirty, 100);
                scheduleOutlineRefresh();
            },
            onException: (payload) => {
                const message = payload?.error?.message || payload?.message || '文档内核发生异常';
                console.error('[Scriptorium] SuperDoc exception:', payload);
                showToast(message, 'error', 5000);
            },
        };

        if (documentData) {
            const file = new File([documentData], state.currentName, {
                type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            });
            config.document = file;
        }

        try {
            state.superdoc = new SuperDocClass(config);
        } catch (error) {
            console.error('[Scriptorium] Editor creation failed:', error);
            setLoading(false);
            elements['superdoc-host'].hidden = true;
            elements['welcome-state'].hidden = false;
            showToast(`无法建立文稿：${error.message}`, 'error', 6000);
        }
    }

    async function initializeHeadlessToolbar() {
        const editor = getBodyEditor();
        if (!editor?.commands) {
            showToast('文档命令表面未就绪，稍后可继续排版。', 'error', 5000);
            return;
        }

        // 直接绑定当前 SuperDoc 实例的命令表面，避免重复加载 ProseMirror/Yjs。
        state.toolbar = {
            execute: executeEditorCommand,
        };
        refreshDirectCommandStates();
    }

    function refreshDirectCommandStates() {
        const editor = getBodyEditor();
        if (!editor) return;
        const activeMap = {
            bold: 'bold',
            italic: 'italic',
            underline: 'underline',
            strikethrough: 'strike',
            'bullet-list': 'bulletList',
            'numbered-list': 'orderedList',
        };
        for (const [controlId, markName] of Object.entries(activeMap)) {
            const control = document.querySelector(`[data-command="${controlId}"]`);
            if (control && typeof editor.isActive === 'function') {
                try {
                    control.classList.toggle('active', editor.isActive(markName));
                } catch {
                    control.classList.remove('active');
                }
            }
        }
    }

    function syncSelectValue(select, value, normalizeFont = false) {
        if (!select || value === undefined || value === null) return;
        let normalized = String(value);
        if (normalizeFont) normalized = normalized.split(',')[0].trim().replace(/^["']|["']$/g, '');
        const option = [...select.options].find((item) => {
            const itemValue = normalizeFont
                ? item.value.split(',')[0].trim().replace(/^["']|["']$/g, '')
                : item.value;
            return itemValue.toLowerCase() === normalized.toLowerCase();
        });
        if (option) select.value = option.value;
    }

    function executeEditorCommand(command, value) {
        const editor = getCommandEditor(command);
        let commands = editor?.commands;
        if (!commands && (command === 'undo' || command === 'redo')) {
            commands = getBodyEditor()?.commands;
        }
        if (!commands) return false;

        const commandMap = {
            bold: ['toggleBold'],
            italic: ['toggleItalic'],
            underline: ['toggleUnderline'],
            strikethrough: ['toggleStrike', 'toggleStrikethrough'],
            'font-family': ['setFontFamily'],
            'font-size': ['setFontSize'],
            'text-color': ['setColor'],
            'highlight-color': ['setHighlight'],
            'text-align': ['setTextAlign'],
            'line-height': ['setLineHeight'],
            'bullet-list': ['toggleBulletList'],
            'numbered-list': ['toggleOrderedList', 'toggleNumberedList'],
            undo: ['undo'],
            redo: ['redo'],
            'table-insert': ['insertTable'],
        };

        const candidates = commandMap[command] || [];
        const methodName = candidates.find((name) => typeof commands[name] === 'function');
        if (!methodName) return false;

        // 字体族名保持为单一逻辑字体。由 SuperDoc 自己维护 OOXML 的
        // ascii / hAnsi / eastAsia / cs 槽位，避免把 CSS 回退栈写入撤销历史。
        const normalizedValue = command === 'font-family'
            ? normalizeCjkFontCommand(value)
            : value;
        const result = normalizedValue === undefined
            ? commands[methodName]()
            : commands[methodName](normalizedValue);
        window.setTimeout(refreshDirectCommandStates, 0);
        return result !== false;
    }

    function executeToolbar(command, value) {
        if (!state.toolbar) {
            showToast('排版工具尚未就绪。');
            return false;
        }
        try {
            if (command === 'image') return insertImage();
            if (command === 'zoom') return applyEditorZoom(value);
            const result = state.toolbar.execute(command, value);
            if (result === false) showToast('当前选区暂不支持此排版操作。');
            return result;
        } catch (error) {
            console.error(`[Scriptorium] Command ${command} failed:`, error);
            showToast('当前选区无法执行此排版操作。', 'error');
            return false;
        }
    }

    function insertImage() {
        const editor = getBodyEditor();
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(file);
                });
                const commands = editor?.commands;
                const insert = commands?.setImage || commands?.insertImage || commands?.addImage;
                if (typeof insert !== 'function') {
                    showToast('当前文档内核暂未暴露图片插入命令。', 'error');
                    return;
                }
                insert.call(commands, { src: dataUrl, alt: file.name });
            } catch (error) {
                showToast(`图片插入失败：${error.message}`, 'error');
            }
        }, { once: true });
        fileInput.click();
        return true;
    }

    function applyEditorZoom(value) {
        const zoom = Number(value) || 100;
        const editor = getActiveEditor();
        if (typeof state.superdoc?.setZoom === 'function') {
            state.superdoc.setZoom(zoom);
            return true;
        }
        if (typeof editor?.setZoom === 'function') {
            // PresentationEditor 的低层接口使用倍率，而 SuperDoc 的公开接口使用百分比。
            editor.setZoom(zoom / 100);
            return true;
        }
        return false;
    }

    function scheduleEditorZoom(value) {
        state.pendingZoom = Number(value) || 100;
        if (state.zoomFrame !== null) return;
        state.zoomFrame = window.requestAnimationFrame(() => {
            state.zoomFrame = null;
            const zoom = state.pendingZoom;
            state.pendingZoom = null;
            applyEditorZoom(zoom);
        });
    }

    function settleEditorZoom() {
        if (state.pendingZoom !== null) {
            if (state.zoomFrame !== null) window.cancelAnimationFrame(state.zoomFrame);
            state.zoomFrame = null;
            const zoom = state.pendingZoom;
            state.pendingZoom = null;
            applyEditorZoom(zoom);
        }

        // Chromium 在连续 transform 缩放时可能保留低分辨率合成纹理。
        // 临时撤销合成层提示，促使最终比例重新栅格化文字。
        const host = elements['superdoc-host'];
        host.classList.add('zoom-settling');
        void host.offsetHeight;
        window.requestAnimationFrame(() => {
            host.classList.remove('zoom-settling');
        });
    }

    function scheduleZoomSettlement() {
        window.clearTimeout(state.zoomSettleTimer);
        state.zoomSettleTimer = window.setTimeout(() => {
            state.zoomSettleTimer = null;
            settleEditorZoom();
        }, 160);
    }

    function requestUnsavedDecision(message) {
        if (!state.dirty) return Promise.resolve('discard');
        if (state.unsavedResolver) return Promise.resolve('cancel');

        elements['unsaved-dialog-message'].textContent = message;
        elements['unsaved-document-name'].textContent = state.currentName || '未命名文稿.docx';
        elements['unsaved-dialog'].hidden = false;

        return new Promise((resolve) => {
            state.unsavedResolver = resolve;
            window.setTimeout(() => elements['unsaved-save-btn'].focus(), 30);
        });
    }

    function resolveUnsavedDecision(decision) {
        const resolve = state.unsavedResolver;
        if (!resolve) return;
        state.unsavedResolver = null;
        elements['unsaved-dialog'].hidden = true;
        resolve(decision);
    }

    async function runAfterUnsavedDecision(message, action) {
        if (!state.dirty) {
            await action();
            return true;
        }

        const decision = await requestUnsavedDecision(message);
        if (decision === 'cancel') return false;
        if (decision === 'save' && !await saveDocument(false)) return false;
        await action();
        return true;
    }

    async function chooseOpen() {
        await runAfterUnsavedDecision(
            '打开另一份文档前，可以保存当前修改，或舍弃这些修改。',
            async () => {
                try {
                    const result = await api.chooseOpen();
                    if (!result?.success) return;
                    await createEditor(Uint8Array.from(result.bytes), result);
                    await renderRecentDocuments();
                } catch (error) {
                    showToast(`打开失败：${error.message}`, 'error', 5000);
                }
            }
        );
    }

    async function openPath(filePath) {
        if (!filePath) return;
        await runAfterUnsavedDecision(
            '载入另一份文档前，可以保存当前修改，或舍弃这些修改。',
            async () => {
                try {
                    const result = await api.readPath(filePath);
                    if (!result?.success) return;
                    await createEditor(Uint8Array.from(result.bytes), result);
                    await renderRecentDocuments();
                } catch (error) {
                    showToast(`载入失败：${error.message}`, 'error', 5000);
                }
            }
        );
    }

    async function createNewDocument() {
        await runAfterUnsavedDecision(
            '建立新稿前，可以保存当前修改，或舍弃这些修改。',
            () => createEditor(null, { name: '未命名文稿.docx' })
        );
    }

    async function exportDocumentBlob() {
        if (!state.superdoc || !state.ready) throw new Error('文档尚未就绪。');
        const blob = await state.superdoc.export({
            triggerDownload: false,
            exportType: ['docx'],
        });
        if (blob instanceof Blob) return blob;
        if (Array.isArray(blob) && blob[0] instanceof Blob) return blob[0];
        throw new Error('DOCX 内核未返回有效文档数据。');
    }

    async function saveDocument(saveAs = false) {
        if (!state.ready || state.saving) return false;
        state.saving = true;
        updateDocumentIdentity();

        try {
            const blob = await exportDocumentBlob();
            const result = await api.save({
                filePath: state.currentPath,
                suggestedName: state.currentName,
                saveAs,
                bytes: new Uint8Array(await blob.arrayBuffer()),
            });
            if (!result?.success) {
                if (!result?.canceled) throw new Error(result?.error || '保存失败');
                return false;
            }

            state.currentPath = result.filePath;
            state.currentName = result.name;
            markSaved();
            await renderRecentDocuments();
            showToast(`已保存 · ${result.name}`, 'success');
            return true;
        } catch (error) {
            console.error('[Scriptorium] Save failed:', error);
            showToast(`保存失败：${error.message}`, 'error', 5000);
            return false;
        } finally {
            state.saving = false;
            updateDocumentIdentity();
        }
    }

    async function renderRecentDocuments() {
        let recent = [];
        try {
            recent = await api.listRecent();
        } catch (error) {
            console.warn('[Scriptorium] Recent documents unavailable:', error);
        }

        elements['recent-documents'].replaceChildren(...recent.slice(0, 6).map((item) => {
            const button = document.createElement('button');
            button.className = 'recent-document';
            button.title = item.path;
            button.innerHTML = `
                <svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4"/></svg>
                <span></span>
            `;
            button.querySelector('span').textContent = item.name;
            button.addEventListener('click', () => openPath(item.path));
            return button;
        }));
    }

    function normalizeFontName(font) {
        return String(font || '').trim().replace(/^["']+|["']+$/g, '');
    }

    function chooseCjkFallbackFont() {
        const priorities = [
            'Microsoft YaHei', 'Microsoft YaHei UI',
            'DengXian', 'SimSun', 'SimHei', 'KaiTi', 'FangSong',
            'Yu Gothic UI', 'Meiryo UI', 'Malgun Gothic',
            'Noto Sans CJK SC', 'Source Han Sans SC', 'Arial Unicode MS',
        ];
        const installed = new Map(state.systemFonts.map((font) => [font.toLowerCase(), font]));
        const probe = '中文日本語한글';
        for (const candidate of priorities) {
            const listed = installed.get(candidate.toLowerCase()) || candidate;
            try {
                if (document.fonts?.check(`16px ${quoteCssFont(listed)}`, probe)) return listed;
            } catch {
                // 某些 Chromium 版本不接受带测试文本的 check，继续按系统列表判断。
            }
            if (installed.has(candidate.toLowerCase())) return listed;
        }
        return 'Microsoft YaHei';
    }

    function normalizeCjkFontCommand(font) {
        const aliases = new Map([
            ['微软雅黑', 'Microsoft YaHei'],
            ['微软雅黑 UI', 'Microsoft YaHei UI'],
            ['宋体', 'SimSun'],
            ['新宋体', 'NSimSun'],
            ['黑体', 'SimHei'],
            ['等线', 'DengXian'],
            ['楷体', 'KaiTi'],
            ['楷体_GB2312', 'KaiTi'],
            ['仿宋', 'FangSong'],
            ['仿宋_GB2312', 'FangSong'],
            ['游ゴシック', 'Yu Gothic'],
            ['游ゴシック UI', 'Yu Gothic UI'],
            ['メイリオ', 'Meiryo'],
            ['맑은 고딕', 'Malgun Gothic'],
        ]);
        const normalized = normalizeFontName(font);
        return aliases.get(normalized) || normalized;
    }

    function quoteCssFont(font) {
        return `"${String(font).replace(/["\\]/g, '\\$&')}"`;
    }

    function appendCjkFallbackToPaintedRuns(root = elements['superdoc-host']) {
        if (!root) return;
        const fallback = chooseCjkFallbackFont();
        const forcedStack = [
            quoteCssFont(fallback),
            '"Microsoft YaHei"',
            '"Microsoft YaHei UI"',
            '"Yu Gothic UI"',
            '"Meiryo UI"',
            '"Malgun Gothic"',
            '"SimSun"',
            'sans-serif',
        ].filter((font, index, all) => all.indexOf(font) === index).join(', ');
        const cjkPattern = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u31f0-\u31ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

        // 直接从文字节点向上定位最深层绘制元素，避免依赖 SuperDoc 私有类名。
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const targets = new Set();
        let textNode = walker.nextNode();
        while (textNode) {
            if (cjkPattern.test(textNode.nodeValue || '')) {
                const parent = textNode.parentElement;
                if (parent && parent.closest('#superdoc-host')) targets.add(parent);
            }
            textNode = walker.nextNode();
        }

        for (const element of targets) {
            element.style.setProperty('font-family', forcedStack, 'important');
            element.style.setProperty('font-synthesis', 'weight style', 'important');
            element.dataset.scriptoriumCjkFallback = fallback;
        }
    }

    function initializeDocumentFonts() {
        state.fontReportDisposer?.();
        state.fontReportDisposer = null;
        state.fontFallbackObserver?.disconnect();
        state.fontFallbackObserver = null;

        const fontsApi = state.superdoc?.fonts;
        if (typeof fontsApi?.onReport !== 'function') return;
        state.fontReportDisposer = fontsApi.onReport((payload) => {
            const missing = Array.isArray(payload?.missingFonts) ? payload.missingFonts : [];
            elements['font-status'].textContent = missing.length
                ? `${missing.length} 种文档字体当前不可用`
                : 'DOCX 字体渲染正常';
        });
    }

    async function loadSystemFonts() {
        elements['font-status'].textContent = '正在读取系统字体…';
        try {
            const fonts = (await api.listSystemFonts())
                .map(normalizeFontName)
                .filter((font, index, all) => font && all.indexOf(font) === index);
            state.systemFonts = fonts;
            const selects = [
                elements['font-family-select'],
                elements['selection-font-family'],
            ].filter(Boolean);
            const previousValues = selects.map((select) => select.value);
            for (const [selectIndex, select] of selects.entries()) {
                const fragment = document.createDocumentFragment();
                for (const font of fonts) {
                    const option = document.createElement('option');
                    option.value = font;
                    option.textContent = font;
                    option.style.fontFamily = `"${font.replace(/["\\]/g, '\\$&')}"`;
                    fragment.appendChild(option);
                }
                select.replaceChildren(fragment);
                if (previousValues[selectIndex]) {
                    syncSelectValue(select, previousValues[selectIndex], true);
                }
            }
            elements['font-status'].textContent = `${fonts.length} 种系统字体可用`;
        } catch (error) {
            console.error('[Scriptorium] Font list failed:', error);
            elements['font-status'].textContent = '系统字体读取失败';
        }
    }

    function getDocumentText() {
        const editor = getActiveEditor();
        try {
            if (typeof editor?.getText === 'function') return editor.getText() || '';
            if (typeof editor?.getJSON === 'function') {
                const json = editor.getJSON();
                const texts = [];
                const walk = (node) => {
                    if (!node) return;
                    if (typeof node.text === 'string') texts.push(node.text);
                    if (Array.isArray(node.content)) {
                        node.content.forEach(walk);
                        if (node.type === 'paragraph') texts.push('\n');
                    }
                };
                walk(json);
                return texts.join('');
            }
        } catch (error) {
            console.warn('[Scriptorium] Text metrics unavailable:', error);
        }
        return '';
    }

    function scheduleDocumentMetrics(immediate = false) {
        window.clearTimeout(state.countTimer);
        state.countTimer = window.setTimeout(updateDocumentMetrics, immediate ? 0 : 420);
    }

    function getDocumentApi() {
        return getBodyEditor()?.doc || getActiveEditor()?.doc || null;
    }

    function mapBlocksToDocumentPositions(blocks) {
        const bodyEditor = getBodyEditor();
        const doc = bodyEditor?.state?.doc;
        if (!doc || !Array.isArray(blocks)) return blocks.map((block) => ({ ...block, pmPos: null }));

        const topLevelPositions = [];
        let offset = 0;
        for (let index = 0; index < doc.childCount; index += 1) {
            const node = doc.child(index);
            const paragraphProperties = node?.attrs?.paragraphProperties || {};
            const styleId = paragraphProperties.styleId || '';
            const isTextBlock = Boolean(node?.isTextblock);
            topLevelPositions.push({
                pos: offset,
                node,
                nodeType: node?.type?.name,
                styleId,
                isTextBlock,
            });
            offset += node.nodeSize;
        }

        let cursor = 0;
        return blocks.map((block) => {
            let match = null;
            for (let index = cursor; index < topLevelPositions.length; index += 1) {
                const candidate = topLevelPositions[index];
                const attrs = candidate.node?.attrs || {};
                const candidateIds = [
                    attrs.sdBlockId,
                    attrs.blockId,
                    attrs.paraId,
                    attrs.id,
                    attrs.paragraphProperties?.paraId,
                ].filter((value) => value !== undefined && value !== null).map(String);
                if (candidateIds.includes(String(block.nodeId))) {
                    match = candidate;
                    cursor = index + 1;
                    break;
                }
            }

            if (!match) {
                for (let index = cursor; index < topLevelPositions.length; index += 1) {
                    const candidate = topLevelPositions[index];
                    if (!candidate.isTextBlock && block.nodeType !== 'table' && block.nodeType !== 'image') continue;
                    match = candidate;
                    cursor = index + 1;
                    break;
                }
            }

            return {
                ...block,
                pmPos: match ? Math.min(match.pos + 1, doc.content.size) : null,
            };
        });
    }

    function scheduleOutlineRefresh(immediate = false) {
        window.clearTimeout(state.outlineRefreshTimer);
        state.outlineRefreshTimer = window.setTimeout(rebuildDocumentOutline, immediate ? 0 : 520);
    }

    async function rebuildDocumentOutline() {
        if (!state.ready) {
            renderDocumentOutline([]);
            return;
        }

        try {
            const docApi = getDocumentApi();
            if (typeof docApi?.blocks?.list !== 'function') {
                renderDocumentOutline([]);
                return;
            }

            const result = await Promise.resolve(docApi.blocks.list({
                limit: 5000,
                includeText: true,
            }));
            const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
            state.outlineItems = mapBlocksToDocumentPositions(blocks);
            renderDocumentOutline(state.outlineItems);
            syncActiveOutlineFromSelection();
        } catch (error) {
            console.warn('[Scriptorium] Document outline unavailable:', error);
            renderDocumentOutline([]);
        }
    }

    function createOutlineButton(block) {
        const button = document.createElement('button');
        const level = Math.max(1, Math.min(6, Number(block.headingLevel) || 1));
        button.type = 'button';
        button.className = 'outline-item';
        button.dataset.nodeId = block.nodeId;
        button.style.setProperty('--outline-level', String(level));
        button.title = block.text || block.textPreview || `标题 ${block.ordinal + 1}`;
        button.innerHTML = `
            <span class="outline-level"></span>
            <span class="outline-item-copy">
                <span class="outline-item-title"></span>
                <span class="outline-item-meta"></span>
            </span>
        `;
        button.querySelector('.outline-level').textContent = String(level);
        button.querySelector('.outline-item-title').textContent =
            (block.text || block.textPreview || '未命名标题').trim() || '未命名标题';
        button.querySelector('.outline-item-meta').textContent = `标题 ${level} · 段 ${block.ordinal + 1}`;
        button.addEventListener('click', () => navigateToOutlineBlock(block));
        return button;
    }

    function createParagraphButton(block) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'paragraph-item';
        button.dataset.nodeId = block.nodeId;
        button.title = block.text || block.textPreview || `空段落 ${block.ordinal + 1}`;
        button.innerHTML = `
            <span class="paragraph-ordinal"></span>
            <span class="paragraph-item-copy">
                <span class="paragraph-preview"></span>
                <span class="paragraph-item-meta"></span>
            </span>
        `;
        button.querySelector('.paragraph-ordinal').textContent = String(block.ordinal + 1).padStart(2, '0');
        button.querySelector('.paragraph-preview').textContent =
            (block.text || block.textPreview || '').trim() || '（空段落）';
        button.querySelector('.paragraph-item-meta').textContent =
            block.headingLevel ? `标题 ${block.headingLevel}` : (block.styleId || '正文');
        button.addEventListener('click', () => navigateToOutlineBlock(block));
        return button;
    }

    function renderDocumentOutline(blocks) {
        if (!elements['outline-tree']) return;
        const textBlocks = blocks.filter((block) =>
            ['paragraph', 'heading', 'listItem'].includes(block.nodeType)
            || typeof block.text === 'string'
        );
        const headings = textBlocks.filter((block) => Number.isFinite(Number(block.headingLevel)));
        const paragraphs = textBlocks.filter((block) => {
            const text = (block.text || block.textPreview || '').trim();
            return Boolean(text) || block.isEmpty;
        });

        elements['outline-tree'].replaceChildren(...headings.map(createOutlineButton));
        elements['paragraph-index'].replaceChildren(...paragraphs.map(createParagraphButton));
        elements['outline-count'].textContent = `${headings.length} 节`;
        elements['outline-empty'].hidden = headings.length > 0 || paragraphs.length > 0;
    }

    function setOutlineTab(tabName) {
        const showHeadings = tabName === 'headings';
        elements['outline-headings-tab'].classList.toggle('active', showHeadings);
        elements['outline-paragraphs-tab'].classList.toggle('active', !showHeadings);
        elements['outline-headings-tab'].setAttribute('aria-selected', String(showHeadings));
        elements['outline-paragraphs-tab'].setAttribute('aria-selected', String(!showHeadings));
        elements['outline-headings-view'].hidden = !showHeadings;
        elements['outline-paragraphs-view'].hidden = showHeadings;
        elements['outline-headings-view'].classList.toggle('active', showHeadings);
        elements['outline-paragraphs-view'].classList.toggle('active', !showHeadings);
    }

    async function navigateToOutlineBlock(block) {
        if (!block || !Number.isFinite(block.pmPos)) {
            showToast('该段落暂时无法定位。', 'error');
            return;
        }

        const presentation = getActiveEditor();
        const bodyEditor = getBodyEditor();
        try {
            let scrolled = false;
            if (typeof presentation?.scrollToPositionAsync === 'function') {
                scrolled = await presentation.scrollToPositionAsync(block.pmPos, {
                    block: 'center',
                    behavior: 'smooth',
                });
            } else if (typeof presentation?.scrollToPosition === 'function') {
                scrolled = presentation.scrollToPosition(block.pmPos, {
                    block: 'center',
                    behavior: 'smooth',
                });
            }

            if (!scrolled && typeof presentation?.getElementAtPos === 'function') {
                const target = presentation.getElementAtPos(block.pmPos, { forceRebuild: true });
                target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
                scrolled = Boolean(target);
            }

            bodyEditor?.commands?.setTextSelection?.({ from: block.pmPos, to: block.pmPos });
            bodyEditor?.view?.focus?.();
            state.activeOutlineNodeId = block.nodeId;
            renderActiveOutlineState();
            if (!scrolled) showToast('已移动光标，但目标纸页仍在渲染。');
        } catch (error) {
            console.warn('[Scriptorium] Outline navigation failed:', error);
            showToast('无法跳转到该段落。', 'error');
        }
    }

    function syncActiveOutlineFromSelection() {
        const position = getBodyEditor()?.state?.selection?.from;
        if (!Number.isFinite(position) || !state.outlineItems.length) return;
        let current = state.outlineItems[0];
        for (const item of state.outlineItems) {
            if (!Number.isFinite(item.pmPos) || item.pmPos > position) break;
            current = item;
        }
        state.activeOutlineNodeId = current?.nodeId || null;
        renderActiveOutlineState();
    }

    function renderActiveOutlineState() {
        document.querySelectorAll('.outline-item, .paragraph-item').forEach((button) => {
            button.classList.toggle('active', button.dataset.nodeId === String(state.activeOutlineNodeId));
        });
    }

    function updateDocumentMetrics() {
        const text = getDocumentText();
        const compact = text.replace(/\s/g, '');
        const words = (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
        const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
        const logicalWords = cjk + words;

        elements['word-count'].textContent = `${logicalWords.toLocaleString()} 字`;
        elements['character-count'].textContent = `${compact.length.toLocaleString()} 字符`;

        const pageNodes = elements['superdoc-host'].querySelectorAll(
            '.superdoc-page, .presentation-editor__page, [data-page-number], [data-page-index]'
        );
        const pageCount = pageNodes.length || '—';
        elements['page-status'].textContent = `第 ${state.ready ? 1 : '—'} 页 / 共 ${pageCount} 页`;
    }

    function updateZoomDisplay(value, execute = true, immediate = false) {
        const zoom = Math.max(50, Math.min(200, Number(value) || 100));
        state.zoom = zoom;
        elements['zoom-range'].value = String(zoom);
        elements['zoom-value'].textContent = `${zoom}%`;
        if (execute) {
            if (immediate) {
                applyEditorZoom(zoom);
                settleEditorZoom();
            } else {
                scheduleEditorZoom(zoom);
            }
        }
    }

    function captureCurrentSelection() {
        const selection = getBodyEditor()?.state?.selection;
        if (!selection || selection.empty) return null;
        return {
            from: selection.from,
            to: selection.to,
        };
    }

    function restoreSelectionSnapshot() {
        const snapshot = state.selectionSnapshot;
        const editor = getBodyEditor();
        const docSize = editor?.state?.doc?.content?.size;
        if (!snapshot || !Number.isFinite(docSize)) return false;
        const from = Math.max(0, Math.min(docSize, snapshot.from));
        const to = Math.max(from, Math.min(docSize, snapshot.to));
        if (from === to) return false;
        return editor.commands?.setTextSelection?.({ from, to }) !== false;
    }

    function findTextStyleAttrsInSelection() {
        const editor = getBodyEditor();
        const selection = editor?.state?.selection;
        if (!editor || !selection) return {};
        if (typeof editor.getAttributes === 'function') {
            try {
                return editor.getAttributes('textStyle') || {};
            } catch {
                // 继续从 ProseMirror 文档节点读取。
            }
        }

        let attrs = {};
        editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
            if (!node.isText) return;
            const mark = node.marks?.find((item) => item.type?.name === 'textStyle');
            if (mark) attrs = mark.attrs || {};
            return false;
        });
        return attrs;
    }

    function syncSelectionFormatBar() {
        const editor = getBodyEditor();
        if (!editor) return;
        const attrs = findTextStyleAttrsInSelection();
        if (attrs.fontFamily) {
            syncSelectValue(elements['selection-font-family'], attrs.fontFamily, true);
        } else if (elements['font-family-select'].value) {
            syncSelectValue(
                elements['selection-font-family'],
                elements['font-family-select'].value,
                true
            );
        }
        if (attrs.fontSize) {
            syncSelectValue(elements['selection-font-size'], attrs.fontSize);
        }

        for (const command of ['bold', 'italic', 'underline']) {
            const button = elements['selection-format-bar'].querySelector(
                `[data-selection-command="${command}"]`
            );
            try {
                button?.classList.toggle('active', Boolean(editor.isActive?.(command)));
            } catch {
                button?.classList.remove('active');
            }
        }
    }

    function showSelectionFormatBar(clientX, clientY) {
        const snapshot = captureCurrentSelection();
        if (!snapshot) {
            hideSelectionFormatBar();
            return;
        }

        state.selectionSnapshot = snapshot;
        syncSelectionFormatBar();
        const bar = elements['selection-format-bar'];
        bar.hidden = false;
        bar.style.left = '0px';
        bar.style.top = '0px';

        const margin = 10;
        const gap = 8;
        const rect = bar.getBoundingClientRect();
        const left = Math.max(
            margin,
            Math.min(window.innerWidth - rect.width - margin, clientX + gap)
        );
        const top = Math.max(
            margin,
            Math.min(window.innerHeight - rect.height - margin, clientY + gap)
        );
        bar.style.left = `${left}px`;
        bar.style.top = `${top}px`;
    }

    function hideSelectionFormatBar() {
        if (!elements['selection-format-bar']) return;
        elements['selection-format-bar'].hidden = true;
        state.selectionSnapshot = null;
    }

    function executeSelectionToolbar(command, value) {
        if (!restoreSelectionSnapshot()) {
            hideSelectionFormatBar();
            return false;
        }
        const result = executeToolbar(command, value);
        window.setTimeout(() => {
            syncSelectionFormatBar();
            getBodyEditor()?.view?.focus?.();
        }, 0);
        return result;
    }

    function showCheckpointDialog() {
        if (!state.ready) return;
        elements['checkpoint-name-input'].value = '';
        elements['checkpoint-note-input'].value = '';
        elements['checkpoint-dialog'].hidden = false;
        window.setTimeout(() => elements['checkpoint-name-input'].focus(), 30);
    }

    function hideCheckpointDialog() {
        elements['checkpoint-dialog'].hidden = true;
    }

    async function createHumanCheckpoint(event) {
        event.preventDefault();
        const name = elements['checkpoint-name-input'].value.trim();
        const note = elements['checkpoint-note-input'].value.trim();
        if (!name) {
            elements['checkpoint-name-input'].focus();
            return;
        }

        const saved = await saveDocument(false);
        if (!saved) return;

        state.checkpoints.unshift({
            id: `human-${Date.now()}`,
            source: 'human',
            name,
            note,
            createdAt: Date.now(),
        });
        hideCheckpointDialog();
        renderLineage();
        showToast('新的文脉刻点已建立', 'success');
    }

    function acceptAgentCheckpoint(payload) {
        if (!payload || typeof payload !== 'object') return;
        state.checkpoints.unshift({
            id: payload.id || `agent-${Date.now()}`,
            source: 'agent',
            name: payload.name || 'Agent 修改提案',
            note: payload.note || '等待人类审阅的协作者提交。',
            createdAt: payload.createdAt || Date.now(),
        });
        renderLineage();
    }

    function renderLineage() {
        elements['checkpoint-count'].textContent = String(state.checkpoints.length);
        if (!state.checkpoints.length) {
            elements['lineage-flow'].innerHTML = `
                <div class="lineage-empty">
                    <span class="empty-orbit"></span>
                    <strong>文脉尚未开始</strong>
                    <p>每次手动创建的文档保存点，以及未来 Agent 提交的修改保存点，都会在这里形成可回望的创作轨迹。</p>
                </div>
            `;
            return;
        }

        elements['lineage-flow'].replaceChildren(...state.checkpoints.map((checkpoint) => {
            const item = document.createElement('article');
            item.className = `checkpoint-item ${checkpoint.source}`;
            const time = new Date(checkpoint.createdAt).toLocaleString('zh-CN', {
                hour12: false,
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            });
            item.innerHTML = `
                <div class="checkpoint-meta">
                    <span class="checkpoint-source">${checkpoint.source === 'agent' ? 'AGENT 提交' : '人类刻点'}</span>
                    <time></time>
                </div>
                <h3></h3>
                <p></p>
            `;
            item.querySelector('time').textContent = time;
            item.querySelector('h3').textContent = checkpoint.name;
            item.querySelector('p').textContent = checkpoint.note || '文档完整状态已记录。';
            return item;
        }));
    }

    function toggleOutline() {
        const collapsed = document.body.classList.toggle('outline-collapsed');
        elements['outline-toggle-btn'].classList.toggle('active', !collapsed);
        elements['outline-toggle-btn'].setAttribute('aria-pressed', String(!collapsed));
    }

    function toggleLineage() {
        const collapsed = document.body.classList.toggle('lineage-collapsed');
        elements['lineage-toggle-btn'].classList.toggle('active', !collapsed);
        elements['lineage-toggle-btn'].setAttribute('aria-pressed', String(!collapsed));
    }

    function toggleFocusMode() {
        const focused = document.body.classList.toggle('focus-mode');
        elements['focus-mode-btn'].classList.toggle('active', focused);
        if (focused) {
            showToast('纯文模式 · 按 Esc 返回');
        }
    }

    function requestFind() {
        const editor = getBodyEditor();
        try {
            if (typeof state.superdoc?.openSurface === 'function') {
                state.superdoc.openSurface({ intent: 'find-replace' });
                return;
            }
            if (typeof editor?.commands?.find === 'function') {
                editor.commands.find();
                return;
            }
        } catch (error) {
            console.warn('[Scriptorium] Find surface unavailable:', error);
        }
        showToast('查找面板将在文档内核完成初始化后可用。');
    }

    function bindWindowControls() {
        elements['minimize-btn'].addEventListener('click', api.minimizeWindow);
        elements['maximize-btn'].addEventListener('click', api.maximizeWindow);
        elements['close-btn'].addEventListener('click', () => {
            runAfterUnsavedDecision(
                '关闭 Scriptorium 前，可以保存当前修改，或舍弃这些修改。',
                () => api.closeWindow()
            );
        });
    }

    function bindEditingControls() {
        elements['new-btn'].addEventListener('click', createNewDocument);
        elements['welcome-new-btn'].addEventListener('click', createNewDocument);
        elements['open-btn'].addEventListener('click', chooseOpen);
        elements['welcome-open-btn'].addEventListener('click', chooseOpen);
        elements['save-btn'].addEventListener('click', () => saveDocument(false));
        elements['save-as-btn'].addEventListener('click', () => saveDocument(true));

        document.querySelectorAll('[data-command]').forEach((control) => {
            control.addEventListener('mousedown', (event) => {
                if (control.tagName === 'BUTTON') event.preventDefault();
            });
            control.addEventListener('click', () => {
                const value = control.dataset.value;
                executeToolbar(control.dataset.command, value);
            });
        });

        elements['font-family-select'].addEventListener('change', (event) => {
            // 保留真实字体族名，确保第三方字体和 DOCX 往返导出不被替换。
            executeToolbar('font-family', event.target.value);
        });
        elements['font-size-select'].addEventListener('change', (event) => {
            executeToolbar('font-size', event.target.value);
        });
        elements['line-height-select'].addEventListener('change', (event) => {
            executeToolbar('line-height', Number(event.target.value));
        });
        elements['text-color-input'].addEventListener('change', (event) => {
            executeToolbar('text-color', event.target.value);
        });
        elements['highlight-color-input'].addEventListener('change', (event) => {
            executeToolbar('highlight-color', event.target.value);
        });
        elements['insert-table-btn'].addEventListener('click', () => {
            executeToolbar('table-insert', { rows: 3, cols: 3 });
        });
        elements['find-btn'].addEventListener('click', requestFind);

        elements['zoom-range'].addEventListener('input', (event) => updateZoomDisplay(event.target.value));
        elements['zoom-range'].addEventListener('change', settleEditorZoom);
        elements['zoom-out-btn'].addEventListener('click', () => updateZoomDisplay(state.zoom - 10, true, true));
        elements['zoom-in-btn'].addEventListener('click', () => updateZoomDisplay(state.zoom + 10, true, true));
    }

    function bindSelectionFormatControls() {
        const bar = elements['selection-format-bar'];
        bar.addEventListener('mousedown', (event) => {
            // 按钮不获取焦点，select/color 仍保留原生弹出能力；命令执行前会恢复选区。
            if (event.target.closest('button')) event.preventDefault();
        });
        bar.addEventListener('contextmenu', (event) => event.preventDefault());

        bar.querySelectorAll('[data-selection-command]').forEach((button) => {
            button.addEventListener('click', () => {
                executeSelectionToolbar(button.dataset.selectionCommand);
            });
        });
        elements['selection-font-family'].addEventListener('change', (event) => {
            executeSelectionToolbar('font-family', event.target.value);
        });
        elements['selection-font-size'].addEventListener('change', (event) => {
            executeSelectionToolbar('font-size', event.target.value);
        });
        elements['selection-text-color'].addEventListener('change', (event) => {
            executeSelectionToolbar('text-color', event.target.value);
        });

        elements['superdoc-host'].addEventListener('contextmenu', (event) => {
            if (!state.ready || !captureCurrentSelection()) return;

            // 有文字选区时由 Scriptorium 快捷条独占右键事件，避免 SuperDoc
            // 自带上下文菜单在冒泡阶段同时打开。无选区时不拦截原生菜单。
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            showSelectionFormatBar(event.clientX, event.clientY);
        }, { capture: true });

        window.addEventListener('pointerdown', (event) => {
            if (!bar.hidden && !bar.contains(event.target)) hideSelectionFormatBar();
        }, true);
        window.addEventListener('blur', hideSelectionFormatBar);
    }

    function bindZoomGestures() {
        window.addEventListener('wheel', (event) => {
            if (!(event.ctrlKey || event.metaKey) || !state.ready) return;
            const target = event.target;
            if (!(target instanceof Node) || !elements['superdoc-host'].contains(target)) return;
            event.preventDefault();

            const direction = event.deltaY < 0 ? 1 : -1;
            updateZoomDisplay(state.zoom + direction * 5);
            scheduleZoomSettlement();
        }, { passive: false, capture: true });
    }

    function bindUnsavedDialog() {
        elements['unsaved-cancel-btn'].addEventListener('click', () => {
            resolveUnsavedDecision('cancel');
        });
        elements['unsaved-discard-btn'].addEventListener('click', () => {
            resolveUnsavedDecision('discard');
        });
        elements['unsaved-save-btn'].addEventListener('click', () => {
            resolveUnsavedDecision('save');
        });
    }

    function bindLineageControls() {
        elements['outline-toggle-btn'].addEventListener('click', toggleOutline);
        elements['lineage-toggle-btn'].addEventListener('click', toggleLineage);
        elements['focus-mode-btn'].addEventListener('click', toggleFocusMode);
        elements['outline-headings-tab'].addEventListener('click', () => setOutlineTab('headings'));
        elements['outline-paragraphs-tab'].addEventListener('click', () => setOutlineTab('paragraphs'));
        elements['create-checkpoint-btn'].addEventListener('click', showCheckpointDialog);
        elements['checkpoint-cancel-btn'].addEventListener('click', hideCheckpointDialog);
        elements['checkpoint-dialog'].addEventListener('click', (event) => {
            if (event.target === elements['checkpoint-dialog']) hideCheckpointDialog();
        });
        elements['checkpoint-dialog'].querySelector('form').addEventListener('submit', createHumanCheckpoint);
    }

    function bindKeyboardShortcuts() {
        window.addEventListener('keydown', (event) => {
            const modifier = event.ctrlKey || event.metaKey;
            if (modifier && event.key.toLowerCase() === 's') {
                event.preventDefault();
                saveDocument(event.shiftKey);
                return;
            }
            if (modifier && event.key.toLowerCase() === 'o') {
                event.preventDefault();
                chooseOpen();
                return;
            }
            if (modifier && event.key.toLowerCase() === 'n') {
                event.preventDefault();
                createNewDocument();
                return;
            }
            if (modifier && event.key.toLowerCase() === 'f') {
                event.preventDefault();
                requestFind();
                return;
            }
            if (event.key === 'Escape') {
                if (!elements['unsaved-dialog'].hidden) {
                    resolveUnsavedDecision('cancel');
                } else if (!elements['selection-format-bar'].hidden) {
                    hideSelectionFormatBar();
                    getBodyEditor()?.view?.focus?.();
                } else if (!elements['checkpoint-dialog'].hidden) {
                    hideCheckpointDialog();
                } else if (document.body.classList.contains('focus-mode')) {
                    toggleFocusMode();
                }
            }
        });
    }

    function bindRuntimeEvents() {
        state.pathRequestDisposer = api.onOpenPathRequest(openPath);
        state.agentCheckpointDisposer = api.onAgentCheckpointProposed(acceptAgentCheckpoint);
        window.addEventListener('beforeunload', () => {
            destroyEditor();
            state.themeDisposer?.();
            state.pathRequestDisposer?.();
            state.agentCheckpointDisposer?.();
        });
    }

    async function initialize() {
        cacheElements();
        bindWindowControls();
        bindEditingControls();
        bindSelectionFormatControls();
        bindZoomGestures();
        bindUnsavedDialog();
        bindLineageControls();
        bindKeyboardShortcuts();
        bindRuntimeEvents();
        await initializeTheme();
        await Promise.all([
            loadSystemFonts(),
            renderRecentDocuments(),
        ]);
        renderLineage();
        updateDocumentIdentity();
        api.windowReady({ surface: 'scriptorium', version: 1 });
    }

    document.addEventListener('DOMContentLoaded', initialize);
})();