#!/usr/bin/env node
/**
 * App Surface 静态契约门禁
 *
 * 覆盖六个已刷新页面（Notes / Translator / Plugin Manager / Forum / Memo / Log）：
 *   1. 页面 HTML 必须引入 styles/app-surfaces/app-surfaces.css，
 *      且 <body> 必须带 vcp-app-surface（opt-in 开关）。
 *   2. 页面 HTML 不得回引主聊天样式栈 ../style.css。
 *   3. 页面 CSS 不得重定义 --vcp-app-* token（token 只能由共享层声明）。
 *   4. 页面 CSS 不得再写自有 ::-webkit-scrollbar（滚动条统一走共享层）。
 *   5. styles/app-surfaces/ 共享层的页面层文件必须挂在 @layer vcp.page 内。
 *
 * 该门禁是纯静态检查，配合 scripts/test-electron-ui-apps-smoke.mjs 中的
 * 运行时 app-surface 审计一起构成视觉回归覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SURFACED_PAGES = [
    { name: 'Notes', html: 'Notemodules/notes.html', css: ['Notemodules/notes.css'] },
    { name: 'Translator', html: 'Translatormodules/translator.html', css: ['Translatormodules/translator.css'] },
    { name: 'Plugin Manager', html: 'PluginManagerModules/plugin-manager.html', css: ['PluginManagerModules/plugin-manager.css'] },
    { name: 'Forum', html: 'Forummodules/forum.html', css: ['Forummodules/forum.css'] },
    { name: 'Memo', html: 'Memomodules/memo.html', css: ['Memomodules/memo.css'] },
    { name: 'Log', html: 'Logmodules/log.html', css: ['Logmodules/log.css'] },
];

const SHARED_LAYER_FILES = [
    'styles/app-surfaces/app-surface-notes.css',
    'styles/app-surfaces/app-surface-translator.css',
    'styles/app-surfaces/app-surface-plugin-manager.css',
    'styles/app-surfaces/app-surface-content-pages.css',
];

const failures = [];

function read(rel) {
    return fs.readFileSync(path.join(root, rel), 'utf8');
}

for (const page of SURFACED_PAGES) {
    const html = read(page.html);

    if (!html.includes('styles/app-surfaces/app-surfaces.css')) {
        failures.push(`${page.name}: ${page.html} 未引入 styles/app-surfaces/app-surfaces.css`);
    }
    if (!/<body[^>]*class="[^"]*\bvcp-app-surface\b/.test(html)) {
        failures.push(`${page.name}: ${page.html} 的 <body> 缺少 vcp-app-surface opt-in 类`);
    }
    if (/href="\.\.\/style\.css"/.test(html)) {
        failures.push(`${page.name}: ${page.html} 回引了主聊天样式栈 ../style.css`);
    }

    for (const cssRel of page.css) {
        const css = read(cssRel);
        const tokenRedef = css.match(/^\s*--vcp-app-[\w-]+\s*:/m);
        if (tokenRedef) {
            failures.push(`${page.name}: ${cssRel} 重定义了共享 token（${tokenRedef[0].trim()}）`);
        }
        if (/::-webkit-scrollbar/.test(css)) {
            failures.push(`${page.name}: ${cssRel} 自带 ::-webkit-scrollbar，滚动条应统一走共享层`);
        }
    }
}

for (const rel of SHARED_LAYER_FILES) {
    const css = read(rel);
    if (!css.includes('@layer vcp.page')) {
        failures.push(`共享页面层 ${rel} 缺少 @layer vcp.page 包裹`);
    }
}

// Memo 复用 Forum 的顶栏/导航样式，forum.css 必须继续提供 #top-nav-bar。
const forumCss = read('Forummodules/forum.css');
if (!forumCss.includes('#top-nav-bar')) {
    failures.push('Forummodules/forum.css 缺少 #top-nav-bar（Memo 依赖其顶栏样式）');
}

if (failures.length > 0) {
    console.error('App surface gate failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}

console.log(`App surface gate passed (${SURFACED_PAGES.length} surfaced pages, ${SHARED_LAYER_FILES.length} page-layer files checked).`);
