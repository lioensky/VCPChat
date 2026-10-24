import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createAppFeatures } = require('../modules/appFeatures.js');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const quiet = { warn() {}, error() {}, log() {} };

function fixture(t, features) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-features-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const modulesDir = path.join(root, 'modules');
    for (const [folder, manifest] of Object.entries(features)) {
        const dir = path.join(modulesDir, folder);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'feature.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
        fs.writeFileSync(path.join(dir, 'index.js'), '');
    }
    fs.mkdirSync(path.join(modulesDir, 'plain'), { recursive: true });
    return { root, modulesDir, appDataRoot: path.join(root, 'AppData') };
}

function loader(paths, extra = {}) {
    return createAppFeatures({ projectRoot: paths.root, appDataRoot: paths.appDataRoot, modulesDir: paths.modulesDir, logger: quiet, ...extra });
}

test('only folders with a valid feature.json are features, and invalid ones are listed but never loaded', (t) => {
    const paths = fixture(t, {
        good: { name: 'Good', main: 'index.js', renderer: 'ui/good.js' },
        escape: { name: 'Escape', main: '../../outside.js' },
        badRenderer: { name: 'BadRenderer', main: 'index.js', renderer: '../outside.js' },
        badScheme: { name: 'BadScheme', main: 'index.js', schemes: [{ scheme: 'Has Space' }] },
        broken: '{ not json',
        dup: { name: 'Good', main: 'index.js' },
    });
    const features = loader(paths);
    const list = features.list();
    assert.deepEqual(list.map((f) => f.folder), ['badRenderer', 'badScheme', 'broken', 'dup', 'escape', 'good']);
    assert.deepEqual(list.filter((f) => !f.error).map((f) => f.name), ['Good']);
    assert.ok(list.filter((f) => f.error).every((f) => f.enabled === false));
    assert.equal(list.find((f) => f.folder === 'good').relativePath, 'modules/good');
});

test('schemes of enabled features are registered in one call, and disabled features register nothing', (t) => {
    const paths = fixture(t, {
        a: { name: 'A', main: 'index.js', schemes: [{ scheme: 'vcp-a', privileges: { standard: true } }] },
        b: { name: 'B', main: 'index.js', schemes: [{ scheme: 'vcp-a' }, { scheme: 'vcp-b' }] },
        c: { name: 'C', main: 'index.js', schemes: [{ scheme: 'vcp-c' }], defaultEnabled: false },
    });
    const calls = [];
    const protocol = { registerSchemesAsPrivileged: (schemes) => calls.push(schemes) };
    assert.deepEqual(loader(paths).registerSchemes(protocol), ['vcp-a', 'vcp-b']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [{ scheme: 'vcp-a', privileges: { standard: true } }, { scheme: 'vcp-b', privileges: {} }]);

    fs.mkdirSync(paths.appDataRoot, { recursive: true });
    fs.writeFileSync(path.join(paths.appDataRoot, 'features.json'), JSON.stringify({ disabled: ['A', 'B'] }));
    const none = [];
    loader(paths).registerSchemes({ registerSchemesAsPrivileged: (schemes) => none.push(schemes) });
    assert.deepEqual(none, []);
});

test('registerAll hands every feature the host, isolates failures, and disposes in reverse order', async (t) => {
    const paths = fixture(t, {
        a: { name: 'A', main: 'index.js', renderer: 'ui/a.js' },
        b: { name: 'B', main: 'index.js', renderer: 'ui/b.js' },
        c: { name: 'C', main: 'index.js' },
        off: { name: 'Off', main: 'index.js', renderer: 'ui/off.js', defaultEnabled: false },
    });
    const required = [];
    const disposed = [];
    const requireModule = (file) => {
        const name = path.basename(path.dirname(file));
        required.push(name);
        if (name === 'b') throw new Error('boom');
        return { register: (host) => ({ host, dispose: () => disposed.push(host.feature.name) }) };
    };
    const features = loader(paths, { requireModule });
    assert.deepEqual(features.rendererEntries(), [], 'nothing is loaded before registerAll');
    assert.deepEqual(features.registerAll({ hooks: 'hooks' }), ['A', 'C']);
    assert.deepEqual(required, ['a', 'b', 'c'], 'a disabled feature is never required');
    assert.deepEqual(features.rendererEntries(), [{ name: 'A', renderer: 'ui/a.js' }], 'only features that loaded get a renderer entry');
    assert.deepEqual(features.list().map((f) => [f.name, f.active]), [['A', true], ['B', false], ['C', true], ['Off', false]]);
    await features.disposeAll();
    assert.deepEqual(disposed, ['C', 'A']);

    const handlers = new Map();
    features.installIpc({ handle: (channel, fn) => handlers.set(channel, fn) });
    assert.deepEqual([...handlers.keys()], ['app-features:renderer-entries']);
});

test('setEnabled writes the state file and reports when a restart is needed', (t) => {
    const paths = fixture(t, { a: { name: 'A', main: 'index.js' } });
    const features = loader(paths, { requireModule: () => ({ register: () => ({}) }) });
    features.registerAll({});
    assert.deepEqual(features.setEnabled('A', false), { name: 'A', enabled: false, restartRequired: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.appDataRoot, 'features.json'), 'utf8')), { disabled: ['A'] });
    assert.equal(features.list()[0].enabled, false);
    assert.equal(features.list()[0].active, true, 'the running copy stays loaded until restart');
    assert.deepEqual(features.setEnabled('A', true), { name: 'A', enabled: true, restartRequired: false });
    assert.throws(() => features.setEnabled('Missing', true), /Missing/);
});

test('the desk pet is a feature whose manifest matches its own scheme and entry points', () => {
    const features = createAppFeatures({ projectRoot, appDataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'app-features-real-')), logger: quiet });
    const pet = features.list().find((f) => f.name === 'DeskPet');
    assert.ok(pet, 'modules/deskpet/feature.json is discovered');
    assert.equal(pet.error, null);
    assert.equal(pet.enabled, true);
    const { SCHEME } = require('../modules/deskpet/petAssets.js');
    assert.deepEqual(pet.manifest.schemes.map((s) => s.scheme), [SCHEME]);
    assert.ok(fs.existsSync(path.join(projectRoot, pet.manifest.renderer)));
    assert.deepEqual(Object.keys(require('../modules/deskpet/index.js')), ['register']);
    const renderer = fs.readFileSync(path.join(projectRoot, pet.manifest.renderer), 'utf8');
    assert.match(renderer, /export function install\(/);
});

test('core code does not reference the desk pet; it only reaches it through the feature loader', () => {
    const owned = ['modules/deskpet/', 'DeskPetmodules/', 'assets/deskpet/', 'scripts/deskpet', 'tests/', 'docs/', 'vendor/', 'VCPDistributedServer/Plugin/'];
    let matches = '';
    try {
        matches = execFileSync('git', ['grep', '--untracked', '-I', '-l', '-i', '-E', 'deskpet|桌宠', '--', '*.js', '*.mjs', '*.cjs', '*.html', '*.css'], { cwd: projectRoot, encoding: 'utf8' });
    } catch (error) {
        if (error.status !== 1) throw error; // 1 = 没有匹配
    }
    const offenders = matches.split('\n').filter(Boolean).filter((file) => !owned.some((prefix) => file.startsWith(prefix)));
    assert.deepEqual(offenders, []);
});
