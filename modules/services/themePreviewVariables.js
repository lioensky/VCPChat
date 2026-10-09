const csstree = require('css-tree');

// Preview metadata only: unconditional root/body tokens, not a full browser cascade.
function extractThemePreviewVariables(content) {
    const ast = csstree.parse(content, { parseCustomProperty: false });
    const base = {};
    const dark = {};
    const light = {};
    const classify = selector => {
        if (selector === ':root' || selector === 'body' || selector === 'html') return base;
        if (selector === 'body.light-theme' || selector === 'body[data-vcp-theme="light"]'
            || selector === "body[data-vcp-theme='light']"
            || selector === 'body[data-vcp-theme=light]') return light;
        if (selector === 'body.dark-theme' || selector === 'body[data-vcp-theme="dark"]'
            || selector === "body[data-vcp-theme='dark']"
            || selector === 'body[data-vcp-theme=dark]') return dark;
        return null;
    };
    ast.children.forEach(rule => {
        if (rule.type !== 'Rule' || rule.prelude?.type !== 'SelectorList') return;
        const targets = new Set();
        rule.prelude.children.forEach(selector => {
            const target = classify(csstree.generate(selector));
            if (target) targets.add(target);
        });
        rule.block.children.forEach(declaration => {
            if (declaration.type !== 'Declaration' || !declaration.property.startsWith('--')) return;
            const value = csstree.generate(declaration.value).trim();
            targets.forEach(target => { target[declaration.property] = value; });
        });
    });
    return { dark: { ...base, ...dark }, light: { ...base, ...light } };
}

module.exports = { extractThemePreviewVariables };