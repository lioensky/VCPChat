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

        function inlineHtmlTagRecords(raw) {
            const source = String(raw || '');
            const allowed = new Set([
                'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code',
                'del', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'q',
                's', 'samp', 'small', 'span', 'strike', 'strong',
                'sub', 'sup', 'time', 'tt', 'u', 'var', 'br', 'wbr',
            ]);
            const voidTags = new Set(['br', 'wbr']);
            const records = [];
            const pattern = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
            let match;
            while ((match = pattern.exec(source))) {
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

        function refreshLocalMarkers(session, sourceStart, sourceEnd = sourceStart) {
            if (!session?.editable?.isConnected) return false;
            const raw = String(session.editable.textContent || '');
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

        function inlineHtmlSourceFragment(raw, baseOffset = 0) {
            const source = String(raw || '');
            const records = inlineHtmlTagRecords(source);
            if (!records.length) {
                return markdownSourceFragment(source, baseOffset);
            }

            const fragment = document.createDocumentFragment();
            const stack = [{ tag: null, container: fragment }];
            const current = () => stack[stack.length - 1].container;
            let offset = 0;

            records.forEach((record) => {
                if (record.start > offset) {
                    current().appendChild(markdownSourceFragment(
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
                current().appendChild(markdownSourceFragment(
                    source.slice(offset),
                    baseOffset + offset
                ));
            }
            return fragment;
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
                element = rendered
                    && !rendered.matches('ul,ol,table,thead,tbody,tr')
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
            const lines = source.split('\n');
            const renderedLines = renderedLineCandidates(shell);

            if (lines.length === 1) {
                const editor = markdownLineElement(
                    source,
                    renderedLines[0] || shell.firstElementChild
                );
                editor.replaceChildren(inlineHtmlSourceFragment(source));
                return editor;
            }

            const editor = document.createElement('div');
            editor.className = 'vdoc-md-live-preview-run';
            let sourceOffset = 0;
            let renderedIndex = 0;
            lines.forEach((line, lineIndex) => {
                if (lineIndex) {
                    editor.appendChild(document.createTextNode('\n'));
                    sourceOffset += 1;
                }
                const lineElement = markdownLineElement(
                    line,
                    line.length
                        ? renderedLines[renderedIndex] || null
                        : null
                );
                if (line.length) {
                    renderedIndex += 1;
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
                region.type === 'markdown'
                    ? createMarkdownVisualEditor(shell, raw)
                    : document.createElement('div'),
                region
            );
            if (region.type !== 'markdown') editor.textContent = raw;
            if (String(editor.textContent || '') !== raw) {
                notificationPort.show?.(
                    '当前 Markdown 无法建立无损渲染态编辑映射。',
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
            selectionPrimitives.restoreOffsets(editor, localOffset);
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
                    const offsets =
                        selectionPrimitives.currentOffsets(editor);
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
                        const settled =
                            selectionPrimitives.currentOffsets(editor);
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
                        if (marker.end === localStart) {
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
                patchFormattedRegion(selection, transaction);
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

        function refreshSessionRegion(
            session,
            transaction,
            selectionOffsets = null
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
            const nextEditable = configureSourceEditor(
                nextRegion.type === 'markdown'
                    ? createMarkdownVisualEditor(session.shell, nextRaw)
                    : document.createElement('div'),
                nextRegion
            );
            if (nextRegion.type !== 'markdown') {
                nextEditable.textContent = nextRaw;
            }
            if (String(nextEditable.textContent || '') !== nextRaw) {
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
            selectionPrimitives.restoreOffsets(
                nextEditable,
                selectionStart,
                selectionEnd
            );
            refreshLocalMarkers(session, selectionStart, selectionEnd);
            installMappings(state.root);
            return true;
        }

        function replaceActiveSelection(session, insertion, reason) {
            if (!session?.editable?.isConnected
                || session.region?.type !== 'markdown') {
                return false;
            }
            const offsets = selectionPrimitives.currentOffsets(
                session.editable
            );
            if (!offsets) return false;

            const currentText = String(session.editable.textContent || '');
            const nextText = currentText.slice(0, offsets.start)
                + String(insertion || '')
                + currentText.slice(offsets.end);
            const caret = offsets.start + String(insertion || '').length;

            // 直接把键盘语义落实为纯文本，再由统一事务重新构建带 Markdown
            // 装饰的编辑树；不依赖各 Chromium 版本生成不同的 div/br DOM。
            session.editable.textContent = nextText;
            selectionPrimitives.restoreOffsets(
                session.editable,
                caret
            );
            return flushSession(session, reason);
        }

        function handleEditorKeydown(event) {
            if (event.defaultPrevented
                || event.isComposing
                || state.composing
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
            if (!session || session.region.type !== 'markdown') return false;

            const offsets = selectionPrimitives.currentOffsets(editable);
            if (!offsets || !offsets.collapsed) return false;
            const text = String(editable.textContent || '');

            if (event.key === 'Tab' && !event.shiftKey) {
                const lineStart = text.lastIndexOf(
                    '\n',
                    Math.max(0, offsets.start - 1)
                ) + 1;
                const lineBreak = text.indexOf('\n', lineStart);
                const line = text.slice(
                    lineStart,
                    lineBreak < 0 ? text.length : lineBreak
                );
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

            if (event.key === 'Enter'
                && !event.shiftKey
                && offsets.start === text.length) {
                event.preventDefault();
                // Markdown 的两个行尾半角空格加换行会稳定编译成 <br>，
                // 是“真换行”；单独 \n 只属于源码软换行，渲染时会折叠。
                return replaceActiveSelection(
                    session,
                    '  \n',
                    'flow-keyboard-hard-line-break'
                );
            }
            return false;
        }

        function flushSession(
            session = state.activeSession,
            reason = 'flow-text-input'
        ) {
            if (!session?.shell?.isConnected
                || !session.editable?.isConnected) {
                return false;
            }
            const nextText = String(session.editable.textContent || '');
            if (nextText === session.previousText) return false;
            const selectionOffsets =
                selectionPrimitives.currentOffsets(session.editable);
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
                selectionOffsets
            )) {
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

            root.addEventListener('contextmenu', (event) => {
                if (event.target.closest?.('[data-vdoc-object-id]')) return;
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

            root.addEventListener('keydown', handleEditorKeydown, options);

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
                    ? selectionPrimitives.currentOffsets(session.editable)
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
            clipboardSourceSelection,
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