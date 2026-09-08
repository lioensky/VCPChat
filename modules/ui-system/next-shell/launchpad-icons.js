/* One demand-driven animation owner per launchpad render. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.VCPNextShell = Object.freeze({ ...root.VCPNextShell, ...api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const ACCENTS = Object.freeze({
        notes: '#b7a0ff', noteMini: '#efc275', translator: '#68ded5',
        music: '#ff83ad', canvas: '#75bbff', scriptorium: '#a4dbca',
        memo: '#dc9aff', forum: '#ffbb78', log: '#abcbdc', dice: '#ff8d7b',
        rag: '#79e9bc', themes: '#f6a5df', loom: '#82bfff', toolbox: '#edbd84',
        database: '#acdce9', task: '#a2dbb7', plugin: '#b5a0f3',
        terminal: '#a8eb83', desktop: '#929dff', widgets: '#cab2f1'
    });

    class LaunchpadIcons {
        constructor({ document, paint = document.defaultView?.VCPNextShell?.paintLaunchpadIcon }) {
            this.document = document;
            this.window = document.defaultView;
            this.paint = paint;
            this.items = [];
            this.cleanups = [];
            this.frame = null;
            this.last = null;
            this.active = false;
            this.disposed = false;
            this.motion = this.window.matchMedia?.('(prefers-reduced-motion: reduce)');
            this.listen(this.motion, 'change', () => this.invalidate());
            this.listen(document, 'visibilitychange', () => {
                this.stop();
                if (!document.hidden) this.invalidate();
            });
            this.listen(this.window, 'resize', () => this.resize());
            if (this.window.ResizeObserver) {
                this.resizeObserver = new this.window.ResizeObserver(() => this.resize());
            }
            if (this.window.IntersectionObserver) {
                this.intersection = new this.window.IntersectionObserver(entries => {
                    if (this.disposed) return;
                    for (const entry of entries) {
                        const state = this.items.find(item => item.canvas === entry.target);
                        if (state) { state.visible = entry.isIntersecting; state.dirty = true; }
                    }
                    this.wake();
                });
            }
        }

        listen(target, type, handler) {
            if (!target?.addEventListener) return;
            target.addEventListener(type, handler);
            this.cleanups.push(() => target.removeEventListener(type, handler));
        }

        attach(button, host, key) {
            if (this.disposed || !Object.hasOwn(ACCENTS, key) || !this.paint) return false;
            const canvas = this.document.createElement('canvas');
            let c;
            try { c = canvas.getContext('2d'); } catch { return false; }
            if (!c?.roundRect) return false;
            canvas.className = 'next-ui-living-icon';
            canvas.setAttribute('aria-hidden', 'true');
            const state = {
                canvas, c, data: [key, '', '', ACCENTS[key]], size: 256,
                energy: 0, x: 0, y: 0, kick: 0, time: 0,
                hovered: false, focused: false, visible: !this.intersection, dirty: true
            };
            // Paint before replacing the fallback: unsupported artwork must not hide it.
            try { this.paint(state, 0); } catch { return false; }
            host.replaceChildren(canvas);
            host.classList.add('next-ui-app-icon-living');
            host.removeAttribute('data-tone');
            host.setAttribute('aria-hidden', 'true');
            this.items.push(state);
            const change = (property, value) => {
                state[property] = value;
                state.dirty = true;
                this.wake();
            };
            const cleanupStart = this.cleanups.length;
            state.host = host;
            this.listen(button, 'pointerenter', () => change('hovered', true));
            this.listen(button, 'pointerleave', () => {
                state.x = state.y = 0;
                change('hovered', false);
            });
            this.listen(button, 'focus', () => change('focused', true));
            this.listen(button, 'blur', () => change('focused', false));
            this.listen(button, 'pointermove', event => {
                if (this.motion?.matches) return;
                const rect = button.getBoundingClientRect();
                state.x = rect.width ? (event.clientX - rect.left) / rect.width * 2 - 1 : 0;
                state.y = rect.height ? (event.clientY - rect.top) / rect.height * 2 - 1 : 0;
                state.dirty = true;
                this.wake();
            });
            this.listen(button, 'pointerdown', () => change('kick', 1));
            this.listen(button, 'pointercancel', () => change('kick', 0));
            state.cleanups = this.cleanups.splice(cleanupStart);
            this.resizeObserver?.observe(canvas);
            this.intersection?.observe(canvas);
            return true;
        }

        detach(host) {
            const index = this.items.findIndex(item => item.host === host);
            if (index < 0) return;
            const [item] = this.items.splice(index, 1);
            item.cleanups.forEach(cleanup => cleanup());
            this.resizeObserver?.unobserve(item.canvas);
            this.intersection?.unobserve(item.canvas);
            if (!this.items.length) this.stop();
        }

        resize() {
            if (this.disposed) return;
            for (const item of this.items) {
                const width = item.canvas.getBoundingClientRect().width;
                if (width) item.size = Math.max(1, Math.round(width * Math.min(this.window.devicePixelRatio || 1, 2)));
                item.dirty = true;
            }
            this.wake();
        }

        invalidate() {
            for (const item of this.items) item.dirty = true;
            this.wake();
        }

        setActive(active) {
            if (this.disposed || this.active === active) return;
            this.active = active;
            if (active) this.resize();
            else {
                this.stop();
                for (const item of this.items) {
                    item.hovered = item.focused = false;
                    item.energy = item.kick = item.x = item.y = 0;
                    item.dirty = true;
                }
            }
        }

        stop() {
            if (this.frame !== null) this.window.cancelAnimationFrame?.(this.frame);
            this.frame = null;
            this.last = null;
        }

        wake() {
            if (this.disposed || !this.active || this.document.hidden || this.frame !== null) return;
            if (this.window.requestAnimationFrame) {
                this.frame = this.window.requestAnimationFrame(now => this.tick(now));
            }
        }

        tick(now) {
            this.frame = null;
            if (this.disposed || !this.active || this.document.hidden) return;
            const dt = this.last === null ? 0.016 : Math.min((now - this.last) / 1000, 0.05);
            this.last = now;
            let again = false;
            for (const item of this.items) {
                if (!item.visible || !item.canvas.isConnected) continue;
                const target = !this.motion?.matches && (item.hovered || item.focused) ? 1 : 0;
                const moving = target || item.energy > 0.002 || item.kick > 0;
                if (!moving && !item.dirty) continue;
                item.energy += (target - item.energy) * Math.min(1, dt * 12);
                item.kick = Math.max(0, item.kick - dt * 4);
                if (this.motion?.matches) item.energy = item.kick = 0;
                else item.time += dt * item.energy;
                if (item.energy < 0.002) item.energy = 0;
                this.paint(item, this.motion?.matches ? 0 : item.time);
                item.dirty = false;
                again ||= Boolean(target || item.energy || item.kick);
            }
            if (again) this.wake();
            else this.last = null;
        }

        dispose() {
            if (this.disposed) return;
            this.disposed = true;
            this.stop();
            this.resizeObserver?.disconnect();
            this.intersection?.disconnect();
            this.items.forEach(item => item.cleanups.forEach(cleanup => cleanup()));
            this.cleanups.splice(0).forEach(cleanup => cleanup());
            this.items.length = 0;
        }
    }
    return { LaunchpadIcons, LAUNCHPAD_ICON_ACCENTS: ACCENTS };
});