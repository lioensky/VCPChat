import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const evidence = JSON.parse(read('scripts/vcpui-production-consumers.json'));
const { COMPONENT_MANIFEST } = await import(`${pathToFileURL(path.join(root, 'modules/ui-system/component-manifest.js')).href}?consumer-check=1`);
const manifestByName = new Map();
for (const item of COMPONENT_MANIFEST) {
    manifestByName.set(item.name, item);
    item.aliases.forEach(alias => manifestByName.set(alias, item));
}

const showcaseSource = read('modules/ui-system/component-showcase.js');
const showcased = new Set([...showcaseSource.matchAll(/section\('([A-Za-z]+)'/g)].map(match => {
    const item = manifestByName.get(match[1]);
    assert.ok(item, `showcase uses unregistered component ${match[1]}`);
    return item.name;
}));

for (const item of COMPONENT_MANIFEST) {
    assert.ok(showcased.has(item.name), `${item.name} is missing from the user-visible component library`);
    const record = evidence[item.name];
    if (item.status === 'stable') assert.ok(record, `${item.name} is stable without a production consumer`);
    if (!record) continue;
    assert.equal(item.status, 'stable', `${item.name} has reviewed production evidence but is not stable`);
    for (const field of ['source', 'electron']) {
        assert.ok(Array.isArray(record[field]) && record[field].length === 2, `${item.name}.${field} must contain [file, token]`);
        const [file, token] = record[field];
        assert.ok(fs.existsSync(path.join(root, file)), `${item.name}.${field} file is missing: ${file}`);
        assert.ok(read(file).includes(token), `${item.name}.${field} evidence disappeared from ${file}: ${token}`);
    }
}

for (const name of Object.keys(evidence)) assert.ok(manifestByName.has(name), `consumer evidence references unknown component ${name}`);
const stable = COMPONENT_MANIFEST.filter(item => item.status === 'stable').length;
console.log(`VCPUI consumer gate passed (${stable} stable with production/Electron evidence, ${COMPONENT_MANIFEST.length - stable} candidate, ${showcased.size} showcased).`);
