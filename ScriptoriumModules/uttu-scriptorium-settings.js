// 文坊的设置。
// 原来散在几处：上游设置弹窗（只有“信任网络字体”一项）、文件菜单、文脉页底部的自动允许。这里一个对话框列全部。
// 开关都接回原来的存取：上游的勾选框留在藏起来的节点里，这里读它、点它，上游的逻辑不动。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, button, icon, escapeHtml } = UI;
    const $ = (id) => document.getElementById(id);

    const upstream = (input) => ({ on: () => Boolean(input?.checked), flip: () => input?.click() });
    const present = (rows) => rows.filter(Boolean);

    function groups() {
        const collect = $('collect-external-resources');
        const types = [...document.querySelectorAll('#auto-approval-types input')];
        return [
            { title: '保存', rows: present([
                { label: '自动保存', on: () => Boolean(UI.autosaveOn?.()), flip: () => UI.setAutosave?.(!UI.autosaveOn?.()) },
                collect && { label: '保存时收纳外链', note: '把外部图片和字体存进工程', ...upstream(collect) },
            ]) },
            { title: 'Agent', rows: [
                { label: '自动合入 Agent 的修改', ...upstream($('auto-approval-enabled')) },
                ...types.map((input) => ({ label: input.parentElement.textContent.trim(), ...upstream(input), child: true })),
            ] },
            { title: '字体', rows: [
                { label: '信任网络字体', note: '直接加载文档里的字体地址，不存到本机', ...upstream($('trust-network-fonts-toggle')) },
            ] },
        ];
    }

    function checkRow(row) {
        const entry = button(`uttu-chk${row.child ? ' child' : ''}`, '',
            `<span class="box">${icon('i-check')}</span><span>${escapeHtml(row.label)}${row.note ? `<small>${escapeHtml(row.note)}</small>` : ''}</span>`);
        entry.setAttribute('role', 'checkbox');
        const paint = () => entry.setAttribute('aria-checked', String(row.on()));
        entry.addEventListener('click', () => {
            row.flip();
            paint();
        });
        paint();
        return entry;
    }

    let scrim = null;
    function close() {
        scrim?.remove();
        scrim = null;
        window.removeEventListener('keydown', onKey, true);
    }
    function onKey(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
    }
    function open() {
        if (scrim) return;
        scrim = make('div', 'uttu-dlg-scrim');
        const box = make('div', 'uttu-dlg uttu-settings');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', '设置');
        const head = make('h4', '', '设置');
        head.append(make('span', 'grow'), button('uttu-tb', '关闭设置', icon('i-x'), close));
        box.append(head);
        for (const group of groups()) {
            const section = make('section', 'uttu-settings-group');
            section.append(make('span', 'lab', group.title), ...group.rows.map(checkRow));
            box.append(section);
        }
        const turn = window.UTTUScriptoriumBoard?.turnAgents?.(); // 白板点“交给 Agent”时交给谁
        if (turn?.list.length > 1) {
            const section = make('section', 'uttu-settings-group');
            const seg = make('div', 'uttu-seg sm');
            const paint = () => seg.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.v === turn.current())));
            for (const name of turn.list) {
                const option = button('', '', name, () => { turn.set(name); paint(); });
                option.dataset.v = name;
                seg.append(option);
            }
            paint();
            section.append(make('span', 'lab', '白板交给'), seg);
            box.append(section);
        }
        scrim.append(box);
        scrim.addEventListener('pointerdown', (event) => { if (event.target === scrim) close(); });
        document.body.append(scrim);
        window.addEventListener('keydown', onKey, true);
    }

    window.UTTUScriptoriumSettings = Object.freeze({ open, close });
})();
