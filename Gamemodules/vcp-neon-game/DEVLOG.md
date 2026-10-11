# VCP Neon Runtime Survivor 开发文档

更新时间：2026-06-26

## 1. 今日目标

本次开发目标是先不接入官网主站，独立打磨一个可本地运行、可快速迭代的 VCP 主题 neon 弹幕肉鸽 demo。

核心原则：

- 不做局外成长，避免游玩负担。
- 单局目标控制在 3-10 分钟。
- 优先保证快乐、随机性、弹幕爽感和 neon 视觉。
- VCP 概念作为技能梗和机制表达，不做说教式教程。
- 使用独立 HTML + Canvas + 原生 JS 模块，不引入完整游戏引擎。
- 模块拆分清晰，方便后续继续加敌人、技能、buff、融合和表现层。

## 2. 当前文件结构

```text
public/vcp-neon-game/
├── index.html
├── styles.css
├── DEVLOG.md
└── js/
    ├── main.js
    ├── config.js
    ├── utils.js
    ├── entities.js
    ├── weapons.js
    └── game.js

scripts/
└── serve-vcp-neon-game.cjs

start-vcp-neon-game.bat
stop-vcp-neon-game.bat
```

### 2.1 页面入口

- `public/vcp-neon-game/index.html`

负责：

- 游戏 canvas 容器。
- 开始界面。
- 升级三选一界面。
- 死亡结算界面。
- HUD。
- Nova 吐槽占位。

### 2.2 样式

- `public/vcp-neon-game/styles.css`

负责：

- Neon 背景。
- HUD 样式。
- 升级卡片。
- 开始/结束弹窗。
- Nova 小头像。
- 全屏 canvas 布局。

### 2.3 配置

- `public/vcp-neon-game/js/config.js`

负责：

- 全局颜色。
- 玩家基础数值。
- 经验成长。
- 难度时间参数。
- Nova 文案。
- 10 个技能配置。
- 5 个融合技能配置。
- 3 个 buff 配置。
- 普通敌人配置。
- 精英怪配置。

### 2.4 工具函数

- `public/vcp-neon-game/js/utils.js`

负责：

- 随机数。
- 向量/角度。
- 距离。
- 碰撞。
- 颜色绘制辅助。
- 时间格式化。
- 权重随机。

### 2.5 实体系统

- `public/vcp-neon-game/js/entities.js`

负责：

- 玩家 Player。
- 子弹 Bullet。
- 敌人 Enemy。
- 经验 XpGem。
- BuffDrop。
- ParticleSystem。
- 敌人生成与掉落逻辑。

### 2.6 武器系统

- `public/vcp-neon-game/js/weapons.js`

负责：

- 10 个普通技能的更新逻辑。
- 5 个融合技能的更新逻辑。
- 升级三选一候选生成。
- 激光、冲击波、抓取臂、未来轰炸等临时攻击体。
- AgentAssistant 僚机视觉和开火。
- 池月 1 号标记逻辑。

### 2.7 游戏主循环

- `public/vcp-neon-game/js/game.js`

负责：

- Game 主类。
- UI 类。
- 输入监听。
- 游戏状态。
- 时间难度成长。
- 敌人刷怪。
- 碰撞结算。
- 经验收集。
- 升级暂停。
- 死亡结算。
- 背景绘制。

### 2.8 启动与关闭脚本

- `scripts/serve-vcp-neon-game.cjs`
- `start-vcp-neon-game.bat`
- `stop-vcp-neon-game.bat`

独立静态服务器运行在：

```text
http://127.0.0.1:3017/vcp-neon-game/index.html
```

不使用 Vite dev server，避免被官网 SPA 路由接管。

## 3. 启动和关闭方式

### 3.1 启动游戏

双击：

```text
start-vcp-neon-game.bat
```

效果：

- 启动独立 Node 静态服务器。
- 自动打开游戏页面。
- 保留服务器窗口。
- 可通过 Ctrl+C 关闭。

访问地址：

```text
http://127.0.0.1:3017/vcp-neon-game/index.html
```

### 3.2 关闭服务器

推荐双击：

```text
stop-vcp-neon-game.bat
```

作用：

- 查找监听 3017 端口的进程。
- 自动 taskkill 关闭服务器。

也可以在服务器窗口按：

```text
Ctrl+C
```

## 4. 今日完成的核心玩法

### 4.1 基础玩法

已实现：

- 玩家移动。
- 鼠标方向辅助瞄准。
- 自动射击。
- 敌人从屏幕边缘刷出。
- 敌人随时间成长。
- 敌方弹幕。
- 冲锋敌人。
- 分裂敌人。
- 精英怪。
- 经验掉落。
- 升级三选一。
- Buff 掉落。
- 死亡结算。
- 暂停。
- Nova 吐槽占位。

### 4.2 局内成长

当前设计没有局外成长。

局内成长方式：

- 击杀敌人获得经验。
- 升级时三选一。
- 技能最高 5 级。
- 满足条件后出现融合技能。
- Buff 是临时爽点，不带出本局。

### 4.3 时间难度成长

目前难度随时间线性增强：

- 刷怪频率提升。
- 敌人速度提升。
- 敌人血量提升。
- 敌方弹幕频率提升。
- 精英怪按间隔出现。

设计目标是让 3 分钟内能快速进入构筑状态，5 分钟后明显压迫，10 分钟后进入接近无限模式的霓虹地狱。

## 5. 技能系统

### 5.1 当前 10 个普通技能

| ID | 名称 | 定位 |
|---|---|---|
| vexus | Vexus / 向量裂针 | 高频直线主炮 |
| wave | 浪潮 V8 / 语义涟漪 | 环形 AOE |
| onering | OneRing / 统一轨道 | 环绕护体 |
| model | VCPModel / 语义路由炮 | 智能追踪 |
| assistant | AgentAssistant / 异步僚机 | 召唤僚机 |
| mail | VCPSuperMail / 邮件导弹 | 延迟爆破 |
| chrome | ChromeBridge / 页面切割 | 扫描激光 |
| openher | OpenHer / 情绪棱镜 | 血量变式弹幕 |
| som | VCP-SOM / 桌面抓取臂 | 控制爆破 |
| chiyue | 池月 1 号 / 注意力指针 | 标记增伤 |

### 5.2 当前 5 个融合技能

| 融合 | 条件 | 效果 |
|---|---|---|
| 测地线洪流 | Vexus + 浪潮 V8 | 链式跳跃弹 |
| 单一灵魂护城河 | OneRing + 浪潮 V8 | 大型环形护城河 |
| 多模型蜂群调度 | VCPModel + AgentAssistant | 多僚机蜂群火力 |
| 未来邮差轰炸链 | VCPSuperMail + ChromeBridge | 延迟轰炸圈 |
| 情绪注意力坍缩 | OpenHer + 池月 1 号 | 标记敌人坍缩伤害 |

## 6. 今日重点调优记录

### 6.1 弹幕颜色辨识性

根据反馈完成色彩分层：

- 玩家攻击：蓝色系。
  - 青蓝。
  - 天蓝。
  - 冰蓝。
  - 深蓝。
- 敌方攻击：红色系。
  - 红。
  - 橙红。
  - 粉红。
  - 深红。
- Buff 掉落：黄色系。
- 经验掉落：绿色系。
- 标记敌人：红橙色系。

这样能避免玩家误把敌弹、经验、buff、标记效果混在一起。

### 6.2 AgentAssistant 僚机视觉

根据反馈，AgentAssistant 原先只有子弹，没有明显跟随小飞机。

已新增：

- 可见小型僚机。
- 僚机围绕玩家飞行。
- 僚机自动朝目标转向。
- 僚机从自身位置开火。
- 融合蜂群时显示 4 架不同蓝色系僚机。
- 后续又缩小了僚机体积，避免遮挡玩家和弹幕。

当前僚机视觉位于：

```text
public/vcp-neon-game/js/weapons.js
```

主要方法：

```text
updateAssistantDrones()
drawAssistantDrones()
```

### 6.3 池月 1 号标记系统

根据反馈，标记系统做了增强。

当前机制：

- 标记间隔随等级降低。
- 标记数量随等级提升。
- 被标记敌人受到额外伤害。
- 被标记敌人有明显环形视觉。
- 标记敌人死亡后，标记会自动转移到附近未标记敌人。
- 高等级时可转移给更多目标。
- 标记颜色已从黄色改为红橙色，避免和 buff 掉落混淆。

当前标记逻辑位置：

```text
public/vcp-neon-game/js/weapons.js
public/vcp-neon-game/js/entities.js
public/vcp-neon-game/js/game.js
```

关键方法：

```text
update_chiyue()
applyMark()
onEnemyKilled()
Enemy.draw()
```

## 7. 当前 Buff 设计

| Buff | 色彩 | 效果 |
|---|---|---|
| VCPDynamicTools / 工具过载 | 黄色系 | 射速提升，附带额外小弹 |
| ContextFoldingV2 / 折叠护盾 | 黄色系 | 护盾吞敌弹，转成经验 |
| FlowInvite / 自主心跳 | 黄色系 | 速度与节奏增强，支援火力 |

Buff 掉落统一保持黄色系。

## 8. 当前敌人设计

普通敌人：

- Token Mosquito：基础小怪。
- Prompt Drone：直线弹幕敌。
- Context Shard：死亡分裂。
- While Loop Charger：冲锋敌。
- Hallucination Eye：环形弹幕敌。

精英怪：

- SystemPromptHacker。
- RAG Kraken。
- Context Overflow Seraph。

## 9. 今日验证情况

已完成：

- 独立服务器启动成功。
- 游戏可通过 3017 端口访问。
- Vite 3000 端口误打开官网的问题已绕开。
- 新增关闭脚本。
- JS 模块曾做过 node --check 检查并通过。
- 后续少量颜色和视觉微调未重新完整跑构建，但改动集中在颜色常量和 Canvas 绘制参数，风险较低。

## 10. 后续待打磨方向

### 10.1 玩法手感

- 进一步调整敌人密度曲线。
- 调整前 2 分钟升级速度，让玩家更快拿到构筑爽点。
- 调整 5 分钟后的弹幕压力。
- 给精英怪增加更明确的入场提示。
- 死亡前增加低血量屏幕边缘警告。

### 10.2 视觉表现

- 玩家技能可以增加更独特的技能释放图形。
- 融合技能出现时可以增加短暂停顿和大字提示。
- Buff 掉落可以加更明显的旋转光柱。
- 经验晶体可以区分小中大三档。
- 敌弹可以加外描边，进一步提升可读性。

### 10.3 音效

建议后续增加轻量音效：

- 开火。
- 击中。
- 捡经验。
- 升级。
- 选择技能。
- 精英出现。
- 融合触发。
- 死亡。

不建议一开始上复杂 BGM 系统，先用少量 WebAudio 合成音即可。

### 10.4 Nova 二期/已落地

当前 Nova 是静态吐槽占位。

后续可以根据事件触发：

- 低血量吐槽。
- 连续升级吐槽。
- 精英出现吐槽。
- 选择某些技能组合时吐槽。
- 死亡原因吐槽。
- 高击杀夸奖。
- 长时间存活后进入加班模式吐槽。

### 10.5 排行榜二期

当前先不做排行榜和局外成长。

如果做二期，建议只做：

- 本地最高分。
- 本地最长存活。
- 本地最高击杀。
- 可选在线榜。

不要加入永久属性成长，保持纯粹局内肉鸽。

## 11. 设计约束记录

确认过的设计倾向：

- 不做局外成长。
- 不给玩家额外负担。
- 游戏第一目标是快乐。
- VCP 梗是皮肤和机制灵感，不是强制教学。
- 官网小游戏应轻量、即开即玩。
- HTML + Canvas 足够，不上重型游戏引擎。
- 模块化便于扩展。
- 颜色语义必须清晰：
  - 蓝 = 玩家火力。
  - 红 = 敌方危险。
  - 黄 = buff。
  - 绿 = 经验。
  - 红橙 = 标记敌人。

## 12. 快速命令备忘

启动：

```bat
start-vcp-neon-game.bat
```

关闭：

```bat
stop-vcp-neon-game.bat
```

直接启动静态服务器：

```bat
node scripts\serve-vcp-neon-game.cjs
```

访问：

```text
http://127.0.0.1:3017/vcp-neon-game/index.html

---

## 13. 追加记录：8bit BGM 与音效系统

更新时间：2026-06-26

本轮追加落地了轻量级 8bit 音频系统，目标是让 demo 在不引入音频资源、不增加构建负担的前提下，获得清爽的街机反馈。

### 13.1 新增文件

```text
public/vcp-neon-game/js/audio.js
```

该文件实现了 `AudioSystem`，基于 WebAudio API 合成声音。

不依赖外部音频文件，不需要 mp3、ogg、wav，也不需要额外库。

### 13.2 当前音频实现方式

当前音频系统使用：

- `AudioContext`
- `OscillatorNode`
- `GainNode`
- `BiquadFilterNode`
- 程序化 noise buffer

主要声音来源：

- `square` 波：8bit 主音色。
- `triangle` 波：柔和高音和琶音。
- `sawtooth` 波：受击、低频警告。
- noise：简单鼓点、噪声打击感。

### 13.3 BGM 设计

BGM 是程序化循环，不加载文件。

当前结构：

- 132 BPM。
- 16/32 step 循环。
- bass line 使用低频方波。
- lead line 使用方波 + 轻微高八度叠加。
- arp 使用 triangle 波做轻量琶音。
- 简单 noise 鼓点模拟 8bit 节奏。

整体目标：

- 清爽。
- 不抢弹幕注意力。
- 有街机感。
- 可长期循环，不要太吵。

### 13.4 音效事件

目前已接入的音效事件：

| 事件 | 音效 |
|---|---|
| 开始游戏 | level 启动音 |
| 玩家开火 | shoot |
| 击中敌人 | hit |
| 吃经验 | xp |
| 升级 | level |
| 吃 buff | buff |
| 精英怪出现 | elite |
| 触发融合 | fusion |
| 玩家受击 | hurt |
| 死亡 | dead |

接入位置主要在：

```text
public/vcp-neon-game/js/game.js
public/vcp-neon-game/js/weapons.js
public/vcp-neon-game/js/main.js
```

### 13.5 声音开关

开始界面新增了声音开关按钮：

```text
声音 ON / 声音 OFF
```

按钮位于：

```text
public/vcp-neon-game/index.html
```

对应样式位于：

```text
public/vcp-neon-game/styles.css
```

逻辑位于：

```text
public/vcp-neon-game/js/main.js
```

当前按钮切换的是总声音开关：

```text
audio.toggleAll()
```

### 13.6 浏览器限制说明

WebAudio 在现代浏览器中通常要求用户手势后才能播放声音。

因此当前设计为：

- 页面初始不会自动播放 BGM。
- 点击“启动 Runtime”后调用 `audio.start()`。
- 这符合浏览器 autoplay policy。
- 声音按钮也属于用户手势，可以恢复或关闭音频。

### 13.7 当前验证结果

用户本地测试反馈：

```text
测试 OK
```

说明：

- 游戏能正常运行。
- BGM 和音效可播放。
- 声音开关可用。
- 当前落地方案满足一期 demo 需求。

### 13.8 后续音频优化方向

后续可继续增强：

- 增加低血量滤波效果。
- 精英怪出现时临时压低 BGM。
- 融合技能触发时加入短暂上升音阶。
- 不同武器使用不同发射音色，但需要限频，避免太吵。
- 增加本地音量分离：
  - BGM 音量。
  - SFX 音量。
- 增加静音状态保存到 `localStorage`。
- 若未来需要更完整的 8bit 作曲，可接入小型 tracker 数据结构，但一期暂时不需要。

### 13.9 设计结论

这次音频实现证明：当前 demo 完全可以不引入音频资源和游戏引擎，仅靠 WebAudio 程序化合成就能获得足够清爽的 8bit 游戏反馈。

这个方案非常适合官网小游戏：

- 体积小。
- 加载快。
- 无版权风险。
- 易于动态响应游戏事件。
- 后续可继续代码级调音。

---

## 14. 追加记录：移动端方案 A 单摇杆控制

更新时间：2026-06-26

本轮根据手机用户反馈，落地了移动端一期控制方案，目标是让手机用户不需要键盘也能即开即玩。

### 14.1 设计结论

采用方案 A：

- 横屏优先。
- 左下角虚拟摇杆控制移动。
- 保留自动瞄准和自动射击。
- 不默认启用双摇杆。
- 不采用“按住飞机拖动”作为主交互，避免手指遮挡玩家和敌弹。

### 14.2 移动控制开关

开始界面新增：

```text
移动控制 自动 / 开 / 关
```

逻辑：

- 自动：默认模式，根据触屏能力和屏幕尺寸自动启用移动端控制。
- 开：强制显示虚拟摇杆，方便手机、平板或 DevTools 测试。
- 关：强制关闭虚拟摇杆，适合触屏笔记本或外接键鼠用户。

用户选择会保存到：

```text
localStorage["vcp-neon-mobile-controls"]
```

### 14.3 自动检测规则

自动模式下启用条件：

- 设备支持 touch 或 coarse pointer。
- 屏幕短边不大于 820px。

这样可以覆盖大多数手机横屏/竖屏场景，同时降低误伤桌面端的概率。

### 14.4 新增交互与 UI

涉及文件：

```text
public/vcp-neon-game/index.html
public/vcp-neon-game/styles.css
public/vcp-neon-game/js/main.js
public/vcp-neon-game/js/game.js
public/vcp-neon-game/js/entities.js
```

新增内容：

- 开始界面增加移动控制按钮。
- 页面底部左侧增加 `#touch-joystick` 虚拟摇杆。
- 竖屏且移动控制启用时显示横屏提示。
- `Game` 内新增移动控制模式切换、自动检测、摇杆 pointer 事件处理。
- `Player.update()` 支持把 `input.touchMove` 合并进移动向量。

### 14.5 当前范围

当前移动端一期只做：

- 左摇杆移动。
- 自动瞄准自动射击。
- 竖屏横屏提示。
- 本地保存控制模式。

暂不做：

- 右摇杆瞄准。
- 主动技能按钮。
- 手机震动反馈。
- 独立移动端难度曲线。

后续如果手机玩家反馈需要更精细瞄准，再追加“横屏双摇杆”作为可选高级模式。

---

## 15. 追加记录：游戏图鉴面板

更新时间：2026-06-26

本轮在开始界面新增了“游戏图鉴”入口，位置在移动控制开关右侧。

### 15.1 新增入口

开始界面按钮区新增：

```text
游戏图鉴
```

涉及文件：

```text
public/vcp-neon-game/index.html
public/vcp-neon-game/styles.css
public/vcp-neon-game/js/main.js
```

### 15.2 图鉴分类

当前图鉴包含四个分页：

- 怪物图鉴
- Buff 推荐
- 技能图鉴
- 融合神器

### 15.3 内容风格

已按游戏整体 Nova 吐槽调性补充文案：

- 怪物图鉴：用诙谐口吻解释为何要击败这些怪物。
- Buff 推荐：说明什么时候拿、为什么爽。
- 技能图鉴：用吐槽方式解释它们在 VCP 系统里的真实作用和游戏化变体。
- 融合神器图鉴：用半技术半胡闹的方式介绍融合技能的构筑意义。

### 15.4 实现方式

图鉴内容直接复用现有配置数据：

```text
ENEMIES
ELITES
BUFFS
WEAPONS
FUSIONS
```

这样后续新增怪物、Buff、技能或融合时，只需要在配置中补充基础数据，再给图鉴文案映射补一条吐槽即可。

### 15.5 交互

当前交互：

- 点击“游戏图鉴”打开图鉴弹窗。
- 点击分类标签切换分页。
- 点击右上角关闭按钮返回开始界面。
- 按 Esc 可关闭图鉴。
- 打开图鉴时 Nova 会给出提示吐槽。

### 15.6 移动端适配

图鉴弹窗已适配小屏：

- 分类按钮自动换行。
- 图鉴卡片在窄屏下变为单列。
- 弹窗内部滚动，避免超出屏幕。
- 横屏手机场景下保持可阅读。

---

## 16. 追加记录：最终开发批次 - 可读性、Boss、小怪、图鉴与 HUD

更新时间：2026-06-26

本轮根据试玩反馈，完成了视觉语义、掉落、敌人内容、Boss 节奏、HUD 和 OneRing 直觉修正。

### 16.1 敌人爆炸粒子语义修正

问题：

- 敌人死亡爆炸原先使用敌人自身红/粉/橙红颜色。
- 敌方弹幕同样使用红色系。
- 玩家容易把死亡粒子误认为敌方攻击弹幕。

调整：

- 敌人受击粒子改为灰白色余烬。
- 敌人死亡爆炸粒子改为灰白色。
- 缩小死亡爆炸粒子数量和传播强度，降低场面混乱度。

涉及位置：

```text
public/vcp-neon-game/js/config.js
public/vcp-neon-game/js/entities.js
public/vcp-neon-game/js/game.js
```

### 16.2 Buff 掉落新增稀有即时效果

新增两个稀有掉落。注意：这里的概率是“已触发总 Buff 掉落之后的内部分布概率”，不是每次击杀额外独立判定。

| Buff | 总 Buff 掉落内部分布 | 效果 |
|---|---:|---|
| RuntimeVersionBump / 版本直升 | 5% | 立即触发一次升级选择 |
| EmergencyRollback / 紧急回滚 | 3% | 回复 30% 最大生命 |

说明：

- 两者属于即时型 buff，不进入持续 buff 列表。
- 常规限时 buff 掉落仍保留原逻辑。
- 命名保持 VCP / Runtime 梗风格。

### 16.3 最终 Boss：API云服务商跑路

新增最终 Boss：

```text
API云服务商跑路
```

刷新节奏：

- 首次：8 分钟。
- 后续：每 8 分钟一次。

定位：

- 长局压力节点。
- 云服务事故、账单暴击、接口 502、SLA 崩坏的梗化实体。
- 攻击方式为大范围云故障环形弹幕 + 面向玩家的高压追踪方向齐射。

涉及位置：

```text
public/vcp-neon-game/js/config.js
public/vcp-neon-game/js/entities.js
public/vcp-neon-game/js/game.js
```

### 16.4 精英怪差异化

原先三个精英怪都使用相近的弹幕生成框架，区分度不够。

本轮调整：

| 精英 | 差异化方向 |
|---|---|
| SystemPromptHacker | 旋转螺旋弹 + 对玩家方向狙击弹，表现“劫持提示词” |
| RAG Kraken | 面向玩家的多段扇形爆发，表现“召回触手” |
| Context Overflow Seraph | 双层环形弹幕，表现“上下文溢出洪水” |

同时绘制层增加不同外环/放射线/双环视觉，让精英形象更容易识别。

### 16.5 新增 meme 小怪

新增三种梗小怪：

| 小怪 | 定位 |
|---|---|
| Prompt Paradox / 提示词悖论 | 慢速高血，发射双向悖论弹 |
| Hallucinated Token Pile / 幻觉累积Token | 慢速胖怪，偏经验包和中型路障 |
| ChunkMiss Gremlin / 网络波动ChunkMiss | 小型抖动移动怪，模拟丢包与网络波动 |

设计约束：

- 不提高整体刷怪频率。
- 只调整随机权重池，让新小怪分摊旧小怪概率。
- 避免难度曲线突然陡增。

### 16.6 怪物图鉴增加样貌预览

怪物图鉴新增 CSS 抽象预览图形：

- 不引入图片资源。
- 普通怪、meme 小怪、精英和最终 Boss 都有不同预览轮廓。
- 图鉴仍复用配置数据生成，便于后续扩展。

涉及位置：

```text
public/vcp-neon-game/js/main.js
public/vcp-neon-game/styles.css
```

### 16.7 HUD 压缩

根据反馈，左上角 HUD 占用视野过大。

调整：

- HUD 整体宽度、padding、圆角和阴影缩小。
- TIME / KILLS / LEVEL 保持单行紧凑显示。
- HP / XP 条压薄。
- 技能胶囊缩小并限制高度，减少遮挡。
- 移动端 HUD 也同步缩小。

涉及位置：

```text
public/vcp-neon-game/styles.css
```

### 16.8 OneRing 增加点防御

反馈：

- OneRing 是卫星/轨道球形式。
- 玩家会直觉认为它应当能挡子弹。
- 原实现只能对敌人造成碰撞伤害，不会拦截敌弹。

调整：

- OneRing 轨道球现在可以撞掉敌方子弹。
- 只做“轨道球点防御”，不是整圈护盾。
- 仍保留 ContextFoldingV2 作为更强的范围吞弹护盾，避免 OneRing 过强。
- 拦截敌弹时有少量蓝色粒子反馈，并有小概率转化少量经验。

涉及位置：

```text
public/vcp-neon-game/js/weapons.js
```

### 16.9 难度与节奏说明

本轮同时将玩家初始最大生命从 100 上调到 108，作为整体难度舒适性补偿。

当前精英与 Boss 大致出现节奏：

- 第 1 个精英：约 00:55。
- 第 2 个精英：约 01:56。
- 第 3 个精英：约 02:54。
- 后续精英间隔逐步从约 64 秒缩短，最低约 34 秒。
- 最终 Boss API云服务商跑路：08:00 / 16:00 / 24:00 ... 每 8 分钟刷新。

### 16.10 验证

本轮改动后执行了 JS 语法检查，首次检查通过。OneRing 点防御追加后仍需再次执行最终语法检查。


### 16.11 满级后保底升级

修复问题：

- 当所有普通技能满级、融合也无可选项时，升级三选一可能没有任何选项，导致升级界面卡住。

调整：

- `getUpgradeChoices()` 在没有武器/融合可选时，返回保底强化。
- 当前保底项：
  - Runtime 耐久扩容：最大 HP +3%，当前 HP 同步小幅补回。
  - 全局火力调参：全局攻击力 +3%，影响所有玩家伤害。
- 攻击力加成记录在 `player.attackBonus`，在敌人受伤结算时统一乘算。

涉及位置：

```text
public/vcp-neon-game/js/entities.js
public/vcp-neon-game/js/game.js
public/vcp-neon-game/js/weapons.js
```

### 16.12 Buff 掉落概率修正

修复问题：

- 早期实现把 RuntimeVersionBump 和 EmergencyRollback 做成“每次击杀额外独立判定”。
- 在高击杀密度下会导致升级/回血掉落远高于预期。

调整为：

- 先按总 Buff 掉落概率判定是否掉落：
  - 普通敌人：3.5%。
  - 精英/Boss：90%。
- 若触发 Buff 掉落，再按内部分布决定类型：
  - RuntimeVersionBump / 版本直升：5%。
  - EmergencyRollback / 紧急回滚：3%，回复 30% 最大生命。
  - 其余 92% 从常规限时 Buff 中随机。


---

## 17. 追加记录：标记满级与渲染架构性能优化

更新时间：2026-06-26

本轮针对“池月 1 号升到 5 级后，大量敌人被标记导致粒子和特效过多、画面明显卡顿”的反馈，完成了一轮 Canvas 渲染压力优化。

### 17.1 问题定位

主要性能热点：

- `applyMark()` 每次标记都会生成较多红橙粒子。
- 标记敌人死亡转移时，转移逻辑额外再次触发一轮粒子，形成重复爆发。
- 大量被标记敌人每帧都会绘制：
  - 高 shadowBlur 环形描边。
  - 虚线旋转环。
  - 3 个带霓虹阴影的轨道点。
- `ParticleSystem.draw()` 原先每个粒子都会调用一次 `fillNeonCircle()`，意味着每个粒子都有独立 `save()` / `restore()` / `shadowBlur` / `arc()`。
- HUD 每帧更新 DOM，在敌人、子弹、粒子数量高时会和 Canvas 绘制竞争主线程。
- 背景每帧重新创建径向渐变，并用霓虹圆绘制星点，有额外绘制成本。

### 17.2 粒子系统优化

涉及位置：

```text
public/vcp-neon-game/js/entities.js
```

调整：

- `ParticleSystem` 增加粒子池上限：
  - `maxItems = 260`
  - `softLimit = 190`
- 当粒子数量超过软上限后，自动减少新爆发粒子数量和力度。
- 接近硬上限时进一步降级，避免粒子数组无限膨胀。
- `update()` 从 `filter()` 改为原地压缩写回，减少高频数组分配。
- `draw()` 改为批量轻量绘制：
  - 单次 `ctx.save()` / `ctx.restore()`。
  - 不再为每个粒子单独开启霓虹阴影。
  - 保留透明度衰减和小圆点视觉。

设计取舍：

- 大爆炸仍然有反馈。
- 高压场景下粒子会自动“省电模式”。
- 牺牲少量霓虹颗粒光晕，换取明显更稳定的帧率。

### 17.3 标记视觉优化

涉及位置：

```text
public/vcp-neon-game/js/entities.js
public/vcp-neon-game/js/weapons.js
public/vcp-neon-game/js/game.js
```

调整：

- `Enemy.draw()` 中的标记视觉改为轻量环形进度描边。
- 普通标记敌人不再绘制 3 个带阴影的轨道点。
- 虚线外环只保留给精英和最终 Boss，普通怪不再绘制。
- 标记环的 `shadowBlur` 降低：
  - 普通怪：低阴影。
  - 精英/Boss：保留更明显但仍较克制的阴影。
- `applyMark()` 根据当前已标记敌人数量动态压缩粒子数量。
- 标记死亡转移时移除重复粒子爆发，只保留 `applyMark()` 内部的统一反馈。
- `fusion_collapse()` 对所有标记敌人的粒子爆发设置总预算，避免满屏标记时一次坍缩生成过多粒子。

效果：

- 池月 1 号高等级标记多个敌人时，标记辨识度仍然保留。
- 大量普通怪被标记时，不再出现“每个怪自带一套高成本光效”的情况。
- 标记转移仍可见，但不会因为连锁击杀瞬间生成粒子洪峰。

### 17.4 主渲染循环优化

涉及位置：

```text
public/vcp-neon-game/js/game.js
```

调整：

- HUD 更新从每帧一次改为约每 0.08 秒一次。
  - 视觉上仍接近实时。
  - 减少 `textContent`、`style.width`、`innerHTML` 的 DOM 写入频率。
- 背景径向渐变增加缓存：
  - resize 时清空缓存。
  - 平时不再每帧重新 `createRadialGradient()`。
- 背景星点从 `fillNeonCircle()` 改为轻量 `fillRect()` 小点。
- 星点数量从 36 降到 28。
- 背景整体霓虹氛围保留，但减少不必要的 per-frame 阴影圆绘制。

### 17.5 当前验证

已执行语法检查：

```bat
node --check public\vcp-neon-game\js\entities.js && node --check public\vcp-neon-game\js\weapons.js && node --check public\vcp-neon-game\js\game.js
```

结果：

```text
通过
```

### 17.6 后续可选优化方向

如果后续仍遇到 8 分钟后极限高压卡顿，可继续做：

- 子弹、敌人、经验对象池，减少频繁 new 和 GC。
- 敌人碰撞 broad-phase 分桶，降低子弹 x 敌人的全量碰撞复杂度。
- 对屏幕外敌人/粒子做更激进的绘制裁剪。
- 增加“低特效模式”开关：
  - 降低粒子池上限。
  - 关闭背景星点。
  - 关闭普通敌人阴影。
- 将背景网格绘制到离屏 canvas，只在 resize 或网格参数变化时重绘。
