// AI 设计助手的模型调用：SillyTavern 当前 API / SillyTavern 连接配置 / 自定义 OpenAI 兼容接口
import * as ST from './st.js';

export const DESIGN_SOURCES = {
    st: '当前 SillyTavern 使用的 API',
    profile: 'SillyTavern 连接配置',
    custom: '自定义 API（OpenAI 兼容）',
};

const CORS_HINT = '可以勾选「通过 SillyTavern 代理转发」（需要在 SillyTavern 的 config.yaml 中设置 enableCorsProxy: true），或在 SillyTavern 中保存一个连接配置后改用「SillyTavern 连接配置」。';

/** 拼出接口地址；填写时可以带或不带 /chat/completions */
export function apiUrl(base, path, proxy = false) {
    let u = String(base || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(u)) throw new Error('请填写以 http:// 或 https:// 开头的 API 地址');
    u = u.replace(/\/(chat\/completions|models)$/i, '') + path;
    return proxy ? `/proxy/${u}` : u;
}

async function request(custom, path, init) {
    let res;
    try {
        res = await fetch(apiUrl(custom.url, path, custom.proxy), {
            ...init,
            headers: { 'Content-Type': 'application/json', ...(custom.key ? { Authorization: `Bearer ${custom.key}` } : {}) },
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new Error(`无法连接到 API（网络问题或浏览器的跨域 CORS 限制）。${CORS_HINT}`);
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 错误页 */ }
    if (!res.ok) {
        const msg = data?.error?.message || data?.message || text.slice(0, 300) || res.statusText;
        throw new Error(`API 返回错误 ${res.status}：${msg}${res.status === 404 && custom.proxy ? `（代理未开启？${CORS_HINT}）` : ''}`);
    }
    if (!data) throw new Error('API 返回的不是 JSON');
    return data;
}

/** 自定义 API 的模型列表（GET /models） */
export async function fetchModels(custom) {
    const data = await request(custom, '/models', { method: 'GET' });
    return (data.data || data.models || []).map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

/**
 * 调用模型
 * @param {object} cfg settings.designer
 * @param {{system:string, user:string}} prompt
 * @returns {Promise<{text:string, truncated?:boolean}>}
 */
export async function designerGenerate(cfg, { system, user }, { signal } = {}) {
    const maxTokens = Math.max(256, Number(cfg.maxTokens) || 8000);
    if (cfg.source === 'profile') {
        if (!cfg.profileId) throw new Error('请先选择一个 SillyTavern 连接配置');
        return { text: await ST.generateWithProfile(cfg.profileId, system, user, maxTokens) };
    }
    if (cfg.source === 'custom') {
        const c = cfg.custom || {};
        if (!c.model) throw new Error('请填写模型名称');
        const data = await request(c, '/chat/completions', {
            method: 'POST', signal,
            body: JSON.stringify({
                model: c.model, stream: false, max_tokens: maxTokens, temperature: Number(cfg.temperature ?? 0.8),
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            }),
        });
        const choice = data.choices?.[0];
        const text = choice?.message?.content ?? choice?.text ?? data.content?.find?.(x => x.type === 'text')?.text ?? '';
        if (!text) throw new Error('API 没有返回内容');
        return { text: String(text), truncated: choice?.finish_reason === 'length' };
    }
    return { text: await ST.generateRawST(system, user, maxTokens) };
}
