/** Owns the main window's pending attachment state and preview projection. */
export function createMainChatAttachmentOwner({ renderPreview = null } = {}) {
    let files = Object.freeze([]);
    let disposed = false;

    const assertActive = () => {
        if (disposed) throw new Error('MainChatAttachmentOwner is disposed.');
    };
    const ref = Object.freeze({
        get: () => files,
        set(value) {
            assertActive();
            files = Object.freeze(Array.isArray(value) ? [...value] : []);
            return files;
        },
        append(value) {
            assertActive();
            files = Object.freeze([...files, value]);
            return files;
        },
    });

    const syncPreview = () => {
        if (disposed) return false;
        renderPreview?.(files, removeAt);
        return true;
    };

    function removeAt(index) {
        assertActive();
        if (!Number.isInteger(index) || index < 0 || index >= files.length) return false;
        files = Object.freeze(files.filter((_, fileIndex) => fileIndex !== index));
        syncPreview();
        return true;
    }

    return Object.freeze({
        ref,
        get: ref.get,
        clear() {
            assertActive();
            files = Object.freeze([]);
            return files;
        },
        removeAt,
        syncPreview,
        dispose() {
            if (disposed) return;
            disposed = true;
            files = Object.freeze([]);
        },
    });
}
