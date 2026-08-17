import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import postcss from 'postcss';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const styleDir = path.join(root, 'styles', 'ui-system');
const moduleDir = path.join(root, 'modules', 'ui-system');
const failures = [];
const crossModeAppearanceFiles = new Set([
    path.join(styleDir, 'appearance-studio.css'),
    path.join(styleDir, 'fonts.css'),
    path.join(styleDir, 'tokens.css'),
]);
const crossModeGlobalSettingsFiles = new Set([
    path.join(styleDir, 'appearance-studio.css'),
    path.join(styleDir, 'business-modals.css'),
    path.join(styleDir, 'components.css'),
    path.join(styleDir, 'fonts.css'),
    path.join(styleDir, 'settings.css'),
    path.join(styleDir, 'tokens.css'),
]);

function filesIn(directory, extension) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? filesIn(target, extension) : entry.name.endsWith(extension) ? [target] : [];
    });
}

function report(file, message) {
    failures.push(`${path.relative(root, file)}: ${message}`);
}

function inspectSelectors(file, css) {
    const root = postcss.parse(css, { from: file });
    root.walkRules(rule => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        rule.selectors.forEach(selector => {
            const isNextScoped = selector.startsWith('html') || selector.startsWith(':is(html');
            const isAppearanceStudioHost = crossModeAppearanceFiles.has(file)
                && selector.includes('html.vcp-appearance-studio-host');
            const isGlobalSettingsHost = crossModeGlobalSettingsFiles.has(file)
                && selector.includes('html.vcp-global-settings-host');
            if (!isNextScoped && !isAppearanceStudioHost && !isGlobalSettingsHost) {
                report(file, `selector escapes next UI scope: ${selector}`);
            }
            if (!selector.includes('.vcp-ui-scope')) {
                report(file, `selector is missing .vcp-ui-scope: ${selector}`);
            }
        });
    });
}

for (const file of filesIn(styleDir, '.css')) {
    const css = fs.readFileSync(file, 'utf8');
    if (/!important\b/.test(css)) report(file, 'contains !important');
    const basename = path.basename(file);
    if (!['tokens.css', 'fonts.css', 'index.css'].includes(basename)) {
        if (/(#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\()/i.test(css)) report(file, 'contains an unregistered literal color');
        if (/font-size\s*:\s*(?:\d|\.)/i.test(css)) report(file, 'contains a fixed font size outside tokens');
    }
    if (!['index.css'].includes(basename)) inspectSelectors(file, css);
}

const messageStylesFile = path.join(styleDir, 'messages.css');
const messageStyles = postcss.parse(fs.readFileSync(messageStylesFile, 'utf8'), { from: messageStylesFile });
const upstreamMessageComponentMarkers = [
    '.vcp-tool-',
    '.vcp-thought-chain',
    '.vcp-desktop-push',
    '.vcp-chat-canvas',
    '.mermaid',
    '.maid-diary',
    '.valet-diary',
    '.diary-',
    '.message-attachment',
    '.vcp-html-preview',
    '.vcp-code-copy',
    '.thinking-indicator',
];
messageStyles.walkRules(rule => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
    rule.selectors.forEach(selector => {
        if (/\.md-content(?:\s|>|\+|~)/.test(selector)) {
            report(messageStylesFile, `must not restyle descendants of the upstream message body: ${selector}`);
        }
        const marker = upstreamMessageComponentMarkers.find(candidate => selector.includes(candidate));
        if (marker) report(messageStylesFile, `must not restyle upstream message component ${marker}: ${selector}`);
    });
});

const componentCss = fs.readFileSync(path.join(styleDir, 'components.css'), 'utf8');
if (!componentCss.includes(':focus-visible')) report(path.join(styleDir, 'components.css'), 'missing focus-visible rules');

const inlineStyleCompatibilityAllowlist = new Set([
    path.join(moduleDir, 'vcp-ui.js'), // Per-instance Range progress cannot be expressed as a static token.
    path.join(moduleDir, 'next-shell', 'next-shell-controller.js'), // Measured native-view bounds require a runtime sidebar width token.
]);

for (const file of filesIn(moduleDir, '.js')) {
    const source = fs.readFileSync(file, 'utf8');
    if (/\bstyle\s*=|\.style\./.test(source) && !inlineStyleCompatibilityAllowlist.has(file)) {
        report(file, 'contains inline style mutation');
    }
}

const runtimeFile = path.join(moduleDir, 'vcp-ui.js');
const runtime = fs.readFileSync(runtimeFile, 'utf8');
const settingsBridgeSource = fs.readFileSync(path.join(moduleDir, 'settings-bridge.js'), 'utf8');
if (/new\s+(?:window\.)?MutationObserver/.test(settingsBridgeSource)) {
    report(path.join(moduleDir, 'settings-bridge.js'), 'must use explicit settings surface lifecycle events');
}
const registrations = [...runtime.matchAll(/\['([A-Za-z]+)',\s*[a-zA-Z]/g)].map(match => match[1]);
const duplicateComponents = registrations.filter((name, index) => registrations.indexOf(name) !== index);
if (duplicateComponents.length) report(runtimeFile, `duplicate component registrations: ${[...new Set(duplicateComponents)].join(', ')}`);
const requiredComponents = ['Button', 'IconButton', 'Input', 'Textarea', 'Select', 'Range', 'Checkbox', 'Switch', 'Field', 'SettingsSection', 'SettingsActionBar', 'Badge', 'Alert', 'Card', 'Tabs', 'Toolbar', 'List', 'TableFrame', 'EmptyState', 'Divider', 'Tooltip', 'Skeleton', 'SegmentedControl', 'Pagination', 'ScrollArea', 'Modal', 'Toast', 'ConfirmDialog', 'InputDialog', 'AppPageShell', 'WindowControls', 'AsyncBoundary'];
requiredComponents.filter(name => !registrations.includes(name)).forEach(name => report(runtimeFile, `missing component registration: ${name}`));

const manifestFile = path.join(moduleDir, 'component-manifest.js');
const { COMPONENT_MANIFEST } = await import(pathToFileURL(manifestFile).href);
const manifestNames = COMPONENT_MANIFEST.flatMap(item => [item.name, ...item.aliases]);
const duplicateManifestNames = manifestNames.filter((name, index) => manifestNames.indexOf(name) !== index);
if (duplicateManifestNames.length) report(manifestFile, `duplicate manifest names: ${[...new Set(duplicateManifestNames)].join(', ')}`);
COMPONENT_MANIFEST.forEach(item => {
    if (!['stable', 'candidate', 'deprecated'].includes(item.status)) report(manifestFile, `invalid status for ${item.name}: ${item.status}`);
});
registrations.filter(name => !manifestNames.includes(name)).forEach(name => report(manifestFile, `registered component is missing from manifest: ${name}`));
manifestNames.filter(name => !registrations.includes(name)).forEach(name => report(manifestFile, `manifest component is not registered: ${name}`));

const webAwesomeComparisonFile = path.join(moduleDir, 'webawesome-comparison.js');
const webAwesomeComparison = fs.readFileSync(webAwesomeComparisonFile, 'utf8');
if (!webAwesomeComparison.includes('vendor/webawesome-runtime/dist-cdn/components/')) {
    report(webAwesomeComparisonFile, 'must load the self-contained vendored dist-cdn build in the no-bundler renderer');
}
if (webAwesomeComparison.includes('@awesome.me/webawesome')) {
    report(webAwesomeComparisonFile, 'must not reference the node_modules copy; use the generated vendor/webawesome-runtime build');
}
if (webAwesomeComparison.includes('@awesome.me/webawesome/dist/components/')) {
    report(webAwesomeComparisonFile, 'standard dist build contains bare Lit imports and breaks app registration');
}
const vendorWebAwesomePackage = path.join(root, 'vendor', 'webawesome-runtime', 'package.json');
const vendoredVersion = JSON.parse(fs.readFileSync(vendorWebAwesomePackage, 'utf8')).version;
if (vendoredVersion !== '3.11.0') {
    report(vendorWebAwesomePackage, 'vendored Web Awesome must remain pinned to 3.11.0');
}

const mainHtmlFile = path.join(root, 'main.html');
const mainDom = new JSDOM(fs.readFileSync(mainHtmlFile, 'utf8'));
const modalTemplates = [...mainDom.window.document.querySelectorAll('template[id$="ModalTemplate"]')];
modalTemplates.forEach(template => {
    const modal = template.content.querySelector('.modal');
    if (modal && !modal.classList.contains('vcp-ui-scope')) {
        report(mainHtmlFile, `modal template ${template.id} is missing vcp-ui-scope`);
    }
});
const globalSearchTemplate = mainDom.window.document.querySelector('template#globalSearchModalTemplate');
const globalSearch = globalSearchTemplate?.content.querySelector('#global-search-modal');
if (!globalSearch?.classList.contains('vcp-ui-scope')) {
    report(mainHtmlFile, 'global search template is missing vcp-ui-scope');
}

const appIds = [];
for (const file of filesIn(moduleDir, '.js')) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/register\(\{[\s\S]*?\bid:\s*'([^']+)'/g)) appIds.push({ id: match[1], file });
}
appIds.forEach((item, index) => {
    if (appIds.findIndex(candidate => candidate.id === item.id) !== index) report(item.file, `duplicate application id: ${item.id}`);
});

// Icon contract: the lucide-adapter semantic alias table must only reference
// icons that exist in the vendored lucide UMD, and every icon name VCPUI
// renders must be resolvable.
const lucideAdapterFile = path.join(moduleDir, 'lucide-adapter.js');
const lucideAdapterSource = fs.readFileSync(lucideAdapterFile, 'utf8');
const aliases = {};
for (const match of lucideAdapterSource.matchAll(/"([a-z0-9_]+)": "([a-z0-9-]+)"/g)) aliases[match[1]] = match[2];
const require = createRequire(import.meta.url);
const lucide = require('../node_modules/lucide/dist/umd/lucide.min.js');
const lucideIcons = new Set(Object.keys(lucide.icons || {}));
const resolveIconName = name => {
    const target = aliases[name] || name.replaceAll('_', '-');
    return target.split('-').filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('');
};
Object.entries(aliases).forEach(([semantic, target]) => {
    if (!lucideIcons.has(resolveIconName(semantic))) {
        report(lucideAdapterFile, `lucide alias ${semantic} -> ${target} does not exist in the vendored lucide build`);
    }
});
for (const match of fs.readFileSync(path.join(moduleDir, 'vcp-ui.js'), 'utf8').matchAll(/icon\('([a-z0-9_]+)'/g)) {
    const name = match[1];
    if (!lucideIcons.has(resolveIconName(name))) {
        report(path.join(moduleDir, 'vcp-ui.js'), `icon name "${name}" is not resolvable through lucide-adapter`);
    }
}

if (failures.length) {
    console.error('UI system guard failed:\n');
    failures.forEach(failure => console.error(`- ${failure}`));
    process.exit(1);
}

console.log(`UI system guard passed (${filesIn(styleDir, '.css').length} CSS files, ${filesIn(moduleDir, '.js').length} modules, ${Object.keys(aliases).length} lucide aliases).`);
