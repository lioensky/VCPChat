

/**
 * 子窗口标题栏置顶按钮行为模块（仅 utility 角色，Windows 专属）。
 *
 * 优化说明：
 * 1. 范围明确：仅面向使用 utility.js 的官方受管子窗口（骰子、音乐、备忘录等），非受管沙箱不介入。
 * 2. 交互保障：样式强制声明 -webkit-app-region: no-drag，避免被标题栏拖拽层截断点击。
 * 3. 深度休眠：按钮就绪后断开全局 DOM 监听，仅保留极浅层监听；正文内容更新 0 开销。
 */

const CONTAINER_SELECTORS = [
    '.blade-window-controls',
    '.window-controls-win',
    '.window-controls',
    '.mini-window-controls',
    '.titlebar-actions .window-controls',
    '.titlebar .window-controls',
    '#custom-title-bar .window-controls',
];
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

    // iframe 子框架
    try {
        if (window.top !== window) return true;
    } catch {
        return true;
    }

    // 内嵌标签页与嵌入式会话
    return Boolean(
        document.documentElement?.dataset?.vcpEmbeddedApp === 'true' ||
        new URLSearchParams(window.location.search).has('vcpEmbedded') ||
        document.querySelector('.next-ui-internal-app-view')
    );
}

function createPinIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    // Lucide pin
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.pointerEvents = 'none';
    for (const d of ['M12 17v5', 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z']) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }
    return svg;
}

function ensurePinStyle() {
    if (document.getElementById('vcp-universal-pin-style')) return;
    const style = document.createElement('style');
    style.id = 'vcp-universal-pin-style';
    style.textContent = `
        .vcp-universal-pin-btn {
            flex-shrink: 0;
            box-sizing: border-box;
            transition: color 0.15s ease, background-color 0.15s ease;
        }
        .vcp-universal-pin-btn svg {
            transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
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
 * @param {object} _ctx      core/expose.js 的上下文
 * @param {object} roleApi   utility 角色的 API，必须包含 togglePinWindow / isWindowPinned / onWindowPinnedChanged
 */
function installPinButton(_ctx, roleApi) {
    if (typeof document === 'undefined') return;
    // 当前能力专注于 Windows 平台
    if (process.platform !== 'win32') return;
    // 门禁：仅对拥有完整 utility 置顶 API 的受管子窗口生效
    if (!roleApi?.togglePinWindow || !roleApi?.onWindowPinnedChanged) return;

    let currentPinnedState = false;
    let initialFetched = false;
    let isToggling = false;

    const renderPinned = (isPinned) => {
        currentPinnedState = Boolean(isPinned);
        document.querySelectorAll('.vcp-universal-pin-btn').forEach((btn) => {
            btn.classList.toggle('is-pinned', currentPinnedState);
            btn.setAttribute('aria-pressed', String(currentPinnedState));
            btn.title = currentPinnedState ? '取消置顶' : '置顶窗口';
        });
    };

    // 纯单向事件流：统一由主进程广播驱动
    roleApi.onWindowPinnedChanged(renderPinned);

    const fetchInitialStateOnce = () => {
        if (initialFetched) return;
        initialFetched = true;
        roleApi.isWindowPinned().then((isPinned) => {
            renderPinned(isPinned);
        }).catch(() => {});
    };

    const mountInto = (container) => {
        const sampleBtn = container.querySelector('button');
        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = `${sampleBtn ? sampleBtn.className : 'window-control-btn'} vcp-universal-pin-btn`.trim();
        pinBtn.title = currentPinnedState ? '取消置顶' : '置顶窗口';
        pinBtn.setAttribute('aria-label', '置顶窗口');
        pinBtn.setAttribute('aria-pressed', String(currentPinnedState));
        if (currentPinnedState) pinBtn.classList.add('is-pinned');
        pinBtn.appendChild(createPinIcon());

        // 防连击与单向事件流：通过 roleApi.togglePinWindow 触发命令，状态统一由 onWindowPinnedChanged 驱动
        pinBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isToggling) return;
            isToggling = true;
            try {
                await roleApi.togglePinWindow();
            } catch (error) {
                console.warn('[UniversalPin] Toggle failed:', error);
            } finally {
                setTimeout(() => { isToggling = false; }, 150);
            }
        });

        // 优先插在托盘按钮或最小化按钮左侧（全面兼容超级骰子 #minimize-dice-btn、音乐、协同等）
        const insertTarget = container.querySelector('#win-tray-btn')
            || container.querySelector('#minimize-dice-btn, #minimize-music-btn, #minimize-btn, button[title*="最小化"], button[aria-label*="最小化"], .window-control, button');
        if (insertTarget && insertTarget.parentNode === container) {
            container.insertBefore(pinBtn, insertTarget);
        } else {
            container.prepend(pinBtn);
        }

        return pinBtn;
    };

    // 状态机：支持“全树搜寻模式”与“目标深度休眠模式”
    let rootObserver = null;
    let narrowObserver = null;
    let mountedPinBtn = null;
    let mountedContainer = null;
    let mountScheduled = false;

    const cleanupNarrowObserver = () => {
        if (narrowObserver) {
            narrowObserver.disconnect();
            narrowObserver = null;
        }
    };

    const cleanupRootObserver = () => {
        if (rootObserver) {
            rootObserver.disconnect();
            rootObserver = null;
        }
    };

    const scheduleMount = () => {
        if (mountScheduled) return;
        mountScheduled = true;
        requestAnimationFrame(() => {
            mountScheduled = false;
            tryMount();
        });
    };

    // 深度休眠态：一旦按钮成功在 DOM 中稳定，立即断开全局树观察，收敛为对标题栏的精准浅层观察
    const enterDeepSleep = (container, pinBtn) => {
        cleanupRootObserver();
        cleanupNarrowObserver();
        mountedContainer = container;
        mountedPinBtn = pinBtn;

        const watchTarget = container.parentElement || container;
        narrowObserver = new MutationObserver(() => {
            // 只要图钉按钮依然连接在当前 DOM 树上，坚决不做任何操作，彻底阻断空转汇报
            if (pinBtn.isConnected && container.isConnected) {
                return;
            }
            // 否则说明标题栏被外部 UI 框架重绘或销毁，唤醒并自愈
            cleanupNarrowObserver();
            mountedContainer = null;
            mountedPinBtn = null;
            scheduleMount();
            startRootObserver();
        });

        narrowObserver.observe(watchTarget, {
            childList: true,
            subtree: false, // 严禁 subtree，仅监听直接容器的替换
        });
    };

    const startRootObserver = () => {
        if (rootObserver) return;
        const root = document.body || document.documentElement;
        if (!root) return;

        rootObserver = new MutationObserver((mutations) => {
            // 智能特征哨兵：正文内容（消息、日志、文本）变动绝不唤醒调度
            let relevant = false;
            for (let i = 0; i < mutations.length; i++) {
                const mut = mutations[i];
                if (mut.addedNodes.length > 0) {
                    for (let j = 0; j < mut.addedNodes.length; j++) {
                        const node = mut.addedNodes[j];
                        if (node.nodeType === 1) { // ELEMENT_NODE
                            const name = node.className || '';
                            const tag = node.tagName || '';
                            if (typeof name === 'string' && (
                                name.includes('control') ||
                                name.includes('header') ||
                                name.includes('title') ||
                                name.includes('blade') ||
                                name.includes('vcp-ui') ||
                                tag === 'HEADER' ||
                                tag === 'NAV'
                            )) {
                                relevant = true;
                                break;
                            }
                        }
                    }
                }
                if (relevant) break;
            }
            if (relevant) {
                scheduleMount();
            }
        });

        rootObserver.observe(root, {
            childList: true,
            subtree: true,
        });
    };

    const tryMount = () => {
        if (isExcludedWindowContext()) {
            document.querySelectorAll('.vcp-universal-pin-btn').forEach((btn) => btn.remove());
            cleanupNarrowObserver();
            cleanupRootObserver();
            return;
        }

        // 避让检测：若窗口已存在现代 UI WindowControls，适配器自动注销退出
        if (document.querySelector('.vcp-ui-window-controls')) {
            document.querySelectorAll('.vcp-universal-pin-btn').forEach((btn) => btn.remove());
            cleanupNarrowObserver();
            cleanupRootObserver();
            return;
        }

        // 若当前按钮依然在文档中正常工作，无需重复扫描
        if (mountedPinBtn?.isConnected && mountedContainer?.isConnected) {
            return;
        }
        const targets = Array.from(document.querySelectorAll(CONTAINER_SELECTORS.join(', ')))
            .filter((container) => !container.querySelector(EXISTING_PIN_SELECTOR)
                && !container.classList.contains('window-controls-mac'));
        if (!targets.length) {
            startRootObserver();
            return;
        }

        let firstBtn = null;
        let firstContainer = null;
        for (const container of targets) {
            const btn = mountInto(container);
            if (!firstBtn) {
                firstBtn = btn;
                firstContainer = container;
            }
        }

        ensurePinStyle();
        fetchInitialStateOnce();

        // 成功挂载，立即进入深度休眠！
        if (firstContainer && firstBtn) {
            enterDeepSleep(firstContainer, firstBtn);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scheduleMount, { once: true });
    } else {
        scheduleMount();
    }

    // 初始启动搜寻
    startRootObserver();

    window.addEventListener('unload', () => {
        cleanupNarrowObserver();
        cleanupRootObserver();
    }, { once: true });
}

module.exports = { installPinButton };
