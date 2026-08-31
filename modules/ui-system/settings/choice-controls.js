// Appearance/voice Choice primitive mounting. Native radios remain canonical.
export function mountChoiceControls(form, api, scope) {
    if (!form || !scope || !api?.mountChoice) return;
    const voice = form.querySelector('#voiceModeLocal')?.closest('.vcp-settings-control-row');
    if (voice && voice.dataset.vcpTypedPrimitiveMounted !== 'true') {
        api.mountChoice(voice, scope);
        voice.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete voice.dataset.vcpTypedPrimitiveMounted; }, 'typed-voice-mode-choice-marker', 'ui-primitive');
    }
    // 聊天布局 (标准/宽屏) uses the same segmented pill presentation; the
    // checked radio stays the canonical value the projection CSS keys on.
    const chatLayout = form.querySelector('#chatLayoutModeNormal')?.closest('.vcp-settings-control-row');
    if (chatLayout && chatLayout.dataset.vcpTypedPrimitiveMounted !== 'true') {
        api.mountChoice(chatLayout, scope);
        chatLayout.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete chatLayout.dataset.vcpTypedPrimitiveMounted; }, 'typed-chat-layout-choice-marker', 'ui-primitive');
    }
}
