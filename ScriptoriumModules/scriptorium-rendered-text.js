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
            const range = resolveSourceRange(source, record.snapshot, {
                ...patchOptions,
                textNodeCount: patchOptions.textNodeCount
                    ?? textNodes(record.root, {
                        ...patchOptions,
                        requireLayout: false,
                    }).length,
            });
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
        const controller = createController();
        let registration = null;

        function disposeSurface() {
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
            return Boolean(
                shell
                && root.contains(shell)
                && !host.closest('[data-vdoc-runtime-generated="true"]')
            );
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
            const patch = controller.sourcePatch(
                scoped.source,
                record,
                nextText,
                {
                    textNodeCount: textNodes(scoped.island, {
                        requireLayout: false,
                    }).length,
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
            scopes.forEach((scope) => {
                controller.scan(scope, {
                    editable: true,
                    acceptHost: (host, node) =>
                        editableIslandHost(host, node, root),
                    onRecord(record) {
                        if (record.host) hostRecords.set(record.host, record);
                    },
                });
            });
            registration = {
                root,
                scopes,
                adapter,
                abortController,
                hostRecords,
            };

            root.addEventListener('input', (event) => {
                const host = event.target.closest?.(
                    '[data-vdoc-rendered-text-editable="true"]'
                );
                if (!host || !root.contains(host)) return;
                const record = hostRecords.get(host);
                if (!record) return;
                const nextText = normalizedText(host.textContent);
                if (applyFlowInput(adapter, host, record, nextText)) {
                    record.snapshot = {
                        ...record.snapshot,
                        text: nextText,
                    };
                }
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
        elementPath,
        elementAtPath,
        textNodeAtPath,
        makeEditable,
        DEFAULT_EXCLUDED_SELECTOR,
        DEFAULT_INTERACTIVE_SELECTOR,
    });
})();