/* Portrait files can be still images, animated images (GIF, animated WebP, APNG) or short videos
 * (MP4, WebM). Animated images play in an <img> by themselves; videos need a <video> element that
 * plays muted and looped. The side pane header and the settings preview both swap between the two
 * element kinds through these helpers. Keep the type list and size limits in step with the main
 * process (modules/ipc/agentHandlers.js). */
'use strict';

export const PORTRAIT_IMAGE_TYPES = Object.freeze(['image/png', 'image/apng', 'image/jpeg', 'image/webp', 'image/gif']);
export const PORTRAIT_VIDEO_TYPES = Object.freeze(['video/mp4', 'video/webm']);
export const PORTRAIT_ACCEPT = [...PORTRAIT_IMAGE_TYPES, ...PORTRAIT_VIDEO_TYPES].join(',');
export const PORTRAIT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const PORTRAIT_VIDEO_MAX_BYTES = 64 * 1024 * 1024;

const VIDEO_PATH = /\.(?:mp4|webm)$/i;

export function isPortraitType(type) {
    return PORTRAIT_IMAGE_TYPES.includes(type) || PORTRAIT_VIDEO_TYPES.includes(type);
}

export function portraitMaxBytes(type) {
    return PORTRAIT_VIDEO_TYPES.includes(type) ? PORTRAIT_VIDEO_MAX_BYTES : PORTRAIT_IMAGE_MAX_BYTES;
}

/** 按文件类型判断；没有类型时看地址的扩展名（file URL 后面带 ?v=） */
export function isPortraitVideo(url, type = '') {
    if (type) return PORTRAIT_VIDEO_TYPES.includes(type);
    if (typeof url !== 'string' || !url) return false;
    return VIDEO_PATH.test(url.split(/[?#]/)[0]);
}

export function isVideoElement(node) {
    return node?.tagName === 'VIDEO';
}

/**
 * 按 template 的样子造一个 img 或 video：类名、data-* 和 hidden 跟着走，src 不带。
 * template 本来就是要的那一种时直接浅复制。
 */
export function createPortraitMediaLike(template, video) {
    if (!template) return null;
    if (isVideoElement(template) === Boolean(video)) return template.cloneNode(false);
    const doc = template.ownerDocument;
    const next = doc.createElement(video ? 'video' : 'img');
    for (const { name, value } of [...template.attributes]) {
        if (name === 'class' || name === 'hidden' || name === 'aria-hidden' || name.startsWith('data-')) next.setAttribute(name, value);
    }
    next.setAttribute('draggable', 'false');
    if (video) {
        // 立绘视频只当会动的画面用：没有声音、不出控件、不能画中画或投屏
        next.muted = true;
        next.defaultMuted = true;
        next.loop = true;
        next.playsInline = true;
        next.preload = 'auto';
        next.setAttribute('muted', '');
        next.setAttribute('loop', '');
        next.setAttribute('playsinline', '');
        next.setAttribute('disablepictureinpicture', '');
        next.setAttribute('disableremoteplayback', '');
        next.setAttribute('tabindex', '-1');
    } else {
        next.setAttribute('alt', '');
    }
    return next;
}

/** 视频停下并放掉解码器；页面上的 img 去掉 src，已经拿下来的 img 不动 */
export function releasePortraitMedia(node) {
    if (!node) return;
    // Chromium 里给已经脱离页面的 img 去掉 src，这个 img 就再也不会被回收（实测每换一次留一个）；
    // 不碰它的话没有别的引用，连同解码好的位图一起被回收。
    if (!isVideoElement(node) && node.isConnected === false) return;
    const hadSource = node.hasAttribute?.('src');
    node.removeAttribute?.('src');
    if (isVideoElement(node) && hadSource) {
        try {
            node.pause();
            node.load();
        } catch { /* 测试环境里的假元素没有这些方法 */ }
    }
}

/** 等这个元素能画出第一帧：img 用 decode()，video 等 loadeddata；成功给 true，读不出来给 false */
export function whenPortraitMediaReady(node) {
    if (!isVideoElement(node)) {
        if (typeof node?.decode !== 'function') return Promise.resolve(true);
        return node.decode().then(() => true, () => false);
    }
    if (node.readyState >= 2) return Promise.resolve(true);
    return new Promise((resolve) => {
        const done = (ok) => {
            node.removeEventListener('loadeddata', onLoaded);
            node.removeEventListener('error', onError);
            resolve(ok);
        };
        const onLoaded = () => done(true);
        const onError = () => done(false);
        node.addEventListener('loadeddata', onLoaded);
        node.addEventListener('error', onError);
    });
}
