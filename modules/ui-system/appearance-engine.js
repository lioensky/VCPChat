(() => {
    const STORAGE_KEY = 'vcpchat.appearanceProfile';
    const OPTION_SETS = Object.freeze({
        density: new Set(['compact', 'comfortable', 'relaxed']),
        radius: new Set(['square', 'small', 'medium', 'round', 'custom']),
        typography: new Set(['system', 'humanist', 'serif']),
        fontScale: new Set(['small', 'normal', 'large']),
        contentWidth: new Set(['full', 'centered']),
        surface: new Set(['solid', 'translucent', 'custom']),
        surfaceEffect: new Set(['vibrancy', 'mica', 'acrylic', 'liquid']),
        shellRadius: new Set(['tuned', 'follow', 'square', 'small', 'medium', 'round', 'custom']),
        composerRadius: new Set(['tuned', 'follow', 'square', 'small', 'medium', 'round', 'custom']),
        sidebarRadius: new Set(['tuned', 'follow', 'square', 'small', 'medium', 'round', 'custom']),
        cardRadius: new Set(['tuned', 'follow', 'square', 'small', 'medium', 'round', 'custom'])
    });
    const LAYOUT_RANGES = Object.freeze({
        sidebarRowHeight: Object.freeze({ min: 38, max: 64, default: 46 }),
        sidebarAvatarSize: Object.freeze({ min: 20, max: 52, default: 32 }),
        customRadius: Object.freeze({ min: 0, max: 32, default: 10 })
    });
    const MATERIAL_RANGES = Object.freeze({
        surfaceOpacity: Object.freeze({ min: 20, max: 100, default: 68 }),
        surfaceBlur: Object.freeze({ min: 0, max: 40, default: 24 }),
        surfaceSaturation: Object.freeze({ min: 50, max: 180, default: 145 }),
        surfaceBrightness: Object.freeze({ min: 80, max: 120, default: 103 }),
        surfaceBorder: Object.freeze({ min: 0, max: 100, default: 32 }),
        surfaceShadow: Object.freeze({ min: 0, max: 100, default: 18 }),
        surfaceSheen: Object.freeze({ min: 0, max: 100, default: 18 })
    });
    const MATERIAL_DEFAULTS = Object.freeze(Object.fromEntries(
        Object.entries(MATERIAL_RANGES).map(([key, range]) => [key, range.default])
    ));
    let materialOpticsMountPending = false;
    let revision = 0;
    let currentProfile = null;
    let stateChannel = null;
    const PRESETS = Object.freeze({
        classic: Object.freeze({
            density: 'comfortable', radius: 'small', typography: 'system',
            fontScale: 'normal', contentWidth: 'full', surface: 'translucent',
            sidebarRowHeight: 46,
            sidebarAvatarSize: 32,
            customRadius: 10,
            surfaceEffect: 'vibrancy',
            ...MATERIAL_DEFAULTS,
            shellRadius: 'tuned', composerRadius: 'tuned', sidebarRadius: 'tuned', cardRadius: 'tuned'
        }),
        next: Object.freeze({
            density: 'comfortable', radius: 'medium', typography: 'humanist',
            fontScale: 'normal', contentWidth: 'full', surface: 'translucent',
            sidebarRowHeight: 46,
            sidebarAvatarSize: 32,
            customRadius: 10,
            surfaceEffect: 'vibrancy',
            ...MATERIAL_DEFAULTS,
            shellRadius: 'tuned', composerRadius: 'tuned', sidebarRadius: 'tuned', cardRadius: 'tuned'
        })
    });

    function normalizeUiMode(mode) {
        return mode === 'next' ? 'next' : 'classic';
    }

    function normalize(profile, uiMode = 'classic') {
        const preset = PRESETS[normalizeUiMode(uiMode)];
        const source = profile && typeof profile === 'object' ? profile : {};
        const options = Object.fromEntries(Object.entries(OPTION_SETS).map(([key, allowed]) => {
            const value = source[key];
            return [key, allowed.has(value) ? value : preset[key]];
        }));
        const material = Object.fromEntries(Object.entries(MATERIAL_RANGES).map(([key, range]) => {
            const parsed = Number(source[key]);
            const value = Number.isFinite(parsed) ? parsed : preset[key];
            return [key, Math.min(range.max, Math.max(range.min, Math.round(value)))];
        }));
        const rowRange = LAYOUT_RANGES.sidebarRowHeight;
        const parsedRowHeight = Number(source.sidebarRowHeight);
        const sidebarRowHeight = Math.min(rowRange.max, Math.max(
            rowRange.min,
            Math.round(Number.isFinite(parsedRowHeight) ? parsedRowHeight : preset.sidebarRowHeight)
        ));
        const avatarRange = LAYOUT_RANGES.sidebarAvatarSize;
        const parsedAvatarSize = Number(source.sidebarAvatarSize);
        const sidebarAvatarSize = Math.min(
            avatarRange.max,
            sidebarRowHeight - 4,
            Math.max(
                avatarRange.min,
                Math.round(Number.isFinite(parsedAvatarSize) ? parsedAvatarSize : preset.sidebarAvatarSize)
            )
        );
        const customRadiusRange = LAYOUT_RANGES.customRadius;
        const parsedCustomRadius = Number(source.customRadius);
        const customRadius = Math.min(customRadiusRange.max, Math.max(
            customRadiusRange.min,
            Math.round(Number.isFinite(parsedCustomRadius) ? parsedCustomRadius : preset.customRadius)
        ));
        const layout = { sidebarRowHeight, sidebarAvatarSize, customRadius };
        return { ...options, ...material, ...layout };
    }

    function applyMaterialVariables(resolved) {
        let materialVariablesNode = document.getElementById('vcpAppearanceMaterialVariables');
        if (!materialVariablesNode) {
            materialVariablesNode = document.createElement('style');
            materialVariablesNode.id = 'vcpAppearanceMaterialVariables';
            document.head.append(materialVariablesNode);
        }
        const shadowColorStrength = Math.round(resolved.surfaceShadow * 0.4);
        const softSheenStrength = Math.round(resolved.surfaceSheen * 0.35);
        const liquidBlur = Math.round(resolved.surfaceBlur * 0.55 * 10) / 10;
        materialVariablesNode.textContent = `:root{
            --vcp-material-opacity:${resolved.surfaceOpacity}%;
            --vcp-material-blur:${resolved.surfaceBlur}px;
            --vcp-material-saturation:${resolved.surfaceSaturation}%;
            --vcp-material-brightness:${resolved.surfaceBrightness}%;
            --vcp-material-border:${resolved.surfaceBorder}%;
            --vcp-material-shadow:${resolved.surfaceShadow}%;
            --vcp-material-shadow-color:${shadowColorStrength}%;
            --vcp-material-sheen:${resolved.surfaceSheen}%;
            --vcp-material-sheen-soft:${softSheenStrength}%;
            --vcp-material-liquid-blur:${liquidBlur}px;
        }`;
    }

    function applyLayoutVariables(resolved) {
        let layoutVariablesNode = document.getElementById('vcpAppearanceLayoutVariables');
        if (!layoutVariablesNode) {
            layoutVariablesNode = document.createElement('style');
            layoutVariablesNode.id = 'vcpAppearanceLayoutVariables';
            document.head.append(layoutVariablesNode);
        }
        const curve = factor => Math.round(resolved.customRadius * factor * 10) / 10;
        layoutVariablesNode.textContent = `:root{
            --vcp-appearance-sidebar-row-height:${resolved.sidebarRowHeight}px;
            --vcp-appearance-sidebar-avatar-size:${resolved.sidebarAvatarSize}px;
            --vcp-appearance-custom-radius:${resolved.customRadius}px;
            --vcp-appearance-shell-curve-1:${curve(0.767)}px;
            --vcp-appearance-shell-curve-2:${curve(0.5)}px;
            --vcp-appearance-shell-curve-3:${curve(0.294)}px;
            --vcp-appearance-shell-curve-4:${curve(0.144)}px;
            --vcp-appearance-shell-curve-5:${curve(0.028)}px;
        }`;
    }

    function mountMaterialOptics() {
        materialOpticsMountPending = false;
        if (normalizeUiMode(document.documentElement.dataset.uiMode) !== 'next') return;
        if (!document.body || document.getElementById('vcpMaterialOptics')) return;
        const namespace = 'http://www.w3.org/2000/svg';
        const optics = document.createElementNS(namespace, 'svg');
        optics.id = 'vcpMaterialOptics';
        optics.classList.add('vcp-material-optics');
        optics.setAttribute('width', '0');
        optics.setAttribute('height', '0');
        optics.setAttribute('aria-hidden', 'true');
        optics.innerHTML = `
            <defs>
                <filter id="vcpLiquidGlassOptics" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">
                    <feTurbulence type="fractalNoise" baseFrequency="0.008 0.028" numOctaves="2" seed="23" result="noise"/>
                    <feGaussianBlur in="noise" stdDeviation="0.55" result="softNoise"/>
                    <feDisplacementMap in="SourceGraphic" in2="softNoise" scale="7" xChannelSelector="R" yChannelSelector="G" result="refracted"/>
                    <feSpecularLighting in="softNoise" surfaceScale="1.4" specularConstant="0.34" specularExponent="28" lighting-color="white" result="specular">
                        <feDistantLight azimuth="225" elevation="58"/>
                    </feSpecularLighting>
                    <feComposite in="specular" in2="SourceGraphic" operator="in" result="edgeLight"/>
                    <feBlend in="refracted" in2="edgeLight" mode="screen"/>
                </filter>
            </defs>`;
        document.body.prepend(optics);
    }

    function ensureMaterialOptics() {
        if (document.getElementById('vcpMaterialOptics') || materialOpticsMountPending) return;
        if (document.body) {
            mountMaterialOptics();
            return;
        }
        materialOpticsMountPending = true;
        document.addEventListener('DOMContentLoaded', mountMaterialOptics, { once: true });
    }

    function syncMaterialOptics(uiMode) {
        if (normalizeUiMode(uiMode) === 'next') {
            ensureMaterialOptics();
            return;
        }
        materialOpticsMountPending = false;
        document.getElementById('vcpMaterialOptics')?.remove();
    }

    function apply(profile, options = {}) {
        const uiMode = options.uiMode || document.documentElement.dataset.uiMode || 'classic';
        const resolved = normalize(profile, uiMode);
        const root = document.documentElement;
        root.dataset.vcpDensity = resolved.density;
        root.dataset.vcpRadius = resolved.radius;
        root.dataset.vcpTypography = resolved.typography;
        root.dataset.vcpFontScale = resolved.fontScale;
        root.dataset.vcpContentWidth = resolved.contentWidth;
        root.dataset.vcpSurface = resolved.surface;
        root.dataset.vcpSurfaceEffect = resolved.surfaceEffect;
        syncMaterialOptics(uiMode);
        applyMaterialVariables(resolved);
        applyLayoutVariables(resolved);
        root.dataset.vcpShellRadius = resolved.shellRadius;
        root.dataset.vcpComposerRadius = resolved.composerRadius;
        root.dataset.vcpSidebarRadius = resolved.sidebarRadius;
        root.dataset.vcpCardRadius = resolved.cardRadius;
        document.querySelectorAll('.vcp-ui-scope').forEach((scope) => {
            scope.dataset.density = resolved.density;
        });
        if (options.cache === true) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(resolved));
        }
        window.dispatchEvent(new CustomEvent('vcp-appearance-changed', {
            detail: { profile: resolved, source: options.source || 'runtime', revision }
        }));
        currentProfile = resolved;
        stateChannel?.publish(Object.freeze({ profile: resolved, revision }), {
            source: options.source || 'runtime',
            force: options.force === true,
        });
        return resolved;
    }

    function commit(profile, options = {}) {
        revision += 1;
        return apply(profile, { ...options, cache: true });
    }

    function getRevision() {
        return revision;
    }

    function readCache(uiMode = 'classic') {
        try {
            return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'), uiMode);
        } catch {
            return normalize(null, uiMode);
        }
    }

    const bootMode = document.documentElement.dataset.uiMode || 'classic';
    apply(readCache(bootMode), { uiMode: bootMode, source: 'boot-cache' });
    stateChannel = window.VCPStateChannels?.create('appearance', Object.freeze({ profile: currentProfile, revision })) || null;
    window.addEventListener('ui-mode-changed', event => {
        syncMaterialOptics(event.detail?.mode || document.documentElement.dataset.uiMode);
    });
    window.VCPAppearance = Object.freeze({
        PRESETS, MATERIAL_RANGES, LAYOUT_RANGES, normalize, apply, commit, getRevision, readCache,
        getCurrent: () => currentProfile,
        subscribe: (listener, options) => stateChannel?.subscribe(listener, options) || (() => false),
    });
})();
