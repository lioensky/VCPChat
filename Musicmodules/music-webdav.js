// Musicmodules/music-webdav.js
// WebDAV logic

function setupWebDav(app) {
    // 曲名、歌手、专辑来自文件标签，歌单名、服务器名、WebDAV 文件名来自用户或远端：拼进 HTML 前都要转义。
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // 引擎和主进程回的是「HTTP error: Server returned 401 Unauthorized」这类英文：换成一句能看懂的原因。
    const webdavReason = (error, fallback, notFound = '服务器上没有这个文件夹') => {
        const raw = String((error && error.message) || error || '')
            .replace(/^Error invoking remote method '[^']*':\s*/i, '')
            .replace(/^HTTP error:\s*/i, '').trim();
        if (!raw) return fallback;
        if (/\b404\b/.test(raw)) return notFound;
        // 主进程连 WebDAV 时 Node 抛的网络错误（connect ECONNREFUSED 等）：以前落到通用说明，拼出「服务器没有响应：连不上服务」
        if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|getaddrinfo|socket hang up|fetch failed/i.test(raw)) return '连不上服务器，检查网络或 WebDAV 地址';
        const described = typeof describeEngineError === 'function' ? describeEngineError(raw) : raw;
        if (/[\u4e00-\u9fff]/.test(described)) return described;
        return window.MusicErrorText ? window.MusicErrorText(raw, fallback) : fallback;
    };
    app.webdavReason = webdavReason;
    const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wv', '.ape', '.wma', '.aiff', '.aif', '.alac', '.dsf', '.dff']);
    const AUDIO_EXT_RE = /\.(mp3|flac|wav|ogg|m4a|aac|opus|wv|ape|wma|aiff?|alac|dsf|dff)$/i;
    const ORIGIN_RE = /^https?:\/\/[^/]+/;
    const REMOVE_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    let browseReqId = 0;
    const boundLists = new WeakSet();
    let currentEntries = [];

    const selectServer = (server) => {
        app.activeWebDavServer = server;
        app.webdavCurrentPath = '/';
        app.webdavScannedTracks = [];
        if (app.webdavScanBtn) app.webdavScanBtn.disabled = false;
        if (app.webdavImportBtn) {
            app.webdavImportBtn.disabled = true;
            app.webdavImportBtn.textContent = '导入到全部';
        }
        app.renderWebDavServerList();
        app.browseWebDav('/');
    };

    const removeServerItem = async (server, removeBtn) => {
        if (removeBtn.disabled) return;
        removeBtn.disabled = true;
        try {
            await app.api.removeWebdavServer({ id: server.id });
        } catch (err) {
            removeBtn.disabled = false;
            console.error('[Music] Failed to remove WebDAV server:', err);
            return;
        }
        if (app.activeWebDavServer && app.activeWebDavServer.id === server.id) {
            browseReqId += 1;
            app.activeWebDavServer = null;
            app.webdavScannedTracks = [];
            currentEntries = [];
            app.webdavFileList.innerHTML = '<div class="no-lyrics" style="padding:20px;">请先选择或添加一个 WebDAV 服务器</div>';
            app.webdavBreadcrumb.innerHTML = '';
            if (app.webdavScanBtn) app.webdavScanBtn.disabled = true;
            if (app.webdavImportBtn) {
                app.webdavImportBtn.disabled = true;
                app.webdavImportBtn.textContent = '导入到全部';
            }
        }
        app.webdavServers = app.webdavServers.filter((s) => s.id !== server.id);
        app.renderWebDavServerList();
    };

    const bindServerList = () => {
        const list = app.webdavServerList;
        if (!list || boundLists.has(list)) return;
        boundLists.add(list);
        list.addEventListener('click', (e) => {
            const removeBtn = e.target.closest?.('.webdav-server-remove');
            if (removeBtn && list.contains(removeBtn)) {
                e.stopPropagation();
                const id = removeBtn.dataset.id;
                const server = app.webdavServers.find((s) => String(s.id) === String(id));
                if (server) removeServerItem(server, removeBtn);
                return;
            }
            const nameEl = e.target.closest?.('.webdav-server-name');
            if (!nameEl || !list.contains(nameEl)) return;
            const row = nameEl.closest('.webdav-server-item');
            const id = row?.dataset.serverId;
            const server = app.webdavServers.find((s) => String(s.id) === String(id));
            if (server) selectServer(server);
        });
    };

    const bindFileList = () => {
        const list = app.webdavFileList;
        if (!list || boundLists.has(list)) return;
        boundLists.add(list);
        list.addEventListener('dblclick', (e) => {
            const row = e.target.closest?.('.webdav-file-item');
            if (!row || !list.contains(row)) return;
            const entry = currentEntries[Number(row.dataset.entryIdx)];
            if (!entry) return;
            if (entry.isDir) {
                if (!app.activeWebDavServer) return;
                const href = String(entry.href || '').replace(/\/$/, '');
                const base = String(app.activeWebDavServer.url || '').replace(/\/$/, '');
                const originMatch = ORIGIN_RE.exec(base);
                const origin = originMatch ? originMatch[0] : base;
                let newPath = href.replace(origin, '');
                if (!newPath.startsWith('/')) newPath = '/' + newPath;
                app.browseWebDav(newPath);
            } else if (row.classList.contains('is-audio')) {
                app.playWebDavTrack(entry);
            }
        });
    };

    const bindBreadcrumb = () => {
        const bar = app.webdavBreadcrumb;
        if (!bar || boundLists.has(bar)) return;
        boundLists.add(bar);
        bar.addEventListener('click', (e) => {
            const crumb = e.target.closest?.('.webdav-crumb');
            if (!crumb || !bar.contains(crumb)) return;
            const targetPath = crumb.dataset.path;
            if (targetPath) app.browseWebDav(targetPath);
        });
    };

    app.openWebDavModal = async () => {
        app.webdavModal.classList.add('active');
        if (!app.api?.listWebdavServers) return;
        const reqId = ++browseReqId;
        try {
            app.webdavServers = await app.api.listWebdavServers() || [];
        } catch (err) {
            console.error('[Music] Failed to list WebDAV servers:', err);
            app.webdavServers = [];
        }
        if (reqId !== browseReqId || !app.webdavModal.classList.contains('active')) return;
        app.renderWebDavServerList();
        if (app.activeWebDavServer) app.browseWebDav(app.webdavCurrentPath);
    };

    app.closeWebDavModal = () => {
        browseReqId += 1;
        app.webdavModal.classList.remove('active');
    };

    app.renderWebDavServerList = () => {
        bindServerList();
        const servers = app.webdavServers;
        if (!servers.length) {
            app.webdavServerList.innerHTML = '<div class="no-lyrics" style="padding:12px;font-size:12px;">暂无服务器</div>';
            return;
        }
        const activeId = app.activeWebDavServer ? app.activeWebDavServer.id : null;
        const parts = new Array(servers.length);
        for (let i = 0; i < servers.length; i += 1) {
            const server = servers[i];
            const idEsc = esc(server.id);
            const activeCls = activeId === server.id ? ' active' : '';
            parts[i] = `<div class="webdav-server-item${activeCls}" data-server-id="${idEsc}"><span class="webdav-server-name">${esc(server.name)}</span><button class="webdav-server-remove" data-id="${idEsc}" title="删除这个服务器" aria-label="删除这个服务器">${REMOVE_ICON_SVG}</button></div>`;
        }
        app.webdavServerList.innerHTML = parts.join('');
    };

    app.browseWebDav = async (dirPath) => {
        const targetServer = app.activeWebDavServer;
        if (!targetServer || !app.api?.listWebdavDirectory) return;
        bindFileList();
        const reqId = ++browseReqId;
        currentEntries = [];
        app.webdavFileList.innerHTML = '<div class="no-lyrics" style="padding:20px;">加载中…</div>';
        app.webdavCurrentPath = dirPath;
        app.renderWebDavBreadcrumb(dirPath);
        let result;
        try {
            result = await app.api.listWebdavDirectory({
                serverId: targetServer.id,
                url: targetServer.url,
                path: dirPath,
            });
        } catch (error) {
            result = { status: 'error', message: error };
        }
        // 这期间已经切换了服务器或点进了别的文件夹，丢弃过时结果
        if (reqId !== browseReqId || app.activeWebDavServer?.id !== targetServer.id || app.webdavCurrentPath !== dirPath) return;
        if (!result || result.status !== 'success') {
            app.webdavFileList.innerHTML = `<div class="no-lyrics" style="padding:20px;">打不开这个文件夹：${esc(webdavReason(result?.message, '服务器没有响应'))}</div>`;
            // 网络恢复后不用关掉弹窗重进，点一下再试
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'webdav-retry-btn';
            retry.textContent = '重试';
            retry.addEventListener('click', () => app.browseWebDav(dirPath));
            app.webdavFileList.firstElementChild.appendChild(retry);
            return;
        }
        const currentPath = safeDecode(dirPath.replace(/\/$/, ''));
        const rawEntries = Array.isArray(result.entries) ? result.entries : [];
        const entries = rawEntries.filter((entry) => {
            if (!entry || !entry.isDir) return Boolean(entry);
            const entryPath = safeDecode(String(entry.href || '').replace(/\/$/, ''));
            return currentPath ? entryPath !== currentPath : entryPath !== '';
        });
        if (entries.length === 0) {
            app.webdavFileList.innerHTML = '<div class="no-lyrics" style="padding:20px;">此目录为空</div>';
            return;
        }
        entries.sort((a, b) => (b.isDir - a.isDir) || String(a.name || '').localeCompare(String(b.name || '')));
        currentEntries = entries;
        const parts = new Array(entries.length);
        for (let i = 0; i < entries.length; i += 1) {
            const entry = entries[i];
            const name = String(entry.name || '');
            const dot = name.lastIndexOf('.');
            const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
            const isAudio = !entry.isDir && AUDIO_EXTS.has(ext);
            const cls = 'webdav-file-item' + (entry.isDir ? ' is-dir' : '') + (isAudio ? ' is-audio' : '');
            const icon = entry.isDir ? '📁' : (isAudio ? '🎵' : '📄');
            parts[i] = `<div class="${cls}" data-entry-idx="${i}"><span class="webdav-file-icon">${icon}</span><span class="webdav-file-name">${esc(name)}</span></div>`;
        }
        app.webdavFileList.innerHTML = parts.join('');
    };

    app.renderWebDavBreadcrumb = (dirPath) => {
        bindBreadcrumb();
        app.webdavBreadcrumb.innerHTML = '';
        const parts = dirPath.replace(/^\/$/, '').split('/').filter(Boolean);
        const frag = document.createDocumentFragment();
        const root = document.createElement('span');
        root.className = 'webdav-crumb';
        root.dataset.path = '/';
        root.textContent = app.activeWebDavServer ? app.activeWebDavServer.name : '根目录';
        frag.appendChild(root);
        let cumPath = '';
        parts.forEach((part) => {
            cumPath += '/' + part;
            const sep = document.createElement('span');
            sep.textContent = ' / ';
            sep.style.opacity = '0.5';
            frag.appendChild(sep);
            const span = document.createElement('span');
            span.className = 'webdav-crumb';
            span.dataset.path = cumPath;
            let decodedPart = part;
            try { decodedPart = decodeURIComponent(part); } catch { /* raw */ }
            span.textContent = decodedPart;
            frag.appendChild(span);
        });
        app.webdavBreadcrumb.appendChild(frag);
    };

    app.playWebDavTrack = async (entry) => {
        if (!app.activeWebDavServer || !app.api?.loadWebdavTrack) return;
        const rawName = String(entry.name || '');
        const track = {
            title: rawName.replace(AUDIO_EXT_RE, ''),
            artist: '',
            album: '',
            path: entry.url,
            isRemote: true,
            serverId: app.activeWebDavServer.id,
        };
        let idx = app.playlist.findIndex((t) => t && t.path === track.path);
        if (idx === -1) {
            idx = app.playlist.length;
            app.playlist.push(track);
            try { app.archiveView?.refresh?.(); } catch (e) { /* 档案页没开 */ }
            try { document.dispatchEvent(new CustomEvent('music-queue-change')); } catch (e) { /* 旧内核 */ }
        }
        // 走和本地曲目相同的加载流程：引擎是异步加载的，下发加载后立刻发“播放”
        // 会被随后的加载完成重置成停止，结果就是点了没声音。
        // 主进程的 music-load 会按 serverId 取凭据。
        await app.loadTrack(idx, true);
    };

    app.setupWebDavHandlers = () => {
        if (!app.api) return;
        const dialogInputs = { name: null, url: null, user: null, pass: null };
        const getDialogInput = (key, id) => {
            const cached = dialogInputs[key];
            if (cached && cached.isConnected) return cached;
            const node = document.getElementById(id);
            dialogInputs[key] = node;
            return node;
        };
        app.addWebDavBtn?.addEventListener('click', app.openWebDavModal);
        app.webdavModalClose?.addEventListener('click', app.closeWebDavModal);
        app.webdavModal?.addEventListener('click', (e) => { if (e.target === app.webdavModal) app.closeWebDavModal(); });
        app.webdavAddServerBtn?.addEventListener('click', () => {
            const nameInput = getDialogInput('name', 'webdav-server-name');
            if (nameInput) nameInput.value = '';
            const urlInput = getDialogInput('url', 'webdav-server-url');
            if (urlInput) urlInput.value = '';
            const userInput = getDialogInput('user', 'webdav-server-username');
            if (userInput) userInput.value = '';
            const passInput = getDialogInput('pass', 'webdav-server-password');
            if (passInput) passInput.value = '';
            app.webdavDialogStatus.style.color = '';
            app.webdavDialogStatus.textContent = '';
            app.webdavServerDialog.classList.add('active');
            nameInput?.focus?.();
        });
        let testReqId = 0;
        const closeServerDialog = () => {
            testReqId += 1;
            app.webdavServerDialog.classList.remove('active');
        };
        app.webdavDialogCancel?.addEventListener('click', closeServerDialog);
        app.webdavServerDialog?.addEventListener('click', (e) => { if (e.target === app.webdavServerDialog) closeServerDialog(); });
        app.webdavDialogTest?.addEventListener('click', async () => {
            if (app.webdavDialogTest.disabled) return;
            const url = getDialogInput('url', 'webdav-server-url').value.trim();
            const username = getDialogInput('user', 'webdav-server-username').value.trim();
            const password = getDialogInput('pass', 'webdav-server-password').value;
            if (!url) { app.webdavDialogStatus.style.color = '#e55'; app.webdavDialogStatus.textContent = '请输入 URL'; return; }
            const reqId = ++testReqId;
            app.webdavDialogTest.disabled = true;
            app.webdavDialogStatus.style.color = '';
            app.webdavDialogStatus.textContent = '测试中…';
            let result;
            try {
                result = await app.api.testWebdavConnection({ url, username, password });
            } catch (error) {
                result = { status: 'error', message: error };
            } finally {
                app.webdavDialogTest.disabled = false;
            }
            if (reqId !== testReqId) return;
            const ok = result?.status === 'success';
            app.webdavDialogStatus.style.color = ok ? 'var(--music-highlight)' : '#e55';
            app.webdavDialogStatus.textContent = ok ? (result.message || '连接成功') : `连接失败：${webdavReason(result?.message, '服务器没有响应', '服务器上没有这个地址，检查 URL')}`;
        });
        app.webdavDialogConfirm?.addEventListener('click', async () => {
            if (app.webdavDialogConfirm.disabled) return;
            const name = getDialogInput('name', 'webdav-server-name').value.trim();
            const url = getDialogInput('url', 'webdav-server-url').value.trim();
            const username = getDialogInput('user', 'webdav-server-username').value.trim();
            const password = getDialogInput('pass', 'webdav-server-password').value;
            if (!name || !url) { app.webdavDialogStatus.style.color = '#e55'; app.webdavDialogStatus.textContent = '名称和 URL 不能为空'; return; }
            app.webdavDialogConfirm.disabled = true;
            let server;
            try {
                server = await app.api.addWebdavServer({ name, url, username, password });
            } catch (error) {
                server = null;
            } finally {
                app.webdavDialogConfirm.disabled = false;
            }
            if (!server || !server.id) {
                // 主进程出错时：对话框留着说明一句，不把空的服务器塞进列表
                app.webdavDialogStatus.style.color = '#e55';
                app.webdavDialogStatus.textContent = '没有存上，再试一次';
                return;
            }
            app.webdavServers.push(server);
            closeServerDialog();
            app.renderWebDavServerList();
        });
        app.webdavServerDialog?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing && e.target?.tagName === 'INPUT') {
                e.preventDefault();
                app.webdavDialogConfirm?.click();
            }
        });
        let activeScanUnsub = null;
        const onWebDavKeyDown = (e) => {
            if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
            const subActive = app.webdavServerDialog?.classList.contains('active');
            const modalActive = app.webdavModal?.classList.contains('active');
            if (!subActive && !modalActive) return;
            if (document.querySelector('.dialog-overlay.music-dialog.visible:not([data-closing])')) return;
            if (subActive) {
                e.preventDefault();
                closeServerDialog();
            } else if (modalActive) {
                e.preventDefault();
                app.closeWebDavModal();
            }
        };
        document.addEventListener('keydown', onWebDavKeyDown);
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('beforeunload', () => {
                document.removeEventListener('keydown', onWebDavKeyDown);
                try { activeScanUnsub?.(); } catch (_) {}
                activeScanUnsub = null;
            }, { once: true });
        }
        app.webdavScanBtn?.addEventListener('click', async () => {
            const scanServer = app.activeWebDavServer;
            if (!scanServer || !app.api?.scanWebdavAudio) return;
            app.webdavScanBtn.disabled = true;
            app.webdavScanBtn.textContent = '扫描中…';
            try { activeScanUnsub?.(); } catch (_) {}
            const unsubscribeProgress = app.api.onWebdavScanProgress?.(({ count }) => {
                if (app.activeWebDavServer?.id === scanServer.id) {
                    app.webdavScanBtn.textContent = `已找到 ${count} 首…`;
                }
            });
            activeScanUnsub = unsubscribeProgress || null;
            try {
                const result = await app.api.scanWebdavAudio({
                    serverId: scanServer.id,
                    url: scanServer.url,
                });
                if (app.activeWebDavServer?.id !== scanServer.id) return;
                if (result && result.status === 'success') {
                    app.webdavScannedTracks = result.tracks || [];
                    app.webdavImportBtn.disabled = app.webdavScannedTracks.length === 0;
                    app.webdavImportBtn.textContent = `导入 ${app.webdavScannedTracks.length} 首到全部`;
                } else {
                    // 读不到服务器：别留着上一次的结果让人误导入。
                    app.webdavScannedTracks = [];
                    app.webdavImportBtn.disabled = true;
                    app.webdavImportBtn.textContent = `扫描失败：${webdavReason(result?.message, '服务器没有响应')}`;
                }
            } catch (err) {
                if (app.activeWebDavServer?.id !== scanServer.id) return;
                // 和服务器没响应时一样，把原因写在导入按钮上，不弹系统提示框。
                app.webdavScannedTracks = [];
                app.webdavImportBtn.disabled = true;
                app.webdavImportBtn.textContent = `扫描出错：${webdavReason(err, '原因不明')}`;
            } finally {
                if (activeScanUnsub === unsubscribeProgress) activeScanUnsub = null;
                unsubscribeProgress?.();
                app.webdavScanBtn.textContent = '扫描全部音频';
                app.webdavScanBtn.disabled = !app.activeWebDavServer;
            }
        });
        app.webdavImportBtn?.addEventListener('click', () => {
            if (!app.activeWebDavServer || app.webdavScannedTracks.length === 0) return;
            // 按地址去重：同名不同曲（各张专辑的 Intro）、本地已有同名歌，都不该把远程曲目挡掉；同一首导入两次才算重复。
            const known = new Set(app.playlist.map((p) => p && p.path).filter(Boolean));
            const newTracks = app.webdavScannedTracks
                .filter((rt) => rt && rt.path && !known.has(rt.path) && known.add(rt.path))
                .map((t) => ({ ...t, serverId: app.activeWebDavServer.id, isRemote: true }));
            if (newTracks.length > 0) {
                app.playlist.push(...newTracks);
                app.currentFilteredTracks = null;
                app.renderPlaylist(null);
                app.saveLibrary();
                try { app.archiveView?.refresh?.(); } catch (e) { /* 档案页没开 */ }
                try { document.dispatchEvent(new CustomEvent('music-queue-change')); } catch (e) { /* 旧内核 */ }
            }
            try {
                window.MusicToast?.show?.({
                    kind: newTracks.length ? 'success' : 'info',
                    message: newTracks.length ? `已导入 ${newTracks.length} 首远程曲目` : '扫描到的曲目都已经在曲库里了'
                });
            } catch (e) { /* 没有提示层 */ }
            app.closeWebDavModal();
        });
    };
}
