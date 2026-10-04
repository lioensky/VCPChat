/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

export function createSideChatReferences({
    store,
    doc,
    referenceList,
    getHandle
}) {
    function renderReferences() {
        referenceList.replaceChildren();
        referenceList.hidden = store.references.length === 0;
        if (store.references.length === 0) return;

        store.references.forEach((ref, idx) => {
            const card = doc.createElement('div');
            card.className = 'side-chat-reference-box';

            const preview = doc.createElement('span');
            preview.className = 'side-chat-ref-text';
            const shortText = ref.text.length > 80 ? ref.text.slice(0, 80) + '...' : ref.text;
            preview.textContent = `${store.references.length > 1 ? `引用 ${idx + 1}` : '引用'}：「${shortText}」`;

            const removeBtn = doc.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'side-chat-reference-remove';
            removeBtn.title = '移除引用';
            removeBtn.setAttribute('aria-label', '移除引用');
            removeBtn.innerHTML = '<span class="vcp-ui-icon">close</span>';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                getHandle().removeReference(ref.id);
            });

            card.append(preview, removeBtn);
            referenceList.appendChild(card);
        });
    }

    return Object.freeze({ renderReferences, dispose() {  } });
}
