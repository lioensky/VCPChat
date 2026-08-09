'use strict';

(() => {
    const FLOW_CONTAINER_TAGS = new Set(['ARTICLE', 'MAIN', 'SECTION']);
    const TEXT_TAGS = new Set(['P', 'BLOCKQUOTE', 'FIGCAPTION']);
    const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const SAFE_INLINE_TAGS = new Set([
        'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL',
        'DFN', 'EM', 'I', 'INS', 'KBD', 'MARK', 'Q', 'RP', 'RT', 'RUBY',
        'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U',
        'VAR', 'WBR',
    ]);
    const COMPLEX_SELECTOR = [
        'img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed',
        'table', 'figure', 'math', '[data-vdoc-math]', '[contenteditable="false"]',
    ].join(',');

    function numericCssLength(value, fallback = 0) {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function sceneMetrics(scene, measurementHost) {
        const probe = document.createElement('div');
        probe.style.cssText = [
            'position:absolute',
            'visibility:hidden',
            'pointer-events:none',
            `width:${scene.page.width}`,
            `height:${scene.page.height}`,
        ].join(';');
        measurementHost.appendChild(probe);
        const metrics = {
            width: probe.getBoundingClientRect().width,
            height: probe.getBoundingClientRect().height,
        };
        probe.remove();
        return metrics;
    }

    function isSafeInlineTree(node) {
        if (node.nodeType === Node.TEXT_NODE) return true;
        if (node.nodeType !== Node.ELEMENT_NODE) return false;
        if (!SAFE_INLINE_TAGS.has(node.tagName)) return false;
        if (node.matches(COMPLEX_SELECTOR)) return false;
        if (node.dataset.vdocPagination === 'atomic'
            || node.dataset.vdocPagination === 'atomic-inline') return false;
        return [...node.childNodes].every(isSafeInlineTree);
    }

    function isSplittableText(node) {
        if (!node?.matches?.(TEXT_TAGS.size ? [...TEXT_TAGS].join(',').toLowerCase() : 'p')) {
            return false;
        }
        if (node.dataset.vdocPagination === 'atomic') return false;
        return [...node.childNodes].every(isSafeInlineTree);
    }

    function isFlowContainer(node) {
        if (!node?.tagName) return false;
        if (node.dataset.vdocPagination === 'atomic') return false;
        if (node.dataset.vdocLayout === 'flow') return true;
        return FLOW_CONTAINER_TAGS.has(node.tagName);
    }

    function classify(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.nodeValue.trim() ? 'text' : 'ignore';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return 'ignore';
        if (node.dataset.vdocPageBreakBefore === 'true'
            || node.dataset.vdocPageBreakAfter === 'true') return 'breakable';
        if (node.dataset.vdocPagination === 'atomic') return 'atomic';
        if (node.matches('table')) return 'table';
        if (node.matches('ul,ol')) return 'list';
        if (HEADING_TAGS.has(node.tagName)) return 'heading';
        if (isSplittableText(node)) return 'splittable-text';
        if (isFlowContainer(node)) return 'flow-container';
        return 'atomic';
    }

    function createPage(index, options) {
        const page = document.createElement('section');
        page.className = 'vdoc-page';
        page.dataset.pageIndex = String(index);
        page.dataset.runtimeState = 'active';
        page.style.setProperty('--vdoc-zoom', String((options.zoom || 100) / 100));
        const content = document.createElement('div');
        content.className = 'vdoc-page-content';
        page.appendChild(content);
        return page;
    }

    function pageContent(page) {
        return page.querySelector(':scope > .vdoc-page-content');
    }

    function pageOverflows(page) {
        const content = pageContent(page);
        return content.scrollHeight > content.clientHeight + 1;
    }

    function cloneShell(element) {
        const shell = element.cloneNode(false);
        shell.removeAttribute('contenteditable');
        shell.removeAttribute('spellcheck');
        return shell;
    }

    function sanitizeDerivedTree(root) {
        root.querySelectorAll?.('[contenteditable], [spellcheck], [data-vdoc-editor-selected]').forEach((node) => {
            node.removeAttribute('contenteditable');
            node.removeAttribute('spellcheck');
            node.removeAttribute('data-vdoc-editor-selected');
        });
        return root;
    }

    function textOffsets(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const offsets = [];
        let total = 0;
        let node;
        while ((node = walker.nextNode())) {
            const segmenter = globalThis.Intl?.Segmenter
                ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
                : null;
            const boundaries = segmenter
                ? [...segmenter.segment(node.nodeValue)].map((part) => part.index + part.segment.length)
                : Array.from(node.nodeValue).map((_, index) => index + 1);
            boundaries.forEach((offset) => offsets.push({
                node,
                offset,
                total: total + offset,
            }));
            total += node.nodeValue.length;
        }
        return offsets;
    }

    function cloneTextFragment(source, endBoundary, fromBoundary = null) {
        const range = document.createRange();
        if (fromBoundary) range.setStart(fromBoundary.node, fromBoundary.offset);
        else range.setStart(source, 0);
        if (endBoundary) range.setEnd(endBoundary.node, endBoundary.offset);
        else range.setEnd(source, source.childNodes.length);
        const shell = cloneShell(source);
        shell.appendChild(range.cloneContents());
        return sanitizeDerivedTree(shell);
    }

    function splitTextToFit(source, page, appendTarget) {
        const boundaries = textOffsets(source);
        if (!boundaries.length) return null;

        let low = 0;
        let high = boundaries.length - 1;
        let best = -1;
        let probe = null;

        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            probe?.remove();
            probe = cloneTextFragment(source, boundaries[middle]);
            appendTarget.appendChild(probe);
            if (pageOverflows(page)) {
                high = middle - 1;
            } else {
                best = middle;
                low = middle + 1;
            }
        }
        probe?.remove();
        if (best < 0) return null;

        const head = cloneTextFragment(source, boundaries[best]);
        head.dataset.vdocFragment = 'head';
        head.dataset.vdocSourceBlock = source.dataset.vdocText || '';
        const tailRange = document.createRange();
        tailRange.setStart(boundaries[best].node, boundaries[best].offset);
        tailRange.setEnd(source, source.childNodes.length);
        const tail = cloneShell(source);
        tail.appendChild(tailRange.cloneContents());
        tail.dataset.vdocFragment = 'tail';
        tail.dataset.vdocSourceBlock = source.dataset.vdocText || '';
        return { head, tail: sanitizeDerivedTree(tail) };
    }

    function createPaginator(runtime, options) {
        let pageIndex = 0;
        let page = createPage(pageIndex, options);
        runtime.appendChild(page);

        const newPage = () => {
            page = createPage(pageIndex += 1, options);
            runtime.appendChild(page);
            return page;
        };

        const appendAtomic = (node) => {
            const target = pageContent(page);
            const clone = sanitizeDerivedTree(node.cloneNode(true));
            target.appendChild(clone);
            if (pageOverflows(page) && target.children.length > 1) {
                clone.remove();
                newPage();
                pageContent(page).appendChild(clone);
            }
            if (pageOverflows(page)) {
                page.dataset.vdocOverflow = 'true';
                clone.dataset.vdocOverflow = 'true';
            }
        };

        const appendSplittable = (node) => {
            let remainder = node;
            let safety = 200;
            while (remainder && safety > 0) {
                safety -= 1;
                const target = pageContent(page);
                const clone = sanitizeDerivedTree(remainder.cloneNode(true));
                target.appendChild(clone);
                if (!pageOverflows(page)) return;
                clone.remove();

                const split = splitTextToFit(remainder, page, target);
                if (split) {
                    target.appendChild(split.head);
                    remainder = split.tail;
                    newPage();
                    continue;
                }

                if (target.children.length) {
                    newPage();
                    continue;
                }
                appendAtomic(remainder);
                return;
            }
        };

        const appendHeading = (node, nextNode = null) => {
            const target = pageContent(page);
            const heading = sanitizeDerivedTree(node.cloneNode(true));
            target.appendChild(heading);
            if (nextNode) {
                const preview = sanitizeDerivedTree(nextNode.cloneNode(true));
                preview.dataset.vdocKeepProbe = 'true';
                target.appendChild(preview);
                const overflow = pageOverflows(page);
                preview.remove();
                if (overflow && target.children.length > 1) {
                    heading.remove();
                    newPage();
                    pageContent(page).appendChild(heading);
                }
            } else if (pageOverflows(page) && target.children.length > 1) {
                heading.remove();
                newPage();
                pageContent(page).appendChild(heading);
            }
        };

        const appendTable = (table) => {
            const rows = [...table.querySelectorAll(':scope > tbody > tr')];
            if (!rows.length) {
                appendAtomic(table);
                return;
            }
            const shell = cloneShell(table);
            const caption = table.querySelector(':scope > caption');
            const colgroup = table.querySelector(':scope > colgroup');
            const thead = table.querySelector(':scope > thead');
            if (caption) shell.appendChild(caption.cloneNode(true));
            if (colgroup) shell.appendChild(colgroup.cloneNode(true));
            if (thead) shell.appendChild(thead.cloneNode(true));
            let tbody = document.createElement('tbody');
            shell.appendChild(tbody);
            pageContent(page).appendChild(shell);

            rows.forEach((row) => {
                const clone = sanitizeDerivedTree(row.cloneNode(true));
                tbody.appendChild(clone);
                if (!pageOverflows(page)) return;
                clone.remove();
                if (!tbody.children.length && pageContent(page).children.length === 1) {
                    tbody.appendChild(clone);
                    page.dataset.vdocOverflow = 'true';
                    return;
                }
                newPage();
                const continued = cloneShell(table);
                if (colgroup) continued.appendChild(colgroup.cloneNode(true));
                if (thead) continued.appendChild(thead.cloneNode(true));
                tbody = document.createElement('tbody');
                continued.appendChild(tbody);
                tbody.appendChild(clone);
                pageContent(page).appendChild(continued);
            });
        };

        const appendList = (list) => {
            const items = [...list.children].filter((child) => child.matches('li'));
            if (!items.length) {
                appendAtomic(list);
                return;
            }
            let shell = cloneShell(list);
            pageContent(page).appendChild(shell);
            items.forEach((item) => {
                const clone = sanitizeDerivedTree(item.cloneNode(true));
                shell.appendChild(clone);
                if (!pageOverflows(page)) return;
                clone.remove();
                if (!shell.children.length && pageContent(page).children.length === 1) {
                    shell.appendChild(clone);
                    page.dataset.vdocOverflow = 'true';
                    return;
                }
                newPage();
                shell = cloneShell(list);
                if (list.tagName === 'OL') {
                    const ordinal = items.indexOf(item);
                    shell.start = numericCssLength(list.start, 1) + ordinal;
                }
                shell.appendChild(clone);
                pageContent(page).appendChild(shell);
            });
        };

        const appendNodes = (nodes) => {
            const relevant = nodes.filter((node) => classify(node) !== 'ignore');
            relevant.forEach((node, index) => {
                const kind = classify(node);
                const breakBefore = node.dataset?.vdocPageBreakBefore === 'true';
                const breakAfter = node.dataset?.vdocPageBreakAfter === 'true';
                if (breakBefore && pageContent(page).children.length) newPage();

                if (kind === 'flow-container') {
                    appendNodes([...node.childNodes]);
                } else if (kind === 'splittable-text') {
                    appendSplittable(node);
                } else if (kind === 'heading') {
                    appendHeading(node, relevant[index + 1] || null);
                } else if (kind === 'table') {
                    appendTable(node);
                } else if (kind === 'list') {
                    appendList(node);
                } else {
                    appendAtomic(node);
                }

                if (breakAfter && pageContent(page).children.length) newPage();
            });
        };

        return { appendNodes };
    }

    function paginate(html, runtime, options = {}) {
        const template = document.createElement('template');
        template.innerHTML = options.ensureIds ? options.ensureIds(html) : String(html || '');
        runtime.replaceChildren();
        runtime.className = 'vdoc-runtime vdoc-paged-runtime';

        if (options.scene?.kind === options.slideDeckKind) {
            const slides = [...template.content.querySelectorAll(':scope > [data-vdoc-slide]')];
            (slides.length ? slides : [...template.content.children]).forEach((slide, index) => {
                const page = createPage(index, options);
                pageContent(page).appendChild(sanitizeDerivedTree(slide.cloneNode(true)));
                runtime.appendChild(page);
            });
        } else {
            createPaginator(runtime, options).appendNodes([...template.content.childNodes]);
        }

        const pages = [...runtime.querySelectorAll(':scope > .vdoc-page')];
        const last = pages.at(-1);
        if (last && !pageContent(last).children.length && pages.length > 1) last.remove();
        [...runtime.querySelectorAll(':scope > .vdoc-page')].forEach((item, index) => {
            item.dataset.pageIndex = String(index);
        });
        return {
            pages: [...runtime.querySelectorAll(':scope > .vdoc-page')],
            warnings: [...runtime.querySelectorAll('[data-vdoc-overflow="true"]')].map((node) => ({
                type: 'oversized-atomic-block',
                blockId: node.dataset.vdocText || node.dataset.vdocBlock || '',
            })),
        };
    }

    function renderContinuous(html, runtime, options = {}) {
        runtime.className = 'vdoc-runtime vdoc-flow-runtime';
        runtime.innerHTML = options.ensureIds ? options.ensureIds(html) : String(html || '');
        return runtime;
    }

    function buildPagedHtml(options) {
        const title = String(options.title || 'Scriptorium 富文档').replace(/[&<>"]/g, (character) =>
            `&#${character.charCodeAt(0)};`
        );
        const pages = options.runtime.cloneNode(true);
        pages.querySelectorAll('[contenteditable], [spellcheck], [data-runtime-state]').forEach((node) => {
            node.removeAttribute('contenteditable');
            node.removeAttribute('spellcheck');
            node.removeAttribute('data-runtime-state');
        });
        return `<!doctype html>
<html lang="${options.language || 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${options.css || ''}</style>
</head>
<body>
${pages.outerHTML}
</body>
</html>`;
    }

    window.VDocPagination = Object.freeze({
        classify,
        isSafeInlineTree,
        isSplittableText,
        paginate,
        renderContinuous,
        buildPagedHtml,
        sceneMetrics,
    });
})();