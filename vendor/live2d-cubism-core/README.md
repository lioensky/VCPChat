# Live2D Cubism Core

桌宠的 Live2D 形象需要 Live2D 官方的 Cubism Core（`live2dcubismcore.min.js`，必须是 5.x）。它是 Live2D Inc. 的专有组件，不进入本仓库：

- 桌宠在 `modules/deskpet/feature.json` 的 `scripts` 里声明了 `scripts/deskpet/fetch-cubism-core.cjs`：`npm install` 时由 `scripts/app-features.cjs install` 运行，从 Live2D 官网下载到这个目录；
- `npm run pack` / `npm run dist` 打包前由 `scripts/app-features.cjs package` 再运行一次（`--strict`，下载不到就停止打包），发布的安装包随应用附带它；
- 离线安装或设置了 `VCPCHAT_SKIP_CUBISM_CORE=1` 时这里是空的，Live2D 桌宠先用立绘，可以之后在设置「桌宠 → Live2D 支持」里一键启用。

用户在设置页装的 Core（数据目录 `AppData/deskpet/`）优先于这里的。

## 许可

Live2D Cubism Core 的著作权属于 Live2D Inc.，按 [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) 使用和随应用分发。使用 VCPChat 的 Live2D 形象即表示同意该协议。Cubism Core 不在 VCPChat 自身的开源许可范围内，不能单独再分发。
