// URL提取器节点实现
// 专门用于从各种格式的数据中提取URL并标准化输出

(function() {
    'use strict';

    // 扩展WorkflowEditor_NodeManager类的URL提取功能
    if (window.WorkflowEditor_NodeManager) {
        const nodeManager = window.WorkflowEditor_NodeManager;

        // 执行URL提取节点
        nodeManager.executeUrlExtractorNode = async function(node, inputData) {
            console.log(`[URLExtractor] 开始执行URL提取节点: ${node.id}`);
            console.log(`[URLExtractor] 接收到的输入数据:`, inputData);
            console.log(`[URLExtractor] 节点配置:`, node.config);
            
            const { urlTypes, deduplication, outputFormat, outputParamName } = node.config || {};
            
            // 智能输入数据处理 - 支持多种输入格式
            let input = null;
            
            console.log(`[URLExtractor] 开始处理输入数据，类型: ${typeof inputData}`);
            console.log(`[URLExtractor] 输入数据键值:`, Object.keys(inputData || {}));
            
            // 1. 优先使用 inputData.input（标准输入）
            if (inputData.input !== undefined && inputData.input !== null) {
                input = inputData.input;
                console.log(`[URLExtractor] 使用 inputData.input:`, input);
            }
            // 2. 如果没有 input 字段，检查是否有其他数据字段
            else if (Object.keys(inputData).length > 0) {
                // 查找可能包含数据的字段
                const dataKeys = Object.keys(inputData);
                console.log(`[URLExtractor] 可用的输入字段:`, dataKeys);
                
                // 优先查找常见的数据字段，特别是 original_plugin_output
                const preferredKeys = ['original_plugin_output', 'data', 'result', 'output', 'content', 'response'];
                let foundKey = null;
                
                for (const key of preferredKeys) {
                    if (inputData[key] !== undefined && inputData[key] !== null) {
                        foundKey = key;
                        console.log(`[URLExtractor] 找到首选字段: ${key}`);
                        break;
                    }
                }
                
                // 如果没找到首选字段，使用第一个非空字段
                if (!foundKey) {
                    foundKey = dataKeys.find(key => inputData[key] !== undefined && inputData[key] !== null);
                    if (foundKey) {
                        console.log(`[URLExtractor] 使用第一个非空字段: ${foundKey}`);
                    }
                }
                
                if (foundKey) {
                    input = inputData[foundKey];
                    console.log(`[URLExtractor] 使用字段 ${foundKey}:`, input);
                } else {
                    input = inputData; // 使用整个输入对象
                    console.log(`[URLExtractor] 使用整个输入对象:`, input);
                }
            }
            // 3. 如果输入数据完全为空，尝试使用整个 inputData
            else {
                input = inputData;
                console.log(`[URLExtractor] 输入数据为空，使用 inputData:`, input);
            }

            // 检查是否有有效的输入数据
            if (!input || (typeof input === 'object' && Object.keys(input).length === 0)) {
                console.warn(`[URLExtractor] 没有有效的输入数据进行URL提取`);
                
                // 返回空结果而不是抛出错误
                const emptyResult = this.formatUrlOutput([], outputFormat || 'array', outputParamName);
                return {
                    ...emptyResult,
                    originalData: input,
                    timestamp: new Date().toISOString(),
                    warning: '没有输入数据，返回空结果'
                };
            }

            try {
                console.log(`[URLExtractor] 开始提取URL，输入类型: ${typeof input}`);
                console.log(`[URLExtractor] 配置参数:`, { urlTypes, deduplication, outputFormat, outputParamName });

                // 提取所有URL
                const extractedUrls = this.extractAllUrls(input, urlTypes || ['image']);
                console.log(`[URLExtractor] 原始提取结果:`, extractedUrls);

                // 去重处理
                let finalUrls = extractedUrls;
                if (deduplication !== false) {
                    finalUrls = [...new Set(extractedUrls)];
                    console.log(`[URLExtractor] 去重后结果:`, finalUrls);
                }

                // 格式化输出，传递 outputParamName
                const result = this.formatUrlOutput(finalUrls, outputFormat || 'array', outputParamName);
                
                // 在节点UI中显示提取结果
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
                if (nodeElement) {
                    this.displayExtractionResult(nodeElement, result);
                }

                console.log(`[URLExtractor] URL提取完成，最终结果:`, result);

                return {
                    ...result,
                    originalData: input,
                    timestamp: new Date().toISOString()
                };

            } catch (error) {
                console.error(`[URLExtractor] URL提取失败:`, error);
                throw new Error(`URL extraction failed: ${error.message}`);
            }
        };

        // 简化的URL提取逻辑 - 使用稳定的正则表达式
        nodeManager.extractAllUrls = function(data, urlTypes) {
            console.log(`[URLExtractor] 开始提取URL，数据类型: ${typeof data}`);
            
            const urls = [];
            
            // 将所有数据转换为字符串进行处理
            let textToProcess = '';
            
            if (typeof data === 'string') {
                textToProcess = data;
            } else if (typeof data === 'object' && data !== null) {
                // 将对象转换为JSON字符串，这样可以提取对象中的所有URL
                textToProcess = JSON.stringify(data);
                console.log(`[URLExtractor] 对象转换为字符串，长度: ${textToProcess.length}`);
            } else {
                textToProcess = String(data);
            }
            
            console.log(`[URLExtractor] 处理文本预览: ${textToProcess.substring(0, 300)}...`);
            
            // 使用简单稳定的正则表达式提取所有HTTP/HTTPS URL
            const urlRegex = /https?:\/\/[^\s"'<>]+/g;
            const matches = textToProcess.match(urlRegex);
            
            if (matches) {
                console.log(`[URLExtractor] 正则匹配到 ${matches.length} 个URL`);
                
                matches.forEach((url, index) => {
                    // 更强力的URL清理 - 移除所有非URL字符
                    let cleanUrl = url.replace(/[^a-zA-Z0-9:\/\.\-_~!*'();?@&=+$,#\[\]%]+.*$/, '');
                    
                    // 进一步清理常见的末尾字符
                    cleanUrl = cleanUrl.replace(/[\\t\s"'<>{}|^`\[\]]+$/, '');
                    
                    console.log(`[URLExtractor] 处理URL ${index + 1}: 原始="${url}" 清理后="${cleanUrl}"`);
                    
                    // 验证URL格式
                    if (this.isValidUrl(cleanUrl)) {
                        // 检查URL类型匹配
                        if (this.matchesUrlType(cleanUrl, urlTypes)) {
                            urls.push(cleanUrl);
                            console.log(`[URLExtractor] ✓ 添加URL: ${cleanUrl}`);
                        } else {
                            console.log(`[URLExtractor] ✗ URL类型不匹配: ${cleanUrl}, 类型要求: ${JSON.stringify(urlTypes)}`);
                        }
                    } else {
                        console.log(`[URLExtractor] ✗ URL格式无效: ${cleanUrl}`);
                    }
                });
            } else {
                console.log(`[URLExtractor] 未找到任何URL匹配`);
            }
            
            console.log(`[URLExtractor] 最终提取到 ${urls.length} 个有效URL`);
            return urls;
        };

        // 从对象中递归提取URL
        nodeManager.extractUrlsFromObject = function(obj, urls, urlTypes) {
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const value = obj[key];
                    
                    // 检查常见的URL字段名
                    if (this.isUrlField(key) && typeof value === 'string' && this.isValidUrl(value)) {
                        if (this.matchesUrlType(value, urlTypes)) {
                            urls.push(value);
                        }
                    }
                    // 递归处理嵌套对象和数组
                    else if (typeof value === 'object' && value !== null) {
                        this.extractUrlsFromObject(value, urls, urlTypes);
                    }
                    else if (Array.isArray(value)) {
                        value.forEach(item => {
                            if (typeof item === 'string' && this.isValidUrl(item)) {
                                if (this.matchesUrlType(item, urlTypes)) {
                                    urls.push(item);
                                }
                            } else if (typeof item === 'object' && item !== null) {
                                this.extractUrlsFromObject(item, urls, urlTypes);
                            }
                        });
                    }
                }
            }
        };

        // 从文本中提取URL（包括HTML）
        nodeManager.extractUrlsFromText = function(text, urls, urlTypes) {
            console.log(`[URLExtractor] 从文本中提取URL，文本长度: ${text.length}`);
            console.log(`[URLExtractor] 文本内容预览: ${text.substring(0, 200)}...`);
            
            // URL正则表达式 - 匹配http/https URL
            const urlRegex = /https?:\/\/[^\s<>"']+/g;
            const matches = text.match(urlRegex);
            
            if (matches) {
                console.log(`[URLExtractor] 通过URL正则找到 ${matches.length} 个匹配`);
                matches.forEach((url, index) => {
                    // 清理URL（移除可能的HTML标签结尾符号）
                    const cleanUrl = url.replace(/[<>"']+$/, '');
                    console.log(`[URLExtractor] 检查URL ${index + 1}: ${cleanUrl}`);
                    
                    if (this.isValidUrl(cleanUrl) && this.matchesUrlType(cleanUrl, urlTypes)) {
                        urls.push(cleanUrl);
                        console.log(`[URLExtractor] ✓ 添加URL: ${cleanUrl}`);
                    } else {
                        console.log(`[URLExtractor] ✗ 跳过URL: ${cleanUrl} (类型不匹配或无效)`);
                    }
                });
            } else {
                console.log(`[URLExtractor] 通过URL正则未找到匹配`);
            }

            // 特殊处理：从HTML img标签中提取src
            const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
            let imgMatch;
            let imgCount = 0;
            
            while ((imgMatch = imgRegex.exec(text)) !== null) {
                imgCount++;
                const imgUrl = imgMatch[1];
                console.log(`[URLExtractor] 从img标签提取URL ${imgCount}: ${imgUrl}`);
                
                if (this.isValidUrl(imgUrl) && this.matchesUrlType(imgUrl, urlTypes)) {
                    urls.push(imgUrl);
                    console.log(`[URLExtractor] ✓ 添加img URL: ${imgUrl}`);
                } else {
                    console.log(`[URLExtractor] ✗ 跳过img URL: ${imgUrl} (类型不匹配或无效)`);
                }
            }
            
            if (imgCount === 0) {
                console.log(`[URLExtractor] 未找到img标签`);
            }
            
            // 额外处理：从各种可能的URL格式中提取
            // 处理可能被转义的URL
            const escapedUrlRegex = /https?:\\?\/\\?\/[^\s<>"'\\]+/g;
            const escapedMatches = text.match(escapedUrlRegex);
            if (escapedMatches) {
                console.log(`[URLExtractor] 找到 ${escapedMatches.length} 个转义URL`);
                escapedMatches.forEach((url, index) => {
                    // 清理转义字符
                    const cleanUrl = url.replace(/\\/g, '');
                    console.log(`[URLExtractor] 检查转义URL ${index + 1}: ${cleanUrl}`);
                    
                    if (this.isValidUrl(cleanUrl) && this.matchesUrlType(cleanUrl, urlTypes)) {
                        urls.push(cleanUrl);
                        console.log(`[URLExtractor] ✓ 添加转义URL: ${cleanUrl}`);
                    }
                });
            }
        };

        // 判断字段名是否可能包含URL
        nodeManager.isUrlField = function(fieldName) {
            const urlFieldNames = [
                'url', 'imageUrl', 'videoUrl', 'audioUrl', 'src', 'href', 'link',
                'image', 'video', 'audio', 'file', 'path', 'uri'
            ];
            const lowerFieldName = fieldName.toLowerCase();
            return urlFieldNames.some(name => lowerFieldName.includes(name));
        };

        // 检查URL是否匹配指定类型
        nodeManager.matchesUrlType = function(url, urlTypes) {
            console.log(`[URLExtractor] 检查URL类型匹配: url="${url}", 要求类型=${JSON.stringify(urlTypes)}`);
            
            if (!urlTypes || urlTypes.length === 0 || urlTypes.includes('all')) {
                console.log(`[URLExtractor] 类型要求为空或包含'all'，直接通过`);
                return true;
            }

            const urlLower = url.toLowerCase();
            console.log(`[URLExtractor] URL转小写: ${urlLower}`);
            
            for (const type of urlTypes) {
                console.log(`[URLExtractor] 检查类型: ${type}`);
                
                switch (type) {
                    case 'image':
                        const imageRegex = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)(\?.*)?$/i;
                        const isImage = imageRegex.test(urlLower);
                        console.log(`[URLExtractor] 图片类型检查: ${isImage}, 正则: ${imageRegex}`);
                        if (isImage) {
                            return true;
                        }
                        break;
                    case 'video':
                        const videoRegex = /\.(mp4|avi|mov|wmv|flv|webm|mkv)(\?.*)?$/i;
                        const isVideo = videoRegex.test(urlLower);
                        console.log(`[URLExtractor] 视频类型检查: ${isVideo}`);
                        if (isVideo) {
                            return true;
                        }
                        break;
                    case 'audio':
                        const audioRegex = /\.(mp3|wav|ogg|aac|flac|m4a)(\?.*)?$/i;
                        const isAudio = audioRegex.test(urlLower);
                        console.log(`[URLExtractor] 音频类型检查: ${isAudio}`);
                        if (isAudio) {
                            return true;
                        }
                        break;
                }
            }
            
            console.log(`[URLExtractor] 所有类型检查都不匹配，返回false`);
            return false;
        };

        // 格式化输出结果
        nodeManager.formatUrlOutput = function(urls, outputFormat, outputParamName) {
            const urlFieldName = outputParamName || 'url'; // 使用自定义参数名或默认 'url'
            
            switch (outputFormat) {
                case 'single':
                    return {
                        [urlFieldName]: urls.length > 0 ? urls[0] : null,
                        count: urls.length
                    };
                
                case 'object':
                    return {
                        [urlFieldName]: urls,
                        count: urls.length,
                        types: this.analyzeUrlTypes(urls),
                        extractedAt: new Date().toISOString()
                    };
                
                case 'array':
                default:
                    return {
                        [urlFieldName]: urls,
                        count: urls.length
                    };
            }
        };

        // 分析URL类型分布
        nodeManager.analyzeUrlTypes = function(urls) {
            const types = { image: 0, video: 0, audio: 0, other: 0 };
            
            urls.forEach(url => {
                if (this.matchesUrlType(url, ['image'])) {
                    types.image++;
                } else if (this.matchesUrlType(url, ['video'])) {
                    types.video++;
                } else if (this.matchesUrlType(url, ['audio'])) {
                    types.audio++;
                } else {
                    types.other++;
                }
            });
            
            return types;
        };

        // 在节点UI中显示提取结果
        nodeManager.displayExtractionResult = function(nodeElement, result) {
            let displayArea = nodeElement.querySelector('.url-extraction-display');
            
            if (!displayArea) {
                displayArea = document.createElement('div');
                displayArea.className = 'url-extraction-display';
                displayArea.style.cssText = `
                    margin: 8px 0;
                    padding: 8px;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    border-radius: 4px;
                    font-size: 11px;
                    color: #ccc;
                    max-height: 200px;
                    overflow-y: auto;
                `;
                
                const nodeContent = nodeElement.querySelector('.node-content') || nodeElement;
                nodeContent.appendChild(displayArea);
            }

            // 构建显示内容
            let displayHtml = `
                <div style="margin-bottom: 6px; font-weight: bold; color: #4CAF50;">
                    ✓ 提取完成: ${result.count} 个URL
                </div>
            `;

            if (result.types) {
                const typeInfo = [];
                if (result.types.image > 0) typeInfo.push(`图片: ${result.types.image}`);
                if (result.types.video > 0) typeInfo.push(`视频: ${result.types.video}`);
                if (result.types.audio > 0) typeInfo.push(`音频: ${result.types.audio}`);
                if (result.types.other > 0) typeInfo.push(`其他: ${result.types.other}`);
                
                if (typeInfo.length > 0) {
                    displayHtml += `<div style="margin-bottom: 6px; color: #888;">${typeInfo.join(', ')}</div>`;
                }
            }

            if (result.urls && result.urls.length > 0) {
                displayHtml += '<div style="margin-top: 6px;">';
                result.urls.slice(0, 5).forEach((url, index) => {
                    const shortUrl = url.length > 50 ? url.substring(0, 47) + '...' : url;
                    displayHtml += `
                        <div style="margin: 2px 0; padding: 2px 4px; background: #333; border-radius: 2px; font-family: monospace;">
                            ${index + 1}. ${shortUrl}
                        </div>
                    `;
                });
                
                if (result.urls.length > 5) {
                    displayHtml += `<div style="margin: 4px 0; color: #888; font-style: italic;">... 还有 ${result.urls.length - 5} 个URL</div>`;
                }
                displayHtml += '</div>';
            }

            displayArea.innerHTML = displayHtml;
        };

        console.log('[URLExtractor] URL提取器节点已加载');
    }
})();