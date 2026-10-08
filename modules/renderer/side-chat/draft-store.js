/* Browser-local composer state; the Electron profile supplies the storage partition. */
'use strict';

export function sideChatDraftKey(descriptor) {
    const parent = descriptor?.parent, child = descriptor?.child;
    if (!parent?.itemId || !parent?.topicId || !child?.itemId || !child?.topicId) return null;
    return `vcp.sideChat.composer.v1:${encodeURIComponent(JSON.stringify([
        parent.itemId, parent.topicId, child.itemId, child.topicId
    ]))}`;
}

function composerInput(value) {
    return {
        draft: typeof value?.draft === 'string' ? value.draft : '',
        references: (Array.isArray(value?.references) ? value.references : [])
            .filter(ref => ref && typeof ref.id === 'string' && typeof ref.text === 'string')
            .map(({ id, text, sourceMessageId }) => ({ id, text, sourceMessageId: typeof sourceMessageId === 'string' ? sourceMessageId : null })),
        model: typeof value?.model === 'string' ? value.model : null
    };
}

export function createSideChatDraftStore({ getStorage }) {
    function access(descriptor, action) {
        try {
            const key = sideChatDraftKey(descriptor);
            const storage = getStorage();
            if (!key || !storage) throw new Error('辅助对话草稿存储不可用');
            return action(storage, key);
        } catch (error) {
            return { ok: false, error };
        }
    }

    return Object.freeze({
        read(descriptor) {
            return access(descriptor, (storage, key) => {
                const raw = storage.getItem(key);
                if (raw === null) return { ok: true, input: null };
                const value = JSON.parse(raw);
                if (!value || value.version !== 1 || typeof value.draft !== 'string') throw new Error('辅助对话草稿格式无效');
                return { ok: true, input: composerInput(value) };
            });
        },
        save(descriptor, input) {
            return access(descriptor, (storage, key) => {
                // Keep an empty record: clearing input must override a legacy file draft.
                storage.setItem(key, JSON.stringify({ version: 1, ...composerInput(input) }));
                return { ok: true };
            });
        },
        remove(descriptor) {
            return access(descriptor, (storage, key) => {
                storage.removeItem(key);
                return { ok: true };
            });
        }
    });
}
