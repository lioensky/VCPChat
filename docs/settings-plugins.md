# 设置 → 插件与工具

主聊天的插件入口打开此设置分区，沿用现有设置壳和 DSH 控件样式。

## 功能

- 界面插件：搜索、启停及 Manifest 配置表单；显示加载器的真实加载结果。
- 本机工具：搜索、启停及配置；运行状态取自本机插件与服务模块，节点连接在工具栏集中显示。
- 后端插件：使用当前 VCPToolBox 管理端账号连接，读取注册清单并通过已有管理 API 启停和保存配置。分布式条目只读。

正常卡片省略重复状态标记，由开关表示启停。异常、未加载、状态未知、待重启、只读仍有短标记；完整运行事实可在详情和无障碍描述中读取。后端“已注册”只表示注册，不证明一次工具调用健康或浏览器已连接。

## 配置行为

本机启停与配置在重启 VCPChat 后生效，不打断当前聊天。后端由现有管理 API 重新加载插件。布尔/枚举使用共享选择器；数字遵守类型和范围；密钥遮挡，多行内容保留换行。

已有 `plugin-config.json` 时编辑该 JSON 文件，否则使用 `config.env`。未知键和注释保留。Manifest 与原始配置位于“高级配置”；后端 Manifest 只读。本机 Manifest 不能改变插件标识或分类。

插件配置独立显式保存，不进入全局设置自动保存。切换分类、搜索、刷新及本次应用会话内关闭重开设置保留草稿。保存与启停校验 revision，阻止覆盖其他窗口的修改；后端 revision 同时绑定服务器 origin。干净表单刷新读取最新配置，“放弃更改”读取成功后才替换草稿。插件移除时保留草稿供复制，并阻止保存。

## 接口与边界

插件 IPC 只接受应用真实主窗口顶层 frame。插件目录和配置拒绝越界路径、目录链接与符号链接，支持正常 Unicode 文件夹。

后端凭据只保留在主进程应用会话，导航、关闭、断开及服务器 origin 改变时清除；请求禁止跳转，超时 12 秒。管理地址采用服务器 origin 的根路径，尚不支持额外反向代理路径前缀。聊天 API key 不能代替管理端账号密码。

复用现有 UIUX 按钮、开关、门户选择器和生命周期所有者；样式通过 `settings.css` 导入，不修改生成的 UIUX 文件。DSH 样式参考固定源码 `639ed015`：正常启用项不显示状态标记、空描述不占位、线形展开箭头、36px/12px 按钮、36×20px 开关及明暗主题语义色。未做完整 DSH 应用像素 A/B。

## 验证

```powershell
npm run test:settings-plugins
node --test tests/settings-schema-render.test.mjs tests/global-settings-save.test.mjs tests/settings-autosave-coordinator.test.mjs tests/preload-registry.test.js tests/frontend-plugins.test.js tests/uiux-settings-bridge-modules.test.mjs tests/uiux-settings-css-parts.test.mjs tests/uiux-primitives.test.mjs
npm run check:ui-system
```

真实 Electron 验证使用隔离插件实际改清单、写配置、制造外部修改冲突并恢复草稿，结束后清理。真实 VCPToolBox 验证管理端登录与清单读取；后端写操作通过匹配现有 API 的模拟服务验证，未停用真实后端插件。检查明暗主题、窄窗口、键盘展开、选择器、搜索和主聊天插件入口。
