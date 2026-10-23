// Live2D 支持：Cubism Core 是 Live2D 的专有组件，不随应用附带，在这里一键从官网装好。
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
    const coreDownloadBtn = button(doc, 'dps-btn dps-btn-primary', '一键启用');
    const coreFileBtn = button(doc, 'dps-btn', '用本地文件…', { title: '已经从 Live2D 官网下好了 Cubism SDK for Web：选压缩包或其中的 live2dcubismcore.min.js' });
    const coreLicenseBtn = button(doc, 'dps-link', 'Live2D 许可协议');
    // 点「一键启用」就是同意许可协议，这句话跟着按钮一起出现
    const coreConsent = el(doc, 'span', 'dps-core-consent', '启用即表示同意');
    coreConsent.append(coreLicenseBtn);
    coreActions.append(coreConsent, coreFileBtn, coreDownloadBtn);
    coreCard.append(coreRow, coreActions);
    return { coreTitle, coreCard, coreRow, coreActions, coreState, coreHint, coreConsent, coreDownloadBtn, coreFileBtn, coreLicenseBtn };
}

// ctx：{ api, state, note, applyCatalog }
export function wireCore(ctx, parts) {
    const { api, state } = ctx;
    const { coreCard, coreRow, coreActions, coreState, coreHint, coreConsent, coreDownloadBtn, coreFileBtn, coreLicenseBtn } = parts;

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
            const what = p.source === 'sdk' ? '完整的 Cubism SDK（单独的 Core 用不了，改下这个）' : 'Cubism Core';
            coreState.textContent = '正在启用 Live2D…';
            coreHint.textContent = p.phase === 'verify'
                ? '下载好了，正在试加载一遍'
                : p.total > 0
                    ? `正在从 Live2D 官网下载 ${what} ${size(p.received)} / ${size(p.total)}`
                    : `正在从 Live2D 官网下载 ${what}${p.received ? ` ${size(p.received)}` : '…'}`;
            return;
        }
        if (status?.installed) {
            const name = status.version ? `Cubism Core ${status.version}` : 'Cubism Core';
            coreState.textContent = status.bundled ? `${name}（随应用附带）` : `${name} 已装好`;
            coreHint.textContent = 'Live2D 形象可以直接用。';
            // 装好了只剩「换一份」，放进这一行里，不再单占一栏
            coreRow.append(coreFileBtn);
            coreActions.hidden = true;
            coreFileBtn.textContent = '换一份…';
            return;
        }
        coreState.textContent = wanted ? `启用 ${state.catalog?.name || 'TA'} 的 Live2D 形象` : 'Live2D 形象还没启用';
        coreHint.textContent = 'Live2D 形象要用 Live2D 官方的 Cubism Core（约 200 KB）。这份 VCPChat 安装时没能带上它，一键从官网装好，所有 Live2D 形象都能用；没装之前先用立绘代替。';
        coreActions.insertBefore(coreFileBtn, coreDownloadBtn);
        coreActions.hidden = false;
        coreFileBtn.textContent = '用本地文件…';
    }

    async function installCore(source) {
        if (state.coreProgress) return;
        if (source === 'official') state.coreProgress = { phase: 'download', received: 0, total: 0 };
        renderCore();
        try {
            const result = await api.installDeskPetCore(source, state.agentId);
            state.coreProgress = null;
            if (result?.catalog && result.catalog.agentId === state.agentId) ctx.applyCatalog(result.catalog);
            if (result?.success) ctx.note('Live2D 已启用，形象已经换上', { ms: 5000 });
            else if (!result?.canceled && result?.error) {
                ctx.note(result.error, { error: true, ms: 8000 });
                coreHint.textContent = source === 'official'
                    ? `${result.error}。可以稍后再试，或者去 Live2D 官网下载 Cubism SDK for Web（5.x），再点「用本地文件…」。`
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
