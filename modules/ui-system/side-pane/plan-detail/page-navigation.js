/** Resident plan pages with keyboard navigation and a separate scroll position per page. */
export function createPlanPageNavigation({ h, button, id, onChange }) {
    let selected = 'plan';
    const positions = new Map();
    const select = (key, scrollTop = 0) => {
        if (selected === key) return;
        positions.set(selected, scrollTop);
        selected = key;
    };
    const pageForFocus = ({ todoId, section } = {}) => {
        if (todoId !== undefined && todoId !== null) return 'plan';
        return ({ timeline: 'timeline', files: 'files', contributors: 'details', report: 'details' })[section] || 'plan';
    };
    function render(pages) {
        const tabs = h('div', 'side-plan-pages');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', '工程内容');
        const panels = h('div', 'side-plan-panels');
        pages.forEach((page, index) => {
            const tabId = `${id}:page:${page.key}`;
            const panelId = `${tabId}:panel`;
            const tab = button('side-plan-page-tab');
            tab.id = tabId;
            tab.dataset.planPage = page.key;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(selected === page.key));
            tab.setAttribute('aria-controls', panelId);
            tab.tabIndex = selected === page.key ? 0 : -1;
            tab.appendChild(h('span', '', page.label));
            if (page.count !== undefined) tab.appendChild(h('span', 'side-plan-page-count', String(page.count)));
            tab.addEventListener('click', () => onChange(page.key));
            tab.addEventListener('keydown', event => {
                const next = ({ ArrowLeft: (index + pages.length - 1) % pages.length,
                    ArrowRight: (index + 1) % pages.length, Home: 0, End: pages.length - 1 })[event.key];
                if (next === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                onChange(pages[next].key);
            });
            tabs.appendChild(tab);
            const panel = h('div', 'side-plan-page');
            panel.id = panelId;
            panel.dataset.planPagePanel = page.key;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', tabId);
            panel.tabIndex = 0;
            panel.hidden = selected !== page.key;
            page.content.filter(Boolean).forEach(node => panel.appendChild(node));
            panels.appendChild(panel);
        });
        // 窄面板里页签横向滑动；每次重画都从头开始，所以把选中的页签滑进可见范围
        const current = tabs.querySelector('[aria-selected="true"]');
        tabs.ownerDocument.defaultView?.requestAnimationFrame?.(() => {
            if (!current || !tabs.isConnected || tabs.scrollWidth <= tabs.clientWidth) return;
            const strip = tabs.getBoundingClientRect();
            const box = current.getBoundingClientRect();
            if (box.left < strip.left) tabs.scrollLeft -= strip.left - box.left;
            else if (box.right > strip.right) tabs.scrollLeft += box.right - strip.right;
        });
        return { tabs, panels };
    }
    return { render, select, pageForFocus, get selected() { return selected; },
        get scrollTop() { return positions.get(selected) || 0; } };
}
