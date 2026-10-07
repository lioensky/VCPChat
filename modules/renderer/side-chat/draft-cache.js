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
        // 休眠前的内存快照是最新的：它没有的引用是用户删掉的，不能因为 localStorage 没写进去就从旧存档里复活
        if (cached && Array.isArray(cached.references) && typeof handle.removeReference === 'function') {
            const keep = new Set(cached.references.map(ref => ref.id));
            (handle.getReferences?.() || []).filter(ref => !keep.has(ref.id)).forEach(ref => handle.removeReference(ref.id));
        }
        if (Array.isArray(source.references) && typeof handle.addReference === 'function') {
            source.references.forEach(ref => {
                if (!handle.getReferences?.().some(current => current.id === ref.id)) handle.addReference(ref);
            });
        }
        // 模型同理：休眠前选的模型以内存快照为准
        const model = cached?.model || descriptor.model;
        if (model && typeof handle.setModel === 'function' && handle.getModel?.() !== model) {
            handle.setModel(model);
        }
    }

    function capture(handle, descriptor) {
        const draft = handle.getDraft?.() || '';
        const references = handle.getReferences?.() || [];
        const model = handle.getModel?.() || null;
        drafts.set(childKeyOf(descriptor), { draft, references, model });
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
