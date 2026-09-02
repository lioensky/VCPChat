// store — 全局设置表单的值访问门面。
// 职责：按控件语义读写表单值（开关/单选走 checked，其余走 value），
// 并在 schema 面替换静态标记前后迁移分区现值。快照以控件 id 为键，
// 与字段类型解耦：custom 组件通过 captureKeys 声明需要迁移的内部控件。
// M5-a 起，保存/回填链也从这里出发：collectSettings/applySettings 按
// 字段描述符的 save 声明推导全量载荷与回填写值（引擎见 value-semantics.js）。

export { collectSettings, applySettings, collectKey, clampBubbleWidthPercent, SAVE_PASSTHROUGH_KEYS, SAVE_CHANNEL_MANIFEST } from './value-semantics.js';

function isCheckable(control) {
    return control?.type === 'checkbox' || control?.type === 'radio';
}

export function readControlById(form, id) {
    const control = form?.querySelector(`#${id}`);
    if (!control) return undefined;
    return isCheckable(control) ? control.checked : control.value;
}

export function writeControlById(form, id, value) {
    const control = form?.querySelector(`#${id}`);
    if (!control || value === undefined) return;
    if (isCheckable(control)) {
        control.checked = Boolean(value);
        return;
    }
    control.value = String(value);
}

// 该分区需要迁移现值的全部控件 id（custom 组件按 captureKeys 声明）。
export function sectionValueIds(sectionDescriptor) {
    const ids = [];
    walkIds(sectionDescriptor);
    function walkIds(descriptor) {
        for (const child of descriptor.fields || []) {
            if (child.kind === 'layout') { walkIds(child); continue; }
            if (child.type === 'custom') {
                ids.push(...(child.captureKeys || []));
                continue;
            }
            if (child.capture === false) continue;
            ids.push(child.key);
        }
    }
    return ids;
}

// 在替换静态标记之前采集该分区的现值快照（id → 值/checked）。
export function captureSectionValues(form, sectionDescriptor) {
    const snapshot = new Map();
    for (const id of sectionValueIds(sectionDescriptor)) {
        const value = readControlById(form, id);
        if (value !== undefined) snapshot.set(id, value);
    }
    return snapshot;
}

// 把快照回写到（新渲染的）分区控件上。
export function restoreSectionValues(form, snapshot) {
    for (const [id, value] of snapshot) {
        writeControlById(form, id, value);
    }
}
