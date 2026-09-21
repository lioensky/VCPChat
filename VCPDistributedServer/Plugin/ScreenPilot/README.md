# ScreenPilot 2.x

ScreenPilot 是运行在每个 VCP 分布式 Windows 设备上的 Computer Use 插件。

## 兼容性承诺

以下旧命令、参数别名和成功返回主体继续兼容：

- `ScreenCapture`
- `ClickAt`
- `ClickText`
- `ClickVisual`
- `InspectUI`
- `ScrollAt`
- `TypeText`
- `QueryWindows`

尤其是 `ScreenCapture` 继续返回：

- `content`
- `resolution`
- `windowRect`
- `savedPath`
- `ocrResults`
- `captureMethod`
- `processName`

2.x 只追加 `captureRect`、`captureBackend` 等字段，不删除或重命名旧字段。

原来的单次 Python stdio 入口仍然可直接运行：

```text
echo {"command":"ScreenCapture"} | python screen_pilot.py
```

插件清单默认使用 `hybridservice/direct`，由 Node.js 常驻协调器管理 Python Worker。

## 运行架构

```text
VCP PluginManager
    │ direct processToolCall
    ▼
ScreenPilotService.js
    │ JSONL over stdio
    ▼
screen_pilot.py --worker
    ├── screenpilot_core/windows.py
    ├── screenpilot_core/geometry.py
    ├── screenpilot_core/ocr.py
    ├── screenpilot_core/uia.py
    ├── screenpilot_core/image_edit.py
    ├── screenpilot_core/interaction.py
    └── screenpilot_core/errors.py
```

### Node.js 常驻协调器负责

- Worker 生命周期。
- 工具请求串行化。
- 请求 ID 与响应关联。
- 超时后终止并重建 Worker。
- 只读命令失败后的安全重试。
- 服务关闭时清理 Worker。
- 保持 direct 插件返回主体与旧同步插件解包后的 `result` 一致。

动作命令不会自动重放，避免双击、重复输入或重复提交。

### Python Worker 负责

- Win32 窗口枚举与输入。
- GDI、DXGI Desktop Duplication 与虚拟桌面裁剪截图。
- RapidOCR 常驻引擎。
- Windows UI Automation。
- UIA 元素短期引用。
- 图生图局部编辑定位。
- 坐标空间换算。
- `Interact`、等待和验证流程。

## 感知与动作通道

`Interact` 默认按以下顺序降级：

1. `uia`
2. `ocr`
3. `image_edit`

### UIA

适用于标准 Win32、WinForms、WPF、UWP/WinUI 和正确暴露无障碍树的应用。

支持原生 Pattern：

- InvokePattern
- ValuePattern
- TogglePattern
- SelectionItemPattern
- ExpandCollapsePattern
- LegacyIAccessiblePattern
- SetFocus

### OCR

使用常驻 RapidOCR 引擎识别文本和中心坐标。常驻 Worker 避免每次请求重复初始化 OCR 模型。

### image_edit

这是图生图模型的局部编辑定位，不是普通视觉模型坐标输出。

流程保持为：

1. 截取原始界面。
2. 要求图生图模型只在目标中心绘制白色标记。
3. 对原图和编辑图进行像素差分。
4. 使用白色像素密度峰值计算目标中心。
5. 将图像坐标换算为物理屏幕坐标。

该通道适用于游戏、自绘 UI、无文字图标等 UIA/OCR 无法识别的目标。

## 坐标空间

新增数据会显式携带 `space`：

- `screenPhysical`：Windows 虚拟桌面物理像素坐标。
- `imagePixel`：截图图像内部像素坐标。

`windowRect` 表示原始窗口矩形；`captureRect` 表示返回图像实际对应的屏幕区域。

窗口部分移出屏幕时，两者可能不同。OCR 和图生图定位必须以 `captureRect` 为坐标原点。

插件支持位于主屏左侧或上方的副屏，因此合法物理屏幕坐标可以为负数。

## 新命令

### UIAction

直接通过 UIA Pattern 操作控件：

```json
{
  "command": "UIAction",
  "windowTitle": "记事本",
  "automationId": "SaveButton",
  "controlType": "Button",
  "action": "invoke"
}
```

也可使用 `InspectUI` 返回的短期 `elementId`。

### Interact

统一定位、动作和验证：

```json
{
  "command": "Interact",
  "windowTitle": "安装程序",
  "name": "下一步",
  "controlType": "Button",
  "text": "下一步",
  "description": "安装程序底部的下一步按钮",
  "action": "click",
  "channels": "uia,ocr,image_edit",
  "verifyText": "安装位置",
  "verifyTimeoutMs": 8000
}
```

### WaitForElement

等待 UIA 元素出现或消失：

```json
{
  "command": "WaitForElement",
  "processName": "notepad.exe",
  "name": "保存",
  "controlType": "Button",
  "condition": "appear",
  "timeoutMs": 10000
}
```

### WaitForText

周期截图并等待 OCR 文本：

```json
{
  "command": "WaitForText",
  "text": "保存成功",
  "condition": "appear",
  "timeoutMs": 8000
}
```

## 依赖

安装插件依赖：

```text
python -m pip install -r requirements.txt
```

其中 `dxcam` 提供真正的 DXGI Desktop Duplication。主显示器内的硬件加速窗口 fallback 会优先使用该后端；跨显示器、负坐标区域或 DXGI 初始化失败时自动回退 Pillow `ImageGrab(all_screens=True)`，并通过 `captureBackend` 报告真实后端。

## 测试

纯函数与无桌面副作用测试：

```text
python -m unittest discover -s tests -p "test_*.py" -v
```

静态检查：

```text
python -m py_compile screen_pilot.py screenpilot_core\*.py
node --check ScreenPilotService.js
```

真实桌面集成测试应额外覆盖：

- 主屏和负坐标副屏。
- 不同 DPI。
- 窗口部分移出屏幕。
- Win32、WPF、Electron、自绘 UI。
- UIA Provider 卡顿。
- GDI 黑屏 fallback。
- 图生图标记差分。
- UIA 动作后的状态验证。