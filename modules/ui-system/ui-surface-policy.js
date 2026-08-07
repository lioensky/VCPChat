// Product allowlist for child business pages that are ready to use the
// next-UI presentation. Excluded pages remain byte-identical to upstream and
// therefore always use their proven Classic presentation.

const ACTIVE_NEXT_UI_SURFACES = Object.freeze([
    'Notemodules/notes.html',
    'Translatormodules/translator.html',
]);

const ACTIVE_SUFFIXES = ACTIVE_NEXT_UI_SURFACES.map(value => `/${value.toLowerCase()}`);

function normalizedPathname(locationLike = globalThis.location) {
    let pathname = String(locationLike?.pathname || '').replaceAll('\\', '/');
    try { pathname = decodeURIComponent(pathname); } catch { /* keep the safe raw pathname */ }
    return pathname.toLowerCase();
}

function isNextUiSurfaceActive(locationLike = globalThis.location) {
    const pathname = normalizedPathname(locationLike);
    return ACTIVE_SUFFIXES.some(suffix => pathname.endsWith(suffix));
}

function resolveSurfaceUiMode(requestedMode, locationLike = globalThis.location) {
    if (requestedMode !== 'next') return 'classic';
    return isNextUiSurfaceActive(locationLike) ? 'next' : 'classic';
}

export {
    ACTIVE_NEXT_UI_SURFACES,
    isNextUiSurfaceActive,
    resolveSurfaceUiMode,
};
