// 给桌宠文件：拖到桌宠上、往输入框里粘贴图片，和下一句话一起发。
// 数量上限和重名改写在 attachments.js 里（纯函数）。
import { addFiles, describeFiles, pastedName, MAX_FILES, MAX_PASTE_BYTES } from 'vcp-deskpet://pet/app/attachments.js';

export function createPetFiles(ctx) {
    const { api, $ } = ctx;

    function setFiles(list) {
        ctx.composer.files = list;
        $('attachText').textContent = describeFiles(list);
        $('attachText').title = list.map((f) => f.name).join('\n');
        $('attachTray').hidden = !list.length;
        $('composerSend').classList.toggle('is-empty', !$('composerInput').value.trim() && !list.length);
    }

    function takeFiles(files) {
        const { list, dropped } = addFiles(ctx.composer.files, files);
        setFiles(list);
        if (dropped) ctx.notice(`一次最多带 ${MAX_FILES} 个文件，有 ${dropped} 个没加上`, { ms: 3500 });
        // 正在录音：文件先挂上，录完进输入条时一起看到；不打断录音
        if (ctx.dock.mode === 'rec') return;
        if (list.length) {
            ctx.openComposer();
            requestAnimationFrame(() => $('composerInput').focus());
        }
    }

    function bindFileDrop() {
        const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
        let depth = 0;
        const leave = () => { depth = 0; document.body.classList.remove('is-drop-target'); };
        // 不拦的话，文件掉进来窗口会直接打开这个文件
        window.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth += 1;
            document.body.classList.add('is-drop-target');
        });
        window.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) ? 'copy' : 'none';
        });
        window.addEventListener('dragleave', () => { if (--depth <= 0) leave(); });
        window.addEventListener('drop', (e) => {
            e.preventDefault();
            leave();
            const files = [...(e.dataTransfer?.files || [])].map((file) => ({
                path: api.filePath?.(file) || '',
                name: file.name,
                type: file.type,
                size: file.size,
            })).filter((f) => f.path);
            if (files.length) takeFiles(files);
        });
        $('composerInput').addEventListener('paste', async (e) => {
            const images = [...(e.clipboardData?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
            if (!images.length) return;
            e.preventDefault();
            const files = [];
            for (const item of images) {
                const file = item.getAsFile();
                if (!file) continue;
                if (file.size > MAX_PASTE_BYTES) {
                    ctx.notice('图片太大了（超过 20 MB），拖文件进来试试', { error: true, ms: 3500 });
                    continue;
                }
                const data = new Uint8Array(await file.arrayBuffer());
                files.push({ data, name: pastedName(file.type), type: file.type, size: data.length });
            }
            if (files.length) takeFiles(files);
        });
        $('attachClear').addEventListener('click', (e) => {
            e.stopPropagation();
            setFiles([]);
        });
    }

    return { setFiles, takeFiles, bindFileDrop };
}
