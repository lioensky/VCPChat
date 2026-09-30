# HTML、JavaScript、CSS 与 EXE 文件分布

> 自动生成于：2026-09-30 11:39:55  

> 项目根目录：`H:\VCP\VCPMain\VCPChat`  

> 扫描最大深度：3 层  

> 筛选文件类型：`.css`、`.exe`、`.html`、`.js`  

> 扫描说明：已自动跳过版本控制、编译产物、依赖包、Python虚拟环境与运行时、构建与Web生成目录、AppData/用户数据等。

## 文件统计

- **总目录数**：128
- **总文件数**：899
- **文件类型数**：4

| 类型 | 扩展名 | 数量 |
| :--- | :--- | ---: |
| JavaScript | `.js` | 739 |
| CSS | `.css` | 111 |
| HTML | `.html` | 39 |
| EXE 运行时/可执行程序 | `.exe` | 10 |
| **合计** | - | **899** |

## 目录结构树

```text
VCPChat/
├── Agenttaskmodules/
│   ├── task.css
│   ├── task.html
│   └── task.js
├── apps/
│   └── bootstrap-installer/
│       ├── src/
│       │   └── styles.css
│       └── index.html
├── assets/
│   └── font/
│       └── vcp-ui/
│           └── noto-sans-sc.css
├── audio_engine/
│   ├── audio_server.exe
│   ├── audio_server.old.soxR.exe
│   ├── audio_server_rubato.exe
│   └── audio_server_x86兼容版.exe
├── bootstrap/
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
│   └── chart.js
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
│   └── desktop.js
├── Dicemodules/
│   ├── dice-soundscape.js
│   ├── dice.css
│   ├── dice.html
│   └── dice.js
├── examples/
│   └── animated-launchpad/
│       └── index.html
├── Flowlockmodules/
│   ├── flowlock-integration.js
│   ├── flowlock-protocol.js
│   ├── flowlock.css
│   └── flowlock.js
├── Forummodules/
│   ├── forum.css
│   ├── forum.html
│   └── forum.js
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
│   └── migrateAvatars.js
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
│   │   │   └── web-agent-runtime-core.js
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
│   │   ├── vcp-main-ui-runtime.js
│   │   ├── vcp-ui.js
│   │   ├── webawesome-adapter.js
│   │   ├── webawesome-comparison.js
│   │   └── webawesome-runtime-manifest.js
│   ├── uiux/
│   │   ├── generated/
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
│   │   ├── music-stage-advanced-modes.js
│   │   ├── music-stage-config.js
│   │   ├── music-stage-host.js
│   │   ├── music-stage-modes.js
│   │   ├── music-stage-runtime.js
│   │   └── music-stage.css
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
│   └── socket.io.min.js
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
│   ├── modular-prompt-module.js
│   ├── original-prompt-module.js
│   ├── preset-prompt-module.js
│   ├── prompt-manager.js
│   └── prompt-modules.css
├── RAGmodules/
│   ├── rag-observer-config.js
│   ├── RAG_Observer.html
│   └── RAG_Overlay.html
├── rust_assistant_engine/
│   ├── runtime/
│   │   └── assistant_core_server-Windows-X64/
│   │       └── assistant_core_server-windows-x64.exe
│   └── ui/
│       ├── assistant-bar.html
│       ├── assistant-bar.js
│       ├── assistant.css
│       ├── assistant.html
│       └── assistant.js
├── rust_audio_engine/
│   └── build-runtime.js
├── rust_chat_data_service/
│   └── build-runtime.js
├── rust_projectforge_indexer/
│   ├── bench.js
│   └── build-runtime.js
├── rust_voice_input_engine/
│   ├── runtime/
│   │   └── win32-x64/
│   │       └── vcp_voice_input_engine.exe
│   └── build-runtime.js
├── ScriptoriumModules/
│   ├── font-font-test.html
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
│   ├── vdoc-container.js
│   ├── vdoc-core.js
│   ├── vdoc-hybrid-compiler.js
│   ├── vdoc-style-library.js
│   └── vdoc-svg-asset-library.js
├── scripts/
│   ├── desktopremote-http-smoke.js
│   └── scriptorium-line-break-diagnostic.js
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
│   ├── chat-manager-selection-race.test.js
│   ├── contribution-registry.test.js
│   ├── creation-controller.test.js
│   ├── deepmemo-central-adapter.test.js
│   ├── desktop-living-icons.test.js
│   ├── diorama-director.test.js
│   ├── diorama-events.test.js
│   ├── embedded-app-controller.test.js
│   ├── embedded-app-security.test.js
│   ├── emoticon-url-fixer.test.js
│   ├── escape-dispatcher.test.js
│   ├── flowlock-timestamp-bindings.test.js
│   ├── frontend-plugins.test.js
│   ├── git-service.test.js
│   ├── global-jev-service.test.js
│   ├── group-chat-queue-interrupt.test.js
│   ├── group-context-window.test.js
│   ├── group-jev-decision-mode.test.js
│   ├── group-jev-integration-contract.test.js
│   ├── group-jev-session-orchestrator.test.js
│   ├── group-sequential-mode.test.js
│   ├── history-watcher-lease-manager.test.js
│   ├── input-enhancer-note-keyboard.test.js
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
│   ├── main-chat-sequence-model.test.js
│   ├── main-chat-stream-consumer.test.js
│   ├── main-chat-voice-composer.test.js
│   ├── message-edit-watcher-failure.test.js
│   ├── message-regeneration-stream-animation.test.js
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
│   ├── notification-change-audit.test.js
│   ├── notification-menu-controller.test.js
│   ├── overlay-coordinator.test.js
│   ├── performance-recorder.test.js
│   ├── pixi-stage-scenes.test.js
│   ├── powershell-window-ipc-isolation.test.js
│   ├── preload-registry.test.js
│   ├── project-forge-ast.test.js
│   ├── project-forge-event-ipc.test.js
│   ├── project-forge-robustness.test.js
│   ├── project-forge-trace.test.js
│   ├── project-forge.test.js
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
│   ├── settlement.test.js
│   ├── single-chat-request-orchestrator.test.js
│   ├── source-service.test.js
│   ├── startup-theme-gate.test.js
│   ├── state-authority.test.js
│   ├── state-channel.test.js
│   ├── stream-manager-terminal-cleanup.test.js
│   ├── surface-controller.test.js
│   ├── task-handle.test.js
│   ├── tavern-rules-engine.test.js
│   ├── theme-handlers.test.js
│   ├── tool-request-scanner.test.js
│   ├── tool-result-regions.test.js
│   ├── topic-list-mode-lifecycle.test.js
│   ├── ui-helper-chat-scroll-follow.test.js
│   ├── ui-helpers-settings-close.test.js
│   ├── voice-composer-interaction.test.js
│   ├── voice-input-engine.test.js
│   ├── window-pin-service.test.js
│   ├── window-state-service.test.js
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
│   ├── index.html
│   ├── main.js
│   ├── preload.js
│   ├── script.js
│   └── style.css
├── VCPDistributedServer/
│   ├── Plugin/
│   │   ├── BladeGame/
│   │   │   ├── blade-electron.css
│   │   │   ├── blade-electron.html
│   │   │   ├── blade-electron.js
│   │   │   ├── blade-preload.js
│   │   │   └── blade-service.js
│   │   ├── ChartController/
│   │   │   └── ChartControllerService.js
│   │   ├── ChatRoomViewer/
│   │   │   └── ChatRoomViewer.js
│   │   ├── CodeSearcher/
│   │   │   ├── CodeSearcher-x86_64-pc-windows-msvc.exe
│   │   │   ├── CodeSearcher.exe
│   │   │   └── CodeSearcher.js
│   │   ├── DeepMemo/
│   │   │   ├── DeepMemo.js
│   │   │   ├── deepmemo_rust.exe
│   │   │   └── DeepMemoService.js
│   │   ├── DesktopRemote/
│   │   │   └── desktop-remote.js
│   │   ├── DistImageServer/
│   │   │   └── image-server.js
│   │   ├── FileOperator/
│   │   │   ├── CodeValidator.js
│   │   │   └── FileOperator.js
│   │   ├── LoomController/
│   │   │   ├── LoomControllerService.js
│   │   │   └── LoomSkillService.js
│   │   ├── MusicController/
│   │   │   └── music-controller.js
│   │   ├── OldPowerShellExecutor/
│   │   │   └── PowerShellExecutor.js
│   │   ├── PluginSourceViewer/
│   │   │   └── PluginSourceViewer.js
│   │   ├── PowerShellExecutor/
│   │   │   ├── PowerShellExecutor.js
│   │   │   ├── test_interactive_sequence.js
│   │   │   └── test_security_check.js
│   │   ├── ProjectForge/
│   │   │   ├── args.js
│   │   │   ├── engine.js
│   │   │   ├── indexerClient.js
│   │   │   ├── linkGraph.js
│   │   │   ├── ProjectForgeService.js
│   │   │   ├── store.js
│   │   │   ├── symbolResolver.js
│   │   │   ├── tickets.js
│   │   │   └── workspace.js
│   │   ├── PromptSponsor/
│   │   │   ├── prompt-sponsor-service.js
│   │   │   └── prompt-sponsor.js
│   │   ├── PTYShellExecutor/
│   │   │   ├── PluginErrorReporter.js
│   │   │   ├── PTYShellExecutor.impl.js
│   │   │   ├── PTYShellExecutor.js
│   │   │   ├── ShellOutputPipeline.js
│   │   │   └── ShellThemeBridge.js
│   │   ├── ScreenPilot/
│   │   │   └── ScreenPilotService.js
│   │   ├── ScriptoriumCollaborator/
│   │   │   └── ScriptoriumCollaboratorService.js
│   │   ├── TopicMemo/
│   │   │   └── TopicMemo.js
│   │   ├── TopicSponsor/
│   │   │   ├── topicsponsor-service.js
│   │   │   └── topicsponsor.js
│   │   ├── VChatAutoTTS/
│   │   │   ├── plugin.css
│   │   │   └── plugin.js
│   │   ├── VChatDynamicWallpaper/
│   │   │   ├── plugin.css
│   │   │   └── plugin.js
│   │   ├── VCPEverything/
│   │   │   └── local-search-controller.js
│   │   ├── VCPMobileSync/
│   │   │   ├── error-contract.js
│   │   │   ├── index.js
│   │   │   └── protocol.js
│   │   ├── VCPSuperDice/
│   │   │   ├── example style.css
│   │   │   ├── example.js
│   │   │   └── superdice.js
│   │   ├── VCPWEWallpaper/
│   │   │   └── we-wallpaper-service.js
│   │   ├── VCPWEWallpaperUI/
│   │   │   ├── plugin.css
│   │   │   └── plugin.js
│   │   └── WindowSensor/
│   │       └── sensor-wrapper.js
│   ├── shared/
│   │   └── fileKit/
│   │       ├── diff.js
│   │       ├── index.js
│   │       ├── output.js
│   │       ├── paths.js
│   │       ├── reader.js
│   │       ├── text.js
│   │       └── validator.js
│   ├── frontend-plugin-loader.js
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
│   │   └── PathResolver.js
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
│   ├── preload.js
│   ├── renderer.js
│   └── style.css
├── Voicechatmodules/
│   ├── recognizer.html
│   ├── voice-input-capture.html
│   ├── voice-input-capture.js
│   ├── voicechat.css
│   ├── voicechat.html
│   └── voicechat.js
├── WebIndexTTS2/
│   └── server.js
├── main.html
├── main.js
├── preload.js
├── renderer.js
├── splash.html
├── StartVCPchat.exe
├── style.css
└── test.html
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
