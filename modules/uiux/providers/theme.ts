import type {
    UiContext,
    UiDisposer,
    UiReadable,
    UiServiceDefinition,
    UiSnapshot,
} from '../contracts.js';

export interface ThemeState {
    readonly ready: boolean;
    /** User-selected mode; effective is the resolved mode used for rendering. */
    readonly preference: 'light' | 'dark' | 'system';
    readonly effective: 'light' | 'dark';
}

export type ThemeReadable = UiReadable<ThemeState>;

export interface ThemeUiService {
    readonly theme: ThemeReadable;
}

export const themeUiDefinition: UiServiceDefinition<ThemeUiService> = {
    id: 'theme-ui',
    provide: (context: UiContext) => {
        const theme = context.services.theme;
        if (!isThemeReadable(theme)) throw new TypeError('ThemeUiDefinition requires a ThemeReadable service.');
        return Object.freeze({ theme });
    },
};

function isThemeReadable(value: unknown): value is ThemeReadable {
    const candidate = value as Partial<ThemeReadable> | null;
    return Boolean(candidate
        && typeof candidate.get === 'function'
        && typeof candidate.getSnapshot === 'function'
        && typeof candidate.subscribe === 'function');
}

function normalizeThemeSnapshot(snapshot: UiSnapshot<ThemeState>): UiSnapshot<ThemeState> {
    const preference = snapshot.value.preference === 'dark' || snapshot.value.preference === 'system'
        ? snapshot.value.preference : 'light';
    const effective = snapshot.value.effective === 'dark' ? 'dark' : 'light';
    return Object.freeze({
        ...snapshot,
        value: Object.freeze({ ready: snapshot.value.ready === true, preference, effective }),
    });
}

const SEMANTIC_THEME_TOKENS = Object.freeze({
    dark: Object.freeze({
        '--vcp-ui-theme-bg-primary': 'oklch(0.04 0.012 230)',
        '--vcp-ui-theme-bg-secondary': 'oklch(0.18 0.015 230 / 0.92)',
        '--vcp-ui-theme-bg-tertiary': 'oklch(0.25 0.012 230 / 0.72)',
        '--vcp-ui-theme-bg-input': 'oklch(0.25 0.012 230 / 0.82)',
        '--vcp-ui-theme-text-primary': 'oklch(0.96 0.008 230)',
        '--vcp-ui-theme-text-secondary': 'oklch(0.68 0.015 230)',
        '--vcp-ui-theme-text-accent': 'oklch(0.75 0.14 230)',
        '--vcp-ui-theme-border': 'oklch(1 0 0 / 0.10)',
        '--vcp-ui-theme-accent': 'oklch(0.68 0.16 230)',
        '--vcp-ui-theme-accent-hover': 'oklch(0.60 0.18 230)',
        '--vcp-ui-theme-on-accent': 'oklch(1 0 0)',
        // Harness aliases are deliberately projected by the same document
        // token owner. Candidate primitives consume these names directly;
        // without them they each choose an unrelated local fallback and a
        // source-mounted Harness fixture can lose declarations such as its
        // transparent elevated-surface border.
        // Source: ui-theme/src/styles/design-platform.css and
        // ui-theme/src/styles/gradient-shadow-text.css.
        '--dsw-alias-bg-layer-1': 'rgb(35, 35, 36)',
        '--dsw-alias-bg-layer-2': 'rgb(44, 44, 46)',
        '--dsw-alias-bg-layer-3': 'rgb(53, 54, 56)',
        '--dsw-alias-bg-module-platform': 'rgb(53, 54, 56)',
        '--dsw-alias-border-inverted': 'rgba(255, 255, 255, 0.06)',
        '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.12)',
        '--dsw-alias-label-primary': 'rgb(249, 250, 251)',
        '--dsw-alias-label-tertiary': 'rgb(173, 178, 184)',
        '--dsw-alias-interactive-bg-hover': 'rgba(255, 255, 255, 0.08)',
        '--dsw-specific-menu': 'rgb(53, 54, 56)',
        '--dsw-shadow-lv3': '0 0 1px 0 rgba(0, 0, 0, 0.2), 0 0 4px 0 rgba(0, 0, 0, 0.02), 0 12px 32px 0 rgba(0, 0, 0, 0.08)',
    }),
    light: Object.freeze({
        '--vcp-ui-theme-bg-primary': 'oklch(0.98 0.008 230)',
        '--vcp-ui-theme-bg-secondary': 'oklch(0.94 0.012 230 / 0.96)',
        '--vcp-ui-theme-bg-tertiary': 'oklch(0.90 0.014 230 / 0.82)',
        '--vcp-ui-theme-bg-input': 'oklch(1 0 0 / 0.94)',
        '--vcp-ui-theme-text-primary': 'oklch(0.22 0.018 230)',
        '--vcp-ui-theme-text-secondary': 'oklch(0.45 0.018 230)',
        '--vcp-ui-theme-text-accent': 'oklch(0.48 0.13 230)',
        '--vcp-ui-theme-border': 'oklch(0.62 0.018 230 / 0.32)',
        '--vcp-ui-theme-accent': 'oklch(0.52 0.15 230)',
        '--vcp-ui-theme-accent-hover': 'oklch(0.44 0.17 230)',
        '--vcp-ui-theme-on-accent': 'oklch(1 0 0)',
        '--dsw-alias-bg-layer-1': 'rgb(255, 255, 255)',
        '--dsw-alias-bg-layer-2': 'rgb(255, 255, 255)',
        '--dsw-alias-bg-layer-3': 'rgb(255, 255, 255)',
        '--dsw-alias-bg-module-platform': 'rgb(245, 246, 247)',
        '--dsw-alias-border-inverted': 'rgba(0, 0, 0, 0)',
        '--dsw-alias-border-l2': 'rgba(0, 0, 0, 0.1)',
        '--dsw-alias-label-primary': 'rgb(15, 17, 21)',
        '--dsw-alias-label-tertiary': 'rgb(129, 133, 140)',
        // Harness source: ui-theme/src/styles/design-platform.css.
        // Keep the document-level token canonical so every Candidate Light-DOM
        // consumer inherits the same hover material rather than patching it
        // locally in individual primitives.
        '--dsw-alias-interactive-bg-hover': 'rgba(38, 49, 72, 0.06)',
        '--dsw-specific-menu': 'rgb(255, 255, 255)',
        '--dsw-shadow-lv3': '0 0 1px 0 rgba(0, 0, 0, 0.2), 0 0 4px 0 rgba(0, 0, 0, 0.02), 0 12px 32px 0 rgba(0, 0, 0, 0.08)',
    }),
});

const tokenOwners = new WeakMap<Document, Map<string, { count: number; previous: string; value: string }>>();
const presenterOwners = new WeakMap<Document, number>();
function applySemanticTokens(root: HTMLElement, effective: ThemeState['effective']): () => void {
    const tokenRoot = root.ownerDocument?.documentElement || root;
    const doc = root.ownerDocument;
    const owners = doc ? (tokenOwners.get(doc) || new Map()) : new Map();
    if (doc && !tokenOwners.has(doc)) tokenOwners.set(doc, owners);
    const tokens = SEMANTIC_THEME_TOKENS[effective];
    Object.entries(tokens).forEach(([name, value]) => {
        const owner = owners.get(name) || { count: 0, previous: tokenRoot.style.getPropertyValue(name), value };
        owner.count += 1; owner.value = value; owners.set(name, owner);
        tokenRoot.style.setProperty(name, value);
    });
    const scheme = owners.get('color-scheme') || { count: 0, previous: tokenRoot.style.getPropertyValue('color-scheme'), value: effective };
    scheme.count += 1; scheme.value = effective; owners.set('color-scheme', scheme); tokenRoot.style.setProperty('color-scheme', effective);
    return () => {
        Object.keys(tokens).concat('color-scheme').forEach(name => { const owner = owners.get(name); if (!owner) return; owner.count -= 1; if (owner.count > 0) return; owners.delete(name); if (owner.previous) tokenRoot.style.setProperty(name, owner.previous); else tokenRoot.style.removeProperty(name); });
        if (owners.size === 0 && doc) tokenOwners.delete(doc);
    };
}

/**
 * Presentation-only theme consumer. It never reads body.classList and owns its
 * subscription through the caller-provided UiScope.
 */
export function mountThemePresenter(
    root: HTMLElement,
    service: ThemeUiService,
    context: UiContext,
): UiDisposer {
    if (!root) throw new TypeError('ThemePresenter requires a root element.');
    const documentRef = root.ownerDocument;
    if (!documentRef) throw new TypeError('ThemePresenter requires a document-backed root.');
    const body = documentRef.body;
    const html = documentRef.documentElement;
    const ownedMeta = (documentRef.querySelector('meta[data-vcp-theme-color]') as HTMLMetaElement | null) || documentRef.createElement('meta');
    const createdMeta = !ownedMeta.isConnected;
    if (createdMeta) { ownedMeta.name = 'theme-color'; ownedMeta.dataset.vcpThemeColor = 'true'; documentRef.head?.append(ownedMeta); }
    presenterOwners.set(documentRef, (presenterOwners.get(documentRef) || 0) + 1);
    let restoreTokens = applySemanticTokens(root, normalizeThemeSnapshot(service.theme.getSnapshot()).value.effective);
    const apply = (snapshot: UiSnapshot<ThemeState>) => {
        const normalized = normalizeThemeSnapshot(snapshot);
        restoreTokens();
        restoreTokens = applySemanticTokens(root, normalized.value.effective);
        html.style.colorScheme = normalized.value.effective;
        if (body) {
            body.dataset.vcpTheme = normalized.value.effective;
        }
        ownedMeta.content = normalized.value.effective === 'dark' ? '#232324' : '#ffffff';
        root.dataset.themeEffective = normalized.value.effective;
        root.dataset.themeReady = String(normalized.value.ready);
        root.dataset.themePreference = normalized.value.preference;
        root.dataset.themeRevision = String(normalized.revision);
        root.dataset.themeSource = normalized.source;
    };
    apply(service.theme.getSnapshot());
    const release = context.scope.subscribe(() => service.theme.subscribe(
        (_value, snapshot) => apply(snapshot),
        { immediate: false },
    ), 'theme-presenter-subscription');
    const releaseTokens = context.scope.own(() => restoreTokens(), 'theme-presenter-tokens', 'theme-tokens');
    return async () => {
        await release();
        await releaseTokens();
        const remaining = Math.max(0, (presenterOwners.get(documentRef) || 1) - 1);
        if (remaining) presenterOwners.set(documentRef, remaining);
        else {
            presenterOwners.delete(documentRef);
            if (body?.dataset.vcpTheme === normalizeThemeSnapshot(service.theme.getSnapshot()).value.effective) delete body.dataset.vcpTheme;
            if (createdMeta) ownedMeta.remove();
        }
    };
}
