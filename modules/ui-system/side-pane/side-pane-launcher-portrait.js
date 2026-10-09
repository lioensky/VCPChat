/* Side pane new tab page portrait header: the agent's portrait and its light-theme version.
 * Every new image is decoded off screen first and only then put on the page, so the header never
 * shows a blank, half-painted or broken frame; a new portrait set replaces the images in place.
 * A portrait can also be a video (MP4, WebM): it plays muted and looped only while it can be seen,
 * stops when the window is hidden or the header is folded away, and stays on its first frame when
 * the system asks for reduced motion. */
'use strict';
import { applyPortraitDisplay } from './portrait-display.js';
import {
    createPortraitMediaLike,
    isPortraitVideo,
    isVideoElement,
    releasePortraitMedia,
    whenPortraitMediaReady
} from './portrait-media.js';

const THEMES = ['default', 'light'];

export function createLauncherPortrait({ view }) {
    const portrait = view?.querySelector?.('.side-pane-launcher-portrait') || null;
    const cleanups = [];
    let portraits = null;
    let display = null;
    // 正在显示的 { dark, light }；null 表示立绘区没放出来（显示圆头像）
    let shown = null;
    let request = 0;
    let disposed = false;
    // 解不出来的图按地址记下来，之后不再用（换了文件地址会带新的 ?v=，不受影响）
    const failed = new Set();
    const win = view?.ownerDocument?.defaultView || null;
    const doc = view?.ownerDocument || null;
    // 视频只在看得见时播：进了可视区、窗口没最小化、头部没收起
    const inView = new WeakSet();
    const reducedMotion = win?.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
    let mediaObserver = null;

    const slotOf = theme => portrait?.querySelector(`[data-portrait-theme="${theme}"]`) || null;

    // 深色和浅色主题各用哪张：坏图去掉；默认那张坏了用浅色版顶上（这时两个主题都用它），
    // 都坏了就是没有立绘；浅色版和默认是同一张时只用一张
    function target() {
        if (!portraits) return null;
        const usable = theme => (typeof portraits[theme] === 'string' && portraits[theme] && !failed.has(portraits[theme]) ? portraits[theme] : '');
        const dark = usable('default') || usable('light');
        if (!dark) return null;
        const light = usable('light');
        return { dark, light: light && light !== dark ? light : '' };
    }

    function videos() {
        return portrait ? [...portrait.querySelectorAll('video[data-portrait-theme]')] : [];
    }

    function canPlay(video) {
        if (disposed || reducedMotion?.matches || doc?.visibilityState === 'hidden') return false;
        if (!portrait || portrait.hidden || video.hidden || !video.getAttribute('src')) return false;
        if (view?.dataset?.launcherSegment === 'notifications') return false;
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
    function paint(images) {
        for (const theme of THEMES) {
            const slot = slotOf(theme);
            const image = images[theme];
            if (image && slot && image !== slot) {
                slot.replaceWith(image);
                releasePortraitMedia(slot);
            } else if (!image && slot) {
                slot.hidden = true;
                releasePortraitMedia(slot);
            }
        }
        if (images.light) portrait.dataset.portraitThemed = '';
        else delete portrait.dataset.portraitThemed;
        observeVideos();
    }

    function markShown(next) {
        shown = next;
        if (portrait) portrait.hidden = !next;
        if (!view) return;
        if (next) {
            view.dataset.launcherPortrait = next.light ? 'themed' : 'single';
            applyPortraitDisplay(view, display);
        } else {
            delete view.dataset.launcherPortrait;
            applyPortraitDisplay(view, null);
        }
    }

    function hide() {
        request += 1;
        if (portrait) paint({});
        markShown(null);
        syncPlayback();
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

    function apply() {
        const token = ++request;
        const next = target();
        if (!next || !portrait) { hide(); return; }
        if (shown && next.dark === shown.dark && next.light === shown.light) {
            markShown(shown);
            return;
        }
        Promise.all([decodeInto(slotOf('default'), next.dark), decodeInto(slotOf('light'), next.light)])
            .then(([dark, light]) => {
                if (disposed || token !== request) {
                    // 已经过时的解码结果不上页面，放掉解码器
                    [dark, light].forEach((node) => { if (node && !node.isConnected) releasePortraitMedia(node); });
                    return;
                }
                // 有图没解出来：它已经记进 failed，按剩下的图重新挑
                if (dark === false || light === false) { apply(); return; }
                paint({ default: dark, light });
                markShown(next);
                syncPlayback();
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
            apply();
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
        /** portraits 是 { default, light? }，null 表示没有立绘；
         *  display 是助手配置里的焦点和高度，跟着换上的那张图一起生效 */
        render(next, nextDisplay = null) {
            portraits = typeof next?.default === 'string' && next.default ? next : null;
            display = portraits ? nextDisplay : null;
            apply();
        },
        get look() { return shown ? { ...shown } : null; },
        dispose() {
            disposed = true;
            request += 1;
            cleanups.forEach(cleanup => cleanup());
            cleanups.length = 0;
            videos().forEach(video => video.pause?.());
        },
    });
}
