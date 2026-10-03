// Small browser-safe config.env editor: preserve comments and unknown keys.
export function envEntries(content) {
    const entries = [];
    const pattern = /^(?:[ \t]*export[ \t]+)?[ \t]*([A-Za-z_][\w]*)[ \t]*=[ \t]*("(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|[^\r\n]*)/gm;
    let match;
    while ((match = pattern.exec(content))) {
        const raw = match[2].trim();
        const quoted = ['"', "'", '`'].includes(raw[0]);
        let value = quoted ? raw.slice(1, -1) : raw.split('#')[0].trim();
        if (raw[0] === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
        const end = !quoted && match[2].includes('#')
            ? pattern.lastIndex - match[2].length + match[2].split('#')[0].trimEnd().length
            : pattern.lastIndex;
        entries.push({ key: match[1], value, start: match.index, end });
    }
    return entries;
}
export function setEnvValue(content, key, value) {
    if (!/^[A-Za-z_][\w]*$/.test(key)) throw new Error('无效的配置项名称');
    const text = String(value);
    const quote = !text.includes("'") ? "'" : !text.includes('`') ? '`' : !text.includes('"') && !/\\[nr]/.test(text) ? '"' : '';
    if (value !== '' && !quote) throw new Error('此值包含复杂引号，请在高级配置中编辑');
    const line = value === '' ? '' : `${key}=${quote}${text}${quote}`;
    const existing = envEntries(content).filter(entry => entry.key === key);
    if (!existing.length) return line ? content + (content && !content.endsWith('\n') ? '\n' : '') + line + '\n' : content;
    let result = content;
    for (let i = existing.length - 1; i >= 0; i--) {
        const entry = existing[i];
        result = result.slice(0, entry.start) + (i === 0 ? line : '') + result.slice(entry.end);
    }
    return result;
}
export function runtimeLabel(item, frontend = globalThis.window?.VCPFrontendPlugins) {
    if (item.error) return { text: '加载异常', tone: 'error' };
    if (item.category === 'renderer') {
        const loaded = frontend?.getLoadState?.(item.name);
        if (item.pendingRestart || (loaded?.loaded && !item.enabled)) return { text: '重启后生效', tone: 'pending' };
        if (!item.enabled) return { text: '已停用', tone: 'neutral' };
        if (loaded?.loaded === false) return { text: '加载失败', tone: 'error' };
        if (loaded?.loaded) return { text: '已加载', tone: 'ready' };
        return { text: item.enabled ? '未报告加载状态' : '已停用', tone: 'neutral' };
    }
    if (item.pendingRestart || item.runtime === 'restart') return { text: '重启后生效', tone: 'pending' };
    if (item.runtime === 'error') return { text: '服务模块加载失败', tone: 'error' };
    if (!item.enabled) return { text: '已停用', tone: 'neutral' };
    if (item.category === 'backend') return { text: '后端已注册', tone: 'ready' };
    if (item.runtime === 'loaded') return { text: item.connected ? '已加载 · 节点已连接' : '已加载 · 节点未连接', tone: item.connected ? 'ready' : 'pending' };
    return { text: '本机服务未加载', tone: 'neutral' };
}
// Settled enabled rows need no marker (DSH inventory StateTag/PHASE_DOT_STATES).
// Transport is shared by local tools and belongs to their panel, not each card.
export function runtimeBadge(item, frontend) {
    const state = runtimeLabel(item, frontend);
    if (state.tone === 'error') return { text: '加载异常', tone: 'error' };
    if (state.text === '重启后生效') return { text: '待重启', tone: 'pending' };
    if (item.enabled && state.text === '未报告加载状态') return { text: '状态未知', tone: 'neutral' };
    if (item.enabled && state.text === '本机服务未加载') return { text: '未加载', tone: 'pending' };
    return { text: item.readOnly ? '只读' : '', tone: 'neutral' };
}
export const isSecret = key => /password|secret|token|api.?key|auth|credential/i.test(key);
