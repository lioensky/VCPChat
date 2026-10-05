/**
 * modules/ui-system/side-pane/side-pane-tab-dnd.js
 * 标签条的横向拖拽排序（指针事件实现，横向列表排序）：
 * 拖动超过 4px 才算拖拽；被拖标签跟随指针，途经的标签让位；松手后按最近中心点落位；Esc 取消。
 */

'use strict';

import { findClosestCenterIndex } from './side-pane-tab-utils.js';

const DRAG_ACTIVATION_DISTANCE_PX = 4;

export function createTabSortable({
    container,
    itemSelector = '.side-pane-tab-item',
    ignoreSelector = '.side-pane-tab-close',
    isDraggable = () => true,
    onReorder,
    onDragStateChange = null
}) {
    if (!container) throw new TypeError('createTabSortable requires a container');
    const doc = container.ownerDocument;
    const win = doc.defaultView;

    let session = null;
    let suppressNextClick = false;

    function getItems() {
        return Array.from(container.querySelectorAll(itemSelector));
    }

    function clearTransforms(items) {
        items.forEach((item) => {
            item.style.transform = '';
            item.classList.remove('is-dragging', 'is-shifting');
        });
    }

    function finish(commit) {
        if (!session) return;
        const { items, fromIndex, toIndex, active, pointerId } = session;
        try { active.releasePointerCapture?.(pointerId); } catch { /* 捕获可能已丢失 */ }
        doc.removeEventListener('keydown', onKeyDown, true);
        const activeId = active.getAttribute('data-tab-id');
        const overId = items[toIndex]?.getAttribute('data-tab-id');
        const moved = session.dragging && commit && toIndex !== fromIndex;
        const wasDragging = session.dragging;
        clearTransforms(items);
        container.classList.remove('is-sorting');
        session = null;
        if (wasDragging) {
            suppressNextClick = true;
            win.setTimeout(() => { suppressNextClick = false; }, 0);
            onDragStateChange?.(false);
        }
        if (moved && activeId && overId) onReorder?.(activeId, overId);
    }

    function onKeyDown(event) {
        if (event.key === 'Escape' && session) {
            event.stopPropagation();
            finish(false);
        }
    }

    function updateDrag(event) {
        const { items, rects, fromIndex, startX, gap } = session;
        const activeRect = rects[fromIndex];
        const containerRect = container.getBoundingClientRect();
        let dx = event.clientX - startX;
        // 不让被拖标签滑出标签条可视区
        const minDx = containerRect.left - activeRect.left;
        const maxDx = containerRect.right - (activeRect.left + activeRect.width);
        dx = Math.max(minDx, Math.min(maxDx, dx));

        const center = activeRect.left + dx + activeRect.width / 2;
        const toIndex = findClosestCenterIndex(rects, center);
        session.toIndex = toIndex < 0 ? fromIndex : toIndex;

        items.forEach((item, index) => {
            if (index === fromIndex) {
                item.style.transform = `translateX(${dx}px)`;
                return;
            }
            let shift = 0;
            if (session.toIndex > fromIndex && index > fromIndex && index <= session.toIndex) {
                shift = -(activeRect.width + gap);
            } else if (session.toIndex < fromIndex && index >= session.toIndex && index < fromIndex) {
                shift = activeRect.width + gap;
            }
            item.style.transform = shift ? `translateX(${shift}px)` : '';
        });
    }

    function onPointerDown(event) {
        if (event.button !== 0 || session) return;
        if (event.target.closest?.(ignoreSelector)) return;
        const item = event.target.closest?.(itemSelector);
        if (!item || !container.contains(item) || !isDraggable(item)) return;
        const items = getItems();
        const fromIndex = items.indexOf(item);
        if (fromIndex === -1 || items.length < 2) return;
        const rects = items.map((el) => {
            const rect = el.getBoundingClientRect();
            return { left: rect.left, width: rect.width };
        });
        const gap = items.length > 1 ? Math.max(0, rects[1].left - (rects[0].left + rects[0].width)) : 0;
        session = {
            items, rects, gap, fromIndex, toIndex: fromIndex,
            active: item, pointerId: event.pointerId,
            startX: event.clientX, startY: event.clientY, dragging: false
        };
    }

    function onPointerMove(event) {
        if (!session || event.pointerId !== session.pointerId) return;
        if (!session.dragging) {
            const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
            if (distance < DRAG_ACTIVATION_DISTANCE_PX) return;
            session.dragging = true;
            try { session.active.setPointerCapture?.(event.pointerId); } catch { /* 忽略 */ }
            doc.addEventListener('keydown', onKeyDown, true);
            container.classList.add('is-sorting');
            session.items.forEach((item) => item.classList.add('is-shifting'));
            session.active.classList.remove('is-shifting');
            session.active.classList.add('is-dragging');
            onDragStateChange?.(true);
        }
        event.preventDefault();
        updateDrag(event);
    }

    function onPointerUp(event) {
        if (!session || event.pointerId !== session.pointerId) return;
        finish(true);
    }

    function onPointerCancel(event) {
        if (!session || event.pointerId !== session.pointerId) return;
        finish(false);
    }

    function onClickCapture(event) {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        event.preventDefault();
        event.stopPropagation();
    }

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerCancel);
    container.addEventListener('click', onClickCapture, true);

    return {
        isDragging: () => Boolean(session?.dragging),
        dispose() {
            finish(false);
            container.removeEventListener('pointerdown', onPointerDown);
            container.removeEventListener('pointermove', onPointerMove);
            container.removeEventListener('pointerup', onPointerUp);
            container.removeEventListener('pointercancel', onPointerCancel);
            container.removeEventListener('click', onClickCapture, true);
        }
    };
}
