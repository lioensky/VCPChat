// 选项：免打扰、主动搭话、只看不点、视线跟随、溜达、动作速度、不透明度、截图隐藏、启动恢复、全屏让开。
// 改一下就存一下（主进程 deskpet-settings:update），不进设置表单的 collect/自动保存。

import { el, buildSwitchRow } from './dom.js';

export function buildOptions(doc) {
    const optionsTitle = el(doc, 'h4', 'dps-subtitle', '选项');
    const options = el(doc, 'div', 'dps-card');
    const dnd = buildSwitchRow(doc, '免打扰', '不主动说话、不出声，主窗口里聊天的回复也不在桌宠头上冒出来。在桌宠上跟 TA 说的话照常回。');
    const restore = buildSwitchRow(doc, '启动时恢复桌宠', '打开 VCPChat 时，把上次开着的桌宠放回原来的位置。');
    const yieldFs = buildSwitchRow(doc, '全屏时让开', '看视频、玩游戏、放幻灯片时桌宠先躲起来，退出全屏再回来。只在 Windows 上有效。');
    yieldFs.row.hidden = true;
    const through = buildSwitchRow(doc, '只看不点', '鼠标直接穿过桌宠，点不到也拖不动，适合专心工作时。用托盘菜单或快捷键关掉；「和桌宠说话」的快捷键照常能用。');
    const follow = buildSwitchRow(doc, '视线跟随光标', '光标在屏幕上移动时 TA 跟着看过去。关掉后只自己四处看看，不会一直盯着光标。');
    const wander = buildSwitchRow(doc, '在桌面上溜达', '站在任务栏上闲了一阵，会沿着任务栏走一小段。');
    const musicDance = buildSwitchRow(doc, '听歌时跟着晃', 'V 音乐播放时随节拍轻轻律动，有合适动作的 Live2D 偶尔做手势。免打扰、睡着或互动时暂停，朗读时收小幅度。');
    const hideCapture = buildSwitchRow(doc, '截图、录屏时隐藏', '截图、录屏、开会共享屏幕时画面里不出现桌宠，自己屏幕上照常看得到。');
    hideCapture.row.hidden = true;
    const opacityRow = el(doc, 'div', 'dps-row');
    const opacityCopy = el(doc, 'span', 'dps-row-copy');
    opacityCopy.append(el(doc, 'span', 'dps-row-title', '不透明度'), el(doc, 'span', 'dps-row-hint', '角色淡一点，后面的字能透出来；气泡和输入框不变。'));
    const opacityControl = el(doc, 'span', 'dps-size');
    const opacitySlider = el(doc, 'input', 'dps-slider');
    opacitySlider.type = 'range';
    opacitySlider.min = '0.3';
    opacitySlider.max = '1';
    opacitySlider.step = '0.05';
    opacitySlider.setAttribute('aria-label', '桌宠不透明度');
    const opacityValue = el(doc, 'span', 'dps-size-value');
    opacityControl.append(opacitySlider, opacityValue);
    opacityRow.append(opacityCopy, opacityControl);
    const idleRow = el(doc, 'div', 'dps-row');
    const idleCopy = el(doc, 'span', 'dps-row-copy');
    idleCopy.append(
        el(doc, 'span', 'dps-row-title', '闲着时主动搭话'),
        el(doc, 'span', 'dps-row-hint', '你在电脑前、但这么久没和 TA 说话时，TA 会主动说一句（记在「桌宠闲聊」话题里，点气泡接着聊）。每次会调用一次模型；离开电脑、深夜、免打扰时不说。'),
    );
    const idleSelect = el(doc, 'select', 'dps-agent');
    idleSelect.id = 'deskPetIdleChat';
    idleSelect.setAttribute('aria-label', '闲着时主动搭话');
    idleSelect.dataset.vcpTypedPrimitiveMounted = 'true';
    for (const [value, label] of [['off', '不主动说'], ['10', '每 10 分钟'], ['30', '每 30 分钟'], ['60', '每 60 分钟']]) {
        const option = el(doc, 'option', '', label);
        option.value = value;
        idleSelect.append(option);
    }
    idleRow.append(idleCopy, idleSelect);
    const speedRow = el(doc, 'div', 'dps-row');
    const speedCopy = el(doc, 'span', 'dps-row-copy');
    speedCopy.append(el(doc, 'span', 'dps-row-title', '动作速度'), el(doc, 'span', 'dps-row-hint', 'Codex 宠物这类逐帧动画的形象动得多快。'));
    const speedSelect = el(doc, 'select', 'dps-agent');
    speedSelect.id = 'deskPetAnimationSpeed';
    speedSelect.setAttribute('aria-label', '动作速度');
    speedSelect.dataset.vcpTypedPrimitiveMounted = 'true';
    for (const [value, label] of [['slow', '慢'], ['normal', '标准'], ['fast', '快']]) {
        const option = el(doc, 'option', '', label);
        option.value = value;
        speedSelect.append(option);
    }
    speedRow.append(speedCopy, speedSelect);
    options.append(dnd.row, idleRow, through.row, follow.row, musicDance.row, wander.row, speedRow, opacityRow, hideCapture.row, restore.row, yieldFs.row);
    return { optionsTitle, options, dnd, restore, yieldFs, through, follow, musicDance, wander, hideCapture, opacitySlider, opacityValue, idleSelect, speedSelect };
}

// ctx：{ doc, api, state, applySnapshot }
export function wireOptions(ctx, parts) {
    const { doc, api, state } = ctx;
    const { dnd, restore, yieldFs, through, follow, musicDance, wander, hideCapture, opacitySlider, opacityValue, idleSelect, speedSelect } = parts;

    function renderSwitches() {
        const settings = state.snapshot?.settings;
        if (!settings) return;
        dnd.input.checked = settings.doNotDisturb === true;
        restore.input.checked = settings.restoreOnLaunch === true;
        yieldFs.input.checked = settings.yieldToFullscreen === true;
        yieldFs.row.hidden = state.snapshot.platform !== 'win32';
        through.input.checked = settings.clickThrough === true;
        follow.input.checked = settings.followCursor !== false;
        wander.input.checked = settings.wander === true;
        musicDance.input.checked = settings.musicDance !== false;
        hideCapture.input.checked = settings.hideFromCapture === true;
        // Linux 上 Electron 做不到「截图时不出现」
        hideCapture.row.hidden = state.snapshot.platform !== 'win32' && state.snapshot.platform !== 'darwin';
        idleSelect.value = settings.idleChat === true ? String(settings.idleChatMinutes || 30) : 'off';
        speedSelect.value = settings.animationSpeed || 'normal';
        const opacity = Number(settings.opacity ?? 1);
        if (doc.activeElement !== opacitySlider) opacitySlider.value = String(opacity);
        opacityValue.textContent = `${Math.round(Number(opacitySlider.value) * 100)}%`;
    }

    async function update(patch) {
        const snapshot = await api.updateDeskPetSettings(patch);
        if (snapshot) ctx.applySnapshot(snapshot);
    }
    dnd.input.addEventListener('change', () => update({ doNotDisturb: dnd.input.checked }));
    restore.input.addEventListener('change', () => update({ restoreOnLaunch: restore.input.checked }));
    yieldFs.input.addEventListener('change', () => update({ yieldToFullscreen: yieldFs.input.checked }));
    through.input.addEventListener('change', () => update({ clickThrough: through.input.checked }));
    follow.input.addEventListener('change', () => update({ followCursor: follow.input.checked }));
    musicDance.input.addEventListener('change', () => update({ musicDance: musicDance.input.checked }));
    idleSelect.addEventListener('change', () => {
        const value = idleSelect.value;
        update(value === 'off' ? { idleChat: false } : { idleChat: true, idleChatMinutes: Number(value) });
    });
    speedSelect.addEventListener('change', () => update({ animationSpeed: speedSelect.value }));
    wander.input.addEventListener('change', () => update({ wander: wander.input.checked }));
    hideCapture.input.addEventListener('change', () => update({ hideFromCapture: hideCapture.input.checked }));
    // 拖动时先只改数字，松手再存（拖的过程中桌宠不跟着一下下闪）
    opacitySlider.addEventListener('input', () => { opacityValue.textContent = `${Math.round(Number(opacitySlider.value) * 100)}%`; });
    opacitySlider.addEventListener('change', () => update({ opacity: Number(opacitySlider.value) }));

    return { renderSwitches };
}
