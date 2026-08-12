'use strict';

(() => {
    function createFindController(context = {}) {
        const elements = context.elements || {};
        const surfacePort = context.surfacePort;
        if (!surfacePort) {
            throw new TypeError('Find controller requires SurfacePort.');
        }

        const state = {
            query: '',
            matches: [],
            index: -1,
            sourceMarks: [],
            abortController: null,
            disposed: false,
        };

        function clearPresentation() {
            if (window.CSS?.highlights) {
                CSS.highlights.delete('scriptorium-find-match');
                CSS.highlights.delete('scriptorium-find-current');
            }
            state.sourceMarks.forEach((mark) => mark.clear?.());
            state.sourceMarks = [];
        }

        function mode() {
            return surfacePort.mode();
        }

        function sourceMode() {
            return mode() === 'source-html' || mode() === 'source-css';
        }

        function setStatus(message, empty = false) {
            if (elements['find-status']) {
                elements['find-status'].textContent = message;
                elements['find-status'].classList.toggle('empty', empty);
            }
            const available = state.matches.length > 0;
            if (elements['find-previous-btn']) {
                elements['find-previous-btn'].disabled = !available;
            }
            if (elements['find-next-btn']) {
                elements['find-next-btn'].disabled = !available;
            }
        }

        function scopeLabel() {
            if (mode() === 'source-html') {
                return context.getAdapter?.()?.kind === 'deck'
                    ? 'HTML 源码'
                    : '混合源码';
            }
            if (mode() === 'source-css') return 'CSS 源码';
            if (mode() === 'read') return '预览文字';
            return '文稿文字';
        }

        function renderedTextNodes(root) {
            const runtime = root?.querySelector('.vdoc-runtime');
            if (!runtime) return [];
            const nodes = [];
            const walker = document.createTreeWalker(
                runtime,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode(node) {
                        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
                        if (node.parentElement?.closest(
                            'style,script,noscript,'
                            + '[data-vdoc-object-resize-handle],'
                            + '[data-vdoc-md-marker]'
                        )) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        return NodeFilter.FILTER_ACCEPT;
                    },
                }
            );
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                nodes.push(node);
            }
            return nodes;
        }

        function renderedMatches(query) {
            const root = surfacePort.activeRoot();
            if (!root) return [];
            const segments = [];
            let text = '';
            let previousBlock = null;
            renderedTextNodes(root).forEach((node) => {
                const block = node.parentElement?.closest(
                    '[data-vdoc-text],[data-vdoc-edit-key]'
                ) || null;
                if (text && block !== previousBlock) text += '\n';
                const start = text.length;
                text += node.nodeValue;
                segments.push({ node, start, end: text.length });
                previousBlock = block;
            });

            const normalizedText = text.toLocaleLowerCase();
            const normalizedQuery = query.toLocaleLowerCase();
            const matches = [];
            let offset = 0;
            while (normalizedQuery
                && (offset = normalizedText.indexOf(
                    normalizedQuery,
                    offset
                )) >= 0) {
                const endOffset = offset + normalizedQuery.length;
                const startSegment = segments.find((segment) =>
                    offset >= segment.start && offset < segment.end
                );
                const endSegment = [...segments].reverse().find((segment) =>
                    endOffset > segment.start && endOffset <= segment.end
                );
                if (startSegment && endSegment) {
                    const range = document.createRange();
                    range.setStart(
                        startSegment.node,
                        offset - startSegment.start
                    );
                    range.setEnd(
                        endSegment.node,
                        endOffset - endSegment.start
                    );
                    matches.push({ type: 'rendered', range });
                }
                offset = Math.max(endOffset, offset + 1);
            }
            return matches;
        }

        function sourceMatches(query) {
            const editor = surfacePort.sourceEditor();
            const source = editor?.getValue?.() || '';
            const normalizedSource = source.toLocaleLowerCase();
            const normalizedQuery = query.toLocaleLowerCase();
            const matches = [];
            let offset = 0;
            while (normalizedQuery
                && (offset = normalizedSource.indexOf(
                    normalizedQuery,
                    offset
                )) >= 0) {
                matches.push({
                    type: 'source',
                    fromIndex: offset,
                    toIndex: offset + normalizedQuery.length,
                });
                offset = Math.max(
                    offset + normalizedQuery.length,
                    offset + 1
                );
            }
            return matches;
        }

        function presentRendered() {
            if (!window.CSS?.highlights
                || typeof window.Highlight !== 'function') {
                return;
            }
            const ranges = state.matches.map((match) => match.range);
            const current = ranges[state.index];
            CSS.highlights.set(
                'scriptorium-find-match',
                new Highlight(...ranges.filter((range) => range !== current))
            );
            CSS.highlights.set(
                'scriptorium-find-current',
                new Highlight(...(current ? [current] : []))
            );
        }

        function presentSource() {
            const editor = surfacePort.sourceEditor();
            if (!editor) return;
            state.sourceMarks = state.matches.map((match, index) =>
                editor.markText(
                    editor.posFromIndex(match.fromIndex),
                    editor.posFromIndex(match.toIndex),
                    {
                        className: index === state.index
                            ? 'cm-vdoc-find-current'
                            : 'cm-vdoc-find-match',
                    }
                )
            );
        }

        function reveal() {
            clearPresentation();
            const match = state.matches[state.index];
            if (!match) return false;
            if (match.type === 'source') {
                presentSource();
                const editor = surfacePort.sourceEditor();
                const from = editor.posFromIndex(match.fromIndex);
                const to = editor.posFromIndex(match.toIndex);
                editor.setSelection(from, to);
                editor.scrollIntoView({ from, to }, 90);
            } else {
                presentRendered();
                match.range.startContainer.parentElement?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                    inline: 'nearest',
                });
            }
            setStatus(`${state.index + 1} / ${state.matches.length}`);
            return true;
        }

        function refresh(options = {}) {
            if (elements['find-panel']?.hidden) return false;
            const query = String(elements['find-input']?.value || '');
            clearPresentation();
            state.query = query;
            state.matches = [];
            state.index = -1;
            if (elements['find-scope']) {
                elements['find-scope'].textContent = scopeLabel();
            }
            if (!query) {
                setStatus('输入以查找');
                return false;
            }
            state.matches = sourceMode()
                ? sourceMatches(query)
                : renderedMatches(query);
            if (!state.matches.length) {
                setStatus('无匹配', true);
                return false;
            }
            state.index = options.preserveIndex
                ? Math.min(
                    Math.max(0, Number(options.index) || 0),
                    state.matches.length - 1
                )
                : 0;
            return reveal();
        }

        function move(direction = 1) {
            if (!state.matches.length) return refresh();
            state.index = (
                state.index + direction + state.matches.length
            ) % state.matches.length;
            return reveal();
        }

        function open() {
            if (!elements['find-panel']) return false;
            elements['find-panel'].hidden = false;
            if (elements['find-scope']) {
                elements['find-scope'].textContent = scopeLabel();
            }
            if (elements['find-input']) {
                elements['find-input'].placeholder = sourceMode()
                    ? '查找源码'
                    : '查找文字';
            }
            refresh();
            elements['find-input']?.focus();
            elements['find-input']?.select();
            return true;
        }

        function close() {
            if (!elements['find-panel']
                || elements['find-panel'].hidden) {
                return false;
            }
            clearPresentation();
            elements['find-panel'].hidden = true;
            state.matches = [];
            state.index = -1;
            return true;
        }

        function bind() {
            state.abortController?.abort();
            state.abortController = new AbortController();
            const options = { signal: state.abortController.signal };
            elements['find-btn']?.addEventListener('click', open, options);
            elements['find-input']?.addEventListener(
                'input',
                () => refresh(),
                options
            );
            elements['find-input']?.addEventListener(
                'keydown',
                (event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    move(event.shiftKey ? -1 : 1);
                },
                options
            );
            elements['find-previous-btn']?.addEventListener(
                'click',
                () => move(-1),
                options
            );
            elements['find-next-btn']?.addEventListener(
                'click',
                () => move(1),
                options
            );
            elements['find-close-btn']?.addEventListener(
                'click',
                close,
                options
            );
            return api;
        }

        function dispose() {
            if (state.disposed) return;
            state.abortController?.abort();
            clearPresentation();
            state.matches = [];
            state.disposed = true;
        }

        const api = Object.freeze({
            open,
            close,
            refresh,
            move,
            clearPresentation,
            bind,
            dispose,
        });
        return api;
    }

    window.ScriptoriumFind = Object.freeze({
        createFindController,
    });
})();