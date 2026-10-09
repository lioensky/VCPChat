// 头顶小符号（所有形象共用）：被碰到、闲时小动作时冒 💢 💫 💕 ♪ ❗，睡着时飘 z，被拎起来冒 💦。

// 动作 → 冒出来的符号
const LIFE_FX = { annoyed: '💢', dizzy: '💫', pat: '💕', sleepPat: '💕', headTap: '♪', hum: '♪', startle: '❗', yawn: '💭', wake: '✨' };

// 睡着时的 z 一秒只挪两三下：CSS 无限动画即使分段也每帧合成，软件渲染下多占 GPU 进程几个百分点
const ZZZ_STEP_MS = 400;
const ZZZ_STEPS = 8;

export function createLifeFx() {
    const el = document.getElementById('lifeFx');
    let timer = 0;
    let zzzTimer = 0;
    let zzzStep = 0;
    let sleeping = false;
    const stepZzz = () => {
        const k = zzzStep / (ZZZ_STEPS - 1);
        el.style.opacity = String(k < 0.25 ? k * 4 : 1 - (k - 0.25) / 0.75);
        el.style.translate = `${Math.round(14 * k)}px ${Math.round(-36 * k)}px`;
        el.style.fontSize = `${Math.round(14 + 12 * k)}px`;
        zzzStep = (zzzStep + 1) % ZZZ_STEPS;
    };
    const stopZzz = () => {
        clearInterval(zzzTimer);
        zzzTimer = 0;
        el.style.removeProperty('opacity');
        el.style.removeProperty('translate');
        el.style.removeProperty('font-size');
    };
    const show = (glyph, ms, mode) => {
        clearTimeout(timer);
        stopZzz();
        if (mode === 'is-zzz' && !document.body.classList.contains('is-paused')) {
            zzzStep = 0;
            stepZzz();
            zzzTimer = setInterval(stepZzz, ZZZ_STEP_MS);
        }
        el.textContent = glyph;
        el.className = '';
        void el.offsetWidth;
        el.className = mode;
        el.hidden = false;
        if (ms) timer = setTimeout(() => { if (sleeping) show('z', 0, 'is-zzz'); else el.hidden = true; }, ms);
    };
    return {
        phase(p) {
            sleeping = p === 'asleep';
            if (sleeping) show('z', 0, 'is-zzz');
            else if (el.classList.contains('is-zzz')) { stopZzz(); el.hidden = true; }
        },
        // 窗口隐藏时 z 也停下
        setPaused(paused) {
            if (paused) stopZzz();
            else if (sleeping) show('z', 0, 'is-zzz');
        },
        act(name, ms) { if (LIFE_FX[name]) show(LIFE_FX[name], Math.min(ms, 1800), 'is-pop'); },
        held(on) { if (on) show('💦', 0, 'is-held'); else if (el.classList.contains('is-held')) el.hidden = true; },
    };
}
