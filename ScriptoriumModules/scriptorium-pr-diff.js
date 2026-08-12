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

        function render(checkpoint) {
            const proposal = checkpoint?.proposal || {};
            const replacements = Array.isArray(proposal.replacements)
                ? proposal.replacements
                : [];
            const sourceHost = elements['pr-source-diff'];
            const visualHost = elements['pr-render-diff'];
            if (!replacements.length) {
                sourceHost.textContent = JSON.stringify(proposal, null, 2);
                visualHost.textContent = proposal.type || '结构变更';
                return false;
            }
            renderSource(sourceHost, replacements);
            const before = currentAdapter().proposalSource?.(proposal)
                || currentAdapter().currentSource();
            const result = applyReplacements(before, replacements);
            if (!result.success) {
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