// Agent VoicePicker presentation bridge.
//
// Mounts a modern Trigger and floating PopupSelect view over the canonical
// agentTtsVoicePrimary and agentTtsVoiceSecondary select elements.
// The native select elements remain strictly authoritative in the DOM
// (for settingsManager data persistence, serialization, and test assertions),
// while the visual presentation provides a 30px height, 8px radius input shell
// with an embedded Chevron icon, fuzzy search filtering (rankByName),
// optgroup categorization, and checkmark indicators.

import { ensurePresentationScope } from './bridge-shared.js';
import { createPopupSelectController, mountPopupSelectView } from '../../uiux/generated/primitives/popup-select.js';

const agentVoicePickerReleases = new Map();

function mountSingleVoicePicker(form, selectId, { marker, scopeLabel, scope }) {
    const select = form?.querySelector?.(`#${selectId}`);
    if (!select || select.dataset[marker] === 'true') return;
    const host = select.closest?.('.model-input-container');
    if (!host) return;

    const voiceScope = scope.child(`${scopeLabel}-${selectId}`);
    const isPrimary = selectId === 'agentTtsVoicePrimary';
    const fieldLabel = isPrimary ? '主语言音色' : '副语言音色';
    const fallbackText = isPrimary ? '不使用语音' : '不使用';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = `${selectId}Trigger`;
    trigger.className = 'vcp-tts-voice-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || fieldLabel);

    const labelSpan = document.createElement('span');
    labelSpan.className = 'vcp-tts-voice-trigger-label';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'vcp-tts-voice-trigger-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

    trigger.append(labelSpan, iconSpan);

    select.classList.add('vcp-tts-voice-native-select');
    select.setAttribute('tabindex', '-1');
    select.dataset[marker] = 'true';

    select.after(trigger);
    host.classList.add('vcp-tts-voice-host');

    const syncTrigger = () => {
        const selectedOption = select.selectedOptions?.[0];
        const text = selectedOption?.textContent?.trim() || select.value || fallbackText;
        labelSpan.textContent = text;
        trigger.title = text;
        trigger.disabled = Boolean(select.disabled);
    };
    syncTrigger();

    voiceScope.listen(select, 'change', syncTrigger);
    voiceScope.listen(select, 'input', syncTrigger);

    if (typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(() => {
            syncTrigger();
        });
        observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
        voiceScope.own(() => observer.disconnect(), `${selectId}-observer`, 'observer');
    }

    const extractOptions = () => {
        const items = [];
        for (const child of Array.from(select.children)) {
            if (child.tagName === 'OPTGROUP') {
                const groupLabel = child.label || child.getAttribute('label') || '';
                for (const opt of Array.from(child.querySelectorAll('option'))) {
                    items.push({
                        id: opt.value,
                        label: opt.textContent?.trim() || opt.value,
                        group: groupLabel,
                        active: opt.value === select.value,
                        disabled: Boolean(opt.disabled),
                    });
                }
            } else if (child.tagName === 'OPTION') {
                items.push({
                    id: child.value,
                    label: child.textContent?.trim() || child.value,
                    group: '',
                    active: child.value === select.value,
                    disabled: Boolean(child.disabled),
                });
            }
        }
        return items;
    };

    const api = globalThis.window?.VCPUIUX;
    const createController = api?.createPopupSelectController || createPopupSelectController;
    const mountView = api?.mountPopupSelectView || mountPopupSelectView;

    let popup = null;
    let view = null;

    try {
        popup = createController({
            command: 'voice',
            options: async () => extractOptions(),
            onSelect: (option) => {
                if (select.disabled) return;
                select.value = option.id;
                syncTrigger();
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
            },
        }, {
            consume: () => true,
            focusComposer: () => trigger.focus(),
        });

        view = mountView(host, {
            popup,
            anchor: trigger,
            searchEnabled: true,
            grouped: true,
            searchPlaceholder: '搜索音色…',
            searchAria: '搜索音色',
            overlayAria: `${fieldLabel}选择`,
            listboxAria: `${fieldLabel}列表`,
            statusEmpty: '无匹配音色',
            optionRole: 'menuitemradio',
        }, voiceScope);

        view.card.classList.add('vcp-tts-voice-popup-card');
        view.card.id = `vcp-tts-voice-menu-${selectId}`;
        trigger.setAttribute('aria-controls', view.card.id);

        const placeCard = () => {
            if (!trigger.isConnected || !popup.getSnapshot().open) return;
            const anchorRect = trigger.getBoundingClientRect();
            const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 800;
            const spaceBelow = viewportHeight - anchorRect.bottom;
            const spaceAbove = anchorRect.top;
            const preferAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
            view.card.classList.toggle('vcp-tts-voice-popup-above', preferAbove);
        };

        voiceScope.listen(trigger, 'click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            if (trigger.disabled) return;
            if (popup.getSnapshot().open) {
                popup.dismiss();
            } else {
                popup.open('voice', {}, { via: 'menu', span: { source: 'agent-voice-picker' } });
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(placeCard);
                } else {
                    setTimeout(placeCard, 0);
                }
            }
        });

        const unsubscribe = popup.subscribe(() => {
            const isOpen = popup.getSnapshot().open;
            trigger.setAttribute('aria-expanded', String(isOpen));
            if (isOpen) {
                placeCard();
            }
        });
        voiceScope.own(unsubscribe, 'voice-picker-subscription', 'ui-presentation');

        if (typeof window !== 'undefined') {
            voiceScope.listen(window, 'resize', placeCard);
        }
        if (typeof document !== 'undefined') {
            voiceScope.listen(document, 'scroll', placeCard, { capture: true });
        }
        if (typeof ResizeObserver !== 'undefined') {
            const cardResizeObserver = new ResizeObserver(() => {
                if (voiceScope.active) placeCard();
            });
            cardResizeObserver.observe(view.card);
            voiceScope.own(() => cardResizeObserver.disconnect(), 'voice-picker-card-resize', 'observer');
        }

        const release = scope.own(async () => {
            delete select.dataset[marker];
            select.classList.remove('vcp-tts-voice-native-select');
            select.removeAttribute('tabindex');
            trigger.remove();
            host.classList.remove('vcp-tts-voice-host');
            await voiceScope.dispose(`${scopeLabel}-${selectId}-released`);
            agentVoicePickerReleases.delete(select);
        }, `${scopeLabel}-${selectId}`, 'ui-primitive');

        agentVoicePickerReleases.set(select, release);
    } catch (error) {
        void voiceScope.dispose(`${scopeLabel}-${selectId}-failed`);
        console.warn(`[VCPUI SettingsBridge] Could not mount typed voice picker for #${selectId}:`, error);
    }
}

export function mountTypedAgentVoicePicker(form, {
    primaryId = 'agentTtsVoicePrimary',
    secondaryId = 'agentTtsVoiceSecondary',
    marker = 'vcpTypedVoicePicker',
    scopeLabel = 'agent-voice-picker-production',
    scope: callerScope,
} = {}) {
    const scope = callerScope || ensurePresentationScope();
    if (!form || !scope) return;

    [primaryId, secondaryId].forEach(selectId => {
        mountSingleVoicePicker(form, selectId, { marker, scopeLabel, scope });
    });
}

export async function cleanupDisconnectedAgentVoicePickers() {
    const promises = [];
    for (const [select, release] of agentVoicePickerReleases) {
        if (!select.isConnected) {
            promises.push(release());
        }
    }
    await Promise.allSettled(promises);
}

export async function releaseAllAgentVoicePickers() {
    const promises = [];
    for (const release of agentVoicePickerReleases.values()) {
        promises.push(release());
    }
    agentVoicePickerReleases.clear();
    await Promise.allSettled(promises);
}
