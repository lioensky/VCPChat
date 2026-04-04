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
    let currentColor = '#498094ff';
    let currentBrushSize = 5;
    let history = [];
    let historyStep = -1;
    const maxHistory = 50;

    // 缩放和拖拽变量
    let currentScale = 1;
    const minScale = 0.2;
    const maxScale = 5;
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
    const imageUrl = params.get('src');
    const imageTitle = params.get('title') || '图片预览';
    const initialTheme = params.get('theme') || 'dark';

    applyTheme(initialTheme);

    if (viewerAPI) {
        viewerAPI.onThemeUpdated(applyTheme);
    }

    const decodedTitle = decodeURIComponent(imageTitle);
    document.title = decodedTitle;
    document.getElementById('image-title-text').textContent = decodedTitle;

    // ========== 工具函数 ==========

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

    // 清除画布
    clearBtn.addEventListener('click', () => {
        if (confirm('确定要清除所有绘图吗？')) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            saveToHistory();
        }
    });

    // ========== 图片加载 ==========

    if (imageUrl) {
        const decodedImageUrl = decodeURIComponent(imageUrl);
        console.log('Image Viewer: Loading image -', decodedImageUrl);
        imgElement.src = decodedImageUrl;

        imgElement.onload = () => {
            console.log('Image Viewer: Image loaded successfully.');
            imgElement.style.display = 'block';
            imageControls.style.display = 'flex';
            errorDiv.style.display = 'none';

            // 设置画布大小
            canvas.width = imgElement.naturalWidth;
            canvas.height = imgElement.naturalHeight;
            canvas.style.width = imgElement.offsetWidth + 'px';
            canvas.style.height = imgElement.offsetHeight + 'px';

            // 设置图像画布用于取色
            imageCanvas.width = imgElement.naturalWidth;
            imageCanvas.height = imgElement.naturalHeight;
            imageCtx.drawImage(imgElement, 0, 0, imgElement.naturalWidth, imgElement.naturalHeight);

            // 保存初始空白状态
            saveToHistory();

            // 默认选择选择工具
            setTool('select');

            // 右键单击可切换UI可见性
            imageContainer.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                toolbar.classList.toggle('hidden');
                imageControls.classList.toggle('active');
            });

            // ========== 缩放和拖拽功能 ==========
            
            imgElement.addEventListener('wheel', (event) => {
                if (event.ctrlKey && currentTool === 'select') {
                    event.preventDefault();

                    const scaleAmount = 0.1;
                    const oldScale = currentScale;
                    let newScale;

                    if (event.deltaY < 0) {
                        newScale = Math.min(maxScale, oldScale + scaleAmount);
                    } else {
                        newScale = Math.max(minScale, oldScale - scaleAmount);
                    }

                    if (newScale === oldScale) return;

                    currentScale = newScale;
                    updateTransform();
                }
            }, { passive: false });

            let dragStartX, dragStartY;
            imgElement.addEventListener('mousedown', (event) => {
                if (event.button === 0 && currentScale > 1 && currentTool === 'select') {
                    isDragging = true;
                    dragStartX = event.clientX;
                    dragStartY = event.clientY;
                    imgElement.style.cursor = 'grabbing';
                    event.preventDefault();
                }
            });

            document.addEventListener('mousemove', (event) => {
                if (isDragging && currentTool === 'select') {
                    const dx = event.clientX - dragStartX;
                    const dy = event.clientY - dragStartY;
                    imgInitialX += dx;
                    imgInitialY += dy;
                    dragStartX = event.clientX;
                    dragStartY = event.clientY;
                    updateTransform();
                }
            });

            document.addEventListener('mouseup', (event) => {
                if (event.button === 0 && isDragging) {
                    isDragging = false;
                    if (currentScale > 1) {
                        imgElement.style.cursor = 'grab';
                    } else {
                        imgElement.style.cursor = 'default';
                    }
                }
            });

            function updateTransform() {
                const transform = `translate(${imgInitialX}px, ${imgInitialY}px) scale(${currentScale})`;
                imageContainer.style.transform = transform;
                
                if (currentScale > 1) {
                    imgElement.style.cursor = 'grab';
                } else {
                    imgElement.style.cursor = 'default';
                    imgInitialX = 0;
                    imgInitialY = 0;
                    imageContainer.style.transform = `scale(${currentScale})`;
                }
            }
        };

        imgElement.onerror = () => {
            console.error('Image Viewer: Error loading image');
            imgElement.style.display = 'none';
            imageControls.style.display = 'none';
            errorDiv.textContent = `无法加载图片: ${decodeURIComponent(imageTitle)}`;
            errorDiv.style.display = 'block';
        };
    } else {
        errorDiv.textContent = '未提供图片URL。';
        errorDiv.style.display = 'block';
    }

    // ========== 保存和导出功能 ==========

    // 保存编辑后的图片
    saveEditedButton.addEventListener('click', async () => {
        try {
            // 创建合成画布
            const mergedCanvas = document.createElement('canvas');
            mergedCanvas.width = imgElement.naturalWidth;
            mergedCanvas.height = imgElement.naturalHeight;
            const mergedCtx = mergedCanvas.getContext('2d');
            
            // 绘制原图
            mergedCtx.drawImage(imgElement, 0, 0);
            // 绘制编辑层
            mergedCtx.drawImage(canvas, 0, 0);
            
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

    // 复制功能（合并编辑后的图）
    copyButton.addEventListener('click', async () => {
        if (!imgElement.src) return;

        const originalText = copyButton.innerHTML;
        try {
            // 创建合成画布
            const mergedCanvas = document.createElement('canvas');
            mergedCanvas.width = imgElement.naturalWidth;
            mergedCanvas.height = imgElement.naturalHeight;
            const mergedCtx = mergedCanvas.getContext('2d');
            
            // 绘制原图和编辑层
            mergedCtx.drawImage(imgElement, 0, 0);
            mergedCtx.drawImage(canvas, 0, 0);
            
            // 转换为 blob 并复制
            const blob = await new Promise(resolve => mergedCanvas.toBlob(resolve, 'image/png'));
            const item = new ClipboardItem({ 'image/png': blob });
            await navigator.clipboard.write([item]);
            
            copyButton.innerHTML = '<svg viewBox="0 0 24 24" style="width:18px; height:18px; fill:currentColor;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg> 已复制';
            setTimeout(() => copyButton.innerHTML = originalText, 2000);
        } catch (err) {
            console.error('Copy failed:', err);
            copyButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg> 复制失败';
            setTimeout(() => copyButton.innerHTML = originalText, 2000);
        }
    });

    // 下载功能
    downloadButton.addEventListener('click', () => {
        if (!imgElement.src) return;

        // 创建合成画布
        const mergedCanvas = document.createElement('canvas');
        mergedCanvas.width = imgElement.naturalWidth;
        mergedCanvas.height = imgElement.naturalHeight;
        const mergedCtx = mergedCanvas.getContext('2d');

        // 绘制原图和编辑层
        mergedCtx.drawImage(imgElement, 0, 0);
        mergedCtx.drawImage(canvas, 0, 0);

        // 创建下载链接并点击
        const link = document.createElement('a');
        link.href = mergedCanvas.toDataURL('image/png');
        link.download = decodeURIComponent(imageTitle) || 'image.png';
        link.click();
    });

    // ========== OCR 功能 ==========
    ocrButton.addEventListener('click', async () => {
        if (!imgElement.src) return;

        const originalHtml = ocrButton.innerHTML;
        ocrButton.innerHTML = '识别中...';
        ocrButton.disabled = true;

        try {
            const { data: { text } } = await Tesseract.recognize(
                imgElement.src,
                'chi_sim+eng', // 识别简体中文和英文
                {
                    logger: m => {
                        console.log(m);
                        if (m.status === 'recognizing text') {
                            const progress = (m.progress * 100).toFixed(0);
                            ocrButton.innerHTML = `识别中 ${progress}%`;
                        }
                    }
                }
            );
            
            // 清理文本：去除多余的空格和空行
            const cleanedText = text.replace(/ /g, '').replace(/\n{2,}/g, '\n');
            ocrResultText.value = cleanedText;
            ocrResultModal.style.display = 'block';

        } catch (err) {
            console.error('OCR 失败:', err);
            ocrResultText.value = '文字识别失败: ' + err.message;
            ocrResultModal.style.display = 'block';
        } finally {
            ocrButton.innerHTML = originalHtml;
            ocrButton.disabled = false;
        }
    });

    // 关闭 OCR 弹窗
    ocrModalClose.addEventListener('click', () => {
        ocrResultModal.style.display = 'none';
    });

    // 点击弹窗外部关闭
    window.addEventListener('click', (event) => {
        if (event.target == ocrResultModal) {
            ocrResultModal.style.display = 'none';
        }
    });

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
            if (currentTool !== 'select') {
                setTool('select');
            } else {
                if (viewerAPI?.closeWindow) {
                    viewerAPI.closeWindow();
                } else {
                    window.close();
                }
            }
        }
        
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

        // 快捷键切换工具
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

    // ========== 动态工具栏布局 ==========
    function updateToolbarLayout() {
        const toolbar = document.getElementById('toolbar');
        const stackableSections = document.querySelectorAll('.stackable');
        const windowHeight = window.innerHeight;
        const toolbarHeight = toolbar.offsetHeight;

        // 先重置状态，以便正确计算高度
        stackableSections.forEach(section => section.classList.remove('stacked'));

        // 重新获取高度
        const unstackedHeight = toolbar.offsetHeight;

        if (unstackedHeight > windowHeight * 0.95) {
            stackableSections.forEach(section => section.classList.add('stacked'));
        } else {
            stackableSections.forEach(section => section.classList.remove('stacked'));
        }
    }

    window.addEventListener('resize', updateToolbarLayout);
    // 初始加载时也执行一次
    imgElement.addEventListener('load', updateToolbarLayout);
    // 如果图片已缓存，可能不会触发load事件，所以在DOM加载后也执行
    updateToolbarLayout();
});
