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
const upstreamRef = process.env.VCP_UPSTREAM_REF || sourceRef;
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
    '.gitattributes',
    '.gitignore',
    'README.md',
    'RAGmodules/RAG_Observer.html',
    'docs/next-ui-webawesome-roadmap.md',
    'docs/next-ui-lifecycle-architecture.md',
    'docs/next-ui-development-roadmap.md',
    'docs/next-ui-current-state.md',
    'docs/vcp-ui-provider-architecture.md',
    'docs/vcp-ui-long-term-roadmap.md',
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
    'docs/ui-system-qa-matrix.md',
    'docs/upstream-function-parity.md',
    'Groupmodules/grouprenderer.js',
    'Notemodules/notes.css',
    'main.html',
    'main.js',
    'modules/chatManager.js',
    'modules/event-listeners.js',
    'modules/filterManager.js',
    'modules/global-settings-manager.js',
    'modules/itemListManager.js',
    'modules/ipc/deepWikiHandlers.js',
    'modules/ipc/chatHandlers.js',
    'modules/ipc/desktopHandlers.js',
    'modules/ipc/agentHandlers.js',
    'modules/ipc/settingsHandlers.js',
    'modules/ipc/themeHandlers.js',
    'modules/ipc/windowHandlers.js',
    'modules/mainChatCommands.js',
    'modules/messageRenderer.js',
    'modules/notificationRenderer.js',
    'modules/renderer/messageContextMenu.js',
    'modules/renderer/middleClickHandler.js',
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
    'modules/ui-system/appearance-engine.js',
    'modules/ui-system/appearance-studio.js',
    'modules/ui-system/ask-nova-modal.js',
    'modules/ui-system/lucide-adapter.js',
    'modules/ui-system/ui-surface-policy.js',
    'modules/ui-system/vcp-ui.js',
    'modules/ui-system/settings-bridge.js',
    'modules/ui-system/settings-surface-session.js',
    'modules/ui-system/select-provider.js',
    'modules/ui-system/select-webawesome-proxy.js',
    'modules/ui-system/ui-mode-controller.js',
    'modules/ui-system/vcp-page-rebuild.js',
    'modules/ui-system/vcp-ui-runtime-bootstrap.js',
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
    'tests/embedded-app-controller.test.js',
    'tests/overlay-coordinator.test.js',
    'tests/next-ui-registries.test.mjs',
    'tests/topic-list-mode-lifecycle.test.js',
    'tests/chat-manager-selection-race.test.js',
    'tests/history-watcher-lease-manager.test.js',
    'tests/message-edit-watcher-failure.test.js',
    'tests/stream-manager-terminal-cleanup.test.js',
    'tests/main-chat-sequence-model.test.js',
    'tests/settlement.test.js',
    'tests/select-provider.test.js',
    'tests/select-webawesome-proxy.test.js',
    'tests/settings-surface-session.test.js',
    'tests/settings-settlement.test.js',
    'tests/support/main-chat-sequence.js',
    'style.css',
    'styles/notifications.css',
    'styles/animations.css',
    'styles/layout.css',
    'styles/compact-sidebar.css',
    'styles/components.css',
    'styles/settings.css',
    'styles/themes.css',
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
]);
const allowedSourceDifferencePatterns = [
    /^vendor\/webawesome(?:-runtime)?\//,
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
