import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick } from './helpers/side-chat-surface-fixture.mjs';

// 关掉流式输出时，回复存盘失败也要和流式一样：亮「保存失败」、拦住关闭，而不是当作已完成（重启后回复就没了）
for (const [label, failure] of [['IPC 的 { error } 形状', { error: 'EACCES: permission denied' }], ['{ success: false }', { success: false, error: 'EACCES: permission denied' }]]) {
    test(`non-streaming reply whose save fails (${label}) is reported as unsaved`, async t => {
        const f = await fixture(t, { stream: false, onSave: messages => messages.some(m => m.role === 'assistant') ? failure : null });
        f.submit('q1');
        await f.untilIdle();
        assert.equal(f.badgeHidden(), false, 'the unsaved badge shows');
        assert.match(f.statusText(), /保存失败/);
        assert.deepEqual(f.handle.getUnsavedStatus(), { hasUnsavedChanges: true, error: 'EACCES: permission denied' });
        assert.deepEqual(await f.handle.requestClose(), { closed: false, reason: 'UNSAVED_CHANGES' });
    });
}

test('a non-streaming reply that saves fine still completes normally', async t => {
    const f = await fixture(t, { stream: false });
    f.submit('q1');
    await f.untilIdle();
    assert.equal(f.badgeHidden(), true);
    assert.deepEqual(f.getHistory().map(m => m.role), ['user', 'assistant']);
});

// 回复落盘之前侧聊一直算忙，不会被休眠回收
test('a streaming side chat stays busy until the reply is on disk', async t => {
    let bridgeRef, args;
    const f = await fixture(t, { stream: true, onSend: async (a, bridge) => { bridgeRef = bridge; args = a; return { streamingStarted: true }; } });
    f.submit('q');
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(f.handle.isBusy(), true, 'streaming');
    bridgeRef.accept({ type: 'data', messageId: args[4], context: args[6], chunk: 'part' });
    bridgeRef.accept({ type: 'end', messageId: args[4], context: args[6], fullResponse: 'part answer' });
    let sawIdleBeforeDisk = false;
    for (let i = 0; i < 100; i++) {
        await tick();
        const onDisk = f.getHistory().some(m => m.role === 'assistant' && /part/.test(m.content || ''));
        if (!f.handle.isBusy() && !onDisk) sawIdleBeforeDisk = true;
        if (!f.handle.isBusy() && onDisk) break;
    }
    assert.equal(sawIdleBeforeDisk, false, 'never idle (sleepable) before the reply is saved');
    assert.equal(f.handle.isBusy(), false);
    assert.ok(f.getHistory().some(m => m.role === 'assistant'), JSON.stringify(f.getHistory()));
});
