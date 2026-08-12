'use strict';

(() => {
    function selectionFor(root) {
        return root?.getSelection?.() || window.getSelection();
    }

    function elementOf(node) {
        if (node?.nodeType === Node.ELEMENT_NODE) return node;
        return node?.parentElement || null;
    }

    function containsRange(root, range) {
        return Boolean(
            root
            && range
            && root.contains(range.startContainer)
            && root.contains(range.endContainer)
        );
    }

    function cloneLiveRange(root, options = {}) {
        const selection = selectionFor(root);
        if (!selection?.rangeCount) return null;
        const range = selection.getRangeAt(0);
        if (!containsRange(root, range)) return null;
        if (options.expanded === true && range.collapsed) return null;
        return range.cloneRange();
    }

    function textNodes(root, options = {}) {
        if (!root) return [];
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (options.acceptNode?.(node) === false) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (options.excludeSelector
                    && node.parentElement?.closest(options.excludeSelector)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            nodes.push(node);
        }
        return nodes;
    }

    function textOffsetWithin(root, node, offset) {
        if (!root || !node || (node !== root && !root.contains(node))) return null;
        try {
            const prefix = document.createRange();
            prefix.selectNodeContents(root);
            prefix.setEnd(node, offset);
            return prefix.toString().length;
        } catch {
            return null;
        }
    }

    function textPointAt(root, wantedOffset, options = {}) {
        const offset = Math.max(0, Number(wantedOffset) || 0);
        const nodes = textNodes(root, options);
        let consumed = 0;
        for (const node of nodes) {
            const length = String(node.nodeValue || '').length;
            if (consumed + length >= offset) {
                return Object.freeze({
                    node,
                    offset: Math.min(length, offset - consumed),
                });
            }
            consumed += length;
        }
        return Object.freeze({
            node: root,
            offset: root?.childNodes?.length || 0,
        });
    }

    function rangeOffsetsWithin(root, range) {
        if (!containsRange(root, range)) return null;
        const start = textOffsetWithin(root, range.startContainer, range.startOffset);
        const end = textOffsetWithin(root, range.endContainer, range.endOffset);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        return Object.freeze({
            start: Math.min(start, end),
            end: Math.max(start, end),
            collapsed: range.collapsed,
        });
    }

    function currentOffsets(root) {
        const range = cloneLiveRange(root);
        return range ? rangeOffsetsWithin(root, range) : null;
    }

    function restoreOffsets(root, start, end = start, options = {}) {
        if (!root?.isConnected) return false;
        const startPoint = textPointAt(root, start, options);
        const endPoint = textPointAt(root, end, options);
        try {
            const range = document.createRange();
            range.setStart(startPoint.node, startPoint.offset);
            range.setEnd(endPoint.node, endPoint.offset);
            const selection = selectionFor(root.getRootNode?.() || root);
            selection.removeAllRanges();
            selection.addRange(range);
            return range;
        } catch {
            return false;
        }
    }

    function selectNodeContents(node, options = {}) {
        if (!node?.isConnected) return false;
        try {
            const range = document.createRange();
            range.selectNodeContents(node);
            if (options.collapse === 'start') range.collapse(true);
            if (options.collapse === 'end') range.collapse(false);
            const selection = selectionFor(node.getRootNode?.() || node);
            selection.removeAllRanges();
            selection.addRange(range);
            return range;
        } catch {
            return false;
        }
    }

    function nearestTextPointFromPoint(nodes, point) {
        const probe = document.createRange();
        let nearest = null;
        [...(nodes || [])].forEach((node) => {
            const text = String(node?.nodeValue || '');
            if (!text) return;
            for (let offset = 0; offset <= text.length; offset += 1) {
                try {
                    const characterOffset = Math.min(
                        Math.max(0, text.length - 1),
                        offset
                    );
                    probe.setStart(node, characterOffset);
                    probe.setEnd(node, Math.min(
                        text.length,
                        characterOffset + 1
                    ));
                    const rects = [...probe.getClientRects()];
                    const rect = rects.find((candidate) =>
                        candidate.width || candidate.height
                    ) || probe.getBoundingClientRect();
                    if (!rect.width && !rect.height) continue;
                    const boundaryX = offset < text.length
                        ? rect.left
                        : rect.right;
                    const boundaryY = Math.max(
                        rect.top,
                        Math.min(rect.bottom, Number(point.clientY) || 0)
                    );
                    const distance = Math.hypot(
                        boundaryX - (Number(point.clientX) || 0),
                        boundaryY - (Number(point.clientY) || 0)
                    );
                    if (!nearest || distance < nearest.distance) {
                        nearest = {
                            node,
                            offset,
                            distance,
                        };
                    }
                } catch {
                    break;
                }
            }
        });
        return nearest
            ? Object.freeze({
                node: nearest.node,
                offset: nearest.offset,
                distance: nearest.distance,
            })
            : null;
    }

    function nearestTextOffsetFromPoint(node, point) {
        return nearestTextPointFromPoint([node], point)?.offset || 0;
    }

    function caretFromPoint(root, point, options = {}) {
        if (!root || !point) return null;
        const caretPosition = root.caretPositionFromPoint?.(
            point.clientX,
            point.clientY
        ) || document.caretPositionFromPoint?.(
            point.clientX,
            point.clientY
        );
        const caretRange = root.caretRangeFromPoint?.(
            point.clientX,
            point.clientY
        ) || document.caretRangeFromPoint?.(
            point.clientX,
            point.clientY
        );
        let node = caretPosition?.offsetNode || caretRange?.startContainer || null;
        let offset = caretPosition?.offset ?? caretRange?.startOffset ?? 0;
        const scope = options.scope || root;
        const forbiddenSelector = options.forbiddenSelector
            || 'script,style,noscript,canvas,svg,video,audio,input,textarea,select';

        if (node?.nodeType === Node.TEXT_NODE
            && scope.contains(node)
            && !node.parentElement?.closest(forbiddenSelector)) {
            return Object.freeze({
                node,
                parent: node.parentElement,
                offset: Math.max(
                    0,
                    Math.min(String(node.nodeValue || '').length, Number(offset) || 0)
                ),
            });
        }

        const eventTarget = point.composedPath?.().find((candidate) =>
            candidate?.nodeType === Node.ELEMENT_NODE
            && scope.contains(candidate)
        ) || point.target;
        let candidate = elementOf(node);
        if (!candidate || !scope.contains(candidate)) {
            candidate = scope.contains(eventTarget) ? eventTarget : scope;
        }
        while (candidate && scope.contains(candidate)) {
            if (!candidate.matches?.(forbiddenSelector)) {
                const candidateNodes = textNodes(candidate, {
                    excludeSelector: forbiddenSelector,
                    acceptNode: options.acceptNode,
                }).filter((textNode) =>
                    String(textNode.nodeValue || '').length > 0
                );
                const nearest = nearestTextPointFromPoint(
                    candidateNodes,
                    point
                );
                if (nearest) {
                    return Object.freeze({
                        node: nearest.node,
                        parent: nearest.node.parentElement,
                        offset: nearest.offset,
                    });
                }
            }
            if (candidate === scope) break;
            candidate = candidate.parentElement;
        }
        return null;
    }

    function placeCaretFromPoint(root, point, options = {}) {
        const target = caretFromPoint(root, point, options);
        if (!target) return false;
        try {
            const range = document.createRange();
            range.setStart(target.node, target.offset);
            range.collapse(true);
            const selection = selectionFor(root);
            selection.removeAllRanges();
            selection.addRange(range);
            return range;
        } catch {
            return false;
        }
    }

    function intersectsNode(range, node) {
        if (!range || !node) return false;
        try {
            return range.intersectsNode(node);
        } catch {
            return false;
        }
    }

    function rangeWithinNode(sourceRange, node) {
        if (!sourceRange || !node || !intersectsNode(sourceRange, node)) return null;
        try {
            const nodeRange = document.createRange();
            nodeRange.selectNodeContents(node);
            const range = document.createRange();
            if (sourceRange.compareBoundaryPoints(Range.START_TO_START, nodeRange) > 0) {
                range.setStart(sourceRange.startContainer, sourceRange.startOffset);
            } else {
                range.setStart(nodeRange.startContainer, nodeRange.startOffset);
            }
            if (sourceRange.compareBoundaryPoints(Range.END_TO_END, nodeRange) < 0) {
                range.setEnd(sourceRange.endContainer, sourceRange.endOffset);
            } else {
                range.setEnd(nodeRange.endContainer, nodeRange.endOffset);
            }
            return range.collapsed ? null : range;
        } catch {
            return null;
        }
    }

    window.ScriptoriumDomSelection = Object.freeze({
        selectionFor,
        elementOf,
        containsRange,
        cloneLiveRange,
        textNodes,
        textOffsetWithin,
        textPointAt,
        rangeOffsetsWithin,
        currentOffsets,
        restoreOffsets,
        selectNodeContents,
        caretFromPoint,
        placeCaretFromPoint,
        nearestTextPointFromPoint,
        nearestTextOffsetFromPoint,
        intersectsNode,
        rangeWithinNode,
    });
})();