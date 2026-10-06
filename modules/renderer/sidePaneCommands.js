/*
 * 侧栏对外提供的动作，登记成命令：
 *   sidepane.open-tab          打开（或回到）一个标签，参数同 controller.openTab
 *   sidepane.open-trajectory   打开调用轨迹并定位到某次请求 { requestId }
 *   notifications.toggle       开 / 关通知页
 *   projectforge.open          打开 V工程，可带 { projectId } 直接定位到那个工程
 * 别的模块（消息右键、代码块按钮、主进程转来的快捷键）只认命令 id，不再碰侧栏控制器或 window 上的全局函数。
 * 命令都挂在 owner scope 上，侧栏卸载时一起注销。
 */
import '../ui-system/lifecycle-scope.js';
import { NOTIFICATIONS_TAB_ID } from '../ui-system/side-pane/side-pane-state.js';

const PROJECT_FORGE_ACTION = 'open-project-forge-window';
// projectforge.js 打开时读这个键定位工程（读完就删，超过一分钟作废）
const PROJECT_FORGE_FOCUS_KEY = 'vcp-projectforge-focus';

export function registerSidePaneCommands({ win, chatAPI, controller, openModelTrajectory, commands = win?.VCPContributions?.commands }) {
    const LifecycleScope = globalThis.VCPLifecycle?.LifecycleScope;
    if (!commands || !LifecycleScope) return { dispose() {} };
    const owner = new LifecycleScope('side-pane-commands');

    const openProjectForge = ({ projectId = null } = {}) => {
        if (typeof projectId === 'string' && projectId) {
            try { win.localStorage.setItem(PROJECT_FORGE_FOCUS_KEY, JSON.stringify({ id: projectId, at: Date.now() })); } catch (_e) { /* 打开窗口不受影响 */ }
        }
        // 和新标签页里的应用入口走同一条路：能嵌入就开成标签页，否则开独立窗口
        const app = win.trayManager?.getApps?.().find(candidate => candidate.action === PROJECT_FORGE_ACTION);
        const shell = win.VCPNextShellController;
        if (app?.embed && shell?.openEmbeddedApp) return shell.openEmbeddedApp(app);
        if (app && win.trayManager?.launchApp) return win.trayManager.launchApp(app);
        return chatAPI?.desktopCreateEmbeddedVchatApp?.(PROJECT_FORGE_ACTION);
    };

    const definitions = [
        { id: 'sidepane.open-tab', title: '在侧栏打开标签', handler: tab => controller.openTab(tab) },
        { id: 'sidepane.open-trajectory', title: '查看调用轨迹', handler: (options = {}) => openModelTrajectory(options) },
        {
            id: 'notifications.toggle',
            title: '开关通知面板',
            handler: () => {
                const snapshot = controller.getSnapshot();
                if (snapshot.visible && snapshot.activeTabId === NOTIFICATIONS_TAB_ID) controller.setVisible(false);
                else controller.showNotifications();
            }
        },
        { id: 'projectforge.open', title: '打开 V工程', handler: openProjectForge },
    ];
    for (const definition of definitions) {
        // 同名命令已被别处登记（不该发生）时保留原来的，不让侧栏启动失败
        if (commands.get(definition.id)) {
            console.warn(`[SidePane] command ${definition.id} is already registered`);
            continue;
        }
        commands.register(definition, { owner, ownerId: 'side-pane' });
    }
    return Object.freeze({ dispose: () => owner.dispose('side-pane-disposed') });
}
