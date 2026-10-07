# VCPChat 项目文件目录结构

> 自动生成于：2026-09-30 11:40:22  

> 项目根目录：`H:\VCP\VCPMain\VCPChat`  

> 扫描说明：已自动跳过版本控制、编译产物、依赖包、Python虚拟环境与运行时、构建与Web生成目录、AppData/用户数据等。

## 文件统计

- **总目录数**：240
- **总文件数**：2049
- **文件类型数**：44

| 类型 | 扩展名 | 数量 |
| :--- | :--- | ---: |
| JavaScript | `.js` | 808 |
| JavaScript (ESM) | `.mjs` | 160 |
| PNG Image | `.png` | 159 |
| Markdown | `.md` | 140 |
| JSON | `.json` | 121 |
| CSS | `.css` | 113 |
| WOFF2 Font | `.woff2` | 102 |
| Rust | `.rs` | 100 |
| Audio (MP3) | `.mp3` | 76 |
| JPEG Image | `.jpg` | 44 |
| HTML | `.html` | 41 |
| Python | `.py` | 30 |
| (无扩展名) | `(无扩展名)` | 13 |
| TTF Font | `.ttf` | 12 |
| EXE 运行时/可执行程序 | `.exe` | 10 |
| .env | `.env` | 10 |
| TOML | `.toml` | 9 |
| Plain Text | `.txt` | 9 |
| JavaScript (CommonJS) | `.cjs` | 8 |
| Batch Script | `.bat` | 8 |
| .example | `.example` | 8 |
| GIF Image | `.gif` | 7 |
| SVG Vector Image | `.svg` | 7 |
| VBScript | `.vbs` | 7 |
| JPEG Image | `.jpeg` | 6 |
| PowerShell | `.ps1` | 5 |
| .block | `.block` | 5 |
| YAML | `.yml` | 4 |
| .ini | `.ini` | 4 |
| TypeScript | `.ts` | 3 |
| TypeScript (React) | `.tsx` | 2 |
| Icon | `.ico` | 2 |
| Audio (WAV) | `.wav` | 2 |
| .wasm | `.wasm` | 2 |
| .command | `.command` | 2 |
| Shell Script | `.sh` | 2 |
| .csproj | `.csproj` | 1 |
| C# | `.cs` | 1 |
| .inc | `.inc` | 1 |
| .rmskin | `.rmskin` | 1 |
| .pc | `.pc` | 1 |
| .old | `.old` | 1 |
| .lnk | `.lnk` | 1 |
| .lock | `.lock` | 1 |
| **合计** | - | **2049** |

## 目录结构树

```text
VCPChat/
├── .github/
│   └── workflows/
│       ├── chat_kernel_ui.yml
│       ├── mobile_sync.yml
│       ├── rust_assistant_engine_build.yml
│       ├── side_pane_e2e.yml
│       └── vcpchat-installer.yml
├── .snow/
│   └── settings.json
├── Agenttaskmodules/
│   ├── task.css
│   ├── task.html
│   └── task.js
├── apps/
│   └── bootstrap-installer/
│       ├── src/
│       │   ├── app.tsx
│       │   ├── main.tsx
│       │   ├── store.ts
│       │   ├── styles.css
│       │   └── theme.ts
│       ├── src-tauri/
│       │   ├── capabilities/
│       │   │   └── default.json
│       │   ├── icons/
│       │   │   ├── icon.ico
│       │   │   └── icon.png
│       │   ├── src/
│       │   │   ├── lib.rs
│       │   │   ├── main.rs
│       │   │   ├── manifest.rs
│       │   │   ├── process.rs
│       │   │   ├── source.rs
│       │   │   └── storage.rs
│       │   ├── build.rs
│       │   ├── Cargo.toml
│       │   └── tauri.conf.json
│       ├── .gitignore
│       ├── index.html
│       ├── LICENSE-HERMES
│       ├── package-lock.json
│       ├── package.json
│       ├── README.md
│       ├── THIRD_PARTY_NOTICES.md
│       ├── tsconfig.app.json
│       ├── tsconfig.json
│       ├── tsconfig.node.json
│       └── vite.config.ts
├── artifacts/
│   ├── diorama/
│   │   ├── chorus.png
│   │   ├── english-phrase.png
│   │   ├── event-meteor.png
│   │   ├── event-pigeons.png
│   │   ├── event-rabbit.png
│   │   ├── event-whale.png
│   │   ├── finale-moon.png
│   │   ├── instrumental.png
│   │   ├── light.png
│   │   ├── motion-off.png
│   │   ├── opening.png
│   │   ├── pause-first.png
│   │   ├── pause-repeat.png
│   │   ├── platform.png
│   │   ├── pre.png
│   │   ├── reflection-off.png
│   │   ├── return.png
│   │   ├── smoke-report.json
│   │   ├── themesEva-dark.png
│   │   ├── themesEva-light.png
│   │   ├── themes纸墨与机芯-dark.png
│   │   ├── themes纸墨与机芯-light.png
│   │   ├── themes酸性玄武-dark.png
│   │   ├── themes酸性玄武-light.png
│   │   └── verse.png
│   ├── manual-soak/
│   │   ├── 2026-08-20T20-28-29-513Z.json
│   │   └── 2026-08-20T20-58-24-947Z.json
│   ├── windows-matrix/
│   │   ├── 2026-08-20T20-12-51-026Z.json
│   │   ├── 2026-08-20T20-13-18-584Z.json
│   │   ├── 2026-08-20T20-16-47-662Z.json
│   │   ├── 2026-08-20T20-49-30-813Z.json
│   │   ├── 2026-08-20T20-59-10-746Z.json
│   │   ├── 2026-08-21T04-47-10-737Z.json
│   │   ├── 2026-08-21T04-49-00-860Z.json
│   │   ├── 2026-08-21T05-10-03-018Z.json
│   │   ├── 2026-08-21T05-15-10-766Z.json
│   │   ├── 2026-08-21T05-51-24-115Z.json
│   │   ├── 2026-08-21T05-55-55-233Z.json
│   │   └── 2026-08-21T06-13-58-840Z.json
│   └── diorama-whale-smoke.json
├── assets/
│   ├── font/
│   │   ├── vcp-ui/
│   │   │   ├── Material-Symbols-LICENSE
│   │   │   ├── material-symbols-outlined.woff2
│   │   │   ├── noto-sans-sc-100-wght-normal.woff2
│   │   │   ├── noto-sans-sc-101-wght-normal.woff2
│   │   │   ├── noto-sans-sc-102-wght-normal.woff2
│   │   │   ├── noto-sans-sc-103-wght-normal.woff2
│   │   │   ├── noto-sans-sc-104-wght-normal.woff2
│   │   │   ├── noto-sans-sc-105-wght-normal.woff2
│   │   │   ├── noto-sans-sc-106-wght-normal.woff2
│   │   │   ├── noto-sans-sc-107-wght-normal.woff2
│   │   │   ├── noto-sans-sc-108-wght-normal.woff2
│   │   │   ├── noto-sans-sc-109-wght-normal.woff2
│   │   │   ├── noto-sans-sc-110-wght-normal.woff2
│   │   │   ├── noto-sans-sc-111-wght-normal.woff2
│   │   │   ├── noto-sans-sc-112-wght-normal.woff2
│   │   │   ├── noto-sans-sc-113-wght-normal.woff2
│   │   │   ├── noto-sans-sc-114-wght-normal.woff2
│   │   │   ├── noto-sans-sc-115-wght-normal.woff2
│   │   │   ├── noto-sans-sc-116-wght-normal.woff2
│   │   │   ├── noto-sans-sc-117-wght-normal.woff2
│   │   │   ├── noto-sans-sc-118-wght-normal.woff2
│   │   │   ├── noto-sans-sc-119-wght-normal.woff2
│   │   │   ├── noto-sans-sc-21-wght-normal.woff2
│   │   │   ├── noto-sans-sc-22-wght-normal.woff2
│   │   │   ├── noto-sans-sc-23-wght-normal.woff2
│   │   │   ├── noto-sans-sc-24-wght-normal.woff2
│   │   │   ├── noto-sans-sc-25-wght-normal.woff2
│   │   │   ├── noto-sans-sc-26-wght-normal.woff2
│   │   │   ├── noto-sans-sc-27-wght-normal.woff2
│   │   │   ├── noto-sans-sc-28-wght-normal.woff2
│   │   │   ├── noto-sans-sc-29-wght-normal.woff2
│   │   │   ├── noto-sans-sc-30-wght-normal.woff2
│   │   │   ├── noto-sans-sc-31-wght-normal.woff2
│   │   │   ├── noto-sans-sc-32-wght-normal.woff2
│   │   │   ├── noto-sans-sc-33-wght-normal.woff2
│   │   │   ├── noto-sans-sc-34-wght-normal.woff2
│   │   │   ├── noto-sans-sc-35-wght-normal.woff2
│   │   │   ├── noto-sans-sc-36-wght-normal.woff2
│   │   │   ├── noto-sans-sc-37-wght-normal.woff2
│   │   │   ├── noto-sans-sc-38-wght-normal.woff2
│   │   │   ├── noto-sans-sc-39-wght-normal.woff2
│   │   │   ├── noto-sans-sc-4-wght-normal.woff2
│   │   │   ├── noto-sans-sc-40-wght-normal.woff2
│   │   │   ├── noto-sans-sc-41-wght-normal.woff2
│   │   │   ├── noto-sans-sc-42-wght-normal.woff2
│   │   │   ├── noto-sans-sc-43-wght-normal.woff2
│   │   │   ├── noto-sans-sc-44-wght-normal.woff2
│   │   │   ├── noto-sans-sc-45-wght-normal.woff2
│   │   │   ├── noto-sans-sc-46-wght-normal.woff2
│   │   │   ├── noto-sans-sc-47-wght-normal.woff2
│   │   │   ├── noto-sans-sc-48-wght-normal.woff2
│   │   │   ├── noto-sans-sc-49-wght-normal.woff2
│   │   │   ├── noto-sans-sc-5-wght-normal.woff2
│   │   │   ├── noto-sans-sc-50-wght-normal.woff2
│   │   │   ├── noto-sans-sc-51-wght-normal.woff2
│   │   │   ├── noto-sans-sc-52-wght-normal.woff2
│   │   │   ├── noto-sans-sc-53-wght-normal.woff2
│   │   │   ├── noto-sans-sc-54-wght-normal.woff2
│   │   │   ├── noto-sans-sc-55-wght-normal.woff2
│   │   │   ├── noto-sans-sc-56-wght-normal.woff2
│   │   │   ├── noto-sans-sc-57-wght-normal.woff2
│   │   │   ├── noto-sans-sc-58-wght-normal.woff2
│   │   │   ├── noto-sans-sc-59-wght-normal.woff2
│   │   │   ├── noto-sans-sc-6-wght-normal.woff2
│   │   │   ├── noto-sans-sc-60-wght-normal.woff2
│   │   │   ├── noto-sans-sc-61-wght-normal.woff2
│   │   │   ├── noto-sans-sc-62-wght-normal.woff2
│   │   │   ├── noto-sans-sc-63-wght-normal.woff2
│   │   │   ├── noto-sans-sc-64-wght-normal.woff2
│   │   │   ├── noto-sans-sc-65-wght-normal.woff2
│   │   │   ├── noto-sans-sc-66-wght-normal.woff2
│   │   │   ├── noto-sans-sc-67-wght-normal.woff2
│   │   │   ├── noto-sans-sc-68-wght-normal.woff2
│   │   │   ├── noto-sans-sc-69-wght-normal.woff2
│   │   │   ├── noto-sans-sc-70-wght-normal.woff2
│   │   │   ├── noto-sans-sc-71-wght-normal.woff2
│   │   │   ├── noto-sans-sc-72-wght-normal.woff2
│   │   │   ├── noto-sans-sc-73-wght-normal.woff2
│   │   │   ├── noto-sans-sc-74-wght-normal.woff2
│   │   │   ├── noto-sans-sc-75-wght-normal.woff2
│   │   │   ├── noto-sans-sc-76-wght-normal.woff2
│   │   │   ├── noto-sans-sc-77-wght-normal.woff2
│   │   │   ├── noto-sans-sc-78-wght-normal.woff2
│   │   │   ├── noto-sans-sc-79-wght-normal.woff2
│   │   │   ├── noto-sans-sc-80-wght-normal.woff2
│   │   │   ├── noto-sans-sc-81-wght-normal.woff2
│   │   │   ├── noto-sans-sc-82-wght-normal.woff2
│   │   │   ├── noto-sans-sc-83-wght-normal.woff2
│   │   │   ├── noto-sans-sc-84-wght-normal.woff2
│   │   │   ├── noto-sans-sc-85-wght-normal.woff2
│   │   │   ├── noto-sans-sc-86-wght-normal.woff2
│   │   │   ├── noto-sans-sc-87-wght-normal.woff2
│   │   │   ├── noto-sans-sc-88-wght-normal.woff2
│   │   │   ├── noto-sans-sc-89-wght-normal.woff2
│   │   │   ├── noto-sans-sc-90-wght-normal.woff2
│   │   │   ├── noto-sans-sc-91-wght-normal.woff2
│   │   │   ├── noto-sans-sc-97-wght-normal.woff2
│   │   │   ├── noto-sans-sc-98-wght-normal.woff2
│   │   │   ├── noto-sans-sc-99-wght-normal.woff2
│   │   │   ├── noto-sans-sc-cyrillic-wght-normal.woff2
│   │   │   ├── noto-sans-sc-latin-ext-wght-normal.woff2
│   │   │   ├── noto-sans-sc-latin-wght-normal.woff2
│   │   │   ├── Noto-Sans-SC-LICENSE
│   │   │   ├── noto-sans-sc-vietnamese-wght-normal.woff2
│   │   │   └── noto-sans-sc.css
│   │   ├── MavenPro-ExtraBold.ttf
│   │   └── Orbitron.ttf
│   ├── iconset/
│   │   ├── BJENAUN/
│   │   │   ├── _1dm_.png
│   │   │   ├── _2fas_auth.png
│   │   │   ├── _8_ball_pool.png
│   │   │   ├── _99.png
│   │   │   ├── _999.png
│   │   │   ├── _hex_.png
│   │   │   ├── _hexfield_.png
│   │   │   ├── _mono_.png
│   │   │   ├── _mythemes.png
│   │   │   ├── aawireless.png
│   │   │   ├── abc_btn_radio_to_on_mtrl_000.png
│   │   │   ├── abc_btn_radio_to_on_mtrl_015.png
│   │   │   ├── abc_btn_switch_to_on_mtrl_00001.9.png
│   │   │   ├── abc_btn_switch_to_on_mtrl_00012.9.png
│   │   │   ├── abci_securities.png
│   │   │   ├── absher.png
│   │   │   ├── accuweather.png
│   │   │   ├── act_fibernet.png
│   │   │   ├── adblock_for_samsung_internet.png
│   │   │   ├── adguard.png
│   │   │   ├── adguard_vpn.png
│   │   │   ├── adidas.png
│   │   │   ├── adobe_lightroom.png
│   │   │   ├── adp.png
│   │   │   ├── aethersx2.png
│   │   │   ├── aftership.png
│   │   │   ├── agen_pulsa.png
│   │   │   ├── agoda.png
│   │   │   ├── aha.png
│   │   │   ├── ai_wallpapers.png
│   │   │   ├── aiqfome.png
│   │   │   ├── airalo.png
│   │   │   ├── airbnb.png
│   │   │   ├── airmail.png
│   │   │   ├── airmee.png
│   │   │   ├── airtel.png
│   │   │   ├── airtel_live_.png
│   │   │   ├── albilad.png
│   │   │   ├── alexis_pie.png
│   │   │   ├── alfagift.png
│   │   │   ├── alibaba.png
│   │   │   ├── aliexpress.png
│   │   │   ├── alinet.png
│   │   │   ├── alipay.png
│   │   │   ├── alive_kwgt.png
│   │   │   ├── alquran.png
│   │   │   ├── amazon_alexa.png
│   │   │   ├── amazon_shoping.png
│   │   │   ├── amazon_store_card.png
│   │   │   ├── american_airlines.png
│   │   │   ├── ampere.png
│   │   │   ├── ana_mara_redefass_supermercado.png
│   │   │   ├── anb.png
│   │   │   ├── android_auto.png
│   │   │   ├── antutu_benchmark.png
│   │   │   ├── aodnotify.png
│   │   │   ├── aosp_mods.png
│   │   │   ├── apktool_m.png
│   │   │   └── app_locker.png
│   │   └── VChatOfficial/
│   │       ├── AI记忆.gif
│   │       ├── AI记忆.png
│   │       ├── dice.png
│   │       ├── README.md
│   │       ├── vchat_main.ico
│   │       ├── vchat_main.png
│   │       ├── 主题.gif
│   │       ├── 主题.png
│   │       ├── 人类笔记.gif
│   │       ├── 人类笔记.png
│   │       ├── 信息流.gif
│   │       ├── 信息流.png
│   │       ├── 协同.png
│   │       ├── 工具箱.gif
│   │       ├── 工具箱.png
│   │       ├── 数据库.gif
│   │       ├── 数据库.png
│   │       ├── 翻译.png
│   │       ├── 论坛.gif
│   │       ├── 论坛.png
│   │       └── 音乐.png
│   ├── svg/
│   │   ├── acrylic-noise.svg
│   │   ├── PaperAirplane.svg
│   │   └── PaperClip.svg
│   ├── wallpaper/
│   │   ├── ayanami_dark.png
│   │   ├── ayanami_first_children_dark.png
│   │   ├── ayanami_first_children_light.jpg
│   │   ├── ayanami_light.png
│   │   ├── code-dark.jpeg
│   │   ├── code-light.jpeg
│   │   ├── ComfyUI_010842_894361418827477_00027.png
│   │   ├── ComfyUI_012952_1030647063343854_00033.png
│   │   ├── dark.jpg
│   │   ├── eva-dark.png
│   │   ├── eva-light.jpg
│   │   ├── forest_night.jpg
│   │   ├── leaf.jpg
│   │   ├── light.jpeg
│   │   ├── mountain.jpg
│   │   ├── sakuranight.png
│   │   ├── themes_snow_realm_light.jpg
│   │   ├── themes_star_abyss_dark.jpg
│   │   ├── vcp_acid_basalt_dark.jpg
│   │   ├── vcp_editorial_ink_light.jpg
│   │   ├── vcp_industrial_core_dark.jpg
│   │   ├── vcp_sterile_lab_light.jpg
│   │   ├── wallpaper-mountain-nightgold.jpg
│   │   ├── wallpaper_ci.jpg
│   │   ├── wallpaper_jin.jpg
│   │   ├── watermelon_day.jpg
│   │   ├── win22coffee.png
│   │   ├── wincoffee.png
│   │   ├── 春信.jpg
│   │   ├── 月影.jpg
│   │   ├── 樱夜倒影.png
│   │   └── 绿影猫咪.png
│   ├── Assistantmodules__Groupmodules__Musicmodules__Not....md
│   ├── dark.jpg
│   ├── default_avatar.png
│   ├── default_group_avatar.png
│   ├── default_user_avatar.png
│   ├── E1-Vchat主界面.jpg
│   ├── E1.5-Vchat前端应用群.jpg
│   ├── E10-浪潮语义寻址可视化悬浮窗.jpg
│   ├── E2-Vchat主界面.jpg
│   ├── E3-VCP桌面.jpg
│   ├── E4-音乐播放器.jpg
│   ├── E5-V文坊.jpg
│   ├── E6-终端与日志.jpg
│   ├── E7-划词小助手应用于Vscode编程解释和辅助生成代码.jpg
│   ├── E8-基于浪潮的语义级记忆关联可视化神经云图.jpg
│   ├── E9-Agent论坛与留言板系统.jpg
│   ├── icon.png
│   ├── icon4.png
│   ├── light.jpeg
│   ├── music-note.svg
│   ├── musicdark.jpeg
│   ├── musiclight.jpeg
│   ├── nova_button.png
│   ├── nova_button_light.png
│   ├── repeat-one.svg
│   ├── repeat.svg
│   ├── sakuranight.png
│   ├── setting.png
│   └── shuffle.svg
├── audio_engine/
│   ├── IRPreset/
│   │   ├── ADX5000预设.wav
│   │   └── 音频IR脉冲预设放在这.txt
│   ├── audio_server
│   ├── audio_server.exe
│   ├── audio_server.old.soxR.exe
│   ├── audio_server_rubato.exe
│   └── audio_server_x86兼容版.exe
├── bootstrap/
│   ├── recovery-main.cjs
│   ├── recovery-preload.cjs
│   ├── recovery-renderer.js
│   ├── recovery.css
│   └── recovery.html
├── Canvasmodules/
│   ├── canvas.css
│   ├── canvas.html
│   └── canvas.js
├── Chartmodules/
│   ├── chart-runtime.js
│   ├── chart-sandbox.html
│   ├── chart-sandbox.js
│   ├── chart.css
│   ├── chart.html
│   ├── chart.js
│   └── README.md
├── Desktopmodules/
│   ├── api/
│   │   ├── desktopMetrics.js
│   │   ├── ipcBridge.js
│   │   └── vcpProxy.js
│   ├── builtinWidgets/
│   │   ├── appTrayWidget.js
│   │   ├── musicWidget.js
│   │   ├── newsWidget.js
│   │   ├── performanceMonitorWidget.js
│   │   ├── systemMonitorWidget.js
│   │   ├── translateWidget.js
│   │   ├── vchatApps.js
│   │   └── weatherWidget.js
│   ├── core/
│   │   ├── dragSystem.js
│   │   ├── performanceManager.js
│   │   ├── state.js
│   │   ├── statusIndicator.js
│   │   ├── styleAutomation.js
│   │   ├── theme.js
│   │   ├── visibilityFreezer.js
│   │   ├── wallpaperManager.js
│   │   ├── widgetManager.js
│   │   └── zIndexManager.js
│   ├── css/
│   │   ├── base.css
│   │   ├── dock.css
│   │   ├── icon-picker.css
│   │   ├── living-icons.css
│   │   ├── settings.css
│   │   ├── shortcuts.css
│   │   ├── sidebar.css
│   │   ├── theme-overrides.css
│   │   ├── ui-components.css
│   │   └── widgets.css
│   ├── favorites/
│   │   ├── favoritesManager.js
│   │   └── thumbnail.js
│   ├── ui/
│   │   ├── contextMenu.js
│   │   ├── dock.js
│   │   ├── globalSettings.js
│   │   ├── iconPicker.js
│   │   ├── livingIcons.js
│   │   ├── saveModal.js
│   │   └── sidebar.js
│   ├── desktop.css
│   ├── desktop.html
│   ├── desktop.js
│   ├── README.md
│   ├── VCPdesktop介绍文档.md
│   ├── 提示词示例.md
│   └── 桌面图标与启动API指南.md
├── Dicemodules/
│   ├── assets/
│   │   └── dice-box/
│   │       ├── ammo/
│   │       │   └── ammo.wasm.wasm
│   │       ├── sounds/
│   │       │   ├── dicehit/
│   │       │   │   ├── dicehit_coin1.mp3
│   │       │   │   ├── dicehit_coin2.mp3
│   │       │   │   ├── dicehit_coin3.mp3
│   │       │   │   ├── dicehit_coin4.mp3
│   │       │   │   ├── dicehit_coin5.mp3
│   │       │   │   ├── dicehit_coin6.mp3
│   │       │   │   ├── dicehit_metal1.mp3
│   │       │   │   ├── dicehit_metal10.mp3
│   │       │   │   ├── dicehit_metal11.mp3
│   │       │   │   ├── dicehit_metal12.mp3
│   │       │   │   ├── dicehit_metal2.mp3
│   │       │   │   ├── dicehit_metal3.mp3
│   │       │   │   ├── dicehit_metal4.mp3
│   │       │   │   ├── dicehit_metal5.mp3
│   │       │   │   ├── dicehit_metal6.mp3
│   │       │   │   ├── dicehit_metal7.mp3
│   │       │   │   ├── dicehit_metal8.mp3
│   │       │   │   ├── dicehit_metal9.mp3
│   │       │   │   ├── dicehit_plastic1.mp3
│   │       │   │   ├── dicehit_plastic10.mp3
│   │       │   │   ├── dicehit_plastic11.mp3
│   │       │   │   ├── dicehit_plastic12.mp3
│   │       │   │   ├── dicehit_plastic13.mp3
│   │       │   │   ├── dicehit_plastic14.mp3
│   │       │   │   ├── dicehit_plastic15.mp3
│   │       │   │   ├── dicehit_plastic2.mp3
│   │       │   │   ├── dicehit_plastic3.mp3
│   │       │   │   ├── dicehit_plastic4.mp3
│   │       │   │   ├── dicehit_plastic5.mp3
│   │       │   │   ├── dicehit_plastic6.mp3
│   │       │   │   ├── dicehit_plastic7.mp3
│   │       │   │   ├── dicehit_plastic8.mp3
│   │       │   │   ├── dicehit_plastic9.mp3
│   │       │   │   ├── dicehit_wood1.mp3
│   │       │   │   ├── dicehit_wood10.mp3
│   │       │   │   ├── dicehit_wood11.mp3
│   │       │   │   ├── dicehit_wood12.mp3
│   │       │   │   ├── dicehit_wood2.mp3
│   │       │   │   ├── dicehit_wood3.mp3
│   │       │   │   ├── dicehit_wood4.mp3
│   │       │   │   ├── dicehit_wood5.mp3
│   │       │   │   ├── dicehit_wood6.mp3
│   │       │   │   ├── dicehit_wood7.mp3
│   │       │   │   ├── dicehit_wood8.mp3
│   │       │   │   └── dicehit_wood9.mp3
│   │       │   └── surfaces/
│   │       │       ├── surface_felt1.mp3
│   │       │       ├── surface_felt2.mp3
│   │       │       ├── surface_felt3.mp3
│   │       │       ├── surface_felt4.mp3
│   │       │       ├── surface_felt5.mp3
│   │       │       ├── surface_felt6.mp3
│   │       │       ├── surface_felt7.mp3
│   │       │       ├── surface_metal1.mp3
│   │       │       ├── surface_metal2.mp3
│   │       │       ├── surface_metal3.mp3
│   │       │       ├── surface_metal4.mp3
│   │       │       ├── surface_metal5.mp3
│   │       │       ├── surface_metal6.mp3
│   │       │       ├── surface_metal7.mp3
│   │       │       ├── surface_metal8.mp3
│   │       │       ├── surface_metal9.mp3
│   │       │       ├── surface_wood_table1.mp3
│   │       │       ├── surface_wood_table2.mp3
│   │       │       ├── surface_wood_table3.mp3
│   │       │       ├── surface_wood_table4.mp3
│   │       │       ├── surface_wood_table5.mp3
│   │       │       ├── surface_wood_table6.mp3
│   │       │       ├── surface_wood_table7.mp3
│   │       │       ├── surface_wood_tray1.mp3
│   │       │       ├── surface_wood_tray2.mp3
│   │       │       ├── surface_wood_tray3.mp3
│   │       │       ├── surface_wood_tray4.mp3
│   │       │       ├── surface_wood_tray5.mp3
│   │       │       ├── surface_wood_tray6.mp3
│   │       │       └── surface_wood_tray7.mp3
│   │       └── themes/
│   │           ├── blueGreenMetal/
│   │           │   ├── diffuse.jpg
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   ├── roughness.jpg
│   │           │   ├── smoothDice.json
│   │           │   └── theme.config.json
│   │           ├── default/
│   │           │   ├── default.json
│   │           │   ├── diffuse-dark.png
│   │           │   ├── diffuse-light.png
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   ├── specular.jpg
│   │           │   └── theme.config.json
│   │           ├── default-extras/
│   │           │   ├── dark.png
│   │           │   ├── default-extras.json
│   │           │   ├── light.png
│   │           │   ├── normal-extras.png
│   │           │   ├── package.json
│   │           │   └── theme.config.json
│   │           ├── diceOfRolling/
│   │           │   ├── diffuse.jpg
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   ├── smoothDice.json
│   │           │   ├── specularity.jpg
│   │           │   └── theme.config.json
│   │           ├── diceOfRolling-fate/
│   │           │   ├── diffuse.jpg
│   │           │   ├── fate-die.json
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   ├── specularity.jpg
│   │           │   └── theme.config.json
│   │           ├── gemstone/
│   │           │   ├── gemstone-dark.png
│   │           │   ├── gemstone-light.png
│   │           │   ├── gemstone.json
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   └── theme.config.json
│   │           ├── gemstoneMarble/
│   │           │   ├── diffuse.jpg
│   │           │   ├── gemstone.json
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   ├── roughness.jpg
│   │           │   └── theme.config.json
│   │           ├── genesys/
│   │           │   ├── diffuse.png
│   │           │   ├── genesys.json
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   ├── specular.png
│   │           │   └── theme.config.json
│   │           ├── rock/
│   │           │   ├── diffuse-dark.png
│   │           │   ├── diffuse-light.png
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   ├── smoothDice.json
│   │           │   ├── specularity.jpg
│   │           │   └── theme.config.json
│   │           ├── rust/
│   │           │   ├── diffuse-dark.png
│   │           │   ├── diffuse-light.png
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   ├── specular.jpg
│   │           │   └── theme.config.json
│   │           ├── smooth/
│   │           │   ├── diffuse-dark.png
│   │           │   ├── diffuse-light.png
│   │           │   ├── normal.png
│   │           │   ├── package.json
│   │           │   ├── smoothDice.json
│   │           │   └── theme.config.json
│   │           ├── smooth-pip/
│   │           │   ├── package.json
│   │           │   ├── pips-dark.png
│   │           │   ├── pips-light.png
│   │           │   ├── pips-normal.png
│   │           │   ├── smooth-pip.json
│   │           │   └── theme.config.json
│   │           └── wooden/
│   │               ├── diffuse.jpg
│   │               ├── normal.png
│   │               ├── package.json
│   │               ├── smoothDice.json
│   │               ├── specularity.jpg
│   │               └── theme.config.json
│   ├── dice-soundscape.js
│   ├── dice.css
│   ├── dice.html
│   └── dice.js
├── docs/
│   ├── archive/
│   │   └── 2026-08-chat-kernel-and-ui-roadmaps/
│   │       ├── chat-kernel-deep-decoupling-roadmap-history.md
│   │       ├── chat-kernel-rendering-roadmap.md
│   │       ├── chat-kernel-vd-roadmap-review.md
│   │       ├── next-ui-webawesome-roadmap.md
│   │       ├── README.md
│   │       └── ui-applications-webawesome-migration-plan.md
│   ├── contracts/
│   │   ├── generated/
│   │   │   └── chat-event-graph.json
│   │   ├── snapshots/
│   │   │   ├── chat-stream-cancel.json
│   │   │   ├── chat-stream-discarded.json
│   │   │   ├── chat-stream-failed.json
│   │   │   └── chat-stream.json
│   │   ├── chat-contract.schema.json
│   │   ├── chat-contracts.json
│   │   └── README.md
│   ├── research/
│   │   └── settings-schema-render-plan.md
│   ├── appearance-design-system.md
│   ├── chat-event-producer-consumer-roadmap.md
│   ├── chat-kernel-consumer-report.json
│   ├── chat-kernel-deep-decoupling-roadmap.md
│   ├── chat-kernel-evidence-and-contracts-roadmap.md
│   ├── chat-kernel-vd7-final-audit.md
│   ├── classic-retirement-architecture.md
│   ├── classic-retirement-inventory.md
│   ├── deepseek-harness-plugin-ui-architecture-research.md
│   ├── deepseek-harness-ui-ux-research.md
│   ├── design-system-upstream-pr-convergence.md
│   ├── global-settings-section-ownership.md
│   ├── HTML-JS-CSS-EXE文件分布.md
│   ├── JEV智能群聊施工图.md
│   ├── jev调用文档.md
│   ├── main-chat-operation-sequence-testing.md
│   ├── MAIN_CHAT_VOICE_COMPOSER_ARCHITECTURE.md
│   ├── music-stage-core-visualizers-implementation-plan.md
│   ├── next-ui-current-state.md
│   ├── next-ui-development-roadmap.md
│   ├── next-ui-lifecycle-architecture.md
│   ├── project-entrypoints.md
│   ├── projectforge-ast-indexer-blueprint.md
│   ├── projectforge-devlog.md
│   ├── projectforge-git-sidebar-devlog.md
│   ├── settings-autosave-coordinator-acceptance.md
│   ├── settings-autosave-coordinator-development-plan.md
│   ├── settings-autosave-coordinator-handoff.md
│   ├── settings-ui-pr-scope-2026-08-31.md
│   ├── stream-switch-tool-wait-recovery.md
│   ├── technical-debt.md
│   ├── ui-active-surface-policy.md
│   ├── ui-components-wa-matrix.md
│   ├── ui-engineering-standard.md
│   ├── ui-harness-external-evidence-checklist.md
│   ├── ui-interaction-accessibility-gaps.md
│   ├── ui-interaction-accessibility-roadmap.md
│   ├── ui-system-qa-matrix.md
│   ├── ui-system.md
│   ├── upstream-function-parity.md
│   ├── vcpchat-bootstrap-completion-audit.md
│   ├── vcpchat-bootstrap-contracts.md
│   ├── vcpchat-hermes-inspired-launcher-roadmap.md
│   ├── vcpchat-installer-commercial-readiness.md
│   ├── vcpchat-launcher-user-guide.md
│   ├── vcpchat-managed-launch-architecture.md
│   ├── vcpchat-tauri-installer-development-plan.md
│   ├── WINDOW_PIN_ARCHITECTURE.md
│   └── workspace-management-devlog.md
├── examples/
│   └── animated-launchpad/
│       └── index.html
├── Flowlockmodules/
│   ├── flowlock-integration.js
│   ├── flowlock-protocol.js
│   ├── flowlock.css
│   ├── flowlock.js
│   └── README.md
├── font-compat-output/
│   ├── FZCuHeiSong-Compat-Regular.ttf
│   ├── FZCuYaSongGBK-Compat-Regular.ttf
│   ├── FZLiBian-Compat-Regular.ttf
│   ├── FZQingKeBenYueSong-Compat-Regular.ttf
│   ├── FZShuTi-Compat-Regular.ttf
│   ├── FZSongKeBenXiuKai-Compat-Regular.ttf
│   └── FZYaoTi-Compat-Regular.ttf
├── Forummodules/
│   ├── forum.css
│   ├── forum.html
│   ├── forum.js
│   └── README.md
├── Groupmodules/
│   ├── modes/
│   │   ├── baseChatMode.js
│   │   ├── inviteOnlyMode.js
│   │   ├── jevDecisionMode.js
│   │   ├── natureRandomMode.js
│   │   └── sequentialMode.js
│   ├── groupchat.js
│   ├── groupContextWindow.js
│   ├── grouprenderer.js
│   ├── jevGroupSessionOrchestrator.js
│   └── topicTitleManager.js
├── launchers/
│   ├── VCPChat-Launcher.command
│   ├── VCPChat-Launcher.sh
│   ├── VCPChat-Launcher.vbs
│   └── VCPChat-Setup.command
├── Logmodules/
│   ├── log.css
│   ├── log.html
│   └── log.js
├── Loommodules/
│   ├── device-menu.html
│   ├── manager.html
│   └── shell.html
├── Memomodules/
│   ├── memo-graph.js
│   ├── memo-workbench.js
│   ├── memo.css
│   ├── memo.html
│   └── memo.js
├── migration/
│   ├── migrateAvatars.js
│   └── 头像迁移脚本readme.md
├── modules/
│   ├── assistant/
│   │   └── assistant-rust-adapter.js
│   ├── bootstrap/
│   │   ├── bootstrap-marker.js
│   │   ├── command-invocation.js
│   │   ├── contracts.js
│   │   ├── diagnostic-report.js
│   │   ├── environment-doctor.js
│   │   ├── launch-protocol.js
│   │   ├── packed-runtime.js
│   │   ├── platform-process.js
│   │   ├── process-runner.js
│   │   ├── progress-protocol.js
│   │   ├── repair-manifest.js
│   │   ├── repair-planner.js
│   │   ├── runtime-closure.js
│   │   ├── update-downloader.js
│   │   └── update-manager.js
│   ├── chat/
│   │   ├── chatContext.js
│   │   ├── chatDomRenderer.js
│   │   ├── chatEventContract.js
│   │   ├── chatHistoryMutationAuthority.js
│   │   ├── chatHistoryPersistence.js
│   │   ├── chatOperation.js
│   │   ├── chatPluginManifest.js
│   │   ├── chatPresentationSkin.js
│   │   ├── chatPresentationState.js
│   │   ├── chatRepository.js
│   │   ├── chatSurface.js
│   │   ├── chatSurfaceSlots.js
│   │   ├── chatThemePlugin.js
│   │   ├── contentModes.js
│   │   ├── contentRuntime.js
│   │   ├── contentTransforms.js
│   │   ├── mainChatStateAuthority.js
│   │   ├── memoryChatRepository.js
│   │   ├── singleChatRequestOrchestrator.js
│   │   ├── streamConsumerRegistry.js
│   │   ├── streamCoordinator.js
│   │   ├── streamSession.js
│   │   ├── streamTransientHistory.js
│   │   ├── surfaceConversation.js
│   │   └── vcpStreamBridge.js
│   ├── ipc/
│   │   ├── dotnet/
│   │   │   └── LibreHardwareMonitorBridge/
│   │   │       ├── LibreHardwareMonitorBridge.csproj
│   │   │       └── Startup.cs
│   │   ├── agentHandlers.js
│   │   ├── assistantHandlers.js
│   │   ├── canvasHandlers.js
│   │   ├── chartHandlers.js
│   │   ├── chatHandlers.js
│   │   ├── deepWikiHandlers.js
│   │   ├── desktopHandlers.js
│   │   ├── desktopMetrics.js
│   │   ├── desktopRemoteHandlers.js
│   │   ├── diceHandlers.js
│   │   ├── docxHandlers.js
│   │   ├── emoticonHandlers.js
│   │   ├── fileDialogHandlers.js
│   │   ├── forumHandlers.js
│   │   ├── gitHandlers.js
│   │   ├── groupChatHandlers.js
│   │   ├── ipcContracts.js
│   │   ├── libreHardwareMonitorBridge.js
│   │   ├── localSttHandlers.js
│   │   ├── mainChatVoiceCoordinator.js
│   │   ├── memoHandlers.js
│   │   ├── musicHandlers.js
│   │   ├── notesHandlers.js
│   │   ├── projectForgeHandlers.js
│   │   ├── promptHandlers.js
│   │   ├── ragHandlers.js
│   │   ├── regexHandlers.js
│   │   ├── settingsHandlers.js
│   │   ├── sourceHandlers.js
│   │   ├── sovitsHandlers.js
│   │   ├── tavernHandlers.js
│   │   ├── themeHandlers.js
│   │   ├── translatorHandlers.js
│   │   ├── voiceHandlers.js
│   │   ├── windowHandlers.js
│   │   └── workspaceHandlers.js
│   ├── loom/
│   │   ├── webcore/
│   │   │   ├── adapter-contract.js
│   │   │   ├── chrome-adapter.js
│   │   │   ├── comfyui-main-world-bridge.js
│   │   │   ├── comfyui-page-adapter.js
│   │   │   ├── electron-adapter.js
│   │   │   ├── index.js
│   │   │   ├── web-agent-page-core.js
│   │   │   ├── web-agent-page-runtime-core.js
│   │   │   ├── web-agent-protocol.js
│   │   │   ├── web-agent-runtime-core.js
│   │   │   └── 后端运行时参考协议-plugin-manifest.json
│   │   └── VCPLoomManager.js
│   ├── lyrics/
│   │   ├── krcDecrypt.js
│   │   ├── lyricFetcherUnified.js
│   │   ├── matchScore.js
│   │   ├── parserCore.js
│   │   └── qrcDecrypt.js
│   ├── renderer/
│   │   ├── animation.js
│   │   ├── colorUtils.js
│   │   ├── composerModelSelect.js
│   │   ├── contentPipeline.js
│   │   ├── contentProcessor.js
│   │   ├── desktopPushConsumer.js
│   │   ├── domBuilder.js
│   │   ├── domListenerOwner.js
│   │   ├── emoticonUrlFixer.js
│   │   ├── enhancedColorUtils.js
│   │   ├── forwardMessageOwner.js
│   │   ├── imageHandler.js
│   │   ├── jevToolUse.js
│   │   ├── mainChatAttachmentOwner.js
│   │   ├── mainChatAuxiliaryEventOwner.js
│   │   ├── mainChatComposition.js
│   │   ├── mainChatDomBindings.js
│   │   ├── mainChatEventBridge.js
│   │   ├── mainChatFlowlockOwner.js
│   │   ├── mainChatSendOwner.js
│   │   ├── mainChatSettingsOwner.js
│   │   ├── mainChatSettingsPresentationOwner.js
│   │   ├── mainChatStreamConsumer.js
│   │   ├── mainChatSurfaceAdapter.js
│   │   ├── mainChatThemeOwner.js
│   │   ├── markdownCodeDomainScanner.js
│   │   ├── messageContextMenu.js
│   │   ├── middleClickHandler.js
│   │   ├── nonStreamingEventConsumer.js
│   │   ├── ownedPreloadSubscription.js
│   │   ├── pretext-bridge.js
│   │   ├── pretext.bundle.js
│   │   ├── pretext.esm.js
│   │   ├── renderDependencies.js
│   │   ├── renderSessionAuthority.js
│   │   ├── streamManager.js
│   │   ├── streamProjectionRuntime.js
│   │   ├── surfaceTaskOwner.js
│   │   ├── toolRequestScanner.js
│   │   ├── toolResultRegions.js
│   │   ├── topicSelectionReadiness.js
│   │   ├── ttsSurfaceOwner.js
│   │   ├── visibilityOptimizer.js
│   │   └── windowStreamRuntime.js
│   ├── services/
│   │   ├── chatDataService/
│   │   │   ├── client.js
│   │   │   ├── index.js
│   │   │   └── lifecycle.js
│   │   ├── attachmentDialogState.js
│   │   ├── chartDataSourceService.js
│   │   ├── chartService.js
│   │   ├── deepWikiService.js
│   │   ├── embeddedAppSessionManager.js
│   │   ├── gitService.js
│   │   ├── globalJevService.js
│   │   ├── historyMutationQueue.js
│   │   ├── historyWatcherLeaseManager.js
│   │   ├── jevClient.js
│   │   ├── networkNotesCacheStore.js
│   │   ├── pluginAgentOperationService.js
│   │   ├── preloadPaths.js
│   │   ├── scriptoriumAgentControlService.js
│   │   ├── scriptoriumFontCacheService.js
│   │   ├── scriptoriumImportService.js
│   │   ├── scriptoriumPptxImportService.js
│   │   ├── senderTaskRegistry.js
│   │   ├── sourceService.js
│   │   ├── windowAppIds.js
│   │   ├── windowPinService.js
│   │   ├── windowService.js
│   │   ├── windowStateService.js
│   │   ├── workspaceIndex.js
│   │   └── workspacePromptPlaceholders.js
│   ├── settings/
│   │   ├── render/
│   │   │   ├── canonical-row.js
│   │   │   ├── field-renderer.js
│   │   │   ├── shared.js
│   │   │   └── widgets.js
│   │   ├── schema/
│   │   │   ├── advanced-features.js
│   │   │   ├── appearance-settings.js
│   │   │   ├── jev-service.js
│   │   │   ├── kernel.js
│   │   │   ├── local-stt-panel.js
│   │   │   ├── quick-actions.js
│   │   │   ├── render-settings.js
│   │   │   ├── selection-assistant.js
│   │   │   ├── server-connection.js
│   │   │   ├── sidebar-surfaces.js
│   │   │   ├── user-identity.js
│   │   │   ├── voice-settings.js
│   │   │   └── workspace-management.js
│   │   ├── schema-surface.js
│   │   ├── store.js
│   │   └── value-semantics.js
│   ├── shared/
│   │   └── embeddedAppAllowlist.js
│   ├── ui-system/
│   │   ├── next-shell/
│   │   │   ├── account-menu-controller.js
│   │   │   ├── app-tab-host.js
│   │   │   ├── assistant-search-controller.js
│   │   │   ├── creation-controller.js
│   │   │   ├── embedded-app-controller.js
│   │   │   ├── escape-dispatcher.js
│   │   │   ├── launchpad-controller.js
│   │   │   ├── launchpad-icon-art.js
│   │   │   ├── launchpad-icons.js
│   │   │   ├── next-shell-controller.js
│   │   │   ├── notification-menu-controller.js
│   │   │   └── overlay-coordinator.js
│   │   ├── settings/
│   │   │   ├── agent-disclosures.js
│   │   │   ├── agent-model-picker-directory.js
│   │   │   ├── agent-model-picker.js
│   │   │   ├── appearance-ranges.js
│   │   │   ├── appearance-toggles.js
│   │   │   ├── autosave.js
│   │   │   ├── bridge-shared.js
│   │   │   ├── dependent-rows.js
│   │   │   ├── field-registry.js
│   │   │   ├── forum-controls.js
│   │   │   ├── global-input-upgrades.js
│   │   │   ├── global-language-rows.js
│   │   │   ├── group-slots.js
│   │   │   ├── home-controls.js
│   │   │   ├── identity-controls.js
│   │   │   ├── marker-registry.js
│   │   │   ├── pipeline.js
│   │   │   ├── render-visibility.js
│   │   │   ├── save-coordinator.js
│   │   │   ├── section-ownership.js
│   │   │   ├── select-projection.js
│   │   │   ├── settings-sidebar-runtime.js
│   │   │   ├── settings-sidebar-slots.js
│   │   │   └── settings-sidebar-surface.js
│   │   ├── appearance-engine.js
│   │   ├── appearance-profile-runtime.js
│   │   ├── appearance-studio.js
│   │   ├── ask-nova-modal.js
│   │   ├── avatar-picker.js
│   │   ├── component-manifest.js
│   │   ├── component-showcase.js
│   │   ├── contribution-registry.js
│   │   ├── interactive-chat-app.js
│   │   ├── lifecycle-inspector.js
│   │   ├── lifecycle-scope.js
│   │   ├── lucide-adapter.js
│   │   ├── material-runtime.js
│   │   ├── next-ui-apps.js
│   │   ├── performance-recorder.js
│   │   ├── settings-bridge.js
│   │   ├── settlement.js
│   │   ├── sidebar-resizer.js
│   │   ├── standalone-chat-app.js
│   │   ├── startup-theme-gate.js
│   │   ├── state-channel.js
│   │   ├── surface-controller.js
│   │   ├── task-handle.js
│   │   ├── theme-runtime.js
│   │   ├── typed-field-owners.js
│   │   ├── ui-surface-policy.js
│   │   ├── vcp-icons.js
│   │   ├── vcp-icons.MIT.txt
│   │   ├── vcp-main-ui-runtime.js
│   │   ├── vcp-ui.js
│   │   ├── webawesome-adapter.js
│   │   ├── webawesome-comparison.js
│   │   └── webawesome-runtime-manifest.js
│   ├── uiux/
│   │   ├── generated/
│   │   │   ├── adapters/
│   │   │   │   ├── assistant-runtime.js
│   │   │   │   ├── forum-config.js
│   │   │   │   ├── rust-assistant.js
│   │   │   │   └── settings.js
│   │   │   ├── lab/
│   │   │   │   └── primitive-lab.js
│   │   │   ├── primitives/
│   │   │   │   ├── agent-model-picker.js
│   │   │   │   ├── agent-preset-row.js
│   │   │   │   ├── agent-preset-seat.js
│   │   │   │   ├── button.js
│   │   │   │   ├── choice.js
│   │   │   │   ├── color-pair.js
│   │   │   │   ├── connection-banner.js
│   │   │   │   ├── diff-block.js
│   │   │   │   ├── directory-browser.js
│   │   │   │   ├── disclosure-row.js
│   │   │   │   ├── field.js
│   │   │   │   ├── font-size-row.js
│   │   │   │   ├── hover-card.js
│   │   │   │   ├── input.js
│   │   │   │   ├── language-row.js
│   │   │   │   ├── menu.js
│   │   │   │   ├── modal.js
│   │   │   │   ├── numeric-stepper-row.js
│   │   │   │   ├── onboarding-surface.js
│   │   │   │   ├── pill.js
│   │   │   │   ├── popup-select.js
│   │   │   │   ├── range.js
│   │   │   │   ├── risk-confirmation.js
│   │   │   │   ├── select.js
│   │   │   │   ├── semantic-icon.js
│   │   │   │   ├── state-dot.js
│   │   │   │   ├── toast.js
│   │   │   │   ├── toggle.js
│   │   │   │   └── tooltip.js
│   │   │   ├── providers/
│   │   │   │   └── theme.js
│   │   │   ├── runtime/
│   │   │   │   ├── dom-renderer.js
│   │   │   │   ├── scope.js
│   │   │   │   └── service-registry.js
│   │   │   ├── browser-entry.js
│   │   │   ├── contracts.js
│   │   │   └── index.js
│   │   └── runtime/
│   │       └── dom-renderer.js
│   ├── utils/
│   │   ├── agentConfigManager.js
│   │   └── appSettingsManager.js
│   ├── voice/
│   │   ├── localStt/
│   │   │   ├── assets.json
│   │   │   ├── localSttService.js
│   │   │   ├── modelManager.js
│   │   │   └── sttWorker.js
│   │   ├── audioRecorder.js
│   │   ├── chatVoiceComposer.js
│   │   ├── passiveVoiceSentinel.js
│   │   ├── speechDirectiveMatcher.js
│   │   ├── voice-input-engine-adapter.js
│   │   ├── voiceComposerView.js
│   │   ├── voiceWaveform.js
│   │   └── wavAudioEncoder.js
│   ├── chatManager.js
│   ├── contextSanitizer.js
│   ├── DASP.txt
│   ├── emoticonManager.js
│   ├── event-listeners.js
│   ├── fileManager.js
│   ├── filterManager.js
│   ├── global-settings-manager.js
│   ├── image-viewer.html
│   ├── image-viewer.js
│   ├── inputEnhancer.js
│   ├── interruptHandler.js
│   ├── itemListManager.js
│   ├── lyricFetcher.js
│   ├── mainChatCommands.js
│   ├── messageRenderer.js
│   ├── modelUsageTracker.js
│   ├── musicScannerWorker.js
│   ├── notificationRenderer.js
│   ├── searchManager.js
│   ├── settingsManager.js
│   ├── SovitsTTS.js
│   ├── speechRecognizer.js
│   ├── tavernRulesEngine.js
│   ├── text-viewer.html
│   ├── text-viewer.js
│   ├── topicListManager.js
│   ├── topicSummarizer.js
│   ├── topTabManager.js
│   ├── trayManager.js
│   ├── ui-helpers.js
│   ├── uiManager.js
│   ├── vcpClient.js
│   ├── weatherService.js
│   └── webdavManager.js
├── Musicmodules/
│   ├── music-stage/
│   │   ├── modes/
│   │   │   ├── cadenza-manager.js
│   │   │   ├── diorama-camera.js
│   │   │   ├── diorama-director.js
│   │   │   ├── diorama-events.js
│   │   │   ├── diorama-lyrics.js
│   │   │   ├── diorama-manager.js
│   │   │   ├── diorama-optics.js
│   │   │   ├── diorama-stations.js
│   │   │   ├── diorama-world.js
│   │   │   ├── fume-manager.js
│   │   │   ├── luminous-manager.js
│   │   │   ├── partita-manager.js
│   │   │   ├── sonnet-manager.js
│   │   │   ├── sonnet-pixi-core.js
│   │   │   ├── stage-lyric-decor.js
│   │   │   ├── stage-lyric-layout.js
│   │   │   ├── stage-lyric-performance.css
│   │   │   ├── stage-lyric-performance.js
│   │   │   ├── stage-mode-utils.js
│   │   │   ├── stage-pixi-effects.js
│   │   │   ├── tempera-manager.js
│   │   │   ├── tempera-pixi-core.js
│   │   │   └── tunnel-manager.js
│   │   ├── DIORAMA-DIRECTION.md
│   │   ├── LYRIC-PERFORMANCE-PORT.md
│   │   ├── music-stage-advanced-modes.js
│   │   ├── music-stage-config.js
│   │   ├── music-stage-host.js
│   │   ├── music-stage-modes.js
│   │   ├── music-stage-runtime.js
│   │   ├── music-stage.css
│   │   └── OPTICAL-PORT.md
│   ├── music-ambient-pixi.js
│   ├── music-effects.js
│   ├── music-lyrics.js
│   ├── music-output.js
│   ├── music-player.js
│   ├── music-sidebar.js
│   ├── music-ui.js
│   ├── music-utils.js
│   ├── music-visualizer.js
│   ├── music-webdav.js
│   ├── music.css
│   ├── music.html
│   ├── music.js
│   ├── README.md
│   ├── socket.io.min.js
│   └── STAGE_UPDATE_NOTES.md
├── NativeSpalash/
│   ├── src/
│   │   ├── main.rs
│   │   ├── ZiHun219Hao-MengQuLuoLiTi-2.ttf
│   │   └── 蒙纳简漫画体.ttf
│   ├── .gitignore
│   ├── build.rs
│   ├── build_and_deploy.bat
│   └── Cargo.toml
├── Notemodules/
│   ├── notemini.css
│   ├── notemini.html
│   ├── notemini.js
│   ├── notes.css
│   ├── notes.html
│   └── notes.js
├── PluginManagerModules/
│   ├── plugin-manager.css
│   ├── plugin-manager.html
│   └── plugin-manager.js
├── preloads/
│   ├── api/
│   │   ├── agents.js
│   │   ├── askNova.js
│   │   ├── assistant.js
│   │   ├── canvas.js
│   │   ├── chat.js
│   │   ├── desktop.js
│   │   ├── dice.js
│   │   ├── embeddedApps.js
│   │   ├── emoticons.js
│   │   ├── files.js
│   │   ├── flowlock.js
│   │   ├── forum.js
│   │   ├── groupChat.js
│   │   ├── localStt.js
│   │   ├── loom.js
│   │   ├── memo.js
│   │   ├── music.js
│   │   ├── notes.js
│   │   ├── plugins.js
│   │   ├── projectForge.js
│   │   ├── prompts.js
│   │   ├── rag.js
│   │   ├── settings.js
│   │   ├── tavern.js
│   │   ├── theme.js
│   │   ├── vcpLog.js
│   │   ├── voice.js
│   │   ├── window.js
│   │   └── workspaces.js
│   ├── behaviors/
│   │   ├── embeddedSurface.js
│   │   └── pinButton.js
│   ├── core/
│   │   ├── define.js
│   │   ├── expose.js
│   │   └── registry.js
│   ├── chart.js
│   ├── chat.js
│   ├── desktop.js
│   ├── docx.js
│   ├── loom-page.js
│   ├── loom.js
│   ├── README.md
│   ├── utility.js
│   └── voice-input-capture.js
├── ProjectForgemodules/
│   ├── projectforge-git.js
│   ├── projectforge-sidetabs.js
│   ├── projectforge-source.js
│   ├── projectforge.css
│   ├── projectforge.html
│   └── projectforge.js
├── Promptmodules/
│   ├── IMPROVEMENTS.md
│   ├── modular-prompt-module.js
│   ├── original-prompt-module.js
│   ├── preset-prompt-module.js
│   ├── prompt-manager.js
│   ├── prompt-modules.css
│   └── README.md
├── public/
│   └── assets/
│       ├── ammo/
│       │   └── ammo.wasm.wasm
│       └── themes/
│           └── default/
│               ├── default.json
│               ├── diffuse-dark.png
│               ├── diffuse-light.png
│               ├── normal.png
│               ├── specular.jpg
│               └── theme.config.json
├── RAGmodules/
│   ├── rag-observer-config.js
│   ├── RAG_Observer.html
│   └── RAG_Overlay.html
├── RMMusic/
│   ├── NORD/
│   │   ├── @Resources/
│   │   │   ├── Fonts/
│   │   │   │   └── SourceCodePro-Regular.ttf
│   │   │   ├── Images/
│   │   │   │   ├── 0.png
│   │   │   │   ├── 1.png
│   │   │   │   ├── 2.png
│   │   │   │   ├── 3.png
│   │   │   │   ├── 4.png
│   │   │   │   ├── Pause.png
│   │   │   │   ├── Play.png
│   │   │   │   ├── progress.png
│   │   │   │   ├── progress_s.png
│   │   │   │   └── volumebar.png
│   │   │   └── Variables.inc
│   │   ├── Music Player/
│   │   │   └── NORD Dark Music Player.ini
│   │   ├── Volume Control/
│   │   │   ├── Bright Volume Control.ini
│   │   │   └── Dark Volume Control.ini
│   │   └── Config.ini
│   └── FrostedGlass Plugin_1.2.0.rmskin
├── rust_assistant_engine/
│   ├── runtime/
│   │   ├── assistant_core_server-Linux-X64/
│   │   │   └── assistant_core_server-linux-x64
│   │   ├── assistant_core_server-macOS-ARM64/
│   │   │   └── assistant_core_server-macos-x64
│   │   └── assistant_core_server-Windows-X64/
│   │       └── assistant_core_server-windows-x64.exe
│   ├── src/
│   │   ├── capture.rs
│   │   ├── capture_linux_wayland.rs
│   │   ├── capture_linux_x11.rs
│   │   ├── capture_linux_x11_event.rs
│   │   ├── capture_macos.rs
│   │   ├── linux_platform.rs
│   │   ├── main.rs
│   │   ├── metrics.rs
│   │   ├── uia_selection_provider.rs
│   │   └── windows_event_source.rs
│   ├── ui/
│   │   ├── assistant-bar.html
│   │   ├── assistant-bar.js
│   │   ├── assistant.css
│   │   ├── assistant.html
│   │   └── assistant.js
│   └── Cargo.toml
├── rust_audio_engine/
│   ├── pkgconfig/
│   │   └── libpkgconf.pc
│   ├── scripts/
│   │   └── build_all.ps1
│   ├── src/
│   │   ├── player/
│   │   │   ├── audio_thread.rs
│   │   │   ├── callback.rs
│   │   │   ├── gapless.rs
│   │   │   ├── mod.rs
│   │   │   ├── spectrum.rs
│   │   │   └── state.rs
│   │   ├── processor/
│   │   │   ├── adapters/
│   │   │   │   ├── convolver/
│   │   │   │   │   ├── control.rs
│   │   │   │   │   ├── handoff.rs
│   │   │   │   │   └── tests.rs
│   │   │   │   ├── convolver.rs
│   │   │   │   └── tests.rs
│   │   │   ├── convolver/
│   │   │   │   └── tests.rs
│   │   │   ├── dsp_chain/
│   │   │   │   └── tests.rs
│   │   │   ├── dynamic_loudness/
│   │   │   │   └── tests.rs
│   │   │   ├── loudness/
│   │   │   │   ├── atomic_state.rs
│   │   │   │   ├── info.rs
│   │   │   │   ├── limiter.rs
│   │   │   │   ├── meter.rs
│   │   │   │   └── normalizer.rs
│   │   │   ├── output_chain/
│   │   │   │   └── tests.rs
│   │   │   ├── resampler/
│   │   │   │   ├── contiguous_polyphase_backend.rs
│   │   │   │   ├── halfband_backend.rs
│   │   │   │   ├── mod.rs
│   │   │   │   ├── polyphase_backend.rs
│   │   │   │   ├── rubato_backend.rs
│   │   │   │   └── spectral_backend.rs
│   │   │   ├── saturation/
│   │   │   │   └── tests.rs
│   │   │   ├── traits/
│   │   │   │   └── tests.rs
│   │   │   ├── adapters.rs
│   │   │   ├── atomic_f64.rs
│   │   │   ├── convolver.rs
│   │   │   ├── crossfeed.rs
│   │   │   ├── dsp.rs
│   │   │   ├── dsp_chain.rs
│   │   │   ├── dynamic_loudness.rs
│   │   │   ├── eq.rs
│   │   │   ├── fir_design.rs
│   │   │   ├── fir_eq.rs
│   │   │   ├── lockfree_params.rs
│   │   │   ├── loudness.rs
│   │   │   ├── loudness_db.rs
│   │   │   ├── mod.rs
│   │   │   ├── output_chain.rs
│   │   │   ├── saturation.rs
│   │   │   ├── spectrum.rs
│   │   │   └── traits.rs
│   │   ├── server/
│   │   │   ├── effects.rs
│   │   │   ├── playback.rs
│   │   │   ├── settings_handlers.rs
│   │   │   ├── webdav_handlers.rs
│   │   │   └── ws_handlers.rs
│   │   ├── channel_layout.rs
│   │   ├── config.rs
│   │   ├── decoder.rs
│   │   ├── lib.rs
│   │   ├── main.rs
│   │   ├── runtime.rs
│   │   ├── server.rs
│   │   ├── settings.rs
│   │   ├── wasapi_output.rs
│   │   └── webdav.rs
│   ├── build-runtime.js
│   ├── build.rs
│   ├── Cargo.toml
│   └── README - 副本.md
├── rust_chat_data_service/
│   ├── src/
│   │   ├── config.rs
│   │   ├── domain.rs
│   │   ├── error.rs
│   │   ├── identity.rs
│   │   ├── ingest.rs
│   │   ├── main.rs
│   │   ├── protocol.rs
│   │   ├── search.rs
│   │   ├── storage.rs
│   │   ├── sync.rs
│   │   ├── sync_wire.rs
│   │   └── watcher.rs
│   ├── build-runtime.js
│   ├── Cargo.toml
│   └── README.md
├── rust_projectforge_indexer/
│   ├── src/
│   │   ├── facts.rs
│   │   ├── lang.rs
│   │   ├── main.rs
│   │   ├── scan.rs
│   │   └── symbols.rs
│   ├── bench.js
│   ├── build-runtime.js
│   └── Cargo.toml
├── rust_voice_input_engine/
│   ├── runtime/
│   │   └── win32-x64/
│   │       └── vcp_voice_input_engine.exe
│   ├── src/
│   │   └── main.rs
│   ├── build-runtime.js
│   ├── Cargo.toml
│   └── test-right-alt.ps1
├── ScriptoriumModules/
│   ├── font-font-test.html
│   ├── font-name-diagnostics.json
│   ├── founder-font-conversion-check.json
│   ├── founder-font-summary.json
│   ├── README.md
│   ├── scriptorium-agent-port.js
│   ├── scriptorium-async.js
│   ├── scriptorium-deck-adapter.js
│   ├── scriptorium-deck-editor.js
│   ├── scriptorium-deck-export.js
│   ├── scriptorium-deck-renderer.js
│   ├── scriptorium-document-store.js
│   ├── scriptorium-dom-selection.js
│   ├── scriptorium-edit-history.js
│   ├── scriptorium-export-resources.js
│   ├── scriptorium-export.js
│   ├── scriptorium-find.js
│   ├── scriptorium-flow-adapter.js
│   ├── scriptorium-flow-editor.js
│   ├── scriptorium-flow-export.js
│   ├── scriptorium-flow-renderer.js
│   ├── scriptorium-formatting.js
│   ├── scriptorium-input-sync.js
│   ├── scriptorium-library.js
│   ├── scriptorium-lineage-store.js
│   ├── scriptorium-lineage-ui.js
│   ├── scriptorium-media.js
│   ├── scriptorium-navigation.js
│   ├── scriptorium-network-fonts.js
│   ├── scriptorium-objects.js
│   ├── scriptorium-pagination.js
│   ├── scriptorium-pr-diff.js
│   ├── scriptorium-pretext-bridge.js
│   ├── scriptorium-programmable-content.js
│   ├── scriptorium-render-coordinator.js
│   ├── scriptorium-render-primitives.js
│   ├── scriptorium-rendered-text.js
│   ├── scriptorium-runtime.js
│   ├── scriptorium-runtime.origin.js
│   ├── scriptorium-session.js
│   ├── scriptorium-settings.js
│   ├── scriptorium-shell.js
│   ├── scriptorium-source-editor.js
│   ├── scriptorium-style-ui.js
│   ├── scriptorium-svg-assets.js
│   ├── scriptorium-visibility.js
│   ├── scriptorium.css
│   ├── scriptorium.html
│   ├── scriptorium.js
│   ├── test-style-pack.vstyle.json
│   ├── vdoc-container.js
│   ├── vdoc-core.js
│   ├── vdoc-hybrid-compiler.js
│   ├── vdoc-style-library.js
│   └── vdoc-svg-asset-library.js
├── scripts/
│   ├── fixtures/
│   │   └── chat-contract-invalid.mjs
│   ├── audit-settings-first-open.mjs
│   ├── audit-settings-layout.mjs
│   ├── audit-settings-style-parity.mjs
│   ├── build-chat-event-graph.mjs
│   ├── build-webawesome-runtime.mjs
│   ├── chaos-probe-settings.mjs
│   ├── check-artifact-plane.mjs
│   ├── check-chat-contracts.mjs
│   ├── check-chat-evidence.mjs
│   ├── check-chat-kernel-consumers.mjs
│   ├── check-chat-release-evidence.mjs
│   ├── check-classic-parity.mjs
│   ├── check-classic-retirement-boundary.mjs
│   ├── check-design-system-boundary.mjs
│   ├── check-global-settings-section-ownership.mjs
│   ├── check-next-delta-contract.mjs
│   ├── check-release-surface.mjs
│   ├── check-theme-provenance.mjs
│   ├── check-ui-applications.mjs
│   ├── check-ui-async-state-matrix.mjs
│   ├── check-ui-harness-evidence.mjs
│   ├── check-ui-interaction-inventory.mjs
│   ├── check-ui-system.mjs
│   ├── check-ui-task-journeys.mjs
│   ├── check-uiux-artifacts.mjs
│   ├── check-vcpui-consumers.mjs
│   ├── check-webawesome-pack.mjs
│   ├── check_theme_wallpapers.ps1
│   ├── compare-dual-instance-parity.mjs
│   ├── compare-settings-schema-pixels.mjs
│   ├── css-import-reader.mjs
│   ├── desktopremote-http-smoke.js
│   ├── diagnose-windows-fonts.py
│   ├── electron-builder-bootstrap-hooks.cjs
│   ├── generate_project_tree.py
│   ├── inspect-sidebar-margins.mjs
│   ├── next-delta-shared-baseline.json
│   ├── normalize-opentype-names.py
│   ├── package-portable-installer.mjs
│   ├── probe-avatar-persistence-electron.mjs
│   ├── promote-canonical-ui-css.mjs
│   ├── remove-retired-classic-main-dom.mjs
│   ├── run-chat-contract-invariants.mjs
│   ├── run-electron-node.mjs
│   ├── scriptorium-line-break-diagnostic.js
│   ├── stress-test-settings-full.mjs
│   ├── test-appearance-engine.mjs
│   ├── test-appearance-studio.mjs
│   ├── test-artifact-plane-invalid.mjs
│   ├── test-ask-nova-service.mjs
│   ├── test-built-artifact-smoke.mjs
│   ├── test-chat-contract-invalid.mjs
│   ├── test-chat-evidence-manifest.mjs
│   ├── test-chat-release-evidence-invalid.mjs
│   ├── test-chat-transcript-snapshot.mjs
│   ├── test-electron-lifecycle-stress.mjs
│   ├── test-electron-main-chat-sequences.mjs
│   ├── test-electron-manual-soak.mjs
│   ├── test-electron-ui-apps-smoke.mjs
│   ├── test-electron-windows-matrix.mjs
│   ├── test-facade-registry-invalid.mjs
│   ├── test-next-ui-empty-state.mjs
│   ├── test-next-ui-tab-lifecycle.mjs
│   ├── test-packaged-artifact-invalid.mjs
│   ├── test-packaged-artifact-smoke.mjs
│   ├── test-page-runtime.mjs
│   ├── test-settings-sidebar-parity-electron.mjs
│   ├── test-settings-wa-electron.mjs
│   ├── test-settings-wa.mjs
│   ├── test-top-tab-session.mjs
│   ├── test-ui-motion-contract.mjs
│   ├── test-ui-system.mjs
│   ├── test-vcp-ui-select-proxy.mjs
│   ├── test-webawesome-adapter.mjs
│   ├── ui-async-state-matrix.json
│   ├── ui-interaction-inventory.json
│   ├── ui-task-journey-matrix.json
│   ├── vcpchat-bootstrap.mjs
│   ├── vcpchat-dev-launcher.mjs
│   ├── vcpchat-doctor.mjs
│   ├── vcpchat-packed-smoke.mjs
│   ├── vcpchat-recovery-ui.mjs
│   ├── vcpchat-release-evidence.mjs
│   ├── vcpchat-repair.mjs
│   ├── vcpchat-runtime-closure.mjs
│   ├── vcpchat-update.mjs
│   ├── vcpchat.mjs
│   ├── vcpui-production-consumers.json
│   ├── write-chat-evidence-manifest.mjs
│   └── 检查主题壁纸.ps1
├── SovitsTest/
│   ├── get_models.py
│   ├── GSVI.py
│   ├── my_infer.py
│   ├── output.wav
│   ├── README.md
│   └── test_sovits_api.py
├── styles/
│   ├── setting/
│   │   ├── settings-model-select.css
│   │   ├── settings-regex.css
│   │   ├── settings-search.css
│   │   ├── settings-sidebar-list.css
│   │   └── settings-sidebar-tabs.css
│   ├── themes/
│   │   ├── themesCodeIDE.css
│   │   ├── themesEva.css
│   │   ├── themes冰火魔歌.css
│   │   ├── themes卡提西亚.css
│   │   ├── themes夜樱猫语.css
│   │   ├── themes星咏与狼嗥.css
│   │   ├── themes星渊雪境.css
│   │   ├── themes月影春信.css
│   │   ├── themes极简Aero.css
│   │   ├── themes熊熊假日.css
│   │   ├── themes瓷与锦.css
│   │   ├── themes童趣梦境.css
│   │   ├── themes第一适格者.css
│   │   ├── themes纸墨与机芯.css
│   │   ├── themes绯红天穹.css
│   │   ├── themes赤与白昼.css
│   │   ├── themes酸性玄武.css
│   │   ├── themes雪境晨昏.css
│   │   ├── themes霓虹咖啡.css
│   │   ├── themes静谧森岭.css
│   │   └── themes黑白简约.css
│   ├── ui-system/
│   │   ├── uiux-theme/
│   │   │   ├── semantic.css
│   │   │   └── static-scale.css
│   │   ├── appearance-studio.css
│   │   ├── ask-nova.css
│   │   ├── business-modals.css
│   │   ├── chat-input.css
│   │   ├── components.css
│   │   ├── fonts.css
│   │   ├── group-settings.css
│   │   ├── index.css
│   │   ├── messages.css
│   │   ├── motion.css
│   │   ├── notifications.css
│   │   ├── settings-portal.css
│   │   ├── settings-primitives.css
│   │   ├── settings-shell.css
│   │   ├── settings-sidebar.css
│   │   ├── settings-stream-animation.css
│   │   ├── settings-template.css
│   │   ├── settings.css
│   │   ├── shell.css
│   │   ├── showcase.css
│   │   ├── sidebar.css
│   │   ├── tokens.css
│   │   └── webawesome-adapter.css
│   ├── animations.css
│   ├── appearance.css
│   ├── base.css
│   ├── chat.css
│   ├── compact-sidebar.css
│   ├── components.css
│   ├── layout.css
│   ├── messageRenderer.css
│   ├── notifications.css
│   ├── search.css
│   ├── settings.css
│   ├── themes.css
│   └── ui-next.css
├── Tavernmodules/
│   ├── tavern-manager.js
│   └── tavern.css
├── tests/
│   ├── support/
│   │   └── main-chat-sequence.js
│   ├── account-menu-controller.test.js
│   ├── app-tab-host.test.js
│   ├── assistant-search-controller.test.js
│   ├── attachment-dialog-state.test.js
│   ├── canvas-edit-approval.test.js
│   ├── chart-controller.test.js
│   ├── chart-data-source.test.js
│   ├── chart-service.test.js
│   ├── chat-context.test.mjs
│   ├── chat-dom-renderer.test.mjs
│   ├── chat-event-contract.test.mjs
│   ├── chat-history-mutation-authority.test.mjs
│   ├── chat-history-persistence.test.mjs
│   ├── chat-manager-selection-race.test.js
│   ├── chat-operation.test.mjs
│   ├── chat-plugin-manifest.test.mjs
│   ├── chat-presentation-skin.test.mjs
│   ├── chat-presentation-state.test.mjs
│   ├── chat-repository.test.mjs
│   ├── chat-surface-slots.test.mjs
│   ├── chat-surface.test.mjs
│   ├── chat-theme-plugin.test.mjs
│   ├── content-pipeline.test.mjs
│   ├── content-processor-owner.test.mjs
│   ├── content-runtime.test.mjs
│   ├── contribution-registry.test.js
│   ├── creation-controller.test.js
│   ├── deepmemo-central-adapter.test.js
│   ├── desktop-living-icons.test.js
│   ├── desktop-push-consumer.test.mjs
│   ├── diorama-director.test.js
│   ├── diorama-events.test.js
│   ├── diorama-stations-smoke.cjs
│   ├── dom-listener-owner.test.mjs
│   ├── embedded-app-controller.test.js
│   ├── embedded-app-security.test.js
│   ├── emoticon-fixer-owner.test.mjs
│   ├── emoticon-url-fixer.test.js
│   ├── enhanced-color-utils-lifecycle.test.mjs
│   ├── escape-dispatcher.test.js
│   ├── flowlock-timestamp-bindings.test.js
│   ├── forward-message-owner.test.mjs
│   ├── frontend-plugins.test.js
│   ├── git-service.test.js
│   ├── global-jev-service.test.js
│   ├── global-settings-save.test.mjs
│   ├── group-chat-queue-interrupt.test.js
│   ├── group-context-window.test.js
│   ├── group-jev-decision-mode.test.js
│   ├── group-jev-integration-contract.test.js
│   ├── group-jev-session-orchestrator.test.js
│   ├── group-sequential-mode.test.js
│   ├── group-settings-slots-static.test.mjs
│   ├── history-mutation-queue.test.cjs
│   ├── history-watcher-lease-manager.test.js
│   ├── image-handler-owner.test.mjs
│   ├── input-enhancer-note-keyboard.test.js
│   ├── input-enhancer-owner.test.mjs
│   ├── input-enhancer-workspace-mention.test.js
│   ├── jev-client.test.js
│   ├── jev-tool-use-rendering.test.js
│   ├── launchpad-controller.test.js
│   ├── launchpad-icons.test.js
│   ├── lifecycle-inspector.test.js
│   ├── lifecycle-scope.test.js
│   ├── loom-controller.test.js
│   ├── loom-electron-adapter.test.js
│   ├── loom-manager-runtime.test.js
│   ├── loom-manager-skill-button.test.js
│   ├── loom-persistent-target.test.js
│   ├── loom-skill.test.js
│   ├── lyric-cross-provider-audit.test.js
│   ├── main-chat-attachment-owner.test.js
│   ├── main-chat-attachment-owner.test.mjs
│   ├── main-chat-auxiliary-event-owner.test.mjs
│   ├── main-chat-dom-bindings.test.mjs
│   ├── main-chat-event-bridge.test.mjs
│   ├── main-chat-flowlock-owner.test.mjs
│   ├── main-chat-send-owner.test.mjs
│   ├── main-chat-sequence-model.test.js
│   ├── main-chat-settings-owner.test.mjs
│   ├── main-chat-state-authority.test.mjs
│   ├── main-chat-stream-consumer.test.js
│   ├── main-chat-surface-adapter.test.mjs
│   ├── main-chat-theme-owner.test.mjs
│   ├── main-chat-voice-composer.test.js
│   ├── markdown-code-domain-scanner.test.mjs
│   ├── memory-chat-repository.test.mjs
│   ├── message-edit-watcher-failure.test.js
│   ├── message-regeneration-stream-animation.test.js
│   ├── message-renderer-animation-island.test.mjs
│   ├── message-renderer-tts.test.mjs
│   ├── middle-click-owner.test.mjs
│   ├── mobile-sync-canonical.test.js
│   ├── mobile-sync-central-adapter.test.js
│   ├── mobile-sync-degraded-mode.test.js
│   ├── mobile-sync-error-contract.test.js
│   ├── mobile-sync-failure-contract.test.js
│   ├── mobile-sync-package.test.js
│   ├── mobile-sync-protocol.test.js
│   ├── mobile-sync-sqlite-delete.test.js
│   ├── mobile-sync-streaming.test.js
│   ├── music-lyrics-auto-candidate.test.js
│   ├── music-lyrics-race-regression.test.js
│   ├── music-stage-lifecycle.test.js
│   ├── next-ui-registries.test.mjs
│   ├── non-streaming-event-consumer.test.mjs
│   ├── notification-change-audit.test.js
│   ├── notification-menu-controller.test.js
│   ├── notification-renderer-lifecycle.test.mjs
│   ├── overlay-coordinator.test.js
│   ├── owned-preload-subscription.test.mjs
│   ├── performance-recorder.test.js
│   ├── pixi-stage-scenes.test.js
│   ├── plugin-agent-operation-service.test.cjs
│   ├── powershell-window-ipc-isolation.test.js
│   ├── preload-registry.test.js
│   ├── project-forge-ast.test.js
│   ├── project-forge-event-ipc.test.js
│   ├── project-forge-robustness.test.js
│   ├── project-forge-trace.test.js
│   ├── project-forge.test.js
│   ├── prompt-manual-save.test.mjs
│   ├── render-dependencies.test.mjs
│   ├── render-session-authority.test.mjs
│   ├── scoped-style-code-fence.test.mjs
│   ├── scriptorium-async.test.js
│   ├── scriptorium-cdn-localization-electron.test.js
│   ├── scriptorium-collaborator.test.js
│   ├── scriptorium-container.test.js
│   ├── scriptorium-electron-smoke.js
│   ├── scriptorium-export-resources-electron.test.js
│   ├── scriptorium-find-smoke.js
│   ├── scriptorium-hybrid-compiler.test.js
│   ├── scriptorium-importers.test.js
│   ├── scriptorium-library.test.js
│   ├── scriptorium-markdown-linebreak-electron.test.js
│   ├── scriptorium-multiselect-copy-smoke.js
│   ├── scriptorium-network-font-render-electron.test.js
│   ├── scriptorium-network-fonts.test.js
│   ├── scriptorium-paste-debug.js
│   ├── scriptorium-pr-diff.test.js
│   ├── scriptorium-quote-layout-electron.test.js
│   ├── scriptorium-rendered-text.test.js
│   ├── scriptorium-style-library.test.js
│   ├── scriptorium-svg-asset-library.test.js
│   ├── scriptorium-vpptx-electron.test.js
│   ├── sender-task-registry.test.js
│   ├── settings-autosave-coordinator.test.mjs
│   ├── settings-autosave-electron.test.mjs
│   ├── settings-close-stress.test.mjs
│   ├── settings-elements-interaction.test.mjs
│   ├── settings-schema-render.test.mjs
│   ├── settings-value-golden.test.mjs
│   ├── settlement.test.js
│   ├── single-chat-request-orchestrator.test.js
│   ├── source-service.test.js
│   ├── startup-theme-gate.test.js
│   ├── state-authority.test.js
│   ├── state-channel.test.js
│   ├── stream-consumer-registry.test.mjs
│   ├── stream-coordinator.test.mjs
│   ├── stream-manager-terminal-cleanup.test.js
│   ├── stream-session.test.mjs
│   ├── stream-transient-history.test.mjs
│   ├── surface-controller.test.js
│   ├── surface-conversation.test.mjs
│   ├── surface-task-owner.test.mjs
│   ├── task-handle.test.js
│   ├── tavern-rules-engine.test.js
│   ├── test-export-inline.cjs
│   ├── theme-handlers.test.js
│   ├── tool-request-scanner.test.js
│   ├── tool-result-regions.test.js
│   ├── topic-list-mode-lifecycle.test.js
│   ├── topic-selection-readiness.test.mjs
│   ├── topic-summary-model.test.mjs
│   ├── tts-surface-owner.test.mjs
│   ├── ui-helper-chat-scroll-follow.test.js
│   ├── ui-helpers-settings-close.test.js
│   ├── ui-manager-lifecycle.test.mjs
│   ├── uiux-assistant-runtime-adapter.test.mjs
│   ├── uiux-dom-renderer.test.mjs
│   ├── uiux-forum-config-adapter.test.mjs
│   ├── uiux-primitives.test.mjs
│   ├── uiux-rust-assistant-adapter.test.mjs
│   ├── uiux-service-registry.test.mjs
│   ├── uiux-settings-adapter.test.mjs
│   ├── uiux-settings-bridge-modules.test.mjs
│   ├── uiux-settings-css-parts.test.mjs
│   ├── uiux-theme-presenter.test.mjs
│   ├── vcp-stream-bridge.test.mjs
│   ├── vcpchat-bootstrap.test.mjs
│   ├── vcpchat-installer-contract.test.mjs
│   ├── vcpchat-installer-git-update.test.mjs
│   ├── vcpchat-managed-bootstrap-m3-m8.test.mjs
│   ├── vcpchat-platform-boundary.test.mjs
│   ├── visibility-optimizer-owner.test.mjs
│   ├── voice-composer-interaction.test.js
│   ├── voice-input-engine.test.js
│   ├── window-pin-service.test.js
│   ├── window-state-service.test.js
│   ├── window-stream-runtime.test.mjs
│   ├── workspace-index.test.js
│   ├── workspace-live-reference.test.js
│   └── workspace-prompt-placeholders.test.js
├── Themesmodules/
│   ├── themes-module.css
│   ├── themes.html
│   └── themes.js
├── Translatormodules/
│   ├── translator.css
│   ├── translator.html
│   └── translator.js
├── VchatManager/
│   ├── consistency-checker.js
│   ├── CONSISTENCY_CHECK_README.md
│   ├── FEATURE_SUMMARY.md
│   ├── index.html
│   ├── main.js
│   ├── package.json
│   ├── preload.js
│   ├── run_silent.vbs
│   ├── script.js
│   ├── start.bat
│   └── style.css
├── VCPDistributedServer/
│   ├── Plugin/
│   │   ├── BladeGame/
│   │   │   ├── blade-electron.css
│   │   │   ├── blade-electron.html
│   │   │   ├── blade-electron.js
│   │   │   ├── blade-preload.js
│   │   │   ├── blade-service.js
│   │   │   ├── plugin-manifest.json
│   │   │   └── readme.md
│   │   ├── ChartController/
│   │   │   ├── ChartControllerService.js
│   │   │   └── plugin-manifest.json
│   │   ├── ChatRoomViewer/
│   │   │   ├── ChatRoomViewer.js
│   │   │   ├── config.env
│   │   │   ├── config.env.example
│   │   │   └── plugin-manifest.json.block
│   │   ├── ChatTencentcos/
│   │   │   ├── chat_tencentcos.py
│   │   │   ├── config.env.example
│   │   │   ├── plugin-manifest.json
│   │   │   ├── README.md
│   │   │   └── requirements.txt
│   │   ├── CodeSearcher/
│   │   │   ├── CodeSearcher-x86_64-pc-windows-msvc.exe
│   │   │   ├── CodeSearcher.exe
│   │   │   ├── CodeSearcher.js
│   │   │   ├── config.env
│   │   │   └── plugin-manifest.json
│   │   ├── DeepMemo/
│   │   │   ├── src/
│   │   │   │   └── main.rs
│   │   │   ├── Cargo.toml
│   │   │   ├── config.env
│   │   │   ├── config.env.example
│   │   │   ├── DeepMemo.js
│   │   │   ├── deepmemo_rust.exe
│   │   │   ├── DeepMemoService.js
│   │   │   ├── plugin-manifest.json
│   │   │   ├── plugin-manifest.json.old
│   │   │   └── README.md
│   │   ├── DesktopRemote/
│   │   │   ├── desktop-remote.js
│   │   │   └── plugin-manifest.json
│   │   ├── DistImageServer/
│   │   │   ├── config.env
│   │   │   ├── image-server.js
│   │   │   └── plugin-manifest.json
│   │   ├── FileOperator/
│   │   │   ├── .env.example
│   │   │   ├── CodeValidator.js
│   │   │   ├── config.env.example
│   │   │   ├── FileOperator.js
│   │   │   └── plugin-manifest.json
│   │   ├── LoomController/
│   │   │   ├── LoomControllerService.js
│   │   │   ├── LoomSkillService.js
│   │   │   ├── plugin-manifest.json
│   │   │   └── README.md
│   │   ├── MediaShot/
│   │   │   ├── config.env
│   │   │   ├── media_shot.py
│   │   │   ├── plugin-manifest.json
│   │   │   └── requirements.txt
│   │   ├── MusicController/
│   │   │   ├── music-controller.js
│   │   │   └── plugin-manifest.json
│   │   ├── OldPowerShellExecutor/
│   │   │   ├── AdminConfirm.py
│   │   │   ├── plugin-manifest.json
│   │   │   └── PowerShellExecutor.js
│   │   ├── PluginSourceViewer/
│   │   │   ├── plugin-manifest.json
│   │   │   └── PluginSourceViewer.js
│   │   ├── PowerShellExecutor/
│   │   │   ├── gui/
│   │   │   │   ├── PowerShellViewer.css
│   │   │   │   ├── PowerShellViewer.html
│   │   │   │   ├── PowerShellViewer.js
│   │   │   │   └── preload.js
│   │   │   ├── AdminConfirm.py
│   │   │   ├── config.env
│   │   │   ├── plugin-manifest.json
│   │   │   ├── PowerShellExecutor.js
│   │   │   ├── test_interactive_sequence.js
│   │   │   └── test_security_check.js
│   │   ├── ProjectForge/
│   │   │   ├── args.js
│   │   │   ├── engine.js
│   │   │   ├── indexerClient.js
│   │   │   ├── linkGraph.js
│   │   │   ├── plugin-manifest.json
│   │   │   ├── ProjectForgeService.js
│   │   │   ├── store.js
│   │   │   ├── symbolResolver.js
│   │   │   ├── tickets.js
│   │   │   └── workspace.js
│   │   ├── PromptSponsor/
│   │   │   ├── .env.example
│   │   │   ├── plugin-manifest.json
│   │   │   ├── prompt-sponsor-service.js
│   │   │   ├── prompt-sponsor.js
│   │   │   └── README.md
│   │   ├── PTYShellExecutor/
│   │   │   ├── gui/
│   │   │   │   ├── preload.js
│   │   │   │   ├── ShellThemeRuntime.js
│   │   │   │   ├── ShellViewer.css
│   │   │   │   ├── ShellViewer.html
│   │   │   │   └── ShellViewer.js
│   │   │   ├── config.env
│   │   │   ├── plugin-manifest.json
│   │   │   ├── PluginErrorReporter.js
│   │   │   ├── PTYShellExecutor.impl.js
│   │   │   ├── PTYShellExecutor.js
│   │   │   ├── PULL_REQUEST.md
│   │   │   ├── README.md
│   │   │   ├── ShellOutputPipeline.js
│   │   │   └── ShellThemeBridge.js
│   │   ├── ScreenPilot/
│   │   │   ├── screenpilot_core/
│   │   │   │   ├── __init__.py
│   │   │   │   ├── capture.py
│   │   │   │   ├── errors.py
│   │   │   │   ├── geometry.py
│   │   │   │   ├── image_edit.py
│   │   │   │   ├── interaction.py
│   │   │   │   ├── ocr.py
│   │   │   │   ├── uia.py
│   │   │   │   └── windows.py
│   │   │   ├── tests/
│   │   │   │   ├── test_core.py
│   │   │   │   └── test_service.js
│   │   │   ├── config.env
│   │   │   ├── plugin-manifest.json
│   │   │   ├── README.md
│   │   │   ├── requirements.txt
│   │   │   ├── screen_pilot.py
│   │   │   └── ScreenPilotService.js
│   │   ├── ScriptoriumCollaborator/
│   │   │   ├── plugin-manifest.json
│   │   │   └── ScriptoriumCollaboratorService.js
│   │   ├── TableLampRemote/
│   │   │   ├── main.py
│   │   │   ├── plugin-manifest.json
│   │   │   └── README.md
│   │   ├── TopicMemo/
│   │   │   ├── plugin-manifest.json
│   │   │   └── TopicMemo.js
│   │   ├── TopicSponsor/
│   │   │   ├── plugin-manifest.json
│   │   │   ├── README.md
│   │   │   ├── topicsponsor-service.js
│   │   │   └── topicsponsor.js
│   │   ├── VChatAutoTTS/
│   │   │   ├── plugin-manifest.json.block
│   │   │   ├── plugin.css
│   │   │   ├── plugin.js
│   │   │   └── README.md
│   │   ├── VChatDynamicWallpaper/
│   │   │   ├── plugin-manifest.json.block
│   │   │   ├── plugin.css
│   │   │   ├── plugin.js
│   │   │   └── README.md
│   │   ├── VCPAlarm/
│   │   │   ├── AlarmRing.mp3
│   │   │   ├── plugin-manifest.json
│   │   │   ├── requirements.txt
│   │   │   ├── run_alarm.py
│   │   │   ├── set_alarm.py
│   │   │   └── VCPAgent.png
│   │   ├── VCPEverything/
│   │   │   ├── local-search-controller.js
│   │   │   ├── plugin-manifest.json
│   │   │   └── readme.md
│   │   ├── VCPMobileSync/
│   │   │   ├── config/
│   │   │   │   └── defaults.js
│   │   │   ├── core/
│   │   │   │   ├── db.js
│   │   │   │   ├── hash.js
│   │   │   │   ├── idempotency.js
│   │   │   │   └── logger.js
│   │   │   ├── dto/
│   │   │   │   ├── agent.dto.js
│   │   │   │   ├── group.dto.js
│   │   │   │   ├── index.js
│   │   │   │   └── topic.dto.js
│   │   │   ├── fixtures/
│   │   │   │   ├── message_canonical_contract.json
│   │   │   │   ├── message_diff_matrix.json
│   │   │   │   ├── topic_canonical_contract.json
│   │   │   │   ├── version_handshake_contract.json
│   │   │   │   └── wire_error_contract.json
│   │   │   ├── sync/
│   │   │   │   ├── canonical.js
│   │   │   │   ├── central.js
│   │   │   │   ├── diff.js
│   │   │   │   ├── entity.js
│   │   │   │   ├── manifest.js
│   │   │   │   ├── message.js
│   │   │   │   └── projection.js
│   │   │   ├── transport/
│   │   │   │   ├── ndjson.js
│   │   │   │   ├── routes.js
│   │   │   │   └── websocket.js
│   │   │   ├── utils/
│   │   │   │   ├── lock.js
│   │   │   │   └── mime.js
│   │   │   ├── .gitignore
│   │   │   ├── config.env.example
│   │   │   ├── error-contract.js
│   │   │   ├── index.js
│   │   │   ├── plugin-manifest.json
│   │   │   ├── protocol.js
│   │   │   └── README.md
│   │   ├── VCPSuperDice/
│   │   │   ├── example style.css
│   │   │   ├── example.js
│   │   │   ├── plugin-manifest.json
│   │   │   ├── README.md
│   │   │   └── superdice.js
│   │   ├── VCPWEWallpaper/
│   │   │   ├── lib/
│   │   │   │   ├── inventory.js
│   │   │   │   ├── locate.js
│   │   │   │   ├── media-server.js
│   │   │   │   └── we-api-shim.js
│   │   │   ├── plugin-manifest.json.block
│   │   │   ├── README.md
│   │   │   └── we-wallpaper-service.js
│   │   ├── VCPWEWallpaperUI/
│   │   │   ├── plugin-manifest.json.block
│   │   │   ├── plugin.css
│   │   │   ├── plugin.js
│   │   │   └── README.md
│   │   ├── VirusTotalAnalyzer/
│   │   │   ├── config.env.example
│   │   │   ├── plugin-manifest.json
│   │   │   ├── requirements.txt
│   │   │   └── vt_analyzer.py
│   │   ├── WaitingForUrReply/
│   │   │   ├── config.env
│   │   │   ├── linux_dialog.py
│   │   │   ├── plugin-manifest.json
│   │   │   ├── README.md
│   │   │   └── waiting_for_reply.py
│   │   └── WindowSensor/
│   │       ├── plugin-manifest.json
│   │       ├── sensor-wrapper.js
│   │       ├── sensor.ps1
│   │       └── sensor.sh
│   ├── shared/
│   │   └── fileKit/
│   │       ├── diff.js
│   │       ├── index.js
│   │       ├── output.js
│   │       ├── paths.js
│   │       ├── reader.js
│   │       ├── text.js
│   │       └── validator.js
│   ├── config.env
│   ├── frontend-plugin-loader.js
│   ├── Plugin.js
│   └── VCPDistributedServer.js
├── VCPHumanToolBox/
│   ├── ComfyUImodules/
│   │   ├── docs/
│   │   │   ├── ComfyUI_Integration_Summary.md
│   │   │   ├── IPC_Channel_Implementation.md
│   │   │   └── PATH_ANALYSIS.md
│   │   ├── comfyui-ipc.js
│   │   ├── comfyui.css
│   │   ├── ComfyUI_StateManager.js
│   │   ├── ComfyUI_UIManager.js
│   │   ├── comfyUIConfig.js
│   │   ├── ComfyUILoader.js
│   │   ├── PathResolver.js
│   │   └── README.md
│   ├── renderer_modules/
│   │   ├── ui/
│   │   │   ├── canvas-editor.js
│   │   │   ├── canvas-handler.js
│   │   │   └── dynamic-image-handler.js
│   │   ├── config.js
│   │   └── tool-manager.js
│   ├── WorkflowEditormodules/
│   │   ├── ai/
│   │   │   ├── AiClientFactory.js
│   │   │   └── HttpAiClient.js
│   │   ├── jsplumb.min.js
│   │   ├── workflow-editor.css
│   │   ├── WorkflowEditor_ApiConfigDialog.css
│   │   ├── WorkflowEditor_ApiConfigDialog.js
│   │   ├── WorkflowEditor_Architecture_Simplified.md
│   │   ├── WorkflowEditor_CanvasManager_JSPlumb.js
│   │   ├── WorkflowEditor_Config.js
│   │   ├── WorkflowEditor_ConnectionManager.js
│   │   ├── WorkflowEditor_ConnectionManager_Simplified.js
│   │   ├── WorkflowEditor_ExecutionEngine.js
│   │   ├── WorkflowEditor_NodeManager.js
│   │   ├── WorkflowEditor_NodeManager_URLExtractor.js
│   │   ├── WorkflowEditor_NodeManager_URLExtractor_Integration.js
│   │   ├── WorkflowEditor_NodeManager_URLRenderer_Patch.js
│   │   ├── WorkflowEditor_PluginDialog.js
│   │   ├── WorkflowEditor_PluginManager.js
│   │   ├── WorkflowEditor_StateManager.js
│   │   ├── WorkflowEditor_UIManager.js
│   │   ├── WorkflowEditorLoader.js
│   │   └── WorkflowEditorLoader_Simplified.js
│   ├── index.html
│   ├── main.js
│   ├── package.json
│   ├── preload.js
│   ├── README.md
│   ├── renderer.js
│   ├── run_silent.vbs
│   ├── start.bat
│   ├── style.css
│   └── VCHB.lnk
├── Voicechatmodules/
│   ├── recognizer.html
│   ├── voice-input-capture.html
│   ├── voice-input-capture.js
│   ├── voicechat.css
│   ├── voicechat.html
│   └── voicechat.js
├── WebIndexTTS2/
│   ├── README.md
│   └── server.js
├── 开发文档/
│   ├── CLI一期工程-补充说明.md
│   ├── CLI一期工程.md
│   ├── DISTRIBUTED_MUSIC_PLAYLIST_UPDATE_ADAPTER.md
│   ├── Loom移动网页布局调试报告.md
│   ├── OPENHER_PERSONA_MOBILE_CARD_API.md
│   ├── Rubato与SoXR音频核心产物AB对照说明.md
│   ├── Rust中央聊天数据服务与DeepMemo同步系统改造施工图.md
│   ├── Scriptorium主模块拆分研究.md
│   ├── Scriptorium换行与版面估算路线报告.md
│   ├── Scriptorium文档源码范式重构设计.md
│   ├── SuperDoc-CJK-line-breaking-GitHub-issue-draft.md
│   ├── VCP Loom一期开发记录-2026-08-01.md
│   ├── VCP Loom二期开发记录-2026-08-01.md
│   ├── VCP Web Agent Core通用化设计方案-2026-08-06.md
│   ├── VCPLog 离线通知缓存补发.md
│   ├── 三种聊天呈现模式开发方案.md
│   ├── 个人提交代码移除统计_546af4a至HEAD.md
│   ├── 动态运行态内容分页与导出稳定化经验.md
│   ├── 新旧Rust音频核心音质与DSP实现对照评估.md
│   ├── 流式渲染端到端竞态性能与可靠性审计报告.md
│   ├── 消息渲染框架分析与优化建议.md
│   ├── 渲染迭代建议.md
│   ├── 静态富文档渲染引擎可靠性报告.md
│   └── 音乐播放器高精度逐字网络歌词系统移植与架构说明.md
├── .gitattributes
├── .gitignore
├── .npmrc
├── backup.py
├── check_theme_wallpapers.bat
├── LICENSE
├── main.html
├── main.js
├── package-lock.json
├── package.json
├── poetry.lock
├── preload.js
├── PRETEXT_INTEGRATION.md
├── PRETEXT_INTEGRATION_CN.md
├── process_songs.py
├── PROJECT_STRUCTURE.md
├── pyproject.toml
├── README.md
├── renderer.js
├── requirements.txt
├── splash.html
├── start debug.bat
├── start-desktop.vbs
├── start-rag-observer.vbs
├── start.bat
├── StartVCPchat.exe
├── style.css
├── stylelint.ui-system.config.cjs
├── test.html
├── test.md
├── vcpchatREADME_en.md
├── vcpchatREADME_jp.md
├── vcpchatREADME_ru.md
├── VCP同步异步插件开发手册.md
├── 启动Vchat.vbs
├── 启动全部.vbs
├── 打开indextts管理页_启动服务器.bat
└── 编译并部署音频引擎.bat
```

## 排除规则列表

<details>
<summary>点击展开查看已排除的目录与文件规则</summary>

- **默认跳过目录名称**：
  `.astro`, `.cache`, `.docusaurus`, `.git`, `.gradle`, `.hg`, `.hypothesis`, `.idea`, `.ipynb_checkpoints`, `.m2`, `.mypy_cache`, `.next`, `.nox`, `.nuxt`, `.output`, `.parcel-cache`, `.pnpm-store`, `.pyre`, `.pytest_cache`, `.ruff_cache`, `.svelte-kit`, `.svn`, `.temp`, `.tmp`, `.tox`, `.turbo`, `.venv`, `.virtualenv`, `.vite`, `.vs`, `.vscode`, `.webpack`, `.yarn`, `__pycache__`, `appdata`, `arm64`, `bin`, `bower_components`, `build`, `carthage`, `coverage`, `data_cache`, `debug`, `dist`, `env`, `htmlcov`, `indexeddb`, `jspm_packages`, `local_storage`, `logs`, `node_modules`, `obj`, `out`, `output`, `packages`, `pip-wheel-metadata`, `pkg`, `pods`, `release`, `sessions`, `storybook-static`, `target`, `temp`, `tmp`, `user_data`, `userdata`, `vendor`, `venv`, `wheelhouse`, `x64`, `x86`
- **默认通配符排除**：
  `cmake-build-*`, `*.egg-info`, `*.dist-info`, `*.tmp`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.pyc`, `*.pyo`, `*.pyd`, `*.o`, `*.obj`, `*.class`, `*.tsbuildinfo`, `*.log`, `*.tmp`, `*.temp`, `*.swp`, `*.swo`, `*.bak`, `*~`, `*.suo`, `*.user`
- **.gitignore 生效规则**：共 54 条规则已并入跳过逻辑
</details>
