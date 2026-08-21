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
        const item = window.currentSelectedItem;
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

    function extractText(element, includeCode) {
        const content = element.querySelector('.md-content');
        if (!content) return '';
        const clone = content.cloneNode(true);
        clone.querySelectorAll('.vcp-tool-use-bubble, .vcp-tool-result-bubble, .tool-bubble, script, style, button, .copy-code-button')
            .forEach((node) => node.remove());
        if (!includeCode) clone.querySelectorAll('pre, code').forEach((node) => node.remove());
        return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
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
