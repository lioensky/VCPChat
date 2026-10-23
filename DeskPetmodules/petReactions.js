// 被碰到的反应和闲时的小动作：时机归 petLife.js，头顶小符号归 lifeFx.js，
// 这里只管把阶段、动作接到形象后端上，并在互动时临时换个表情（演完换回当前情绪）。
// 设置页「表情映射」改完也从这里当场演一下。
import { createPetLife } from 'vcp-deskpet://pet/app/petLife.js';
import { createLifeFx } from 'vcp-deskpet://pet/app/lifeFx.js';

// 被碰到才有的反应：回到高帧率；其余闲时小动作按当前帧率演
const USER_REACTIONS = new Set(['poke', 'headTap', 'pat', 'annoyed', 'dizzy', 'startle', 'wake', 'landed']);
// 反应期间临时换的情绪（立绘换差分、Live2D 换表情），演完换回来
const REACTION_EMOTION = { headTap: 'shy', pat: 'affectionate', annoyed: 'angry', dizzy: 'surprised', startle: 'surprised' };

export function createPetReactions(ctx) {
    const { api } = ctx;

    // 建好 lifeFx 和 petLife，接上设置页的表情映射；ctx.lifeFx、ctx.life 从这里起有值
    function startReactions() {
        const lifeFx = createLifeFx();
        ctx.lifeFx = lifeFx;
        let flashTimer = 0;
        let tapTimer = 0;
        // 互动反应时临时换个表情（不改导演的心情，演完换回来）
        window.addEventListener('pagehide', () => { clearTimeout(flashTimer); clearTimeout(tapTimer); lifeFx.dispose(); }, { once: true });
        const flashEmotion = (emotion, ms) => {
            // 立绘没画这个情绪就不换，免得退回默认立绘闪一下
            if (ctx.backend.canShow && !ctx.backend.canShow(emotion)) return;
            clearTimeout(flashTimer);
            clearTimeout(tapTimer);
            ctx.backend.apply({ ...ctx.frame, emotion, intensity: 0.8 }, { changed: true });
            flashTimer = setTimeout(() => ctx.backend.apply(ctx.shownFrame(ctx.frame), { changed: true, motion: false }), ms);
        };
        // 点头、点身体绑定的表情演一会儿（至少 2 秒，点身体的反应本身很短）再换回当前情绪
        const playTap = (zone, ms) => {
            const bound = ctx.backend.playTap?.(zone);
            if (bound?.expression) {
                clearTimeout(flashTimer);
                clearTimeout(tapTimer);
                tapTimer = setTimeout(() => ctx.backend.apply(ctx.shownFrame(ctx.frame), { changed: true, motion: false }), Math.max(ms, 2000));
            }
            return bound || null;
        };
        // 设置页「表情映射」：换上新映射；emotion 给了就当场演一下这个情绪，tap 给了就演一下点这个区域
        api.onProfile?.(({ profile, emotion, tap } = {}) => {
            ctx.backend.setProfile?.(profile);
            if (tap) {
                if (!playTap(tap, 3500)) {
                    // 这个区域没绑：演默认反应给你看
                    if (tap === 'head') flashEmotion(REACTION_EMOTION.headTap, 3500);
                    else ctx.backend.tap();
                }
            } else if (emotion) flashEmotion(emotion, 3500);
            else ctx.backend.apply(ctx.shownFrame(ctx.frame), { changed: true, motion: false });
        });
        ctx.life = createPetLife({
            onPhase(phase) {
                document.body.dataset.lifePhase = phase;
                ctx.backend.life?.phase(phase);
                lifeFx.phase(phase);
                ctx.backend.apply(ctx.shownFrame(ctx.frame), { changed: true, motion: false });
                if (phase === 'asleep' && !ctx.frame.state) ctx.backend.setActive('sleep');
            },
            onAction({ name, ms }) {
                ctx.backend.life?.act(name, ms);
                if (!ctx.life.quiet || USER_REACTIONS.has(name)) lifeFx.act(name, ms);
                if (USER_REACTIONS.has(name)) {
                    // 被碰到的反应要流畅：回到高帧率
                    ctx.lastActivity = Date.now();
                    ctx.backend.setActive(true);
                }
                // 点头、点身体：绑了的部分照绑定演，没绑的部分照原来的反应
                const bound = name === 'poke' ? playTap('body', ms) : name === 'headTap' ? playTap('head', ms) : null;
                if (name === 'poke') {
                    if (!bound?.motion) ctx.backend.tap();
                    if (!bound?.expression) ctx.director.nudge({ emotion: 'happy', intensity: 0.6, source: 'tap' });
                } else if (REACTION_EMOTION[name] && !ctx.frame.state && !bound?.expression) {
                    flashEmotion(REACTION_EMOTION[name], ms);
                }
            },
            onGaze(g) { if (g) ctx.backend.life?.gaze(g); },
        });
        // 免打扰（桌宠设置里开）：不自己做小动作、不冒小符号
        const syncQuiet = () => {
            ctx.life.setQuiet(ctx.isQuiet());
            ctx.life.setFollowCursor(ctx.prefs.followCursor !== false);
        };
        syncQuiet();
        window.addEventListener('deskpet:prefs', syncQuiet);
    }

    return { startReactions };
}
