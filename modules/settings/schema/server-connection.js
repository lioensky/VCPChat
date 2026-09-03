// schema/server-connection — "服务器连接" 分区（M1）。
// 两张可折叠卡片（VCP 连接 / 网络笔记）；网络笔记的路径容器是运行时
// 动态追加子行的复合键，由分区 collect 钩子收集（M5-a）。
import { section, card, text, button, custom } from './kernel.js';

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

export const serverConnectionSection = section('server-connection', '服务器连接', [
    card('vcpConnection', {
        cardKey: 'vcp-connection',
        title: 'VCP 连接',
        description: '连接 VCP 主服务与 WebSocket 的地址和鉴权。',
        fields: [
            text('vcpServerUrl', {
                inputType: 'url',
                label: 'VCP 服务器 URL',
                placeholder: '将自动补全 /v1/chat/completions',
                required: true,
                stacked: true,
                hintStyle: null,
                save: {
                    trim: true,
                    transform: (value, scope) => scope.settingsManager.completeVcpUrl(value),
                },
            }),
            text('vcpApiKey', { inputType: 'password', label: 'VCP API Key', stacked: true }),
            text('vcpLogUrl', { inputType: 'url', label: 'VCP WebSocket服务器 URL', stacked: true, save: { trim: true } }),
            text('fileKey', {
                inputType: 'password',
                label: 'VCP文件/图床密码',
                placeholder: '用于拼接表情包图片地址',
                stacked: true,
                hint: '用于访问VCP返回的文件/图片地址，将拼接为 [`/pw=密码/images或files/分类/文件名`]。',
                save: { falsy: '' },
            }),
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
