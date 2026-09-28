# VCP 窗口置顶（Window Pinning）与多窗口层级调度架构设计

## 1. 概述与核心目标

在 VCP 客户端的 Windows 桌面场景中，用户常打开多个独立子窗口（如日志中心、备忘录、图片预览、独立终端、BladeGame 插件等）。传统的简单置顶机制存在多窗口层叠遮挡、小窗口被大窗口吞没、拖拽时层级跳动冲突等问题。

本设计旨在建立一套**零侵入、跨隔离、手感稳定、兼顾临时查看与自动归纳**的完整置顶与 Z 序调度体系。

---

## 2. 异构窗口双轨装配设计（兼容新旧与插件窗口）

VCP 内部存在两种完全不同技术栈与生命周期的独立窗口，本设计采用“双轨并行”方案实现无死角自动装配：

| 窗口类型 | 典型代表 | Preload 隔离与环境 | 装配与通信通道 |
| :--- | :--- | :--- | :--- |
| **标准 VCP 子窗口** | 论坛 (Forum)、备忘录 (Memo)、日志中心 (Log)、图片预览 (ImageViewer) | 注入标准 `utility.js` Preload，享有完整的 `window.utilityAPI` 上下文桥接 | **Preload 通道**：`installUniversalPinControl`<br>在 DOM 就绪时识别标题栏容器挂载图钉，通过标准 IPC `toggle-pin-window` 双向通信 |
| **分布式异构插件与工具** | BladeGame 游戏窗口、PowerShell Executor、PTYShell 终端等 | 独立沙箱 Preload（如 `blade-preload.js`、`gui/preload.js`），完全无 `window.utilityAPI` 依赖 | **主进程接管通道**：`setupGlobalWindowPinObserver`<br>监听 `app` 的 `browser-window-created`，在窗口加载就绪后安全挂载图钉，免侵入插件业务代码 |
| **现代 UI 组件化窗口** | 采用 `vcp-ui.js` 统一组件体系构建的新版窗口 | 运行时由 `VCPUI.create('WindowControls')` 或 `appPageShellFactory` 动态渲染控制栏 | **组件受控通道**：`windowControlsFactory`<br>声明式支持 `pinable: true/false`，控制器动态挂载与注销状态监听，杜绝僵尸按钮 |

### 严格的排除范围（Excluded Contexts）
为保障整体视觉与系统安全，以下视口严格排除置顶功能：
1. **主聊天视口**：`main.html` / `main-chat-window`；
2. **桌面底座窗口**：`desktop.html` / `desktop-window`；
3. **内嵌标签页与嵌入式应用**：`dataset.vcpEmbeddedApp === 'true'`、`vcpEmbedded=1`、`.next-ui-internal-app-view` 以及所有 iframe 子框架。

---

## 3. 多窗口层级调度与物理聚类算法

当多个窗口同时处于置顶（Always-On-Top）状态时，调度引擎采用几何算法进行无感排序：

1. **AABB 碰撞检测与独立连通分量（Connected Clusters）**：
   - 算法计算窗口的外接矩形（Bounding Box），仅对**物理区域真实发生空间重叠**的窗口划入同一个集群独立排位；
   - 屏幕两侧或多显示器上互不相交的窗口群落互不影响，杜绝全局联动导致的层级侧漏。
2. **面积密度评分（Visual Density Ordering）**：
   - 采用尺寸加权评分 $S = \min(w, h) \times \sqrt{w \times h}$；
   - 连通群落内部按尺寸从大到小排序，**较小窗口自底向上依次声明置顶，确保小窗口始终浮在上方**，避免小工具被大窗口吞噬。

---

## 4. 人机交互语义：即时查看与手势归纳

本体系贯彻 **“交互阶段听用户的，整理阶段听算法的”** 设计哲学：

1. **静态点击：即时查看优先（后来者居上）**
   - 当窗口保持静止时，调度体系保持**惰性（Inert / Sleep）**；
   - 用户点击任何一个下层置顶窗口，Windows 原生机制将其直接激活到最顶层方便查看与打字，后台绝不强行打压或抢夺层级，**彻底根除按住瞬间“先下沉再上浮”的反复横跳与抓空失焦问题**。
2. **动态拖拽：长按持续霸榜**
   - 用户按住并拖动某一窗口时，该窗口即时脱离静态群落，独占最高优先级；
   - 只要用户鼠标未松开（无论是在移动还是停留在原地静止思考），霸榜状态持续有效，绝不被任何硬超时打断。
3. **松手落定：120ms 防抖自动规整**
   - 手指松开鼠标（`moved` / `resized`）那一刻，启动 120ms 防抖计时器；
   - 计时结束后，该窗口带入新坐标重新归入连通分量体系，自动按面积重排（大在下、小在上），实现优雅的手势归纳。
4. **异常脱离兜底**
   - 窗口获得 `blur`（如 Alt+Tab 切走）或 `minimize`（最小化）时，自动视为拖拽动作平滑退出，确保调度锁万无一失。
