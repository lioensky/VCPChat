// modules/deskpet/petSizing.js
// 桌宠多大、多透明、穿不穿透这些设置：推给页面的那份 prefs，按长宽比和缩放改窗口，
// 以及换装（换一套形象、顺带换窗口比例）。

const petPrefs = require('./petPrefs');
const outfitStore = require('./outfits');
const { isAgentId } = require('./petAssets');
const { rememberFigure, savedAspect } = require('./petState');

// 页面要的设置（prefsFor）和托盘上显示的设置：这些变了才推给页面、才刷新托盘
const PAGE_PREF_KEYS = ['doNotDisturb', 'clickThrough', 'shortcuts', 'opacity', 'wander', 'followCursor', 'animationSpeed', 'musicDance'];
const TRAY_KEYS = ['doNotDisturb', 'clickThrough', 'shortcuts', 'openAgents', 'lastAgent'];

function createPetSizing(ctx) {
    const { pets } = ctx;

    function sendPrefs(pet) {
        if (!pet || pet.win.isDestroyed()) return;
        pet.win.webContents.send('deskpet:prefs', prefsFor(pet));
    }

    function prefsFor(pet) {
        const settings = ctx.controls?.get() || petPrefs.DEFAULT_SETTINGS;
        const key = settings.shortcuts?.clickThrough || '';
        return {
            scale: pet.scale,
            doNotDisturb: settings.doNotDisturb,
            clickThrough: settings.clickThrough === true,
            opacity: settings.opacity ?? 1,
            wander: settings.wander === true,
            followCursor: settings.followCursor !== false,
            animationSpeed: settings.animationSpeed || 'normal',
            musicDance: settings.musicDance !== false,
            // 页面提示里写怎么关：按平台写成 Ctrl / Cmd
            clickThroughKey: key.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
        };
    }

    /**
     * 换了长宽比（换装、页面量出了形象的实际比例）后按新比例改窗口：脚底中点不动，大小档位不变，
     * 新比例在这块屏上放不下时缩到放得下。
     */
    function applyAspect(pet, aspect, kind = pet?.kind) {
        if (!pet || pet.win.isDestroyed()) return false;
        const { geometry, motion } = ctx;
        const previous = { ...pet.win.getBounds(), ...geometry.sizeOf(pet) };
        const area = geometry.workAreaAt(previous);
        pet.aspect = aspect;
        pet.kind = kind;
        pet.scale = petPrefs.fitScale(pet.scale, area, aspect, kind);
        const size = geometry.sizeOf(pet);
        if (size.width === previous.width && size.height === previous.height) return false;
        const target = petPrefs.resizeAnchored(previous, size, area);
        motion.untuck(pet);
        geometry.applyBounds(pet, target);
        resetShape(pet);
        sendPrefs(pet);
        ctx.savePetState(pet.agentId, { x: target.x, y: target.y, scale: pet.scale, tuck: null });
        return true;
    }

    /** 页面量出了当前这套形象的长宽比（不透明像素的包围盒，高 ÷ 宽）。 */
    async function onFigureMeasured(pet, report) {
        const measured = petPrefs.normalizeAspect(report?.aspect);
        if (!measured || !pet.outfit || report?.outfit !== pet.outfit || pet.win.isDestroyed()) return;
        const saved = (await ctx.readPetState())[pet.agentId];
        const known = savedAspect(saved, pet.outfit);
        // 和记着的差不多就沿用记着的：量的时候正呼吸、做动作，每次差一点，窗口不该跟着变
        const aspect = known && petPrefs.sameAspect(measured, known) ? known : measured;
        if (known !== aspect) ctx.savePetState(pet.agentId, { figures: rememberFigure(saved, pet.outfit, aspect) });
        // 拖着的时候不改窗口，放下以后下次量到再改
        if (pet.drag || pet.win.isDestroyed() || report.outfit !== pet.outfit) return;
        if (pet.aspect !== null && petPrefs.sameAspect(aspect, pet.aspect)) return;
        applyAspect(pet, aspect);
        ctx.controls?.refreshSettings();
    }

    /** 换装：记住这次的选择，按这套的比例改窗口（脚底不动），再重新载入页面换上新形象。 */
    async function setPetOutfit(agentId, outfitId) {
        const pet = pets.get(agentId);
        if (!pet || pet.win.isDestroyed() || !outfitStore.isOutfitId(outfitId)) return false;
        const outfit = (await ctx.listAgentOutfits(agentId).catch(() => [])).find((o) => o.id === outfitId);
        if (!outfit || pet.win.isDestroyed()) return false;
        if (pet.outfit === outfitId) return true;
        ctx.motion.stopDrag(pet, { save: true });
        pet.outfit = outfitId;
        const saved = (await ctx.readPetState())[agentId];
        await ctx.savePetState(agentId, { outfit: outfitId });
        if (pet.win.isDestroyed() || pet.outfit !== outfitId) return false;
        // 没量过的形象先按默认比例开，页面量完会再报上来
        applyAspect(pet, savedAspect(saved, outfitId), outfit.kind);
        pet.win.webContents.reload();
        ctx.controls?.refreshSettings();
        return true;
    }

    /** 改一个桌宠的大小：脚底不动，放不下就缩到当前屏放得下。 */
    function setPetScale(agentId, scale) {
        const pet = pets.get(agentId);
        if (!pet && isAgentId(agentId)) {
            // 没开着的桌宠（设置页里调的）：记下来，下次按它开
            const next = petPrefs.clampScale(scale);
            ctx.savePetState(agentId, { scale: next }).then(() => ctx.controls?.refreshSettings());
            return next;
        }
        if (!pet || pet.win.isDestroyed() || pet.drag) return null;
        const { geometry, motion } = ctx;
        const bounds = pet.win.getBounds();
        const area = geometry.workAreaAt(bounds);
        const next = petPrefs.fitScale(scale, area, pet.aspect, pet.kind);
        if (next === pet.scale) return pet.scale;
        // 脚底位置按算出来的旧宽高定，不用读回来的（系统可能多算了一两个像素）
        const previous = { ...bounds, ...geometry.sizeOf(pet) };
        pet.scale = next;
        const target = petPrefs.resizeAnchored(previous, geometry.sizeOf(pet), area);
        motion.untuck(pet);
        geometry.applyBounds(pet, target);
        resetShape(pet);
        sendPrefs(pet);
        ctx.savePetState(agentId, { x: target.x, y: target.y, scale: next, tuck: null });
        ctx.controls?.refreshSettings();
        return next;
    }

    function stepPetScale(agentId, direction) {
        const pet = pets.get(agentId);
        if (!pet) return null;
        return setPetScale(agentId, pet.scale + Math.sign(direction) * petPrefs.SCALE_STEP);
    }

    // Linux 的输入区按旧窗口算的，换大小后让页面重新报一次
    function resetShape(pet) {
        pet.lastShape = '';
    }

    function setDoNotDisturb(on) {
        ctx.controls?.update({ doNotDisturb: !!on });
    }

    function broadcastPrefs() {
        for (const pet of pets.values()) sendPrefs(pet);
    }

    return {
        sendPrefs,
        prefsFor,
        applyAspect,
        onFigureMeasured,
        setPetOutfit,
        setPetScale,
        stepPetScale,
        resetShape,
        setDoNotDisturb,
        broadcastPrefs,
    };
}

module.exports = { createPetSizing, PAGE_PREF_KEYS, TRAY_KEYS };
