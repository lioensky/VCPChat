import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 桌宠是透明置顶窗口：只要有一个无限循环的 CSS 动画在跑，窗口就每秒合成 60 帧，
// 待机时比 Live2D 按档位降下来的帧率还费。无限动画只许出现在短暂的状态里（下面列着），
// 平时的呼吸、浮动由页面按帧率档位定时写变量（deskpet.js createCssLife）。
const TRANSIENT = new Map([
    ['#bubble.is-streaming #bubbleText::after', '回复正在流出来时的光标'],
    ['#toolCard[data-status="running"] .tool-card-icon', '工具正在跑'],
    ['body[data-walk] #stage', '正在溜达'],
    ['.pet-dock .rec-dot', '录音中的红点（不在录音时由下一条规则关掉）'],
    ['.pet-dock .rec-stop.is-busy .rec-dot', '识别中'],
]);

function infiniteRules(file) {
    const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/animation[^;]*\binfinite\b/.test(match[2])) rules.push(match[1].trim());
    }
    return { css, rules };
}

test('the pet page runs no endless CSS animation while it is just standing there', () => {
    for (const file of ['DeskPetmodules/deskpet.css', 'DeskPetmodules/dock.css']) {
        for (const selector of infiniteRules(file).rules) {
            assert.ok(TRANSIENT.has(selector), `${file}: ${selector} 是常驻的无限动画`);
        }
    }
    const { css } = infiniteRules('DeskPetmodules/dock.css');
    assert.match(css, /\.pet-dock:not\(\[data-mode="rec"\]\) \.rec-dot\s*\{\s*animation: none;/);
});
