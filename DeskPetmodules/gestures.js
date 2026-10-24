// 回复里的动作：情绪标记斜杠后面写动作名，<!--emo:happy/nod 0.8--> 就是开心地点点头。
// 斜杠后面本来是立绘的子表情名，动作名占用这几个；情绪标记在主窗口、朗读、气泡里都会去掉，不用另造一种标记。
// 桌宠念到（或显示到）这句话时演这个动作。

// 标记里的写法 → petLife / lifeMotion 的动作名
export const GESTURES = Object.freeze({
    nod: 'agree',
    shake: 'disagree',
    tilt: 'tilt',
    cheer: 'cheer',
    bow: 'bow',
});

export function gestureOf(variant) {
    return typeof variant === 'string' ? GESTURES[variant.toLowerCase()] || null : null;
}

/**
 * 该演哪些动作：标记位置已经显示出来（朗读时是念到的那句末尾，不朗读时是整条），还没演过的。
 * tags 里的项会被标上 played。
 */
export function dueGestures(tags, revealEnd) {
    const end = revealEnd == null ? Infinity : revealEnd;
    const due = [];
    for (const tag of tags || []) {
        if (!tag.gesture || tag.played || tag.at >= end) continue;
        tag.played = true;
        due.push(tag.gesture);
    }
    // 一口气到了好几个（整条一下子显示出来）只演最后一个，不连着抽搐
    return due.length ? [due[due.length - 1]] : [];
}
