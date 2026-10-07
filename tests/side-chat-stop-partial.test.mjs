// 侧聊点停止：已经流出来的部分要留下并标为已停止（和主聊天一致），停止之后才到的内容不再写进来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick } from './helpers/side-chat-surface-fixture.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const untilNotBusy = async (form, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (!form.hasAttribute('aria-busy')) return true; await wait(20); }
    return false;
};
const assistant = f => f.getHistory().filter(message => message.role === 'assistant');
const open = async (t, options) => {
    const f = await fixture(t, options);
    f.submit('问题');
    for (let i = 0; i < 30; i++) await tick();
    return f;
};

test('上游拒绝中止：保留已流出的部分并标为已停止，之后到的内容丢掉', async t => {
    let send;
    const f = await open(t, {
        stream: true,
        interrupt: { async interrupt() { return { success: false, error: 'rejected' }; } },
        onSend: async (args, bridge) => {
            send = { args, bridge };
            bridge.accept({ type: 'data', messageId: args[4], context: args[6], chunk: '已经流出的半截' });
            return { streamingStarted: true };
        },
    });
    f.stop();
    assert.equal(await untilNotBusy(f.form, 2000), true);
    send.bridge.accept({ type: 'data', messageId: send.args[4], context: send.args[6], chunk: '停止后才到' });
    send.bridge.accept({ type: 'end', messageId: send.args[4], context: send.args[6] });
    for (let i = 0; i < 30; i++) await tick();
    const [message] = assistant(f);
    assert.equal(message?.content, '已经流出的半截');
    assert.equal(message?.finishReason, 'cancelled');
    assert.match(f.doc.body.textContent, /已经流出的半截/);
    assert.doesNotMatch(f.doc.body.textContent, /停止后才到/);
});

test('中止请求很慢、期间回答已经自己收尾：停止不能把这条回答删掉', async t => {
    let send;
    let answerInterrupt;
    const f = await open(t, {
        stream: true,
        // 和模拟服务一样：中止接口回得比原回答还晚，最后还是失败
        interrupt: { interrupt: () => new Promise(resolve => { answerInterrupt = resolve; }) },
        onSend: async (args, bridge) => {
            send = { args, bridge };
            bridge.accept({ type: 'data', messageId: args[4], context: args[6], chunk: '完整的回答' });
            return { streamingStarted: true };
        },
    });
    f.stop();
    for (let i = 0; i < 10; i++) await tick();
    send.bridge.accept({ type: 'end', messageId: send.args[4], context: send.args[6] });
    for (let i = 0; i < 30; i++) await tick();
    answerInterrupt({ success: false, error: 'Unexpected token d in JSON' });
    assert.equal(await untilNotBusy(f.form, 2000), true);
    for (let i = 0; i < 30; i++) await tick();
    const [message] = assistant(f);
    assert.equal(message?.content, '完整的回答');
    assert.equal(assistant(f).length, 1);
    assert.match(f.doc.body.textContent, /完整的回答/);
});

test('上游接受中止却一直不收尾：几秒后本地停止，保留已流出的部分', async t => {
    const f = await open(t, {
        stream: true,
        interrupt: { async interrupt() { return { success: true }; } },
        onSend: async (args, bridge) => {
            bridge.accept({ type: 'data', messageId: args[4], context: args[6], chunk: '已经流出的半截' });
            return { streamingStarted: true };
        },
    });
    f.stop();
    assert.equal(await untilNotBusy(f.form, 6000), true, '侧聊停在忙碌状态');
    for (let i = 0; i < 30; i++) await tick();
    const [message] = assistant(f);
    assert.equal(message?.content, '已经流出的半截');
    assert.equal(message?.finishReason, 'cancelled');
});
