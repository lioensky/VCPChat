// 全局快捷键：一行一个动作，点按钮再按组合键就录下来（录的时候先停掉现有的快捷键）。
// 权威在主进程（deskpet-settings:shortcut），这里只显示快照和错误。

import { el, button } from './dom.js';
import { formatAccelerator, acceleratorFromEvent } from './accelerators.js';

export function buildShortcuts(doc) {
    const shortcutsTitle = el(doc, 'h4', 'dps-subtitle', '快捷键');
    const shortcuts = el(doc, 'div', 'dps-card');
    const shortcutHint = el(doc, 'p', 'dps-row-hint dps-card-hint', '在任何程序里都能用。点一下按钮，再按下想要的组合键；Esc 取消，Backspace 清除。');
    const shortcutList = el(doc, 'div', 'dps-shortcuts');
    const resetRow = el(doc, 'div', 'dps-card-actions');
    const resetBtn = button(doc, 'dps-btn', '恢复默认快捷键');
    resetRow.append(resetBtn);
    shortcuts.append(shortcutHint, shortcutList, resetRow);
    return { shortcutsTitle, shortcuts, shortcutList, resetBtn };
}

// ctx：{ doc, api, state, applySnapshot }
export function wireShortcuts(ctx, parts) {
    const { doc, api, state } = ctx;
    const { shortcutList, resetBtn } = parts;

    function renderShortcuts() {
        const snapshot = state.snapshot;
        if (!snapshot) return;
        shortcutList.replaceChildren();
        for (const [actionId, action] of Object.entries(snapshot.actions)) {
            const row = el(doc, 'div', 'dps-row dps-shortcut');
            const label = el(doc, 'span', 'dps-row-title', action.label);
            const accelerator = snapshot.settings.shortcuts[actionId];
            const recording = state.recording === actionId;
            const key = button(doc, 'dps-key', recording ? '请按下组合键…' : (formatAccelerator(accelerator) || '未设置'));
            key.classList.toggle('is-recording', recording);
            key.classList.toggle('is-empty', !accelerator && !recording);
            key.addEventListener('click', () => (recording ? stopRecording() : startRecording(actionId)));
            key.addEventListener('keydown', (e) => onRecordKey(e, actionId));
            const error = el(doc, 'span', 'dps-key-error', state.errors[actionId] || (snapshot.paused ? '' : snapshot.failures?.[actionId] || ''));
            row.append(label, error, key);
            shortcutList.append(row);
            if (recording) key.focus({ preventScroll: true });
        }
    }

    async function startRecording(actionId) {
        state.recording = actionId;
        delete state.errors[actionId];
        // 录的时候先停掉现有的全局快捷键，否则按下去直接触发了
        ctx.applySnapshot(await api.pauseDeskPetShortcuts(true));
    }

    async function stopRecording() {
        if (!state.recording) return;
        state.recording = null;
        ctx.applySnapshot(await api.pauseDeskPetShortcuts(false));
    }

    async function onRecordKey(e, actionId) {
        if (state.recording !== actionId) return;
        e.preventDefault();
        e.stopPropagation();
        const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
        if (plain && e.key === 'Escape') return stopRecording();
        let accelerator;
        if (plain && (e.key === 'Backspace' || e.key === 'Delete')) accelerator = '';
        else {
            accelerator = acceleratorFromEvent(e);
            if (accelerator === null) return; // 只按了修饰键，继续等
        }
        state.recording = null;
        await api.pauseDeskPetShortcuts(false);
        const result = await api.setDeskPetShortcut(actionId, accelerator);
        if (result?.success) delete state.errors[actionId];
        else state.errors[actionId] = result?.error || '设置失败';
        ctx.applySnapshot(result?.snapshot || (await api.getDeskPetSettings()));
    }

    resetBtn.addEventListener('click', async () => {
        state.errors = {};
        state.recording = null;
        await api.pauseDeskPetShortcuts(false);
        ctx.applySnapshot(await api.resetDeskPetShortcuts());
    });

    return { renderShortcuts, stopRecording };
}
