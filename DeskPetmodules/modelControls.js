// 显式模型控制：编号严格匹配当前目录；临时参数层，不触碰持久换装。
export function controlTokens(variant) {
    return typeof variant === 'string' ? [...new Set(variant.toLowerCase().split(/[+,，]/).filter(Boolean))].slice(0, 8) : [];
}

export function dueModelControls(tags, revealEnd) {
    const due = [];
    for (const tag of tags || []) {
        if (!tag.variant || tag.controlPlayed || tag.at >= (revealEnd ?? Infinity)) continue;
        tag.controlPlayed = true;
        due.push({ variant: tag.variant, intensity: tag.intensity });
    }
    return due.slice(-1);
}

export function createModelControlLayer(core, idOf, items = []) {
    const parameters = core?._model?.parameters || core?.getModel?.()?.parameters;
    const defaults = new Map();
    for (let i = 0; i < (parameters?.ids?.length || 0); i++) {
        const value = parameters.defaultValues?.[i] ?? core.getParameterDefaultValue?.(i);
        if (Number.isFinite(value)) defaults.set(parameters.ids[i], value);
    }
    let active = [], remaining = 0, strength = 0;
    let previous = new Set();
    return {
        play(tokens, intensity) {
            const selected = items.filter(item => item.kind === 'expression' && tokens.includes(item.id));
            if (!selected.length) return false;
            active = selected;
            remaining = 4;
            const number = Number(intensity);
            strength = Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.7;
            return true;
        },
        apply(dt) {
            remaining = Math.max(0, remaining - Math.max(0, Math.min(0.1, dt || 0)));
            const weight = strength * Math.min(1, remaining / 0.4);
            const values = new Map();
            if (weight > 0) for (const item of active) for (const p of item.parameters || []) {
                if (!defaults.has(p.id)) continue;
                const before = values.has(p.id) ? values.get(p.id) : defaults.get(p.id);
                values.set(p.id, p.blend === 'Overwrite' ? before + (p.value - before) * weight
                    : p.blend === 'Multiply' ? before * (1 + (p.value - 1) * weight) : before + p.value * weight);
            }
            for (const id of previous) if (!values.has(id)) core.setParameterValueById(idOf(id), defaults.get(id));
            for (const [id, value] of values) core.setParameterValueById(idOf(id), value);
            previous = new Set(values.keys());
            if (!remaining) active = [];
        },
        get active() { return remaining > 0; },
    };
}