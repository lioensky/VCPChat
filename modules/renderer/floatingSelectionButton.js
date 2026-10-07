const MAX_REFERENCE_CHARS = 8000;

export function createFloatingSelectionButton({ doc, win, notify }) {
    const floatingBtn = doc.getElementById('floatingSelectionSideChatBtn');
    if (!floatingBtn) return Object.freeze({ dispose() {} });

    const getSelectionMessageItem = (range) => {
        const node = range?.commonAncestorContainer;
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        // 只认主聊天区的消息；侧栏对话里的选区若再"在侧栏提问"会把回复喂回同一个侧聊
        if (!element?.closest?.('#chatMessages') || element.closest('.side-chat-surface')) return null;
        return element.closest('.message-item') || null;
    };

    const hide = () => { floatingBtn.hidden = true; };
    // 按钮是 fixed 定位在选区视口坐标上；任何滚动或尺寸变化都会让坐标失效（ZCode MarkdownSelectionTooltip 同样在滚动时收起）
    const onViewportChange = () => { if (!floatingBtn.hidden) hide(); };

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
    doc.addEventListener('scroll', onViewportChange, true);
    win.addEventListener('resize', onViewportChange);
    floatingBtn.addEventListener('mousedown', onMouseDown);
    floatingBtn.addEventListener('click', onClick);
    return Object.freeze({
        dispose: () => {
            doc.removeEventListener('selectionchange', onSelectionChange);
            doc.removeEventListener('scroll', onViewportChange, true);
            win.removeEventListener('resize', onViewportChange);
            floatingBtn.removeEventListener('mousedown', onMouseDown);
            floatingBtn.removeEventListener('click', onClick);
        }
    });
}
