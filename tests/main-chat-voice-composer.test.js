const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    parseCommaPhrases,
    matchSpeechDirective,
} = require('../modules/voice/speechDirectiveMatcher');
const { encodeWav } = require('../modules/voice/wavAudioEncoder');
const {
    applyHighpassFilter,
    applySoftNoiseGate,
    trimSilenceAndFade,
} = require('../modules/voice/audioRecorder');
const { PassiveVoiceSentinel } = require('../modules/voice/passiveVoiceSentinel');
const { ChatVoiceComposer } = require('../modules/voice/chatVoiceComposer');
const { VoiceComposerView } = require('../modules/voice/voiceComposerView');
const { MainChatVoiceCoordinator } = require('../modules/ipc/mainChatVoiceCoordinator');

// ==========================================
// 1. 指令解析纯函数测试 (SpeechDirectiveMatcher)
// ==========================================
test('SpeechDirectiveMatcher: parseCommaPhrases 切分支持中英文逗号与首尾去空格', () => {
    assert.deepStrictEqual(
        parseCommaPhrases('  清空 ， clean up , 发送出去 ，  '),
        ['清空', 'clean up', '发送出去']
    );
    assert.deepStrictEqual(parseCommaPhrases(''), []);
    assert.deepStrictEqual(parseCommaPhrases(null), []);
    assert.deepStrictEqual(parseCommaPhrases('  ， ,  '), []);
});

test('SpeechDirectiveMatcher: matchSpeechDirective 清空短语优先于发送短语', () => {
    const result = matchSpeechDirective('刚才说的作废了清空重新来发送', {
        clearDirectives: ['清空', '作废'],
        sendDirectives: ['发送'],
    });
    assert.equal(result.action, 'CLEAR');
    assert.equal(result.text, '');
});

test('SpeechDirectiveMatcher: matchSpeechDirective 发送短语精准摘除紧邻标点与空白', () => {
    // 尾部发送词
    const r1 = matchSpeechDirective('请帮我写一首现代诗，发送！', {
        sendDirectives: ['发送'],
    });
    assert.equal(r1.action, 'SEND');
    assert.equal(r1.text, '请帮我写一首现代诗');

    // 中间发送词
    const r2 = matchSpeechDirective('今天天气怎么样发送好的谢谢', {
        sendDirectives: ['发送'],
    });
    assert.equal(r2.action, 'SEND');
    assert.equal(r2.text, '今天天气怎么样 好的谢谢');

    // 仅说了发送词本身
    const r3 = matchSpeechDirective('  发送  ', {
        sendDirectives: ['发送'],
    });
    assert.equal(r3.action, 'SEND');
    assert.equal(r3.text, '');
});

test('SpeechDirectiveMatcher: matchSpeechDirective 未命中指令词返回 NORMAL 动作', () => {
    const result = matchSpeechDirective('今天天气真好', {
        clearDirectives: ['清空'],
        sendDirectives: ['发送'],
    });
    assert.equal(result.action, 'NORMAL');
    assert.equal(result.text, '今天天气真好');
});

// ==========================================
// 2. 交互状态门面测试 (ChatVoiceComposer)
// ==========================================
test('ChatVoiceComposer: 接收识别文本驱动输入框，空输入行不触发发送', () => {
    const composer = new ChatVoiceComposer();
    let sent = false;
    const inputMock = { value: '', dispatchEvent: () => {} };
    const btnMock = {
        disabled: false,
        click: () => { sent = true; },
    };

    composer.messageInput = inputMock;
    composer.sendMessageBtn = btnMock;
    composer.updateDirectives({ sendKeywords: ['发送'] });

    // 输入行为空且只识别到发送词 -> 不发
    composer.handleIncomingSpeechText('发送');
    assert.equal(inputMock.value, '');
    assert.equal(sent, false);

    // 带有正常内容 -> 上屏并触发发送
    composer.handleIncomingSpeechText('明天放假吗发送');
    assert.equal(inputMock.value, '明天放假吗');
    assert.equal(sent, true);
});

test('ChatVoiceComposer: 命中清空指令立即重置输入框内容', () => {
    const composer = new ChatVoiceComposer();
    const inputMock = { value: '原有草稿内容', dispatchEvent: () => {} };

    composer.messageInput = inputMock;
    composer.updateDirectives({ clearKeywords: ['清空'] });

    composer.handleIncomingSpeechText('不对不对清空吧');
    assert.equal(inputMock.value, '');
});

test('ChatVoiceComposer: 状态机枚举一致性与状态属性投射正确', () => {
    const composer = new ChatVoiceComposer();
    assert.equal(composer.state, 'idle');
    assert.equal(composer.isSttActive, false);
    assert.equal(composer.isSessionRunning, false);
    assert.equal(composer.isRecordingAudio, false);

    composer.state = 'stt_ready';
    assert.equal(composer.isSttActive, true);
    assert.equal(composer.isSessionRunning, false);

    composer.state = 'stt_recording';
    assert.equal(composer.isSttActive, true);
    assert.equal(composer.isSessionRunning, true);

    composer.state = 'audio_recording';
    assert.equal(composer.isRecordingAudio, true);
    assert.equal(composer.isSttActive, false);
});

test('ChatVoiceComposer: attachWavAudioFile 纯净委托现有 handleFileDrop 与 attachedFiles 通道', async () => {
    const composer = new ChatVoiceComposer();
    let dropPayload = null;
    let appendedItem = null;
    let previewUpdated = false;

    composer.electronAPI = {
        handleFileDrop: async (agentId, topicId, files) => {
            dropPayload = { agentId, topicId, files };
            return [{
                success: true,
                attachment: {
                    name: files[0].name,
                    type: files[0].type,
                    size: files[0].size,
                    internalPath: '/mock/path/audio.wav',
                },
            }];
        },
    };
    composer.attachedFiles = {
        append: item => { appendedItem = item; },
    };
    composer.updateAttachmentPreview = () => { previewUpdated = true; };
    composer.getCurrentAgentId = () => 'test-agent';
    composer.getCurrentTopicId = () => 'test-topic';

    const dummyBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' });
    const success = await composer.attachWavAudioFile(dummyBlob);

    assert.equal(success, true);
    assert.equal(dropPayload.agentId, 'test-agent');
    assert.equal(dropPayload.topicId, 'test-topic');
    assert.match(dropPayload.files[0].name, /^audio_record_\d+_\d+\.wav$/);
    assert.equal(appendedItem.localPath, '/mock/path/audio.wav');
    assert.equal(previewUpdated, true);
});

// ==========================================
// 3. 音频编码与数字信号处理测试 (DSP & RIFF WAV)
// ==========================================
test('WAV 编码器输出标准 RIFF 头部与合规数据长度', async () => {
    const samples = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
    const wavBlob = encodeWav(samples, 44100, 1);

    assert.equal(wavBlob.type, 'audio/wav');
    const buffer = await wavBlob.arrayBuffer();
    const view = new DataView(buffer);

    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    assert.equal(riff, 'RIFF');
    assert.equal(wave, 'WAVE');

    // 验证音频参数
    assert.equal(view.getUint16(20, true), 1); // PCM 格式
    assert.equal(view.getUint16(22, true), 1); // 1 通道
    assert.equal(view.getUint32(24, true), 44100); // 采样率
    assert.equal(view.getUint16(34, true), 16); // 16 位深
    assert.equal(view.getUint32(40, true), samples.length * 2); // 数据区字节数
});

test('trimSilenceAndFade: 准确切除音频前后静音并保留起止淡入淡出缓冲', () => {
    const sampleRate = 48000;
    const totalSamples = sampleRate * 3; // 3 秒
    const samples = new Float32Array(totalSamples);

    // 构造中间 1 秒的模拟语音（有规律波形）
    const speechStart = sampleRate * 1;
    const speechEnd = sampleRate * 2;
    for (let i = speechStart; i < speechEnd; i++) {
        samples[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    }

    const trimmed = trimSilenceAndFade(samples, sampleRate);
    assert.ok(trimmed.length < totalSamples, '静音采样点应被裁剪缩减');
    assert.ok(trimmed.length > speechEnd - speechStart, '应保留合理起止缓冲');
});

// ==========================================
// 4. 开口声学守卫测试 (PassiveVoiceSentinel)
// ==========================================
test('PassiveVoiceSentinel: 周期性人声信号连续 3 帧快速触发唤醒', () => {
    let triggered = false;
    const sentinel = new PassiveVoiceSentinel({
        sampleRate: 16000,
        bufferSize: 256,
        onTrigger: () => { triggered = true; },
    });
    sentinel.active = true;

    // 构造模拟 200Hz 人声周期波形（16000 采样率下 200Hz 周期为 80 samples，落在 minLag 45 ~ maxLag 140 之间）
    const speechFrame = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        // 使用基波 + 二次谐波形成更真实的人声包络，提升 crestFactor 与周期性
        speechFrame[i] = 0.12 * Math.sin((2 * Math.PI * 200 * i) / 16000)
                       + 0.06 * Math.sin((2 * Math.PI * 400 * i) / 16000);
    }

    sentinel.processAudioFrame(speechFrame);
    sentinel.processAudioFrame(speechFrame);
    sentinel.processAudioFrame(speechFrame);

    assert.equal(triggered, true, '连续 3 帧周期性人声应触发唤醒');
});

test('PassiveVoiceSentinel: 机械敲击瞬态脉冲被冲激能量比拦截', () => {
    let triggered = false;
    const sentinel = new PassiveVoiceSentinel({
        onTrigger: () => { triggered = true; },
    });
    sentinel.active = true;

    // 构造前半段巨大、后半段微弱的敲键盘脉冲
    const clickFrame = new Float32Array(256);
    for (let i = 0; i < 30; i++) clickFrame[i] = 0.8;
    for (let i = 30; i < 256; i++) clickFrame[i] = 0.001;

    for (let f = 0; f < 5; f++) {
        sentinel.processAudioFrame(clickFrame);
    }
    assert.equal(triggered, false, '键盘敲击脉冲不应触发唤醒');
});

// ==========================================
// 5. 架构与契约安全测试
// ==========================================
test('主进程 voiceHandlers 委托并导出合法 IPC 通道，无后门存盘通道', () => {
    const voiceHandlersSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'ipc', 'voiceHandlers.js'), 'utf8');
    const coordinatorSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'ipc', 'mainChatVoiceCoordinator.js'), 'utf8');
    const combinedSource = voiceHandlersSource + '\n' + coordinatorSource;

    assert.match(combinedSource, /main-chat-voice:start/);
    assert.match(combinedSource, /main-chat-voice:stop/);
    assert.match(combinedSource, /main-chat-voice:cancel/);
    assert.match(combinedSource, /main-chat-voice:status/);
    assert.match(combinedSource, /main-chat-voice:captured-text/);
    assert.match(combinedSource, /main-chat-voice:session-ended/);

    // 严禁新增任何私自持久化音频的后门 IPC 通道，录音必须复用 handleFileDrop
    assert.doesNotMatch(combinedSource, /save-recorded-audio-file/);
});

test('Preload 隔离层白名单契约合规', () => {
    const { describeApis } = require('../preloads/core/registry');
    const chatApis = new Set(describeApis().filter(api => api.roles.includes('chat')).map(api => api.name));
    assert.ok(!chatApis.has('saveRecordedAudioFile'));
    assert.ok(chatApis.has('startMainChatVoiceInput'));
    assert.ok(chatApis.has('onMainChatVoiceSessionEnded'));
});

// ==========================================
// 6. 生命周期闭环与销毁死角防线测试
// ==========================================
test('ChatVoiceComposer: dispose() 无论何种状态均强制终结 recorder 资源', () => {
    const composer = new ChatVoiceComposer();
    let recorderDisposed = false;
    composer.recorder = {
        dispose: () => { recorderDisposed = true; },
    };
    composer.state = 'idle';

    composer.dispose();
    assert.equal(recorderDisposed, true, '即使处于非录音状态也应强制释放 recorder 硬件资源');
    assert.equal(composer.recorder, null);
    assert.equal(composer.state, 'idle');
});

test('VoiceComposerView: dispose() 彻底清理内外两层气泡定时器', () => {
    const view = new VoiceComposerView();
    view.bubbleDismissTimer = setTimeout(() => {}, 10000);
    view.bubbleRemoveTimer = setTimeout(() => {}, 10000);

    view.dispose();
    assert.equal(view.bubbleDismissTimer, null, '外层 dismiss 定时器应被清理置空');
    assert.equal(view.bubbleRemoveTimer, null, '内层 remove 定时器应被清理置空');
});

test('MainChatVoiceCoordinator: 目标窗口 webContents 销毁时主动取消会话并释放底层引擎', async () => {
    const { EventEmitter } = require('node:events');
    const mockWebContents = new EventEmitter();
    mockWebContents.id = 999;
    mockWebContents.isDestroyed = () => false;

    const mockMainWindow = {
        webContents: mockWebContents,
        isDestroyed: () => false,
        getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
    };

    let releaseAllCalled = false;
    let stopSessionCalled = false;
    const mockEngine = {
        start: async () => {},
        configureHotkey: async () => {},
        stopSession: async () => { stopSessionCalled = true; },
        releaseAll: async () => { releaseAllCalled = true; },
        restoreFocus: async () => {},
    };

    const mockVoiceCaptureWindow = {
        show: () => {},
        focus: () => {},
        hide: () => {},
        isDestroyed: () => false,
        webContents: {
            focus: () => {},
            send: () => {},
        },
    };

    const coordinator = new MainChatVoiceCoordinator({
        getMainWindow: () => mockMainWindow,
        getVoiceCaptureWindow: () => mockVoiceCaptureWindow,
        ensureVoiceCaptureWindowReady: async () => {},
        positionVoiceCaptureWindow: () => {},
        getVoiceInputEngine: () => mockEngine,
        getConfiguredShortcut: () => 'F7',
        getSettingsManager: () => ({ readSettings: async () => ({}) }),
    });

    const startRes = await coordinator.startSession();
    assert.equal(startRes.success, true);
    assert.ok(coordinator.getActiveSession() !== null);

    // 模拟用户直接刷新页面或关闭主窗口，webContents 触发 destroyed 事件
    mockWebContents.emit('destroyed');

    // 等待异步撤销流程结算完成
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(coordinator.getActiveSession(), null, '窗口销毁后会话应被自动置空');
    assert.equal(releaseAllCalled, true, '底层引擎 releaseAll 应被主动调用释放全局按键');
    assert.equal(stopSessionCalled, true, '底层引擎 stopSession 应被调用');
});

test('ChatVoiceComposer: AI 流式输出中不探测发送短语，文本原样上屏且不误触停止按钮', () => {
    const composer = new ChatVoiceComposer();
    let clicked = false;
    const inputMock = { value: '', dispatchEvent: () => {} };
    const btnMock = {
        disabled: false,
        dataset: { mode: 'interrupt' }, // 处于 AI 流式输出 / 中断状态
        classList: { contains: (cls) => cls === 'interrupt-mode' },
        click: () => { clicked = true; },
    };

    composer.messageInput = inputMock;
    composer.sendMessageBtn = btnMock;
    composer.updateDirectives({ sendKeywords: ['发送'] });

    // 说了带发送词的话，AI 正在流式输出中
    composer.handleIncomingSpeechText('请问明天天气如何发送');

    // AI 流式输出期间，发送词不被剥离，作为普通文本保留
    assert.equal(inputMock.value, '请问明天天气如何发送');
    // 绝不触发发送，更绝不能误点击当前处于 interrupt 模式的按钮
    assert.equal(clicked, false);
});

test('ChatVoiceComposer: AI 流式输出中清空短语仍可正常重置输入框', () => {
    const composer = new ChatVoiceComposer();
    const inputMock = { value: '上一句未完成的草稿', dispatchEvent: () => {} };
    const btnMock = {
        disabled: false,
        dataset: { mode: 'interrupt' },
        classList: { contains: (cls) => cls === 'interrupt-mode' },
        click: () => {},
    };

    composer.messageInput = inputMock;
    composer.sendMessageBtn = btnMock;
    composer.updateDirectives({ clearKeywords: ['清空'] });

    // AI 流式输出期间，清空指令不受影响
    composer.handleIncomingSpeechText('不对清空');
    assert.equal(inputMock.value, '');
});

test('MainChatVoiceCoordinator: 子窗口正在使用快捷键听写时，主聊天自律避让并返回 subwindow_active', async () => {
    let subwindowActive = true;
    const mockMainWindow = {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, id: 1, once: () => {}, removeListener: () => {}, send: () => {} },
    };

    const coordinator = new MainChatVoiceCoordinator({
        getMainWindow: () => mockMainWindow,
        getVoiceCaptureWindow: () => ({
            isDestroyed: () => false,
            show: () => {},
            focus: () => {},
            hide: () => {},
            webContents: { focus: () => {}, send: () => {} },
        }),
        ensureVoiceCaptureWindowReady: async () => {},
        positionVoiceCaptureWindow: () => {},
        getVoiceInputEngine: () => ({
            start: async () => {},
            configureHotkey: async () => {},
            stopSession: async () => {},
            releaseAll: async () => {},
            restoreFocus: async () => {},
        }),
        getConfiguredShortcut: () => 'F7',
        getSettingsManager: () => ({ readSettings: async () => ({}) }),
        isSubwindowHotkeyActive: () => subwindowActive,
    });

    const res = await coordinator.startSession();
    assert.equal(res.success, false);
    assert.equal(res.reason, 'subwindow_active');
    assert.equal(coordinator.getActiveSession(), null);

    // 当子窗口停止听写后
    subwindowActive = false;
    const res2 = await coordinator.startSession();
    assert.equal(res2.success, true);
    assert.ok(coordinator.getActiveSession() !== null);
    await coordinator.cancelSession();
});

test('ChatVoiceComposer: 收到 session-ended 取消/强制停用通知时彻底关闭 STT 模式', () => {
    const composer = new ChatVoiceComposer();
    composer.state = 'stt_recording';
    let sentinelStopped = false;
    composer.sentinel = {
        stop: () => { sentinelStopped = true; },
        resume: () => {},
    };

    // 收到带有 canceled / forceDeactivate 的会话结束通知
    composer.handleSessionEnded({ canceled: true, forceDeactivate: true });

    // 彻底重置为 idle，哨兵被彻底释放
    assert.equal(composer.state, 'idle');
    assert.equal(composer.sentinel, null);
    assert.equal(sentinelStopped, true);
});

test('voiceHandlers: 语音聊天窗口销毁时自动取消捕获会话并隐藏 voiceCaptureWindow', () => {
    const handlersSrc = fs.readFileSync(path.join(__dirname, '../modules/ipc/voiceHandlers.js'), 'utf8');
    assert.match(handlersSrc, /target\.webContents\.once\('destroyed'/, '必须监听目标窗口销毁');
    assert.match(handlersSrc, /cancelVoiceCaptureFromHotkey/, '必须提供快捷键会话取消退出机制');
});

test('AudioRecorder DSP: 高通滤波器滤除次低频轰鸣，软噪声门在停顿期有效压制底噪', () => {
    const sampleRate = 48000;
    // 构造 30Hz 次低频干扰信号
    const lowFreq = new Float32Array(sampleRate * 0.1);
    for (let i = 0; i < lowFreq.length; i++) {
        lowFreq[i] = 0.5 * Math.sin((2 * Math.PI * 30 * i) / sampleRate);
    }
    const filtered = applyHighpassFilter(lowFreq, sampleRate, 80);
    // 30Hz 信号经过 80Hz 二阶高通滤波器衰减显著（幅度衰减应 > 70%）
    let maxFiltered = 0;
    for (let i = Math.round(lowFreq.length * 0.5); i < lowFreq.length; i++) {
        if (Math.abs(filtered[i]) > maxFiltered) maxFiltered = Math.abs(filtered[i]);
    }
    assert.ok(maxFiltered < 0.18, `30Hz 次低频应被显著压制，当前最大幅值: ${maxFiltered}`);

    // 验证停顿期软噪声门控：纯微弱白噪在噪声门处理后增益平滑衰减
    const pauseNoise = new Float32Array(sampleRate * 0.5);
    for (let i = 0; i < pauseNoise.length; i++) {
        pauseNoise[i] = (Math.random() - 0.5) * 0.004; // 底噪
    }
    applySoftNoiseGate(pauseNoise, sampleRate, 0.003, 0.15);
    // 检查末端稳态幅值是否已被压低
    let maxPauseAfter = 0;
    for (let i = Math.round(pauseNoise.length * 0.7); i < pauseNoise.length; i++) {
        if (Math.abs(pauseNoise[i]) > maxPauseAfter) maxPauseAfter = Math.abs(pauseNoise[i]);
    }
    assert.ok(maxPauseAfter < 0.002, `停顿区白噪应被衰减，当前最大幅值: ${maxPauseAfter}`);
});

test('ChatVoiceComposer: 处于 STT_RECORDING 状态时左键点击具有最高权限，立即取消会话并彻底销毁全部状态', async () => {
    const composer = new ChatVoiceComposer();
    composer.state = 'stt_recording';
    let cancelCalled = false;
    let sentinelStopped = false;
    composer.sentinel = {
        stop: () => { sentinelStopped = true; },
        resume: () => {},
    };
    composer.electronAPI = {
        cancelMainChatVoiceInput: async () => {
            cancelCalled = true;
            return { success: true };
        },
    };

    await composer.handleLeftClick();

    assert.equal(cancelCalled, true, '必须调用 cancelMainChatVoiceInput 强制取消会话');
    assert.equal(composer.state, 'idle', '状态必须立即重置为 idle');
    assert.equal(composer.sentinel, null, '哨兵必须被销毁释放');
    assert.equal(sentinelStopped, true, '哨兵必须执行 stop');
});

test('joinSpeechTexts: 智能拼接中文自然连贯，英文数字之间保留分词空格', () => {
    const { joinSpeechTexts } = require('../modules/voice/chatVoiceComposer');
    assert.equal(joinSpeechTexts('今天天气真好', '我们去散步'), '今天天气真好我们去散步');
    assert.equal(joinSpeechTexts('今天天气真好，', '我们去散步'), '今天天气真好，我们去散步');
    assert.equal(joinSpeechTexts('Hello', 'World'), 'Hello World');
    assert.equal(joinSpeechTexts('Model', 'V2'), 'Model V2');
    assert.equal(joinSpeechTexts('这是', 'GPT4'), '这是GPT4');
    assert.equal(joinSpeechTexts('GPT4', '很强'), 'GPT4很强');
});
