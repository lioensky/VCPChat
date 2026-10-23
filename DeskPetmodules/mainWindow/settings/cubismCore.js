// Live2D 支持：Cubism Core 是 Live2D 的专有组件，不随应用附带，在这里一键装好。
// 下载进度由主进程推过来（deskpet-settings:core-progress），装好后形象卡片会重建。

import { el, button } from './dom.js';

export function buildCore(doc) {
    const coreTitle = el(doc, 'h4', 'dps-subtitle', 'Live2D 支持');
    const coreCard = el(doc, 'div', 'dps-card dps-core');
    const coreRow = el(doc, 'div', 'dps-row');
    const coreCopy = el(doc, 'span', 'dps-row-copy');
    const coreState = el(doc, 'span', 'dps-row-title');
    const coreHint = el(doc, 'span', 'dps-row-hint');
    coreHint.setAttribute('aria-live', 'polite');
    coreCopy.append(coreState, coreHint);
    coreRow.append(coreCopy);
    const coreActions = el(doc, 'div', 'dps-card-actions');
    const coreDownloadBtn = button(doc, 'dps-btn dps-btn-primary', '同意并下载');
    const coreFileBtn = button(doc, 'dps-btn', '选择本地文件…', { title: '已经从 Live2D 官网下好了 Cubism SDK for Web：选压缩包或其中的 live2dcubismcore.min.js' });
    const coreLicenseBtn = button(doc, 'dps-link', '许可协议');
    coreActions.append(coreLicenseBtn, coreFileBtn, coreDownloadBtn);
    coreCard.append(coreRow, coreActions);
    return { coreTitle, coreCard, coreState, coreHint, coreDownloadBtn, coreFileBtn, coreLicenseBtn };
}

// ctx：{ api, state, note, applyCatalog }
export function wireCore(ctx, parts) {
    const { api, state } = ctx;
    const { coreCard, coreState, coreHint, coreDownloadBtn, coreFileBtn, coreLicenseBtn } = parts;

    function size(bytes) {
        return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function renderCore() {
        const status = state.catalog?.core;
        const installing = Boolean(state.coreProgress) || status?.busy === true;
        const wanted = Boolean(state.catalog?.outfits?.some((o) => o.needsCore));
        coreCard.classList.toggle('is-wanted', wanted && !status?.installed);
        coreDownloadBtn.disabled = installing;
        coreFileBtn.disabled = installing;
        const p = state.coreProgress;
        if (p) {
            coreState.textContent = '正在安装 Cubism Core…';
            coreHint.textContent = p.phase === 'verify'
                ? '下载好了，正在取出 Core 并试加载一遍'
                : p.total > 0
                    ? `正在从 Live2D 官网下载 SDK ${size(p.received)} / ${size(p.total)}`
                    : `正在从 Live2D 官网下载 SDK${p.received ? ` ${size(p.received)}` : '…'}`;
            return;
        }
        if (status?.installed) {
            coreState.textContent = status.version ? `Cubism Core ${status.version} 已装好` : 'Cubism Core 已装好';
            coreHint.textContent = 'Live2D 形象可以直接用。想换一份 Core 时选本地文件（只支持 5.x）。';
            coreDownloadBtn.hidden = true;
            coreFileBtn.textContent = '更换…';
            return;
        }
        coreState.textContent = wanted ? `${state.catalog?.name || 'TA'} 的 Live2D 形象还缺 Cubism Core` : '还没装 Cubism Core';
        coreHint.textContent = `Live2D 形象要用 Live2D 官方的 Cubism Core，它是 Live2D 的专有组件，VCPChat 不附带。点「同意并下载」表示你同意 Live2D 的许可协议，会从 Live2D 官网下载 Cubism SDK for Web ${status?.release || ''}，只取出 Core 放进 VCPChat 的数据目录。没装之前，Live2D 形象先用立绘代替。`;
        coreDownloadBtn.hidden = false;
        coreFileBtn.textContent = '选择本地文件…';
    }

    async function installCore(source) {
        if (state.coreProgress) return;
        if (source === 'official') state.coreProgress = { phase: 'download', received: 0, total: 0 };
        renderCore();
        try {
            const result = await api.installDeskPetCore(source, state.agentId);
            state.coreProgress = null;
            if (result?.catalog && result.catalog.agentId === state.agentId) ctx.applyCatalog(result.catalog);
            if (result?.success) ctx.note(`Cubism Core ${result.version || ''} 装好了，Live2D 形象已经换上`, { ms: 5000 });
            else if (!result?.canceled && result?.error) {
                ctx.note(result.error, { error: true, ms: 8000 });
                coreHint.textContent = source === 'official'
                    ? `${result.error}。也可以去 Live2D 官网手动下载 Cubism SDK for Web（5.x），再点「选择本地文件…」。`
                    : `${result.error}。原来的设置没有变。`;
            }
        } finally {
            state.coreProgress = null;
            coreDownloadBtn.disabled = false;
            coreFileBtn.disabled = false;
        }
    }

    coreDownloadBtn.addEventListener('click', () => installCore('official'));
    coreFileBtn.addEventListener('click', () => installCore('file'));
    coreLicenseBtn.addEventListener('click', () => api.openDeskPetCoreLink?.('license'));

    // 只有正在装的时候才理进度推送
    function onProgress(progress) {
        if (!state.coreProgress || !progress) return;
        state.coreProgress = progress;
        renderCore();
    }

    return { renderCore, onProgress };
}
