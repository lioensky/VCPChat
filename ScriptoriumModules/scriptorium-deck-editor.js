'use strict';

(() => {
    const INLINE_STYLES = Object.freeze({
        bold: ['fontWeight', '700'],
        italic: ['fontStyle', 'italic'],
        underline: ['textDecorationLine', 'underline'],
        strikethrough: ['textDecorationLine', 'line-through'],
    });

    function createDeckEditor(context = {}) {
        const adapter = context.adapter;
        const documentPort = context.documentPort;
        const selectionPrimitives = context.selectionPrimitives;
        const core = context.core;
        const textFragment = context.textFragment || window.ScriptoriumTextFragment;
        if (!textFragment) throw new TypeError('Deck editor requires the shared text fragment codec.');
        const notificationPort = context.notificationPort || {};
        if (!adapter || adapter.kind !== 'deck' || !documentPort
            || !selectionPrimitives || !core) {
            throw new TypeError(
                'Deck editor requires a deck adapter, DocumentPort, DOM selection primitives and VDocCore.'
            );
        }

        const inputSyncModule = context.inputSync
            || window.ScriptoriumInputSync;
        if (!inputSyncModule?.createInputSync) {
            throw new TypeError(
                'Deck editor requires the shared input synchronization module.'
            );
        }

        const state = {
            root: null,
            abortController: null,
            activeEditable: null,
            inputSync: null,
            selectionRange: null,
            selectionText: '',
            selectedBlockIds: [],
            explicitBlockSelection: false,
            blockSelectionAnchorId: null,
            pendingNodes: new Map(),
            pendingAttributes: new Map(),
            flushTimer: null,
            copiedHtml: '',
            copiedText: '',
            disposed: false,
        };

        function assertActive() {
            if (state.disposed) throw new Error('Deck editor has been disposed.');
        }

        function renderedBlocks() {
            return state.root
                ? [...state.root.querySelectorAll('[data-vdoc-text]')]
                : [];
        }

        function blocksForIds(ids = state.selectedBlockIds) {
            const selected = new Set(ids);
            return renderedBlocks().filter((block) =>
                selected.has(block.dataset.vdocText)
            );
        }

        function currentSelection() {
            return selectionPrimitives.selectionFor(state.root);
        }

        function liveRange(expanded = false) {
            return selectionPrimitives.cloneLiveRange(state.root, {
                expanded,
            });
        }

        function selectedRange(preferSaved = false) {
            if (preferSaved
                && state.selectionRange?.startContainer?.isConnected
                && state.selectionRange?.endContainer?.isConnected) {
                return state.selectionRange;
            }
            return liveRange(true) || (
                state.selectionRange?.startContainer?.isConnected
                    ? state.selectionRange
                    : null
            );
        }

        function blocksForRange(range) {
            if (!range || range.collapsed) return [];
            return renderedBlocks().filter((block) =>
                selectionPrimitives.intersectsNode(range, block)
            );
        }

        function selectedBlocks(preferSaved = false) {
            if (state.explicitBlockSelection) {
                const blocks = blocksForIds();
                if (blocks.length) return blocks;
            }
            const range = selectedRange(preferSaved);
            const ranged = blocksForRange(range);
            if (ranged.length) return ranged;
            return state.activeEditable?.isConnected
                ? [state.activeEditable]
                : [];
        }

        function presentBlockSelection() {
            const selected = new Set(state.selectedBlockIds);
            renderedBlocks().forEach((block) => {
                if (state.explicitBlockSelection
                    && selected.has(block.dataset.vdocText)) {
                    block.dataset.vdocEditorSelected = 'true';
                } else {
                    block.removeAttribute('data-vdoc-editor-selected');
                }
            });
            context.onSelectionChange?.(selectionState());
        }

        function clearBlockSelection() {
            state.explicitBlockSelection = false;
            state.selectedBlockIds = [];
            state.blockSelectionAnchorId = null;
            state.selectionRange = null;
            state.selectionText = '';
            currentSelection()?.removeAllRanges();
            presentBlockSelection();
        }

        function setBlockSelection(ids, options = {}) {
            const wanted = new Set(ids);
            const blocks = renderedBlocks().filter((block) =>
                wanted.has(block.dataset.vdocText)
            );
            if (!blocks.length) {
                clearBlockSelection();
                return false;
            }
            state.explicitBlockSelection = true;
            state.selectedBlockIds = blocks.map((block) =>
                block.dataset.vdocText
            );
            if (!options.preserveAnchor) {
                state.blockSelectionAnchorId = state.selectedBlockIds[0];
            }

            const range = document.createRange();
            range.setStartBefore(blocks[0]);
            range.setEndAfter(blocks[blocks.length - 1]);
            state.selectionRange = range.cloneRange();
            state.selectionText = blocks.map((block) =>
                block.textContent || ''
            ).join('\n');
            try {
                blocks[0].focus({ preventScroll: true });
            } catch {
                blocks[0].focus();
            }
            const selection = currentSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            state.activeEditable = blocks[0];
            presentBlockSelection();
            return true;
        }

        function selectBlockInterval(anchorId, focusId) {
            const blocks = renderedBlocks();
            const anchorIndex = blocks.findIndex((block) =>
                block.dataset.vdocText === anchorId
            );
            const focusIndex = blocks.findIndex((block) =>
                block.dataset.vdocText === focusId
            );
            if (anchorIndex < 0 || focusIndex < 0) return false;
            const start = Math.min(anchorIndex, focusIndex);
            const end = Math.max(anchorIndex, focusIndex);
            return setBlockSelection(
                blocks.slice(start, end + 1).map((block) =>
                    block.dataset.vdocText
                ),
                { preserveAnchor: true }
            );
        }

        function toggleBlock(blockId) {
            const ids = new Set(
                state.explicitBlockSelection ? state.selectedBlockIds : []
            );
            if (ids.has(blockId)) ids.delete(blockId);
            else ids.add(blockId);
            if (!state.blockSelectionAnchorId) {
                state.blockSelectionAnchorId = blockId;
            }
            return setBlockSelection([...ids], { preserveAnchor: true });
        }

        function captureSelection() {
            const range = liveRange(true);
            if (!range) return false;
            state.explicitBlockSelection = false;
            state.selectionRange = range;
            state.selectionText = range.toString();
            state.selectedBlockIds = blocksForRange(range)
                .map((block) => block.dataset.vdocText)
                .filter(Boolean);
            presentBlockSelection();
            return true;
        }

        function selectionState() {
            return Object.freeze({
                range: state.selectionRange,
                text: state.selectionText,
                blockIds: [...state.selectedBlockIds],
                explicitBlocks: state.explicitBlockSelection,
                activeEditable: state.activeEditable,
            });
        }

        function viewStatePoint(block, node, offset) {
            const fragment = textFragment.fromDOM(block);
            const affinity = node.nodeType === Node.TEXT_NODE && offset === node.length
                ? 'upstream' : 'downstream';
            return textFragment.domToLogical(fragment, node, offset, affinity);
        }

        function captureViewState() {
            const selection = currentSelection();
            const endpoint = (node, offset) => {
                const element = selectionPrimitives.elementOf(node);
                const block = element?.closest('[data-vdoc-text]');
                if (!block || !state.root?.contains(block)) return null;
                const path = [];
                for (let current = node; current !== block; current = current.parentNode) {
                    path.unshift([...current.parentNode.childNodes].indexOf(current));
                }
                return {
                    blockId: block.dataset.vdocText,
                    position: viewStatePoint(block, node, offset),
                    path,
                    nodeType: node.nodeType,
                    nodeOffset: offset,
                };
            };
            const active = state.root?.activeElement || document.activeElement;
            const scrollHost = state.root?.host?.parentElement;
            return Object.freeze({
                anchor: selection?.rangeCount
                    ? endpoint(selection.anchorNode, selection.anchorOffset) : null,
                focus: selection?.rangeCount
                    ? endpoint(selection.focusNode, selection.focusOffset) : null,
                focused: Boolean(active?.isContentEditable && state.root?.contains(active)),
                blockIds: state.explicitBlockSelection ? [...state.selectedBlockIds] : [],
                scrollLeft: Number(scrollHost?.scrollLeft) || 0,
                scrollTop: Number(scrollHost?.scrollTop) || 0,
            });
        }

        function restoreViewState(viewState) {
            if (!viewState || !state.root) return false;
            const endpoint = (saved) => {
                if (!saved?.blockId) return null;
                const block = state.root.querySelector(
                    `[data-vdoc-text="${CSS.escape(saved.blockId)}"]`
                );
                if (!block) return null;
                const fragment = textFragment.fromDOM(block);
                // A path is only a hint; the shared codec owns line and style-side positions.
                if (Array.isArray(saved.path) && Number.isInteger(saved.nodeOffset)
                    && saved.nodeOffset >= 0) {
                    let node = block;
                    for (const index of saved.path) {
                        node = Number.isInteger(index) && index >= 0
                            ? node?.childNodes[index] : null;
                        if (!node) break;
                    }
                    const length = node?.nodeType === Node.TEXT_NODE
                        ? node.length : node?.childNodes.length;
                    const point = node && textFragment.domToLogical(
                        fragment, node, saved.nodeOffset, saved.position?.affinity
                    );
                    if (node?.nodeType === saved.nodeType && saved.nodeOffset <= length
                        && (saved.position ? point?.offset === saved.position.offset : !fragment.supported)) {
                        return { block, node, offset: saved.nodeOffset };
                    }
                }
                if (!saved.position || !fragment.supported) return null;
                const point = textFragment.logicalToDOM(fragment, {
                    ...saved.position,
                    offset: Math.min(fragment.length, Math.max(0, saved.position.offset)),
                });
                return point ? { block, ...point } : null;
            };
            const anchor = endpoint(viewState.anchor);
            const focus = endpoint(viewState.focus);
            const focusHost = (block) => {
                let host = block;
                while (host?.parentElement?.isContentEditable
                    && state.root.contains(host.parentElement)) host = host.parentElement;
                host?.focus({ preventScroll: true });
                state.activeEditable = block;
            };
            let restored = false;
            if (viewState.blockIds?.length) {
                restored = setBlockSelection(viewState.blockIds);
                if (restored && viewState.focused) focusHost(state.activeEditable);
            } else if (anchor && focus) {
                if (viewState.focused) focusHost(focus.block);
                currentSelection()?.setBaseAndExtent(
                    anchor.node, anchor.offset, focus.node, focus.offset
                );
                state.selectionRange = liveRange();
                state.selectionText = state.selectionRange?.toString() || '';
                captureSelection();
                restored = true;
            }
            const scrollHost = state.root?.host?.parentElement;
            scrollHost?.scrollTo?.({
                left: Number(viewState.scrollLeft) || 0,
                top: Number(viewState.scrollTop) || 0,
                behavior: 'auto',
            });
            return restored;
        }

        function semanticInnerHtml(renderedNode) {
            const clone = renderedNode.cloneNode(true);
            context.restoreSemantics?.(clone);
            core.sanitizeFragment(clone);
            clone.querySelectorAll(
                '[contenteditable], [spellcheck], [data-vdoc-editor-selected]'
            ).forEach((node) => {
                node.removeAttribute('contenteditable');
                node.removeAttribute('spellcheck');
                node.removeAttribute('data-vdoc-editor-selected');
            });
            // Valid author HTML keeps its tags, CSS selectors and independent identities.
            const holder = document.createDocumentFragment();
            holder.appendChild(clone);
            const markup = core.serializeFragment(holder);
            const template = document.createElement('template');
            const wrappers = { TD: ['<table><tbody><tr>', '</tr></tbody></table>'],
                TH: ['<table><tbody><tr>', '</tr></tbody></table>'] };
            const [before, after] = wrappers[clone.tagName] || ['', ''];
            template.innerHTML = before + markup + after;
            const parent = before ? template.content.querySelector('tr') : template.content;
            clone.normalize();
            parent?.normalize();
            const fragment = textFragment.fromDOM(clone);
            const encoded = textFragment.encode(fragment);
            if (encoded !== null) return encoded;
            if (parent?.childNodes.length === 1 && parent.firstChild.isEqualNode(clone)) {
                return core.serializeFragment(clone);
            }
            throw new Error('此文本块含有无法无损保存的嵌套结构，请撤销最近的粘贴或输入后重试。');
        }

        function updateSourceNodes(renderedNodes, attributesById = new Map()) {
            const nodes = [...new Map(
                renderedNodes
                    .filter((node) => node?.dataset?.vdocText)
                    .map((node) => [node.dataset.vdocText, node])
            ).values()];
            if (!nodes.length) return false;

            const template = document.createElement('template');
            template.innerHTML = adapter.currentSource();
            // Prepare every block before touching source; unsupported input rejects the batch.
            let prepared;
            try {
                prepared = nodes.map(node => [node, semanticInnerHtml(node)]);
            } catch (error) {
                notificationPort.show?.(error.message, 'error');
                return null;
            }
            let changed = false;
            prepared.forEach(([renderedNode, html]) => {
                const nodeId = renderedNode.dataset.vdocText;
                const target = template.content.querySelector(
                    `[data-vdoc-text="${CSS.escape(nodeId)}"]`
                );
                if (!target) return;
                if (core.serializeFragment(target) !== html) {
                    target.innerHTML = html;
                    changed = true;
                }
                (attributesById.get(nodeId) || []).forEach((attribute) => {
                    const nextValue = attribute === 'class'
                        ? renderedNode.className
                        : renderedNode.getAttribute(attribute);
                    const currentValue = attribute === 'class'
                        ? target.className
                        : target.getAttribute(attribute);
                    if (nextValue === currentValue) return;
                    if (nextValue === null || nextValue === '') {
                        target.removeAttribute(attribute);
                    } else if (attribute === 'class') {
                        target.className = nextValue;
                    } else {
                        target.setAttribute(attribute, nextValue);
                    }
                    changed = true;
                });
            });
            if (!changed) return false;
            return adapter.replaceCurrentSource(core.serializeFragment(template.content), {
                reason: 'deck-stable-nodes-updated',
            });
        }

        function flush() {
            state.inputSync?.flush();
            window.clearTimeout(state.flushTimer);
            state.flushTimer = null;
            if (!state.pendingNodes.size) return true;
            const nodes = [...state.pendingNodes.values()];
            const attributes = new Map(state.pendingAttributes);
            const changed = updateSourceNodes(nodes, attributes);
            if (changed === null) return false;
            state.pendingNodes.clear();
            state.pendingAttributes.clear();
            if (changed) {
                context.historyPort?.capture?.();
                context.onFlush?.();
            }
            return true;
        }

        function queueNode(node, options = {}) {
            const id = node?.dataset?.vdocText;
            if (!id) return false;
            state.pendingNodes.set(id, node);
            if (options.attributes?.length) {
                const attributes = state.pendingAttributes.get(id) || new Set();
                options.attributes.forEach((attribute) =>
                    attributes.add(attribute)
                );
                state.pendingAttributes.set(id, attributes);
            }
            window.clearTimeout(state.flushTimer);
            state.flushTimer = window.setTimeout(
                flush,
                Number.isFinite(options.delay) ? options.delay : 2000
            );
            return true;
        }

        function wrapRanges(configure, preferSaved = false) {
            const range = selectedRange(preferSaved);
            if (!range || range.collapsed) return [];
            const blocks = state.explicitBlockSelection
                ? blocksForIds()
                : blocksForRange(range);
            const ranges = blocks.map((block) => {
                if (state.explicitBlockSelection) {
                    const blockRange = document.createRange();
                    blockRange.selectNodeContents(block);
                    return blockRange;
                }
                return selectionPrimitives.rangeWithinNode(range, block);
            }).filter(Boolean);
            const wrappers = [];
            [...ranges].reverse().forEach((targetRange) => {
                const wrapper = document.createElement('span');
                configure(wrapper);
                try {
                    targetRange.surroundContents(wrapper);
                } catch {
                    wrapper.appendChild(targetRange.extractContents());
                    targetRange.insertNode(wrapper);
                }
                wrappers.unshift(wrapper);
            });
            if (!wrappers.length) return [];
            const nextRange = document.createRange();
            nextRange.setStartBefore(wrappers[0]);
            nextRange.setEndAfter(wrappers.at(-1));
            state.selectionRange = nextRange.cloneRange();
            state.selectionText = nextRange.toString();
            const selection = currentSelection();
            selection.removeAllRanges();
            selection.addRange(nextRange);
            return wrappers;
        }

        function applyInlineStyle(property, value, preferSaved = false) {
            const wrappers = wrapRanges((wrapper) => {
                wrapper.style[property] = value;
            }, preferSaved);
            if (!wrappers.length) return false;
            const blocks = [...new Set(wrappers.map((wrapper) =>
                wrapper.closest('[data-vdoc-text]')
            ).filter(Boolean))];
            blocks.forEach(queueNode);
            context.onSelectionChange?.(selectionState());
            return true;
        }

        function executeFormatting(command, value, options = {}) {
            if (command === 'advanced-style') {
                const className = String(value?.className || '')
                    .replace(/[^a-zA-Z0-9_-]/g, '');
                const styleId = String(value?.id || '')
                    .replace(/["<>&]/g, '');
                if (!className || !styleId) return false;
                const range = selectedRange(options.preferSaved);
                const blocks = selectedBlocks(options.preferSaved);
                if (!range || !blocks.length) return false;
                const fullSingleBlock = blocks.length === 1
                    && range.toString().trim()
                        === blocks[0].textContent.trim();
                const useBlock = value.targets?.includes('heading')
                    || value.targets?.includes('paragraph')
                    || (
                        value.targets?.includes('block')
                        && (blocks.length > 1 || fullSingleBlock)
                    );
                if (useBlock) {
                    blocks.forEach((block) => {
                        block.classList.add(className);
                        block.dataset.vdocStyle = styleId;
                        queueNode(block, {
                            attributes: ['class', 'data-vdoc-style'],
                        });
                    });
                    return true;
                }
                const wrappers = wrapRanges((wrapper) => {
                    wrapper.className = className;
                    wrapper.dataset.vdocStyle = styleId;
                }, options.preferSaved);
                if (!wrappers.length) return false;
                [...new Set(wrappers.map((wrapper) =>
                    wrapper.closest('[data-vdoc-text]')
                ).filter(Boolean))].forEach(queueNode);
                return true;
            }
            if (command === 'bullet-list'
                || command === 'numbered-list') {
                if (!flush()) return false;
                const blocks = selectedBlocks(options.preferSaved);
                if (!blocks.length) return false;
                const list = document.createElement(
                    command === 'bullet-list' ? 'ul' : 'ol'
                );
                const first = blocks[0];
                first.before(list);
                blocks.forEach((block) => {
                    const item = document.createElement('li');
                    item.innerHTML = block.innerHTML;
                    item.dataset.vdocText = block.dataset.vdocText;
                    item.contentEditable = 'true';
                    item.spellcheck = false;
                    list.appendChild(item);
                    block.remove();
                });
                const source = document.createElement('template');
                source.innerHTML = adapter.currentSource();
                const sourceBlocks = blocks.map((block) =>
                    source.content.querySelector(
                        `[data-vdoc-text="${
                            CSS.escape(block.dataset.vdocText)
                        }"]`
                    )
                );
                if (sourceBlocks.some((block) => !block)) {
                    list.replaceWith(...blocks);
                    return false;
                }
                const sourceList = list.cloneNode(false);
                sourceBlocks[0].before(sourceList);
                sourceBlocks.forEach((block) => {
                    const item = document.createElement('li');
                    item.innerHTML = block.innerHTML;
                    item.dataset.vdocText = block.dataset.vdocText;
                    sourceList.appendChild(item);
                    block.remove();
                });
                const changed = adapter.replaceCurrentSource(
                    core.serializeFragment(source.content),
                    { reason: `deck-${command}` }
                );
                if (changed) context.historyPort?.capture?.();
                return changed;
            }
            if (INLINE_STYLES[command]) {
                const [property, styleValue] = INLINE_STYLES[command];
                return applyInlineStyle(
                    property,
                    styleValue,
                    options.preferSaved
                );
            }
            const inlineProperties = {
                'font-family': 'fontFamily',
                'font-size': 'fontSize',
                'text-color': 'color',
                'highlight-color': 'backgroundColor',
            };
            if (inlineProperties[command]) {
                return applyInlineStyle(
                    inlineProperties[command],
                    value,
                    options.preferSaved
                );
            }
            if (command === 'line-height' || command === 'text-align') {
                const blocks = selectedBlocks(options.preferSaved);
                if (!blocks.length) return false;
                blocks.forEach((block) => {
                    if (command === 'line-height') {
                        block.style.lineHeight = String(value);
                    } else {
                        block.style.textAlign = String(value);
                    }
                    queueNode(block, { attributes: ['style'] });
                });
                return true;
            }
            if (command === 'image') {
                return context.mediaPort?.open?.() ?? false;
            }
            return false;
        }

        function canExecute(command, options = {}) {
            if (command === 'image') return true;
            return selectedBlocks(options.preferSaved).length > 0
                || Boolean(selectedRange(options.preferSaved));
        }

        function formattingState(target = null) {
            const element = selectionPrimitives.elementOf(target)
                || selectionPrimitives.elementOf(
                    currentSelection()?.focusNode
                )
                || state.activeEditable;
            if (!element || !state.root?.contains(element)) {
                return { available: false };
            }
            const textElement = element.closest?.(
                '[data-vdoc-text],span,strong,b,em,i,u,s,strike'
            ) || element;
            const computed = getComputedStyle(textElement);
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
                selectionTarget: /^H[1-6]$/.test(
                    textElement.closest?.('[data-vdoc-text]')?.tagName || ''
                )
                    ? 'heading'
                    : state.explicitBlockSelection
                        ? 'block'
                        : 'inline',
            };
        }

        function cleanBlock(block) {
            const clone = block.cloneNode(true);
            context.restoreSemantics?.(clone);
            clone.querySelectorAll(
                '[contenteditable], [spellcheck], [data-vdoc-editor-selected]'
            ).forEach((node) => {
                node.removeAttribute('contenteditable');
                node.removeAttribute('spellcheck');
                node.removeAttribute('data-vdoc-editor-selected');
            });
            clone.removeAttribute('contenteditable');
            clone.removeAttribute('spellcheck');
            clone.removeAttribute('data-vdoc-editor-selected');
            return clone;
        }

        function clipboardPayload() {
            const range = selectedRange(true);
            const blocks = state.explicitBlockSelection
                ? blocksForIds()
                : blocksForRange(range);
            if (!blocks.length || (!state.explicitBlockSelection && !range)) {
                return null;
            }
            if (state.explicitBlockSelection) {
                const textContent = block => {
                    const visit = node => {
                        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
                        if (node.nodeName === 'BR') return '\n';
                        return [...node.childNodes].map(visit).join('');
                    };
                    return visit(block);
                };
                return Object.freeze({
                    html: blocks.map((block) =>
                        cleanBlock(block).outerHTML
                    ).join('\n'),
                    text: blocks.map(textContent).join('\n'),
                });
            }
            const fragment = range.cloneContents();
            const host = document.createElement('div');
            host.appendChild(fragment);
            return Object.freeze({
                html: core.sanitizeHtml(host.innerHTML),
                text: range.toString(),
            });
        }

        function rememberClipboard(payload) {
            if (!payload) return false;
            state.copiedHtml = String(payload.html || '');
            state.copiedText = String(payload.text || '');
            return true;
        }

        function structureHtml(type = 'paragraph') {
            let element = null;
            const centerHeadingMatch = /^heading-([1-6])-center(?:-html)?$/.exec(type);
            if (centerHeadingMatch) {
                const level = Number(centerHeadingMatch[1]);
                element = document.createElement(`h${level}`);
                element.style.textAlign = 'center';
                element.textContent = '新标题';
            } else if (/^heading-[1-6]$/.test(type)) {
                element = document.createElement(`h${type.slice(-1)}`);
                element.textContent = '新标题';
            } else if (type === 'blockquote') {
                element = document.createElement('blockquote');
                element.textContent = '引文';
            } else if (type === 'table') {
                element = document.createElement('table');
                element.style.width = '100%';
                element.style.borderCollapse = 'collapse';
                const body = document.createElement('tbody');
                for (let row = 0; row < 3; row += 1) {
                    const tableRow = document.createElement('tr');
                    for (let column = 0; column < 3; column += 1) {
                        const cell = document.createElement('td');
                        cell.style.padding = '.45em .65em';
                        cell.style.border = '1px solid currentColor';
                        cell.textContent = row === 0
                            ? `标题 ${column + 1}`
                            : '内容';
                        tableRow.appendChild(cell);
                    }
                    body.appendChild(tableRow);
                }
                element.appendChild(body);
            } else {
                element = document.createElement('p');
                element.innerHTML = '<br>';
            }
            return core.ensureTextNodeIds(element.outerHTML);
        }

        function insertStructure(type = 'paragraph') {
            return insertContent(
                structureHtml(type),
                { reason: `deck-structure-${type}` }
            );
        }

        function insertContent(fragment, options = {}) {
            if (!flush()) return false;
            const source = String(fragment || '');
            if (!source.trim()) return false;
            const template = document.createElement('template');
            template.innerHTML = core.ensureTextNodeIds(
                core.sanitizeHtml(source)
            );
            const blocks = [...template.content.children];
            if (!blocks.length) return false;

            const renderedAnchor = options.anchor
                || state.activeEditable
                || renderedBlocks().at(-1);
            const sourceTemplate = document.createElement('template');
            sourceTemplate.innerHTML = adapter.currentSource();
            const sourceAnchorId = renderedAnchor?.dataset?.vdocText;
            let sourceAnchor = sourceAnchorId
                ? sourceTemplate.content.querySelector(
                    `[data-vdoc-text="${CSS.escape(sourceAnchorId)}"]`
                )
                : null;
            const renderedParent = renderedAnchor?.parentElement
                || state.root?.querySelector(
                    '.vdoc-slide-scene,[data-vdoc-slide]'
                );
            const sourceParent = sourceAnchor?.parentElement
                || sourceTemplate.content.querySelector(
                    '.vdoc-slide-scene,[data-vdoc-slide]'
                )
                || sourceTemplate.content.firstElementChild;
            if (!renderedParent || !sourceParent) return false;

            blocks.forEach((block) => {
                const rendered = block.cloneNode(true);
                rendered.querySelectorAll(core.EDITABLE_SELECTOR).forEach((node) => {
                    node.contentEditable = 'true';
                    node.spellcheck = false;
                });
                if (rendered.matches(core.EDITABLE_SELECTOR)) {
                    rendered.contentEditable = 'true';
                    rendered.spellcheck = false;
                }
                if (renderedAnchor?.parentElement) renderedAnchor.after(rendered);
                else renderedParent.appendChild(rendered);
                if (sourceAnchor?.parentElement) sourceAnchor.after(block);
                else sourceParent.appendChild(block);
                sourceAnchor = block;
            });
            const changed = adapter.replaceCurrentSource(core.serializeFragment(sourceTemplate.content), {
                reason: 'deck-content-inserted',
            });
            if (changed) context.historyPort?.capture?.();
            return changed;
        }

        function bindSurface(root) {
            assertActive();
            if (!disposeSurface()) return false;
            state.root = root;
            state.inputSync = inputSyncModule.createInputSync({
                delay: 0,
                snapshot: (target) => target,
                onVisualInput: ({ target }) => {
                    // 原生 contenteditable 已经完成 DOM 修改；这里仅同步
                    // 选择状态，不触碰源码或渲染树，保证输入反馈立即可见。
                    state.activeEditable = target;
                    if (!state.explicitBlockSelection) captureSelection();
                },
                commit: ({ snapshot }) => {
                    // 源码提交与视觉输入解耦：这里只把最新节点放入
                    // deck 原有合并队列，真正写源码仍由 flush 完成。
                    queueNode(snapshot);
                },
            });
            state.abortController = new AbortController();
            const options = { signal: state.abortController.signal };

            root.querySelectorAll(core.EDITABLE_SELECTOR).forEach((editable) => {
                editable.contentEditable = 'true';
                editable.spellcheck = false;
            });

            root.addEventListener('focusin', (event) => {
                const block = event.target.closest?.('[data-vdoc-text]');
                if (block) state.activeEditable = block;
                context.onFormattingTarget?.(event.target);
            }, options);

            root.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || event.defaultPrevented) return;
                const block = event.target.closest?.('[data-vdoc-text]');
                if (!block) return;
                const blockId = block.dataset.vdocText;
                state.activeEditable = block;
                if (event.shiftKey && state.blockSelectionAnchorId) {
                    event.preventDefault();
                    selectBlockInterval(state.blockSelectionAnchorId, blockId);
                } else if (event.ctrlKey || event.metaKey) {
                    event.preventDefault();
                    toggleBlock(blockId);
                } else {
                    state.blockSelectionAnchorId = blockId;
                    if (state.explicitBlockSelection) clearBlockSelection();
                }
                context.onFormattingTarget?.(event.target);
            }, options);

            root.addEventListener('mouseup', () => {
                if (!state.explicitBlockSelection) captureSelection();
            }, options);
            root.addEventListener('keyup', captureSelection, options);

            root.addEventListener('beforeinput', (event) => {
                if (event.defaultPrevented || !event.cancelable
                    || event.isComposing
                    || event.inputType !== 'insertParagraph') return;
                const block = event.target.closest?.('[data-vdoc-text]');
                if (!block || !root.contains(block)
                    || state.inputSync?.isComposing(block)) return;
                const range = liveRange();
                if (!range || !block.contains(range.startContainer)
                    || !block.contains(range.endContainer)) return;

                // 原生 Enter 会在 P 内插入 DIV，序列化后被解析器拆成兄弟节点。
                // 文本块内使用 BR；浏览器编辑命令保留光标、行尾占位和原生撤销。
                event.preventDefault();
                document.execCommand('insertLineBreak');
                const selection = currentSelection();
                const end = block.lastElementChild;
                const previous = end?.previousElementSibling;
                if (selection?.isCollapsed && selection.anchorNode === block
                    && selection.anchorOffset === block.childNodes.length
                    && end?.tagName === 'BR' && previous?.tagName === 'BR') {
                    end.setAttribute('data-vdoc-caret-placeholder', 'true');
                }
            }, options);

            root.addEventListener('input', (event) => {
                if (event.defaultPrevented) return;
                const block = event.target.closest?.(core.EDITABLE_SELECTOR)
                    || event.target.closest?.('[data-vdoc-text]');
                if (!block) return;
                if (event.inputType === 'insertLineBreak'
                    || event.inputType === 'insertParagraph') {
                    const end = block.lastChild;
                    const previous = end?.previousSibling;
                    if (end?.nodeName === 'BR' && previous?.nodeName === 'BR') {
                        end.setAttribute('data-vdoc-caret-placeholder', 'true');
                    }
                }
                state.inputSync?.markInput(block, event);
            }, options);

            root.addEventListener('compositionstart', (event) => {
                const block = event.target.closest?.(core.EDITABLE_SELECTOR)
                    || event.target.closest?.('[data-vdoc-text]');
                if (!block) return;
                state.inputSync?.compositionStart(block, event);
            }, options);

            root.addEventListener('compositionend', (event) => {
                const block = event.target.closest?.(core.EDITABLE_SELECTOR)
                    || event.target.closest?.('[data-vdoc-text]');
                if (!block) return;
                state.inputSync?.compositionEnd(block, event);
            }, options);

            root.addEventListener('copy', (event) => {
                const payload = clipboardPayload();
                if (!payload) return;
                rememberClipboard(payload);
                event.clipboardData?.setData('text/plain', payload.text);
                event.clipboardData?.setData('text/html', payload.html);
                event.preventDefault();
            }, options);

            root.addEventListener('cut', (event) => {
                const payload = clipboardPayload();
                if (!payload) return;
                rememberClipboard(payload);
                event.clipboardData?.setData('text/plain', payload.text);
                event.clipboardData?.setData('text/html', payload.html);
                event.preventDefault();
                context.deleteSelection?.(selectionState());
            }, options);

            const escapeText = value => String(value).replace(/[&<>]/g, character => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;',
            })[character]);
            const insertClipboard = (event, transfer) => {
                if (!transfer) return;
                event.preventDefault();
                const html = transfer.getData('text/html');
                const text = transfer.getData('text/plain');
                if (html) insertContent(html, { reason: 'deck-paste' });
                else if (text) insertContent(`<p>${text.split(/\r\n|\r|\n/)
                    .map(escapeText).join('<br>')}</p>`, { reason: 'deck-paste' });
            };
            root.addEventListener('paste', event => {
                insertClipboard(event, event.clipboardData);
            }, options);
            root.addEventListener('drop', event => {
                insertClipboard(event, event.dataTransfer);
            }, options);

            return api;
        }

        function disposeSurface() {
            if (!flush()) return false;
            state.inputSync?.dispose();
            state.inputSync = null;
            state.abortController?.abort();
            state.abortController = null;
            state.root = null;
            state.activeEditable = null;
            state.selectionRange = null;
            state.selectionText = '';
            state.selectedBlockIds = [];
            state.explicitBlockSelection = false;
            state.blockSelectionAnchorId = null;
            return true;
        }

        function dispose() {
            if (state.disposed) return true;
            if (!disposeSurface()) return false;
            state.disposed = true;
            return true;
        }

        const api = Object.freeze({
            kind: 'deck-editor',
            bindSurface,
            captureSelection,
            captureViewState,
            restoreViewState,
            selectionState,
            setBlockSelection,
            clearBlockSelection,
            executeFormatting,
            insertStructure,
            canExecute,
            formattingState,
            insertContent,
            clipboardPayload,
            flush,
            updateSourceNodes,
            disposeSurface,
            dispose,
        });

        return api;
    }

    window.ScriptoriumDeckEditor = Object.freeze({
        INLINE_STYLES,
        createDeckEditor,
    });
})();
