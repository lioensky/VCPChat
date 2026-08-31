import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

// Settings surface split invariants (refactor 2026-08-27, R2-02E).
// settings.css used to be a single 2000+ line file mixing shell layout,
// control contracts, canonical rows, generated template declarations and the
// body-level portal override — the "who owns this rule" debt that produced
// the 2026-08-27 portal stacking regression. It is now an import-only entry
// over single-concern part files; these tests keep the split honest.

const styleDir = path.join(process.cwd(), 'styles', 'ui-system');
const entryPath = path.join(styleDir, 'settings.css');
const ENTRY_PARTS = [
    'settings-shell.css',       // layered shell/typography/controls/cards/avatar
    'settings-overrides.css',   // unlayered legacy + canonical row/input ownership passes
    'settings-primitives.css',  // live SettingsRoot panel/nav/content primitives
    'settings-template.css',    // canonicalized [data-vcp-style] template declarations
    'settings-portal.css',      // body-level portal stacking override
    'settings-stream-animation.css', // upstream streaming-animation settings + live preview
];

const read = name => fs.readFileSync(path.join(styleDir, name), 'utf8');

test('settings.css entry is import-only and orders the single-concern parts', () => {
    const source = read('settings.css');
    const imports = [...source.matchAll(/@import\s+url\('\.\/([^']+)'\);/g)].map(match => match[1]);
    assert.deepEqual(imports, ENTRY_PARTS, 'entry import list must match the documented part order');
    // Strip comments, imports and whitespace: nothing but those may remain.
    const residue = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@import\s+url\([^)]*\);/g, '')
        .trim();
    assert.equal(residue, '', 'settings.css must not carry rules of its own');
});

test('every settings part exists, is loaded by the entry, and is brace-balanced', () => {
    for (const name of ENTRY_PARTS) {
        const source = read(name);
        const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
        const opens = (stripped.match(/\{/g) || []).length;
        const closes = (stripped.match(/\}/g) || []).length;
        assert.equal(opens, closes, `${name} must not split an @layer/@scope/rule block across part files`);
        const atRules = [...stripped.matchAll(/@(layer|scope)\b/g)].length;
        assert.ok(opens > 0 || atRules === 0 || source.trim().length === 0, `${name} is unexpectedly empty`);
    }
    const declared = new Set(ENTRY_PARTS);
    const onDisk = fs.readdirSync(styleDir).filter(name => /^settings-.+\.css$/.test(name));
    for (const name of onDisk) {
        assert.ok(declared.has(name), `orphan settings part on disk but not imported by the entry: ${name}`);
    }
});

test('cross-part selector duplicates follow the override-after-layer contract', () => {
    const isLayered = rule => {
        for (let parent = rule.parent; parent; parent = parent.parent) {
            if (parent.type === 'atrule' && parent.name === 'layer') return true;
        }
        return false;
    };
    const owner = new Map(); // selector -> { part, layered }
    for (const name of ENTRY_PARTS) {
        const root = postcss.parse(read(name), { from: path.join(styleDir, name) });
        root.walkRules(rule => {
            if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
            for (const selector of rule.selectors) {
                const previous = owner.get(selector);
                const layered = isLayered(rule);
                if (previous) {
                    // Same-part repeats are pre-existing cascade tuning inside
                    // one concern — not a split problem. The one sanctioned
                    // CROSS-part repeat: a later UNLAYERED declaration
                    // out-ranking an earlier LAYERED one (the "unlayered
                    // wins" cascade contract documented at the top of
                    // settings-overrides.css). Any other cross-part duplicate
                    // means two concerns fight over one selector.
                    const sanctioned = previous.part === name
                        || (previous.layered && !layered);
                    assert.ok(sanctioned, `selector "${selector}" is owned by both ${previous.part} and ${name} without an override-after-layer rationale`);
                }
                owner.set(selector, { part: name, layered });
            }
        });
    }
    assert.ok(owner.size > 100, 'settings parts unexpectedly contain almost no rules — check the split');
});

test('the template part stays machine-owned and the portal part keeps the stacking override', () => {
    const template = read('settings-template.css');
    assert.match(template, /Canonicalized template presentation declarations/, 'template part header comment missing');
    assert.doesNotMatch(template.replace(/\/\*[\s\S]*?\*\//g, ''), /^(?!\s*:is).*\{/m, 'template part must contain only canonicalized declarations');
    const portal = read('settings-portal.css');
    assert.match(portal, /z-index:\s*calc\(var\(--vcp-ui-z-overlay\)\s*\+\s*10\)/, 'portal part must keep the overlay-relative stacking lift');
    assert.match(portal, /\.vcp-uiux-primitive-menu/, 'portal part must target the generated primitive menu portal');
});
