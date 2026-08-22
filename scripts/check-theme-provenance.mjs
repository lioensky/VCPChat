import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = path.join(root, 'styles', 'themes.css');
const sourceDir = path.join(root, 'styles', 'themes');
const artifact = fs.readFileSync(artifactPath);
const sources = fs.readdirSync(sourceDir).filter(file => file.endsWith('.css'));
const matches = sources.filter(file => artifact.equals(fs.readFileSync(path.join(sourceDir, file))));
if (matches.length !== 1) {
    console.error(`Theme provenance failed: active styles/themes.css must match exactly one source theme; matches=${matches.length}`);
    process.exitCode = 1;
} else {
    console.log(`Theme provenance passed: styles/themes.css <- styles/themes/${matches[0]}`);
}
