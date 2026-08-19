import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const appearanceEngineSource = fs.readFileSync('modules/ui-system/appearance-engine.js', 'utf8');

const raceDom = new JSDOM('<!doctype html><html data-ui-mode="next"><head></head><body></body></html>', {
    url: 'https://vcpchat.local/',
    runScripts: 'outside-only'
});
const raceBody = raceDom.window.document.body;
raceBody.remove();
raceDom.window.eval(appearanceEngineSource);
raceDom.window.document.documentElement.dataset.uiMode = 'classic';
raceDom.window.document.documentElement.append(raceBody);
raceDom.window.document.dispatchEvent(new raceDom.window.Event('DOMContentLoaded'));
assert.equal(
    raceDom.window.document.getElementById('vcpMaterialOptics'),
    null,
    'a deferred Next optics mount must not leak into Classic after a pre-DOM mode switch'
);
raceDom.window.close();

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
assert.equal(bootOptics, null, 'Classic must not mount the Next material optics runtime');
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
assert.ok(document.getElementById('vcpMaterialOptics'), 'Next mounts the material optics runtime');
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
    surfaceBorder: 32, surfaceShadow: 18, surfaceSheen: 18,
    sidebarRowHeight: 46, sidebarAvatarSize: 32, customRadius: 10
}));
assert.equal(document.documentElement.dataset.vcpRadius, 'square');
assert.equal(document.documentElement.dataset.vcpShellRadius, 'tuned');
assert.equal(document.documentElement.dataset.vcpComposerRadius, 'tuned');
assert.match(document.getElementById('vcpAppearanceLayoutVariables').textContent, /--vcp-appearance-sidebar-row-height:46px/);
assert.match(document.getElementById('vcpAppearanceLayoutVariables').textContent, /--vcp-appearance-sidebar-avatar-size:32px/);
assert.match(document.getElementById('vcpAppearanceLayoutVariables').textContent, /--vcp-appearance-custom-radius:10px/);
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
assert.equal(appearance.normalize({ sidebarRowHeight: 80 }, 'next').sidebarRowHeight, 64);
assert.equal(appearance.normalize({ sidebarRowHeight: 20 }, 'next').sidebarRowHeight, 38);
assert.equal(appearance.normalize({ sidebarRowHeight: 38, sidebarAvatarSize: 50 }, 'next').sidebarAvatarSize, 34);
assert.equal(appearance.normalize({ radius: 'custom', customRadius: 40 }, 'next').customRadius, 32);

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
const tokensCss = fs.readFileSync('styles/ui-system/tokens.css', 'utf8');
const sidebarCss = fs.readFileSync('styles/ui-system/sidebar.css', 'utf8');
const fontsCss = fs.readFileSync('styles/ui-system/fonts.css', 'utf8');
assert.match(appearanceCss, /\.vcp-material-optics\s*\{[^}]*position:\s*fixed/s);
assert.match(appearanceCss, /html\[data-vcp-radius="square"\] \.vcp-ui-scope/);
assert.doesNotMatch(appearanceCss, /data-ui-mode/);
assert.match(appearanceCss, /--vcp-ui-font-family:\s*var\(--vcp-appearance-font-family\)/);
assert.match(appearanceCss, /\.chat-input-card\s*\{\s*border-radius:\s*var\(--vcp-ui-composer-radius, 24px\)/s);
assert.match(appearanceCss, /--vcp-ui-shell-radius:\s*0px/);
assert.match(appearanceCss, /--vcp-ui-shell-radius:\s*18px/);
assert.match(appearanceCss, /data-vcp-shell-radius="tuned"/);
assert.match(appearanceCss, /--vcp-ui-sidebar-item-radius:\s*10px/);
assert.match(appearanceCss, /data-vcp-surface-effect="liquid"\] \.next-ui-navigation-material/);
assert.doesNotMatch(appearanceCss, /data-vcp-surface="custom"\] \.main-content/);
assert.match(appearanceCss, /data-vcp-sidebar-radius="custom"[^}]*--vcp-ui-sidebar-item-radius:\s*var\(--vcp-appearance-custom-radius\)/s);
assert.match(fontsCss, /--vcp-ui-font-family:\s*var\(--vcp-appearance-font-family/);
assert.match(tokensCss, /--vcp-ui-sidebar-avatar-size:\s*var\(--vcp-appearance-sidebar-avatar-size/);
assert.match(sidebarCss, /#nextUiAccountAvatar\s*\{[^}]*var\(--vcp-ui-sidebar-avatar-size\)/s);
console.log('appearance engine checks passed.');
