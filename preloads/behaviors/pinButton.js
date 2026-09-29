'use strict';

/**
 * 子窗口标题栏置顶按钮（仅 utility 角色，仅 Windows）。
 *
 * 自动在窗口控制按钮组里插入一个置顶按钮，并与主进程的置顶状态保持同步：
 *   - 点击时调用 togglePinWindow，按返回值刷新按钮
 *   - 挂载时调用 isWindowPinned 读取初始状态
 *   - 订阅 onWindowPinnedChanged，接收主进程广播的状态变化（快捷键、托盘等途径触发的置顶）
 *
 * 不挂载的页面：主聊天窗口（main.html）、桌面（desktop.html）、内嵌标签页与 iframe。
 * 主进程侧见 modules/services/windowPinService.js，架构说明见 docs/WINDOW_PIN_ARCHITECTURE.md。
 */

const CONTAINER_SELECTORS = [
    '.window-controls-win',
    '.window-controls:not(.window-controls-mac)',
    '.mini-window-controls',
    '.blade-window-controls',
    '.vcp-ui-window-controls',
];

const MINIMIZE_BUTTON_SELECTOR = '#win-minimize-btn, #minimize-btn, #minimize-notes-btn, #minimize-music-btn, #minimize-theme-btn, #minimize-translator-btn, #minimize-viewer-btn, #blade-minimize-btn, .btn-minimize, .vcp-ui-window-control-button, [aria-label*="最小化"]';
const EXISTING_PIN_SELECTOR = '.vcp-universal-pin-btn, .vcp-ui-window-control-pin';

function isExcludedWindowContext() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return true;

    // 主聊天视口
    if (
        document.body?.id === 'main-chat-window' ||
        document.getElementById('nextUiHomeTab') ||
        window.location.pathname.endsWith('main.html') ||
        window.location.href.includes('main.html')
    ) {
        return true;
    }

    // 桌面底座窗口
    if (
        document.body?.id === 'desktop-window' ||
        window.location.pathname.endsWith('desktop.html') ||
        window.location.href.includes('desktop.html') ||
        window.location.search.includes('desktop-only')
    ) {
        return true;
    }

    // iframe
    try {
        if (window.top !== window) return true;
    } catch {
        return true;
    }

    // 内嵌标签页
    return Boolean(
        document.documentElement?.dataset?.vcpEmbeddedApp === 'true' ||
        new URLSearchParams(window.location.search).has('vcpEmbedded') ||
        document.querySelector('.next-ui-internal-app-view')
    );
}

function createPinIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.pointerEvents = 'none';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4.5 1.5 L11.5 1.5 L10.5 4.5 L12.5 8.5 L9 8.5 L9 14.5 L7 14.5 L7 8.5 L3.5 8.5 L5.5 4.5 Z');
    svg.appendChild(path);
    return svg;
}

function ensurePinStyle() {
    if (document.getElementById('vcp-universal-pin-style')) return;
    const style = document.createElement('style');
    style.id = 'vcp-universal-pin-style';
    style.textContent = `
        .vcp-universal-pin-btn.is-pinned {
            color: var(--vcp-ui-primary, #6366f1) !important;
            background: var(--vcp-ui-primary-bg, rgba(99, 102, 241, 0.16)) !important;
        }
        .vcp-universal-pin-btn.is-pinned svg {
            transform: rotate(-15deg);
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

/**
 * @param {object} ctx       core/expose.js 的上下文
 * @param {object} roleApi   utility 角色的 API，需要 togglePinWindow / isWindowPinned / onWindowPinnedChanged
 */
function installPinButton(ctx, roleApi) {
    if (typeof document === 'undefined') return;
    // 当前实现只在 Windows 上实机调优过
    if (process.platform !== 'win32') return;

    const renderPinned = (isPinned) => {
        const pinned = Boolean(isPinned);
        document.querySelectorAll('.vcp-universal-pin-btn').forEach((btn) => {
            btn.classList.toggle('is-pinned', pinned);
            btn.setAttribute('aria-pressed', String(pinned));
            btn.title = pinned ? '取消置顶' : '置顶窗口';
        });
    };

    // 旧实现这里调用的是 ops.subscribe(channel, mapper)，只返回了订阅工厂而没有传入回调，
    // 监听从未注册，主进程广播的置顶变化收不到。现在直接使用角色 API 订阅。
    roleApi.onWindowPinnedChanged(renderPinned);

    const mountInto = (container) => {
        const sampleBtn = container.querySelector('button');
        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = `${sampleBtn ? sampleBtn.className : 'window-control-btn'} vcp-universal-pin-btn`.trim();
        pinBtn.title = '置顶窗口';
        pinBtn.setAttribute('aria-label', '置顶窗口');
        pinBtn.setAttribute('aria-pressed', 'false');
        pinBtn.appendChild(createPinIcon());

        pinBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
                renderPinned(await roleApi.togglePinWindow());
            } catch (error) {
                console.warn('[UniversalPin] Toggle failed:', error);
            }
        });

        // 优先插在托盘按钮或最小化按钮左侧
        const insertTarget = container.querySelector('#win-tray-btn') || container.querySelector(MINIMIZE_BUTTON_SELECTOR);
        if (insertTarget && insertTarget.parentNode === container) {
            container.insertBefore(pinBtn, insertTarget);
        } else {
            container.prepend(pinBtn);
        }
    };

    const tryMount = () => {
        if (isExcludedWindowContext()) return;
        const targets = Array.from(document.querySelectorAll(CONTAINER_SELECTORS.join(', ')))
            .filter((container) => !container.querySelector(EXISTING_PIN_SELECTOR)
                && !container.classList.contains('window-controls-mac'));
        if (!targets.length) return;

        targets.forEach(mountInto);
        ensurePinStyle();
        roleApi.isWindowPinned().then((isPinned) => {
            if (isPinned) renderPinned(true);
        }).catch(() => {});
    };

    let mountScheduled = false;
    const scheduleMount = () => {
        if (mountScheduled) return;
        mountScheduled = true;
        requestAnimationFrame(() => {
            mountScheduled = false;
            tryMount();
        });
    };

    // 页面会动态渲染标题栏，DOM 变化时重新尝试挂载
    const observeDom = () => {
        const target = document.documentElement || document.body;
        if (!target) return;
        const observer = new MutationObserver((mutations) => {
            const onlySelf = mutations.every((m) => m.target?.classList?.contains?.('vcp-universal-pin-btn'));
            if (!onlySelf) scheduleMount();
        });
        observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style'],
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            scheduleMount();
            observeDom();
        }, { once: true });
    } else {
        scheduleMount();
        observeDom();
    }

    // 兜底轮询：应对主进程卡顿或超长异步加载，挂载成功或 3 秒后停止
    let pollCount = 0;
    const pollInterval = setInterval(() => {
        pollCount += 1;
        scheduleMount();
        if (document.querySelector(EXISTING_PIN_SELECTOR) || pollCount >= 30) {
            clearInterval(pollInterval);
        }
    }, 100);

    window.addEventListener('load', scheduleMount, { once: true });
}

module.exports = { installPinButton };