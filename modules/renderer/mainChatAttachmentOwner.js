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

    return Object.freeze({
        ref,
        get: ref.get,
        clear() {
            assertActive();
            files = Object.freeze([]);
            return files;
        },
        syncPreview() {
            if (disposed) return false;
            renderPreview?.(files);
            return true;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            files = Object.freeze([]);
        },
    });
}
