'use strict';
(() => {
    function create({ stage, model, onEdit }) {
        const layer = document.createElement('div');
        layer.className = 'scriptorium-board-html-layer';
        stage.append(layer);
        const entries = new Map();
        let interactive = null;
        function remove(id) {
            const entry = entries.get(id);
            if (!entry) return;
            entry.frame.src = 'about:blank';
            entry.root.remove();
            if (entry.url) void window.scriptoriumAPI.view('board-html-release', { url: entry.url }).catch(() => {});
            entries.delete(id);
            if (interactive === id) interactive = null;
        }
        let pointer = null;
        function refreshTools() {
            entries.forEach((entry, id) => {
                const rect = entry.root.getBoundingClientRect();
                const hover = pointer && pointer.x >= rect.left && pointer.x <= rect.right
                    && pointer.y >= rect.top && pointer.y <= rect.bottom;
                const active = interactive === id;
                entry.root.classList.toggle('tools-visible', Boolean(hover || entry.selected || active));
                entry.root.classList.toggle('is-interactive', active);
                entry.frame.style.pointerEvents = active ? 'auto' : 'none';
                entry.toggle.textContent = active ? '✕ 退出' : '交互';
            });
        }
        function move(event) { pointer = { x: event.clientX, y: event.clientY }; refreshTools(); }
        function leave() { pointer = null; refreshTools(); }
        stage.addEventListener('pointermove', move, { passive: true });
        stage.addEventListener('pointerleave', leave);
        function exit() {
            interactive = null;
            refreshTools();
        }
        const escape = (event) => { if (event.key === 'Escape') exit(); };
        window.addEventListener('keydown', escape, true);
        function sync(elements, state) {
            const nodes = elements.filter((element) => !element.isDeleted && element.customData?.vcpHtml);
            const ids = new Set(nodes.map((element) => element.id));
            for (const id of entries.keys()) if (!ids.has(id)) remove(id);
            const zoom = state.zoom?.value || 1;
            for (const element of nodes) {
                const node = element.customData.vcpHtml;
                let entry = entries.get(element.id);
                if (!entry || entry.source !== node.source) {
                    remove(element.id);
                    const root = document.createElement('div');
                    root.className = 'scriptorium-board-html-node';
                    root.dataset.nodeId = element.id;
                    const frame = document.createElement('iframe');
                    frame.setAttribute('sandbox', 'allow-scripts');
                    frame.setAttribute('referrerpolicy', 'no-referrer');
                    frame.title = node.title || 'HTML 节点';
                    frame.style.pointerEvents = 'none';
                    const html = model.sandboxDocument(node.source);
                    const tools = document.createElement('div');
                    tools.className = 'scriptorium-board-html-tools';
                    for (const [label, act] of [
                        ['交互', () => {
                            const was = interactive === element.id;
                            exit();
                            if (!was) { interactive = element.id; refreshTools(); frame.focus(); }
                        }],
                        ['源码', () => onEdit(element.id)],
                    ]) {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.textContent = label;
                        button.addEventListener('click', act);
                        tools.append(button);
                    }
                    root.append(frame, tools);
                    layer.append(root);
                    entry = { root, frame, toggle: tools.firstElementChild, selected: false, url: null, source: node.source };
                    entries.set(element.id, entry);
                    const pending = entry;
                    void window.scriptoriumAPI.view('board-html-page', { html }).then((result) => {
                        if (!result.success) throw new Error(result.error);
                        if (entries.get(element.id) !== pending) {
                            return window.scriptoriumAPI.view('board-html-release', { url: result.url });
                        }
                        pending.url = result.url;
                        frame.src = result.url;
                    }).catch((error) => { frame.title = `节点加载失败：${error.message}`; });
                }
                const x = (element.x + (state.scrollX || 0)) * zoom;
                const y = (element.y + (state.scrollY || 0)) * zoom;
                Object.assign(entry.root.style, {
                    width: `${element.width}px`, height: `${element.height}px`,
                    transform: `translate(${x}px,${y}px) scale(${zoom}) rotate(${element.angle || 0}rad)`,
                });
                entry.selected = Boolean(state.selectedElementIds?.[element.id]);
                // 默认事件穿透给画布；仅浮动工具条与交互态iframe接收事件。
            }
            refreshTools();
        }
        function clear() { for (const id of [...entries.keys()]) remove(id); }
        function dispose() {
            clear(); layer.remove();
            stage.removeEventListener('pointermove', move);
            stage.removeEventListener('pointerleave', leave);
            window.removeEventListener('keydown', escape, true);
        }
        return Object.freeze({ sync, clear, dispose, hasNodes: () => entries.size > 0 });
    }
    window.ScriptoriumBoardHtml = Object.freeze({ create });
})();