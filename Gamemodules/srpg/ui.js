import { defaultSettings, MODULE_NAME, META_KEY, FE_KAI_PROFILE_ID } from './src/defaults.js';
import { createBattle } from './src/engine.js';
import { recordCheckpoint } from './src/history.js';
import { textDialog } from './src/ui/dom.js';

const LOCAL_KEY = 'vcp_tavern_srpg_save_v1';
const OWNER_AVATAR = 'fe_kai_sandbox.png';
const remote = window.srpgRemote;
const statusBadge = document.getElementById('vcp-sync-status');
const toastBox = document.getElementById('vcp-toast-box');

function showToast(type, message) {
    if (!toastBox) return;
    const item = document.createElement('div');
    item.className = 'vcp-toast';
    if (type === 'error') item.style.borderLeftColor = '#ef4444';
    else if (type === 'success') item.style.borderLeftColor = '#10b981';
    item.textContent = String(message || '');
    toastBox.append(item);
    setTimeout(() => item.remove(), 3200);
}

window.toastr = {
    info: msg => showToast('info', msg),
    success: msg => showToast('success', msg),
    warning: msg => showToast('warning', msg),
    error: msg => showToast('error', msg),
};

let lastReportText = '';
let applyingRemote = false;
let syncTimer = null;

function ensureBoundSettings(settings) {
    const s = settings || defaultSettings();
    s.bindings ||= {};
    s.activeProfile ||= FE_KAI_PROFILE_ID;
    s.bindings[`char:${OWNER_AVATAR}`] = s.activeProfile;
    s.ui ||= {};
    s.ui.layout = 'float';
    s.ui.cell ||= 54;
    return s;
}

function buildInitialBattle(settings) {
    const p = settings.profiles.find(x => x.id === settings.activeProfile) || settings.profiles[0];
    const m = p?.maps?.[0];
    if (!p || !m) return null;
    const b = createBattle(m, p.units, p.terrains, p.unitTypes);
    b.profileId = p.id;
    b.profileName = p.name;
    b.rev = 1;
    recordCheckpoint(b, { chat: 0, kind: 'start' });
    return b;
}

let initialSettings = ensureBoundSettings(defaultSettings());
let initialBattle = null;

try {
    const cached = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
    if (cached?.settings) initialSettings = ensureBoundSettings(cached.settings);
    if (cached?.battle) initialBattle = cached.battle;
} catch { /* ignore localStorage parse error */ }

if (remote) {
    try {
        const res = await remote.getState();
        if (res?.ok && res.state) {
            if (res.state.settings) initialSettings = ensureBoundSettings(res.state.settings);
            if (res.state.battle) initialBattle = res.state.battle;
            if (statusBadge) statusBadge.textContent = `已连接主进程 · rev ${res.state.revision}`;
        }
    } catch (err) {
        if (statusBadge) statusBadge.textContent = `本地沙盘模式 (${err.message})`;
    }
}

if (!initialBattle) {
    initialBattle = buildInitialBattle(initialSettings);
}

const stContext = {
    chatId: 'vcp-fe-kai-sandbox',
    characterId: 0,
    characters: [{ name: '万缕千丝·凯伊线沙盘', avatar: OWNER_AVATAR }],
    extensionSettings: { [MODULE_NAME]: initialSettings },
    chatMetadata: { [META_KEY]: initialBattle },
    chat: [],
    saveSettingsDebounced() {
        scheduleSync();
    },
    saveMetadataDebounced() {
        scheduleSync();
    },
    saveMetadata() {
        scheduleSync();
    },
    setExtensionPrompt() {},
    registerMacro() {},
    registerFunctionTool() {},
};

window.SillyTavern = {
    getContext: () => stContext,
};

const { App } = await import('./src/ui/panel.js');
const app = new App();
window.TavernSRPG = app;

function scheduleSync() {
    if (applyingRemote) return;
    const settings = ensureBoundSettings(stContext.extensionSettings[MODULE_NAME]);
    const battle = stContext.chatMetadata[META_KEY] || null;
    try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify({ settings, battle }));
    } catch { /* ignore quota error */ }
    if (!remote) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
        try {
            const out = await remote.sync({ settings, battle });
            if (out?.ok && out.state && statusBadge) {
                statusBadge.textContent = `已同步 · rev ${out.state.revision}`;
            }
        } catch (err) {
            if (statusBadge) statusBadge.textContent = `同步异常：${err.message}`;
        }
    }, 80);
}

const stage = document.getElementById('vcp-srpg-stage');
app.mount();
if (app.panel && stage) {
    stage.append(app.panel);
}
if (app.fab) app.fab.style.display = 'none';
app._open = true;
app.panel.hidden = false;
await app.onChatChanged();
app.render();

// 拦截“发送行动”按钮触发的输入框写入，存入最新战报并自动复制到剪贴板
const sendBtn = document.getElementById('send_but');
const sendTa = document.getElementById('send_textarea');
sendBtn?.addEventListener('click', () => {
    const text = sendTa?.value || '';
    if (!text.trim()) return;
    lastReportText = text;
    navigator.clipboard?.writeText(text).catch(() => {});
    showToast('success', '战报已整理并复制到剪贴板，可直接粘贴到聊天或由迟明读取！');
    scheduleSync();
});

document.getElementById('vcp-copy-context-btn')?.addEventListener('click', () => {
    const text = app.battleContext() || '当前尚无活跃战场。';
    textDialog(app.panel, '当前完整战场态势（已支持迟明后台直读）', text, {
        note: '包含 ASCII 网格地图、地形图例、全员 HP/韧性/技能冷却与敌我方位距离。',
    });
});

document.getElementById('vcp-copy-report-btn')?.addEventListener('click', () => {
    const text = lastReportText || sendTa?.value || app.battleContext() || '本回合尚无已整理的战报。';
    textDialog(app.panel, '最新回合战报记录', text, {
        note: '在战场页点击「预览并发送」或「结束回合」后会自动生成结构化战报。',
    });
});

if (remote) {
    remote.onUpdate(output => {
        if (!output?.ok || !output.state || output.source === 'ui') return;
        applyingRemote = true;
        try {
            if (output.state.settings) {
                stContext.extensionSettings[MODULE_NAME] = ensureBoundSettings(output.state.settings);
            }
            stContext.chatMetadata[META_KEY] = output.state.battle || null;
            if (output.state.pendingText) lastReportText = output.state.pendingText;
            if (statusBadge) statusBadge.textContent = `Agent 同步更新 · rev ${output.state.revision}`;
            app.render();
            showToast('info', '棋盘已同步迟明（Nova）的最新操作');
        } finally {
            applyingRemote = false;
        }
    });
}