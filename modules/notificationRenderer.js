// modules/notificationRenderer.js

var notificationRendererApi = window.chatAPI || window.electronAPI;
let filterManagerCapability = null;
let notificationLifecycleOwner = null;

function checkMessageFilter(messageTitle) {
    return filterManagerCapability?.checkMessageFilter?.(messageTitle) || null;
}

function scheduleNotificationTimeout(callback, delay) {
    return notificationLifecycleOwner?.timeout
        ? notificationLifecycleOwner.timeout(callback, delay)
        : setTimeout(callback, delay);
}

function listenNotification(target, type, handler, options) {
    if (notificationLifecycleOwner?.add) return notificationLifecycleOwner.add(target, type, handler, options);
    target?.addEventListener?.(type, handler, options);
    return true;
}

/**
 * @typedef {Object} VCPLogStatus
 * @property {'open'|'closed'|'error'|'connecting'} status
 * @property {string} message
 */

/**
 * @typedef {Object} VCPLogData
 * @property {string} type - e.g., 'vcp_log', 'daily_note_created', 'connection_ack'
 * @property {Object|string} data - The actual log data or message content
 * @property {string} [message] - A general message if data is not the primary content
 */

/**
 * Updates the VCPLog connection status display.
 * @param {VCPLogStatus} statusUpdate - The status object.
 * @param {HTMLElement} vcpLogConnectionStatusDiv - The DOM element for status display.
 */
function updateVCPLogStatus(statusUpdate, vcpLogConnectionStatusDiv) {
    if (!vcpLogConnectionStatusDiv || !statusUpdate) return; // 增加对 statusUpdate 自身的检查

    // 安全地从 statusUpdate 对象中提取数据，无论其内部结构如何
    const source = statusUpdate.source;
    const message = statusUpdate.message;
    const status = statusUpdate.status;

    const prefix = source || 'VCPLog';
    const statusText = `${prefix}: ${message || '状态未知'}`;
    const textElement = vcpLogConnectionStatusDiv.querySelector?.('.notifications-status-text');
    if (textElement) textElement.textContent = statusText;
    else vcpLogConnectionStatusDiv.textContent = statusText;
    vcpLogConnectionStatusDiv.className = `notifications-status status-${status || 'unknown'}`;
    vcpLogConnectionStatusDiv.dataset.status = status || 'unknown';
}

const handledToolApprovalRequestIds = new Set();
const toolApprovalTimers = new Map();
const TOOL_CHANGE_DIFF_MATRIX_LIMIT = 120000;
const TOOL_APPROVAL_DIFF_PREVIEW_LINES = 8;
// AI 常把 EditCode 的 replace 写成这些名字；末尾数字对应编号步骤
const TOOL_APPROVAL_REPLACE_TYPO = /^(replacement|replace[_-]?(?:with|text|content|code)|new[_-]?(?:content|text|code|string))(\d*)$/i;
const TOOL_APPROVAL_TARGET_TYPO = /^(old[_-]?(?:code|string|text|content)|search|find|original)\d*$/i;

function formatToolChangePreviewValue(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'undefined') return '';
    try {
        const serialized = JSON.stringify(value, null, 2);
        return typeof serialized === 'string' ? serialized : String(value ?? '');
    } catch (error) {
        return String(value ?? '');
    }
}

function truncatePreviewLines(value, maxLines = 6) {
    if (value === null || typeof value === 'undefined') return '';
    const text = formatToolChangePreviewValue(value);
    const lines = text.split('\n');
    if (lines.length <= maxLines) {
        return text;
    }
    return lines.slice(0, maxLines).join('\n') + '\n…';
}

function buildToolChangeDiff(beforeValue, afterValue) {
    const beforeLines = formatToolChangePreviewValue(beforeValue).split('\n');
    const afterLines = formatToolChangePreviewValue(afterValue).split('\n');
    const matrixSize = (beforeLines.length + 1) * (afterLines.length + 1);

    if (matrixSize > TOOL_CHANGE_DIFF_MATRIX_LIMIT) {
        return [
            ...beforeLines.map(text => ({ type: 'delete', text })),
            ...afterLines.map(text => ({ type: 'add', text }))
        ];
    }

    const lengths = Array.from(
        { length: beforeLines.length + 1 },
        () => new Uint32Array(afterLines.length + 1)
    );

    for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
        for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
            lengths[beforeIndex][afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
                ? lengths[beforeIndex + 1][afterIndex + 1] + 1
                : Math.max(lengths[beforeIndex + 1][afterIndex], lengths[beforeIndex][afterIndex + 1]);
        }
    }

    const diff = [];
    let beforeIndex = 0;
    let afterIndex = 0;
    while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
        if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
            diff.push({ type: 'context', text: beforeLines[beforeIndex] });
            beforeIndex += 1;
            afterIndex += 1;
        } else if (lengths[beforeIndex + 1][afterIndex] >= lengths[beforeIndex][afterIndex + 1]) {
            diff.push({ type: 'delete', text: beforeLines[beforeIndex] });
            beforeIndex += 1;
        } else {
            diff.push({ type: 'add', text: afterLines[afterIndex] });
            afterIndex += 1;
        }
    }
    while (beforeIndex < beforeLines.length) {
        diff.push({ type: 'delete', text: beforeLines[beforeIndex++] });
    }
    while (afterIndex < afterLines.length) {
        diff.push({ type: 'add', text: afterLines[afterIndex++] });
    }
    return diff;
}

function openToolChangeAuditModal(approvalData, options = {}) {
    const changePreview = approvalData?.changePreview;
    if (!changePreview || typeof changePreview !== 'object' || Array.isArray(changePreview)) return false;

    const uiHelper = window.uiHelperFunctions;
    uiHelper?.openModal?.('toolChangeAuditModal');

    const modal = document.getElementById('toolChangeAuditModal');
    const beforeElement = document.getElementById('toolChangeAuditBefore');
    const afterElement = document.getElementById('toolChangeAuditAfter');
    const diffElement = document.getElementById('toolChangeAuditDiff');
    const reasonInput = document.getElementById('toolChangeAuditReason');
    const wrapToggle = document.getElementById('toolChangeAuditWrapToggle');
    if (!modal || !beforeElement || !afterElement || !diffElement || !reasonInput || !wrapToggle) return false;

    const beforeText = formatToolChangePreviewValue(changePreview.target);
    const afterText = formatToolChangePreviewValue(changePreview.replace);
    const diff = buildToolChangeDiff(changePreview.target, changePreview.replace);
    const additions = diff.filter(line => line.type === 'add').length;
    const deletions = diff.filter(line => line.type === 'delete').length;

    document.getElementById('toolChangeAuditToolName').textContent = approvalData.toolName || '未知工具';
    document.getElementById('toolChangeAuditMaid').textContent = approvalData.maid || '未知助手';
    document.getElementById('toolChangeAuditRequestId').textContent = approvalData.requestId || '—';
    document.getElementById('toolChangeAuditTimestamp').textContent = approvalData.timestamp || '—';
    document.getElementById('toolChangeAuditStatus').textContent = '等待审核';
    document.getElementById('toolChangeAuditSummary').textContent =
        `检测到 ${additions} 行新增、${deletions} 行删除。请确认变更内容后再决定是否执行。`;
    beforeElement.textContent = beforeText || '（空内容）';
    afterElement.textContent = afterText || '（空内容）';
    reasonInput.value = typeof options.reason === 'string' ? options.reason : '';
    diffElement.replaceChildren();

    const setWrapEnabled = (enabled) => {
        modal.classList.toggle('is-wrap-enabled', enabled);
        wrapToggle.classList.toggle('active', enabled);
        wrapToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        wrapToggle.title = enabled
            ? '关闭代码与差异内容的自动换行'
            : '开启代码与差异内容的自动换行';
    };
    setWrapEnabled(false);
    wrapToggle.onclick = event => {
        event.stopPropagation();
        setWrapEnabled(wrapToggle.getAttribute('aria-pressed') !== 'true');
    };

    diff.forEach((line) => {
        const row = document.createElement('div');
        row.className = `tool-change-audit-diff-line is-${line.type}`;

        const marker = document.createElement('span');
        marker.className = 'tool-change-audit-diff-marker';
        marker.textContent = line.type === 'add' ? '+' : line.type === 'delete' ? '−' : ' ';

        const content = document.createElement('span');
        content.className = 'tool-change-audit-diff-text';
        content.textContent = line.text || ' ';

        row.append(marker, content);
        diffElement.appendChild(row);
    });

    const close = () => uiHelper?.closeModal?.('toolChangeAuditModal');
    const decide = (approved) => {
        if (handledToolApprovalRequestIds.has(approvalData.requestId)) {
            close();
            return;
        }
        const accepted = options.onDecision?.(approved, reasonInput.value);
        if (accepted !== false) close();
    };

    document.getElementById('closeToolChangeAuditModal').onclick = close;
    document.getElementById('cancelToolChangeAudit').onclick = close;
    document.getElementById('rejectToolChangeAudit').onclick = () => decide(false);
    document.getElementById('approveToolChangeAudit').onclick = () => decide(true);
    modal.onclick = event => {
        if (event.target === modal) close();
    };
    modal.onkeydown = event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    };

    // 从头开始审：聚焦理由框时不要把工具名和摘要滚出视野
    modal.querySelectorAll('.modal-content').forEach(node => { node.scrollTop = 0; });
    requestAnimationFrame(() => reasonInput.focus({ preventScroll: true }));
    return true;
}

function clearPersistentNotifications({ container = document.getElementById('notificationsList') } = {}) {
    if (!container) return { success: false, removed: 0 };
    let removed = 0;
    container.querySelectorAll('.notification-item').forEach(item => {
        if (item.dataset.protectedNotification === 'tool-approval') return;
        item.remove();
        removed += 1;
    });
    return { success: true, removed };
}

function sendToolApprovalResponse(requestId, approved, reason = '') {
    if (!requestId || !notificationRendererApi || typeof notificationRendererApi.sendVCPLogMessage !== 'function') {
        return false;
    }

    const responseData = {
        requestId,
        approved: approved === true
    };

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (trimmedReason) {
        responseData.reason = trimmedReason;
    }

    notificationRendererApi.sendVCPLogMessage({
        type: 'tool_approval_response',
        data: responseData
    });
    return true;
}

/**
 * Renders a VCPLog notification in the notifications list.
 * @param {VCPLogData|string} logData - The parsed JSON log data or a raw string message.
 * @param {string|null} originalRawMessage - The original raw string message from WebSocket, if available.
 * @param {HTMLElement} notificationsListUl - The UL element for the persistent notifications sidebar.
 * @param {Object} themeColors - An object containing theme colors (largely unused now with CSS variables).
 */
function renderVCPLogNotification(logData, originalRawMessage = null, notificationsListUl, themeColors = {}) {
    if (logData && typeof logData === 'object' && logData.type === 'tool_approval_request' && logData.data && typeof logData.data === 'object') {
        const autoApprovalResult = (filterManagerCapability || window.filterManager)?.checkToolAutoApproval?.(logData.data);
        if (autoApprovalResult && autoApprovalResult.action === 'approve') {
            const sent = sendToolApprovalResponse(logData.data.requestId, true);
            const autoApprovalLog = {
                type: 'tool_auto_approval',
                data: {
                    toolName: logData.data.toolName,
                    maid: logData.data.maid,
                    requestId: logData.data.requestId,
                    ruleName: autoApprovalResult.rule?.name || '未命名规则',
                    sent,
                    timestamp: new Date().toISOString()
                }
            };

            if (notificationsListUl) {
                renderVCPLogNotification(autoApprovalLog, JSON.stringify(autoApprovalLog), notificationsListUl, themeColors);
            }

            console.log('[NotificationRenderer] 工具调用已按规则自动允许:', autoApprovalLog.data);
            return;
        }

        const requestId = logData.data.requestId;
        if (requestId) {
            if (handledToolApprovalRequestIds.has(requestId)) {
                return;
            }
            const existingElement = typeof document !== 'undefined'
                && document.querySelector?.(`.notification-tool-approval[data-tool-approval-request-id="${CSS.escape(String(requestId))}"]`);
            if (existingElement) {
                return;
            }
        }
    }

    // Suppress the generic English connection success message for VCPLog
    if (logData && typeof logData === 'object' && logData.type === 'connection_ack' && logData.message === 'WebSocket connection successful for VCPLog.') {
        return; // Do not render this notification
    }

    const toastContainer = document.getElementById('floating-toast-notifications-container');

    const textToCopy = originalRawMessage !== null ? originalRawMessage :
                       (typeof logData === 'object' && logData !== null ? JSON.stringify(logData, null, 2) : String(logData));

    let titleText = 'VCP 通知:';
    let mainContent = '';
    let contentIsPreformatted = false;
    // 卡片语气：驱动通知列表左侧状态点和「错误」筛选
    let notificationTone = 'neutral';

    // --- Content Parsing Logic (adapted from original renderer.js) ---
    if (logData && typeof logData === 'object' && logData.type === 'vcp_log' && logData.data && typeof logData.data === 'object') {
        const vcpData = logData.data;
        if (vcpData.tool_name && vcpData.status) {
            titleText = `${vcpData.tool_name} ${vcpData.status}`;
            const normalizedStatus = String(vcpData.status).toLowerCase();
            if (/(error|fail|timeout)/.test(normalizedStatus)) notificationTone = 'error';
            else if (/(success|ok|done|complete)/.test(normalizedStatus)) notificationTone = 'success';
            if (typeof vcpData.content !== 'undefined') {
                let rawContentString = String(vcpData.content);
                mainContent = rawContentString;
                contentIsPreformatted = true;

                // Handle common error pattern: "执行错误: {"plugin_error": "..."}"
                if (vcpData.status === 'error' && rawContentString.includes('{')) {
                    const jsonStart = rawContentString.indexOf('{');
                    const prefix = rawContentString.substring(0, jsonStart);
                    const jsonPart = rawContentString.substring(jsonStart);
                    try {
                        const parsed = JSON.parse(jsonPart);
                        const displayError = parsed.plugin_error || parsed.error || parsed.message;
                        if (displayError) {
                            mainContent = prefix.trim() + (prefix.trim().endsWith(':') ? ' ' : ': ') + displayError;
                            contentIsPreformatted = false;
                        }
                    } catch (e) {
                        // Not valid JSON or parsing failed, keep raw content
                    }
                }

                try {
                    const parsedInnerContent = JSON.parse(rawContentString);
                    let titleSuffix = '';
                    if (parsedInnerContent.MaidName) {
                        titleSuffix += ` by ${parsedInnerContent.MaidName}`;
                    }
                    if (parsedInnerContent.timestamp && typeof parsedInnerContent.timestamp === 'string' && parsedInnerContent.timestamp.length >= 16) {
                        const timePart = parsedInnerContent.timestamp.substring(11, 16);
                        titleSuffix += `${parsedInnerContent.MaidName ? ' ' : ''}@ ${timePart}`;
                    }
                    if (titleSuffix) {
                        titleText += ` (${titleSuffix.trim()})`;
                    }
                    if (typeof parsedInnerContent.original_plugin_output !== 'undefined') {
                        const pluginOutput = parsedInnerContent.original_plugin_output;
                        if (typeof pluginOutput === 'object' && pluginOutput !== null) {
                            // DailyNote 插件返回带有 status 和 message 字段，优先显示友好消息
                            if (vcpData.tool_name === 'DailyNote' && pluginOutput.message) {
                                const statusIcon = pluginOutput.status === 'success' ? '✅' : '❌';
                                mainContent = `${statusIcon} ${pluginOutput.message}`;
                                contentIsPreformatted = false;
                            } else if (pluginOutput.message && typeof pluginOutput.message === 'string') {
                                // 通用处理：如果插件输出包含 message 字段，优先显示
                                mainContent = pluginOutput.message;
                                contentIsPreformatted = false;
                            } else {
                                mainContent = JSON.stringify(pluginOutput, null, 2);
                                // contentIsPreformatted is already true (from line 52) and should remain true for JSON display
                            }
                        } else {
                            mainContent = String(pluginOutput);
                            contentIsPreformatted = false; // If it's not an object, treat as plain text
                        }
                    } else if (vcpData.tool_name === 'DailyNote') {
                        // DailyNote 新格式：content 直接包含 message/folder/fileName/MaidName/timestamp
                        // 也兼容旧格式（无 message 字段时显示默认文本）
                        const statusIcon = vcpData.status === 'success' ? '✅' : '❌';
                        if (parsedInnerContent.message) {
                            mainContent = `${statusIcon} ${parsedInnerContent.message}`;
                        } else {
                            mainContent = `${statusIcon} 日记内容已成功记录到本地知识库。`;
                        }
                        contentIsPreformatted = false;
                    }
                } catch (e) {
                    // console.warn('VCP Notifier: Could not parse vcpData.content as JSON:', e, rawContentString);
                }
            } else {
                mainContent = '(无内容)';
            }
        } else if (vcpData.source === 'DistPluginManager' && vcpData.content) {
            titleText = '分布式服务器:';
            mainContent = vcpData.content;
            contentIsPreformatted = false;
        } else {
            titleText = 'VCP 日志条目:';
            mainContent = JSON.stringify(vcpData, null, 2);
            contentIsPreformatted = true;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'video_generation_status' && logData.data && typeof logData.data === 'object') {
        titleText = '视频生成状态:';
        if (logData.data.original_plugin_output && typeof logData.data.original_plugin_output.message === 'string') {
            mainContent = logData.data.original_plugin_output.message;
            contentIsPreformatted = false;
        } else if (logData.data.original_plugin_output) { // If original_plugin_output exists but not its message, stringify it
            mainContent = JSON.stringify(logData.data.original_plugin_output, null, 2);
            contentIsPreformatted = true;
        } else { // Fallback to stringify the whole data part
            mainContent = JSON.stringify(logData.data, null, 2);
            contentIsPreformatted = true;
        }
        // Attempt to add timestamp to title
        if (logData.data.timestamp && typeof logData.data.timestamp === 'string' && logData.data.timestamp.length >= 16) {
            const timePart = logData.data.timestamp.substring(11, 16);
            titleText += ` (@ ${timePart})`;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'daily_note_created' && logData.data && typeof logData.data === 'object') {
        const noteData = logData.data;
        titleText = `日记: ${noteData.maidName || 'N/A'} (${noteData.dateString || 'N/A'})`;
        if (noteData.status === 'success') {
            mainContent = noteData.message || '日记已成功创建。';
        } else {
            mainContent = noteData.message || `日记处理状态: ${noteData.status || '未知'}`;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'connection_ack' && logData.message) {
        titleText = 'VCP 连接:';
        mainContent = String(logData.message);
    } else if (logData && typeof logData === 'object' && logData.type === 'tool_auto_approval' && logData.data && typeof logData.data === 'object') {
        const approvalLog = logData.data;
        titleText = `✅ 已自动允许: ${approvalLog.toolName || '未知工具'}`;
        notificationTone = 'success';
        mainContent = `助手: ${approvalLog.maid || '未知'}\n规则: ${approvalLog.ruleName || '未命名规则'}\n请求ID: ${approvalLog.requestId || 'N/A'}\n状态: ${approvalLog.sent ? '已发送允许响应' : '发送失败'}`;
        contentIsPreformatted = true;
    } else if (logData && typeof logData === 'object' && logData.type && logData.message) { // Generic type + message
        titleText = `类型: ${logData.type}`;
        mainContent = String(logData.message);
        if (logData.data) {
            mainContent += `\n数据: ${JSON.stringify(logData.data, null, 2)}`;
            contentIsPreformatted = true;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'tool_approval_request' && logData.data && typeof logData.data === 'object') {
        const approvalData = logData.data;
        titleText = `🛠️ 审核请求: ${approvalData.toolName}`;
        notificationTone = 'warn';
        mainContent = `助手: ${approvalData.maid}\n命令: ${approvalData.args?.command || JSON.stringify(approvalData.args)}\n时间: ${approvalData.timestamp}`;
        contentIsPreformatted = true;
    } else { // Fallback for other structures or plain string
        titleText = 'VCP 消息:';
        mainContent = typeof logData === 'object' && logData !== null ? JSON.stringify(logData, null, 2) : String(logData);
        contentIsPreformatted = typeof logData === 'object';
    }
    // --- End Content Parsing ---

    const isToolApprovalRequest = logData && logData.type === 'tool_approval_request';
    const hasToolChangePreview = isToolApprovalRequest
        && logData.data?.changePreview
        && typeof logData.data.changePreview === 'object'
        && !Array.isArray(logData.data.changePreview);

    // Function to populate a notification element (either toast or list item)
    const populateNotificationElement = (element, isToast) => {
        if (isToolApprovalRequest) {
            element.dataset.protectedNotification = 'tool-approval';
            element.dataset.toolApprovalRequestId = logData.data?.requestId || '';
            element.classList.add('notification-protected', 'notification-tool-approval');
        }

        if (!isToast) {
            // 状态归类交给 notificationCenter：pending 置顶、resolved 折叠归档
            element.dataset.notificationState = isToolApprovalRequest
                ? 'pending'
                : (logData?.type === 'tool_auto_approval' ? 'resolved' : 'info');
            element.dataset.notificationTone = notificationTone;
        }

        const strongTitle = document.createElement('strong');
        strongTitle.textContent = titleText;
        let headRow = null;
        if (isToast) {
            element.appendChild(strongTitle);
        } else {
            headRow = document.createElement('div');
            headRow.classList.add('notification-head');
            const toneDot = document.createElement('span');
            toneDot.classList.add('notification-tone-dot');
            toneDot.setAttribute('aria-hidden', 'true');
            headRow.append(toneDot, strongTitle);
            element.appendChild(headRow);
        }

        const contentDiv = document.createElement('div');
        contentDiv.classList.add('notification-content');
        if (mainContent) {
            if (contentIsPreformatted) {
                const pre = document.createElement('pre');
                pre.textContent = mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : '');
                pre.style.overflowWrap = 'break-word'; //  处理长文本换行
                pre.style.whiteSpace = 'pre-wrap'; //  确保<pre>标签也能自动换行
                contentDiv.appendChild(pre);
            } else {
                const p = document.createElement('p');
                p.textContent = mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : '');
                p.style.overflowWrap = 'break-word'; //  处理长文本换行
                contentDiv.appendChild(p);
            }
        }
        if (isToolApprovalRequest && logData.data) {
            const approvalDetails = document.createElement('div');
            approvalDetails.classList.add('notification-approval-details');

            const filePath = logData.data.filePath || logData.data.path || logData.data.args?.filePath || logData.data.args?.path;
            if (filePath) {
                const pathRow = document.createElement('div');
                pathRow.classList.add('notification-approval-row', 'notification-approval-path');
                const pathLabel = document.createElement('span');
                pathLabel.classList.add('notification-approval-label');
                pathLabel.textContent = '文件: ';
                const pathValue = document.createElement('span');
                pathValue.classList.add('notification-approval-value');
                pathValue.textContent = String(filePath);
                pathRow.append(pathLabel, pathValue);
                approvalDetails.appendChild(pathRow);
            }

            const reasonText = logData.data.reason || logData.data.args?.reason;
            if (reasonText) {
                const reasonRow = document.createElement('div');
                reasonRow.classList.add('notification-approval-row', 'notification-approval-ai-reason');
                const reasonLabel = document.createElement('span');
                reasonLabel.classList.add('notification-approval-label');
                reasonLabel.textContent = '理由: ';
                const reasonValue = document.createElement('span');
                reasonValue.classList.add('notification-approval-value');
                reasonValue.textContent = String(reasonText);
                reasonRow.append(reasonLabel, reasonValue);
                approvalDetails.appendChild(reasonRow);
            }

            const approvalArgs = logData.data.args || {};
            const changePreview = logData.data.changePreview || approvalArgs.changePreview;
            const previewSections = [];

            const parseLinesRange = (step) => {
                let start = step.start;
                let end = step.end;
                if (start === undefined && end === undefined && step.lines !== undefined) {
                    const linesStr = String(step.lines).trim();
                    const match = linesStr.match(/^(\d+)\s*[-~,:]\s*(\d+)$/);
                    if (match) {
                        start = Number(match[1]);
                        end = Number(match[2]);
                    } else if (/^\d+$/.test(linesStr)) {
                        start = Number(linesStr);
                        end = start;
                    }
                }
                if (start !== undefined && end !== undefined) {
                    return Number(start) === Number(end) ? `${start}` : `${start}-${end}`;
                }
                if (start !== undefined) return `${start}`;
                if (end !== undefined) return `${end}`;
                return '';
            };

            // rawArgs/suffix 用来找写错名字的 replace：编号步骤只收已知字段，错名要回原始参数里找
            const formatStepSection = (step, rawArgs = step, suffix = '') => {
                const op = String(step.op || '').trim().toLowerCase();
                const stepTarget = step.target;
                const stepReplace = step.replace;
                const hasTarget = typeof stepTarget !== 'undefined' && stepTarget !== '';
                const replaceText = formatToolChangePreviewValue(stepReplace);
                const lineRange = parseLinesRange(step);

                if (hasTarget && (op === 'delete' || !replaceText)) {
                    // EditCode 缺 replace（或为空）时 ProjectForge 会把整段删掉；
                    // AI 常把 replace 写成 replacement 之类，这时多半不是真想删，要点名提醒
                    const misnamedReplace = op !== 'delete' && typeof stepReplace === 'undefined'
                        ? Object.keys(rawArgs).find(key => {
                            const match = key.match(TOOL_APPROVAL_REPLACE_TYPO);
                            return match && match[2] === suffix;
                        })
                        : undefined;
                    return {
                        label: misnamedReplace
                            ? `将删除这段代码（参数写成了 ${misnamedReplace}，ProjectForge 只认 replace${suffix}）`
                            : '将删除这段代码',
                        deletion: true,
                        text: truncatePreviewLines(stepTarget, 6)
                    };
                }
                if (hasTarget) {
                    const changed = buildToolChangeDiff(stepTarget, stepReplace).filter(line => line.type !== 'context');
                    const visible = changed.slice(0, TOOL_APPROVAL_DIFF_PREVIEW_LINES);
                    const indents = visible.filter(line => line.text.trim()).map(line => line.text.match(/^[ \t]*/)[0].length);
                    const commonIndent = indents.length ? Math.min(...indents) : 0;
                    const shown = visible.map(line => ({ ...line, text: line.text.slice(Math.min(commonIndent, line.text.match(/^[ \t]*/)[0].length)) }));
                    return {
                        label: changed.length ? '改动' : '改动（无实际变化）',
                        diffLines: shown,
                        more: changed.length - shown.length
                    };
                }

                if (op === 'delete') {
                    if (lineRange) {
                        return { label: `将删除第 ${lineRange} 行`, deletion: true, text: '' };
                    }
                    if (step.symbol !== undefined) {
                        return { label: `将删除符号 ${step.symbol}`, deletion: true, text: '' };
                    }
                    return { label: '将删除代码', deletion: true, text: '' };
                }

                if (op === 'insert' || step.after !== undefined || step.before !== undefined) {
                    let label = '插入代码';
                    if (step.after !== undefined) label = `在第 ${step.after} 行后插入`;
                    else if (step.before !== undefined) label = `在第 ${step.before} 行前插入`;
                    const text = step.content !== undefined ? truncatePreviewLines(step.content, 6) : (replaceText || '');
                    return { label, text };
                }

                if (step.symbol !== undefined) {
                    const label = `替换符号 ${step.symbol}`;
                    const text = step.content !== undefined ? truncatePreviewLines(step.content, 6) : (replaceText || '');
                    return { label, text };
                }

                if (lineRange) {
                    // 按行替换缺 content：新版 ProjectForge 拒绝执行，旧版会把这些行删掉，按删除提示并排除出批量允许
                    if (step.content === undefined) {
                        return { label: `第 ${lineRange} 行缺少 content${suffix}，可能会被删掉`, deletion: true, text: replaceText ? truncatePreviewLines(replaceText, 6) : '' };
                    }
                    return { label: `第 ${lineRange} 行 → 新内容`, text: truncatePreviewLines(step.content, 6) };
                }

                if (step.content !== undefined) {
                    return { label: '新内容', text: truncatePreviewLines(step.content, 6) };
                }
                if (replaceText) {
                    return { label: '新内容', text: truncatePreviewLines(replaceText, 6) };
                }

                return null;
            };

            const argsSource = (approvalArgs && Object.keys(approvalArgs).length > 0) ? approvalArgs : (logData.data || {});
            let editSteps = [];
            if (Array.isArray(argsSource.edits)) {
                editSteps = argsSource.edits.filter(step => step && typeof step === 'object');
            } else if (typeof argsSource.edits === 'string') {
                try {
                    const parsed = JSON.parse(argsSource.edits);
                    if (Array.isArray(parsed)) editSteps = parsed.filter(step => step && typeof step === 'object');
                } catch {}
            }
            if (!editSteps.length) {
                const numbered = new Map();
                const stepRegex = /^(op|start|end|lines|after|before|content|target|replace|expect|line|pick|symbol|range)(\d+)$/i;
                for (const [key, value] of Object.entries(argsSource)) {
                    const match = key.match(stepRegex);
                    if (!match) continue;
                    const field = match[1].toLowerCase();
                    const num = Number(match[2]);
                    if (!numbered.has(num)) numbered.set(num, {});
                    numbered.get(num)[field] = value;
                }
                if (numbered.size) {
                    editSteps = [...numbered.keys()].sort((a, b) => a - b).map(n => ({ step: n, ...numbered.get(n) }));
                }
            }

            const MAX_EDIT_STEPS_PREVIEW = 5;
            if (editSteps.length > 0) {
                const visibleSteps = editSteps.slice(0, MAX_EDIT_STEPS_PREVIEW);
                visibleSteps.forEach(step => {
                    // 编号步骤带 step 序号，错名参数在原始参数里以同一序号结尾
                    const sec = step.step !== undefined ? formatStepSection(step, argsSource, String(step.step)) : formatStepSection(step);
                    // 多步时标上序号，几步内容相近也能分清
                    if (sec && editSteps.length > 1) sec.label = `步骤 ${step.step ?? editSteps.indexOf(step) + 1} · ${sec.label}`;
                    if (sec) previewSections.push(sec);
                });
                if (editSteps.length > MAX_EDIT_STEPS_PREVIEW) {
                    const remaining = editSteps.length - MAX_EDIT_STEPS_PREVIEW;
                    previewSections.push({
                        label: `… 还有 ${remaining} 步`,
                        text: ''
                    });
                }
            } else {
                const singleStep = {
                    op: approvalArgs.op,
                    target: changePreview?.target ?? logData.data.target ?? approvalArgs.target,
                    replace: changePreview?.replace ?? logData.data.replace ?? approvalArgs.replace,
                    start: approvalArgs.start,
                    end: approvalArgs.end,
                    lines: approvalArgs.lines,
                    symbol: approvalArgs.symbol,
                    after: approvalArgs.after,
                    before: approvalArgs.before,
                    content: approvalArgs.content
                };
                const hasAnyStepField = singleStep.op !== undefined
                    || singleStep.target !== undefined
                    || (singleStep.replace !== undefined && singleStep.replace !== '')
                    || singleStep.start !== undefined
                    || singleStep.end !== undefined
                    || singleStep.lines !== undefined
                    || singleStep.symbol !== undefined
                    || singleStep.after !== undefined
                    || singleStep.before !== undefined;

                if (hasAnyStepField) {
                    const sec = formatStepSection(singleStep, approvalArgs);
                    if (sec) previewSections.push(sec);
                } else if (typeof approvalArgs.content === 'string') {
                    previewSections.push({ label: '文件内容', text: truncatePreviewLines(approvalArgs.content, 6) });
                }
            }

            // EditCode 一个能认出的编辑字段都没有：批准了 ProjectForge 也会拒绝，别让用户对着空卡片白等白批
            if (String(approvalArgs.command || '') === 'EditCode' && !previewSections.length) {
                const misnamed = Object.keys(approvalArgs).filter(key => TOOL_APPROVAL_TARGET_TYPO.test(key) || TOOL_APPROVAL_REPLACE_TYPO.test(key));
                previewSections.push({
                    label: misnamed.length
                        ? `参数写成了 ${misnamed.join(' / ')}，ProjectForge 只认 target / replace，批准了也不会执行`
                        : '没有可识别的编辑内容，ProjectForge 会拒绝执行',
                    deletion: true,
                    text: ''
                });
            }

            // 回退、删文件、删工程这类命令的作用对象不在 path/content 里，卡片上要写明，
            // 否则只能信 AI 自己写的理由
            const pickArg = (...names) => {
                for (const name of names) {
                    const key = Object.keys(approvalArgs).find(k => k.toLowerCase() === name.toLowerCase());
                    if (key && approvalArgs[key] !== undefined && approvalArgs[key] !== '') return String(approvalArgs[key]);
                }
                return undefined;
            };
            const isTrue = value => /^(true|1|yes)$/i.test(String(value ?? '').trim());
            const command = String(approvalArgs.command || '');
            if (command === 'Rollback') {
                const batchRef = pickArg('batch', 'batchId');
                const nodeRef = pickArg('toNode', 'node', 'nodeId');
                const scope = pickArg('path', 'file');
                let label = '回退目标未写明，ProjectForge 会拒绝执行';
                if (batchRef) label = /^last$/i.test(batchRef) ? '撤销最近一次批次' : `撤销批次 ${batchRef}`;
                else if (nodeRef) label = `把${scope ? ` ${scope} ` : '整个工程'}恢复到节点 ${nodeRef} 时的状态`;
                if (isTrue(pickArg('dryRun'))) label += '（仅预演，不写盘）';
                previewSections.push({ label, text: '' });
                if (isTrue(pickArg('force'))) {
                    previewSections.push({ label: 'force=true：磁盘上不是 ProjectForge 写入的改动也会被覆盖', deletion: true, text: '' });
                }
            } else if (command === 'RemoveFile') {
                const paths = pickArg('paths');
                if (paths) previewSections.push({ label: '将移到回收站（可用 Rollback 恢复）', text: truncatePreviewLines(paths.split(/[,\n]/).map(p => p.trim()).filter(Boolean).join('\n'), 6) });
            } else if (command === 'MoveFile') {
                const from = pickArg('from');
                const to = pickArg('to');
                if (from || to) previewSections.push({ label: '移动 / 重命名', text: `${from || '?'} → ${to || '?'}` });
            } else if (command === 'DeleteProjects' || command === 'RestoreProjects' || command === 'PurgeProjects') {
                const ids = pickArg('projectIds', 'projectId') || '';
                const label = {
                    DeleteProjects: '删除工程（软删，可恢复，不动磁盘文件）',
                    RestoreProjects: '恢复工程',
                    PurgeProjects: '永久清除工程记录和全部历史快照，之后无法回退'
                }[command];
                previewSections.push({ label, deletion: command === 'PurgeProjects', text: ids.split(/[,\n]/).map(p => p.trim()).filter(Boolean).join('\n') });
            }

            if (previewSections.length) {
                const previewBlock = document.createElement('div');
                previewBlock.classList.add('notification-approval-preview');
                previewSections.forEach(({ label, text, deletion, diffLines, more }) => {
                    const section = document.createElement('div');
                    section.classList.add('notification-approval-preview-section');
                    if (deletion) section.classList.add('is-deletion');
                    const labelElement = document.createElement('div');
                    labelElement.classList.add('notification-approval-preview-label');
                    labelElement.textContent = label;
                    const pre = document.createElement('pre');
                    pre.classList.add('notification-approval-preview-code');
                    if (diffLines) {
                        diffLines.forEach(line => {
                            const row = document.createElement('span');
                            row.classList.add('notification-approval-diff-line', line.type === 'add' ? 'is-add' : 'is-delete');
                            row.textContent = `${line.type === 'add' ? '+' : '-'} ${line.text}\n`;
                            pre.appendChild(row);
                        });
                        if (more > 0) pre.appendChild(document.createTextNode(`… 还有 ${more} 行改动`));
                    } else if (typeof text === 'string' && text !== '') {
                        pre.textContent = text;
                    }
                    if (diffLines || (typeof text === 'string' && text !== '')) {
                        section.append(labelElement, pre);
                    } else {
                        section.append(labelElement);
                    }
                    previewBlock.appendChild(section);
                });
                approvalDetails.appendChild(previewBlock);
            }

            if (approvalDetails.hasChildNodes()) {
                contentDiv.appendChild(approvalDetails);
            }
        }
        element.appendChild(contentDiv);

        // Special handling for approval requests - Moved here to be before timestamp
        if (isToolApprovalRequest) {
            const approvalReasonWrapper = document.createElement('div');
            approvalReasonWrapper.classList.add('notification-approval-reason');

            const reasonInput = document.createElement('textarea');
            reasonInput.classList.add('notification-approval-reason-input');
            reasonInput.placeholder = '可选：告诉 AI 为什么通过或拒绝';
            reasonInput.maxLength = 1000;
            reasonInput.rows = isToast ? 2 : 1;
            reasonInput.addEventListener('click', (e) => e.stopPropagation());
            reasonInput.addEventListener('keydown', (e) => e.stopPropagation());

            const reasonHint = document.createElement('div');
            reasonHint.classList.add('notification-approval-reason-hint');
            reasonHint.textContent = '拒绝时建议填写可执行的修正建议，最多 1000 字。';

            approvalReasonWrapper.appendChild(reasonInput);
            approvalReasonWrapper.appendChild(reasonHint);
            element.appendChild(approvalReasonWrapper);

            const approvalActions = document.createElement('div');
            approvalActions.classList.add('notification-actions');

            const finishApproval = (approved, suppliedReason = reasonInput.value) => {
                const requestId = logData.data.requestId;
                if (handledToolApprovalRequestIds.has(requestId)) return false;

                const sent = sendToolApprovalResponse(requestId, approved, suppliedReason);
                if (!sent) return false;

                handledToolApprovalRequestIds.add(requestId);
                dismissToolApprovalNotifications(requestId, { approved, reason: suppliedReason });
                return true;
            };

            if (hasToolChangePreview) {
                const auditBtn = document.createElement('button');
                auditBtn.type = 'button';
                auditBtn.textContent = '审计';
                auditBtn.classList.add('vcp-btn', 'vcp-btn-audit');
                auditBtn.setAttribute('aria-label', `审计 ${logData.data.toolName || '工具'} 的内容变更`);
                auditBtn.onclick = (event) => {
                    event.stopPropagation();
                    openToolChangeAuditModal(logData.data, {
                        reason: reasonInput.value,
                        onDecision: (approved, reason) => finishApproval(approved, reason)
                    });
                };
                approvalActions.appendChild(auditBtn);
            }

            const allowBtn = document.createElement('button');
            allowBtn.textContent = '允许';
            allowBtn.classList.add('vcp-btn', 'vcp-btn-success');
            allowBtn.onclick = (e) => {
                e.stopPropagation();
                finishApproval(true);
            };

            const rejectBtn = document.createElement('button');
            rejectBtn.textContent = '拒绝';
            rejectBtn.classList.add('vcp-btn', 'vcp-btn-danger');
            rejectBtn.onclick = (e) => {
                e.stopPropagation();
                finishApproval(false);
            };

            approvalActions.appendChild(allowBtn);
            approvalActions.appendChild(rejectBtn);
            element.appendChild(approvalActions);
        }

        const timestampSpan = document.createElement('span');
        timestampSpan.classList.add('notification-timestamp');
        timestampSpan.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        if (headRow) headRow.appendChild(timestampSpan);
        else element.appendChild(timestampSpan);

        if (isToast) {
            if (isToolApprovalRequest) {
                // 审核请求防误触：悬浮通知本体点击不关闭，必须点“允许/拒绝”。
                element.onclick = null;
            } else {
                element.onclick = () => {
                    // 清除自动消失的timeout（如果有的话）
                    if (element.dataset.autoDismissTimeout) {
                        clearTimeout(parseInt(element.dataset.autoDismissTimeout));
                    }
                    closeToastNotification(element);
                }; // Click on bubble itself still closes it
            }
        } else { // For persistent list item
            const copyButton = document.createElement('button');
            copyButton.className = 'notification-copy-btn';
            copyButton.textContent = '📋';
            copyButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
            copyButton.title = '复制消息到剪贴板';
            copyButton.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(textToCopy).then(() => {
                    const originalText = copyButton.textContent;
                    const originalMarkup = copyButton.innerHTML;
                    copyButton.textContent = '已复制!';
                    copyButton.disabled = true;
                    scheduleNotificationTimeout(() => {
                        copyButton.textContent = originalText;
                        copyButton.innerHTML = originalMarkup;
                        copyButton.disabled = false;
                    }, 1500);
                }).catch(err => {
                    console.error('通知复制失败: ', err);
                    const originalText = copyButton.textContent;
                    const originalMarkup = copyButton.innerHTML;
                    copyButton.textContent = '错误!';
                    scheduleNotificationTimeout(() => {
                        copyButton.textContent = originalText;
                        copyButton.innerHTML = originalMarkup;
                    }, 1500);
                });
            };
            const cardActions = document.createElement('div');
            cardActions.classList.add('notification-card-actions');
            cardActions.appendChild(copyButton);

            // 列表用于回看历史：不再「点一下就消失」，改为显式的关闭按钮（待审批卡片不显示）
            const dismissButton = document.createElement('button');
            dismissButton.type = 'button';
            dismissButton.className = 'notification-dismiss-btn';
            dismissButton.title = '移除这条通知';
            dismissButton.setAttribute('aria-label', '移除这条通知');
            dismissButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
            dismissButton.onclick = (e) => {
                e.stopPropagation();
                if (element.dataset.notificationState === 'pending') return;
                element.remove();
            };
            cardActions.appendChild(dismissButton);
            element.appendChild(cardActions);
        }
    };

    const closeToastNotification = (toastElement) => {
        toastElement.classList.add('exiting');
        
        // 设置一个fallback timeout，确保元素一定会被移除
        const fallbackTimeout = scheduleNotificationTimeout(() => {
            if (toastElement.parentNode) {
                toastElement.parentNode.removeChild(toastElement);
            }
        }, 500); // 500ms后强制移除，即使transition没有完成
        
        listenNotification(toastElement, 'transitionend', () => {
            clearTimeout(fallbackTimeout); // 如果transition正常完成，清除fallback
            if (toastElement.parentNode) {
                toastElement.parentNode.removeChild(toastElement);
            }
        }, { once: true });
    };

    const settleApprovalListItem = (approvalElement, decision) => {
        if (approvalElement.dataset.notificationState === 'resolved') return;
        const isExpired = decision?.expired === true;
        const approved = decision?.approved === true;
        const reason = typeof decision?.reason === 'string' ? decision.reason.trim() : '';
        approvalElement.querySelectorAll('.notification-approval-reason, .notification-actions').forEach(node => node.remove());
        delete approvalElement.dataset.protectedNotification;
        approvalElement.classList.remove('notification-protected');
        approvalElement.dataset.notificationTone = isExpired ? 'muted' : (approved ? 'success' : 'muted');

        const result = document.createElement('div');
        result.classList.add('notification-result', isExpired ? 'is-expired' : (approved ? 'is-approved' : 'is-rejected'));
        const verdict = document.createElement('span');
        verdict.classList.add('notification-result-verdict');
        verdict.textContent = isExpired ? '已过期' : (approved ? '已允许' : '已拒绝');
        result.appendChild(verdict);
        if (reason) {
            const reasonText = document.createElement('span');
            reasonText.classList.add('notification-result-reason');
            reasonText.textContent = reason;
            result.appendChild(reasonText);
        }
        const content = approvalElement.querySelector('.notification-content');
        (content || approvalElement.querySelector('.notification-head'))?.after(result);
        // 最后切换状态，让 notificationCenter 一次性归档
        approvalElement.dataset.notificationState = 'resolved';
    };

    const dismissToolApprovalNotifications = (requestId, decision = null) => {
        if (!requestId) return;

        const cancelTimer = toolApprovalTimers.get(requestId);
        if (cancelTimer) {
            if (typeof cancelTimer === 'function') {
                cancelTimer();
            } else {
                clearTimeout(cancelTimer);
            }
            toolApprovalTimers.delete(requestId);
        }

        const escapedRequestId = CSS.escape(String(requestId));
        const approvalElements = document.querySelectorAll(`.notification-tool-approval[data-tool-approval-request-id="${escapedRequestId}"]`);

        approvalElements.forEach((approvalElement) => {
            approvalElement.querySelectorAll('button, textarea').forEach((control) => {
                control.disabled = true;
            });

            const auditModal = document.getElementById('toolChangeAuditModal');
            if (auditModal?.classList.contains('active')
                && document.getElementById('toolChangeAuditRequestId')?.textContent === String(requestId)) {
                window.uiHelperFunctions?.closeModal?.('toolChangeAuditModal');
            }

            if (approvalElement.classList.contains('floating-toast-notification')) {
                closeToastNotification(approvalElement);
            } else if (decision) {
                settleApprovalListItem(approvalElement, decision);
            } else {
                approvalElement.remove();
            }
        });
    };

    const expireToolApprovalNotification = (requestId) => {
        if (!requestId || handledToolApprovalRequestIds.has(requestId)) return;
        handledToolApprovalRequestIds.add(requestId);
        dismissToolApprovalNotifications(requestId, { expired: true });
    };

    // 初始化焦点清理机制
    initializeFocusCleanup();

    // Render Floating Toast only if the sidebar is not already active and filter allows it
    const notificationsSidebarElement = document.getElementById('notificationsSidebar');

    // Check if message should be filtered
    const filterResult = checkMessageFilter(titleText);

    // 如果过滤总开关未启用，或者明确匹配白名单规则，则显示通知；审批请求（tool_approval_request）必须有人回应，免受黑名单规则拦截
    const shouldShowNotification = isToolApprovalRequest || !filterResult || (filterResult.action === 'show');

    if (toastContainer && (!notificationsSidebarElement || !notificationsSidebarElement.classList.contains('active')) && shouldShowNotification) {
        const toastBubble = document.createElement('div');
        toastBubble.classList.add('floating-toast-notification');
        // 添加创建时间戳
        toastBubble.dataset.createdAt = Date.now().toString();
        populateNotificationElement(toastBubble, true);

        toastContainer.prepend(toastBubble);
        scheduleNotificationTimeout(() => toastBubble.classList.add('visible'), 50);
        
        // 增强自动消失逻辑，支持自定义停留时间
        let autoDismissDelay = 7000; // 默认7秒

        // 审核类通知永不自动消失
        if (isToolApprovalRequest) {
            autoDismissDelay = Infinity;
        } else {
            const filterResult = checkMessageFilter(titleText);
            if (filterResult && filterResult.duration !== undefined) {
                autoDismissDelay = filterResult.duration === 0 ? Infinity : filterResult.duration * 1000;
            }
        }

        let autoDismissTimeout;
        if (autoDismissDelay === Infinity) {
            // 永久显示，不设置自动消失定时器
            autoDismissTimeout = null;
        } else {
            autoDismissTimeout = scheduleNotificationTimeout(() => {
                if (toastBubble.parentNode && toastBubble.classList.contains('visible') && !toastBubble.classList.contains('exiting')) {
                    closeToastNotification(toastBubble);
                }
            }, autoDismissDelay);
        }
        
        // 保存timeout ID，以便在手动关闭时清除（如果有的话）
        if (autoDismissTimeout) {
            toastBubble.dataset.autoDismissTimeout = autoDismissTimeout.toString();
        }
    } else if (toastContainer && notificationsSidebarElement && notificationsSidebarElement.classList.contains('active')) {
        // console.log('Notification sidebar is active, suppressing floating toast.');
    } else if (filterResult && filterResult.action === 'hide') {
        console.log('Message filtered out by rule:', filterResult.rule?.name || 'default blacklist', 'Action:', filterResult.action);
    } else if (!toastContainer) {
        console.warn('Floating toast container not found. Toast not displayed.');
    }

    // Render to Persistent Notification Sidebar List
    if (notificationsListUl) {
        const listItemBubble = document.createElement('li'); // Use 'li' for the list
        listItemBubble.classList.add('notification-item'); // Existing class for list items
        populateNotificationElement(listItemBubble, false);
        notificationsListUl.prepend(listItemBubble);
        // Apply 'visible' class for potential animations on list items if defined in CSS
        scheduleNotificationTimeout(() => listItemBubble.classList.add('visible'), 50);
    } else {
        console.warn('Notifications sidebar UL not found. Persistent notification not added.');
    }

    if (isToolApprovalRequest && logData.data?.requestId) {
        const reqId = logData.data.requestId;
        const ttlMs = logData.data.approvalTtlMs;
        if (typeof ttlMs === 'number' && ttlMs > 0) {
            let remainingMs = ttlMs;
            // 实时请求从收到时起算，避免服务器与本机时钟不一致；只有断线重放的旧请求才按服务器时间扣掉已过去的部分
            if (logData._vcpReplay === true && logData.data.timestamp) {
                const parsedTime = Date.parse(logData.data.timestamp);
                if (!Number.isNaN(parsedTime)) {
                    const elapsedMs = Date.now() - parsedTime;
                    remainingMs = Math.min(ttlMs, ttlMs - elapsedMs);
                }
            }

            if (remainingMs <= 0) {
                expireToolApprovalNotification(reqId);
            } else {
                const rawTimer = scheduleNotificationTimeout(() => {
                    expireToolApprovalNotification(reqId);
                }, remainingMs);
                const cancelTimer = typeof rawTimer === 'function' ? rawTimer : () => clearTimeout(rawTimer);
                toolApprovalTimers.set(reqId, cancelTimer);
            }
        }
    }
}

// 添加窗口焦点变化监听，清理残留的通知元素
let focusCleanupInitialized = false;

function initializeFocusCleanup(options = {}) {
    if (focusCleanupInitialized) return;
    focusCleanupInitialized = true;
    notificationLifecycleOwner = options.owner || notificationLifecycleOwner;

    const cleanupExpiredToasts = (maxAgeMs) => {
        const toastContainer = document.getElementById('floating-toast-notifications-container');
        if (!toastContainer) return;
        toastContainer.querySelectorAll('.floating-toast-notification').forEach(toast => {
            if (toast.dataset.protectedNotification === 'tool-approval') return;
            const createdAt = Number(toast.dataset.createdAt || Date.now());
            if (!toast.dataset.createdAt) toast.dataset.createdAt = String(createdAt);
            if (Date.now() - createdAt > maxAgeMs) toast.parentNode?.removeChild(toast);
        });
    };

    // 当窗口重新获得焦点时，清理所有可能残留的通知元素
    const onFocus = () => {
        const toastContainer = document.getElementById('floating-toast-notifications-container');
        if (toastContainer) {
            // 查找所有添加了 exiting 类但仍在 DOM 中的元素
            const exitingToasts = toastContainer.querySelectorAll('.floating-toast-notification.exiting');
            exitingToasts.forEach(toast => {
                if (toast.parentNode) {
                    console.log('[NotificationRenderer] 清理残留的通知元素');
                    toast.parentNode.removeChild(toast);
                }
            });
            
            // 清理超时的通知元素（显示超过10秒的）
            const allToasts = toastContainer.querySelectorAll('.floating-toast-notification');
            allToasts.forEach(toast => {
                if (toast.dataset.protectedNotification === 'tool-approval') return;

                // 检查元素创建时间，如果没有时间戳则设置一个
                if (!toast.dataset.createdAt) {
                    toast.dataset.createdAt = Date.now().toString();
                } else {
                    const createdAt = parseInt(toast.dataset.createdAt);
                    const now = Date.now();
                    if (now - createdAt > 10000) { // 超过10秒
                        console.log('[NotificationRenderer] 清理超时的通知元素');
                        if (toast.parentNode) {
                            toast.parentNode.removeChild(toast);
                        }
                    }
                }
            });
        }
    };
    if (notificationLifecycleOwner?.add) notificationLifecycleOwner.add(window, 'focus', onFocus);
    else window.addEventListener('focus', onFocus);

    // 定期清理机制，每30秒检查一次
    const scheduleCleanup = () => {
        cleanupExpiredToasts(15000);
        if (notificationLifecycleOwner?.timeout) notificationLifecycleOwner.timeout(scheduleCleanup, 30000);
        else scheduleNotificationTimeout(scheduleCleanup, 30000);
    };
    scheduleCleanup();
}

// Expose functions to be used by renderer.js
window.notificationRenderer = {
    updateVCPLogStatus,
    renderVCPLogNotification,
    initializeFocusCleanup,
    clearPersistentNotifications,
    buildToolChangeDiff,
    openToolChangeAuditModal,
    configureCapabilities({ filterManager = null, listenerOwner = null } = {}) {
        filterManagerCapability = filterManager;
        notificationLifecycleOwner = listenerOwner;
    }
};
