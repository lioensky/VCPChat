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
 * 平台置顶驱动层契约（WindowPinDriver）：
 * 抽象适配 Windows 原生置顶特性，解耦调度逻辑；非 Win32 系统通过 Null 实现零开销。
 */
const WindowPinDriver = {
	isSupported() {
		return process.platform === 'win32';
	},
	applyTopmost(win, isTop) {
		if (!win) return;
		try {
			if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
			win._pinBypass = true;
			try {
				if (isTop) {
					win.setAlwaysOnTop(false);
					// 采用 pop-up-menu 权级，配合 moveTop() 稳固 Z 序
					win.setAlwaysOnTop(true, 'pop-up-menu', 1);
					if (typeof win.moveTop === 'function') {
						win.moveTop();
					}
				} else {
					win.setAlwaysOnTop(false, 'normal');
				}
			} finally {
				win._pinBypass = false;
			}
		} catch (_) {}
	}
};

/**
 * 原生置顶提升：
 * 采用 Driver 层进行受控提升
 */
function bringWindowToTopmost(win) {
	WindowPinDriver.applyTopmost(win, true);
}

function applyWindowTopmost(win, isTop) {
	WindowPinDriver.applyTopmost(win, isTop);
}

/**
 * 向窗口广播置顶状态变更（单向 IPC，避免阻滞 V8 微任务队列）。
 */
function notifyPinnedChanged(win, isPinnedState) {
	if (!win) return;
	try {
		if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
		const wc = win.webContents;
		if (wc && !wc.isDestroyed?.()) {
			wc.send("window-pinned-changed", Boolean(isPinnedState));
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

	// 拖拽节流：拖拽期间首帧提升，期间节流避免向 DWM 发送冗余命令
	let dragThrottleTimer = null;
	const onMoveOrResize = () => {
		if (activeDraggingWinId !== winId) {
			activeDraggingWinId = winId;
			bringWindowToTopmost(win);
		}

		if (settleTimer) {
			clearTimeout(settleTimer);
			settleTimer = null;
		}

		if (!dragThrottleTimer) {
			dragThrottleTimer = setTimeout(() => {
				dragThrottleTimer = null;
			}, 100);
		}
	};

	// 拖拽或缩放结束（松手）/ 窗口失焦 / 最小化：防抖 120ms 后重新排定层级
	const onMotionEnd = () => {
		if (dragThrottleTimer) {
			clearTimeout(dragThrottleTimer);
			dragThrottleTimer = null;
		}
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
		if (dragThrottleTimer) {
			clearTimeout(dragThrottleTimer);
			dragThrottleTimer = null;
		}
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
function setupGlobalWindowPinObserver(_app, _mainWindow) {
	// 现代 VCP 窗口统一由 WindowControls 与 utility 装配接管，废弃全局注入。
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
	WindowPinDriver,
	isExcludedWindow,
};
