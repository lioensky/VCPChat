const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Hooks = require(path.join(__dirname, '../Musicmodules/music-app-hooks.js'));

test('before：后装的先跑，原方法最后跑，this 和参数原样传下去', () => {
    const calls = [];
    const app = { name: 'app', show(x, y) { calls.push(['base', this.name, x, y]); return 'shown'; } };
    assert.equal(typeof Hooks.before(app, 'show', 'likes', (x) => calls.push(['likes', x])), 'function');
    assert.equal(typeof Hooks.before(app, 'show', 'goto', (x) => calls.push(['goto', x])), 'function');
    assert.equal(app.show(1, 2), 'shown');
    assert.deepEqual(calls, [['goto', 1], ['likes', 1], ['base', 'app', 1, 2]]);
    assert.deepEqual(Hooks.list(app), { show: ['before:likes', 'before:goto'] });
});

test('before 钩子抛错照常往外抛（和手写包装一样）', () => {
    const app = { show: () => 'ok' };
    Hooks.before(app, 'show', 'x', () => { throw new Error('boom'); });
    assert.throws(() => app.show(), /boom/);
});

test('after：拿到返回值和参数；钩子出错不影响返回值', () => {
    const seen = [];
    const app = { update: (state) => `done:${state.v}` };
    Hooks.after(app, 'update', 'a', (result, state) => seen.push([result, state.v]));
    Hooks.after(app, 'update', 'b', () => { throw new Error('ignored'); });
    const warn = console.warn; console.warn = () => {};
    try { assert.equal(app.update({ v: 3 }), 'done:3'); } finally { console.warn = warn; }
    assert.deepEqual(seen, [['done:3', 3]]);
});

test('wrap：可以改参数、等异步结果', async () => {
    const app = { load: async (n) => n * 2 };
    Hooks.wrap(app, 'load', 'x', (base) => async (n) => (await base(n + 1)) + 1);
    assert.equal(await app.load(1), 5);
});

test('原方法不存在时不装，返回 false', () => {
    const app = {};
    assert.equal(Hooks.before(app, 'missing', 'x', () => {}), false);
    assert.equal(Hooks.after(app, 'missing', 'x', () => {}), false);
    assert.equal(Hooks.wrap(app, 'missing', 'x', (b) => b), false);
    assert.equal('missing' in app, false);
    assert.deepEqual(Hooks.list(app), {});
});

test('remove()：还在最外层才拆，拆完恢复原方法；外面被别人包过就不动', () => {
    const base = () => 'base';
    const app = { f: base };
    const removeA = Hooks.wrap(app, 'f', 'a', (b) => () => `a(${b()})`);
    const removeB = Hooks.wrap(app, 'f', 'b', (b) => () => `b(${b()})`);
    assert.equal(app.f(), 'b(a(base))');
    assert.equal(removeA(), false);
    assert.equal(app.f(), 'b(a(base))');
    assert.equal(removeB(), true);
    assert.equal(removeA(), true);
    assert.equal(app.f, base);
    assert.deepEqual(Hooks.list(app), {});
});
