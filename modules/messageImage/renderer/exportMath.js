// 消息图片画图用的几个纯计算（index.js 用，测试直接引）：字体分片挑选、克隆宽度取整、长消息分段高度。
// 不碰截图库和页面，所以能在 Node 里测。

// 页面只嵌入这些消息用得到的字体分片：MiSans 按字符区间切成上百个分片，全嵌进去每画一次多一两秒。
export function codePoints(items) {
    const points = new Set();
    for (const item of items) for (const char of item.textContent || '') points.add(char.codePointAt(0));
    return points;
}

export function rangeCovers(range, points) {
    const text = String(range || '').trim();
    if (!text) return true;
    return text.split(',').some((part) => {
        const match = /^\s*U\+([0-9a-f?]+)(?:-([0-9a-f]+))?\s*$/i.exec(part);
        if (!match) return true;
        const low = parseInt(match[1].replace(/\?/g, '0'), 16);
        const high = match[2] ? parseInt(match[2], 16) : parseInt(match[1].replace(/\?/g, 'f'), 16);
        for (const point of points) if (point >= low && point <= high) return true;
        return false;
    });
}

export function fontCssFor(cssText, points) {
    const faces = String(cssText || '').match(/@font-face\s*\{[^}]*\}/g) || [];
    return faces.filter((face) => rangeCovers(/unicode-range\s*:\s*([^;}]*)/i.exec(face)?.[1], points)).join('\n');
}

// 截图库把每个元素的计算宽度写成固定值，字符串只留六位有效数字（"37.3333px"），比屏幕上的 37.333336 窄一丝；
// 收缩适应的标签、按钮刚好装下自己的字，窄一丝就换行。克隆上的固定宽度向上取到排版的最小单位（1/64 设备像素）。
export const LAYOUT_UNIT = 64;
export const snap = (value, zoom = 1) => Math.ceil(value * zoom * LAYOUT_UNIT - 1e-6) / (LAYOUT_UNIT * zoom);
export const layoutZoom = () => Math.max(1, Number(window.devicePixelRatio) || 1);
export function snapBoxes(root, zoom = 1) {
    for (const node of [root, ...root.querySelectorAll('*')]) {
        const style = node.style;
        if (!style) continue;
        for (const name of ['width', 'inline-size']) {
            const value = style.getPropertyValue(name);
            if (/^[\d.]+px$/.test(value)) style.setProperty(name, `${snap(parseFloat(value), zoom)}px`, style.getPropertyPriority(name));
        }
    }
}

// 截图库的单块画布有边长上限（约 32767 像素），长消息按 SLICE 像素一段段画，主进程接起来。
export const SLICE = 16000;
export function sliceHeight(scale, limit = SLICE) {
    // 每段的 CSS 高度乘清晰度要是整数像素，接缝处才不会多一行或少一行。
    for (let css = Math.floor(limit / scale); css > 0; css -= 1) {
        if (Math.abs(css * scale - Math.round(css * scale)) < 1e-6) return css;
    }
    return Math.floor(limit / scale);
}
