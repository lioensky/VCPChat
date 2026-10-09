// modules/deskpet/petAssets.js
// 桌宠页面能读到的文件，以及一个助手的形象清单（vcp-deskpet:// 协议背后的那一半）。
//
//   vcp-deskpet://pet/app/…              DeskPetmodules/ 里的页面和脚本
//   vcp-deskpet://pet/vendor/…           vendor/（渲染引擎）
//   vcp-deskpet://pet/emotion/…          modules/emotion/（和侧栏立绘共用的情绪模块）
//   vcp-deskpet://pet/builtin/nova/…     应用自带的 Nova 三套形象（assets/deskpet/nova/）
//   vcp-deskpet://pet/core/…             用户装的 Cubism Core，和安装前试加载的暂存文件
//   vcp-deskpet://pet/agent/<id>/…       助手目录里的 deskpet/ 子目录、立绘和头像（别的文件不可见）
//   vcp-deskpet://pet/default-avatar.png 应用的默认头像
// 同一个 origin，模型的 XHR 不跨域。

'use strict';

const path = require('path');
const fs = require('fs-extra');
const outfitStore = require('./outfits');

const SCHEME = 'vcp-deskpet';
const IMAGE_EXTENSIONS = outfitStore.IMAGE_EXTENSIONS;

function isInside(base, file) {
    const rel = path.relative(base, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function guard(base, segments) {
    const file = path.normalize(path.join(base, ...segments));
    return isInside(base, file) ? file : null;
}

// agent 目录名：单独一段，不能是 . 或 ..（否则会指到 Agents 目录本身或它的上级）。
function isAgentId(agentId) {
    return typeof agentId === 'string' && agentId.length > 0 && agentId !== '.' && agentId !== '..'
        && agentId === path.basename(agentId) && !/[\\/]/.test(agentId);
}

// 菜单和设置窗口只要名字和种类
function outfitSummary(outfit) {
    return { id: outfit.id, name: outfit.name, kind: outfit.kind, label: outfitStore.outfitLabel(outfit), builtIn: outfit.builtIn === true };
}

/**
 * paths：{ projectRoot, appDataRoot, agentDir }；stagedCorePath()：设置页正在试加载的 Core 暂存文件（没有是 null）。
 */
function createPetAssets({ paths, stagedCorePath = () => null }) {
    const coreFilePath = () => path.join(paths.appDataRoot, 'deskpet', 'live2dcubismcore.min.js');
    const defaultAvatarPath = () => path.join(paths.projectRoot, 'assets', 'default_avatar.png');
    const builtInDirectory = () => path.join(paths.projectRoot, 'assets', 'deskpet', 'nova');

    function resolveServedFile(urlString) {
        const url = new URL(urlString);
        let segments;
        try {
            segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        } catch {
            return null;
        }
        // 每一段都必须是普通文件名：Windows 会把反斜杠当分隔符，'..' 一律拒绝。
        if (segments.some((s) => s === '..' || s === '.' || /[\\/:]/.test(s))) return null;
        const root = segments.shift();
        if (root === 'app') return guard(path.join(paths.projectRoot, 'DeskPetmodules'), segments);
        if (root === 'vendor') return guard(path.join(paths.projectRoot, 'vendor'), segments);
        if (root === 'emotion') return guard(path.join(paths.projectRoot, 'modules', 'emotion'), segments);
        // 助手自己没放头像时用应用的默认头像（和主窗口侧栏里显示的一样）
        if (root === 'default-avatar.png' && !segments.length) return defaultAvatarPath();
        if (root === 'builtin') {
            if (segments.shift() !== 'nova') return null;
            return guard(builtInDirectory(), segments);
        }
        if (root === 'core') {
            const name = segments.join('/');
            if (name === 'live2dcubismcore.min.js') return coreFilePath();
            // 安装前试加载的暂存文件（modules/deskpet/cubismCore.js）
            if (name === 'staged.js') return stagedCorePath() || null;
            return null;
        }
        if (root === 'agent') {
            const agentId = segments.shift();
            if (!agentId || agentId.includes('..')) return null;
            const agentRoot = path.join(paths.agentDir, agentId);
            const name = segments.join('/');
            // 只放行 deskpet/ 子目录、立绘和头像，agent 目录里的其他文件（配置、历史）不可见。
            if (segments[0] === 'deskpet') return guard(path.join(agentRoot, 'deskpet'), segments.slice(1));
            if (segments.length === 1 && /^(portrait|avatar)(\.[\w-]+)?\.[a-z0-9]+$/i.test(name)) return guard(agentRoot, segments);
            return null;
        }
        return null;
    }

    function agentUrl(agentId, file) {
        if (isInside(builtInDirectory(), file)) {
            const rel = path.relative(builtInDirectory(), file).split(path.sep).map(encodeURIComponent).join('/');
            return `${SCHEME}://pet/builtin/nova/${rel}`;
        }
        const rel = path.relative(path.join(paths.agentDir, agentId), file).split(path.sep).map(encodeURIComponent).join('/');
        return `${SCHEME}://pet/agent/${encodeURIComponent(agentId)}/${rel}`;
    }

    function portraitUrls(agentId, portraits) {
        if (!portraits) return null;
        return Object.fromEntries(Object.entries(portraits).map(([key, file]) => [key, agentUrl(agentId, file)]));
    }

    async function listOutfits(agentId) {
        const agentRoot = path.join(paths.agentDir, agentId);
        let preferBuiltIn = false;
        try {
            const config = await fs.readJson(path.join(agentRoot, 'config.json'));
            preferBuiltIn = typeof config.name === 'string' && config.name.trim().toLowerCase() === 'nova';
        } catch { /* An agent without configuration can still pick a bundled outfit. */ }
        return outfitStore.listOutfits(agentRoot, {
            hasCore: await fs.pathExists(coreFilePath()),
            builtInDir: builtInDirectory(),
            preferBuiltIn,
        });
    }

    /** 桌宠页面（和设置页卡片快照）要的一切：名字、选中的那套形象和它的文件地址、Core、立绘、头像。 */
    async function resolveAssets(agentId, wantedOutfit) {
        const agentRoot = path.join(paths.agentDir, agentId);
        let name = agentId;
        try {
            const config = await fs.readJson(path.join(agentRoot, 'config.json'));
            if (config?.name) name = config.name;
        } catch { /* 没有配置就用 id */ }

        const outfits = await listOutfits(agentId);
        const outfit = outfitStore.pickOutfit(outfits, wantedOutfit);
        // 选的这套没有立绘（Live2D、网格立绘）时，Live2D 用不了就退回助手目录的立绘
        const fallback = outfits.find((o) => o.id === outfitStore.PORTRAIT_ID)?.portraits || null;
        const avatar = IMAGE_EXTENSIONS.map((ext) => `avatar.${ext}`);
        const files = (await fs.pathExists(agentRoot)) ? await fs.readdir(agentRoot) : [];
        const avatarFile = avatar.map((wanted) => files.find((f) => f.toLowerCase() === wanted)).find(Boolean);
        // 换过 Core 以后（设置页里装、换）页面的缓存里可能还是旧的那份：地址带上修改时间
        const coreStat = await fs.stat(coreFilePath()).catch(() => null);
        const hasCore = Boolean(coreStat);
        return {
            agentId,
            name,
            outfit: outfit ? outfitSummary(outfit) : null,
            outfits: outfits.map(outfitSummary),
            live2d: outfit?.live2d ? { modelUrl: agentUrl(agentId, outfit.live2d) } : null,
            puppet: outfit?.puppet ? { rigUrl: agentUrl(agentId, outfit.puppet) } : null,
            coreUrl: hasCore ? `${SCHEME}://pet/core/live2dcubismcore.min.js?v=${Math.round(coreStat.mtimeMs)}` : null,
            corePath: coreFilePath(),
            portraits: portraitUrls(agentId, outfit?.portraits || fallback),
            // 新建的助手目录里没有头像文件，主窗口显示的是默认头像：桌宠也用它，不要只剩一个表情符号
            avatar: avatarFile ? agentUrl(agentId, path.join(agentRoot, avatarFile)) : `${SCHEME}://pet/default-avatar.png`,
        };
    }

    async function listAgents() {
        const ids = (await fs.pathExists(paths.agentDir)) ? await fs.readdir(paths.agentDir) : [];
        const agents = [];
        for (const id of ids) {
            try {
                const config = await fs.readJson(path.join(paths.agentDir, id, 'config.json'));
                agents.push({ id, name: config?.name || id });
            } catch { /* 不是 agent 目录 */ }
        }
        // 同名的助手（比如复制出来的两个 Nova）在菜单、设置页下拉里分不清：名字后面带上 id 末尾几位
        const counts = new Map();
        for (const agent of agents) counts.set(agent.name, (counts.get(agent.name) || 0) + 1);
        for (const agent of agents) agent.label = counts.get(agent.name) > 1 ? `${agent.name} · ${agent.id.slice(-4)}` : agent.name;
        return agents;
    }

    async function agentExists(agentId) {
        return isAgentId(agentId) && fs.pathExists(path.join(paths.agentDir, agentId));
    }

    const pageUrl = (agentId, query = '') => `${SCHEME}://pet/app/deskpet.html?agentId=${encodeURIComponent(agentId)}${query}`;

    return { resolveServedFile, coreFilePath, resolveAssets, listOutfits, listAgents, agentExists, pageUrl, appUrl: (file) => `${SCHEME}://pet/app/${file}` };
}

module.exports = { createPetAssets, isAgentId, outfitSummary, SCHEME };
