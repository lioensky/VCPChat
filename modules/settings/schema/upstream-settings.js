// schema/upstream-settings —— 服务器连接分区的两块自定义卡片
//
// 1) 上游模型：选供应商 → 自动带出 API 地址与版本前缀（用户不用懂 v1beta/openai 这种东西），
//    只填 API Key，保存后写 VCPToolBox/config.env 并自动重启后端。
// 2) 维护：检测更新 / 更新前后端 / 关闭窗口行为，原来悬浮框的能力。
//
// 两块都走本地 VCPDistributedServer（默认 5974）的 /vcp-update/* 接口，
// 不写 settings.json —— 所以除供应商选择外的字段统一 save:false。

import { renderSchemaField } from '../render/field-renderer.js';

const BACKEND_API = 'http://127.0.0.1:6005';
const DIST_API = 'http://127.0.0.1:5974';
const BACKEND_PROBE = 'http://127.0.0.1:6005/v1/models';

function inferVersionPrefix(apiUrl) {
    if (!apiUrl) return 'v1';
    const lower = String(apiUrl).toLowerCase();
    if (lower.includes('generativelanguage.googleapis.com') || lower.includes('google')) {
        return 'v1beta/openai';
    }
    if (lower.includes('bigmodel.cn') || lower.includes('zhipu')) {
        return 'v4';
    }
    return 'v1';
}
const BUTTON_CLASS = 'sidebar-button small-button vcp-settings-card-add-row';

// 供应商 → 上游地址与前缀。VCP 的拼法是 `${apiUrl}/${prefix}/chat/completions`。
const PROVIDERS = [
    {
        value: 'google',
        label: 'Google Gemini（官方原生）',
        apiUrl: 'https://generativelanguage.googleapis.com',
        prefix: 'v1beta/openai',
    },
    {
        value: 'openai',
        label: 'OpenAI（官方）',
        apiUrl: 'https://api.openai.com',
        prefix: 'v1',
    },
    {
        value: 'deepseek',
        label: 'DeepSeek（官方）',
        apiUrl: 'https://api.deepseek.com',
        prefix: 'v1',
    },
    {
        value: 'zhipu',
        label: '智谱 GLM',
        apiUrl: 'https://open.bigmodel.cn/api/paas',
        prefix: 'v4',
    },
    {
        value: 'custom',
        label: '自定义（中转 / 自建网关）',
        apiUrl: '',
        prefix: 'v1',
    },
];

let maintenanceTimer = null;

function textField(key, label, options = {}) {
    return {
        kind: 'field',
        key,
        type: 'text',
        inputType: options.inputType || 'text',
        label,
        placeholder: options.placeholder,
        hint: options.hint,
        stacked: true,
        save: false,
    };
}

function selectField(key, label, options) {
    return {
        kind: 'field',
        key,
        type: 'select',
        label,
        options,
        stacked: true,
    };
}

function buttonField(key, label) {
    return { kind: 'field', type: 'button', key, label, className: BUTTON_CLASS, save: false };
}

function statusNode(doc, id) {
    const node = doc.createElement('small');
    node.id = id;
    node.style.display = 'block';
    node.style.marginTop = '6px';
    node.style.opacity = '0.75';
    return node;
}

function setStatus(node, text, isError = false) {
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger-color)' : '';
    node.style.opacity = isError ? '1' : '0.75';
}

function pick(root, id) {
    return root.querySelector(`#${id}`);
}

async function getAuthHeader() {
    let key = '';
    if (typeof document !== 'undefined') {
        const keyInput = document.getElementById('vcpApiKey');
        if (keyInput && keyInput.value) {
            key = keyInput.value.trim();
        }
    }
    if (!key && typeof window !== 'undefined') {
        const loadSettingsFn = window.electronAPI?.loadSettings || window.electronAPI?.settings?.loadSettings;
        if (typeof loadSettingsFn === 'function') {
            try {
                const settings = await loadSettingsFn();
                if (settings?.vcpApiKey) {
                    key = settings.vcpApiKey.trim();
                }
            } catch (_) {}
        }
    }
    return key ? { 'Authorization': `Bearer ${key}` } : {};
}

async function requestJson(urlOrPath, options = {}) {
    const authHeaders = await getAuthHeader();
    const headers = { ...authHeaders, ...(options.headers || {}) };
    const mergedOptions = { ...options, headers };

    if (typeof urlOrPath === 'string' && (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://'))) {
        const response = await fetch(urlOrPath, mergedOptions);
        if (response.status === 401) {
            throw new Error('未授权 (401 Unauthorized)：请先在连接设置中配置 VCP API Key');
        }
        const data = await response.json();
        if (!data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${response.status}`);
        return data;
    }

    const relPath = urlOrPath.startsWith('/') ? urlOrPath : `/${urlOrPath}`;
    const candidates = [`${BACKEND_API}${relPath}`, `${DIST_API}${relPath}`];
    let lastError = null;

    for (const targetUrl of candidates) {
        try {
            const response = await fetch(targetUrl, mergedOptions);
            if (response.status === 401) {
                throw new Error('未授权 (401 Unauthorized)：请先在连接设置中配置 VCP API Key');
            }
            if (response.ok) {
                const data = await response.json();
                if (data && data.ok === true) return data;
            }
        } catch (err) {
            lastError = err;
            if (err.message && err.message.includes('401')) {
                throw err;
            }
        }
    }
    throw lastError || new Error(`无法连接到本地服务 (${candidates.join(', ')})`);
}

// ---------------------------------------------------------------- 上游模型卡片

export function buildUpstreamCard(doc) {
    const wrap = doc.createElement('div');

    wrap.append(
        renderSchemaField(doc, selectField('vcpUpstreamProvider', '供应商', PROVIDERS.map(provider => ({
            value: provider.value,
            label: provider.label,
        })))),
        renderSchemaField(doc, textField('vcpUpstreamUrl', 'API 地址', {
            placeholder: '选「自定义」时填写',
        })),
        renderSchemaField(doc, textField('vcpUpstreamKey', 'API Key', {
            inputType: 'password',
            placeholder: '留空表示不修改',
        }))
    );

    const applyButton = renderSchemaField(doc, buttonField('vcpUpstreamApply', '保存并重启后端'));
    applyButton.style.marginTop = '16px';
    const status = statusNode(doc, 'vcpUpstreamStatus');
    wrap.append(applyButton, status);

    const providerSelect = pick(wrap, 'vcpUpstreamProvider');
    const urlInput = pick(wrap, 'vcpUpstreamUrl');
    const keyInput = pick(wrap, 'vcpUpstreamKey');

    function providerOf(value) {
        return PROVIDERS.find(provider => provider.value === value) || PROVIDERS[0];
    }

    // 选供应商后：非自定义时把地址填死并锁定只读，自定义时放开。版本前缀由程序智能添加。
    function syncProviderFields() {
        const provider = providerOf(providerSelect.value);
        const isCustom = provider.value === 'custom';
        if (!isCustom) {
            urlInput.value = provider.apiUrl;
        }
        urlInput.readOnly = !isCustom;
        urlInput.style.opacity = isCustom ? '' : '0.6';
    }

    providerSelect.addEventListener('change', syncProviderFields);

    async function load(isRefresh = false) {
        if (!isRefresh) setStatus(status, '读取中…');
        try {
            const data = await requestJson('/vcp-update/upstream');
            const matched = PROVIDERS.find(provider =>
                provider.value !== 'custom'
                && provider.apiUrl === data.apiUrl);
            providerSelect.value = matched ? matched.value : 'custom';
            if (!matched) {
                urlInput.value = data.apiUrl || '';
            }
            syncProviderFields();
            keyInput.value = '';
            if (data.hasKey) {
                keyInput.placeholder = '•••••••••••••••• (已保存，留空保持不变)';
            } else {
                keyInput.placeholder = '请输入 API Key (如 sk-...)';
            }
            if (!isRefresh) {
                setStatus(status, '');
            }
        } catch (error) {
            syncProviderFields();
            setStatus(status, `连不上本地服务：${error.message}`, true);
        }
    }

    function getBackendProbeUrl() {
        const serverInput = doc.getElementById('vcpServerUrl');
        if (serverInput && serverInput.value) {
            try {
                const parsed = new URL(serverInput.value);
                return `${parsed.origin}/v1/models`;
            } catch (_) {}
        }
        return BACKEND_PROBE;
    }

    applyButton.addEventListener('click', async () => {
        const provider = providerOf(providerSelect.value);
        const apiUrl = provider.value === 'custom' ? urlInput.value.trim() : provider.apiUrl;
        const prefix = provider.prefix || inferVersionPrefix(apiUrl);
        const apiKey = keyInput.value.trim();

        if (!apiUrl) {
            setStatus(status, '自定义供应商需要填写 API 地址', true);
            return;
        }
        const hasSavedKey = keyInput.placeholder && keyInput.placeholder.includes('已保存');
        if (!apiKey && !hasSavedKey) {
            setStatus(status, '请填写 API Key', true);
            return;
        }

        setStatus(status, '保存中…');
        try {
            const payload = { apiUrl, prefix };
            if (apiKey) payload.apiKey = apiKey;
            await requestJson('/vcp-update/upstream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            keyInput.value = '';
            setStatus(status, '已写入 config.env，正在重启后端…');
            await requestJson('/vcp-update/restart-backend', { method: 'POST' }).catch(() => {});

            const probeUrl = getBackendProbeUrl();
            let up = false;
            for (let attempt = 0; attempt < 50; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                try {
                    const probe = await fetch(probeUrl, { method: 'GET' });
                    if (probe.status === 200 || probe.status === 401) { up = true; break; }
                } catch (probeError) {
                    // 后端还没起来
                }
            }
            if (up) {
                await load(true);
                setStatus(status, '已保存，后端已重启');
            } else {
                setStatus(status, '已写入配置；若后端未自动重启，请检查控制台', false);
            }
        } catch (error) {
            setStatus(status, `保存失败：${error.message}`, true);
        }
    });

    syncProviderFields();
    load();
    return wrap;
}

// ---------------------------------------------------------------- 维护卡片

function renderCheckLine(doc, label, item) {
    const line = doc.createElement('small');
    line.style.display = 'block';
    if (!item) return line;
    if (item.error) {
        line.textContent = `${label}：查询失败（${item.error}）`;
        line.style.color = 'var(--danger-color)';
        return line;
    }
    const state = item.upToDate ? '已是最新' : '有新版本';
    line.textContent = `${label}：${state} · 本地 ${item.localShort || '未知'} → 远端 ${item.remoteShort || '未知'}`;
    line.style.opacity = item.upToDate ? '0.75' : '1';
    return line;
}

export function buildMaintenanceCard(doc) {
    if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
    }

    const wrap = doc.createElement('div');

    // 主操作整行，两个更新按钮各占一半，避免三个全宽按钮堆成一摞。
    const grid = doc.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '1fr 1fr';
    grid.style.gap = '8px';

    const checkButton = renderSchemaField(doc, buttonField('vcpMaintCheck', '检测更新'));
    checkButton.style.gridColumn = '1 / -1';
    const backendButton = renderSchemaField(doc, buttonField('vcpMaintUpdateBackend', '更新后端'));
    const frontendButton = renderSchemaField(doc, buttonField('vcpMaintUpdateFrontend', '更新前端'));
    grid.append(checkButton, backendButton, frontendButton);

    const statusBox = doc.createElement('div');
    statusBox.id = 'vcpMaintStatus';
    statusBox.style.marginTop = '8px';
    const initialLine = doc.createElement('small');
    initialLine.textContent = '点击「检测更新」查看是否有新版本';
    initialLine.style.opacity = '0.75';
    statusBox.append(initialLine);

    const logBox = doc.createElement('pre');
    logBox.id = 'vcpMaintLog';
    logBox.style.marginTop = '8px';
    logBox.style.maxHeight = '160px';
    logBox.style.overflow = 'auto';
    logBox.style.fontSize = '11px';
    logBox.style.whiteSpace = 'pre-wrap';
    logBox.style.display = 'none';

    const closeRow = doc.createElement('div');
    closeRow.style.marginTop = '10px';
    closeRow.style.display = 'flex';
    closeRow.style.alignItems = 'center';
    closeRow.style.gap = '8px';
    const closeLabel = doc.createElement('small');
    closeLabel.textContent = '关闭窗口时';
    closeLabel.style.opacity = '0.75';
    const closeSelect = doc.createElement('select');
    closeSelect.id = 'vcpCloseMode';
    closeSelect.style.fontSize = '12px';
    closeSelect.style.padding = '4px 8px';
    closeSelect.style.borderRadius = '6px';
    [
        { value: 'tray', text: '最小化到托盘' },
        { value: 'quit', text: '彻底关闭界面' },
    ].forEach(option => {
        const node = doc.createElement('option');
        node.value = option.value;
        node.textContent = option.text;
        closeSelect.append(node);
    });
    closeRow.append(closeLabel, closeSelect);

    wrap.append(grid, statusBox, logBox, closeRow);

    async function check() {
        statusBox.replaceChildren();
        const loading = doc.createElement('small');
        loading.textContent = '查询中…';
        loading.style.opacity = '0.75';
        statusBox.append(loading);
        try {
            const data = await requestJson('/vcp-update/status');
            statusBox.replaceChildren(
                renderCheckLine(doc, '后端', data.backend),
                renderCheckLine(doc, '前端', data.frontend)
            );
            if (data.running) startPolling();
        } catch (error) {
            const line = doc.createElement('small');
            line.textContent = `连不上更新服务：${error.message}`;
            line.style.color = 'var(--danger-color)';
            statusBox.replaceChildren(line);
        }
    }

    function startPolling() {
        if (maintenanceTimer) return;
        logBox.style.display = 'block';
        maintenanceTimer = setInterval(async () => {
            try {
                const data = await requestJson('/vcp-update/log');
                logBox.textContent = (data.log || []).join('\n');
                logBox.scrollTop = logBox.scrollHeight;
                if (!data.running) {
                    clearInterval(maintenanceTimer);
                    maintenanceTimer = null;
                    check();
                }
            } catch (error) {
                clearInterval(maintenanceTimer);
                maintenanceTimer = null;
            }
        }, 1500);
    }

    async function apply(target) {
        logBox.style.display = 'block';
        try {
            await requestJson('/vcp-update/apply?target=' + target, { method: 'POST' });
            logBox.textContent = `已开始更新 ${target} …`;
            startPolling();
        } catch (error) {
            logBox.textContent = `启动更新失败：${error.message}`;
        }
    }

    checkButton.addEventListener('click', check);
    backendButton.addEventListener('click', () => apply('backend'));
    frontendButton.addEventListener('click', () => apply('frontend'));

    requestJson('/vcp-update/tray-setting')
        .then(data => {
            if (data && data.ok) closeSelect.value = data.closeToTray ? 'tray' : 'quit';
        })
        .catch(() => { /* 服务没起来保持默认 */ });

    closeSelect.addEventListener('change', async event => {
        const closeToTray = event.target.value === 'tray';
        try {
            await requestJson('/vcp-update/tray-setting?closeToTray=' + closeToTray, { method: 'POST' });
        } catch (error) {
            // 失败时恢复原值，避免界面显示与实际不一致
            event.target.value = closeToTray ? 'quit' : 'tray';
        }
    });

    return wrap;
}
