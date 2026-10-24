# 桌宠（试验功能）

在左下角「全局设置」的「桌宠」分区里点一张形象卡片，就会把那个 Agent 放到桌面上：透明、无边框、置顶，只有角色本身和气泡可以点，空白处鼠标直接穿透到下面的窗口。

- **直接对话：** 平时角色脚下有一道小横条；鼠标停在角色上一会儿，它撑开成一颗小胶囊（✎ 打字、🎤 说话），移开 1.4 秒后收回横条。胶囊在脚底下，不压着角色；拖到任务栏附近松手时是胶囊落在任务栏上。点 ✎、双击角色或右键「和 TA 说话」展开成比角色宽的输入条，Enter 发送、Esc 收起，输入条跟着字数长高；输入条左边的 ＋ 按下后，这一句先开一个新话题再发（和主窗口的「新话题」一样，再按一下取消）。点 🎤 开始录音（按钮里的圆点随音量起伏），再点一下停止，用本机 SenseVoice 转成文字放进输入条，改好再发；没装 SenseVoice 模型时会提示。几种状态之间都有过渡动画。话经主窗口按正常流程发出，历史、话题都照常保存；主窗口当前不是这个 Agent 时会自动切过去。TA 还在回复时发的话先排着，这条说完自动发出（气泡下方小字会写「说完就发」）。
- **回复气泡：** 回复边流出边显示在角色头顶（情绪标记、思维链、工具调用不显示；Markdown 记号整理成纯文字，代码块显示为 [代码]，图片显示为 [图片]）。回复结束后按长短停留 8 到 30 秒，鼠标停在气泡上时不收。点气泡打开主窗口看完整内容。
- **表情：** 跟着回复换表情；思考、调用工具、出错时有对应状态；单击角色会做个开心的动作（双击只打开输入框，不触发这个动作）。
- **闲着时：** 光标停住后视线自己四处看；隔十几秒做个小动作（歪头、伸懒腰、哼歌、东张西望）。3 分钟没人理就打哈欠、眼皮发沉、时不时点一下头，再过 1 分钟睡着（闭眼低头，头顶飘 z）。光标在窗口里晃一晃会慢慢醒；单击、拖动、来了回复或主动说话时惊醒。睡着时摸头不会醒，只在梦里笑一下。
- **互动：** 单击身体是开心，点头顶会害羞；光标在头上来回蹭是摸头；连点三下不耐烦（💢），戳到第六下晕了（💫），连点时第二下打开的空输入框会自己收回去。拖起来会慌，左右拖时身子跟着甩，放下时落地一顿。
- **心情：** 小动作跟着长期心情走：开心时动得勤、爱哼歌；难过、生气时少动、不哼歌；累了更早犯困（心情很淡时不影响）。
- **省电：** 空闲 30 秒后降帧，睡着再降一档（10 帧，软件渲染 5 帧）；小动作按当前帧率演，被碰到才回到高帧率；隐藏桌宠时完全停止渲染，闲时计时也停；没有显卡、用软件渲染时帧率再降一档并关掉抗锯齿。
- **出声：** 助手在 Agent 设置里选了音色（和主窗口「朗读」用同一套：音色、语速、正则、导演提示词），桌宠就把回复念出来。回复边流边按句交给 TTS，第一句写完就开口；嘴跟着声音的大小开合；Live2D 模型带あいうえお口形参数（`ParamA`～`ParamO`，至少 A、I、U）时，还会从声音里认出元音换口形（Live2D 和网格立绘动 `ParamMouthOpenY`，差分立绘换 `portrait.talk.png` 张嘴帧，没有就随声音轻轻起伏，头像跟着放大缩小）。气泡只显示到正在念的那一句，表情也跟着这一句的情绪标记换。正在念时单击角色就停下，整段字一下显示完。右键「朗读回复」可以只让这个助手的桌宠闭嘴（记在 `AppData\deskpet\voice.json`）。同一时间只有一个声音：桌宠开口时主窗口的朗读停下，主窗口开始朗读时桌宠停下；桌宠正在念的那条，主窗口的自动朗读插件不再念一遍。免打扰时主窗口里聊天的回复不念，在桌宠上说的话和闹钟照常念。没选音色的助手还是假口型、不出声。
- **正在做什么：** 回复里调工具时，气泡下面有一条小卡片，比如「🔍 正在搜索 · 明天上海天气」，做完打勾、失败标红。
- **主动搭话：** AI 用「AI 主动创建话题」插件开了新话题时，开着的桌宠会把第一句话说出来，点气泡直接切到那个话题；用 VCP 闹钟插件设的闹钟到点时，桌宠（藏起来的也会出来）说出提醒事项。闹钟原本的弹窗照旧。
- **右键菜单：** 换装、朗读回复、免打扰、设置…、隐藏桌宠。说话、语音在脚下的胶囊上；切换助手、大小、透明度、溜达、只看不点在设置页（大小也能 Ctrl+滚轮，只看不点也在托盘）。
- **换装：** 同一个助手可以有好几套形象（比如科技服、女仆、Q 版），右键「换装」或在桌宠设置里选。每个助手记住自己上次穿的那套；换的时候脚底位置不动，大小档位不变。怎么放见下面「2b. 多套形象」。
- **全身像：** 形象按不透明像素的轮廓摆：图四周的透明边不算，脚底贴着窗口底边。窗口跟着形象的比例走，竖长的全身像窗口更高更窄，Q 版、半身像和以前一样高；量过的比例会记住，下次直接按它开。气泡、情绪角标、头顶小符号都跟着头走，点头、摸头也按头的位置算。
- **大小：** 鼠标放在角色上按住 Ctrl（macOS 上 Cmd）滚动滚轮，或右键「大小」，或在桌宠设置里拖滑块，50% 到 300%（100% 是默认大小，比第一版小了四成）。脚底位置不动，每个助手的大小分别记住；放不下的屏上会自动缩到放得下。
- **免打扰：** 右键、托盘或设置里打开。打开后桌宠不主动开新话题、不出声，主窗口里聊天的回复和情绪角标也不在桌宠头上冒出来；在桌宠上跟 TA 说的话照常回，闹钟照常叫。角色自己也不做小动作、不打哈欠、不冒小符号，只安静地呼吸眨眼、到点打盹；被碰到时照常反应。头顶旁边有个小月亮表示正在免打扰。
- **全局快捷键：** 在任何程序里都能用，可以在桌宠设置里改或清空：
  - `Ctrl+Alt+Shift+P` 显示/隐藏桌宠（一个都没开时打开上次那个）
  - `Ctrl+Alt+Shift+M` 和桌宠说话（叫出最近用过的桌宠并打开输入框，再按一次收起）
  至少要两个修饰键，不能用 VCPChat 自己占着的组合；被别的程序占用时设置里会提示。
- **托盘：** 托盘菜单里有「桌宠」：显示/隐藏、和桌宠说话、免打扰、桌宠设置。
- **启动恢复：** 退出 VCPChat 时开着的桌宠，下次打开会回到原来的位置（设置里可以关掉）。自己关掉的不会回来。
- **设置页：** 全局设置里的「桌宠」分区（右键「桌宠设置…」、托盘都会直接跳到这里）。上面是当前桌宠的大预览，下面带一条和桌宠上一样的输入胶囊（多一个收起钮，收成小横条后光标再进来又撑开），在这里打字或说话会交给桌面上的桌宠；「自定义」展开大小滑块和形象文件夹。「我的桌宠」列出所选助手的每一套形象，卡片上是真实渲染的快照，点一下就换上（桌宠没开就直接打开），点「无」关掉。「导入形象」可以选 Live2D 的 `*.model3.json`、网格立绘的 `*.puppet.json`（连同它所在的文件夹一起复制）、整个模型压缩包 `.zip`（只解出模型所在那一层，国内压缩软件打的中文文件名也能认）或几张图片，复制进这个助手的 `deskpet\` 新建一套；也可以把这些文件或模型文件夹直接拖到形象列表上。免打扰、只看不点、视线跟随光标、溜达、不透明度、截图录屏时隐藏（Windows、macOS）、启动恢复和快捷键也在这一页。

应用内置 Nova 女仆全身和简洁 Q 版 Live2D，以及两个 Codex 精灵：刻晴、乐奈（`assets/deskpet/codex/`，不需要 Cubism Core）。右键「换装」或在桌宠设置里选择，每个助手分别记住选择。新建的 Nova（名称为 Nova、不区分大小写）默认用女仆；已有自定义模型和其他助手的立绘保留原来的默认选择。其他助手可以在「换装」里手动选内置 Nova 或精灵，但不会默认变成它们。

Nova 的两套资源位于 `assets/deskpet/nova/`，包含真正的 `.moc3` 模型、贴图、动作、表情和立绘备用图，直接从应用目录读取，不会覆盖助手的数据。未配置 Cubism Core 时显示对应立绘；Q 版的立绘备用图还含 12 个情绪及思考、工具、错误状态。Live2D 版本提供基础参数表情和点头、摇头等动作，复杂的手势差分尚未绑定成 Live2D 动作。

不是 Nova、又没放自己的素材时，桌宠显示 Agent 的头像，加上一个情绪圆环。下面任意一种素材都能让它更像样。

## Windows 上怎么试

### 1. 放 Live2D 模型（可选）

1. **Cubism Core。** 一般不用管：`npm install` 时 `scripts/deskpet/fetch-cubism-core.cjs` 会从 Live2D 官网把 Core 下到 `vendor/live2d-cubism-core/`（不进 git），打包时也会带上，设置页显示「随应用附带」。离线安装、下载失败或设置了 `VCPCHAT_SKIP_CUBISM_CORE=1` 时没有这一份，这时在全局设置「桌宠」分区的「Live2D 支持」点「一键启用」，会从 Live2D 官网下载单独发布的 Core（约 200 KB）装好，正在用立绘代替的 Live2D 桌宠自动换回 Live2D。官网那份要是换成了 6.x 或者下不下来，会自动改下锁定版本的 Cubism SDK for Web 5-r.4，只取出 Core。连不上官网时，自己去官网下载 SDK（必须是 **5.x**），点「用本地文件…」选压缩包或里面的 `live2dcubismcore.min.js`。装之前会在隐藏页面里试加载一遍，坏文件和 6.x 不会替换已经能用的 Core。也可以手动放到：
   ```
   <VCPChat>\AppData\deskpet\live2dcubismcore.min.js
   ```
   如果设置了 `VCPCHAT_APP_DATA_DIR`，就放在那个目录下的 `deskpet\` 里。这里的 Core 优先于随应用附带的。注意不能用 6.x（SDK 5-r.5 及以后）：渲染引擎还不支持，桌宠会提示并自动改用立绘。
2. **模型。** 把整个模型文件夹（里面有 `*.model3.json`、`.moc3`、贴图等）放到：
   ```
   <VCPChat>\AppData\Agents\<AgentId>\deskpet\<模型文件夹>\
   ```
   官方示例模型里 Mao、Natori 带表情文件，适合试情绪；Hiyori 没有表情文件，只能靠参数叠加看出变化。
3. **表情映射（可选）。** 官方示例 Natori、Mao、Haru、Ren 已内置映射，放进去就能用（推荐 Natori：表情最全）。其他模型在设置页「桌宠」分区选中这套形象，下面「表情映射 · 调整」里给每个情绪挑表情和动作，改一项桌宠就当场演一下，保存后写进模型文件夹的 `deskpet.json`（只改这 12 个情绪和点头、点身体两项，文件里别的键保留）。也可以手写：
   ```json
   {
     "expressions": { "neutral": "Normal", "happy": "Smile", "shy": "Blushing", "sad": "Sad",
                      "angry": "Angry", "surprised": "Surprised" },
     "motions": { "happy": "TapBody" },
     "taps": { "head": { "expression": "Blushing", "motion": "TapHead" }, "body": { "motion": "TapBody" } }
   }
   ```
   `taps` 是点到头、点到身体时演的表情和动作（看模型的 HitAreas，没有就按头部宽度估），没写的按默认反应：点头害羞、点身体开心。
   情绪键与侧栏差分立绘相同，共 12 个：`neutral calm happy excited shy affectionate curious surprised concerned sad tired angry`。没写的情绪按表情名去猜（含 smile、angry 之类的词）。

本项目附带自有 Nova 模型。Cubism Core 不在仓库里，安装依赖和打包时从 Live2D 官网下载、随应用附带，按 [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) 使用（见 `vendor/live2d-cubism-core/README.md`）；第三方示例模型需自行按其许可获取。已有 Core 配置可继续使用。

### 1b. 或者放网格立绘（可选，不需要 Cubism Core）

只有一张立绘、没有 Live2D 模型时，可以把图切成几块（底图、眼皮、睫毛、嘴型、腮红）做成 `*.puppet.json`，由 `puppet.js` 逐帧挪网格顶点：呼吸、眨眼、头和眼睛跟着光标、说话口型、按情绪换眼型嘴型和腮红。参数名与 Live2D 一致，情绪映射和 Live2D 共用。

```
<VCPChat>\AppData\Agents\<AgentId>\deskpet\<文件夹>\nova.puppet.json（及同目录的贴图）
```

Nova 的这一套由 `scripts/deskpet/build-nova-puppet.py` 从 `assets/nova_button_light.png` 生成（自动抠图，眼睛和嘴的位置手工标定）。同时放了 Live2D 模型和 Core 时优先用 Live2D。

### 2. 或者放差分立绘（可选）

没有 Live2D 模型时，桌宠会使用立绘，和侧栏首页立绘是同一套文件（在 Agent 设置里上传的差分这里也能用）：

```
AppData\Agents\<AgentId>\portrait.png           默认立绘
AppData\Agents\<AgentId>\portrait.happy.png     各情绪的差分（12 个情绪键）
AppData\Agents\<AgentId>\portrait.thinking.png  状态差分：thinking / tool / error
AppData\Agents\<AgentId>\portrait.talk.png      张嘴帧（可选）：朗读时按声音大小和当前立绘来回切
```

缺哪张就退回最相近的情绪，最后退回默认立绘。透明背景的 PNG 或 WebP 效果最好，点击只命中不透明的像素。

### 2b. 多套形象（换装）

`deskpet\` 下每个子文件夹是一套形象，文件夹里放什么就是什么：

```
AppData\Agents\<AgentId>\deskpet\
  科技服\        NovaTech.model3.json 及贴图（Live2D，可以在更深的子文件夹里）
  女仆\          portrait.png、portrait.happy.png …（差分立绘，也可以直接叫 happy.png）
  Q版\           nova-chibi-simple.png（只有一张图也行，那张就是这套的立绘）
  网格\          nova.puppet.json 及切块
```

- 菜单里显示文件夹名；想换个名字、排顺序或写一句介绍，在文件夹里放 `outfit.json`：`{ "name": "女仆", "order": 2, "description": "周末穿的" }`（`order` 小的在前，没写的按名字排；`description` 显示在设置页卡片上，最多 120 字，不写就按形象类型给一句）。
- 设置页卡片上的快照存在 `AppData\deskpet\previews\<AgentId>\`，形象文件变了会自动重拍，删掉也没关系。
- 以前直接放在 `deskpet\` 下的模型算一套「默认」；助手目录里的 `portrait.*.png` 算一套「立绘」，排在最后。老数据不用挪。
- 没选过时：有 Core 先用 Live2D，再是网格立绘、Codex 精灵动画、立绘。选过的那套删了就回到这个默认。

Codex 桌宠可通过 `pet.json`、整个文件夹、ZIP 或标准命名的 `spritesheet.png` / `spritesheet.webp` 导入；支持 8×9 的 v1 和含 16 个视线方向的 8×11 v2。`spriteBackend.js` 使用 Canvas2D 播放逐帧动画，共用桌宠的聊天、会话卡片和审批界面，不需要 Cubism Core。任务处理中播放工作行，审批时播放等待行，拖动/移动播放对应方向行。素材保留原有动作，没有额外的连续口型；格式和尺寸见 `docs/deskpet-live2d-v1.md`。
- 一套里同时有 Live2D 和网格立绘时，没放 Cubism Core 就用网格立绘；Live2D 那套没有自己的立绘时，用不了 Live2D 就退回助手目录的立绘。
- 有模型或网格立绘的文件夹里，只认按约定起名的立绘（`portrait.*` 或情绪键），贴图不会被当成立绘。
- 每个桌宠选了哪套、各套量出来的长宽比记在 `AppData\deskpet\state.json`（`outfit`、`figures`）。

### 3. 打开和关闭

- **打开或收起：** 全局设置 →「桌宠」，选好助手后点它的一套形象就打开，点「无」关掉；上面的「显示 / 隐藏桌宠」按钮和全局快捷键 `Ctrl+Alt+Shift+P` 收起或叫回所有桌宠。聊天头部不再有桌宠按钮。
- **移动：** 按住角色拖动，位置会记住。
- **关闭：** 在设置页选「无」；右键「隐藏桌宠」只是先收起来。桌宠不在任务栏里，Alt+F4 关不掉它。
- 关掉主窗口时，所有桌宠一起关闭（下次启动按「启动恢复」放回来）。
- **设置：** 右键「设置…」或托盘里打开全局设置的「桌宠」分区，设置存在 `AppData\deskpet\settings.json`，每个桌宠的位置和大小在 `AppData\deskpet\state.json`。

## 音乐伴舞

桌宠设置里的「听歌时跟着晃」默认开启。V 音乐播放时，Live2D 使用标准头部、身体参数跟随估算节拍轻轻摇摆；网格立绘、差分立绘和头像使用同一套律动的可用部分。Nova Q 版自动从 Wave、Heart、Cheer 等动作组中挑选手势，Nova 女仆没有这些动作时只做律动，不要求额外动作文件。

频谱复用音乐窗口已有的音频引擎连接，经主进程校验、节流后转发给可见桌宠，不建立第二条引擎连接。当前后端频谱为对数分带；节拍只是实时估算，不是歌曲的精确 BPM、拍号或副歌识别。手势按四拍一小节计数，高能量时可挑选 accent 手势。暂停、关闭播放器或断流后停止；免打扰、隐藏、睡眠、拖动、输入和互动期间避让，朗读期间只保留较小律动。伴舞期间保持活动帧率，精灵逐帧形象暂不支持伴舞。

第三方模型在模型旁的 deskpet.json 中增加可选 dance 配置；不写就使用通用默认，dance 为 false 可单独禁用。示例：

```json
{
  "dance": {
    "amplitude": 1.2,
    "map": { "bounce": { "id": "WZY", "scale": 0.35 } },
    "every": [2, 4],
    "gestures": [
      { "id": "point", "params": { "AJYSYC": 2, "AJYSS2": 1 }, "beats": 4 },
      { "id": "heart", "motion": "手势3比心.motion3.json", "accent": true },
      { "id": "stars", "expression": "按键 星星眼", "beats": 8, "accent": true }
    ]
  }
}
```

- amplitude：0～2 的整体幅度；头部限幅仍生效，不绕过 headPoseLimits。
- map.bounce：将归一化弹动额外映射到模型输入参数；不要映射物理输出，以免被覆盖。
- every：两次手势间隔的小节数，默认 2～4，按四拍估算。
- gestures：配置后替代自动动作选择；空数组表示只律动。params、motion、expression 三选一。
- params：只允许模型实际存在的参数，拍点硬切，结束恢复占用参数；不重置整个模型或服装。
- motion：匹配已有动作组、目录中的动作编号、名称或文件名。仅从已扫描白名单解析，不加载任意路径。
- expression：按目录编号或名称匹配，允许省略「按键」前缀；以临时参数层应用，不替换聊天情绪表情。
- beats：手势保持拍数，默认 4；目录已提供时长的动作按文件时长播放一次。
- accent：只在较高能量时使用，不表示已经识别出歌曲副歌。

配置解析会忽略缺失资源和未知参数。第三方资源留在用户模型目录，不打包进 Nova，也不修改原始模型和 VTube Studio 文件。

## 闲时动作和模型

各种形象都有闲时表现，按能用的东西逐级退化：

- **Live2D：** 每个动作都是一组叠在标准参数上的曲线（`ParamAngleX/Y/Z`、`ParamEyeLOpen`、`ParamMouthOpenY` 等，模型没有的参数自动跳过），所以只有 Idle、TapBody 两组动作的官方示例也能打哈欠、打盹、睡觉。模型自己有对应动作组时会一起放（参数曲线只轻轻叠一点）：按组名认 `TapHead`、`Angry`、`Shake`、`Surprised`、`Yawn`、`Stretch`、`Wake`、`Landing` 等，也可以在 `deskpet.json` 的 `motions` 里写，键是动作名：
  ```json
  { "motions": { "yawn": "Sleepy", "headTap": "TapHead", "annoyed": "Shake", "startle": "Flick" } }
  ```
  动作名：`lookAround tilt stretch hum yawn nod wake startle poke headTap pat sleepPat annoyed dizzy landed`。睡着时换成「疲惫」的表情（`tired`）。
- **网格立绘：** 和 Live2D 用同一套参数曲线。
- **差分立绘、头像：** 用整张图的歪头、下沉、挤压、抖动演同样的动作；睡着时换 `portrait.tired.png`（没画就不换，只靠歪头下沉和 z）；头像睡着时角标换成 😪。

头顶的小符号（💢 💫 💕 ♪ ❗ 和睡着时的 z）所有形象都有。

## 情绪从哪里来

和侧栏差分立绘共用 `modules/emotion`：桌宠打开期间，发给这个 Agent 的请求会在 system prompt 末尾加一段说明（侧栏已经加过、或角色提示词里自己写了就不重复），请模型在回复里写 `<!--emo:happy 0.8-->` 这样的标记。标记会从聊天显示里剥掉。

模型没写标记时，会按回复文字用规则推测一个情绪，桌宠角标上会注明「推测」。桌宠关着时，请求不会多加任何东西。

## 文件

主进程（`modules/`）：

- `deskpet/index.js`：唯一入口。由 `modules/appFeatures.js` 按 `deskpet/feature.json` 加载，只调 `register(host)`，协议 `vcp-deskpet://` 也在清单里声明；在插件管理器的 Feature 分类里可以停用（重启后生效）；桌宠要核心配合的地方（聊天请求和回复流、工具结果、删助手、朗读拦截、托盘菜单）都挂在 `modules/hostHooks.js` 上，删掉 `modules/deskpet/` 核心照常运行。主窗口里的 API 在 `deskpet/preloadApi.js`（`preloads/core/registry.js` 自动扫到，删目录就没了）。工具审批经 `vcp:tool-approval-pending`/`settled` 事件转过来。
- `deskpet/petHandlers.js`：装配和主进程生命周期：建共用上下文、把下面这些装上、注册自定义协议、启动时恢复上次的桌宠、退出时收摊。
- `deskpet/petContext.js`：各块共用的上下文（开着的桌宠、路径、主窗口、平台差异，以及推给主窗口和设置页的几句话）。
- `deskpet/petWindow.js`：窗口的一生——打开、显示隐藏、鼠标穿透、页面就绪、关闭、崩溃恢复、启动时恢复。
- `deskpet/petGeometry.js`：位置和大小的算法（窗口尺寸、默认位置、在不在屏上、工作区、贴边判定）。
- `deskpet/petDisplays.js`：显示器变化后摆回屏里，别的程序全屏时让位。
- `deskpet/petMotion.js`：拖动跟手、松手甩出去、贴边、藏进屏幕边里再探出来、沿任务栏溜达。
- `deskpet/petSizing.js`：缩放、换装、长宽比和页面偏好（透明度、气泡、免打扰）。
- `deskpet/petMenus.js`：桌宠身上的右键菜单和托盘里的「桌宠」一项。
- `deskpet/petStream.js`：把回复流转给桌宠页面，以及桌宠开着时追加的情绪标记和动作说明。
- `deskpet/petMainBridge.js`：和主窗口之间的来回（桌宠发言经主窗口发送、问当前话题、跳到话题、叫出主窗口和设置页）。
- `deskpet/petProactive.js`：主动开的新话题、闹钟、主窗口转来的工具审批。
- `deskpet/petCommands.js`：快捷键、托盘和设置页触发的动作（显示隐藏、说话、切换助手、桌宠列表）。
- `deskpet/petIpc.js`：桌宠这边所有 ipcMain 的注册，具体做什么交给上面各块。
- `deskpet/petAssets.js`：`vcp-deskpet://` 协议放行哪些文件，一个助手有哪几套形象、页面要的资源地址。
- `deskpet/petState.js`：`AppData\deskpet\state.json`（每个桌宠的位置、大小、形象、长宽比、藏边），读改写串行、先写临时文件再改名。
- `deskpet/petPrefs.js`：设置的默认值和校验、尺寸计算（按形象长宽比定窗口），纯函数。`petControls.js` 管设置文件和全局快捷键。
- `deskpet/outfits.js`：找出每个助手有哪几套形象（换装）；`zipImport.js` 导入模型压缩包。
- `deskpet/settingsPage.js`：设置页「桌宠」分区的主进程部分（卡片目录、换装、导入、表情映射，映射存在模型旁的 `deskpet.json`，读写在 `expressionProfile.js`）；`petPreviews.js` 在一个离屏窗口里给每套形象拍快照；`cubismCore.js` 下载、校验、安装 Cubism Core（试加载页面是 `DeskPetmodules/core-probe.html`）。设置页面板在 `DeskPetmodules/mainWindow/`。
- `deskpet/idleRunner.js`（时机和流程）、`idleChat.js`（说什么、能不能说）：闲时主动搭话。
- `deskpet/edgeSnap.js`、`throwMotion.js`、`wander.js`：贴边和藏边、甩出去、溜达的路线（纯函数，主进程按帧挪窗口）。`fullscreenWatch.js`：别的程序全屏时让开。`petTray.js`：托盘菜单只在真变了时才改。
- `deskpet/petVoice.js`：桌宠出声：按助手的 TTS 设置把句子交给共用的朗读（`register` 时注入），音频回到桌宠窗口；「朗读回复」开关；桌宠在念的回复不让主窗口再念（挂在 `tts:speak` 上）。`sovitsHandlers.js` 保证同一时间只有一个窗口在出声。

主窗口这一侧（`DeskPetmodules/mainWindow/`，只在 preload 暴露了桌宠接口时由 `modules/event-listeners.js` 动态载入）：

- `index.js`：唯一入口 `install()`（清单里的 `renderer`，经 `modules/renderer/appFeatures.js` 载入）：挂样式、经 `modules/settings/extensions.js` 注册设置里的「桌宠」分区、装上桥。
- `bridge.js`、`sendBridge.js`：桌宠和主窗口之间的往来（桌宠发言进当前会话、打开设置并切到桌宠分区）。
- `settingsSection.js`、`settingsPanel.js`、`settings.css`：全局设置「桌宠」分区。

页面（`DeskPetmodules/`）：

- `preload.js`：桌宠窗口专用 preload。
- `deskpet.js`：页面入口，只搭骨架：建好各模块共用的上下文、按顺序接线、管可见性和按档位降帧。下面这些是它拆出来的部分：
  - `petBubble.js`：气泡的状态和渲染、提示条、漏掉的回复小红点、主动说话、情绪角标、气泡对准头顶。
  - `petSpeech.js`：把 TTS 的播放进度接到气泡和嘴型上。
  - `petComposer.js`：底部输入条和录音（听写）、展开收起、草稿、发送和排队。
  - `petFiles.js`：拖进来的文件和粘贴的图片。
  - `petStream.js`：回复流和心情接到情绪导演，按念到哪一句换表情。
  - `petApprovals.js`：工具审批卡片。
  - `petHit.js`：鼠标命中、形象和控件的范围、拖动和连点、摸头。
  - `petWander.js`：什么时候想溜达，走起来告诉页面。
  - `petPrefs.js`：主进程给的设置（大小、透明度、免打扰、只看不点）。
  - `petReactions.js`：被碰到的反应和闲时小动作接到形象后端。
  - `petBackendPick.js`：依次挑形象后端，和设置页卡片的快照。
- 形象后端接口相同（`apply`、`probe`、`bounds`、`head`、`life`、`setActive`、`setPaused`…），按 Live2D → 网格立绘 → Codex 精灵动画 → 差分立绘 → 头像依次退：`live2dBackend.js`、`puppetBackend.js`（网格在 `puppet.js`）、`spriteBackend.js`、`imageBackend.js`（立绘和头像）。`petStage.js` 提供帧率档位、WebGL 和 Pixi 舞台、按轮廓摆放、按像素命中；精灵图使用 Canvas2D。`emotionLook.js` 是情绪的角标文字、色环和参数。

`dockVisibility.js` 统一处理底部控件的悬停展开、延时收起、输入/录音/会话固定显示、拖动和穿透隐藏，并阻止旧的异步命中覆盖最新光标状态。空闲只留横条，有会话动态时横条变蓝；铃铛不会自动展开会话。规则见 `docs/deskpet/hover-session-card-20261009.md`。
- `figure.js`：按不透明像素量形象的轮廓和头的位置，把脚底摆到窗口底边（纯函数）。
- `petLife.js`：闲时的时机（小动作、视线游走、犯困、睡着、醒来、连点、摸头）；`lifeMotion.js`：把阶段和动作变成参数曲线、拖动摆动和跳起高度；`lifeFx.js`：头顶小符号。
- `voice.js`、`speechText.js`：播放 TTS 音频、用 AnalyserNode 量音量驱动嘴型，按句切回复、跟踪念到哪一句（气泡和表情跟着走）。`dictation.js`：录音、重采样成 16 kHz WAV 交给本机 SenseVoice。
- `bubbleText.js` 把回复整理成气泡里的纯文字；`toolCard.js`、`toolActivity.js` 是「正在做什么」小卡片；`approvals.js`、`attachments.js`、`missedReply.js`、`gestures.js`、`hitAreas.js`、`expressionMap.js`、`gaze.js`、`moodOrder.js` 各管一件小事（纯函数，有单元测试）。
- `dock.css`：桌宠和设置页共用的胶囊 / 输入条 / 录音条。
- 给桌宠加会出声、会主动动的功能时，先看免打扰：页面里读 `window.deskPetPrefs.doNotDisturb`，或者监听 `window` 上的 `deskpet:prefs` 事件（`detail` 是 `{ scale, doNotDisturb }`）。

其他：

- `modules/emotion/`：情绪标签、规则兜底、情绪导演和差分挑图（与侧栏立绘共用）。
- `vendor/live2d/`：untitled-pixi-live2d-engine 1.4.0（MIT）。
