'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../ProjectForgemodules/projectforge.js'), 'utf8');
function fixture() {
    let resolve, reject;
    const calls = [], appends = [], errors = [];
    const state = { currentId: 'p1', detail: { timeline: [{ id: 105 }], timelineHasMore: true, timelineBeforeBatch: 105 } };
    const context = {
        state, Set, api: { projectForgeGetTimeline(...args) { calls.push(args); return new Promise((r, j) => { resolve = r; reject = j; }); } },
        call: p => p, toast: message => errors.push(message),
        $: () => ({ querySelector: () => ({ insertAdjacentHTML: (position, html) => appends.push({ position, html }) }) }),
        timelineCards: rows => rows.map(b => `b${b.id}`).join(','),
    };
    vm.runInNewContext(source.slice(source.indexOf('function timelineMoreButton()'), source.indexOf('function timelineCards(')), context);
    const button = { disabled: false, textContent: '', outerHTML: '' };
    return { context, state, calls, appends, errors, button, run: () => context.loadMoreTimeline(button), finish: page => resolve(page), fail: () => reject(new Error('断连')) };
}
test('渐进追加保留已有DOM、去重与防重复点击；最后一页显示全部', async () => {
    const f = fixture();
    const pending = f.run();
    await f.run();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], 'p1');
    assert.equal(f.calls[0][1].beforeBatch, 105);
    f.finish({ timeline: [{ id: 105 }, { id: 104 }], timelineHasMore: false, timelineBeforeBatch: 104 });
    await pending;
    assert.equal(f.appends[0].position, 'beforeend');
    assert.equal(f.appends[0].html, 'b104');
    assert.deepEqual(f.state.detail.timeline.map(b => b.id), [105, 104]);
    assert.match(f.button.outerHTML, /已显示全部/);
});
test('切换工程或刷新详情后丢弃旧页；请求失败可重试', async () => {
    for (const mode of ['switch', 'refresh', 'failure']) {
        const f = fixture();
        const pending = f.run();
        if (mode === 'switch') f.state.currentId = 'p2';
        if (mode === 'refresh') f.state.detail = { ...f.state.detail };
        if (mode === 'failure') f.fail();
        else f.finish({ timeline: [{ id: 104 }], timelineHasMore: false, timelineBeforeBatch: 104 });
        await pending;
        assert.equal(f.appends.length, 0);
        assert.equal(f.button.disabled, false);
        assert.equal(f.errors.length, mode === 'failure' ? 1 : 0);
    }
});