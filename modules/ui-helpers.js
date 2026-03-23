// modules/ui-helpers.js
(function() {
    'use strict';

    // --- State for helper functions ---
    let croppedAgentAvatarFile = null;
    let croppedUserAvatarFile = null;
    let croppedGroupAvatarFile = null;

    const uiHelperFunctions = {};

    /**
     * 从字符串中解析正则表达式（支持 /pattern/flags 格式）
     * @param {string} input - 正则表达式字符串，如 "/test/gi" 或普通字符串 "test"
     * @returns {RegExp|null} - 返回RegExp对象，如果解析失败则返回null
     */
    uiHelperFunctions.regexFromString = function(input) {
        if (!input || typeof input !== 'string') {
            return null;
        }
        
        // 终极修复：废除使用正则表达式解析正则表达式的脆弱方法。
        // 改为使用明确的、手动字符串分割，这能从根本上避免转义地狱。
        if (input.length < 2 || !input.startsWith('/') || input.lastIndexOf('/') === 0) {
            console.error(`[regexFromString] 无效的格式: "${input}"。规则必须采用 /pattern/flags 的格式。`);
            return null;
        }

        try {
            const lastSlashIndex = input.lastIndexOf('/');
            const pattern = input.substring(1, lastSlashIndex);
            const flags = input.substring(lastSlashIndex + 1);
            
            // 这是最稳定、最可靠的创建方式
            return new RegExp(pattern, flags);
            
        } catch (e) {
            console.error(`[regexFromString] 解析正则表达式 "${input}" 失败:`, e);
            return null;
        }
    };

    /**
     * Scrolls the chat messages div to the bottom.
     */
    uiHelperFunctions.scrollToBottom = function() {
        const chatMessagesDiv = document.getElementById('chatMessages');
        const parentContainer = document.querySelector('.chat-messages-container');
        if (!chatMessagesDiv || !parentContainer) return;

        // 🟢 核心修复：使用真正的滚动容器（parentContainer）进行判断
        // 之前的逻辑错误地使用了 chatMessagesDiv，而它通常没有滚动条，导致判断永远为 true
        const scrollThreshold = 50; // 像素容差
        const isScrolledToBottom = parentContainer.scrollHeight - parentContainer.clientHeight <= parentContainer.scrollTop + scrollThreshold;

        // 只有当用户已经位于底部时，才执行自动滚动。
        if (isScrolledToBottom) {
            // 使用 requestAnimationFrame 来确保滚动操作在下一次浏览器重绘前执行。
            requestAnimationFrame(() => {
                if (document.body.contains(parentContainer)) {
                    parentContainer.scrollTop = parentContainer.scrollHeight;
                    // 同时同步内部 div 的位置（如果它也有滚动条的话）
                    chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
                }
            });
        }
    };

    /**
     * Automatically resizes a textarea to fit its content.
     * @param {HTMLTextAreaElement} textarea The textarea element.
     */
    uiHelperFunctions.autoResizeTextarea = function(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    };

    /**
     * Opens a modal dialog by its ID.
     * @param {string} modalId The ID of the modal element.
     */
    uiHelperFunctions.openModal = function(modalId) {
        let modalElement = document.getElementById(modalId);
        
        // 如果元素不存在，尝试从模板加载
        if (!modalElement) {
            const template = document.getElementById(modalId + 'Template');
            if (template) {
                const container = document.getElementById('modal-container');
                if (container) {
                    const clone = template.content.cloneNode(true);
                    container.appendChild(clone);
                    modalElement = document.getElementById(modalId);
                    console.log(`[UI Helper] Modal "${modalId}" instantiated from template.`);
                    
                    // 🟢 关键：触发一个自定义事件，通知其他模块该模态框已就绪
                    // 这样可以延迟绑定事件监听器
                    document.dispatchEvent(new CustomEvent('modal-ready', { detail: { modalId } }));
                }
            }
        }

        if (modalElement) {
            modalElement.classList.add('active');
            // 确保新打开的模态框获得焦点
            modalElement.focus();
        } else {
            console.warn(`[UI Helper] Modal "${modalId}" not found and no template available.`);
        }
    };

    /**
     * Closes a modal dialog by its ID.
     * @param {string} modalId The ID of the modal element.
     */
    uiHelperFunctions.closeModal = function(modalId) {
        const modalElement = document.getElementById(modalId);
        if (modalElement) modalElement.classList.remove('active');
    };

    /**
     * Shows a toast notification.
     * @param {string} message The message to display.
     * @param {number} [duration=3000] The duration in milliseconds.
     */
    uiHelperFunctions.showToastNotification = function(message, type = 'info', duration = 3000) {
        const container = document.getElementById('floating-toast-notifications-container');
        if (!container) {
            console.warn("Toast notification container not found.");
            alert(message); // Fallback
            return;
        }

        const toast = document.createElement('div');
        toast.className = `floating-toast-notification ${type}`; // e.g., 'info', 'success', 'error'
        toast.textContent = message;

        container.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => {
            toast.classList.add('visible');
        });

        const removeToast = () => {
            if (!toast.parentNode) return; // Already removed
            toast.classList.remove('visible');
            toast.classList.add('exiting');
            
            const onTransitionEnd = (event) => {
                if (event.propertyName === 'transform' && toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                    toast.removeEventListener('transitionend', onTransitionEnd);
                }
            };
            toast.addEventListener('transitionend', onTransitionEnd);

            // Fallback removal
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 500); // Should match animation duration
        };

        // Set timer to animate out and remove
        const removalTimeout = setTimeout(removeToast, duration);

        // Add click listener to remove early
        toast.addEventListener('click', () => {
            clearTimeout(removalTimeout); // Cancel the scheduled removal
            removeToast();
        });
    };

    /**
     * Shows temporary feedback on a button after an action.
     * @param {HTMLButtonElement} buttonElement The button element.
     * @param {boolean} success Whether the action was successful.
     * @param {string} tempText The temporary text to show.
     * @param {string} originalText The original text of the button.
     */
    uiHelperFunctions.showSaveFeedback = function(buttonElement, success, tempText, originalText) {
        if (!buttonElement) return;
        buttonElement.textContent = tempText;
        buttonElement.disabled = true;
        if (!success) buttonElement.classList.add('error-feedback');

        setTimeout(() => {
            buttonElement.textContent = originalText;
            buttonElement.disabled = false;
            if (!success) buttonElement.classList.remove('error-feedback');
        }, success ? 2000 : 3000);
    };

    /**
     * Shows a topic context menu (delegated to topicListManager).
     * @param {Event} event The context menu event.
     * @param {HTMLElement} topicItemElement The topic list item element.
     * @param {Object} itemFullConfig The full item configuration.
     * @param {Object} topic The topic object.
     * @param {string} itemType The item type ('agent' or 'group').
     */
    uiHelperFunctions.showTopicContextMenu = function(event, topicItemElement, itemFullConfig, topic, itemType) {
        // Delegate to topicListManager if available
        if (window.topicListManager && window.topicListManager.showTopicContextMenu) {
            window.topicListManager.showTopicContextMenu(event, topicItemElement, itemFullConfig, topic, itemType);
        } else {
            console.warn('[UI Helper] topicListManager.showTopicContextMenu not available');
        }
    };

    /**
     * Opens an avatar cropping modal.
     * @param {File} file The image file to crop.
     * @param {function(File): void} onCropConfirmedCallback Callback with the cropped file.
     * @param {string} [cropType='agent'] The type of avatar ('agent', 'group', 'user').
     */
    uiHelperFunctions.openAvatarCropper = async function(file, onCropConfirmedCallback, cropType = 'agent') {
        // 🟢 修复：先调用 openModal 确保从模板实例化 DOM 元素
        uiHelperFunctions.openModal('avatarCropperModal');

        const cropperContainer = document.getElementById('avatarCropperContainer');
        const canvas = document.getElementById('avatarCanvas');
        const confirmCropBtn = document.getElementById('confirmCropBtn');
        const cancelCropBtn = document.getElementById('cancelCropBtn');
        const cropCircleSVG = document.getElementById('cropCircle');
        const cropCircleBorderSVG = document.getElementById('cropCircleBorder');

        if (!cropperContainer || !canvas || !confirmCropBtn || !cancelCropBtn || !cropCircleSVG || !cropCircleBorderSVG) {
            console.error("Avatar cropper elements not found even after modal open!");
            return;
        }
        
        const ctx = canvas.getContext('2d');
        canvas.style.display = 'block';
        cropperContainer.style.cursor = 'grab';

        let img = new Image();
        let currentEventListeners = {};

        img.onload = () => {
            canvas.width = 360;
            canvas.height = 360;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = 'rgba(255, 255, 255, 0)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            let scale = Math.min(canvas.width / img.width, canvas.height / img.height);
            let scaledWidth = img.width * scale;
            let scaledHeight = img.height * scale;
            let offsetX = (canvas.width - scaledWidth) / 2;
            let offsetY = (canvas.height - scaledHeight) / 2;
            ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

            let circle = { x: canvas.width / 2, y: canvas.height / 2, r: Math.min(canvas.width / 2, canvas.height / 2, 100) };
            updateCircleSVG();

            let isDragging = false;
            let dragStartX, dragStartY, circleStartX, circleStartY;

            function updateCircleSVG() {
                cropCircleSVG.setAttribute('cx', circle.x);
                cropCircleSVG.setAttribute('cy', circle.y);
                cropCircleSVG.setAttribute('r', circle.r);
                cropCircleBorderSVG.setAttribute('cx', circle.x);
                cropCircleBorderSVG.setAttribute('cy', circle.y);
                cropCircleBorderSVG.setAttribute('r', circle.r);
            }

            currentEventListeners.onMouseDown = (e) => {
                const rect = cropperContainer.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                if (Math.sqrt((mouseX - circle.x)**2 + (mouseY - circle.y)**2) < circle.r + 10) {
                    isDragging = true;
                    dragStartX = mouseX;
                    dragStartY = mouseY;
                    circleStartX = circle.x;
                    circleStartY = circle.y;
                    cropperContainer.style.cursor = 'grabbing';
                }
            };

            currentEventListeners.onMouseMove = (e) => {
                if (!isDragging) return;
                const rect = cropperContainer.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                circle.x = circleStartX + (mouseX - dragStartX);
                circle.y = circleStartY + (mouseY - dragStartY);
                circle.x = Math.max(circle.r, Math.min(canvas.width - circle.r, circle.x));
                circle.y = Math.max(circle.r, Math.min(canvas.height - circle.r, circle.y));
                updateCircleSVG();
            };

            currentEventListeners.onMouseUpOrLeave = () => {
                isDragging = false;
                cropperContainer.style.cursor = 'grab';
            };

            currentEventListeners.onWheel = (e) => {
                e.preventDefault();
                const zoomFactor = e.deltaY < 0 ? 1.05 : 0.95;
                const newRadius = Math.max(30, Math.min(Math.min(canvas.width, canvas.height) / 2, circle.r * zoomFactor));
                if (newRadius === circle.r) return;
                circle.r = newRadius;
                circle.x = Math.max(circle.r, Math.min(canvas.width - circle.r, circle.x));
                circle.y = Math.max(circle.r, Math.min(canvas.height - circle.r, circle.y));
                updateCircleSVG();
            };

            currentEventListeners.onConfirmCrop = () => {
                const finalCropCanvas = document.createElement('canvas');
                const finalSize = circle.r * 2;
                finalCropCanvas.width = finalSize;
                finalCropCanvas.height = finalSize;
                const finalCtx = finalCropCanvas.getContext('2d');

                finalCtx.drawImage(canvas,
                    circle.x - circle.r, circle.y - circle.r,
                    finalSize, finalSize,
                    0, 0,
                    finalSize, finalSize
                );

                finalCtx.globalCompositeOperation = 'destination-in';
                finalCtx.beginPath();
                finalCtx.arc(circle.r, circle.r, circle.r, 0, Math.PI * 2);
                finalCtx.fill();
                finalCtx.globalCompositeOperation = 'source-over';

                finalCropCanvas.toBlob((blob) => {
                    if (!blob) {
                        console.error("[AvatarCropper] Failed to create blob from final canvas.");
                        uiHelperFunctions.showToastNotification("裁剪失败，无法生成图片数据。", 'error');
                        return;
                    }
                    const croppedFile = new File([blob], `${cropType}_avatar.png`, { type: "image/png" });
                    if (typeof onCropConfirmedCallback === 'function') {
                        onCropConfirmedCallback(croppedFile);
                    }
                    cleanupAndClose();
                }, 'image/png');
            };

            currentEventListeners.onCancelCrop = () => {
                cleanupAndClose();
                const agentAvatarInput = document.getElementById('agentAvatarInput');
                const userAvatarInput = document.getElementById('userAvatarInput');
                if (cropType === 'agent' && agentAvatarInput) agentAvatarInput.value = '';
                else if (cropType === 'user' && userAvatarInput) userAvatarInput.value = '';
                else if (cropType === 'group' && window.GroupRenderer) {
                    const groupAvatarInputElement = document.getElementById('groupAvatarInput');
                    if (groupAvatarInputElement) groupAvatarInputElement.value = '';
                }
            };

            function cleanupAndClose() {
                cropperContainer.removeEventListener('mousedown', currentEventListeners.onMouseDown);
                document.removeEventListener('mousemove', currentEventListeners.onMouseMove);
                document.removeEventListener('mouseup', currentEventListeners.onMouseUpOrLeave);
                cropperContainer.removeEventListener('mouseleave', currentEventListeners.onMouseUpOrLeave);
                cropperContainer.removeEventListener('wheel', currentEventListeners.onWheel);
                confirmCropBtn.removeEventListener('click', currentEventListeners.onConfirmCrop);
                cancelCropBtn.removeEventListener('click', currentEventListeners.onCancelCrop);
                uiHelperFunctions.closeModal('avatarCropperModal');
            }

            cropperContainer.addEventListener('mousedown', currentEventListeners.onMouseDown);
            document.addEventListener('mousemove', currentEventListeners.onMouseMove);
            document.addEventListener('mouseup', currentEventListeners.onMouseUpOrLeave);
            cropperContainer.addEventListener('mouseleave', currentEventListeners.onMouseUpOrLeave);
            cropperContainer.addEventListener('wheel', currentEventListeners.onWheel);
            confirmCropBtn.addEventListener('click', currentEventListeners.onConfirmCrop);
            cancelCropBtn.addEventListener('click', currentEventListeners.onCancelCrop);
        };

        img.onerror = () => {
            console.error("[AvatarCropper] Image failed to load from blob URL.");
            uiHelperFunctions.showToastNotification("无法加载选择的图片，请尝试其他图片。", 'error');
            uiHelperFunctions.closeModal('avatarCropperModal');
        };
        img.src = URL.createObjectURL(file);
    };

    /**
     * Updates the attachment preview area with current attached files.
     * @param {Array} attachedFiles Array of attached file objects.
     * @param {HTMLElement} attachmentPreviewArea The preview area element.
     */
    uiHelperFunctions.updateAttachmentPreview = function(attachedFiles, attachmentPreviewArea) {
        if (!attachmentPreviewArea) {
            console.error('[UI Helper] updateAttachmentPreview: attachmentPreviewArea is null or undefined!');
            return;
        }
    
        attachmentPreviewArea.innerHTML = ''; // Clear previous previews
        if (attachedFiles.length === 0) {
            attachmentPreviewArea.style.display = 'none';
            return;
        }
        attachmentPreviewArea.style.display = 'flex'; // Show the area
    
        attachedFiles.forEach((af, index) => {
            const prevDiv = document.createElement('div');
            prevDiv.className = 'attachment-preview-item';
            prevDiv.title = af.originalName || af.file.name;
    
            const fileType = af.file.type;
    
            if (fileType.startsWith('image/')) {
                const thumbnailImg = document.createElement('img');
                thumbnailImg.className = 'attachment-thumbnail-image';
                thumbnailImg.src = af.localPath; // Assumes localPath is a usable URL (e.g., file://)
                thumbnailImg.alt = af.originalName || af.file.name;
                thumbnailImg.onerror = () => { // Fallback to icon if image fails to load
                    thumbnailImg.remove(); // Remove broken image
                    const iconSpanFallback = document.createElement('span');
                    iconSpanFallback.className = 'file-preview-icon';
                    iconSpanFallback.textContent = '⚠️'; // Error/fallback icon
                    prevDiv.prepend(iconSpanFallback); // Add fallback icon at the beginning
                };
                prevDiv.appendChild(thumbnailImg);
            } else {
                const iconSpan = document.createElement('span');
                iconSpan.className = 'file-preview-icon';
                if (fileType.startsWith('audio/')) {
                    iconSpan.textContent = '🎵';
                } else if (fileType.startsWith('video/')) {
                    iconSpan.textContent = '🎞️';
                } else if (fileType.includes('pdf')) {
                    iconSpan.textContent = '📄';
                } else {
                    iconSpan.textContent = '📎';
                }
                prevDiv.appendChild(iconSpan);
            }
    
            const nameSpan = document.createElement('span');
            nameSpan.className = 'file-preview-name';
            const displayName = af.originalName || af.file.name;
            nameSpan.textContent = displayName.length > 20 ? displayName.substring(0, 17) + '...' : displayName;
            prevDiv.appendChild(nameSpan);
    
            const removeBtn = document.createElement('button');
            removeBtn.className = 'file-preview-remove-btn';
            removeBtn.innerHTML = '×';
            removeBtn.title = '移除此附件';
            removeBtn.onclick = () => {
                attachedFiles.splice(index, 1);
                uiHelperFunctions.updateAttachmentPreview(attachedFiles, attachmentPreviewArea);
            };
            prevDiv.appendChild(removeBtn);
    
            attachmentPreviewArea.appendChild(prevDiv);
        });
    };

    /**
     * Helper to get a centrally stored cropped file (agent, group, or user).
     * @param {string} type The type of avatar ('agent', 'group', 'user').
     * @returns {File|null} The cropped file or null.
     */
    uiHelperFunctions.getCroppedFile = function(type) {
        if (type === 'agent') return croppedAgentAvatarFile;
        if (type === 'group') return croppedGroupAvatarFile;
        if (type === 'user') return croppedUserAvatarFile;
        return null;
    };

    /**
     * Helper to set a centrally stored cropped file.
     * @param {string} type The type of avatar ('agent', 'group', 'user').
     * @param {File|null} file The cropped file to store.
     */
    uiHelperFunctions.setCroppedFile = function(type, file) {
        if (type === 'agent') croppedAgentAvatarFile = file;
        else if (type === 'group') croppedGroupAvatarFile = file;
        else if (type === 'user') croppedUserAvatarFile = file;
    };

    /**
     * Function to extract average color from an avatar image.
     * @param {string} imageUrl The URL of the image.
     * @param {function(string): void} callback Callback with the average color.
     */
    uiHelperFunctions.getAverageColorFromAvatar = function(imageUrl, callback) {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = function() {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);

            try {
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;
                let r = 0, g = 0, b = 0, count = 0;

                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] > 0) { // Only count non-transparent pixels
                        r += data[i];
                        g += data[i + 1];
                        b += data[i + 2];
                        count++;
                    }
                }

                if (count > 0) {
                    r = Math.round(r / count);
                    g = Math.round(g / count);
                    b = Math.round(b / count);
                    const avgColor = `rgb(${r}, ${g}, ${b})`;
                    callback(avgColor);
                } else {
                    callback(null);
                }
            } catch (error) {
                console.error('[UI Helper] Error extracting color from avatar:', error);
                callback(null);
            }
        };
        img.onerror = function() {
            console.error('[UI Helper] Failed to load image for color extraction:', imageUrl);
            callback(null);
        };
        img.src = imageUrl;
    };

    uiHelperFunctions.prepareGroupSettingsDOM = function() {
        // This function is called early in DOMContentLoaded.
        // It ensures the container for group settings exists.
        // The actual content (form fields) will be managed by GroupRenderer.
        if (!document.getElementById('groupSettingsContainer')) {
            const settingsTab = document.getElementById('tabContentSettings');
            if (settingsTab) {
                const groupContainerHTML = `<div id="groupSettingsContainer" style="display: none;"></div>`;
                settingsTab.insertAdjacentHTML('beforeend', groupContainerHTML);
                console.log("[UI Helper] groupSettingsContainer placeholder created.");
            } else {
                console.error("[UI Helper] Could not find tabContentSettings to append group settings DOM placeholder.");
            }
        }
         // Ensure createNewGroupBtn has its text updated
         const createNewAgentBtn = document.getElementById('createNewAgentBtn');
         const createNewGroupBtn = document.getElementById('createNewGroupBtn');
         if (createNewAgentBtn) {
             createNewAgentBtn.textContent = '创建 Agent';
         }
         if (createNewGroupBtn) {
             createNewGroupBtn.textContent = '创建 Group';
             console.log('[UI Helper prepareGroupSettingsDOM] createNewGroupBtn textContent set to:', createNewGroupBtn.textContent);
             createNewGroupBtn.style.display = 'inline-block'; // Make it visible
         }
    };

    uiHelperFunctions.addNetworkPathInput = function(path = '') {
        const container = document.getElementById('networkNotesPathsContainer');
        const inputGroup = document.createElement('div');
        inputGroup.className = 'network-path-input-group';
    
        const input = document.createElement('input');
        input.type = 'text';
        input.name = 'networkNotesPath';
        input.placeholder = '例如 \\\\NAS\\Shared\\Notes';
        input.value = path;
        input.style.flexGrow = '1';
    
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '删除';
        removeBtn.className = 'sidebar-button small-button danger-button'; // Re-use existing styles
        removeBtn.style.width = 'auto';
        removeBtn.onclick = () => {
            inputGroup.remove();
        };
    
        inputGroup.appendChild(input);
        inputGroup.appendChild(removeBtn);
        container.appendChild(inputGroup);
    };

    uiHelperFunctions.filterAgentList = function(searchTerm) {
        const lowerCaseSearchTerm = searchTerm.toLowerCase().trim();
        const itemListUl = document.getElementById('agentList'); // Renamed from agentListUl to itemListUl
        if (!itemListUl) return;
        const items = itemListUl.querySelectorAll('li'); // Get all list items
    
        items.forEach(item => {
            const nameElement = item.querySelector('.agent-name');
            if (nameElement) {
                const name = nameElement.textContent.toLowerCase();
                if (name.includes(lowerCaseSearchTerm)) {
                    item.style.display = ''; // Reset to default display style from CSS
                } else {
                    item.style.display = 'none';
                }
            }
        });
    };

    /**
     * Updates the speaking indicator animation on an avatar.
     * @param {string} msgId The ID of the message item.
     * @param {boolean} isSpeaking True to show the indicator, false to hide it.
     */
    uiHelperFunctions.updateSpeakingIndicator = function(msgId, isSpeaking) {
        const messageItem = document.querySelector(`.message-item[data-message-id="${msgId}"]`);
        if (messageItem) {
            const avatarElement = messageItem.querySelector('.chat-avatar');
            if (avatarElement) {
                if (isSpeaking) {
                    avatarElement.classList.add('speaking');
                } else {
                    avatarElement.classList.remove('speaking');
                }
            }
        }
    };

    /**
     * 显示确认对话框（替代原生 confirm()，避免 Electron 焦点问题）
     * @param {string} message - 确认消息
     * @param {string} [title='确认'] - 对话框标题
     * @param {string} [confirmText='确定'] - 确认按钮文字
     * @param {string} [cancelText='取消'] - 取消按钮文字
     * @param {boolean} [isDanger=false] - 是否为危险操作（红色确认按钮）
     * @returns {Promise<boolean>} - 用户点击确认返回 true，取消返回 false
     */
    uiHelperFunctions.showConfirmDialog = function(message, title = '确认', confirmText = '确定', cancelText = '取消', isDanger = false) {
        return new Promise((resolve) => {
            // 创建模态框容器
            const overlay = document.createElement('div');
            overlay.id = 'confirm-dialog-overlay';
            overlay.className = 'confirm-dialog-overlay';
            
            // 创建对话框
            const dialog = document.createElement('div');
            dialog.className = 'confirm-dialog';
            
            // 标题
            const titleEl = document.createElement('div');
            titleEl.className = 'confirm-dialog-title';
            titleEl.textContent = title;
            dialog.appendChild(titleEl);
            
            // 消息
            const messageEl = document.createElement('div');
            messageEl.className = 'confirm-dialog-message';
            messageEl.textContent = message;
            dialog.appendChild(messageEl);
            
            // 按钮容器
            const buttonsEl = document.createElement('div');
            buttonsEl.className = 'confirm-dialog-buttons';
            
            // 取消按钮
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'confirm-dialog-btn confirm-dialog-cancel';
            cancelBtn.textContent = cancelText;
            cancelBtn.onclick = () => {
                cleanup();
                resolve(false);
            };
            buttonsEl.appendChild(cancelBtn);
            
            // 确认按钮
            const confirmBtn = document.createElement('button');
            confirmBtn.className = `confirm-dialog-btn confirm-dialog-confirm ${isDanger ? 'danger' : ''}`;
            confirmBtn.textContent = confirmText;
            confirmBtn.onclick = () => {
                cleanup();
                resolve(true);
            };
            buttonsEl.appendChild(confirmBtn);
            
            dialog.appendChild(buttonsEl);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            
            // 显示动画
            requestAnimationFrame(() => {
                overlay.classList.add('visible');
                confirmBtn.focus();
            });
            
            // 键盘事件
            const handleKeydown = (e) => {
                if (e.key === 'Escape') {
                    cleanup();
                    resolve(false);
                } else if (e.key === 'Enter') {
                    cleanup();
                    resolve(true);
                }
            };
            document.addEventListener('keydown', handleKeydown);
            
            // 点击遮罩关闭
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    cleanup();
                    resolve(false);
                }
            };
            
            // 清理函数
            function cleanup() {
                document.removeEventListener('keydown', handleKeydown);
                overlay.classList.remove('visible');
                setTimeout(() => {
                    if (overlay.parentNode) {
                        overlay.parentNode.removeChild(overlay);
                    }
                }, 200);
            }
        });
    };

    window.uiHelperFunctions = uiHelperFunctions;

})();