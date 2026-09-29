// 主聊天语音交互控制器：编排语音听写与原声录音的状态机及交互
const COMPOSER_STATE = Object.freeze({
	IDLE: "idle",
	STT_READY: "stt_ready",
	STT_RECORDING: "stt_recording",
	AUDIO_RECORDING: "audio_recording",
});

class ChatVoiceComposer {
	constructor() {
		this.messageInput = null;
		this.electronAPI = null;
		this.attachedFiles = null;
		this.updateAttachmentPreview = null;
		this.sendMessageBtn = null;
		this.getCurrentAgentId = null;
		this.getCurrentTopicId = null;
		this.listenerOwner = null;

		this.view = null;
		this.recorder = null;
		this.sentinel = null;

		this.state = COMPOSER_STATE.IDLE;
		this.sessionEpoch = 0;
		this.isTransitioning = false;

		this.sendDirectives = [];
		this.clearDirectives = [];
		this.quietTimeoutMs = 2500;
		this.idleTimeoutMs = 5500;
		this.voiceInputMode = "windows_voice_typing";

		this.disposers = [];
	}

	get isSttActive() {
		return (
			this.state === COMPOSER_STATE.STT_READY ||
			this.state === COMPOSER_STATE.STT_RECORDING
		);
	}

	get isSessionRunning() {
		return this.state === COMPOSER_STATE.STT_RECORDING;
	}

	get isRecordingAudio() {
		return this.state === COMPOSER_STATE.AUDIO_RECORDING;
	}

	get button() {
		return this.view?.button || null;
	}

	set button(btn) {
		if (this.view) {
			this.view.button = btn;
		}
	}

	// 状态迁移：同步更新视图、提示及哨兵生命周期
	transitionTo(nextState) {
		this.state = nextState;
		const isStt = this.isSttActive;
		const isAudio = this.isRecordingAudio;

		this.view?.setSttActive(isStt);
		this.view?.setRecordingAudio(isAudio);
		this.updateButtonTooltip();

		if (!isStt && this.sentinel) {
			try {
				this.sentinel.stop();
			} catch (_) {}
			this.sentinel = null;
		}
	}

	async callIpc(methodName, channel, ...args) {
		if (typeof this.electronAPI?.[methodName] === 'function') {
			return this.electronAPI[methodName](...args);
		}
		if (typeof this.electronAPI?.invoke === 'function') {
			return this.electronAPI.invoke(channel, ...args);
		}
		return null;
	}

	own(disposer) {
		if (typeof disposer !== "function") return;
		this.disposers.push(disposer);
		this.listenerOwner?.own?.(disposer);
	}

	init(refs = {}) {
		this.dispose();

		this.messageInput = refs.messageInput;
		this.electronAPI = refs.electronAPI;
		this.attachedFiles = refs.attachedFiles;
		this.updateAttachmentPreview = refs.updateAttachmentPreview;
		this.sendMessageBtn =
			refs.sendMessageBtn ||
			(typeof document !== "undefined"
				? document.getElementById("sendMessageBtn")
				: null);
		this.getCurrentAgentId = refs.getCurrentAgentId || (() => "default");
		this.getCurrentTopicId = refs.getCurrentTopicId || (() => "default");
		this.listenerOwner = refs.listenerOwner || null;

		const ViewClass =
			typeof window !== "undefined" &&
			(window.VcpVoice?.VoiceComposerView || window.VoiceComposerView);
		if (ViewClass) {
			this.view = new ViewClass();
			this.view.mount({
				sendMessageBtn: this.sendMessageBtn,
				onLeftClick: () => this.handleLeftClick(),
				onContextMenu: () => this.handleContextMenu(),
			});
		}

		const RecorderClass =
			typeof window !== "undefined" &&
			(window.VcpVoice?.AudioRecorder || window.AudioRecorder);
		if (RecorderClass) {
			this.recorder = new RecorderClass();
		}

		this.syncConfigFromSettings();
		this.setupIpcListeners();
	}

	async syncConfigFromSettings() {
		try {
			const settings =
				typeof this.electronAPI?.loadSettings === "function"
					? await this.electronAPI.loadSettings()
					: null;
			if (!settings) return;
			this.updateFromSettingsObject(settings);
		} catch (_) {}
	}

	updateFromSettingsObject(settings) {
		if (!settings) return;
		this.clearDirectives = parseCommaPhrases(settings.mainChatVoiceClearPhrase);
		this.sendDirectives = parseCommaPhrases(settings.mainChatVoiceSendPhrase);

		const idle = Number(settings.mainChatVoiceInitialIdleTimeout);
		if (Number.isFinite(idle) && idle > 0) {
			this.idleTimeoutMs = idle * 1000;
		}

		const quiet = Number(settings.mainChatVoiceQuietTimeout);
		if (Number.isFinite(quiet) && quiet > 0) {
			this.quietTimeoutMs = quiet * 1000;
		}
		if (settings.voiceInputMode) {
			this.voiceInputMode = settings.voiceInputMode;
		}
		this.updateButtonTooltip();
	}

	updateDirectives(options = {}) {
		if (Array.isArray(options.sendKeywords)) {
			this.sendDirectives = options.sendKeywords
				.map((s) => String(s || "").trim())
				.filter(Boolean);
		}
		if (Array.isArray(options.clearKeywords)) {
			this.clearDirectives = options.clearKeywords
				.map((s) => String(s || "").trim())
				.filter(Boolean);
		}
		if (
			typeof options.quietTimeoutMs === "number" &&
			options.quietTimeoutMs > 0
		) {
			this.quietTimeoutMs = options.quietTimeoutMs;
		}
		if (
			typeof options.idleTimeoutMs === "number" &&
			options.idleTimeoutMs > 0
		) {
			this.idleTimeoutMs = options.idleTimeoutMs;
		}
	}

	updateButtonTooltip() {
		this.view?.updateTooltip({
			isRecordingAudio: this.isRecordingAudio,
			isSttActive: this.isSttActive,
			voiceInputMode: this.voiceInputMode,
		});
	}

	setupIpcListeners() {
		const textHandler = (payload) => {
			const rawText = String(payload?.text || "").trim();
			if (!rawText) return;
			this.handleIncomingSpeechText(rawText);
		};

		if (typeof this.electronAPI?.onMainChatVoiceCapturedText === "function") {
			const unsub = this.electronAPI.onMainChatVoiceCapturedText(textHandler);
			this.own(unsub);
		}

		const sessionEndHandler = (payload) => {
			this.handleSessionEnded(payload);
		};

		if (typeof this.electronAPI?.onMainChatVoiceSessionEnded === "function") {
			const unsub =
				this.electronAPI.onMainChatVoiceSessionEnded(sessionEndHandler);
			this.own(unsub);
		}

		if (typeof this.electronAPI?.onSettingsExternalUpdated === "function") {
			const unsub = this.electronAPI.onSettingsExternalUpdated(() => {
				this.syncConfigFromSettings();
			});
			this.own(unsub);
		}

		if (typeof window !== "undefined") {
			const onSettingsChanged = (event) => {
				if (event?.detail?.settings) {
					this.updateFromSettingsObject(event.detail.settings);
				} else {
					this.syncConfigFromSettings();
				}
			};
			window.addEventListener("global-settings-updated", onSettingsChanged);
			this.own(() => {
				window.removeEventListener(
					"global-settings-updated",
					onSettingsChanged,
				);
			});
		}
	}

	handleSessionEnded(payload = {}) {
		if (payload?.canceled || payload?.forceDeactivate) {
			this.deactivateSttMode();
			return;
		}
		if (this.state === COMPOSER_STATE.STT_RECORDING) {
			this.transitionTo(COMPOSER_STATE.STT_READY);
			// 听写完成后留出 80ms 硬件/驱动释放缓冲，平滑过渡回哨兵监听，避免设备争抢
			clearTimeout(this.sentinelResumeTimer);
			this.sentinelResumeTimer = setTimeout(() => {
				this.sentinelResumeTimer = null;
				if (this.state === COMPOSER_STATE.STT_READY) {
					this.ensureSentinelActive().catch((err) => {
						console.warn("[ChatVoiceComposer] 哨兵常驻启动异常:", err);
					});
				}
			}, 80);
		}
	}

	handleIncomingSpeechText(rawText) {
		if (!this.messageInput) return;
		const text = String(rawText || "").trim();
		if (!text) return;

		const matcher = getSpeechDirectiveMatcher();
		const btn =
			this.sendMessageBtn ||
			(typeof document !== "undefined"
				? document.getElementById("sendMessageBtn") ||
					document.querySelector(".chat-send-button")
				: null);
		const isAiStreaming = Boolean(
			btn?.dataset?.mode === "interrupt" ||
				btn?.classList?.contains("interrupt-mode"),
		);

		// AI 流式输出期间不探测发送短语，文字完整保留在输入框中；清空短语不受影响
		const activeSendDirectives = isAiStreaming ? [] : this.sendDirectives;

		const result = matcher?.matchSpeechDirective
			? matcher.matchSpeechDirective(text, {
					clearDirectives: this.clearDirectives,
					sendDirectives: activeSendDirectives,
				})
			: { action: "NORMAL", text };

		if (result.action === "CLEAR") {
			this.messageInput.value = "";
			this.messageInput.dispatchEvent(new Event("input", { bubbles: true }));
			return;
		}

		if (result.text) {
			this.messageInput.value = joinSpeechTexts(this.messageInput.value, result.text);
			this.messageInput.dispatchEvent(new Event("input", { bubbles: true }));
			// 自动将光标定位至末尾并将滚动条滚动到最下方，确保长文本时最新识别的内容始终可见
			try {
				const len = this.messageInput.value.length;
				this.messageInput.setSelectionRange?.(len, len);
				this.messageInput.scrollTop = this.messageInput.scrollHeight;
			} catch (_) {}
		}

		if (result.action === "SEND") {
			if (!this.messageInput.value.trim()) return;
			// 仅在非中断模式且非禁用时触发发送，避免误触停止按钮
			if (btn && !btn.disabled && btn.dataset?.mode !== "interrupt") {
				try {
					btn.click();
				} catch (_) {}
			}
		}
	}

	async handleLeftClick() {
		if (this.isTransitioning) return;
		this.isTransitioning = true;
		try {
			if (this.state === COMPOSER_STATE.AUDIO_RECORDING) {
				await this.stopAudioRecording();
				return;
			}

			if (this.isSttActive) {
				this.stopSttMode();
			} else {
				await this.startSttMode();
			}
		} finally {
			this.isTransitioning = false;
		}
	}

	async handleContextMenu() {
		if (this.isTransitioning) return;
		this.isTransitioning = true;
		try {
			if (this.isSttActive) {
				this.stopSttMode();
			}

			if (this.state === COMPOSER_STATE.AUDIO_RECORDING) {
				await this.stopAudioRecording();
			} else {
				await this.startAudioRecording();
			}
		} finally {
			this.isTransitioning = false;
		}
	}

	async startSttMode() {
		const epoch = ++this.sessionEpoch;
		// 第一次点击为主观主动输入：直接启动听写会话，不开启哨兵也不占用麦克风
		await this.startVoiceSession(epoch);
	}

	async ensureSentinelActive() {
		if (this.state !== COMPOSER_STATE.STT_READY) return;

		const SentinelClass =
			typeof window !== "undefined"
				? window.VcpVoice?.PassiveVoiceSentinel || window.PassiveVoiceSentinel
				: null;
		if (!this.sentinel && SentinelClass) {
			this.sentinel = new SentinelClass({
				thresholdRms: 0.007,
				onTrigger: () => {
					this.onVoiceTriggered();
				},
			});
		}

		if (this.sentinel) {
			try {
				if (!this.sentinel.active) {
					await this.sentinel.start();
				} else if (this.sentinel.suspended) {
					this.sentinel.resume();
				}
			} catch (err) {
				console.warn("[ChatVoiceComposer] 哨兵启动失败:", err);
			}
		}
	}

	async onVoiceTriggered() {
		if (this.state !== COMPOSER_STATE.STT_READY) return;

		// 立即切换为听写中状态
		this.transitionTo(COMPOSER_STATE.STT_RECORDING);

		// 哨兵检测到人声后立刻暂停，释放麦克风，避免抢占输入法的音频输入
		if (this.sentinel) {
			this.sentinel.suspend();
		}

		// 优雅留出 80ms 声卡与驱动交接缓冲时间，避免与语音输入引擎发生麦克风抢占碰撞
		await new Promise((resolve) => setTimeout(resolve, 80));
		if (this.state !== COMPOSER_STATE.STT_RECORDING) return;

		const epoch = ++this.sessionEpoch;
		await this.startVoiceSession(epoch);
	}

	async startVoiceSession(invokingEpoch = this.sessionEpoch) {
		this.transitionTo(COMPOSER_STATE.STT_RECORDING);

		if (this.sentinel) {
			this.sentinel.suspend();
		}

		try {
			const options = {
				quietTimeoutMs: this.quietTimeoutMs,
				idleTimeoutMs: this.idleTimeoutMs,
			};
			const startResult = await this.callIpc(
				'startMainChatVoiceInput',
				'main-chat-voice:start',
				options,
			);

			// 若异步调用期间用户主动退出，强制丢弃并确保清理
			if (invokingEpoch !== this.sessionEpoch || !this.isSttActive) {
				this.stopSttMode();
				return;
			}

			if (startResult && startResult.success === false) {
				const errMsg = String(startResult.error || "");
				this.stopSttMode();
				if (startResult.reason === "subwindow_active") {
					this.view?.showBubble(
						"语音聊天小窗口正在听写中",
						"如需使用主界面的语音按钮请先在小窗口停止听写或将其关闭",
					);
					return;
				}
				const isUnimplemented = /not implemented|unsupported|not found/i.test(
					errMsg,
				);
				this.view?.showBubble(
					isUnimplemented ? "当前环境暂未支持原生听写" : "语音听写启动受阻",
					"右键点击麦克风可录制原声 WAV 附件",
				);
				return;
			}
		} catch (error) {
			console.warn("[ChatVoiceComposer] 唤起语音输入受阻:", error);
			this.stopSttMode();
			const errMsg = String(error?.message || "");
			const isUnimplemented = /not implemented|unsupported|not found/i.test(
				errMsg,
			);
			this.view?.showBubble(
				isUnimplemented ? "当前环境暂未支持原生听写" : "语音听写启动异常",
				"右键点击麦克风可录制原声 WAV 附件",
			);
		}
	}

	// 退出 STT 模式：重置状态并释放哨兵资源
	deactivateSttMode() {
		this.sessionEpoch += 1;
		clearTimeout(this.sentinelResumeTimer);
		this.sentinelResumeTimer = null;
		this.transitionTo(COMPOSER_STATE.IDLE);
		if (this.sentinel) {
			try {
				this.sentinel.stop();
			} catch (_) {}
			this.sentinel = null;
		}
	}

	stopSttMode() {
		this.deactivateSttMode();
		try {
			this.callIpc('cancelMainChatVoiceInput', 'main-chat-voice:cancel').catch(() => {});
		} catch (_) {}
	}

	async startAudioRecording() {
		if (!this.recorder) {
			const RecorderClass =
				typeof window !== "undefined"
					? window.VcpVoice?.AudioRecorder || window.AudioRecorder
					: null;
			if (RecorderClass) this.recorder = new RecorderClass();
		}
		if (!this.recorder) return;

		try {
			await this.recorder.start();
			this.transitionTo(COMPOSER_STATE.AUDIO_RECORDING);
		} catch (error) {
			console.error("[ChatVoiceComposer] 录音启动失败:", error);
			this.transitionTo(COMPOSER_STATE.IDLE);
		}
	}

	async stopAudioRecording() {
		if (this.state !== COMPOSER_STATE.AUDIO_RECORDING || !this.recorder) return;
		this.transitionTo(COMPOSER_STATE.IDLE);

		try {
			const wavBlob = await this.recorder.stop();
			if (wavBlob) {
				await this.attachWavAudioFile(wavBlob);
			}
		} catch (error) {
			console.error("[ChatVoiceComposer] 录音停止或保存异常:", error);
		}
	}

	async attachWavAudioFile(wavBlob) {
		if (!wavBlob) return false;
		const now = new Date();
		const pad = (n) => String(n).padStart(2, "0");
		const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		const fileName = `audio_record_${dateStr}.wav`;

		try {
			const arrayBuffer = await wavBlob.arrayBuffer();
			const wavBytes = new Uint8Array(arrayBuffer);
			const agentId =
				typeof this.getCurrentAgentId === "function"
					? this.getCurrentAgentId()
					: "default";
			const topicId =
				typeof this.getCurrentTopicId === "function"
					? this.getCurrentTopicId()
					: "default";

			const dropResults = await this.callIpc(
				'handleFileDrop',
				'handle-file-drop',
				agentId,
				topicId,
				[
					{
						name: fileName,
						type: 'audio/wav',
						data: wavBytes,
						size: wavBytes.byteLength,
					},
				],
			);

			if (
				Array.isArray(dropResults) &&
				dropResults[0]?.success &&
				dropResults[0]?.attachment
			) {
				const att = dropResults[0].attachment;
				const item = {
					file: { name: att.name, type: att.type, size: att.size },
					localPath: att.internalPath,
					originalName: att.name,
					_fileManagerData: att,
				};

				if (typeof this.attachedFiles?.append === "function") {
					this.attachedFiles.append(item);
				} else if (Array.isArray(this.attachedFiles)) {
					this.attachedFiles.push(item);
				}

				if (typeof this.updateAttachmentPreview === "function") {
					this.updateAttachmentPreview();
				}
				return true;
			}
			return false;
		} catch (error) {
			console.error("[ChatVoiceComposer] 附加录音文件失败:", error);
			return false;
		}
	}

	dispose() {
		this.stopSttMode();
		try {
			this.recorder?.dispose();
		} catch (_) {}
		this.recorder = null;
		this.state = COMPOSER_STATE.IDLE;
		this.disposers
			.splice(0)
			.reverse()
			.forEach((fn) => {
				try {
					fn();
				} catch (_) {}
			});
		if (this.view) {
			this.view.dispose();
			this.view = null;
		}
	}
}

function getSpeechDirectiveMatcher() {
	if (typeof window !== "undefined") {
		if (window.VcpVoice?.SpeechDirectiveMatcher)
			return window.VcpVoice.SpeechDirectiveMatcher;
	}
	if (typeof require === "function") {
		try {
			return require("./speechDirectiveMatcher");
		} catch (_) {}
	}
	return null;
}

function joinSpeechTexts(existingText, incomingText) {
	const prev = String(existingText || "");
	const next = String(incomingText || "").trim();
	if (!prev) return next;
	if (!next) return prev;
	// 若前缀末尾或新文字开头已有空白，不重复补空格
	if (/\s$/.test(prev) || /^\s/.test(next)) {
		return `${prev}${next}`;
	}
	// 仅当前句末尾与新句开头均为半角英文字母或数字时，才补充空格分词；其余中文或标点自然连贯拼接
	const needSpace = /[a-zA-Z0-9]$/.test(prev) && /^[a-zA-Z0-9]/.test(next);
	return needSpace ? `${prev} ${next}` : `${prev}${next}`;
}

function parseCommaPhrases(phraseStr) {
	const matcher = getSpeechDirectiveMatcher();
	if (matcher?.parseCommaPhrases) {
		return matcher.parseCommaPhrases(phraseStr);
	}
	if (!phraseStr || typeof phraseStr !== "string") return [];
	return phraseStr
		.split(/[,，]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const chatVoiceComposer = new ChatVoiceComposer();

if (typeof window !== "undefined") {
	window.VcpVoice = Object.assign(window.VcpVoice || {}, {
		COMPOSER_STATE,
		ChatVoiceComposer,
		chatVoiceComposer,
	});
	window.chatVoiceComposer = chatVoiceComposer;
}

if (typeof module !== "undefined" && module.exports) {
	module.exports = {
		COMPOSER_STATE,
		parseCommaPhrases,
		joinSpeechTexts,
		ChatVoiceComposer,
		chatVoiceComposer,
	};
}
