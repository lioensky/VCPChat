// 模型伴舞配置解析及按拍调度。资源只从已扫描目录解析，不加载配置给出的任意 URL。
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const number = (v, fallback) => Number.isFinite(v) ? v : fallback;
const label = value => String(value || '').replace(/\\/g, '/').split('/').pop()
    .replace(/\.(exp3|motion3)\.json$/i, '').replace(/^按键[\s_-]+/u, '').toLowerCase();

export function resolveDanceProfile(raw, { paramIds = new Set(), catalog = {}, motionGroups = [] } = {}) {
    const config = raw && typeof raw === 'object' ? raw : {};
    const items = catalog.items || [];
    const gestures = [];
    const configured = Array.isArray(config.gestures);
    const candidates = configured ? config.gestures.slice(0, 32)
        : motionGroups.filter(g => /^(Dance|Cheer|Wave|Heart|Clap|Happy)$/i.test(g))
            .map(motion => ({ motion, beats: 4 }));
    for (const entry of candidates) {
        if (!entry || typeof entry !== 'object') continue;
        const gesture = { id: String(entry.id || gestures.length), beats: clamp(number(entry.beats, 4), 1, 16), accent: entry.accent === true };
        if (entry.params && typeof entry.params === 'object') {
            gesture.params = Object.fromEntries(Object.entries(entry.params).slice(0, 32)
                .filter(([id, value]) => paramIds.has(id) && Number.isFinite(value)).map(([id, value]) => [id, clamp(value, -100, 100)]));
            if (!Object.keys(gesture.params).length) continue;
        } else if (typeof entry.motion === 'string') {
            const item = items.find(i => i.kind === 'motion' && (i.id === entry.motion || label(i.name) === label(entry.motion)
                || label(i.name).endsWith(`.${label(entry.motion)}`)
                || (catalog.motions?.[i.group] || []).some(m => label(m.File) === label(entry.motion))));
            if (item) Object.assign(gesture, { motion: item.group, index: item.index, duration: item.duration, parameterIds: item.parameterIds || [] });
            else if (motionGroups.includes(entry.motion)) gesture.motion = entry.motion;
            else continue;
        } else if (typeof entry.expression === 'string') {
            const item = items.find(i => i.kind === 'expression' && (i.id === entry.expression || label(i.name) === label(entry.expression)));
            if (!item) continue;
            // 表情也作为临时参数层，不替换情绪表情管理器。
            gesture.parameters = item.parameters;
        } else continue;
        gestures.push(gesture);
    }
    const lo = clamp(Math.round(number(config.every?.[0], 2)), 1, 16);
    const hi = clamp(Math.round(number(config.every?.[1], 4)), lo, 16);
    const mapping = config.map?.bounce;
    const bounceId = typeof mapping === 'string' ? mapping : mapping?.id;
    return {
        enabled: raw !== false && config.enabled !== false,
        amplitude: clamp(number(config.amplitude, 1), 0, 2),
        every: [lo, hi],
        bounce: paramIds.has(bounceId) ? { id: bounceId, scale: clamp(number(mapping?.scale, 0.35), -2, 2) } : null,
        gestures,
    };
}

export function createDanceScheduler({ random = Math.random } = {}) {
    let active = null, until = 0, next = null, previous = null, lastBeat = -1;
    const interval = profile => 4 * (profile.every[0] + Math.floor(random() * (profile.every[1] - profile.every[0] + 1)));
    function clear() { active = null; until = 0; next = null; lastBeat = -1; }
    return {
        clear,
        step(groove, profile, allowed = true) {
            const beat = Number.isFinite(groove?.beat) ? groove.beat : 0;
            if (!allowed || !groove?.playing || !profile.enabled || beat < lastBeat) {
                clear();
                return { active: null, started: null };
            }
            if (next === null) next = Math.ceil(beat) + interval(profile);
            if (active && beat >= until) active = null;
            const boundary = Math.floor(beat);
            let started = null;
            if (!active && beat >= next && boundary !== lastBeat) {
                const pool = profile.gestures.filter(g => (!g.accent || groove.energy >= 0.5) && g.id !== previous);
                const choices = pool.length ? pool : profile.gestures.filter(g => !g.accent || groove.energy >= 0.5);
                if (choices.length) {
                    started = active = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
                    previous = active.id;
                    until = beat + (active.motion && active.duration ? active.duration * groove.bpm / 60 : active.beats);
                }
                // 先收回、再留出完整休息间隔，不让长手势刚结束就接上下一个。
                next = Math.ceil(active ? until : beat) + interval(profile);
            }
            lastBeat = boundary;
            return { active, started };
        },
    };
}

// 每帧只覆盖手势占用的参数。结束后用进入该层前的值恢复，不把衣服或整个模型重置。
export function createDanceParameterLayer(core, idOf, ids) {
    const parameters = core?._model?.parameters || core?.getModel?.()?.parameters;
    const defaults = new Map((parameters?.ids || []).map((id, i) => [id, parameters.defaultValues?.[i] ?? 0]));
    let previous = new Map();
    return {
        apply(gesture) {
            for (const [id, value] of previous) core.setParameterValueById(idOf(id), value);
            const desired = new Map();
            for (const [id, value] of Object.entries(gesture?.params || {})) if (ids.has(id)) desired.set(id, value);
            for (const p of gesture?.parameters || []) {
                if (!ids.has(p.id)) continue;
                const base = core.getParameterValueById?.(idOf(p.id)) ?? defaults.get(p.id) ?? 0;
                const value = p.blend === 'Overwrite' ? p.value : p.blend === 'Multiply' ? base * p.value : base + p.value;
                desired.set(p.id, value);
            }
            const saved = new Map();
            for (const [id, value] of desired) {
                saved.set(id, previous.has(id) ? previous.get(id) : core.getParameterValueById?.(idOf(id)) ?? defaults.get(id) ?? 0);
                core.setParameterValueById(idOf(id), value);
            }
            previous = saved;
        },
    };
}

// 动作的参数会被引擎 saveParameters 保存；在 beforeMotionUpdate 恢复后，
// 引擎本帧自然保存干净基线。只恢复该动作的曲线参数，绝不调用全模型重置。
export function createDanceMotionLease(core, idOf, ids) {
    let wanted = null;
    let saved = new Map();
    let releasing = false;
    return {
        begin(parameterIds = []) {
            wanted = parameterIds.filter(id => ids.has(id));
            releasing = false;
        },
        release() {
            wanted = null;
            releasing = true;
        },
        beforeMotionUpdate() {
            if (releasing) {
                for (const [id, value] of saved) core.setParameterValueById(idOf(id), value);
                saved.clear();
                releasing = false;
            }
            if (wanted) {
                saved = new Map(wanted.map(id => [id, core.getParameterValueById(idOf(id))]));
                wanted = null;
            }
        },
    };
}