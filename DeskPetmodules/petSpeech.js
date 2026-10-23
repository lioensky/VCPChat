// 桌宠出声的接线：回复按句交给 TTS，气泡和表情跟着念到的那一句走（朗读本体在 voice.js）。
// 嘴型也从这里来：有朗读时跟着声音，没有朗读时回复流出来的那段假装在说。
import { createSpeech } from 'vcp-deskpet://pet/app/voice.js';
import { PROACTIVE_HOLD_MS } from 'vcp-deskpet://pet/app/petBubble.js';

export function createPetSpeech(ctx) {
    const { api } = ctx;
    const speech = createSpeech({
        api,
        onChange: () => {
            // 念着的时候不打哈欠、不睡着
            ctx.life?.hold('speak', speech.active());
            ctx.renderBubble();
            // 回复早就结束、刚念完：现在才开始算气泡停留时间
            // 闹钟、新话题按它们自己的停留时间算（念完不能把 60 秒的闹钟缩成几秒）
            const bubble = ctx.bubble;
            if (!bubble.replyId && !speech.active() && bubble.reply) {
                ctx.scheduleReplyHide(Math.max(ctx.replyHoldMs(), PROACTIVE_HOLD_MS[bubble.proactive?.kind] || 0));
            }
        },
        onFrame: (next) => ctx.applyFrame(next),
        onRelease: () => { if (ctx.director) ctx.applyFrame(ctx.director.frame); },
        onLevel: (open) => {
            document.body.style.setProperty('--voice', open.toFixed(3));
            ctx.backend?.setMouth?.(open);
            if (open) ctx.lastActivity = ctx.bubble.heardAt = Date.now();
        },
        onError: (error) => console.warn('[DeskPet] 播放朗读音频失败：', error?.message || error),
    });

    // 说话时嘴张多大：朗读时跟着声音走；没有朗读时，回复流出来的那段时间假装在说（fake 给出假口型）。
    function talkLevel(fake) {
        const voiced = speech.mouth();
        if (voiced != null) return voiced;
        return ctx.bubble.replyId && !ctx.frame.state ? fake() : 0;
    }

    return { speech, talkLevel };
}
