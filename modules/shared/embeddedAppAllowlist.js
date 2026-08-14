((root, factory) => {
    const allowlist = factory();
    if (typeof module === 'object' && module.exports) module.exports = allowlist;
    if (root) root.VCPEmbeddedAppAllowlist = allowlist;
})(typeof window !== 'undefined' ? window : globalThis, () => {
    // This is deliberately a security allowlist, not a second product app
    // catalog. The upstream tray remains authoritative for names, icons and
    // standalone launch actions; Main uses this projection only to validate
    // which local pages may run inside a WebContentsView.
    const entries = Object.freeze([
        { action: 'open-notes-window', page: 'Notemodules/notes.html' },
        { action: 'open-note-mini-window', page: 'Notemodules/notemini.html' },
        { action: 'open-translator-window', page: 'Translatormodules/translator.html' },
        { action: 'open-memo-window', page: 'Memomodules/memo.html' },
        { action: 'open-forum-window', page: 'Forummodules/forum.html' },
        { action: 'open-log-window', page: 'Logmodules/log.html' },
        { action: 'open-themes-window', page: 'Themesmodules/themes.html' },
        { action: 'open-task-window', page: 'Agenttaskmodules/task.html' },
        { action: 'open-plugin-manager-window', page: 'PluginManagerModules/plugin-manager.html' },
    ].map(Object.freeze));
    const byAction = new Map(entries.map(entry => [entry.action, entry]));
    return Object.freeze({
        entries,
        get: action => byAction.get(action) || null,
        isEmbeddable: action => byAction.has(action),
    });
});
