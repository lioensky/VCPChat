// ProjectForge 分栏：只在操作结束时落盘；窗口缩小时不覆盖用户偏好。
'use strict';
(() => {
    const KEY = 'vcp-projectforge-sidebar-width';
    const DEFAULT = 300;
    document.addEventListener('DOMContentLoaded', () => {
        const layout = document.querySelector('.layout');
        const handle = document.getElementById('project-sidebar-resizer');
        if (!layout || !handle) return;
        let preferred = DEFAULT;
        try {
            const saved = Number(localStorage.getItem(KEY));
            if (Number.isFinite(saved) && saved > 0) preferred = saved;
        } catch { /* 存储不可用不影响拖动。 */ }
        let width = DEFAULT;
        let drag = null;

        function bounds() {
            const style = getComputedStyle(layout);
            const available = Math.max(0, layout.clientWidth
                - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - handle.offsetWidth);
            const min = Math.min(200, available / 2);
            return { min, max: Math.max(min, available - Math.min(320, available / 2)) };
        }
        function render() {
            const { min, max } = bounds();
            width = Math.round(Math.max(min, Math.min(max, preferred)));
            const value = `${width}px`;
            if (layout.style.getPropertyValue('--pf-sidebar-width') !== value)
                layout.style.setProperty('--pf-sidebar-width', value);
            handle.setAttribute('aria-valuemin', String(Math.round(min)));
            handle.setAttribute('aria-valuemax', String(Math.round(max)));
            handle.setAttribute('aria-valuenow', String(width));
            handle.setAttribute('aria-valuetext', `侧栏 ${width} 像素`);
        }
        function persist() {
            try { localStorage.setItem(KEY, String(preferred)); } catch { /* 非关键偏好。 */ }
        }
        function finish(event) {
            if (!drag || (event?.pointerId != null && event.pointerId !== drag.id)) return;
            const id = drag.id;
            drag = null;
            layout.classList.remove('pf-resizing');
            if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
            persist();
        }
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || drag || event.isPrimary === false) return;
            event.preventDefault();
            handle.setPointerCapture(event.pointerId);
            drag = { id: event.pointerId, x: event.clientX, width };
            layout.classList.add('pf-resizing');
            handle.focus();
        });
        handle.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.id) return;
            const { min, max } = bounds();
            preferred = Math.max(min, Math.min(max, drag.width + event.clientX - drag.x));
            render();
        });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
            handle.addEventListener(type, finish);
        window.addEventListener('blur', () => finish());
        handle.addEventListener('dblclick', () => {
            preferred = DEFAULT;
            render();
            persist();
        });
        handle.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const { min, max } = bounds();
            const step = event.shiftKey ? 40 : 10;
            preferred = event.key === 'Home' ? min : event.key === 'End' ? max
                : Math.max(min, Math.min(max, width + (event.key === 'ArrowRight' ? step : -step)));
            render();
            persist();
        });
        const observer = new ResizeObserver(render);
        observer.observe(layout);
        window.addEventListener('pagehide', () => { finish(); observer.disconnect(); }, { once: true });
        render();
    });
})();