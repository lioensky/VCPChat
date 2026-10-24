// modules/deskpet/petCommands.js
// 快捷键、托盘和设置页按一下就做的那些事：全部显示隐藏、和桌宠说话、换个助手上场、
// 设置页里的「显示 / 隐藏桌宠」和桌宠列表。

const petPrefs = require('./petPrefs');
const { isAgentId } = require('./petAssets');

function createPetCommands(ctx) {
    const { pets } = ctx;

    /** 快捷键「显示/隐藏桌宠」：有露着的就全部收起；都收着就全部叫回来；一个都没开就打开上次那个。 */
    async function toggleAllPets() {
        const { windows } = ctx;
        const live = [...pets.values()].filter((pet) => !pet.win.isDestroyed());
        const visible = live.filter((pet) => pet.win.isVisible());
        if (visible.length) {
            for (const pet of visible) pet.win.hide();
            for (const pet of live) pet.yielded = false;
        } else if (live.length) {
            for (const pet of live) windows.showPet(pet);
        } else {
            const settings = ctx.controls?.get();
            let candidates = [...new Set([...(settings?.openAgents || []), settings?.lastAgent].filter(Boolean))];
            // 第一次按：还没开过桌宠。有叫 Nova 的助手就请出内置 Nova；没有就打开设置页的桌宠分区，告诉 TA 从哪开始
            if (!candidates.length) {
                const nova = (await ctx.listAgents()).find((agent) => agent.name.trim().toLowerCase() === 'nova');
                if (nova) candidates = [nova.id];
            }
            for (const agentId of candidates.slice(0, 1)) await windows.openPet(agentId);
            if (!pets.size) ctx.bridge.openSettingsPage();
        }
        for (const pet of live) ctx.notifyMain(pet.agentId);
        ctx.refreshTray();
    }

    /** 快捷键「和桌宠说话」：叫出最近用过的那个桌宠并打开输入框；输入框已经开着就收起。
     *  语音那个键（voice）：开始录音；正在录就停下、识别完直接发。 */
    async function talkToPet({ voice = false } = {}) {
        let pet = (ctx.lastTouched && pets.get(ctx.lastTouched)) || [...pets.values()].find((p) => !p.win.isDestroyed() && p.win.isVisible())
            || [...pets.values()].find((p) => !p.win.isDestroyed());
        if (!pet) {
            await toggleAllPets();
            pet = [...pets.values()][0];
            if (!pet) return;
        }
        if (!pet.win.isVisible()) {
            ctx.windows.showPet(pet);
            ctx.notifyMain(pet.agentId);
        }
        ctx.lastTouched = pet.agentId;
        openInput(pet, voice ? { voice: true } : { toggle: true });
    }

    // 刚打开的桌宠页面还没准备好（形象还在载入）时先记着，页面报 ready 以后再弹输入框
    function openInput(pet, options) {
        if (pet.win.isDestroyed()) return;
        ctx.motion.stopWalk(pet);
        if (pet.ready) pet.win.webContents.send('deskpet:open-input', options);
        else pet.pendingToggle = options;
    }

    /** 在同一个位置把桌宠换成另一个 agent（各自保留自己的大小，脚底对齐）。 */
    async function switchPet(fromId, toId) {
        const { geometry, windows } = ctx;
        const pet = pets.get(fromId);
        if (!pet || fromId === toId) return;
        const anchor = pet.win.getBounds();
        if (pets.has(toId)) {
            const target = pets.get(toId);
            geometry.applyBounds(target, petPrefs.resizeAnchored(anchor, geometry.sizeOf(target), geometry.workAreaAt(anchor)));
            windows.showPet(target);
        } else {
            const opened = await windows.openPet(toId, { anchor });
            // 换不过去（助手刚被删掉）就留着原来的桌宠，不要两边都没了。
            if (!opened?.success) return;
        }
        windows.closePet(fromId);
        const moved = pets.get(toId);
        if (moved && !moved.win.isDestroyed()) ctx.savePetPosition(toId, moved.win.getPosition());
    }

    /** 设置页预览里输入的话：叫出这个助手的桌宠（没开就打开），由桌宠发出去，回复显示在桌宠头上。 */
    async function talkFromSettings(agentId, text, { newTopic = false } = {}) {
        const { windows } = ctx;
        if (!pets.has(agentId)) {
            const opened = await windows.openPet(agentId);
            if (!opened?.success) return { success: false, error: '桌宠打不开' };
        }
        const pet = pets.get(agentId);
        if (!pet || pet.win.isDestroyed()) return { success: false, error: '桌宠打不开' };
        if (!pet.win.isVisible()) windows.showPet(pet);
        ctx.lastTouched = agentId;
        ctx.notifyMain(agentId);
        // 交到桌宠页面手里才算发出：页面没起来（启动失败、被关）就照实告诉设置页
        try {
            await windows.whenPageReady(pet);
        } catch (error) {
            return { success: false, error: error.message };
        }
        if (pet.win.isDestroyed()) return { success: false, error: '桌宠已经关了' };
        pet.win.webContents.send('deskpet:open-input', { submit: text, newTopic });
        return { success: true };
    }

    /** 设置页的「显示 / 隐藏桌宠」。显示时一个都没开就打开设置页里正在看的那个助手。 */
    async function setPetsVisible(visible, agentId) {
        const { windows } = ctx;
        const live = [...pets.values()].filter((pet) => !pet.win.isDestroyed());
        if (!visible) {
            for (const pet of live) {
                pet.yielded = false;
                if (pet.win.isVisible()) pet.win.hide();
            }
        } else if (live.length) {
            for (const pet of live) windows.showPet(pet);
        } else if (agentId && isAgentId(agentId)) {
            await windows.openPet(agentId);
        } else {
            await toggleAllPets();
        }
        for (const pet of live) ctx.notifyMain(pet.agentId);
        ctx.refreshTray();
    }

    function listPetsForSettings() {
        return [...pets.values()].filter((pet) => !pet.win.isDestroyed()).map((pet) => ({
            agentId: pet.agentId,
            name: pet.name || pet.agentId,
            scale: pet.scale,
            maxScale: petPrefs.maxScaleForWorkArea(ctx.geometry.workAreaAt(pet.win.getBounds()), pet.aspect, pet.kind),
            visible: pet.win.isVisible(),
            outfit: pet.outfit,
            outfits: pet.outfits || [],
        }));
    }

    // 闲时搭话找谁：露着的桌宠，最近在聊的那个排前面
    function idleCandidates() {
        const visible = ctx.visibleAgents().filter((id) => {
            const pet = pets.get(id);
            return pet && !pet.win.isDestroyed() && pet.win.isVisible();
        });
        if (ctx.lastTalkedAgentId && visible.includes(ctx.lastTalkedAgentId)) return [ctx.lastTalkedAgentId, ...visible.filter((id) => id !== ctx.lastTalkedAgentId)];
        return visible;
    }

    return {
        toggleAllPets,
        talkToPet,
        openInput,
        switchPet,
        talkFromSettings,
        setPetsVisible,
        listPetsForSettings,
        idleCandidates,
    };
}

module.exports = { createPetCommands };
