import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = relative => fs.existsSync(path.join(root, relative));

const productionFiles = [
    'renderer.js',
    'modules/event-listeners.js',
    'modules/chatManager.js',
    'modules/messageRenderer.js',
    'modules/renderer/streamManager.js',
    'modules/renderer/messageContextMenu.js',
    'modules/renderer/middleClickHandler.js',
    'Flowlockmodules/flowlock-integration.js',
    'Voicechatmodules/voicechat.js',
    'rust_assistant_engine/ui/assistant.js',
    'modules/mainChatCommands.js',
    'modules/settingsManager.js',
    'modules/global-settings-manager.js',
    'modules/renderer/contentProcessor.js',
    'modules/ui-system/interactive-chat-app.js',
    'modules/ui-system/standalone-chat-app.js',
];
const testFiles = fs.readdirSync(path.join(root, 'tests'))
    .filter(file => /chat|stream|main-chat|lifecycle/i.test(file))
    .map(file => `tests/${file}`);

const source = file => read(file);
const count = (text, pattern) => [...text.matchAll(pattern)].length;
const references = new Map(['chatManager', 'messageRenderer', 'streamManager'].map(name => [name, { production: [], tests: [] }]));

for (const file of productionFiles) {
    if (!exists(file)) continue;
    const text = source(file);
    for (const name of references.keys()) {
        if (new RegExp(`\\b${name}\\b`).test(text)) references.get(name).production.push({ file, occurrences: count(text, new RegExp(`\\b${name}\\b`, 'g')) });
    }
}
for (const file of testFiles) {
    const text = source(file);
    for (const name of references.keys()) {
        if (new RegExp(`\\b${name}\\b`).test(text)) references.get(name).tests.push({ file, occurrences: count(text, new RegExp(`\\b${name}\\b`, 'g')) });
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
    productionFiles,
    testFiles,
    references: Object.fromEntries(references),
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
        'legacy facade removal requires a later zero-production-consumer proof',
        'main-window start/data/end/error events have one coordinator authority',
    ],
};
const rendererSource = source('renderer.js');
assert.doesNotMatch(rendererSource, /case ['"](?:agent_thinking|start|data|end|error)['"]:/, 'renderer must not retain the pre-coordinator stream terminal switch');
assert.match(rendererSource, /mainChatAdapter\?\.acceptStreamEvent\(eventData\)/, 'main window must route VCP events through MainChatSurfaceAdapter');
const reportPath = path.join(root, 'docs/chat-kernel-consumer-report.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Chat Kernel consumer baseline passed (${productionFiles.length} production files, ${testFiles.length} test files, ${kernelFiles.length} kernel files).`);
for (const [name, value] of references) {
    console.log(`  ${name}: production=${value.production.length}, tests=${value.tests.length}`);
}
