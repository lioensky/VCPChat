(function installSidebarResizer(global) {
    'use strict';

    function create({
        handle,
        document: documentRef = global.document,
        eventNames = { down: 'mousedown', move: 'mousemove', up: 'mouseup', cancel: 'mouseleave' },
        getValue,
        getBounds,
        applyValue,
        onCommit,
        beforeBegin,
        direction = 1,
        step = 20,
        onActiveChange,
    }) {
        if (!handle || !documentRef || typeof getValue !== 'function'
            || typeof getBounds !== 'function' || typeof applyValue !== 'function') {
            throw new TypeError('A sidebar resizer needs a handle, value accessors, bounds, and an apply callback.');
        }

        let active = false;
        let startX = 0;
        let startValue = 0;
        let pendingValue = null;
        let frame = 0;
        let activePointerId = null;

        const normalize = (value) => {
            const bounds = getBounds() || {};
            const min = Number.isFinite(bounds.min) ? bounds.min : 0;
            const max = Math.max(min, Number.isFinite(bounds.max) ? bounds.max : min);
            return Math.max(min, Math.min(max, value));
        };

        const flush = () => {
            frame = 0;
            if (pendingValue === null) return;
            applyValue(pendingValue, getBounds() || {});
        };

        const schedule = (value) => {
            pendingValue = normalize(value);
            if (!frame) frame = global.requestAnimationFrame(flush);
        };

        const stop = (event) => {
            if (!active) return;
            if (frame) {
                global.cancelAnimationFrame(frame);
                frame = 0;
            }
            flush();
            const completedValue = pendingValue;
            pendingValue = null;
            active = false;
            onActiveChange?.(false);
            onCommit?.(completedValue, event);
            if (Number.isInteger(activePointerId)) handle.releasePointerCapture?.(activePointerId);
            activePointerId = null;
            documentRef.removeEventListener(eventNames.move, move);
            documentRef.removeEventListener(eventNames.up, stop);
            if (eventNames.cancel) documentRef.removeEventListener(eventNames.cancel, stop);
        };

        const move = (event) => {
            if (!active) return;
            schedule(startValue + ((event.clientX - startX) * direction));
        };

        const start = (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            stop(event);
            active = true;
            startX = event.clientX;
            startValue = getValue();
            pendingValue = startValue;
            activePointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
            if (activePointerId !== null) handle.setPointerCapture?.(activePointerId);
            onActiveChange?.(true);
            documentRef.addEventListener(eventNames.move, move);
            documentRef.addEventListener(eventNames.up, stop);
            if (eventNames.cancel) documentRef.addEventListener(eventNames.cancel, stop);
        };

        const begin = (event) => {
            if (beforeBegin?.(event, () => start(event)) === false) return;
            start(event);
        };

        const keydown = (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const delta = event.key === 'ArrowRight' ? step : -step;
            const value = normalize(getValue() + (delta * direction));
            applyValue(value, getBounds() || {});
            onCommit?.(value, event);
        };

        handle.addEventListener(eventNames.down, begin);
        handle.addEventListener('keydown', keydown);
        return {
            refresh() {
                applyValue(normalize(getValue()), getBounds() || {});
            },
            dispose() {
                stop();
                handle.removeEventListener(eventNames.down, begin);
                handle.removeEventListener('keydown', keydown);
            },
        };
    }

    global.VCPSidebarResizer = Object.freeze({ create });
}(window));
