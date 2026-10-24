'use strict';

// 只输出可读正文，不向工具结果暴露逐字计时等内部 JSON。
function escapeMarkdown(value) {
    return (typeof value === 'string' ? value : '')
        .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
        .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1')
        .replace(/\r\n?|\n/g, ' ').trim();
}

function formatCurrentLyrics(snapshot) {
    if (!snapshot?.track) return '### 当前歌词\n\n当前未加载歌曲，没有歌词。';
    const { track } = snapshot;
    const header = [
        '### 当前歌词',
        '',
        `- **歌曲**：${escapeMarkdown(track.title) || '未知标题'}`,
        `- **歌手**：${escapeMarkdown(track.artist) || '未知艺术家'}`
    ];
    if (track.album) header.push(`- **专辑**：${escapeMarkdown(track.album)}`);
    const paragraphs = [];
    for (const line of Array.isArray(snapshot.lines) ? snapshot.lines : []) {
        const original = escapeMarkdown(line?.original);
        const translation = escapeMarkdown(line?.translation);
        const romanization = escapeMarkdown(line?.romanization);
        if (!original && !translation && !romanization) continue;
        const parts = [];
        if (original) parts.push(original);
        if (romanization) parts.push(`**罗马音**：${romanization}`);
        if (translation) parts.push(`**译文**：${translation}`);
        paragraphs.push(parts.join('  \n'));
    }
    return header.join('\n') + '\n\n' + (paragraphs.length
        ? '#### 歌词\n\n' + paragraphs.join('\n\n')
        : '当前歌曲暂无歌词。');
}

module.exports = { formatCurrentLyrics };