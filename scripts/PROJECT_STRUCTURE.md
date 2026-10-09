# VCPChat 项目文件目录结构

> 自动生成于：2026-10-09 22:10:51  

> 项目根目录：`H:\VCP\VCPMain\VCPChat`  

> 筛选文件类型：`.bash`、`.bat`、`.c`、`.cc`、`.cfg`、`.cjs`、`.cmd`、`.conf`、`.cpp`、`.cs`、`.css`、`.cxx`、`.example`、`.go`、`.h`、`.hpp`、`.htm`、`.html`、`.hxx`、`.ini`、`.ipynb`、`.java`、`.js`、`.json`、`.json5`、`.jsonc`、`.jsx`、`.kt`、`.kts`、`.less`、`.lock`、`.lua`、`.md`、`.mjs`、`.php`、`.properties`、`.ps1`、`.psd1`、`.psm1`、`.py`、`.pyi`、`.r`、`.rb`、`.rs`、`.rst`、`.sass`、`.scss`、`.sh`、`.sql`、`.svelte`、`.swift`、`.toml`、`.ts`、`.tsx`、`.txt`、`.vbs`、`.vue`、`.xml`、`.yaml`、`.yml`、`.zsh`  

> 扫描说明：已自动跳过版本控制、编译产物、依赖包、Python虚拟环境与运行时、构建与Web生成目录、AppData/用户数据等。

## 文件统计

- **总目录数**：209
- **总文件数**：1361
- **文件类型数**：21

| 类型 | 扩展名 | 数量 |
| :--- | :--- | ---: |
| JavaScript | `.js` | 825 |
| CSS | `.css` | 143 |
| Rust | `.rs` | 114 |
| JSON | `.json` | 92 |
| Markdown | `.md` | 56 |
| HTML | `.html` | 40 |
| Python | `.py` | 26 |
| TOML | `.toml` | 9 |
| Batch Script | `.bat` | 9 |
| Plain Text | `.txt` | 8 |
| .example | `.example` | 8 |
| VBScript | `.vbs` | 7 |
| YAML | `.yml` | 6 |
| .ini | `.ini` | 4 |
| TypeScript | `.ts` | 3 |
| JavaScript (CommonJS) | `.cjs` | 3 |
| TypeScript (React) | `.tsx` | 2 |
| Shell Script | `.sh` | 2 |
| PowerShell | `.ps1` | 2 |
| C# | `.cs` | 1 |
| .lock | `.lock` | 1 |
| **合计** | - | **1361** |

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
  `.astro`, `.cache`, `.docusaurus`, `.git`, `.gradle`, `.hg`, `.hypothesis`, `.idea`, `.ipynb_checkpoints`, `.m2`, `.mypy_cache`, `.next`, `.nox`, `.nuxt`, `.output`, `.parcel-cache`, `.pnpm-store`, `.pyre`, `.pytest_cache`, `.ruff_cache`, `.svelte-kit`, `.svn`, `.temp`, `.tmp`, `.tox`, `.turbo`, `.venv`, `.virtualenv`, `.vite`, `.vs`, `.vscode`, `.webpack`, `.yarn`, `__pycache__`, `__tests__`, `appdata`, `arm64`, `artifacts`, `bin`, `bower_components`, `build`, `carthage`, `checkpoints`, `coverage`, `data_cache`, `debug`, `dist`, `doc`, `docs`, `documentation`, `env`, `example`, `examples`, `htmlcov`, `indexeddb`, `jspm_packages`, `local_storage`, `logs`, `models`, `node_modules`, `obj`, `out`, `output`, `packages`, `pip-wheel-metadata`, `pkg`, `pods`, `pretrained_models`, `project_structure.md`, `python_embedded`, `python_embeded`, `release`, `reports`, `screenshots`, `scripts`, `sessions`, `site-packages`, `storybook-static`, `target`, `temp`, `test`, `test-results`, `tests`, `tmp`, `user_data`, `userdata`, `vendor`, `venv`, `wheelhouse`, `x64`, `x86`, `开发文档`
- **默认通配符排除**：
  `cmake-build-*`, `*.egg-info`, `*.dist-info`, `*.tmp`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.pyc`, `*.pyo`, `*.pyd`, `*.o`, `*.obj`, `*.class`, `*.tsbuildinfo`, `*.log`, `*.tmp`, `*.temp`, `*.swp`, `*.swo`, `*.bak`, `*~`, `*.suo`, `*.user`, `scripts`, `开发文档`, `doc`, `docs`, `documentation`, `test`, `tests`, `__tests__`, `example`, `examples`, `artifacts`, `screenshots`, `test-results`, `reports`, `models`, `checkpoints`, `pretrained_models`, `site-packages`, `python_embedded`, `python_embeded`, `PROJECT_STRUCTURE.md`
- **.gitignore 生效规则**：共 56 条规则已并入跳过逻辑
</details>
