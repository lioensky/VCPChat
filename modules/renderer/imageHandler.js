// modules/renderer/imageHandler.js
/** Creates one image interaction owner for one MessageRenderer instance. */
export function createImageHandler({ fixUrl = value => value } = {}) {
    let imageHandlerRefs = null;
    const ownedContentListeners = new Map();

    function isComfyUIImageUrl(src) {
        try {
            const url = new URL(src);
            const hostname = url.hostname.toLowerCase();
            return url.protocol === 'http:'
                && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]')
                && url.port === '8188'
                && url.pathname === '/api/view'
                && Boolean(url.searchParams.get('filename'));
        } catch {
            return false;
        }
    }

    function createImageObjectUrl(ownerWindow, base64Data, mimeType) {
        if (
            !ownerWindow?.atob
            || !ownerWindow?.Blob
            || typeof ownerWindow?.URL?.createObjectURL !== 'function'
        ) {
            return null;
        }

        const binary = ownerWindow.atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }

        const blob = new ownerWindow.Blob([bytes], { type: mimeType || 'application/octet-stream' });
        return ownerWindow.URL.createObjectURL(blob);
    }

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
        // 先设置基础 HTML；受 ComfyUI 来源策略影响的图片随后由主进程安全代理替换。
        contentDiv.innerHTML = rawHtml;
        const transport = imageHandlerRefs.electronAPI;
        const listenerDisposers = [];

        const images = contentDiv.querySelectorAll('img');
        images.forEach((img) => {
            let originalSrc = img.src;
            let displaySrc = originalSrc;
            let objectUrl = null;
            let disposed = false;

            // 修复表情包 URL
            if (fixUrl && originalSrc.includes('表情包')) {
                const fixedSrc = fixUrl(originalSrc);
                if (fixedSrc !== originalSrc) {
                    img.src = fixedSrc;
                    originalSrc = fixedSrc;
                    displaySrc = fixedSrc;
                }
            }

            img.referrerPolicy = 'no-referrer';
            img.style.cursor = 'pointer';
            img.title = `点击在新窗口预览\n右键可复制图片`;

            // Electron Renderer 直接将 ComfyUI URL 用作子资源时可能被来源检查以 403 拒绝。
            // 仅对受严格限制的本机 /api/view 地址调用主进程代理；其他图片保持原加载路径。
            if (isComfyUIImageUrl(originalSrc) && typeof transport.proxyComfyUIImage === 'function') {
                img.dataset.vcpImageProxyState = 'loading';
                void transport.proxyComfyUIImage(originalSrc).then((result) => {
                    if (disposed || !img.isConnected) return;
                    if (!result?.success || !result.data || !result.mimeType) {
                        img.dataset.vcpImageProxyState = 'failed';
                        console.warn('[ImageHandler] ComfyUI image proxy failed:', result?.error || 'Unknown error');
                        return;
                    }

                    const ownerWindow = contentDiv.ownerDocument?.defaultView;
                    objectUrl = createImageObjectUrl(ownerWindow, result.data, result.mimeType);
                    displaySrc = objectUrl || `data:${result.mimeType};base64,${result.data}`;
                    img.src = displaySrc;
                    img.dataset.vcpImageProxyState = 'loaded';
                }).catch((error) => {
                    if (disposed) return;
                    img.dataset.vcpImageProxyState = 'failed';
                    console.warn('[ImageHandler] ComfyUI image proxy request failed:', error);
                });
            }

            const onClick = (event) => {
                event.stopPropagation();
                const currentTheme = contentDiv.ownerDocument.body.classList.contains('light-theme') ? 'light' : 'dark';
                transport.openImageViewer({
                    src: displaySrc,
                    title: img.alt || originalSrc.split('/').pop() || 'AI 图片',
                    theme: currentTheme
                });
            };

            const onContextMenu = (event) => {
                event.preventDefault();
                event.stopPropagation();
                transport.showImageContextMenu(originalSrc);
            };

            img.addEventListener('click', onClick);
            img.addEventListener('contextmenu', onContextMenu);
            listenerDisposers.push(() => {
                disposed = true;
                img.removeEventListener('click', onClick);
                img.removeEventListener('contextmenu', onContextMenu);
                if (objectUrl) {
                    contentDiv.ownerDocument?.defaultView?.URL?.revokeObjectURL?.(objectUrl);
                    objectUrl = null;
                }
            });
        });

        if (listenerDisposers.length > 0) {
            ownedContentListeners.set(contentDiv, listenerDisposers);
        }
    }

    function dispose() {
        [...ownedContentListeners.keys()].forEach(cleanupContent);
        imageHandlerRefs = null;
    }

    return Object.freeze({ initialize, setContentAndProcessImages, cleanupContent, dispose });
}
