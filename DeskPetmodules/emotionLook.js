// 情绪在桌宠上看起来什么样：角标的文字和表情符号、头像的色环、Live2D 和网格立绘叠加的参数。
// 情绪键与侧栏差分立绘相同（modules/emotion）。

export const EMOTION_LABEL = {
    neutral: '平静', calm: '放松', happy: '开心', excited: '兴奋', shy: '害羞', affectionate: '温柔',
    curious: '好奇', surprised: '惊讶', concerned: '担心', sad: '难过', tired: '疲惫', angry: '生气',
};
export const EMOTION_EMOJI = {
    neutral: '🙂', calm: '😌', happy: '😊', excited: '🤩', shy: '😳', affectionate: '🥰',
    curious: '🤔', surprised: '😮', concerned: '😟', sad: '😢', tired: '😪', angry: '😠',
};
export const EMOTION_RING = {
    neutral: '#9aa4b2', calm: '#8fc7b8', happy: '#ffb648', excited: '#ff9f1c', shy: '#ff8fb1', affectionate: '#ff7eb6',
    curious: '#6b8cff', surprised: '#59d0ff', concerned: '#b39ddb', sad: '#6c8fb3', tired: '#a58cff', angry: '#ff5f57',
};

// 情绪 → 叠加到标准参数上的增量（乘以强度）。模型没有的参数自动跳过，
// 所以没有 exp3 表情文件的模型（例如 Hiyori）也能看出情绪。
export const EMOTION_PARAMS = {
    neutral: {},
    calm: { ParamEyeLSmile: 0.3, ParamEyeRSmile: 0.3, ParamMouthForm: 0.3 },
    happy: { ParamMouthForm: 1, ParamEyeLSmile: 0.9, ParamEyeRSmile: 0.9, ParamCheek: 0.5, ParamBrowLY: 0.3, ParamBrowRY: 0.3 },
    excited: { ParamMouthForm: 1, ParamMouthOpenY: 0.4, ParamEyeLOpen: 0.25, ParamEyeROpen: 0.25, ParamBrowLY: 0.8, ParamBrowRY: 0.8, ParamCheek: 0.4 },
    shy: { ParamCheek: 1, ParamMouthForm: 0.4, ParamEyeLOpen: -0.25, ParamEyeROpen: -0.25, ParamAngleY: -10, ParamAngleX: 8, ParamEyeBallX: -0.4 },
    affectionate: { ParamCheek: 0.7, ParamMouthForm: 0.8, ParamEyeLSmile: 0.6, ParamEyeRSmile: 0.6, ParamAngleZ: 6 },
    curious: { ParamAngleZ: -10, ParamBrowLY: 0.5, ParamBrowRY: -0.1, ParamEyeBallX: 0.3, ParamEyeBallY: 0.2 },
    surprised: { ParamEyeLOpen: 0.35, ParamEyeROpen: 0.35, ParamBrowLY: 0.9, ParamBrowRY: 0.9, ParamMouthOpenY: 0.5, ParamMouthForm: -0.2 },
    concerned: { ParamBrowLY: -0.3, ParamBrowRY: -0.3, ParamBrowLAngle: 0.6, ParamBrowRAngle: 0.6, ParamMouthForm: -0.4 },
    sad: { ParamMouthForm: -0.9, ParamBrowLY: -0.5, ParamBrowRY: -0.5, ParamBrowLAngle: 0.6, ParamBrowRAngle: 0.6, ParamAngleY: -8, ParamEyeLOpen: -0.15, ParamEyeROpen: -0.15 },
    tired: { ParamEyeLOpen: -0.65, ParamEyeROpen: -0.65, ParamAngleZ: 8, ParamBrowLY: -0.2, ParamBrowRY: -0.2 },
    angry: { ParamMouthForm: -0.7, ParamBrowLY: -0.4, ParamBrowRY: -0.4, ParamBrowLAngle: -0.9, ParamBrowRAngle: -0.9, ParamAngleX: -6 },
};
// 状态叠在情绪上：思考时眼睛往上看、调工具时低头专注、出错时皱眉。
export const STATE_PARAMS = {
    thinking: { ParamEyeBallY: 0.6, ParamEyeBallX: 0.3, ParamAngleZ: -6, ParamAngleY: 6 },
    tool: { ParamBrowLY: -0.4, ParamBrowRY: -0.4, ParamEyeBallY: -0.4, ParamAngleY: -8 },
    error: EMOTION_PARAMS.concerned,
};

/** 一帧（{ state, emotion, intensity }）要叠到参数上的目标值：情绪按强度（0.3–1）缩放，状态原样加上去。 */
export function paramTargets(frame) {
    const intensity = Math.max(0.3, Math.min(1, frame.intensity || 0.6));
    const target = {};
    for (const [id, v] of Object.entries(EMOTION_PARAMS[frame.emotion] || {})) target[id] = v * intensity;
    for (const [id, v] of Object.entries(STATE_PARAMS[frame.state] || {})) target[id] = (target[id] || 0) + v;
    return target;
}
