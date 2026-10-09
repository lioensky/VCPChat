# VCPChat 项目文件目录结构

> 自动生成于：2026-10-09 22:07:46  

> 项目根目录：`H:\VCP\VCPMain\VCPChat`  

> 筛选文件类型：`.bash`、`.bat`、`.c`、`.cc`、`.cfg`、`.cjs`、`.cmd`、`.conf`、`.cpp`、`.cs`、`.css`、`.cxx`、`.example`、`.go`、`.h`、`.hpp`、`.htm`、`.html`、`.hxx`、`.ini`、`.ipynb`、`.java`、`.js`、`.json`、`.json5`、`.jsonc`、`.jsx`、`.kt`、`.kts`、`.less`、`.lock`、`.lua`、`.md`、`.mjs`、`.php`、`.properties`、`.ps1`、`.psd1`、`.psm1`、`.py`、`.pyi`、`.r`、`.rb`、`.rs`、`.rst`、`.sass`、`.scss`、`.sh`、`.sql`、`.svelte`、`.swift`、`.toml`、`.ts`、`.tsx`、`.txt`、`.vbs`、`.vue`、`.xml`、`.yaml`、`.yml`、`.zsh`  

> 扫描说明：已自动跳过版本控制、编译产物、依赖包、Python虚拟环境与运行时、构建与Web生成目录、AppData/用户数据等。

## 文件统计

- **总目录数**：228
- **总文件数**：1926
- **文件类型数**：22

| 类型 | 扩展名 | 数量 |
| :--- | :--- | ---: |
| JavaScript | `.js` | 980 |
| JavaScript (ESM) | `.mjs` | 289 |
| Markdown | `.md` | 144 |
| CSS | `.css` | 143 |
| Rust | `.rs` | 114 |
| JSON | `.json` | 105 |
| HTML | `.html` | 41 |
| Python | `.py` | 30 |
| JavaScript (CommonJS) | `.cjs` | 15 |
| TOML | `.toml` | 9 |
| Batch Script | `.bat` | 9 |
| Plain Text | `.txt` | 8 |
| .example | `.example` | 8 |
| VBScript | `.vbs` | 7 |
| YAML | `.yml` | 6 |
| PowerShell | `.ps1` | 5 |
| .ini | `.ini` | 4 |
| TypeScript | `.ts` | 3 |
| TypeScript (React) | `.tsx` | 2 |
| Shell Script | `.sh` | 2 |
| C# | `.cs` | 1 |
| .lock | `.lock` | 1 |
| **合计** | - | **1926** |

## 目录结构树

```text
VCPChat/
├── .github/
│   └── workflows/
│       ├── chat_kernel_ui.yml
│       ├── mobile_sync.yml
│       ├── rust_assistant_engine_build.yml
│       ├── side_pane_e2e.yml
│       ├── side_pane_windows.yml
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
│       ├── index.html
│       ├── package-lock.json
│       ├── package.json
│       ├── README.md
│       ├── THIRD_PARTY_NOTICES.md
│       ├── tsconfig.app.json
│       ├── tsconfig.json
│       ├── tsconfig.node.json
│       └── vite.config.ts
├── assets/
│   ├── font/
│   │   └── vcp-ui/
│   │       └── noto-sans-sc.css
│   ├── iconset/
│   │   └── VChatOfficial/
│   │       └── README.md
│   └── Assistantmodules__Groupmodules__Musicmodules__Not....md
├── audio_engine/
│   └── IRPreset/
│       └── 音频IR脉冲预设放在这.txt
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
│   │       └── themes/
│   │           ├── blueGreenMetal/
│   │           │   ├── package.json
│   │           │   ├── smoothDice.json
│   │           │   └── theme.config.json
│   │           ├── default/
│   │           │   ├── default.json
│   │           │   ├── package.json
│   │           │   └── theme.config.json
│   │           ├── default-extras/
│   │           │   ├── default-extras.json
│   │           │   ├── package.json
│   │           │   └── theme.config.json
│   │           ├── diceOfRolling/
│   │           │   ├── package.json
│   │           │   ├── smoothDice.json
│   │           │   └── theme.config.json
│   │           ├── diceOfRolling-fate/
│   │           │   ├── fate-die.json
│   │           │   ├── package.json
│   │           │   └── theme.config.json
│   │           ├── gemstone/
│   │           │   ├── gemstone.json
│   │           │   ├── package.json
│   │           │   └── theme.config.json
│   │           ├── gemstoneMarble/
│   │           │   ├── gemstone.json
│   │           │   ├── package.json
│   │           │   └── theme.config.json
│   │           ├── genesys/
│   │           │   ├── genesys.json
│   │           │   ├── package.json
│   │           │   └── theme.config.json
│   │           ├── rock/
│   │           │   ├── package.json
│   │           │   ├── smoothDice.json
│   │           │   └── theme.config.json
│   │           ├── rust/
│   │           │   ├── package.json
│   │           │   └── theme.config.json
│   │           ├── smooth/
│   │           │   ├── package.json
│   │           │   ├── smoothDice.json
│   │           │   └── theme.config.json
│   │           ├── smooth-pip/
│   │           │   ├── package.json
│   │           │   ├── smooth-pip.json
│   │           │   └── theme.config.json
│   │           └── wooden/
│   │               ├── package.json
│   │               ├── smoothDice.json
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
│   ├── local-sovits-tts-server-compatibility.md
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
│   ├── SIDE_PANE_ARCHITECTURE.md
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
│   ├── verification.md
│   ├── vgame-development-plan.md
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
│   ├── groupChatUrl.js
│   ├── groupContextWindow.js
│   ├── grouprenderer.js
│   ├── jevGroupSessionOrchestrator.js
│   ├── streamWatchdog.js
│   └── topicTitleManager.js
├── launchers/
│   ├── VCPChat-Launcher.sh
│   └── VCPChat-Launcher.vbs
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
│   │   ├── sideChatSessionService.js
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
│   │   │       └── Startup.cs
│   │   ├── agentHandlers.js
│   │   ├── applicationSender.js
│   │   ├── assistantHandlers.js
│   │   ├── browserHandlers.js
│   │   ├── canvasHandlers.js
│   │   ├── chartHandlers.js
│   │   ├── chatHandlers.js
│   │   ├── deepWikiHandlers.js
│   │   ├── desktopHandlers.js
│   │   ├── desktopMetrics.js
│   │   ├── desktopRemoteHandlers.js
│   │   ├── diceHandlers.js
│   │   ├── docxHandlers.js
│   │   ├── domainActivator.js
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
│   │   ├── modelTrajectoryHandlers.js
│   │   ├── musicHandlers.js
│   │   ├── notesHandlers.js
│   │   ├── projectForgeHandlers.js
│   │   ├── promptHandlers.js
│   │   ├── ragHandlers.js
│   │   ├── regexHandlers.js
│   │   ├── senderLifetime.js
│   │   ├── settingsHandlers.js
│   │   ├── sideChatHandlers.js
│   │   ├── sidePaneIpcPolicy.js
│   │   ├── sourceHandlers.js
│   │   ├── sovitsHandlers.js
│   │   ├── stateSubscriptions.js
│   │   ├── tavernHandlers.js
│   │   ├── terminalHandlers.js
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
│   │   ├── sideBrowserService.js
│   │   └── VCPLoomManager.js
│   ├── lyrics/
│   │   ├── krcDecrypt.js
│   │   ├── lyricFetcherUnified.js
│   │   ├── matchScore.js
│   │   ├── parserCore.js
│   │   └── qrcDecrypt.js
│   ├── renderer/
│   │   ├── side-chat/
│   │   │   ├── attachments.js
│   │   │   ├── composer-state.js
│   │   │   ├── draft-cache.js
│   │   │   ├── draft-store.js
│   │   │   ├── message-actions.js
│   │   │   ├── message-edit.js
│   │   │   ├── model-picker.js
│   │   │   ├── persistence.js
│   │   │   ├── references.js
│   │   │   ├── scrolling.js
│   │   │   └── shell.js
│   │   ├── animation.js
│   │   ├── chat-header-style.js
│   │   ├── colorUtils.js
│   │   ├── composerCommands.js
│   │   ├── composerModelSelect.js
│   │   ├── contentPipeline.js
│   │   ├── contentProcessor.js
│   │   ├── desktopPushConsumer.js
│   │   ├── domBuilder.js
│   │   ├── domListenerOwner.js
│   │   ├── emoticonUrlFixer.js
│   │   ├── enhancedColorUtils.js
│   │   ├── floatingSelectionButton.js
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
│   │   ├── mediaLifecycle.js
│   │   ├── messageContextMenu.js
│   │   ├── messenger-presentation.js
│   │   ├── middleClickHandler.js
│   │   ├── nonStreamingEventConsumer.js
│   │   ├── ownedPreloadSubscription.js
│   │   ├── pretext-bridge.js
│   │   ├── pretext.bundle.js
│   │   ├── pretext.esm.js
│   │   ├── renderDependencies.js
│   │   ├── renderSessionAuthority.js
│   │   ├── sideChatSurfaceOwner.js
│   │   ├── sideChatWiring.js
│   │   ├── sidePaneCommands.js
│   │   ├── sidePaneHostBindings.js
│   │   ├── sidePaneLauncherWiring.js
│   │   ├── sidePaneWiring.js
│   │   ├── sidePaneWorkspaceServices.js
│   │   ├── streamManager.js
│   │   ├── streamProjectionRuntime.js
│   │   ├── surfaceTaskOwner.js
│   │   ├── toolPresentation.js
│   │   ├── toolRequestMarkers.js
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
│   │   ├── agentPortraitImages.js
│   │   ├── attachmentDialogState.js
│   │   ├── chartDataSourceService.js
│   │   ├── chartService.js
│   │   ├── deepWikiService.js
│   │   ├── dotGitPath.js
│   │   ├── embeddedAppSessionManager.js
│   │   ├── gitService.js
│   │   ├── gitWatcher.js
│   │   ├── globalJevService.js
│   │   ├── historyMutationQueue.js
│   │   ├── historyWatcherLeaseManager.js
│   │   ├── jevClient.js
│   │   ├── networkNotesCacheStore.js
│   │   ├── pdfAttachmentService.js
│   │   ├── pluginAgentOperationService.js
│   │   ├── preloadPaths.js
│   │   ├── scriptoriumAgentControlService.js
│   │   ├── scriptoriumFontCacheService.js
│   │   ├── scriptoriumImportService.js
│   │   ├── scriptoriumPptxImportService.js
│   │   ├── senderTaskRegistry.js
│   │   ├── sourceService.js
│   │   ├── themePreviewVariables.js
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
│   │   ├── conversation-status-panel/
│   │   │   ├── branch-dialogs.js
│   │   │   ├── commit-dialog.js
│   │   │   ├── dom.js
│   │   │   ├── floating.js
│   │   │   ├── git-actions.js
│   │   │   ├── git-graph.js
│   │   │   ├── helpers.js
│   │   │   ├── push-dialog.js
│   │   │   └── sections.js
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
│   │   ├── side-pane/
│   │   │   ├── code-viewer/
│   │   │   │   ├── diff-view.js
│   │   │   │   ├── editor.js
│   │   │   │   ├── file-read.js
│   │   │   │   ├── helpers.js
│   │   │   │   └── picker.js
│   │   │   ├── git/
│   │   │   │   ├── cards.js
│   │   │   │   ├── context-menu.js
│   │   │   │   ├── diff-model.js
│   │   │   │   └── git-view.js
│   │   │   ├── plan-detail/
│   │   │   │   ├── node-view.js
│   │   │   │   ├── page-navigation.js
│   │   │   │   ├── project-picker.js
│   │   │   │   └── topic-activity.js
│   │   │   ├── tab-types/
│   │   │   │   ├── browser.js
│   │   │   │   ├── chat.js
│   │   │   │   ├── code-viewer.js
│   │   │   │   ├── lazy-provider.js
│   │   │   │   ├── model-trajectory.js
│   │   │   │   ├── notifications.js
│   │   │   │   ├── plan-detail.js
│   │   │   │   ├── terminal.js
│   │   │   │   └── tool-output.js
│   │   │   ├── browserSideProvider.js
│   │   │   ├── codeViewerSideProvider.js
│   │   │   ├── menu-position.js
│   │   │   ├── modelTrajectoryModel.js
│   │   │   ├── modelTrajectorySideProvider.js
│   │   │   ├── planDetailSideProvider.js
│   │   │   ├── portrait-display.js
│   │   │   ├── portrait-media.js
│   │   │   ├── selection-reference.js
│   │   │   ├── side-pane-controller.js
│   │   │   ├── side-pane-dormancy.js
│   │   │   ├── side-pane-entries.js
│   │   │   ├── side-pane-focus.js
│   │   │   ├── side-pane-launcher-portrait.js
│   │   │   ├── side-pane-launcher.js
│   │   │   ├── side-pane-occurrence.js
│   │   │   ├── side-pane-persistence.js
│   │   │   ├── side-pane-resizer-owner.js
│   │   │   ├── side-pane-shortcuts.js
│   │   │   ├── side-pane-state.js
│   │   │   ├── side-pane-tab-close-owner.js
│   │   │   ├── side-pane-tab-dnd.js
│   │   │   ├── side-pane-tab-menu.js
│   │   │   ├── side-pane-tab-overview.js
│   │   │   ├── side-pane-tab-registry.js
│   │   │   ├── side-pane-tab-strip.js
│   │   │   ├── side-pane-tab-utils.js
│   │   │   ├── side-pane-types.js
│   │   │   ├── side-pane-visibility.js
│   │   │   ├── terminalDataTransform.js
│   │   │   ├── terminalLinks.js
│   │   │   ├── terminalSideProvider.js
│   │   │   ├── terminalTheme.js
│   │   │   └── toolOutputSideProvider.js
│   │   ├── sources/
│   │   │   ├── conversation-current.js
│   │   │   ├── git-changes.js
│   │   │   ├── git-workspace.js
│   │   │   ├── projectforge-changes.js
│   │   │   └── terminal-command-runs.js
│   │   ├── agent-portrait-settings.js
│   │   ├── appearance-engine.js
│   │   ├── appearance-profile-runtime.js
│   │   ├── appearance-studio.js
│   │   ├── ask-nova-modal.js
│   │   ├── avatar-picker.js
│   │   ├── chat-back-to-bottom.js
│   │   ├── chat-composer-inset.js
│   │   ├── chat-navigation-idle.js
│   │   ├── component-manifest.js
│   │   ├── component-showcase.js
│   │   ├── contribution-registry.js
│   │   ├── conversation-scope.js
│   │   ├── conversation-status-panel.js
│   │   ├── conversation-turn-navigator.js
│   │   ├── git-file-diff.js
│   │   ├── git-graph-layout.js
│   │   ├── interactive-chat-app.js
│   │   ├── lifecycle-inspector.js
│   │   ├── lifecycle-scope.js
│   │   ├── line-diff.js
│   │   ├── lucide-adapter.js
│   │   ├── material-runtime.js
│   │   ├── message-file-changes.js
│   │   ├── next-ui-apps.js
│   │   ├── performance-recorder.js
│   │   ├── project-plan-model.js
│   │   ├── settings-bridge.js
│   │   ├── settlement.js
│   │   ├── shared-source.js
│   │   ├── sidebar-resizer.js
│   │   ├── standalone-chat-app.js
│   │   ├── startup-theme-gate.js
│   │   ├── state-channel.js
│   │   ├── surface-controller.js
│   │   ├── task-handle.js
│   │   ├── text-escape.js
│   │   ├── theme-runtime.js
│   │   ├── typed-field-owners.js
│   │   ├── ui-surface-policy.js
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
│   ├── modelTrajectory.js
│   ├── modelUsageTracker.js
│   ├── musicScannerWorker.js
│   ├── notificationCenter.js
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
│   │   └── main.rs
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
│   │   ├── browser.js
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
│   │   ├── modelTrajectory.js
│   │   ├── music.js
│   │   ├── notes.js
│   │   ├── plugins.js
│   │   ├── projectForge.js
│   │   ├── prompts.js
│   │   ├── rag.js
│   │   ├── settings.js
│   │   ├── sideChat.js
│   │   ├── state.js
│   │   ├── tavern.js
│   │   ├── terminal.js
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
│       └── themes/
│           └── default/
│               ├── default.json
│               └── theme.config.json
├── RAGmodules/
│   ├── rag-observer-config.js
│   ├── RAG_Observer.html
│   └── RAG_Overlay.html
├── RMMusic/
│   └── NORD/
│       ├── Music Player/
│       │   └── NORD Dark Music Player.ini
│       ├── Volume Control/
│       │   ├── Bright Volume Control.ini
│       │   └── Dark Volume Control.ini
│       └── Config.ini
├── rust_assistant_engine/
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
│   │   ├── binary/
│   │   │   ├── demangle.rs
│   │   │   ├── elf.rs
│   │   │   ├── entropy.rs
│   │   │   ├── mod.rs
│   │   │   ├── pe.rs
│   │   │   └── wasm.rs
│   │   ├── facts/
│   │   │   ├── c_cpp.rs
│   │   │   ├── csharp_lua.rs
│   │   │   ├── go.rs
│   │   │   ├── java.rs
│   │   │   ├── js_html.rs
│   │   │   ├── mod.rs
│   │   │   ├── python.rs
│   │   │   ├── rust_lang.rs
│   │   │   └── types.rs
│   │   ├── lang.rs
│   │   ├── main.rs
│   │   ├── scan.rs
│   │   └── symbols.rs
│   ├── bench.js
│   ├── build-runtime.js
│   └── Cargo.toml
├── rust_voice_input_engine/
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
│   ├── helpers/
│   │   └── shared-composer-icons.mjs
│   ├── audit-settings-first-open.mjs
│   ├── audit-settings-layout.mjs
│   ├── audit-settings-style-parity.mjs
│   ├── build-chat-event-graph.mjs
│   ├── build-webawesome-runtime.mjs
│   ├── chaos-probe-settings.mjs
│   ├── chat-event-source.mjs
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
│   ├── run-all-tests.mjs
│   ├── run-chat-contract-invariants.mjs
│   ├── run-electron-node.mjs
│   ├── scriptorium-line-break-diagnostic.js
│   ├── smoke-side-pane-e2e.mjs
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
│   ├── test-dedicated-preload-electron.mjs
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
│   │   ├── themes黑曜与星火.css
│   │   └── themes黑白简约.css
│   ├── ui-system/
│   │   ├── uiux-theme/
│   │   │   ├── semantic.css
│   │   │   └── static-scale.css
│   │   ├── appearance-studio.css
│   │   ├── ask-nova.css
│   │   ├── business-modals.css
│   │   ├── chat-back-to-bottom.css
│   │   ├── chat-composer-inset.css
│   │   ├── chat-input.css
│   │   ├── components.css
│   │   ├── fonts.css
│   │   ├── group-settings.css
│   │   ├── index.css
│   │   ├── message-file-changes.css
│   │   ├── messages.css
│   │   ├── motion.css
│   │   ├── notification-center-cards.css
│   │   ├── notification-center-dock.css
│   │   ├── notification-center-list.css
│   │   ├── notification-center-status.css
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
│   │   ├── side-pane-browser.css
│   │   ├── side-pane-code-viewer.css
│   │   ├── side-pane-git-extras.css
│   │   ├── side-pane-launcher.css
│   │   ├── side-pane-model-trajectory.css
│   │   ├── side-pane-motion.css
│   │   ├── side-pane-plan.css
│   │   ├── side-pane-shell.css
│   │   ├── side-pane-side-chat-extras.css
│   │   ├── side-pane-side-chat.css
│   │   ├── side-pane-tab-bar.css
│   │   ├── side-pane-tab-overlays.css
│   │   ├── side-pane-tab-overview.css
│   │   ├── side-pane-tabs.css
│   │   ├── side-pane-terminal.css
│   │   ├── side-pane-tool-output.css
│   │   ├── sidebar.css
│   │   ├── status-panel.css
│   │   ├── status-tokens.css
│   │   ├── tokens.css
│   │   ├── tool-presentation.css
│   │   ├── turn-navigator.css
│   │   └── webawesome-adapter.css
│   ├── animations.css
│   ├── appearance.css
│   ├── base.css
│   ├── chat-messenger.css
│   ├── chat.css
│   ├── compact-sidebar.css
│   ├── components.css
│   ├── layout.css
│   ├── messageRenderer.css
│   ├── notifications.css
│   ├── search.css
│   ├── settings.css
│   ├── side-chat-bubbles.css
│   ├── themes.css
│   └── ui-next.css
├── Tavernmodules/
│   ├── tavern-manager.js
│   └── tavern.css
├── tests/
│   ├── helpers/
│   │   ├── dedicated-preload-electron.cjs
│   │   ├── electron-test-entry.cjs
│   │   ├── electron-test-main.cjs
│   │   ├── main-composer.mjs
│   │   ├── README.md
│   │   ├── scriptorium-native-input-preload.cjs
│   │   ├── side-chat-surface-fixture.mjs
│   │   ├── trusted-main-sender.cjs
│   │   └── wait-for.mjs
│   ├── support/
│   │   └── main-chat-sequence.js
│   ├── account-menu-controller.test.js
│   ├── app-tab-host.test.js
│   ├── assistant-search-controller.test.js
│   ├── attachment-dialog-state.test.js
│   ├── browser-handlers.test.js
│   ├── canvas-edit-approval.test.js
│   ├── chart-controller.test.js
│   ├── chart-data-source.test.js
│   ├── chart-service.test.js
│   ├── chat-back-to-bottom.test.mjs
│   ├── chat-bubble-backdrop.test.mjs
│   ├── chat-composer-inset.test.mjs
│   ├── chat-context.test.mjs
│   ├── chat-dom-renderer.test.mjs
│   ├── chat-event-contract.test.mjs
│   ├── chat-event-graph.test.mjs
│   ├── chat-history-mutation-authority.test.mjs
│   ├── chat-history-persistence.test.mjs
│   ├── chat-manager-selection-race.test.js
│   ├── chat-media-lifecycle.test.mjs
│   ├── chat-navigation-idle.test.mjs
│   ├── chat-operation.test.mjs
│   ├── chat-plugin-manifest.test.mjs
│   ├── chat-presentation-skin.test.mjs
│   ├── chat-presentation-state.test.mjs
│   ├── chat-repository.test.mjs
│   ├── chat-surface-slots.test.mjs
│   ├── chat-surface.test.mjs
│   ├── chat-theme-plugin.test.mjs
│   ├── chat-visibility-optimizer-height-batch.test.mjs
│   ├── compact-topic-drawer-layout.test.mjs
│   ├── composer-model-select.test.mjs
│   ├── content-pipeline.test.mjs
│   ├── content-processor-owner.test.mjs
│   ├── content-runtime.test.mjs
│   ├── continue-writing-send-state.test.mjs
│   ├── contribution-registry.test.js
│   ├── conversation-current-source.test.mjs
│   ├── conversation-scope.test.mjs
│   ├── conversation-status-panel.test.mjs
│   ├── conversation-status-races.test.mjs
│   ├── conversation-turn-navigator.test.mjs
│   ├── creation-controller.test.js
│   ├── deepmemo-central-adapter.test.js
│   ├── design-system-boundary.test.mjs
│   ├── desktop-living-icons.test.js
│   ├── desktop-push-consumer.test.mjs
│   ├── diorama-director.test.js
│   ├── diorama-events.test.js
│   ├── diorama-stations-smoke.cjs
│   ├── distributed-plugin-startup.test.js
│   ├── dom-listener-owner.test.mjs
│   ├── domain-activator.test.js
│   ├── embedded-app-controller.test.js
│   ├── embedded-app-security.test.js
│   ├── emoticon-fixer-owner.test.mjs
│   ├── emoticon-url-fixer.test.js
│   ├── enhanced-color-utils-lifecycle.test.mjs
│   ├── escape-dispatcher.test.js
│   ├── flowlock-timestamp-bindings.test.js
│   ├── forward-message-owner.test.mjs
│   ├── frontend-plugins.test.js
│   ├── git-changes-source.test.mjs
│   ├── git-file-diff.test.mjs
│   ├── git-mutation-outcome.test.js
│   ├── git-service.test.js
│   ├── git-watcher.test.js
│   ├── git-workspace-source.test.mjs
│   ├── global-jev-service.test.js
│   ├── global-settings-save.test.mjs
│   ├── group-chat-queue-interrupt.test.js
│   ├── group-chat-url.test.js
│   ├── group-context-window.test.js
│   ├── group-fetch-timeout.test.js
│   ├── group-jev-decision-mode.test.js
│   ├── group-jev-integration-contract.test.js
│   ├── group-jev-session-orchestrator.test.js
│   ├── group-sequential-mode.test.js
│   ├── group-settings-slots-static.test.mjs
│   ├── group-stream-watchdog.test.js
│   ├── history-mutation-queue.test.cjs
│   ├── history-watcher-lease-manager.test.js
│   ├── image-handler-owner.test.mjs
│   ├── input-enhancer-note-keyboard.test.js
│   ├── input-enhancer-owner.test.mjs
│   ├── input-enhancer-workspace-mention.test.js
│   ├── item-list-behavior.test.js
│   ├── jev-client.test.js
│   ├── jev-tool-use-rendering.test.js
│   ├── launchpad-controller.test.js
│   ├── launchpad-icons.test.js
│   ├── lifecycle-inspector.test.js
│   ├── lifecycle-scope.test.js
│   ├── line-diff-budget.test.mjs
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
│   ├── main-chat-response-body.test.mjs
│   ├── main-chat-send-owner.test.mjs
│   ├── main-chat-sequence-model.test.js
│   ├── main-chat-settings-owner.test.mjs
│   ├── main-chat-state-authority.test.mjs
│   ├── main-chat-stream-consumer.test.js
│   ├── main-chat-surface-adapter.test.mjs
│   ├── main-chat-theme-owner.test.mjs
│   ├── main-chat-voice-composer.test.js
│   ├── main-composer-commands.test.mjs
│   ├── markdown-code-domain-scanner.test.mjs
│   ├── memory-chat-repository.test.mjs
│   ├── message-edit-watcher-failure.test.js
│   ├── message-file-changes-projectforge.test.mjs
│   ├── message-file-changes.test.mjs
│   ├── message-regeneration-stream-animation.test.js
│   ├── message-renderer-animation-island.test.mjs
│   ├── message-renderer-tool-cards.test.mjs
│   ├── message-renderer-tts.test.mjs
│   ├── messenger-presentation.test.mjs
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
│   ├── model-trajectory-handlers.test.js
│   ├── model-trajectory-model.test.mjs
│   ├── model-trajectory-recorder.test.js
│   ├── music-lyrics-auto-candidate.test.js
│   ├── music-lyrics-race-regression.test.js
│   ├── music-stage-lifecycle.test.js
│   ├── next-ui-registries.test.mjs
│   ├── non-streaming-event-consumer.test.mjs
│   ├── notification-center.test.js
│   ├── notification-change-audit.test.js
│   ├── notification-menu-controller.test.js
│   ├── notification-renderer-lifecycle.test.mjs
│   ├── overlay-coordinator.test.js
│   ├── owned-preload-subscription.test.mjs
│   ├── pdf-attachment-pipeline.test.mjs
│   ├── performance-recorder.test.js
│   ├── pixi-stage-scenes.test.js
│   ├── plugin-agent-operation-service.test.cjs
│   ├── popover-window-blur.test.mjs
│   ├── powershell-completion-receipt.test.js
│   ├── powershell-output-boundaries.test.js
│   ├── powershell-pager-suppression.test.js
│   ├── powershell-window-ipc-isolation.test.js
│   ├── preload-registry.test.js
│   ├── project-forge-ast.test.js
│   ├── project-forge-event-ipc.test.js
│   ├── project-forge-robustness.test.js
│   ├── project-forge-trace.test.js
│   ├── project-forge.test.js
│   ├── projectforge-changes-source.test.mjs
│   ├── prompt-block-layout.test.mjs
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
│   ├── selection-reference.test.mjs
│   ├── sender-task-registry.test.js
│   ├── settings-agent-draft-retention.test.mjs
│   ├── settings-autosave-coordinator.test.mjs
│   ├── settings-autosave-electron.test.mjs
│   ├── settings-close-stress.test.mjs
│   ├── settings-elements-interaction.test.mjs
│   ├── settings-mimo-slot-lifecycle.test.mjs
│   ├── settings-schema-render.test.mjs
│   ├── settings-section-a11y.test.mjs
│   ├── settings-select-projection-forms.test.mjs
│   ├── settings-unsaved-indicator.test.mjs
│   ├── settings-value-golden.test.mjs
│   ├── settlement.test.js
│   ├── shared-source.test.mjs
│   ├── side-browser-address.test.mjs
│   ├── side-browser-retry-electron.test.js
│   ├── side-browser-service.test.js
│   ├── side-chat-audit-probes.test.mjs
│   ├── side-chat-authorization.test.mjs
│   ├── side-chat-delete-leftovers.test.mjs
│   ├── side-chat-deleted-child.test.mjs
│   ├── side-chat-draft-restore.test.mjs
│   ├── side-chat-draft-save.test.mjs
│   ├── side-chat-entry-points.test.mjs
│   ├── side-chat-ephemeral-parity.test.mjs
│   ├── side-chat-floating-selection.test.mjs
│   ├── side-chat-history-load-state.test.mjs
│   ├── side-chat-integration.test.mjs
│   ├── side-chat-interactive-submit.test.mjs
│   ├── side-chat-ipc-metadata.test.mjs
│   ├── side-chat-message-delete.test.mjs
│   ├── side-chat-message-keyboard.test.mjs
│   ├── side-chat-model-and-context.test.mjs
│   ├── side-chat-persistence-retry.test.mjs
│   ├── side-chat-preparation-cancel.test.mjs
│   ├── side-chat-regenerate-busy.test.mjs
│   ├── side-chat-save-failure.test.mjs
│   ├── side-chat-scrolling.test.mjs
│   ├── side-chat-session-service.test.mjs
│   ├── side-chat-stop-partial.test.mjs
│   ├── side-chat-surface-owner.test.mjs
│   ├── side-chat-topic-binding-parity.test.mjs
│   ├── side-chat-trajectory-cleanup.test.mjs
│   ├── side-pane-advanced-parity.test.mjs
│   ├── side-pane-agent-portraits.test.mjs
│   ├── side-pane-batch-close.test.mjs
│   ├── side-pane-code-viewer.test.mjs
│   ├── side-pane-commands.test.mjs
│   ├── side-pane-controller.test.mjs
│   ├── side-pane-deleted-topic.test.mjs
│   ├── side-pane-dom-boundary.test.mjs
│   ├── side-pane-dormancy.test.mjs
│   ├── side-pane-focus.test.mjs
│   ├── side-pane-git-ai-scope.test.mjs
│   ├── side-pane-git-load-states.test.mjs
│   ├── side-pane-git-push-visibility.test.mjs
│   ├── side-pane-git-real-backend.test.mjs
│   ├── side-pane-git-refresh-focus.test.mjs
│   ├── side-pane-git-stale-diff.test.mjs
│   ├── side-pane-git.test.mjs
│   ├── side-pane-ipc-sender.test.js
│   ├── side-pane-leak.test.mjs
│   ├── side-pane-menu-keyboard.test.mjs
│   ├── side-pane-model-trajectory.test.mjs
│   ├── side-pane-mount-timing.test.mjs
│   ├── side-pane-occurrence.test.mjs
│   ├── side-pane-overlay-dismiss.test.mjs
│   ├── side-pane-parent-scope.test.mjs
│   ├── side-pane-persistence.test.mjs
│   ├── side-pane-plan-detail.test.mjs
│   ├── side-pane-plan-topic.test.mjs
│   ├── side-pane-portrait-height-layout.test.mjs
│   ├── side-pane-portrait-media.test.mjs
│   ├── side-pane-portrait-save-safety.test.mjs
│   ├── side-pane-portrait-settings.test.mjs
│   ├── side-pane-resizer-owner.test.mjs
│   ├── side-pane-scope-restore.test.mjs
│   ├── side-pane-screen-reader-names.test.mjs
│   ├── side-pane-shortcuts.test.mjs
│   ├── side-pane-state.test.mjs
│   ├── side-pane-tab-id-lookup.test.mjs
│   ├── side-pane-tab-strip-dnd.test.mjs
│   ├── side-pane-tab-strip-keyboard.test.mjs
│   ├── side-pane-tab-strip-reuse.test.mjs
│   ├── side-pane-tab-strip.test.mjs
│   ├── side-pane-terminal-lifecycle.test.mjs
│   ├── side-pane-terminal-links.test.mjs
│   ├── side-pane-terminal-size.test.mjs
│   ├── side-pane-terminal-theme.test.mjs
│   ├── side-pane-tool-output.test.mjs
│   ├── side-pane-view-scope-release.test.mjs
│   ├── side-pane-visibility-animation.test.mjs
│   ├── side-pane-wiring-modules.test.mjs
│   ├── side-plan-revert-confirmation.test.mjs
│   ├── side-plan-revert-record-failure.test.cjs
│   ├── sidebar-avatar-only-navigation.test.js
│   ├── sidebar-resizer-lifecycle.test.mjs
│   ├── single-chat-request-orchestrator.test.js
│   ├── source-handlers-sender.test.js
│   ├── source-service.test.js
│   ├── startup-theme-gate.test.js
│   ├── state-authority.test.js
│   ├── state-channel.test.js
│   ├── state-subscriptions.test.js
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
│   ├── terminal-cd-command.test.js
│   ├── terminal-command-run-watch.test.js
│   ├── terminal-handlers.test.js
│   ├── terminal-native-helper.test.js
│   ├── terminal-package-closure.test.js
│   ├── terminal-view-routing.test.js
│   ├── test-export-inline.cjs
│   ├── theme-handlers.test.js
│   ├── theme-preview-variables.test.js
│   ├── tool-approval-card-enhancement.test.mjs
│   ├── tool-presentation-local.test.mjs
│   ├── tool-presentation-settings.test.cjs
│   ├── tool-presentation.test.mjs
│   ├── tool-request-malformed-marker.test.mjs
│   ├── tool-request-scanner.test.js
│   ├── tool-result-regions.test.js
│   ├── topic-list-keyboard.test.js
│   ├── topic-list-load-robustness.test.js
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
│   ├── vcp-ui-toast-dismiss.test.mjs
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
│   ├── workspace-handlers-sender.test.js
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
│   │   │   └── config.env.example
│   │   ├── ChatTencentcos/
│   │   │   ├── chat_tencentcos.py
│   │   │   ├── config.env.example
│   │   │   ├── plugin-manifest.json
│   │   │   ├── README.md
│   │   │   └── requirements.txt
│   │   ├── CodeSearcher/
│   │   │   ├── CodeSearcher.js
│   │   │   └── plugin-manifest.json
│   │   ├── DeepMemo/
│   │   │   ├── src/
│   │   │   │   └── main.rs
│   │   │   ├── Cargo.toml
│   │   │   ├── config.env.example
│   │   │   ├── DeepMemo.js
│   │   │   ├── DeepMemoService.js
│   │   │   ├── plugin-manifest.json
│   │   │   └── README.md
│   │   ├── DesktopRemote/
│   │   │   ├── desktop-remote.js
│   │   │   └── plugin-manifest.json
│   │   ├── DistImageServer/
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
│   │   │   ├── command-output-parser.js
│   │   │   ├── commandRunStore.js
│   │   │   ├── nativeHelperPath.js
│   │   │   ├── plugin-manifest.json
│   │   │   ├── PowerShellExecutor.js
│   │   │   ├── terminalOutputSanitizer.js
│   │   │   ├── test_interactive_sequence.js
│   │   │   └── test_security_check.js
│   │   ├── ProjectForge/
│   │   │   ├── args.js
│   │   │   ├── engine.js
│   │   │   ├── gui-revert-file.js
│   │   │   ├── indexerClient.js
│   │   │   ├── linkGraph.js
│   │   │   ├── plugin-manifest.json
│   │   │   ├── ProjectForgeService.js
│   │   │   ├── resolvers.js
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
│   │   │   ├── plugin.css
│   │   │   ├── plugin.js
│   │   │   └── README.md
│   │   ├── VChatDynamicWallpaper/
│   │   │   ├── plugin.css
│   │   │   ├── plugin.js
│   │   │   └── README.md
│   │   ├── VCPAlarm/
│   │   │   ├── plugin-manifest.json
│   │   │   ├── requirements.txt
│   │   │   ├── run_alarm.py
│   │   │   └── set_alarm.py
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
│   │   │   ├── README.md
│   │   │   └── we-wallpaper-service.js
│   │   ├── VCPWEWallpaperUI/
│   │   │   ├── plugin.css
│   │   │   ├── plugin.js
│   │   │   └── README.md
│   │   ├── VirusTotalAnalyzer/
│   │   │   ├── config.env.example
│   │   │   ├── plugin-manifest.json
│   │   │   ├── requirements.txt
│   │   │   └── vt_analyzer.py
│   │   ├── WaitingForUrReply/
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
│   │       ├── binaryReader.js
│   │       ├── diff.js
│   │       ├── index.js
│   │       ├── output.js
│   │       ├── paths.js
│   │       ├── reader.js
│   │       ├── text.js
│   │       └── validator.js
│   ├── frontend-plugin-loader.js
│   ├── normalize-plugin-examples.js
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
│   └── style.css
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
├── backup.py
├── check_theme_wallpapers.bat
├── main.html
├── main.js
├── package-lock.json
├── package.json
├── poetry.lock
├── preload.js
├── PRETEXT_INTEGRATION.md
├── PRETEXT_INTEGRATION_CN.md
├── process_songs.py
├── pyproject.toml
├── README.md
├── renderer.js
├── requirements.txt
├── splash.html
├── start debug.bat
├── start-desktop.vbs
├── start-rag-observer.vbs
├── start.bat
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
├── 生成程序目录.bat
└── 编译并部署音频引擎.bat
```

## 排除规则列表

<details>
<summary>点击展开查看已排除的目录与文件规则</summary>

- **默认跳过目录名称**：
  `.astro`, `.cache`, `.docusaurus`, `.git`, `.gradle`, `.hg`, `.hypothesis`, `.idea`, `.ipynb_checkpoints`, `.m2`, `.mypy_cache`, `.next`, `.nox`, `.nuxt`, `.output`, `.parcel-cache`, `.pnpm-store`, `.pyre`, `.pytest_cache`, `.ruff_cache`, `.svelte-kit`, `.svn`, `.temp`, `.tmp`, `.tox`, `.turbo`, `.venv`, `.virtualenv`, `.vite`, `.vs`, `.vscode`, `.webpack`, `.yarn`, `__pycache__`, `appdata`, `arm64`, `artifacts`, `bin`, `bower_components`, `build`, `carthage`, `checkpoints`, `coverage`, `data_cache`, `debug`, `dist`, `env`, `htmlcov`, `indexeddb`, `jspm_packages`, `local_storage`, `logs`, `models`, `node_modules`, `obj`, `out`, `output`, `packages`, `pip-wheel-metadata`, `pkg`, `pods`, `pretrained_models`, `project_structure.md`, `python_embedded`, `python_embeded`, `release`, `reports`, `screenshots`, `sessions`, `site-packages`, `storybook-static`, `target`, `temp`, `test-results`, `tmp`, `user_data`, `userdata`, `vendor`, `venv`, `wheelhouse`, `x64`, `x86`
- **默认通配符排除**：
  `cmake-build-*`, `*.egg-info`, `*.dist-info`, `*.tmp`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.pyc`, `*.pyo`, `*.pyd`, `*.o`, `*.obj`, `*.class`, `*.tsbuildinfo`, `*.log`, `*.tmp`, `*.temp`, `*.swp`, `*.swo`, `*.bak`, `*~`, `*.suo`, `*.user`, `artifacts`, `screenshots`, `test-results`, `reports`, `models`, `checkpoints`, `pretrained_models`, `site-packages`, `python_embedded`, `python_embeded`, `PROJECT_STRUCTURE.md`
- **.gitignore 生效规则**：共 56 条规则已并入跳过逻辑
</details>
