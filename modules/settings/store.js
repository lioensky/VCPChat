// store — 全局设置表单的值访问门面（M0 最小面）。
// 现阶段唯一的职责：按 schema 字段语义读写表单控件值（开关走 checked，
// 其余走 value），供 schema 面切换时在静态标记与渲染标记之间迁移现值。
// 后续阶段（M1+）它会成长为 typed owner 迁移后的统一取值/回填入口；
// 保存链本身不动：handleSaveGlobalSettings 仍按 id 收集整个表单。
export function readFieldValue(form, field) {
    const control = form?.querySelector(`#${field.key}`);
    if (!control) return undefined;
    return field.type === 'switch' ? control.checked : control.value;
}

export function writeFieldValue(form, field, value) {
    const control = form?.querySelector(`#${field.key}`);
    if (!control || value === undefined) return;
    if (field.type === 'switch') {
        control.checked = Boolean(value);
        return;
    }
    control.value = String(value);
}

// 在替换静态标记之前采集该分区的现值快照（key → 值）。
export function captureSectionValues(form, sectionDescriptor) {
    const snapshot = new Map();
    for (const field of sectionDescriptor.fields) {
        const value = readFieldValue(form, field);
        if (value !== undefined) snapshot.set(field.key, value);
    }
    return snapshot;
}
