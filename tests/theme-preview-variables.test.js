const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractThemePreviewVariables: extract } = require('../modules/services/themePreviewVariables');

test('Obsidian grouped selectors expose both palettes and wallpapers', () => {
    const css = fs.readFileSync(path.join(__dirname, '../styles/themes/themes黑曜与星火.css'), 'utf8');
    const { dark, light } = extract(css);
    assert.equal(dark['--button-bg'], '#FFB703');
    assert.equal(light['--button-bg'], '#1D4ED8');
    assert.match(dark['--chat-wallpaper-dark'], /relic_obsidian_dark/);
    assert.match(light['--chat-wallpaper-light'], /relic_ivory_light/);
});

test('legacy single selectors remain compatible', () => {
    const css = fs.readFileSync(path.join(__dirname, '../styles/themes/themes静谧森岭.css'), 'utf8');
    const { dark, light } = extract(css);
    assert.equal(dark['--button-bg'], '#587465');
    assert.equal(light['--button-bg'], '#6e8598');
});

test('merge global tokens, ignore component and conditional overrides', () => {
    const { dark, light } = extract(`
        :root { --base: rgba(1, 2, 3, .5); --button-bg: black }
        body[data-vcp-theme="dark"] { --button-bg: gold; }
        body.light-theme, body[data-vcp-theme="light"] { --button-bg: blue; }
        body.light-theme .card { --button-bg: red; }
        @media (max-width: 500px) { :root { --button-bg: green; } }
    `);
    assert.equal(dark['--button-bg'], 'gold');
    assert.equal(light['--button-bg'], 'blue');
    assert.equal(light['--base'], dark['--base']);
});