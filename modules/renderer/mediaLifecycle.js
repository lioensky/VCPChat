/** Chat media must start only through playback controls, never HTML attributes. */
export function prepareChatMediaHtml(html, ownerDocument) {
    if (typeof html !== 'string' || !/<\s*(?:audio|video)\b/i.test(html)) return html;
    const template = ownerDocument.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('audio, video').forEach(media => {
        media.removeAttribute('autoplay');
        media.removeAttribute('loop');
        media.setAttribute('preload', 'metadata');
        media.setAttribute('controls', '');
    });
    return template.innerHTML;
}

/** Include the root itself: morphdom can discard an individual media node. */
export function cleanupChatMedia(root) {
    if (!root) return;
    const players = [...(root.querySelectorAll?.('.vcp-audio-player') || [])];
    if (root.matches?.('.vcp-audio-player')) players.unshift(root);
    players.forEach(player => {
        player._vcpAudioCleanup?.();
        delete player._vcpAudioCleanup;
    });
    const mediaNodes = [...(root.querySelectorAll?.('audio, video') || [])];
    if (root.matches?.('audio, video')) mediaNodes.unshift(root);
    mediaNodes.forEach(media => {
        media.autoplay = false;
        media.loop = false;
        try { media.pause?.(); } catch { /* already closed */ }
        if ('srcObject' in media) {
            try { media.srcObject = null; } catch { /* unsupported source */ }
        }
        media.removeAttribute('src');
        media.querySelectorAll?.('source, track').forEach(source => source.removeAttribute('src'));
        try { media.load?.(); } catch { /* already closed */ }
    });
}