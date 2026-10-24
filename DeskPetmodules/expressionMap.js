// Live2D 模型的情绪 → 表情 / 动作映射（纯函数）。桌宠页面按它挑表情，设置页的「表情映射」按它显示「自动」会选哪个。
//
// 先看模型旁边的 deskpet.json：
//   { "expressions": { "happy": "exp_02" }, "motions": { "happy": "Tap", "sad": "" } }
// 写了且模型里有就用它（动作写空字符串是「不放动作」）；没写的按官方示例模型的内置表、再按名字猜。

export const EMOTION_LABELS = [
    ['neutral', '平常'], ['calm', '平静'], ['happy', '开心'], ['excited', '兴奋'],
    ['shy', '害羞'], ['affectionate', '亲昵'], ['curious', '好奇'], ['surprised', '惊讶'],
    ['concerned', '担心'], ['sad', '难过'], ['tired', '疲惫'], ['angry', '生气'],
];
export const EMOTION_KEYS = EMOTION_LABELS.map(([key]) => key);

// 点到哪儿（DeskPetmodules/hitAreas.js 的区域）→ 自己绑定的表情和动作，写在 deskpet.json 的 taps 下：
//   { "taps": { "head": { "expression": "Blushing", "motion": "TapHead" }, "body": { "motion": "TapBody" } } }
// 没绑定的按原来的反应演（点头害羞、点身体开心）。
export const TAP_ZONES = [['head', '点头'], ['body', '点身体']];
export const TAP_KEYS = TAP_ZONES.map(([key]) => key);

/** 这个区域绑定的 { expression, motion }（模型里没有的名字当没绑）；什么都没绑返回 null。 */
export function pickTap(zone, names, groups, profile = {}) {
    const bound = profile?.taps?.[zone];
    if (!bound || typeof bound !== 'object') return null;
    const expression = typeof bound.expression === 'string' && names.includes(bound.expression) ? bound.expression : null;
    const motion = typeof bound.motion === 'string' && groups.includes(bound.motion) ? bound.motion : null;
    return expression || motion ? { expression, motion } : null;
}

/** 设置页用：每个区域现在绑了什么（没绑是 null，交给默认反应）。 */
export function describeTaps({ names = [], groups = [], profile = {} } = {}) {
    return TAP_ZONES.map(([zone, label]) => {
        const bound = pickTap(zone, names, groups, profile);
        return { zone, label, expression: bound?.expression ?? null, motion: bound?.motion ?? null };
    });
}

// 换情绪时点缀一个动作；组不存在就跳过。
export const EMOTION_MOTIONS = {
    happy: ['Tap', 'TapBody', 'Tap@Body'],
    excited: ['Tap', 'TapBody', 'Tap@Body'],
    shy: ['Tap@Body', 'Tap', 'TapBody'],
    affectionate: ['Tap@Body', 'TapBody'],
    surprised: ['Flick', 'FlickUp'],
    sad: ['FlickDown'],
    angry: ['Flick@Body', 'Flick'],
};

// 官方示例模型的表情映射（按模型文件名认）。
export const SAMPLE_EXPRESSIONS = {
    natori: { neutral: 'Normal', calm: 'Normal', happy: 'Smile', excited: 'exp_02', shy: 'Blushing', affectionate: 'Blushing', curious: 'exp_01', surprised: 'Surprised', concerned: 'exp_03', sad: 'Sad', tired: 'exp_05', angry: 'Angry' },
    mao: { neutral: 'exp_01', calm: 'exp_02', happy: 'exp_02', excited: 'exp_04', shy: 'exp_06', affectionate: 'exp_06', curious: 'exp_07', surprised: 'exp_07', concerned: 'exp_05', sad: 'exp_05', angry: 'exp_08' },
    haru: { neutral: 'F01', calm: 'F01', happy: 'F05', excited: 'F02', shy: 'F07', affectionate: 'F07', curious: 'F06', surprised: 'F06', concerned: 'F08', sad: 'F04', tired: 'F08', angry: 'F03' },
    ren: { neutral: 'exp_01', calm: 'exp_01', happy: 'exp_02', tired: 'exp_03', sad: 'exp_04', concerned: 'exp_05' },
};

// 其余模型按表情名猜。
export const EXPRESSION_HINTS = {
    neutral: ['normal', 'neutral', 'default', 'idle', '默认'],
    calm: ['calm', 'relax'],
    happy: ['happy', 'smile', 'joy', 'fun', '开心', '笑'],
    excited: ['excite', 'star', '兴奋'],
    shy: ['shy', 'blush', 'embarrass', '害羞', '脸红'],
    affectionate: ['love', 'heart', 'blush', '喜欢'],
    curious: ['curious', 'question', 'think', '疑问'],
    surprised: ['surprise', 'shock', '惊'],
    concerned: ['worry', 'trouble', 'concern', '担心'],
    sad: ['sad', 'cry', 'tear', '哭', '难过'],
    tired: ['sleep', 'tired', '困'],
    angry: ['angry', 'anger', 'annoy', 'mad', '生气', '怒'],
};

/** 模型文件名（不含 .model3.json，小写），用来认官方示例模型。 */
export function modelNameOf(modelUrlOrPath) {
    const last = String(modelUrlOrPath || '').split(/[\\/]/).pop() || '';
    let name = last;
    try { name = decodeURIComponent(last); } catch { /* 保持原样 */ }
    return name.replace(/\.model3\.json$/i, '').toLowerCase();
}

/** 不看 deskpet.json 时「自动」会选的表情。 */
export function autoExpression(emotion, names, modelName = '') {
    const sample = SAMPLE_EXPRESSIONS[modelName]?.[emotion];
    if (sample && names.includes(sample)) return sample;
    const hints = EXPRESSION_HINTS[emotion] || [];
    return names.find((n) => hints.some((h) => n.toLowerCase().includes(h))) || null;
}

export function autoMotion(emotion, groups) {
    return (EMOTION_MOTIONS[emotion] || []).find((g) => groups.includes(g)) || null;
}

export function pickExpression(emotion, names, profile = {}, modelName = '') {
    const configured = profile?.expressions?.[emotion];
    if (typeof configured === 'string' && names.includes(configured)) return configured;
    return autoExpression(emotion, names, modelName);
}

export function pickMotion(emotion, groups, profile = {}) {
    const configured = profile?.motions?.[emotion];
    if (configured === '') return null;
    if (typeof configured === 'string' && groups.includes(configured)) return configured;
    return autoMotion(emotion, groups);
}

/**
 * 设置页用：每个情绪当前会用什么、是不是自己指定的、「自动」时会是什么。
 * set 为 true 表示 deskpet.json 里写了而且模型里确实有（写了但找不到的当没写）。
 */
export function describeMapping({ names = [], groups = [], profile = {}, modelName = '' } = {}) {
    return EMOTION_LABELS.map(([emotion, label]) => {
        const configuredExpression = profile?.expressions?.[emotion];
        const configuredMotion = profile?.motions?.[emotion];
        return {
            emotion,
            label,
            expression: pickExpression(emotion, names, profile, modelName),
            expressionSet: typeof configuredExpression === 'string' && names.includes(configuredExpression),
            autoExpression: autoExpression(emotion, names, modelName),
            motion: pickMotion(emotion, groups, profile),
            motionSet: configuredMotion === '' || (typeof configuredMotion === 'string' && groups.includes(configuredMotion)),
            autoMotion: autoMotion(emotion, groups),
        };
    });
}
