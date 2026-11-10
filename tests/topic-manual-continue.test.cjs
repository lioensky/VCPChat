const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(mode) {
    const source = fs.readFileSync('modules/event-listeners.js', 'utf8');
    const start = source.indexOf("    async function handleContinueWriting(additionalPrompt = '')");
    const end = source.indexOf('    // 导出到window对象供Flowlock使用', start);
    assert.ok(start > 0 && end > start);
    const calls = [];
    const history = [{ id: 'original', role: 'user', content: 'question' }];
    let selected = { id: 'agent-1', type: 'agent', name: 'Kerr', config: { streamOutput: mode === 'stream-failed' } };
    let topic = 'topic-1';
    const api = {
        topicAdmissionAcquire: async () => { calls.push('acquire'); return { success: true }; },
        topicAdmissionRelease: async (scope, token) => {
            calls.push('release');
            assert.equal(scope.topicId, 'topic-1');
            assert.match(token, /^manual_/);
            return { success: true };
        },
        topicAdmissionUncertain: async (scope, token) => {
            calls.push('uncertain');
            assert.equal(scope.itemId, 'agent-1');
            assert.match(token, /^manual_/);
            return { success: true };
        },
        sendToVCP: async () => {
            calls.push('send');
            history.push({ id: 'plugin', role: 'assistant', content: 'concurrent letter' });
            if (mode === 'switch') {
                selected = { id: 'other', type: 'agent' };
                topic = 'other-topic';
            }
            if (mode === 'send-failed') throw new Error('send failed');
            if (mode === 'stream-failed') return { streamError: true, errorDetail: 'stream failed' };
            if (mode === 'response-error') return { response: { error: 'remote failed' } };
            return {
                response: { choices: [{ message: { content: 'terminal' } }] },
                context: { agentId: 'malicious-other', topicId: 'wrong-topic' },
            };
        },
        topicAdmissionPersistAssistant: async (scope, message) => {
            calls.push('persist');
            assert.equal(scope.itemId, 'agent-1');
            assert.equal(scope.topicId, 'topic-1');
            assert.equal(message.admissionTerminal, true);
            assert.match(message.admissionToken, /^manual_/);
            assert.match(message.id, /^regen_/);
            assert.equal(message.content, 'terminal');
            if (mode === 'save-threw') throw new Error('disk failed');
            if (mode === 'save-rejected') return { success: false, error: 'disk failed' };
            const latest = history.filter(value => !value.isThinking);
            latest.push(message);
            return { success: true, history: latest };
        },
        getChatHistory: async () => assert.fail('atomic path must not read/replace an old snapshot'),
    };
    const sandbox = {
        console: { log() {}, error() {} },
        chatAPI: api,
        refs: {
            currentSelectedItem: { get: () => selected },
            currentTopicId: { get: () => topic },
            globalSettings: { get: () => ({ vcpServerUrl: 'https://fixture.invalid', vcpApiKey: 'fixture' }) },
            currentChatHistory: { get: () => history },
        },
        chatManager: {
            isContextCompacting: () => false,
            attemptTopicSummarizationIfNeeded: async () => {
                calls.push('summary');
                if (mode === 'ui-failed') throw new Error('UI failed');
            },
        },
        uiHelperFunctions: { showToastNotification() {}, openModal() {} },
        messageRenderer: { renderMessage() {}, removeMessageById() {} },
        notifySendStateChanged() {},
        assembleRequestMessages: async () => {
            if (mode === 'prepare-failed') throw new Error('prepare failed');
            return { messagesForVCP: [] };
        },
        historyMutationAuthority: { replace: async () => assert.fail('no snapshot cleanup or terminal writes') },
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(start, end) + '\nthis.run = handleContinueWriting;', sandbox);
    return { run: sandbox.run, calls, history };
}

for (const mode of ['saved', 'switch', 'ui-failed']) {
    test(`manual continuation atomic terminal: ${mode}`, async () => {
        const { run, calls, history } = fixture(mode);
        await run();
        assert.deepEqual(calls, mode === 'switch'
            ? ['acquire', 'send', 'persist', 'release']
            : ['acquire', 'send', 'persist', 'summary', 'release']);
        assert.ok(history.some(value => value.id === 'plugin'));
        if (mode !== 'switch') {
            assert.equal(history.some(value => value.isThinking), false);
            assert.ok(history.some(value => value.content === 'terminal'));
        }
    });
}

for (const mode of ['save-threw', 'save-rejected', 'send-failed', 'response-error', 'stream-failed']) {
    test(`manual continuation retains dispatched lease: ${mode}`, async () => {
        const { run, calls, history } = fixture(mode);
        await assert.rejects(run(), /failed/);
        assert.equal(calls.at(-1), 'uncertain');
        assert.equal(calls.includes('release'), false);
        assert.ok(history.some(value => value.id === 'plugin'));
        assert.equal(history.some(value => value.isThinking), false);
    });
}

test('manual continuation releases preparation failure without uncertain or history cleanup', async () => {
    const { run, calls, history } = fixture('prepare-failed');
    await assert.rejects(run(), /prepare failed/);
    assert.deepEqual(calls, ['acquire', 'release']);
    assert.deepEqual(history.map(value => value.id), ['original']);
});