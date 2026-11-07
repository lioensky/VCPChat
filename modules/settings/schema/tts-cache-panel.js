export function buildTtsCachePanel(doc) {
    const row = doc.createElement('div');
    row.className = 'vcp-uiux-language-row';
    const text = doc.createElement('div');
    text.className = 'vcp-uiux-language-row-text';
    const title = doc.createElement('div');
    title.className = 'vcp-uiux-language-row-title';
    title.textContent = '合成音频缓存';
    const status = doc.createElement('div');
    status.className = 'vcp-uiux-language-row-description';
    status.textContent = '清理本地与网络共用的 AppData/tts_cache；不删除模型、参考音频或音色预设。';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'vcp-uiux-language-row-selector';
    button.textContent = '清空语音缓存';
    const api = doc.defaultView?.electronAPI;
    button.disabled = !api?.sovitsClearAudioCache;
    button.addEventListener('click', async () => {
        if (button.disabled || !doc.defaultView.confirm('清空已生成的本地和网络语音缓存？下次朗读需重新合成（网络模式可能再次计费）。不会删除参考音频和预设。')) return;
        button.disabled = true;
        try {
            const result = await api.sovitsClearAudioCache();
            status.textContent = `已清理 ${result.removed} 个音频缓存。正在播放的音频不会被打断。`;
        } catch (error) {
            status.textContent = `清理失败：${error.message}`;
        } finally {
            button.disabled = false;
        }
    });
    text.append(title, status);
    row.append(text, button);
    return row;
}