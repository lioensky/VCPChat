import { envEntries, setEnvValue, runtimeLabel, runtimeBadge, isSecret } from './plugins-settings-model.js';
import { mountSelectKeyboardGlue } from './select-keyboard.js';

const mounted = new WeakMap();
const drafts = new WeakMap();
const CATEGORIES = { renderer: '界面插件', local: '本机工具', backend: '后端插件' };

export function mountPluginsSettings(host, { api = globalThis.window?.chatAPI, scope, frontend = globalThis.window?.VCPFrontendPlugins, ui = globalThis.window?.VCPUIUX } = {}) {
    if (!host || mounted.has(host)) return mounted.get(host);
    const doc = host.ownerDocument;
    function resources() {
        const abort = new doc.defaultView.AbortController();
        const cleanups = new Set();
        return {
            get active() { return !abort.signal.aborted; },
            listen(el, type, fn, options = {}) { el.addEventListener(type, fn, { ...options, signal: abort.signal }); },
            own(fn) { const release = () => { if (cleanups.delete(release)) fn(); }; cleanups.add(release); return release; },
            dispose() { abort.abort(); for (const fn of [...cleanups].reverse()) fn(); }
        };
    }
    const lifetime = resources();
    let disposed = false;
    let active = 'renderer';
    const states = new Map();
    const savedDrafts = drafts.get(host) || new Map(); drafts.set(host, savedDrafts);
    const draftKey = item => `${item.category}:${item.id}`;
    function node(tag, className, text) {
        const el = doc.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }
    function listen(el, type, fn) { lifetime.listen(el, type, fn); }
    function button(text, fn, className = 'plugins-button', owner = lifetime) {
        const el = node('button', className, text); el.type = 'button'; owner.listen(el, 'click', fn);
        if (className.includes('plugins-button') && ui?.mountButton) {
            ui.mountButton(el, { variant: className.includes('plugins-button-primary') ? 'primary' : 'outline', size: 'md' }, owner);
            // Current DSH Button uses radius-md; the older shared adapter still projects a capsule.
            el.style.borderRadius = 'var(--dsw-radius-md, 12px)';
        }
        return el;
    }
    async function call(method, data) {
        if (!api?.[method]) throw new Error('插件管理接口不可用，请重启 VCPChat');
        const result = await api[method](data);
        if (!result?.success) throw new Error(result?.error || '插件管理操作失败');
        return result.data;
    }
    function message(el, text, error = false) {
        el.textContent = text; el.dataset.tone = error ? 'error' : 'neutral';
    }
    function status(card) {
        const state = runtimeLabel(card.item, frontend);
        const badge = runtimeBadge(card.item, frontend);
        card.status.textContent = badge.text; card.status.dataset.tone = badge.tone; card.status.hidden = !badge.text;
        card.expand.setAttribute('aria-label', `${card.title.textContent}，${state.text}`);
        if (card.description.textContent) card.expand.setAttribute('aria-describedby', card.description.id);
        else card.expand.removeAttribute('aria-describedby');
        card.toggle.title = state.text;
        const fact = card.details.querySelector('.plugins-runtime-fact');
        if (fact) fact.textContent = card.item.category === 'local' ? state.text.split(' · ')[0] : state.text;
        card.toggle.setAttribute('aria-checked', String(card.item.enabled));
        card.toggle.disabled = card.busy || card.detailLoading || card.stale || card.item.readOnly || Boolean(card.item.error);
        const locked = card.busy || card.detailLoading;
        if (locked) card.root.setAttribute('aria-busy', 'true'); else card.root.removeAttribute('aria-busy');
        for (const control of card.details.querySelectorAll('.plugins-input, .plugins-code')) {
            control.disabled = locked || (control.classList.contains('plugins-input') && (card.item.readOnly || card.stale));
            const trigger = control.parentElement.querySelector('.vcp-uiux-select-trigger'); if (trigger) trigger.disabled = control.disabled;
        }
        const invalid = [...card.details.querySelectorAll('.plugins-input, .plugins-code')].some(control => !control.checkValidity());
        const save = card.details.querySelector('.plugins-button-primary'); if (save) save.disabled = locked || card.stale || !card.dirty || card.item.readOnly || invalid;
        const discard = card.details.querySelector('.plugins-config-actions .plugins-button:not(.plugins-button-primary)'); if (discard) discard.disabled = locked || !card.dirty;
    }
    const heading = node('h3', 'plugins-heading', '插件与工具');
    const tabs = node('div', 'plugins-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '插件类型');
    const body = node('div', 'plugins-panels');
    host.replaceChildren(heading, tabs, body);
    // Independent config saves must never trigger the global-settings autosave/submit owner.
    for (const type of ['input', 'change']) listen(host, type, event => event.stopPropagation());
    listen(host, 'keydown', event => {
        if (event.key === 'Enter' && event.target.matches('input, select')) event.preventDefault();
    });
    function select(category) {
        active = category;
        for (const [key, state] of states) {
            if (key !== category) for (const card of state.cards.values()) card.detailScope?.closeMenus?.();
            state.panel.hidden = key !== category;
            state.tab.setAttribute('aria-selected', String(key === category));
            state.tab.tabIndex = key === category ? 0 : -1;
        }
        if (!states.get(category).loaded) void refresh(states.get(category));
    }
    function filter(state) {
        const query = state.search.value.trim().toLocaleLowerCase();
        let count = 0;
        for (const card of state.cards.values()) {
            const match = `${card.item.displayName || ''} ${card.item.name || card.item.id} ${card.item.description || ''}`.toLocaleLowerCase().includes(query);
            card.root.hidden = !match; if (match) count++;
        }
        state.empty.hidden = count > 0 || state.loading || Boolean(state.error);
        state.empty.textContent = query ? '无搜索结果' : '暂无插件';
    }
    async function refresh(state) {
        const sequence = ++state.sequence;
        state.loading = true; state.error = ''; state.refresh.disabled = true; state.panel.setAttribute('aria-busy', 'true');
        message(state.notice, '正在读取插件状态…'); filter(state);
        for (const card of state.cards.values()) card.detailScope?.closeMenus?.();
        try {
            const items = await call('pluginSettingsList', { category: state.category });
            if (disposed || sequence !== state.sequence) return;
            const ids = new Set(items.map(item => item.id));
            for (const [id, card] of state.cards) {
                if (!ids.has(id)) {
                    if (card.dirty) {
                        card.stale = true; status(card);
                        card.details.querySelector('.plugins-button-primary').disabled = true;
                        message(card.notice, '插件已移除。未保存的更改已保留，请复制所需配置。', true);
                    } else { card.removed = true; card.detailScope?.dispose(); card.scope.dispose(); card.root.remove(); state.cards.delete(id); }
                }
            }
            for (const item of items) {
                let card = state.cards.get(item.id);
                if (!card) { card = makeCard(state, item); state.cards.set(item.id, card); }
                else {
                    card.item = item;
                    card.title.textContent = item.displayName || item.name || item.id;
                    card.description.textContent = item.description || ''; card.description.hidden = !item.description; card.description.title = item.description || '';
                    card.toggle.setAttribute('aria-label', `启用 ${item.displayName || item.id}`);
                    card.stale = false;
                    if (card.detail && !card.busy && !card.detailLoading) {
                        if (card.dirty) message(card.notice, '未保存的更改已保留');
                        else await loadDetail(card);
                    }
                    status(card);
                }
                state.list.append(card.root);
            }
            if (disposed || sequence !== state.sequence) return;
            state.loaded = true;
            state.login.hidden = true;
            if (state.disconnect) state.disconnect.hidden = false;
            message(state.notice, '');
            if (state.connection) {
                const connected = items.some(item => item.connected);
                message(state.connection, items.length ? connected ? '节点已连接' : '节点未连接' : '');
                state.connection.dataset.tone = items.length && !connected ? 'pending' : 'neutral';
            }
        } catch (error) {
            if (disposed || sequence !== state.sequence) return;
            state.error = error.message;
            const initialLogin = state.category === 'backend' && !state.loaded && /请登录当前/.test(error.message);
            message(state.notice, initialLogin ? '' : error.message, !initialLogin);
            if (state.connection) message(state.connection, '');
            // Never leave stale backend rows looking authoritative after disconnect/auth failure.
            state.list.hidden = true;
            for (const card of state.cards.values()) { card.stale = true; status(card); }
            if (state.category === 'backend' && /登录|账号|密码/.test(error.message)) { state.login.hidden = false; state.disconnect.hidden = true; }
        } finally {
            if (!disposed && sequence === state.sequence) {
                state.loading = false; state.refresh.disabled = false; state.panel.removeAttribute('aria-busy');
                if (!state.error) state.list.hidden = false;
                filter(state);
            }
        }
    }
    function makeCard(state, item) {
        const cardScope = resources();
        const root = node('article', 'plugins-card'); root.dataset.pluginId = item.id;
        const header = node('div', 'plugins-card-header');
        const expand = button('', () => { const open = expand.getAttribute('aria-expanded') !== 'true'; expand.setAttribute('aria-expanded', String(open)); details.hidden = !open; if (!open) card.detailScope?.closeMenus?.(); if (open && !card.detail) void loadDetail(card); }, 'plugins-card-expand', cardScope);
        expand.setAttribute('aria-expanded', 'false');
        const copy = node('span', 'plugins-card-copy');
        const title = node('strong', 'plugins-card-title', item.displayName || item.name || item.id);
        const description = node('span', 'plugins-card-description', item.description || '');
        description.hidden = !item.description; description.title = item.description || '';
        description.id = `plugins-description-${state.category}-${encodeURIComponent(item.id)}`;
        copy.append(title, description);
        const chevron = node('span', 'vcp-ui-icon plugins-chevron', 'chevron-down'); chevron.setAttribute('aria-hidden', 'true');
        expand.append(copy, chevron);
        const tools = node('div', 'plugins-card-tools'); const indicator = node('span', 'plugins-runtime');
        const toggle = button('', async () => {
            if (card.busy || card.dirty) { message(card.notice, '请先保存或放弃更改', true); return; }
            card.busy = true; status(card);
            try {
                const result = await call('pluginSettingsToggle', { category: state.category, id: card.item.id, enabled: !card.item.enabled, revision: card.item.revision });
                if (disposed || card.removed) return;
                card.item.enabled = !card.item.enabled; card.item.pendingRestart = result.requiresRestart;
                message(card.notice, '');
                // Reload revision after manifest rename so subsequent config saves use the correct source.
                if (card.detail) { card.detail = null; await loadDetail(card); }
                await refresh(state);
            } catch (error) { if (!disposed) message(card.notice, error.message, true); }
            finally { if (!disposed) { card.busy = false; status(card); } }
        }, 'plugins-switch', cardScope);
        toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', `启用 ${item.displayName || item.id}`);
        tools.append(indicator, toggle); header.append(expand, tools);
        const details = node('div', 'plugins-card-details'); details.hidden = true;
        details.id = `plugins-detail-${state.category}-${encodeURIComponent(item.id)}`;
        expand.setAttribute('aria-controls', details.id);
        const notice = node('p', 'plugins-notice plugins-card-notice'); notice.setAttribute('role', 'status');
        root.append(header, details, notice);
        const card = { root, item, title, description, expand, scope: cardScope, status: indicator, toggle, details, notice, dirty: false, busy: false, detail: null, detailLoading: false };
        const saved = savedDrafts.get(draftKey(item));
        if (saved) {
            card.detail = saved.data; renderDetail(card, saved); details.hidden = false; expand.setAttribute('aria-expanded', 'true');
            message(notice, '已恢复未保存的更改');
            savedDrafts.delete(draftKey(item));
        }
        status(card); return card;
    }
    async function loadDetail(card) {
        if (card.detailLoading) return;
        card.detailLoading = true; status(card); message(card.notice, '正在读取配置…');
        try {
            const data = await call('pluginSettingsDetail', { category: card.item.category, id: card.item.id });
            if (disposed || card.removed) return;
            card.detail = data; renderDetail(card); message(card.notice, data.error || '', Boolean(data.error));
        } catch (error) {
            if (!disposed && !card.removed) { message(card.notice, error.message, true); card.details.replaceChildren(button('重试', () => void loadDetail(card), 'plugins-button', card.scope)); }
        } finally { card.detailLoading = false; if (!disposed) status(card); }
    }
    function renderDetail(card, saved) {
        card.detailScope?.dispose();
        const detailScope = resources(); card.detailScope = detailScope;
        const data = card.detail;
        let config = saved?.config ?? data.config;
        let rawEdited = saved?.rawEdited ?? false;
        const fields = node('div', 'plugins-config-fields'); const controls = new Map();
        const meta = node('dl', 'plugins-meta');
        for (const [label, value] of [['标识', data.name || data.id], ['版本', data.version], ['类型', data.pluginType]]) {
            if (value) meta.append(node('dt', '', label), node('dd', '', value));
        }
        meta.append(node('dt', '', '状态'), node('dd', 'plugins-runtime-fact'));
        const advanced = node('details', 'plugins-advanced');
        const summary = node('summary', 'plugins-advanced-toggle');
        const advancedIcon = node('span', 'vcp-ui-icon plugins-chevron', 'chevron-down'); advancedIcon.setAttribute('aria-hidden', 'true');
        summary.append(node('span', '', '高级配置'), advancedIcon);
        advanced.append(summary);
        const rawLabel = node('label', 'plugins-field'); rawLabel.append(node('span', 'plugins-field-label', data.configFormat === 'json' ? 'plugin-config.json' : 'config.env'));
        const raw = node('textarea', 'plugins-code'); raw.rows = 6; raw.spellcheck = false; raw.value = config; raw.readOnly = data.readOnly; raw.setAttribute('aria-label', `原始 ${data.configFormat === 'json' ? 'plugin-config.json' : 'config.env'}`); rawLabel.append(raw);
        const manifestLabel = node('label', 'plugins-field'); manifestLabel.append(node('span', 'plugins-field-label', data.category === 'backend' ? 'Manifest（只读）' : 'Manifest'));
        const manifest = node('textarea', 'plugins-code'); manifest.rows = 8; manifest.spellcheck = false; manifest.value = saved?.manifest ?? data.rawManifest; manifest.readOnly = data.category === 'backend' || data.readOnly; manifest.setAttribute('aria-label', '插件 Manifest'); manifestLabel.append(manifest);
        advanced.append(node('p', 'plugins-hint', '配置可能包含密钥'), rawLabel, manifestLabel);
        const save = button('保存', async () => {
            if (card.busy || card.stale || card.detailLoading) return;
            if (!raw.checkValidity()) { raw.reportValidity(); return; }
            for (const control of controls.values()) if (!control.checkValidity()) { control.reportValidity(); return; }
            card.busy = true; save.disabled = true; discard.disabled = true; raw.disabled = true; manifest.disabled = true;
            for (const control of controls.values()) { control.disabled = true; control.parentElement.querySelector('.vcp-uiux-select-trigger')?.setAttribute('disabled', ''); }
            detailScope.closeMenus?.();
            status(card); message(card.notice, '正在保存配置…');
            try {
                const result = await call('pluginSettingsSave', { category: data.category, id: data.id, revision: data.revision, config,
                    ...(data.category !== 'backend' && manifest.value !== data.rawManifest ? { rawManifest: manifest.value } : {}) });
                if (disposed || card.removed) return;
                card.dirty = false;
                card.detail = null; await loadDetail(card);
                card.item.pendingRestart = result.requiresRestart; status(card);
                message(card.notice, '已保存');
            } catch (error) { if (!disposed) message(card.notice, error.message, true); }
            finally {
                if (!disposed) {
                    card.busy = false; save.disabled = !card.dirty || data.readOnly; discard.disabled = !card.dirty;
                    raw.disabled = false; manifest.disabled = false; for (const control of controls.values()) {
                        control.disabled = data.readOnly;
                        const trigger = control.parentElement.querySelector('.vcp-uiux-select-trigger'); if (trigger) trigger.disabled = data.readOnly;
                    }
                    status(card);
                }
            }
        }, 'plugins-button plugins-button-primary', detailScope);
        const discard = button('放弃更改', async () => {
            if (card.busy || card.detailLoading) return;
            card.busy = true; discard.disabled = true; status(card);
            try {
                const latest = await call('pluginSettingsDetail', { category: data.category, id: data.id });
                if (disposed || card.removed) return;
                card.dirty = false; card.detail = latest; renderDetail(card); message(card.notice, '');
            } catch (error) { if (!disposed && !card.removed) message(card.notice, `${error.message}；更改已保留。`, true); }
            finally { if (!disposed && !card.removed) { card.busy = false; discard.disabled = !card.dirty; status(card); } }
        }, 'plugins-button', detailScope);
        discard.title = '放弃更改并重新读取';
        function dirty() {
            card.dirty = config !== data.config || manifest.value !== data.rawManifest;
            save.disabled = !card.dirty || data.readOnly || !raw.checkValidity(); discard.disabled = !card.dirty;
            status(card);
            message(card.notice, card.dirty ? '未保存' : '');
        }
        function syncControls() {
            let values;
            if (data.configFormat === 'json') {
                try {
                    const parsed = JSON.parse(config);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
                    values = new Map(Object.entries(parsed).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]));
                }
                catch { raw.setCustomValidity('原始配置必须是有效的 JSON 对象'); return; }
            } else values = new Map(envEntries(config).map(entry => [entry.key, entry.value]));
            for (const [key, control] of controls) { control.value = values.get(key) ?? ''; control.setCustomValidity(''); control.dispatchEvent(new doc.defaultView.Event('vcp-uiux-sync')); }
        }
        for (const [key, specValue] of Object.entries(data.configSchema || {})) {
            if (!/^[A-Za-z_][\w]*$/.test(key)) continue;
            const spec = typeof specValue === 'object' && specValue ? specValue : { type: specValue };
            const field = node('label', 'plugins-field'); field.append(node('span', 'plugins-field-label', spec.title || key));
            let control;
            if (spec.type === 'boolean' || Array.isArray(spec.enum)) {
                control = node('select', 'plugins-input');
                const labelFor = value => spec.type === 'boolean' ? String(value) === 'true' ? '开启' : '关闭' : String(value);
                const options = [['', `默认${spec.default !== undefined ? `（${labelFor(spec.default)}）` : ''}`], ...(spec.enum || ['true', 'false']).map(value => [String(value), labelFor(value)])];
                for (const [value, label] of options) { const option = node('option', '', label); option.value = value; control.append(option); }
            } else {
                let initial = '';
                if (data.configFormat === 'json') { try { initial = JSON.parse(config)?.[key] ?? ''; } catch { /* raw editor exposes invalid JSON for repair */ } }
                else initial = new Map(envEntries(config).map(entry => [entry.key, entry.value])).get(key) || '';
                initial = String(initial);
                if (isSecret(key) && initial.includes('\n')) { field.append(node('span', 'plugins-hint', '多行密钥，请在高级配置中编辑')); fields.append(field); continue; }
                control = node(initial.includes('\n') || ['array', 'object'].includes(spec.type) ? 'textarea' : 'input', 'plugins-input');
                if (control.tagName === 'INPUT') control.type = isSecret(key) ? 'password' : ['integer', 'number'].includes(spec.type) ? 'number' : 'text';
                else control.rows = 3;
                if (spec.type === 'integer') control.step = '1'; else if (spec.type === 'number') control.step = 'any';
                if (spec.minimum !== undefined) control.min = spec.minimum;
                if (spec.maximum !== undefined) control.max = spec.maximum;
                control.placeholder = spec.default !== undefined && !isSecret(key) ? `默认：${spec.default}` : '未设置';
                control.autocomplete = 'off';
            }
            control.dataset.configKey = key; control.disabled = data.readOnly;
            controls.set(key, control); field.append(control);
            if (spec.description) field.append(node('span', 'plugins-hint', spec.description));
            const edit = () => {
                try {
                    control.setCustomValidity('');
                    if (data.configFormat === 'json') {
                        const values = JSON.parse(config);
                        if (control.value === '') delete values[key];
                        else {
                            const value = ['boolean', 'integer', 'number', 'array', 'object'].includes(spec.type) ? JSON.parse(control.value) : control.value;
                            if (spec.type === 'array' && !Array.isArray(value)) throw new Error();
                            if (spec.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error();
                            if (spec.type === 'boolean' && typeof value !== 'boolean') throw new Error();
                            if (['integer', 'number'].includes(spec.type) && (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value)))) throw new Error();
                            values[key] = value;
                        }
                        config = JSON.stringify(values, null, 2) + '\n';
                    } else {
                        config = setEnvValue(config, key, control.value);
                        const values = text => JSON.stringify([...new Map(envEntries(text).map(entry => [entry.key, entry.value]))].sort(([a], [b]) => a.localeCompare(b)));
                        if (!rawEdited && values(config) === values(data.config)) config = data.config;
                    }
                    raw.value = config; dirty();
                } catch (error) { card.dirty = true; discard.disabled = false; control.setCustomValidity(data.configFormat === 'json' ? '请输入符合类型的 JSON 值' : error.message); save.disabled = true; message(card.notice, control.validationMessage, true); }
            };
            detailScope.listen(control, control.tagName === 'SELECT' ? 'change' : 'input', edit);
            fields.append(field);
        }
        syncControls();
        detailScope.listen(raw, 'input', () => { rawEdited = true; config = raw.value; raw.setCustomValidity(''); syncControls(); dirty(); });
        detailScope.listen(manifest, 'input', dirty);
        const actions = node('div', 'plugins-config-actions'); actions.hidden = Boolean(data.readOnly); actions.append(save, discard); save.disabled = true; discard.disabled = true;
        card.details.replaceChildren(meta, ...(fields.childElementCount ? [fields] : []), advanced, actions);
        if (data.readOnly) card.details.prepend(node('p', 'plugins-hint', '分布式插件，请在所属节点编辑'));
        const triggers = [];
        detailScope.closeMenus = () => { for (const trigger of triggers) if (trigger.getAttribute('aria-expanded') === 'true') trigger.click(); };
        for (const [key, control] of controls) if (control.tagName === 'SELECT' && ui?.mountSelect) {
            control.id = `${card.details.id}-${key}`;
            ui.mountSelect(control, { label: control.closest('label').querySelector('.plugins-field-label').textContent, portal: true }, detailScope);
            const trigger = control.parentElement.querySelector('.vcp-uiux-select-trigger');
            trigger.disabled = data.readOnly; triggers.push(trigger);
            const decorate = () => {
                const icon = node('span', 'vcp-ui-icon plugins-chevron', 'chevron-down'); icon.setAttribute('aria-hidden', 'true');
                trigger.querySelector('.plugins-chevron')?.remove(); trigger.append(icon);
            };
            decorate(); detailScope.listen(control, 'change', decorate); detailScope.listen(control, 'vcp-uiux-sync', decorate);
            const cleanups = []; mountSelectKeyboardGlue(control, cleanups, detailScope);
            detailScope.own(() => { for (const cleanup of cleanups) cleanup(); });
        }
        card.captureDraft = () => ({ data, config, rawEdited, manifest: manifest.value,
            values: [...controls].map(([key, control]) => [key, control.value, control.validity.customError ? control.validationMessage : '']) });
        if (saved) {
            for (const [key, value, error] of saved.values) {
                const control = controls.get(key); if (!control) continue;
                control.value = value; control.setCustomValidity(error); control.dispatchEvent(new doc.defaultView.Event('vcp-uiux-sync'));
            }
            dirty(); card.dirty = true; status(card);
        }
    }
    for (const [category, label] of Object.entries(CATEGORIES)) {
        const tab = button(label, () => select(category), 'plugins-tab'); tab.id = `plugins-tab-${category}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `plugins-panel-${category}`);
        const panel = node('section', 'plugins-panel'); panel.id = `plugins-panel-${category}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
        const toolbar = node('div', 'plugins-toolbar');
        const searchBox = node('div', 'plugins-search'); const icon = node('span', 'vcp-ui-icon', 'search'); icon.setAttribute('aria-hidden', 'true');
        const search = node('input', 'plugins-search-input'); search.type = 'search'; search.placeholder = `搜索${label}…`; search.setAttribute('aria-label', `搜索${label}`); searchBox.append(icon, search);
        const refreshButton = button('刷新', () => void refresh(state)); toolbar.append(searchBox, refreshButton);
        const notice = node('p', 'plugins-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
        const connection = category === 'local' ? node('span', 'plugins-notice plugins-connection') : null;
        if (connection) { connection.setAttribute('role', 'status'); toolbar.append(connection); }
        const list = node('div', 'plugins-list'); const empty = node('p', 'plugins-empty'); empty.hidden = true;
        const login = node('div', 'plugins-login'); login.hidden = true;
        const state = { category, tab, panel, search, refresh: refreshButton, notice, connection, list, empty, login, cards: new Map(), loaded: false, loading: false, error: '', sequence: 0 };
        if (category === 'backend') {
            login.append(node('p', 'plugins-hint', '连接 VCPToolBox 管理端'));
            const usernameLabel = node('label', 'plugins-field'); usernameLabel.append(node('span', 'plugins-field-label', '管理端账号'));
            const username = node('input', 'plugins-input'); username.autocomplete = 'username'; usernameLabel.append(username);
            const passwordLabel = node('label', 'plugins-field'); passwordLabel.append(node('span', 'plugins-field-label', '管理端密码'));
            const password = node('input', 'plugins-input'); password.type = 'password'; password.autocomplete = 'current-password'; passwordLabel.append(password);
            const connect = button('连接管理端', async () => {
                connect.disabled = true; message(notice, '正在连接管理端…');
                try { await call('pluginSettingsConnect', { username: username.value, password: password.value }); if (!disposed) { password.value = ''; await refresh(state); } }
                catch (error) { if (!disposed) message(notice, error.message, true); }
                finally { if (!disposed) connect.disabled = false; }
            }, 'plugins-button plugins-button-primary');
            login.append(usernameLabel, passwordLabel, connect);
            const disconnect = button('断开管理端', async () => {
                try { await call('pluginSettingsDisconnect'); if (!disposed) { state.loaded = false; await refresh(state); } }
                catch (error) { if (!disposed) message(notice, error.message, true); }
            });
            const sessionActions = node('span', 'plugins-session-actions'); sessionActions.hidden = true; state.disconnect = sessionActions;
            sessionActions.append(disconnect); toolbar.append(sessionActions);
            listen(password, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); connect.click(); } });
        }
        listen(search, 'input', () => filter(state));
        listen(tab, 'keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const keys = Object.keys(CATEGORIES); const index = keys.indexOf(active);
            const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length];
            select(next); states.get(next).tab.focus();
        });
        panel.append(toolbar, notice, login, list, empty); tabs.append(tab); body.append(panel); states.set(category, state);
    }
    // Loading is lazy: opening general settings must not contact the backend.
    const onActivated = () => { if (!states.get(active).loaded) void refresh(states.get(active)); };
    listen(host.closest('.settings-section') || host, 'vcp-settings-section-activated', onActivated);
    const controller = { select, refresh: () => refresh(states.get(active)), dispose() {
        disposed = true; lifetime.dispose();
        for (const state of states.values()) for (const card of state.cards.values()) {
            if (card.dirty && card.captureDraft) savedDrafts.set(draftKey(card.item), card.captureDraft());
            card.removed = true; card.detailScope?.dispose(); card.scope.dispose();
        }
        states.clear(); host.replaceChildren(); mounted.delete(host);
    } };
    mounted.set(host, controller); scope?.own(() => controller.dispose(), 'plugins-settings', 'ui-presentation');
    for (const [key, state] of states) { state.panel.hidden = key !== active; state.tab.setAttribute('aria-selected', String(key === active)); state.tab.tabIndex = key === active ? 0 : -1; }
    return controller;
}
