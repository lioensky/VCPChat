/**
 * VCPdesktop - 图标选择器模块
 * 负责：从 assets/iconset 预设文件夹中选择自定义图标
 *
 * 支持图标类型：
 *   - image (PNG/JPG/ICO/WebP) — 标准图片图标
 *   - svg — 矢量图标（支持 currentColor 主题适配）
 *   - gif — 动画图标
 *   - html — HTML 富图标（Shadow DOM 隔离渲染，AI 原生生成）
 */

'use strict';

(function () {
    let pickerOverlay = null;
    let currentCallback = null;
    let currentPreset = '';
    let currentPage = 1;
    let currentSearch = '';
    let searchDebounceTimer = null;
    const PAGE_SIZE = 60;

    // ============================================================
    // 创建图标选择器 DOM
    // ============================================================

    function ensurePickerDOM() {
        if (pickerOverlay) return;

        pickerOverlay = document.createElement('div');
        pickerOverlay.className = 'desktop-iconpicker-overlay';
        pickerOverlay.innerHTML = `
            <div class="desktop-iconpicker-panel">
                <div class="desktop-iconpicker-header">
                    <span class="desktop-iconpicker-title">🎨 选择图标</span>
                    <button class="desktop-iconpicker-close" title="关闭">✕</button>
                </div>
                <div class="desktop-iconpicker-toolbar">
                    <select class="desktop-iconpicker-preset-select">
                        <option value="">加载中...</option>
                    </select>
                    <input type="text" class="desktop-iconpicker-search" placeholder="搜索图标..." />
                </div>
                <div class="desktop-iconpicker-grid-wrapper">
                    <div class="desktop-iconpicker-grid"></div>
                </div>
                <div class="desktop-iconpicker-footer">
                    <span class="desktop-iconpicker-info"></span>
                    <div class="desktop-iconpicker-pagination">
                        <button class="desktop-iconpicker-prev" title="上一页">◀</button>
                        <span class="desktop-iconpicker-page-info"></span>
                        <button class="desktop-iconpicker-next" title="下一页">▶</button>
                    </div>
                </div>
            </div>
        `;

        // 点击遮罩关闭
        pickerOverlay.addEventListener('click', (e) => {
            if (e.target === pickerOverlay) {
                closePicker();
            }
        });

        // 关闭按钮
        pickerOverlay.querySelector('.desktop-iconpicker-close').addEventListener('click', () => {
            closePicker();
        });

        // 预设下拉
        const presetSelect = pickerOverlay.querySelector('.desktop-iconpicker-preset-select');
        presetSelect.addEventListener('change', () => {
            currentPreset = presetSelect.value;
            currentPage = 1;
            loadIcons();
        });

        // 搜索框
        const searchInput = pickerOverlay.querySelector('.desktop-iconpicker-search');
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                currentSearch = searchInput.value.trim();
                currentPage = 1;
                loadIcons();
            }, 300);
        });

        // 翻页按钮
        pickerOverlay.querySelector('.desktop-iconpicker-prev').addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                loadIcons();
            }
        });

        pickerOverlay.querySelector('.desktop-iconpicker-next').addEventListener('click', () => {
            currentPage++;
            loadIcons();
        });

        document.body.appendChild(pickerOverlay);
    }

    // ============================================================
    // 打开/关闭
    // ============================================================

    /**
     * 打开图标选择器
     * @param {Function} callback - 选择图标后的回调，参数为 { relativePath, dataUrl }
     */
    async function openPicker(callback) {
        ensurePickerDOM();
        currentCallback = callback;
        currentPage = 1;
        currentSearch = '';

        const searchInput = pickerOverlay.querySelector('.desktop-iconpicker-search');
        searchInput.value = '';

        pickerOverlay.classList.add('visible');

        // 加载预设列表
        await loadPresets();
    }

    function closePicker() {
        if (pickerOverlay) {
            pickerOverlay.classList.remove('visible');
        }
        currentCallback = null;
    }

    // ============================================================
    // 数据加载
    // ============================================================

    async function loadPresets() {
        const presetSelect = pickerOverlay.querySelector('.desktop-iconpicker-preset-select');
        presetSelect.innerHTML = '<option value="">加载中...</option>';

        try {
            const result = await window.electronAPI.desktopIconsetListPresets();
            if (result?.success && result.presets.length > 0) {
                presetSelect.innerHTML = '';
                for (const preset of result.presets) {
                    const opt = document.createElement('option');
                    opt.value = preset.name;
                    opt.textContent = `${preset.name} (${preset.iconCount} 图标)`;
                    presetSelect.appendChild(opt);
                }
                currentPreset = result.presets[0].name;
                presetSelect.value = currentPreset;
                loadIcons();
            } else {
                presetSelect.innerHTML = '<option value="">暂无图标预设</option>';
                const grid = pickerOverlay.querySelector('.desktop-iconpicker-grid');
                grid.innerHTML = '<div class="desktop-iconpicker-empty">未找到图标预设文件夹<br><span style="font-size:11px;opacity:0.5;">请在 assets/iconset/ 目录下添加图标文件夹</span></div>';
            }
        } catch (err) {
            console.error('[IconPicker] Load presets error:', err);
            presetSelect.innerHTML = '<option value="">加载失败</option>';
        }
    }

    async function loadIcons() {
        const grid = pickerOverlay.querySelector('.desktop-iconpicker-grid');
        const info = pickerOverlay.querySelector('.desktop-iconpicker-info');
        const pageInfo = pickerOverlay.querySelector('.desktop-iconpicker-page-info');
        const prevBtn = pickerOverlay.querySelector('.desktop-iconpicker-prev');
        const nextBtn = pickerOverlay.querySelector('.desktop-iconpicker-next');

        if (!currentPreset) {
            grid.innerHTML = '<div class="desktop-iconpicker-empty">请选择图标预设</div>';
            return;
        }

        grid.innerHTML = '<div class="desktop-iconpicker-loading">加载中...</div>';

        try {
            const result = await window.electronAPI.desktopIconsetListIcons({
                presetName: currentPreset,
                page: currentPage,
                pageSize: PAGE_SIZE,
                search: currentSearch,
            });

            if (!result?.success) {
                grid.innerHTML = `<div class="desktop-iconpicker-empty">加载失败: ${result?.error || '未知错误'}</div>`;
                return;
            }

            const { icons, total, page, pageSize } = result;
            const totalPages = Math.ceil(total / pageSize) || 1;

            // 更新翻页信息
            info.textContent = `共 ${total} 个图标`;
            pageInfo.textContent = `${page} / ${totalPages}`;
            prevBtn.disabled = page <= 1;
            nextBtn.disabled = page >= totalPages;

            if (icons.length === 0) {
                grid.innerHTML = '<div class="desktop-iconpicker-empty">未找到匹配的图标</div>';
                return;
            }

            grid.innerHTML = '';

            for (const icon of icons) {
                const cell = document.createElement('div');
                cell.className = 'desktop-iconpicker-cell';
                cell.title = `${icon.name} (${icon.iconType || 'image'})`;

                // 根据图标类型选择不同的预览方式
                const iconType = icon.iconType || 'image';

                if (iconType === 'html') {
                    // HTML 图标：用 Shadow DOM 隔离预览
                    const previewEl = document.createElement('div');
                    previewEl.className = 'desktop-iconpicker-cell-html';
                    // 延迟加载 HTML 内容（性能优化）
                    const loadHtmlPreview = async () => {
                        try {
                            const dataResult = await window.electronAPI.desktopIconsetGetIconData(icon.relativePath);
                            if (dataResult?.success && dataResult.htmlContent) {
                                const shadow = previewEl.attachShadow({ mode: 'closed' });
                                shadow.innerHTML = dataResult.htmlContent;
                            }
                        } catch (e) {
                            previewEl.textContent = '📄';
                        }
                    };
                    // 使用 IntersectionObserver 懒加载
                    const observer = new IntersectionObserver((entries) => {
                        if (entries[0].isIntersecting) {
                            loadHtmlPreview();
                            observer.disconnect();
                        }
                    }, { threshold: 0.1 });
                    observer.observe(previewEl);
                    cell.appendChild(previewEl);

                    // 类型标签
                    const badge = document.createElement('span');
                    badge.className = 'desktop-iconpicker-cell-badge';
                    badge.textContent = 'HTML';
                    cell.appendChild(badge);
                } else {
                    // PNG/SVG/GIF/其他图片：用 <img> 预览
                    const img = document.createElement('img');
                    img.src = `../${icon.relativePath}`;
                    img.className = 'desktop-iconpicker-cell-img';
                    img.draggable = false;
                    img.loading = 'lazy';
                    img.onerror = function () {
                        this.style.display = 'none';
                        cell.classList.add('broken');
                    };
                    cell.appendChild(img);

                    // GIF 类型标签
                    if (iconType === 'gif') {
                        const badge = document.createElement('span');
                        badge.className = 'desktop-iconpicker-cell-badge';
                        badge.textContent = 'GIF';
                        cell.appendChild(badge);
                    }
                }

                const label = document.createElement('span');
                label.className = 'desktop-iconpicker-cell-label';
                label.textContent = icon.name.length > 10 ? icon.name.substring(0, 9) + '…' : icon.name;
                cell.appendChild(label);

                // 点击选择
                cell.addEventListener('click', async () => {
                    // 选中高亮
                    grid.querySelectorAll('.desktop-iconpicker-cell.selected').forEach(el => el.classList.remove('selected'));
                    cell.classList.add('selected');

                    // 读取图标数据
                    try {
                        const dataResult = await window.electronAPI.desktopIconsetGetIconData(icon.relativePath);
                        if (dataResult?.success && currentCallback) {
                            currentCallback({
                                relativePath: icon.relativePath,
                                dataUrl: dataResult.dataUrl || null,
                                htmlContent: dataResult.htmlContent || null,
                                svgContent: dataResult.svgContent || null,
                                iconType: dataResult.iconType || iconType,
                            });
                            closePicker();
                        }
                    } catch (err) {
                        console.error('[IconPicker] Get icon data error:', err);
                    }
                });

                grid.appendChild(cell);
            }
        } catch (err) {
            console.error('[IconPicker] Load icons error:', err);
            grid.innerHTML = '<div class="desktop-iconpicker-empty">加载异常</div>';
        }
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.iconPicker = {
        open: openPicker,
        close: closePicker,
    };

})();