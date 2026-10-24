// modules/deskpet/petMenus.js
// 两个菜单：在桌宠身上右键的那个（换装、朗读、免打扰、设置、隐藏）和托盘里的「桌宠」那一项；
// 外加读持续心情（页面要用）。

const outfitStore = require('./outfits');
const { outfitSummary } = require('./petAssets');
const { getAgentMoodStore } = require('../agentMood');

// ---- 持续心情 ----------------------------------------------------------------

async function readMood(agentId) {
    try {
        return (await getAgentMoodStore()?.get(agentId)) ?? null;
    } catch (_error) {
        return null;
    }
}

function createPetMenus(ctx) {
    const { pets } = ctx;
    const { Menu, nativeImage } = ctx.electron;
    let nameIcon;

    // 原生菜单图标位与勾选标记共用左侧栏；透明位图绘制四角星，不依赖字体或 SVG 解码。
    function getNameIcon() {
        if (nameIcon) return nameIcon;
        const size = 16;
        const pixels = Buffer.alloc(size * size * 4);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = Math.abs(x - 7.5);
                const dy = Math.abs(y - 7.5);
                const alpha = Math.max(0, Math.min(1, 7.5 - dx - dy - 2 * Math.min(dx, dy)));
                const offset = (y * size + x) * 4;
                // BGRA，暖金色；预乘透明度，避免边缘产生暗边。
                pixels[offset] = Math.round(55 * alpha);
                pixels[offset + 1] = Math.round(163 * alpha);
                pixels[offset + 2] = Math.round(224 * alpha);
                pixels[offset + 3] = Math.round(255 * alpha);
            }
        }
        nameIcon = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
        return nameIcon;
    }

    function outfitMenu(pet, outfits) {
        return outfits.map((outfit) => ({
            label: outfitStore.outfitLabel(outfit),
            type: 'radio',
            checked: outfit.id === pet.outfit,
            click: () => ctx.sizing.setPetOutfit(pet.agentId, outfit.id).catch((error) => console.warn('[DeskPet] outfit switch failed:', error.message)),
        }));
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

    /**
     * 在桌宠身上右键：只放常用的几项。说话、语音在胶囊上；切换助手、大小、透明度、溜达、只看不点在设置里
     * （大小还有 Ctrl+滚轮，只看不点还有托盘），心情看脸上。
     */
    async function showContextMenu(pet) {
        ctx.motion.stopWalk(pet);
        const [voiceItem, outfits, agents] = await Promise.all([
            ctx.voice.menuItem(pet),
            ctx.listAgentOutfits(pet.agentId).catch(() => []),
            ctx.listAgents().catch(() => []),
        ]);
        const agent = agents.find((item) => item.id === pet.agentId);
        // 读换装列表期间桌宠可能已经被关掉了。
        if (pet.win.isDestroyed()) return;
        pet.outfits = outfits.map(outfitSummary);
        Menu.buildFromTemplate([
            { label: agent?.name || '未知助手', icon: getNameIcon(), enabled: true, click: () => {} },
            { type: 'separator' },
            { label: '换装', enabled: outfits.length > 1, submenu: outfitMenu(pet, outfits) },
            voiceItem,
            {
                label: '免打扰',
                type: 'checkbox',
                checked: ctx.controls?.get().doNotDisturb === true,
                click: (item) => ctx.sizing.setDoNotDisturb(item.checked),
            },
            { type: 'separator' },
            { label: '设置…', click: () => ctx.controls?.openSettings() },
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
        ]).popup({ window: pet.win });
    }

    return { outfitMenu, trayMenuItems, showContextMenu, readMood };
}

module.exports = { createPetMenus, readMood };
