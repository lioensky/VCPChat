const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');

function loadRegistry() {
    const path = require.resolve('../modules/ui-system/contribution-registry.js');
    delete require.cache[path];
    return require(path);
}

test('all contribution kinds retract with their lifecycle owner', async () => {
    const api = loadRegistry();
    const owner = new LifecycleScope('plugin:fixture');
    const changes = [];
    const unsubscribe = api.apps.subscribe(change => changes.push(change.action));
    const commandDisposer = api.commands.register({ id: 'fixture.run', title: 'Run', handler: value => value + 1 }, { owner });
    const appDisposer = api.apps.register({ id: 'fixture-app', title: 'Fixture', kind: 'internal', mount() {} }, { owner });
    api.menus.register({ id: 'fixture.menu', title: 'Fixture', location: 'account', command: 'fixture.run' }, { owner });
    api.settings.register({ id: 'fixture.setting', title: 'Fixture', section: 'quick-actions', command: 'fixture.run' }, { owner });
    assert.equal(api.commands.execute('fixture.run', 2), 3);
    assert.equal(appDisposer.contribution.ownerId, 'plugin:fixture');
    assert.equal(commandDisposer(), true);
    assert.equal(commandDisposer(), false);
    await owner.dispose('test');
    assert.equal(api.apps.list().length, 0);
    assert.equal(api.menus.list().length, 0);
    assert.equal(api.settings.list().length, 0);
    assert.deepEqual(changes, ['registered', 'unregistered']);
    unsubscribe();
});

test('contributions reject arbitrary presentation and unsafe action metadata', () => {
    const api = loadRegistry();
    assert.throws(() => api.menus.register({
        id: 'unsafe.menu', title: 'Unsafe', location: 'account', command: 'unsafe.run', html: '<script></script>'
    }), /cannot provide html/);
    assert.throws(() => api.menus.register({ id: 'bad.menu', title: 'Bad', location: 'elsewhere', command: 'bad.run' }), /invalid location/);
    assert.throws(() => api.settings.register({ id: 'bad.setting', title: 'Bad', section: 'x', command: 'ipc:anything' }), /requires title/);
});

test('duplicate and late registrations fail without leaving entries', async () => {
    const api = loadRegistry();
    const first = api.commands.register({ id: 'fixture.unique', handler() {} });
    assert.throws(() => api.commands.register({ id: 'fixture.unique', handler() {} }), /Duplicate/);
    first();
    const owner = new LifecycleScope('inactive-owner');
    await owner.dispose();
    assert.throws(() => api.commands.register({ id: 'fixture.late', handler() {} }, { owner }), /inactive owner/);
    assert.equal(api.commands.get('fixture.late'), null);
});
