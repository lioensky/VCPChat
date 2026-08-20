import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const exists = file => fs.existsSync(new URL(`../${file}`, import.meta.url));
const canonicalTextDigest = source => crypto.createHash('sha256')
    .update(source.replace(/\r\n/g, '\n'))
    .digest('hex');
const document = new JSDOM(read('main.html')).window.document;

assert.equal(canonicalTextDigest('line one\nline two\n'), canonicalTextDigest('line one\r\nline two\r\n'),
    'reviewed text baselines must be independent from the checkout line-ending policy');

for (const retiredFile of [
    'modules/uiModeManager.js',
    'modules/ui-system/settings-settlement.js',
    'modules/ui-system/ui-mode-controller.js',
    'modules/ui-system/vcp-page-rebuild.js',
    'modules/ui-system/vcp-ui-runtime-bootstrap.js',
    'styles/ui-system/runtime.css',
]) {
    assert.equal(exists(retiredFile), false, `${retiredFile} must not return without a production consumer`);
}
assert.equal(document.documentElement.dataset.uiMode, 'next', 'main.html must declare the canonical presentation');
assert.doesNotMatch(read('preloads/shared/catalog.js'), /onUiModeUpdated|ui-mode-updated/,
    'preload must not expose a presentation subscription without a sender and consumer');
assert.doesNotMatch(read('modules/renderer/streamManager.js'), /\binitStreamManager\b/,
    'StreamProjection must not retain the retired initStreamManager compatibility facade');

const canonicalIds = [
    'nextUiTopbar', 'nextUiAddTabBtn', 'nextUiCreateItemBtn',
    'nextUiAccountMenuTrigger', 'nextUiNotificationMenuBtn',
    'chatMessages', 'messageInput', 'sendMessageBtn', 'agentList',
    'tabContentTopics', 'tabContentSettings', 'notificationsList',
];
for (const id of canonicalIds) {
    assert.equal(document.querySelectorAll(`#${id}`).length, 1,
        `canonical/upstream shared element #${id} must exist exactly once`);
}

const retiredMainIds = [
    'createNewAgentBtn', 'createNewGroupBtn', 'openForumBtn',
    'themeToggleBtn', 'clearNotificationsBtn', 'doNotDisturbBtn',
    'minimize-to-tray-btn', 'minimize-btn', 'maximize-btn', 'restore-btn',
    'close-btn', 'settings-btn', 'title-bar-seam-fixer',
];
for (const id of retiredMainIds) {
    assert.equal(document.getElementById(id), null, `retired main control #${id} must not return`);
}

const mainRuntimeFiles = [
    'renderer.js',
    'modules/event-listeners.js',
    'modules/uiManager.js',
    'modules/filterManager.js',
    'modules/ui-helpers.js',
    'Groupmodules/grouprenderer.js',
];
for (const file of mainRuntimeFiles) {
    const source = read(file);
    for (const id of retiredMainIds) {
        assert.equal(source.includes(id), false,
            `${file} must not silently wire the retired main control #${id}`);
    }
}

const rendererSource = read('renderer.js');
const globalSettingsSource = read('modules/global-settings-manager.js');
const appearanceStudioSource = read('modules/ui-system/appearance-studio.js');
for (const [file, source] of [
    ['renderer.js', rendererSource],
    ['modules/global-settings-manager.js', globalSettingsSource],
    ['modules/ui-system/appearance-studio.js', appearanceStudioSource],
]) {
    assert.doesNotMatch(source, /(?:globalSettings|newSettings|draft|snapshot)\.uiMode|uiModeManager\.(?:apply|applyAsync)/,
        `${file} must not treat the retired main-window mode as live state`);
}
assert.doesNotMatch(appearanceStudioSource, /appearanceUiMode|enableNextUi|ui-mode-changed/,
    'Appearance Studio must only edit appearance, not a retired presentation switch');

const embeddedSource = read('modules/services/embeddedAppSessionManager.js');
assert.match(embeddedSource, /const uiMode = 'classic'/,
    'unmigrated child applications must keep an explicit upstream presentation policy');
assert.doesNotMatch(embeddedSource, /settings-updated|ui-mode-updated|subscribeSettings/,
    'main settings must not override the presentation policy of live child applications');

const vcpUiSource = read('modules/ui-system/vcp-ui.js');
assert.match(vcpUiSource, /_listen\(wa, 'wa-hide',[\s\S]*?event\.preventDefault\(\)[\s\S]*?finalize\(null\)/,
    'Web Awesome Modal dismissal must honor dismissibility and finalize the shared close contract');
assert.match(vcpUiSource, /_listen\(wa, 'wa-hide', event => \{[\s\S]*?event\.target !== wa[\s\S]*?_listen\(wa, 'wa-after-hide', event => \{[\s\S]*?event\.target !== wa/,
    'Web Awesome Modal must reject lifecycle events bubbled by nested components');
assert.match(vcpUiSource, /_listen\(wa, 'wa-after-hide',[\s\S]*?finalize\(null\)[\s\S]*?controller\.destroy\(\)/,
    'Web Awesome Modal teardown must defensively finalize before destroying resources');

const creationSource = read('modules/ui-system/next-shell/creation-controller.js');
assert.doesNotMatch(creationSource, /getSnapshot|whenSettled|pendingOperations|listeners|\brevision\b|\boperationId\b/,
    'creation must not expose test-only settlement state');
assert.match(creationSource, /await webAwesome\.loadComponents\(\)[\s\S]*?REQUIRED_WEB_AWESOME_COMPONENTS\.filter\(tag => !webAwesome\.isDefined\(tag\)\)/,
    'creation must await its own Web Awesome dependency before choosing a Surface kernel');
assert.doesNotMatch(creationSource, /SurfaceController \?|buildControls\(\(name, options\) => ui\.create/,
    'creation must not retain a direct no-Surface construction path');
assert.doesNotMatch(creationSource, /is-native-fallback|using native fallback/,
    'canonical creation must not mount a second native UI when Web Awesome fails');
assert.match(creationSource, /surface\.kernel !== 'web-awesome'[\s\S]*?surface\.dispose\('create-kernel-unavailable'\)[\s\S]*?showUnavailable/,
    'canonical creation must reject a non-Web-Awesome Surface explicitly');
assert.match(creationSource, /modal\.update\(\{ dismissible: false, closeOnBackdrop: false \}\)/,
    'durable Agent/group creation must lock user dismissal at its commit boundary');
assert.match(creationSource, /modal\.update\(\{ dismissible: true, closeOnBackdrop: true \}\)/,
    'failed creation must restore user dismissal controls');

const surfaceSource = read('modules/ui-system/surface-controller.js');
assert.match(surfaceSource, /kernel === 'web-awesome'[\s\S]*?mountScope\?\.\(host\)[\s\S]*?this\.own\(releaseKernelScope/,
    'Web Awesome Surfaces must own and release their theme/token scope');

const commandsSource = read('modules/mainChatCommands.js');
assert.doesNotMatch(commandsSource, /\.click\s*\(/,
    'canonical commands must not proxy through presentation DOM clicks');
assert.match(commandsSource, /createAgent[\s\S]*?createGroup/,
    'canonical creation entries must remain shared business commands');

const itemListSource = read('modules/itemListManager.js');
assert.doesNotMatch(itemListSource, /assistant-catalog|getCatalogState|getCatalogSnapshot|whenSettled|catalogChannel/,
    'item list must not publish a test-only catalog store');

const chatRepositorySource = read('modules/chat/chatRepository.js');
assert.match(chatRepositorySource, /createChatRepository/,
    'ChatRepository must define the explicit history capability boundary');
assert.match(read('renderer.js'), /createChatRepository\(chatAPI\)[\s\S]*?chatRepository/,
    'ChatRepository must have a real main renderer consumer');
assert.match(read('renderer.js'), /topicListManager\.init\([\s\S]*?chatRepository,/,
    'TopicListManager must receive the shared ChatRepository at its production entry');
assert.match(read('renderer.js'), /searchManager\.init\([\s\S]*?chatRepository,/,
    'SearchManager must receive the shared ChatRepository at its production entry');
assert.match(read('renderer.js'), /createStreamTransientHistory\([\s\S]*?repository: chatRepository/,
    'the composition root must provide transient stream history from the shared ChatRepository');
assert.match(read('modules/messageRenderer.js'), /transientStreamHistory: mainRendererReferences\.transientStreamHistory/,
    'MessageRenderer must pass through the injected transient-history provider');
assert.doesNotMatch(read('modules/renderer/streamManager.js'), /chatRepository/,
    'StreamProjection must not retain direct repository authority');
const historyPersistenceSource = read('modules/chat/chatHistoryPersistence.js');
assert.match(historyPersistenceSource, /createHistoryPersistence[\s\S]*repository\.getHistory[\s\S]*repository\.saveHistory/,
    'ChatHistoryPersistence must own the durable stream read/merge/write policy');
assert.match(historyPersistenceSource, /createTransientChatHistoryPersistence[\s\S]*durable: false/,
    'auxiliary terminal persistence must explicitly identify its transient session contract');
for (const auxiliaryWindow of ['Voicechatmodules/voicechat.js', 'rust_assistant_engine/ui/assistant.js']) {
    const auxiliarySource = read(auxiliaryWindow);
    assert.match(auxiliarySource, /createTransientChatHistoryPersistence/,
        `${auxiliaryWindow} must not describe its short-lived session repository as durable`);
    assert.match(auxiliarySource, /await streamRuntime\?\.cancel\(activeStreamingMessageId,/,
        `${auxiliaryWindow} must await its real stream operation before durable close save`);
    assert.doesNotMatch(auxiliarySource, /waitForActiveStreamToSettle|Timed out while waiting stream to settle/,
        `${auxiliaryWindow} must not reintroduce polling settlement`);
}
assert.doesNotMatch(historyPersistenceSource, /\b(?:window|document|electronAPI)\b/,
    'ChatHistoryPersistence must remain independent from DOM and Electron');
assert.match(read('modules/chat/chatDomRenderer.js'), /createChatDomRenderer/,
    'ChatDomRenderer must define the explicit root/teardown adapter');
assert.match(read('modules/chat/contentRuntime.js'), /createRenderModel/,
    'ContentRuntime must expose a DOM-free render-model operation');
assert.doesNotMatch(read('modules/chat/contentRuntime.js'), /from ['"]\.\.\/renderer\//,
    'ContentRuntime must not depend on renderer implementation modules');
assert.doesNotMatch(read('modules/chat/chatSurface.js'), /presentationState\?\.subscribe\?\.\(\(\) => \{\}\)/,
    'ChatSurface must not create a test-only no-op state subscription');
assert.match(read('modules/renderer/streamManager.js'), /createRenderModel\([\s\S]*PIPELINE_MODES\.STREAM_FAST/,
    'StreamManager must consume the DOM-free ContentRuntime render model');
assert.match(read('modules/messageRenderer.js'), /cleanupAnimationsInContent\(contentDiv\)[\s\S]*unobserveMessage\(messageItem\)/,
    'message teardown must release animation and visibility resources per root');
assert.match(read('modules/messageRenderer.js'), /vcpAudioCleanup[\s\S]*listenerDisposers[\s\S]*audio\.removeAttribute\('src'\)/,
    'audio controls must remove listeners and release media sources on root teardown');
assert.match(read('modules/messageRenderer.js'), /disposeRootResources[\s\S]*cleanupMessageDomResources/,
    'independent ChatSurface roots must have an explicit resource disposer');
assert.match(read('modules/messageRenderer.js'), /createRenderSessionAuthority[\s\S]*invalidateRenderSession\(root\)/,
    'message rendering must revoke progressive work per owning Surface root');
assert.doesNotMatch(read('modules/messageRenderer.js'), /let activeRenderSessionId\s*=/,
    'message rendering must not retain a module-wide scalar render generation');
assert.match(read('modules/messageRenderer.js'), /export function createMessageRenderer\(options = \{\}\)/,
    'message rendering must be created by an explicit Surface-owned factory');
assert.doesNotMatch(read('modules/messageRenderer.js'), /export const messageRenderer\s*=/,
    'message rendering must not expose a shared mutable singleton instance');
for (const [file, factory] of [
    ['modules/renderer/imageHandler.js', 'createImageHandler'],
    ['modules/renderer/emoticonUrlFixer.js', 'createEmoticonUrlFixer'],
    ['modules/renderer/contentProcessor.js', 'createContentProcessor'],
    ['modules/renderer/messageContextMenu.js', 'createMessageContextMenu'],
    ['modules/renderer/middleClickHandler.js', 'createMiddleClickHandler'],
    ['modules/renderer/visibilityOptimizer.js', 'createVisibilityOptimizer'],
]) {
    assert.match(read(file), new RegExp(`export function ${factory}\\(`),
        `${file} must expose a renderer-owned provider factory`);
}
for (const factory of ['createImageHandler', 'createVisibilityOptimizer', 'createEmoticonUrlFixer', 'createContentProcessor', 'createMessageContextMenu', 'createMiddleClickHandler']) {
    assert.match(read('modules/messageRenderer.js'), new RegExp(`${factory}\\(`),
        `each MessageRenderer must construct its own ${factory} provider`);
}
assert.doesNotMatch(read('modules/renderer/imageHandler.js'), /export (?:const|let|var) (?:imageHandlerRefs|ownedContentListeners)/,
    'image interaction ownership must not be exported as mutable module state');
assert.doesNotMatch(read('modules/renderer/emoticonUrlFixer.js'), /export (?:const|let|var) (?:emoticonLibrary|initializationPromise)/,
    'emoticon catalog ownership must not be exported as mutable module state');
assert.match(read('modules/renderer/visibilityOptimizer.js'), /visibilityOwnerByMessage\.get\(messageItem\)\?\.captureWebAnimation/,
    'the realm animation interceptor may route only through the exact message owner');
assert.match(read('modules/renderer/visibilityOptimizer.js'), /scanTimers[\s\S]*unobserveMessage[\s\S]*scanTimer\.window\.clearTimeout\(scanTimer\.id\)/,
    'visibility teardown must cancel delayed per-message scans');
assert.match(read('modules/renderer/animation.js'), /cleanupAnimationsInContent[\s\S]*renderer\.dispose\(\)/,
    'animation cleanup must dispose Three.js renderers');
assert.match(read('modules/renderer/animation.js'), /_vcpMutationObserver[\s\S]*disconnect/,
    'Three.js DOM observers must disconnect with their owning renderer');
assert.match(read('modules/renderer/contentProcessor.js'), /scheduleOwnedTimeout[\s\S]*clearOwnedTimeouts[\s\S]*cleanupPreviewsInContent/,
    'content processor delayed work must be owned by the message root and cleared on teardown');
assert.match(read('modules/chat/chatOperation.js'), /cancelRequested[\s\S]*if \(cancelRequested\) return true/,
    'interactive surface cancellation must be idempotent for repeated user actions');
assert.doesNotMatch(read('modules/renderer/streamManager.js'), /historySaveQueue|historySaveChains|saveHistoryForContext|debouncedSaveHistory/,
    'StreamManager must not retain a second durable queue or repository write policy');
assert.match(read('modules/renderer/desktopPushConsumer.js'), /export function createDesktopPushConsumer[\s\S]*unsubscribe[\s\S]*cleanupMessage[\s\S]*dispose/,
    'Desktop push must have an explicit subscription, per-message cleanup and lifecycle owner');
assert.doesNotMatch(read('modules/renderer/streamManager.js'), /const desktopPushStates = new Map|onDesktopStatus\(/,
    'StreamManager must not retain Desktop push state or a hidden Desktop status subscription');
assert.match(read('modules/renderer/streamManager.js'), /createDesktopPushConsumer[\s\S]*desktopPushConsumer\?\.processToken[\s\S]*desktopPushConsumer\?\.dispose/,
    'StreamManager may only consume Desktop push through its explicit owned capability');
assert.doesNotMatch(read('modules/renderer/streamManager.js'), /persistProjectedStreamTerminal|finalizeStreamedMessage/,
    'StreamManager must not expose a second durable terminal facade');
assert.match(read('modules/renderer/mainChatSurfaceAdapter.js'), /persistTerminal: projected => services\.historyPersistence\.commit/,
    'MainChatSurfaceAdapter must own the production durable commit capability');
assert.match(read('renderer.js'), /createChatHistoryPersistence\(chatRepository\)[\s\S]*historyPersistence,/,
    'the main renderer must compose the durable provider with its real repository');
assert.match(read('modules/chat/vcpStreamBridge.js'), /disposeOperation[\s\S]*handle\.dispose[\s\S]*operation\.chain/,
    'message-scoped Surface retraction must reach bridge quiescence without a producer terminal');
assert.match(read('modules/chat/surfaceConversation.js'), /createSurfaceConversation[\s\S]*selectedItemRef[\s\S]*topicIdRef[\s\S]*historyRef[\s\S]*dispose/,
    'internal chat Surfaces must own fixed conversation identity, local history and disposal authority');
assert.doesNotMatch(read('modules/renderer/streamManager.js'), /(?<![A-Za-z_$])(document|window)\s*[.\[]/,
    'StreamProjection must consume its owning DOM realm through injected capabilities');
assert.doesNotMatch(read('modules/renderer/streamManager.js'), /(?<![A-Za-z_$.])requestAnimationFrame\s*\(/,
    'StreamProjection animation frames must be owned by its scheduler capability');
assert.match(read('renderer.js'), /createSurfaceConversation[\s\S]*conversationCapability/,
    'internal Surface renderers must receive an explicit conversation capability');
assert.match(read('modules/ui-system/interactive-chat-app.js'), /conversation: rendererOwner\.conversation[\s\S]*awaitTerminal: true/,
    'interactive chat must send through its own conversation authority and real terminal operation');
assert.match(read('modules/chat/vcpStreamBridge.js'), /MAX_RETIRED_SESSIONS[\s\S]*retireSession[\s\S]*retiredSessions\.size/,
    'late-event tombstones must be bounded for a long-lived main window');
assert.match(read('modules/chat/streamConsumerRegistry.js'), /dispose\(\)[\s\S]*lease\.active = false[\s\S]*routes\.clear/,
    'registry disposal must revoke routes already captured by stream consumers');
assert.match(read('modules/renderer/mainChatStreamConsumer.js'), /persistTerminal\(projected\)[\s\S]*catch \(sideEffectError\)[\s\S]*post-commit side effect failed/,
    'post-commit side effects must not rewrite a successful durable outcome');
assert.doesNotMatch(read('modules/renderer/messageContextMenu.js'), /contextMenuDependencies\.(?:startStreamingMessage|finalizeStreamedMessage)/,
    'regeneration and context-menu cancellation must use the coordinator-owned bridge');
assert.match(read('renderer.js'), /mainChatAdapter\?\.cancelStream/,
    'main send-button cancellation fallback must use the coordinator-owned operation');
const rendererStreamHandler = read('renderer.js');
assert.match(rendererStreamHandler, /createNonStreamingEventConsumer/,
    'non-streaming VCP events must have an explicit consumer');
assert.match(rendererStreamHandler, /createMainChatEventBridge/,
    'main VCP event subscription must be owned by an explicit event bridge');
assert.match(rendererStreamHandler, /mainChatEventBridge\?\.dispose/,
    'main VCP event subscription must be disposed with the main Surface');
assert.doesNotMatch(rendererStreamHandler, /messageRenderer\.renderFullMessage\(/,
    'renderer must not retain a non-streaming terminal fallback');
assert.doesNotMatch(rendererStreamHandler, /messageRenderer\.removeMessageById\(/,
    'renderer must not retain a non-streaming removal fallback');
const compositionSource = read('modules/renderer/mainChatComposition.js');
assert.match(compositionSource, /createMainChatSurfaceAdapter\(/,
    'main chat must be owned by a real MainChatSurfaceAdapter');
assert.match(compositionSource, /createChatOperations/,
    'main chat composition must provide a real operation consumer');
assert.match(read('modules/renderer/mainChatSurfaceAdapter.js'), /createChatSurface\([\s\S]*?mode: 'interactive'/,
    'MainChatSurfaceAdapter must compose a real interactive ChatSurface');
assert.match(read('modules/ui-system/standalone-chat-app.js'), /id: 'standalone-chat-history'/,
    'standalone read-only chat must have a registered internal-app consumer');
assert.match(read('modules/ui-system/standalone-chat-app.js'), /createChatSurfaceSlots/,
    'named surface slots must have a real production consumer');
assert.match(read('modules/renderer/mainChatComposition.js'), /createChatOperations/,
    'main chat must have a real operation consumer');
assert.match(read('modules/chat/chatPresentationState.js'), /createChatPresentationState/,
    'presentation state must define a narrow read-only state provider');
assert.match(read('modules/ui-system/standalone-chat-app.js'), /createChatPresentationState/,
    'standalone presentation must consume the formal state provider');
assert.match(read('modules/ui-system/standalone-chat-app.js'), /createPresentationSkin/,
    'standalone presentation must consume the controlled skin provider');
assert.match(read('modules/ui-system/standalone-chat-app.js'), /createChatThemePlugin/,
    'standalone presentation must consume the token-only theme provider');
assert.match(read('modules/ui-system/standalone-chat-app.js'), /createChatPluginLoader[\s\S]*pluginLoader\.install/,
    'standalone presentation must consume the controlled chat plugin loader');
assert.match(read('modules/chat/chatPluginManifest.js'), /subscribeState[\s\S]*presentation-state capability/,
    'chat plugin state subscriptions must be capability-gated');
assert.match(read('main.html'), /modules\/ui-system\/standalone-chat-app\.js/,
    'standalone chat app must be loaded by the real renderer entry');
assert.match(read('modules/ui-system/interactive-chat-app.js'), /id: 'standalone-chat-compose'/,
    'interactive chat must have a registered internal-app consumer');
for (const sourceFile of [
    'modules/chatManager.js', 'modules/messageRenderer.js',
    'modules/renderer/messageContextMenu.js',
    'modules/topicListManager.js', 'modules/searchManager.js'
]) {
    assert.match(read(sourceFile), /chatRepository|historyMutationAuthority/,
        `${sourceFile} must consume the shared ChatRepository or history mutation authority boundary`);
}
const interactiveChatSource = read('modules/ui-system/interactive-chat-app.js');
assert.doesNotMatch(interactiveChatSource, /__vcpCancelActiveResponse|vcp-chat-stream-terminal/,
    'independent chat must not cancel or settle through main-window global stream state');
assert.doesNotMatch(interactiveChatSource, /from ['"]\.\.\/messageRenderer\.js|from ['"]\.\.\/chatManager\.js|window\.__vcpChat/,
    'independent chat must consume injected mount capabilities rather than renderer singletons or window providers');
assert.match(interactiveChatSource, /createRenderer\([\s\S]*rendererOwner\.renderer[\s\S]*rendererOwner\.dispose\(\)/,
    'independent chat must create and dispose its own MessageRenderer owner');
assert.doesNotMatch(interactiveChatSource, /context\.chat\?\.renderer/,
    'independent chat must not borrow the main-window renderer instance');
assert.match(interactiveChatSource, /onOperation[\s\S]*operation\?\.cancel/,
    'independent chat must cancel the exact operation returned by its production send path');
assert.doesNotMatch(read('modules/renderer/windowStreamRuntime.js'), /messageRenderer/,
    'auxiliary stream runtime must not request an unused renderer capability');
const standaloneChatSource = read('modules/ui-system/standalone-chat-app.js');
assert.doesNotMatch(standaloneChatSource, /from ['"]\.\.\/messageRenderer\.js|window\.__vcp(?:Chat|Presentation)/,
    'read-only chat must consume injected mount capabilities rather than renderer singletons or window providers');
assert.match(standaloneChatSource, /createRenderer\([\s\S]*rendererOwner\.renderer[\s\S]*rendererOwner\.dispose\(\)/,
    'read-only chat must create and dispose its own MessageRenderer owner');
assert.doesNotMatch(standaloneChatSource, /context\.chat\?\.renderer/,
    'read-only chat must not borrow the main-window renderer instance');
const nextShellSource = read('modules/ui-system/next-shell/next-shell-controller.js');
assert.match(nextShellSource, /chat: chatCapabilities/,
    'Next Shell must pass the chat capability closure to internal application consumers');
assert.match(nextShellSource, /function provideChatCapabilities[\s\S]*repository: capabilities\.repository/,
    'Next Shell must accept the real chat capability provider from the composition root');
assert.match(nextShellSource, /getSnapshot: capabilities\.getSnapshot[\s\S]*createRenderer: capabilities\.createRenderer/,
    'Next Shell must expose state reads and renderer creation as narrow capabilities');
assert.doesNotMatch(nextShellSource, /renderer: capabilities\.renderer/,
    'Next Shell must not propagate the main-window renderer instance to child Surfaces');
assert.match(read('renderer.js'), /function createOwnedInternalChatRenderer[\s\S]*const streamProjection = createStreamProjection\(\)[\s\S]*streamManager: streamProjection[\s\S]*initializeStreamProjection: mode === 'interactive'[\s\S]*exposeGlobalCommands: false[\s\S]*await streamProjection\.dispose\(\)/,
    'internal applications must own and dispose their projection; readonly Surfaces must not initialize it while interactive Surfaces may consume it');
assert.doesNotMatch(read('renderer.js'), /window\.__vcp(?:ChatContext|ChatRepository|PresentationState)\s*=/,
    'the renderer composition root must not publish chat services as ambient window providers');
assert.doesNotMatch(read('modules/renderer/messageContextMenu.js'), /electronAPI\.save(?:Group)?ChatHistory/,
    'message edit persistence must use ChatRepository rather than renderer IPC fallbacks');
assert.match(read('Flowlockmodules/flowlock-integration.js'), /requires a ready ChatManager provider/,
    'Flowlock must fail fast when its production history consumer is absent or not ready');
assert.match(read('Flowlockmodules/flowlock-integration.js'), /requires a history mutation authority/,
    'Flowlock must fail fast when its durable mutation authority is absent');
assert.doesNotMatch(read('Flowlockmodules/flowlock-integration.js'), /saveChatHistory|saveGroupChatHistory/,
    'Flowlock must not bypass the shared durable history mutation authority');
for (const sourceFile of [
    'modules/chatManager.js',
    'modules/topicListManager.js',
    'modules/searchManager.js',
    'modules/renderer/streamManager.js',
]) {
    assert.doesNotMatch(read(sourceFile), /allowLegacyHistoryFallback/,
        `${sourceFile} must not retain a production-unused direct IPC history fallback`);
}

const contributionSource = read('modules/ui-system/contribution-registry.js');
assert.doesNotMatch(contributionSource, /new ContributionRegistry\(['"](?:menu|setting)['"]\)|\bmenus\b|\bsettings\b/,
    'contribution registry must not expose kinds without production producers and consumers');
assert.match(contributionSource, /Object\.freeze\(\{ ContributionRegistry, CommandRegistry, commands, apps, diagnostics \}\)/,
    'contribution registry must retain only the production command/app contract');
const accountMenuSource = read('modules/ui-system/next-shell/account-menu-controller.js');
assert.doesNotMatch(accountMenuSource, /getMenuRegistry|renderContributions|data-contribution|account-menu-contributions/,
    'account menu must not retain an empty dynamic contribution surface');
assert.match(read('modules/ui-system/component-showcase.js'), /id: 'ui-component-library'/,
    'the user-visible component library must remain a registered internal application');
assert.match(read('modules/ui-system/next-shell/launchpad-controller.js'), /getInternalApps\(\)\.forEach/,
    'Launchpad must continue exposing registered internal applications to users');

const eventSource = read('modules/event-listeners.js');
for (const id of [
    'enableMiddleClickQuickAction', 'middleClickQuickAction',
    'enableMiddleClickAdvanced', 'middleClickAdvancedDelay',
]) {
    assert.match(eventSource, new RegExp(`getElementById\\('${id}'\\)`),
        `upstream settings behavior for #${id} must remain wired without a retired toolbar button`);
}

const sharedBaseline = JSON.parse(read('scripts/next-delta-shared-baseline.json'));
for (const [file, entry] of Object.entries(sharedBaseline)) {
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length >= 12, `${file} requires a review rationale`);
    const digest = canonicalTextDigest(read(file));
    assert.equal(digest, entry.sha256,
        `${file} changed across the Next/upstream business boundary; review it explicitly and update its rationale/hash`);
}

console.log('Next delta contract passed (canonical ownership, upstream reachability, modal and child policy).');
