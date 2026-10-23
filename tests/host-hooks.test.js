const test = require('node:test');
const assert = require('node:assert/strict');
const { HOOKS, createHostHooks } = require('../modules/hostHooks');

const quiet = () => {
    const warnings = [];
    return { warnings, hooks: createHostHooks({ logger: { warn: (...args) => warnings.push(args.join(' ')) } }) };
};

test('with nothing registered every call is a no-op', async () => {
    const { hooks } = quiet();
    const messages = [{ role: 'user', content: 'hi' }];
    assert.equal(hooks.pipe('chat:request-messages', messages, {}), messages);
    assert.equal(hooks.every('tts:speak', {}, {}), true);
    assert.deepEqual(hooks.collect('tray:menu-items'), []);
    assert.equal(hooks.emit('chat:request-start', 'm1', {}), undefined);
    await hooks.emitAsync('agent:removed', 'Nova');
});

test('unknown hook names and the wrong call style throw', () => {
    const { hooks } = quiet();
    assert.throws(() => hooks.on('chat:typo', () => {}), /Unknown host hook/);
    assert.throws(() => hooks.emit('tts:speak'), /called with every/);
    assert.throws(() => hooks.on('tools:result', 'nope'), /needs a function/);
    for (const kind of Object.values(HOOKS)) assert.ok(['emit', 'emitAsync', 'pipe', 'every', 'collect'].includes(kind));
});

test('pipe chains handlers; undefined keeps the value', () => {
    const { hooks } = quiet();
    hooks.on('chat:request-messages', (messages, context) => [...messages, context.agentId]);
    hooks.on('chat:request-messages', () => undefined);
    hooks.on('chat:request-messages', (messages) => [...messages, 'last']);
    assert.deepEqual(hooks.pipe('chat:request-messages', ['first'], { agentId: 'Nova' }), ['first', 'Nova', 'last']);
});

test('every is false when any handler says false; collect concatenates arrays', () => {
    const { hooks } = quiet();
    hooks.on('tts:speak', () => true);
    const off = hooks.on('tts:speak', (_sender, options) => options.msgId !== 'claimed');
    assert.equal(hooks.every('tts:speak', null, { msgId: 'claimed' }), false);
    assert.equal(hooks.every('tts:speak', null, { msgId: 'free' }), true);
    off();
    assert.equal(hooks.every('tts:speak', null, { msgId: 'claimed' }), true);

    hooks.on('tray:menu-items', () => [{ label: 'a' }]);
    hooks.on('tray:menu-items', () => null);
    hooks.on('tray:menu-items', () => [{ label: 'b' }, { label: 'c' }]);
    assert.deepEqual(hooks.collect('tray:menu-items').map((item) => item.label), ['a', 'b', 'c']);
});

test('a failing handler is logged and skipped, the others still run', async () => {
    const { hooks, warnings } = quiet();
    const seen = [];
    hooks.on('chat:stream-payload', () => { throw new Error('boom'); });
    hooks.on('chat:stream-payload', (payload) => seen.push(payload.type));
    hooks.emit('chat:stream-payload', { type: 'end' });
    assert.deepEqual(seen, ['end']);

    hooks.on('chat:request-messages', () => { throw new Error('bad pipe'); });
    assert.deepEqual(hooks.pipe('chat:request-messages', ['kept'], {}), ['kept']);
    hooks.on('tts:speak', () => { throw new Error('bad gate'); });
    assert.equal(hooks.every('tts:speak', null, {}), true);
    hooks.on('tray:menu-items', () => { throw new Error('bad menu'); });
    assert.deepEqual(hooks.collect('tray:menu-items'), []);

    const order = [];
    hooks.on('agent:removed', async () => { throw new Error('async boom'); });
    hooks.on('agent:removed', async (agentId) => { await Promise.resolve(); order.push(agentId); });
    await hooks.emitAsync('agent:removed', 'Nova');
    assert.deepEqual(order, ['Nova']);
    assert.equal(warnings.length, 5);
});

test('a handler that unregisters itself mid-call does not skip the next one', () => {
    const { hooks } = quiet();
    const seen = [];
    const off = hooks.on('tray:refresh', () => { seen.push('first'); off(); });
    hooks.on('tray:refresh', () => seen.push('second'));
    hooks.emit('tray:refresh', false);
    hooks.emit('tray:refresh', false);
    assert.deepEqual(seen, ['first', 'second', 'second']);
});
