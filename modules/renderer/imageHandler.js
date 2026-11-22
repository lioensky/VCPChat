// modules/renderer/imageHandler.js
import { prepareChatMediaHtml, cleanupChatMedia } from './mediaLifecycle.js';

const MAX_GALLERY_IMAGES = 200;
const MIN_GALLERY_EDGE = 48;

function describeImage(image, src) {
    const fileName = /^data:/i.test(src) ? '' : src.split(/[?#]/, 1)[0].split('/').pop();
    const alt = image.alt.trim();
    return { src, title: (!/^data:/i.test(alt) && alt) || fileName || 'AI 图片' };
}

function isEmoticonSource(src) {
    return src.includes('表情包') || /%E8%A1%A8%E6%83%85%E5%8C%85/i.test(src);
}

function collectGallery(root, selectedImage) {
    if (!root.contains(selectedImage)) return {};
    const gallery = [];
    let index = -1;
    for (const image of root.querySelectorAll('.message-item .md-content img')) {
        const src = image.currentSrc || image.src;
        if (!src || isEmoticonSource(src) || isEmoticonSource(image.src)
            || image.closest('.chat-avatar, .message-avatar, .avatar')
            || image.naturalWidth < MIN_GALLERY_EDGE || image.naturalHeight < MIN_GALLERY_EDGE) continue;
        if (image === selectedImage) index = gallery.length;
        gallery.push(describeImage(image, src));
        if (gallery.length === MAX_GALLERY_IMAGES) break;
    }
    return index >= 0 && gallery.length > 1 ? { gallery, index } : {};
}
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
    cleanupChatMedia(contentDiv);
    // Parse in an inert template before any autoplay attribute reaches live DOM.
    contentDiv.innerHTML = prepareChatMediaHtml(rawHtml, contentDiv.ownerDocument);
    const { electronAPI: transport, chatMessagesDiv } = imageHandlerRefs;
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
            e.preventDefault(); // The viewer handles this click, including images inside anchors.
            e.stopPropagation();
            const currentTheme = contentDiv.ownerDocument.body.classList.contains('light-theme') ? 'light' : 'dark';
            transport.openImageViewer({
                ...describeImage(img, img.currentSrc || img.src || src),
                theme: currentTheme,
                ...collectGallery(chatMessagesDiv, img),
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
