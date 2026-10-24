/* Side pane new tab page portrait header: the agent's portrait, its light-theme version and its
 * expression variants. Every new image is decoded off screen first and only then put on the page,
 * so the header never shows a blank, half-painted or broken frame. A new portrait set replaces the
 * images in place; an emotion frame cross-fades to the variant on the second layer.
 * A portrait can also be a video (MP4, WebM): it plays muted and looped only while it can be seen,
 * stops when the window is hidden or the header is folded away, and stays on its first frame when
 * the system asks for reduced motion. */
'use strict';
import { resolvePortrait } from '../../emotion/portraitVariants.js';
import { applyPortraitDisplay } from './portrait-display.js';
import {
    createPortraitMediaLike,
    isPortraitVideo,
    isVideoElement,
    releasePortraitMedia,
    whenPortraitMediaReady
} from './portrait-media.js';

// 交叉淡入的时长和样式里一致；换层后多等一会儿再把旧层的图清掉
const LAYER_RELEASE_MS = 400;
const THEMES = ['default', 'light'];

export function createLauncherPortrait({ view, scheduler = globalThis }) {
    const portrait = view?.querySelector?.('.side-pane-launcher-portrait') || null;
    const layers = portrait ? [...portrait.querySelectorAll('.side-pane-launcher-portrait-layer')] : [];
    // 老结构里没有分层时，整个立绘容器就是唯一一层（不做淡入淡出）
    if (portrait && !layers.length) layers.push(portrait);
    const cleanups = [];
    let portraits = null;
    let display = null;
    let frame = null;
    let active = 0;
    // 正在显示的 { dark, light }；null 表示立绘区没放出来（显示圆头像）
    let shown = null;
    let request = 0;
    let releaseTimer = null;
    let disposed = false;
    // 解不出来的图按地址记下来，之后不再用（换了文件地址会带新的 ?v=，不受影响）
    const failed = new Set();
    const win = view?.ownerDocument?.defaultView || null;
    const doc = view?.ownerDocument || null;
    // 视频只在看得见时播：进了可视区、所在那层是当前层、窗口没最小化、头部没收起
    const inView = new WeakSet();
    const reducedMotion = win?.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
    let mediaObserver = null;

    const slotOf = (layer, theme) => layer.querySelector(`[data-portrait-theme="${theme}"]`);

    // 坏图去掉；默认那张坏了用浅色版顶上（这时两个主题都用它），都坏了就是没有立绘
    function usablePortraits() {
        if (!portraits) return null;
        const usable = Object.fromEntries(Object.entries(portraits)
            .filter(([, url]) => typeof url === 'string' && url && !failed.has(url)));
        if (!usable.default) {
            if (!usable.light) return null;
            usable.default = usable.light;
            delete usable.light;
        }
        return usable;
    }

    // 深色和浅色主题各要哪张图；浅色挑出来和深色是同一张时只用一张
    function targetFor(current) {
        const look = { state: frame?.state || null, emotion: frame?.emotion || 'neutral' };
        const dark = resolvePortrait(current, { ...look, theme: 'dark' })?.url || '';
        const light = resolvePortrait(current, { ...look, theme: 'light' })?.url || '';
        return { dark, light: light && light !== dark ? light : '' };
    }

    function clearLayer(layer) {
        for (const theme of THEMES) {
            const slot = slotOf(layer, theme);
            if (!slot) continue;
            slot.hidden = true;
            releasePortraitMedia(slot);
        }
        delete layer.dataset.portraitThemed;
        syncPlayback();
    }

    function videos() {
        return portrait ? [...portrait.querySelectorAll('video[data-portrait-theme]')] : [];
    }

    function canPlay(video) {
        if (disposed || reducedMotion?.matches || doc?.visibilityState === 'hidden') return false;
        if (!portrait || portrait.hidden || video.hidden || !video.getAttribute('src')) return false;
        if (view?.dataset?.launcherSegment === 'notifications') return false;
        const layer = video.closest('.side-pane-launcher-portrait-layer');
        if (layer && layer !== portrait && !layer.hasAttribute('data-portrait-active')) return false;
        return !mediaObserver || inView.has(video);
    }

    function syncPlayback() {
        for (const video of videos()) {
            if (canPlay(video)) {
                if (video.paused) Promise.resolve(video.play?.()).catch(() => {});
            } else if (!video.paused) {
                video.pause?.();
            }
        }
    }

    // 换了元素以后重新挂可视区观察（主题切换把另一张藏成 display:none 时也算看不见）
    function observeVideos() {
        if (!mediaObserver) return;
        mediaObserver.disconnect();
        videos().forEach(video => mediaObserver.observe(video));
    }

    // 换上已经解码好的图；没有图的那一格藏起来
    function paint(layer, images) {
        for (const theme of THEMES) {
            const slot = slotOf(layer, theme);
            const image = images[theme];
            if (image && slot && image !== slot) {
                slot.replaceWith(image);
                releasePortraitMedia(slot);
            } else if (!image && slot) {
                slot.hidden = true;
                releasePortraitMedia(slot);
            }
        }
        if (images.light) layer.dataset.portraitThemed = '';
        else delete layer.dataset.portraitThemed;
        observeVideos();
    }

    function activate(index) {
        layers.forEach((layer, i) => {
            if (layer === portrait) return;
            if (i === index) layer.dataset.portraitActive = '';
            else delete layer.dataset.portraitActive;
        });
        active = index;
    }

    function markShown(target) {
        shown = target;
        if (portrait) portrait.hidden = !target;
        if (!view) return;
        if (target) {
            view.dataset.launcherPortrait = target.light ? 'themed' : 'single';
            applyPortraitDisplay(view, display);
        } else {
            delete view.dataset.launcherPortrait;
            applyPortraitDisplay(view, null);
        }
        if (target && frame) view.dataset.launcherPortraitLook = frame.state || frame.emotion || 'neutral';
        else delete view.dataset.launcherPortraitLook;
    }

    function cancelRelease() {
        if (releaseTimer) scheduler.clearTimeout(releaseTimer);
        releaseTimer = null;
    }

    function hide() {
        request += 1;
        cancelRelease();
        layers.forEach(clearLayer);
        markShown(null);
    }

    // 照这一格做一个新的 img 或 video 在屏幕外解码；成功给出新元素，失败记下地址并给出 false
    function decodeInto(slot, src) {
        if (!slot || !src) return Promise.resolve(null);
        const video = isPortraitVideo(src);
        if (!slot.hidden && slot.getAttribute('src') === src && isVideoElement(slot) === video
            && (video ? slot.readyState >= 2 : slot.complete && slot.naturalWidth)) return Promise.resolve(slot);
        const next = createPortraitMediaLike(slot, video);
        next.hidden = false;
        if (!video) next.decoding = 'async';
        next.setAttribute('src', src);
        return whenPortraitMediaReady(next).then((ok) => {
            if (ok) return next;
            releasePortraitMedia(next);
            failed.add(src);
            return false;
        });
    }

    // fade 为 true 时在另一层解码并淡入（情绪切换），否则原地替换（换了立绘文件或换了助手）
    function apply({ fade }) {
        const token = ++request;
        const current = usablePortraits();
        if (!current || !portrait) { hide(); return; }
        const target = targetFor(current);
        if (shown && target.dark === shown.dark && target.light === shown.light) {
            markShown(shown);
            return;
        }
        const crossFade = fade && shown && layers.length > 1;
        const index = crossFade ? (active + 1) % layers.length : active;
        const layer = layers[index];
        Promise.all([decodeInto(slotOf(layer, 'default'), target.dark), decodeInto(slotOf(layer, 'light'), target.light)])
            .then(([dark, light]) => {
                // 不上页面的解码结果（请求已经过时，或另一张没解出来要重挑）放掉解码器，视频不再缓冲
                const release = () => [dark, light].forEach((node) => { if (node && !node.isConnected) releasePortraitMedia(node); });
                if (disposed || token !== request) { release(); return; }
                // 有图没解出来：它已经记进 failed，按剩下的图重新挑
                if (dark === false || light === false) { release(); apply({ fade }); return; }
                cancelRelease();
                paint(layer, { default: dark, light });
                const previous = active;
                activate(index);
                markShown(target);
                syncPlayback();
                if (previous === index) {
                    layers.forEach((other, i) => { if (i !== index && other !== portrait) clearLayer(other); });
                    return;
                }
                releaseTimer = scheduler.setTimeout(() => {
                    releaseTimer = null;
                    if (!disposed && active !== previous) clearLayer(layers[previous]);
                }, LAYER_RELEASE_MS);
            });
    }

    // 已经显示出来的图读失败（文件被删了之类）：记下来，退到别的图或圆头像。
    // img 会被解码好的新元素替换，所以在容器上捕获 error，而不是挂在每个 img 上
    if (portrait) {
        const onError = (event) => {
            const image = event.target;
            if (!image?.matches?.('[data-portrait-theme]') || image.hidden) return;
            const src = image.getAttribute('src');
            if (!src || !portraits || failed.has(src)) return;
            failed.add(src);
            apply({ fade: false });
        };
        portrait.addEventListener('error', onError, true);
        cleanups.push(() => portrait.removeEventListener('error', onError, true));

        if (typeof win?.IntersectionObserver === 'function') {
            mediaObserver = new win.IntersectionObserver((entries) => {
                entries.forEach(entry => (entry.isIntersecting ? inView.add(entry.target) : inView.delete(entry.target)));
                syncPlayback();
            });
            cleanups.push(() => mediaObserver.disconnect());
        }
        if (doc) {
            doc.addEventListener('visibilitychange', syncPlayback);
            cleanups.push(() => doc.removeEventListener('visibilitychange', syncPlayback));
        }
        if (reducedMotion?.addEventListener) {
            reducedMotion.addEventListener('change', syncPlayback);
            cleanups.push(() => reducedMotion.removeEventListener('change', syncPlayback));
        }
        // 切到通知页时头部淡出收起，视频跟着停
        if (view && typeof win?.MutationObserver === 'function') {
            const segmentObserver = new win.MutationObserver(syncPlayback);
            segmentObserver.observe(view, { attributes: true, attributeFilter: ['data-launcher-segment'] });
            cleanups.push(() => segmentObserver.disconnect());
        }
    }

    return Object.freeze({
        /** portraits 是 { default, light?, <情绪或状态>?, <键>-light? }，null 表示没有立绘；
         *  display 是助手配置里的焦点和高度，跟着换上的那张图一起生效 */
        render(next, nextDisplay = null) {
            portraits = typeof next?.default === 'string' && next.default ? next : null;
            display = portraits ? nextDisplay : null;
            apply({ fade: false });
        },
        /** frame 来自情绪源：{ state, emotion, intensity, source }；null 回到默认立绘 */
        setFrame(next) {
            frame = next && typeof next === 'object' ? next : null;
            if (portraits) apply({ fade: true });
        },
        get look() { return shown ? { ...shown } : null; },
        dispose() {
            disposed = true;
            request += 1;
            cancelRelease();
            cleanups.forEach(cleanup => cleanup());
            cleanups.length = 0;
            videos().forEach(video => video.pause?.());
        },
    });
}
