# UI Harness 外部发布证据清单

本清单用于补齐 A4/A6 中不能在当前 macOS 工作区伪造的证据。它不改变运行时协议，也不把用户未提交的 `styles/themes.css` 纳入验证提交。

## Windows 实机

在干净检出、与待验远程分支相同的 commit 上执行：

```powershell
npm ci
npm run check:ui-harness-evidence
npm run test:electron-ui-apps
npm run test:electron-main-chat-sequences
npm run test:electron-lifecycle-stress
```

分别以 100%、125%、150% 系统缩放启动应用，记录：

- 主窗口和设置窗口是否可见，是否出现横向溢出；
- 顶栏、动态标签、托盘、Ask Nova、创建助手和聊天输入是否可用；
- 深浅主题连续切换后的响应时间、最终主题 class 和 Web Awesome theme owner；
- Windows GPU/透明材质开启与关闭时的错误日志和视觉差异。

## Packaged launch

使用签名或受信任桌面环境生成安装/portable 产物，在真实桌面双击启动，不使用开发目录 Electron 代替。启动后保存以下证据：

- `app.asar` 与 Web Awesome vendor closure 检查结果；
- renderer readiness、启动主题门释放和 canonical 主 Surface 可见；
- Notes/Translator 内嵌页面、应用标签恢复和外部窗口回退；
- 应用退出后没有残留 renderer、WebContentsView 或孤儿进程。

## 人工 soak（30–60 分钟）

固定执行以下序列至少三轮：

1. 打开设置、搜索分类、修改外观、保存、重新打开；
2. 连续切换主题和窗口缩放；
3. 打开/切换/关闭 Notes、Translator 及一个独立窗口应用；
4. 打开 Ask Nova，发送、取消、关闭并再次打开；
5. 创建助手/群组，模拟模型请求延迟后关闭或切换页面；
6. reload 一次主窗口，再恢复标签和聊天状态。

每轮结束检查 listener、LifecycleScope、受管资源、WebContentsView、renderer process、detached DOM 和错误日志。任何指标持续增长、主窗口消失、Escape 级联关闭或迟到结果污染新 Surface，都算失败并保留最小复现序列。

## 证据归档规则

- 记录 commit、平台、Electron 版本、DPI、窗口尺寸、GPU 状态和时间戳；
- 自动门禁通过不替代 Windows/packaged/manual 证据；
- 没有真实外部运行结果时，路线状态保持“进行中”，不得标记 A4/A6 退出。
