const test = require('node:test');
const assert = require('node:assert/strict');

function api() {
    const path = require.resolve('../modules/ui-system/state-channel.js');
    delete require.cache[path];
    return require(path);
}

test('state channels publish one authoritative revision and unsubscribe explicitly', () => {
    const states = api();
    const channel = states.create('ui-mode', 'classic');
    const seen = [];
    const unsubscribe = channel.subscribe((value, snapshot) => seen.push([value, snapshot.revision]));
    channel.publish('classic');
    channel.publish('next', { source: 'settings' });
    unsubscribe();
    channel.publish('classic', { source: 'preview' });
    assert.deepEqual(seen, [['classic', 0], ['next', 1]]);
    assert.deepEqual(channel.getSnapshot(), { name: 'ui-mode', value: 'classic', revision: 2, source: 'preview' });
    assert.deepEqual(states.diagnostics(), [{ name: 'ui-mode', revision: 2, source: 'preview', subscribers: 0 }]);
});

test('duplicate channels and publishing after disposal are rejected', () => {
    const states = api();
    const channel = states.create('appearance', null);
    assert.throws(() => states.create('appearance', null), /already exists/);
    channel.dispose();
    assert.equal(states.get('appearance'), null);
    assert.throws(() => channel.publish({}), /disposed/);
});

test('a failing immediate subscriber is rolled back transactionally', () => {
    const states = api();
    const channel = states.create('failing-state', 'initial');
    const listener = () => { throw new Error('immediate failure'); };
    assert.throws(() => channel.subscribe(listener), /immediate failure/);
    assert.equal(channel.listeners.size, 0);
    assert.equal(states.diagnostics()[0].subscribers, 0);
    assert.doesNotThrow(() => channel.publish('next'));
});
