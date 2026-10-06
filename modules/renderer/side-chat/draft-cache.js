/* Auxiliary conversation input belongs to its provider, across tab unmounts. */
'use strict';

function childKeyOf(descriptor, fallbackId = '') {
    return `${descriptor?.child?.itemId || ''}:${descriptor?.child?.topicId || descriptor?.id || fallbackId}`;
}

export function createSideChatDraftCache() {
    const drafts = new Map();

    function restore(handle, descriptor) {
        const key = childKeyOf(descriptor);
        const cached = drafts.get(key);
        drafts.delete(key);
        const source = cached || descriptor;
        if (typeof source.draft === 'string' && typeof handle.setDraft === 'function' && handle.getDraft?.() !== source.draft) handle.setDraft(source.draft);
        if (Array.isArray(source.references) && typeof handle.addReference === 'function') {
            source.references.forEach(ref => {
                if (!handle.getReferences?.().some(current => current.id === ref.id)) handle.addReference(ref);
            });
        }
        if (descriptor.model && typeof handle.setModel === 'function' && handle.getModel?.() !== descriptor.model) {
            handle.setModel(descriptor.model);
        }
    }

    function capture(handle, descriptor) {
        const draft = handle.getDraft?.() || '';
        const references = handle.getReferences?.() || [];
        drafts.set(childKeyOf(descriptor), { draft, references });
    }

    function ownHandle(handle, descriptor) {
        if (!handle) return handle;
        restore(handle, descriptor);
        const properties = Object.getOwnPropertyDescriptors(handle);
        let disposed = false;
        properties.dispose = {
            enumerable: true,
            value: async () => {
                if (disposed) return;
                disposed = true;
                capture(handle, descriptor);
                await handle.dispose?.();
            }
        };
        return Object.freeze(Object.defineProperties({}, properties));
    }

    return Object.freeze({ ownHandle, forget: descriptor => drafts.delete(childKeyOf(descriptor)), dispose() { drafts.clear(); } });
}
