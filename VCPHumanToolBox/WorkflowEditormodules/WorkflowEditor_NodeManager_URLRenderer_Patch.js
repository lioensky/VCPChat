// URL渲染器简化版本
// 专注于单条和多条URL的基本渲染功能

(function() {
    'use strict';

    // 扩展WorkflowEditor_NodeManager类的URL渲染功能
    if (window.WorkflowEditor_NodeManager) {
        const nodeManager = window.WorkflowEditor_NodeManager;

        // 执行URL渲染节点 - 简化版本
        nodeManager.executeUrlRendererNode = async function(node, inputData) {
            const { urlPath, renderType, width, height } = node.config;
            
            console.log(`[URLRenderer] 开始处理输入数据:`, inputData);
            console.log(`[URLRenderer] 配置参数:`, { urlPath, renderType, width, height });
            console.log(`[URLRenderer] 输入数据键值:`, Object.keys(inputData || {}));

            // 智能输入数据处理
            let input = null;
            
            // 1. 如果有 input 字段，优先使用
            if (inputData.input !== undefined && inputData.input !== null) {
                input = inputData.input;
                console.log(`[URLRenderer] 使用 inputData.input:`, input);
            }
            // 2. 否则使用整个 inputData
            else {
                input = inputData;
                console.log(`[URLRenderer] 使用整个 inputData:`, input);
            }

            if (!input || (typeof input === 'object' && Object.keys(input).length === 0)) {
                console.log(`[URLRenderer] 输入数据为空，显示等待状态`);
                
                // 在节点UI中显示等待状态
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
                if (nodeElement) {
                    this.renderWaitingState(nodeElement);
                }
                
                return {
                    result: null,
                    rendered: false,
                    type: 'waiting',
                    count: 0,
                    message: '等待输入数据...',
                    originalData: input,
                    timestamp: new Date().toISOString()
                };
            }

            try {
                // 提取URL数据
                const urlData = this.extractUrlData(input, urlPath || 'url');
                console.log(`[URLRenderer] 提取的URL数据:`, urlData);

                if (!urlData) {
                    // 如果没有找到URL，尝试从输入数据的其他字段中查找
                    console.log(`[URLRenderer] 未找到URL，尝试从其他字段查找...`);
                    
                    // 尝试常见的URL字段名
                    const possibleUrlFields = ['url', 'extractedUrls', 'urls', 'imageUrl', 'src'];
                    let foundUrl = null;
                    
                    for (const field of possibleUrlFields) {
                        const fieldValue = this.getNestedProperty(input, field);
                        if (fieldValue) {
                            console.log(`[URLRenderer] 在字段 ${field} 中找到数据:`, fieldValue);
                            foundUrl = this.processUrlData(fieldValue);
                            if (foundUrl) {
                                console.log(`[URLRenderer] 成功提取URL:`, foundUrl);
                                break;
                            }
                        }
                    }
                    
                    if (!foundUrl) {
                        throw new Error(`URL not found in input data using path: ${urlPath || 'url'}. Available fields: ${Object.keys(input).join(', ')}`);
                    }
                    
                    // 使用找到的URL
                    const urlDataFromField = foundUrl;
                    
                    // 判断是单个URL还是URL数组
                    const isArray = Array.isArray(urlDataFromField);
                    console.log(`[URLRenderer] 数据类型: ${isArray ? '数组' : '单个URL'}`);

                    let renderResult;

                    if (isArray) {
                        // 多条URL渲染
                        renderResult = await this.renderMultipleUrls(node, urlDataFromField, {
                            renderType, width, height
                        });
                    } else {
                        // 单条URL渲染
                        renderResult = await this.renderSingleUrl(node, urlDataFromField, {
                            renderType, width, height
                        });
                    }

                    return {
                        ...renderResult,
                        originalData: input,
                        timestamp: new Date().toISOString()
                    };
                }

                // 正常路径：找到了URL数据
                // 判断是单个URL还是URL数组
                const isArray = Array.isArray(urlData);
                console.log(`[URLRenderer] 数据类型: ${isArray ? '数组' : '单个URL'}`);

                let renderResult;

                if (isArray) {
                    // 多条URL渲染
                    renderResult = await this.renderMultipleUrls(node, urlData, {
                        renderType, width, height
                    });
                } else {
                    // 单条URL渲染
                    renderResult = await this.renderSingleUrl(node, urlData, {
                        renderType, width, height
                    });
                }

                return {
                    ...renderResult,
                    originalData: input,
                    timestamp: new Date().toISOString()
                };

            } catch (error) {
                console.error(`[URLRenderer] 渲染失败:`, error);
                throw new Error(`URL rendering failed: ${error.message}`);
            }
        };

        // 提取URL数据 - 简化版本
        nodeManager.extractUrlData = function(data, path) {
            console.log(`[URLRenderer] extractUrlData - data:`, data, `path:`, path);

            // 处理模板语法 {{xxx}} 或 {{input.xxx}}
            if (typeof path === 'string' && path.includes('{{') && path.includes('}}')) {
                console.log(`[URLRenderer] 检测到模板语法: ${path}`);
                
                const templateRegex = /\{\{(.*?)\}\}/;
                const match = path.match(templateRegex);
                
                if (match) {
                    const variablePath = match[1].trim();
                    console.log(`[URLRenderer] 解析模板变量路径: ${variablePath}`);
                    
                    // 支持 input.xxx 格式
                    let actualPath = variablePath;
                    if (variablePath.startsWith('input.')) {
                        actualPath = variablePath.substring(6);
                    }
                    
                    // 从输入数据中提取
                    const extractedData = this.getNestedProperty(data, actualPath);
                    console.log(`[URLRenderer] 模板解析结果:`, extractedData);
                    
                    if (extractedData !== undefined && extractedData !== null) {
                        return this.processUrlData(extractedData);
                    }
                }
            }

            // 如果输入直接是字符串URL
            if (typeof data === 'string' && this.isValidUrl(data)) {
                return data;
            }

            // 如果输入是URL数组
            if (Array.isArray(data)) {
                return this.processUrlData(data);
            }

            // 如果输入是对象，尝试从指定路径提取
            if (typeof data === 'object' && data !== null) {
                const extractedData = this.getNestedProperty(data, path);
                return this.processUrlData(extractedData);
            }

            return null;
        };

        // 处理URL数据
        nodeManager.processUrlData = function(data) {
            if (Array.isArray(data)) {
                // 如果是数组，提取其中的URL
                const urlArray = data.map(item => {
                    if (typeof item === 'string' && this.isValidUrl(item)) {
                        return item;
                    }
                    if (typeof item === 'object' && item !== null) {
                        return item.url || item.imageUrl || item.src;
                    }
                    return null;
                }).filter(url => url !== null);

                return urlArray.length > 0 ? urlArray : null;
            } else if (typeof data === 'string' && this.isValidUrl(data)) {
                return data;
            } else if (typeof data === 'object' && data !== null) {
                // 如果是对象，尝试提取URL字段
                return data.url || data.imageUrl || data.src;
            }

            return null;
        };

        // 获取嵌套属性
        nodeManager.getNestedProperty = function(obj, path) {
            if (!obj || typeof obj !== 'object' || !path) return undefined;
            const parts = path.split('.');
            let current = obj;
            for (const part of parts) {
                if (current === null || typeof current !== 'object' || !current.hasOwnProperty(part)) {
                    return undefined;
                }
                current = current[part];
            }
            return current;
        };

        // 渲染单条URL
        nodeManager.renderSingleUrl = async function(node, url, config) {
            const { renderType, width = 400, height = 300 } = config;
            
            console.log(`[URLRenderer] 渲染单个URL: ${url}`);
            
            if (!this.isValidUrl(url)) {
                throw new Error(`Invalid URL: ${url}`);
            }

            // 检测URL类型
            const detectedType = renderType === 'auto' ? this.detectUrlType(url) : renderType;
            
            // 在节点UI中显示渲染结果
            const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
            if (nodeElement) {
                this.renderUrlInNode(nodeElement, url, detectedType, { width, height });
            }

            return {
                result: url,
                rendered: true,
                type: detectedType,
                count: 1
            };
        };

        // 渲染多条URL
        nodeManager.renderMultipleUrls = async function(node, urlArray, config) {
            const { renderType, width = 300, height = 200 } = config;
            
            console.log(`[URLRenderer] 渲染多个URL: ${urlArray.length} 个`);
            
            const validUrls = urlArray.filter(url => this.isValidUrl(url));
            
            if (validUrls.length === 0) {
                throw new Error('No valid URLs found in array');
            }

            // 在节点UI中显示渲染结果
            const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
            if (nodeElement) {
                this.renderMultipleUrlsInNode(nodeElement, validUrls, { renderType, width, height });
            }

            return {
                result: validUrls,
                rendered: true,
                type: 'multiple',
                count: validUrls.length
            };
        };

        // 在节点中渲染单个URL
        nodeManager.renderUrlInNode = function(nodeElement, url, type, config) {
            const { width, height } = config;
            
            let renderArea = nodeElement.querySelector('.url-render-area');
            
            if (!renderArea) {
                renderArea = document.createElement('div');
                renderArea.className = 'url-render-area';
                renderArea.style.cssText = `
                    margin: 4px 0;
                    padding: 0;
                    background: transparent;
                    border: none;
                    border-radius: 4px;
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                `;
                
                const nodeContent = nodeElement.querySelector('.node-content') || nodeElement;
                nodeContent.appendChild(renderArea);
            }

            let contentHtml = '';
            
            switch (type) {
                case 'image':
                    const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    contentHtml = `
                        <div class="single-image-container" style="width: 100%; display: flex; flex-direction: column;">
                            <!-- 控制面板 -->
                            <div class="image-controls" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; padding: 4px 8px; background: #2a2a2a; border-radius: 4px; font-size: 10px;">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <select id="fitMode_${imageId}" onchange="this.parentElement.parentElement.parentElement.querySelector('img').style.objectFit = this.value"
                                            onwheel="event.preventDefault(); const options = this.options; const currentIndex = this.selectedIndex; const newIndex = event.deltaY > 0 ? Math.min(currentIndex + 1, options.length - 1) : Math.max(currentIndex - 1, 0); this.selectedIndex = newIndex; this.onchange();"
                                            style="background: #1a1a1a; color: #ccc; border: 1px solid #444; border-radius: 3px; padding: 2px 4px; font-size: 9px; cursor: pointer;">
                                        <option value="contain" selected>适应</option>
                                        <option value="cover">填充</option>
                                        <option value="none">原始</option>
                                        <option value="scale-down">缩小</option>
                                    </select>
                                    <button onclick="const container = this.parentElement.parentElement.parentElement.querySelector('.image-display-area'); const img = container.querySelector('img'); if(img && img.naturalHeight > 0) { container.style.height = 'auto'; container.style.minHeight = Math.min(img.naturalHeight, 500) + 'px'; container.style.maxHeight = '500px'; } this.nextElementSibling.nextElementSibling.textContent = '自适应';" style="background: #1a73e8; color: white; border: none; border-radius: 3px; padding: 2px 6px; font-size: 9px; cursor: pointer;" title="自适应大小">📐</button>
                                    <input type="range" id="sizeSlider_${imageId}" min="100" max="500" value="300" 
                                           onchange="const container = this.parentElement.parentElement.parentElement.querySelector('.image-display-area'); const img = container.querySelector('img'); if(img) { const newHeight = parseInt(this.value); container.style.height = newHeight + 'px'; container.style.minHeight = newHeight + 'px'; container.style.maxHeight = newHeight + 'px'; } this.nextElementSibling.textContent = this.value + 'px';"
                                           style="width: 60px; height: 12px;">
                                    <span id="sizeLabel_${imageId}" style="color: #888; font-size: 9px; min-width: 35px;">自适应</span>
                                </div>
                                <button onclick="window.open('${url}', '_blank')" style="background: #1a73e8; color: white; border: none; border-radius: 3px; padding: 2px 6px; font-size: 9px; cursor: pointer;">🔍</button>
                            </div>
                            <!-- 图片显示区域 -->
                            <div class="image-display-area" style="width: 100%; height: auto; min-height: 150px; max-height: 500px; overflow: hidden; border-radius: 6px; background: #1a1a1a; display: flex; align-items: center; justify-content: center; position: relative;">
                                <img src="${url}" alt="图片" id="${imageId}"
                                     style="max-width: 100%; height: auto; object-fit: contain; cursor: pointer; transition: transform 0.2s ease;"
                                     onclick="window.open('${url}', '_blank')"
                                     onmouseover="this.style.transform='scale(1.02)'"
                                     onmouseout="this.style.transform='scale(1)'"
                                     onload="this.parentElement.style.height = 'auto'; this.parentElement.style.minHeight = Math.min(this.naturalHeight, 500) + 'px';"
                                     onerror="this.parentElement.innerHTML='<div style=\\'color: #ff6b6b; text-align: center; padding: 20px; font-size: 12px;\\'>图片加载失败</div>'" />
                            </div>
                            <div style="margin-top: 6px; font-size: 10px; color: #666; word-break: break-all; text-align: center; line-height: 1.2;">
                                ${this.truncateUrl(url, 40)}
                            </div>
                        </div>
                    `;
                    break;

                case 'video':
                    contentHtml = `
                        <div class="single-video-container" style="width: 100%; display: flex; flex-direction: column;">
                            <div style="width: 100%; aspect-ratio: 16/9; overflow: hidden; border-radius: 6px; background: #1a1a1a;">
                                <video style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px;" controls>
                                    <source src="${url}" type="video/mp4">
                                    您的浏览器不支持视频播放
                                </video>
                            </div>
                            <div style="margin-top: 6px; font-size: 10px; color: #666; word-break: break-all; text-align: center; line-height: 1.2;">
                                ${this.truncateUrl(url, 40)}
                            </div>
                        </div>
                    `;
                    break;

                case 'iframe':
                    contentHtml = `
                        <div class="single-iframe-container" style="width: 100%; display: flex; flex-direction: column;">
                            <div style="width: 100%; aspect-ratio: 16/9; overflow: hidden; border-radius: 6px; background: #1a1a1a;">
                                <iframe src="${url}" 
                                        style="width: 100%; height: 100%; border: none; border-radius: 6px;">
                                </iframe>
                            </div>
                            <div style="margin-top: 6px; font-size: 10px; color: #666; word-break: break-all; text-align: center; line-height: 1.2;">
                                ${this.truncateUrl(url, 40)}
                            </div>
                        </div>
                    `;
                    break;

                default:
                    contentHtml = `
                        <div class="single-link-container" style="width: 100%; display: flex; flex-direction: column;">
                            <div style="width: 100%; aspect-ratio: 2; display: flex; align-items: center; justify-content: center; background: #2a2a2a; border-radius: 6px; border: 1px solid #444;">
                                <a href="${url}" target="_blank" style="color: #1a73e8; text-decoration: none; font-weight: 500; font-size: 14px;">
                                    🔗 打开链接
                                </a>
                            </div>
                            <div style="margin-top: 6px; font-size: 10px; color: #666; word-break: break-all; text-align: center; line-height: 1.2;">
                                ${this.truncateUrl(url, 40)}
                            </div>
                        </div>
                    `;
            }

            renderArea.innerHTML = contentHtml;
        };

        // 在节点中渲染多个URL
        nodeManager.renderMultipleUrlsInNode = function(nodeElement, urlArray, config) {
            const { renderType, width, height } = config;
            
            let renderArea = nodeElement.querySelector('.url-render-area');
            
            if (!renderArea) {
                renderArea = document.createElement('div');
                renderArea.className = 'url-render-area';
                renderArea.style.cssText = `
                    margin: 4px 0;
                    padding: 0;
                    background: transparent;
                    border: none;
                    border-radius: 4px;
                    width: 100%;
                    max-height: 500px;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                `;
                
                const nodeContent = nodeElement.querySelector('.node-content') || nodeElement;
                nodeContent.appendChild(renderArea);
            }

            const containerId = `multi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            let contentHtml = `
                <!-- ComfyUI风格控制面板 -->
                <div class="multi-image-controls" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; padding: 6px 8px; background: #2a2a2a; border-radius: 4px; font-size: 10px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="color: #ccc;">共 ${urlArray.length} 张</span>
                        <select id="multiFitMode_${containerId}" onchange="document.querySelectorAll('#${containerId} img').forEach(img => img.style.objectFit = this.value)" 
                                onwheel="event.preventDefault(); const options = this.options; const currentIndex = this.selectedIndex; const newIndex = event.deltaY > 0 ? Math.min(currentIndex + 1, options.length - 1) : Math.max(currentIndex - 1, 0); this.selectedIndex = newIndex; this.onchange();"
                                style="background: #1a1a1a; color: #ccc; border: 1px solid #444; border-radius: 3px; padding: 2px 4px; font-size: 9px; cursor: pointer;">
                            <option value="contain" selected>适应</option>
                            <option value="cover">填充</option>
                            <option value="none">原始</option>
                            <option value="scale-down">缩小</option>
                        </select>
                        
                        <label style="color: #888; font-size: 9px;">列数:</label>
                        <select id="gridColumns_${containerId}" onchange="const cols = this.value; const container = document.getElementById('${containerId}'); if(cols === 'auto') { container.style.gridTemplateColumns = 'repeat(auto-fit, minmax(120px, 1fr))'; } else { container.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)'; }"
                                onwheel="event.preventDefault(); const options = this.options; const currentIndex = this.selectedIndex; const newIndex = event.deltaY > 0 ? Math.min(currentIndex + 1, options.length - 1) : Math.max(currentIndex - 1, 0); this.selectedIndex = newIndex; this.onchange();"
                                style="background: #1a1a1a; color: #ccc; border: 1px solid #444; border-radius: 3px; padding: 2px 4px; font-size: 9px; cursor: pointer;">
                            <option value="1">1</option>
                            <option value="2" selected>2</option>
                            <option value="3">3</option>
                            <option value="4">4</option>
                            <option value="5">5</option>
                            <option value="6">6</option>
                            <option value="auto">自动</option>
                        </select>
                        
                        <label style="color: #888; font-size: 9px;">尺寸:</label>
                        <input type="range" id="multiSizeSlider_${containerId}" min="80" max="300" value="120" 
                               onchange="const size = this.value; const container = document.getElementById('${containerId}'); const cols = document.getElementById('gridColumns_${containerId}').value; if(cols === 'auto') { container.style.gridTemplateColumns = 'repeat(auto-fit, minmax(' + size + 'px, 1fr))'; } this.nextElementSibling.textContent = size + 'px';"
                               style="width: 60px; height: 12px;">
                        <span id="multiSizeLabel_${containerId}" style="color: #888; font-size: 9px; min-width: 35px;">120px</span>
                    </div>
                    
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <button onclick="const container = document.getElementById('${containerId}'); container.style.gap = '2px';" style="background: #333; color: #ccc; border: 1px solid #444; border-radius: 3px; padding: 2px 6px; font-size: 9px; cursor: pointer;" title="紧密排列">紧密</button>
                        <button onclick="const container = document.getElementById('${containerId}'); container.style.gap = '6px';" style="background: #1a73e8; color: white; border: none; border-radius: 3px; padding: 2px 6px; font-size: 9px; cursor: pointer;" title="标准间距">标准</button>
                        <button onclick="const container = document.getElementById('${containerId}'); container.style.gap = '12px';" style="background: #333; color: #ccc; border: 1px solid #444; border-radius: 3px; padding: 2px 6px; font-size: 9px; cursor: pointer;" title="宽松排列">宽松</button>
                    </div>
                </div>
                <div id="${containerId}" class="multiple-urls-container" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; padding: 4px;">
            `;

            urlArray.forEach((url, index) => {
                const detectedType = renderType === 'auto' ? this.detectUrlType(url) : renderType;
                
                let itemHtml = '';
                
                switch (detectedType) {
                    case 'image':
                        const itemImageId = `multiImg_${index}_${Date.now()}`;
                        itemHtml = `
                            <div class="url-item image-item" style="display: flex; flex-direction: column; background: #1a1a1a; border-radius: 6px; overflow: hidden; border: 1px solid #333;">
                                <div style="width: 100%; height: auto; min-height: 120px; max-height: 300px; overflow: hidden; background: #2a2a2a; display: flex; align-items: center; justify-content: center; position: relative;">
                                    <img src="${url}" alt="图片 ${index + 1}" id="${itemImageId}"
                                         style="width: 100%; height: auto; object-fit: contain; cursor: pointer; transition: transform 0.2s ease;"
                                         onclick="window.open('${url}', '_blank')"
                                         onmouseover="this.style.transform='scale(1.05)'"
                                         onmouseout="this.style.transform='scale(1)'"
                                         onload="const container = this.parentElement; const aspectRatio = this.naturalWidth / this.naturalHeight; const containerWidth = container.offsetWidth; const autoHeight = Math.min(containerWidth / aspectRatio, 300); container.style.height = autoHeight + 'px';"
                                         onerror="this.parentElement.innerHTML='<div style=\\'color: #ff6b6b; font-size: 10px; text-align: center; padding: 20px;\\'>加载失败</div>'" />
                                    <div style="position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,0.7); border-radius: 3px; padding: 2px 4px;">
                                        <button onclick="window.open('${url}', '_blank')" style="background: none; border: none; color: white; font-size: 10px; cursor: pointer; padding: 0;" title="查看原图">🔍</button>
                                    </div>
                                </div>
                                <div style="padding: 4px; font-size: 9px; color: #666; word-break: break-all; text-align: center; line-height: 1.2; background: #1a1a1a;">
                                    ${index + 1}. ${this.truncateUrl(url, 25)}
                                </div>
                            </div>
                        `;
                        break;

                    default:
                        itemHtml = `
                            <div class="url-item link-item" style="display: flex; flex-direction: column; background: #1a1a1a; border-radius: 6px; overflow: hidden; border: 1px solid #333;">
                                <div style="width: 100%; aspect-ratio: 2; display: flex; align-items: center; justify-content: center; background: #2a2a2a;">
                                    <a href="${url}" target="_blank" style="color: #1a73e8; text-decoration: none; font-size: 12px; font-weight: 500;">
                                        🔗
                                    </a>
                                </div>
                                <div style="padding: 4px; font-size: 9px; color: #666; word-break: break-all; text-align: center; line-height: 1.2; background: #1a1a1a;">
                                    ${index + 1}. ${this.truncateUrl(url, 25)}
                                </div>
                            </div>
                        `;
                }
                
                contentHtml += itemHtml;
            });

            contentHtml += '</div>';
            renderArea.innerHTML = contentHtml;
        };

        // 检测URL类型
        nodeManager.detectUrlType = function(url) {
            if (!url || typeof url !== 'string') return 'link';
            
            const urlLower = url.toLowerCase();
            
            if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)(\?|$)/i.test(urlLower)) {
                return 'image';
            }
            
            if (/\.(mp4|avi|mov|wmv|flv|webm|mkv)(\?|$)/i.test(urlLower)) {
                return 'video';
            }
            
            return 'link';
        };

        // 检查URL是否有效
        nodeManager.isValidUrl = function(url) {
            if (!url || typeof url !== 'string') return false;
            try {
                new URL(url);
                return true;
            } catch {
                return false;
            }
        };

        // 截断URL显示
        nodeManager.truncateUrl = function(url, maxLength) {
            if (!url || url.length <= maxLength) {
                return url;
            }
            return url.substring(0, maxLength - 3) + '...';
        };

        // 渲染等待状态
        nodeManager.renderWaitingState = function(nodeElement) {
            let renderArea = nodeElement.querySelector('.url-render-area');
            
            if (!renderArea) {
                renderArea = document.createElement('div');
                renderArea.className = 'url-render-area';
                renderArea.style.cssText = `
                    margin: 4px 0;
                    padding: 0;
                    background: transparent;
                    border: none;
                    border-radius: 4px;
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                `;
                
                const nodeContent = nodeElement.querySelector('.node-content') || nodeElement;
                nodeContent.appendChild(renderArea);
            }

            renderArea.innerHTML = `
                <div class="waiting-state-container" style="width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; background: #1a1a1a; border-radius: 6px; border: 2px dashed #444;">
                    <div style="font-size: 24px; margin-bottom: 12px; opacity: 0.6;">⏳</div>
                    <div style="font-size: 12px; color: #888; text-align: center; line-height: 1.4;">
                        等待输入数据...
                    </div>
                    <div style="font-size: 10px; color: #666; text-align: center; margin-top: 8px; line-height: 1.3;">
                        请连接上游节点提供URL数据
                    </div>
                </div>
            `;
        };

        console.log('[URLRenderer] 简化版本已加载');
    }
})();