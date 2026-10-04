const MAX_REFERENCE_CHARS = 8000;

export function createFloatingSelectionButton({ doc, win, notify }) {
    const floatingBtn = doc.getElementById('floatingSelectionSideChatBtn');
    if (!floatingBtn) return Object.freeze({ dispose() {} });

    const getSelectionMessageItem = (range) => {
        const node = range?.commonAncestorContainer;
        return (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.message-item') || null;
    };

    const hide = () => { floatingBtn.hidden = true; };

    const onSelectionChange = () => {
        const sel = win.getSelection();
        const selectedText = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString().trim() : '';
        const range = selectedText.length >= 2 ? sel.getRangeAt(0) : null;
        if (!range || !getSelectionMessageItem(range)) {
            hide();
            return;
        }
        const rect = range.getBoundingClientRect();
        floatingBtn.hidden = false;
        const btnWidth = floatingBtn.offsetWidth || 110;
        const left = Math.max(10, Math.min(win.innerWidth - btnWidth - 10, rect.left + rect.width / 2 - btnWidth / 2));
        floatingBtn.style.left = `${Math.round(left)}px`;
        floatingBtn.style.top = `${Math.round(Math.max(10, rect.top - 36))}px`;
    };

    // 按下时不抢走选区
    const onMouseDown = (e) => e.preventDefault();

    const onClick = async (e) => {
        e.stopPropagation();
        const sel = win.getSelection();
        const selectedText = sel ? sel.toString().trim() : '';
        hide();
        if (!selectedText) return;
        if (selectedText.length > MAX_REFERENCE_CHARS) {
            notify(`选区文本超过 ${MAX_REFERENCE_CHARS} 字符上限，无法引用`, 'warning');
            return;
        }
        const messageItem = getSelectionMessageItem(sel.rangeCount ? sel.getRangeAt(0) : null);
        const sourceMessageId = messageItem?.getAttribute?.('data-message-id') || messageItem?.id || null;
        await win.openSideChatWithSelection({ selectedText, message: { id: sourceMessageId } });
    };

    doc.addEventListener('selectionchange', onSelectionChange);
    floatingBtn.addEventListener('mousedown', onMouseDown);
    floatingBtn.addEventListener('click', onClick);
    return Object.freeze({
        dispose: () => {
            doc.removeEventListener('selectionchange', onSelectionChange);
            floatingBtn.removeEventListener('mousedown', onMouseDown);
            floatingBtn.removeEventListener('click', onClick);
        }
    });
}
