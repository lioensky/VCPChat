'use strict';

const clean = value => String(value ?? '').replace(/[\r\n`]/g, ' ');

function formatResult(output) {
    const lines = [`## Tavern-SRPG 战棋沙盘 · ${output.ok ? '成功' : output.partial ? '部分成功' : '失败'}`];
    if (output.message) lines.push(clean(output.message));
    for (const step of output.results || []) {
        const detail = step.ok ? (step.message || (step.resumed ? '续读现有战局' : '完成')) : step.error;
        lines.push(`- ${step.step}. **${clean(step.command)}**：${clean(detail)}`);
    }
    if (output.error) {
        lines.push(`**失败步骤 ${output.failedStep ?? '-'}：${clean(output.error)}**`);
    }
    if (output.skipped?.length) {
        lines.push(`未执行：${output.skipped.map(s => `${s.step}.${clean(s.command)}`).join('、')}。已完成步骤保留，请勿重复重放。`);
    }
    const s = output.state;
    if (s) {
        lines.push(
            '',
            `### 沙盘概况 · 资料卡「${clean(s.profileName)}」 (revision: ${s.revision})`,
        );
        if (s.checkpoints?.length) {
            lines.push(
                '天刻回溯存档点：' +
                s.checkpoints.slice(-6).map(cp => `\`${cp.id}\`(${cp.title}, 我${cp.player}/敌${cp.enemy})`).join(' · ')
            );
        }
        if (s.pendingText) {
            lines.push('', '### 本轮待描写/已记录战报', s.pendingText);
        }
        if (s.battleText) {
            lines.push('', '### 完整战场态势', s.battleText);
        }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
}

module.exports = { formatResult };