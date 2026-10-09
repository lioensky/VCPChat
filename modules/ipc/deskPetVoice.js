// modules/ipc/deskPetVoice.js
// 桌宠出声（deskPetHandlers 的一部分）：桌宠把回复按句送来，这里按该助手的 TTS 设置
// （Agent 设置里的音色、语速、正则、导演提示词）交给 VCPChat 共用的 SovitsTTS 合成，音频直接回到桌宠窗口播放。
//
//   - 助手没设音色就不出声；右键菜单「朗读回复」可以单独让桌宠闭嘴（每个助手分开记，存在 AppData/deskpet/voice.json）。
//   - 同一时间只有一个声音：桌宠开口时主窗口里的朗读停下，主窗口开始朗读时桌宠停下。
//   - 桌宠正在念的那条回复，主窗口的自动朗读不再念一遍。

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const sovits = require('./sovitsHandlers');

const SENTENCE_MAX_CHARS = 1000;
// 桌宠念完以后，这么久内主窗口对同一条的自动朗读仍然跳过（自动朗读在回复结束后才触发）。
const CLAIM_GRACE_MS = 8000;

let paths = null;
let findPet = null; // event → pet
let muted = null; // agentId → true，懒加载
const claims = new Map(); // messageId → { contents, until }
const speeches = new WeakMap(); // pet → { messageId, session, options }
// 还在读配置的 voice-begin：期间又来了新的 begin 或这条已经 end，读完就不再占
const beginning = new WeakMap(); // pet → { messageId, seq }
let beginSeq = 0;

function voicePrefsPath() {
    return path.join(paths.appDataRoot, 'deskpet', 'voice.json');
}

async function loadMuted() {
    if (muted) return muted;
    try {
        const data = await fs.readJson(voicePrefsPath());
        muted = data && typeof data.muted === 'object' && data.muted ? data.muted : {};
    } catch {
        muted = {};
    }
    return muted;
}

async function setMuted(agentId, value) {
    const map = await loadMuted();
    if (value) map[agentId] = true;
    else delete map[agentId];
    await fs.outputJson(voicePrefsPath(), { muted: map }, { spaces: 2 });
}

async function readVoiceConfig(agentId) {
    try {
        const config = await fs.readJson(path.join(paths.agentDir, agentId, 'config.json'));
        if (!config?.ttsVoicePrimary) return null;
        return {
            voice: config.ttsVoicePrimary,
            speed: config.ttsSpeed || 1.0,
            ttsRegex: config.ttsRegexPrimary,
            directorPrompts: config.ttsDirectorPrompts,
            voiceSecondary: config.ttsVoiceSecondary,
            ttsRegexSecondary: config.ttsRegexSecondary,
        };
    } catch {
        return null;
    }
}

/** 这个助手的桌宠现在能不能出声：{ hasVoice, muted }。 */
async function voiceStatus(agentId) {
    const [config, map] = await Promise.all([readVoiceConfig(agentId), loadMuted()]);
    return { hasVoice: Boolean(config), muted: Boolean(map[agentId]), config };
}

function pruneClaims() {
    const now = Date.now();
    for (const [id, claim] of claims) {
        if (claim.until && claim.until < now) claims.delete(id);
        else if (claim.contents.isDestroyed()) claims.delete(id);
    }
}

function releaseClaim(messageId, contents) {
    const claim = claims.get(messageId);
    if (claim && claim.contents === contents) claim.until = Date.now() + CLAIM_GRACE_MS;
}

// 主窗口（或别的窗口）要念的正是桌宠在念的那条：跳过。
function gate(sender, options) {
    pruneClaims();
    const claim = claims.get(String(options?.msgId ?? ''));
    return !claim || claim.contents === sender;
}

/** 桌宠关掉、重载时：它发起的朗读停掉，占着的回复放开。 */
function release(pet) {
    // 窗口的 closed 事件里 win.webContents 已经销毁，一碰就抛异常（主进程会弹「JavaScript error」框卡住），
    // 所以用打开窗口时记下的那个
    let contents = pet?.contents;
    if (!contents) {
        try { contents = pet?.win?.webContents; } catch { contents = null; }
    }
    if (!contents) return;
    for (const [id, claim] of claims) if (claim.contents === contents) claims.delete(id);
    speeches.delete(pet);
    beginning.delete(pet);
    sovits.stopSpeechFrom(contents);
}

function registerIpc() {
    // 新回复开始：能出声就占下这条，返回 { speaking }
    ipcMain.handle('deskpet:voice-begin', async (event, messageId) => {
        const pet = findPet(event);
        const id = typeof messageId === 'string' ? messageId : '';
        if (!pet || !id) return { speaking: false };
        const seq = ++beginSeq;
        beginning.set(pet, { messageId: id, seq });
        const status = await voiceStatus(pet.agentId);
        // 读配置期间被新回复顶掉、被 voice-end 放弃：不能再占，否则这条一直占着（主窗口也念不了它）
        if (beginning.get(pet)?.seq !== seq) return { speaking: false };
        beginning.delete(pet);
        if (!status.hasVoice || status.muted || pet.win.isDestroyed()) return { speaking: false };
        pruneClaims();
        claims.set(id, { contents: pet.win.webContents, until: 0 });
        speeches.set(pet, { messageId: id, session: null, options: status.config });
        // 页面按这两个正则跳过念不出字的句子（TTS 会悄悄丢掉它们，页面就会一直等那句的声音）
        return { speaking: true, ttsRegex: status.config.ttsRegex || '', ttsRegexSecondary: status.config.ttsRegexSecondary || '' };
    });

    // 一句话：第一句开始新的朗读（停掉别处的），之后的接在后面
    ipcMain.on('deskpet:voice-say', (event, payload) => {
        const pet = findPet(event);
        const speech = pet && speeches.get(pet);
        const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, SENTENCE_MAX_CHARS) : '';
        if (!speech || !text || payload.messageId !== speech.messageId || pet.win.isDestroyed()) return;
        const contents = pet.win.webContents;
        const options = { ...speech.options, text, msgId: String(payload.key || speech.messageId) };
        if (payload.first || speech.session == null) {
            speech.session = sovits.startSpeech(contents, options, { notifySender: false });
        } else if (!sovits.appendSpeech(contents, options, speech.session)) {
            // 期间别的窗口开始朗读了，这条不再接着念
            speeches.delete(pet);
            releaseClaim(speech.messageId, contents);
        }
    });

    // 念完、放弃，或者用户让 TA 别念了（stop）
    ipcMain.on('deskpet:voice-end', (event, payload) => {
        const pet = findPet(event);
        if (!pet || pet.win.isDestroyed()) return;
        const contents = pet.win.webContents;
        const speech = speeches.get(pet);
        if (payload?.messageId && beginning.get(pet)?.messageId === payload.messageId) beginning.delete(pet);
        if (payload?.messageId) releaseClaim(String(payload.messageId), contents);
        if (speech && speech.messageId === payload?.messageId) speeches.delete(pet);
        if (payload?.stop) sovits.stopSpeechFrom(contents);
    });
}

/** 右键菜单里的「朗读回复」开关。 */
async function menuItem(pet) {
    const status = await voiceStatus(pet.agentId).catch(() => ({ hasVoice: false, muted: false }));
    return {
        label: status.hasVoice ? '朗读回复' : '朗读回复（先在助手设置里选音色）',
        type: 'checkbox',
        enabled: status.hasVoice,
        checked: status.hasVoice && !status.muted,
        click: (item) => {
            const nextMuted = !item.checked;
            setMuted(pet.agentId, nextMuted).catch((error) => console.warn('[DeskPet] save voice pref:', error.message));
            if (nextMuted && !pet.win.isDestroyed()) {
                // 正在念就马上停
                sovits.stopSpeechFrom(pet.win.webContents);
                pet.win.webContents.send('stop-tts-audio');
            }
        },
    };
}

function initialize(options) {
    paths = options.paths;
    findPet = options.findPet;
    sovits.setSpeakGate(gate);
    registerIpc();
}

module.exports = {
    initialize,
    release,
    menuItem,
    // 测试用
    _gate: gate,
    _claims: claims,
};
