// Structural boundary for standalone/embedded business pages.
// No child page currently has a production Next-UI consumer. Keep the central
// policy and prove that every known child page remains on its upstream UI.

import fs from 'node:fs';
import path from 'node:path';
import { ACTIVE_NEXT_UI_SURFACES } from '../modules/ui-system/ui-surface-policy.js';

const root = process.cwd();

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
const failures = [];

const activePolicyPages = new Set(ACTIVE_NEXT_UI_SURFACES);
if (activePolicyPages.size) failures.push(`child Next-UI allowlist must remain empty (found: ${[...activePolicyPages].join(', ')})`);
for (const page of upstreamClassicPages) {
    const htmlPath = path.join(root, page.html);
    const jsPath = path.join(root, page.js);
    if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) {
        failures.push(`${page.html}: registered Classic page or script is missing`);
        continue;
    }
    const html = fs.readFileSync(htmlPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');
    if (activePolicyPages.has(page.html)) failures.push(`${page.html}: upstream classic page must not be active`);
    if (/vcp-ui-runtime-bootstrap|styles\/ui-system\/runtime\.css|<\s*wa-[\w-]+/i.test(html))
        failures.push(`${page.html}: upstream Classic page must not load a child Next-UI runtime or Web Awesome element`);
    if (/AppPageShell|VCPPageRebuild|VCPWebAwesome|vcp-ui-runtime-ready/.test(js))
        failures.push(`${page.js}: upstream Classic page must not contain a child Next-UI rebuild or adapter dependency`);
}

if (failures.length) {
    console.error('Page runtime gate failed:\n');
    failures.forEach(failure => console.error(`- ${failure}`));
    process.exit(1);
}

console.log(`Page runtime gate passed (0 active rebuilt, ${upstreamClassicPages.length} upstream classic).`);
