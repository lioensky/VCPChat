'use strict';

// 目录是提示词和执行器的共同白名单，不修改原模型或 VTube Studio 配置。
const path = require('path');
const { createHash } = require('crypto');
const fs = require('fs-extra');
const { modelInfo, readLocalJson, readWardrobe } = require('./live2dWardrobe');

const MAX_ITEMS = 200;
const labelOf = value => String(value || '').replace(/(?:\.exp3|\.motion3)\.json$/i, '')
    .replace(/^按键[\s_-]+/u, '').replace(/[\r\n<>{}|=]/g, '').trim().slice(0, 48);

async function readCapabilities(modelPath) {
    const { base, model, vtube } = await modelInfo(modelPath);
    if (!model) return { items: [], expressions: [], motions: {} };
    const wardrobe = await readWardrobe(modelPath);
    const excluded = new Set(wardrobe.flatMap(group => group.items.map(item => item.id)));
    const candidates = new Map();
    const idleFiles = new Set([vtube?.FileReferences?.IdleAnimation, vtube?.FileReferences?.IdleAnimationWhenTrackingLost]);
    const add = (file, name, group = null, index = 0) => {
        if (typeof file !== 'string' || !/\.(exp3|motion3)\.json$/i.test(file)) return;
        file = file.replace(/\\/g, '/');
        if (excluded.has(file)) return;
        if (!candidates.has(file) && candidates.size < MAX_ITEMS) candidates.set(file, { file, name: labelOf(name || path.posix.basename(file)), group, index });
    };
    const refs = model.FileReferences || {};
    for (const entry of (Array.isArray(refs.Expressions) ? refs.Expressions : []).slice(0, MAX_ITEMS)) add(entry?.File, entry?.Name);
    for (const [group, entries] of Object.entries(refs.Motions || {}).slice(0, MAX_ITEMS)) {
        if (!Array.isArray(entries)) continue;
        entries.slice(0, MAX_ITEMS).forEach((entry, index) => add(entry?.File, labelOf(path.posix.basename(entry?.File || '')) || group, group, index));
    }
    for (const hotkey of (Array.isArray(vtube?.Hotkeys) ? vtube.Hotkeys : []).slice(0, MAX_ITEMS)) {
        if (['ToggleExpression', 'TriggerAnimation'].includes(hotkey?.Action)) add(hotkey.File, hotkey.Name);
    }
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) if (entry.isFile()) add(entry.name);
    const items = [], expressions = [], motions = {};
    for (const candidate of candidates.values()) {
        const data = await readLocalJson(base, candidate.file);
        if (!data) continue;
        const expression = /\.exp3\.json$/i.test(candidate.file);
        const digest = createHash('sha256').update(`${modelPath}\0${candidate.file}\0${JSON.stringify(data)}`).digest('hex').slice(0, 10);
        const id = `${expression ? 'e' : 'm'}${digest}`;
        if (expression) {
            if (!Array.isArray(data.Parameters) || data.Parameters.length > 500) continue;
            const parameters = data.Parameters.filter(p => typeof p?.Id === 'string' && p.Id.length <= 200 && Number.isFinite(p.Value)
                && ['Add', 'Multiply', 'Overwrite'].includes(p.Blend || 'Add'))
                .map(p => ({ id: p.Id, value: p.Value, blend: p.Blend || 'Add' }));
            if (!parameters.length) continue;
            // 正式声明缺失时在内存中补齐引擎资源。
            const declared = Array.isArray(refs.Expressions) ? refs.Expressions : [];
            const name = declared.find(e => e?.File?.replace(/\\/g, '/') === candidate.file)?.Name || candidate.name;
            expressions.push({ Name: name, File: candidate.file });
            items.push({ id, name: candidate.name, kind: 'expression', parameters });
        } else {
            if (!Array.isArray(data.Curves) || !Number.isFinite(data.Meta?.Duration) || data.Meta.Duration <= 0) continue;
            const system = idleFiles.has(candidate.file) || /idle|待机|面捕|tracking.?lost/i.test(`${candidate.name} ${candidate.group || ''}`);
            // 每个文件独立组，指令始终精确选择一个动画，不随机挑组内动作。
            const group = `deskpet_${id}`;
            motions[group] = [{ File: candidate.file }];
            if (!system) items.push({
                id, name: candidate.name, kind: 'motion', group, index: 0, duration: Math.min(30, data.Meta.Duration),
                parameterIds: [...new Set(data.Curves.filter(c => c?.Target === 'Parameter' && typeof c.Id === 'string').map(c => c.Id))].slice(0, 500),
            });
        }
    }
    return { items, expressions, motions };
}

function capabilityPrompt(catalog) {
    const items = catalog?.items || [];
    if (!items.length) return '';
    const lines = [
        '【模型能力】情绪标记斜杠后可写下列编号，多个用 + 连接，可与通用动作组合；末尾强度可省略（默认0.7，范围0到1）。例如 <!--emo:happy/nod 0.8-->。只按需调用，不编造编号；表情和姿态短暂显示后自动恢复，不改变服装。',
    ];
    for (const [kind, title] of [['expression', '表情/姿态'], ['motion', '动画']]) {
        const rows = items.filter(item => item.kind === kind);
        if (rows.length) lines.push(`${title}：${rows.map(item => `${item.id}=${labelOf(item.name)}`).join('、')}`);
    }
    const example = items.find(item => item.kind === 'expression') || items[0];
    lines.push(`调用示例：<!--emo:happy/${example.id} 0.8-->`);
    return lines.join('\n');
}

module.exports = { readCapabilities, capabilityPrompt };