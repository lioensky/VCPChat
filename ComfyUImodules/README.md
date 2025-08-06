# ComfyUI 图像生成 · 前端简明使用说明

面向普通用户的极简指南，仅保留必要信息。

一、3 步开始
1) 打开面板：右上角点击“AI图”。
2) 测试连接：在“连接设置”填 http://localhost:8188，点“测试连接”。
3) 保存生效：在“生成参数/提示词配置”完成选择后，点击右下角“保存配置”。

二、最少需要知道的设置
- 工作流：选择一个可用模板（如 text2img_basic）。
- 模型与尺寸：模型、宽/高；步数和 CFG 影响质量与耗时。
- 种子：填 -1 表示随机；固定非 -1 可复现。
- 提示词与 LoRA：在“提示词配置”里填写质量增强词/负面词，添加需要的 LoRA 并设置强度。

三、LoRA 使用说明
1) 组合 LoRA 的推荐方式
- 工作流中应包含“weilin-comfyui-prompt-all-in-one”节点（界面显示名称可能为“WeiLinComfyUIPromptToLoras”）。
- 只有当该节点存在时，设置中的 LoRA 列表才会被自动组合注入，实现多 LoRA 叠加。

2) 如果工作流没有该节点，如何处理设置里的 LoRA？
- 默认行为：不会强行插入或改写工作流；设置中的 LoRA 信息将被忽略（不注入），以避免破坏现有流程。
- 可选方案：
  a) 在工作流中加入上述节点并接入提示词/处理链路；
  b) 或在提示词里手写 LoRA token（例如 <lora:name:strength:clipStrength>），此时不依赖该节点，但需自行维护提示词格式。

四、让节点“不要被替换”
在 ComfyUI 节点标题加入以下任一关键字（不区分大小写），该节点将跳过自动替换：
- 英文：no / not / none / skip / hold / keep
- 中文：别动 / 不替换 / 保持 / 跳过 / 保留
示例：标题写成“保持_我的节点”即可避免被替换。

附注：
- 连线引用（如 ["4", 1]）本来就不会被替换。
- 未在白名单内的罕见节点类型默认不替换。
- 某些已知类型（如 SaveImage）默认不替换。

五、导入工作流（可选）
- 在“导入工作流”粘贴 ComfyUI 的 “Save (API Format)” JSON → “验证格式” → “转换并保存”。

六、常见问题（速查）
- 连接失败：确认 ComfyUI 已启动、地址端口正确；必要时填 API Key；检查防火墙/代理。
- 列表为空：先成功“测试连接”，并确认 ComfyUI 侧已安装资源。
- 保存后无变化：通常会自动更新；若没有，关闭后重新打开面板。

七、无需打开面板（可选）
直接编辑配置文件并保存：
- 路径：[@/VCPToolBox/Plugin/ComfyUIGen/comfyui-settings.json](VCPToolBox/Plugin/ComfyUIGen/comfyui-settings.json:1)
更多后端细节：[@/VCPToolBox/Plugin/ComfyUIGen/docs/README_PLUGIN_CN.md](VCPToolBox/Plugin/ComfyUIGen/docs/README_PLUGIN_CN.md:1)