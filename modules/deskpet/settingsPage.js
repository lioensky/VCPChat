// modules/deskpet/settingsPage.js
// 主窗口「全局设置 → 桌宠」分区的主进程部分：列出某个助手的几套形象（带快照）、选一套就让桌宠换上、
// 「无」就收起这个助手的桌宠、显示/隐藏、导入形象、打开形象文件夹、在预览里直接跟 TA 说话。
// 全局开关和快捷键仍在 petControls.js；窗口本身仍归 deskPetHandlers.js，这里通过 pets 回调去动。
//
// 只认主窗口发来的请求（controls.fromSettings）。

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');
const outfitStore = require('./outfits');
const petPrefs = require('./petPrefs');
const cubismCore = require('./cubismCore');
const expressionProfile = require('./expressionProfile');
const zipImport = require('./zipImport');

const KIND_LABEL = { live2d: 'Live2D', puppet: '网格立绘', portrait: '立绘' };
const IMPORT_MAX_FILES = 400;
const IMPORT_MAX_BYTES = 300 * 1024 * 1024;
const IMAGE_FILTER = outfitStore.IMAGE_EXTENSIONS;

/** 导入：选中的文件决定拷什么。模型文件拷它所在的文件夹；图片拷这几张图。 */
function planImport(files) {
    const zip = files.find((file) => /\.zip$/i.test(file));
    if (zip) return { kind: 'zip', source: zip, name: path.basename(zip, path.extname(zip)) };
    const model = files.find((file) => /\.(model3|puppet)\.json$/i.test(file));
    if (model) return { kind: 'folder', source: path.dirname(model), name: path.basename(path.dirname(model)) };
    const images = files.filter((file) => IMAGE_FILTER.includes(path.extname(file).slice(1).toLowerCase()));
    if (!images.length) return null;
    return { kind: 'images', files: images, name: path.basename(images[0], path.extname(images[0])) };
}

async function folderSize(dir, limit) {
    let files = 0;
    let bytes = 0;
    const walk = async (current, depth) => {
        if (depth > 6 || files > limit.files || bytes > limit.bytes) return;
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) await walk(full, depth + 1);
            else if (entry.isFile()) {
                files += 1;
                bytes += (await fs.stat(full)).size;
            }
            if (files > limit.files || bytes > limit.bytes) return;
        }
    };
    await walk(dir, 0);
    return { files, bytes };
}

/** 文件夹名：去掉路径里不能用的字符，重名时加 -2、-3。 */
async function freeFolderName(base, wanted) {
    const clean = String(wanted || '形象').replace(/[\\/:*?"<>|.]+/g, ' ').trim().slice(0, 40) || '形象';
    let name = clean;
    for (let i = 2; await fs.pathExists(path.join(base, name)); i += 1) name = `${clean}-${i}`;
    return name;
}

function createSettingsPage({ electron, paths, controls, previews, pets, core }) {
    const { ipcMain, dialog, shell } = electron;
    const agentRoot = (agentId) => path.join(paths.agentDir, agentId);

    async function agentName(agentId) {
        try {
            const config = await fs.readJson(path.join(agentRoot(agentId), 'config.json'));
            return config?.name || agentId;
        } catch {
            return agentId;
        }
    }

    async function avatarUrl(agentId) {
        const files = await fs.readdir(agentRoot(agentId)).catch(() => []);
        const file = IMAGE_FILTER.map((ext) => `avatar.${ext}`).map((wanted) => files.find((f) => f.toLowerCase() === wanted)).find(Boolean);
        return file ? pathToFileURL(path.join(agentRoot(agentId), file)).href : null;
    }

    /** 没指定助手时打开哪一个：最近碰过的桌宠、开着的、上次开的、有形象的、第一个。 */
    async function defaultAgent(agents) {
        const settings = controls.get();
        // 最近用过的排在开着的前面：几个桌宠都开着时，打开的是刚刚在用的那个
        const candidates = [pets.lastTouched(), settings.lastAgent, ...pets.openAgents(), ...settings.openAgents].filter(Boolean);
        const known = new Set(agents.map((a) => a.id));
        const hit = candidates.find((id) => known.has(id));
        if (hit) return hit;
        for (const agent of agents) {
            if (await fs.pathExists(path.join(agentRoot(agent.id), 'deskpet'))) return agent.id;
        }
        return agents[0]?.id || null;
    }

    /** 一个助手的设置页数据；没有现成快照的形象在后台渲染，渲染好一张推一张（deskpet-settings:preview）。 */
    async function catalog(requestedId, { force = false } = {}) {
        const agents = await pets.listAgents();
        const agentId = agents.some((a) => a.id === requestedId) ? requestedId : await defaultAgent(agents);
        const coreStatus = await core.status().catch(() => null);
        if (!agentId) return { agents, agentId: null, outfits: [], core: coreStatus };
        const [outfits, saved, name, avatar] = await Promise.all([
            pets.listOutfits(agentId).catch(() => []),
            pets.readState(agentId),
            agentName(agentId),
            avatarUrl(agentId),
        ]);
        const live = pets.info(agentId);
        const chosen = live?.outfit || outfitStore.pickOutfit(outfits, saved?.outfit)?.id || null;
        const items = await Promise.all(outfits.map(async (outfit) => ({
            id: outfit.id,
            name: outfit.name,
            kind: outfit.kind,
            kindLabel: [outfit.builtIn ? '内置' : '', KIND_LABEL[outfit.kind] || ''].filter(Boolean).join(' · '),
            builtIn: outfit.builtIn === true,
            description: outfitStore.outfitDescription(outfit),
            missingCore: outfit.missingCore === true,
            needsCore: outfit.needsCore === true,
            hasModel: Boolean(outfit.live2d),
            preview: force ? null : await previews.cached(agentId, outfit),
        })));
        const pending = outfits.filter((outfit, i) => !items[i].preview);
        // 当前这套排最前面，大预览先出来
        pending.sort((a, b) => (b.id === chosen) - (a.id === chosen));
        for (const outfit of pending) {
            const aspect = saved?.figures?.[outfit.id] ?? null;
            previews.render(agentId, outfit, { aspect }).then((url) => {
                pets.sendPreview({ agentId, outfitId: outfit.id, url });
            }).catch(() => {});
        }
        previews.prune(agentId, outfits.map((o) => o.id)).catch(() => {});
        const scale = live?.scale ?? petPrefs.savedScale(saved);
        return {
            agents,
            agentId,
            name,
            avatar,
            open: Boolean(live),
            visible: Boolean(live?.visible),
            anyVisible: pets.openAgents().length > 0,
            // 关着的桌宠选中的是「无」；lastOutfit 是再打开时会穿的那套
            outfit: live ? chosen : null,
            lastOutfit: chosen,
            outfits: items,
            scale,
            maxScale: live?.maxScale ?? petPrefs.SCALE_MAX,
            folder: path.join(agentRoot(agentId), 'deskpet'),
            core: coreStatus,
        };
    }

    /** 选一张卡片：outfitId 为空是「无」，收起这个助手的桌宠；否则打开（没开的话）并换上那套。 */
    async function choose(agentId, outfitId) {
        if (!pets.isAgentId(agentId)) return { success: false, error: '找不到这个助手' };
        if (!outfitId) {
            pets.closePet(agentId);
            return { success: true };
        }
        if (!outfitStore.isOutfitId(outfitId)) return { success: false, error: '没有这套形象' };
        // 文件夹刚被删掉、或者超过了能列出来的套数：照实说换不上，不要假装已经换好
        const outfits = await pets.listOutfits(agentId).catch(() => []);
        if (!outfits.some((outfit) => outfit.id === outfitId)) return { success: false, error: '没找到这套形象（文件夹可能被删了，或者形象太多没列出来）' };
        if (pets.info(agentId)) {
            const switched = await pets.setOutfit(agentId, outfitId);
            if (!switched) return { success: false, error: '没换成' };
            pets.showPet(agentId);
        } else {
            // 先记下选择，打开时直接按这套开（省一次换装重载）
            await pets.saveState(agentId, { outfit: outfitId });
            const opened = await pets.openPet(agentId);
            if (!opened?.success) return { success: false, error: opened?.error === 'agent-not-found' ? '找不到这个助手' : '桌宠打不开' };
        }
        return { success: true };
    }

    // 拖到设置页上的文件：只收本机上存在的绝对路径；拖进来一个文件夹就当模型文件夹
    async function droppedPlan(files) {
        const list = files.filter((file) => typeof file === 'string' && path.isAbsolute(file)).slice(0, IMPORT_MAX_FILES);
        const existing = [];
        for (const file of list) {
            const stat = await fs.stat(file).catch(() => null);
            if (stat?.isDirectory() && list.length === 1) return { kind: 'folder', source: file, name: path.basename(file) };
            if (stat?.isFile()) existing.push(file);
        }
        return planImport(existing);
    }

    async function importOutfit(agentId, dropped = null) {
        if (!pets.isAgentId(agentId)) return { success: false, error: '找不到这个助手' };
        if (Array.isArray(dropped)) return copyOutfit(agentId, await droppedPlan(dropped));
        const picked = await dialog.showOpenDialog(pets.mainWindow() || undefined, {
            title: '导入形象：选 Live2D 模型（.model3.json 或整个 .zip 压缩包）、网格立绘（.puppet.json），或者一张/几张立绘图片',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: '形象', extensions: ['json', 'zip', ...IMAGE_FILTER] },
                { name: '所有文件', extensions: ['*'] },
            ],
        });
        if (picked.canceled || !picked.filePaths?.length) return { success: false, canceled: true };
        return copyOutfit(agentId, planImport(picked.filePaths));
    }

    async function copyOutfit(agentId, plan) {
        if (!plan) return { success: false, error: '没认出来：请选 .model3.json、.puppet.json、.zip、图片，或者模型所在的文件夹' };
        const base = path.join(agentRoot(agentId), 'deskpet');
        if (plan.kind === 'folder') {
            // 模型放在「下载」这种大文件夹里时，别把整个文件夹拷过去
            const size = await folderSize(plan.source, { files: IMPORT_MAX_FILES, bytes: IMPORT_MAX_BYTES });
            if (size.files > IMPORT_MAX_FILES || size.bytes > IMPORT_MAX_BYTES) {
                return { success: false, error: '模型所在的文件夹太大了（会把整个文件夹拷进来）。先把模型单独放进一个文件夹再导入' };
            }
            // 选的就在形象文件夹里（或者是它的上级）：拷进自己会出错
            const source = path.resolve(plan.source);
            const target = path.resolve(base);
            if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep)) return { success: false, error: '这套已经在形象文件夹里了' };
        }
        const name = await freeFolderName(base, plan.name);
        const target = path.join(base, name);
        try {
            if (plan.kind === 'folder') await fs.copy(plan.source, target);
            else if (plan.kind === 'zip') {
                if ((await fs.stat(plan.source)).size > IMPORT_MAX_BYTES) return { success: false, error: '压缩包太大了，先解压出模型所在的文件夹再导入' };
                const unpacked = await zipImport.extractOutfitZip(await fs.readFile(plan.source), target, {
                    limits: { files: IMPORT_MAX_FILES, bytes: IMPORT_MAX_BYTES },
                    imageExtensions: IMAGE_FILTER,
                });
                if (!unpacked.success) return unpacked;
            } else {
                await fs.ensureDir(target);
                for (const file of plan.files) await fs.copy(file, path.join(target, path.basename(file)));
            }
            if (!(await fs.pathExists(path.join(target, 'outfit.json')))) await fs.writeJson(path.join(target, 'outfit.json'), { name }, { spaces: 2 });
            if (!(await outfitStore.inspectFolder(target))) {
                await fs.remove(target);
                return { success: false, error: '这个文件夹里没找到能用的模型或立绘' };
            }
        } catch (error) {
            await fs.remove(target).catch(() => {});
            return { success: false, error: `拷贝失败：${error.message}` };
        }
        return { success: true, outfitId: name };
    }

    /** Cubism Core：从 Live2D 官网下载，或选本地的 SDK 压缩包 / Core 文件。装好后让用着 Live2D 形象的桌宠重新载入。 */
    async function installCore(source) {
        let result;
        if (source === 'file') {
            const picked = await dialog.showOpenDialog(pets.mainWindow() || undefined, {
                title: '选 Cubism SDK for Web 的压缩包，或者其中的 Core/live2dcubismcore.min.js',
                properties: ['openFile'],
                filters: [
                    { name: 'Cubism SDK 或 Core', extensions: ['zip', 'js'] },
                    { name: '所有文件', extensions: ['*'] },
                ],
            });
            if (picked.canceled || !picked.filePaths?.length) return { success: false, canceled: true };
            result = await core.installFromFile(picked.filePaths[0]);
        } else {
            result = await core.installOfficial();
        }
        if (result.success) await core.afterInstall().catch((error) => console.warn('[DeskPet] reload after Core install failed:', error.message));
        return result;
    }

    /** 表情映射：这套 Live2D 有哪些表情和动作、deskpet.json 里写了什么。内置形象在应用目录里，只能看不能改。 */
    async function mappingTarget(agentId, outfitId) {
        if (!pets.isAgentId(agentId) || !outfitStore.isOutfitId(outfitId)) return null;
        const outfit = (await pets.listOutfits(agentId).catch(() => [])).find((o) => o.id === outfitId);
        return outfit?.live2d ? outfit : null;
    }

    async function getMapping(agentId, outfitId) {
        const outfit = await mappingTarget(agentId, outfitId);
        if (!outfit) return { success: false, error: '这套不是 Live2D 模型' };
        try {
            const { names, groups } = await expressionProfile.readModelCatalog(outfit.live2d);
            return {
                success: true,
                outfitId,
                name: outfit.name,
                editable: outfit.builtIn !== true,
                modelFile: path.basename(outfit.live2d),
                names,
                groups,
                profile: await expressionProfile.readProfile(outfit.live2d),
                showing: pets.info(agentId)?.outfit === outfitId,
            };
        } catch (error) {
            return { success: false, error: `读不了模型文件：${error.message}` };
        }
    }

    /** 试一下（save=false）或保存（save=true）：桌宠正穿着这套时马上换上新映射，emotion 给了就演一下。 */
    async function applyMapping(agentId, outfitId, mapping, { save = false, emotion = null } = {}) {
        const outfit = await mappingTarget(agentId, outfitId);
        if (!outfit) return { success: false, error: '这套不是 Live2D 模型' };
        if (save && outfit.builtIn) return { success: false, error: '内置形象不能改映射' };
        const catalogOfModel = await expressionProfile.readModelCatalog(outfit.live2d);
        const profile = expressionProfile.mergeProfile(await expressionProfile.readProfile(outfit.live2d), mapping, catalogOfModel);
        if (save) await expressionProfile.writeProfile(outfit.live2d, profile);
        // 试一下：情绪名，或 tap:head / tap:body（点头、点身体的绑定）
        const tap = typeof emotion === 'string' && emotion.startsWith('tap:') && expressionProfile.TAP_KEYS.includes(emotion.slice(4)) ? emotion.slice(4) : null;
        const wanted = expressionProfile.EMOTION_KEYS.includes(emotion) ? emotion : null;
        const showing = pets.info(agentId)?.outfit === outfitId && pets.pushProfile(agentId, { profile, emotion: wanted, ...(tap ? { tap } : {}) });
        return { success: true, showing: Boolean(showing), profile };
    }

    async function openFolder(agentId) {
        if (!pets.isAgentId(agentId)) return { success: false };
        const dir = path.join(agentRoot(agentId), 'deskpet');
        await fs.ensureDir(dir);
        const error = await shell.openPath(dir);
        return { success: !error, error: error || undefined };
    }

    function registerIpc() {
        // 不是主窗口发来的一律不理
        const guard = (fn) => (event, ...args) => (controls.fromSettings(event) ? fn(...args) : null);
        const idOrNull = (agentId) => (typeof agentId === 'string' ? agentId : null);
        ipcMain.handle('deskpet-settings:get', guard(() => controls.snapshot()));
        ipcMain.handle('deskpet-settings:catalog', guard((agentId) => catalog(idOrNull(agentId))));
        ipcMain.handle('deskpet-settings:refresh', guard((agentId) => catalog(idOrNull(agentId), { force: true })));
        ipcMain.handle('deskpet-settings:choose', guard(async (agentId, outfitId) => {
            const result = await choose(String(agentId || ''), typeof outfitId === 'string' ? outfitId : '');
            return { ...result, catalog: await catalog(String(agentId || '')) };
        }));
        ipcMain.handle('deskpet-settings:set-visible', guard(async (visible, agentId) => {
            await pets.setVisible(visible === true, idOrNull(agentId));
            return catalog(idOrNull(agentId));
        }));
        ipcMain.handle('deskpet-settings:import', guard(async (agentId, files) => {
            let result = await importOutfit(String(agentId || ''), Array.isArray(files) ? files : null);
            if (result.success) {
                const chosen = await choose(String(agentId), result.outfitId);
                // 拷进来了但没换上（比如形象太多没列出来）：别说「已经换上」
                if (!chosen.success) result = { success: false, error: `导入好了，但没换上：${chosen.error}` };
            }
            return { ...result, catalog: await catalog(String(agentId || '')) };
        }));
        ipcMain.handle('deskpet-settings:open-folder', guard((agentId) => openFolder(String(agentId || ''))));
        ipcMain.handle('deskpet-settings:core-install', guard(async (source, agentId) => {
            const result = await installCore(source === 'file' ? 'file' : 'official');
            return { ...result, catalog: await catalog(idOrNull(agentId)) };
        }));
        ipcMain.handle('deskpet-settings:core-link', guard((which) => {
            const url = cubismCore.LINKS[which === 'download' ? 'download' : 'license'];
            return shell.openExternal(url).then(() => true, () => false);
        }));
        ipcMain.handle('deskpet-settings:mapping', guard((agentId, outfitId) => getMapping(String(agentId || ''), String(outfitId || ''))));
        ipcMain.handle('deskpet-settings:mapping-apply', guard((agentId, outfitId, mapping, options) => applyMapping(
            String(agentId || ''),
            String(outfitId || ''),
            mapping && typeof mapping === 'object' ? mapping : {},
            { save: options?.save === true, emotion: typeof options?.emotion === 'string' ? options.emotion : null },
        ).catch((error) => ({ success: false, error: error.message }))));
        ipcMain.handle('deskpet-settings:talk', guard(async (agentId, text, options) => {
            const message = typeof text === 'string' ? text.trim().slice(0, 8000) : '';
            if (!message) return { success: false, error: '没有内容' };
            return pets.talk(String(agentId || ''), message, { newTopic: options?.newTopic === true });
        }));
    }

    return { catalog, choose, importOutfit, registerIpc };
}

module.exports = { createSettingsPage, planImport };
