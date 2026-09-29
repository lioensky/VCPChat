// 主聊天语音交互控制器：编排语音听写与原声录音的状态机及交互
// 融合光标级写入、草稿冲突自愈、活动栏展开与防御性生命周期
const COMPOSER_STATE = Object.freeze({
	IDLE: "idle",
	STT_READY: "stt_ready",
	STT_RECORDING: "stt_recording",
	AUDIO_RECORDING: "audio_recording",
	REQUESTING: "requesting",
	TRANSCRIBING: "transcribing",
	FEEDBACK: "feedback",
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

		this.draftRev = 0;
		this.activeSpan = null;
		this.pendingText = "";
		this.lastAgentId = null;
		this.lastTopicId = null;

		this.maxAudioDurationSeconds = 180;
		this.audioRecordTimer = null;
		this.transcribingTimeout = null;

		this.disposers = [];
	}

	get isSttActive() {
		return (
			this.state === COMPOSER_STATE.STT_READY ||
			this.state === COMPOSER_STATE.STT_RECORDING ||
			this.state === COMPOSER_STATE.REQUESTING ||
			this.state === COMPOSER_STATE.TRANSCRIBING ||
			this.state === COMPOSER_STATE.FEEDBACK
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

	// 状态迁移：同步更新视图、活动栏、提示及哨兵生命周期
	transitionTo(nextState, payload = {}) {
		this.state = nextState;
		const isStt = this.isSttActive;
		const isAudio = this.isRecordingAudio;

		this.view?.setSttActive(isStt);
		this.view?.setRecordingAudio(isAudio);
		this.updateButtonTooltip();

		let phase = 'idle';
		let mode = 'stt';
		let source = null;

		if (nextState === COMPOSER_STATE.AUDIO_RECORDING) {
			phase = 'recording';
			mode = 'audio-record';
			source = this.recorder;
		} else if (nextState === COMPOSER_STATE.STT_RECORDING || nextState === COMPOSER_STATE.STT_READY) {
			phase = 'recording';
			mode = 'stt';
			source = this.sentinel;
		} else if (nextState === COMPOSER_STATE.REQUESTING) {
			phase = 'requesting';
			mode = payload.mode || (this.isRecordingAudio ? 'audio-record' : 'stt');
		} else if (nextState === COMPOSER_STATE.TRANSCRIBING) {
			phase = 'transcribing';
			mode = payload.mode || (this.isRecordingAudio ? 'audio-record' : 'stt');
		} else if (nextState === COMPOSER_STATE.FEEDBACK) {
			phase = 'feedback';
			mode = payload.mode || (this.isRecordingAudio ? 'audio-record' : 'stt');
		} else {
			phase = 'idle';
		}

		this.view?.setPhase(phase, {
			mode,
			source: payload.source || source,
			message: payload.message,
			hasPending: Boolean(this.pendingText),
		});

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

		this.lastAgentId = this.getCurrentAgentId();
		this.lastTopicId = this.getCurrentTopicId();

		const ViewClass =
			typeof window !== "undefined" &&
			(window.VcpVoice?.VoiceComposerView || window.VoiceComposerView);
		if (ViewClass) {
			this.view = new ViewClass();
			this.view.mount({
				messageInput: this.messageInput,
				sendMessageBtn: this.sendMessageBtn,
				onLeftClick: () => this.handleLeftClick(),
				onContextMenu: () => this.handleContextMenu(),
				onCancel: () => this.cancelCurrentVoiceSession(),
				onStop: () => this.stopCurrentVoiceSession(),
				onInsertPending: () => this.insertPendingDraftText(),
				onRetry: () => this.retryVoiceSession(),
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
		this.setupDefensiveLifecycles();
	}

	// 捕获草稿选区与版本标尺
	captureInsertion() {
		if (!this.messageInput) {
			return { start: 0, end: 0, draftText: "", rev: ++this.draftRev };
		}
		const val = String(this.messageInput.value || "");
		const start = typeof this.messageInput.selectionStart === "number"
			? this.messageInput.selectionStart
			: val.length;
		const end = typeof this.messageInput.selectionEnd === "number"
			? this.messageInput.selectionEnd
			: start;
		return {
			start,
			end,
			draftText: val,
			rev: ++this.draftRev,
		};
	}

	// 光标级原子写入与草稿冲突检测
	insertText(text, span = this.activeSpan) {
		if (!this.messageInput) return false;
		const textToInsert = String(text || "").trim();
		if (!textToInsert) return true;

		// 冲突检测：如果当前输入框内容与录音发起时的草稿快照不一致，说明用户在录音期间改动了文字
		if (span && typeof span.draftText === "string" && this.messageInput.value !== span.draftText) {
			return false; // 触发冲突自愈流程
		}

		const original = String(this.messageInput.value || "");
		let start = original.length;
		let end = original.length;

		if (span && typeof span.start === "number") {
			start = Math.max(0, Math.min(span.start, original.length));
			end = Math.max(start, Math.min(typeof span.end === "number" ? span.end : start, original.length));
		}

		const before = original.slice(0, start);
		const after = original.slice(end);

		// 仅当前文末尾与新句开头均为半角英文字母或数字时才补空格分词；
		// 中文与标点自然连贯拼接（对齐上游 joinSpeechTexts 规则）。
		const needsLeadingSpace =
			before.length > 0 &&
			/[a-zA-Z0-9]$/.test(before) &&
			/^[a-zA-Z0-9]/.test(textToInsert);
		const insertedStr = needsLeadingSpace ? ` ${textToInsert}` : textToInsert;

		let appliedViaExec = false;
		if (typeof document !== "undefined" && typeof document.execCommand === "function") {
			try {
				this.messageInput.focus?.({ preventScroll: true });
				this.messageInput.setSelectionRange?.(start, end);
				appliedViaExec = document.execCommand("insertText", false, insertedStr);
			} catch (_) {
				appliedViaExec = false;
			}
		}

		if (!appliedViaExec) {
			this.messageInput.value = `${before}${insertedStr}${after}`;
			const newPos = start + insertedStr.length;
			try {
				this.messageInput.selectionStart = newPos;
				this.messageInput.selectionEnd = newPos;
			} catch (_) {}
		}

		try {
			this.messageInput.dispatchEvent?.(new Event("input", { bubbles: true }));
		} catch (_) {}
		// 在末尾追加时滚动到最下方，确保长文本时最新识别的内容始终可见
		if (after.length === 0) {
			try {
				this.messageInput.scrollTop = this.messageInput.scrollHeight;
			} catch (_) {}
		}
		return true;
	}

	// 冲突自愈：将暂存的识别文本插入到当前最新光标处
	insertPendingDraftText() {
		if (!this.pendingText) {
			this.transitionTo(COMPOSER_STATE.IDLE);
			return;
		}
		const currentSpan = this.captureInsertion();
		this.insertText(this.pendingText, currentSpan);
		this.pendingText = "";
		this.transitionTo(COMPOSER_STATE.IDLE);
		try {
			this.messageInput?.focus({ preventScroll: true });
		} catch (_) {}
	}

	clearTimers() {
		if (this.audioRecordTimer) {
			clearTimeout(this.audioRecordTimer);
			this.audioRecordTimer = null;
		}
		if (this.transcribingTimeout) {
			clearTimeout(this.transcribingTimeout);
			this.transcribingTimeout = null;
		}
	}

	// 防御性生命周期：Blur 失焦防偷录、VisibilityChange 最小化保护、ESC 撤销
	setupDefensiveLifecycles() {
		if (typeof window === "undefined") return;

		const onBlur = () => {
			if (this.state === COMPOSER_STATE.STT_RECORDING || this.state === COMPOSER_STATE.AUDIO_RECORDING) {
				this.cancelCurrentVoiceSession();
			}
		};

		const onVisibility = () => {
			if (typeof document !== "undefined" && document.hidden) {
				if (this.state !== COMPOSER_STATE.TRANSCRIBING && this.state !== COMPOSER_STATE.IDLE) {
					this.cancelCurrentVoiceSession();
				}
			}
		};

		const onKeyDown = (event) => {
			if (event.key === "Escape" && this.state !== COMPOSER_STATE.IDLE) {
				event.preventDefault();
				this.cancelCurrentVoiceSession();
			}
		};

		window.addEventListener("blur", onBlur);
		document.addEventListener("visibilitychange", onVisibility);
		document.addEventListener("keydown", onKeyDown);

		this.own(() => {
			window.removeEventListener("blur", onBlur);
			document.removeEventListener("visibilitychange", onVisibility);
			document.removeEventListener("keydown", onKeyDown);
		});
	}

	checkSessionSwitch() {
		const curAgent = typeof this.getCurrentAgentId === "function" ? this.getCurrentAgentId() : "default";
		const curTopic = typeof this.getCurrentTopicId === "function" ? this.getCurrentTopicId() : "default";
		if ((this.lastAgentId && this.lastAgentId !== curAgent) || (this.lastTopicId && this.lastTopicId !== curTopic)) {
			if (this.state !== COMPOSER_STATE.IDLE) {
				this.cancelCurrentVoiceSession();
			}
		}
		this.lastAgentId = curAgent;
		this.lastTopicId = curTopic;
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
		if (this.transcribingTimeout) {
			clearTimeout(this.transcribingTimeout);
			this.transcribingTimeout = null;
		}
		if (payload?.canceled || payload?.forceDeactivate) {
			this.deactivateSttMode();
			return;
		}
		if (this.state === COMPOSER_STATE.STT_RECORDING || this.state === COMPOSER_STATE.TRANSCRIBING) {
			if (!this.receivedSpeechInSession && !this.pendingText) {
				this.transitionTo(COMPOSER_STATE.FEEDBACK, {
					message: '未识别到语音',
				});
			} else if (this.pendingText) {
				this.transitionTo(COMPOSER_STATE.FEEDBACK, {
					message: '草稿已被修改。可在当前光标处插入。',
				});
			} else {
				this.transitionTo(COMPOSER_STATE.IDLE);
			}
			if (this.sentinel) {
				this.sentinel.resume();
			}
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
			this.messageInput.dispatchEvent?.(new Event("input", { bubbles: true }));
			this.activeSpan = this.captureInsertion();
			return;
		}

		if (result.text) {
			this.receivedSpeechInSession = true;
			const ok = this.insertText(result.text, this.activeSpan);
			if (!ok) {
				// 草稿发生冲突（录音期间用户改动了草稿），进入 feedback 阶段
				// 避免多句流式推送覆盖旧词，多句累加保存
				this.pendingText = this.pendingText
					? `${this.pendingText} ${result.text}`
					: result.text;
				this.transitionTo(COMPOSER_STATE.FEEDBACK, {
					message: "草稿已被修改。可在当前光标处插入。",
				});
				return;
			}
			this.activeSpan = this.captureInsertion();
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

	// 统一取消当前录音或听写会话（左侧 ✕ 取消按钮 / ESC / 失焦触发）
	cancelCurrentVoiceSession() {
		this.pendingText = "";
		this.activeSpan = null;
		this.clearTimers();
		if (this.state === COMPOSER_STATE.AUDIO_RECORDING) {
			this.cancelAudioRecording();
		} else {
			this.stopSttMode();
		}
		this.transitionTo(COMPOSER_STATE.IDLE);
		try {
			this.messageInput?.focus({ preventScroll: true });
		} catch (_) {}
	}

	// 统一停止当前会话（右侧 ■ 停止按钮触发）
	async stopCurrentVoiceSession() {
		this.clearTimers();
		if (this.state === COMPOSER_STATE.AUDIO_RECORDING) {
			await this.stopAudioRecording();
		} else if (this.isSttActive) {
			this.transitionTo(COMPOSER_STATE.TRANSCRIBING);
			this.transcribingTimeout = setTimeout(() => {
				if (this.state === COMPOSER_STATE.TRANSCRIBING) {
					this.transitionTo(COMPOSER_STATE.IDLE);
				}
			}, 8000);
			try {
				await this.callIpc('stopMainChatVoiceInput', 'main-chat-voice:stop');
			} catch (_) {}
		}
	}

	isNativeSttSupported() {
		if (typeof process !== "undefined" && process.platform) {
			return process.platform === "win32";
		}
		return false;
	}

	async handleLeftClick() {
		if (this.isTransitioning) return;
		if (this.messageInput?.disabled) return;
		this.isTransitioning = true;
		try {
			if (this.state === COMPOSER_STATE.AUDIO_RECORDING) {
				await this.stopAudioRecording();
				return;
			}

			if (this.isSttActive) {
				this.stopSttMode();
				return;
			}

			// 非 Windows 环境（如 macOS / Linux）无系统级 Win+H 原生听写管道，左键直接无缝启动高质量原声录音
			if (!this.isNativeSttSupported()) {
				await this.startAudioRecording();
				return;
			}

			await this.startSttMode();
		} finally {
			this.isTransitioning = false;
		}
	}

	async handleContextMenu() {
		if (this.isTransitioning) return;
		if (this.messageInput?.disabled) return;
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
		this.checkSessionSwitch();
		this.activeSpan = this.captureInsertion();
		this.pendingText = "";
		this.receivedSpeechInSession = false;

		const epoch = ++this.sessionEpoch;
		this.transitionTo(COMPOSER_STATE.REQUESTING, { mode: 'stt' });

		const SentinelClass =
			typeof window !== "undefined"
				? window.VcpVoice?.PassiveVoiceSentinel || window.PassiveVoiceSentinel
				: null;
		if (!this.sentinel && SentinelClass) {
			this.sentinel = new SentinelClass({
				thresholdRms: 0.007,
				onTrigger: () => {
					this.onVoiceTriggered(epoch);
				},
			});
		}

		if (this.sentinel) {
			let started = false;
			try {
				started = await this.sentinel.start();
			} catch (_) {}
			if (!started) {
				this.deactivateSttMode();
				this.transitionTo(COMPOSER_STATE.FEEDBACK, {
					mode: 'stt',
					message: '麦克风权限未开启，请在系统设置中允许访问',
				});
				return;
			}
			// 若启动期间用户已主动退出，直接销毁并返回
			if (epoch !== this.sessionEpoch || !this.isSttActive) {
				this.deactivateSttMode();
				return;
			}
			this.sentinel.suspend();
		}

		await this.onVoiceTriggered(epoch);
	}

	async onVoiceTriggered(invokingEpoch = this.sessionEpoch) {
		if (invokingEpoch !== this.sessionEpoch) return;

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
		this.clearTimers();
		this.sessionEpoch += 1;
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
		this.checkSessionSwitch();
		this.activeSpan = this.captureInsertion();
		this.pendingText = "";
		this.receivedSpeechInSession = false;

		if (!this.recorder) {
			const RecorderClass =
				typeof window !== "undefined"
					? window.VcpVoice?.AudioRecorder || window.AudioRecorder
					: null;
			if (RecorderClass) this.recorder = new RecorderClass();
		}
		if (!this.recorder) return;

		this.transitionTo(COMPOSER_STATE.REQUESTING, { mode: 'audio-record' });

		try {
			await this.recorder.start();
			this.transitionTo(COMPOSER_STATE.AUDIO_RECORDING);
			if (this.audioRecordTimer) clearTimeout(this.audioRecordTimer);
			this.audioRecordTimer = setTimeout(() => {
				void this.stopAudioRecording();
			}, this.maxAudioDurationSeconds * 1000);
		} catch (error) {
			console.error("[ChatVoiceComposer] 录音启动失败:", error);
			const isPermission = error?.name === 'NotAllowedError' || /permission/i.test(error?.message);
			this.transitionTo(COMPOSER_STATE.FEEDBACK, {
				mode: 'audio-record',
				message: isPermission ? '麦克风权限未开启，请在系统设置中允许访问' : '麦克风设备启动失败，请检查硬件连接',
			});
		}
	}

	cancelAudioRecording() {
		if (this.audioRecordTimer) {
			clearTimeout(this.audioRecordTimer);
			this.audioRecordTimer = null;
		}
		this.transitionTo(COMPOSER_STATE.IDLE);
		try {
			this.recorder?.dispose();
		} catch (_) {}
		this.recorder = null;
	}

	async stopAudioRecording() {
		if (this.audioRecordTimer) {
			clearTimeout(this.audioRecordTimer);
			this.audioRecordTimer = null;
		}
		if (this.state !== COMPOSER_STATE.AUDIO_RECORDING || !this.recorder) return;
		this.transitionTo(COMPOSER_STATE.TRANSCRIBING, { mode: 'audio-record', message: '正在处理音频…' });

		try {
			const wavBlob = await this.recorder.stop();
			if (wavBlob) {
				await this.attachWavAudioFile(wavBlob);
				this.transitionTo(COMPOSER_STATE.IDLE);
			} else {
				this.transitionTo(COMPOSER_STATE.FEEDBACK, {
					mode: 'audio-record',
					message: '未识别到有效语音',
				});
			}
		} catch (error) {
			console.error("[ChatVoiceComposer] 录音停止或保存异常:", error);
			this.transitionTo(COMPOSER_STATE.FEEDBACK, {
				mode: 'audio-record',
				message: '录音处理失败，请重试',
			});
		}
	}

	retryVoiceSession() {
		const wasAudio = this.state === COMPOSER_STATE.AUDIO_RECORDING || this.view?.waveformContainer?.classList.contains('mode-audio-record');
		this.cancelCurrentVoiceSession();
		if (wasAudio) {
			void this.startAudioRecording();
		} else {
			void this.startSttMode();
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
		this.clearTimers();
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
