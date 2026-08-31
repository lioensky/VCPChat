// ThemeRuntime owns preference/effective resolution and immutable snapshots.
(() => {
    class ThemeRuntime {
        constructor({ matchMedia = globalThis.matchMedia?.bind(globalThis) } = {}) {
            // Window.matchMedia is an IDL method and must retain its Window
            // receiver in Chromium/Electron. Store an already-bound capability
            // so resolution remains safe when called from ThemeRuntime.resolve.
            this.matchMedia = typeof matchMedia === 'function' ? matchMedia : null;
            this.preference = 'system';
            this.effective = this.resolve('system');
            this.revision = 0;
            this.listeners = new Set();
        }
        resolve(preference) {
            if (preference === 'light' || preference === 'dark') return preference;
            return this.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
        }
        snapshot(source = 'runtime') {
            return Object.freeze({ name: 'theme', value: Object.freeze({ ready: true, preference: this.preference, effective: this.effective }), revision: this.revision, source });
        }
        setPreference(preference, source = 'runtime') {
            const next = preference === 'light' || preference === 'dark' || preference === 'system' ? preference : 'system';
            const effective = this.resolve(next);
            if (next === this.preference && effective === this.effective) return this.snapshot(source);
            this.preference = next; this.effective = effective; this.revision += 1;
            const snapshot = this.snapshot(source);
            this.listeners.forEach(listener => listener(snapshot.value, snapshot));
            return snapshot;
        }
        subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    }
    globalThis.VCPThemeRuntime = ThemeRuntime;
})();
