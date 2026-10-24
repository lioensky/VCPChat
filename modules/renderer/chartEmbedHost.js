const SELECTOR = '.vcp-chart-embed[data-chart-id]';
const SANDBOX_URL = 'vcp-chart://app/Chartmodules/chart-sandbox.html';

export function createChartEmbedHost({ root, api, maxInstances = 4 }) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const slots = new Set();
    const instances = new Map();
    const preferred = new Map();
    let disposed = false;
    let reconcileTimer = null;
    let sequence = 0;
    const parking = doc.createElement('div');
    parking.hidden = true;
    parking.dataset.chartEmbedParking = 'true';
    doc.body.appendChild(parking);

    function send(entry, type, payload = {}) {
        if (!entry.ready || entry.dead) return;
        entry.frame.contentWindow?.postMessage({
            source: 'vcp-chart-shell', type, chartId: entry.id,
            generation: entry.generation, ...payload,
        }, '*');
    }

    function status(entry, text) {
        entry.status = text;
        if (entry.slot) entry.slot.querySelector('.vcp-chart-status').textContent = text;
    }

    function theme() {
        return doc.body.classList.contains('light-theme')
            || doc.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    }

    function sync(entry) {
        if (!entry.ready || entry.dead) return;
        const slot = entry.slot;
        const rect = slot?.getBoundingClientRect();
        const bounds = root.closest('.chat-messages-container')?.getBoundingClientRect()
            || { top: 0, bottom: win.innerHeight };
        const visible = !!(slot?.isConnected && rect && rect.bottom > bounds.top - 200
            && rect.top < bounds.bottom + 200 && !doc.hidden);
        if (entry.visible !== visible) {
            entry.visible = visible;
            send(entry, visible ? 'resume' : 'pause');
        }
        if (visible) {
            send(entry, 'resize', { size: {
                width: Math.round(rect.width), height: Math.round(entry.frame.clientHeight),
                devicePixelRatio: win.devicePixelRatio,
            } });
        }
    }

    function move(frame, target) {
        if (frame.parentNode === target) return;
        if (frame.isConnected) target.moveBefore(frame, null);
        else target.appendChild(frame);
    }

    function park(entry) {
        if (entry.dead) return;
        if (entry.slot) {
            entry.slot.classList.remove('is-playing');
            entry.slot.querySelector('.vcp-chart-status').textContent = '引用 · 点击播放可切换到此处';
        }
        move(entry.frame, parking);
        entry.slot = null;
        sync(entry);
    }

    function place(entry, slot) {
        if (entry.slot === slot) return;
        if (entry.slot) park(entry);
        clearTimeout(entry.orphanTimer);
        entry.orphanTimer = null;
        entry.slot = slot;
        move(entry.frame, slot.querySelector('.vcp-chart-stage'));
        slot.classList.add('is-playing');
        status(entry, entry.ready ? '实时图表' : '正在加载图表…');
        sync(entry);
    }

    function release(entry) {
        if (entry.dead) return;
        send(entry, 'destroy');
        entry.dead = true;
        clearTimeout(entry.timeout);
        clearTimeout(entry.orphanTimer);
        if (entry.slot) {
            entry.slot.classList.remove('is-playing');
            entry.slot.querySelector('.vcp-chart-status').textContent = '引用 · 点击播放';
        }
        entry.frame.remove();
        instances.delete(entry.id);
        if (entry.token) {
            void api.chartEmbedRelease({ chartId: entry.id, token: entry.token }).catch(() => {});
        }
    }

    async function refresh(entry) {
        if (!entry.token || entry.dead) return;
        const snapshot = await api.chartEmbedSnapshot({ chartId: entry.id, token: entry.token });
        if (entry.dead) return;
        const old = entry.snapshot.manifest;
        entry.snapshot = snapshot;
        if (old.codeRevision !== snapshot.manifest.codeRevision) {
            entry.generation = ++sequence;
            send(entry, 'initialize', { snapshot: { ...snapshot, generation: entry.generation } });
        } else {
            send(entry, 'data-change', { change: { type: 'data-replaced', data: snapshot.data } });
        }
        send(entry, 'theme', { theme: theme() });
        sync(entry);
    }

    async function create(id, slot) {
        if (instances.has(id) || disposed) return;
        slot.dataset.chartAttempted = 'true';
        if (instances.size >= maxInstances) {
            const victim = [...instances.values()].find(entry => !entry.visible);
            if (victim) release(victim);
            else {
                slot.querySelector('.vcp-chart-status').textContent = '活跃图表已达上限，请在工作台查看';
                return;
            }
        }
        const frame = doc.createElement('iframe');
        frame.className = 'vcp-chart-embed-frame';
        frame.title = slot.dataset.chartTitle || id;
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        const entry = {
            id, frame, slot: null, ready: false, token: null, dead: false,
            generation: ++sequence, visible: undefined, snapshot: null,
            updates: Promise.resolve(),
        };
        instances.set(id, entry);
        place(entry, slot);
        try {
            const acquired = await api.chartEmbedAcquire(id);
            if (entry.dead || disposed) {
                await api.chartEmbedRelease({ chartId: id, token: acquired.token }).catch(() => {});
                return;
            }
            entry.token = acquired.token;
            entry.snapshot = acquired.snapshot;
            entry.timeout = win.setTimeout(() => {
                status(entry, '加载超时 · 点击播放重试');
                release(entry);
            }, 15000);
            frame.src = SANDBOX_URL;
        } catch (error) {
            const target = entry.slot;
            release(entry);
            if (target) target.querySelector('.vcp-chart-status').textContent = `加载失败：${error.message}`;
        }
    }

    function activate(slot) {
        if (disposed || !slot.isConnected) return;
        const id = slot.dataset.chartId;
        slot.dataset.chartAuto = 'true';
        preferred.set(id, slot);
        const existing = instances.get(id);
        if (existing) place(existing, slot);
        else void create(id, slot);
    }

    function reconcile() {
        reconcileTimer = null;
        if (disposed) return;
        for (const slot of slots) {
            if (!slot.isConnected || !root.contains(slot)) {
                intersection?.unobserve(slot);
                resize?.unobserve(slot);
                slots.delete(slot);
            }
        }
        const groups = new Map();
        for (const slot of root.querySelectorAll(SELECTOR)) {
            if (!slots.has(slot)) continue;
            const id = slot.dataset.chartId;
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(slot);
        }
        for (const entry of instances.values()) {
            if (!groups.has(entry.id) && !entry.orphanTimer) {
                entry.orphanTimer = win.setTimeout(() => {
                    entry.orphanTimer = null;
                    if (![...slots].some(slot => slot.isConnected
                        && slot.dataset.chartId === entry.id)) release(entry);
                }, 15000);
            }
        }
        for (const [id, group] of groups) {
            const eligible = group.filter(slot => slot.dataset.chartAuto === 'true');
            const chosen = preferred.get(id);
            if (chosen && !group.includes(chosen)) preferred.delete(id);
            const slot = eligible.includes(chosen) ? chosen : eligible.at(-1);
            if (!slot) continue;
            if (instances.has(id)) place(instances.get(id), slot);
            else if (slot.dataset.chartAttempted !== 'true') void create(id, slot);
        }
    }

    function schedule() {
        if (reconcileTimer === null) reconcileTimer = win.setTimeout(reconcile, 0);
    }

    const supported = typeof parking.moveBefore === 'function' && !!api?.chartEmbedAcquire;
    const intersection = win.IntersectionObserver ? new win.IntersectionObserver(() => {
        instances.forEach(sync);
    }, { root: root.closest('.chat-messages-container'), rootMargin: '200px' }) : null;
    const resize = win.ResizeObserver ? new win.ResizeObserver(() => instances.forEach(sync)) : null;
    const observer = new win.MutationObserver(() => {
        scan(root, { auto: false });
        schedule();
    });
    observer.observe(root, { childList: true, subtree: true });

    function scan(container, { auto = true } = {}) {
        for (const slot of container.querySelectorAll(SELECTOR)) {
            if (slots.has(slot)) {
                if (auto) slot.dataset.chartAuto = 'true';
                continue;
            }
            if (slot.closest('[data-vcp-block-type="tool-result"], [data-vcp-block-type="tool-use"]')) continue;
            slots.add(slot);
            slot.dataset.chartAuto = String(auto);
            slot.style.height = `${Math.min(900, Math.max(180, Number(slot.dataset.chartHeight) || 360))}px`;
            slot.replaceChildren();
            const header = doc.createElement('div');
            header.className = 'vcp-chart-header';
            const title = doc.createElement('strong');
            title.textContent = slot.dataset.chartTitle || slot.dataset.chartId;
            const actions = doc.createElement('div');
            function button(text, callback) {
                const element = doc.createElement('button');
                element.type = 'button';
                element.dataset.vcpSystemControl = 'true';
                element.textContent = text;
                element.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    callback();
                });
                actions.appendChild(element);
            }
            button('播放', () => supported && activate(slot));
            button('工作台', () => {
                void api?.chartEmbedOpen?.(slot.dataset.chartId).catch(error => {
                    slot.querySelector('.vcp-chart-status').textContent = error.message;
                });
            });
            button('复制引用', () => {
                let text = '';
                try { text = decodeURIComponent(slot.dataset.chartReference || ''); } catch {}
                void win.navigator.clipboard?.writeText(text);
            });
            header.append(title, actions);
            const stage = doc.createElement('div');
            stage.className = 'vcp-chart-stage';
            const poster = doc.createElement('div');
            poster.className = 'vcp-chart-poster';
            const code = doc.createElement('code');
            code.textContent = slot.dataset.chartId;
            const label = doc.createElement('span');
            label.className = 'vcp-chart-status';
            label.textContent = supported ? '引用 · 点击播放' : '当前环境不支持消息图表，请打开工作台';
            poster.append(code, label);
            stage.appendChild(poster);
            // Keep status visible even while the live iframe covers its poster.
            header.appendChild(label);
            slot.append(header, stage);
            intersection?.observe(slot);
            resize?.observe(slot);
        }
        if (supported) schedule();
    }

    function beforeReplace(container) {
        for (const entry of instances.values()) {
            if (entry.slot && container.contains(entry.slot)) park(entry);
        }
        for (const slot of slots) {
            if (container.contains(slot)) {
                slots.delete(slot);
                intersection?.unobserve(slot);
                resize?.unobserve(slot);
            }
        }
        schedule();
    }

    async function message(event) {
        const entry = [...instances.values()].find(value => value.frame.contentWindow === event.source);
        const payload = event.data;
        if (!entry || entry.dead || payload?.source !== 'vcp-chart-sandbox') return;
        if (payload.type === 'sandbox-ready') {
            if (entry.ready || !entry.snapshot) return;
            entry.ready = true;
            send(entry, 'initialize', { snapshot: { ...entry.snapshot, generation: entry.generation } });
            send(entry, 'theme', { theme: theme() });
            sync(entry);
            return;
        }
        if (payload.chartId !== entry.id || payload.generation !== entry.generation) return;
        if (payload.type === 'ready') {
            clearTimeout(entry.timeout);
            status(entry, '实时图表');
            sync(entry);
        } else if (payload.type === 'error') {
            clearTimeout(entry.timeout);
            status(entry, `图表错误：${String(payload.message).slice(0, 180)}`);
        } else if (payload.type === 'data-source-request') {
            if (typeof payload.requestId !== 'string' || payload.requestId.length > 100) return;
            const generation = entry.generation;
            try {
                const result = await api.chartEmbedReadDataSource({
                    chartId: entry.id, token: entry.token, request: payload.request,
                });
                if (generation === entry.generation) send(entry, 'data-source-response', { requestId: payload.requestId, result });
            } catch (error) {
                if (generation === entry.generation) send(entry, 'data-source-response', { requestId: payload.requestId, error: error.message });
            }
        }
    }
    win.addEventListener('message', message);
    const visibility = () => instances.forEach(sync);
    doc.addEventListener('visibilitychange', visibility);
    const themes = new win.MutationObserver(() => {
        instances.forEach(entry => send(entry, 'theme', { theme: theme() }));
    });
    themes.observe(doc.body, { attributes: true, attributeFilter: ['class', 'data-vcp-theme'] });
    const unsubscribe = api?.onChartEmbedChanged?.(change => {
        const entry = instances.get(change?.chartId);
        if (!entry) return;
        if (change.type === 'deleted') {
            const target = entry.slot;
            release(entry);
            if (target) target.querySelector('.vcp-chart-status').textContent = '图表已删除';
            return;
        }
        entry.updates = entry.updates.then(() => refresh(entry)).catch(error => status(entry, `更新失败：${error.message}`));
    });

    function clear() {
        [...instances.values()].forEach(release);
        slots.clear();
        preferred.clear();
        intersection?.disconnect();
        resize?.disconnect();
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
    }

    return {
        scan, beforeReplace, clear,
        dispose() {
            if (disposed) return;
            disposed = true;
            clear();
            observer.disconnect();
            themes.disconnect();
            unsubscribe?.();
            win.removeEventListener('message', message);
            doc.removeEventListener('visibilitychange', visibility);
            parking.remove();
        },
    };
}