// 音乐伴舞的页面接线：复用播放器频谱，不建立第二条引擎连接。
// 预览不订阅；隐藏、免打扰、交互时撤掉伴舞，恢复后等下一份新数据。
import { createMusicGroove } from './musicGroove.js';

export function createPetMusic(ctx, { now = () => performance.now() / 1000 } = {}) {
    const analyzer = createMusicGroove();
    let visible = true;
    let dancing = false;
    let disposed = false;
    function update() {
        if (disposed) return;
        const life = ctx.life;
        const holds = life?.holds || [];
        const supported = typeof ctx.backend?.life?.groove === 'function';
        const allowed = supported && visible && ctx.prefs.musicDance !== false && !ctx.isQuiet()
            && life?.phase === 'awake' && !life?.busy && !ctx.walking
            && !holds.some(reason => ['drag', 'hidden', 'composer'].includes(reason));
        const frame = allowed ? analyzer.snapshot(now()) : null;
        dancing = !!frame?.playing;
        const speaking = ctx.speech?.active() || ctx.frame.state || holds.includes('reply');
        ctx.backend?.life?.groove?.(dancing ? frame : null, speaking ? 0.35 : 1);
        // music hold 不能唤醒已睡着的角色；只在 awake 且真的有音乐时持有。
        life?.hold('music', dancing);
        if (dancing) ctx.backend.setActive(true);
        return dancing;
    }
    const off = ctx.api.onMusicGroove?.(payload => {
        if (disposed || !visible) return;
        analyzer.push(payload?.data, { now: now(), playing: payload?.playing === true, trackKey: payload?.trackKey || '' });
        update();
    });
    const prefsChanged = () => update();
    window.addEventListener('deskpet:prefs', prefsChanged);
    return {
        update,
        get active() { return dancing; },
        visibility(on) {
            visible = on;
            analyzer.reset();
            update();
        },
        dispose() {
            if (disposed) return;
            off?.();
            window.removeEventListener('deskpet:prefs', prefsChanged);
            analyzer.reset();
            ctx.backend?.life?.groove?.(null);
            ctx.life?.hold('music', false);
            disposed = true;
            dancing = false;
        },
    };
}