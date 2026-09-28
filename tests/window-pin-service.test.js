const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
	isOverlapping,
	getVisualDensityScore,
	compareWindowPriority,
	findWindowClusters,
	pin,
	unpin,
	isPinned,
	togglePin,
	reorderPinnedWindows,
	cleanupAll,
} = require("../modules/services/windowPinService");

function createMockWindow(id, bounds) {
	const emitter = new EventEmitter();
	let currentBounds = { ...bounds };
	let destroyed = false;
	const calls = [];
	const webContentsCalls = [];

	return {
		id,
		isDestroyed: () => destroyed,
		getBounds: () => ({ ...currentBounds }),
		setBounds: (b) => {
			currentBounds = { ...b };
		},
		setAlwaysOnTop: (isTop, level) => {
			calls.push({ method: "setAlwaysOnTop", isTop: Boolean(isTop), level });
		},
		moveTop: () => {
			calls.push({ method: "moveTop" });
		},
		webContents: {
			isDestroyed: () => destroyed,
			send: (channel, ...args) => {
				webContentsCalls.push({ channel, args });
			},
			executeJavaScript: async () => {},
		},
		destroy: () => {
			destroyed = true;
			emitter.emit("closed");
		},
		on: (evt, fn) => emitter.on(evt, fn),
		once: (evt, fn) => emitter.once(evt, fn),
		removeListener: (evt, fn) => emitter.removeListener(evt, fn),
		emit: (evt, ...args) => emitter.emit(evt, ...args),
		getCalls: () => calls,
		getWebContentsCalls: () => webContentsCalls,
		clearCalls: () => {
			calls.length = 0;
			webContentsCalls.length = 0;
		},
	};
}

test("WindowPinService: 综合验证（碰撞排序、连通分量、拖拽防抖、IPC 与生命周期）", async () => {
	cleanupAll();

	// 1. AABB 空间重叠检测
	assert.equal(
		isOverlapping(
			{ x: 0, y: 0, width: 200, height: 200 },
			{ x: 100, y: 100, width: 200, height: 200 },
		),
		true,
	);
	assert.equal(
		isOverlapping(
			{ x: 0, y: 0, width: 100, height: 100 },
			{ x: 200, y: 200, width: 100, height: 100 },
		),
		false,
	);

	// 2. 面积权重与严格弱序（较小窗口优先级更高）
	const small = { width: 200, height: 200 };
	const large = { width: 800, height: 600 };
	assert.ok(getVisualDensityScore(small) < getVisualDensityScore(large));
	assert.equal(compareWindowPriority(small, large, 1, 2), 1);
	assert.equal(compareWindowPriority(large, small, 2, 1), -1);

	// 3. 连通分量识别（空间相交聚类，互不相交集群隔离）
	const clusters = findWindowClusters([
		{ win: { id: 1 }, bounds: { x: 0, y: 0, width: 400, height: 400 } },
		{ win: { id: 2 }, bounds: { x: 100, y: 100, width: 200, height: 200 } },
		{ win: { id: 3 }, bounds: { x: 2000, y: 0, width: 500, height: 500 } },
		{ win: { id: 4 }, bounds: { x: 2100, y: 100, width: 200, height: 200 } },
	]);
	assert.equal(clusters.length, 2);

	// 4. 置顶注册、IPC 状态同步与层级排序
	const winL = createMockWindow(10, {
		x: 100,
		y: 100,
		width: 800,
		height: 600,
	});
	const winS = createMockWindow(20, {
		x: 150,
		y: 150,
		width: 300,
		height: 200,
	});

	assert.equal(pin(winL), true);
	assert.equal(isPinned(winL), true);
	assert.ok(
		winL
			.getWebContentsCalls()
			.some((c) => c.channel === "window-pinned-changed" && c.args[0] === true),
	);

	assert.equal(pin(winS), true);
	winL.clearCalls();
	winS.clearCalls();

	reorderPinnedWindows();
	assert.ok(winS.getCalls().length > 0, "小窗口 winS 应提升到大窗口 winL 之上");

	// 5. 拖拽插队与松手 120ms 防抖落定（长按期间持续霸榜，直到松手才防抖落定）
	winL.clearCalls();
	winS.clearCalls();
	winL.emit("move");
	assert.ok(winL.getCalls().length > 0, "拖拽大窗口时必须即时插队提升");
	assert.equal(winS.getCalls().length, 0);

	// 模拟长按停顿思考：在未触发 moved/松手前，多次排位调度绝不破坏拖拽窗口的置顶霸榜
	reorderPinnedWindows();
	assert.equal(
		winS.getCalls().length,
		0,
		"长按拖拽中途未松手时，其他小窗口不能插队覆盖",
	);

	winL.emit("moved");
	await new Promise((r) => setTimeout(r, 160));
	assert.ok(
		winS.getCalls().length > 0,
		"松手后防抖落定，小窗口 winS 重新恢复浮在大窗口上方",
	);

	// 5.1 失焦兜底（Alt+Tab 或切走窗口时退出拖拽锁）
	winL.clearCalls();
	winS.clearCalls();
	winL.emit("move");
	winL.emit("blur");
	await new Promise((r) => setTimeout(r, 160));
	assert.ok(winS.getCalls().length > 0, "失焦后安全防抖落定，解除拖拽锁定");

	// 6. 取消置顶与窗口销毁生命周期清理
	assert.equal(togglePin(winL), false);
	assert.equal(isPinned(winL), false);

	winS.destroy();
	assert.equal(isPinned(winS), false);
	assert.equal(unpin(winS), false);

	cleanupAll();
});
