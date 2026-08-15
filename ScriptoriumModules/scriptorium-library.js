'use strict';

((root, factory) => {
    const libraryModule = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = libraryModule;
    }
    if (root) root.ScriptoriumLibrary = libraryModule;
})(typeof window !== 'undefined' ? window : null, () => {
    const ROOT_ICONS = Object.freeze({
        notes: 'N',
        documents: 'D',
        presentations: 'P',
        fonts: 'F',
        styles: 'S',
        graphics: 'G',
    });

    function formatFileSize(value) {
        const size = Math.max(0, Number(value) || 0);
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) {
            return `${Math.max(0.1, size / 1024).toFixed(1)} KB`;
        }
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    function countFiles(entries = []) {
        return entries.reduce(
            (count, entry) => count + (
                entry?.type === 'directory'
                    ? countFiles(entry.children)
                    : entry?.type === 'file' ? 1 : 0
            ),
            0
        );
    }

    function validateLibraryResult(result) {
        if (!result?.success || !Array.isArray(result.roots)) {
            throw new Error('文档目录返回了无效数据。');
        }
        result.roots.forEach((root) => {
            if (!root || typeof root.id !== 'string'
                || typeof root.label !== 'string'
                || !Array.isArray(root.children)) {
                throw new Error('文档目录包含无效根节点。');
            }
        });
        return result;
    }

    function createChevron(documentRef) {
        const svg = documentRef.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg'
        );
        svg.classList.add('library-chevron');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const pathNode = documentRef.createElementNS(
            'http://www.w3.org/2000/svg',
            'path'
        );
        pathNode.setAttribute('d', 'm9 6 6 6-6 6');
        svg.appendChild(pathNode);
        return svg;
    }

    function createLibraryController(context = {}) {
        const persistencePort = context.persistencePort;
        const documentRef = context.document
            || (typeof document !== 'undefined' ? document : null);
        const openPath = context.openPath;
        const rootIcons = {
            ...ROOT_ICONS,
            ...(context.rootIcons || {}),
        };
        if (!persistencePort?.listDocumentLibrary || !documentRef) {
            throw new TypeError(
                'Library controller requires PersistencePort and document.'
            );
        }
        if (typeof openPath !== 'function') {
            throw new TypeError('Library controller requires openPath.');
        }

        let elements = context.elements || {};
        let bound = false;
        let disposed = false;
        let refreshListener = null;

        function setElements(nextElements) {
            elements = nextElements || {};
        }

        function renderEntries(entries = []) {
            const fragment = documentRef.createDocumentFragment();
            entries.forEach((entry) => {
                if (entry.type === 'directory') {
                    const details = documentRef.createElement('details');
                    details.className = 'library-directory';
                    const summary = documentRef.createElement('summary');
                    summary.className = 'library-directory-summary';
                    summary.appendChild(createChevron(documentRef));

                    const name = documentRef.createElement('span');
                    name.className = 'library-node-name';
                    name.textContent = entry.name;
                    const count = documentRef.createElement('span');
                    count.className = 'library-directory-count';
                    count.textContent = String(countFiles(entry.children));
                    summary.append(name, count);

                    const children = documentRef.createElement('div');
                    children.className = 'library-children';
                    children.appendChild(renderEntries(entry.children));
                    details.append(summary, children);
                    fragment.appendChild(details);
                    return;
                }
                if (entry.type !== 'file') return;

                const button = documentRef.createElement('button');
                button.type = 'button';
                button.className = 'library-file';
                button.dataset.extension = entry.extension;
                button.title = entry.path;
                button.setAttribute('role', 'treeitem');

                const badge = documentRef.createElement('span');
                badge.className = 'library-file-badge';
                badge.textContent = String(entry.extension || 'FILE')
                    .toUpperCase();

                const copy = documentRef.createElement('span');
                copy.className = 'library-file-copy';
                const name = documentRef.createElement('strong');
                name.textContent = entry.name;
                const metadata = documentRef.createElement('small');
                metadata.textContent = formatFileSize(entry.size);
                copy.append(name, metadata);
                button.append(badge, copy);
                button.addEventListener('click', () => openPath(entry.path));
                fragment.appendChild(button);
            });
            return fragment;
        }

        function renderRoot(rootNode, index) {
            const details = documentRef.createElement('details');
            details.className = 'library-root';
            details.open = true;

            const summary = documentRef.createElement('summary');
            summary.className = 'library-root-summary';
            summary.setAttribute('role', 'treeitem');
            summary.setAttribute('aria-level', '1');

            const icon = documentRef.createElement('span');
            icon.className = 'library-root-icon';
            icon.textContent = rootIcons[rootNode.id]
                || String(index + 1);

            const copy = documentRef.createElement('span');
            copy.className = 'library-root-copy';
            const label = documentRef.createElement('strong');
            label.textContent = rootNode.label;
            const description = documentRef.createElement('small');
            description.textContent = `${rootNode.description || ''} · ${
                countFiles(rootNode.children)
            } 个文件`;
            copy.append(label, description);
            summary.append(icon, copy, createChevron(documentRef));

            const children = documentRef.createElement('div');
            children.className = 'library-children';
            if (rootNode.children.length) {
                children.appendChild(renderEntries(rootNode.children));
            } else {
                const empty = documentRef.createElement('div');
                empty.className = 'library-root-empty';
                empty.textContent = '目录为空。保存或放入支持的文件后刷新。';
                children.appendChild(empty);
            }
            details.append(summary, children);
            return details;
        }

        async function refresh() {
            if (disposed) return false;
            const host = elements['document-library-tree'];
            const refreshButton = elements['library-refresh-btn'];
            if (!host) return false;
            if (refreshButton) refreshButton.disabled = true;
            host.setAttribute('aria-busy', 'true');
            try {
                const result = validateLibraryResult(
                    await persistencePort.listDocumentLibrary()
                );
                host.replaceChildren(...result.roots.map(renderRoot));
                return true;
            } catch (error) {
                const failure = documentRef.createElement('div');
                failure.className = 'library-error';
                failure.setAttribute('role', 'alert');
                failure.textContent = `文档目录读取失败：${error.message}`;
                host.replaceChildren(failure);
                return false;
            } finally {
                host.removeAttribute('aria-busy');
                if (refreshButton) refreshButton.disabled = false;
            }
        }

        function bind() {
            if (bound || disposed) return;
            const refreshButton = elements['library-refresh-btn'];
            if (refreshButton) {
                refreshListener = () => refresh();
                refreshButton.addEventListener('click', refreshListener);
            }
            bound = true;
        }

        function dispose() {
            if (disposed) return;
            if (refreshListener) {
                elements['library-refresh-btn']?.removeEventListener(
                    'click',
                    refreshListener
                );
            }
            refreshListener = null;
            bound = false;
            disposed = true;
        }

        return Object.freeze({
            setElements,
            refresh,
            bind,
            dispose,
        });
    }

    return Object.freeze({
        ROOT_ICONS,
        formatFileSize,
        countFiles,
        validateLibraryResult,
        createLibraryController,
    });
});