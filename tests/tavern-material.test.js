'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const css = require('css-tree');

test('Tavern base and appearance override share composer material and bounded blur', () => {
    const composer = fs.readFileSync('styles/ui-system/chat-input.css', 'utf8');
    assert.match(composer, /background: var\(--next-shell-bg, var\(--panel-bg\)\)/);
    for (const [file, selector] of [
        ['Tavernmodules/tavern.css', '.tavern-popover'],
        ['styles/appearance.css', 'html body .tavern-popover'],
    ]) {
        const ast = css.parse(fs.readFileSync(file, 'utf8'));
        let declarations;
        css.walk(ast, {
            visit: 'Rule',
            enter(node) {
                if (css.generate(node.prelude) === selector) {
                    declarations ||= {};
                    node.block.children.forEach(item => {
                        if (item.type === 'Declaration') declarations[item.property] = css.generate(item.value);
                    });
                }
            },
        });
        assert.ok(declarations, file);
        assert.match(declarations.background, /--next-shell-bg/);
        assert.match(declarations['background-image'], /--next-material-sheen/);
        assert.equal(declarations['backdrop-filter'], 'blur(10px) saturate(112%)');
        assert.equal(declarations['-webkit-backdrop-filter'], declarations['backdrop-filter']);
    }
});