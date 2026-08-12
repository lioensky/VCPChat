'use strict';

(() => {
    function locateTarget(source, target, hintLine = null) {
        const text = String(source || '');
        const needle = String(target || '');
        if (!needle) return null;
        const offsets = [];
        let cursor = text.indexOf(needle);
        while (cursor >= 0) {
            offsets.push(cursor);
            cursor = text.indexOf(needle, cursor + Math.max(1, needle.length));
        }
        if (!offsets.length) return null;
        if (offsets.length === 1 || !Number.isFinite(Number(hintLine))) {
            return offsets[0];
        }
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        const line = Math.max(1, Math.min(lines.length, Number(hintLine)));
        const hintedOffset = lines.slice(0, line - 1)
            .reduce((length, value) => length + value.length + 1, 0);
        return offsets.sort((left, right) =>
            Math.abs(left - hintedOffset) - Math.abs(right - hintedOffset)
        )[0];
    }

    function applyReplacements(source, replacements = []) {
        let output = String(source || '');
        const applied = [];
        for (const replacement of replacements) {
            const target = String(replacement?.target || '');
            const offset = locateTarget(
                output,
                target,
                replacement?.startLine
            );
            if (offset === null) {
                return Object.freeze({
                    success: false,
                    code: 'TARGET_NOT_FOUND',
                    message: '未找到 PR target。',
                    source: String(source || ''),
                });
            }
            const value = String(
                replacement?.replace
                ?? replacement?.replacement
                ?? ''
            );
            output = output.slice(0, offset)
                + value
                + output.slice(offset + target.length);
            applied.push({ target, replacement: value, offset });
        }
        return Object.freeze({
            success: true,
            source: output,
            applied,
        });
    }

    function createPrDiffController(context = {}) {
        const elements = context.elements || {};
        let adapter = null;

        function setAdapter(nextAdapter) {
            if (!nextAdapter
                || typeof nextAdapter.currentSource !== 'function') {
                throw new TypeError('PR diff requires a document adapter.');
            }
            adapter = nextAdapter;
            return adapter;
        }

        function currentAdapter() {
            const resolved = adapter || context.getAdapter?.();
            if (!resolved) throw new Error('No document adapter is active.');
            return resolved;
        }

        function appendLine(host, type, text) {
            const line = document.createElement('span');
            line.className = `pr-source-line pr-source-line-${type}`;
            line.textContent = text || ' ';
            host.appendChild(line);
        }

        function renderSource(host, replacements) {
            host.replaceChildren();
            replacements.forEach((replacement, index) => {
                appendLine(host, 'hunk', `@@ replacement ${index + 1} @@`);
                String(replacement.target || '').replace(/\r\n?/g, '\n')
                    .split('\n')
                    .forEach((line) => appendLine(host, 'removed', `− ${line}`));
                String(replacement.replace ?? replacement.replacement ?? '')
                    .replace(/\r\n?/g, '\n')
                    .split('\n')
                    .forEach((line) => appendLine(host, 'added', `+ ${line}`));
            });
        }

        function previewDocument(markup, css = '') {
            return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;min-height:100%;background:#fffdf8;color:#1d2421}
body{padding:20px;font-family:system-ui,sans-serif}
*,*::before,*::after{animation-play-state:paused!important;transition:none!important}
${String(css).replace(/<\/style/gi, '<\\/style')}
</style></head><body>${markup}</body></html>`;
        }

        function renderVisual(host, before, after, proposal) {
            const visualContext = currentAdapter().proposalPreview?.({
                before,
                after,
                proposal,
            }) || {
                before,
                after,
                css: currentAdapter().currentCss(),
            };
            const canvases = document.createElement('div');
            canvases.className = 'pr-island-canvases';
            [
                ['变更前', visualContext.before],
                ['变更后', visualContext.after],
            ].forEach(([label, markup]) => {
                const card = document.createElement('section');
                card.className = 'pr-island-card';
                const title = document.createElement('strong');
                title.textContent = label;
                const frame = document.createElement('iframe');
                frame.className = 'pr-island-frame';
                frame.sandbox = '';
                frame.title = `${label}隔离预览`;
                frame.srcdoc = previewDocument(
                    markup || '<p>无内容</p>',
                    visualContext.css
                );
                card.append(title, frame);
                canvases.appendChild(card);
            });
            host.replaceChildren(canvases);
        }

        function stateSource(state, proposal = {}) {
            if (!state || typeof state !== 'object') return '';
            const sourceKind = String(proposal.sourceKind || '');
            if (sourceKind === 'document-css') {
                return String(state.documentCss || '');
            }
            if (sourceKind === 'deck-css') return String(state.deckCss || '');
            if (Array.isArray(state.slides)) {
                const index = Number(proposal.slideIndex);
                const slide = state.slides[
                    Number.isInteger(index) ? index : 0
                ];
                return String(slide?.source || '');
            }
            return String(state.source || '');
        }

        function renderSemanticFallback(visualHost, sourceHost, checkpoint) {
            const status = String(checkpoint?.status || 'applied');
            const author = checkpoint?.author?.name
                || checkpoint?.author?.signature
                || '未知作者';
            const descriptions = {
                conflict:
                    '该提案因修订冲突未应用，文档内容没有发生变化。',
                rejected:
                    '该提案已被拒绝，文档内容没有发生变化。',
                failed:
                    '该提案应用失败，文档内容没有发生变化。',
                applied:
                    checkpoint?.operation?.type === 'project-create'
                        ? `文档由 ${author} 创建。`
                        : '该节点记录了一次结构或状态变更。',
            };
            visualHost.replaceChildren();
            const notice = document.createElement('div');
            notice.className = `pr-render-fallback ${status}`;
            notice.textContent = descriptions[status]
                || checkpoint?.summary
                || checkpoint?.name
                || '此节点没有可渲染的文本差异。';
            visualHost.appendChild(notice);
            sourceHost.replaceChildren();
            appendLine(
                sourceHost,
                'hunk',
                `@@ ${checkpoint?.name || '文脉节点'} @@`
            );
            appendLine(
                sourceHost,
                'context',
                checkpoint?.receipt?.message
                    || checkpoint?.summary
                    || '无源码变更'
            );
            return false;
        }

        function render(checkpoint, targetElements = {}) {
            const proposal = checkpoint?.proposal || {};
            const replacements = Array.isArray(proposal.replacements)
                ? proposal.replacements
                : [];
            const sourceHost = targetElements.sourceHost
                || elements['pr-source-diff'];
            const visualHost = targetElements.visualHost
                || elements['pr-render-diff'];
            if (!sourceHost || !visualHost) return false;

            const historicalBefore = stateSource(
                checkpoint?.changeSet?.before,
                proposal
            );
            const historicalAfter = stateSource(
                checkpoint?.changeSet?.after,
                proposal
            );
            if (historicalBefore || historicalAfter) {
                if (replacements.length) renderSource(sourceHost, replacements);
                else {
                    sourceHost.replaceChildren();
                    appendLine(sourceHost, 'hunk', '@@ 历史状态变更 @@');
                    String(historicalBefore).split(/\r?\n/)
                        .forEach((line) =>
                            appendLine(sourceHost, 'removed', `− ${line}`)
                        );
                    String(historicalAfter).split(/\r?\n/)
                        .forEach((line) =>
                            appendLine(sourceHost, 'added', `+ ${line}`)
                        );
                }
                renderVisual(
                    visualHost,
                    historicalBefore,
                    historicalAfter,
                    proposal
                );
                return true;
            }

            if (!replacements.length) {
                return renderSemanticFallback(
                    visualHost,
                    sourceHost,
                    checkpoint
                );
            }
            renderSource(sourceHost, replacements);
            const before = currentAdapter().proposalSource?.(proposal)
                || currentAdapter().currentSource();
            const result = applyReplacements(before, replacements);
            if (!result.success) {
                // conflict/rejected 的 target 可能已不在当前修订中，但原提案
                // 仍应可读；使用 target/replace 本身构造隔离对照。
                if (['conflict', 'rejected', 'failed'].includes(
                    checkpoint?.status
                )) {
                    renderVisual(
                        visualHost,
                        replacements.map((item) => item.target || '').join('\n'),
                        replacements.map((item) =>
                            item.replace ?? item.replacement ?? ''
                        ).join('\n'),
                        proposal
                    );
                    return true;
                }
                visualHost.textContent = result.message;
                return false;
            }
            renderVisual(visualHost, before, result.source, proposal);
            return true;
        }

        return Object.freeze({
            setAdapter,
            render,
        });
    }

    window.ScriptoriumPrDiff = Object.freeze({
        locateTarget,
        applyReplacements,
        createPrDiffController,
    });
})();