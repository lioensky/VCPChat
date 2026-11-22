document.addEventListener('DOMContentLoaded', async () => {
    const viewerAPI = window.utilityAPI || window.electronAPI;

    const imgElement = document.getElementById('viewerImage');
    const errorDiv = document.getElementById('errorMessage');
    const imageControls = document.getElementById('imageControls');
    const copyButton = document.getElementById('copyButton');
    const downloadButton = document.getElementById('downloadButton');
    const saveEditedButton = document.getElementById('saveEditedButton');
    const canvas = document.getElementById('drawingCanvas');
    const ctx = canvas.getContext('2d');
    const imageContainer = document.getElementById('imageContainer');
    const toolbar = document.getElementById('toolbar');

    // 工具按钮
    const selectTool = document.getElementById('selectTool');
    const brushTool = document.getElementById('brushTool');
    const eraserTool = document.getElementById('eraserTool');
    const eyedropperTool = document.getElementById('eyedropperTool');
    const lineTool = document.getElementById('lineTool');
    const rectTool = document.getElementById('rectTool');
    const circleTool = document.getElementById('circleTool');
    const arrowTool = document.getElementById('arrowTool');
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    const clearBtn = document.getElementById('clearBtn');
    const colorPicker = document.getElementById('colorPicker');
    const brushSize = document.getElementById('brushSize');
    const brushPreview = document.getElementById('brushPreview');
    const colorCodeDisplay = document.getElementById('colorCodeDisplay');

    // OCR 元素
    const ocrButton = document.getElementById('ocrButton');
    const ocrResultModal = document.getElementById('ocrResultModal');
    const ocrModalClose = document.getElementById('ocrModalClose');
    const ocrResultText = document.getElementById('ocrResultText');
    const copyOcrText = document.getElementById('copyOcrText');

    // 状态变量
    let currentTool = 'select';
    let isDrawing = false;
    let startX, startY;
    let currentColor = colorPicker.value;
    let currentBrushSize = 5;
    let history = [];
    let historyStep = -1;
    const maxHistory = 50;

    // 缩放和拖拽变量
    // 长截图（如阅读模式分享出来的整页 Markdown）等比缩放到视口后，
    // 文字相当于被压缩到很小，因此需要一个比常规图片大得多的最大放大倍率。
    let currentScale = 1;
    const minScale = 0.05; // 极端缩小：方便看长截图全貌
    const maxScale = 32;   // 极端放大：方便看清长截图细节文字
    // 滚轮一格 ×1.15；按住 Shift 滚轮一格 ×1.5（快速跳跃）
    const ZOOM_FACTOR_STEP = 1.15;
    const ZOOM_FACTOR_FAST = 1.5;
    let isDragging = false;
    let imgInitialX = 0;
    let imgInitialY = 0;

    // 临时绘图变量
    let tempCanvas = document.createElement('canvas');
    let tempCtx = tempCanvas.getContext('2d');
    let imageCanvas = document.createElement('canvas');
    let imageCtx = imageCanvas.getContext('2d', { willReadFrequently: true });

    // Theme Management
    function applyTheme(theme) {
        document.body.classList.toggle('light-theme', theme === 'light');
    }

    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get('token');
    let imageUrl = params.get('src');
    let imageTitle = params.get('title') || '图片预览';
    const initialTheme = params.get('theme') || 'dark';
    let resolvedImageSrc = '';
    let originalImageBlobPromise = null;
    // 同一话题里的图片，可左右翻页（payload.gallery，来自 renderer/imageHandler.js）。
    let gallery = [];
    let galleryIndex = 0;

    applyTheme(initialTheme);

    if (viewerAPI) {
        viewerAPI.onThemeUpdated(applyTheme);
    }

    // 如果是 token 模式，先尝试从主进程一次性取走真正的 payload。
    // 这样可以承载任意大体积的 dataURL（截图分享）而不会受 URL 长度限制。
    if (tokenFromUrl && viewerAPI && typeof viewerAPI.consumeImageViewerPayload === 'function') {
        try {
            const payload = await viewerAPI.consumeImageViewerPayload(tokenFromUrl);
            if (payload && payload.src) {
                imageUrl = payload.src;
                if (payload.title) imageTitle = payload.title;
                if (payload.theme) applyTheme(payload.theme);
                if (Array.isArray(payload.gallery) && payload.gallery.length > 1) {
                    gallery = payload.gallery.filter(item => item && typeof item.src === 'string');
                    galleryIndex = Math.max(0, Math.min(gallery.length - 1, Number(payload.index) || 0));
                }
                console.log('[ImageViewer] Loaded payload via token. src length:', payload.src.length);
            } else {
                console.error('[ImageViewer] Token payload missing or already consumed:', tokenFromUrl);
            }
        } catch (err) {
            console.error('[ImageViewer] Failed to consume image payload by token:', err);
        }
    }

    const decodedTitle = (() => {
        try {
            return decodeURIComponent(imageTitle);
        } catch (_) {
            return imageTitle;
        }
    })();
    document.title = decodedTitle;
    document.getElementById('image-title-text').textContent = decodedTitle;

    // ========== 工具函数 ==========

    function getImageMimeType(src) {
        const dataUrlMatch = /^data:([^;,]+)/i.exec(src || '');
        if (dataUrlMatch) return dataUrlMatch[1].toLowerCase();

        const cleanUrl = (src || '').split(/[?#]/, 1)[0];
        if (/\.gif$/i.test(cleanUrl) || /\.gif$/i.test(document.title)) return 'image/gif';
        return '';
    }

    function isUneditedGif() {
        return getImageMimeType(resolvedImageSrc) === 'image/gif' && historyStep <= 0 && rotation === 0;
    }

    async function getOriginalImageBlob() {
        if (!resolvedImageSrc) throw new Error('原始图片地址不存在');

        if (!originalImageBlobPromise) {
            originalImageBlobPromise = fetch(resolvedImageSrc)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`读取原始图片失败: HTTP ${response.status}`);
                    }
                    return response.blob();
                })
                .then(blob => {
                    // 某些服务没有返回正确的 Content-Type，以源数据识别结果为准。
                    const mimeType = getImageMimeType(resolvedImageSrc) || blob.type;
                    return mimeType && blob.type !== mimeType
                        ? new Blob([blob], { type: mimeType })
                        : blob;
                })
                .catch(error => {
                    originalImageBlobPromise = null;
                    throw error;
                });
        }

        return originalImageBlobPromise;
    }

    function getGifDownloadName() {
        let fileName = document.title || 'image.gif';
        if (!/\.gif$/i.test(fileName)) {
            fileName = fileName.replace(/\.[a-z0-9]+$/i, '') + '.gif';
        }
        return fileName;
    }

    function getPngDownloadName() {
        const fileName = (document.title || 'image.png').replace(/\.[a-z0-9]+$/i, '') + '.png';
        if (fileName.toLowerCase() !== 'image.png') return fileName;

        const now = new Date();
        const timestamp = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        ].join('') + '_' + [
            String(now.getHours()).padStart(2, '0'),
            String(now.getMinutes()).padStart(2, '0'),
            String(now.getSeconds()).padStart(2, '0')
        ].join('');

        return `image_${timestamp}.png`;
    }

    // 保存当前画布状态到历史记录
    function saveToHistory() {
        historyStep++;
        if (historyStep < history.length) {
            history.length = historyStep;
        }
        history.push(canvas.toDataURL());
        if (history.length > maxHistory) {
            history.shift();
            historyStep--;
        }
    }

    // 从历史记录加载画布
    function loadFromHistory(step) {
        if (step < 0 || step >= history.length) return;
        const img = new Image();
        img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
        };
        img.src = history[step];
    }

    // 获取鼠标在画布上的坐标
    function getCanvasCoordinates(event) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (event.clientX - rect.left) * scaleX,
            y: (event.clientY - rect.top) * scaleY
        };
    }

    // 切换工具
    function setTool(tool) {
        currentTool = tool;
        
        // 更新按钮状态
        document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
        const toolButtons = {
            'select': selectTool,
            'brush': brushTool,
            'eraser': eraserTool,
            'eyedropper': eyedropperTool,
            'line': lineTool,
            'rect': rectTool,
            'circle': circleTool,
            'arrow': arrowTool
        };
        if (toolButtons[tool]) {
            toolButtons[tool].classList.add('active');
        }

        // 更新画布指针事件
        if (tool === 'select') {
            canvas.classList.remove('active');
            canvas.style.cursor = 'default';
        } else {
            canvas.classList.add('active');
            canvas.style.cursor = tool === 'eyedropper' ? 'crosshair' : 'crosshair';
        }
        // 标注工具条常驻在顶栏下面一行；选了画图工具就是在标注，选回“选择”就是看图。
        const annotating = tool !== 'select';
        if (annotating && typeof rotation !== 'undefined' && rotation !== 0) { rotation = 0; resetView(); } // 画布坐标不跟旋转走
        document.body.classList.toggle('viewer-annotating', annotating);
    }

    // 绘制箭头
    function drawArrow(ctx, fromX, fromY, toX, toY) {
        const headlen = 15 * (currentBrushSize / 5); // 箭头大小
        const angle = Math.atan2(toY - fromY, toX - fromX);
        
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
        
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(toX - headlen * Math.cos(angle - Math.PI / 6), toY - headlen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(toX, toY);
        ctx.lineTo(toX - headlen * Math.cos(angle + Math.PI / 6), toY - headlen * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
    }

    // 获取画布上某点的颜色
    function getColorAtPoint(x, y) {
        if (!imageCanvas.width || !imageCanvas.height) {
            return '#000000';
        }
        const clampedX = Math.max(0, Math.min(Math.floor(x), imageCanvas.width - 1));
        const clampedY = Math.max(0, Math.min(Math.floor(y), imageCanvas.height - 1));
        const imageData = imageCtx.getImageData(clampedX, clampedY, 1, 1);
        const pixel = imageData.data;
        if (pixel[3] === 0) { // If transparent, don't pick color
            return currentColor;
        }
        return `#${((1 << 24) + (pixel[0] << 16) + (pixel[1] << 8) + pixel[2]).toString(16).slice(1)}`;
    }

    // ========== 绘图事件处理 ==========

    function startDrawing(event) {
        if (currentTool === 'select') return;
        
        isDrawing = true;
        const coords = getCanvasCoordinates(event);
        startX = coords.x;
        startY = coords.y;

        if (currentTool === 'eyedropper') {
            const color = getColorAtPoint(startX, startY);
            currentColor = color;
            colorPicker.value = color;
            colorCodeDisplay.textContent = color.toUpperCase();
            setTool('brush');
            return;
        }

        if (currentTool === 'brush' || currentTool === 'eraser') {
            ctx.beginPath();
            ctx.moveTo(startX, startY);
        }

        // 保存当前状态到临时画布
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        tempCtx.drawImage(canvas, 0, 0);
    }

    function draw(event) {
        if (!isDrawing || currentTool === 'select' || currentTool === 'eyedropper') return;

        const coords = getCanvasCoordinates(event);
        const currentX = coords.x;
        const currentY = coords.y;

        if (currentTool === 'brush' || currentTool === 'eraser') {
            ctx.lineTo(currentX, currentY);
            ctx.strokeStyle = currentTool === 'eraser' ? '#FFFFFF' : currentColor;
            ctx.lineWidth = currentBrushSize;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalCompositeOperation = currentTool === 'eraser' ? 'destination-out' : 'source-over';
            ctx.stroke();
        } else {
            // 对于形状工具，先恢复临时画布，再绘制预览
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(tempCanvas, 0, 0);
            
            ctx.strokeStyle = currentColor;
            ctx.lineWidth = currentBrushSize;
            ctx.lineCap = 'round';
            ctx.globalCompositeOperation = 'source-over';

            switch (currentTool) {
                case 'line':
                    ctx.beginPath();
                    ctx.moveTo(startX, startY);
                    ctx.lineTo(currentX, currentY);
                    ctx.stroke();
                    break;
                case 'rect':
                    ctx.strokeRect(startX, startY, currentX - startX, currentY - startY);
                    break;
                case 'circle':
                    const radius = Math.sqrt(Math.pow(currentX - startX, 2) + Math.pow(currentY - startY, 2));
                    ctx.beginPath();
                    ctx.arc(startX, startY, radius, 0, 2 * Math.PI);
                    ctx.stroke();
                    break;
                case 'arrow':
                    drawArrow(ctx, startX, startY, currentX, currentY);
                    break;
            }
        }
    }

    function stopDrawing() {
        if (isDrawing && currentTool !== 'select' && currentTool !== 'eyedropper') {
            saveToHistory();
        }
        isDrawing = false;
        ctx.beginPath();
    }

    // ========== 事件监听器 ==========

    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseleave', stopDrawing);

    // 工具按钮事件
    selectTool.addEventListener('click', () => setTool('select'));
    brushTool.addEventListener('click', () => setTool('brush'));
    eraserTool.addEventListener('click', () => setTool('eraser'));
    eyedropperTool.addEventListener('click', () => setTool('eyedropper'));
    lineTool.addEventListener('click', () => setTool('line'));
    rectTool.addEventListener('click', () => setTool('rect'));
    circleTool.addEventListener('click', () => setTool('circle'));
    arrowTool.addEventListener('click', () => setTool('arrow'));

    // 颜色和画笔大小
    colorPicker.addEventListener('input', (e) => {
        currentColor = e.target.value;
        brushPreview.style.backgroundColor = currentColor;
        colorCodeDisplay.textContent = currentColor.toUpperCase();
    });

    brushSize.addEventListener('input', (e) => {
        currentBrushSize = parseInt(e.target.value);
        brushPreview.style.width = currentBrushSize + 'px';
        brushPreview.style.height = currentBrushSize + 'px';
    });

    // 初始化画笔预览
    brushPreview.style.width = currentBrushSize + 'px';
    brushPreview.style.height = currentBrushSize + 'px';
    brushPreview.style.backgroundColor = currentColor;
    colorCodeDisplay.textContent = currentColor.toUpperCase();

    // 点击色码复制
    colorCodeDisplay.addEventListener('click', () => {
        navigator.clipboard.writeText(currentColor).then(() => {
            const originalText = colorCodeDisplay.textContent;
            colorCodeDisplay.textContent = 'Copied!';
            setTimeout(() => {
                colorCodeDisplay.textContent = originalText;
            }, 1000);
        });
    });

    // 撤销/重做
    undoBtn.addEventListener('click', () => {
        if (historyStep > 0) {
            historyStep--;
            loadFromHistory(historyStep);
        }
    });

    redoBtn.addEventListener('click', () => {
        if (historyStep < history.length - 1) {
            historyStep++;
            loadFromHistory(historyStep);
        }
    });

    // 清除画布。不弹系统确认框；直接清除（记进历史），底部出一条“撤销”，4 秒后消失。
    const undoToast = document.getElementById('viewerUndoToast');
    let undoToastTimer = null;
    const hideUndoToast = () => { if (undoToast) undoToast.hidden = true; clearTimeout(undoToastTimer); };
    document.getElementById('viewerUndoClear')?.addEventListener('click', () => { hideUndoToast(); undoBtn.click(); });
    clearBtn.addEventListener('click', () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        saveToHistory();
        if (!undoToast) return;
        undoToast.hidden = false;
        clearTimeout(undoToastTimer);
        undoToastTimer = setTimeout(hideUndoToast, 4000);
    });

    // ========== 图片加载 ==========
    // 打开即适应窗口；滚轮直接以光标为中心缩放；
    // 拖动限制在图片边界内；双击在适应窗口和 100% 之间切换；← / → 翻同一话题的图；交互监听只挂一次，翻页不重复挂。

    const zoomLabel = document.getElementById('viewerZoomLabel');
    const indexLabel = document.getElementById('viewerIndexLabel');
    let interactionBound = false;
    // 旋转只改看的方向；复制、另存为按转过的方向导出。标注时回到 0°（画布坐标不跟旋转走）。
    let rotation = 0;
    // 长截图：高宽比很大、适应窗口后字小到看不清的图。按宽铺满、从顶部开始，滚轮上下滚动，Ctrl+滚轮缩放。
    let longMode = false;

    function isQuarterTurn() { return rotation === 90 || rotation === 270; }
    function isLongView() { return longMode && !isQuarterTurn(); }

    function viewportSize() {
        const stage = imageContainer.parentElement;
        return { w: stage.clientWidth, h: stage.clientHeight };
    }

    function fitScaleFor100() {
        // 适应窗口时 scale=1；100% 是原图像素对屏幕像素
        const shown = imgElement.offsetWidth || 1;
        return (imgElement.naturalWidth || shown) / shown;
    }

    // “适应”时的比例：普通图 1；转了 90° 的图重新适应窗口；长截图按宽铺满。都不超过原图大小。
    function baseScale() {
        const { w: vw, h: vh } = viewportSize();
        const ow = imgElement.offsetWidth || 1;
        const oh = imgElement.offsetHeight || 1;
        const full = Math.max(1, fitScaleFor100());
        if (isLongView()) return Math.min(full, vw / ow);
        if (isQuarterTurn()) return Math.min(full, vw / oh, vh / ow);
        return 1;
    }

    function clampPan() {
        const { w: vw, h: vh } = viewportSize();
        const sw = (isQuarterTurn() ? imgElement.offsetHeight : imgElement.offsetWidth) * currentScale;
        const sh = (isQuarterTurn() ? imgElement.offsetWidth : imgElement.offsetHeight) * currentScale;
        const maxX = Math.max(0, (sw - vw) / 2);
        const maxY = Math.max(0, (sh - vh) / 2);
        imgInitialX = Math.max(-maxX, Math.min(maxX, imgInitialX));
        imgInitialY = Math.max(-maxY, Math.min(maxY, imgInitialY));
    }

    function syncCanvasSize() {
        canvas.style.width = imgElement.offsetWidth + 'px';
        canvas.style.height = imgElement.offsetHeight + 'px';
    }

    function updateTransform() {
        clampPan();
        // 先 translate 后 rotate、scale：translate 单位是屏幕像素，滚轮的光标补偿才准确。只动 transform，不触发排版。
        imageContainer.style.transform = `translate3d(${imgInitialX}px, ${imgInitialY}px, 0) rotate(${rotation}deg) scale(${currentScale})`;
        if (zoomLabel) zoomLabel.textContent = `${Math.round(currentScale / fitScaleFor100() * 100)}%`;
    }

    function zoomTo(newScale, clientX, clientY) {
        const oldScale = currentScale;
        newScale = Math.max(minScale, Math.min(maxScale, newScale));
        if (newScale === oldScale) return;
        const rect = imageContainer.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const px = clientX ?? cx;
        const py = clientY ?? cy;
        const ratio = newScale / oldScale;
        imgInitialX = (px - cx) * (1 - ratio) + imgInitialX;
        imgInitialY = (py - cy) * (1 - ratio) + imgInitialY;
        currentScale = newScale;
        updateTransform();
    }

    function resetView() {
        currentScale = baseScale();
        imgInitialX = 0;
        // 长截图从顶部开始看：先给一个很大的下移量，clampPan 会把它收到“顶边对齐”
        imgInitialY = isLongView() ? Number.MAX_SAFE_INTEGER : 0;
        updateTransform();
    }

    function panBy(dx, dy) {
        imgInitialX += dx;
        imgInitialY += dy;
        updateTransform();
    }

    function rotateBy(delta) {
        if (document.body.classList.contains('viewer-annotating')) return;
        rotation = (rotation + delta + 360) % 360;
        resetView();
    }

    // 滚轮、右键菜单不在这些地方生效：顶栏、标注工具条、缩略图条、识别文字抽屉、菜单本身
    const CHROME_SELECTOR = '#custom-title-bar, .toolbar, #viewerFilmstrip, #ocrResultModal, .viewer-ctxmenu, .viewer-side-arrow, .viewer-undo-toast';

    function bindInteractionOnce() {
        if (interactionBound) return;
        interactionBound = true;

        imageContainer.parentElement.addEventListener('wheel', (event) => {
            if (event.target?.closest?.(CHROME_SELECTOR)) return;
            if (currentTool !== 'select') return;
            event.preventDefault();
            if (isLongView() && !event.ctrlKey) {
                // 长截图：滚轮上下滚动，Shift+滚轮左右
                if (event.shiftKey) panBy(-event.deltaY, 0);
                else panBy(-event.deltaX, -event.deltaY);
                return;
            }
            const factor = event.shiftKey ? ZOOM_FACTOR_FAST : ZOOM_FACTOR_STEP;
            zoomTo(event.deltaY < 0 ? currentScale * factor : currentScale / factor, event.clientX, event.clientY);
        }, { passive: false });

        imgElement.addEventListener('dblclick', (event) => {
            if (currentTool !== 'select') return;
            event.preventDefault();
            const base = baseScale();
            if (Math.abs(currentScale - base) < 0.01) {
                // 普通图：适应 → 100%；长截图：按宽铺满 → 整张放进窗口
                if (isLongView()) zoomTo(1, event.clientX, event.clientY);
                else if (fitScaleFor100() > base + 0.01) zoomTo(fitScaleFor100(), event.clientX, event.clientY);
            } else resetView();
        });

        let dragStartX, dragStartY;
        imgElement.addEventListener('mousedown', (event) => {
            if (event.button === 0 && currentTool === 'select') {
                isDragging = true;
                dragStartX = event.clientX;
                dragStartY = event.clientY;
                event.preventDefault();
            }
        });
        document.addEventListener('mousemove', (event) => {
            if (!isDragging || currentTool !== 'select') return;
            imgInitialX += event.clientX - dragStartX;
            imgInitialY += event.clientY - dragStartY;
            dragStartX = event.clientX;
            dragStartY = event.clientY;
            updateTransform();
        });
        document.addEventListener('mouseup', (event) => {
            if (event.button === 0) isDragging = false;
        });
        const syncLayout = () => { syncCanvasSize(); updateTransform(); };
        if (window.ResizeObserver) {
            new ResizeObserver(syncLayout).observe(imageContainer.parentElement);
        } else {
            window.addEventListener('resize', syncLayout);
        }
    }

    let imageGeneration = 0;
    function showImage(src, title) {
        imageGeneration++;
        hideUndoToast();
        setOcrPanelOpen(false);
        ocrResultText.value = '';
        resolvedImageSrc = src;
        originalImageBlobPromise = null;
        history = [];
        historyStep = -1;
        rotation = 0;
        if (title) {
            document.title = title;
            document.getElementById('image-title-text').textContent = title;
        }
        if (indexLabel) indexLabel.textContent = gallery.length > 1 ? `${galleryIndex + 1} / ${gallery.length}` : '';
        markCurrentThumb();
        imgElement.src = src;
    }

    function showGalleryImage(index) {
        if (gallery.length < 2 || currentTool !== 'select') return;
        const nextIndex = (index + gallery.length) % gallery.length;
        if (nextIndex === galleryIndex) return;
        if (historyStep > 0 && !window.confirm('切换图片将丢弃本张的标注，仍要切换吗？')) return;
        galleryIndex = nextIndex;
        const item = gallery[galleryIndex];
        showImage(item.src, item.title || '图片预览');
    }

    // 底部缩略图条（同一话题有多张图时出现，T 键收起 / 展开）。
    // 缩略图懒加载，只解码看得见的几张；点一下跳过去，滚轮横向滚动。
    const thumbs = document.getElementById('viewerThumbs');

    function buildThumbs() {
        if (!thumbs || gallery.length < 2) return;
        const frag = document.createDocumentFragment();
        gallery.forEach((item, i) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'viewer-thumb';
            button.dataset.index = String(i);
            button.setAttribute('aria-label', `第 ${i + 1} 张`);
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.alt = '';
            img.draggable = false;
            img.src = item.src;
            button.appendChild(img);
            frag.appendChild(button);
        });
        thumbs.appendChild(frag);
        thumbs.addEventListener('click', (event) => {
            const button = event.target.closest('.viewer-thumb');
            if (button) showGalleryImage(Number(button.dataset.index));
        });
        thumbs.addEventListener('wheel', (event) => {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                thumbs.scrollLeft += event.deltaY;
                event.preventDefault();
            }
        }, { passive: false });
    }

    function markCurrentThumb() {
        if (!thumbs || !thumbs.children.length) return;
        thumbs.querySelector('.viewer-thumb.is-current')?.classList.remove('is-current');
        const current = thumbs.children[galleryIndex];
        if (!current) return;
        current.classList.add('is-current');
        current.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    function toggleThumbs() {
        if (gallery.length < 2) return;
        document.body.classList.toggle('viewer-thumbs-hidden');
        requestAnimationFrame(() => { syncCanvasSize(); resetView(); });
    }

    if (gallery.length > 1) {
        document.body.classList.add('viewer-has-gallery');
        buildThumbs();
    }

    imgElement.onload = () => {
        imgElement.style.display = 'block';
        imageControls.style.display = 'flex';
        errorDiv.style.display = 'none';

        canvas.width = imgElement.naturalWidth;
        canvas.height = imgElement.naturalHeight;
        syncCanvasSize();
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 长截图：高是宽的 2.5 倍以上，而且适应窗口后显示宽度不到能显示宽度的 70%
        const { w: vw } = viewportSize();
        longMode = imgElement.naturalHeight / Math.max(1, imgElement.naturalWidth) > 2.5
            && imgElement.offsetWidth < Math.min(imgElement.naturalWidth, vw) * 0.7;
        document.body.classList.toggle('viewer-long-image', longMode);

        imageCanvas.width = imgElement.naturalWidth;
        imageCanvas.height = imgElement.naturalHeight;
        imageCtx.drawImage(imgElement, 0, 0, imgElement.naturalWidth, imgElement.naturalHeight);

        saveToHistory();
        setTool('select');
        bindInteractionOnce();
        resetView();
    };

    imgElement.onerror = () => {
        imgElement.style.display = 'none';
        imageControls.style.display = 'none';
        errorDiv.textContent = `无法加载图片: ${document.title}`;
        errorDiv.style.display = 'block';
    };

    if (imageUrl) {
        // token 模式下 src 已经是原始 dataURL，不需要 decode；URL 模式下 src 是 encodeURIComponent 过的，需要解码。
        let finalSrc = imageUrl;
        if (!tokenFromUrl) {
            try { finalSrc = decodeURIComponent(imageUrl); } catch (_) { finalSrc = imageUrl; }
        }
        showImage(finalSrc, null);
    } else {
        errorDiv.textContent = '未提供图片URL。';
        errorDiv.style.display = 'block';
    }

    // 供键盘快捷键使用
    const viewerNav = { zoomTo, resetView, fitScaleFor100, showGalleryImage, get index() { return galleryIndex; }, get count() { return gallery.length; } };

    // 导出用的合成图：原图 + 标注层，按当前旋转方向画。复制、存编辑、另存为共用。
    function renderExportCanvas() {
        const w = imgElement.naturalWidth;
        const h = imgElement.naturalHeight;
        const out = document.createElement('canvas');
        out.width = isQuarterTurn() ? h : w;
        out.height = isQuarterTurn() ? w : h;
        const outCtx = out.getContext('2d');
        outCtx.translate(out.width / 2, out.height / 2);
        outCtx.rotate(rotation * Math.PI / 180);
        outCtx.drawImage(imgElement, -w / 2, -h / 2);
        outCtx.drawImage(canvas, -w / 2, -h / 2);
        return out;
    }

    // ========== 保存和导出功能 ==========

    // 保存编辑后的图片
    saveEditedButton.addEventListener('click', async () => {
        try {
            // 合成画布：原图 + 编辑层，按旋转方向
            const mergedCanvas = renderExportCanvas();

            // 转换为 blob
            const blob = await new Promise(resolve => mergedCanvas.toBlob(resolve, 'image/png'));
            
            // 复制到剪贴板
            const item = new ClipboardItem({ 'image/png': blob });
            await navigator.clipboard.write([item]);
            
            const originalText = saveEditedButton.innerHTML;
            saveEditedButton.innerHTML = '<svg viewBox="0 0 24 24" style="width:18px; height:18px; fill:currentColor;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg> 已保存';
            setTimeout(() => {
                saveEditedButton.innerHTML = originalText;
            }, 2000);
        } catch (err) {
            console.error('Failed to save edited image:', err);
        }
    });

    // 复制功能：未编辑的 GIF 保留原始动画；其他图片合并编辑层后复制为 PNG。
    copyButton.addEventListener('click', async () => {
        if (!imgElement.naturalWidth) return;

        const originalText = copyButton.innerHTML;
        try {
            let blob;
            let mimeType;

            if (isUneditedGif()) {
                blob = await getOriginalImageBlob();
                mimeType = 'image/gif';

                if (viewerAPI && typeof viewerAPI.copyGifToClipboard === 'function') {
                    const gifBytes = new Uint8Array(await blob.arrayBuffer());
                    await viewerAPI.copyGifToClipboard(gifBytes);
                } else {
                    const item = new ClipboardItem({ [mimeType]: blob });
                    await navigator.clipboard.write([item]);
                }
            } else {
                const mergedCanvas = renderExportCanvas();

                blob =await new Promise(resolve => mergedCanvas.toBlob(resolve, 'image/png'));
                mimeType = 'image/png';

                const item = new ClipboardItem({ [mimeType]: blob });
                await navigator.clipboard.write([item]);
            }

            copyButton.innerHTML = '<svg viewBox="0 0 24 24" style="width:18px; height:18px; fill:currentColor;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg> 已复制';
            setTimeout(() => copyButton.innerHTML = originalText, 2000);
        } catch (err) {
            console.error('Copy failed:', err);
            copyButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg> 复制失败';
            setTimeout(() => copyButton.innerHTML = originalText, 2000);
        }
    });

    // 下载功能：未编辑的 GIF 直接下载原文件，避免画布截取后只剩静态首帧。
    downloadButton.addEventListener('click', async () => {
        if (!imgElement.naturalWidth) return;

        const link = document.createElement('a');

        if (isUneditedGif()) {
            try {
                const blob = await getOriginalImageBlob();
                const objectUrl = URL.createObjectURL(blob);
                link.href = objectUrl;
                link.download = getGifDownloadName();
                link.click();
                setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                return;
            } catch (err) {
                console.error('GIF download failed:', err);
                return;
            }
        }

        const mergedCanvas = renderExportCanvas();

        link.href =mergedCanvas.toDataURL('image/png');
        link.download = getPngDownloadName();
        link.click();
    });

    // ========== OCR 功能 ==========
    let tesseractLoadPromise = null;

    function loadTesseractIfNeeded() {
        if (window.Tesseract) {
            return Promise.resolve(window.Tesseract);
        }

        if (tesseractLoadPromise) {
            return tesseractLoadPromise;
        }

        tesseractLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '../vendor/tesseract.min.js';
            script.async = true;
            script.onload = () => {
                if (window.Tesseract) {
                    resolve(window.Tesseract);
                } else {
                    reject(new Error('本地 OCR 脚本已加载，但 Tesseract 对象不存在。'));
                }
            };
            script.onerror = () => {
                tesseractLoadPromise = null;
                reject(new Error('无法加载本地 OCR 脚本: ../vendor/tesseract.min.js'));
            };
            document.head.appendChild(script);
        });

        return tesseractLoadPromise;
    }

    ocrButton.addEventListener('click', async () => {
        if (!imgElement.naturalWidth) return;

        const generation = imageGeneration;
        const source = resolvedImageSrc;
        const originalHtml = ocrButton.innerHTML;
        ocrButton.innerHTML = '加载 OCR';
        ocrButton.disabled = true;
        // 结果放在右侧抽屉里，不挡图；识别过程中抽屉先打开，显示进度。
        ocrResultText.value = '正在加载识别组件';
        setOcrPanelOpen(true);

        try {
            const TesseractAPI = await loadTesseractIfNeeded();
            ocrButton.innerHTML = '识别中';
            ocrResultText.value = '正在识别';

            const { data: { text } } = await TesseractAPI.recognize(
                source,
                'chi_sim+eng', // 识别简体中文和英文
                {
                    logger: m => {
                        if (generation !== imageGeneration) return;
                        if (m.status === 'recognizing text') {
                            const progress = (m.progress * 100).toFixed(0);
                            ocrButton.innerHTML = `识别中 ${progress}%`;
                            ocrResultText.value = `正在识别 ${progress}%`;
                        }
                    }
                }
            );
            
            if (generation !== imageGeneration) return;
            // 相邻汉字或假名间常有识别器插入的空格；保留英文、数字及其他文字的词界。
            const cleanedText = text
                .replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) +(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '')
                .replace(/\n{2,}/g, '\n');
            ocrResultText.value = cleanedText;

        } catch (err) {
            if (generation !== imageGeneration) return;
            console.error('OCR 失败:', err);
            ocrResultText.value = '文字识别失败: ' + err.message;
        } finally {
            ocrButton.innerHTML = originalHtml;
            ocrButton.disabled = false;
        }
    });

    function setOcrPanelOpen(open) {
        if ((ocrResultModal.style.display === 'block') === open) return;
        ocrResultModal.style.display = open ? 'block' : 'none';
        Promise.resolve(viewerAPI?.setImageViewerOcrOpen?.(open)).catch(error => {
            console.warn('窗口宽度未调整，保留窗口内并排显示。', error);
        });
    }
    ocrModalClose.addEventListener('click', () => setOcrPanelOpen(false));

    // 复制 OCR 文本
    copyOcrText.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(ocrResultText.value);
            const originalText = copyOcrText.textContent;
            copyOcrText.textContent = '已复制!';
            setTimeout(() => {
                copyOcrText.textContent = originalText;
            }, 2000);
        } catch (err) {
            console.error('复制 OCR 文本失败:', err);
        }
    });

    // ========== 键盘快捷键 ==========
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (closeContextMenu()) {
                // 先关右键菜单
            } else if (ocrResultModal.style.display === 'block') {
                setOcrPanelOpen(false);
            } else if (document.body.classList.contains('viewer-annotating')) {
                setAnnotating(false);
            } else if (currentTool !== 'select') {
                setTool('select');
            } else {
                if (viewerAPI?.closeWindow) {
                    viewerAPI.closeWindow();
                } else {
                    window.close();
                }
            }
        }
        
        if (event.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
        // Ctrl+Z 撤销
        if (event.ctrlKey && event.key === 'z' && !event.shiftKey) {
            event.preventDefault();
            undoBtn.click();
        }
        
        // Ctrl+Shift+Z 或 Ctrl+Y 重做
        if ((event.ctrlKey && event.shiftKey && event.key === 'z') || (event.ctrlKey && event.key === 'y')) {
            event.preventDefault();
            redoBtn.click();
        }

        // 看图快捷键。Ctrl+C 复制、Ctrl+S 另存为；0 适应窗口、1 原始大小、+/- 缩放；
        // ← / → 翻页；M 进入或退出标注；H 显示或隐藏界面。标注模式里方向键和 0/1 不抢画图的键。
        if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
            event.preventDefault(); copyButton.click(); return;
        }
        if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 's') {
            event.preventDefault(); downloadButton.click(); return;
        }
        if (!event.ctrlKey && !event.altKey && event.target?.tagName !== 'TEXTAREA' && event.target?.tagName !== 'INPUT') {
            const annotating = document.body.classList.contains('viewer-annotating');
            const key = event.key;
            if (key.toLowerCase() === 'm') { setAnnotating(!annotating); return; }
            if (key.toLowerCase() === 'h') { document.body.classList.toggle('viewer-chrome-hidden'); return; }
            if (!annotating) {
                const pageStep = viewportSize().h * 0.9;
                if (key === 'ArrowLeft') { viewerNav.showGalleryImage(viewerNav.index - 1); return; }
                if (key === 'ArrowRight') { viewerNav.showGalleryImage(viewerNav.index + 1); return; }
                // R 向右转、Shift+R 向左转；T 缩略图条；↑/↓ 平移，长截图里空格 / PageDown / PageUp / Home / End 翻屏
                if (key.toLowerCase() === 'r') { rotateBy(event.shiftKey ? -90 : 90); return; }
                if (key.toLowerCase() === 't') { toggleThumbs(); return; }
                if (key === 'ArrowUp') { event.preventDefault(); panBy(0, 80); return; }
                if (key === 'ArrowDown') { event.preventDefault(); panBy(0, -80); return; }
                if (key === 'PageDown' || (key === ' ' && !event.shiftKey)) { event.preventDefault(); panBy(0, -pageStep); return; }
                if (key === 'PageUp' || (key === ' ' && event.shiftKey)) { event.preventDefault(); panBy(0, pageStep); return; }
                if (key === 'Home') { panBy(0, Number.MAX_SAFE_INTEGER); return; }
                if (key === 'End') { panBy(0, -Number.MAX_SAFE_INTEGER); return; }
                if (key === '0') { viewerNav.resetView(); return; }
                if (key === '1') { viewerNav.zoomTo(viewerNav.fitScaleFor100()); return; }
                if (key === '+' || key === '=') { viewerNav.zoomTo(currentScale * ZOOM_FACTOR_STEP); return; }
                if (key === '-' || key === '_') { viewerNav.zoomTo(currentScale / ZOOM_FACTOR_STEP); return; }
                return; // 看图模式下不响应画图工具的单键
            }
        }

        // 快捷键切换工具（标注模式里）
        if (!event.ctrlKey && !event.shiftKey && !event.altKey) {
            switch(event.key.toLowerCase()) {
                case 'v': setTool('select'); break;
                case 'b': setTool('brush'); break;
                case 'e': setTool('eraser'); break;
                case 'i': setTool('eyedropper'); break;
                case 'l': setTool('line'); break;
                case 'r': setTool('rect'); break;
                case 'c': setTool('circle'); break;
                case 'a': setTool('arrow'); break;
            }
        }
    });

    // ========== 标注、界面自动隐藏 ==========
    // 工具条常驻（顶栏下面一行）；M 键在画笔和“选择”之间切换，等于点工具条上的按钮。
    function setAnnotating(on) {
        closeContextMenu();
        setTool(on ? 'brush' : 'select');
    }
    document.getElementById('viewerPrevBtn')?.addEventListener('click', () => viewerNav.showGalleryImage(viewerNav.index - 1));
    document.getElementById('viewerNextBtn')?.addEventListener('click', () => viewerNav.showGalleryImage(viewerNav.index + 1));
    // 图片两侧的箭头：鼠标在窗口左边或右边四分之一（标题栏和底部条以外）时出现那一侧的箭头。
    document.getElementById('viewerSidePrev')?.addEventListener('click', () => viewerNav.showGalleryImage(viewerNav.index - 1));
    document.getElementById('viewerSideNext')?.addEventListener('click', () => viewerNav.showGalleryImage(viewerNav.index + 1));
    const updateNearSide = (event) => {
        const stage = imageContainer.parentElement;
        const inStage = stage.contains(event.target);
        const band = Math.min(220, stage.clientWidth / 4);
        document.body.classList.toggle('viewer-near-prev', inStage && event.clientX < stage.offsetLeft + band);
        document.body.classList.toggle('viewer-near-next', inStage && event.clientX > stage.offsetLeft + stage.clientWidth - band);
    };
    document.addEventListener('mousemove', updateNearSide, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => document.body.classList.remove('viewer-near-prev', 'viewer-near-next'));
    document.getElementById('viewerZoomLabel')?.addEventListener('click', () => viewerNav.resetView());
    if (gallery.length > 1) document.body.classList.add('viewer-has-gallery');

    // ========== 看图右键菜单 ==========
    // 在图上或空白处右键：复制、另存为、旋转、适应 / 原始大小、识别文字、标注。标注模式里不弹，留给画图。
    const ctxMenu = document.createElement('div');
    ctxMenu.className = 'viewer-ctxmenu';
    ctxMenu.setAttribute('role', 'menu');
    document.body.appendChild(ctxMenu);
    const MENU_ITEMS = [
        ['复制', 'Ctrl+C', () => copyButton.click()],
        ['另存为', 'Ctrl+S', () => downloadButton.click()],
        null,
        ['向左旋转', 'Shift+R', () => rotateBy(-90)],
        ['向右旋转', 'R', () => rotateBy(90)],
        ['适应窗口', '0', () => resetView()],
        ['原始大小', '1', () => zoomTo(fitScaleFor100())],
        null,
        ['识别文字', '', () => ocrButton.click()],
        ['标注', 'M', () => setAnnotating(true)],
    ];
    for (const entry of MENU_ITEMS) {
        if (!entry) {
            const sep = document.createElement('div');
            sep.className = 'viewer-ctxmenu-sep';
            ctxMenu.appendChild(sep);
            continue;
        }
        const [label, keys, run] = entry;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'viewer-ctxmenu-item';
        item.setAttribute('role', 'menuitem');
        const text = document.createElement('span');
        text.textContent = label;
        const hint = document.createElement('span');
        hint.className = 'viewer-ctxmenu-key';
        hint.textContent = keys;
        item.append(text, hint);
        item.addEventListener('click', () => { closeContextMenu(); run(); });
        ctxMenu.appendChild(item);
    }

    function closeContextMenu() {
        if (!ctxMenu.classList.contains('is-open')) return false;
        ctxMenu.classList.remove('is-open');
        return true;
    }

    document.addEventListener('contextmenu', (event) => {
        if (event.target?.closest?.(CHROME_SELECTOR)) return;
        event.preventDefault();
        if (document.body.classList.contains('viewer-annotating') || !imgElement.naturalWidth) return;
        ctxMenu.classList.add('is-open');
        const { offsetWidth: mw, offsetHeight: mh } = ctxMenu;
        const x = Math.min(event.clientX, window.innerWidth - mw - 4);
        const y = Math.min(event.clientY, window.innerHeight - mh - 4);
        ctxMenu.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
    });
    document.addEventListener('mousedown', (event) => {
        if (!event.target?.closest?.('.viewer-ctxmenu')) closeContextMenu();
    });
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('wheel', closeContextMenu, { passive: true });

    // ========== 窗口控制 ==========
    document.getElementById('minimize-viewer-btn').addEventListener('click', () => {
        if (viewerAPI) viewerAPI.minimizeWindow();
    });

    document.getElementById('maximize-viewer-btn').addEventListener('click', () => {
        if (viewerAPI) viewerAPI.maximizeWindow();
    });

    document.getElementById('close-viewer-btn').addEventListener('click', () => {
        if (viewerAPI?.closeWindow) {
            viewerAPI.closeWindow();
        } else {
            window.close();
        }
    });

});
