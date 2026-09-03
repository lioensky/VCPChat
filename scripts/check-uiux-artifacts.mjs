import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedRoot = path.join(root, 'modules', 'uiux', 'generated');

const required = [
    'browser-entry.js',
    'index.js',
    'runtime/scope.js',
    'runtime/service-registry.js',
];

const missing = required.filter(file => {
    const absolute = path.join(generatedRoot, file);
    return !fs.existsSync(absolute) || fs.statSync(absolute).size === 0;
});

if (missing.length) {
    console.error(`UIUX generated artifact check failed; missing or empty: ${missing.join(', ')}`);
    process.exitCode = 1;
} else {
    console.log(`UIUX generated artifact check passed (${required.length} required artifacts).`);
}
