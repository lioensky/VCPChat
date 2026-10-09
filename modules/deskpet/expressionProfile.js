// modules/deskpet/expressionProfile.js
// 设置页「表情映射」的主进程部分：读 Live2D 模型里有哪些表情和动作组，读写模型旁边的 deskpet.json。
// 映射规则本身（「自动」会选哪个）在 DeskPetmodules/expressionMap.js，设置页和桌宠页面共用。
//
// deskpet.json 里只改 expressions / motions 下 12 个情绪键和 taps 下的 head / body，其他键（闲时动作名、自己加的字段）原样保留。

'use strict';

const path = require('path');
const fs = require('fs-extra');

// 和 DeskPetmodules/expressionMap.js 的 EMOTION_KEYS 一致（测试里核对）
const EMOTION_KEYS = ['neutral', 'calm', 'happy', 'excited', 'shy', 'affectionate', 'curious', 'surprised', 'concerned', 'sad', 'tired', 'angry'];
// 和 DeskPetmodules/expressionMap.js 的 TAP_KEYS 一致：点头、点身体时自己绑定的表情和动作
const TAP_KEYS = ['head', 'body'];
const MAX_MODEL_BYTES = 2 * 1024 * 1024;
const MAX_NAMES = 200;

/** model3.json 里声明的表情名和动作组名。 */
async function readModelCatalog(modelPath) {
    const stat = await fs.stat(modelPath);
    if (stat.size > MAX_MODEL_BYTES) throw new Error('model3.json 太大');
    const model = await fs.readJson(modelPath);
    const refs = model?.FileReferences || {};
    const names = (Array.isArray(refs.Expressions) ? refs.Expressions : [])
        .map((e) => (typeof e?.Name === 'string' ? e.Name : null))
        .filter(Boolean);
    const groups = Object.keys(refs.Motions && typeof refs.Motions === 'object' ? refs.Motions : {});
    return { names: [...new Set(names)].slice(0, MAX_NAMES), groups: groups.slice(0, MAX_NAMES) };
}

function profilePath(modelPath) {
    return path.join(path.dirname(modelPath), 'deskpet.json');
}

async function readProfile(modelPath) {
    try {
        const profile = await fs.readJson(profilePath(modelPath));
        return profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
    } catch {
        return {};
    }
}

/**
 * 把设置页提交的映射合进原来的 deskpet.json。
 * mapping = { expressions: { happy: 'Smile' | null }, motions: { happy: 'Tap' | '' | null }, taps: { head: { expression, motion } } }
 * null（或没给）是「自动」：删掉这个键；动作的 '' 是「不放动作」。模型里没有的名字一律当自动。
 */
function mergeProfile(existing, mapping, { names, groups }) {
    const next = { ...(existing && typeof existing === 'object' ? existing : {}) };
    const expressions = { ...(next.expressions && typeof next.expressions === 'object' ? next.expressions : {}) };
    const motions = { ...(next.motions && typeof next.motions === 'object' ? next.motions : {}) };
    for (const emotion of EMOTION_KEYS) {
        const expression = mapping?.expressions?.[emotion];
        if (typeof expression === 'string' && names.includes(expression)) expressions[emotion] = expression;
        else delete expressions[emotion];
        const motion = mapping?.motions?.[emotion];
        if (motion === '' || (typeof motion === 'string' && groups.includes(motion))) motions[emotion] = motion;
        else delete motions[emotion];
    }
    if (Object.keys(expressions).length) next.expressions = expressions;
    else delete next.expressions;
    if (Object.keys(motions).length) next.motions = motions;
    else delete next.motions;
    // 点头、点身体：{ expression, motion }，两样都没有（或模型里没有）就删掉这个区域，回到默认反应
    const taps = { ...(next.taps && typeof next.taps === 'object' && !Array.isArray(next.taps) ? next.taps : {}) };
    for (const zone of TAP_KEYS) {
        const given = mapping?.taps?.[zone];
        const expression = typeof given?.expression === 'string' && names.includes(given.expression) ? given.expression : null;
        const motion = typeof given?.motion === 'string' && groups.includes(given.motion) ? given.motion : null;
        if (expression || motion) taps[zone] = { ...(expression ? { expression } : {}), ...(motion ? { motion } : {}) };
        else delete taps[zone];
    }
    if (Object.keys(taps).length) next.taps = taps;
    else delete next.taps;
    return next;
}

async function writeProfile(modelPath, profile) {
    const file = profilePath(modelPath);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeJson(tmp, profile, { spaces: 2 });
    await fs.move(tmp, file, { overwrite: true });
}

module.exports = { EMOTION_KEYS, TAP_KEYS, readModelCatalog, readProfile, mergeProfile, writeProfile, profilePath };
