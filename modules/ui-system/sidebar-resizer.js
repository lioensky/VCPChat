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
        let pendingBegin = null;
        let disposed = false;
        const windowRef = documentRef.defaultView || global;

        const normalize = (value) => {
            const bounds = getBounds() || {};
            const min = Number.isFinite(bounds.min) ? bounds.min : 0;
            const max = Math.max(min, Number.isFinite(bounds.max) ? bounds.max : min);
            return Math.max(min, Math.min(max, value));
        };

        const flush = () => {
            frame = 0;
            if (!active || disposed || pendingValue === null) return;
            const value = pendingValue;
            pendingValue = null;
            applyValue(value, getBounds() || {});
        };

        const schedule = (value) => {
            pendingValue = normalize(value);
            if (!frame) frame = windowRef.requestAnimationFrame(flush);
        };

        const belongsToGesture = event => active && (!event || activePointerId === null || event.pointerId === activePointerId);

        // Retire listeners and capture before callbacks: releasing capture can
        // synchronously emit lostpointercapture, and disposal must not commit.
        const end = () => {
            active = false;
            if (frame) {
                windowRef.cancelAnimationFrame(frame);
                frame = 0;
            }
            pendingValue = null;
            const pointerId = activePointerId;
            activePointerId = null;
            documentRef.removeEventListener(eventNames.move, move);
            documentRef.removeEventListener(eventNames.up, finish);
            if (eventNames.cancel) documentRef.removeEventListener(eventNames.cancel, cancel);
            handle.removeEventListener('lostpointercapture', cancel);
            windowRef.removeEventListener?.('blur', onWindowBlur);
            if (pointerId !== null && (!handle.hasPointerCapture || handle.hasPointerCapture(pointerId))) {
                handle.releasePointerCapture?.(pointerId);
            }
        };

        const cancel = event => {
            if (!belongsToGesture(event)) return;
            end();
            onActiveChange?.(false);
        };
        const onWindowBlur = () => cancel();

        const finish = event => {
            if (!belongsToGesture(event)) return;
            const value = normalize(startValue + ((event.clientX - startX) * direction));
            end();
            try {
                applyValue(value, getBounds() || {});
                onCommit?.(value, event);
            } finally {
                onActiveChange?.(false);
            }
        };

        const move = (event) => {
            if (!belongsToGesture(event)) return;
            schedule(startValue + ((event.clientX - startX) * direction));
        };

        const start = (event) => {
            if (disposed || active || (event.button !== undefined && event.button !== 0)) return;
            event.preventDefault();
            const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
            if (pointerId !== null) handle.setPointerCapture?.(pointerId);
            active = true;
            startX = event.clientX;
            startValue = getValue();
            pendingValue = startValue;
            activePointerId = pointerId;
            onActiveChange?.(true);
            documentRef.addEventListener(eventNames.move, move);
            documentRef.addEventListener(eventNames.up, finish);
            if (eventNames.cancel) documentRef.addEventListener(eventNames.cancel, cancel);
            handle.addEventListener('lostpointercapture', cancel);
            windowRef.addEventListener?.('blur', onWindowBlur);
        };

        const begin = (event) => {
            if (disposed || active || pendingBegin || (event.button !== undefined && event.button !== 0)) return;
            if (typeof beforeBegin !== 'function') {
                start(event);
                return;
            }
            event.preventDefault();
            const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
            const pending = {
                cancel: ended => {
                    if (pointerId === null || ended.pointerId === pointerId) abandonBegin();
                },
                blur: () => abandonBegin()
            };
            pendingBegin = pending;
            documentRef.addEventListener(eventNames.up, pending.cancel);
            if (eventNames.cancel) documentRef.addEventListener(eventNames.cancel, pending.cancel);
            windowRef.addEventListener?.('blur', pending.blur);
            const resume = () => {
                if (disposed || pendingBegin !== pending) return;
                abandonBegin();
                start(event);
            };
            try {
                if (beforeBegin(event, resume) !== false) resume();
            } catch (error) {
                abandonBegin();
                throw error;
            }
        };

        const abandonBegin = () => {
            if (!pendingBegin) return;
            const pending = pendingBegin;
            pendingBegin = null;
            documentRef.removeEventListener(eventNames.up, pending.cancel);
            if (eventNames.cancel) documentRef.removeEventListener(eventNames.cancel, pending.cancel);
            windowRef.removeEventListener?.('blur', pending.blur);
        };

        const keydown = (event) => {
            if (disposed) return;
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
            cancel() {
                abandonBegin();
                cancel();
            },
            refresh() {
                if (disposed) return;
                applyValue(normalize(getValue()), getBounds() || {});
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                abandonBegin();
                try {
                    cancel();
                } finally {
                    handle.removeEventListener(eventNames.down, begin);
                    handle.removeEventListener('keydown', keydown);
                }
            },
        };
    }

    global.VCPSidebarResizer = Object.freeze({ create });
}(window));
