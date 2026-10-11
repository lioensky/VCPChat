'use strict';
const clean = value => String(value ?? '').replace(/[|\r\n`]/g, ' ');
const cash = value => Math.round(value).toLocaleString('en-US');
function formatResult(output) {
    const lines = [`## ForgeTax · ${output.ok ? '成功' : output.partial ? '部分成功' : '失败'}`];
    if (output.message) lines.push(clean(output.message));
    for (const step of output.results || []) {
        lines.push(`- ${step.step}. ${clean(step.command)}：${step.ok ? step.resumed ? '续读存档' : '完成' : clean(step.error)}`);
        const hits = (step.events || []).filter(e => e.type === 'hammer');
        if (hits.length) {
            const counts = {};
            const names = { break: '破碎', damage: '损坏', maintain: '维持', success: '成功', critical: '大成功' };
            for (const h of hits) {
                const key = names[h.result] + (h.blocked ? '(已保护)' : '');
                counts[key] = (counts[key] || 0) + 1;
            }
            lines.push(`  锤${hits.length}次：${Object.entries(counts).map(([k, n]) => `${k}×${n}`).join('，')}`);
        }
        for (const e of step.events || []) {
            if (e.type === 'tribute') lines.push(`  上贡认定 ${cash(e.credited)}/${cash(e.target)}，到账 ${cash(e.paid)}，${e.passed ? '达标' : '扣命'}`);
            if (e.type === 'evolution') lines.push(`  ${clean(e.swordId)}进化：${clean(e.name)}`);
            if (e.type === 'end' || e.type === 'relic') lines.push(`  ${clean(e.ending || e.message)}`);
        }
    }
    if (output.error) lines.push(`**失败步骤 ${output.failedStep ?? '-'}：${clean(output.error)}**`);
    if (output.skipped?.length) lines.push(`未执行：${output.skipped.map(s => `${s.step}.${clean(s.command)}`).join('、')}。已完成步骤保留，请勿整串重放。`);
    const s = output.state;
    if (s) {
        lines.push('', `### 状态 · ${clean(s.player)}`,
            `第${s.day}天 | 命${s.lives} | ${clean(s.status)} | 贡金${cash(s.target)} → 明日${cash(s.nextTarget)}`,
            `现金${cash(s.cash)} | 累计收入${cash(s.income)} | 最高剑值${cash(s.maxSword)}`,
            `runId: \`${clean(s.runId)}\` · revision: ${s.revision}`,
            `道具：${Object.entries(s.items).map(([k, v]) => `${k}×${v}`).join(' ')} | 怀表可用:${s.canUndo ? '是' : '否'} | 次日额外铁剑:${s.pendingIron}`,
            '', '### 背包', '| ID | 剑/等级 | 价值 | 专注/裂痕/积压 | 下一锤概率% 碎/损/维/成/暴 | 效果 |',
            '|---|---|---:|---|---|---|');
        for (const sw of s.swords) {
            const buffs = [sw.protection && '保护', sw.blessing && '祝福', sw.surge && '以损换势', sw.patience && '耐心', sw.broken && '不可强化'].filter(Boolean);
            lines.push(`| ${clean(sw.id)} | ${clean(sw.name)} +${sw.level} | ${cash(sw.value)} | ${sw.focus}/10 / ${sw.cracks.toFixed(1)} / ${sw.pressure.toFixed(1)} | ${sw.probabilities ? sw.probabilities.map(p => (p * 100).toFixed(1)).join('/') : '-'} | ${buffs.join('、') || '-'} |`);
        }
        if (!s.swords.length) lines.push('背包为空。');
        lines.push('', `### 遗物 ${s.relics.length}/8`);
        for (const r of s.relics) lines.push(`- ${clean(r.id)} · ${clean(r.name)}：${clean(r.description)}`);
        if (!s.relics.length) lines.push('无');
        lines.push('', '### 遗物机（每日刷新）');
        for (const r of s.shops.relics) lines.push(`- ${clean(r.id)} · ${clean(r.name)} · ${r.cost}把未敲铁剑 · ${r.sold ? '已售' : r.owned ? '已持有' : '可购'}：${clean(r.description)}`);
        lines.push('', `### 道具商店（${s.shopRefreshIn}天后刷新）`);
        for (const i of s.shops.items) lines.push(`- ${clean(i.id)}：${i.bought >= 3 ? '售罄' : cash(i.price)} · 已买${i.bought}/3`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
}
module.exports = { formatResult };