// modules/deskpet/petMenus.js
// 两个菜单：在桌宠身上右键的那个（心情、说话、切换助手、换装、大小、透明度…）
// 和托盘里的「桌宠」那一项，外加菜单上显示的持续心情那行字。

const petPrefs = require('./petPrefs');
const outfitStore = require('./outfits');
const { outfitSummary } = require('./petAssets');
const { getAgentMoodStore } = require('../agentMood');

// ---- 持续心情 ----------------------------------------------------------------

const MOOD_LABEL = {
    neutral: '🙂 平静', calm: '😌 放松', happy: '😊 开心', excited: '🤩 兴奋', shy: '😳 害羞', affectionate: '🥰 温柔',
    curious: '🤔 好奇', surprised: '😮 惊讶', concerned: '😟 担心', sad: '😢 难过', tired: '😪 疲惫', angry: '😠 生气',
};

async function readMood(agentId) {
    try {
        return (await getAgentMoodStore()?.get(agentId)) ?? null;
    } catch (_error) {
        return null;
    }
}

function moodMenuLabel(mood) {
    const label = MOOD_LABEL[mood?.emotion] || MOOD_LABEL.neutral;
    if (!mood || mood.emotion === 'neutral') return `现在的心情：${label}`;
    const degree = mood.intensity >= 0.6 ? '很' : mood.intensity >= 0.35 ? '' : '有点';
    return `现在的心情：${label.replace(' ', ` ${degree}`)}`;
}

function createPetMenus(ctx) {
    const { pets } = ctx;
    const { Menu } = ctx.electron;

    function outfitMenu(pet, outfits) {
        return outfits.map((outfit) => ({
            label: outfitStore.outfitLabel(outfit),
            type: 'radio',
            checked: outfit.id === pet.outfit,
            click: () => ctx.sizing.setPetOutfit(pet.agentId, outfit.id).catch((error) => console.warn('[DeskPet] outfit switch failed:', error.message)),
        }));
    }

    // 角色淡一点，后面的字能透出来；气泡和输入框不变
    function opacityMenu() {
        const current = ctx.controls?.get().opacity ?? 1;
        return [1, 0.8, 0.6, 0.4].map((value) => ({
            label: value === 1 ? '不透明' : `${Math.round(value * 100)}%`,
            type: 'radio',
            checked: Math.abs(current - value) < 0.001,
            click: () => ctx.controls?.update({ opacity: value }),
        }));
    }

    function scaleMenu(pet) {
        const presets = [0.8, 1, 1.25, 1.5, 2, 2.5];
        const max = petPrefs.maxScaleForWorkArea(ctx.geometry.workAreaAt(pet.win.getBounds()), pet.aspect, pet.kind);
        const shortcut = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
        return [
            { label: `放大（${shortcut}+滚轮）`, enabled: pet.scale < max, click: () => ctx.sizing.stepPetScale(pet.agentId, 1) },
            { label: '缩小', enabled: pet.scale > petPrefs.SCALE_MIN, click: () => ctx.sizing.stepPetScale(pet.agentId, -1) },
            { type: 'separator' },
            ...presets.map((value) => ({
                label: `${Math.round(value * 100)}%`,
                type: 'radio',
                checked: Math.abs(pet.scale - value) < 0.001,
                enabled: value <= max,
                click: () => ctx.sizing.setPetScale(pet.agentId, value),
            })),
        ];
    }

    /** 托盘菜单里的「桌宠」一项（main.js 建托盘菜单时调用）。 */
    function trayMenuItems() {
        if (!ctx.controls) return [];
        const settings = ctx.controls.get();
        const live = [...pets.values()].filter((pet) => !pet.win.isDestroyed());
        const anyVisible = live.some((pet) => pet.win.isVisible());
        // 只显示快捷键，不在菜单里再注册一次（全局快捷键已经注册过了）
        const shortcut = (id) => (settings.shortcuts[id] ? { accelerator: settings.shortcuts[id], registerAccelerator: false } : {});
        const toggle = () => ctx.commands.toggleAllPets().catch(() => {});
        // 显示 / 隐藏是两项轮流露出来，开关桌宠时只改 visible，不用换文字重建菜单
        return [{
            label: '桌宠',
            submenu: [
                { id: 'deskpet-hide', label: '隐藏桌宠', ...shortcut('toggle'), visible: anyVisible, click: toggle },
                { id: 'deskpet-show', label: '显示桌宠', ...shortcut('toggle'), visible: !anyVisible, click: toggle },
                { id: 'deskpet-talk', label: '和桌宠说话', ...shortcut('talk'), click: () => ctx.commands.talkToPet().catch(() => {}) },
                { type: 'separator' },
                { id: 'deskpet-dnd', label: '免打扰', type: 'checkbox', checked: settings.doNotDisturb, click: (item) => ctx.sizing.setDoNotDisturb(item.checked) },
                { id: 'deskpet-click-through', label: '只看不点（鼠标穿透）', type: 'checkbox', checked: settings.clickThrough, ...shortcut('clickThrough'), click: (item) => ctx.windows.setClickThrough(item.checked) },
                { label: '桌宠设置…', click: () => ctx.controls.openSettings() },
            ],
        }];
    }

    /** 在桌宠身上右键：菜单里的助手列表、心情、朗读和换装都要先读一遍。 */
    async function showContextMenu(pet) {
        ctx.motion.stopWalk(pet);
        const [agents, mood, voiceItem, outfits] = await Promise.all([
            ctx.listAgents().catch(() => []), readMood(pet.agentId), ctx.voice.menuItem(pet), ctx.listAgentOutfits(pet.agentId).catch(() => []),
        ]);
        // 读助手列表期间桌宠可能已经被关掉了。
        if (pet.win.isDestroyed()) return;
        pet.outfits = outfits.map(outfitSummary);
        Menu.buildFromTemplate([
            { label: moodMenuLabel(mood), enabled: false },
            { type: 'separator' },
            { label: '和 TA 说话', click: () => ctx.commands.openInput(pet, {}) },
            {
                label: '切换助手',
                enabled: agents.length > 1,
                submenu: agents.map((agent) => ({
                    label: agent.label,
                    type: 'radio',
                    checked: agent.id === pet.agentId,
                    click: () => ctx.commands.switchPet(pet.agentId, agent.id).catch((error) => console.warn('[DeskPet] switch failed:', error.message)),
                })),
            },
            { label: '换装', enabled: outfits.length > 1, submenu: outfitMenu(pet, outfits) },
            voiceItem,
            { label: '打开主窗口', click: ctx.bridge.openMainWindow },
            { type: 'separator' },
            { label: '大小', submenu: scaleMenu(pet) },
            { label: '透明度', submenu: opacityMenu() },
            {
                label: '免打扰',
                type: 'checkbox',
                checked: ctx.controls?.get().doNotDisturb === true,
                click: (item) => ctx.sizing.setDoNotDisturb(item.checked),
            },
            {
                label: '在桌面上溜达',
                type: 'checkbox',
                checked: ctx.controls?.get().wander === true,
                click: (item) => ctx.controls?.update({ wander: item.checked }),
            },
            // 打开后点不到桌宠了：从托盘或快捷键关
            { label: '只看不点（鼠标穿透）', click: () => ctx.windows.setClickThrough(true) },
            { label: '桌宠设置…', click: () => ctx.controls?.openSettings() },
            { type: 'separator' },
            {
                label: '隐藏桌宠',
                click: () => {
                    if (pet.win.isDestroyed()) return;
                    pet.yielded = false;
                    pet.win.hide();
                    ctx.notifyMain(pet.agentId);
                    ctx.refreshTray();
                },
            },
            { label: '关闭桌宠', click: () => ctx.windows.closePet(pet.agentId) },
        ]).popup({ window: pet.win });
    }

    return { outfitMenu, opacityMenu, scaleMenu, trayMenuItems, showContextMenu, readMood };
}

module.exports = { createPetMenus, MOOD_LABEL, moodMenuLabel, readMood };
