'use strict';

(() => {
    function createFlowEditor(context = {}) {
        const adapter = context.adapter;
        const documentPort = context.documentPort;
        const selectionPrimitives = context.selectionPrimitives;
        const compiler = context.hybridCompiler;
        const notificationPort = context.notificationPort || {};
        if (!adapter || adapter.kind !== 'flow' || !documentPort
            || !selectionPrimitives || !compiler) {
            throw new TypeError(
                'Flow editor requires a flow adapter, DocumentPort, DOM selection primitives and compiler.'
            );
        }

        const state = {
            root: null,
            abortController: null,
            activeSession: null,
            selectionRange: null,
            selectionText: '',
            domSourceMap: new WeakMap(),
            textSourceMap: new WeakMap(),
            composing: false,
            disposed: false,
        };

        function assertActive() {
            if (state.disposed) throw new Error('Flow editor has been disposed.');
        }

        function compiled(force = false) {
            return adapter.compile({ force });
        }

        function regionForShell(shell) {
            const key = shell?.dataset?.vdocEditKey;
            return compiled().editRegions.find((region) => region.key === key) || null;
        }

        function sourceForRegion(region) {
            return adapter.currentSource().slice(
                region.sourceRange.start,
                region.sourceRange.end
            );
        }

        function sourceHashValid(region) {
            return compiler.simpleHash(sourceForRegion(region)) === region.sourceHash;
        }

        function stableBoundaryCrossed(from, to) {
            const regions = compiled().editRegions || [];
            return regions.some((region) =>
                region.flowKind === 'stable-atomic'
                && from < region.sourceRange.end
                && to > region.sourceRange.start
            );
        }

        function transact(transaction = {}) {
            assertActive();
            const source = adapter.currentSource();
            const from = Math.max(
                0,
                Math.min(source.length, Number(transaction.from) || 0)
            );
            const to = Math.max(
                from,
                Math.min(source.length, Number(transaction.to) || from)
            );
            const insertion = String(transaction.insert ?? '');
            const expected = transaction.expected === undefined
                ? source.slice(from, to)
                : String(transaction.expected);

            if (source.slice(from, to) !== expected) {
                notificationPort.show?.(
                    '当前源码映射已过期，本次输入未提交。',
                    'error'
                );
                return null;
            }
            if (!transaction.allowAtomic
                && stableBoundaryCrossed(from, to)) {
                notificationPort.show?.(
                    '本次修改跨越稳定内容边界，已安全拒绝。',
                    'info'
                );
                return null;
            }

            const nextSource = source.slice(0, from)
                + insertion
                + source.slice(to);
            if (!adapter.replaceCurrentSource(nextSource, {
                reason: transaction.reason || 'flow-editor-transaction',
            })) {
                return null;
            }
            const result = Object.freeze({
                from,
                to,
                insertion,
                removed: expected,
                caret: from + insertion.length,
                delta: insertion.length - (to - from),
                revision: documentPort.status().revision,
            });
            context.historyPort?.schedule?.();
            context.onTransaction?.(result);
            return result;
        }

        function textMappingForShell(shell, region) {
            const raw = sourceForRegion(region);
            const rendered = String(shell.textContent || '');
            if (!rendered) return [];
            const mappings = [];
            let sourceCursor = 0;
            selectionPrimitives.textNodes(shell, {
                excludeSelector: [
                    'script',
                    'style',
                    'noscript',
                    '[data-vdoc-atomic]',
                    '[data-vdoc-md-marker]',
                ].join(','),
            }).forEach((node) => {
                const text = String(node.nodeValue || '');
                if (!text) return;
                let localStart = raw.indexOf(text, sourceCursor);
                if (localStart < 0) localStart = raw.indexOf(text);
                if (localStart < 0) return;
                const mapping = Object.freeze({
                    shell,
                    regionKey: region.key,
                    sourceRange: {
                        start: region.sourceRange.start + localStart,
                        end: region.sourceRange.start + localStart + text.length,
                    },
                    text,
                });
                state.textSourceMap.set(node, mapping);
                mappings.push(mapping);
                sourceCursor = localStart + text.length;
            });
            state.domSourceMap.set(shell, Object.freeze({ ...region }));
            return mappings;
        }

        function installMappings(root = state.root) {
            if (!root) return false;
            state.domSourceMap = new WeakMap();
            state.textSourceMap = new WeakMap();
            root.querySelectorAll('[data-vdoc-edit-key]').forEach((shell) => {
                const region = regionForShell(shell);
                if (region) textMappingForShell(shell, region);
            });
            return true;
        }

        function configureSourceEditor(editor, region) {
            editor.className = 'vdoc-md-live-preview';
            editor.dataset.vdocFlowSourceEditor = 'true';
            editor.dataset.vdocFlowDomain = region.type === 'markdown'
                ? 'markdown'
                : 'html';
            editor.contentEditable = 'plaintext-only';
            editor.spellcheck = false;
            editor.setAttribute('role', 'textbox');
            editor.setAttribute('aria-multiline', 'true');
            editor.setAttribute(
                'aria-label',
                region.type === 'markdown'
                    ? 'Markdown 源码编辑区'
                    : 'HTML 源码编辑区'
            );
            return editor;
        }

        function activateShell(shell, point = null) {
            const current = state.activeSession;
            if (current?.shell === shell && current.editable?.isConnected) {
                return current;
            }
            if (current) deactivateSession(current);

            const region = regionForShell(shell);
            if (!region || region.flowKind === 'stable-atomic') return null;

            let sourceOffset = region.sourceRange.start;
            if (point) {
                const target = selectionPrimitives.caretFromPoint(
                    state.root,
                    point,
                    { scope: shell }
                );
                const mappedOffset = target
                    ? sourceEndpoint(shell, target.node, target.offset)
                    : null;
                if (Number.isFinite(mappedOffset)) sourceOffset = mappedOffset;
            }

            const raw = sourceForRegion(region);
            const editor = configureSourceEditor(
                document.createElement('div'),
                region
            );
            editor.textContent = raw;
            shell.replaceChildren(editor);
            shell.dataset.vdocEditActive = 'true';
            const session = beginSession(shell, editor);
            if (!session) return null;

            try {
                editor.focus({ preventScroll: true });
            } catch {
                editor.focus();
            }
            selectionPrimitives.restoreOffsets(
                editor,
                Math.max(
                    0,
                    Math.min(raw.length, sourceOffset - region.sourceRange.start)
                )
            );
            installMappings(state.root);
            return session;
        }

        function deactivateSession(session = state.activeSession) {
            if (!session) return false;
            flushSession(session);
            if (state.activeSession === session) state.activeSession = null;
            if (!session.shell?.isConnected) return true;
            session.shell.removeAttribute('data-vdoc-edit-active');
            context.renderPort?.patchRegion?.(
                session.shell,
                session.region.ordinal
            );
            return true;
        }

        function sourceEndpoint(shell, node, offset) {
            const mapping = node?.nodeType === Node.TEXT_NODE
                ? state.textSourceMap.get(node)
                : null;
            if (mapping?.shell === shell) {
                return Math.min(
                    mapping.sourceRange.end,
                    mapping.sourceRange.start + Math.max(0, Number(offset) || 0)
                );
            }
            const region = state.domSourceMap.get(shell) || regionForShell(shell);
            if (!region) return null;
            const renderedOffset = selectionPrimitives.textOffsetWithin(
                shell,
                node,
                offset
            );
            if (!Number.isFinite(renderedOffset)) return null;
            const raw = sourceForRegion(region);
            return region.sourceRange.start + Math.min(raw.length, renderedOffset);
        }

        function sourceSelection() {
            const range = selectionPrimitives.cloneLiveRange(
                state.root,
                { expanded: true }
            ) || (
                state.selectionRange?.startContainer?.isConnected
                ? state.selectionRange.cloneRange()
                : null
            );
            if (!range || range.collapsed) return null;
            const startElement = selectionPrimitives.elementOf(range.startContainer);
            const endElement = selectionPrimitives.elementOf(range.endContainer);
            const shell = startElement?.closest?.('[data-vdoc-edit-key]');
            if (!shell
                || endElement?.closest?.('[data-vdoc-edit-key]') !== shell) {
                return null;
            }
            const region = regionForShell(shell);
            if (!region || region.flowKind === 'stable-atomic') return null;
            const sourceStart = sourceEndpoint(
                shell,
                range.startContainer,
                range.startOffset
            );
            const sourceEnd = sourceEndpoint(
                shell,
                range.endContainer,
                range.endOffset
            );
            if (!Number.isFinite(sourceStart)
                || !Number.isFinite(sourceEnd)
                || sourceEnd < sourceStart) {
                return null;
            }
            return Object.freeze({
                shell,
                region,
                range,
                sourceStart,
                sourceEnd,
                selected: range.toString(),
                domain: region.type === 'markdown' ? 'markdown' : 'html',
            });
        }

        function captureSelection() {
            const range = selectionPrimitives.cloneLiveRange(
                state.root,
                { expanded: true }
            );
            if (!range) return false;
            state.selectionRange = range;
            state.selectionText = range.toString();
            context.onSelectionChange?.(selectionState());
            return true;
        }

        function selectionState() {
            return Object.freeze({
                range: state.selectionRange,
                text: state.selectionText,
                context: sourceSelection(),
            });
        }

        function styleDeclaration(command, value) {
            const safe = String(value || '').replace(/[;"<>]/g, '');
            const declarations = {
                'font-family': `font-family:${safe}`,
                'font-size': `font-size:${safe}`,
                'text-color': `color:${safe}`,
                'highlight-color': `background-color:${safe}`,
                'line-height': `line-height:${safe}`,
                'text-align': `display:block;text-align:${safe}`,
                underline: 'text-decoration-line:underline',
            };
            return declarations[command] || '';
        }

        function executeFormatting(command, value) {
            if (command === 'image') {
                return context.mediaPort?.open?.() ?? false;
            }
            const selection = sourceSelection();
            if (!selection) {
                notificationPort.show?.('请先在正文中选择文字。', 'info');
                return false;
            }
            if (!sourceHashValid(selection.region)) {
                notificationPort.show?.(
                    '当前块源码映射已过期，请重新选择文字。',
                    'error'
                );
                return false;
            }

            const markdownDelimiters = {
                bold: '**',
                italic: '*',
                strikethrough: '~~',
            };
            if (command === 'advanced-style') {
                const className = String(value?.className || '')
                    .replace(/[^a-zA-Z0-9_-]/g, '');
                const styleId = String(value?.id || '')
                    .replace(/["<>&]/g, '');
                if (!className || !styleId) return false;
                const source = adapter.currentSource();
                const selectedSource = source.slice(
                    selection.sourceStart,
                    selection.sourceEnd
                );
                const transaction = transact({
                    from: selection.sourceStart,
                    to: selection.sourceEnd,
                    expected: selectedSource,
                    insert: `<span class="${className}" data-vdoc-style="${styleId}">${
                        selectedSource
                    }</span>`,
                    reason: 'flow-advanced-style',
                });
                if (!transaction) return false;
                context.renderPort?.patchRegion?.(
                    selection.shell,
                    selection.region.ordinal,
                    transaction.caret
                );
                return true;
            }
            if (command === 'bullet-list' || command === 'numbered-list') {
                const source = adapter.currentSource();
                const selectedSource = source.slice(
                    selection.sourceStart,
                    selection.sourceEnd
                );
                const prefix = command === 'bullet-list' ? '- ' : '1. ';
                const replacement = selectedSource
                    .split(/\r?\n/)
                    .map((line) => `${prefix}${line}`)
                    .join('\n');
                const transaction = transact({
                    from: selection.sourceStart,
                    to: selection.sourceEnd,
                    expected: selectedSource,
                    insert: replacement,
                    reason: `flow-${command}`,
                });
                if (!transaction) return false;
                context.renderPort?.patchRegion?.(
                    selection.shell,
                    selection.region.ordinal,
                    transaction.caret
                );
                return true;
            }
            const htmlTags = {
                bold: ['<strong>', '</strong>'],
                italic: ['<em>', '</em>'],
                strikethrough: ['<s>', '</s>'],
                underline: ['<u>', '</u>'],
            };
            let open;
            let close;
            if (selection.domain === 'markdown'
                && markdownDelimiters[command]) {
                open = markdownDelimiters[command];
                close = open;
            } else if (htmlTags[command]) {
                [open, close] = htmlTags[command];
            } else {
                const declaration = styleDeclaration(command, value);
                if (!declaration) return false;
                open = `<span style="${declaration}">`;
                close = '</span>';
            }

            const source = adapter.currentSource();
            const selectedSource = source.slice(
                selection.sourceStart,
                selection.sourceEnd
            );
            const transaction = transact({
                from: selection.sourceStart,
                to: selection.sourceEnd,
                expected: selectedSource,
                insert: `${open}${selectedSource}${close}`,
                reason: `flow-format-${command}`,
            });
            if (!transaction) return false;

            context.renderPort?.patchRegion?.(
                selection.shell,
                selection.region.ordinal,
                transaction.caret
            );
            return true;
        }

        function structureSource(type = 'paragraph') {
            if (/^heading-[1-6]$/.test(type)) {
                return `${'#'.repeat(Number(type.slice(-1)))} 新标题`;
            }
            if (type === 'blockquote') return '> 引文';
            if (type === 'table') {
                return [
                    '| 标题 1 | 标题 2 | 标题 3 |',
                    '| --- | --- | --- |',
                    '| 内容 | 内容 | 内容 |',
                    '| 内容 | 内容 | 内容 |',
                ].join('\n');
            }
            return '\u200B';
        }

        function insertionOffset() {
            const selection = sourceSelection();
            if (selection) return selection.sourceEnd;
            const sessionRegion = state.activeSession?.shell?.isConnected
                ? regionForShell(state.activeSession.shell)
                : null;
            return sessionRegion?.sourceRange?.end
                ?? adapter.currentSource().length;
        }

        function insertStructure(type = 'paragraph') {
            assertActive();
            const inserted = adapter.insertContent(
                structureSource(type),
                {
                    offset: insertionOffset(),
                    reason: `flow-structure-${type}`,
                }
            );
            if (!inserted) return false;
            context.historyPort?.capture?.({
                reason: `flow-structure-${type}`,
            });
            context.renderPort?.invalidate?.(
                `flow-structure-${type}`
            );
            context.renderPort?.renderEdit?.({ force: true });
            return true;
        }

        function canExecute(command) {
            if (['undo', 'redo', 'image'].includes(command)) return true;
            return Boolean(sourceSelection());
        }

        function formattingState(target = null) {
            const selection = sourceSelection();
            if (!selection) return { available: false };
            const element = selectionPrimitives.elementOf(
                target || selection.range.startContainer
            ) || selection.shell;
            const computed = getComputedStyle(element);
            const activeCommands = [];
            if (Number.parseFloat(computed.fontWeight) >= 600
                || computed.fontWeight === 'bold') {
                activeCommands.push('bold');
            }
            if (/^(?:italic|oblique)/i.test(computed.fontStyle)) {
                activeCommands.push('italic');
            }
            if (computed.textDecorationLine.includes('underline')) {
                activeCommands.push('underline');
            }
            if (computed.textDecorationLine.includes('line-through')) {
                activeCommands.push('strikethrough');
            }
            return {
                available: true,
                fontFamily: computed.fontFamily,
                fontSize: computed.fontSize,
                textColor: context.colorToHex?.(computed.color) || '',
                lineHeight: computed.lineHeight,
                activeCommands,
                selectionTarget: /^H[1-6]$/.test(element.tagName)
                    ? 'heading'
                    : 'inline',
            };
        }

        function beginSession(shell, editable) {
            const region = regionForShell(shell);
            if (!region || region.flowKind === 'stable-atomic') return null;
            const session = {
                shell,
                editable,
                region: { ...region },
                raw: sourceForRegion(region),
                previousText: String(editable.textContent || ''),
                revision: documentPort.status().revision,
            };
            state.activeSession = session;
            return session;
        }

        function refreshSessionRegion(session, transaction) {
            const nextCompiled = compiled(true);
            const expectedStart = transaction.from;
            const expectedEnd = transaction.caret;
            const nextRegion = nextCompiled.editRegions.find((region) =>
                region.sourceRange.start === expectedStart
                && region.sourceRange.end === expectedEnd
                && region.flowKind !== 'stable-atomic'
            ) || null;
            if (!nextRegion) return false;

            session.region = { ...nextRegion };
            session.raw = sourceForRegion(nextRegion);
            session.previousText = String(session.editable.textContent || '');
            session.revision = documentPort.status().revision;
            session.shell.dataset.vdocEditKey = nextRegion.key;
            session.shell.dataset.vdocEditType = nextRegion.type;
            session.shell.dataset.vdocFlowKind = nextRegion.flowKind;
            configureSourceEditor(session.editable, nextRegion);
            installMappings(state.root);
            return true;
        }

        function flushSession(session = state.activeSession) {
            if (!session?.shell?.isConnected
                || !session.editable?.isConnected) {
                return false;
            }
            const nextText = String(session.editable.textContent || '');
            if (nextText === session.previousText) return false;
            if (!sourceHashValid(session.region)) {
                notificationPort.show?.(
                    '当前编辑区源码映射已过期，输入未写入源码。',
                    'error'
                );
                return false;
            }
            const transaction = transact({
                from: session.region.sourceRange.start,
                to: session.region.sourceRange.end,
                expected: session.raw,
                insert: nextText,
                reason: 'flow-text-input',
            });
            if (!transaction) return false;
            if (!refreshSessionRegion(session, transaction)) {
                state.activeSession = null;
                context.renderPort?.invalidate?.(
                    'flow-edit-region-structure-changed'
                );
                context.renderPort?.renderEdit?.({ force: true });
            }
            return true;
        }

        function bindSurface(root) {
            assertActive();
            disposeSurface();
            state.root = root;
            installMappings(root);
            state.abortController = new AbortController();
            const options = { signal: state.abortController.signal };

            root.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || event.defaultPrevented) return;
                const shell = event.target.closest?.('[data-vdoc-edit-key]');
                if (!shell) return;
                const region = regionForShell(shell);
                if (!region || region.flowKind === 'stable-atomic') return;
                if (event.target.closest?.('[data-vdoc-flow-source-editor="true"]')) {
                    return;
                }
                event.preventDefault();
                activateShell(shell, event);
            }, options);

            root.addEventListener('focusin', (event) => {
                const editable = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const shell = event.target.closest?.('[data-vdoc-edit-key]');
                if (editable && shell
                    && state.activeSession?.editable !== editable) {
                    beginSession(shell, editable);
                }
            }, options);

            root.addEventListener('input', (event) => {
                if (event.isComposing || state.composing) return;
                const editable = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const shell = event.target.closest?.('[data-vdoc-edit-key]');
                if (!editable || !shell) return;
                const session = state.activeSession?.editable === editable
                    ? state.activeSession
                    : beginSession(shell, editable);
                flushSession(session);
            }, options);

            root.addEventListener('compositionstart', () => {
                state.composing = true;
            }, options);
            root.addEventListener('compositionend', (event) => {
                state.composing = false;
                const editable = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const shell = event.target.closest?.('[data-vdoc-edit-key]');
                if (!editable || !shell) return;
                flushSession(
                    state.activeSession?.editable === editable
                        ? state.activeSession
                        : beginSession(shell, editable)
                );
            }, options);

            root.addEventListener('focusout', (event) => {
                const editor = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const session = state.activeSession;
                if (!editor || session?.editable !== editor) return;
                window.requestAnimationFrame(() => {
                    if (state.activeSession !== session
                        || !session.shell?.isConnected
                        || session.shell.contains(state.root?.activeElement)) {
                        return;
                    }
                    deactivateSession(session);
                });
            }, options);

            root.addEventListener('mouseup', captureSelection, options);
            root.addEventListener('keyup', captureSelection, options);
            return api;
        }

        function flush() {
            return flushSession() || true;
        }

        function disposeSurface() {
            state.abortController?.abort();
            state.abortController = null;
            flushSession();
            state.root = null;
            state.activeSession = null;
            state.selectionRange = null;
            state.selectionText = '';
            state.domSourceMap = new WeakMap();
            state.textSourceMap = new WeakMap();
        }

        function dispose() {
            if (state.disposed) return;
            disposeSurface();
            state.disposed = true;
        }

        const api = Object.freeze({
            kind: 'flow-editor',
            bindSurface,
            installMappings,
            activateShell,
            deactivateSession,
            transact,
            sourceSelection,
            captureSelection,
            selectionState,
            executeFormatting,
            insertStructure,
            canExecute,
            formattingState,
            flush,
            flushSession,
            disposeSurface,
            dispose,
        });

        return api;
    }

    window.ScriptoriumFlowEditor = Object.freeze({
        createFlowEditor,
    });
})();