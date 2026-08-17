'use strict';

(() => {
    function createFlowEditor(context = {}) {
        const adapter = context.adapter;
        const documentPort = context.documentPort;
        const selectionPrimitives = context.selectionPrimitives;
        const compiler = context.hybridCompiler;
        const notificationPort = context.notificationPort || {};
        const inputSyncModule = context.inputSync
            || window.ScriptoriumInputSync;
        if (!adapter || adapter.kind !== 'flow' || !documentPort
            || !selectionPrimitives || !compiler
            || !inputSyncModule?.createInputSync) {
            throw new TypeError(
                'Flow editor requires a flow adapter, DocumentPort, DOM selection primitives and compiler.'
            );
        }

        const state = {
            root: null,
            abortController: null,
            inputSync: null,
            activeSession: null,
            selectionRange: null,
            selectionText: '',
            domSourceMap: new WeakMap(),
            textSourceMap: new WeakMap(),
            composing: false,
            compositionSession: null,
            compositionCommit: null,
            compositionCommitTimer: 0,
            compositionEpoch: 0,
            compositionRetiredEditable: null,
            compositionCommitFrame: 0,
            textInputFlushTimer: 0,
            enterInputGuardEditable: null,
            enterInputGuardCount: 0,
            enterInputGuardTimer: 0,
            boundaryFocusFrame: 0,
            deferredRender: null,
            disposed: false,
        };

        function assertActive() {
            if (state.disposed) throw new Error('Flow editor has been disposed.');
        }

        function inputPending() {
            return Boolean(state.composing || state.compositionCommit);
        }

        function deferRender(render) {
            if (!inputPending() || typeof render !== 'function') return false;
            // 多次失效只需在输入稳定后执行最后一次全量渲染。保留活动
            // contenteditable 的 DOM 身份，避免外部刷新关闭 IME 候选窗。
            state.deferredRender = render;
            return true;
        }

        function releaseDeferredRender() {
            const render = state.deferredRender;
            state.deferredRender = null;
            if (typeof render !== 'function' || state.disposed) return false;
            render();
            return true;
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

        function inlineHtmlTagRecords(raw) {
            const source = String(raw || '');
            const codeSpans = [];
            const codePattern = /(`+)([\s\S]*?)\1/g;
            let codeMatch;
            while ((codeMatch = codePattern.exec(source))) {
                codeSpans.push({
                    start: codeMatch.index,
                    end: codeMatch.index + codeMatch[0].length,
                });
            }
            const allowed = new Set([
                // 行内 HTML 与静态块级 HTML 共用同一套无损标签骨架。
                // script/style 以及媒体、表单控件不在此开放：它们要么拥有
                // 独立原子区域，要么不应被普通文字输入会话接管。
                'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi',
                'bdo', 'big', 'blockquote', 'br', 'caption', 'cite',
                'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn',
                'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font',
                'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
                'hgroup', 'hr', 'i', 'ins', 'kbd', 'li', 'main', 'mark',
                'menu', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby',
                's', 'samp', 'section', 'small', 'span', 'strike',
                'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
                'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul',
                'var', 'wbr',
            ]);
            const voidTags = new Set(['br', 'col', 'hr', 'wbr']);
            const records = [];
            const pattern = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
            let match;
            while ((match = pattern.exec(source))) {
                const matchEnd = match.index + match[0].length;
                if (codeSpans.some((span) =>
                    match.index < span.end && matchEnd > span.start
                )) {
                    continue;
                }
                const tag = String(match[1] || '').toLowerCase();
                if (!allowed.has(tag)) continue;
                records.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    source: match[0],
                    tag,
                    closing: /^<\//.test(match[0]),
                    selfClosing: voidTags.has(tag) || /\/\s*>$/.test(match[0]),
                });
            }
            return records;
        }

        function concealedMarker(
            text,
            kind = 'source',
            start = null,
            end = null,
            extra = {}
        ) {
            const marker = document.createElement('span');
            marker.className =
                `vdoc-md-marker vdoc-md-marker-${kind} vdoc-md-marker-concealed`;
            marker.dataset.vdocMdMarker = kind;
            if (Number.isFinite(start)) {
                marker.dataset.vdocSourceStart = String(start);
            }
            if (Number.isFinite(end)) {
                marker.dataset.vdocSourceEnd = String(end);
            }
            if (extra.tag) marker.dataset.vdocHtmlTag = extra.tag;
            if (extra.closing) marker.dataset.vdocHtmlClosing = 'true';
            if (extra.selfClosing) marker.dataset.vdocHtmlSelfClosing = 'true';
            marker.textContent = String(text || '');
            return marker;
        }

        function setMarkerVisible(marker, visible) {
            marker.classList.toggle('vdoc-md-marker-concealed', !visible);
            marker.style.setProperty(
                'display',
                visible ? 'inline' : 'none',
                'important'
            );
        }

        function editableDomText(root) {
            if (!root) return '';
            const blockTags = new Set([
                'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV',
                'FOOTER', 'HEADER', 'H1', 'H2', 'H3', 'H4', 'H5',
                'H6', 'LI', 'MAIN', 'P', 'SECTION',
            ]);
            let output = '';
            const visit = (node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    output += String(node.nodeValue || '');
                    return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                if (node.dataset?.vdocMdMarker === 'terminal-line-ending') {
                    return;
                }
                if (node.tagName === 'BR') {
                    output += '\n';
                    return;
                }
                const block = blockTags.has(node.tagName);
                if (block && output && !output.endsWith('\n')) output += '\n';
                node.childNodes.forEach(visit);
                if (block && output && !output.endsWith('\n')) output += '\n';
            };
            root.childNodes.forEach(visit);
            const visible = output.replace(/\n$/, '');
            const terminalLineEnding = root.querySelector?.(
                '[data-vdoc-md-marker="terminal-line-ending"]'
            )?.textContent || '';
            return visible + terminalLineEnding;
        }

        function editableSourceText(editable) {
            if (!editable) return '';
            if (editable.dataset?.vdocFlowDomain === 'html') {
                // 静态 HTML 编辑树把标签源码放在隐藏 marker 中，把可见文字
                // 放在对应的语义元素中。textContent 按 DOM 顺序连接二者，恰好
                // 还原原始 HTML；不能在这里按块元素注入视觉换行。
                return String(editable.textContent || '');
            }
            if (!editable.classList?.contains('vdoc-md-live-preview-run')) {
                return editableDomText(editable);
            }

            const lines = [...editable.children].filter((child) =>
                child.classList?.contains('vdoc-md-live-preview-line')
            );
            if (!lines.length) return editableDomText(editable);
            return lines.map((line) => editableDomText(line)).join('\n');
        }

        function editorSelectionOffsets(editable) {
            const range = selectionPrimitives.cloneLiveRange(
                editable?.getRootNode?.() || state.root
            );
            if (!range || !editable?.contains(range.startContainer)
                || !editable.contains(range.endContainer)) {
                return null;
            }
            if (!editable.classList?.contains('vdoc-md-live-preview-run')) {
                return selectionPrimitives.rangeOffsetsWithin(editable, range);
            }

            const lines = [...editable.children].filter((child) =>
                child.classList?.contains('vdoc-md-live-preview-line')
            );
            const endpoint = (node, offset) => {
                const element = selectionPrimitives.elementOf(node);
                const line = element?.closest?.('.vdoc-md-live-preview-line');
                const lineIndex = lines.indexOf(line);
                if (lineIndex < 0) return null;
                const local = selectionPrimitives.textOffsetWithin(
                    line,
                    node,
                    offset
                );
                if (!Number.isFinite(local)) return null;
                const prefix = lines.slice(0, lineIndex)
                    .reduce((length, candidate) =>
                        length + editableDomText(candidate).length + 1,
                    0);
                return prefix + Math.min(
                    editableDomText(line).length,
                    local
                );
            };
            const start = endpoint(range.startContainer, range.startOffset);
            const end = endpoint(range.endContainer, range.endOffset);
            if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
            return Object.freeze({
                start: Math.min(start, end),
                end: Math.max(start, end),
                collapsed: range.collapsed,
            });
        }

        function resilientEditorSelectionOffsets(editable) {
            const strict = editorSelectionOffsets(editable);
            if (strict) return strict;
            if (!editable?.isConnected
                || editable.getRootNode()?.activeElement !== editable) {
                return null;
            }

            // Chromium 在 contenteditable DOM 被同步重建后，可能短暂保留
            // “一个端点在新树、另一个端点在旧树”的 Selection。此时界面
            // 仍显示光标，但 cloneLiveRange() 会正确拒绝该跨树 Range。
            // 对已聚焦编辑器只采用仍连接的有效端点，恢复为折叠光标。
            const selection = selectionPrimitives.selectionFor(
                editable.getRootNode()
            );
            const candidates = [
                [selection?.focusNode, selection?.focusOffset],
                [selection?.anchorNode, selection?.anchorOffset],
            ];
            for (const [node, offset] of candidates) {
                if (!node || (node !== editable && !editable.contains(node))) {
                    continue;
                }
                const textOffset = selectionPrimitives.textOffsetWithin(
                    editable,
                    node,
                    offset
                );
                if (!Number.isFinite(textOffset)) continue;
                const length = editableSourceText(editable).length;
                const caret = Math.max(0, Math.min(length, textOffset));
                selectionPrimitives.restoreOffsets(editable, caret);
                return Object.freeze({
                    start: caret,
                    end: caret,
                    collapsed: true,
                });
            }
            return null;
        }

        function pastedMarkdownText(value) {
            return String(value || '').replace(/\r\n?/g, '\n');
        }

        function refreshLocalMarkers(session, sourceStart, sourceEnd = sourceStart) {
            if (!session?.editable?.isConnected) return false;
            if (session.region?.type === 'html') {
                // 静态 HTML 的标签 marker 是无损序列化骨架，不是面向用户的
                // Markdown 语法提示。即使光标位于标签包围的文字内，也始终
                // 保持隐藏，避免渲染态文字编辑退化成 HTML 源码编辑。
                session.editable.querySelectorAll('[data-vdoc-md-marker]')
                    .forEach((marker) => setMarkerVisible(marker, false));
                return true;
            }
            const raw = editableSourceText(session.editable);
            const start = Math.max(0, Math.min(raw.length, Number(sourceStart) || 0));
            const end = Math.max(
                start,
                Math.min(raw.length, Number(sourceEnd) || start)
            );
            const lineStart = raw.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
            const lineBreak = raw.indexOf('\n', end);
            const lineEnd = lineBreak < 0 ? raw.length : lineBreak;
            const markers = [...session.editable.querySelectorAll(
                '[data-vdoc-md-marker]'
            )].map((node) => ({
                node,
                kind: node.dataset.vdocMdMarker,
                start: Number(node.dataset.vdocSourceStart),
                end: Number(node.dataset.vdocSourceEnd),
                tag: node.dataset.vdocHtmlTag || '',
                closing: node.dataset.vdocHtmlClosing === 'true',
                selfClosing: node.dataset.vdocHtmlSelfClosing === 'true',
            })).filter((record) =>
                Number.isFinite(record.start) && Number.isFinite(record.end)
            );
            const inlineKinds = new Set([
                'strong',
                'emphasis',
                'italic',
                'strikethrough',
                'code',
                'html-tag',
            ]);
            const visible = new Set();

            markers.forEach((marker) => {
                if (marker.kind === 'paragraph-break') {
                    // 回车占位符必须在所有编辑行中始终参与布局、拖选与
                    // 源码映射；它仅由低透明度样式弱化，不能 display:none。
                    visible.add(marker.node);
                    return;
                }
                if (!inlineKinds.has(marker.kind)
                    && marker.start >= lineStart
                    && marker.start <= lineEnd) {
                    visible.add(marker.node);
                }
            });

            const markdownGroups = new Map();
            markers.forEach((marker) => {
                if (!inlineKinds.has(marker.kind)
                    || marker.kind === 'html-tag') {
                    return;
                }
                const key = `${marker.kind}\u0000${marker.node.textContent}`;
                const group = markdownGroups.get(key) || [];
                group.push(marker);
                markdownGroups.set(key, group);
            });
            const markdownPairs = [];
            markdownGroups.forEach((group) => {
                group.sort((left, right) => left.start - right.start);
                for (let index = 0; index + 1 < group.length; index += 2) {
                    markdownPairs.push({
                        open: group[index],
                        close: group[index + 1],
                    });
                }
            });
            const markdownCandidates = markdownPairs
                .filter((pair) => end > start
                    ? pair.open.start <= end && pair.close.end >= start
                    : pair.open.end <= start && pair.close.start >= end
                )
                .sort((left, right) =>
                    (left.close.end - left.open.start)
                    - (right.close.end - right.open.start)
                );
            (end > start
                ? markdownCandidates
                : markdownCandidates.slice(0, 1)
            ).forEach((pair) => {
                visible.add(pair.open.node);
                visible.add(pair.close.node);
            });

            const htmlStack = [];
            const htmlPairs = [];
            markers.filter((marker) => marker.kind === 'html-tag')
                .sort((left, right) => left.start - right.start)
                .forEach((marker) => {
                    if (marker.selfClosing) return;
                    if (!marker.closing) {
                        htmlStack.push(marker);
                        return;
                    }
                    let openIndex = htmlStack.length - 1;
                    while (openIndex >= 0
                        && htmlStack[openIndex].tag !== marker.tag) {
                        openIndex -= 1;
                    }
                    if (openIndex < 0) return;
                    const open = htmlStack[openIndex];
                    htmlStack.splice(openIndex);
                    htmlPairs.push({ open, close: marker });
                });
            const htmlCandidates = htmlPairs
                .filter((pair) => end > start
                    ? pair.open.start <= end && pair.close.end >= start
                    : pair.open.end <= start && pair.close.start >= end
                )
                .sort((left, right) =>
                    (left.close.end - left.open.start)
                    - (right.close.end - right.open.start)
                );
            (end > start
                ? htmlCandidates
                : htmlCandidates.slice(0, 1)
            ).forEach((pair) => {
                visible.add(pair.open.node);
                visible.add(pair.close.node);
            });

            markers.forEach((marker) =>
                setMarkerVisible(marker.node, visible.has(marker.node))
            );
            return true;
        }

        function markdownSourceFragment(raw, baseOffset = 0) {
            const source = String(raw || '');
            const fragment = document.createDocumentFragment();
            const ranges = compiler.markdownLiveMarkerRanges(source)
                .map((range, index) => ({
                    ...range,
                    index,
                    delimiter: source.slice(range.start, range.end),
                }));
            const inlineKinds = new Set([
                'strong',
                'emphasis',
                'italic',
                'strikethrough',
                'code',
            ]);
            const grouped = new Map();
            ranges.forEach((range) => {
                if (!inlineKinds.has(range.kind)) return;
                const key = `${range.kind}\u0000${range.delimiter}`;
                const group = grouped.get(key) || [];
                group.push(range);
                grouped.set(key, group);
            });

            const pairsByOpen = new Map();
            const pairedIndexes = new Set();
            grouped.forEach((group) => {
                for (let index = 0; index + 1 < group.length; index += 2) {
                    const open = group[index];
                    const close = group[index + 1];
                    pairsByOpen.set(open.index, { open, close });
                    pairedIndexes.add(open.index);
                    pairedIndexes.add(close.index);
                }
            });

            const semanticTag = {
                strong: 'strong',
                emphasis: 'em',
                italic: 'em',
                strikethrough: 'del',
                code: 'code',
            };
            const appendRange = (container, start, end, candidates) => {
                let offset = start;
                for (let index = 0; index < candidates.length; index += 1) {
                    const range = candidates[index];
                    if (range.start < offset || range.start >= end) continue;
                    if (range.start > offset) {
                        container.appendChild(document.createTextNode(
                            source.slice(offset, range.start)
                        ));
                    }

                    const pair = pairsByOpen.get(range.index);
                    if (pair && pair.close.start < end) {
                        container.appendChild(concealedMarker(
                            pair.open.delimiter,
                            pair.open.kind,
                            baseOffset + pair.open.start,
                            baseOffset + pair.open.end
                        ));
                        const decoration = document.createElement(
                            semanticTag[pair.open.kind] || 'span'
                        );
                        decoration.dataset.vdocMarkdownDecoration =
                            pair.open.kind;
                        appendRange(
                            decoration,
                            pair.open.end,
                            pair.close.start,
                            candidates.filter((candidate) =>
                                candidate.start >= pair.open.end
                                && candidate.end <= pair.close.start
                            )
                        );
                        container.appendChild(decoration);
                        container.appendChild(concealedMarker(
                            pair.close.delimiter,
                            pair.close.kind,
                            baseOffset + pair.close.start,
                            baseOffset + pair.close.end
                        ));
                        offset = pair.close.end;
                        continue;
                    }

                    if (pairedIndexes.has(range.index)) continue;
                    container.appendChild(concealedMarker(
                        range.delimiter,
                        range.kind,
                        baseOffset + range.start,
                        baseOffset + range.end
                    ));
                    offset = range.end;
                }
                if (offset < end) {
                    container.appendChild(document.createTextNode(
                        source.slice(offset, end)
                    ));
                }
            };

            appendRange(fragment, 0, source.length, ranges);
            if (!fragment.childNodes.length) {
                fragment.appendChild(document.createTextNode(source));
            }
            return fragment;
        }

        function inlineHtmlSourceFragment(
            raw,
            baseOffset = 0,
            options = {}
        ) {
            const source = String(raw || '');
            const sourceFragment = (value, offset) =>
                options.markdown === false
                    ? document.createTextNode(value)
                    : markdownSourceFragment(value, offset);
            const records = inlineHtmlTagRecords(source);
            if (!records.length) {
                const fragment = document.createDocumentFragment();
                fragment.appendChild(sourceFragment(source, baseOffset));
                return fragment;
            }

            const fragment = document.createDocumentFragment();
            const stack = [{ tag: null, container: fragment }];
            const current = () => stack[stack.length - 1].container;
            let offset = 0;

            records.forEach((record) => {
                if (record.start > offset) {
                    current().appendChild(sourceFragment(
                        source.slice(offset, record.start),
                        baseOffset + offset
                    ));
                }

                if (record.closing) {
                    let matchingIndex = stack.length - 1;
                    while (matchingIndex > 0
                        && stack[matchingIndex].tag !== record.tag) {
                        matchingIndex -= 1;
                    }
                    if (matchingIndex > 0) stack.splice(matchingIndex);
                    current().appendChild(concealedMarker(
                        record.source,
                        'html-tag',
                        baseOffset + record.start,
                        baseOffset + record.end,
                        record
                    ));
                    offset = record.end;
                    return;
                }

                current().appendChild(concealedMarker(
                    record.source,
                    'html-tag',
                    baseOffset + record.start,
                    baseOffset + record.end,
                    record
                ));
                const template = document.createElement('template');
                template.innerHTML = record.source;
                const decoration = template.content.firstElementChild;
                if (decoration) {
                    decoration.removeAttribute('contenteditable');
                    decoration.removeAttribute('spellcheck');
                    decoration.dataset.vdocInlineHtmlDecoration = 'true';
                    current().appendChild(decoration);
                    if (!record.selfClosing) {
                        stack.push({
                            tag: record.tag,
                            container: decoration,
                        });
                    }
                }
                offset = record.end;
            });

            if (offset < source.length) {
                current().appendChild(sourceFragment(
                    source.slice(offset),
                    baseOffset + offset
                ));
            }
            return fragment;
        }

        function createStaticHtmlVisualEditor(raw) {
            const editor = document.createElement('div');
            editor.className = 'vdoc-html-live-preview';
            editor.replaceChildren(inlineHtmlSourceFragment(
                raw,
                0,
                { markdown: false }
            ));
            return editor;
        }

        function visualEditorForRegion(shell, region, raw) {
            return region.type === 'markdown'
                ? createMarkdownVisualEditor(shell, raw)
                : createStaticHtmlVisualEditor(raw);
        }

        function markdownLineKind(line) {
            const source = String(line || '');
            if (/^#{1,6}(?:\s|$)/.test(source)) return 'heading';
            if (/^\s*>\s?/.test(source)) return 'quote';
            if (/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s+/.test(source)) {
                return 'task-list';
            }
            if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(source)) return 'list';
            if (/^\s*\|.*\|\s*$/.test(source)
                || /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/
                    .test(source)) {
                return 'table';
            }
            return 'paragraph';
        }
        function renderedLineCandidates(shell) {
            const candidates = [];
            [...(shell?.children || [])].forEach((child) => {
                if (child.matches('[data-vdoc-md-line-separator]')) return;
                if (child.matches(
                    '[data-vdoc-flow-source-editor="true"].vdoc-md-live-preview-run'
                )) {
                    candidates.push(...[...child.children].filter((line) =>
                        line.matches('.vdoc-md-live-preview-line')
                    ));
                    return;
                }
                if (child.matches('ul,ol')) {
                    candidates.push(...child.querySelectorAll(':scope > li'));
                    return;
                }
                if (child.matches('blockquote')
                    && child.children.length) {
                    candidates.push(...child.children);
                    return;
                }
                candidates.push(child);
            });
            return candidates;
        }

        function renderedLineStyleCandidates(shell) {
            return renderedLineCandidates(shell).flatMap((element) => {
                // Marked 在 breaks:true 下把一个 paragraph token 的源码行
                // 渲染为单个 <p>，行边界则是其中的 <br>。逐行编辑树不能
                // 只把这个 <p> 分配给第一行、让其余行退回无样式的 <div>；
                // 否则 p 专属的行高、字体和字距会从第二行开始全部丢失。
                const visualLineCount = Math.max(
                    1,
                    element.querySelectorAll?.('br').length + 1
                );
                return Array.from({ length: visualLineCount }, (_, index) => ({
                    element,
                    continuation: index > 0,
                }));
            });
        }

        function copyRenderedLineTypography(target, rendered) {
            if (!target || !rendered) return target;
            const style = getComputedStyle(rendered);
            [
                'color',
                'font-family',
                'font-size',
                'font-style',
                'font-variant',
                'font-weight',
                'font-stretch',
                'line-height',
                'letter-spacing',
                'word-spacing',
                'text-align',
                'text-justify',
                'text-transform',
                'text-autospace',
                'text-decoration-line',
                'text-decoration-style',
                'text-decoration-thickness',
                'text-underline-offset',
            ].forEach((property) => {
                const value = style.getPropertyValue(property);
                if (value) target.style.setProperty(property, value);
            });
            return target;
        }

        function markdownLineElement(line, rendered = null) {
            const kind = markdownLineKind(line);
            const headingLevel = kind === 'heading'
                ? String(line).match(/^(#{1,6})/)?.[1]?.length
                : 0;
            let element;
            if (headingLevel) {
                element = rendered?.tagName === `H${headingLevel}`
                    ? rendered.cloneNode(false)
                    : document.createElement(`h${headingLevel}`);
            } else if (kind === 'quote') {
                element = rendered?.tagName === 'BLOCKQUOTE'
                    ? rendered.cloneNode(false)
                    : document.createElement('blockquote');
            } else if (kind === 'list' || kind === 'task-list') {
                element = rendered?.tagName === 'LI'
                    ? rendered.cloneNode(false)
                    : document.createElement('div');
            } else {
                // 多行编辑树中的节点代表“源码行”，而不是 Markdown 段落。
                // 绝不能在这里克隆静态 <p>：一旦一个静态段落被按源码换行
                // 拆为多个节点，p 的 margin/padding/text-indent 等段级规则
                // 就会在每一行重新执行，表现为从激活点开始行距突然膨胀。
                //
                // <p> 仅作为计算排版样式与 run 外边距的来源；普通行始终
                // 使用中性 div。原本就是中性容器的节点仍可保留其结构属性。
                element = rendered?.matches(
                    'address,article,aside,div,footer,header,main,section'
                )
                    ? rendered.cloneNode(false)
                    : document.createElement('div');
            }
            element.removeAttribute('contenteditable');
            element.removeAttribute('spellcheck');
            element.classList.add('vdoc-md-live-preview-line');
            element.dataset.vdocMdLineKind = kind;
            return element;
        }

        function createMarkdownVisualEditor(shell, raw) {
            const source = String(raw || '');
            const terminalLineEnding =
                source.match(/(?:\r?\n)+$/)?.[0] || '';
            const terminalLinePrefix = terminalLineEnding
                ? source.slice(0, -terminalLineEnding.length)
                : source;
            // 纯尾换行只代表块边界，不建立可见编辑行。用户创建的每一条
            // 空白行都由独占行 ↵ 显式表达，因此无需再根据两个尾随空格或
            // 零宽字符猜测该换行是否可见。
            const trailingLineEnding = terminalLineEnding;
            const visualSource = trailingLineEnding
                ? terminalLinePrefix
                : source;
            const lines = source.split('\n');
            const renderedLines = renderedLineCandidates(shell);
            const renderedLineStyles = renderedLineStyleCandidates(shell);
            const singleVisualLine = !visualSource.includes('\n')
                && !visualSource.includes('\r');

            if (singleVisualLine) {
                const renderedBlock = shell.firstElementChild;
                const editor = renderedBlock
                    ? renderedBlock.cloneNode(true)
                    : markdownLineElement(visualSource);
                editor.querySelectorAll?.('[contenteditable], [spellcheck]')
                    .forEach((node) => {
                        node.removeAttribute('contenteditable');
                        node.removeAttribute('spellcheck');
                    });
                editor.removeAttribute('contenteditable');
                editor.removeAttribute('spellcheck');
                editor.classList.add('vdoc-md-live-preview-line');
                editor.dataset.vdocMdLineKind = markdownLineKind(source);

                // 引用、单项列表等静态 Markdown 拥有 blockquote > p、
                // ul > li 这样的布局骨架。编辑态必须保留完整骨架，只替换
                // 最内层文字内容，否则段落 margin、列表缩进和行盒都会变化。
                const contentHost = editor.matches('blockquote')
                    ? editor.querySelector('p') || editor
                    : editor.matches('ul,ol')
                        ? editor.querySelector('li') || editor
                        : editor;
                if (contentHost !== editor) {
                    // Marked 输出会在 blockquote/ul 与语义子元素之间放置
                    // 格式化换行 Text 节点。它们不是 Markdown 源码内容；
                    // 若克隆进编辑树，会让无损还原前后各多出一个换行。
                    [...editor.childNodes].forEach((node) => {
                        if (node.nodeType === Node.TEXT_NODE
                            && !String(node.nodeValue || '').trim()) {
                            node.remove();
                        }
                    });
                }
                contentHost.replaceChildren(inlineHtmlSourceFragment(
                    visualSource
                ));
                if (trailingLineEnding) {
                    // Marked 的 blockquote/list token 常把块后的单个换行纳入
                    // raw。它属于源码边界而非第二条可见行：隐藏保存该偏移，
                    // 避免引用被误建成多行编辑器，同时保证无损序列化。
                    contentHost.appendChild(concealedMarker(
                        trailingLineEnding,
                        'terminal-line-ending'
                    ));
                }
                if (!compiler.markdownLiveMarkerRanges(visualSource).length
                    && !inlineHtmlTagRecords(visualSource).length) {
                    // 裸文本编辑前后必须沿用相同的空白折叠和断行算法。
                    // 通用源码编辑规则中的 break-spaces/anywhere 会改变字宽、
                    // 两端对齐和换行点，导致获得焦点时发生轻微布局跳动。
                    editor.classList.add('vdoc-md-plain-text-preview');
                }
                return editor;
            }

            const editor = document.createElement('div');
            editor.className = 'vdoc-md-live-preview-run';
            const renderedBlock = renderedLines[0] || shell.firstElementChild;
            if (renderedBlock) {
                const style = getComputedStyle(renderedBlock);
                editor.style.marginBlockStart = style.marginBlockStart;
                editor.style.marginBlockEnd = style.marginBlockEnd;
                editor.style.marginInlineStart = style.marginInlineStart;
                editor.style.marginInlineEnd = style.marginInlineEnd;
                copyRenderedLineTypography(editor, renderedBlock);
            }
            let sourceOffset = 0;
            let renderedIndex = 0;
            lines.forEach((line, lineIndex) => {
                if (lineIndex) {
                    const separator = document.createElement('span');
                    separator.dataset.vdocMdLineSeparator = 'true';
                    separator.contentEditable = 'false';
                    separator.setAttribute('aria-hidden', 'true');
                    separator.textContent = '\n';
                    editor.appendChild(separator);
                    sourceOffset += 1;
                }
                const renderedStyle = line.length
                    ? renderedLineStyles[renderedIndex] || null
                    : null;
                const lineElement = markdownLineElement(
                    line,
                    renderedStyle && !renderedStyle.continuation
                        ? renderedStyle.element
                        : null
                );
                if (line.length) {
                    renderedIndex += 1;
                    // 同一静态 <p> 中 <br> 后的行继续使用其最终计算排版，
                    // 但不克隆 <p> 标签本身，避免 text-indent 等“段落首行”
                    // 规则错误地重复应用到每条源码行。
                    //
                    // 标题末尾 Enter 创建的 ↵ 普通行没有对应的静态渲染节点。
                    // run 容器为了保留首行几何会继承标题排版；若这里不显式
                    // 重置，新行会临时显示成标题字重。无静态来源的普通行应
                    // 使用编辑区域父级的正文排版，标题行仍由自身来源控制。
                    const typographySource = renderedStyle?.element || (
                        lineElement.dataset.vdocMdLineKind === 'paragraph'
                            ? shell.parentElement
                            : null
                    );
                    copyRenderedLineTypography(
                        lineElement,
                        typographySource
                    );
                    lineElement.replaceChildren(inlineHtmlSourceFragment(
                        line,
                        sourceOffset
                    ));
                }
                editor.appendChild(lineElement);
                sourceOffset += line.length;
            });
            return editor;
        }

        function restoreEditorOffsets(
            editor,
            raw,
            start,
            end = start
        ) {
            const source = String(raw || '');
            const selectionStart = Math.max(
                0,
                Math.min(source.length, Number(start) || 0)
            );
            const selectionEnd = Math.max(
                selectionStart,
                Math.min(source.length, Number(end) || selectionStart)
            );

            const lines = editor.classList?.contains(
                'vdoc-md-live-preview-run'
            )
                ? [...editor.children].filter((child) =>
                    child.classList?.contains('vdoc-md-live-preview-line')
                )
                : [];
            if (lines.length) {
                const pointForOffset = (offset) => {
                    const before = source.slice(0, offset);
                    const lineIndex = (before.match(/\n/g) || []).length;
                    const lineStart = before.lastIndexOf('\n') + 1;
                    return {
                        line: lines[Math.min(lineIndex, lines.length - 1)],
                        offset: offset - lineStart,
                    };
                };
                const startPoint = pointForOffset(selectionStart);
                const endPoint = pointForOffset(selectionEnd);
                if (startPoint.line === endPoint.line && startPoint.line) {
                    return selectionPrimitives.restoreOffsets(
                        startPoint.line,
                        startPoint.offset,
                        endPoint.offset
                    );
                }
            }

            return selectionPrimitives.restoreOffsets(
                editor,
                selectionStart,
                selectionEnd
            );
        }

        function configureSourceEditor(editor, region) {
            editor.classList.add('vdoc-md-live-preview');
            editor.dataset.vdocFlowSourceEditor = 'true';
            editor.dataset.vdocFlowDomain = region.type === 'markdown'
                ? 'markdown'
                : 'html';
            editor.removeAttribute('contenteditable');
            editor.contentEditable = 'true';
            editor.spellcheck = false;
            editor.setAttribute('role', 'textbox');
            editor.setAttribute('aria-multiline', 'true');
            editor.setAttribute(
                'aria-label',
                region.type === 'markdown'
                    ? 'Markdown 渲染态编辑区'
                    : 'HTML 渲染态文字编辑区'
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
                visualEditorForRegion(shell, region, raw),
                region
            );
            const editorSource = editableSourceText(editor);
            if (editorSource !== raw) {
                console.warn(
                    '[Scriptorium] Lossless edit mapping failed: '
                    + JSON.stringify({
                        regionKey: region.key,
                        regionType: region.type,
                        flowKind: region.flowKind,
                        markdownTokenType: region.markdownTokenType,
                        source: raw,
                        restoredSource: editorSource,
                    })
                );
                notificationPort.show?.(
                    '当前内容无法建立无损渲染态编辑映射。',
                    'error'
                );
                return null;
            }
            shell.replaceChildren(editor);
            shell.dataset.vdocEditActive = 'true';
            const session = beginSession(shell, editor);
            if (!session) return null;

            const localOffset = Math.max(
                0,
                Math.min(raw.length, sourceOffset - region.sourceRange.start)
            );
            refreshLocalMarkers(session, localOffset);
            try {
                editor.focus({ preventScroll: true });
            } catch {
                editor.focus();
            }
            restoreEditorOffsets(editor, raw, localOffset);
            installMappings(state.root);

            if (point) {
                const clickedLineIndex = Number(point.lineIndex);
                const lineTarget = Number.isInteger(clickedLineIndex)
                    ? editor.querySelectorAll(
                        '.vdoc-md-live-preview-line'
                    )[clickedLineIndex]
                    : null;
                const clickTarget = lineTarget || editor;
                const clickPoint = {
                    clientX: point.clientX,
                    clientY: point.clientY,
                    target: clickTarget,
                    composedPath: () => lineTarget
                        ? [lineTarget, editor]
                        : [editor],
                };
                window.requestAnimationFrame(() => {
                    if (state.activeSession !== session) return;
                    const placed = selectionPrimitives.placeCaretFromPoint(
                        state.root,
                        clickPoint,
                        { scope: editor }
                    );
                    if (!placed) {
                        selectionPrimitives.restoreOffsets(editor, localOffset);
                    }
                    const offsets = editorSelectionOffsets(editor);
                    refreshLocalMarkers(
                        session,
                        offsets?.start ?? localOffset,
                        offsets?.end ?? localOffset
                    );

                    // 当前语法对展开后行内宽度可能变化。等待显隐样式完成布局，
                    // 再按用户最初点击的屏幕坐标做最终校准；失败时保留上一轮
                    // 已经有效的 Selection，不再回退到行首。
                    window.requestAnimationFrame(() => {
                        if (state.activeSession !== session) return;
                        selectionPrimitives.placeCaretFromPoint(
                            state.root,
                            clickPoint,
                            { scope: editor }
                        );
                        const settled = editorSelectionOffsets(editor);
                        refreshLocalMarkers(
                            session,
                            settled?.start ?? offsets?.start ?? localOffset,
                            settled?.end ?? offsets?.end ?? localOffset
                        );
                        context.onSelectionChange?.(selectionState());
                    });
                });
            }
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
            const liveRange = selectionPrimitives.cloneLiveRange(
                state.root,
                { expanded: true }
            ) || (
                state.selectionRange?.startContainer?.isConnected
                    ? state.selectionRange.cloneRange()
                    : null
            );
            if (!liveRange || liveRange.collapsed) return null;

            const startElement = selectionPrimitives.elementOf(
                liveRange.startContainer
            );
            const endElement = selectionPrimitives.elementOf(
                liveRange.endContainer
            );
            let shell = startElement?.closest?.('[data-vdoc-edit-key]');
            let range = liveRange;

            if (!shell
                || endElement?.closest?.('[data-vdoc-edit-key]') !== shell) {
                // 浏览器在整段拖选、三击选段或从行尾向下拖动时，常把
                // Selection 终点放在下一块的起始边界。只要裁剪后真正
                // 含有可见文字的编辑块仍然只有一个，就应视为单块选区，
                // 而不是因为无文本的边界溢出拒绝段落格式化。
                const covered = [
                    ...state.root.querySelectorAll('[data-vdoc-edit-key]'),
                ].map((candidate) => ({
                    shell: candidate,
                    range: selectionPrimitives.rangeWithinNode(
                        liveRange,
                        candidate
                    ),
                })).filter((candidate) =>
                    candidate.range
                    && !candidate.range.collapsed
                    && candidate.range.toString().length > 0
                );
                if (covered.length !== 1) return null;
                [{ shell, range }] = covered;
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

        function clipboardSourceEndpoint(node, offset, edge) {
            const element = selectionPrimitives.elementOf(node);
            const shell = element?.closest?.('[data-vdoc-edit-key]');
            const region = regionForShell(shell);
            if (!shell || !region) return null;

            if (region.flowKind === 'stable-atomic') {
                return edge === 'start'
                    ? region.sourceRange.start
                    : region.sourceRange.end;
            }

            if (node === shell) {
                if (Number(offset) <= 0) return region.sourceRange.start;
                if (Number(offset) >= shell.childNodes.length) {
                    return region.sourceRange.end;
                }
            }
            return sourceEndpoint(shell, node, offset);
        }

        function expandClipboardMarkdownSyntax(sourceStart, sourceEnd) {
            let start = sourceStart;
            let end = sourceEnd;
            const source = adapter.currentSource();
            const inlineKinds = new Set([
                'strong',
                'emphasis',
                'italic',
                'strikethrough',
                'code',
            ]);

            (compiled().editRegions || []).filter((region) =>
                region.type === 'markdown'
                && start < region.sourceRange.end
                && end > region.sourceRange.start
            ).forEach((region) => {
                const raw = source.slice(
                    region.sourceRange.start,
                    region.sourceRange.end
                );
                const markers = compiler.markdownLiveMarkerRanges(raw);
                const groups = new Map();
                markers.forEach((marker) => {
                    if (!inlineKinds.has(marker.kind)) return;
                    const delimiter = raw.slice(marker.start, marker.end);
                    const key = `${marker.kind}\u0000${delimiter}`;
                    const group = groups.get(key) || [];
                    group.push(marker);
                    groups.set(key, group);
                });

                let expanded = true;
                while (expanded) {
                    expanded = false;
                    groups.forEach((group) => {
                        for (let index = 0; index + 1 < group.length; index += 2) {
                            const open = group[index];
                            const close = group[index + 1];
                            const openStart =
                                region.sourceRange.start + open.start;
                            const openEnd =
                                region.sourceRange.start + open.end;
                            const closeStart =
                                region.sourceRange.start + close.start;
                            const closeEnd =
                                region.sourceRange.start + close.end;
                            if (start <= openEnd && end >= closeStart
                                && (start > openStart || end < closeEnd)) {
                                start = Math.min(start, openStart);
                                end = Math.max(end, closeEnd);
                                expanded = true;
                            }
                        }
                    });
                }

                const localStart = start - region.sourceRange.start;
                markers.filter((marker) => !inlineKinds.has(marker.kind))
                    .forEach((marker) => {
                        const gap = raw.slice(marker.end, localStart);
                        if (marker.end <= localStart && /^\s*$/.test(gap)) {
                            start = region.sourceRange.start + marker.start;
                        }
                    });
            });
            return { start, end };
        }

        function clipboardSourceSelection() {
            const range = selectionPrimitives.cloneLiveRange(
                state.root,
                { expanded: true }
            ) || (
                state.selectionRange?.startContainer?.isConnected
                    ? state.selectionRange.cloneRange()
                    : null
            );
            if (!range || range.collapsed) return null;

            const intersectedRegions = [
                ...state.root.querySelectorAll('[data-vdoc-edit-key]')
            ].map((shell) => ({
                shell,
                region: regionForShell(shell),
            })).filter(({ shell, region }) =>
                region && selectionPrimitives.intersectsNode(range, shell)
            );
            const sourceStart = clipboardSourceEndpoint(
                range.startContainer,
                range.startOffset,
                'start'
            ) ?? intersectedRegions[0]?.region?.sourceRange?.start;
            const sourceEnd = clipboardSourceEndpoint(
                range.endContainer,
                range.endOffset,
                'end'
            ) ?? intersectedRegions.at(-1)?.region?.sourceRange?.end;
            if (!Number.isFinite(sourceStart)
                || !Number.isFinite(sourceEnd)
                || sourceEnd < sourceStart) {
                return null;
            }

            const expanded = expandClipboardMarkdownSyntax(
                sourceStart,
                sourceEnd
            );
            const source = adapter.currentSource();
            return Object.freeze({
                range,
                sourceStart: expanded.start,
                sourceEnd: expanded.end,
                text: source.slice(expanded.start, expanded.end),
            });
        }

        function deleteClipboardSourceSelection(
            payload = clipboardSourceSelection(),
            reason = 'flow-delete-source-selection'
        ) {
            if (!payload
                || !Number.isFinite(payload.sourceStart)
                || !Number.isFinite(payload.sourceEnd)
                || payload.sourceEnd <= payload.sourceStart) {
                return false;
            }

            const source = adapter.currentSource();
            const candidate = source.slice(0, payload.sourceStart)
                + source.slice(payload.sourceEnd);
            const normalized = normalizeParagraphBreaksInChangedLines(
                candidate,
                payload.sourceStart,
                payload.sourceStart,
                payload.sourceStart,
                payload.sourceStart
            );
            const preserved = preserveBlankMarkdownRegion(
                normalized.source,
                normalized.selectionStart
            );
            const nextSource = preserved.source;
            const caret = preserved.caret;

            // 归一化可能顺带清除删除边界处与正文粘连的 ↵。计算原源码与
            // 最终源码的最小差异，只提交必要范围，避免把一次圈选删除
            // 扩大成整篇文档替换，也继续服从稳定原子区域保护。
            let from = 0;
            const prefixLimit = Math.min(source.length, nextSource.length);
            while (from < prefixLimit && source[from] === nextSource[from]) {
                from += 1;
            }
            let sourceTail = source.length;
            let nextTail = nextSource.length;
            while (sourceTail > from
                && nextTail > from
                && source[sourceTail - 1] === nextSource[nextTail - 1]) {
                sourceTail -= 1;
                nextTail -= 1;
            }

            const transaction = transact({
                from,
                to: sourceTail,
                expected: source.slice(from, sourceTail),
                insert: nextSource.slice(from, nextTail),
                reason,
            });
            if (!transaction) return false;

            state.activeSession = null;
            state.selectionRange = null;
            state.selectionText = '';
            selectionPrimitives.selectionFor(state.root)?.removeAllRanges?.();
            context.onSelectionChange?.(selectionState());
            context.renderPort?.invalidate?.(reason);
            context.renderPort?.renderEdit?.({ force: true });
            scheduleBoundaryFocus(caret);
            return true;
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

        function patchFormattedRegion(selection, transaction) {
            if (state.activeSession?.shell === selection.shell) {
                state.activeSession = null;
            }
            selection.shell.removeAttribute('data-vdoc-edit-active');
            state.selectionRange = null;
            state.selectionText = '';
            return context.renderPort?.patchRegion?.(
                selection.shell,
                selection.region.ordinal,
                transaction.caret
            ) ?? false;
        }

        function advancedStyleSourceRuns(raw, baseOffset, from, to) {
            const source = String(raw || '');
            const localFrom = Math.max(
                0,
                Math.min(source.length, Number(from) - baseOffset)
            );
            const localTo = Math.max(
                localFrom,
                Math.min(source.length, Number(to) - baseOffset)
            );
            const placeholder =
                compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
            const runs = [];
            let runStart = null;
            let cursor = 0;

            // 一个 Marked paragraph region 内仍可能包含单换行和独占 ↵ 行。
            // 因此不能把 region 直接当成段落；按源码物理行识别几何空白，
            // 但普通非空单换行继续保留在同一个样式目标内。
            const lines = source.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
            lines.forEach((line) => {
                if (!line && cursor >= source.length) return;
                const lineEnding = line.match(/(?:\r\n|\n)$/)?.[0] || '';
                const content = line.slice(
                    0,
                    line.length - lineEnding.length
                );
                const separator = !content.trim()
                    || content.trim() === placeholder;
                if (separator) {
                    if (runStart !== null && cursor > runStart) {
                        runs.push({ start: runStart, end: cursor });
                    }
                    runStart = null;
                } else if (runStart === null) {
                    runStart = cursor;
                }
                cursor += line.length;
            });
            if (runStart !== null && cursor > runStart) {
                runs.push({ start: runStart, end: cursor });
            }

            return runs.map((run) => {
                const clippedStart = Math.max(run.start, localFrom);
                const clippedEnd = Math.min(run.end, localTo);
                const selected = source.slice(clippedStart, clippedEnd);
                const leading =
                    selected.match(/^[ \t\r\n]*/)?.[0].length || 0;
                const trailing =
                    selected.match(/[ \t\r\n]*$/)?.[0].length || 0;
                return {
                    from: baseOffset + clippedStart + leading,
                    to: baseOffset + clippedEnd - trailing,
                };
            }).filter((run) => run.to > run.from);
        }

        function advancedStyleSelectionTargets(targets = []) {
            const range = selectionPrimitives.cloneLiveRange(
                state.root,
                { expanded: true }
            ) || (
                state.selectionRange?.startContainer?.isConnected
                    ? state.selectionRange.cloneRange()
                    : null
            );
            if (!range || range.collapsed) return null;

            const covered = [
                ...state.root.querySelectorAll('[data-vdoc-edit-key]'),
            ].map((shell) => {
                const region = regionForShell(shell);
                const clippedRange = selectionPrimitives.rangeWithinNode(
                    range,
                    shell
                );
                if (!region
                    || region.flowKind === 'stable-atomic'
                    || !clippedRange
                    || clippedRange.collapsed
                    || !clippedRange.toString().length) {
                    return null;
                }
                const sourceStart = sourceEndpoint(
                    shell,
                    clippedRange.startContainer,
                    clippedRange.startOffset
                );
                const sourceEnd = sourceEndpoint(
                    shell,
                    clippedRange.endContainer,
                    clippedRange.endOffset
                );
                if (!Number.isFinite(sourceStart)
                    || !Number.isFinite(sourceEnd)
                    || sourceEnd <= sourceStart) {
                    return null;
                }
                return {
                    shell,
                    region,
                    range: clippedRange,
                    sourceStart,
                    sourceEnd,
                };
            }).filter(Boolean);
            if (!covered.length) return null;

            const paragraphStyle = targets.includes('paragraph')
                && covered.every(({ region }) =>
                    region.type === 'markdown'
                    && region.markdownTokenType === 'paragraph'
                );
            const selections = covered.flatMap((candidate) => {
                const regionStart = candidate.region.sourceRange.start;
                const regionEnd = candidate.region.sourceRange.end;
                const runs = advancedStyleSourceRuns(
                    sourceForRegion(candidate.region),
                    regionStart,
                    paragraphStyle ? regionStart : candidate.sourceStart,
                    paragraphStyle ? regionEnd : candidate.sourceEnd
                );
                return runs.map((run) => ({
                    shell: candidate.shell,
                    region: candidate.region,
                    from: run.from,
                    to: run.to,
                    paragraph: paragraphStyle,
                }));
            });
            return selections.length ? selections : null;
        }

        function applyAdvancedStyle(value) {
            const className = String(value?.className || '')
                .replace(/[^a-zA-Z0-9_-]/g, '');
            const styleId = String(value?.id || '')
                .replace(/["<>&]/g, '');
            const targets = Array.isArray(value?.targets)
                ? value.targets.map((target) => String(target))
                : [];
            if (!className || !styleId) return false;

            const selections = advancedStyleSelectionTargets(targets);
            if (!selections) {
                notificationPort.show?.('请先在正文中选择文字。', 'info');
                return false;
            }
            if (selections.some(({ region }) => !sourceHashValid(region))) {
                notificationPort.show?.(
                    '当前块源码映射已过期，请重新选择文字。',
                    'error'
                );
                return false;
            }

            const source = adapter.currentSource();
            const ordered = [...selections].sort((left, right) =>
                left.from - right.from
            );
            const from = ordered[0].from;
            const to = ordered.at(-1).to;
            let insertion = source.slice(from, to);

            // 从源码尾部向前包装，保证前方标签插入不会改变后方目标偏移。
            [...ordered].reverse().forEach((selection) => {
                const localFrom = selection.from - from;
                const localTo = selection.to - from;
                const selectedSource = insertion.slice(localFrom, localTo);
                const targetAttribute = selection.paragraph
                    ? ' data-vdoc-style-target="paragraph"'
                    : '';
                insertion = insertion.slice(0, localFrom)
                    + `<span class="${className}" data-vdoc-style="${styleId}"${
                        targetAttribute
                    }>${selectedSource}</span>`
                    + insertion.slice(localTo);
            });

            const transaction = transact({
                from,
                to,
                expected: source.slice(from, to),
                insert: insertion,
                reason: 'flow-advanced-style',
            });
            if (!transaction) return false;

            if (ordered.length === 1) {
                patchFormattedRegion({
                    shell: ordered[0].shell,
                    region: ordered[0].region,
                }, transaction);
            } else {
                state.activeSession = null;
                state.selectionRange = null;
                state.selectionText = '';
                selectionPrimitives.selectionFor(state.root)?.removeAllRanges?.();
                context.onSelectionChange?.(selectionState());
                context.renderPort?.invalidate?.('flow-advanced-style');
                context.renderPort?.renderEdit?.({ force: true });
            }
            return true;
        }

        function executeFormatting(command, value) {
            if (command === 'image') {
                return context.mediaPort?.open?.() ?? false;
            }
            if (command === 'advanced-style') {
                return applyAdvancedStyle(value);
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
                patchFormattedRegion(selection, transaction);
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

            patchFormattedRegion(selection, transaction);
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
            return compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
        }

        function insertionOffset() {
            const session = state.activeSession;
            if (session?.editable?.isConnected
                && session.shell?.isConnected) {
                const offsets = editorSelectionOffsets(session.editable);
                const region = regionForShell(session.shell) || session.region;
                if (offsets && region
                    && region.flowKind !== 'stable-atomic') {
                    return Math.max(
                        region.sourceRange.start,
                        Math.min(
                            region.sourceRange.end,
                            region.sourceRange.start + offsets.end
                        )
                    );
                }
            }

            // sourceSelection() 有意只接受展开选区；图形插入还必须支持
            // 被工具栏夺走焦点前保存下来的折叠光标。
            const range = selectionPrimitives.cloneLiveRange(state.root) || (
                state.selectionRange?.startContainer?.isConnected
                    ? state.selectionRange.cloneRange()
                    : null
            );
            if (range) {
                const startElement = selectionPrimitives.elementOf(
                    range.startContainer
                );
                const endElement = selectionPrimitives.elementOf(
                    range.endContainer
                );
                const shell = startElement?.closest?.('[data-vdoc-edit-key]');
                if (shell
                    && endElement?.closest?.('[data-vdoc-edit-key]') === shell) {
                    const region = regionForShell(shell);
                    const offset = region?.flowKind !== 'stable-atomic'
                        ? sourceEndpoint(
                            shell,
                            range.endContainer,
                            range.endOffset
                        )
                        : null;
                    if (Number.isFinite(offset)) return offset;
                }
            }

            const sessionRegion = session?.shell?.isConnected
                ? regionForShell(session.shell)
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
            if (command === 'advanced-style') {
                return Boolean(
                    selectionPrimitives.cloneLiveRange(
                        state.root,
                        { expanded: true }
                    ) || state.selectionRange
                );
            }
            return Boolean(sourceSelection());
        }

        function formattingState(target = null) {
            const selection = sourceSelection();
            const liveRange = selectionPrimitives.cloneLiveRange(state.root);
            const element = selectionPrimitives.elementOf(
                target
                || selection?.range?.startContainer
                || liveRange?.startContainer
            ) || state.activeSession?.editable || null;
            if (!element || !state.root?.contains(element)) {
                return { available: false };
            }
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
                available: Boolean(selection),
                fontFamily: computed.fontFamily,
                fontSize: computed.fontSize,
                textColor: context.colorToHex?.(computed.color) || '',
                lineHeight: computed.lineHeight,
                activeCommands,
                selectionTarget: /^H[1-6]$/.test(
                    element.closest?.('h1,h2,h3,h4,h5,h6')?.tagName || ''
                )
                    ? 'heading'
                    : element.closest?.(
                        'p,[data-vdoc-md-line-kind="paragraph"]'
                    )
                        ? 'paragraph'
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
                previousText: editableSourceText(editable),
                revision: documentPort.status().revision,
            };
            state.activeSession = session;
            return session;
        }

        function refreshSessionRegion(
            session,
            transaction,
            selectionOffsets = null,
            options = {}
        ) {
            const nextCompiled = compiled(true);
            const expectedStart = transaction.from;
            const expectedEnd = transaction.caret;
            const nextRegion = nextCompiled.editRegions.find((region) =>
                region.sourceRange.start === expectedStart
                && region.sourceRange.end === expectedEnd
                && region.flowKind !== 'stable-atomic'
            ) || null;
            if (!nextRegion) return false;

            const nextRaw = sourceForRegion(nextRegion);

            // 输入缓冲提交只对齐源码，不重建当前 contenteditable。
            // compositionend/input 之后 Chromium 仍可能持有原生 Selection；
            // 此处 replaceChildren 会让浏览器输入目标、Selection 和 Scriptorium
            // 映射分裂，产生丢字、重复及前文移位。只要编译后的区域边界
            // 没有变化，保留输入 DOM，并更新会话元数据即可。
            if (options.preserveEditable
                && session.editable?.isConnected
                && session.shell?.contains(session.editable)) {
                session.region = { ...nextRegion };
                session.raw = nextRaw;
                session.previousText = nextRaw;
                session.revision = documentPort.status().revision;
                session.shell.dataset.vdocEditKey = nextRegion.key;
                session.shell.dataset.vdocEditType = nextRegion.type;
                session.shell.dataset.vdocFlowKind = nextRegion.flowKind;
                installMappings(state.root);
                return true;
            }

            const nextEditable = configureSourceEditor(
                visualEditorForRegion(session.shell, nextRegion, nextRaw),
                nextRegion
            );
            if (editableSourceText(nextEditable) !== nextRaw) {
                return false;
            }

            const requestedStart = Number(selectionOffsets?.start);
            const requestedEnd = Number(selectionOffsets?.end);
            const selectionStart = Math.max(
                0,
                Math.min(
                    nextRaw.length,
                    Number.isFinite(requestedStart)
                        ? requestedStart
                        : transaction.caret - transaction.from
                )
            );
            const selectionEnd = Math.max(
                selectionStart,
                Math.min(
                    nextRaw.length,
                    Number.isFinite(requestedEnd)
                        ? requestedEnd
                        : selectionStart
                )
            );

            session.shell.replaceChildren(nextEditable);
            session.editable = nextEditable;
            session.region = { ...nextRegion };
            session.raw = nextRaw;
            session.previousText = nextRaw;
            session.revision = documentPort.status().revision;
            session.shell.dataset.vdocEditKey = nextRegion.key;
            session.shell.dataset.vdocEditType = nextRegion.type;
            session.shell.dataset.vdocFlowKind = nextRegion.flowKind;

            try {
                nextEditable.focus({ preventScroll: true });
            } catch {
                nextEditable.focus();
            }
            restoreEditorOffsets(
                nextEditable,
                nextRaw,
                selectionStart,
                selectionEnd
            );
            refreshLocalMarkers(session, selectionStart, selectionEnd);
            installMappings(state.root);
            return true;
        }

        function preserveBlankMarkdownRegion(raw, caret) {
            const source = String(raw || '');
            if (/[^\s]/u.test(source)) {
                return { source, caret };
            }
            const offset = Math.max(
                0,
                Math.min(source.length, Number(caret) || 0)
            );
            const placeholder =
                compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
            return {
                source: source.slice(0, offset)
                    + placeholder
                    + source.slice(offset),
                caret: offset + placeholder.length,
            };
        }

        function paragraphBreakTextInsertionOffsets(raw, offsets) {
            const source = String(raw || '');
            const start = Math.max(
                0,
                Math.min(source.length, Number(offsets?.start) || 0)
            );
            const end = Math.max(
                start,
                Math.min(source.length, Number(offsets?.end) || start)
            );
            if (start !== end) return { start, end };
            const lineStart =
                source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
            const lineBreak = source.indexOf('\n', start);
            const lineEnd = lineBreak < 0 ? source.length : lineBreak;
            const placeholder =
                compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';

            // Chromium 可能把视觉上相同的光标放在 ↵ 前侧、文本节点内部
            // 或 ↵ 后侧。占位行上的文字输入统一规范到 ↵ 后方；这里只移动
            // 插入点，不提前删除源码。随后由局部归一化执行唯一一次清理。
            return source.slice(lineStart, lineEnd).trim() === placeholder
                ? { start: lineEnd, end: lineEnd }
                : { start, end };
        }

        function normalizeParagraphBreaksInChangedLines(
            raw,
            changeStart,
            changeEnd,
            selectionStart = changeEnd,
            selectionEnd = selectionStart
        ) {
            const source = String(raw || '');
            const from = Math.max(
                0,
                Math.min(source.length, Number(changeStart) || 0)
            );
            const to = Math.max(
                from,
                Math.min(source.length, Number(changeEnd) || from)
            );
            const windowStart =
                source.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
            const followingBreak = source.indexOf('\n', to);
            const windowEnd = followingBreak < 0
                ? source.length
                : followingBreak;
            const windowSource = source.slice(windowStart, windowEnd);
            const placeholder =
                compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
            const escapedPlaceholder = placeholder.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            );
            const pattern = new RegExp(
                `^([ \\t]*)${escapedPlaceholder}[ \\t]*(?=\\S)`,
                'gm'
            );
            const removals = [];
            const normalizedWindow = windowSource.replace(
                pattern,
                (match, indentation, offset) => {
                    const indentationLength = String(indentation).length;
                    const removedStart =
                        windowStart + offset + indentationLength;
                    removals.push({
                        start: removedStart,
                        end: windowStart + offset + String(match).length,
                    });
                    return indentation;
                }
            );
            if (!removals.length) {
                return {
                    source,
                    selectionStart,
                    selectionEnd,
                    changed: false,
                };
            }
            const adjust = (offset) => {
                const value = Math.max(
                    0,
                    Math.min(source.length, Number(offset) || 0)
                );
                const removedBefore = removals.reduce((total, removed) => {
                    if (value <= removed.start) return total;
                    return total + Math.min(
                        value,
                        removed.end
                    ) - removed.start;
                }, 0);
                return value - removedBefore;
            };
            return {
                source: source.slice(0, windowStart)
                    + normalizedWindow
                    + source.slice(windowEnd),
                selectionStart: adjust(selectionStart),
                selectionEnd: adjust(selectionEnd),
                changed: true,
            };
        }

        function paragraphBreakEnterSelection(raw, offsets) {
            const source = String(raw || '');
            const start = Math.max(
                0,
                Math.min(source.length, Number(offsets?.start) || 0)
            );
            const end = Math.max(
                start,
                Math.min(source.length, Number(offsets?.end) || start)
            );
            if (start !== end) return { start, end };
            const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
            const lineBreak = source.indexOf('\n', start);
            const lineEnd = lineBreak < 0 ? source.length : lineBreak;
            const placeholder =
                compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
            return source.slice(lineStart, lineEnd).trim() === placeholder
                ? { start: lineEnd, end: lineEnd }
                : { start, end };
        }

        function commitSessionInsertion(
            session,
            insertion,
            offsets,
            reason
        ) {
            if (!session?.editable?.isConnected
                || session.region?.type !== 'markdown'
                || !offsets) {
                return false;
            }

            // Enter、Tab、粘贴及结构删除会结束当前输入脉冲。若浏览器 DOM
            // 中还有尚未提交的普通文字或退格结果，必须与本次显式操作合并
            // 成一个事务；不能先 flush 再做第二次结构事务，也不能继续以
            // 旧模型源码为工作副本，否则会丢失 Enter 前的即时输入。
            window.clearTimeout(state.textInputFlushTimer);
            state.textInputFlushTimer = 0;
            const modelRaw = sourceForRegion(session.region);
            const domRaw = editableSourceText(session.editable);
            const currentRaw = domRaw !== session.previousText
                ? domRaw
                : modelRaw;
            const inserted = String(insertion || '');
            const effectiveOffsets = /\S/u.test(inserted)
                && !inserted.includes('\n')
                ? paragraphBreakTextInsertionOffsets(currentRaw, offsets)
                : offsets;
            const start = Math.max(
                0,
                Math.min(
                    currentRaw.length,
                    Number(effectiveOffsets.start) || 0
                )
            );
            const end = Math.max(
                start,
                Math.min(
                    currentRaw.length,
                    Number(effectiveOffsets.end) || start
                )
            );
            const candidateRaw = currentRaw.slice(0, start)
                + inserted
                + currentRaw.slice(end);
            const candidateCaret = start + inserted.length;
            const normalized = normalizeParagraphBreaksInChangedLines(
                candidateRaw,
                start,
                candidateCaret,
                candidateCaret,
                candidateCaret
            );
            const preserved = preserveBlankMarkdownRegion(
                normalized.source,
                normalized.selectionStart
            );
            const nextRaw = preserved.source;
            const caret = preserved.caret;
            const transaction = transact({
                from: session.region.sourceRange.start,
                to: session.region.sourceRange.end,
                expected: modelRaw,
                insert: nextRaw,
                reason,
            });
            if (!transaction) return false;
            const refreshed = refreshSessionRegion(session, transaction, {
                start: caret,
                end: caret,
            });
            if (!refreshed) {
                const viewState = captureViewState();
                state.activeSession = null;
                context.renderPort?.invalidate?.(
                    'flow-edit-region-structure-changed'
                );
                context.renderPort?.renderEdit?.({ force: true });
                // 标题末尾 Enter 会把原 heading token 与新建的 ↵ 段落
                // 编译成两个 edit region。旧编辑树仍保存 Enter 前的 Selection，
                // 不能再从它反推焦点，否则区域边界会优先命中原标题末尾。
                // 事务已经给出了新源码中的确定光标，直接定位新段落。
                restoreViewState({
                    ...viewState,
                    sourceOffset: transaction.from + caret,
                });
            }
            return true;
        }

        function replaceActiveSelection(session, insertion, reason) {
            const offsets = session?.editable?.isConnected
                ? editorSelectionOffsets(session.editable)
                : null;
            return commitSessionInsertion(
                session,
                insertion,
                offsets,
                reason
            );
        }

        function adjacentEditableShell(shell, backwards = false) {
            const shells = [
                ...state.root.querySelectorAll('[data-vdoc-edit-key]'),
            ].filter((candidate) => {
                const region = regionForShell(candidate);
                return region && region.flowKind !== 'stable-atomic';
            });
            const index = shells.indexOf(shell);
            if (index < 0) return null;
            return shells[index + (backwards ? -1 : 1)] || null;
        }

        function finishHtmlSession(session, nextShell = null) {
            if (!session || session.region.type !== 'html') return false;
            deactivateSession(session);
            if (nextShell?.isConnected) activateShell(nextShell);
            return true;
        }

        function activateSourceOffset(sourceOffset) {
            if (!state.root) return false;
            const offset = Math.max(
                0,
                Math.min(adapter.currentSource().length, Number(sourceOffset) || 0)
            );
            const regions = compiled().editRegions || [];
            const region = regions.find((candidate) =>
                candidate.flowKind !== 'stable-atomic'
                && offset >= candidate.sourceRange.start
                && offset <= candidate.sourceRange.end
            ) || regions.find((candidate) =>
                candidate.flowKind !== 'stable-atomic'
                && candidate.sourceRange.start >= offset
            );
            if (!region) return false;
            const shell = [...state.root.querySelectorAll(
                '[data-vdoc-edit-key]'
            )].find((candidate) =>
                candidate.dataset.vdocEditKey === region.key
            );
            if (!shell) return false;

            const nextSession = activateShell(shell);
            if (!nextSession?.editable?.isConnected) return false;
            const localOffset = Math.max(
                0,
                Math.min(
                    sourceForRegion(region).length,
                    offset - region.sourceRange.start
                )
            );
            restoreEditorOffsets(
                nextSession.editable,
                sourceForRegion(region),
                localOffset
            );
            refreshLocalMarkers(nextSession, localOffset);
            return true;
        }

        function captureViewState() {
            const session = state.activeSession;
            const offsets = session?.editable?.isConnected
                ? resilientEditorSelectionOffsets(session.editable)
                : null;
            const region = session?.shell?.isConnected
                ? regionForShell(session.shell) || session.region
                : null;
            const scrollHost = state.root?.host?.parentElement;
            return Object.freeze({
                sourceOffset: offsets && region
                    ? region.sourceRange.start + offsets.end
                    : null,
                focused: Boolean(
                    session?.editable?.isConnected
                    && state.root?.activeElement === session.editable
                ),
                scrollLeft: Number(scrollHost?.scrollLeft) || 0,
                scrollTop: Number(scrollHost?.scrollTop) || 0,
            });
        }

        function restoreViewState(viewState) {
            if (!viewState || !state.root) return false;
            const restoreScroll = () => {
                const scrollHost = state.root?.host?.parentElement;
                scrollHost?.scrollTo?.({
                    left: Number(viewState.scrollLeft) || 0,
                    top: Number(viewState.scrollTop) || 0,
                    behavior: 'auto',
                });
            };
            restoreScroll();
            if (viewState.focused
                && Number.isFinite(viewState.sourceOffset)) {
                scheduleBoundaryFocus(viewState.sourceOffset);
            }
            window.requestAnimationFrame(restoreScroll);
            return true;
        }

        function scheduleBoundaryFocus(sourceOffset) {
            if (state.boundaryFocusFrame) {
                window.cancelAnimationFrame(state.boundaryFocusFrame);
            }
            state.boundaryFocusFrame = window.requestAnimationFrame(() => {
                state.boundaryFocusFrame = 0;
                if (state.disposed || activateSourceOffset(sourceOffset)) return;
                // 全量重渲染及 Shadow DOM 插件绑定可能跨越当前帧；若首帧尚未
                // 建立新 shell，再等待一帧，避免 HTML 标题 Enter 后丢失焦点。
                state.boundaryFocusFrame = window.requestAnimationFrame(() => {
                    state.boundaryFocusFrame = 0;
                    if (!state.disposed) activateSourceOffset(sourceOffset);
                });
            });
        }

        function insertHtmlBoundaryBlankLine(session, editable) {
            if (!session || session.region.type !== 'html') return false;
            const raw = sourceForRegion(session.region);
            const offsets = editorSelectionOffsets(editable);
            if (!offsets) return false;

            // HTML 标签源码由隐藏 marker 和可见文字共同构成。用源码光标
            // 相对区域中点决定插入到块前或块后，符合标题开头/末尾操作习惯。
            const before = offsets.start <= raw.length / 2;
            const boundary = before
                ? session.region.sourceRange.start
                : session.region.sourceRange.end;
            const placeholder =
                compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
            const insertion = before
                ? `${placeholder}\n\n`
                : `\n\n${placeholder}`;
            const transaction = transact({
                from: boundary,
                to: boundary,
                expected: '',
                insert: insertion,
                reason: before
                    ? 'flow-html-blank-line-before'
                    : 'flow-html-blank-line-after',
            });
            if (!transaction) return false;

            // 标题边界只新增一个相邻 Markdown 区域。禁止调用全量
            // renderEdit()：它会销毁整个 Shadow DOM、滚动锚点和运行态节点。
            const nextCompiled = compiled(true);
            const template = document.createElement('template');
            template.innerHTML = nextCompiled.previewHtml || '';
            const replacements = [...template.content.querySelectorAll(
                '[data-vdoc-edit-key]'
            )];
            const existing = [...state.root.querySelectorAll(
                '[data-vdoc-edit-key]'
            )];
            const oldOrdinal = session.region.ordinal;
            const htmlOrdinal = before ? oldOrdinal + 1 : oldOrdinal;
            const markdownOrdinal = before ? oldOrdinal : oldOrdinal + 1;
            const htmlReplacement = replacements[htmlOrdinal];
            const markdownReplacement = replacements[markdownOrdinal];

            if (!htmlReplacement || !markdownReplacement) {
                // 只有编译结果无法建立局部对应关系时才安全降级为全量重建。
                state.activeSession = null;
                context.renderPort?.invalidate?.(
                    'flow-html-boundary-local-patch-failed'
                );
                context.renderPort?.renderEdit?.({ force: true });
                scheduleBoundaryFocus(transaction.caret);
                return true;
            }

            const syncShellMetadata = (target, replacement) => {
                target.className = replacement.className;
                target.dataset.vdocEditKey =
                    replacement.dataset.vdocEditKey;
                target.dataset.vdocEditType =
                    replacement.dataset.vdocEditType;
                target.dataset.vdocFlowKind =
                    replacement.dataset.vdocFlowKind;
            };

            // 当前标题仅恢复自己的静态内容，不触碰页面中的其它节点。
            session.shell.replaceChildren(...[
                ...htmlReplacement.childNodes,
            ].map((node) => node.cloneNode(true)));
            syncShellMetadata(session.shell, htmlReplacement);
            session.shell.removeAttribute('data-vdoc-edit-active');

            const markdownShell = markdownReplacement.cloneNode(true);
            if (before) session.shell.before(markdownShell);
            else session.shell.after(markdownShell);

            // 新区域会令原标题之后的 ordinal 整体后移一位。保留这些 shell
            // 的 DOM 身份和运行状态，只同步编译器重新签发的区域元数据。
            existing.slice(oldOrdinal + 1).forEach((shell, index) => {
                const replacement = replacements[oldOrdinal + 2 + index];
                if (replacement) syncShellMetadata(shell, replacement);
            });

            state.activeSession = null;
            installMappings(state.root);
            const nextSession = activateShell(markdownShell);
            if (!nextSession?.editable?.isConnected) return true;

            const markdownRaw = sourceForRegion(nextSession.region);
            const placeholderOffset = markdownRaw.indexOf(placeholder);
            const caret = placeholderOffset < 0
                ? markdownRaw.length
                : placeholderOffset + placeholder.length;
            restoreEditorOffsets(nextSession.editable, markdownRaw, caret);
            refreshLocalMarkers(nextSession, caret);
            return true;
        }

        function deleteLineBoundaryBeforeSession(session) {
            if (!session?.region || session.region.type !== 'markdown') {
                return false;
            }
            const source = adapter.currentSource();
            const boundary = session.region.sourceRange.start;
            if (boundary <= 0) return false;

            const prefix = source.slice(0, boundary);
            const placeholder =
                compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
            const escapedPlaceholder = placeholder.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            );

            // Marked 会把段落之间的整个空白分隔带排除在两个编辑区域之外。
            // 区域头部退格若只删最后一个换行，剩余 \n\n 仍会维持段落分区，
            // 视觉上就像退格完全无效。这里一次消费紧邻区域的完整分隔带：
            // 连续 LF/CRLF、空白行以及独占 ↵ 行。
            const separatorPattern = new RegExp(
                `(?:(?:\\r\\n|\\n)[ \\t]*(?:${
                    escapedPlaceholder
                }[ \\t]*)?)+$`
            );
            const separator = prefix.match(separatorPattern)?.[0] || '';
            if (!separator) return false;
            const from = boundary - separator.length;

            const transaction = transact({
                from,
                to: boundary,
                expected: source.slice(from, boundary),
                insert: '',
                reason: 'flow-delete-line-boundary',
            });
            if (!transaction) return false;

            state.activeSession = null;
            context.renderPort?.invalidate?.('flow-line-boundary-deleted');
            context.renderPort?.renderEdit?.({ force: true });
            scheduleBoundaryFocus(from);
            return true;
        }

        function markdownLineBreakInsertion(editable, offsets) {
            const raw = editableSourceText(editable);
            const start = Math.max(
                0,
                Math.min(raw.length, Number(offsets?.start) || 0)
            );
            const end = Math.max(
                start,
                Math.min(raw.length, Number(offsets?.end) || start)
            );
            const lineStart =
                raw.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
            const followingBreak = raw.indexOf('\n', end);
            const lineEnd = followingBreak < 0
                ? raw.length
                : followingBreak;
            const placeholder =
                compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
            const currentLine = raw.slice(lineStart, lineEnd);

            // 空占位行继续拆分时保留当前 ↵，并在下一行创建新 ↵。
            if (currentLine.trim() === placeholder) {
                return `\n${placeholder}`;
            }

            // 统一拆行协议：
            // 行首：↵\n正文
            // 行中：前文\n后文
            // 行尾：正文\n↵
            const atLineStart = start === lineStart;
            const atLineEnd = end === lineEnd;
            if (atLineStart) return `${placeholder}\n`;
            if (atLineEnd) return `\n${placeholder}`;
            return '\n';
        }

        function handleEditorKeydown(event) {
            if (event.defaultPrevented
                || event.isComposing
                || state.composing
                || state.compositionCommit
                || event.ctrlKey
                || event.metaKey
                || event.altKey) {
                return false;
            }
            const editable = event.target.closest?.(
                '[data-vdoc-flow-source-editor="true"]'
            );
            const shell = event.target.closest?.('[data-vdoc-edit-key]');
            if (!editable || !shell) return false;
            const session = state.activeSession?.editable === editable
                ? state.activeSession
                : beginSession(shell, editable);
            if (!session) return false;
            // HTML 块内部不能直接插入浏览器原生换行。Enter 根据源码光标
            // 位于内容前半段还是后半段，在完整 HTML 元素边界外创建一条
            // Markdown 编辑行。尤其是 <h1 style="...">标题</h1>，可见文本
            // 尾部的光标实际位于隐藏闭合标签之前，不能再把 Enter 解释为
            // “提交并退出”，否则标题之后天然没有可供继续输入的位置。
            if (session.region.type === 'html'
                && event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                return insertHtmlBoundaryBlankLine(session, editable);
            }
            if (session.region.type === 'html' && event.key === 'Tab') {
                event.preventDefault();
                event.stopPropagation();
                return finishHtmlSession(
                    session,
                    adjacentEditableShell(shell, event.shiftKey)
                );
            }
            if (session.region.type !== 'markdown') return false;

            const offsets = resilientEditorSelectionOffsets(editable);
            if (!offsets) return false;
            const text = editableSourceText(editable);

            if (event.key === 'Tab'
                && !event.shiftKey
                && offsets.collapsed) {
                const lineStart = text.lastIndexOf(
                    '\n',
                    Math.max(0, offsets.start - 1)
                ) + 1;
                const lineBreak = text.indexOf('\n', lineStart);
                const lineEnd = lineBreak < 0 ? text.length : lineBreak;
                const line = text.slice(lineStart, lineEnd);
                const placeholder =
                    compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';

                if (line.trim() === placeholder) {
                    // Enter 创建的独占 ↵ 行第一次按 Tab 时，缩进直接取代
                    // 占位符，不能形成“　　↵”并把透明符号重新显露出来。
                    event.preventDefault();
                    return commitSessionInsertion(
                        session,
                        '　　',
                        {
                            start: lineStart,
                            end: lineEnd,
                        },
                        'flow-keyboard-placeholder-indent'
                    );
                }

                if (offsets.start !== lineStart
                    || markdownLineKind(line) !== 'paragraph') {
                    return false;
                }
                event.preventDefault();
                return replaceActiveSelection(
                    session,
                    '　　',
                    'flow-keyboard-first-line-indent'
                );
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                // 结构性 Enter 必须保持单一事务协议：先阻止浏览器原生
                // DOM 修改，再由 commitSessionInsertion() 一次性完成源码
                // 写入、区域刷新和光标恢复。普通文字/IME 仍走共享输入
                // 解耦路径，不能把结构换行伪装成普通 input 快照。
                const raw = editableSourceText(editable);
                const insertionOffsets =
                    paragraphBreakEnterSelection(raw, offsets);
                const handled = commitSessionInsertion(
                    session,
                    markdownLineBreakInsertion(
                        editable,
                        insertionOffsets
                    ),
                    insertionOffsets,
                    'flow-keydown-paragraph-break'
                );
                if (handled) {
                    if (state.enterInputGuardEditable !== editable) {
                        state.enterInputGuardEditable = editable;
                        state.enterInputGuardCount = 0;
                    }
                    state.enterInputGuardCount += 1;
                    window.clearTimeout(state.enterInputGuardTimer);
                    state.enterInputGuardTimer = window.setTimeout(() => {
                        state.enterInputGuardEditable = null;
                        state.enterInputGuardCount = 0;
                        state.enterInputGuardTimer = 0;
                    }, 120);
                }
                return handled;
            }
            return false;
        }

        function scheduleTextInputFlush(session) {
            if (!session?.editable?.isConnected) return false;
            return state.inputSync?.markInput(session.editable) ?? false;
        }

        function flushSession(
            session = state.activeSession,
            reason = 'flow-text-input'
        ) {
            if (inputPending()
                && reason !== 'flow-composition-input'
                && reason !== 'flow-composition-snapshot') {
                return false;
            }
            if (!session?.shell?.isConnected
                || !session.editable?.isConnected) {
                return false;
            }
            const domText = editableSourceText(session.editable);
            if (domText === session.previousText) return false;
            const selectionOffsets =
                editorSelectionOffsets(session.editable);
            const normalized = normalizeParagraphBreaksInChangedLines(
                domText,
                selectionOffsets?.start ?? 0,
                selectionOffsets?.end ?? selectionOffsets?.start ?? 0,
                selectionOffsets?.start,
                selectionOffsets?.end
            );
            const nextText = normalized.source;
            const normalizedSelectionOffsets = selectionOffsets
                ? {
                    ...selectionOffsets,
                    start: normalized.selectionStart,
                    end: normalized.selectionEnd,
                }
                : null;
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
                reason,
            });
            if (!transaction) return false;
            if (!refreshSessionRegion(
                session,
                transaction,
                normalizedSelectionOffsets,
                {
                    preserveEditable:
                        reason === 'flow-composition-input'
                        || reason === 'flow-text-input',
                }
            )) {
                const viewState = captureViewState();
                state.activeSession = null;
                context.renderPort?.invalidate?.(
                    'flow-edit-region-structure-changed'
                );
                context.renderPort?.renderEdit?.({ force: true });
                // 原区域被本次 DOM 输入拆成多个 Markdown token 时，旧 DOM
                // Selection 已不再代表新编译树；使用归一化后的模型偏移恢复。
                restoreViewState({
                    ...viewState,
                    sourceOffset: transaction.from
                        + (normalizedSelectionOffsets?.end
                            ?? transaction.insertion.length),
                });
            }
            return true;
        }

        function bindSurface(root) {
            assertActive();
            disposeSurface();
            state.root = root;
            state.inputSync = inputSyncModule.createInputSync({
                delay: 0,
                snapshot: (editable) => ({
                    editable,
                    text: editableSourceText(editable),
                    offsets: editorSelectionOffsets(editable),
                    session: state.activeSession?.editable === editable
                        ? state.activeSession
                        : null,
                }),
                onVisualInput: ({ snapshot }) => {
                    const session = snapshot?.session;
                    if (!session || inputPending()) return;
                    const offsets = snapshot.offsets;
                    if (offsets) {
                        refreshLocalMarkers(
                            session,
                            offsets.start,
                            offsets.end
                        );
                    }
                },
                commit: ({ snapshot }) => {
                    const session = snapshot?.session;
                    if (state.disposed
                        || inputPending()
                        || !session
                        || state.activeSession !== session
                        || !session.editable?.isConnected) {
                        return;
                    }
                    flushSession(session, 'flow-text-input');
                },
            });
            installMappings(root);
            state.abortController = new AbortController();
            const options = { signal: state.abortController.signal };

            // 被动渲染树必须完整接收浏览器原生 pointerdown，才能从第一次
            // 手势开始拖选文字。仅在 click 确认为折叠点击后替换为编辑树；
            // 展开的 Selection 和右键均不触发换树。
            root.addEventListener('click', (event) => {
                if (event.button !== 0 || event.defaultPrevented) return;
                const shell = event.target.closest?.('[data-vdoc-edit-key]');
                if (!shell) return;
                const region = regionForShell(shell);
                if (!region || region.flowKind === 'stable-atomic') return;
                if (event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                )) {
                    return;
                }
                const liveRange = selectionPrimitives.cloneLiveRange(root);
                if (liveRange && !liveRange.collapsed) {
                    captureSelection();
                    return;
                }
                const renderedLines = renderedLineCandidates(shell);
                const clickedLine = event.target.closest?.(
                    'li,h1,h2,h3,h4,h5,h6,p,blockquote,div'
                );
                const lineIndex = clickedLine
                    ? renderedLines.findIndex((line) =>
                        line === clickedLine || line.contains(clickedLine)
                    )
                    : -1;
                activateShell(shell, {
                    clientX: event.clientX,
                    clientY: event.clientY,
                    target: event.target,
                    lineIndex,
                    composedPath: () => event.composedPath(),
                });
            }, options);

            root.addEventListener('copy', (event) => {
                const payload = clipboardSourceSelection();
                if (!payload) return;
                event.clipboardData?.setData('text/plain', payload.text);
                event.clipboardData?.setData('text/markdown', payload.text);
                event.preventDefault();
            }, options);

            root.addEventListener('cut', (event) => {
                const payload = clipboardSourceSelection();
                if (!payload) return;
                event.clipboardData?.setData('text/plain', payload.text);
                event.clipboardData?.setData('text/markdown', payload.text);
                if (deleteClipboardSourceSelection(
                    payload,
                    'flow-cut-source-selection'
                )) {
                    event.preventDefault();
                }
            }, options);

            root.addEventListener('paste', (event) => {
                const editable = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const shell = event.target.closest?.('[data-vdoc-edit-key]');
                if (!editable || !shell) return;
                const session = state.activeSession?.editable === editable
                    ? state.activeSession
                    : beginSession(shell, editable);
                if (!session || session.region.type !== 'markdown') return;
                const offsets = editorSelectionOffsets(editable);
                if (!offsets) return;
                const text = event.clipboardData?.getData('text/plain');
                if (text === undefined || text === null) return;
                event.preventDefault();
                commitSessionInsertion(
                    session,
                    pastedMarkdownText(text),
                    offsets,
                    'flow-paste-plain-text'
                );
            }, options);

            root.addEventListener('contextmenu', (event) => {
                if (event.target.closest?.('[data-vdoc-object-id]')) return;
                const island = event.target.closest?.('[data-vdoc-island]');
                if (island) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    context.onIslandContextMenu?.({
                        event,
                        island,
                        editor: api,
                    });
                    return;
                }
                captureSelection();
                const selection = selectionState();
                if (!selection.text || !selection.range) return;
                event.preventDefault();
                context.onContextMenu?.({
                    event,
                    selection,
                    editor: api,
                });
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

            root.addEventListener('keydown', (event) => {
                if (handleEditorKeydown(event) || event.defaultPrevented) return;
                if (event.isComposing
                    || state.composing
                    || event.ctrlKey
                    || event.metaKey
                    || event.altKey
                    || !['Backspace', 'Delete'].includes(event.key)) {
                    return;
                }

                // 被动渲染树不是 contenteditable，跨 shell 圈选后浏览器不会
                // 可靠派发 beforeinput。键盘删除必须直接消费完整源码选区。
                const payload = clipboardSourceSelection();
                if (!payload) return;
                event.preventDefault();
                event.stopPropagation();
                deleteClipboardSourceSelection(
                    payload,
                    event.key === 'Backspace'
                        ? 'flow-keydown-delete-selection-backward'
                        : 'flow-keydown-delete-selection-forward'
                );
            }, options);

            document.addEventListener('keydown', (event) => {
                if (event.defaultPrevented
                    || event.isComposing
                    || state.composing
                    || event.ctrlKey
                    || event.metaKey
                    || event.altKey
                    || !['Backspace', 'Delete'].includes(event.key)) {
                    return;
                }

                // 静态渲染文字不可聚焦。鼠标圈选后，键盘焦点通常仍停留在
                // Scriptorium 外壳，Backspace 因而不会进入 ShadowRoot。
                // 活动 contenteditable 继续由 ShadowRoot keydown/beforeinput
                // 负责；这里只接管静态树及跨 shell 的展开源码选区。
                const activeEditor = state.root?.activeElement?.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                if (activeEditor) return;

                const payload = clipboardSourceSelection();
                if (!payload) return;
                event.preventDefault();
                event.stopPropagation();
                deleteClipboardSourceSelection(
                    payload,
                    event.key === 'Backspace'
                        ? 'flow-document-delete-selection-backward'
                        : 'flow-document-delete-selection-forward'
                );
            }, {
                signal: state.abortController.signal,
                capture: true,
            });

            root.addEventListener('beforeinput', (event) => {
                if (event.defaultPrevented
                    || event.isComposing
                    || state.composing) {
                    return;
                }
                const editable = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                // Chromium/Windows IME 通常在 compositionend 之后再派发一次
                // 最终 beforeinput/input。此阶段必须让浏览器完成候选文字
                // 固化，不能 preventDefault，更不能重建 contenteditable DOM。
                if (state.compositionCommit?.editable === editable) return;
                const shell = event.target.closest?.('[data-vdoc-edit-key]');
                if (!editable || !shell) return;
                const session = state.activeSession?.editable === editable
                    ? state.activeSession
                    : beginSession(shell, editable);
                if (!session) return;

                if (event.inputType === 'insertParagraph'
                    || event.inputType === 'insertLineBreak') {
                    if (state.enterInputGuardEditable === editable
                        && state.enterInputGuardCount > 0) {
                        // keydown 已完成这一轮 Enter。浏览器可能派发多个
                        // beforeinput 回执；它们都属于同一轮操作，不能按次数
                        // 消费，否则后续回执会再次进入下面的兜底插入路径。
                        event.preventDefault();
                        return;
                    }
                    event.preventDefault();
                    if (session.region.type === 'html') {
                        // 虚拟键盘及辅助输入设备可能绕过 keydown；与键盘 Enter
                        // 保持一致，在完整 HTML 元素边界外建立后续编辑行。
                        insertHtmlBoundaryBlankLine(session, editable);
                        return;
                    }
                    if (session.region.type !== 'markdown') return;
                    const offsets = resilientEditorSelectionOffsets(editable);
                    if (!offsets) return;
                    // 真换行与必要的 ↵ 直接进入文档模型；禁止浏览器仅修改
                    // contenteditable DOM，避免出现“UI 换行、源码没变”。
                    const raw = editableSourceText(editable);
                    const insertionOffsets =
                        paragraphBreakEnterSelection(raw, offsets);
                    commitSessionInsertion(
                        session,
                        markdownLineBreakInsertion(
                            editable,
                            insertionOffsets
                        ),
                        insertionOffsets,
                        'flow-beforeinput-paragraph-break'
                    );
                    return;
                }

                if (session.region.type !== 'markdown') return;
                const offsets = resilientEditorSelectionOffsets(editable);
                if (!offsets) return;

                const selectionDeletionTypes = new Set([
                    'deleteByCut',
                    'deleteByDrag',
                    'deleteContent',
                    'deleteContentBackward',
                    'deleteContentForward',
                    'deleteWordBackward',
                    'deleteWordForward',
                    'deleteSoftLineBackward',
                    'deleteSoftLineForward',
                    'deleteHardLineBackward',
                    'deleteHardLineForward',
                ]);
                if (!offsets.collapsed
                    && selectionDeletionTypes.has(event.inputType)) {
                    event.preventDefault();
                    commitSessionInsertion(
                        session,
                        '',
                        offsets,
                        `flow-beforeinput-${event.inputType}`
                    );
                    return;
                }

                if (event.inputType === 'deleteContentBackward') {
                    const raw = sourceForRegion(session.region);
                    if (offsets.start === offsets.end && offsets.start <= 0) {
                        event.preventDefault();
                        deleteLineBoundaryBeforeSession(session);
                        return;
                    }

                    // 普通字符退格交给浏览器直接修改当前编辑 DOM，
                    // 由 input 事件进入短脉冲队列。只有行首、换行或
                    // paragraph-break 占位符边界继续使用自定义事务；
                    // 否则延迟事务会让后续退格仍看到同一个 DOM 偏移。
                    if (offsets.start === offsets.end) {
                        const placeholder =
                            compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
                        const prefix = raw.slice(0, offsets.start);
                        const suffix = raw.slice(offsets.end);
                        const atStructuralBoundary =
                            prefix.endsWith('\r\n')
                            || prefix.endsWith('\n')
                            || prefix.endsWith(
                                `\r\n${placeholder}`
                            )
                            || prefix.endsWith(`\n${placeholder}`)
                            || (
                                prefix.endsWith('\r\n')
                                && suffix.startsWith(placeholder)
                            )
                            || (
                                prefix.endsWith('\n')
                                && suffix.startsWith(placeholder)
                            );
                        if (!atStructuralBoundary) {
                            // 普通退格由浏览器先完成视觉删除；随后由
                            // input 事件统一交给共享输入同步核心读取新 DOM。
                            // beforeinput 阶段不能读取快照，否则拿到的是删除前内容。
                            return;
                        }
                    }

                    event.preventDefault();

                    let deletionStart = offsets.start;
                    let deletionEnd = offsets.end;
                    if (offsets.start === offsets.end) {
                        const placeholder =
                            compiler.PARAGRAPH_BREAK_PLACEHOLDER || '↵';
                        const lfParagraphBreak = `\n${placeholder}`;
                        const crlfParagraphBreak = `\r\n${placeholder}`;
                        const prefix = raw.slice(0, offsets.start);
                        const suffix = raw.slice(offsets.end);
                        if (prefix.endsWith(crlfParagraphBreak)) {
                            // 光标位于 CRLF 占位行的 ↵ 后方。
                            deletionStart =
                                offsets.start - crlfParagraphBreak.length;
                        } else if (prefix.endsWith(lfParagraphBreak)) {
                            // 光标位于 LF 占位行的 ↵ 后方。
                            deletionStart =
                                offsets.start - lfParagraphBreak.length;
                        } else if (prefix.endsWith('\r\n')
                            && suffix.startsWith(placeholder)) {
                            // 光标位于 CRLF 占位行的 ↵ 前方：合并上一行时
                            // 必须同时删除当前占位符，不能留下“正文↵”。
                            deletionStart = offsets.start - 2;
                            deletionEnd = offsets.end + placeholder.length;
                        } else if (prefix.endsWith('\n')
                            && suffix.startsWith(placeholder)) {
                            // 光标位于 LF 占位行的 ↵ 前方。
                            deletionStart = offsets.start - 1;
                            deletionEnd = offsets.end + placeholder.length;
                        } else if (prefix.endsWith('\r\n')) {
                            // 普通 CRLF 真换行后的行首退格。
                            deletionStart = offsets.start - 2;
                        } else if (prefix.endsWith('\n')) {
                            // 普通 LF 真换行后的行首退格。
                            deletionStart = offsets.start - 1;
                        } else {
                            const previous = Array.from(prefix).at(-1) || '';
                            deletionStart = offsets.start - previous.length;
                        }
                    }
                    commitSessionInsertion(
                        session,
                        '',
                        {
                            start: deletionStart,
                            end: deletionEnd,
                        },
                        'flow-beforeinput-delete-backward'
                    );
                    return;
                }

                // 普通文本不能在 beforeinput 阶段读取快照：
                // 此时浏览器尚未完成 DOM 修改，读取到的仍是旧内容。
                // 统一等待 input 事件，由共享同步核心读取修改后的视觉 DOM。
                return;
            }, options);

            const clearCompositionCommit = () => {
                if (state.compositionCommitTimer) {
                    window.clearTimeout(state.compositionCommitTimer);
                    state.compositionCommitTimer = 0;
                }
                if (state.compositionCommitFrame) {
                    window.cancelAnimationFrame(state.compositionCommitFrame);
                    state.compositionCommitFrame = 0;
                }
                const pending = state.compositionCommit;
                state.compositionCommit = null;
                return pending;
            };

            const finishCompositionCommit = () => {
                state.compositionCommitTimer = 0;
                state.compositionCommitFrame = 0;
                const pending = state.compositionCommit;
                state.compositionCommit = null;
                try {
                    commitCompositionDom(pending);
                } finally {
                    releaseDeferredRender();
                }
            };

            const scheduleCompositionCommit = () => {
                if (state.compositionCommitTimer) {
                    window.clearTimeout(state.compositionCommitTimer);
                    state.compositionCommitTimer = 0;
                }
                if (state.compositionCommitFrame) {
                    window.cancelAnimationFrame(state.compositionCommitFrame);
                    state.compositionCommitFrame = 0;
                }

                const pending = state.compositionCommit;
                if (!pending) return;
                if (pending.inputObserved) {
                    // 已经收到 compositionend 后的最终 input。不要在 input
                    // 事件调用栈中重建 DOM；下一帧提交即可，既让 Chromium
                    // 完成原生 Selection 更新，也避免固定等待 80ms。
                    state.compositionCommitFrame =
                        window.requestAnimationFrame(finishCompositionCommit);
                    return;
                }

                // 某些输入法只派发 compositionend，不派发可观察的最终
                // input。保留兜底窗口，避免过早提交截断候选词。
                state.compositionCommitTimer = window.setTimeout(
                    finishCompositionCommit,
                    80
                );
            };

            const commitCompositionDom = (pending) => {
                if (!pending?.session) return false;
                if (pending.epoch !== state.compositionEpoch) return false;
                if (pending.editable?.isConnected
                    && pending.session.editable === pending.editable) {
                    const session = pending.session;
                    const editable = pending.editable;
                    const committed = flushSession(
                        session,
                        'flow-composition-input'
                    );
                    if (committed) {
                        // flushSession 的 IME 路径会保留 contenteditable 元素，
                        // 避免 composition 结束后丢失焦点。源码归一化可能删除
                        // 输入行上的 ↵，因此只同步该元素的内部子树，绝不重建
                        // Shadow DOM，也不触发 renderEdit。
                        const raw = sourceForRegion(session.region);
                        const offsets = editorSelectionOffsets(editable);
                        const normalized = normalizeParagraphBreaksInChangedLines(
                            editableSourceText(editable),
                            offsets?.start ?? 0,
                            offsets?.end ?? offsets?.start ?? 0,
                            offsets?.start,
                            offsets?.end
                        );
                        const nextEditable = configureSourceEditor(
                            visualEditorForRegion(session.shell, session.region, raw),
                            session.region
                        );
                        if (editableSourceText(nextEditable) === raw) {
                            editable.replaceChildren(...nextEditable.childNodes);
                            restoreEditorOffsets(
                                editable,
                                raw,
                                normalized.selectionStart,
                                normalized.selectionEnd
                            );
                            refreshLocalMarkers(
                                session,
                                normalized.selectionStart,
                                normalized.selectionEnd
                            );
                            installMappings(state.root);
                        }
                        state.compositionRetiredEditable = editable;
                    }
                    return committed;
                }

                // Enter 后的重排、插件刷新或焦点同步可能在最终提交帧前
                // 替换 contenteditable。旧 DOM 即使断开，compositionend/input
                // 保存的文本快照仍是本次候选词的唯一可靠载体，不能直接丢弃。
                const snapshotText = String(pending.text ?? '');
                if (!snapshotText
                    || !pending.session.region
                    || !sourceHashValid(pending.session.region)) {
                    return false;
                }
                const currentRaw = sourceForRegion(pending.session.region);
                const offsets = pending.offsets || {
                    start: snapshotText.length,
                    end: snapshotText.length,
                };
                const normalized = normalizeParagraphBreaksInChangedLines(
                    snapshotText,
                    offsets.start,
                    offsets.end,
                    offsets.start,
                    offsets.end
                );
                const transaction = transact({
                    from: pending.session.region.sourceRange.start,
                    to: pending.session.region.sourceRange.end,
                    expected: currentRaw,
                    insert: normalized.source,
                    reason: 'flow-composition-snapshot',
                });
                if (!transaction) return false;

                // 旧 editable 已断开不等于整个编辑面都失效。先尝试在
                // 原 shell 内局部重建：若编译后的源码仍对应单一 edit
                // region，refreshSessionRegion() 会只替换该 shell 的编辑子树，
                // 并保留 Shadow DOM、其它 shell 和运行态节点。
                const locallyRefreshed = refreshSessionRegion(
                    pending.session,
                    transaction,
                    {
                        start: normalized.selectionStart,
                        end: normalized.selectionEnd,
                    }
                );
                if (locallyRefreshed
                    && pending.session.editable?.isConnected) {
                    state.activeSession = pending.session;
                    state.compositionRetiredEditable =
                        pending.session.editable;
                    try {
                        pending.session.editable.focus({
                            preventScroll: true,
                        });
                    } catch {
                        pending.session.editable.focus();
                    }
                    restoreEditorOffsets(
                        pending.session.editable,
                        normalized.source,
                        normalized.selectionStart,
                        normalized.selectionEnd
                    );
                    refreshLocalMarkers(
                        pending.session,
                        normalized.selectionStart,
                        normalized.selectionEnd
                    );
                    return true;
                }

                // 只有当前源码确实拆分/合并了 edit region，局部映射失败时
                // 才升级为全局编辑面重建；这是结构变化兜底，不是普通 IME
                // 输入的默认路径。
                state.compositionRetiredEditable = pending.editable;
                state.activeSession = null;
                context.renderPort?.invalidate?.(
                    'flow-composition-snapshot-committed'
                );
                context.renderPort?.renderEdit?.({ force: true });
                scheduleBoundaryFocus(
                    transaction.from + normalized.selectionEnd
                );
                return true;
            };

            root.addEventListener('input', (event) => {
                if (event.isComposing || state.composing) return;
                const editable = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const shell = event.target.closest?.('[data-vdoc-edit-key]');
                if (!editable || !shell) return;

                // composition 提交后，旧 contenteditable 仍可能有迟到的
                // input 事件冒泡到 root。它们不能再次创建会话或 flush，
                // 否则会用旧 Selection/旧映射重复写入源码。
                if (state.compositionRetiredEditable === editable) return;

                if (state.enterInputGuardEditable === editable
                    && state.enterInputGuardCount > 0
                    && (
                        event.inputType === 'insertParagraph'
                        || event.inputType === 'insertLineBreak'
                    )) {
                    // keydown 已经完成了 Enter 的视觉补丁；浏览器随后补发
                    // 的结构性 input 只是同一次操作的回执，不能再次进入
                    // 普通输入队列，否则会额外生成一行。
                    return;
                }

                if (state.compositionCommit?.editable === editable) {
                    // 最终 input 到达时只更新渲染态缓冲，并重新开始静默窗口。
                    // 绝不在 input 调用栈中提交源码或替换 event.target。
                    state.compositionCommit.inputObserved = true;
                    state.compositionCommit.text =
                        editableSourceText(editable);
                    state.compositionCommit.offsets =
                        editorSelectionOffsets(editable);
                    scheduleCompositionCommit();
                    return;
                }

                const session = state.activeSession?.editable === editable
                    ? state.activeSession
                    : beginSession(shell, editable);
                if (session) state.inputSync?.markInput(editable, event);
            }, options);

            root.addEventListener('compositionstart', (event) => {
                clearCompositionCommit();
                window.clearTimeout(state.textInputFlushTimer);
                state.textInputFlushTimer = 0;
                // 新的组合会话开始后，旧编辑器节点的迟到事件不再相关。
                // 只有在这里解除旧节点屏蔽，避免上一轮 compositionend
                // 后排队的 input 误入普通 flush 路径。
                state.compositionEpoch += 1;
                state.compositionRetiredEditable = null;
                const editable = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const shell = event.target.closest?.('[data-vdoc-edit-key]');
                state.composing = true;
                state.compositionSession = editable && shell
                    ? (state.activeSession?.editable === editable
                        ? state.activeSession
                        : beginSession(shell, editable))
                    : null;
            }, options);
            root.addEventListener('compositionend', (event) => {
                const session = state.compositionSession;
                const editable = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                state.composing = false;
                state.compositionSession = null;
                if (!session || !editable
                    || session.region.type !== 'markdown') {
                    clearCompositionCommit();
                    return;
                }

                // 不在 compositionend 中根据旧 Selection 手动插入 event.data。
                // 此时平台 IME 仍可能继续派发最终 beforeinput/input；同步重建
                // DOM 会关闭候选窗、丢字或重复提交。等待一个可被最终 input
                // 重置的静默窗口，从浏览器已固化的 DOM 整体同步。
                const epoch = state.compositionEpoch;
                state.compositionCommit = {
                    session,
                    editable,
                    epoch,
                    text: editableSourceText(editable),
                    offsets: editorSelectionOffsets(editable),
                };
                scheduleCompositionCommit();
            }, options);

            root.addEventListener('focusout', (event) => {
                const editor = event.target.closest?.(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const session = state.activeSession;
                if (!editor || session?.editable !== editor) return;
                window.requestAnimationFrame(() => {
                    if (state.activeSession !== session
                        || state.compositionCommit
                        || state.composing
                        || !session.shell?.isConnected
                        || session.shell.contains(state.root?.activeElement)
                        || context.isContextMenuOpen?.()) {
                        return;
                    }
                    deactivateSession(session);
                });
            }, options);

            const syncSelectionPresentation = () => {
                const captured = captureSelection();
                if (!captured) {
                    state.selectionRange = null;
                    state.selectionText = '';
                    context.onSelectionChange?.(selectionState());
                }
                const session = state.activeSession;
                const offsets = session?.editable?.isConnected
                    ? editorSelectionOffsets(session.editable)
                    : null;
                if (offsets) {
                    refreshLocalMarkers(
                        session,
                        offsets.start,
                        offsets.end
                    );
                }
            };
            root.addEventListener(
                'mouseup',
                syncSelectionPresentation,
                options
            );
            root.addEventListener(
                'keyup',
                syncSelectionPresentation,
                options
            );
            return api;
        }

        function flush() {
            // 保存、历史快照等后台调用不能穿透活动 IME 会话。共享输入核心
            // 先排空普通输入的最新 DOM 快照；composition 期间它会自行保持
            // pending，待 composition 提交器完成后再同步源码。
            if (inputPending()) return true;
            state.inputSync?.flush();
            return flushSession() || true;
        }

        function disposeSurface() {
            window.clearTimeout(state.textInputFlushTimer);
            state.textInputFlushTimer = 0;
            state.inputSync?.dispose();
            state.inputSync = null;
            window.clearTimeout(state.enterInputGuardTimer);
            state.enterInputGuardTimer = 0;
            state.enterInputGuardEditable = null;
            state.enterInputGuardCount = 0;
            state.abortController?.abort();
            state.abortController = null;
            if (state.compositionCommitTimer) {
                window.clearTimeout(state.compositionCommitTimer);
                state.compositionCommitTimer = 0;
            }
            if (state.compositionCommitFrame) {
                window.cancelAnimationFrame(state.compositionCommitFrame);
                state.compositionCommitFrame = 0;
            }
            if (state.boundaryFocusFrame) {
                window.cancelAnimationFrame(state.boundaryFocusFrame);
                state.boundaryFocusFrame = 0;
            }
            state.compositionCommit = null;
            state.composing = false;
            state.compositionSession = null;
            state.compositionRetiredEditable = null;
            state.deferredRender = null;
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
            insertionOffset,
            clipboardSourceSelection,
            captureSelection,
            selectionState,
            executeFormatting,
            insertStructure,
            canExecute,
            formattingState,
            captureViewState,
            restoreViewState,
            inputPending,
            deferRender,
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