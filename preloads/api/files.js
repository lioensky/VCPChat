'use strict';

// 剪贴板、图片/文本查看器、外部链接、本地文件读取、拖拽文件真实路径、Python 执行。
// 主进程：modules/ipc/fileDialogHandlers.js、modules/ipc/windowHandlers.js（image-viewer:*）、main.js（execute-python-code）
const { invoke, send, custom } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/fileDialogHandlers.js', 'modules/ipc/windowHandlers.js', 'main.js'],
    roles: ['chat', 'utility'],
    api: {
        // 主进程返回 { success, data, extension }；页面只拿到 { data, extension } 或 null
        readImageFromClipboard: invoke('read-image-from-clipboard-main')
            .mapResult((result) => (result && result.success ? { data: result.data, extension: result.extension } : null)),
        // 主进程返回 { success, text }；页面只拿到字符串，失败时为 ''
        readTextFromClipboard: invoke('read-text-from-clipboard-main')
            .mapResult((result) => (result && result.success ? result.text : '')),

        showImageContextMenu: send('show-image-context-menu', 'imageUrl'),
        openImageViewer: send('open-image-viewer', 'data'),
        openImageInNewWindow: send('open-image-in-new-window', 'imageUrl', 'imageTitle'),
        // 大体积图片 payload 经主进程内存缓存中转，避免把 dataURL 塞进窗口 URL
        registerImageViewerPayload: invoke('image-viewer:register-payload', 'payload').roles('utility'),
        consumeImageViewerPayload: invoke('image-viewer:consume-payload', 'token').roles('utility'),
        copyGifToClipboard: invoke('image-viewer:copy-gif', 'gifBytes').roles('utility'),
        openTextInNewWindow: invoke('display-text-content-in-viewer', 'textContent', 'windowTitle', 'theme'),

        sendOpenExternalLink: send('open-external-link', 'url').roles('chat', 'utility', 'desktop'),

        getTextContent: invoke('get-text-content', 'filePath', 'fileType'),
        getFileAsBase64: invoke('get-file-as-base64', 'filePath').roles('chat'),
        openPythonAttachmentInTextEditor: invoke('open-python-attachment-in-text-editor', 'fileUrl').roles('chat'),
        executePythonCode: invoke('execute-python-code', 'code').roles('utility'),

        // 同步返回拖拽 File 对应的本地路径；非本地文件（如浏览器拖入的数据）返回 ''。不经过 IPC。
        getPathForFile: custom('query', null, ({ webUtils }) => (file) => {
            try {
                return webUtils?.getPathForFile?.(file) || '';
            } catch {
                return '';
            }
        }).roles('chat'),
    },
};