/**
 * 计划页面包屑胶囊上的工程切换菜单。
 * 菜单挂在计划页的 scope 上而不是标题栏里：标题栏随每次刷新整块重绘，菜单不能跟着消失。
 */
const FILTER_THRESHOLD = 6;

export function createProjectPicker({ h, icon, doc, win, host, api, onPick }) {
    let menu = null;
    let seq = 0;
    let unbind = null;

    const isOpen = () => Boolean(menu);
    const trigger = () => host.querySelector('.side-plan-crumbs');

    function close({ restoreFocus = false } = {}) {
        if (!menu) return;
        seq++;
        menu.remove();
        menu = null;
        unbind?.();
        unbind = null;
        const btn = trigger();
        btn?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) btn?.focus();
    }

    async function listAll() {
        const res = await api?.projectForgeListProjects?.({});
        if (!res?.success) throw new Error(res?.error || '读取工程列表失败');
        return (res.data || [])
            .filter(p => p && !p.deleted_at)
            .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    }

    function item(project, currentId) {
        const btn = h('button', 'side-plan-picker-item');
        btn.type = 'button';
        btn.setAttribute('role', 'option');
        btn.dataset.projectId = project.id;
        const current = project.id === currentId;
        btn.setAttribute('aria-selected', String(current));
        btn.appendChild(h('span', 'side-plan-picker-name', project.name || project.id));
        if (project.workspace_alias) btn.appendChild(h('span', 'side-plan-picker-meta', project.workspace_alias));
        if (current) btn.appendChild(icon('check', 'side-plan-picker-check'));
        btn.addEventListener('click', () => {
            close({ restoreFocus: true });
            if (!current) onPick(project.id, project.name || '');
        });
        return btn;
    }

    function fill(list, { all, topicIds, currentId, query }) {
        list.innerHTML = '';
        const q = query.trim().toLowerCase();
        const match = (p) => !q || `${p.name || ''} ${p.workspace_alias || ''}`.toLowerCase().includes(q);
        const byId = new Map(all.map(p => [p.id, p]));
        const topic = topicIds.map(id => byId.get(id)).filter(Boolean).filter(match);
        const rest = all.filter(p => !topicIds.includes(p.id)).filter(match);
        const group = (label, projects) => {
            if (!projects.length) return;
            if (topic.length) list.appendChild(h('div', 'side-plan-picker-label', label));
            projects.forEach(p => list.appendChild(item(p, currentId)));
        };
        group('本话题用过', topic);
        group('全部工程', rest);
        if (!topic.length && !rest.length) list.appendChild(h('div', 'side-plan-picker-empty', q ? '没有匹配的工程' : '还没有工程'));
    }

    function move(delta) {
        const items = [...menu.querySelectorAll('.side-plan-picker-item')];
        if (!items.length) return;
        const at = items.indexOf(doc.activeElement);
        const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
        items[next].focus();
    }

    async function open({ currentId, topicIds = [] }) {
        close();
        const token = ++seq;
        menu = h('div', 'side-plan-picker');
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', '切换工程');
        const list = h('div', 'side-plan-picker-list');
        list.appendChild(h('div', 'side-plan-picker-empty', '正在读取工程…'));
        menu.appendChild(list);
        host.appendChild(menu);
        trigger()?.setAttribute('aria-expanded', 'true');

        const onPointer = (event) => {
            if (menu?.contains(event.target) || trigger()?.contains(event.target)) return;
            close();
        };
        const onKey = (event) => {
            if (event.key === 'Escape') { event.preventDefault(); close({ restoreFocus: true }); }
            else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        };
        const onBlur = () => close();
        doc.addEventListener('pointerdown', onPointer, true);
        menu.addEventListener('keydown', onKey);
        win.addEventListener('blur', onBlur);
        unbind = () => {
            doc.removeEventListener('pointerdown', onPointer, true);
            win.removeEventListener('blur', onBlur);
        };

        let all = [];
        try {
            all = await listAll();
        } catch (error) {
            if (token !== seq) return;
            list.innerHTML = '';
            list.appendChild(h('div', 'side-plan-picker-empty', error?.message || '读取工程列表失败'));
            return;
        }
        if (token !== seq) return;
        const state = { all, topicIds, currentId, query: '' };
        if (all.length > FILTER_THRESHOLD) {
            const input = h('input', 'side-plan-picker-filter');
            input.type = 'search';
            input.placeholder = '筛选工程…';
            input.setAttribute('aria-label', '筛选工程');
            input.addEventListener('input', () => { state.query = input.value; fill(list, state); });
            input.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                menu.querySelector('.side-plan-picker-item')?.click();
            });
            menu.insertBefore(input, list);
            fill(list, state);
            input.focus();
        } else {
            fill(list, state);
            (menu.querySelector('.side-plan-picker-item[aria-selected="true"]') || menu.querySelector('.side-plan-picker-item'))?.focus();
        }
    }

    return { open, close, isOpen, dispose: () => close() };
}
