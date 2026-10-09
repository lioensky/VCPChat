// modules/deskpet/petState.js
// 每个桌宠记在 AppData/deskpet/state.json 里的东西：位置、大小、选的那套形象、各套量出来的长宽比、藏边状态。
// 读改写串行：拖动结束和改大小几乎同时保存时，后一次不会拿着旧内容把前一次盖掉；读也排在写后面，免得读到正在写的那一半。

'use strict';

const fs = require('fs-extra');
const petPrefs = require('./petPrefs');

// 每套形象量出来的长宽比只记最近这么多套
const MAX_REMEMBERED_FIGURES = 24;

function createPetStateStore({ file }) {
    let writes = Promise.resolve();

    async function readFile() {
        let text;
        try { text = await fs.readFile(file, 'utf8'); } catch { return {}; }
        try {
            const state = JSON.parse(text);
            return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
        } catch {
            // 写坏了（以前的版本写到一半被杀掉）：留一份备份再当空的，不让下一次保存把所有桌宠的位置、大小、形象一起冲掉而无从找回
            await fs.copy(file, `${file}.bad`).catch(() => {});
            return {};
        }
    }

    // 先写临时文件再改名：写到一半被杀掉也只丢这一次，不会留下半个文件
    async function writeFile(state) {
        const tmp = `${file}.tmp`;
        await fs.outputJson(tmp, state, { spaces: 2 });
        await fs.move(tmp, file, { overwrite: true });
    }

    /** 排进写队列：change(state) 改好返回 true 才写回去。 */
    function enqueue(change) {
        writes = writes.then(async () => {
            const state = await readFile();
            if (change(state) !== false) await writeFile(state);
        }).catch((error) => console.warn('[DeskPet] state save failed:', error.message));
        return writes;
    }

    return {
        async read() {
            await writes;
            return readFile();
        },
        save(agentId, patch) {
            return enqueue((state) => {
                // 记大小、位置时顺带记下是按哪一版的尺寸算的（见 petPrefs.savedScale、legacyPosition）
                const versioned = patch.scale === undefined && patch.x === undefined ? patch : { ...patch, sizeVersion: petPrefs.SIZE_VERSION };
                state[agentId] = { ...(state[agentId] || {}), ...versioned };
            });
        },
        remove(agentId) {
            return enqueue((state) => {
                if (!(agentId in state)) return false;
                delete state[agentId];
                return true;
            });
        },
    };
}

// 每套形象量出来的长宽比记在 state.json 里，下次打开（或换回这一套）直接按它开窗口，不用先开再改大小。
function rememberFigure(saved, outfitId, aspect) {
    const figures = { ...(saved?.figures && typeof saved.figures === 'object' ? saved.figures : {}) };
    delete figures[outfitId];
    figures[outfitId] = aspect;
    const keys = Object.keys(figures);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_FIGURES))) delete figures[key];
    return figures;
}

function savedAspect(saved, outfitId) {
    return petPrefs.normalizeAspect(saved?.figures?.[outfitId]);
}

function hasSavedPosition(saved) {
    return Boolean(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y));
}

module.exports = { createPetStateStore, rememberFigure, savedAspect, hasSavedPosition, MAX_REMEMBERED_FIGURES };
