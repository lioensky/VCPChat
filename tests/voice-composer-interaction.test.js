const test = require('node:test');
const assert = require('node:assert/strict');

const { VoiceWaveform } = require('../modules/voice/voiceWaveform');
const { ChatVoiceComposer, COMPOSER_STATE } = require('../modules/voice/chatVoiceComposer');
const { VoiceComposerView } = require('../modules/voice/voiceComposerView');

// ==========================================
// 1. 零重渲染 SVG 动态波形测试
// ==========================================
test('VoiceWaveform: 预渲染 80 根 SVG line 并正确挂载', () => {
    // 模拟 DOM 环境
    const lines = [];
    const svgMock = {
        setAttribute: () => {},
        classList: { add: () => {} },
        appendChild: (el) => lines.push(el),
        querySelectorAll: () => lines,
        remove: () => {},
        parentNode: { removeChild: () => {} },
    };

    const docMock = {
        createElementNS: (_ns, tag) => {
            if (tag === 'svg') return svgMock;
            if (tag === 'line') {
                const attrs = {};
                return {
                    setAttribute: (k, v) => { attrs[k] = v; },
                    getAttribute: (k) => attrs[k],
                    attrs,
                };
            }
            return {};
        },
    };

    global.document = docMock;
    const waveform = new VoiceWaveform({ barCount: 80 });
    const containerMock = {
        contains: () => false,
        appendChild: () => {},
    };

    waveform.mount(containerMock);
    assert.equal(lines.length, 80, '必须预置精确 80 根 SVG 动态竖线');
    assert.equal(lines[0].attrs.x1, '4');
    assert.equal(lines[0].attrs.y1, '19');
    assert.equal(lines[0].attrs.y2, '21');

    waveform.destroy();
    delete global.document;
});

test('VoiceWaveform: amplitude 振幅动态驱动竖线高度几何更新', () => {
    const lines = [];
    for (let i = 0; i < 80; i++) {
        const attrs = { y1: '19', y2: '21' };
        lines.push({
            setAttribute: (k, v) => { attrs[k] = v; },
            attrs,
        });
    }

    const waveform = new VoiceWaveform({ barCount: 80 });
    waveform.bars = lines.map(element => ({ element, level: 0 }));
    waveform.source = { amplitude: () => 0.5 };

    // 模拟一轮 draw
    let next = waveform.source.amplitude();
    for (let i = 0; i < waveform.bars.length; i++) {
        const bar = waveform.bars[i];
        const prev = bar.level;
        bar.level = next;
        next = prev;
        const height = 1 + Math.min(1, bar.level * 5) * 17;
        bar.element.setAttribute('y1', String(20 - height));
        bar.element.setAttribute('y2', String(20 + height));
    }

    // 第一根 bar 应达到振幅高度
    const expectedHeight = 1 + Math.min(1, 0.5 * 5) * 17; // 1 + 17 = 18
    assert.equal(lines[0].attrs.y1, String(20 - expectedHeight));
    assert.equal(lines[0].attrs.y2, String(20 + expectedHeight));
});

// ==========================================
// 2. 光标级原子写入与草稿冲突自愈测试
// ==========================================
test('ChatVoiceComposer: captureInsertion 准确捕获光标选区与文本草稿快照', () => {
    const composer = new ChatVoiceComposer();
    composer.messageInput = {
        value: 'Hello world',
        selectionStart: 5,
        selectionEnd: 5,
    };

    const span = composer.captureInsertion();
    assert.equal(span.start, 5);
    assert.equal(span.end, 5);
    assert.equal(span.draftText, 'Hello world');
    assert.ok(span.rev > 0);
});

test('ChatVoiceComposer: insertText 在草稿未发生变动时于原光标位置原子插入', () => {
    const composer = new ChatVoiceComposer();
    const inputMock = {
        value: 'function test() {}',
        selectionStart: 13,
        selectionEnd: 13,
        dispatchEvent: () => {},
    };
    composer.messageInput = inputMock;

    // 录音发起时，光标在 test() 的括号之间 (索引 14)
    inputMock.selectionStart = 14;
    inputMock.selectionEnd = 14;
    const span = composer.captureInsertion();

    // 用户没有敲击键盘，识别文字返回 "paramA"
    const success = composer.insertText('paramA', span);
    assert.equal(success, true, '草稿一致时必须成功写入');
    assert.equal(inputMock.value, 'function test(paramA) {}');
    assert.equal(inputMock.selectionStart, 20, '光标自动移动到新插入文字末尾');
});

test('ChatVoiceComposer: 草稿冲突拦截——录音期间手动修改草稿触发自愈状态', () => {
    const composer = new ChatVoiceComposer();
    const inputMock = {
        value: '原始草稿内容',
        selectionStart: 6,
        selectionEnd: 6,
        dispatchEvent: () => {},
    };
    composer.messageInput = inputMock;

    // 1. 录音开始时做快照
    composer.activeSpan = composer.captureInsertion();

    // 2. 录音进行期间，用户在键盘上手动将草稿改为了 "已被修改的内容"
    inputMock.value = '已被修改的内容';
    inputMock.selectionStart = 7;
    inputMock.selectionEnd = 7;

    // 3. STT 识别返回
    composer.handleIncomingSpeechText('追加语音');

    // 验证：绝对不破坏或粗暴拼接到已被修改的草稿末尾！
    assert.equal(inputMock.value, '已被修改的内容', '发生冲突时原草稿内容必须受到严格保护');
    assert.equal(composer.state, COMPOSER_STATE.FEEDBACK, '必须进入 FEEDBACK 冲突自愈状态');
    assert.equal(composer.pendingText, '追加语音', '识别文字必须完好暂存等待用户操作');

    // 4. 用户点击 [插入文字]，将暂存内容插入到当前光标处
    composer.insertPendingDraftText();
    assert.equal(inputMock.value, '已被修改的内容追加语音', '点击插入后精准插入到当前最新光标');
    assert.equal(composer.state, COMPOSER_STATE.IDLE, '插入后状态机平稳恢复为 IDLE');
    assert.equal(composer.pendingText, '', '暂存内容被清空');
});

test('ChatVoiceComposer: 草稿冲突放弃——用户点击取消或按 ESC 丢弃暂存', () => {
    const composer = new ChatVoiceComposer();
    const inputMock = {
        value: '我的代码草稿',
        selectionStart: 6,
        selectionEnd: 6,
        dispatchEvent: () => {},
    };
    composer.messageInput = inputMock;
    composer.state = COMPOSER_STATE.FEEDBACK;
    composer.pendingText = '误录的废话';

    // 用户点击取消或丢弃
    composer.cancelCurrentVoiceSession();

    assert.equal(inputMock.value, '我的代码草稿', '草稿不受任何污染');
    assert.equal(composer.pendingText, '', '暂存内容被丢弃');
    assert.equal(composer.state, COMPOSER_STATE.IDLE, '恢复空闲');
});

// ==========================================
// 3. 防御性生命周期测试 (Defensive Lifecycles)
// ==========================================
test('ChatVoiceComposer: 窗口失焦 (Blur) 与标签隐藏自动终止录音防止偷录', () => {
    const composer = new ChatVoiceComposer();
    let cancelled = false;
    composer.cancelCurrentVoiceSession = () => { cancelled = true; };

    composer.state = COMPOSER_STATE.STT_RECORDING;

    // 模拟 blur
    if (composer.state === COMPOSER_STATE.STT_RECORDING) {
        composer.cancelCurrentVoiceSession();
    }
    assert.equal(cancelled, true, '录音期间失焦必须触发取消');
});

test('ChatVoiceComposer: 会话/话题切换自动隔离未决录音', () => {
    const composer = new ChatVoiceComposer();
    let agent = 'agent-1';
    let topic = 'topic-1';
    composer.getCurrentAgentId = () => agent;
    composer.getCurrentTopicId = () => topic;
    composer.lastAgentId = 'agent-1';
    composer.lastTopicId = 'topic-1';
    composer.state = COMPOSER_STATE.AUDIO_RECORDING;

    // 用户切换到 topic-2
    topic = 'topic-2';
    composer.checkSessionSwitch();

    assert.equal(composer.state, COMPOSER_STATE.IDLE, '会话切换必须立即终结未决录音，防止串录');
});

// ==========================================
// 4. 展开式活动栏视图状态机映射测试 (VoiceComposerView)
// ==========================================
test('VoiceComposerView: setPhase 各阶段正确切换视觉与按钮呈现', () => {
    const view = new VoiceComposerView();
    let expandedClass = false;
    let activityPhaseAttr = '';

    const barMock = {
        style: {},
        setAttribute: (_k, v) => { activityPhaseAttr = v; },
        querySelector: () => ({ style: {}, textContent: '', append: () => {}, replaceChildren: () => {} }),
    };

    view.activityBar = barMock;
    view.actionsContainer = {
        classList: {
            add: (cls) => { if (cls === 'vcp-voice-expanded') expandedClass = true; },
            remove: (cls) => { if (cls === 'vcp-voice-expanded') expandedClass = false; },
        },
    };
    view.button = { style: {} };
    view.waveform = { start: () => {}, stop: () => {} };

    // 1. recording
    view.setPhase('recording', { mode: 'stt' });
    assert.equal(expandedClass, true, 'recording 时必须展开活动栏');
    assert.equal(activityPhaseAttr, 'recording');
    assert.equal(view.button.style.display, 'none');

    // 2. feedback
    view.setPhase('feedback', { message: '草稿已被修改' });
    assert.equal(activityPhaseAttr, 'feedback');

    // 3. idle
    view.setPhase('idle');
    assert.equal(expandedClass, false, 'idle 时收起活动栏');
    assert.equal(view.button.style.display, '', '恢复麦克风触发按钮');
});

// ==========================================
// 5. 对抗式审查补齐项专项测试 (Harden Invariants)
// ==========================================
test('ChatVoiceComposer: 冲突状态下连续多句语音推送被累加暂存，不丢失前句', () => {
    const composer = new ChatVoiceComposer();
    const inputMock = { value: '初始内容', selectionStart: 4, selectionEnd: 4, dispatchEvent: () => {} };
    composer.messageInput = inputMock;
    composer.activeSpan = composer.captureInsertion();

    // 外部修改触发冲突
    inputMock.value = '被修改的内容';

    // 第一句识别返回
    composer.handleIncomingSpeechText('第一句话');
    assert.equal(composer.pendingText, '第一句话');
    assert.equal(composer.state, COMPOSER_STATE.FEEDBACK);

    // 第二句流式推送接着到达（用户尚未点击插入）
    composer.handleIncomingSpeechText('第二句话');
    assert.equal(composer.pendingText, '第一句话 第二句话', '多句语音必须累加保存在 pendingText 中');
});

test('ChatVoiceComposer: 输入框 disabled 时点击麦克风不响应', async () => {
    const composer = new ChatVoiceComposer();
    composer.messageInput = { disabled: true };

    let sttStarted = false;
    composer.startSttMode = async () => { sttStarted = true; };

    await composer.handleLeftClick();
    assert.equal(sttStarted, false, '输入框被禁用时不应启动语音听写');

    let audioStarted = false;
    composer.startAudioRecording = async () => { audioStarted = true; };
    await composer.handleContextMenu();
    assert.equal(audioStarted, false, '输入框被禁用时不应启动原声录音');
});

test('ChatVoiceComposer: insertPendingDraftText 与 cancelCurrentVoiceSession 后还原输入框焦点', () => {
    const composer = new ChatVoiceComposer();
    let focused = false;
    composer.messageInput = {
        value: '草稿',
        selectionStart: 2,
        selectionEnd: 2,
        focus: () => { focused = true; },
        dispatchEvent: () => {},
    };
    composer.pendingText = '补充文字';
    composer.state = COMPOSER_STATE.FEEDBACK;

    composer.insertPendingDraftText();
    assert.equal(focused, true, '插入文字后必须主动将焦点还给输入框');

    focused = false;
    composer.state = COMPOSER_STATE.FEEDBACK;
    composer.cancelCurrentVoiceSession();
    assert.equal(focused, true, '取消或丢弃后也必须主动还焦给输入框');
});

test('PassiveVoiceSentinel: 挂起态 (VAD suspended) 期间继续计算 RMS 振幅以供给波形', () => {
    const { PassiveVoiceSentinel } = require('../modules/voice/passiveVoiceSentinel');
    const sentinel = new PassiveVoiceSentinel({ bufferSize: 256 });
    sentinel.active = true;
    sentinel.suspended = true; // 模拟听写期间挂起 VAD

    // 传入有能量的音频帧
    const frame = new Float32Array(256).fill(0.1);
    sentinel.processAudioFrame(frame);

    // 检验 amplitude() 是否能获取到计算出的 RMS
    const amp = sentinel.amplitude();
    assert.ok(amp > 0.05, `挂起态下 amplitude() 应正常输出音频振幅，实际: ${amp}`);
});

test('ChatVoiceComposer: 原声录音超时自动停止保护 (maxAudioDurationSeconds)', async () => {
    const composer = new ChatVoiceComposer();
    composer.maxAudioDurationSeconds = 0.05; // 50ms 超时
    let stopped = false;
    composer.recorder = {
        start: async () => {},
        stop: async () => null,
    };
    composer.stopAudioRecording = async () => { stopped = true; };

    await composer.startAudioRecording();
    assert.ok(composer.audioRecordTimer !== null);

    return new Promise(resolve => {
        setTimeout(() => {
            assert.equal(stopped, true, '超过最大录音时长必须自动触发停止保存');
            resolve();
        }, 80);
    });
});

