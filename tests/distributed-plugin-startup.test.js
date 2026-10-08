const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createManager(manifests, modules = {}) {
    const events = [];
    let activeReads = 0;
    let maxReads = 0;
    const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin.js'), 'utf8');
    const context = {
        __dirname: '/distributed',
        process: { env: {}, platform: 'win32' },
        console: { log() {}, warn() {}, error() {} },
        setImmediate(callback) {
            return setImmediate(() => { events.push('yield'); callback(); });
        },
        setTimeout, clearTimeout,
        module: { exports: {} },
        require(id) {
            if (id === 'fs') return { promises: {
                async readdir() {
                    return manifests.map((_, i) => ({ name: String(i), isDirectory: () => true }));
                },
                async readFile(file) {
                    activeReads++;
                    maxReads = Math.max(maxReads, activeReads);
                    await new Promise(resolve => setImmediate(resolve));
                    activeReads--;
                    if (file.endsWith('config.env')) throw new Error('ENOENT');
                    return JSON.stringify(manifests[Number(path.basename(path.dirname(file)))]);
                }
            } };
            if (id === 'path') return path;
            if (id === 'child_process') return { spawn() { throw new Error('Unexpected spawn'); } };
            if (id === 'node-schedule') return {};
            if (id === 'dotenv') return { parse: () => ({}) };
            events.push(`require:${path.basename(id)}`);
            const result = modules[path.basename(id)];
            if (result instanceof Error) throw result;
            return result || {};
        }
    };
    vm.runInNewContext(source, context);
    return { manager: context.module.exports, events, maxReads: () => maxReads };
}

function direct(name) {
    return { name, pluginType: 'hybridservice', entryPoint: { script: `${name}.js` },
        communication: { protocol: 'direct' } };
}

test('discovery limits I/O concurrency, preserves duplicates and never requires services or renderer plugins', async () => {
    const manifests = [direct('a'), direct('a'), {
        name: 'ui', pluginType: 'renderer', frontend: { script: 'ui.js' }
    }, ...Array.from({ length: 7 }, (_, i) => direct(`b${i}`))];
    const { manager, events, maxReads } = createManager(manifests);
    await manager.loadPlugins();
    assert.equal(manager.plugins.size, 8);
    assert.equal(manager.getPlugin('a').basePath, path.join('/distributed', 'Plugin', '0'));
    assert.equal(manager.getPlugin('ui'), undefined);
    assert.equal(manager.serviceModules.size, 0);
    assert.equal(events.some(event => event.startsWith('require:')), false);
    assert.ok(maxReads() > 1 && maxReads() <= 4);
});

test('services yield between require, initialize and routes and tolerate individual failure', async () => {
    const order = [];
    const { manager, events } = createManager([direct('a'), direct('bad'), direct('b')], {
        'a.js': {
            initialize: async options => { assert.equal(options.services.shared, 42); order.push('init:a'); },
            registerRoutes: async () => order.push('routes:a')
        },
        'bad.js': new Error('broken module'),
        'b.js': { initialize: async () => order.push('init:b'), processToolCall: async () => 'ok' }
    });
    await manager.loadPlugins();
    events.length = 0;
    await manager.initializeServices({}, null, '/project', { shared: 42 });
    assert.deepEqual(order, ['init:a', 'routes:a', 'init:b']);
    assert.deepEqual(events.slice(0, 4), ['yield', 'require:a.js', 'yield', 'yield']);
    assert.equal(await manager.processToolCall('b', {}), 'ok');
});

test('stop during initialization prevents routes and later modules, while loaded module is cleaned up', async () => {
    let stopped = false;
    const order = [];
    const { manager, events } = createManager([direct('a'), direct('b')], {
        'a.js': {
            initialize: async () => { order.push('init'); stopped = true; },
            registerRoutes: () => order.push('routes'),
            cleanup: async () => order.push('cleanup')
        }
    });
    await manager.loadPlugins();
    await manager.initializeServices({}, null, '/project', {}, { shouldStop: () => stopped });
    await manager.shutdownAllPlugins();
    assert.deepEqual(order, ['init', 'cleanup']);
    assert.equal(events.includes('require:b.js'), false);
});

test('cancelled discovery does not submit manifests or initialize static plugins', async () => {
    const { manager } = createManager([direct('a')]);
    let staticStarted = false;
    manager.initializeStaticPlugins = async () => { staticStarted = true; };
    await manager.loadPlugins({ shouldStop: () => true });
    assert.equal(manager.plugins.size, 0);
    assert.equal(staticStarted, false);
});