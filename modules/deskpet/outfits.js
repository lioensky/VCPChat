// modules/deskpet/outfits.js
// 桌宠的「换装」：同一个助手可以有好几套形象，每套是 Agents/<id>/deskpet/ 下的一个子文件夹。
//
//   deskpet/
//     <套装文件夹>/            一套形象，文件夹名就是它的 id
//       *.model3.json          Live2D（可以在更深的子文件夹里，例如 runtime/）
//       *.puppet.json          网格立绘
//       portrait.png、portrait.happy.png …  差分立绘（也可以直接叫 happy.png）
//       随便一张 png           只有一张图时，那张就是这套的立绘
//       outfit.json            可选：{ "name": "女仆", "order": 2, "description": "设置页卡片上的一句介绍" }
//                              （也认同目录 deskpet.json 里的这几项）
//     *.model3.json / *.puppet.json / portrait.*  直接放在 deskpet/ 下的算一套「默认」（以前的单模型布局）
//
// 助手目录里给侧栏用的 portrait.*.png 也算一套「立绘」，排在最后，换回去就是平常的立绘。
// 一个文件夹里同时有 Live2D 和网格立绘时还是一套：有 Cubism Core 用 Live2D，没有就用网格立绘。
//
// 这里只读目录、不碰窗口；返回的都是绝对路径，由 deskPetHandlers 换成 vcp-deskpet:// 地址。

'use strict';

const path = require('path');
const fs = require('fs-extra');

const ROOT_ID = ':root';
const PORTRAIT_ID = ':portrait';
const IMAGE_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg', 'gif', 'avif'];
// 与 modules/emotion/emotionVocabulary.js 一致：12 个情绪键加 3 个状态键；talk 是朗读时的张嘴帧。
const PORTRAIT_KEYS = ['neutral', 'calm', 'happy', 'excited', 'shy', 'affectionate', 'curious',
    'surprised', 'concerned', 'sad', 'tired', 'angry', 'thinking', 'tool', 'error', 'talk'];
const MAX_OUTFITS = 40;
const BUILTIN_PRESETS = ['tech', 'maid', 'chibi'];
const KIND_LABEL = { live2d: 'Live2D', puppet: '网格立绘', portrait: '立绘' };

async function readDir(dir) {
    try {
        return await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

// 先找本层，再按名字顺序找子文件夹（最多往下 3 层）。
async function findBySuffix(dir, suffix, depth = 0, maxDepth = 3) {
    if (depth > maxDepth) return null;
    const entries = (await readDir(dir)).sort((a, b) => a.name.localeCompare(b.name));
    const direct = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith(suffix));
    if (direct) return path.join(dir, direct.name);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = await findBySuffix(path.join(dir, entry.name), suffix, depth + 1, maxDepth);
        if (found) return found;
    }
    return null;
}

function splitImage(name) {
    const match = /^(.+)\.([a-z0-9]+)$/i.exec(name);
    if (!match || !IMAGE_EXTENSIONS.includes(match[2].toLowerCase())) return null;
    return match[1].toLowerCase();
}

/**
 * 一个目录里的差分立绘：{ default, light?, <键>?, <键>-light? }，与侧栏立绘相同的结构，交给 resolvePortrait 挑图。
 * strict 时只认 portrait.* 这种名字（助手目录、deskpet 根目录、Live2D 文件夹里的贴图不能当立绘）；
 * 否则也认 happy.png 这种直接用情绪键起名的图，再没有就拿文件夹里第一张图当默认立绘。
 */
function collectPortraits(dir, files, { strict }) {
    const byStem = new Map();
    // 同名不同格式时按 IMAGE_EXTENSIONS 的顺序取第一个
    const images = files.filter((name) => splitImage(name) !== null)
        .sort((a, b) => IMAGE_EXTENSIONS.indexOf(a.split('.').pop().toLowerCase()) - IMAGE_EXTENSIONS.indexOf(b.split('.').pop().toLowerCase()));
    for (const name of images) {
        const stem = splitImage(name);
        if (!byStem.has(stem)) byStem.set(stem, path.join(dir, name));
    }
    const pick = (key) => byStem.get(`portrait.${key}`) || (!strict && byStem.get(key)) || null;
    const portraits = {};
    const base = byStem.get('portrait') || (!strict && byStem.get('default')) || null;
    if (base) portraits.default = base;
    const light = pick('light');
    if (light) portraits.light = light;
    for (const key of PORTRAIT_KEYS) {
        const file = pick(key);
        if (file) portraits[key] = file;
        const lightFile = pick(`${key}-light`);
        if (lightFile) portraits[`${key}-light`] = lightFile;
    }
    if (!portraits.default) {
        // 只有差分没有默认立绘时，用 neutral / calm 顶上
        const fallback = portraits.neutral || portraits.calm;
        if (fallback) portraits.default = fallback;
    }
    if (!portraits.default && !strict) {
        // 只放了一张（或几张）随便起名的图：按名字顺序第一张就是这套的立绘
        const loose = [...byStem.keys()].sort().find((stem) => !stem.startsWith('portrait.') && !PORTRAIT_KEYS.includes(stem.split('-')[0]));
        if (loose) portraits.default = byStem.get(loose);
    }
    if (!portraits.default) {
        const first = Object.values(portraits)[0];
        if (first) portraits.default = first;
    }
    return portraits.default ? portraits : null;
}

async function readOutfitInfo(dir) {
    for (const name of ['outfit.json', 'deskpet.json']) {
        try {
            const info = await fs.readJson(path.join(dir, name));
            if (info && typeof info === 'object') {
                return {
                    name: typeof info.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 40) : null,
                    order: Number.isFinite(info.order) ? info.order : null,
                    description: typeof info.description === 'string' && info.description.trim() ? info.description.trim().slice(0, 120) : null,
                };
            }
        } catch { /* 没有或写坏了就当没有 */ }
    }
    return { name: null, order: null, description: null };
}

function kindOf(outfit, hasCore) {
    if (outfit.live2d && hasCore) return 'live2d';
    if (outfit.puppet) return 'puppet';
    if (outfit.portraits) return 'portrait';
    return outfit.live2d ? 'live2d' : null;
}

/** 一个套装文件夹里有什么；什么都认不出来时返回 null。 */
async function scanFolder(dir, { root = false } = {}) {
    // deskpet 根目录只看本层：子文件夹各自是一套
    const maxDepth = root ? 0 : 3;
    const live2d = await findBySuffix(dir, '.model3.json', 0, maxDepth);
    const puppet = await findBySuffix(dir, '.puppet.json', 0, maxDepth);
    const files = (await readDir(dir)).filter((e) => e.isFile()).map((e) => e.name);
    // 有模型的文件夹里散放着贴图，只认按约定起名的立绘
    const portraits = collectPortraits(dir, files, { strict: root || Boolean(live2d || puppet) });
    if (!live2d && !puppet && !portraits) return null;
    return { live2d, puppet, portraits };
}

/**
 * 这个助手所有的形象，排好顺序：deskpet/ 根目录那套、各个文件夹（按 order 再按名字）、助手目录的立绘。
 * 每项 { id, name, kind, live2d, puppet, portraits }，kind 是实际会用的那种（live2d / puppet / portrait）。
 */
async function listOutfits(agentRoot, { hasCore = false, builtInDir = null, preferBuiltIn = false } = {}) {
    const deskpetDir = path.join(agentRoot, 'deskpet');
    const outfits = [];
    const root = await scanFolder(deskpetDir, { root: true });
    if (root) {
        const info = await readOutfitInfo(deskpetDir);
        outfits.push({ id: ROOT_ID, name: info.name || '默认', description: info.description, ...root });
    }
    const folders = (await readDir(deskpetDir)).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const found = [];
    for (const entry of folders.slice(0, MAX_OUTFITS * 2)) {
        const dir = path.join(deskpetDir, entry.name);
        const scanned = await scanFolder(dir);
        if (!scanned) continue;
        const info = await readOutfitInfo(dir);
        found.push({ id: entry.name, name: info.name || entry.name, order: info.order, description: info.description, ...scanned });
    }
    found.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id));
    for (const { order: _order, ...outfit } of found.slice(0, MAX_OUTFITS)) outfits.push(outfit);
    const agentFiles = (await readDir(agentRoot)).filter((e) => e.isFile()).map((e) => e.name);
    const agentPortraits = collectPortraits(agentRoot, agentFiles, { strict: true });
    if (agentPortraits) outfits.push({ id: PORTRAIT_ID, name: '立绘', description: null, live2d: null, puppet: null, portraits: agentPortraits });
    // Bundled Nova is read directly from the application; never copy over agent-owned files.
    // Existing custom outfits remain the default, while a new Nova gets the bundled model.
    const hasCustomOutfit = outfits.some((outfit) => outfit.id !== PORTRAIT_ID);
    if (builtInDir) {
        for (const preset of BUILTIN_PRESETS) {
            const dir = path.join(builtInDir, preset);
            const scanned = await scanFolder(dir);
            if (!scanned) continue;
            const info = await readOutfitInfo(dir);
            outfits.push({
                id: `builtin:nova-${preset}`,
                name: info.name || `Nova · ${preset}`,
                description: info.description || null,
                builtIn: true,
                preferred: preferBuiltIn && !hasCustomOutfit && preset === 'tech',
                ...scanned,
            });
        }
    }
    for (const outfit of outfits) {
        outfit.kind = kindOf(outfit, hasCore);
        // 只有 Live2D、又没放 Core：页面会提示缺 Core 并退回立绘
        outfit.missingCore = outfit.kind === 'live2d' && !hasCore;
        // 有 Live2D 模型但没 Core（不管退回的是网格立绘还是立绘）：设置页提示装 Core
        outfit.needsCore = Boolean(outfit.live2d) && !hasCore;
    }
    return outfits;
}

/**
 * 没选过（或选的那套已经删了）时用哪一套：和以前单模型时一样，有 Core 先用 Live2D，再是网格立绘，
 * 再是文件夹里的立绘（或缺 Core 的 Live2D，页面会提示），最后是助手目录的立绘。
 */
function defaultOutfit(outfits) {
    const choose = (choices) => choices.find((o) => o.kind === 'live2d' && !o.missingCore)
        || choices.find((o) => o.kind === 'puppet')
        || choices.find((o) => o.id !== PORTRAIT_ID)
        || choices[0]
        || null;
    // 内置 Nova 只给 Nova 当默认；其他助手没有自己的素材时仍显示头像，不会默认变成 Nova
    return outfits.find((o) => o.preferred)
        || choose(outfits.filter((o) => !o.builtIn));
}

function pickOutfit(outfits, wanted) {
    return (typeof wanted === 'string' && outfits.find((o) => o.id === wanted)) || defaultOutfit(outfits);
}

/** 设置页卡片上的一句介绍：outfit.json 里写了就用它，没写按种类说。 */
function outfitDescription(outfit) {
    if (outfit.description) return outfit.description;
    if (outfit.needsCore) return 'Live2D 模型。装好 Cubism Core 前先用立绘代替（见下方「Live2D 支持」）';
    if (outfit.kind === 'live2d') return 'Live2D 模型，会眨眼、跟着光标看、按情绪换表情';
    if (outfit.kind === 'puppet') return '网格立绘，一张图切块做成的，会呼吸、眨眼、对口型';
    const faces = Object.keys(outfit.portraits || {}).filter((key) => PORTRAIT_KEYS.includes(key) && key !== 'talk').length;
    return faces ? `差分立绘，${faces + 1} 张表情跟着回复换` : '一张立绘，会呼吸、歪头、打盹';
}

/** 导入时检查一个文件夹能不能当一套形象：认得出来返回 { kind }，否则 null。 */
async function inspectFolder(dir) {
    const scanned = await scanFolder(dir);
    if (!scanned) return null;
    return { kind: scanned.live2d ? 'live2d' : scanned.puppet ? 'puppet' : 'portrait' };
}

/** 菜单、设置页里显示的那一行。 */
function outfitLabel(outfit) {
    const kind = KIND_LABEL[outfit.kind];
    return kind && outfit.name !== kind ? `${outfit.name}（${kind}）` : outfit.name;
}

/** 存进 state.json 的 id：文件夹名或两个保留 id，长度有限，不含路径分隔符。 */
function isOutfitId(value) {
    return typeof value === 'string' && value.length > 0 && value.length < 200 && !/[\\/]/.test(value) && value !== '.' && value !== '..';
}

module.exports = {
    ROOT_ID,
    PORTRAIT_ID,
    PORTRAIT_KEYS,
    IMAGE_EXTENSIONS,
    listOutfits,
    defaultOutfit,
    pickOutfit,
    outfitLabel,
    outfitDescription,
    inspectFolder,
    isOutfitId,
    collectPortraits,
    findBySuffix,
};
