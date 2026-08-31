// AppearanceProfileRuntime owns layout/typography/density profile state.
(() => {
    class AppearanceProfileRuntime {
        constructor({ normalize }) { this.normalize = normalize; this.current = null; this.revision = 0; }
        resolve(profile, uiMode) { this.current = this.normalize(profile, uiMode); return this.current; }
        commit(profile, uiMode) { this.revision += 1; return this.resolve(profile, uiMode); }
        snapshot() { return Object.freeze({ profile: this.current, revision: this.revision }); }
    }
    globalThis.VCPAppearanceProfileRuntime = AppearanceProfileRuntime;
})();
