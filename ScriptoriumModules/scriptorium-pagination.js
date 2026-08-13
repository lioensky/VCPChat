'use strict';

(() => {
    const FLOW_CONTAINER_TAGS = new Set([
        'ARTICLE', 'MAIN', 'SECTION', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
        // Marked 将 Markdown 引用编译为 blockquote > p。引用外壳是文本
        // 语义容器，不是不可拆分组件，必须递归分页其中的段落。
        'BLOCKQUOTE',
    ]);
    const NON_VISUAL_TAGS = new Set([
        'STYLE', 'SCRIPT', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT',
    ]);
    const TEXT_TAGS = new Set(['P', 'BLOCKQUOTE', 'FIGCAPTION', 'DIV']);
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

    function isTextualInline(node) {
        if (node?.nodeType === Node.TEXT_NODE) return true;
        if (node?.nodeType !== Node.ELEMENT_NODE) return false;
        if (!SAFE_INLINE_TAGS.has(node.tagName)) return false;
        if (node.dataset.vdocPagination === 'atomic'
            || node.dataset.vdocPagination === 'atomic-inline'
            || node.matches(COMPLEX_SELECTOR)
            || isInteractiveIsland(node)) {
            return false;
        }

        // class、style、CSS 变量、背景、字体、颜色、padding 与纯 CSS 动画
        // 都只是文字表现，不改变 span/strong/em/code 等节点的文本流身份。
        // 只有显式原子声明或真实媒体/脚本交互内容才阻止字素级分页。
        return !node.querySelector?.(
            'script,canvas,video,audio,iframe,object,embed,'
            + '[data-vdoc-island],'
            + '[data-vdoc-interactive],'
            + '[data-vdoc-component],'
            + '[data-vdoc-pagination="atomic"],'
            + '[data-vdoc-pagination="atomic-inline"]'
        );
    }

    function isSafeInlineTree(node) {
        if (!isTextualInline(node)) return false;
        return node.nodeType === Node.TEXT_NODE
            || [...node.childNodes].every(isSafeInlineTree);
    }

    function isSplittableText(node) {
        if (!node?.matches?.(
            TEXT_TAGS.size ? [...TEXT_TAGS].join(',').toLowerCase() : 'p'
        )) {
            return false;
        }
        if (node.dataset.vdocPagination === 'atomic'
            || isInteractiveIsland(node)) {
            return false;
        }
        // 带 class/style/CSS 背景与动画的文本 div 仍属于文字流。
        // 只要后代全是安全行内节点，就保留外壳并按字素分页。
        return [...node.childNodes].every(isSafeInlineTree);
    }

    function isInteractiveIsland(node) {
        if (!node?.matches) return false;
        if (node.matches('[data-vdoc-island],'
            + '[data-vdoc-interactive],'
            + '[data-vdoc-component],'
            + '[data-vdoc-pagination="atomic"]')) {
            return true;
        }
        return node.matches('canvas,video,audio,iframe,object,embed')
            || Boolean(node.querySelector?.(
                ':scope > script,'
                + ':scope > canvas,'
                + ':scope > video,'
                + ':scope > audio,'
                + ':scope > [data-vdoc-interactive]'
            ));
    }

    function isSemanticTextContainer(node) {
        if (!node?.tagName || isInteractiveIsland(node)) return false;
        if (node.dataset.vdocLayout === 'flow') return true;
        if (FLOW_CONTAINER_TAGS.has(node.tagName)) return true;
        if (node.tagName !== 'DIV') return false;
        if (!node.children.length) return Boolean(node.textContent?.trim());
        return [...node.children].every((child) =>
            NON_VISUAL_TAGS.has(child.tagName)
            || HEADING_TAGS.has(child.tagName)
            || TEXT_TAGS.has(child.tagName)
            || child.matches?.(
                'div,ul,ol,table,figure,pre,hr,'
                + '[data-vdoc-math],[data-vdoc-mermaid]'
            )
        );
    }

    function isFlowContainer(node) {
        return isSemanticTextContainer(node);
    }

    function classify(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.nodeValue.trim() ? 'text' : 'ignore';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return 'ignore';
        if (NON_VISUAL_TAGS.has(node.tagName)) return 'resource';
        if (node.dataset.vdocPageBreakBefore === 'true'
            || node.dataset.vdocPageBreakAfter === 'true') return 'breakable';
        if (isInteractiveIsland(node)) return 'atomic';
        if (node.matches('table')) return 'table';
        if (node.matches('ul,ol')) return 'list';
        if (HEADING_TAGS.has(node.tagName)) return 'heading';
        if (isSplittableText(node)) return 'splittable-text';
        if (isFlowContainer(node)) return 'flow-container';
        return 'atomic';
    }

    function createPage(index, options, flowBody = false) {
        const page = document.createElement('section');
        page.className = 'vdoc-page';
        page.dataset.pageIndex = String(index);
        page.dataset.runtimeState = 'active';
        page.style.setProperty('--vdoc-zoom', String((options.zoom || 100) / 100));
        const content = document.createElement('div');
        content.className = 'vdoc-page-content';
        if (flowBody) {
            const body = document.createElement('div');
            body.className = 'vdoc-page-body';
            content.appendChild(body);
        }
        page.appendChild(content);
        return page;
    }

    function pageFrame(page) {
        return page.querySelector(':scope > .vdoc-page-content');
    }

    function pageContent(page) {
        const frame = pageFrame(page);
        return frame?.querySelector(':scope > .vdoc-page-body') || frame;
    }

    function pageOverflows(page) {
        const body = pageContent(page);
        if (!body) return false;
        // 分页只解决垂直容量。流式正文盒的 clientHeight 已经扣除页眉、
        // 页脚和装订留白，因此 scrollHeight 是唯一分页依据。
        // 横向装饰扩展不能靠换页解决；尤其 box-decoration-break:clone
        // 可能增大 scrollWidth，却仍属于同一段连续内联文本。
        return body.scrollHeight > body.clientHeight + 1;
    }

    function nodeHasVisibleContent(node, excludedRoot = null) {
        if (!node || node === excludedRoot
            || excludedRoot?.contains?.(node)) {
            return false;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            return Boolean(node.nodeValue.trim());
        }
        if (node.nodeType !== Node.ELEMENT_NODE
            || NON_VISUAL_TAGS.has(node.tagName)) {
            return false;
        }
        if (node.matches?.(
            'img,svg,canvas,video,audio,iframe,object,embed,'
            + 'table,figure,hr,'
            + '[data-vdoc-island],[data-vdoc-math],[data-vdoc-mermaid]'
        )) {
            return true;
        }
        return [...node.childNodes].some((child) =>
            nodeHasVisibleContent(child, excludedRoot)
        );
    }

    function pageHasVisibleContent(page, excludedRoot = null) {
        return [...pageContent(page).childNodes].some((node) =>
            nodeHasVisibleContent(node, excludedRoot)
        );
    }

    function pageContainsOnlyHeadings(page, excludedRoot = null) {
        const visibleElements = [];
        const visit = (node) => {
            if (!node || node === excludedRoot
                || excludedRoot?.contains?.(node)
                || NON_VISUAL_TAGS.has(node.tagName)) {
                return;
            }
            if (node.nodeType === Node.TEXT_NODE) {
                if (node.nodeValue.trim()) visibleElements.push(node);
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (HEADING_TAGS.has(node.tagName)) {
                visibleElements.push(node);
                return;
            }
            if (node.classList.contains('vdoc-pagination-shell')
                || FLOW_CONTAINER_TAGS.has(node.tagName)) {
                [...node.childNodes].forEach(visit);
                return;
            }
            if (nodeHasVisibleContent(node)) visibleElements.push(node);
        };
        [...pageContent(page).childNodes].forEach(visit);
        return visibleElements.length > 0
            && visibleElements.every((node) =>
                node.nodeType === Node.ELEMENT_NODE
                && HEADING_TAGS.has(node.tagName)
            );
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
        let page = createPage(pageIndex, options, true);
        const containerStack = [];
        runtime.appendChild(page);

        const appendTarget = () => {
            let target = pageContent(page);
            containerStack.forEach((source) => {
                let shell = [...target.children].at(-1);
                if (!shell || shell.dataset.vdocPaginationShell
                    !== source.dataset.vdocPaginationShell) {
                    shell = cloneShell(source);
                    shell.classList.add('vdoc-pagination-shell');
                    shell.dataset.vdocPaginationShell =
                        source.dataset.vdocPaginationShell;
                    target.appendChild(shell);
                }
                target = shell;
            });
            return target;
        };

        const newPage = () => {
            page = createPage(pageIndex += 1, options, true);
            runtime.appendChild(page);
            appendTarget();
            return page;
        };

        const appendAtomic = (node) => {
            const target = appendTarget();
            const clone = sanitizeDerivedTree(node.cloneNode(true));
            target.appendChild(clone);
            if (pageOverflows(page)
                && pageHasVisibleContent(page, clone)) {
                clone.remove();
                newPage();
                appendTarget().appendChild(clone);
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
                const target = appendTarget();
                const clone = sanitizeDerivedTree(remainder.cloneNode(true));
                target.appendChild(clone);
                if (!pageOverflows(page)) return;
                clone.remove();

                // 普通 Markdown 段落及其中带 CSS 的 span 是一个连续文本块。
                // 当前页剩余空间不足时通常整段移页；但若页面中只有刚刚
                // keep-with-next 移来的标题，就必须让正文留在标题后并允许
                // 拆分，否则标题与正文会连续两次移页，形成标题独占页。
                if (pageHasVisibleContent(page)
                    && !pageContainsOnlyHeadings(page)) {
                    newPage();
                    continue;
                }

                const split = splitTextToFit(remainder, page, target);
                if (split) {
                    target.appendChild(split.head);
                    remainder = split.tail;
                    newPage();
                    continue;
                }

                appendAtomic(remainder);
                return;
            }
        };

        const appendHeading = (node, nextNode = null) => {
            const target = appendTarget();
            const heading = sanitizeDerivedTree(node.cloneNode(true));
            target.appendChild(heading);
            let overflow = pageOverflows(page);
            if (nextNode && !overflow) {
                const preview = sanitizeDerivedTree(nextNode.cloneNode(true));
                preview.dataset.vdocKeepProbe = 'true';
                target.appendChild(preview);
                overflow = pageOverflows(page);
                preview.remove();
            }
            if (overflow && pageHasVisibleContent(page, heading)) {
                heading.remove();
                newPage();
                appendTarget().appendChild(heading);
            }
            if (pageOverflows(page)) {
                page.dataset.vdocOverflow = 'true';
                heading.dataset.vdocOverflow = 'true';
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
            appendTarget().appendChild(shell);

            rows.forEach((row) => {
                const clone = sanitizeDerivedTree(row.cloneNode(true));
                tbody.appendChild(clone);
                if (!pageOverflows(page)) return;
                clone.remove();
                if (!tbody.children.length && appendTarget().children.length === 1) {
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
                appendTarget().appendChild(continued);
            });
        };

        const appendList = (list) => {
            const items = [...list.children].filter((child) => child.matches('li'));
            if (!items.length) {
                appendAtomic(list);
                return;
            }
            let shell = cloneShell(list);
            appendTarget().appendChild(shell);

            const createContinuedList = (ordinal) => {
                newPage();
                shell = cloneShell(list);
                if (list.tagName === 'OL') {
                    shell.start = numericCssLength(list.start, 1) + ordinal;
                }
                appendTarget().appendChild(shell);
            };

            items.forEach((item, ordinal) => {
                let remainder = item;
                let safety = 200;
                while (remainder && safety > 0) {
                    safety -= 1;
                    const clone = sanitizeDerivedTree(remainder.cloneNode(true));
                    shell.appendChild(clone);
                    if (!pageOverflows(page)) return;
                    clone.remove();

                    const target = appendTarget();
                    const listIsOnlyCurrentShell = target.children.length === 1
                        && target.firstElementChild === shell;
                    const pageHasContentBeforeListItem = pageHasVisibleContent(
                        page,
                        listIsOnlyCurrentShell ? shell : null
                    );

                    // 列表项与普通段落遵循同一规则。只有标题位于列表前时，
                    // 第一项必须继续留在标题页；否则标题会被单独遗留一页。
                    if ((pageHasContentBeforeListItem
                        && !pageContainsOnlyHeadings(page, shell))
                        || shell.children.length) {
                        createContinuedList(ordinal);
                        continue;
                    }

                    if ([...remainder.childNodes].every(isSafeInlineTree)) {
                        const split = splitTextToFit(remainder, page, shell);
                        if (split) {
                            shell.appendChild(split.head);
                            remainder = split.tail;
                            createContinuedList(ordinal);
                            continue;
                        }
                    }

                    shell.appendChild(clone);
                    page.dataset.vdocOverflow = 'true';
                    clone.dataset.vdocOverflow = 'true';
                    return;
                }
            });
        };

        let shellSequence = 0;
        const appendNodes = (nodes) => {
            const relevant = nodes.filter((node) =>
                !['ignore', 'resource'].includes(classify(node))
            );
            relevant.forEach((node, index) => {
                const kind = classify(node);
                const breakBefore = node.dataset?.vdocPageBreakBefore === 'true';
                const breakAfter = node.dataset?.vdocPageBreakAfter === 'true';
                if (breakBefore && appendTarget().children.length) newPage();

                if (kind === 'flow-container') {
                    const source = node.cloneNode(false);
                    source.dataset.vdocPaginationShell =
                        `shell-${shellSequence += 1}`;
                    containerStack.push(source);
                    appendTarget();
                    appendNodes([...node.childNodes]);
                    containerStack.pop();
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

                if (breakAfter && appendTarget().children.length) newPage();
            });
        };

        return { appendNodes };
    }

    function paginate(html, runtime, options = {}) {
        const template = document.createElement('template');
        template.innerHTML = options.ensureIds ? options.ensureIds(html) : String(html || '');
        runtime.replaceChildren();
        runtime.className = 'vdoc-runtime vdoc-paged-runtime';

        template.content.querySelectorAll('style,link[rel="stylesheet"]').forEach(
            (resource) => {
                if (resource.closest(
                    '[data-vdoc-island],'
                    + '[data-vdoc-interactive],'
                    + '[data-vdoc-component],'
                    + '[data-vdoc-pagination="atomic"]'
                )) {
                    return;
                }
                runtime.appendChild(resource.cloneNode(true));
            }
        );

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
        if (last && !pageHasVisibleContent(last) && pages.length > 1) last.remove();
        [...runtime.querySelectorAll(':scope > .vdoc-page')].forEach((item, index) => {
            item.dataset.pageIndex = String(index);
        });
        return {
            pages: [...runtime.querySelectorAll(':scope > .vdoc-page')],
            warnings: [...runtime.querySelectorAll('[data-vdoc-overflow="true"]')]
                .filter((node) => !node.closest(
                    '[data-vdoc-overflow="true"] [data-vdoc-overflow="true"]'
                ))
                .map((node) => ({
                    type: node.matches('[data-vdoc-island]')
                        ? 'oversized-interactive-island'
                        : 'oversized-atomic-block',
                    islandId: node.dataset.vdocIsland || null,
                    blockId: node.dataset.vdocText
                        || node.dataset.vdocBlock
                        || node.dataset.vdocIsland
                        || '',
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
        pages.querySelectorAll(
            '[contenteditable],'
            + '[spellcheck],'
            + '[data-runtime-state],'
            + '[data-vdoc-pagination-shell]'
        ).forEach((node) => {
            node.removeAttribute('contenteditable');
            node.removeAttribute('spellcheck');
            node.removeAttribute('data-runtime-state');
            node.removeAttribute('data-vdoc-pagination-shell');
        });

        if (options.rehydrateRuntime === true) {
            const islandSelector = [
                '[data-vdoc-island]',
                '[data-vdoc-interactive]',
                '[data-vdoc-component]',
            ].join(',');
            pages.querySelectorAll(islandSelector).forEach((island) => {
                island.classList.remove('vdoc-runtime-paused');
                island.removeAttribute('data-runtime-state');
                island.removeAttribute('data-vdoc-initialized');
                island.removeAttribute('data-bound');
                island.removeAttribute('data-vdoc-was-playing');
                island.querySelectorAll(
                    '[data-vdoc-initialized],'
                    + '[data-bound],'
                    + '[data-vdoc-was-playing]'
                ).forEach((node) => {
                    node.removeAttribute('data-vdoc-initialized');
                    node.removeAttribute('data-bound');
                    node.removeAttribute('data-vdoc-was-playing');
                });
            });
        }

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
        isInteractiveIsland,
        isSemanticTextContainer,
        isTextualInline,
        isSafeInlineTree,
        isSplittableText,
        paginate,
        renderContinuous,
        buildPagedHtml,
        sceneMetrics,
    });
})();