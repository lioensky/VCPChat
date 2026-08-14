// test-page-runtime — structural gate for migrated standalone/embedded pages.
//
// Every migrated page must opt into the shared design-system runtime the same
// way: the runtime stylesheet + bootstrap module in the document, and a next-UI
// enhancement hook in its script that runs only when the mode resolves to next.
//
// Pages are added to the `migratedPages` list as they complete R5.x migration.
// A page on the list but missing the wiring fails the gate, so a regression in
// the runtime adoption cannot go unnoticed.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import {
    ACTIVE_NEXT_UI_SURFACES,
    resolveSurfaceUiMode,
} from '../modules/ui-system/ui-surface-policy.js';

const root = process.cwd();

// { html: relative HTML entry, js: relative script to check for the hook }
// Pages that have been genuinely reconstructed: next mode builds their DOM
// from VCPUI components (AppPageShell). Web Awesome remains an implementation
// detail behind VCPUI; strict sample pages are forbidden from reaching through
// to VCPWebAwesome directly.
const wiredPages = [];
const activeRebuiltPages = [];
const upstreamClassicPages = [
    { html: 'Translatormodules/translator.html', js: 'Translatormodules/translator.js' },
    { html: 'Notemodules/notes.html', js: 'Notemodules/notes.js' },
    { html: 'Notemodules/notemini.html', js: 'Notemodules/notemini.js' },
    { html: 'Logmodules/log.html', js: 'Logmodules/log.js' },
    { html: 'PluginManagerModules/plugin-manager.html', js: 'PluginManagerModules/plugin-manager.js' },
    { html: 'Agenttaskmodules/task.html', js: 'Agenttaskmodules/task.js' },
    { html: 'Memomodules/memo.html', js: 'Memomodules/memo.js' },
    { html: 'Forummodules/forum.html', js: 'Forummodules/forum.js' },
    { html: 'RAGmodules/RAG_Observer.html', js: 'RAGmodules/RAG_Observer.html' },
    { html: 'VCPHumanToolBox/index.html', js: 'VCPHumanToolBox/renderer.js', strictAdapter: true },
    { html: 'VchatManager/index.html', js: 'VchatManager/script.js' },
    { html: 'Canvasmodules/canvas.html', js: 'Canvasmodules/canvas.js' },
];
const rebuiltPages = [...activeRebuiltPages];

const failures = [];

for (const page of [...wiredPages, ...rebuiltPages]) {
    const htmlPath = path.join(root, page.html);
    if (!fs.existsSync(htmlPath)) {
        failures.push(`${page.html}: page is registered as migrated but is missing`);
        continue;
    }
    const html = fs.readFileSync(htmlPath, 'utf8');

    if (!html.includes('styles/ui-system/runtime.css')) {
        failures.push(`${page.html}: missing runtime.css link`);
    }
    if (!html.includes('modules/ui-system/vcp-ui-runtime-bootstrap.js')) {
        failures.push(`${page.html}: missing vcp-ui-runtime-bootstrap.js module`);
    }

    if (page.js) {
        const jsPath = path.join(root, page.js);
        if (!fs.existsSync(jsPath)) {
            failures.push(`${page.js}: script missing`);
            continue;
        }
        const js = fs.readFileSync(jsPath, 'utf8');
        if (!js.includes('vcp-ui-runtime-ready')) {
            failures.push(`${page.js}: missing vcp-ui-runtime-ready next-mode hook`);
        }
        // Business pages must consume the design system through VCPUI only.
        if (!/VCPUI|VCPPageRebuild/.test(js)) {
            failures.push(`${page.js}: page must use the VCPUI API (VCPUI/VCPPageRebuild)`);
        }
        // The Web Awesome adapter is an internal implementation detail; business
        // pages must never reference it directly. Boundary: 业务页面 → VCPUI →
        // WebAwesomeAdapter → Web Awesome.
        if (/VCPWebAwesome/.test(js)) {
            failures.push(`${page.js}: business page must not reference VCPWebAwesome directly; use VCPUI`);
        }
        if (rebuiltPages.includes(page) && !/(?:window\.)?VCPUI\.create\(['"]AppPageShell['"]|\bV\.create\(['"]AppPageShell['"]|VCPPageRebuild/.test(js)) {
            failures.push(`${page.js}: rebuilt page must build an AppPageShell through VCPUI`);
        }
    }
}

const activePolicyPages = new Set(ACTIVE_NEXT_UI_SURFACES);
for (const page of activeRebuiltPages) {
    if (!activePolicyPages.has(page.html)) failures.push(`${page.html}: active rebuild is missing from the next-UI surface allowlist`);
    const mode = resolveSurfaceUiMode('next', { pathname: `C:/VCPChat/${page.html}` });
    if (mode !== 'next') failures.push(`${page.html}: active rebuild resolves to ${mode}`);
}
for (const page of upstreamClassicPages) {
    const html = fs.readFileSync(path.join(root, page.html), 'utf8');
    const js = fs.readFileSync(path.join(root, page.js), 'utf8');
    if (activePolicyPages.has(page.html)) failures.push(`${page.html}: upstream classic page must not be active`);
    if (html.includes('vcp-ui-runtime-bootstrap.js') || /AppPageShell|VCPPageRebuild/.test(js)) {
        failures.push(`${page.html}: upstream classic page must not contain the retired next-UI rebuild`);
    }
}

if (failures.length) {
    console.error('Page runtime gate failed:\n');
    failures.forEach(failure => console.error(`- ${failure}`));
    process.exit(1);
}

console.log(`Page runtime gate passed (${wiredPages.length} wired, ${activeRebuiltPages.length} active rebuilt, ${upstreamClassicPages.length} upstream classic).`);
