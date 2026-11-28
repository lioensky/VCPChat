/**
 * Theme scoping and automatic light-theme surface/contrast adaptation
 * for inline AI-authored HTML island `<style>` blocks.
 */

const THEME_ROOT_QUALIFIER_RE = /^(:root|html|body)((?:\.(?:light|dark)-theme|\[data-vcp-theme(?:=[^\]]+)?\])+)($|[\s>+~.#[:][\s\S]*)$/i;
const PLAIN_ROOT_SELECTOR_RE = /^(?::root|html|body)(?=$|[\s>+~.#[:])/i;
const EXPLICIT_THEME_SELECTOR_RE = /(?:\.(?:light|dark)-theme\b|\[data-vcp-theme\b)/i;

const BG_PROPS = new Set(['background', 'background-color', 'background-image']);
const BORDER_PROPS = new Set([
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'outline', 'outline-color',
]);
const TEXT_PROPS = new Set(['color', '-webkit-text-fill-color']);

const NAMED_LIGHT_HEX = Object.freeze({
    white: '#ffffff',
    snow: '#fffafa',
    ivory: '#fffff0',
    whitesmoke: '#f5f5f5',
    aliceblue: '#f0f8ff',
    azure: '#f0ffff',
    mintcream: '#f5fffa',
    honeydew: '#f0fff0',
    lavender: '#e6e6fa',
    cyan: '#00ffff',
    aqua: '#00ffff',
    yellow: '#ffff00',
    lime: '#00ff00',
});

const NAMED_DARK_HEX = Object.freeze({
    black: '#000000',
    navy: '#000080',
    midnightblue: '#191970',
    darkslategray: '#2f4f4f',
    darkslategrey: '#2f4f4f',
});

/**
 * Scope a single CSS selector under `#scopeId`, preserving ancestor theme qualifiers
 * such as `body.light-theme` or `html[data-vcp-theme="light"]` outside the message root.
 *
 * @param {string} selector
 * @param {string} scopeSelectorText - Escaped `#scopeId` selector string.
 * @returns {string}
 */
export function scopeRootAwareSelector(selector, scopeSelectorText) {
    const normalized = String(selector || '').trim();
    if (!normalized) throw new SyntaxError('Empty selector is not allowed');

    const themeMatch = normalized.match(THEME_ROOT_QUALIFIER_RE);
    if (themeMatch) {
        const [, rootTag, qualifiers, rest] = themeMatch;
        const ancestor = `${rootTag}${qualifiers}`;
        const trimmedRest = rest.trimStart();
        if (!trimmedRest) return `${ancestor} ${scopeSelectorText}`;
        if (/^::?[\w-]+$/.test(trimmedRest) && !rest.startsWith(' ')) {
            return `${ancestor} ${scopeSelectorText}${trimmedRest}`;
        }
        return `${ancestor} ${scopeSelectorText} ${trimmedRest}`;
    }

    if (PLAIN_ROOT_SELECTOR_RE.test(normalized)) {
        return normalized.replace(PLAIN_ROOT_SELECTOR_RE, scopeSelectorText);
    }
    if (/^::?[\w-]+$/.test(normalized)) return `${scopeSelectorText}${normalized}`;
    return `${scopeSelectorText} ${normalized}`;
}

/**
 * Returns true if any rule selector in the parsed stylesheet already targets
 * `.light-theme`, `.dark-theme`, or `[data-vcp-theme...]`.
 *
 * @param {object} ast - Parsed css-tree AST.
 * @param {object} cssTree
 * @returns {boolean}
 */
export function hasExplicitThemeSelectors(ast, cssTree) {
    let found = false;
    cssTree.walk(ast, {
        visit: 'Rule',
        enter(node) {
            if (found || !node?.prelude) return;
            const preludeText = cssTree.generate(node.prelude);
            if (EXPLICIT_THEME_SELECTOR_RE.test(preludeText)) {
                found = true;
            }
        }
    });
    return found;
}

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

function parseHexColor(hex) {
    const clean = hex.slice(1);
    if (clean.length === 3 || clean.length === 4) {
        const r = parseInt(clean[0] + clean[0], 16);
        const g = parseInt(clean[1] + clean[1], 16);
        const b = parseInt(clean[2] + clean[2], 16);
        const a = clean.length === 4 ? parseInt(clean[3] + clean[3], 16) / 255 : 1;
        return { r, g, b, a };
    }
    if (clean.length === 6 || clean.length === 8) {
        const r = parseInt(clean.slice(0, 2), 16);
        const g = parseInt(clean.slice(2, 4), 16);
        const b = parseInt(clean.slice(4, 6), 16);
        const a = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1;
        return { r, g, b, a };
    }
    return null;
}

function parseRgbChannel(raw) {
    const token = raw.trim();
    if (token.endsWith('%')) {
        return clamp01(parseFloat(token) / 100) * 255;
    }
    const num = parseFloat(token);
    return Number.isFinite(num) ? Math.min(255, Math.max(0, num)) : null;
}

function parseAlphaChannel(raw) {
    if (raw === undefined) return 1;
    const token = raw.trim();
    if (token.endsWith('%')) {
        const pct = parseFloat(token);
        return Number.isFinite(pct) ? clamp01(pct / 100) : null;
    }
    const num = parseFloat(token);
    return Number.isFinite(num) ? clamp01(num) : null;
}

function parseRgbFunction(fnStr) {
    const match = fnStr.match(/^rgba?\(\s*([^)]+)\s*\)$/i);
    if (!match) return null;
    const body = match[1].trim();
    let channels;
    let alphaRaw;

    if (body.includes(',')) {
        const parts = body.split(',').map((s) => s.trim());
        if (parts.length !== 3 && parts.length !== 4) return null;
        channels = parts.slice(0, 3);
        alphaRaw = parts[3];
    } else {
        const [rgbPart, alphaPart] = body.split('/').map((s) => s.trim());
        channels = rgbPart.split(/\s+/);
        if (channels.length !== 3) return null;
        alphaRaw = alphaPart;
    }

    const r = parseRgbChannel(channels[0]);
    const g = parseRgbChannel(channels[1]);
    const b = parseRgbChannel(channels[2]);
    const a = parseAlphaChannel(alphaRaw);
    if (r === null || g === null || b === null || a === null) return null;
    return { r, g, b, a };
}

function parseColorToken(token) {
    const trimmed = token.trim();
    const lower = trimmed.toLowerCase();
    if (NAMED_LIGHT_HEX[lower]) return parseHexColor(NAMED_LIGHT_HEX[lower]);
    if (NAMED_DARK_HEX[lower]) return parseHexColor(NAMED_DARK_HEX[lower]);
    if (trimmed.startsWith('#')) return parseHexColor(trimmed);
    if (lower.startsWith('rgb')) return parseRgbFunction(trimmed);
    return null;
}

function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return { h: h * 60, s, l };
}

function hslToRgb(h, s, l) {
    if (s === 0) {
        const v = Math.round(clamp01(l) * 255);
        return { r: v, g: v, b: v };
    }
    const hue2rgb = (p, q, tRaw) => {
        let t = tRaw;
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hn = ((h % 360) + 360) % 360 / 360;
    return {
        r: Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
        g: Math.round(hue2rgb(p, q, hn) * 255),
        b: Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
    };
}

function relativeLuminance(r, g, b) {
    const lin = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function formatColor({ r, g, b, a = 1 }) {
    const ri = Math.round(r);
    const gi = Math.round(g);
    const bi = Math.round(b);
    if (a >= 0.999) {
        return `#${[ri, gi, bi].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
    return `rgba(${ri}, ${gi}, ${bi}, ${Number(a.toFixed(3))})`;
}

function isDarkSurfaceColor({ r, g, b, a }) {
    if (a < 0.04) return false;
    const { s, l } = rgbToHsl(r, g, b);
    return l < 0.22 || (a <= 0.72 && l < 0.30 && s < 0.55);
}

function adaptBackgroundColor(parsed) {
    const { r, g, b, a } = parsed;
    const hsl = rgbToHsl(r, g, b);

    // Nearly-invisible white-alpha surface -> crisp light card over warm paper.
    if (hsl.l > 0.85 && a >= 0.01 && a <= 0.25) {
        return 'rgba(255, 255, 255, 0.72)';
    }

    if (!isDarkSurfaceColor(parsed)) return null;

    if (hsl.s <= 0.20) {
        if (a <= 0.65) {
            const inkAlpha = Math.min(0.08, Math.max(0.04, a * 0.2));
            return `rgba(27, 33, 31, ${Number(inkAlpha.toFixed(3))})`;
        }
        return 'var(--secondary-bg, #f8fafc)';
    }

    const lightRgb = hslToRgb(hsl.h, Math.min(0.45, hsl.s), 0.95);
    const outAlpha = a > 0.85 ? 1 : Math.max(0.78, Math.min(0.92, a + 0.35));
    return formatColor({ ...lightRgb, a: outAlpha });
}

function adaptBorderColor(parsed) {
    const { r, g, b, a } = parsed;
    const hsl = rgbToHsl(r, g, b);

    if (hsl.l > 0.85 && a >= 0.02 && a <= 0.35) {
        const borderAlpha = Math.min(0.22, Math.max(0.10, a * 1.35));
        return `rgba(27, 33, 31, ${Number(borderAlpha.toFixed(3))})`;
    }

    if (hsl.l > 0.50 && hsl.s >= 0.25) {
        const darkRgb = hslToRgb(hsl.h, Math.min(0.9, hsl.s), Math.min(hsl.l, 0.40));
        return formatColor({ ...darkRgb, a });
    }

    return null;
}

function adaptTextColor(parsed) {
    const { r, g, b, a } = parsed;
    if (a < 0.1) return null;
    const lum = relativeLuminance(r, g, b);
    if (lum <= 0.28) return null;

    const hsl = rgbToHsl(r, g, b);
    if (hsl.s < 0.18) {
        return lum > 0.55
            ? 'var(--primary-text, #1e293b)'
            : 'var(--secondary-text, #475569)';
    }

    // Preserve chromatic hue while lowering lightness for >= 5:1 contrast on light paper.
    const targetSat = Math.min(0.92, Math.max(hsl.s * 0.9, 0.65));
    let lo = 0.10;
    let hi = Math.min(hsl.l, 0.48);
    let best = hslToRgb(hsl.h, targetSat, lo);
    for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const candidate = hslToRgb(hsl.h, targetSat, mid);
        if (relativeLuminance(candidate.r, candidate.g, candidate.b) <= 0.16) {
            best = candidate;
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return formatColor({ ...best, a });
}

/**
 * Replace top-level CSS color literals in `value` outside `var(...)` calls,
 * passing each parsed `{ r, g, b, a }` to `mapper`.
 */
function transformColorLiteralsOutsideVar(value, mapper) {
    const src = String(value || '');
    const colorPattern = /var\([^)]*\)|#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|\b(?:white|snow|ivory|whitesmoke|aliceblue|azure|mintcream|honeydew|lavender|cyan|aqua|yellow|lime|black|navy|midnightblue|darkslategra[ey])\b/gi;
    let changed = false;

    const out = src.replace(colorPattern, (token) => {
        if (token.toLowerCase().startsWith('var(')) return token;
        const parsed = parseColorToken(token);
        if (!parsed) return token;
        const replacement = mapper(parsed);
        if (!replacement) return token;
        changed = true;
        return replacement;
    });

    return changed ? out : null;
}

function hasOpaqueNonLightenedBackground(declarations) {
    for (const decl of declarations) {
        const prop = String(decl.property || '').toLowerCase();
        if (!BG_PROPS.has(prop)) continue;
        const val = String(decl.value || '');
        if (/var\(/i.test(val)) continue;
        let keepsDarkSolid = false;
        transformColorLiteralsOutsideVar(val, (parsed) => {
            if (parsed.a >= 0.85 && relativeLuminance(parsed.r, parsed.g, parsed.b) < 0.36 && !isDarkSurfaceColor(parsed)) {
                keepsDarkSolid = true;
            }
            return null;
        });
        if (keepsDarkSolid) return true;
    }
    return false;
}

/**
 * Inspect already-scoped rules in `ast` and return light-theme override rules
 * (`body.light-theme <selector>, body[data-vcp-theme="light"] <selector>`)
 * when dark-glass surfaces or low-contrast light/pastel ink colors are detected.
 *
 * @param {Array<{ parentList: object, scopedSelectors: string[], declarations: Array<{ property: string, value: string, important: boolean }> }>} ruleSnapshots
 * @returns {Array<{ parentList: object, cssText: string }>}
 */
export function buildLightThemeOverrides(ruleSnapshots) {
    const overrides = [];

    for (const snapshot of ruleSnapshots) {
        const { parentList, scopedSelectors, declarations } = snapshot;
        if (!parentList || !Array.isArray(scopedSelectors) || scopedSelectors.length === 0 || !Array.isArray(declarations) || declarations.length === 0) continue;

        const keepWhiteText = hasOpaqueNonLightenedBackground(declarations);
        const adaptedDecls = [];

        for (const decl of declarations) {
            const prop = String(decl.property || '').toLowerCase();
            const val = String(decl.value || '');
            let nextVal = null;

            if (BG_PROPS.has(prop)) {
                nextVal = transformColorLiteralsOutsideVar(val, adaptBackgroundColor);
            } else if (BORDER_PROPS.has(prop)) {
                nextVal = transformColorLiteralsOutsideVar(val, adaptBorderColor);
            } else if (TEXT_PROPS.has(prop) && !keepWhiteText) {
                nextVal = transformColorLiteralsOutsideVar(val, adaptTextColor);
            }

            if (nextVal) {
                adaptedDecls.push(`${decl.property}:${nextVal}${decl.important ? ' !important' : ''}`);
            }
        }

        if (adaptedDecls.length === 0) continue;

        const selectors = scopedSelectors
            .map((s) => s.trim())
            .filter(Boolean)
            .flatMap((s) => (
                EXPLICIT_THEME_SELECTOR_RE.test(s)
                    ? []
                    : [`body.light-theme ${s}`, `body[data-vcp-theme="light"] ${s}`]
            ));

        if (selectors.length === 0) continue;
        overrides.push({
            parentList,
            cssText: `${selectors.join(',')} { ${adaptedDecls.join(';')} }`,
        });
    }

    return overrides;
}
