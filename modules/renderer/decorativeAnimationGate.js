// modules/renderer/decorativeAnimationGate.js

/*
 * 装饰性流光的视口门控。
 *
 * 工具气泡自带四条关键帧（背景流动、边框流光、齿轮旋转、工具名流光），改的都是
 * background-position / color 这类合成器无法独立完成的属性，每帧都要主线程重算样式并重绘；
 * 消息生成中它们是 infinite 的，静态内容上也要各播一遍。
 * visibilityOptimizer 以消息项为单位、带 200px 预加载边距判定可见，落在边距内的消息项被视为
 * 可见，但其中的气泡本身可能完全在视口外，于是空闲时仍有一批气泡在逐帧跑动画。
 *
 * 这里以气泡元素本身为单位、零边距观察：不在滚动容器可视区内的气泡加 `vcp-anim-offscreen`，
 * CSS 屏障把它及其伪元素 / 后代的动画置为 paused；回到可视区即移除，外观与原来一致。
 * 页面隐藏（最小化 / 遮挡）时 Chromium 本就不渲染，这里不另做处理。
 */

const DEFAULT_SELECTOR = '.vcp-tool-use-bubble, .user-clicked-button-bubble';
const DEFAULT_CLASS_NAME = 'vcp-anim-offscreen';

export function createDecorativeAnimationGate(options = {}) {
    const selector = String(options.selector || DEFAULT_SELECTOR);
    const className = String(options.className || DEFAULT_CLASS_NAME);

    let container = null;
    let ownerWindow = null;
    let intersectionObserver = null;
    let mutationObserver = null;
    let pruneTimer = null;
    const tracked = new Set();

    function isElement(node) {
        return !!node && node.nodeType === 1 && typeof node.matches === 'function';
    }

    function track(element) {
        if (!intersectionObserver || tracked.has(element)) return;
        tracked.add(element);
        intersectionObserver.observe(element);
    }

    function untrack(element) {
        if (!tracked.delete(element)) return;
        intersectionObserver?.unobserve(element);
        element.classList.remove(className);
    }

    function collect(node) {
        if (!isElement(node)) return;
        if (node.matches(selector)) track(node);
        if (typeof node.querySelectorAll === 'function') {
            node.querySelectorAll(selector).forEach(track);
        }
    }

    // 流式渲染会整段替换消息内容，被换下的气泡要及时从观察者里摘掉，避免只增不减。
    function prune() {
        pruneTimer = null;
        for (const element of [...tracked]) {
            if (!element.isConnected) untrack(element);
        }
    }

    function schedulePrune() {
        if (pruneTimer !== null || !ownerWindow) return;
        pruneTimer = ownerWindow.setTimeout(prune, 0);
    }

    function handleIntersections(entries) {
        for (const entry of entries) {
            const element = entry.target;
            if (!tracked.has(element)) continue;
            element.classList.toggle(className, !entry.isIntersecting);
        }
    }

    // 工具气泡的 class 是渲染后在已入树的 <pre> 上补加的（prettify 阶段），只看 childList 永远等不到它；
    // 所以 class 变化也要看：开始匹配就纳入观察，不再匹配就释放。门控自己切换的暂停 class 不改变匹配结果，
    // 走到这里只是一次 Set 查找，不会形成回环。
    function handleClassChange(target) {
        if (!isElement(target)) return;
        const matches = target.matches(selector);
        if (matches && !tracked.has(target)) {
            track(target);
        } else if (!matches && tracked.has(target)) {
            untrack(target);
        }
    }

    function handleMutations(records) {
        let removed = false;
        for (const record of records) {
            if (record.type === 'attributes') {
                handleClassChange(record.target);
                continue;
            }
            record.addedNodes.forEach(collect);
            if (record.removedNodes.length > 0) removed = true;
        }
        if (removed) schedulePrune();
    }

    /** 观察一个滚动容器；重复调用会先解除上一次。 */
    function attach(scrollContainer) {
        detach();
        if (!isElement(scrollContainer)) return false;
        const view = scrollContainer.ownerDocument?.defaultView;
        if (!view || typeof view.IntersectionObserver !== 'function' || typeof view.MutationObserver !== 'function') {
            return false;
        }
        container = scrollContainer;
        ownerWindow = view;
        intersectionObserver = new view.IntersectionObserver(handleIntersections, {
            root: scrollContainer,
            rootMargin: '0px',
            threshold: 0,
        });
        mutationObserver = new view.MutationObserver(handleMutations);
        mutationObserver.observe(scrollContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        collect(scrollContainer);
        return true;
    }

    function detach() {
        if (pruneTimer !== null && ownerWindow) {
            ownerWindow.clearTimeout(pruneTimer);
            pruneTimer = null;
        }
        mutationObserver?.disconnect();
        mutationObserver = null;
        for (const element of [...tracked]) untrack(element);
        tracked.clear();
        intersectionObserver?.disconnect();
        intersectionObserver = null;
        container = null;
        ownerWindow = null;
    }

    /** 诊断用计数：被观察的气泡数与当前被判为视口外的数量。 */
    function snapshot() {
        let offscreen = 0;
        for (const element of tracked) {
            if (element.classList.contains(className)) offscreen += 1;
        }
        return { attached: !!container, tracked: tracked.size, offscreen, className };
    }

    return Object.freeze({ attach, detach, snapshot });
}
