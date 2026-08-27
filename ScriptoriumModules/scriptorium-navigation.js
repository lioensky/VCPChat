'use strict';

(() => {
    function createNavigationController(context = {}) {
        const elements = context.elements || {};
        let adapter = null;
        let strategy = null;
        let abortController = null;
        let disposed = false;

        function assertActive() {
            if (disposed) throw new Error('Navigation controller has been disposed.');
        }

        function setAdapter(nextAdapter, nextStrategy = null) {
            assertActive();
            if (!nextAdapter || typeof nextAdapter.outline !== 'function') {
                throw new TypeError('Navigation requires a document adapter.');
            }
            adapter = nextAdapter;
            strategy = nextStrategy
                || context.strategies?.[nextAdapter.kind]
                || null;
            render();
            return adapter;
        }

        function clear() {
            assertActive();
            adapter = null;
            strategy = null;
            elements['outline-tree']?.replaceChildren();
            elements['paragraph-index']?.replaceChildren();
            elements['slide-navigator']?.replaceChildren();
            if (elements['outline-count']) {
                elements['outline-count'].textContent = '0 节';
            }
            if (elements['slide-count']) {
                elements['slide-count'].textContent = '0 页';
            }
            if (elements['slide-navigator-header']) {
                elements['slide-navigator-header'].hidden = true;
            }
            if (elements['slide-navigator']) {
                elements['slide-navigator'].hidden = true;
            }
            document.querySelector('.outline-tabs')
                ?.removeAttribute('hidden');
            if (elements['outline-headings-view']) {
                elements['outline-headings-view'].hidden = false;
            }
            if (elements['outline-paragraphs-view']) {
                elements['outline-paragraphs-view'].hidden = true;
            }
            if (elements['outline-empty']) {
                elements['outline-empty'].hidden = false;
            }
            return true;
        }

        function currentAdapter() {
            return adapter || context.getAdapter?.() || null;
        }

        function createItem(item) {
            if (strategy?.createItem) {
                return strategy.createItem(item, {
                    adapter: currentAdapter(),
                    navigate,
                });
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'outline-item';
            button.textContent = item.title || item.text || '未命名';
            button.addEventListener('click', () => navigate(item));
            return button;
        }

        function navigate(item) {
            const activeAdapter = currentAdapter();
            if (!activeAdapter) return false;
            if (strategy?.navigate) {
                return strategy.navigate(item, activeAdapter);
            }
            return false;
        }

        function render() {
            const activeAdapter = currentAdapter();
            if (!activeAdapter || !strategy) return false;
            const items = activeAdapter.outline();
            const ports = Object.freeze({
                adapter: activeAdapter,
                createItem,
                navigate,
            });
            if (strategy.render) {
                strategy.render(items, elements, ports);
            } else {
                elements['outline-tree']?.replaceChildren(
                    ...items.map(createItem)
                );
            }
            return true;
        }

        function executeStrategyCommand(command) {
            const activeAdapter = currentAdapter();
            const handler = strategy?.commands?.[command];
            if (!activeAdapter || typeof handler !== 'function') return false;
            const changed = handler(activeAdapter);
            if (!changed) return false;
            context.renderPort?.invalidate?.(`navigation-${command}`);
            context.renderPort?.renderEdit?.({ force: true });
            render();
            return true;
        }

        function bind() {
            assertActive();
            abortController?.abort();
            abortController = new AbortController();
            const options = { signal: abortController.signal };
            elements['add-slide-btn']?.addEventListener(
                'click',
                () => executeStrategyCommand('add'),
                options
            );
            elements['delete-slide-btn']?.addEventListener(
                'click',
                () => executeStrategyCommand('delete'),
                options
            );
            return api;
        }

        function dispose() {
            if (disposed) return;
            abortController?.abort();
            adapter = null;
            strategy = null;
            disposed = true;
        }

        const api = Object.freeze({
            setAdapter,
            clear,
            render,
            navigate,
            bind,
            dispose,
        });
        return api;
    }

    function createFlowNavigationStrategy(context = {}) {
        function render(items, elements, ports) {
            if (elements['slide-navigator-header']) {
                elements['slide-navigator-header'].hidden = true;
            }
            if (elements['slide-navigator']) {
                elements['slide-navigator'].hidden = true;
            }
            document.querySelector('.outline-tabs')
                ?.removeAttribute('hidden');
            if (elements['outline-headings-view']) {
                elements['outline-headings-view'].hidden = false;
            }
            if (elements['outline-paragraphs-view']) {
                elements['outline-paragraphs-view'].hidden = true;
            }
            const headings = items.filter((item) =>
                item.kind === 'heading'
            );
            const paragraphs = items.filter((item) =>
                item.kind === 'paragraph'
            );
            if (elements['outline-count']) {
                elements['outline-count'].textContent =
                    `${headings.length} 节`;
            }
            elements['outline-tree']?.replaceChildren(
                ...headings.map(ports.createItem)
            );
            elements['paragraph-index']?.replaceChildren(
                ...paragraphs.map(ports.createItem)
            );
            if (elements['outline-empty']) {
                elements['outline-empty'].hidden = items.length > 0;
            }
        }

        function createItem(item, ports) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = item.kind === 'heading'
                ? 'outline-item'
                : 'paragraph-item';
            button.style.setProperty(
                '--outline-level',
                String(item.level || 1)
            );
            const label = document.createElement('span');
            label.className = item.kind === 'heading'
                ? 'outline-item-title'
                : 'paragraph-preview';
            label.textContent = item.text || '（空段落）';
            button.appendChild(label);
            button.addEventListener('click', () =>
                ports.navigate(item)
            );
            return button;
        }

        function navigate(item) {
            const root = context.surfacePort?.editRoot?.();
            const shells = root
                ? [...root.querySelectorAll('[data-vdoc-edit-key]')]
                : [];
            const target = shells[item.ordinal];
            target?.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
            });
            return Boolean(target);
        }

        return Object.freeze({
            render,
            createItem,
            navigate,
        });
    }

    function createDeckNavigationStrategy(context = {}) {
        function render(items, elements, ports) {
            if (elements['slide-navigator-header']) {
                elements['slide-navigator-header'].hidden = false;
            }
            if (elements['slide-navigator']) {
                elements['slide-navigator'].hidden = false;
            }
            document.querySelector('.outline-tabs')
                ?.setAttribute('hidden', '');
            if (elements['outline-headings-view']) {
                elements['outline-headings-view'].hidden = true;
            }
            if (elements['outline-paragraphs-view']) {
                elements['outline-paragraphs-view'].hidden = true;
            }
            if (elements['outline-count']) {
                elements['outline-count'].textContent =
                    `${items.length} 页`;
            }
            if (elements['slide-count']) {
                elements['slide-count'].textContent =
                    `${items.length} 页`;
            }
            if (elements['delete-slide-btn']) {
                elements['delete-slide-btn'].disabled =
                    items.length <= 1;
            }
            const navigator = elements['slide-navigator'];
            if (navigator) {
                // 切页及文字编辑都会刷新缩略图列表。replaceChildren 会把
                // 滚动容器重置到开头，因此必须围绕 DOM 重建保留视口。
                const scrollLeft = navigator.scrollLeft;
                const scrollTop = navigator.scrollTop;
                navigator.replaceChildren(...items.map(ports.createItem));
                navigator.scrollLeft = scrollLeft;
                navigator.scrollTop = scrollTop;
            }
            if (elements['outline-empty']) {
                elements['outline-empty'].hidden = true;
            }
        }

        function createItem(item, ports) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'slide-nav-item';
            button.classList.toggle(
                'active',
                item.index === ports.adapter.activeSlideIndex()
            );
            button.dataset.slideId = item.id;

            const ordinal = document.createElement('span');
            ordinal.className = 'slide-nav-ordinal';
            ordinal.textContent = String(item.index + 1);
            const preview = document.createElement('span');
            preview.className = 'slide-nav-preview';
            const canvas = document.createElement('span');
            canvas.className = 'slide-nav-canvas';
            const slide = ports.adapter.slides()[item.index];
            const thumbnail = context.renderer?.createThumbnail?.(
                ports.adapter,
                slide,
                { observe: context.observeThumbnail }
            );
            if (thumbnail) canvas.appendChild(thumbnail);
            const title = document.createElement('span');
            title.className = 'slide-nav-title';
            title.textContent = item.title;
            preview.append(canvas, title);
            button.append(ordinal, preview);
            button.addEventListener('click', () =>
                ports.navigate(item)
            );
            return button;
        }

        function navigate(item, adapter) {
            if (!adapter.selectSlide(item.index)) return false;
            context.renderPort?.invalidate?.('active-slide-changed');
            context.renderPort?.renderEdit?.({ force: true });
            context.sourcePort?.refresh?.({ force: true });
            context.onNavigate?.(item);
            return true;
        }

        return Object.freeze({
            render,
            createItem,
            navigate,
            commands: Object.freeze({
                add: (adapter) => adapter.addSlide(),
                delete: (adapter) => adapter.deleteSlide(),
            }),
        });
    }

    window.ScriptoriumNavigation = Object.freeze({
        createNavigationController,
        createFlowNavigationStrategy,
        createDeckNavigationStrategy,
    });
})();