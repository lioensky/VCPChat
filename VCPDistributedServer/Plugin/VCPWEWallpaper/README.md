# VCPWEWallpaper - Wallpaper Engine 壁纸服务

> pluginType: `service` · 无 config.env · 无 AI 可见命令（纯基础设施）
> 配套渲染端：`VCPWEWallpaperUI`（renderer 型前端插件）

## 功能

发现本机 Wallpaper Engine 安装，枚举壁纸库存（官方默认 / 我的项目 / 创意工坊订阅），并通过 VCPDistributedServer 主 Express 应用（默认 5974 端口）提供 HTTP 服务：

| 路由 | 说明 |
|---|---|
| `GET /vcp-we-wallpaper/inventory` | 壁纸库存 JSON（id/title/type/playable/media/preview/web）。带 `?refresh=1` 则绕过缓存重扫 |
| `GET /vcp-we-wallpaper/media/<token>` | 视频媒体流，支持 Range（拖进度条） |
| `GET /vcp-we-wallpaper/preview/<token>` | 预览图 |
| `GET /vcp-we-wallpaper/web/<token>/*` | **web 类型壁纸的目录子树托管**，入口 HTML 自动注入 WE API 垫片 |

- **类型边界**：Video（mp4 等）与 Web（HTML）可动态呈现；Scene（WE 原生 3D，内容封在私有 `scene.pkg` 里）与 Application 无法在浏览器渲染，渲染端会退化为静态预览图。
- **安全模型**：
  - `media` / `preview`：token = base64url(绝对路径)，**逐文件白名单**，仅 inventory 枚举过的文件可被服务。
  - `web`：静态站点的相对引用无法靠单文件白名单满足，因此收敛为**逐目录白名单 + 路径归一化校验**——token 只能是 inventory 枚举出的 web 壁纸目录；归一化后必须仍在该目录内（否则 403）；`lstat` 只服务普通文件，目录与符号链接一律拒绝。
  - 未注册 token 一律 404，不暴露任意文件系统。
- **缓存**：inventory 结果缓存 5 分钟（LRU），巨型库存重复扫描不阻塞事件循环。前端壁纸库弹窗的「重新扫描」按钮以 `?refresh=1` 强制失效——主人在 Steam 新订阅壁纸后不该被迫等一个 TTL 或重启服务器。
- **开销实测**（136 个创意工坊壁纸）：WE 定位 58 ms（进程内仅首次）、目录枚举 26 ms（冷 fs 缓存）/ 19 ms（暖），堆增量 0.70 MB，其中 `project.json` 属性合计 0.11 MB。`registerRoutes` 只挂路由不做扫描，首次扫描发生在前端请求 inventory 时，因此不拖慢 VCPChat 启动。
- **WE 定位**：Windows 注册表 `HKCU\Software\Valve\Steam` -> `libraryfolders.vdf` 解析 -> 多盘 SteamLibrary 探针，非默认安装路径可用。

## WE API 垫片（`lib/we-api-shim.js`）

web 类型壁纸在 Wallpaper Engine 里运行时，`wallpaper32.exe` 会向页面注入一组私有全局函数。浏览器里这些全是 `undefined`，壁纸脚本直接调用会抛 `TypeError` 导致整页白屏。垫片在入口 HTML 的 `<head>` 之后注入，早于壁纸自身脚本执行：

| WE API | 垫片行为 |
|---|---|
| `wallpaperPropertyListener` | 用 `Object.defineProperty` setter 拦截赋值时机，壁纸刚挂上监听器就回喂 `project.json` 里的 `general.properties`（无需猜时序） |
| `wallpaperRegisterAudioListener` | 128 段全零频谱，15Hz 空转（不喂会让部分壁纸卡在等待态） |
| `wallpaperRegisterMedia*Listener` | 空实现，壁纸走「无播放」分支 |

注入的属性 JSON 会把 `</` 转义成 `<\/`，防止壁纸属性文本里的 `</script>` 提前闭合注入点。

前端侧配套：iframe 在窗口不可见时会被卸载（`removeAttribute('src')`），壁纸的 `requestAnimationFrame` 随文档一起停；回到前台重新挂回同一 URL。因此本插件的目录托管路由会在切窗口时被重复请求，属预期行为。

## 文件结构

```
VCPWEWallpaper/
├── plugin-manifest.json    # service 型清单（entryPoint.type: nodejs）
├── we-wallpaper-service.js # 入口：initialize + registerRoutes 协议
└── lib/
    ├── locate.js           # Steam/WE 定位（注册表 + VDF）
    ├── inventory.js        # 三源枚举 + project.json 分型 + MIME 表
    ├── we-api-shim.js      # WE 私有 JS API 垫片（web 壁纸必需）
    └── media-server.js     # 四条路由 + Range 流式 + 目录托管 + 缓存
```

## 启用方式

1. 在 VCPChat 的插件管理器中启用本插件（需分布式服务器开启）。
2. 重启后访问 `http://127.0.0.1:5974/vcp-we-wallpaper/inventory` 验证。
3. 安装并启用 `VCPWEWallpaperUI` 前端插件即可在聊天窗口选择壁纸。
4. **web 壁纸需要主程序 `main.html` 的 CSP 放通 `frame-src 'self' http://127.0.0.1:5974 http://localhost:5974`**（本仓库已加）。缺这一行时 web 壁纸会被浏览器拦下，渲染端自动降级为静态预览图，其余功能不受影响。

## 测试

```
node tests/vcp-we-wallpaper-service.test.js
```

用真 Express + 本机真实库存跑：inventory 200 / 入口页垫片注入 / 相对资源 MIME 正确 / 编码穿越判 403 / 目录请求 404 / 未注册 token 404 / 垫片 `</script>` 转义。本机未装 WE 或库中无 web 壁纸时相关用例明确跳过，不伪装成通过。

## 已知限制

- **Scene 壁纸无法动态渲染**：内容封在私有二进制 `scene.pkg`（实测 10–22MB/个），需要 WE 自家 3D 引擎。`Almamu/linux-wallpaperengine` 确实实现了 scene 渲染，但那是原生 C++/OpenGL 程序，形态上无法塞进 Electron 渲染进程。渲染端对 scene 一律用自带 `preview.jpg` 静态铺底。
- **音频律动类 web 壁纸会静止**：垫片喂的是全零频谱。接真实频谱需要把主程序的 `AnalyserNode` 数据 `postMessage` 进 iframe，属后续增强。
- **依赖外网 CDN 的 web 壁纸可能白屏**：实测库中有壁纸引用 `fonts.googleapis.com` 和已下线的 `html5shiv.googlecode.com`。渲染端有 8 秒载入超时保护，超时自动降级为静态预览图。
- **依赖正在播放媒体信息的壁纸**显示「无播放」。
- 播放列表轮转为 v1.1 规划（当前 `playlists` 字段为占位空数组）；渲染端的轮播基于过滤范围而非 WE 播放列表。

## 致谢

核心定位/枚举/流式逻辑移植自 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（MIT）。该项目的渲染端会为 web 壁纸创建 iframe，但服务端只有单文件 `media`/`preview` 路由，没有目录托管也没有 API 垫片——本插件的目录子树托管与垫片是新增实现。
