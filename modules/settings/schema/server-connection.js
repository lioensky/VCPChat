// schema/server-connection — "服务器连接" 分区（M1）。
// 本机通信采用全双工神经管道 IPC 直连（免端口、零鉴权、原生主动唤醒）。
// 可折叠卡片：通信通道与连接 / 上游模型（写在 config.env）/ 高级（日志 WebSocket）/ 网络笔记。
import { section, card, text, button, switchField, custom } from './kernel.js';
import { buildUpstreamCard } from './upstream-settings.js';

function buildDuplexIpcCard(doc) {
    const row = doc.createElement('div');
    row.className = 'vcp-settings-row vcp-settings-row-stacked';
    const wrap = doc.createElement('div');
    wrap.style.padding = '12px 14px';
    wrap.style.borderRadius = '8px';
    wrap.style.background = 'rgba(16, 185, 129, 0.08)';
    wrap.style.border = '1px solid rgba(16, 185, 129, 0.2)';

    const topRow = doc.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.justifyContent = 'space-between';

    const left = doc.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '8px';

    const dot = doc.createElement('span');
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.borderRadius = '50%';
    dot.style.backgroundColor = '#10b981';
    dot.style.display = 'inline-block';
    dot.style.boxShadow = '0 0 8px rgba(16, 185, 129, 0.5)';

    const title = doc.createElement('strong');
    title.style.fontSize = '13px';
    title.textContent = '全双工神经 IPC 通道 (Duplex Pipe)';
    left.append(dot, title);

    const badge = doc.createElement('span');
    badge.style.fontSize = '11px';
    badge.style.padding = '2px 8px';
    badge.style.borderRadius = '10px';
    badge.style.background = 'rgba(16, 185, 129, 0.16)';
    badge.style.color = '#047857';
    badge.style.fontWeight = '600';
    badge.textContent = '免配即用';

    topRow.append(left, badge);

    const desc = doc.createElement('small');
    desc.style.display = 'block';
    desc.style.marginTop = '6px';
    desc.style.opacity = '0.78';
    desc.style.lineHeight = '1.5';
    desc.textContent = '客户端与本机 VCPToolBox 采用 \\\\.\\pipe\\vcp-ipc 双工管道直连，免端口、零鉴权延迟，原生支持后台生命体主动打扰唤醒协议。';

    wrap.append(topRow, desc);
    row.append(wrap);
    return row;
}

// 网络笔记路径容器：子行由 typed-field-owners 动态追加，渲染器只出壳。
function buildNetworkNotesContainer(doc) {
    const row = doc.createElement('div');
    row.className = 'vcp-settings-row vcp-settings-row-stacked';
    const container = doc.createElement('div');
    container.id = 'networkNotesPathsContainer';
    container.setAttribute('data-vcp-style', '5');
    row.append(container);
    return row;
}

// 卡内字段由自定义组件整块渲染：值走 /vcp-update/* 写 config.env，
// 不进 settings.json，所以声明里统一 save:false。
const upstreamCardMount = (doc) => buildUpstreamCard(doc);

export const serverConnectionSection = section('server-connection', '服务器连接', [
    card('vcpConnection', {
        cardKey: 'vcp-connection',
        title: '通信通道与连接',
        description: '本机通信架构与远程服务连接配置。',
        fields: [
            custom('duplexIpcStatus', buildDuplexIpcCard),
            switchField('enableRemoteVcpServer', {
                label: '连接远程 / 云端 VCP 服务器',
                hint: '本机运行无需开启。仅在将 VCP 后端部署于远程服务器或局域网时展开配置。',
                defaultValue: false,
                save: false,
            }),
            text('vcpServerUrl', {
                inputType: 'url',
                label: '远程 VCP 服务器 URL',
                placeholder: '将自动补全 /v1/chat/completions',
                stacked: true,
                hintStyle: null,
                when: ['enableRemoteVcpServer'],
                save: {
                    trim: true,
                    transform: (value, scope) => scope.settingsManager.completeVcpUrl(value),
                },
            }),
            text('vcpApiKey', {
                inputType: 'password',
                label: '远程 VCP API Key',
                stacked: true,
                when: ['enableRemoteVcpServer'],
            }),
            text('fileKey', {
                inputType: 'password',
                label: 'VCP 文件/图床密码',
                placeholder: '用于拼接表情包图片地址',
                stacked: true,
                when: ['enableRemoteVcpServer'],
                hint: '用于访问VCP返回的文件/图片地址，将拼接为 [`/pw=密码/images或files/分类/文件名`]。',
                save: { falsy: '' },
            }),
        ],
    }),
    card('upstreamModel', {
        cardKey: 'upstream-model',
        title: '上游模型',
        description: 'VCP 后端实际调用的模型服务。写入 config.env，保存后会自动重启后端。版本前缀由程序智能添加。',
        fields: [
            custom('vcpUpstreamCard', upstreamCardMount),
        ],
    }),
    card('advancedConnection', {
        cardKey: 'advanced-connection',
        title: '高级 · 日志与信息流',
        description: 'VCPLog 的 WebSocket 地址与鉴权。只有使用「信息流监听器」或工具日志面板时才需要填。',
        fields: [
            text('vcpLogUrl', { inputType: 'url', label: 'VCP WebSocket服务器 URL', stacked: true, save: { trim: true } }),
            text('vcpLogKey', { inputType: 'password', label: 'VCP WebSocket鉴权 Key', stacked: true, save: { trim: true } }),
        ],
    }),
    card('networkNotes', {
        cardKey: 'network-notes',
        title: '网络笔记',
        description: '网络笔记的存储路径列表，可添加多个位置。',
        fields: [
            custom('networkNotesPathsContainer', buildNetworkNotesContainer),
            button('addNetworkPathBtn', {
                label: '添加路径',
                className: 'sidebar-button small-button vcp-settings-card-add-row',
                rowStyle: 6,
            }),
        ],
    }),
], {
    // 网络笔记路径是动态子行的复合键：逐行 trim、过滤空行。
    collect(scope) {
        const container = scope.doc?.getElementById('networkNotesPathsContainer');
        const paths = container
            ? Array.from(container.querySelectorAll('input[name="networkNotesPath"]'))
                .map(input => input.value.trim())
                .filter(path => path)
            : [];
        return { networkNotesPaths: paths };
    },
});
