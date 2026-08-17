import fs from 'node:fs';

const file = new URL('../main.html', import.meta.url);
let html = fs.readFileSync(file, 'utf8');

const removeRange = (startMarker, endMarker) => {
    const start = html.indexOf(startMarker);
    const end = html.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error(`Unable to find retirement range: ${startMarker}`);
    html = html.slice(0, start) + html.slice(end);
};

const removeBalancedDivByClass = className => {
    const marker = `class="${className}"`;
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) throw new Error(`Unable to find .${className}`);
    const start = html.lastIndexOf('<div', markerIndex);
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start;
    let depth = 0;
    for (let match; (match = tags.exec(html));) {
        depth += match[0] === '</div>' ? -1 : 1;
        if (depth === 0) {
            html = html.slice(0, start) + html.slice(tags.lastIndex);
            return;
        }
    }
    throw new Error(`Unbalanced .${className}`);
};

const removeButtonById = id => {
    const markerIndex = html.indexOf(`id="${id}"`);
    if (markerIndex < 0) return;
    const start = html.lastIndexOf('<button', markerIndex);
    const end = html.indexOf('</button>', markerIndex);
    if (start < 0 || end < 0) throw new Error(`Unable to remove #${id}`);
    html = html.slice(0, start) + html.slice(end + '</button>'.length);
};

if (html.includes('id="title-bar-seam-fixer"')) removeRange('    <div class="seam-fixer" id="title-bar-seam-fixer">', '    <div class="next-ui-navigation-material"');
if (html.includes('class="sidebar-actions"')) removeBalancedDivByClass('sidebar-actions');
if (html.includes('class="notification-header-actions"')) removeBalancedDivByClass('notification-header-actions');
removeButtonById('themeToggleBtn');

fs.writeFileSync(file, html);
console.log('Removed retired Classic main-window presentation nodes.');
