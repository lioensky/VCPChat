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

    app.openWebDavModal = async () => {
        app.webdavModal.classList.add('active');
        if (!app.api?.listWebdavServers) return;
        try {
            app.webdavServers = await app.api.listWebdavServers() || [];
        } catch (err) {
            console.error('[Music] Failed to list WebDAV servers:', err);
            app.webdavServers = [];
        }
        app.renderWebDavServerList();
        if (app.activeWebDavServer) app.browseWebDav(app.webdavCurrentPath);
    };

    app.closeWebDavModal = () => { app.webdavModal.classList.remove('active'); };

    app.renderWebDavServerList = () => {
        app.webdavServerList.innerHTML = '';
        if (app.webdavServers.length === 0) {
            app.webdavServerList.innerHTML = '<div class="no-lyrics" style="padding:12px;font-size:12px;">暂无服务器</div>';
            return;
        }
        app.webdavServers.forEach((server) => {
            const div = document.createElement('div');
            div.className = 'webdav-server-item' + (app.activeWebDavServer && app.activeWebDavServer.id === server.id ? ' active' : '');
            div.innerHTML = `<span class="webdav-server-name">${esc(server.name)}</span><button class="webdav-server-remove" data-id="${esc(server.id)}" title="删除这个服务器" aria-label="删除这个服务器"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
            div.querySelector('.webdav-server-name').addEventListener('click', () => {
                app.activeWebDavServer = server;
                app.webdavCurrentPath = '/';
                app.webdavScannedTracks = [];
                app.webdavScanBtn.disabled = false;
                app.webdavImportBtn.disabled = true;
                app.renderWebDavServerList();
                app.browseWebDav('/');
            });
            div.querySelector('.webdav-server-remove').addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await app.api.removeWebdavServer({ id: server.id });
                } catch (err) {
                    console.error('[Music] Failed to remove WebDAV server:', err);
                    return;
                }
                if (app.activeWebDavServer && app.activeWebDavServer.id === server.id) {
                    app.activeWebDavServer = null;
                    app.webdavFileList.innerHTML = '<div class="no-lyrics" style="padding:20px;">请先选择或添加一个 WebDAV 服务器</div>';
                    app.webdavBreadcrumb.innerHTML = '';
                    app.webdavScanBtn.disabled = true;
                    app.webdavImportBtn.disabled = true;
                }
                app.webdavServers = app.webdavServers.filter((s) => s.id !== server.id);
                app.renderWebDavServerList();
            });
            app.webdavServerList.appendChild(div);
        });
    };

    app.browseWebDav = async (dirPath) => {
        if (!app.activeWebDavServer || !app.api?.listWebdavDirectory) return;
        app.webdavFileList.innerHTML = '<div class="no-lyrics" style="padding:20px;">加载中…</div>';
        app.webdavCurrentPath = dirPath;
        app.renderWebDavBreadcrumb(dirPath);
        let result;
        try {
            result = await app.api.listWebdavDirectory({
                serverId: app.activeWebDavServer.id,
                url: app.activeWebDavServer.url,
                path: dirPath,
            });
        } catch (error) {
            result = { status: 'error', message: error };
        }
        if (app.webdavCurrentPath !== dirPath) return; // 这期间已经点进别的文件夹
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
        const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
        const entries = result.entries.filter((entry) => {
            const entryPath = safeDecode(entry.href.replace(/\/$/, ''));
            const currentPath = dirPath.replace(/\/$/, '');
            return !entryPath.endsWith(currentPath) || (entry.isDir && entry.href !== dirPath);
        });
        if (entries.length === 0) {
            app.webdavFileList.innerHTML = '<div class="no-lyrics" style="padding:20px;">此目录为空</div>';
            return;
        }
        const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wv', '.ape']);
        app.webdavFileList.innerHTML = '';
        entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
        const fragment = document.createDocumentFragment();
        entries.forEach((entry) => {
            const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop().toLowerCase() : '';
            const isAudio = !entry.isDir && AUDIO_EXTS.has(ext);
            const div = document.createElement('div');
            div.className = 'webdav-file-item' + (entry.isDir ? ' is-dir' : '') + (isAudio ? ' is-audio' : '');
            div.innerHTML = `<span class="webdav-file-icon">${entry.isDir ? '📁' : (isAudio ? '🎍' : '📄')}</span><span class="webdav-file-name">${esc(entry.name)}</span>`;
            if (entry.isDir) {
                div.addEventListener('dblclick', () => {
                    const href = entry.href.replace(/\/$/, '');
                    const base = app.activeWebDavServer.url.replace(/\/$/, '');
                    const originMatch = base.match(/^https?:\/\/[^/]+/);
                    const origin = originMatch ? originMatch[0] : base;
                    let newPath = href.replace(origin, '');
                    if (!newPath.startsWith('/')) newPath = '/' + newPath;
                    app.browseWebDav(newPath);
                });
            } else if (isAudio) {
                div.addEventListener('dblclick', () => app.playWebDavTrack(entry));
            }
            fragment.appendChild(div);
        });
        app.webdavFileList.appendChild(fragment);
    };

    app.renderWebDavBreadcrumb = (dirPath) => {
        app.webdavBreadcrumb.innerHTML = '';
        const parts = dirPath.replace(/^\/$/, '').split('/').filter(Boolean);
        const root = document.createElement('span');
        root.className = 'webdav-crumb';
        root.textContent = app.activeWebDavServer ? app.activeWebDavServer.name : '根目录';
        root.addEventListener('click', () => app.browseWebDav('/'));
        app.webdavBreadcrumb.appendChild(root);
        let cumPath = '';
        parts.forEach((part) => {
            cumPath += '/' + part;
            const sep = document.createElement('span');
            sep.textContent = ' / ';
            sep.style.opacity = '0.5';
            app.webdavBreadcrumb.appendChild(sep);
            const span = document.createElement('span');
            span.className = 'webdav-crumb';
            let decodedPart = part;
            try { decodedPart = decodeURIComponent(part); } catch { /* raw */ }
            span.textContent = decodedPart;
            const snapPath = cumPath;
            span.addEventListener('click', () => app.browseWebDav(snapPath));
            app.webdavBreadcrumb.appendChild(span);
        });
    };

    app.playWebDavTrack = async (entry) => {
        if (!app.activeWebDavServer || !app.api?.loadWebdavTrack) return;
        const track = {
            title: entry.name.replace(/\.[^.]+$/, ''),
            artist: '',
            album: '',
            path: entry.url,
            isRemote: true,
            serverId: app.activeWebDavServer.id,
        };
        if (!app.playlist.some((t) => t.path === track.path)) app.playlist.push(track);
        const idx = app.playlist.findIndex((t) => t.path === track.path);
        // 走和本地曲目相同的加载流程：引擎是异步加载的，下发加载后立刻发“播放”
        // 会被随后的加载完成重置成停止，结果就是点了没声音。
        // 主进程的 music-load 会按 serverId 取凭据。
        await app.loadTrack(idx, true);
    };

    app.setupWebDavHandlers = () => {
        if (!app.api) return;
        app.addWebDavBtn?.addEventListener('click', app.openWebDavModal);
        app.webdavModalClose?.addEventListener('click', app.closeWebDavModal);
        app.webdavModal?.addEventListener('click', (e) => { if (e.target === app.webdavModal) app.closeWebDavModal(); });
        app.webdavAddServerBtn?.addEventListener('click', () => {
            document.getElementById('webdav-server-name').value = '';
            document.getElementById('webdav-server-url').value = '';
            document.getElementById('webdav-server-username').value = '';
            document.getElementById('webdav-server-password').value = '';
            app.webdavDialogStatus.textContent = '';
            app.webdavServerDialog.classList.add('active');
        });
        app.webdavDialogCancel?.addEventListener('click', () => app.webdavServerDialog.classList.remove('active'));
        app.webdavDialogTest?.addEventListener('click', async () => {
            const url = document.getElementById('webdav-server-url').value.trim();
            const username = document.getElementById('webdav-server-username').value.trim();
            const password = document.getElementById('webdav-server-password').value;
            if (!url) { app.webdavDialogStatus.textContent = '请输入 URL'; return; }
            app.webdavDialogStatus.style.color = '';
            app.webdavDialogStatus.textContent = '测试中…';
            let result;
            try {
                result = await app.api.testWebdavConnection({ url, username, password });
            } catch (error) {
                result = { status: 'error', message: error };
            }
            const ok = result?.status === 'success';
            app.webdavDialogStatus.style.color = ok ? 'var(--music-highlight)' : '#e55';
            app.webdavDialogStatus.textContent = ok ? (result.message || '连接成功') : `连接失败：${webdavReason(result?.message, '服务器没有响应', '服务器上没有这个地址，检查 URL')}`;
        });
        app.webdavDialogConfirm?.addEventListener('click', async () => {
            if (app.webdavDialogConfirm.disabled) return;
            const name = document.getElementById('webdav-server-name').value.trim();
            const url = document.getElementById('webdav-server-url').value.trim();
            const username = document.getElementById('webdav-server-username').value.trim();
            const password = document.getElementById('webdav-server-password').value;
            if (!name || !url) { app.webdavDialogStatus.textContent = '名称和 URL 不能为空'; return; }
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
            app.webdavServerDialog.classList.remove('active');
            app.renderWebDavServerList();
        });
        app.webdavScanBtn?.addEventListener('click', async () => {
            const scanServer = app.activeWebDavServer;
            if (!scanServer || !app.api?.scanWebdavAudio) return;
            app.webdavScanBtn.disabled = true;
            app.webdavScanBtn.textContent = '扫描中…';
            const unsubscribeProgress = app.api.onWebdavScanProgress?.(({ count }) => {
                if (app.activeWebDavServer?.id === scanServer.id) {
                    app.webdavScanBtn.textContent = `已找到 ${count} 首…`;
                }
            });
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
                unsubscribeProgress?.();
                app.webdavScanBtn.textContent = '扫描全部音频';
                app.webdavScanBtn.disabled = !app.activeWebDavServer;
            }
        });
        app.webdavImportBtn?.addEventListener('click', () => {
            if (app.webdavScannedTracks.length === 0) return;
            // 按地址去重：同名不同曲（各张专辑的 Intro）、本地已有同名歌，都不该把远程曲目挡掉；同一首导入两次才算重复。
            const known = new Set(app.playlist.map((p) => p && p.path).filter(Boolean));
            const newTracks = app.webdavScannedTracks
                .filter((rt) => rt && rt.path && !known.has(rt.path) && known.add(rt.path))
                .map((t) => ({ ...t, serverId: app.activeWebDavServer.id, isRemote: true }));
            app.playlist.push(...newTracks);
            app.currentFilteredTracks = null;
            app.renderPlaylist(null);
            app.saveLibrary();
            app.closeWebDavModal();
        });
    };
}
