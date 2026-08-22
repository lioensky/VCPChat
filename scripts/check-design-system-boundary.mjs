import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import postcss from 'postcss';

const root = process.cwd();
// Pin the reviewed, workflow-free product snapshot. The former subtraction
// anchor predates several months of upstream product work, while a leftover
// local `upstream/main` ref may be older still. Both make accepted product
// changes look like design-system violations. Environment overrides remain
// available when a PR intentionally audits against a newly reviewed snapshot.
const sourceRef = process.env.VCP_DESIGN_SOURCE_REF || 'b5931a69d0815a1dfd60c079093ed5518a73dc77';
// Compare the reviewed subtraction snapshot against the current product main
// as the second ancestry boundary. The snapshot is intentionally not itself
// the upstream ref: this branch may contain unrelated upstream product work
// that is already present on main and must not be reported as a design delta.
const upstreamRef = process.env.VCP_UPSTREAM_REF || 'origin/main';
const failures = [];

const forbiddenPaths = [
    /^\.cargo\/config\.toml$/,
    /^\.github\/workflows\/codex_agent_windows\.yml$/,
    /^agent-runtime\//,
    /^docs\/agent-runtime\//,
    /^docs\/gui-current-development-status\.md$/,
    /^fixtures\/codex/i,
    /^modules\/codex-runtime\//,
    /^modules\/agent-config-descriptors\.js$/,
    /^modules\/ipc\/agentRuntimeHandlers\.js$/,
    /^modules\/ui-system\/agent-/,
    /^styles\/ui-system\/agent-/,
    /^rust(?:-tui)?\//,
    /^(?:clippy|rustfmt|rust-toolchain)\.toml$/,
    /^eslint\.agent\.config\.mjs$/,
    /^scripts\/.*(?:codex|agent)/i,
    /^scripts\/(?:rust-live-preflight|test-runtime-service-contexts|test-vcp-content-projection|live-fileoperator-node|fixtures\/render-message-contract-child)\./,
];

const allowedSourceDifferences = new Set([
    '.github/workflows/canonical_ui.yml',
    '.github/workflows/chat_kernel_ui.yml',
    '.gitattributes',
    '.gitignore',
    'README.md',
    'RAGmodules/RAG_Observer.html',
    // Deletion side of the 2026-08 documentation archive moves. Current
    // content is allowed only through the archive path pattern below.
    'docs/next-ui-webawesome-roadmap.md',
    'docs/next-ui-lifecycle-architecture.md',
    'docs/next-ui-development-roadmap.md',
    'docs/deepseek-harness-ui-ux-research.md',
    'docs/ui-interaction-accessibility-roadmap.md',
    'docs/next-ui-current-state.md',
    'docs/classic-retirement-architecture.md',
    'docs/classic-retirement-inventory.md',
    'docs/main-chat-operation-sequence-testing.md',
    'docs/design-system-upstream-pr-convergence.md',
    'docs/ui-active-surface-policy.md',
    'docs/appearance-design-system.md',
    'docs/ui-components-wa-matrix.md',
    'docs/ui-engineering-standard.md',
    'docs/ui-system.md',
    'docs/ui-applications-webawesome-migration-plan.md',
    'docs/deepseek-harness-ui-ux-research.md',
    'docs/ui-interaction-accessibility-gaps.md',
    'docs/ui-interaction-accessibility-roadmap.md',
    'docs/ui-harness-external-evidence-checklist.md',
    'docs/vcpchat-bootstrap-contracts.md',
    'docs/vcpchat-managed-launch-architecture.md',
    'docs/vcpchat-hermes-inspired-launcher-roadmap.md',
    'docs/vcpchat-bootstrap-completion-audit.md',
    'docs/vcpchat-launcher-user-guide.md',
    'docs/ui-system-qa-matrix.md',
    'docs/upstream-function-parity.md',
    'Groupmodules/grouprenderer.js',
    'Notemodules/notes.css',
    'main.html',
    'main.js',
    'audio_engine/audio_server',
    'rust_assistant_engine/runtime/assistant_core_server-Linux-X64/assistant_core_server-linux-x64',
    'rust_assistant_engine/runtime/assistant_core_server-macOS-ARM64/assistant_core_server-macos-x64',
    'bootstrap/recovery-main.cjs',
    'bootstrap/recovery-preload.cjs',
    'bootstrap/recovery-renderer.js',
    'bootstrap/recovery.html',
    'bootstrap/recovery.css',
    'launchers/VCPChat-Launcher.command',
    'launchers/VCPChat-Launcher.sh',
    'launchers/VCPChat-Launcher.vbs',
    'launchers/VCPChat-Setup.command',
    'modules/bootstrap/contracts.js',
    'modules/bootstrap/bootstrap-marker.js',
    'modules/bootstrap/diagnostic-report.js',
    'modules/bootstrap/environment-doctor.js',
    'modules/bootstrap/launch-protocol.js',
    'modules/bootstrap/packed-runtime.js',
    'modules/bootstrap/platform-process.js',
    'tests/vcpchat-platform-boundary.test.mjs',
    'modules/bootstrap/process-runner.js',
    'modules/bootstrap/progress-protocol.js',
    'modules/bootstrap/repair-manifest.js',
    'modules/bootstrap/repair-planner.js',
    'modules/bootstrap/runtime-closure.js',
    'modules/bootstrap/update-manager.js',
    'modules/bootstrap/update-downloader.js',
    'scripts/vcpchat.mjs',
    'modules/chatManager.js',
    'modules/assistant/assistant-rust-adapter.js',
    'modules/event-listeners.js',
    'modules/filterManager.js',
    'modules/global-settings-manager.js',
    'modules/inputEnhancer.js',
    'modules/notificationRenderer.js',
    'modules/settingsManager.js',
    'modules/weatherService.js',
    'modules/itemListManager.js',
    'modules/ipc/deepWikiHandlers.js',
    'modules/ipc/chatHandlers.js',
    'modules/ipc/canvasHandlers.js',
    'modules/ipc/desktopHandlers.js',
    'modules/ipc/agentHandlers.js',
    'modules/ipc/assistantHandlers.js',
    'modules/ipc/voiceHandlers.js',
    'modules/ipc/settingsHandlers.js',
    'modules/ipc/themeHandlers.js',
    'modules/ipc/windowHandlers.js',
    'modules/mainChatCommands.js',
    'modules/messageRenderer.js',
    'modules/renderer/mainChatComposition.js',
    'modules/renderer/mainChatDomBindings.js',
    'modules/renderer/streamProjectionRuntime.js',
    'modules/renderer/topicSelectionReadiness.js',
    'modules/renderer/ownedPreloadSubscription.js',
    'modules/renderer/mainChatEventBridge.js',
    'modules/renderer/nonStreamingEventConsumer.js',
    'modules/renderer/animation.js',
    'modules/renderer/contentPipeline.js',
    'modules/renderer/contentProcessor.js',
    'modules/notificationRenderer.js',
    'modules/renderer/messageContextMenu.js',
    'modules/renderer/streamManager.js',
    'modules/searchManager.js',
    'modules/settingsManager.js',
    'modules/services/deepWikiService.js',
    'modules/services/embeddedAppSessionManager.js',
    'modules/services/historyWatcherLeaseManager.js',
    'modules/services/senderTaskRegistry.js',
    'modules/services/windowStateService.js',
    'modules/shared/embeddedAppAllowlist.js',
    'modules/topTabManager.js',
    'modules/topicListManager.js',
    'modules/trayManager.js',
    'modules/ui-helpers.js',
    'modules/uiManager.js',
    'VCPDistributedServer/frontend-plugin-loader.js',
    'VCPDistributedServer/Plugin/VCPMobileSync/core/logger.js',
    'modules/ipc/ipcContracts.js',
    'modules/ui-system/vcp-main-ui-runtime.js',
    'modules/ui-system/lifecycle-scope.js',
    'modules/ui-system/lifecycle-inspector.js',
    'modules/ui-system/settings-settlement.js',
    'modules/ui-system/performance-recorder.js',
    'modules/ui-system/task-handle.js',
    'modules/ui-system/contribution-registry.js',
    'modules/ui-system/component-manifest.js',
    'modules/ui-system/component-showcase.js',
    'modules/ui-system/state-channel.js',
    'modules/ui-system/settlement.js',
    'modules/ui-system/surface-controller.js',
    'modules/ui-system/next-shell/overlay-coordinator.js',
    'modules/ui-system/next-shell/embedded-app-controller.js',
    'modules/ui-system/next-shell/app-tab-host.js',
    'modules/ui-system/next-shell/assistant-search-controller.js',
    'modules/ui-system/next-shell/account-menu-controller.js',
    'modules/ui-system/next-shell/launchpad-controller.js',
    'modules/ui-system/next-shell/creation-controller.js',
    'modules/ui-system/next-shell/next-shell-controller.js',
    'modules/ui-system/next-ui-apps.js',
    'scripts/check-theme-provenance.mjs',
    'scripts/check-ui-async-state-matrix.mjs',
    'scripts/check-ui-harness-evidence.mjs',
    'scripts/check-ui-interaction-inventory.mjs',
    'scripts/check-ui-task-journeys.mjs',
    'scripts/test-electron-ui-apps-smoke.mjs',
    'scripts/test-ui-motion-contract.mjs',
    'scripts/vcpchat-dev-launcher.mjs',
    'scripts/vcpchat-doctor.mjs',
    'scripts/vcpchat-bootstrap.mjs',
    'scripts/vcpchat-packed-smoke.mjs',
    'scripts/vcpchat-recovery-ui.mjs',
    'scripts/vcpchat-release-evidence.mjs',
    'scripts/vcpchat-repair.mjs',
    'scripts/vcpchat-runtime-closure.mjs',
    'scripts/vcpchat-update.mjs',
    'scripts/electron-builder-bootstrap-hooks.cjs',
    'scripts/ui-async-state-matrix.json',
    'scripts/ui-interaction-inventory.json',
    'scripts/ui-task-journey-matrix.json',
    'modules/ui-system/appearance-engine.js',
    'modules/ui-system/appearance-studio.js',
    'modules/ui-system/ask-nova-modal.js',
    'modules/ui-system/lucide-adapter.js',
    'modules/ui-system/ui-surface-policy.js',
    'modules/ui-system/vcp-ui.js',
    'modules/ui-system/settings-bridge.js',
    'modules/ui-system/ui-mode-controller.js',
    'modules/ui-system/vcp-page-rebuild.js',
    'modules/ui-system/vcp-ui-runtime-bootstrap.js',
    'modules/ui-system/startup-theme-gate.js',
    'modules/ui-system/webawesome-adapter.js',
    'modules/ui-system/webawesome-comparison.js',
    'modules/ui-system/webawesome-runtime-manifest.js',
    'modules/utils/appSettingsManager.js',
    'modules/uiModeManager.js',
    'Promptmodules/prompt-manager.js',
    'package-lock.json',
    'package.json',
    'preloads/chat.js',
    'preloads/shared/catalog.js',
    'preloads/shared/roles.js',
    'preloads/utility.js',
    'renderer.js',
    'Translatormodules/translator.css',
    'Translatormodules/translator.js',
    'rust_chat_data_service/Cargo.toml',
    'rust_chat_data_service/src/ingest.rs',
    'rust_chat_data_service/src/search.rs',
    'rust_chat_data_service/src/sync.rs',
    'rust_chat_data_service/src/watcher.rs',
    'scripts/check-design-system-boundary.mjs',
    'scripts/check-classic-parity.mjs',
    'scripts/check-classic-retirement-boundary.mjs',
    'scripts/check-next-delta-contract.mjs',
    'scripts/next-delta-shared-baseline.json',
    'scripts/promote-canonical-ui-css.mjs',
    'scripts/remove-retired-classic-main-dom.mjs',
    'scripts/build-webawesome-runtime.mjs',
    'scripts/check-webawesome-pack.mjs',
    'scripts/check-ui-applications.mjs',
    'scripts/check-ui-system.mjs',
    'scripts/check-vcpui-consumers.mjs',
    'scripts/vcpui-production-consumers.json',
    'scripts/test-ui-system.mjs',
    'scripts/test-appearance-engine.mjs',
    'scripts/test-appearance-studio.mjs',
    'scripts/test-ask-nova-service.mjs',
    'scripts/test-settings-wa.mjs',
    'scripts/test-page-runtime.mjs',
    'scripts/test-next-ui-tab-lifecycle.mjs',
    'scripts/test-next-ui-empty-state.mjs',
    'scripts/test-ui-mode-controller.mjs',
    'scripts/test-ui-mode-manager.mjs',
    'scripts/test-webawesome-adapter.mjs',
    'scripts/test-vcp-ui-select-proxy.mjs',
    'scripts/test-electron-ui-apps-smoke.mjs',
    'scripts/test-electron-lifecycle-stress.mjs',
    'scripts/test-electron-main-chat-sequences.mjs',
    'scripts/test-electron-windows-matrix.mjs',
    'scripts/test-settings-wa-electron.mjs',
    'tests/frontend-plugins.test.js',
    'tests/lifecycle-scope.test.js',
    'tests/lifecycle-inspector.test.js',
    'tests/performance-recorder.test.js',
    'tests/embedded-app-security.test.js',
    'tests/task-handle.test.js',
    'tests/sender-task-registry.test.js',
    'tests/contribution-registry.test.js',
    'tests/state-channel.test.js',
    'tests/state-authority.test.js',
    'tests/window-state-service.test.js',
    'tests/surface-controller.test.js',
    'tests/app-tab-host.test.js',
    'tests/assistant-search-controller.test.js',
    'tests/account-menu-controller.test.js',
    'tests/launchpad-controller.test.js',
    'tests/creation-controller.test.js',
    'tests/global-settings-save.test.mjs',
    'tests/startup-theme-gate.test.js',
    'tests/theme-handlers.test.js',
    'tests/embedded-app-controller.test.js',
    'tests/overlay-coordinator.test.js',
    'tests/next-ui-registries.test.mjs',
    'tests/topic-list-mode-lifecycle.test.js',
    'tests/chat-manager-selection-race.test.js',
    'tests/history-watcher-lease-manager.test.js',
    'tests/message-edit-watcher-failure.test.js',
    'tests/stream-manager-terminal-cleanup.test.js',
    'tests/desktop-push-consumer.test.mjs',
    'tests/emoticon-fixer-owner.test.mjs',
    'tests/image-handler-owner.test.mjs',
    'tests/middle-click-owner.test.mjs',
    'tests/render-session-authority.test.mjs',
    'tests/surface-conversation.test.mjs',
    'tests/surface-task-owner.test.mjs',
    'tests/visibility-optimizer-owner.test.mjs',
    'tests/main-chat-sequence-model.test.js',
    'tests/main-chat-event-bridge.test.mjs',
    'tests/main-chat-dom-bindings.test.mjs',
    'tests/main-chat-state-authority.test.mjs',
    'tests/topic-selection-readiness.test.mjs',
    'tests/owned-preload-subscription.test.mjs',
    'tests/non-streaming-event-consumer.test.mjs',
    'tests/stream-transient-history.test.mjs',
    'tests/settlement.test.js',
    'tests/settings-settlement.test.js',
    'tests/vcpchat-bootstrap.test.mjs',
    'tests/vcpchat-managed-bootstrap-m3-m8.test.mjs',
    'tests/support/main-chat-sequence.js',
    'style.css',
    'styles/notifications.css',
    'styles/animations.css',
    'styles/layout.css',
    'styles/compact-sidebar.css',
    'styles/components.css',
    'styles/settings.css',
    'styles/themes.css',
    'styles/chat.css',
    'styles/appearance.css',
    'styles/setting/settings-global-modal.css',
    'styles/themes/themes纸墨与机芯.css',
    'styles/ui-next.css',
    'styles/ui-system/shell.css',
    'styles/ui-system/sidebar.css',
    'styles/ui-system/components.css',
    'styles/ui-system/appearance-studio.css',
    'styles/ui-system/ask-nova.css',
    'styles/ui-system/business-modals.css',
    'styles/ui-system/chat-input.css',
    'styles/ui-system/fonts.css',
    'styles/ui-system/group-settings.css',
    'styles/ui-system/runtime.css',
    'styles/ui-system/index.css',
    'styles/ui-system/messages.css',
    'styles/ui-system/notifications.css',
    'styles/ui-system/settings.css',
    'styles/ui-system/showcase.css',
    'styles/ui-system/tokens.css',
    'styles/ui-system/webawesome-adapter.css',
    'assets/nova_button.png',
    'assets/nova_button_light.png',
    'assets/svg/acrylic-noise.svg',
    'Notemodules/notes.js',
    'renderer.js',
    'modules/messageRenderer.js',
    'modules/renderer/streamManager.js',
    'modules/chat/streamTransientHistory.js',
    'modules/renderer/desktopPushConsumer.js',
    'modules/renderer/domBuilder.js',
    'modules/renderer/emoticonUrlFixer.js',
    'modules/renderer/enhancedColorUtils.js',
    'modules/renderer/imageHandler.js',
    'modules/renderer/renderSessionAuthority.js',
    'modules/renderer/surfaceTaskOwner.js',
    'modules/renderer/visibilityOptimizer.js',
    'modules/text-viewer.js',
    'scripts/check-chat-kernel-consumers.mjs',
    'docs/chat-kernel-consumer-report.json',
    'docs/chat-kernel-deep-decoupling-roadmap.md',
    'docs/chat-kernel-vd7-final-audit.md',
    'docs/deepseek-harness-plugin-ui-architecture-research.md',
    'docs/chat-kernel-rendering-roadmap.md',
    'Voicechatmodules/voicechat.js',
    'Voicechatmodules/voicechat.html',
    'rust_assistant_engine/ui/assistant.js',
    'rust_assistant_engine/ui/assistant.html',
    'Flowlockmodules/flowlock-integration.js',
    'Flowlockmodules/flowlock.js',
    'VCPDistributedServer/Plugin/VChatAutoTTS/plugin.js',
    'modules/event-listeners.js',
    'modules/renderer/middleClickHandler.js',
]);
const allowedSourceDifferencePatterns = [
    /^docs\/archive\/2026-08-chat-kernel-and-ui-roadmaps\//,
    // Chat Kernel D5/D6 owner modules and focused lifecycle tests belong to
    // this review slice, not to the design-system subtraction leak set.
    /^modules\/renderer\/(?:domListenerOwner|forwardMessageOwner|mainChatAttachmentOwner|mainChatAuxiliaryEventOwner|mainChatFlowlockOwner|mainChatSendOwner|mainChatSettingsOwner|mainChatThemeOwner|ttsSurfaceOwner)\.js$/,
    /^tests\/(?:dom-listener-owner|enhanced-color-utils-lifecycle|forward-message-owner|input-enhancer-owner|main-chat-attachment-owner|main-chat-auxiliary-event-owner|main-chat-flowlock-owner|main-chat-send-owner|main-chat-theme-owner|notification-renderer-lifecycle|tts-surface-owner|ui-manager-lifecycle)\.test\.(?:js|mjs)$/,
    /^scripts\/test-electron-manual-soak\.mjs$/,
    // Generated evidence is audited output, not product UI source.
    /^artifacts\/(?:manual-soak|windows-matrix)\/[^/]+\.json$/,
    // Contract/evidence automation is a gate layer and must not be treated as
    // a design-system subtraction delta.
    /^docs\/contracts\//,
    /^docs\/chat-kernel-evidence-and-contracts-roadmap\.md$/,
    /^docs\/chat-event-producer-consumer-roadmap\.md$/,
    /^docs\/stream-switch-tool-wait-recovery\.md$/,
    /^scripts\/(?:build-chat-event-graph|check-chat-contracts|check-chat-evidence|check-artifact-plane|run-chat-contract-invariants|test-built-artifact-smoke|test-chat-contract-invalid|test-chat-transcript-snapshot|write-chat-evidence-manifest)\.mjs$/,
    // Evidence-plane runners are release contracts, not UI subtraction code.
    /^scripts\/(?:check-chat-release-evidence|test-artifact-plane-invalid|test-chat-evidence-manifest|test-chat-release-evidence-invalid|test-facade-registry-invalid|test-packaged-artifact-invalid|test-packaged-artifact-smoke)\.mjs$/,
    /^scripts\/fixtures\/chat-contract-invalid\.mjs$/,
    /^tests\/chat-event-contract\.test\.mjs$/,
    /^vendor\/webawesome(?:-runtime)?\//,
    /^modules\/chat\//,
    /^modules\/renderer\/(?:mainChatComposition|mainChatSettingsPresentationOwner|mainChatStreamConsumer|mainChatSurfaceAdapter|renderDependencies|windowStreamRuntime)\.js$/,
    /^tests\/(?:notification-renderer-lifecycle|main-chat-settings-owner)\.test\.mjs$/,
    /^modules\/ui-system\/(?:standalone-chat-app|interactive-chat-app)\.js$/,
    /^Voicechatmodules\/voicechat\.js$/,
    /^rust_assistant_engine\/ui\/assistant\.(?:js|html)$/,
    /^Flowlockmodules\/flowlock-integration\.js$/,
    /^modules\/event-listeners\.js$/,
    /^tests\/(?:chat-|content-|stream-|memory-chat-repository|window-stream-runtime|render-dependencies|main-chat-surface-adapter|vcp-stream-bridge)/,
    /^(?:Agenttaskmodules|Forummodules|Logmodules|Memomodules|PluginManagerModules|VCPHumanToolBox|VchatManager)\//,
    /^Notemodules\/notemini\.(?:html|js|css)$/,
];

const upstreamClassicPatterns = [
    /^(?:Agenttaskmodules|Forummodules|Logmodules|Memomodules|PluginManagerModules|VCPHumanToolBox|VchatManager)\//,
    /^Notemodules\/notes\.(?:html|js|css)$/,
    /^Notemodules\/notemini\.(?:html|js|css)$/,
    /^Translatormodules\/translator\.(?:html|js|css)$/,
    /^RAGmodules\/RAG_Observer\.html$/,
];

function git(args) {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
}

const trackedFiles = git(['ls-files']).split('\n').filter(Boolean);
for (const file of trackedFiles) {
    if (forbiddenPaths.some(pattern => pattern.test(file))) failures.push(`${file}: forbidden Build/Codex path remains`);
}

const runtimeFiles = trackedFiles.filter(file => (
    /^(?:main\.html|main\.js|renderer\.js|package\.json)$/.test(file)
    || /^(?:modules|preloads|styles)\//.test(file)
) && /\.(?:html|js|mjs|cjs|css|json)$/.test(file));
const forbiddenRuntimeTerms = /VCPBuild|Agent Workbench|modules\/codex-runtime|agent-runtime:|agent-session:|agent-workspace:|agent-chat-root|agent-chat-notification-view|shared-notification-surface/i;
for (const file of runtimeFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (forbiddenRuntimeTerms.test(source)) failures.push(`${file}: forbidden Build/Codex runtime reference remains`);
}

const subtractionLeakFiles = trackedFiles.filter(file => (
    /^rust_chat_data_service\/(?:Cargo\.toml|src\/.*\.rs)$/.test(file)
    || /^(?:main\.js|package\.json)$/.test(file)
));
const forbiddenSubtractionTerms = /vcp-shadow-index|vcp_shadow_index|Rust Agent runtime|agent-state\.json|\.vcp-agent\./i;
for (const file of subtractionLeakFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (forbiddenSubtractionTerms.test(source)) failures.push(`${file}: removed Build/Agent dependency leaked into retained runtime`);
}

const requiredRetainedFiles = [
    'assets/font/Orbitron.ttf',
    'assets/nova_button.png',
    'assets/nova_button_light.png',
    'styles/ui-next.css',
    'modules/topTabManager.js',
    'modules/ui-system/lifecycle-scope.js',
    'modules/services/deepWikiService.js',
    'modules/services/embeddedAppSessionManager.js',
    'modules/ui-system/ask-nova-modal.js',
    'styles/ui-system/ask-nova.css',
    'Notemodules/notes.html',
    'Translatormodules/translator.html',
];
for (const file of requiredRetainedFiles) {
    if (!fs.existsSync(path.join(root, file))) failures.push(`${file}: required development-tree design asset is missing`);
}

const embeddedHostSource = fs.readFileSync(path.join(root, 'modules/services/embeddedAppSessionManager.js'), 'utf8');
if (/vcpApiKey|vcpServerUrl/.test(embeddedHostSource)) {
    failures.push('embeddedAppSessionManager.js: secrets or server credentials must not enter embedded page descriptors');
}
if (/executeJavaScript|insertCSS/.test(embeddedHostSource)) {
    failures.push('embeddedAppSessionManager.js: embedded mode must be declared by preload, not post-load injection');
}

const retainedEventListenersSource = fs.readFileSync(path.join(root, 'modules/event-listeners.js'), 'utf8');
if (/\bgetAgentSidebar\b/.test(retainedEventListenersSource)) {
    failures.push('event-listeners.js: removed Agent sidebar accessor leaked into the retained main-chat sidebar controls');
}

const nextCommandConsumers = [
    'modules/topTabManager.js',
    'modules/ui-system/appearance-studio.js',
];
for (const file of nextCommandConsumers) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (/\.click\(\)/.test(source)) {
        failures.push(`${file}: Next presentation must call commands instead of clicking hidden Classic DOM`);
    }
}

const embeddedAllowlistSource = fs.readFileSync(path.join(root, 'modules/shared/embeddedAppAllowlist.js'), 'utf8');
for (const action of [
    'open-notes-window', 'open-note-mini-window', 'open-translator-window',
    'open-memo-window', 'open-forum-window', 'open-log-window',
    'open-themes-window', 'open-task-window', 'open-plugin-manager-window',
]) {
    const occurrences = embeddedAllowlistSource.split(`action: '${action}'`).length - 1;
    if (occurrences !== 1) failures.push(`embeddedAppAllowlist.js: ${action} must have exactly one trusted descriptor`);
}

const cssFiles = trackedFiles.filter(file => file === 'styles/ui-next.css' || /^styles\/ui-system\/.*\.css$/.test(file));
for (const file of cssFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
        const reference = match[2].trim();
        if (!reference || reference.startsWith('#') || /^(?:data:|https?:|var\()/i.test(reference)) continue;
        const target = path.resolve(path.dirname(path.join(root, file)), reference.split(/[?#]/, 1)[0]);
        if (!fs.existsSync(target)) failures.push(`${file}: missing local CSS asset ${reference}`);
    }
}

// Inspect the committed theme, not an unrelated user-owned working-tree edit.
const activeThemeSource = git(['show', 'HEAD:styles/themes.css']);
if (!activeThemeSource.includes(':focus-visible:not(#messageInput):not(.chat-message-input)')) {
    failures.push('styles/themes.css: design theme must preserve the main composer focus contract');
}
if (/(^|[},]\s*):focus-visible\s*\{/m.test(activeThemeSource)) {
    failures.push('styles/themes.css: unscoped focus styling must not override the main composer');
}

// ui-next.css owns the main-chat shell geometry while ui-system files own
// reusable components. Exact selector duplication across that boundary is a
// strong signal that cascade authority has forked again.
const shellSelectors = new Set();
postcss.parse(fs.readFileSync(path.join(root, 'styles/ui-next.css'), 'utf8')).walkRules(rule => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
    rule.selectors.forEach(selector => shellSelectors.add(selector.trim()));
});
for (const file of cssFiles.filter(file => file.startsWith('styles/ui-system/'))) {
    postcss.parse(fs.readFileSync(path.join(root, file), 'utf8')).walkRules(rule => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        for (const selector of rule.selectors) {
            if (shellSelectors.has(selector.trim())) {
                failures.push(`${file}: selector duplicates styles/ui-next.css shell authority: ${selector.trim()}`);
            }
        }
    });
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
    for (const match of String(command).matchAll(/(?:^|\s)(scripts\/[\w./-]+\.(?:mjs|cjs|js))/g)) {
        if (!fs.existsSync(path.join(root, match[1]))) failures.push(`package.json: script ${name} references missing ${match[1]}`);
    }
}

try {
    git(['rev-parse', '--verify', sourceRef]);
    git(['rev-parse', '--verify', upstreamRef]);
    const filesDifferentFromUpstream = new Set(
        git(['diff', '--ignore-space-at-eol', '--name-only', upstreamRef, '--'])
            .split('\n')
            .filter(Boolean)
    );
    const differences = git(['diff', '--ignore-space-at-eol', '--name-only', sourceRef, '--'])
        .split('\n')
        .filter(Boolean);
    for (const file of differences) {
        const restoredToUpstream = !filesDifferentFromUpstream.has(file);
        if (allowedSourceDifferences.has(file)
            || allowedSourceDifferencePatterns.some(pattern => pattern.test(file))
            || forbiddenPaths.some(pattern => pattern.test(file))
            || restoredToUpstream) continue;
        failures.push(`${file}: differs from ${sourceRef} outside the subtraction allowlist`);
    }
} catch {
    console.warn(`[DesignBoundary] Source ref ${sourceRef} is unavailable; skipped byte-parity audit.`);
}

try {
    git(['rev-parse', '--verify', upstreamRef]);
    const classicDifferences = git(['diff', '--name-only', upstreamRef, '--'])
        .split('\n')
        .filter(file => file && upstreamClassicPatterns.some(pattern => pattern.test(file)));
    for (const file of classicDifferences) {
        failures.push(`${file}: excluded Next surface must remain byte-identical to ${upstreamRef}`);
    }
} catch {
    console.warn(`[DesignBoundary] Upstream ref ${upstreamRef} is unavailable; skipped Classic parity audit.`);
}

if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
} else {
    console.log(`Design-system subtraction boundary passed (${trackedFiles.length} tracked files, ${cssFiles.length} CSS files).`);
}
