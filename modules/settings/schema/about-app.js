// schema/about-app —— "关于 VCP" 分区（成熟商业级关于面板）
// 包含软件信息、版本标识、六边形双通道架构状态、更新中心与开源许可证/官网链接。

import { section, card, custom } from './kernel.js';
import { buildMaintenanceCard } from './upstream-settings.js';

function buildBrandCard(doc) {
    const wrap = doc.createElement('div');
    wrap.className = 'vcp-about-brand-wrap';
    wrap.style.padding = '12px 14px';
    wrap.style.borderRadius = '8px';
    wrap.style.background = 'rgba(0, 0, 0, 0.03)';
    wrap.style.border = '1px solid rgba(0, 0, 0, 0.08)';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '8px';

    const header = doc.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';

    const titleGroup = doc.createElement('div');
    titleGroup.style.display = 'flex';
    titleGroup.style.alignItems = 'baseline';
    titleGroup.style.gap = '8px';

    const title = doc.createElement('strong');
    title.style.fontSize = '16px';
    title.style.letterSpacing = '0.5px';
    title.textContent = 'VCP AIOS';

    const versionBadge = doc.createElement('span');
    versionBadge.style.fontSize = '11px';
    versionBadge.style.padding = '2px 8px';
    versionBadge.style.borderRadius = '12px';
    versionBadge.style.background = 'rgba(59, 130, 246, 0.12)';
    versionBadge.style.color = '#2563eb';
    versionBadge.style.fontWeight = '600';
    versionBadge.textContent = 'v1.2.0 (Hexagonal IPC)';

    titleGroup.append(title, versionBadge);

    const archBadge = doc.createElement('span');
    archBadge.style.fontSize = '11px';
    archBadge.style.opacity = '0.7';
    archBadge.textContent = '全双工神经管道就绪';

    header.append(titleGroup, archBadge);

    const desc = doc.createElement('small');
    desc.style.opacity = '0.85';
    desc.style.lineHeight = '1.6';
    desc.textContent = '拥有自主常驻思考、全双工神经管道直连与四级主动打扰唤醒能力的桌面拟态生命体智能中枢。';

    const metaGrid = doc.createElement('div');
    metaGrid.style.display = 'grid';
    metaGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(180px, 1fr))';
    metaGrid.style.gap = '8px';
    metaGrid.style.marginTop = '4px';

    const items = [
        { label: '通信架构', val: '双通道 (IPC + HTTP 6005)' },
        { label: 'IPC 管道', val: '\\\\.\\pipe\\vcp-ipc' },
        { label: '主动唤醒', val: '4 级打扰协议 (Toast/Popup)' },
        { label: '核心引擎', val: 'VcpCoreEngine 六边形层' },
    ];

    for (const item of items) {
        const cell = doc.createElement('div');
        cell.style.padding = '6px 8px';
        cell.style.borderRadius = '6px';
        cell.style.background = 'rgba(255, 255, 255, 0.5)';
        cell.style.border = '1px solid rgba(0, 0, 0, 0.05)';

        const k = doc.createElement('span');
        k.style.fontSize = '11px';
        k.style.opacity = '0.65';
        k.style.display = 'block';
        k.textContent = item.label;

        const v = doc.createElement('strong');
        v.style.fontSize = '12px';
        v.style.display = 'block';
        v.style.marginTop = '2px';
        v.textContent = item.val;

        cell.append(k, v);
        metaGrid.append(cell);
    }

    wrap.append(header, desc, metaGrid);
    return wrap;
}

function buildCommunityCard(doc) {
    const wrap = doc.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '10px';

    const desc = doc.createElement('small');
    desc.style.opacity = '0.8';
    desc.style.lineHeight = '1.5';
    desc.textContent = 'VCP 是自由开源项目。你可以自由使用、修改与分发代码。';

    const linksRow = doc.createElement('div');
    linksRow.style.display = 'flex';
    linksRow.style.flexWrap = 'wrap';
    linksRow.style.gap = '10px';

    const links = [
        { label: '📦 前端仓库 (VCPChat)', url: 'https://github.com/lioensky/VCPChat' },
        { label: '⚙️ 后端仓库 (VCPToolBox)', url: 'https://github.com/lioensky/VCPToolBox' },
        { label: '📄 开源许可证 (GPL v3 / MIT)', url: 'https://github.com/lioensky/VCPChat/blob/main/LICENSE' },
    ];

    for (const link of links) {
        const a = doc.createElement('a');
        a.href = '#';
        a.textContent = link.label;
        a.style.fontSize = '12px';
        a.style.color = 'var(--accent-color, #3b82f6)';
        a.style.textDecoration = 'none';
        a.style.padding = '4px 10px';
        a.style.borderRadius = '6px';
        a.style.border = '1px solid rgba(59, 130, 246, 0.25)';
        a.style.background = 'rgba(59, 130, 246, 0.05)';
        a.style.transition = 'all 0.2s ease';

        a.addEventListener('click', (e) => {
            e.preventDefault();
            if (window.chatAPI?.sendOpenExternalLink) {
                window.chatAPI.sendOpenExternalLink(link.url);
            } else if (window.electronAPI?.invoke) {
                window.electronAPI.invoke('browser:open-external', link.url).catch(() => {});
            } else {
                window.open(link.url, '_blank');
            }
        });

        linksRow.append(a);
    }

    wrap.append(desc, linksRow);
    return wrap;
}

export const aboutAppSection = section('about-app', '关于 VCP', [
    card('aboutBrand', {
        cardKey: 'about-brand',
        title: '软件与架构',
        description: 'VCP 拟态生命体智能系统与双通道运行状态。',
        fields: [
            custom('vcpAboutBrandCard', buildBrandCard),
        ],
    }),
    card('aboutUpdates', {
        cardKey: 'about-updates',
        title: '版本检查与维护',
        description: '检测前后端远端提交、一键在线更新及窗口关闭策略。',
        fields: [
            custom('vcpAboutMaintenanceCard', (doc) => buildMaintenanceCard(doc)),
        ],
    }),
    card('aboutCommunity', {
        cardKey: 'about-community',
        title: '开源社区与许可证',
        description: '项目源码、协议条款与社区支持。',
        fields: [
            custom('vcpAboutCommunityCard', buildCommunityCard),
        ],
    }),
]);
