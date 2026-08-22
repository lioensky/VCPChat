// Computes the self-contained offline Web Awesome runtime used by VCPUI.
// The default mode is read-only. Pass --output <directory> to materialize the
// closure in a new directory; the source vendor tree is never modified.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const sourceRoot = path.join(root, 'node_modules', '@awesome.me', 'webawesome');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputRoot = outputIndex === -1 ? null : path.resolve(args[outputIndex + 1] || '');
const checkIndex = args.indexOf('--check');
const checkRoot = checkIndex === -1 ? null : path.resolve(args[checkIndex + 1] || '');

const manifestModule = await import(pathToFileURL(path.join(root, 'modules', 'ui-system', 'webawesome-runtime-manifest.js')).href);
const components = [...manifestModule.WEB_AWESOME_COMPONENTS];
const runtimeVersion = manifestModule.WEB_AWESOME_VERSION;
const runtimeLocale = manifestModule.WEB_AWESOME_LOCALE;
const entries = [
    'package.json',
    'LICENSE.md',
    'dist-cdn/styles/themes/default.css',
    'dist-cdn/translations/zh-cn.js',
    ...components.map(component => `dist-cdn/components/${component}/${component}.js`),
];
const dependencyPatterns = [
    /(?:from\s+|import\s*\()['"](\.\.?\/[^'"\n]+)['"]/g,
    /import\s*['"](\.\.?\/[^'"\n]+)['"]/g,
    /@import\s+(?:url\()?\s*['"]?(\.\.?\/[^'"\s)]+)['"]?\s*\)?/g,
    /url\(\s*['"]?(\.\.?\/[^'"\s)]+)['"]?\s*\)/g,
    /new\s+URL\(\s*['"](\.\.?\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
];

function assertSafeOutput(target) {
    if (!target) return;
    const allowedParent = path.join(root, 'vendor');
    if (target === sourceRoot || target === allowedParent || !target.startsWith(`${allowedParent}${path.sep}`)) {
        throw new Error('--output must be a new child directory of this repository\'s vendor directory');
    }
}

function collectClosure() {
    if (!fs.existsSync(sourceRoot)) {
        throw new Error('install the pinned @awesome.me/webawesome dependency before generating the runtime');
    }
    const installedVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
    if (installedVersion !== runtimeVersion) {
        throw new Error(`Web Awesome source version must be ${runtimeVersion}, found ${installedVersion}`);
    }
    const queue = entries.map(file => path.join(sourceRoot, file));
    const files = new Set();
    const missing = [];
    while (queue.length) {
        const file = path.resolve(queue.pop());
        if (files.has(file)) continue;
        files.add(file);
        if (!fs.existsSync(file)) {
            missing.push(path.relative(sourceRoot, file));
            continue;
        }
        if (!/\.(?:js|css)$/i.test(file)) continue;
        const source = fs.readFileSync(file, 'utf8');
        for (const pattern of dependencyPatterns) {
            for (const match of source.matchAll(pattern)) {
                const specifier = match[1].split(/[?#]/, 1)[0];
                const dependency = path.resolve(path.dirname(file), specifier);
                if (!dependency.startsWith(`${sourceRoot}${path.sep}`)) {
                    missing.push(`${path.relative(sourceRoot, file)}: dependency escapes vendor root (${specifier})`);
                    continue;
                }
                queue.push(dependency);
            }
        }
    }
    return { files: [...files].sort(), missing };
}

function digest(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createManifest(files) {
    return {
        package: '@awesome.me/webawesome',
        version: runtimeVersion,
        source: 'node_modules/@awesome.me/webawesome',
        locale: runtimeLocale,
        components,
        files: files.map(file => ({
            path: path.relative(sourceRoot, file).split(path.sep).join('/'),
            sha256: digest(file),
        })),
    };
}

function materialize(files, target, manifest) {
    if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing output directory: ${target}`);
    for (const file of files) {
        const relative = path.relative(sourceRoot, file);
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file, destination);
    }
    fs.writeFileSync(path.join(target, 'vcp-runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

assertSafeOutput(outputRoot);
assertSafeOutput(checkRoot);
if (outputRoot && checkRoot) throw new Error('use either --output or --check, not both');
const closure = collectClosure();
if (closure.missing.length) {
    console.error('Web Awesome runtime closure is incomplete:');
    closure.missing.forEach(item => console.error(`- ${item}`));
    process.exit(1);
}
const bytes = closure.files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
const manifest = createManifest(closure.files);
if (outputRoot) materialize(closure.files, outputRoot, manifest);
if (checkRoot) {
    const manifestFile = path.join(checkRoot, 'vcp-runtime-manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error(`generated manifest is missing: ${manifestFile}`);
    const actual = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(manifest)) {
        throw new Error('generated Web Awesome runtime is stale; regenerate it from the pinned dependency');
    }
}
const action = outputRoot
    ? ` -> ${path.relative(root, outputRoot)}`
    : checkRoot ? `; ${path.relative(root, checkRoot)} is reproducible` : '';
console.log(`Web Awesome runtime closure: ${closure.files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB${action}.`);
