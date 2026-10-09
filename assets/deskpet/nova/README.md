# 内置 Nova

三套形象共用一个 Agent，通过桌宠「换装」选择，ID 分别为 `builtin:nova-tech`、`builtin:nova-maid`、`builtin:nova-chibi`。仅从应用目录读取。用户模型继续放在自己的 `Agents/<id>/deskpet/`，选择记录仍由现有 `deskpet/state.json` 管理。

每套包含 Cubism `.moc3`、`model3.json`、2048 贴图、物理配置、Idle/Blink/Nod/Shake 动作，以及七套基础参数表情，映射到系统十二个情绪。口型、呼吸、视线和互动使用现有桌宠运行时。Q 版另附十二情绪和状态立绘，作为无 Core 时的回退。

美术来自本次 Nova 制作：科技服全身、修正颈部阴影的女仆全身、清理刘海和眼周残影的简洁 Q 版。源图、拆层 PSD 和动作差分由独立美术包保存，运行资源不包含编辑器工程。初版使用 PSD2Live 自动绑定，适合功能验证；后续可在 Cubism 编辑器里细化闭眼形状、嘴型与肢体动作。

本目录不含 `live2dcubismcore.min.js`。运行时沿用应用数据目录中已配置的 Core 5.x；缺少运行库或显卡不可用时回退到本套立绘。不要把第三方 Core 或示例模型混入本目录。

## Q 版（chibi）第二版

Q 版已改为模型自带的表情与手势，不再只是立绘差分：

- 表情 11 套（`expressions/`）：Neutral、Happy、Shy、Sad、Angry、Surprised、Tired，新增 Stars（星星眼）、Wink、Smug、Speechless。`deskpet.json` 的 `expressions` 把十二个情绪全部映射到这些表情（calm 与 neutral 共用 Neutral，睡眠走 tired → Tired）。
- 手势 8 个（新增 motion3）：Wave、Salute、Heart、Tea、Typing、Shrug、Akimbo、Cheer，加上原有的 Nod、Shake。`deskpet.json` 的 `motions` 和生活动作（摸头、打哈欠、伸懒腰、哼歌、醒来、落地等）都映射到这些动作。
- 闭眼：EyeOpen 降到 0.3 以下时，眼线保持弯成眼皮的形状，眼白（带青色虹膜）在 0.45→0.3 之间淡出；每一套表情的眼睛都这样处理（Stars 没有眼线，闭眼时借用中性眼皮），所以任何表情下眨眼、闭眼和睡觉都只剩深色眼皮弧线，不露青色。
- 口型：表情自带的嘴没有张开状态。MouthOpenY 超过 0.1 时表情嘴淡出、中性说话嘴淡入（0.3 时完全切换），所以任何表情下说话都会动嘴；表情的 MouthForm 仍然作用在说话嘴上。
- 绘制顺序：前发在 AngleX 每个关键帧（含 0）都画在脸和眼睛之上，转头时眉形碎片不会透出来。
- 贴图后处理（`fix_chibi_backhair.py`，导出后执行）：清掉后发两侧和头顶的修补残影（歪头时会露出来），两侧保持不透明（之前的渐隐会在身体和侧发之间透出一条半透明竖带）、把中性眼线和闭嘴线加粗 2 px、去掉眼线内圈的青色抗锯齿边，以及头饰图层底边的两个眉尖碎点。

已知未修：眼珠移动幅度很小（D9）、身体转角幅度小（D10）、鞋子接缝（D11）、歪头 ±4° 时内侧头发偶尔有一条很淡的细线（D12 残留）、手势开始和结束时手臂是瞬间切换的（交叉淡化会出现两双手臂，所以保留瞬切）。
