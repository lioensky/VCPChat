/**
 * modules/services/windowPinService.js
 *
 * 窗口置顶管理与多窗口层级调度服务（Windows 平台专属）。
 *
 * 规则说明:
 * 1. 拖拽优先：拖拽或调整尺寸中的窗口即时插队提升至最前；长按不松手期间持续锁定最高层级；
 * 2. 释放重排：松开鼠标后防抖 120ms，对空间重叠的置顶窗口按面积排定（较小窗口置于上方）；
 * 3. 连通分量划分：仅对物理区域有重叠的窗口集群独立排位，互不干扰；
 * 4. 生命周期管理：窗口关闭/失焦时安全清理，防范状态锁死。
 */

/** @type {Map<number, { win: import('electron').BrowserWindow, cleanup: () => void }>} */
const pinnedWindows = new Map();

/** 当前正处于拖拽/长按状态的窗口 ID */
let activeDraggingWinId = null;
let settleTimer = null;

/**
 * 检测两个矩形区域是否有空间重合（AABB 碰撞检测）。
 */
function isOverlapping(rectA, rectB) {
	if (!rectA || !rectB) return false;
	return !(
		rectA.x + rectA.width <= rectB.x ||
		rectB.x + rectB.width <= rectA.x ||
		rectA.y + rectA.height <= rectB.y ||
		rectB.y + rectB.height <= rectA.y
	);
}

/**
 * 计算窗口面积权重评分，评分越小优先级越高（较小窗口排在上方）。
 */
function getVisualDensityScore(rect) {
	if (!rect) return 0;
	const width = Math.max(1, Number(rect.width) || 1);
	const height = Math.max(1, Number(rect.height) || 1);
	const minSide = Math.min(width, height);
	return minSide * Math.sqrt(width * height);
}

/**
 * 比较两窗口优先级（严格弱序）：
 * 返回 1 表示 A 优于 B（A 应排在上方）；
 * 返回 -1 表示 B 优于 A；
 * 评分相同时通过 ID 稳定平局。
 */
function compareWindowPriority(rectA, rectB, idA = 0, idB = 0) {
	const scoreA = getVisualDensityScore(rectA);
	const scoreB = getVisualDensityScore(rectB);
	if (scoreA !== scoreB) {
		return scoreA < scoreB ? 1 : -1;
	}
	if (idA !== idB) {
		return idA < idB ? 1 : -1;
	}
	return 0;
}

/**
 * 安全获取窗口 Bounds。
 */
function safeGetBounds(win) {
	if (!win) return null;
	try {
		if (typeof win.isDestroyed === "function" && win.isDestroyed()) return null;
		return win.getBounds();
	} catch (_) {
		return null;
	}
}

/**
 * 原生置顶提升：
 * Windows 下采用 setAlwaysOnTop(false -> true) 打破 Chromium 内部缓存，强制向 DWM 发送 HWND_TOPMOST。
 */
function bringWindowToTopmost(win) {
	if (!win) return;
	try {
		if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
		win._pinBypass = true;
		win.setAlwaysOnTop(false);
		win.setAlwaysOnTop(true);
	} catch (_) {
	} finally {
		if (win) win._pinBypass = false;
	}
}

function applyWindowTopmost(win, isTop) {
	if (!win) return;
	try {
		if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
		if (isTop) {
			bringWindowToTopmost(win);
		} else {
			win._pinBypass = true;
			try {
				win.setAlwaysOnTop(false);
			} finally {
				win._pinBypass = false;
			}
		}
	} catch (_) {}
}

/**
 * 向窗口通知置顶状态变更事件（双向同步）。
 */
function notifyPinnedChanged(win, isPinnedState) {
	if (!win) return;
	try {
		if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
		const wc = win.webContents;
		if (wc && !wc.isDestroyed?.()) {
			wc.send("window-pinned-changed", isPinnedState);
			const pinned = Boolean(isPinnedState);
			wc.executeJavaScript(`
				(() => {
					const pinned = ${pinned};
					document.querySelectorAll('.vcp-universal-pin-btn').forEach(pinBtn => {
						pinBtn.classList.toggle('is-pinned', pinned);
						pinBtn.setAttribute('aria-pressed', String(pinned));
						pinBtn.title = pinned ? '取消置顶' : '置顶窗口';
						pinBtn.setAttribute('aria-label', pinned ? '取消置顶' : '置顶窗口');
					});
				})()
			`).catch(() => {});
		}
	} catch (_) {}
}

/**
 * 将重叠窗口集合按照 AABB 相交关系划分为独立的连通分量 (Connected Clusters)。
 * 保证多屏幕或屏幕两侧互不重叠的窗口集群独立排位，互不产生层级侧漏。
 */
function findWindowClusters(items) {
	const visited = new Set();
	const clusters = [];

	for (let i = 0; i < items.length; i++) {
		if (visited.has(i)) continue;
		const cluster = [items[i]];
		visited.add(i);
		const queue = [items[i]];

		while (queue.length > 0) {
			const curr = queue.shift();
			for (let j = 0; j < items.length; j++) {
				if (!visited.has(j) && isOverlapping(curr.bounds, items[j].bounds)) {
					visited.add(j);
					cluster.push(items[j]);
					queue.push(items[j]);
				}
			}
		}

		if (cluster.length > 1) {
			clusters.push(cluster);
		}
	}

	return clusters;
}

/**
 * 核心调度：按空间连通分量 (Clusters) 自底向上排定 [大, 中, 小]。
 * 当有窗口处于按住拖拽状态时完全跳过，确保拖拽窗口绝对优先。
 */
function reorderPinnedWindows() {
	if (pinnedWindows.size <= 1) return;
	if (activeDraggingWinId !== null) return;

	const items = [];
	for (const [_, entry] of pinnedWindows.entries()) {
		if (!entry?.win) continue;
		try {
			if (
				typeof entry.win.isDestroyed === "function" &&
				entry.win.isDestroyed()
			)
				continue;
		} catch (_) {
			continue;
		}
		const b = safeGetBounds(entry.win);
		if (b) items.push({ win: entry.win, bounds: b });
	}

	if (items.length <= 1) return;

	// 找出所有相互独立的重叠连通分量
	const clusters = findWindowClusters(items);
	if (clusters.length === 0) return;

	for (const cluster of clusters) {
		// 每个群组内部按尺寸由大到小排序：[大, 中, 小]
		cluster.sort((a, b) =>
			compareWindowPriority(a.bounds, b.bounds, a.win.id, b.win.id),
		);

		// 当前群组内最大窗口垫底保留，上方较小窗口按从大到小依次自底向上提升
		const upperItems = cluster.slice(1);
		for (const item of upperItems) {
			bringWindowToTopmost(item.win);
		}
	}
}

/**
 * 检查窗口是否已开启置顶。
 */
function isPinned(winOrId) {
	if (!winOrId) return false;
	const winId = typeof winOrId === "number" ? winOrId : winOrId.id;
	if (winId == null) return false;
	if (!pinnedWindows.has(winId)) return false;
	const entry = pinnedWindows.get(winId);
	if (
		entry?.win &&
		typeof entry.win.isDestroyed === "function" &&
		entry.win.isDestroyed()
	) {
		unpin(winId);
		return false;
	}
	return true;
}

/**
 * 开启置顶。
 */
function pin(win) {
	if (!win) return false;
	try {
		if (typeof win.isDestroyed === "function" && win.isDestroyed())
			return false;
	} catch (_) {
		return false;
	}

	const winId = win.id;
	if (pinnedWindows.has(winId)) {
		bringWindowToTopmost(win);
		notifyPinnedChanged(win, true);
		return true;
	}

	bringWindowToTopmost(win);

	// 拖拽或缩放移动中：插队提升到最前，并保持活跃拖拽状态
	const onMoveOrResize = () => {
		if (activeDraggingWinId !== winId) {
			activeDraggingWinId = winId;
			bringWindowToTopmost(win);
		}

		if (settleTimer) {
			clearTimeout(settleTimer);
			settleTimer = null;
		}
	};

	// 拖拽或缩放结束（松手）/ 窗口失焦 / 最小化：防抖 120ms 后重新排定层级
	const onMotionEnd = () => {
		if (activeDraggingWinId !== winId) return;

		if (settleTimer) {
			clearTimeout(settleTimer);
			settleTimer = null;
		}

		const targetWinId = winId;
		settleTimer = setTimeout(() => {
			settleTimer = null;
			if (activeDraggingWinId === targetWinId) {
				activeDraggingWinId = null;
			}
			reorderPinnedWindows();
		}, 120);
	};

	const onClosed = () => {
		unpin(winId);
	};

	win.on("move", onMoveOrResize);
	win.on("resize", onMoveOrResize);
	win.on("moved", onMotionEnd);
	win.on("resized", onMotionEnd);
	win.on("blur", onMotionEnd);
	win.on("minimize", onMotionEnd);
	win.once("closed", onClosed);

	const cleanup = () => {
		try {
			win.removeListener("move", onMoveOrResize);
			win.removeListener("resize", onMoveOrResize);
			win.removeListener("moved", onMotionEnd);
			win.removeListener("resized", onMotionEnd);
			win.removeListener("blur", onMotionEnd);
			win.removeListener("minimize", onMotionEnd);
			win.removeListener("closed", onClosed);
		} catch (_) {}
	};

	pinnedWindows.set(winId, { win, cleanup });
	notifyPinnedChanged(win, true);
	reorderPinnedWindows();
	return true;
}

/**
 * 取消置顶。安全支持 win 实例或 winId，窗口已被销毁时依然能彻底释放 Map 与定时器。
 */
function unpin(winOrId) {
	if (!winOrId) return false;
	const winId = typeof winOrId === "number" ? winOrId : winOrId.id;
	if (winId == null) return false;

	const entry = pinnedWindows.get(winId);
	if (!entry) return false;

	pinnedWindows.delete(winId);
	if (activeDraggingWinId === winId) {
		activeDraggingWinId = null;
		if (settleTimer) {
			clearTimeout(settleTimer);
			settleTimer = null;
		}
	}

	if (typeof entry.cleanup === "function") {
		entry.cleanup();
	}

	const win = entry.win;
	if (win) {
		try {
			if (typeof win.isDestroyed !== "function" || !win.isDestroyed()) {
				applyWindowTopmost(win, false);
				notifyPinnedChanged(win, false);
			}
		} catch (_) {}
	}

	reorderPinnedWindows();
	return false;
}

/**
 * 切换置顶状态。
 */
function togglePin(win) {
	if (!win) return false;
	try {
		if (typeof win.isDestroyed === "function" && win.isDestroyed())
			return false;
	} catch (_) {
		return false;
	}
	return isPinned(win) ? unpin(win) : pin(win);
}

/**
 * 清理所有置顶窗口。
 */
function cleanupAll() {
	if (settleTimer) {
		clearTimeout(settleTimer);
		settleTimer = null;
	}
	activeDraggingWinId = null;

	for (const [, entry] of pinnedWindows.entries()) {
		if (typeof entry.cleanup === "function") entry.cleanup();
		if (entry.win) {
			try {
				if (
					typeof entry.win.isDestroyed !== "function" ||
					!entry.win.isDestroyed()
				) {
					applyWindowTopmost(entry.win, false);
					notifyPinnedChanged(entry.win, false);
				}
			} catch (_) {}
		}
	}
	pinnedWindows.clear();
}

/** 兼容别名 */
const elevateWindow = (win) => bringWindowToTopmost(win);
const settleWindow = () => reorderPinnedWindows();
const resettleAllIntersectingGroups = () => reorderPinnedWindows();
const assertAllPinnedWindowsAbove = () => reorderPinnedWindows();

let globalObserverInitialized = false;

function isExcludedWindow(win, mainWindow) {
	if (!win) return true;
	try {
		if (typeof win.isDestroyed === "function" && win.isDestroyed()) return true;
		if (mainWindow && win === mainWindow) return true;
		if (typeof win.isModal === "function" && win.isModal()) return true;

		try {
			const desktopHandlers = require("../ipc/desktopHandlers");
			const desktopWin = desktopHandlers.getDesktopWindow?.();
			if (desktopWin && win === desktopWin) return true;
		} catch (_) {}

		const url = win.webContents?.getURL?.() || "";
		if (
			url.includes("main.html") ||
			url.includes("desktop.html") ||
			url.includes("desktop-only") ||
			url.includes("vcpEmbedded=1") ||
			url.includes("RAG_Overlay.html")
		) {
			return true;
		}
	} catch (_) {
		return true;
	}
	return false;
}

/**
 * 主进程全局独立窗口置顶监听。
 * 为各受管子窗口装配置顶图钉及快捷调用。
 * 平台门禁：专注于 Windows 平台。
 */
function setupGlobalWindowPinObserver(app, mainWindow) {
	if (!app || globalObserverInitialized) return;
	globalObserverInitialized = true;

	// 平台门禁：非 Windows 环境优雅跳过
	if (process.platform !== "win32") return;

	const attachToWindow = (win) => {
		if (!win || win._pinObserverAttached) return;
		win._pinObserverAttached = true;

		// 通过 console-message 接收免 Preload 依赖的通用图钉点击兜底
		const wc = win.webContents;
		if (wc) {
			wc.on("console-message", (_event, _level, message) => {
				if (message === "__VCP_PIN_TOGGLE__") {
					if (!isExcludedWindow(win, mainWindow)) {
						togglePin(win);
					}
				}
			});

			const tryInjectPinButton = () => {
				if (isExcludedWindow(win, mainWindow)) return;
				const injectScript = `
					(() => {
						// 契约分流：若窗口已有标准 Preload 接管，则由 utility.js 自行装配，避免主进程重复扫描
						if (window.utilityAPI?.togglePinWindow) return;

						const candidateSelectors = [
							'.blade-window-controls',
							'.window-controls-win',
							'.window-controls:not(.window-controls-mac)',
							'.mini-window-controls',
							'.vcp-ui-window-controls',
							'.titlebar-actions'
						];
						let container = null;
						for (const sel of candidateSelectors) {
							const el = document.querySelector(sel);
							if (el) {
								if (el.classList.contains('window-controls-mac')) continue;
								container = el;
								break;
							}
						}
						if (!container) {
							const minOrClose = document.querySelector(
								'button#blade-minimize-btn, button#win-minimize-btn, button#minimize-btn, button.btn-minimize, button.blade-window-control-close, button.vcp-ui-window-control-close, button[title*="最小化"], button[aria-label*="最小化"]'
							);
							if (minOrClose) container = minOrClose.parentElement;
						}
						if (!container) return;

						// 检查是否已有置顶按钮，避免重复注入
						const existingPin = container.querySelector(
							'.vcp-universal-pin-btn, .vcp-ui-window-control-pin, [aria-label*="置顶"], [title*="置顶"], [aria-label*="pin" i], [title*="pin" i], [id*="pin" i], [class*="pin-btn" i]'
						);
						if (existingPin) return;

						const sampleBtn = container.querySelector('button');
						const sampleClass = sampleBtn ? sampleBtn.className : 'window-control-btn';

						const pinBtn = document.createElement('button');
						pinBtn.type = 'button';
						pinBtn.className = (sampleClass + ' vcp-universal-pin-btn').trim();
						pinBtn.title = '置顶窗口';
						pinBtn.setAttribute('aria-label', '置顶窗口');
						pinBtn.setAttribute('aria-pressed', 'false');

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
						pinBtn.appendChild(svg);

						const syncPinVisual = (pinned) => {
							const isTop = Boolean(pinned);
							document.querySelectorAll('.vcp-universal-pin-btn').forEach(btn => {
								btn.classList.toggle('is-pinned', isTop);
								btn.setAttribute('aria-pressed', String(isTop));
								btn.title = isTop ? '取消置顶' : '置顶窗口';
								btn.setAttribute('aria-label', isTop ? '取消置顶' : '置顶窗口');
							});
						};

						pinBtn.addEventListener('click', async (e) => {
							e.preventDefault();
							e.stopPropagation();
							if (window.utilityAPI?.togglePinWindow) {
								try {
									const isPinned = await window.utilityAPI.togglePinWindow();
									syncPinVisual(isPinned);
								} catch (_) {}
							} else {
								console.log('__VCP_PIN_TOGGLE__');
							}
						});

						if (window.utilityAPI?.isWindowPinned) {
							window.utilityAPI.isWindowPinned().then(syncPinVisual).catch(() => {});
						}

						const minBtn = container.querySelector(
							'#blade-minimize-btn, #win-minimize-btn, #minimize-btn, #minimize-notes-btn, #minimize-music-btn, #minimize-theme-btn, #minimize-translator-btn, #minimize-viewer-btn, .btn-minimize, .vcp-ui-window-control-button, [aria-label*="最小化"]'
						);
						const trayBtn = container.querySelector('#win-tray-btn');
						const insertTarget = trayBtn || minBtn;

						if (insertTarget && insertTarget.parentNode === container) {
							container.insertBefore(pinBtn, insertTarget);
						} else {
							container.prepend(pinBtn);
						}

						if (!document.getElementById('vcp-universal-pin-style')) {
							const style = document.createElement('style');
							style.id = 'vcp-universal-pin-style';
							style.textContent = \`
								.vcp-universal-pin-btn.is-pinned {
									color: var(--vcp-ui-primary, #6366f1) !important;
									background: var(--vcp-ui-primary-bg, rgba(99, 102, 241, 0.16)) !important;
								}
								.vcp-universal-pin-btn.is-pinned svg {
									transform: rotate(-15deg);
								}
							\`;
							(document.head || document.documentElement).appendChild(style);
						}
					})();
				`;
				wc.executeJavaScript(injectScript)
					.then(() => {
						if (isPinned(win)) {
							notifyPinnedChanged(win, true);
						}
					})
					.catch(() => {});
			};

			wc.on("did-finish-load", tryInjectPinButton);
			wc.on("dom-ready", tryInjectPinButton);
		}
	};

	app.on("browser-window-created", (_event, win) => {
		attachToWindow(win);
	});

	try {
		const { BrowserWindow } = require("electron");
		if (BrowserWindow?.getAllWindows) {
			BrowserWindow.getAllWindows().forEach((win) => {
				attachToWindow(win);
			});
		}
	} catch (_) {}
}

module.exports = {
	isOverlapping,
	getVisualDensityScore,
	compareWindowPriority,
	findWindowClusters,
	applyWindowTopmost,
	elevateWindow,
	isPinned,
	togglePin,
	pin,
	unpin,
	settleWindow,
	resettleAllIntersectingGroups,
	assertAllPinnedWindowsAbove,
	reorderPinnedWindows,
	cleanupAll,
	setupGlobalWindowPinObserver,
};
