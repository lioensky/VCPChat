// 按模型配置缩小最终合成的头部动作；只限制头，不改变眼睛、嘴或身体参数。
const HEAD_AXES = { x: 'ParamAngleX', y: 'ParamAngleY', z: 'ParamAngleZ' };

export function createHeadPoseLimiter(coreModel, getId) {
    const parameters = coreModel?._model?.parameters || coreModel?.getModel?.()?.parameters;
    const ids = Array.from(parameters?.ids || []);
    const axes = Object.entries(HEAD_AXES).map(([axis, id]) => ({ axis, id, index: ids.indexOf(id) }))
        .filter(({ index }) => index >= 0);

    return (limits, compress = true) => {
        if (!limits || !parameters) return;
        for (const { axis, id, index } of axes) {
            const limit = limits[axis];
            if (!Number.isFinite(limit) || limit < 0) continue;
            const value = parameters.values[index];
            const min = parameters.minimumValues[index];
            const max = parameters.maximumValues[index];
            const rest = parameters.defaultValues[index];
            if (![value, min, max, rest].every(Number.isFinite)) continue;
            const lower = Math.max(min, rest - limit);
            const upper = Math.min(max, rest + limit);
            const delta = value - rest;
            const span = delta < 0 ? rest - min : max - rest;
            // 整段动作等比收小，保留靠近正脸时的连续变化，避免过早到达边界。
            const scaled = compress && span > 0 ? rest + delta * Math.min(1, limit / span) : value;
            coreModel.setParameterValueById(getId(id), Math.max(lower, Math.min(upper, scaled)));
        }
    };
}
