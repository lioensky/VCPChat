/* Open-tab entry ordering, availability and execution. */
'use strict';

export function createSidePaneEntries({ doc, list, hideMenus, onEntriesChanged }) {
    let disposed = false;
    // ---- 打开标签页入口：{ id, label, icon?, order?, open(), isAvailable?() } ----
    const entryMap = new Map();
    let entrySeq = 0;

    function availableEntries() {
        return Array.from(entryMap.values())
            .filter(entry => {
                try { return entry.isAvailable?.() !== false; } catch { return false; }
            })
            .sort((a, b) => a.order - b.order || a.seq - b.seq);
    }

    function createEntryRow({ icon, label }) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'side-pane-menu-item';
        btn.setAttribute('role', 'menuitem');
        const iconEl = doc.createElement('span');
        iconEl.className = 'vcp-ui-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        iconEl.textContent = icon || 'tab';
        const labelEl = doc.createElement('span');
        labelEl.className = 'side-pane-menu-item-label';
        labelEl.textContent = label;
        btn.append(iconEl, labelEl);
        return btn;
    }

    function renderEntries() {
        const entries = availableEntries();
        list?.replaceChildren(...entries.map(entry => {
            const row = createEntryRow(entry);
            row.setAttribute('data-open-tab-entry', entry.id);
            return row;
        }));
        onEntriesChanged(entries);
    }

    async function runEntry(entryId) {
        const entry = entryMap.get(entryId);
        hideMenus();
        if (!entry || disposed) return;
        try {
            await entry.open();
        } catch (error) {
            console.error(`[SidePaneEntries] Failed to open "${entryId}":`, error);
        }
    }

    function registerEntry(entry) {
        if (disposed) return () => {};
        if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.label !== 'string' || typeof entry.open !== 'function') {
            throw new TypeError('registerOpenTabEntry requires { id, label, open }');
        }
        const stored = Object.freeze({
            id: entry.id,
            label: entry.label,
            icon: entry.icon ? String(entry.icon) : 'tab',
            order: Number.isFinite(entry.order) ? entry.order : 100,
            seq: entrySeq++,
            open: entry.open,
            isAvailable: typeof entry.isAvailable === 'function' ? entry.isAvailable : null
        });
        entryMap.set(stored.id, stored);
        renderEntries();
        return () => {
            if (entryMap.get(stored.id) !== stored) return;
            entryMap.delete(stored.id);
            if (!disposed) renderEntries();
        };
    }

    return Object.freeze({ availableEntries, registerEntry, renderEntries, runEntry,
        dispose() { disposed = true; entryMap.clear(); }
    });
}
