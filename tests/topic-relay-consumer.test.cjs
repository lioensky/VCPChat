'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

for (const mode of ['persist', 'dispose', 'group']) {
    test(`actual consumer tool-return relay lifetime: ${mode}`, async () => {
        const { createMainChatStreamConsumer } = await import('../modules/renderer/mainChatStreamConsumer.js');
        const boundaries = [];
        const effects = [];
        let finishSave;
        const saveGate = new Promise(resolve => { finishSave = resolve; });
        const context = { agentId: 'a', topicId: 't', admissionToken: 'old',
            ...(mode === 'group' ? { isGroupMessage: true, groupId: 'g' } : {}) };
        const consumer = createMainChatStreamConsumer({ messageId: 'live', context }, {
            start() {}, append() {},
            onToolReturnBoundary: value => { boundaries.push(value); },
            projectTerminal: async () => ({ context, content: 'tools returned' }),
            persistTerminal: async () => { effects.push('saving'); await saveGate; effects.push('saved'); return { context }; },
            afterPersist: async () => { effects.push('handover'); },
        });
        await consumer.prepare({ type: 'start', context });
        consumer.consume({ type: 'chunk', text: '[[VCP调用结果信息汇总:tools returned\nVCP调用结果结' });
        assert.equal(boundaries.length, 0);
        consumer.consume({ type: 'chunk', text: '束]]\n' });
        await new Promise(resolve => setImmediate(resolve));
        if (mode === 'group') {
            assert.equal(boundaries.length, 0);
            consumer.dispose();
            return;
        }
        assert.equal(boundaries.length, 1);
        assert.equal(boundaries[0].context.admissionToken, 'old');
        assert.equal(boundaries[0].isActive(), true);
        if (mode === 'dispose') {
            consumer.dispose();
            assert.equal(boundaries[0].isActive(), false);
            return;
        }
        const saving = consumer.persist({
            terminal: { kind: 'cancelled', fullResponse: 'tools returned', context },
        });
        assert.equal(boundaries[0].isActive(), false);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(effects, ['saving'], 'handover must not run while JSON save is pending');
        finishSave();
        await saving;
        assert.deepEqual(effects, ['saving', 'saved', 'handover']);
    });
}