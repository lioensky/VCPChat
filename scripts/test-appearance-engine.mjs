import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const appearanceEngineSource = fs.readFileSync('modules/ui-system/appearance-engine.js', 'utf8');

const bootDom = new JSDOM(`<!doctype html><html data-ui-mode="classic"><head>
    <script>${appearanceEngineSource.replace(/<\/script/gi, '<\\/script')}</script>
    </head><body><main id="classicLayout"></main></body></html>`, {
    url: 'https://vcpchat.local/',
    runScripts: 'dangerously'
});
if (bootDom.window.document.readyState === 'loading') {
    await new Promise(resolve => bootDom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
}
const bootOptics = bootDom.window.document.getElementById('vcpMaterialOptics');
assert.ok(bootOptics, 'material optics mounts after body creation');
assert.equal(bootOptics.parentElement, bootDom.window.document.body, 'material optics never becomes an inline html child');
assert.ok(bootOptics.classList.contains('vcp-material-optics'), 'material optics uses the out-of-flow geometry class');
assert.equal(bootDom.window.document.documentElement.querySelector(':scope > svg'), null, 'classic layout has no pre-body SVG line box');
bootDom.window.close();

const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body><div class="vcp-ui-scope"></div></body></html>', {
    url: 'https://vcpchat.local/',
    runScripts: 'outside-only'
});
Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    CustomEvent: dom.window.CustomEvent,
    localStorage: dom.window.localStorage
});

dom.window.eval(appearanceEngineSource);
const appearance = dom.window.VCPAppearance;
assert.ok(appearance);
assert.equal(appearance.getRevision(), 0);
assert.equal(appearance.normalize({ radius: 'round' }, 'next').radius, 'round');
assert.equal(appearance.normalize({ radius: 'invalid' }, 'next').radius, 'medium');

appearance.commit({ density: 'relaxed' }, { uiMode: 'next', source: 'test-commit' });
assert.equal(appearance.getRevision(), 1, 'persisted commits advance the appearance revision');
assert.equal(appearance.readCache('next').density, 'relaxed');

const resolved = appearance.apply({
    density: 'compact', radius: 'square', typography: 'serif',
    fontScale: 'large', contentWidth: 'centered', surface: 'solid'
}, { uiMode: 'next', cache: true, source: 'test' });
assert.equal(JSON.stringify(resolved), JSON.stringify({
    density: 'compact', radius: 'square', typography: 'serif',
    fontScale: 'large', contentWidth: 'centered', surface: 'solid',
    surfaceEffect: 'vibrancy',
    shellRadius: 'tuned', composerRadius: 'tuned', sidebarRadius: 'tuned', cardRadius: 'tuned',
    surfaceOpacity: 68, surfaceBlur: 24, surfaceSaturation: 145, surfaceBrightness: 103,
    surfaceBorder: 32, surfaceShadow: 18, surfaceSheen: 18
}));
assert.equal(document.documentElement.dataset.vcpRadius, 'square');
assert.equal(document.documentElement.dataset.vcpShellRadius, 'tuned');
assert.equal(document.documentElement.dataset.vcpComposerRadius, 'tuned');
assert.equal(document.querySelector('.vcp-ui-scope').dataset.density, 'compact');
assert.equal(appearance.readCache('next').contentWidth, 'centered');
assert.equal(document.getElementById('vcpAppearanceMaterialVariables').textContent.includes('--vcp-material-blur:24px'), true);

const material = appearance.apply({
    ...resolved,
    surface: 'custom',
    surfaceEffect: 'liquid',
    surfaceOpacity: 12,
    surfaceBlur: 52,
    surfaceSaturation: 146,
    surfaceBrightness: 94,
    surfaceBorder: 68,
    surfaceShadow: 22,
    surfaceSheen: 81
}, { uiMode: 'next', cache: false, source: 'test-material' });
assert.equal(material.surface, 'custom');
assert.equal(material.surfaceOpacity, 20);
assert.equal(material.surfaceBlur, 40);
assert.equal(material.surfaceSaturation, 146);
assert.equal(document.documentElement.dataset.vcpSurface, 'custom');
assert.equal(document.documentElement.dataset.vcpSurfaceEffect, 'liquid');
assert.match(document.getElementById('vcpAppearanceMaterialVariables').textContent, /--vcp-material-sheen:81%/);
assert.equal(appearance.normalize({ surfaceEffect: 'unknown' }, 'next').surfaceEffect, 'vibrancy');

const detailed = appearance.apply({
    ...resolved,
    shellRadius: 'follow',
    composerRadius: 'round',
    sidebarRadius: 'square',
    cardRadius: 'small'
}, { uiMode: 'next', cache: false, source: 'test-details' });
assert.equal(detailed.shellRadius, 'follow');
assert.equal(document.documentElement.dataset.vcpSidebarRadius, 'square');
assert.equal(document.documentElement.dataset.vcpCardRadius, 'small');

const appearanceCss = fs.readFileSync('styles/appearance.css', 'utf8');
const fontsCss = fs.readFileSync('styles/ui-system/fonts.css', 'utf8');
assert.match(appearanceCss, /\.vcp-material-optics\s*\{[^}]*position:\s*fixed/s);
assert.match(appearanceCss, /html\[data-vcp-radius="square"\] \.vcp-ui-scope/);
assert.match(appearanceCss, /--vcp-ui-font-family:\s*var\(--vcp-appearance-font-family\)/);
assert.match(appearanceCss, /\.chat-input-card\s*\{\s*border-radius:\s*var\(--vcp-ui-composer-radius, 24px\)/s);
assert.match(appearanceCss, /--vcp-ui-shell-radius:\s*0px/);
assert.match(appearanceCss, /--vcp-ui-shell-radius:\s*18px/);
assert.match(appearanceCss, /data-vcp-shell-radius="tuned"/);
assert.match(appearanceCss, /--vcp-ui-sidebar-item-radius:\s*10px/);
assert.match(appearanceCss, /data-vcp-surface-effect="liquid"\] \.next-ui-navigation-material/);
assert.doesNotMatch(appearanceCss, /data-vcp-surface="custom"\] \.main-content/);
assert.match(fontsCss, /--vcp-ui-font-family:\s*var\(--vcp-appearance-font-family/);
console.log('appearance engine checks passed.');
