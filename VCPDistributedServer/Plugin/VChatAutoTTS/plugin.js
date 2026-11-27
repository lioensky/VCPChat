(() => {
    'use strict';

    const ID = 'vchat-auto-tts';
    if (window.VCPFrontendPlugins?.get(ID)) return;

    const STORE_KEY = 'vchatAutoTts.settings.v1';
    const processed = new Set();
    const streamingCandidates = new Set();
    const pending = new Map();
    const api = window.chatAPI || window.electronAPI;
    let observer;
    let settingsObserver;
    let controls;
    let settings = loadSettings();

    function loadSettings() {
        try {
            const value = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
            return value && typeof value === 'object' ? value : {};
        } catch {
            return {};
        }
    }

    function saveSettings() {
        localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    }

    function currentAgent() {
        const item = window.VCPMainChatState?.snapshot?.()?.selectedItem;
        return item?.type === 'agent' && item.id ? item : null;
    }

    function getAgentSettings(agentId) {
        return { enabled: false, includeCode: false, ...(settings[agentId] || {}) };
    }

    function setAgentSettings(agentId, value) {
        settings[agentId] = { ...getAgentSettings(agentId), ...value };
        saveSettings();
    }

    function isAssistantMessage(element) {
        return element?.classList?.contains('message-item')
            && (element.classList.contains('assistant') || element.classList.contains('agent'));
    }

    function messageIdOf(element) {
        return element?.dataset?.messageId || '';
    }

    function createUniqueFallbackPrefix(text, label) {
        let prefix;
        do {
            const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
            prefix = `__${label}_${nonce}_`;
        } while (text.includes(prefix));
        return prefix;
    }

    function shouldStripUnclosedToolFallback(text, startIndex, openMarkerLength) {
        if (typeof text !== 'string' || startIndex < 0) return false;
        const lineStart = text.lastIndexOf('\n', startIndex - 1) + 1;
        if (/^[ \t]*$/.test(text.slice(lineStart, startIndex))) return true;
        const afterOpen = text.slice(startIndex + openMarkerLength, startIndex + openMarkerLength + 160);
        return /^[ \t]*\r?\n?[ \t]*(?:(?:tool_name|maid|maidname|valet|valetname|command|jev|archery)\s*[:：]|[^\s,:：「」{}<>()[\]]+\s*[:：]\s*(?:「始(?:escape)?」|\{始(?:escape)?\})|<tool_name>)/i.test(afterOpen);
    }

    function stripProtocolTextFallback(rawText, codeMasks = []) {
        let text = String(rawText || '');
        let idx = 0;
        // 1. 剥离工具批次与嵌套工具结果块为占位符，保留跨跳边界
        text = text.replace(/<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>[\s\S]*?(?:<<<\[VCP_TOOL_BATCH_END:\1\]>>>|$)/g,
            () => `\n<!--VCP_TOOL_RESULT_${idx++}-->\n`);
        let out = '';
        let cursor = 0;
        const resultRe = /\[\[VCP调用结果信息汇总:|VCP调用结果结束\]\]/g;
        let depth = 0;
        let resStart = 0;
        let rm;
        while ((rm = resultRe.exec(text)) !== null) {
            if (rm[0].startsWith('[[')) {
                if (depth++ === 0) resStart = rm.index;
            } else if (depth > 0 && --depth === 0) {
                out += text.slice(cursor, resStart) + `\n<!--VCP_TOOL_RESULT_${idx++}-->\n`;
                cursor = resultRe.lastIndex;
            }
        }
        if (depth > 0) {
            out += text.slice(cursor, resStart) + `\n<!--VCP_TOOL_RESULT_${idx++}-->\n`;
            cursor = text.length;
        }
        text = out + text.slice(cursor);

        // 2. 按协议硬墙界定清理闭合与未闭合工具请求（含模糊尖括号与 ESCAPE）
        const openRe = /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
        const endRe = /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
        const wallRe = /<<<\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|USER|ASSISTANT)\]>>>|<!--VCP_TOOL_RESULT_(?:DOM_)?\d+-->|<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
        let cleaned = '';
        let pos = 0;
        while (pos < text.length) {
            openRe.lastIndex = pos;
            const om = openRe.exec(text);
            if (!om) {
                cleaned += text.slice(pos);
                break;
            }
            cleaned += text.slice(pos, om.index);
            const afterOpen = om.index + om[0].length;
            endRe.lastIndex = afterOpen;
            const em = endRe.exec(text);
            wallRe.lastIndex = afterOpen;
            const wm = wallRe.exec(text);
            if (em && (!wm || em.index < wm.index)) {
                cleaned += '\n';
                pos = em.index + em[0].length;
            } else if (!shouldStripUnclosedToolFallback(text, om.index, om[0].length)) {
                cleaned += om[0];
                pos = afterOpen;
            } else if (wm) {
                cleaned += '\n';
                pos = wm.index;
            } else {
                pos = text.length;
                break;
            }
        }
        let result = cleaned
            .replace(/<!--VCP_TOOL_RESULT_(?:DOM_)?\d+-->/g, '')
            .replace(/\[本轮工具调用摘要:\][\s\S]*?\[本轮工具调用摘要结束\]/gi, '')
            .replace(/<<<\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|ASSISTANT|USER)\]>>>/gi, '')
            .replace(/@!?[\u4e00-\u9fa5A-Za-z0-9_]+/g, '');

        for (let i = codeMasks.length - 1; i >= 0; i -= 1) {
            const { token, text: codeText } = codeMasks[i];
            if (result.includes(token)) {
                result = result.split(token).join(codeText);
            }
        }
        return result.replace(/\s+/g, ' ').trim();
    }

    function extractText(element, includeCode) {
        const content = element.querySelector('.md-content');
        if (!content) return '';

        if (typeof window.messageRenderer?.extractSpeakableTextFromContentElement === 'function') {
            let target = content;
            if (!includeCode) {
                target = content.cloneNode(true);
                target.querySelectorAll('pre, code, .copy-code-button').forEach((node) => node.remove());
            }
            return window.messageRenderer
                .extractSpeakableTextFromContentElement(target)
                .replace(/\s+/g, ' ')
                .trim();
        }

        const clone = content.cloneNode(true);
        let domIdx = 0;
        const docRef = clone.ownerDocument || element.ownerDocument;
        clone.querySelectorAll(
            '.vcp-role-divider, .vcp-tool-result-bubble, [data-vcp-block-type="tool-result"], [data-vcp-block-type="tool-batch"], [data-vcp-block-type="role-divider"]'
        ).forEach((node) => {
            if (docRef?.createTextNode) {
                node.replaceWith(docRef.createTextNode(`\n<!--VCP_TOOL_RESULT_DOM_${domIdx++}-->\n`));
            } else {
                node.remove();
            }
        });
        clone.querySelectorAll(
            '[data-vcp-block-type], .vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble, .vcp-flowlock-bubble, .maid-diary-bubble, .maid-diary-update-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, .tool-bubble, .highlighted-tag, .highlighted-alert-tag, script, style, button, .copy-code-button'
        ).forEach((node) => node.remove());

        const codeMasks = [];
        if (!includeCode) {
            clone.querySelectorAll('pre, code').forEach((node) => node.remove());
        } else {
            const codePrefix = createUniqueFallbackPrefix(clone.textContent || '', 'VCP_TTS_CODE');
            clone.querySelectorAll('pre, code').forEach((node) => {
                if (node.parentElement?.closest('pre, code')) return;
                const rawCodeText = node.innerText || node.textContent || '';
                const token = `${codePrefix}${codeMasks.length}__`;
                codeMasks.push({ token, text: rawCodeText });
                if (docRef?.createTextNode) {
                    const wrapped = node.tagName?.toLowerCase() === 'pre' ? `\n${token}\n` : token;
                    node.replaceWith(docRef.createTextNode(wrapped));
                }
            });
        }

        return stripProtocolTextFallback(clone.innerText || clone.textContent || '', codeMasks);
    }

    async function speak(element) {
        const messageId = messageIdOf(element);
        if (!messageId || processed.has(messageId)) return;
        processed.add(messageId);

        const agent = currentAgent();
        const messageAgentId = element.dataset.agentId || agent?.id;
        if (!agent || !messageAgentId || messageAgentId !== agent.id) return;
        const pluginSettings = getAgentSettings(messageAgentId);
        if (!pluginSettings.enabled) return;

        try {
            const agentConfig = await api.getAgentConfig(messageAgentId);
            if (!agentConfig || agentConfig.error || !agentConfig.ttsVoicePrimary) return;
            const text = extractText(element, pluginSettings.includeCode);
            if (!text) return;
            window.ensureAudioContext?.();
            api.sovitsSpeak({
                text,
                voice: agentConfig.ttsVoicePrimary,
                speed: agentConfig.ttsSpeed || 1,
                msgId: messageId,
                ttsRegex: agentConfig.ttsRegexPrimary,
                directorPrompts: agentConfig.ttsDirectorPrompts,
                voiceSecondary: agentConfig.ttsVoiceSecondary,
                ttsRegexSecondary: agentConfig.ttsRegexSecondary
            });
        } catch (error) {
            console.error('[AutoTTS] 自动朗读失败。', error);
        }
    }

    function trackOrSchedule(element) {
        if (!isAssistantMessage(element)) return;
        const messageId = messageIdOf(element);
        if (!messageId || processed.has(messageId)) return;
        if (element.classList.contains('streaming') || element.classList.contains('thinking')) {
            streamingCandidates.add(messageId);
            return;
        }
        if (!streamingCandidates.has(messageId)) return;
        streamingCandidates.delete(messageId);
        clearTimeout(pending.get(messageId));
        pending.set(messageId, setTimeout(() => {
            pending.delete(messageId);
            if (element.isConnected
                && !element.classList.contains('streaming')
                && !element.classList.contains('thinking')) speak(element);
        }, 650));
    }

    function inspectNode(node) {
        if (!(node instanceof Element)) return;
        if (isAssistantMessage(node)) trackOrSchedule(node);
        node.querySelectorAll?.('.message-item.assistant, .message-item.agent').forEach(trackOrSchedule);
    }

    function markHistoryProcessed() {
        document.querySelectorAll('.message-item.assistant, .message-item.agent').forEach((element) => {
            const id = messageIdOf(element);
            if (id) processed.add(id);
        });
    }

    function syncControls() {
        if (!controls?.isConnected) return;
        const agent = currentAgent();
        const enabled = controls.querySelector('[data-field="enabled"]');
        const includeCode = controls.querySelector('[data-field="includeCode"]');
        enabled.disabled = !agent;
        includeCode.disabled = !agent;
        const value = agent ? getAgentSettings(agent.id) : { enabled: false, includeCode: false };
        enabled.checked = value.enabled;
        includeCode.checked = value.includeCode;
    }

    function injectControls() {
        if (document.getElementById('vchat-auto-tts-controls')) {
            controls = document.getElementById('vchat-auto-tts-controls');
            syncControls();
            return true;
        }
        const speed = document.getElementById('agentTtsSpeed');
        const speedGroup = speed?.closest('div')?.parentElement || speed?.parentElement;
        if (!speedGroup?.parentElement) return false;

        controls = document.createElement('div');
        controls.id = 'vchat-auto-tts-controls';
        controls.innerHTML = `
            <div class="vchat-auto-tts-row">
                <label for="vchatAutoTtsEnabled">自动朗读</label>
                <label class="switch">
                    <input type="checkbox" id="vchatAutoTtsEnabled" data-field="enabled">
                    <span class="slider round"></span>
                </label>
            </div>
            <div class="vchat-auto-tts-row">
                <label for="vchatAutoTtsIncludeCode">朗读代码块</label>
                <label class="switch">
                    <input type="checkbox" id="vchatAutoTtsIncludeCode" data-field="includeCode">
                    <span class="slider round"></span>
                </label>
            </div>`;
        speedGroup.insertAdjacentElement('afterend', controls);

        controls.querySelector('[data-field="enabled"]').addEventListener('change', (event) => {
            const agent = currentAgent();
            if (agent) setAgentSettings(agent.id, { enabled: event.target.checked });
        });
        controls.querySelector('[data-field="includeCode"]').addEventListener('change', (event) => {
            const agent = currentAgent();
            if (agent) setAgentSettings(agent.id, { includeCode: event.target.checked });
        });
        syncControls();
        return true;
    }

    function startSettingsSync() {
        injectControls();
        const container = document.getElementById('agentSettingsContainer') || document.body;
        settingsObserver = new MutationObserver(() => {
            injectControls();
            syncControls();
        });
        settingsObserver.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        const header = document.getElementById('currentChatAgentName');
        if (header) settingsObserver.observe(header, { childList: true, characterData: true, subtree: true });
    }

    function startMessageObserver() {
        const container = document.getElementById('chatMessages');
        if (!container) {
            setTimeout(startMessageObserver, 250);
            return;
        }
        markHistoryProcessed();
        observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes') trackOrSchedule(mutation.target);
                mutation.addedNodes.forEach(inspectNode);
            }
        });
        observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    function destroy() {
        observer?.disconnect();
        settingsObserver?.disconnect();
        pending.forEach(clearTimeout);
        pending.clear();
        streamingCandidates.clear();
        controls?.remove();
    }

    startSettingsSync();
    startMessageObserver();
    window.VCPFrontendPlugins?.register(ID, { destroy, settings: () => settings, syncControls });
})();
