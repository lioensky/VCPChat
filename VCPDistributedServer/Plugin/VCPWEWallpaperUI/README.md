# VCPWEWallpaperUI - Wallpaper Engine 壁纸（前端）

> pluginType: `renderer` · 由 frontend-plugin-loader.js 注入聊天窗口
> 硬依赖：service 插件 `VCPWEWallpaper`（需启用分布式服务器）

## 功能

在聊天窗口使用 Wallpaper Engine 库存壁纸作为动态背景：

- **三种呈现形态**，按壁纸实际能力自动分派：

  | 形态 | 图层 | 适用 |
  |---|---|---|
  | `video` | `<video>` 硬解播放 | Video 类型壁纸（.mp4 等） |
  | `web` | `<iframe>` 隔离渲染 | Web 类型壁纸，由 service 端托管目录并注入 WE API 垫片 |
  | `image` | `<div>` 背景图铺底 | Scene 类型，或 web 载入超时后的降级兜底 |

- **壁纸库网格选择器**：预览图 + 标题 + **形态徽章**（视频·动态 / 网页·动态 / 场景·静态 / 不可用），标题搜索 + 类型过滤 + 分页（每页 24 张）。徽章按「实际能得到什么」标注，而非 WE 原始类型。
- **重新扫描**：弹窗右上角的回旋箭头按钮。service 端 inventory 有 5 分钟缓存，在 Steam 新订阅壁纸后不点它最多要等一个 TTL；该按钮以 `?refresh=1` 强制重扫，并回报本次新增/减少了几张。
- **chat-header 控制面板**：壁纸库 / 播放暂停 / 静音 / 背景显隐 / 音量 / **轮播** / **下一张**。折叠后仅剩一枚 `header-button`（右键该图标也可直接开壁纸库）。非视频形态下播放/静音/音量三个控件自动隐藏（对静态图和 web 壁纸没有意义）。
- **轮播**：在当前过滤范围内的「可动态呈现」壁纸（video + web）间定时轮换。左键开关，**右键循环切换间隔**（1 / 5 / 15 / 30 / 60 分钟），开启态按钮点亮。窗口不可见时跳过切换，不浪费解码。静态兜底图不参与轮播——一张不动的图轮换只会莫名闪烁。
- **白屏保护**：web 壁纸 8 秒内未 `load` 视为白屏（多见于依赖外网 CDN 的壁纸），自动降级为该壁纸自带的 `preview` 静态图，并在本次会话内记住不再重试。
- **无缝循环**：视频壁纸 `loop` 常开，播完立刻从头接上。这与轮播是两套独立机制——`loop` 管单张无限重播，轮播管到点换下一张；轮播关闭时单张就一直循环下去。
- **断点续播**：重启 VCPChat 后从上次播放位置继续。
- **窗口不可见即挂起**：`visibilitychange` 上暂停视频解码、卸载 web iframe（壁纸的 rAF 随文档一起停），回到前台自动恢复——视频从记下的进度接上，web 挂回同一入口页且不再重跑白屏超时判定（挂起前已验证过可载入，否则每次切窗口都会被误判降级）。主人自己按了「隐藏背景」时不擅自恢复。
- **只取元数据**：`<video preload="metadata">`。HTML5 默认 `auto`，Chromium 会尽量把整个文件缓冲进内存；本机视频壁纸实测平均 76.6 MB、最大 205.5 MB，`auto` 就是几百 MB 的白花。`metadata` 只读时长/尺寸，播放时按 Range 流式取，画面表现无差别。
- **互斥协调**：本插件激活时自动暂停 VChatDynamicWallpaper（辉宝）的背景视频，避免双层视频。只改其内存态，不动它的 localStorage。
- **registry 暴露**：`{ destroy, pause, resume, openPicker, next, setRotate, state, active, kind }` 供 VCPGlass 等插件联动。

## 使用

1. 启用分布式服务器 + `VCPWEWallpaper` service 插件（先决条件）
2. 启用本插件，重启 VCPChat
3. 聊天窗口标题栏出现网格图标 -> 点击展开面板 -> 「壁纸库」-> 点选壁纸

## web 壁纸的前置条件

主程序 `main.html` 的 CSP 必须放通：

```
frame-src 'self' http://127.0.0.1:5974 http://localhost:5974;
```

本仓库已加。CSP 的多策略是**取交集**的，插件自己注入 `<meta>` 只能收紧不能放宽，所以这一行没有插件侧替代方案（`srcdoc` / `blob:` / `data:` iframe 都继承父页 CSP 且源为 opaque，`'self'` 匹配不到任何东西）。缺这一行时 web 壁纸会被浏览器拦下，8 秒后自动降级为静态预览图，其余功能不受影响。

## 设置（localStorage `vcpWeWallpaper.settings.v1`）

`enabled` / `wallpaperId` / `wallpaperKind`（`video`｜`web`｜`image`）/ `playing` / `muted` / `volume` / `currentTime` / `visible` / `serverBase`（默认 `http://127.0.0.1:5974`）/ `filterType` / `panelCollapsed` / `rotate` / `rotateMinutes`

## 测试

```
node tests/vcp-we-wallpaper-ui.test.js
```

JSDOM 冒烟：结构注入（含 `loop` / `preload` 两个默认值断言）/ 分页 / 过滤 / 徽章形态 / 静态兜底 / 不可用拒绝 / web iframe 载入 / 超时降级 / 视频点选 / 辉宝互斥 / 轮播开关与间隔循环与手动下一张 / 隐藏挂起与恢复（视频暂停续播、主动隐藏不擅自恢复、web 卸载重挂不误降级）/ 持久化 / destroy 清理。

## 已知限制

- **Scene 壁纸只能静态铺底**：内容封在私有 `scene.pkg`，需要 WE 自家 3D 引擎才能渲染。
- **音频律动类 web 壁纸会静止**：service 端垫片喂的是全零频谱。
- **依赖外网 CDN 的 web 壁纸**可能白屏并降级为静态图（有超时保护，不会一直空白）。
- **库存不会自动更新**：这是刻意的设计。前端 `fetchInventory` 首次取到库存后就锁在内存里，第二次打开壁纸库连请求都不发；service 端那 5 分钟 TTL 是惰性过期（只让缓存作废，重扫要等下一次请求触发），因此一个 VCPChat 会话内库存是稳定不变的。在 Steam 新订阅壁纸后，点弹窗右上角的「重新扫描」即可，不必重启。既无定时任务也无目录监听。
- **轮播基于过滤范围**，不是 WE 自己的播放列表（service 端 `playlists` 仍是 v1.1 占位）。
- **动态壁纸的开销来自壁纸本身**，不是本插件。插件自身实测：WE 定位 58 ms（仅首次）、136 个壁纸目录枚举 26 ms（冷）/ 19 ms（暖），堆增量 0.70 MB，库存缓存 5 分钟，两插件源码合计 77 KB。真正吃资源的是 1080p/4K 视频的持续流式读取与硬解——这是动态壁纸的固有成本，`preload=metadata` 与隐藏挂起已把可省的部分省掉。
- 与辉宝插件同时启用时以本插件优先（激活即暂停辉宝）；关闭本插件背景后需手动重新启用辉宝。

## 致谢

播放器内核（状态机/失败跳过/断点续播模型）移植自 VCPChat 仓库内 VChatDynamicWallpaper（by 辉宝）。
