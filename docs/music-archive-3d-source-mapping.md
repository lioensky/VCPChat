# 3D 档案阵列：和原版 Rhine Music Database 的源码对照

原版版本：MikeQu223/Rhine-Music-Database，提交 e52a6f4。我们的实现只有一个文件：`Musicmodules/music-archive/archive-scene.js`。
「照搬」表示公式和数值都和原版一样；「改」表示我们有意做得不一样，后面写了原因。

## 1. 卡盒模型

| 我们 | 原版出处 | 状态 |
|---|---|---|
| 托盘 x ±2.493、y 0.01–3.69、z -0.13–0.19 | `Assets/models/archive-cassette.glb` 里的 Ivory_Edges 网格（量出来的尺寸） | 尺寸照搬，用代码重建。前沿的唇边被面板挡住，所以做成了闭合盒 |
| 面板 0.032 厚，z 0.174–0.206，倒角 0.012 | 同一个 glb 的 Frosted_Polymer 网格 | 照搬 |
| 左上角缺口 x -2.284 到 -2.034、y 3.475 以上 | Frosted_Polymer 的缺口（插 Index_Inlay 的位置） | 照搬 |
| 两个孔，半径 0.082，圆心 (2.389, 3.526) 和 (-2.335, 0.14) | Frosted_Polymer 上的孔、Titanium_Fasteners 的位置 | 照搬 |
| 阵列里不画螺丝、索引片、标签 | `SceneAppearance.cpp` 里 `arrays = {Frosted_Polymer, Ivory_Edges, Optical_Diffuser}` | 照搬 |

## 2. 阵列（浏览）着色：`opticalSurface.frag` 的壳体分支加 `bake-archive-lighting.py`

| 我们（CARD_FRAG） | 原版 | 状态 |
|---|---|---|
| `faceSample()` | `face_sample()`：宽面的暖棕渐变、端面和顶面的颜色、边缘提亮 `exp(-d/0.025)`、自发光条 | 浅色照搬；深色改了，见第 5 节 |
| `radiance()` | `inverse_display_curve()`：按曝光 1.02 反解 RRT 曲线 | 照搬，用解析解代替原版的二分查找 |
| `surfaceUv()`、`faceOf()` | `opticalGeometry.vert` 里的 surfaceUv 和 `getFace()` | 照搬，改成逐像素计算（原版逐顶点计算，在倒角上会插值出错） |
| `normalResponse()` | `bake_normal_response()`：按 \|n\|² 在三个面之间混色，高光 0.18·cos²⁴，方向 (-0.48, 0.80, 0.36) | 照搬，解析计算代替 128² 贴图 |
| `field()` | `field_sample()`：5 个发光点、散射、吸收、每层卡衰减 0.78 | 公式照搬，解析计算代替 96²×24 三维贴图。端详时分母另加 0.45（原版贴图三线性插值本身是糊的，这样近看不会出光斑） |
| 合成：`baked·nr + 高光 + 光场 + 自发光·selected` | `vec3 color = baked.rgb * normalResponse.rgb + normalResponse.a; color += bakedIllumination(); color += emissionColor * baked.a * emission` | 照搬 |
| 选中卡面板半透 38% | `RhiScene.cpp` musicDraws：选中 Frosted 在阵列里 opacity 0.62 | 照搬，透出 Optical_Diffuser（z = -0.038） |
| 雾 | `NativeSceneCamera.cpp`：fogNear = 距离 + lerp(5-4θ, -1, detail)，fogFar = 距离 + lerp(25-9θ, 12, detail)；`NativeSceneFrame.cpp` 雾色 #eae5e1 → #263136 | 浅色照搬；深色雾色改了，见第 5 节 |

## 3. 后期：`opticalFinalFragment.frag`

| 我们 | 原版 | 状态 |
|---|---|---|
| 3×3 二项模糊，半径 1 + 6·smoothstep(.05, .48, \|y-.52\|)·(1-detail) | 同一段 | 照搬 |
| ACES，曝光 0.76 / 0.98 | `aces(hdr, mix(0.76, 0.98, theme))` | 照搬 |
| 上半截、下沿、四角往纸色压：浅色 .72 / .72 / .19，深色 .82 / .84 / .48 | 同一段 | 照搬，取出详情时收掉 |
| 背景 | 原版 background #eae5e1 / #11181b 直接当线性值清屏 | 改：反算成纸色。取出卡片、镜头抬高时，背景正好等于页面纸色，不会发灰或发青 |

## 4. 取出（端详）的卡：`opticalSurface.frag` 中 hero（`v_mode > 0.5`）的各个分支

| 部件 | 原版 | 我们 |
|---|---|---|
| 面板 Frosted_Polymer | flags 3 加 hero 走玻璃分支：`clearGlass = tint·0.06 + fog·(0.04+0.95·fresnel) + spec + sheen·0.85 + edge·0.55`，alpha = 0.06 + rim·1.3 + fresnel·0.35 | 方案 A 照搬（几乎全透，看到的是内衬板）；方案 B 把内衬换成象牙白，光场只留一成五 |
| 内衬 Optical_Diffuser | flags 5 走壳体分支，烘焙色加光场加自发光，再过 `keyLight(·, 0.6)` | 方案 A 照搬 |
| 托盘 Ivory_Edges | flags 4 加 hero：`mix(color #f0e7df, dark #687277) + 光场`，再过 `keyLight(·, 0.35)` | 照搬，深色乘 0.75 |
| 螺丝 Titanium_Fasteners | musicDraws 固定成暗色 (0.065, 0.075, 0.08) | 改：钛灰 (0.43, 0.45, 0.46)。原版的暗色贴在象牙白上像个黑洞 |
| 主光 `keyLight()` | 方向 normalize(0, .55, .84)，base·(0.55+0.45·N·L) + pow(N·H, mix(20, 90, gloss))·mix(.18, .85, gloss) | 照搬 |
| 卡面的细线、十字标 | Music_Case_Marks：一张印刷贴图（原版美术，标签分支） | 改：我们用代码自己画（四边走线、角上十字、小地球、底边小字），不搬原版的图 |
| 圆盘和封面 | Music_Disc_Print / Silver / Hub | 不做：保留我们原来的方形封面排版（你说过保留） |

## 5. 深色主题

原版深色的做法：`face_sample` 的 dark 分支用青灰（端面 0.14,0.17,0.18；宽面 0.075,0.102,0.114），光场和浅色一样强，雾色 #263136。
我们第二轮照搬了这一套，结果是大片琥珀色压在青灰上，发脏、发绿。

现在改成：
- **卡盒：** 中性石墨灰。宽面下深上浅（0.165 → 0.235），顶面 0.36，端面 0.27，四边留一圈细亮边。
- **暖光：** 只留三分之一。
- **雾色：** 压到接近纸色 (0.06, 0.075, 0.08)，远处的卡淡进去时不会浮出一条亮带。
- **不变的部分：** 后期的压边比例和曝光 0.98 照搬原版。

## 6. 没有照搬的东西（以及原因）

- **原版的贴图资源：** 烘焙图集、光场、法线响应的二进制文件，我们都改用解析公式在着色器里计算。数值一样，省去了贴图。
- **原版美术：** Case_Marks 印刷贴图、圆盘印刷、各种 logo 和字体，一律不搬。

## 7. 动效与交互（夜间轮次）

| 我们 | 原版出处 | 状态 |
|---|---|---|
| 肩部隆起速率 5、列聚焦速率 4、镜头 3.7 | `NativeSceneUpdate.cpp`：`m_shoulder.damp(…, 5)`、`m_laneFocus.damp(…, 4)`、`m_columnCamera/m_rail.damp(…, 3.7)` | 照搬 |
| 悬停卡探出 0.28，按 `1-exp(-14·dt)` 趋近 | 同文件 `m_hoverLifts`：目标 0.28，速率 14 | 照搬（原来 0.24、线性 10） |
| 待机起伏两组正弦，2.5 秒不操作后按 0.8 渐起、按 4 收回 | `ArchiveField::sample` 的 breathing；`m_idleGain` 的 0.8 / 4 | 照搬；只在播放时起伏（我们的省电选择） |
| 取出时镜头跟随 `blend 2.8`，进度由抬起高度 `smooth((lift-0.8)/2.4)` 算 | 同文件 `m_detail = lerp(m_detail, cameraTarget, blend)` | 照搬（原来 5） |
| 卡顺着起伏坡度前后倾 `slope×0.024×(1-detail)`，选中卡再乘 `(1-smooth(lift/0.4))` | 同文件 `actor.rotation.x`、普通卡的 `Matrix::compose(position, {slope*0.024*(1-m_detail),0,0})` | 照搬，标题贴片一起倾 |
| 换下来的卡按 `exp(-4.5·dt)` 落回 | `SceneLifetimePolicy.h` `returningLiftStep` | 照搬（原来临界阻尼弹簧 4.2） |
| 端详时拖动转卡：每像素 0.004 弧度、±0.8，按 2.8 跟随，松手按 7 指数回正 | `NativeSceneInput.cpp` pointermove 的 `m_targetRotation`；`returnAngleStep` | 照搬（原来 0.006、±1.2、立即跟手） |
| 按住空白拖动整片档案、松手惯性滑行并吸附 | `SceneDrag.cpp` `ArchiveDrag` / `ArchiveMomentum`（10 像素起拖、120 毫秒采样、摩擦 2.4、吸附弹簧 10、起滑阈值 0.75） | 照搬；只在卡已放回时可拖，和原版 `canBrowse()` 一致 |
| 镜头快速移动、卡飞出前半段按 0.67 倍分辨率画 | `render/RenderModePolicy.h` 渲染比例 50–200% 加放大 | 思路照搬；原版是固定比例，我们只在运动时降，停稳全清晰 |
| 实例从近到远画 | `NativeSceneUpdate.cpp` 按相机距离前到后重排 | 照搬（按行倒序） |
| （未搬）机位、注视点、视角再按 `1-exp(-5·dt)` 跟随 | `NativeSceneCamera.cpp` 的 `blend` | 试过后撤回：鼠标每动一下镜头要多追约 0.8 秒、按满帧画，和「降负载」冲突；我们的卡片移动已经各自有弹簧 |
| （未搬）不操作 0.75 秒即停掉待机起伏 | `Engine.cpp` `energyIdle` | 会改变放歌时的观感，待定 |
| 卡取出后背景的选中波纹按 `1-exp(-8·dt)` 淡到 0，淡完清空 | `NativeSceneUpdate.cpp` `m_pulseGain` | 照搬 |
| 重选刚换下的卡：从它当时的高度和角度接着抬 | `NativeScene::select` 的 `m_returning` 取回 | 照搬 |
| 低帧率（待机 12 帧、省电 30 帧）时两帧之间用定时器睡，快到点才要显示帧 | `Engine.cpp` tick：只转唱片时 `intervalMs = 33`，场景停稳就停掉定时器 | 思路照搬；画的帧数不变，页面被叫醒的次数约为原来五分之一 |
| 只在能浏览时指针才带动镜头视差；放回过渡里视差缓缓跟上 | `NativeSceneUpdate.cpp` `m_pendingHover` 只在 `canBrowse()` 时更新 `m_pointer` | 照搬；卡取出端详时晃鼠标不再整帧重画 |
| （未搬）指针视差的范围 | 原版 `m_pointer = x/宽 − 0.5`（±0.5）×0.12；我们是 ±1×0.12 | 我们晃动幅度是原版两倍；改了观感会变，待定 |
| （未搬）滚轮一格只走一行、不带惯性 | `Engine::wheel` 的 `m_wheelSteps` | 本机版的滚轮惯性是她要的手感，保留 |
| 起伏场（肩部隆起、列聚焦强度、待机两组正弦、选中波纹）与主题翻色（每张 0.58 秒、最远晚 0.6 秒、整体 0.85 秒、smoothstep） | `SceneMotion.cpp` `ArchiveField::sample`、`ThemeWave` | 逐项核对过，常数和曲线一致 |
| （未搬）浏览时投影矩阵横向偏 0.16（`m_projection.values[8] += 0.16 * archiveOffset`） | `NativeSceneCamera.cpp` 浏览构图 | 原版把阵列整体往一侧挪；我们按本机版左目录、右抽屉的让位构图，不叠加这个偏移 |
| 画布不开多重采样、深度、模板 | 原版场景在自己的目标里做抗锯齿后合成 | 后期开着时画布只收一个全屏三角形，省掉每帧整屏解析，像素一致 |
