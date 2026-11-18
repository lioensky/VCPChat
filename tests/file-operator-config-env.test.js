const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const pluginPath = path.resolve(__dirname, '../VCPDistributedServer/Plugin/FileOperator/FileOperator.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const pluginRequire = createRequire(pluginPath);
const pluginManager = require('../VCPDistributedServer/Plugin.js');
const projectForgeManifest = require('../VCPDistributedServer/Plugin/ProjectForge/plugin-manifest.json');
const KEYS = ['ALLOWED_DIRECTORIES', 'DEBUG_MODE', 'MAX_FILE_SIZE'];

function isolateEnv(t) {
    const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    t.after(() => {
        for (const key of KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });
}

// Load FileOperator from a temporary plugin directory holding the given env files.
// It shares the real process.env, as direct plugins do inside the Chat main process.
function loadPlugin(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-operator-env-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pluginDir = path.join(root, 'VCPDistributedServer', 'Plugin', 'FileOperator');
    const docs = path.join(root, 'docs');
    const outside = path.join(root, 'outside');
    for (const dir of [pluginDir, docs, outside]) fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
        fs.writeFileSync(path.join(pluginDir, name), text.replaceAll('<docs>', docs));
    }
    const context = {
        module: { exports: {} },
        __dirname: pluginDir,
        process, Buffer, console,
        require: pluginRequire
    };
    vm.runInNewContext(source, context, { filename: pluginPath });
    return { plugin: context.module.exports, docs, outside };
}

test('config.env applies to FileOperator without being written into the shared process.env', async t => {
    isolateEnv(t);
    const { plugin, docs, outside } = loadPlugin(t, {
        'config.env': 'ALLOWED_DIRECTORIES=<docs>\nDEBUG_MODE=false\nMAX_FILE_SIZE=1024\n'
    });
    assert.equal((await plugin.writeFile(path.join(docs, 'a.txt'), 'ok')).success, true);
    assert.match((await plugin.writeFile(path.join(outside, 'a.txt'), 'ok')).error, /Access denied/);
    assert.match((await plugin.writeFile(path.join(docs, 'big.txt'), 'x'.repeat(2048))).error, /Content too large/);

    for (const key of KEYS) assert.equal(process.env[key], undefined, key);
});

test('other plugins do not inherit FileOperator settings through the host config fallback', t => {
    isolateEnv(t);
    loadPlugin(t, { 'config.env': 'ALLOWED_DIRECTORIES=<docs>\n' });
    const config = pluginManager._getPluginConfig({ ...projectForgeManifest, pluginSpecificEnvConfig: {} });
    assert.equal(config.ALLOWED_DIRECTORIES, undefined);
});

test('.env is still the fallback and existing process variables still take precedence', async t => {
    isolateEnv(t);
    process.env.MAX_FILE_SIZE = '4096';
    const { plugin, docs, outside } = loadPlugin(t, {
        '.env': 'ALLOWED_DIRECTORIES=<docs>\nMAX_FILE_SIZE=1024\n'
    });
    assert.equal((await plugin.writeFile(path.join(docs, 'mid.txt'), 'x'.repeat(2048))).success, true);
    assert.match((await plugin.writeFile(path.join(outside, 'a.txt'), 'ok')).error, /Access denied/);

    assert.equal(process.env.MAX_FILE_SIZE, '4096');
    assert.equal(process.env.ALLOWED_DIRECTORIES, undefined);
});
