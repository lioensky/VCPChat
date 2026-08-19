import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const root = path.resolve(import.meta.dirname, '..');
const candidates = [];
const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (entry.name.endsWith('.css') && target !== path.join(root, 'styles', 'themes.css')) candidates.push(target);
    }
};
visit(path.join(root, 'styles'));

let promoted = 0;
let removed = 0;
for (const file of candidates) {
    const original = fs.readFileSync(file, 'utf8');
    const tree = postcss.parse(original, { from: file });
    tree.walkRules(rule => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        if (rule.selectors.every(selector => selector.includes('html:not([data-ui-mode="next"])'))) {
            rule.remove();
            removed += 1;
            return;
        }
        const selectors = rule.selectors.map(selector => selector.replaceAll('html[data-ui-mode="next"]', 'html'));
        if (selectors.some((selector, index) => selector !== rule.selectors[index])) {
            rule.selectors = selectors;
            promoted += 1;
        }
    });
    tree.walkAtRules(rule => {
        if (Array.isArray(rule.nodes) && rule.nodes.length === 0) rule.remove();
    });
    const output = tree.toString();
    if (output !== original) fs.writeFileSync(file, output);
}
console.log(`Promoted ${promoted} canonical selectors and removed ${removed} Classic-only rules.`);
