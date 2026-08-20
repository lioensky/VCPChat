import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = relative => fs.existsSync(path.join(root, relative));

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

for (const file of productionFiles) {
    if (!exists(file)) continue;
    for (const name of references.keys()) {
        references.get(name).production.push(...memberEvidence(file, name));
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
        'main-window start/data/end/error events have one coordinator authority',
    ],
};
const rendererSource = source('renderer.js');
const messageRendererSource = source('modules/messageRenderer.js');
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
const reportPath = path.join(root, 'docs/chat-kernel-consumer-report.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Chat Kernel consumer baseline passed (${productionFiles.length} production files, ${testFiles.length} test files, ${kernelFiles.length} kernel files).`);
for (const [name, value] of references) {
    const files = new Set(value.production.map(item => item.file));
    const compatibility = value.production.filter(item => item.access === 'compatibility-global').length;
    console.log(`  ${name}: productionEvidence=${value.production.length}, productionFiles=${files.size}, compatibility=${compatibility}, tests=${value.tests.length}`);
}
