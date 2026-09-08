/* Desktop adapter only: artwork and scheduling are shared with the main launchpad. */
(function () {
    'use strict';
    const keys = Object.freeze({
        'open-notes-window': 'notes', 'open-memo-window': 'memo',
        'open-forum-window': 'forum', 'open-rag-observer-window': 'rag',
        'open-dice-window': 'dice', 'open-canvas-window': 'canvas',
        'open-translator-window': 'translator', 'open-music-window': 'music',
        'open-themes-window': 'themes', 'open-loom-manager': 'loom',
        'launch-human-toolbox': 'toolbox', 'launch-vchat-manager': 'database',
        'open-note-mini-window': 'noteMini', 'open-scriptorium-window': 'scriptorium',
        'open-log-window': 'log', 'open-task-window': 'task',
        'open-plugin-manager-window': 'plugin', 'open-powershell-executor-terminal': 'terminal'
    });
    const owners = new Map();
    const hosts = new Map();
    let disposed = false;
    function keyFor(item) {
        if (item.type !== 'vchat-app' || item.htmlIcon || item.animatedIcon) return null;
        // Only replace official defaults, never user images or dynamic Loom favicons.
        if (item.icon && !String(item.icon).startsWith('../assets/iconset/VChatOfficial/')) return null;
        return keys[item.appAction] || null;
    }
    function sync() {
        if (disposed) return;
        const frozen = window.VCPDesktop.visibilityFreezer?.isFrozen?.() || false;
        for (const [group, owner] of owners) {
            owner.setActive(!frozen && (group !== 'drawer' ||
                document.getElementById('desktop-dock-drawer')?.classList.contains('open')));
        }
    }
    function attach(button, item, group, className) {
        const key = keyFor(item);
        const Icons = window.VCPNextShell?.LaunchpadIcons;
        if (disposed || !key || !Icons) return false;
        let owner = owners.get(group);
        if (!owner) {
            owner = new Icons({ document });
            owners.set(group, owner);
        }
        const host = document.createElement('span');
        host.className = className + ' desktop-living-icon-host';
        if (!owner.attach(button, host, key)) return false;
        // Called before label insertion, or after an explicit old-icon replacement.
        button.firstElementChild?.remove();
        button.prepend(host);
        hosts.set(host, owner);
        sync();
        return true;
    }
    function release(button) {
        const host = button.querySelector('.desktop-living-icon-host');
        if (!host) return;
        hosts.get(host)?.detach(host);
        hosts.delete(host);
        host.remove();
    }
    // Desktop presets and widgets may remove icons outside Dock's own methods.
    const observer = new MutationObserver(() => {
        for (const [host, owner] of hosts) {
            if (!host.isConnected) { owner.detach(host); hosts.delete(host); }
        }
        sync();
    });
    observer.observe(document.getElementById('desktop-canvas'), { childList: true, subtree: true });
    observer.observe(document.getElementById('desktop-dock-items'), { childList: true, subtree: true });
    observer.observe(document.getElementById('desktop-dock-drawer'), {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class']
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    function dispose() {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        owners.forEach(owner => owner.dispose());
        owners.clear();
        hosts.clear();
    }
    window.addEventListener('pagehide', dispose, { once: true });
    window.VCPDesktop.livingIcons = { attach, release, sync, dispose, keyFor };
})();