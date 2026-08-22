import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = relative => fs.existsSync(path.join(root, relative));
const packageScripts = JSON.parse(read('package.json')).scripts || {};

const ignoredProductionDirectoryNames = new Set([
    '.git',
    'docs',
    'node_modules',
    'screenshots',
    'scripts',
    'tests',
    'vendor',
]);
const ignoredProductionDirectoryPaths = new Set(['audio_engine/AppData']);
const productionFiles = [];
const collectProductionFiles = (directory, relative = '') => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const rel = path.join(relative, entry.name).replaceAll(path.sep, '/');
        if (entry.isDirectory()) {
            if (!ignoredProductionDirectoryNames.has(entry.name) && !ignoredProductionDirectoryPaths.has(rel)) {
                collectProductionFiles(path.join(directory, entry.name), rel);
            }
        } else if (/\.(?:js|mjs|html)$/.test(entry.name)) {
            productionFiles.push(rel);
        }
    }
};
collectProductionFiles(root);
productionFiles.sort();
const testFiles = fs.readdirSync(path.join(root, 'tests'))
    .filter(file => /chat|stream|main-chat|lifecycle/i.test(file))
    .map(file => `tests/${file}`);

const source = file => read(file);
const count = (text, pattern) => [...text.matchAll(pattern)].length;
const providerFiles = Object.freeze({
    chatManager: 'modules/chatManager.js',
    messageRenderer: 'modules/messageRenderer.js',
    streamManager: 'modules/renderer/streamManager.js',
});
const surfaceFor = file => {
    if (file === 'renderer.js' || file.startsWith('modules/event-') || file.startsWith('modules/mainChat')) return 'main-window';
    if (file.startsWith('Voicechatmodules/')) return 'voice-chat';
    if (file.startsWith('rust_assistant_engine/')) return 'rust-assistant';
    if (file.startsWith('Flowlockmodules/')) return 'flowlock';
    if (file.startsWith('modules/ui-system/')) return 'internal-app';
    if (file.startsWith('tests/')) return 'test';
    return 'shared-renderer';
};
const withoutComments = text => {
    let block = false;
    return text.split(/\r?\n/).map(line => {
        let output = '';
        for (let index = 0; index < line.length; index += 1) {
            if (block) {
                const end = line.indexOf('*/', index);
                if (end < 0) return output;
                block = false;
                index = end + 1;
                continue;
            }
            if (line.startsWith('//', index)) break;
            if (line.startsWith('/*', index)) {
                block = true;
                index += 1;
                continue;
            }
            output += line[index];
        }
        return output;
    });
};
const memberEvidence = (file, name) => {
    if (file === providerFiles[name]) return [];
    const rawLines = source(file).split(/\r?\n/);
    const codeLines = withoutComments(source(file));
    const pattern = new RegExp(`\\b(window\\.)?${name}(?:\\?\\.)?\\.([A-Za-z_$][\\w$]*)`, 'g');
    const evidence = [];
    codeLines.forEach((line, index) => {
        for (const match of line.matchAll(pattern)) {
            evidence.push({
                file,
                line: index + 1,
                surface: surfaceFor(file),
                access: match[1] ? 'compatibility-global' : 'explicit-provider',
                member: match[2],
                snippet: rawLines[index].trim().slice(0, 240),
            });
        }
    });
    return evidence;
};
const references = new Map(Object.keys(providerFiles).map(name => [name, { production: [], tests: [] }]));
const retiredRendererGlobals = Object.freeze([
    'globalSettings',
    'applyChatPresentationMode',
    'normalizeChatPresentationMode',
    'checkMessageFilter',
    'applyChatBubbleLayoutSettings',
]);
const publicFacades = Object.freeze({
    VCPMainChatState: Object.freeze({
        owner: 'renderer.js',
        dynamicSmoke: 'scripts/test-electron-main-chat-sequences.mjs',
        dynamicScript: 'test:electron-main-chat-sequences',
        smokeAssertions: Object.freeze([
            'selectedConfigFrozen: snapshot.selectedItem?.config == null || Object.isFrozen(snapshot.selectedItem.config)',
            "hasHistoryRef: 'historyRef' in window.VCPMainChatState",
            'VCPMainChatState must remain a frozen, non-replaceable read-only plugin facade',
        ]),
        mutability: 'frozen deep read-only snapshot facade; mutation remains in MainChatStateAuthority',
        retirement: 'retain while Flowlock and AutoTTS plugin consumers use the main-chat state protocol',
        compositionMethodsCheck: false,
    }),
    MainChatCommands: Object.freeze({
        owner: 'modules/mainChatCommands.js',
        dynamicSmoke: 'scripts/test-electron-ui-apps-smoke.mjs',
        dynamicScript: 'test:electron-ui-apps',
        smokeAssertions: Object.freeze([
            'const clearResult = window.MainChatCommands.clearNotifications()',
            'assert.deepEqual(parityControls.clearProtection',
        ]),
        mutability: 'frozen command facade; composition is configured by one-shot event',
        retirement: 'retain while Next shell, Classic menus or plugin commands consume it',
    }),
    VCPAppearanceStudio: Object.freeze({
        owner: 'modules/ui-system/appearance-studio.js',
        dynamicSmoke: 'scripts/test-appearance-studio.mjs',
        dynamicScript: 'test:appearance-studio',
        smokeAssertions: Object.freeze([
            'const studio = window.VCPAppearanceStudio',
            'assert.equal(studio.open(',
            'assert.equal(studio.isOpen(), true)',
        ]),
        mutability: 'frozen appearance command facade; composition and disposal use internal events',
        retirement: 'retain while Next shell and settings entrypoints consume it',
    }),
});

for (const file of productionFiles) {
    if (!exists(file)) continue;
    for (const name of references.keys()) {
        references.get(name).production.push(...memberEvidence(file, name));
    }
}

const facadeLedger = {};
for (const [name, definition] of Object.entries(publicFacades)) {
    const production = [];
    const tests = [];
    const pattern = new RegExp(`\\bwindow\\.${name}(?:\\?\\.|\\.)([A-Za-z_$][\\w$]*)`, 'g');
    for (const file of productionFiles) {
        if (file === definition.owner) continue;
        const rawLines = source(file).split(/\r?\n/);
        withoutComments(source(file)).forEach((line, index) => {
            for (const match of line.matchAll(pattern)) {
                production.push({ file, line: index + 1, surface: surfaceFor(file), member: match[1], snippet: rawLines[index].trim().slice(0, 240) });
            }
        });
    }
    for (const file of testFiles) {
        const rawLines = source(file).split(/\r?\n/);
        withoutComments(source(file)).forEach((line, index) => {
            for (const match of line.matchAll(pattern)) tests.push({ file, line: index + 1, member: match[1], snippet: rawLines[index].trim().slice(0, 240) });
        });
    }
    const ownerSource = source(definition.owner);
    const smokeSource = source(definition.dynamicSmoke);
    assert.ok(production.length > 0, `${name} must have a real production consumer or be retired`);
    assert.equal(exists(definition.dynamicSmoke), true, `${name} must name an existing dynamic smoke`);
    assert.match(packageScripts[definition.dynamicScript] || '', new RegExp(definition.dynamicSmoke.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${name} dynamic smoke must be wired to npm script ${definition.dynamicScript}`);
    for (const assertion of definition.smokeAssertions) {
        assert.ok(smokeSource.includes(assertion), `${name} dynamic smoke must retain protocol assertion: ${assertion}`);
    }
    assert.match(ownerSource, new RegExp(`Object\\.defineProperty\\(window, ['"]${name}['"], \\{\\s*value: Object\\.freeze\\(`),
        `${name} must publish a frozen, non-replaceable facade`);
    assert.match(ownerSource, /writable:\s*false,\s*configurable:\s*false/,
        `${name} window property must be non-writable and non-configurable`);
    if (definition.compositionMethodsCheck !== false) {
        assert.doesNotMatch(ownerSource, /\b(?:configureCapabilities|setChatManagerProvider)\s*\(/, `${name} must not expose composition methods`);
    }
    facadeLedger[name] = { ...definition, production, tests };
}

const ambientFacadeDefinitions = new Map();
const ambientFacadeReferences = { production: new Map(), tests: new Map() };
const recordAmbientDefinition = (name, file, line, syntax, snippet) => {
    const definitions = ambientFacadeDefinitions.get(name) || [];
    definitions.push({ file, line, syntax, snippet });
    ambientFacadeDefinitions.set(name, definitions);
};
const recordAmbientReference = (target, name, file, line, snippet) => {
    const references = target.get(name) || [];
    references.push({ file, line, surface: surfaceFor(file), snippet });
    target.set(name, references);
};
const indexAmbientFacades = (files, target, includeDefinitions) => {
for (const file of files) {
    const rawLines = source(file).split(/\r?\n/);
    const codeLines = withoutComments(source(file));
    codeLines.forEach((line, index) => {
        const snippet = rawLines[index].trim().slice(0, 240);
        for (const match of line.matchAll(/(?<![A-Za-z0-9_$.])window(?:\.([A-Za-z_$][\w$]*)|\[['"]([A-Za-z_$][\w$]*)['"]\])/g)) {
            recordAmbientReference(target, match[1] || match[2], file, index + 1, snippet);
        }
        if (!includeDefinitions) return;
        for (const match of line.matchAll(/(?<![A-Za-z0-9_$.])window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
            recordAmbientDefinition(match[1], file, index + 1, 'dot-assignment', rawLines[index].trim().slice(0, 240));
        }
        for (const match of line.matchAll(/(?<![A-Za-z0-9_$.])window\[['"]([A-Za-z_$][\w$]*)['"]\]\s*=(?!=)/g)) {
            recordAmbientDefinition(match[1], file, index + 1, 'bracket-assignment', rawLines[index].trim().slice(0, 240));
        }
        for (const match of line.matchAll(/Object\.defineProperty\(window,\s*['"]([A-Za-z_$][\w$]*)['"]/g)) {
            recordAmbientDefinition(match[1], file, index + 1, 'define-property', rawLines[index].trim().slice(0, 240));
        }
    });
}
};
indexAmbientFacades(productionFiles, ambientFacadeReferences.production, true);
indexAmbientFacades(testFiles, ambientFacadeReferences.tests, false);
const ambientFacadeLedger = {};
for (const [name, definitions] of [...ambientFacadeDefinitions].sort(([left], [right]) => left.localeCompare(right))) {
    const definitionKeys = new Set(definitions.map(item => `${item.file}:${item.line}`));
    const production = (ambientFacadeReferences.production.get(name) || [])
        .filter(item => !definitionKeys.has(`${item.file}:${item.line}`));
    const tests = ambientFacadeReferences.tests.get(name) || [];
    ambientFacadeLedger[name] = {
        classification: publicFacades[name] ? 'supported-public-facade' : 'legacy-or-feature-local-ambient',
        definitions,
        production,
        tests,
    };
}
for (const name of Object.keys(publicFacades)) {
    assert.ok(ambientFacadeLedger[name], `${name} must appear in the complete ambient facade inventory`);
}

for (const file of productionFiles) {
    const code = withoutComments(source(file)).join('\n');
    for (const name of retiredRendererGlobals) {
        assert.doesNotMatch(code, new RegExp(`\\bwindow\\.${name}\\b`), `${file} must not consume or publish retired window.${name}`);
    }
}
for (const file of testFiles) {
    for (const name of references.keys()) {
        references.get(name).tests.push(...memberEvidence(file, name));
    }
}
for (const [name, evidence] of references) {
    assert.ok(evidence.production.length > 0, `${name} must retain at least one real production member consumer`);
    assert.equal(evidence.production.some(item => item.file === providerFiles[name]), false, `${name} provider definition cannot self-certify as a consumer`);
    assert.equal(
        evidence.production.filter(item => item.access === 'compatibility-global').length,
        0,
        `${name} must have zero production compatibility-global consumers after facade retirement`
    );
}

for (const file of productionFiles) {
    const text = source(file);
    for (const name of Object.keys(providerFiles)) {
        assert.doesNotMatch(
            withoutComments(text).join('\n'),
            new RegExp(`\\bwindow\\.${name}\\s*(?:\\?\\.)?\\s*[A-Za-z_$][\\w$]*`),
            `${file} must not reintroduce window.${name} compatibility access`
        );
    }
}

const kernelFiles = [
    'modules/chat/chatContext.js',
    'modules/chat/chatRepository.js',
    'modules/chat/contentRuntime.js',
    'modules/chat/contentTransforms.js',
    'modules/chat/chatDomRenderer.js',
    'modules/chat/chatSurface.js',
    'modules/chat/chatOperation.js',
    'modules/chat/chatPresentationState.js',
    'modules/chat/chatPresentationSkin.js',
    'modules/chat/chatSurfaceSlots.js',
    'modules/chat/chatThemePlugin.js',
    'modules/chat/chatPluginManifest.js',
    'modules/chat/streamSession.js',
    'modules/chat/streamCoordinator.js',
    'modules/chat/streamTransientHistory.js',
    'modules/chat/streamConsumerRegistry.js',
    'modules/chat/vcpStreamBridge.js',
];
// ChatRepository is the intentional transport adapter; the pure-runtime rule
// applies to the domain, content, renderer and plugin contracts around it.
const pureKernelFiles = kernelFiles.filter(file => file !== 'modules/chat/chatRepository.js');
for (const file of kernelFiles) assert.equal(exists(file), true, `${file} must exist before D1 begins`);

const forbiddenKernelPatterns = [
    [/\bdocument\b/, 'document'],
    [/\bwindow\b/, 'window'],
    [/electronAPI/, 'electronAPI'],
    [/from ['\"]electron(?:[/'\"])/, 'electron import'],
];
for (const file of pureKernelFiles) {
    const text = source(file);
    for (const [pattern, label] of forbiddenKernelPatterns) {
        assert.doesNotMatch(text, pattern, `${file} must not depend on ${label}`);
    }
}

const report = {
    phase: 'D6',
    ignoredProductionDirectoryNames: [...ignoredProductionDirectoryNames],
    ignoredProductionDirectoryPaths: [...ignoredProductionDirectoryPaths],
    productionFiles,
    testFiles,
    references: Object.fromEntries(references),
    retiredRendererGlobals,
    publicFacades: facadeLedger,
    ambientFacades: ambientFacadeLedger,
    providerFiles,
    kernelFiles,
    pureKernelFiles,
    ownershipSignals: Object.fromEntries(productionFiles.map(file => {
        const text = source(file);
        return [file, {
            windowReferences: count(text, /\bwindow\b/g),
            documentReferences: count(text, /\bdocument\b/g),
            electronReferences: count(text, /electronAPI/g),
            timers: count(text, /\b(?:setTimeout|setInterval|requestAnimationFrame)\b/g),
            listeners: count(text, /\.addEventListener\(/g),
            mutableMaps: count(text, /new Map\(/g),
        }];
    })),
    invariants: [
        'pure kernel files have no document/window/electronAPI dependency',
        'production and test consumers are reported separately',
        'provider definitions, exports and compatibility assignments cannot self-certify as consumers',
        'production consumers and compatibility globals are discovered across all repository production sources',
        'each consumer evidence item records a source line, member access and production surface',
        'legacy facade removal requires a later zero-production-consumer proof',
        'retired renderer globals have zero production definitions and consumers',
        'each retained public facade is frozen, has production consumers, a dynamic smoke and a retirement decision',
        'all direct production window facade publications are inventoried with definitions and consumers',
        'main-window start/data/end/error events have one coordinator authority',
    ],
};
const rendererSource = source('renderer.js');
const settingsPresentationOwnerSource = source('modules/renderer/mainChatSettingsPresentationOwner.js');
const messageRendererSource = source('modules/messageRenderer.js');
const mainChatEventBridgeSource = source('modules/renderer/mainChatEventBridge.js');
const nonStreamingEventConsumerSource = source('modules/renderer/nonStreamingEventConsumer.js');
const contentProcessorSource = source('modules/renderer/contentProcessor.js');
const chatManagerSource = source('modules/chatManager.js');
const settingsOwnerSource = source('modules/renderer/mainChatSettingsOwner.js');
const ownedPreloadSource = source('modules/renderer/ownedPreloadSubscription.js');
const uiManagerSource = source('modules/uiManager.js');
const eventListenersSource = source('modules/event-listeners.js');
const appearanceStudioSource = source('modules/ui-system/appearance-studio.js');
assert.match(messageRendererSource, /export function createMessageRenderer\(options = \{\}\) \{[\s\S]*const surfaceId = String\(/,
    'MessageRenderer must create a stable per-instance Surface namespace');
assert.match(messageRendererSource, /const ownedStyleElements = new Set\(\)/,
    'MessageRenderer must own injected style nodes per renderer instance');
assert.match(messageRendererSource, /for \(const styleElement of ownedStyleElements\)/,
    'MessageRenderer style cleanup must use instance-owned nodes');
const streamHandlerStart = rendererSource.indexOf('chatAPI.onVCPStreamEvent');
const streamHandlerEnd = rendererSource.indexOf('chatAPI.onVCPGroupTopicUpdated', streamHandlerStart);
const streamHandlerSource = rendererSource.slice(streamHandlerStart, streamHandlerEnd < 0 ? undefined : streamHandlerEnd);
assert.doesNotMatch(streamHandlerSource, /messageRenderer\.appendStreamChunk\(messageId/, 'renderer must not retain direct stream chunk dispatch');
assert.doesNotMatch(streamHandlerSource, /messageRenderer\.finalizeStreamedMessage\(\s*messageId/, 'renderer must not retain direct stream terminal dispatch');
assert.match(rendererSource, /mainChatAdapter\?\.acceptStreamEvent\(eventData\)/, 'main window must route VCP events through MainChatSurfaceAdapter');
assert.match(rendererSource, /createMainChatSettingsPresentationOwner/, 'renderer must construct the settings presentation owner');
assert.match(rendererSource, /createMainChatAttachmentOwner/, 'renderer must construct the attachment state owner');
assert.match(rendererSource, /createMainChatSendOwner/, 'renderer must construct the send and interrupt owner');
assert.match(rendererSource, /attachedFilesRef: mainChatAttachmentOwner\.ref/, 'ChatManager must receive the owned attachment ref');
assert.match(rendererSource, /sendButtonAction: mainChatSendOwner\.handleAction/, 'event listeners must receive the owned send action');
assert.match(rendererSource, /notifySendStateChanged: mainChatSendOwner\.update/, 'stream composition must receive the owned send projection');
assert.match(rendererSource, /currentSelectedItemRef = mainChatStateAuthority\.selectedItemRef/, 'renderer must consume the selection authority ref');
assert.match(rendererSource, /currentTopicIdRef = mainChatStateAuthority\.topicIdRef/, 'renderer must consume the topic authority ref');
assert.doesNotMatch(rendererSource, /\blet\s+(?:attachedFiles|currentSelectedItem|currentTopicId)\b/,
    'renderer must not regain mutable attachment or conversation mirrors');
assert.doesNotMatch(rendererSource, /function\s+(?:getInterruptibleMessageForCurrentChat|updateSendButtonState|interruptActiveResponseFromSendButton|handleSendButtonAction)\b/,
    'renderer must not regain send or interrupt business policy');
for (const [file, text] of [
    ['modules/chatManager.js', chatManagerSource],
    ['modules/settingsManager.js', source('modules/settingsManager.js')],
    ['modules/messageRenderer.js', messageRendererSource],
]) {
    assert.doesNotMatch(
        withoutComments(text).join('\n'),
        /\b(?:currentSelectedItem|selectedItem|currentSelectedItemVal)\.(?:name|config|topics|uiCollapseStates|avatarUrl|avatarCalculatedColor)\s*=|Object\.assign\((?:currentSelectedItem|selectedItem)\b/,
        `${file} must replace selection state through its authority instead of mutating borrowed values`
    );
}
assert.doesNotMatch(
    withoutComments(messageRendererSource).join('\n'),
    /const\s+currentChatHistoryArray\s*=\s*mainRendererReferences\.currentChatHistoryRef\.get\(\)[\s\S]{0,400}?currentChatHistoryArray\.splice\(/,
    'MessageRenderer must copy history snapshots before mutation'
);
assert.match(rendererSource, /\[\.\.\.ownedRendererSubscriptions\]\.reverse\(\)[\s\S]*for \(const subscription of subscriptions\)[\s\S]*await subscription\.dispose\(\)/,
    'renderer composition must await owned capability disposal in reverse registration order');
assert.match(ownedPreloadSource, /const tasks = new Set\(\)[\s\S]*await Promise\.allSettled\(\[\.\.\.tasks\]\)/,
    'owned preload subscriptions must drain in-flight async consumers during disposal');
assert.match(ownedPreloadSource, /abortController\.abort\(\)/,
    'owned preload subscriptions must signal lifecycle cancellation before draining consumers');
assert.match(chatManagerSource, /async function dispose\(\)[\s\S]*emptyStateObserver\?\.disconnect\(\)[\s\S]*canvasContentDisposer\?\.\(\)[\s\S]*await Promise\.allSettled/,
    'ChatManager must retract DOM/preload resources and drain owned persistence work');
assert.match(rendererSource, /ownedRendererSubscriptions\.add\(chatManager\)/,
    'renderer composition must register ChatManager teardown');
assert.match(uiManagerSource, /themeDisposer = electronAPI\.onThemeUpdated[\s\S]*async \(\) => \{[\s\S]*themeDisposer\?\.\(\)[\s\S]*await Promise\.allSettled/,
    'UIManager must own its theme subscription and drain async projection work');
assert.match(rendererSource, /ownedRendererSubscriptions\.add\(\{ dispose: \(\) => window\.uiManager\.dispose\?\.\(\) \}\)[\s\S]*await window\.uiManager\.init/,
    'renderer must register UIManager disposal before awaiting initialization');
assert.match(settingsOwnerSource, /const get = \(\) => clone\(settings\)/,
    'settings authority reads must return detached values');
assert.match(settingsOwnerSource, /const snapshot = \(\) => freeze\(clone\(settings\)\)/,
    'settings authority snapshots must be recursively frozen');
for (const [file, text] of [
    ['modules/event-listeners.js', eventListenersSource],
    ['modules/uiManager.js', uiManagerSource],
    ['modules/ui-system/appearance-studio.js', appearanceStudioSource],
]) {
    assert.doesNotMatch(
        withoutComments(text).join('\n'),
        /(?:globalSettings|currentSettings|settings)\.(?:sidebarAvatarOnly|sidebarActive|assistantEnabled|currentThemeMode|appearanceProfile|filterEnabled)\s*=|Object\.assign\(getSettings\(\)/,
        `${file} must commit settings changes through the settings authority`
    );
}
assert.match(rendererSource, /mainChatSettingsPresentationOwner\.loadAndApply\(\)/,
    'renderer must delegate settings loading and projection to its owner');
assert.doesNotMatch(rendererSource, /CHAT_FONT_PRESETS|function captureChatPresentationScrollAnchor|function syncChatPresentationModeControls/,
    'renderer must not regain settings or presentation DOM policy');
assert.match(settingsPresentationOwnerSource, /async function loadAndApply\(\)/,
    'settings presentation owner must own startup settings projection');
assert.doesNotMatch(rendererSource, /window\.(?:globalSettings|applyChatPresentationMode|normalizeChatPresentationMode|checkMessageFilter|applyChatBubbleLayoutSettings)/,
    'renderer must not republish retired ambient settings and presentation globals');
// These assertions require production composition evidence; test-only imports cannot satisfy them.
assert.match(rendererSource, /createMainChatEventBridge/, 'renderer must construct the main chat event bridge');
assert.match(mainChatEventBridgeSource, /chatAPI\.onVCPStreamEvent/, 'event bridge must consume the preload producer');
assert.match(mainChatEventBridgeSource, /subscription\?\.dispose|subscription\(\)/, 'event bridge must retain a producer disposer');
assert.match(rendererSource, /createNonStreamingEventConsumer/, 'renderer must construct the non-streaming event consumer');
assert.match(nonStreamingEventConsumerSource, /renderFullMessageProjection/, 'non-streaming consumer must project durable full responses');
assert.match(nonStreamingEventConsumerSource, /renderTarget\.removeMessage/, 'non-streaming consumer must remove through its owning Surface');
assert.match(contentProcessorSource, /mainRefs\.messageCommands\?\.handleSendMessage/, 'content processor must use an injected Surface send capability');
assert.doesNotMatch(contentProcessorSource, /getElementById\(['"]messageInput['"]\)/, 'content processor must not discover the main input by global DOM id');
assert.match(chatManagerSource, /renderTarget\?\.removeMessage(?:ById)?/, 'ChatManager must remove placeholders through the initiating render target');
assert.doesNotMatch(chatManagerSource, /window\.updateSendButtonState/, 'ChatManager must use the injected send-state capability');
assert.doesNotMatch(source('modules/event-listeners.js'), /window\.handleSendButtonAction|window\.__vcpCancelActiveResponse/, 'event listeners must use the injected send-button capability');
assert.match(messageRendererSource, /vcp-\$\{surfaceId\}-chat-\$\{message\.id\}/, 'message styles must be namespaced by Surface and message');
assert.match(messageRendererSource, /audioRoot\?\.querySelectorAll\?\.\(['"]audio\.vcp-audio-native['"]\)/, 'audio playback isolation must be scoped to the owning Surface root');
assert.doesNotMatch(source('modules/renderer/streamManager.js'), /onStreamStateChanged/, 'stream projection must not retain the legacy generic state callback');
assert.doesNotMatch(source('modules/renderer/streamManager.js'), /notifySurfaceOperationStateChanged|updateSendButtonState/,
    'stream projection must not reverse-control main-window send state');
assert.match(chatManagerSource, /notifySendStateChanged/, 'ChatManager operation owner must publish main send-state changes');
assert.match(source('modules/renderer/streamManager.js'), /transientStreamHistory/, 'stream projection history must be delegated to the transient history provider');
assert.match(source('modules/renderer/streamManager.js'), /streamOperationId/, 'stream projection must carry producer operation identity into its Surface runtime');
assert.match(source('modules/renderer/streamManager.js'), /createStreamProjectionRuntime/, 'stream projection runtime state must use the Surface-owned operation-scoped runtime provider');
assert.doesNotMatch(source('modules/renderer/streamManager.js'), /refs\.historyAuthority/, 'stream projection must not use an ambiguous durable-history authority name');
assert.match(rendererSource, /createStreamTransientHistory[\s\S]*transientStreamHistory,/, 'main and internal composition must construct and inject transient history providers');
assert.match(source('Voicechatmodules/voicechat.js'), /createStreamTransientHistory[\s\S]*transientStreamHistory,[\s\S]*viewAuthority/, 'Voice Surface must own its transient history and view authority');
assert.match(source('rust_assistant_engine/ui/assistant.js'), /createStreamTransientHistory[\s\S]*transientStreamHistory,[\s\S]*viewAuthority/, 'Rust assistant Surface must own its transient history and view authority');
assert.doesNotMatch(messageRendererSource, /createStreamTransientHistory/, 'MessageRenderer must consume rather than secretly construct the transient history provider');
assert.match(source('modules/renderer/streamManager.js'), /requires an owning Surface root/, 'stream projection must fail fast without an owning root');
assert.match(source('modules/renderer/streamManager.js'), /requires an explicit view authority/, 'stream projection must fail fast without a view authority');
assert.doesNotMatch(source('modules/renderer/streamManager.js'), /if \(refs\.viewAuthority &&/, 'stream projection must not silently fall back to global selection state');
const reportPath = path.join(root, 'docs/chat-kernel-consumer-report.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Chat Kernel consumer baseline passed (${productionFiles.length} production files, ${testFiles.length} test files, ${kernelFiles.length} kernel files).`);
for (const [name, value] of references) {
    const files = new Set(value.production.map(item => item.file));
    const compatibility = value.production.filter(item => item.access === 'compatibility-global').length;
    console.log(`  ${name}: productionEvidence=${value.production.length}, productionFiles=${files.size}, compatibility=${compatibility}, tests=${value.tests.length}`);
}
