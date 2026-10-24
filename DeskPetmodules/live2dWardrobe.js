// 持久装扮与临时表情分离。每帧从模型默认值合成，不在上一帧的结果上累加。
export function createWardrobeLayer(core, idOf, groups = [], initial = {}) {
    const parameters = core?._model?.parameters || core?.getModel?.()?.parameters;
    const ids = parameters?.ids || [];
    const defaults = new Map();
    for (let index = 0; index < ids.length; index++) {
        const value = parameters.defaultValues?.[index] ?? core.getParameterDefaultValue?.(index);
        if (Number.isFinite(value)) defaults.set(ids[index], value);
    }
    let selected = initial;
    let previous = new Set();

    function setSelection(next) {
        selected = next && typeof next === 'object' ? next : {};
    }

    function apply() {
        const values = new Map();
        for (const group of groups) {
            const wanted = Array.isArray(selected[group.id]) ? selected[group.id] : [];
            const items = group.items.filter(item => wanted.includes(item.id));
            for (const item of group.multiple ? items : items.slice(0, 1)) {
                for (const p of item.parameters) {
                    if (!defaults.has(p.id)) continue; // 不给模型创造不存在的参数
                    const before = values.has(p.id) ? values.get(p.id) : defaults.get(p.id);
                    values.set(p.id, p.blend === 'Overwrite' ? p.value : p.blend === 'Multiply' ? before * p.value : before + p.value);
                }
            }
        }
        for (const id of previous) {
            if (!values.has(id)) core.setParameterValueById(idOf(id), defaults.get(id));
        }
        for (const [id, value] of values) core.setParameterValueById(idOf(id), value);
        previous = new Set(values.keys());
    }

    return { apply, setSelection };
}