'use strict';

(() => {
    const DEFAULT_EXCLUDED_SELECTOR = [
        'script',
        'style',
        'noscript',
        'canvas',
        'svg',
        'video',
        'audio',
        'input',
        'textarea',
        'select',
        '[data-vdoc-atomic]',
        '[data-vdoc-object-resize-handle]',
        '[data-vdoc-md-live-preview]',
    ].join(',');

    const DEFAULT_INTERACTIVE_SELECTOR = [
        'a',
        'button',
        'input',
        'textarea',
        'select',
        'audio',
        'video',
        '[role="button"]',
    ].join(',');

    function normalizedText(value) {
        return String(value ?? '');
    }

    function isVisibleTextNode(node, options = {}) {
        if (node?.nodeType !== Node.TEXT_NODE || !normalizedText(node.nodeValue).trim()) {
            return false;
        }
        const parent = node.parentElement;
        if (!parent || parent.closest(
            options.excludedSelector || DEFAULT_EXCLUDED_SELECTOR
        )) {
            return false;
        }
        if (options.requireLayout !== false) {
            const style = getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden'
                || style.contentVisibility === 'hidden') {
                return false;
            }
        }
        return options.acceptNode?.(node) !== false;
    }

    function textNodes(root, options = {}) {
        if (!root) return [];
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return isVisibleTextNode(node, options)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            },
        });
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            nodes.push(node);
        }
        return nodes;
    }

    function elementPath(root, element) {
        if (!root || !element || (element !== root && !root.contains(element))) {
            return null;
        }
        const path = [];
        for (let current = element; current && current !== root;) {
            const parent = current.parentElement;
            if (!parent) return null;
            path.unshift([...parent.children].indexOf(current));
            current = parent;
        }
        return path;
    }

    function elementAtPath(root, path) {
        let current = root;
        for (const index of path || []) {
            current = current?.children?.[index] || null;
            if (!current) return null;
        }
        return current;
    }

    function textNodeIndex(node) {
        return node?.parentElement
            ? [...node.parentElement.childNodes].indexOf(node)
            : -1;
    }

    function textNodeAtPath(root, path, index) {
        const element = elementAtPath(root, path);
        const node = element?.childNodes?.[index] || null;
        return node?.nodeType === Node.TEXT_NODE ? node : null;
    }

    function fingerprint(root, node, options = {}) {
        if (!root || !isVisibleTextNode(node, {
            ...options,
            requireLayout: false,
        })) {
            return null;
        }
        const nodes = textNodes(root, {
            ...options,
            requireLayout: false,
        });
        const ordinal = nodes.indexOf(node);
        if (ordinal < 0) return null;
        const text = normalizedText(node.nodeValue);
        const sameTextOrdinal = nodes
            .slice(0, ordinal + 1)
            .filter((candidate) => candidate.nodeValue === text)
            .length - 1;
        return {
            text,
            ordinal,
            sameTextOrdinal,
            previousText: normalizedText(nodes[ordinal - 1]?.nodeValue),
            nextText: normalizedText(nodes[ordinal + 1]?.nodeValue),
            path: elementPath(root, node.parentElement),
            textNodeIndex: textNodeIndex(node),
            parentTag: node.parentElement?.tagName || '',
        };
    }

    function diffText(previousValue, nextValue) {
        const previous = normalizedText(previousValue);
        const next = normalizedText(nextValue);
        if (previous === next) return null;

        let prefix = 0;
        const shared = Math.min(previous.length, next.length);
        while (prefix < shared && previous[prefix] === next[prefix]) prefix += 1;

        let previousEnd = previous.length;
        let nextEnd = next.length;
        while (
            previousEnd > prefix
            && nextEnd > prefix
            && previous[previousEnd - 1] === next[nextEnd - 1]
        ) {
            previousEnd -= 1;
            nextEnd -= 1;
        }
        return {
            prefix,
            previousEnd,
            nextEnd,
            removed: previous.slice(prefix, previousEnd),
            inserted: next.slice(prefix, nextEnd),
        };
    }

    function allOccurrences(source, needle) {
        const value = normalizedText(needle);
        if (!value) return [];
        const matches = [];
        let offset = source.indexOf(value);
        while (offset >= 0) {
            matches.push({ start: offset, end: offset + value.length });
            offset = source.indexOf(value, offset + Math.max(1, value.length));
        }
        return matches;
    }

    function nearbyAnchorScore(source, candidate, anchor, direction) {
        const value = normalizedText(anchor);
        if (!value) return 0;
        const windowSize = Math.max(96, Math.min(2048, value.length * 8));
        if (direction < 0) {
            const start = Math.max(0, candidate.start - windowSize);
            const found = source.lastIndexOf(value, candidate.start);
            if (found < start) return 0;
            const distance = candidate.start - (found + value.length);
            return 32 - Math.min(28, Math.floor(distance / 16));
        }
        const end = Math.min(source.length, candidate.end + windowSize);
        const found = source.indexOf(value, candidate.end);
        if (found < 0 || found > end) return 0;
        const distance = found - candidate.end;
        return 32 - Math.min(28, Math.floor(distance / 16));
    }

    function resolveSourceRange(sourceValue, snapshot, options = {}) {
        const source = normalizedText(sourceValue);
        const text = normalizedText(snapshot?.text);
        if (!source || !text) return null;
        const candidates = allOccurrences(source, text);
        if (!candidates.length) return null;
        if (candidates.length === 1) {
            return {
                ...candidates[0],
                confidence: 1,
                reason: 'unique-text',
                candidates: 1,
            };
        }

        const expectedRatio = Number.isFinite(snapshot?.ordinal)
            && Number.isFinite(options.textNodeCount)
            && options.textNodeCount > 1
            ? snapshot.ordinal / (options.textNodeCount - 1)
            : null;
        const expectedOffset = expectedRatio === null
            ? null
            : Math.round(expectedRatio * source.length);

        const ranked = candidates.map((candidate, occurrence) => {
            let score = 0;
            score += nearbyAnchorScore(
                source,
                candidate,
                snapshot.previousText,
                -1
            );
            score += nearbyAnchorScore(
                source,
                candidate,
                snapshot.nextText,
                1
            );
            if (occurrence === snapshot.sameTextOrdinal) score += 18;
            if (expectedOffset !== null) {
                const relativeDistance = Math.abs(candidate.start - expectedOffset)
                    / Math.max(1, source.length);
                score += Math.max(0, 16 - Math.round(relativeDistance * 32));
            }
            return { ...candidate, score, occurrence };
        }).sort((left, right) =>
            right.score - left.score || left.start - right.start
        );

        const winner = ranked[0];
        const runnerUp = ranked[1];
        const margin = winner.score - (runnerUp?.score || 0);
        const minimumScore = Number(options.minimumScore) || 18;
        const minimumMargin = Number(options.minimumMargin) || 8;
        if (winner.score < minimumScore || margin < minimumMargin) return null;
        return {
            start: winner.start,
            end: winner.end,
            confidence: Math.min(0.99, .5 + winner.score / 160 + margin / 100),
            reason: 'context-ranked',
            candidates: candidates.length,
            score: winner.score,
            margin,
        };
    }

    function sourceTextFields(sourceValue) {
        const source = normalizedText(sourceValue);
        const fields = [];
        const push = (value, kind, start) => {
            const text = normalizedText(value).trim();
            if (!text || text.length < 2) return;
            if (/^[\w\s.#:[\](){},;+*/'"`=-]+$/.test(text)) return;
            fields.push({ text, kind, start });
        };

        // 保持与原始岛源码完全相同的字符偏移；删除 style 会让后续
        // script 字段的定位整体前移，必须使用等长空格屏蔽。
        const withoutStyle = source.replace(
            /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
            (match) => ' '.repeat(match.length)
        );
        const scriptRanges = [];
        withoutStyle.replace(
            /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,
            (match, body, offset) => {
                scriptRanges.push({
                    start: offset,
                    end: offset + match.length,
                    body,
                    bodyStart: offset + match.indexOf(body),
                });
                return match;
            }
        );

        const staticSource = withoutStyle.replace(
            /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
            (match) => ' '.repeat(match.length)
        );
        staticSource.replace(
            />([^<>]+)</g,
            (match, text, offset) => {
                push(text, 'html', offset + 1);
                return match;
            }
        );

        scriptRanges.forEach(({ body, bodyStart }) => {
            const stringPattern = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
            let match;
            while ((match = stringPattern.exec(body))) {
                const value = match[2]
                    .replace(/\\(['"`\\])/g, '$1')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (!value || value.length < 2) continue;
                if (/^[.#\[\]()[\]{}:_-]+$/.test(value)) continue;
                if (!/[\u3400-\u9fff]|[A-Za-z]{2,}/.test(value)) continue;
                const valueStart = bodyStart + match.index + match[0].indexOf(match[2]);
                push(value, 'script', valueStart);
            }
        });

        return fields.sort((left, right) => left.start - right.start);
    }

    function sequenceSourceRange(sourceValue, snapshot, options = {}) {
        const source = normalizedText(sourceValue);
        const text = normalizedText(snapshot?.text).trim();
        if (!source || !text) return null;

        const fields = sourceTextFields(source);
        if (!fields.length) return null;

        const visualOrdinal = Number.isFinite(snapshot?.ordinal)
            ? snapshot.ordinal
            : null;
        const visualCount = Number(options.textNodeCount);
        if (visualOrdinal === null || !Number.isFinite(visualCount)
            || visualCount < 1) return null;

        const exact = fields
            .map((field, index) => ({ ...field, index }))
            .filter((field) =>
                field.text === text
                || field.text.includes(text)
                || text.includes(field.text)
            );
        if (!exact.length) return null;

        const expectedIndex = visualOrdinal / Math.max(1, visualCount - 1)
            * Math.max(0, fields.length - 1);
        const previousText = normalizedText(snapshot.previousText).trim();
        const nextText = normalizedText(snapshot.nextText).trim();

        const ranked = exact.map((field) => {
            let score = 0;
            const distance = Math.abs(field.index - expectedIndex);
            score += Math.max(0, 42 - Math.round(distance * 8));
            if (field.text === text) score += 24;
            if (previousText && fields[field.index - 1]?.text.includes(previousText)) {
                score += 20;
            }
            if (nextText && fields[field.index + 1]?.text.includes(nextText)) {
                score += 20;
            }
            return { field, score };
        }).sort((left, right) =>
            right.score - left.score || left.field.start - right.field.start
        );

        const winner = ranked[0];
        const runnerUp = ranked[1];
        const margin = winner.score - (runnerUp?.score || 0);
        if (!winner || winner.score < 30 || (runnerUp && margin < 10)) {
            return null;
        }

        const start = winner.field.start;
        const end = start + winner.field.text.length;
        const exactStart = source.indexOf(text, start);
        if (exactStart < 0 || exactStart >= end) return null;

        return {
            start: exactStart,
            end: exactStart + text.length,
            confidence: Math.min(0.95, .55 + winner.score / 200 + margin / 120),
            reason: 'island-text-sequence',
            candidates: exact.length,
            score: winner.score,
            margin,
        };
    }

    function editableHostFor(node, scope, options = {}) {
        const host = node?.parentElement;
        if (!host || !scope?.contains(host) || host === scope) return null;
        if (host.closest(options.interactiveSelector || DEFAULT_INTERACTIVE_SELECTOR)) {
            return null;
        }
        if (options.acceptHost?.(host, node) === false) return null;
        return host;
    }

    function makeEditable(node, scope, options = {}) {
        const host = editableHostFor(node, scope, options);
        if (!host) return null;
        host.contentEditable = 'true';
        host.spellcheck = false;
        host.dataset.vdocRenderedTextEditable = 'true';
        host.setAttribute('role', 'textbox');
        host.setAttribute('aria-multiline', 'false');
        return host;
    }

    function createController(options = {}) {
        const records = new WeakMap();
        const roots = new Map();

        function scan(root, scanOptions = {}) {
            if (!root) return [];
            const nodes = textNodes(root, scanOptions);
            const discovered = [];
            nodes.forEach((node) => {
                const existing = records.get(node);
                const snapshot = fingerprint(root, node, scanOptions);
                if (!snapshot) return;
                const record = existing || {
                    root,
                    node,
                    host: null,
                    snapshot,
                };
                record.root = root;
                record.node = node;
                record.snapshot = snapshot;
                if (scanOptions.editable !== false) {
                    record.host = makeEditable(node, root, scanOptions);
                }
                records.set(node, record);
                discovered.push(record);
                scanOptions.onRecord?.(record);
            });
            roots.set(root, { options: scanOptions });
            return discovered;
        }

        function refresh(root) {
            const registration = roots.get(root);
            return registration ? scan(root, registration.options) : [];
        }

        function recordFor(node) {
            return records.get(node) || null;
        }

        function capture(root, node, captureOptions = {}) {
            const snapshot = fingerprint(root, node, captureOptions);
            if (!snapshot) return null;
            const record = records.get(node) || {
                root,
                node,
                host: editableHostFor(node, root, captureOptions),
            };
            record.snapshot = snapshot;
            records.set(node, record);
            return record;
        }

        function sourcePatch(source, record, nextText, patchOptions = {}) {
            if (!record?.snapshot) return null;
            const textNodeCount = patchOptions.textNodeCount
                ?? textNodes(record.root, {
                    ...patchOptions,
                    requireLayout: false,
                }).length;
            const sequencePatch = () => sequenceSourceRange(
                source,
                record.snapshot,
                { ...patchOptions, textNodeCount }
            );
            const standardPatch = () => resolveSourceRange(
                source,
                record.snapshot,
                { ...patchOptions, textNodeCount }
            );
            const range = patchOptions.preferSequence
                ? (sequencePatch() || standardPatch())
                : (standardPatch() || sequencePatch());
            if (!range) return null;
            const replacement = normalizedText(nextText);
            return {
                ...range,
                previousText: record.snapshot.text,
                nextText: replacement,
                source: source.slice(0, range.start)
                    + replacement
                    + source.slice(range.end),
            };
        }

        function dispose(root = null) {
            if (root) {
                roots.delete(root);
                return;
            }
            roots.clear();
        }

        return Object.freeze({
            scan,
            refresh,
            capture,
            recordFor,
            sourcePatch,
            resolveSourceRange,
            diffText,
            textNodes,
            fingerprint,
            elementPath,
            elementAtPath,
            textNodeAtPath,
            dispose,
            options,
        });
    }

    function createRenderedTextController(context = {}) {
        const historyPort = context.historyPort;
        const notificationPort = context.notificationPort || {};
        const getVisibilityPort = context.getVisibilityPort
            || (() => context.visibilityPort);
        const controller = createController();
        let registration = null;

        function disposeSurface() {
            registration?.observer?.disconnect();
            registration?.abortController.abort();
            registration?.scopes?.forEach((scope) =>
                controller.dispose(scope)
            );
            registration = null;
        }

        function editableIslandHost(host, _node, root) {
            const shell = host.closest?.(
                '[data-vdoc-edit-key][data-vdoc-edit-type="island"]'
            );
            // data-vdoc-runtime-generated 只表示节点由岛脚本建立，用于区分
            // 运行态 DOM 与持久源码结构；它不是禁止选择或编辑的安全边界。
            // 动态表格、图例和数据卡片中的文字仍需通过源码文本匹配或
            // 上下文/相对位置回退写回岛内脚本源码。
            return Boolean(shell && root.contains(shell));
        }

        function islandSource(adapter, host) {
            const island = host.closest?.('[data-vdoc-island]');
            const islandId = String(island?.dataset.vdocIsland || '');
            if (!islandId || adapter?.kind !== 'flow') return null;
            const compiled = adapter.compile();
            const region = compiled.editRegions.find((candidate) =>
                candidate.type === 'island'
                && candidate.islandId === islandId
            );
            if (!region) return null;
            return {
                island,
                islandId,
                region,
                source: adapter.currentSource().slice(
                    region.sourceRange.start,
                    region.sourceRange.end
                ),
            };
        }

        function applyFlowInput(adapter, host, record, nextText) {
            const scoped = islandSource(adapter, host);
            if (!scoped) return false;
            const sourceRecord = record.sourceSnapshot
                ? {
                    ...record,
                    snapshot: record.sourceSnapshot,
                }
                : record;
            const replacement = record.projectEditedText
                ? record.projectEditedText(nextText)
                : nextText;
            const isRuntimeGenerated = Boolean(
                record.node?.parentElement?.closest?.(
                    '[data-vdoc-runtime-generated="true"]'
                )
            );
            const patch = controller.sourcePatch(
                scoped.source,
                sourceRecord,
                replacement,
                {
                    textNodeCount: textNodes(scoped.island, {
                        requireLayout: false,
                    }).length,
                    preferSequence: record.preferSequence
                        || isRuntimeGenerated,
                }
            );
            if (!patch) {
                notificationPort.show?.(
                    '无法唯一定位岛内文字，本次输入未写入源码。',
                    'error'
                );
                return false;
            }
            const start = scoped.region.sourceRange.start;
            const source = adapter.currentSource();
            const nextSource = source.slice(0, start + patch.start)
                + patch.nextText
                + source.slice(start + patch.end);
            if (!adapter.replaceCurrentSource(nextSource, {
                reason: 'rendered-island-text-input',
            })) {
                return false;
            }
            historyPort?.schedule?.();
            return true;
        }

        function activate(input = {}) {
            disposeSurface();
            const { root, adapter } = input;
            if (!root || !adapter || input.kind !== 'flow') return false;

            const abortController = new AbortController();
            const hostRecords = new WeakMap();
            const scopes = [
                ...root.querySelectorAll(
                    '[data-vdoc-edit-key][data-vdoc-edit-type="island"] '
                    + '[data-vdoc-island]'
                ),
            ];
            const scanOptions = {
                editable: false,
                acceptHost: (host, node) =>
                    editableIslandHost(host, node, root),
            };
            const scanScope = (scope) => {
                if (!scope?.isConnected || !root.contains(scope)) return [];
                const scoped = islandSource(adapter, scope);
                if (!scoped) return [];
                const records = controller.scan(scope, scanOptions);
                const textNodeCount = records.length;
                records.forEach((record) => {
                    const host = editableHostFor(
                        record.node,
                        scope,
                        scanOptions
                    );
                    if (!host) return;

                    // contenteditable 作用于元素而非 Text 节点。仅在宿主的全部
                    // 文本都由当前节点承担时开放输入，避免把含多个行内 span 的
                    // 混合父元素整体改写；各 span 叶子仍会分别参与后续扫描。
                    const nodeText = normalizedText(record.node.nodeValue);
                    if (normalizedText(host.textContent) !== nodeText) return;

                    // 第一层：保留原始空白的节点级匹配。第二层：HTML 解析可能
                    // 将 CRLF、缩进或标签外围换行规范化，此时改用核心可见文本
                    // 匹配，并在提交时只投影用户编辑后的核心文字，保留源码排版。
                    let sourceSnapshot = record.snapshot;
                    let sequenceRange = sequenceSourceRange(
                        scoped.source,
                        sourceSnapshot,
                        { textNodeCount }
                    );
                    let standardRange = controller.resolveSourceRange(
                        scoped.source,
                        sourceSnapshot,
                        { textNodeCount }
                    );
                    let range = sequenceRange || standardRange;
                    record.preferSequence = Boolean(sequenceRange);
                    if (!range) {
                        const coreText = nodeText.trim();
                        if (!coreText) return;
                        sourceSnapshot = {
                            ...record.snapshot,
                            text: coreText,
                            previousText: normalizedText(
                                record.snapshot.previousText
                            ).trim(),
                            nextText: normalizedText(
                                record.snapshot.nextText
                            ).trim(),
                        };
                        sequenceRange = sequenceSourceRange(
                            scoped.source,
                            sourceSnapshot,
                            { textNodeCount }
                        );
                        standardRange = controller.resolveSourceRange(
                            scoped.source,
                            sourceSnapshot,
                            { textNodeCount }
                        );
                        range = sequenceRange || standardRange;
                        record.preferSequence = Boolean(sequenceRange);
                        if (range) {
                            record.projectEditedText = (value) =>
                                normalizedText(value).trim();
                        }
                    }
                    if (!range) {
                        // 占位符或纯计算结果仍可参与浏览器原生选择，但不会进入
                        // 输入态；“可见文字”与“可可靠写回源码”在这里明确解耦。
                        return;
                    }
                    record.sourceSnapshot = sourceSnapshot;
                    record.sourceRange = range;
                    record.host = makeEditable(
                        record.node,
                        scope,
                        scanOptions
                    );
                    if (record.host) hostRecords.set(record.host, record);
                });
                return records;
            };
            scopes.forEach(scanScope);

            // 岛脚本通常在静态 Surface 建立后才生成表格行、图例或数据卡片。
            // 监听子树结构变化，为后插入文字增量建立可编辑宿主和双重源码定位
            // 快照。只观察 childList，避免用户输入文字时刷新正在提交的快照。
            const observer = new MutationObserver((records) => {
                const changedScopes = new Set();
                records.forEach((record) => {
                    const scope = record.target?.closest?.('[data-vdoc-island]');
                    if (scope && scopes.includes(scope)) {
                        changedScopes.add(scope);
                    }
                });
                changedScopes.forEach(scanScope);
            });
            scopes.forEach((scope) => observer.observe(scope, {
                childList: true,
                subtree: true,
            }));

            registration = {
                root,
                scopes,
                adapter,
                abortController,
                hostRecords,
                observer,
            };

            // MutationObserver 在当前任务结束后运行。用户若恰好在动态节点刚
            // 插入的同一帧点击，必须在浏览器建立默认 Selection 前同步补扫。
            root.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                const scope = event.target.closest?.('[data-vdoc-island]');
                if (!scope || !scopes.includes(scope)) return;
                scanScope(scope);
            }, {
                capture: true,
                signal: abortController.signal,
            });

            const sessions = new WeakMap();

            function renderedTextHost(target) {
                const host = target?.closest?.(
                    '[data-vdoc-rendered-text-editable="true"]'
                );
                return host && root.contains(host) ? host : null;
            }

            function finishRuntimePause(session) {
                if (!session?.island || !session.pausedByEditor) return;
                getVisibilityPort()?.resume?.(session.island);
                session.pausedByEditor = false;
            }

            function commitHost(host) {
                const session = sessions.get(host);
                sessions.delete(host);
                if (!session) return true;
                const nextText = normalizedText(host.textContent);
                if (nextText === session.previousText) {
                    finishRuntimePause(session);
                    return true;
                }
                if (applyFlowInput(
                    adapter,
                    host,
                    session.record,
                    nextText
                )) {
                    session.record.snapshot = {
                        ...session.record.snapshot,
                        text: nextText,
                    };
                    finishRuntimePause(session);
                    return true;
                }

                finishRuntimePause(session);

                // 映射在编辑期间因外部源码变化而失效时，不留下“看似改好但
                // 无法保存”的运行态假象；恢复进入编辑前的可持久文本。
                host.textContent = session.previousText;
                return false;
            }

            function adjacentEditableHost(host, backwards = false) {
                const hosts = [
                    ...root.querySelectorAll(
                        '[data-vdoc-rendered-text-editable="true"]'
                    ),
                ].filter((candidate) =>
                    candidate.isConnected
                    && candidate.contentEditable === 'true'
                );
                const index = hosts.indexOf(host);
                if (index < 0) return null;
                return hosts[index + (backwards ? -1 : 1)] || null;
            }

            function finishHostEditing(host, nextHost = null) {
                commitHost(host);
                if (nextHost?.isConnected) {
                    try {
                        nextHost.focus({ preventScroll: true });
                    } catch {
                        nextHost.focus();
                    }
                    return;
                }
                host.blur();
            }

            root.addEventListener('focusin', (event) => {
                const host = renderedTextHost(event.target);
                if (!host) return;
                const record = hostRecords.get(host);
                if (!record) return;
                const island = host.closest?.('[data-vdoc-island]');
                const visibility = getVisibilityPort();
                const wasPaused = Boolean(
                    island && visibility?.isPaused?.(island)
                );
                if (island && !wasPaused) visibility?.pause?.(island);
                sessions.set(host, {
                    record,
                    previousText: normalizedText(host.textContent),
                    island,
                    pausedByEditor: Boolean(island && !wasPaused),
                });
            }, { signal: abortController.signal });

            // 独立 HTML 岛文本采用单行提交语义。Enter 固化并退出；Tab
            // 固化后顺序切换宿主，绝不让浏览器向岛内插入换行或缩进。
            root.addEventListener('keydown', (event) => {
                if (event.defaultPrevented
                    || event.isComposing
                    || event.keyCode === 229
                    || event.ctrlKey
                    || event.metaKey
                    || event.altKey) {
                    return;
                }
                const host = renderedTextHost(event.target);
                if (!host || (event.key !== 'Enter' && event.key !== 'Tab')) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                const nextHost = event.key === 'Tab'
                    ? adjacentEditableHost(host, event.shiftKey)
                    : null;
                finishHostEditing(host, nextHost);
            }, { signal: abortController.signal });

            // 虚拟键盘、辅助输入设备及部分输入法可能不派发普通 keydown。
            // 在 beforeinput 再次封锁段落/换行，保持 HTML 岛单行不变量。
            root.addEventListener('beforeinput', (event) => {
                if (event.defaultPrevented || event.isComposing) return;
                if (event.inputType !== 'insertParagraph'
                    && event.inputType !== 'insertLineBreak') {
                    return;
                }
                const host = renderedTextHost(event.target);
                if (!host) return;
                event.preventDefault();
                finishHostEditing(host);
            }, { signal: abortController.signal });

            // 普通点击离开仍沿用 focusout 提交；显式 Enter/Tab 已删除会话，
            // 因此这里不会重复写入源码或重复创建历史记录。
            root.addEventListener('focusout', (event) => {
                const host = renderedTextHost(event.target);
                if (!host) return;
                commitHost(host);
            }, { signal: abortController.signal });

            return true;
        }

        function dispose() {
            disposeSurface();
            controller.dispose();
        }

        return Object.freeze({
            activate,
            disposeSurface,
            dispose,
        });
    }

    window.ScriptoriumRenderedText = Object.freeze({
        createController,
        createRenderedTextController,
        textNodes,
        fingerprint,
        diffText,
        resolveSourceRange,
        sequenceSourceRange,
        sourceTextFields,
        elementPath,
        elementAtPath,
        textNodeAtPath,
        makeEditable,
        DEFAULT_EXCLUDED_SELECTOR,
        DEFAULT_INTERACTIVE_SELECTOR,
    });
})();