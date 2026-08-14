'use strict';

(() => {
    function inferKind(source) {
        const value = String(source || '').trim().toLowerCase();
        const dataKind = value.match(/^data:(image|video|audio)\//)?.[1];
        if (dataKind) return dataKind;
        const path = value.split(/[?#]/, 1)[0];
        if (/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|tiff?)$/i.test(path)) {
            return 'image';
        }
        if (/\.(?:m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i.test(path)) {
            return 'video';
        }
        if (/\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|weba|wma)$/i.test(path)) {
            return 'audio';
        }
        return '';
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '';
        const milliseconds = Math.round(seconds * 1000);
        const hours = Math.floor(milliseconds / 3600000);
        const minutes = Math.floor((milliseconds % 3600000) / 60000);
        const wholeSeconds = Math.floor((milliseconds % 60000) / 1000);
        const fraction = milliseconds % 1000;
        return `${
            hours ? `${String(hours).padStart(2, '0')}:` : ''
        }${String(minutes).padStart(2, '0')}:${
            String(wholeSeconds).padStart(2, '0')
        }.${String(fraction).padStart(3, '0')}`;
    }

    function readMetadata(kind, source, timeout = 15000) {
        return new Promise((resolve) => {
            const media = kind === 'image'
                ? new Image()
                : document.createElement(kind);
            let settled = false;
            const finish = (metadata) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                media.removeAttribute?.('src');
                media.load?.();
                resolve(metadata);
            };
            const timer = window.setTimeout(
                () => finish({ available: false }),
                timeout
            );
            if (kind === 'image') {
                media.onload = () => finish({
                    available: true,
                    width: media.naturalWidth,
                    height: media.naturalHeight,
                });
                media.onerror = () => finish({ available: false });
            } else {
                media.preload = 'metadata';
                media.onloadedmetadata = () => finish({
                    available: true,
                    width: kind === 'video' ? media.videoWidth : null,
                    height: kind === 'video' ? media.videoHeight : null,
                    duration: Number.isFinite(media.duration)
                        ? media.duration
                        : null,
                });
                media.onerror = () => finish({ available: false });
            }
            media.src = source;
        });
    }

    function createMediaController(context = {}) {
        const elements = context.elements || {};
        const documentPort = context.documentPort;
        const containerModule = context.containerModule;
        const notificationPort = context.notificationPort || {};
        if (!documentPort || !containerModule) {
            throw new TypeError(
                'Media controller requires DocumentPort and VDocContainer.'
            );
        }

        let adapter = null;
        let localItems = [];
        let abortController = null;
        let disposed = false;

        function setAdapter(nextAdapter) {
            if (!nextAdapter || typeof nextAdapter.insertContent !== 'function') {
                throw new TypeError('Media controller requires a document adapter.');
            }
            adapter = nextAdapter;
            return adapter;
        }

        function currentAdapter() {
            const resolved = adapter || context.getAdapter?.();
            if (!resolved) throw new Error('No document adapter is active.');
            return resolved;
        }

        function setStatus(message, type = '') {
            const status = elements['media-dialog-status'];
            if (!status) return;
            status.textContent = message;
            status.classList.toggle('loading', type === 'loading');
            status.classList.toggle('error', type === 'error');
        }

        function mediaName(source) {
            try {
                const path = new URL(source, location.href).pathname;
                return decodeURIComponent(
                    path.split('/').filter(Boolean).pop() || ''
                );
            } catch {
                return String(source || '').split(/[\\/]/).pop()
                    ?.split(/[?#]/, 1)[0] || '';
            }
        }

        function createFigure(kind, source, metadata, description, info = {}) {
            const figure = document.createElement('figure');
            figure.className = 'vdoc-media';
            figure.dataset.vdocMedia = kind;
            figure.dataset.vdocAtomic = 'media';
            figure.dataset.vdocObject = 'media';
            figure.dataset.vdocObjectName = description || '媒体';
            figure.dataset.vdocStableId = `media-${
                context.hash?.(`${kind}\u0000${source}`)
                || crypto.randomUUID()
            }`;
            figure.contentEditable = 'false';
            figure.setAttribute('description', description);
            figure.setAttribute('aria-label', description);
            if (info.name) figure.dataset.vdocSourceName = info.name;
            if (info.type) figure.dataset.vdocSourceType = info.type;
            if (Number.isFinite(info.size)) {
                figure.dataset.vdocSourceSize = String(info.size);
            }

            const media = document.createElement(
                kind === 'image' ? 'img' : kind
            );
            const embedded = source.startsWith(
                containerModule.RESOURCE_SCHEME
            );
            if (embedded) {
                media.dataset.vdocResourceSrc = source;
                media.src = documentPort.resourceResolver()
                    ?.resolveHtml?.(source) || source;
                figure.dataset.vdocSourceKind = 'embedded-resource';
            } else {
                media.src = source;
                figure.dataset.vdocSourceKind = 'external-src';
                figure.dataset.vdocSrc = source;
            }
            media.style.display = 'block';
            media.style.maxWidth = '100%';
            media.style.margin = '0 auto';
            media.setAttribute('description', description);
            media.dataset.vdocDescription = description;
            if (kind === 'image') {
                media.alt = description;
                media.loading = 'lazy';
                media.decoding = 'async';
            } else {
                media.controls = true;
                media.preload = 'metadata';
                media.setAttribute('aria-label', description);
            }

            if (Number(metadata.width) > 0 && Number(metadata.height) > 0) {
                media.width = Number(metadata.width);
                media.height = Number(metadata.height);
                figure.dataset.vdocNativeWidth = String(metadata.width);
                figure.dataset.vdocNativeHeight = String(metadata.height);
            }
            if (Number.isFinite(Number(metadata.duration))) {
                figure.dataset.vdocDuration = String(metadata.duration);
                figure.dataset.vdocDurationText = formatDuration(
                    Number(metadata.duration)
                );
            }

            const caption = document.createElement('figcaption');
            caption.textContent = description;
            figure.append(media, caption);
            return figure;
        }

        function renderLocalItems() {
            const list = elements['media-local-list'];
            if (!list) return;
            list.hidden = !localItems.length;
            elements['media-local-count'].textContent = localItems.length
                ? `已选择 ${localItems.length} 个文件`
                : '尚未选择本地文件';
            list.replaceChildren(...localItems.map((item) => {
                const card = document.createElement('article');
                card.className = 'media-local-item';
                const name = document.createElement('strong');
                name.textContent = item.file.name;
                const description = document.createElement('textarea');
                description.placeholder = `描述“${item.file.name}”的内容`;
                description.value = item.description;
                description.addEventListener('input', () => {
                    item.description = description.value;
                });
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.textContent = '×';
                remove.addEventListener('click', () => {
                    localItems = localItems.filter(
                        (candidate) => candidate !== item
                    );
                    renderLocalItems();
                });
                card.append(name, remove, description);
                return card;
            }));
            const localMode = localItems.length > 0;
            elements['media-src-fields'].hidden = localMode;
            if (elements['media-src-input']) {
                // 隐藏 required 输入并不会退出浏览器约束校验。批量本地模式
                // 必须同步禁用 src，否则 requestSubmit() 会被不可见字段拦截。
                elements['media-src-input'].disabled = localMode;
            }
        }

        function selectFiles(files) {
            localItems = [...(files || [])].map((file) => ({
                id: crypto.randomUUID(),
                file,
                kind: String(file.type || '').match(
                    /^(image|video|audio)\//
                )?.[1] || inferKind(file.name),
                description: '',
            })).filter((item) =>
                ['image', 'video', 'audio'].includes(item.kind)
            );
            renderLocalItems();
            return localItems;
        }

        function open() {
            const status = documentPort.status();
            if (!status.ready) return false;
            localItems = [];
            elements['media-form']?.reset();
            renderLocalItems();
            setStatus('等待输入媒体地址或选择本地文件');
            elements['media-dialog'].hidden = false;
            window.setTimeout(
                () => elements['media-src-input']?.focus(),
                0
            );
            return true;
        }

        function close() {
            elements['media-dialog'].hidden = true;
            localItems = [];
            if (elements['media-local-input']) {
                elements['media-local-input'].value = '';
            }
            renderLocalItems();
            setStatus('等待输入媒体地址或选择本地文件');
        }

        async function localFigure(item) {
            const bytes = new Uint8Array(await item.file.arrayBuffer());
            const probeUrl = URL.createObjectURL(new Blob(
                [bytes],
                { type: item.file.type || 'application/octet-stream' }
            ));
            let metadata;
            try {
                metadata = await readMetadata(item.kind, probeUrl);
            } finally {
                URL.revokeObjectURL(probeUrl);
            }
            const description = item.description.trim() || item.file.name;
            const resource = await containerModule.registerResource(
                documentPort.document(),
                documentPort.resourceData(),
                {
                    bytes,
                    kind: 'media',
                    name: item.file.name,
                    mime: item.file.type,
                    description,
                    nativeWidth: metadata.width,
                    nativeHeight: metadata.height,
                    duration: metadata.duration,
                    durationText: formatDuration(Number(metadata.duration)),
                }
            );
            return createFigure(
                item.kind,
                containerModule.resourceReference(resource),
                metadata,
                description,
                {
                    name: item.file.name,
                    type: item.file.type,
                    size: item.file.size,
                }
            );
        }

        async function submit(event) {
            event?.preventDefault?.();
            const source = elements['media-src-input']?.value.trim() || '';
            if (!localItems.length && !source) {
                setStatus('请选择本地媒体或输入 src。', 'error');
                return false;
            }
            try {
                setStatus('正在读取媒体元数据…', 'loading');
                let node;
                if (localItems.length) {
                    node = document.createElement('section');
                    node.className = 'vdoc-media-batch';
                    node.dataset.vdocObject = 'media-group';
                    node.dataset.vdocObjectName =
                        `${localItems.length} 个媒体`;
                    for (const item of localItems) {
                        node.appendChild(await localFigure(item));
                    }
                } else {
                    const selected = elements['media-kind-select']?.value;
                    const kind = selected === 'auto'
                        ? inferKind(source)
                        : selected;
                    if (!['image', 'video', 'audio'].includes(kind)) {
                        setStatus('无法识别媒体类型。', 'error');
                        return false;
                    }
                    const metadata = await readMetadata(kind, source);
                    const description =
                        elements['media-description-input']?.value.trim()
                        || mediaName(source)
                        || '插入的媒体';
                    node = createFigure(
                        kind,
                        source,
                        metadata,
                        description
                    );
                }
                const inserted = currentAdapter().insertContent(
                    node.outerHTML,
                    { reason: 'media-inserted' }
                );
                if (!inserted) {
                    setStatus('当前编辑位置无法插入媒体。', 'error');
                    return false;
                }
                close();
                notificationPort.show?.('媒体已插入', 'success');
                return true;
            } catch (error) {
                setStatus(`媒体插入失败：${error.message}`, 'error');
                return false;
            }
        }

        function bind() {
            abortController?.abort();
            abortController = new AbortController();
            const options = { signal: abortController.signal };
            elements['media-local-select-btn']?.addEventListener(
                'click',
                () => elements['media-local-input']?.click(),
                options
            );
            elements['media-local-input']?.addEventListener(
                'change',
                (event) => selectFiles(event.target.files),
                options
            );
            elements['media-form']?.addEventListener(
                'submit',
                submit,
                options
            );
            elements['media-cancel-btn']?.addEventListener(
                'click',
                close,
                options
            );
            return api;
        }

        function dispose() {
            if (disposed) return;
            abortController?.abort();
            close();
            adapter = null;
            disposed = true;
        }

        const api = Object.freeze({
            setAdapter,
            open,
            close,
            submit,
            selectFiles,
            createFigure,
            readMetadata,
            dispose,
            bind,
        });
        return api;
    }

    window.ScriptoriumMedia = Object.freeze({
        inferKind,
        formatDuration,
        readMetadata,
        createMediaController,
    });
})();