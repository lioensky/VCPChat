// modules/renderer/imageHandler.js
/** Creates one image interaction owner for one MessageRenderer instance. */
export function createImageHandler({ fixUrl = value => value } = {}) {
    let imageHandlerRefs = null;
    const ownedContentListeners = new Map();

    function cleanupContent(contentDiv) {
        const disposers = ownedContentListeners.get(contentDiv);
        if (!disposers) return;
        ownedContentListeners.delete(contentDiv);
        disposers.splice(0).reverse().forEach(dispose => dispose());
    }

    function initialize(refs) {
        if (!refs?.electronAPI || !refs?.chatMessagesDiv) {
            throw new TypeError('ImageHandler requires Electron transport and a Surface root');
        }
        imageHandlerRefs = Object.freeze({
            electronAPI: refs.electronAPI,
            uiHelper: refs.uiHelper || null,
            chatMessagesDiv: refs.chatMessagesDiv,
        });
    }

/**
 * 将内容设置到DOM元素，并处理其中的图片。
 * 此函数现在管理一个持久化的图片加载状态，以防止在流式渲染中重复加载和闪烁。
 * @param {HTMLElement} contentDiv - 要设置内容的DOM元素。
 * @param {string} rawHtml - 经过marked.parse()处理的原始HTML。
 * @param {string} messageId - 消息ID。
 */
    function setContentAndProcessImages(contentDiv, rawHtml, messageId) {
    if (!imageHandlerRefs) throw new Error('ImageHandler is not initialized');
    cleanupContent(contentDiv);
    // 🟢 直接设置 HTML，不做替换
    contentDiv.innerHTML = rawHtml;
    const transport = imageHandlerRefs.electronAPI;
    const listenerDisposers = [];

    // 🟢 然后对所有 <img> 添加事件监听
    const images = contentDiv.querySelectorAll('img');
    images.forEach((img, index) => {
        let src = img.src;
        
        // 修复表情包 URL
        if (fixUrl && src.includes('表情包')) {
            const fixedSrc = fixUrl(src);
            if (fixedSrc !== src) {
                img.src = fixedSrc;
                src = fixedSrc;
            }
        }
        
        // 添加交互事件
        img.style.cursor = 'pointer';
        img.title = `点击在新窗口预览\n右键可复制图片`;
        
        const onClick = (e) => {
            e.stopPropagation();
            const currentTheme = contentDiv.ownerDocument.body.classList.contains('light-theme') ? 'light' : 'dark';
            transport.openImageViewer({
                src: src,
                title: img.alt || src.split('/').pop() || 'AI 图片',
                theme: currentTheme
            });
        };

        const onContextMenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            transport.showImageContextMenu(src);
        };
        img.addEventListener('click', onClick);
        img.addEventListener('contextmenu', onContextMenu);
        listenerDisposers.push(() => img.removeEventListener('click', onClick));
        listenerDisposers.push(() => img.removeEventListener('contextmenu', onContextMenu));
    });
    if (listenerDisposers.length > 0) ownedContentListeners.set(contentDiv, listenerDisposers);
}

    function dispose() {
        [...ownedContentListeners.keys()].forEach(cleanupContent);
        imageHandlerRefs = null;
    }

    return Object.freeze({ initialize, setContentAndProcessImages, cleanupContent, dispose });
}
