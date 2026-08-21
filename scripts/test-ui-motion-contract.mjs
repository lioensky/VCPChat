import assert from 'node:assert/strict';
import fs from 'node:fs';

const files = [
    'styles/base.css',
    'styles/components.css',
    'styles/layout.css',
    'styles/ui-next.css',
    'styles/ui-system/components.css',
    'styles/ui-system/tokens.css',
    'styles/ui-system/appearance-studio.css',
    'styles/ui-system/ask-nova.css',
];
const source = files.map(file => fs.readFileSync(file, 'utf8'));
assert.ok(source.some(css => css.includes('@media (prefers-reduced-motion: reduce)')),
    'at least one UI stylesheet must define reduced-motion behavior');
const requiredSelectors = [
    ['styles/ui-next.css', '.next-ui-launchpad'],
    ['styles/ui-system/sidebar.css', '.next-ui-account-menu'],
    ['styles/ui-system/notifications.css', '.next-ui-notification-menu'],
    ['styles/ui-system/components.css', '.vcp-ui-modal-overlay'],
];
for (const selector of requiredSelectors) {
    const [file, value] = selector;
    assert.ok(fs.readFileSync(file, 'utf8').includes(value), `missing motion surface selector: ${value}`);
}
for (const css of source) {
    const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?(?=\n\s*@media|\n\s*\/\*|$)/g) || [];
    assert.ok(reduced.every(block => !/animation-duration:\s*(?:[2-9]\d*|\d{2,})ms\b/.test(block)),
        'reduced-motion blocks may only use zero or the conventional 1ms terminal duration');
}
console.log(`UI motion contract passed: ${files.length} stylesheets inspected`);
