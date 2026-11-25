import { mountDeviceControls } from './device-controls.js';
import { deviceKind, paintDeviceIcon } from './device-art.js';

const LOGIN_CODES = new Set(['login_required', 'auth_expired', 'auth_file_invalid']);
const ERRORS = {
    login_required: '尚未连接米家。请使用米家 App 扫码。',
    auth_expired: '米家登录已过期，请重新扫码。',
    auth_file_invalid: '本机登录文件无法读取，请重新扫码。',
    python_missing: '找不到 Python。请确认 VChat 能从 PATH 启动 Python。',
    sdk_missing: '本机 Python 未安装米家 SDK（mijiaAPI 2.0.1）。',
    login_busy: '另一个米家面板正在扫码，可在那边完成后刷新。',
    login_attempt_missing: '这次扫码已经结束，请重试。',
    timeout: '请求超时，请重试。',
    cancelled: '已取消扫码。',
    request_failed: '米家请求失败，请检查网络后重试。若仍无法读取，可重新连接。',
};
const errorText = code => ERRORS[code] || '暂时无法读取米家，请重试。';

export function mountMijiaPanel(host, api) {
    const doc = host.ownerDocument;
    const el = (tag, cls, text) => {
        const node = doc.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const panel = el('section', 'mijia-panel');
    const heading = el('div', 'mijia-heading');
    const title = el('h1', '', '米家');
    const status = el('p', 'mijia-status');
    status.setAttribute('role', 'status');
    const actions = el('div', 'mijia-actions');
    const button = label => {
        const node = el('button', 'mijia-button', label);
        node.type = 'button';
        actions.append(node);
        return node;
    };
    const refresh = button('刷新');
    const connect = button('连接米家');
    const cancel = button('取消扫码');
    const qrBox = el('div', 'mijia-qr');
    const qr = el('img');
    qr.alt = '米家登录二维码';
    qrBox.append(qr);
    const list = el('ul', 'mijia-device-list');
    list.setAttribute('aria-label', '米家设备');
    const summary = el('div', 'mijia-summary');
    summary.append(title, status);
    heading.append(summary, actions);
    panel.append(heading, qrBox, list);
    host.replaceChildren(panel);

    let disposed = false;
    let revision = 0;
    let busy = false;
    let login = false;
    let connected = false;
    let attemptId = null;
    let timer;
    const cards = new Map();
    function removeCard(id) {
        const card = cards.get(id);
        card?.controls?.dispose();
        card?.row.remove();
        cards.delete(id);
    }
    const current = version => !disposed && version === revision;
    function setState(message, { showConnect = !connected } = {}) {
        status.textContent = message;
        refresh.disabled = busy;
        connect.hidden = login || !showConnect;
        connect.disabled = busy;
        cancel.hidden = !login;
    }
    function hideQr() {
        qrBox.hidden = true;
        qr.removeAttribute('src');
    }
    function renderDevices(devices) {
        connected = true;
        const live = new Set(devices.map(device => device.id));
        for (const id of cards.keys()) if (!live.has(id)) removeCard(id);
        for (const device of devices) {
            let card = cards.get(device.id);
            if (card && card.model !== device.model) {
                removeCard(device.id);
                card = null;
            }
            if (!card) {
                const row = el('li', 'mijia-device');
                row.dataset.deviceId = device.id;
                const header = el('div', 'mijia-device-header');
                const info = el('div', 'mijia-device-info');
                const name = el('strong');
                const state = el('span', 'mijia-device-state');
                info.append(name, el('small', '', device.model));
                const icon = el('span', 'mijia-device-art');
                icon.setAttribute('aria-hidden', 'true');
                header.append(icon, info, state);
                row.append(header);
                card = { row, icon, name, state, model: device.model, controls: mountDeviceControls(row, device, api) };
                cards.set(device.id, card);
            }
            paintDeviceIcon(card.icon, deviceKind(device.model, device.name));
            card.name.textContent = device.name;
            card.state.textContent = device.online === true ? '在线' : device.online === false ? '离线' : '状态未知';
            card.state.dataset.online = String(device.online === true);
            card.controls?.updateOnline(device.online);
            if (card.row.parentNode !== list) list.append(card.row);
            if (device.online === true) void card.controls?.reload();
        }
        setState(`米家已连接 · ${devices.length} 台设备`);
    }
    function showFailure(code) {
        if (LOGIN_CODES.has(code)) {
            connected = false;
            for (const id of cards.keys()) removeCard(id);
        }
        connect.textContent = connected ? '重新连接' : '连接米家';
        setState(errorText(code), { showConnect: !connected || code === 'request_failed' });
    }
    async function load() {
        const version = ++revision;
        busy = true;
        setState('正在读取设备…');
        let response;
        try { response = await api?.mijiaListDevices?.(); } catch { /* render a generic error */ }
        if (!current(version)) return;
        busy = false;
        if (response?.success) renderDevices(response.devices);
        else showFailure(response?.code);
    }
    function cancelRemote(id) {
        if (id) void Promise.resolve().then(() => api?.mijiaCancelLogin?.(id)).catch(() => {});
    }
    async function poll(version, id) {
        let response;
        try { response = await api?.mijiaLoginState?.(id); } catch { /* render a generic error */ }
        if (!current(version)) return;
        if (!response?.success || response.phase === 'done') {
            attemptId = null;
            busy = login = false;
            hideQr();
            if (response?.success) renderDevices(response.devices);
            else {
                if (response?.phase !== 'done') cancelRemote(id);
                showFailure(response?.code);
            }
            return;
        }
        if (response.phase === 'qr') {
            const source = `data:image/png;base64,${response.png}`;
            if (qr.getAttribute('src') !== source) qr.src = source;
            qrBox.hidden = false;
            setState('请用米家 App 扫码，随后在手机上确认。');
        } else if (response.phase === 'verifying') {
            hideQr();
            setState('正在验证登录并读取设备…');
        }
        timer = setTimeout(() => void poll(version, id), 650);
    }
    async function start() {
        const version = ++revision;
        busy = login = true;
        setState('正在获取登录二维码…');
        let response;
        try { response = await api?.mijiaStartLogin?.(); } catch { /* render a generic error */ }
        if (!current(version)) {
            cancelRemote(response?.attemptId);
            return;
        }
        if (!response?.success) {
            busy = login = false;
            showFailure(response?.code);
            return;
        }
        attemptId = response.attemptId;
        void poll(version, attemptId);
    }
    refresh.addEventListener('click', load);
    connect.addEventListener('click', start);
    cancel.addEventListener('click', () => {
        ++revision;
        clearTimeout(timer);
        cancelRemote(attemptId);
        attemptId = null;
        busy = login = false;
        hideQr();
        setState('已取消扫码。', { showConnect: true });
    });
    hideQr();
    void load();
    return {
        isBusy: () => busy || [...cards.values()].some(card => card.controls?.isBusy()),
        dispose() {
            disposed = true;
            clearTimeout(timer);
            cancelRemote(attemptId);
            for (const id of cards.keys()) removeCard(id);
            panel.remove();
        },
    };
}