export function mountDeviceControls(host, device, api) {
    const doc = host.ownerDocument;
    const props = device.properties || [];
    if (!props.length) return null;
    const create = (tag, text) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const fields = new Map();
    const drafts = new Map();
    const receipts = new Map();
    let values = {};
    let online = device.online;
    let busy = false;
    let disposed = false;
    const details = create('div');
    details.className = 'mijia-controls';
    const actions = create('div');
    actions.className = 'mijia-actions';
    const notice = create('small');
    notice.setAttribute('role', 'status');

    const button = (text, action) => {
        const node = create('button', text);
        node.type = 'button';
        node.className = 'mijia-button';
        node.addEventListener('click', action);
        return node;
    };
    const format = (prop, value) => {
        if (value === undefined) return '暂不可读';
        if (prop.type === 'boolean') return value ? '开' : '关';
        return prop.values?.[value] ?? `${value}${prop.unit === '%' ? '%' : prop.unit ? ` ${prop.unit}` : ''}`;
    };
    const read = button('刷新状态', () => void reload());
    const apply = button('应用', () => void write('apply', Object.fromEntries(drafts)));
    const undo = button('撤销', () => {
        drafts.clear();
        receipts.clear();
        notice.textContent = '';
        update();
    });
    const zones = new Map();
    const zoneGrid = create('div');
    zoneGrid.className = 'mijia-zones';
    const hasApply = props.some(prop => prop.commit === 'apply');
    apply.classList.add('mijia-apply');
    actions.append(read);
    if (hasApply) actions.append(apply, undo);

    for (const prop of props) {
        const row = create('div');
        row.className = 'mijia-property';
        const title = create('span', prop.label);
        const current = create('span');
        const receipt = create('small');
        const field = { current, receipt };
        row.append(title, current);
        if (prop.commit === 'immediate' && prop.type === 'boolean') {
            field.control = button('', () => {
                if (typeof values[prop.key] === 'boolean') {
                    void write('immediate', { [prop.key]: !values[prop.key] });
                }
            });
            row.append(field.control);
        } else if (prop.commit === 'apply' && prop.type === 'integer') {
            const control = create('input');
            control.type = 'range';
            control.min = prop.min;
            control.max = prop.max;
            control.step = prop.step;
            control.setAttribute('aria-label', prop.label);
            const draft = create('span');
            control.addEventListener('input', () => {
                const value = control.valueAsNumber;
                if (!Number.isSafeInteger(value)) return;
                if (value === values[prop.key]) drafts.delete(prop.key);
                else drafts.set(prop.key, value);
                receipts.delete(prop.key);
                update();
            });
            Object.assign(field, { control, draft });
            row.append(control, draft);
        }
        row.append(receipt);
        fields.set(prop.key, field);
        if (prop.group && !prop.commit) {
            let zone = zones.get(prop.group);
            if (!zone) {
                zone = create('section');
                zone.className = 'mijia-zone';
                zone.append(create('h3', prop.group));
                zones.set(prop.group, zone);
                if (!zoneGrid.parentNode) details.append(zoneGrid);
                zoneGrid.append(zone);
            }
            title.textContent = prop.label.startsWith(prop.group) ? prop.label.slice(prop.group.length) : prop.label;
            zone.append(row);
        } else {
            details.append(row);
        }
    }
    details.append(actions, notice);
    host.append(details);

    function update() {
        const writable = !busy && online !== false;
        for (const prop of props) {
            const { current, control, draft, receipt } = fields.get(prop.key);
            const value = values[prop.key];
            current.textContent = format(prop, value);
            if (control) {
                control.disabled = !writable || value === undefined;
                if (draft) {
                    control.hidden = value === undefined && !drafts.has(prop.key);
                    control.value = drafts.get(prop.key) ?? value ?? prop.min;
                    draft.textContent = drafts.has(prop.key) ? `待应用：${format(prop, drafts.get(prop.key))}` : '';
                } else {
                    control.textContent = value === undefined ? '开关不可用' : value ? '关灯' : '开灯';
                }
            }
            receipt.textContent = receipts.get(prop.key) || '';
        }
        read.disabled = busy;
        apply.disabled = !writable || !drafts.size || [...drafts.keys()].some(key => values[key] === undefined);
        undo.disabled = busy || !drafts.size;
    }

    async function reload() {
        if (busy || disposed) return;
        busy = true;
        notice.textContent = '正在读取状态…';
        update();
        let response;
        try { response = await api?.mijiaReadProperties?.(device.id); } catch { /* render generic failure */ }
        if (disposed) return;
        busy = false;
        if (response?.success && response.model === device.model) {
            values = response.values;
            for (const [key, value] of drafts) {
                if (values[key] === value) {
                    drafts.delete(key);
                    receipts.delete(key);
                }
            }
            notice.textContent = Object.keys(values).length ? '' : '设备未返回可读属性。';
        } else {
            values = {};
            notice.textContent = '暂时无法读取设备状态。';
        }
        update();
    }

    async function write(mode, changes) {
        if (busy || disposed || online === false || !Object.keys(changes).length) return;
        busy = true;
        notice.textContent = '正在应用…';
        for (const key of Object.keys(changes)) receipts.delete(key);
        update();
        let response;
        try { response = await api?.mijiaWriteProperties?.(device.id, mode, changes); } catch { /* write outcome unknown */ }
        if (disposed) return;
        busy = false;
        let confirmed = 0;
        for (const [key, value] of Object.entries(changes)) {
            const row = response?.results?.[key];
            if (row?.status === 'confirmed' && row.value === value) {
                values[key] = value;
                drafts.delete(key);
                confirmed++;
            } else if (row?.status === 'rejected') {
                receipts.set(key, '设备拒绝，可调整后重试。');
            } else if (!response?.success && ['device_offline', 'device_busy', 'invalid_request', 'auth_expired', 'login_required'].includes(response?.code)) {
                receipts.set(key, '未提交，请刷新后重试。');
            } else {
                if (row?.value !== undefined) values[key] = row.value;
                else delete values[key];
                receipts.set(key, '结果未确认，请刷新状态。');
            }
        }
        notice.textContent = confirmed === Object.keys(changes).length ? '已应用。' : `已确认 ${confirmed} 项，详见各字段。`;
        update();
    }

    update();
    return {
        reload,
        isBusy: () => busy,
        updateOnline(value) {
            online = value;
            update();
        },
        dispose() {
            disposed = true;
            details.remove();
        },
    };
}