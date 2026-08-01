/*
 * VCP Loom · Bing 手机版测试注入脚本
 * 在远程页面上下文中执行，不具备 Node.js 或 VChat IPC 权限。
 *
 * 不覆写站点的 viewport。Bing 会依据移动 User-Agent 和自身响应式规则
 * 选择布局，运行时强改 viewport 反而可能导致桌面与移动样式断点错位。
 */

document.documentElement.dataset.vcpLoomApp = 'example-mobile';

const viewport = document.querySelector('meta[name="viewport"]');
const clientHints = navigator.userAgentData
    ? {
        mobile: navigator.userAgentData.mobile,
        platform: navigator.userAgentData.platform,
        brands: navigator.userAgentData.brands,
    }
    : null;

console.info('[VCP Loom] Bing mobile diagnostics ' + JSON.stringify({
    userAgent: navigator.userAgent,
    clientHints,
    viewport: viewport?.content || '(missing)',
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    screenOrientation: window.screen.orientation?.type || '(missing)',
    devicePixelRatio: window.devicePixelRatio,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    touchEvent: 'ontouchstart' in window,
}));

function layoutSnapshot(stage) {
    const snapshotElement = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
            selector,
            tag: element.tagName,
            id: element.id,
            className: String(element.className || '').slice(0, 300),
            rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            },
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            minWidth: style.minWidth,
            width: style.width,
            zoom: style.zoom,
            transform: style.transform,
            display: style.display,
            position: style.position,
        };
    };

    console.info('[VCP Loom] Bing layout snapshot ' + JSON.stringify({
        stage,
        href: location.href,
        readyState: document.readyState,
        htmlClass: document.documentElement.className,
        bodyClass: document.body?.className || '',
        innerWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        elements: [
            snapshotElement('html'),
            snapshotElement('body'),
            snapshotElement('#b_header'),
            snapshotElement('#sb_form'),
            snapshotElement('#b_content'),
            snapshotElement('main'),
        ].filter(Boolean),
    }));
}

layoutSnapshot('inject');
setTimeout(() => layoutSnapshot('500ms'), 500);
setTimeout(() => layoutSnapshot('1000ms'), 1000);
setTimeout(() => layoutSnapshot('2000ms'), 2000);