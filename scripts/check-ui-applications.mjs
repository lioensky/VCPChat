// check:ui-applications — migration gate for the application surfaces.
//
// The Web Awesome runtime is owned by the ui-system adapter (and the showcase
// experiment page). Business modules must never reach for it directly:
//
//   - no `<wa-*>` custom element tags,
//   - no bare `--wa-*` design tokens,
//   - no reference to the third-party package or any public CDN,
//   - no `::part()` styling outside the single registered adapter stylesheet.
//
// The gate scans the targeted business surface directories plus the main
// renderer document, so a migration cannot silently leak the runtime into
// product code.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const surfaceDirs = [
    'Translatormodules',
    'Logmodules',
    'PluginManagerModules',
    'Agenttaskmodules',
    'Notemodules',
    'Memomodules',
    'Forummodules',
    'Canvasmodules',
    'Dicemodules',
    'RAGmodules',
    'VCPHumanToolBox',
    'VchatManager',
];
const singleFiles = ['main.html'];
const SELECT_RUNTIME_ENTRYPOINTS = [];

const CDN_HOSTS = [
    /unpkg\.com/i,
    /cdn\.jsdelivr\.net/i,
    /cdnjs\.cloudflare\.com/i,
    /esm\.sh/i,
];
const CDN_SCHEMES = [/^https?:[/\\]{2}/i];

// Lucide is part of the design-system icon layer. It enters only through the
// sanctioned main renderer/runtime entry points; a
// business page must reach icons through VCPUI (material-symbols fallback or
// the adapter), never by loading the lucide runtime itself.
const LUCIDE_SANCTIONED_ENTRIES = new Set([
    path.normalize('main.html'),
    path.normalize('modules/ui-system/vcp-ui-runtime-bootstrap.js'),
]);

const failures = [];

function filesIn(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return filesIn(target);
        return /\.(html|js|mjs|cjs|css)$/i.test(entry.name) ? [target] : [];
    });
}

function scanFile(file, source) {
    const relative = path.relative(root, file);
    // <wa-*/> custom elements (also catches self-closing and multi-line tags).
    for (const match of source.matchAll(/<(\/)?\s*wa-[\w-]+/g)) {
        failures.push(`${relative}: direct <${match[0].slice(1)}> usage is only allowed inside the WebAwesomeAdapter or showcase`);
        if (failures.length > 60) return;
    }
    // Bare --wa-* design tokens.
    for (const match of source.matchAll(/--wa-[\w-]+/g)) {
        failures.push(`${relative}: bare --wa-* token (${match[0]}) must be mapped in styles/ui-system/webawesome-adapter.css`);
        if (failures.length > 60) return;
    }
    // Third-party package references.
    if (/@awesome\.me\/webawesome/.test(source)) {
        failures.push(`${relative}: must not reference the Web Awesome package; use VCPUI/WebAwesomeAdapter instead`);
    }
    // The adapter global is an internal implementation detail. Business pages
    // must reach Web Awesome only through VCPUI.
    if (/VCPWebAwesome/.test(source)) {
        failures.push(`${relative}: must not reference VCPWebAwesome directly; use VCPUI (业务 → VCPUI → WebAwesomeAdapter)`);
    }
    // Lucide runtime references are only allowed in the sanctioned entries.
    if (!LUCIDE_SANCTIONED_ENTRIES.has(path.normalize(relative))
        && (/(?:lucide\/dist|window\.lucide|import\([^)]*lucide|lucide\.createElement)/.test(source))) {
        failures.push(`${relative}: must not load or reference the lucide runtime directly; icons flow through VCPUI (main.html / VCPHumanToolBox are the only sanctioned entries)`);
    }
    // Public CDN URLs (https/http hosts that are not the app itself).
    for (const match of source.matchAll(/(https?:)?[/\\]{2}[\w.-]*(unpkg|jsdelivr|cdnjs|esm\.sh)[^\s"'`)]*/gi)) {
        failures.push(`${relative}: public CDN URL "${match[0]}" is forbidden`);
    }
    for (const line of source.split(/\r?\n/)) {
        const urlMatch = line.match(/(https?:[/\\]{2}[^\s"'`)]+)/);
        if (!urlMatch) continue;
        if (CDN_HOSTS.some(re => re.test(urlMatch[1]))) {
            failures.push(`${relative}: public CDN URL "${urlMatch[1]}" is forbidden`);
        }
        if (/^https?:/i.test(line.trim()) && /@awesome\.me/i.test(line)) {
            failures.push(`${relative}: Web Awesome must load from the generated vendor/webawesome-runtime closure, not a CDN`);
        }
    }
    // Unregistered ::part() usage (parts are only registered in the adapter stylesheet).
    if (source.includes('::part(')) {
        failures.push(`${relative}: ::part() styling must live only in styles/ui-system/webawesome-adapter.css`);
    }
}

const targets = surfaceDirs.flatMap(dir => filesIn(path.join(root, dir))).concat(
    singleFiles.map(file => path.join(root, file)).filter(file => fs.existsSync(file))
);

for (const file of targets) {
    let source;
    try {
        source = fs.readFileSync(file, 'utf8');
    } catch (error) {
        failures.push(`${path.relative(root, file)}: unreadable (${error.message})`);
        continue;
    }
    scanFile(file, source);
    if (failures.length > 100) break;
}

// Confirm the single registered place for WA shadow parts still exists.
const adapterCssPath = path.join(root, 'styles', 'ui-system', 'webawesome-adapter.css');
if (!fs.existsSync(adapterCssPath)) {
    failures.push('styles/ui-system/webawesome-adapter.css: adapter stylesheet is missing');
}
const adapterCss = fs.readFileSync(adapterCssPath, 'utf8');
const registeredParts = [...adapterCss.matchAll(/::part\(([\w-]+)\)/g)].map(match => match[1]);

for (const entrypoint of SELECT_RUNTIME_ENTRYPOINTS) {
    const entryPath = path.join(root, entrypoint);
    const source = fs.existsSync(entryPath) ? fs.readFileSync(entryPath, 'utf8') : '';
    if (!source.includes('vcp-ui-runtime-bootstrap.js')) {
        failures.push(`${entrypoint}: Select-bearing next-mode page must load vcp-ui-runtime-bootstrap.js`);
    }
}
const mainSource = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
if (!mainSource.includes('modules/ui-system/vcp-main-ui-runtime.js')) {
    failures.push('main.html: global settings Select migration requires vcp-main-ui-runtime.js');
}
const runtimeSource = fs.readFileSync(path.join(root, 'modules/ui-system/vcp-ui-runtime-bootstrap.js'), 'utf8');
if (runtimeSource.includes('VCPUI.observeControls')) {
    failures.push('vcp-ui-runtime-bootstrap.js: document-wide dynamic control observers are forbidden');
}
if (!runtimeSource.includes('UiModeController.createSurfaceController') || !runtimeSource.includes('mountScope')) {
    failures.push('vcp-ui-runtime-bootstrap.js: explicit mode surface lifecycle is missing');
}
const vcpUiSource = fs.readFileSync(path.join(root, 'modules/ui-system/vcp-ui.js'), 'utf8');
if (!vcpUiSource.includes("ENHANCERS.set('select', selectEnhancer)")) {
    failures.push('vcp-ui.js: Select enhancer must use the Web Awesome proxy adapter');
}

if (failures.length) {
    console.error('UI applications gate failed:\n');
    [...new Set(failures)].slice(0, 60).forEach(failure => console.error(`- ${failure}`));
    process.exit(1);
}

console.log(`UI applications gate passed (${targets.length} business files scanned, ${registeredParts.length} shadow parts registered in the adapter).`);
