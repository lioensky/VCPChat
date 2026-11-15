import { retainMessagePreview, releaseMessagePreview } from './messagePreviewText.js';

/** One viewport owner. Keeps shells, never keeps detached content subtrees. */
export function createOffscreenDomWindow({ canEvict, evict, restore, coldMargin = 3000, warmMargin = 1500, batchSize = 3 } = {}) {
    let root = null;
    let win = null;
    let frame = null;
    let disposed = false;
    let mutationObserver = null;
    let suspended = false;
    let restoreAllTask = null;
    const yields = new Map();
    let scrollRevision = 0;
    let layoutRevision = 0;
    const entries = new Map();
    const stats = { evicted: 0, restored: 0, protected: 0, failures: 0 };
    const properties = ['height', 'minHeight', 'maxHeight', 'boxSizing', 'overflow', 'contentVisibility'];
    const saveStyle = node => Object.fromEntries(properties.map(key => [key, node.style[key]]));
    const restoreStyle = (node, style) => { for (const key of properties) node.style[key] = style[key]; };
    function schedule() {
        if (disposed || !root || frame !== null) return;
        frame = win.requestAnimationFrame(() => { frame = null; void check(); });
    }
    function onScroll() { scrollRevision++; suspended = false; schedule(); }
    function anchor() {
        const bounds = root.getBoundingClientRect();
        for (const item of entries.keys()) {
            const rect = item.getBoundingClientRect();
            if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
                return { item, top: rect.top, revision: scrollRevision };
            }
        }
        return null;
    }
    function compensate(saved) {
        if (!saved || saved.revision !== scrollRevision || !saved.item.isConnected) return;
        // Chromium may already have applied automatic scroll anchoring. Compare
        // actual viewport positions, never add a second estimated height delta.
        const delta = saved.item.getBoundingClientRect().top - saved.top;
        if (Math.abs(delta) > 0.5) root.scrollTop += delta;
    }
    function wake(item, entry) {
        if (entry.restoring) return entry.wait;
        if (!entry.cold || !item.isConnected) return Promise.resolve();
        const version = entry.version;
        const savedAnchor = anchor();
        entry.restoring = true;
        entry.wait = (async () => {
            try {
                await restore(item, () => entries.get(item) === entry && entry.version === version && !disposed);
                if (entries.get(item) !== entry || entry.version !== version || disposed) return;
                restoreStyle(item, entry.shellStyle);
                restoreStyle(entry.content, entry.contentStyle);
                delete item.dataset.vcpDomEvicted;
                releaseMessagePreview(entry.content);
                entry.cold = false;
                stats.restored++;
                compensate(savedAnchor);
            } catch (error) {
                stats.failures++;
                console.warn('[OffscreenDomWindow] Restore failed; retained placeholder for retry:', error);
            } finally {
                entry.restoring = false;
                entry.wait = null;
            }
        })();
        return entry.wait;
    }
    async function check() {
        if (disposed || suspended || restoreAllTask || !root?.isConnected) return;
        const bounds = root.getBoundingClientRect();
        let changed = 0;
        let remaining = false;
        for (const [item, entry] of entries) {
            if (!item.isConnected) { unobserve(item); continue; }
            const rect = item.getBoundingClientRect();
            const near = rect.bottom >= bounds.top - warmMargin && rect.top <= bounds.bottom + warmMargin;
            if (entry.cold) {
                if (near && !entry.restoring) {
                    if (changed++ >= batchSize) { remaining = true; continue; }
                    void wake(item, entry);
                }
                continue;
            }
            const far = rect.bottom < bounds.top - coldMargin || rect.top > bounds.bottom + coldMargin;
            if (!far || entry.restoring) continue;
            if (changed >= batchSize) { remaining = true; continue; }
            if (!canEvict?.(item)) { stats.protected++; continue; }
            const content = item.querySelector('.md-content');
            if (!content) continue;
            // content-visibility:auto may otherwise return an intrinsic estimate.
            // Force only this bounded candidate to layout, then capture real sizes.
            const shellStyle = saveStyle(item);
            const contentStyle = saveStyle(content);
            item.style.contentVisibility = 'visible';
            const shellHeight = item.getBoundingClientRect().height;
            const contentHeight = content.getBoundingClientRect().height;
            if (!(shellHeight > 0) || !(contentHeight > 0)) {
                restoreStyle(item, shellStyle);
                continue;
            }
            entry.shellStyle = shellStyle;
            entry.contentStyle = contentStyle;
            entry.content = content;
            entry.layoutRevision = layoutRevision;
            const savedAnchor = anchor();
            try {
                retainMessagePreview(content);
                evict(item);
                for (const [node, height] of [[item, shellHeight], [content, contentHeight]]) {
                    node.style.height = node.style.minHeight = node.style.maxHeight = `${height}px`;
                    node.style.boxSizing = 'border-box';
                    node.style.overflow = 'hidden';
                }
                item.dataset.vcpDomEvicted = 'true';
                item.dataset.vcpMeasuredHeight = String(shellHeight);
                content.replaceChildren();
                entry.cold = true;
                stats.evicted++;
                changed++;
                compensate(savedAnchor);
            } catch (error) {
                releaseMessagePreview(content);
                restoreStyle(item, shellStyle);
                restoreStyle(content, contentStyle);
                stats.failures++;
                console.warn('[OffscreenDomWindow] Eviction failed:', error);
            }
        }
        if (remaining) schedule();
    }
    function unobserve(item) {
        const entry = entries.get(item);
        if (!entry) return;
        entry.version++;
        entries.delete(item);
        if (entry.cold) {
            restoreStyle(item, entry.shellStyle);
            restoreStyle(entry.content, entry.contentStyle);
        }
        releaseMessagePreview(entry.content);
        delete item.dataset.vcpDomEvicted;
    }
    function observe(item) {
        if (!root?.contains(item)) return;
        if (!entries.has(item)) entries.set(item, { cold: false, restoring: false, version: 0 });
        schedule();
    }
    function destroy() {
        disposed = true;
        if (frame !== null) win?.cancelAnimationFrame(frame);
        frame = null;
        for (const [id, resolve] of yields) { win.cancelAnimationFrame(id); resolve(); }
        yields.clear();
        mutationObserver?.disconnect();
        mutationObserver = null;
        root?.removeEventListener('scroll', onScroll);
        win?.removeEventListener('resize', onResize);
        for (const item of entries.keys()) unobserve(item);
        root = null;
    }
    function onResize() {
        layoutRevision++;
        // Cold heights are stale after width/font changes. Restore bounded chunks;
        // never erase their dimensions before the replacement is ready.
        void restoreAll().then(() => { suspended = false; schedule(); });
    }
    function restoreAll() {
        if (restoreAllTask) return restoreAllTask;
        suspended = true;
        restoreAllTask = (async () => {
            let count = 0;
            for (const [item, entry] of entries) {
                if (disposed) return;
                if (!entry.cold) continue;
                await wake(item, entry);
                if (++count % batchSize === 0) {
                    await new Promise(resolve => {
                        const id = win.requestAnimationFrame(() => { yields.delete(id); resolve(); });
                        yields.set(id, resolve);
                    });
                }
            }
        })().finally(() => { restoreAllTask = null; });
        return restoreAllTask;
    }
    return Object.freeze({
        initialize(container) {
            root = container;
            win = root.ownerDocument.defaultView;
            disposed = false;
            root.addEventListener('scroll', onScroll, { passive: true });
            win.addEventListener('resize', onResize);
            mutationObserver = new win.MutationObserver(records => {
                for (const { target } of records) {
                    if (entries.get(target)?.cold && target.matches('.streaming, .thinking, .editing')) unobserve(target);
                }
            });
            mutationObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
        },
        observe, unobserve, check, restoreAll, invalidateLayout: onResize, destroy,
        getStats: () => ({ ...stats, tracked: entries.size, cold: [...entries.values()].filter(entry => entry.cold).length }),
    });
}