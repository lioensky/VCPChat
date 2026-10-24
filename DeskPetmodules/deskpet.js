// VCPChat 桌宠页面。
//   形象：Live2D（agent 的 deskpet/ 里有 .model3.json，且用户放了 5.x 的 Cubism Core）
//        → 网格立绘（deskpet/ 里有 .puppet.json，一张图切块做的可动角色，不需要 Core）
//        → 差分立绘（portrait.<情绪>.png，与侧栏首页立绘同一套约定）→ 头像加情绪色环。
//   表情：主进程把这个 agent 的回复流原样转过来，交给与侧栏立绘共用的情绪导演
//        （modules/emotion），导演给出 { state, emotion, intensity } 帧。
//   对话：光标停在角色上时脚边冒出小胶囊（打字 / 说话），双击角色或右键「和 TA 说话」直接展开输入条；
//        话经主窗口按正常流程发送，回复显示在气泡里。说话用本地 SenseVoice 识别成文字放进输入条。
//   预览：?preview=1 时只画角色，量好位置报给主进程截图（设置页卡片用），不接回复流、不出声。
// 这个文件只是入口：把下面几部分接在一起，各部分自己管自己的那一块——
//   petBubble.js（气泡、提示、没看到的回复、主动说话）、petSpeech.js（出声和嘴型）、
//   petComposer.js（小胶囊和输入条、录音）、petFiles.js（拖进来、粘贴进来的文件）、
//   petStream.js（回复流接到导演、持续心情）、petApprovals.js（工具审批卡片）、
//   petHit.js（命中、包围盒、拖动和点击）、petWander.js（溜达）、petPrefs.js（设置）、
//   petReactions.js（闲时小动作和互动反应）、petBackendPick.js（挑形象后端、预览快照）。
import { createEmotionDirector } from 'vcp-deskpet://pet/emotion/emotionDirector.js';
import { TOP_RESERVE } from 'vcp-deskpet://pet/app/petStage.js';
import { createSessionCard } from 'vcp-deskpet://pet/app/sessionCard.js';
import { createPetBubble, REPLY_HOLD_AFTER_HOVER_MS } from 'vcp-deskpet://pet/app/petBubble.js';
import { createPetSpeech } from 'vcp-deskpet://pet/app/petSpeech.js';
import { createPetPrefs } from 'vcp-deskpet://pet/app/petPrefs.js';
import { createPetComposer } from 'vcp-deskpet://pet/app/petComposer.js';
import { createPetFiles } from 'vcp-deskpet://pet/app/petFiles.js';
import { createPetHit } from 'vcp-deskpet://pet/app/petHit.js';
import { createPetStream } from 'vcp-deskpet://pet/app/petStream.js';
import { createPetApprovals } from 'vcp-deskpet://pet/app/petApprovals.js';
import { createPetWander } from 'vcp-deskpet://pet/app/petWander.js';
import { createPetReactions } from 'vcp-deskpet://pet/app/petReactions.js';
import { createPetBackendPick } from 'vcp-deskpet://pet/app/petBackendPick.js';

const api = window.deskPetAPI;
const PREVIEW = new URLSearchParams(location.search).has('preview');
// 有回复、刚被碰过时形象按 active 档帧率画，空闲这么久降到 idle，睡着了再降到 sleep（档位在 petStage.js）
const IDLE_AFTER_MS = 30000;

const $ = (id) => document.getElementById(id);

// 各部分共用的东西都挂在这上面：会变的状态（当前帧、形象后端、设置、在不在溜达）和互相要调的函数。
// 每个 createPetXxx 把自己那几个函数拼进来，用到别人的时候临时从 ctx 上读，省得到处加全局变量。
const ctx = {
    api, PREVIEW, $,
    backend: null,          // 形象后端（Live2D / 网格立绘 / 精灵 / 立绘头像），启动时挑
    director: null,         // 情绪导演（modules/emotion）
    proactiveDirector: null, // 主动说话用的导演：接好以后就是 director
    life: null,             // petLife：闲时小动作、困了睡、被吵醒、连点和摸头
    lifeFx: null,           // 头顶的小符号
    pointerBindings: null,
    frame: { state: null, emotion: 'neutral', intensity: 0, source: 'idle' },
    lastActivity: Date.now(),
    walking: null,          // 'left' | 'right' | null，正在往哪边溜达
    // 主进程给的设置：大小、免打扰。别的模块（声音、待机反应）读 window.deskPetPrefs 或听 'deskpet:prefs' 事件。
    prefs: { scale: 1, doNotDisturb: false, clickThrough: false },
};
Object.assign(ctx, createPetBubble(ctx));
Object.assign(ctx, createPetSpeech(ctx));
Object.assign(ctx, createPetPrefs(ctx));
Object.assign(ctx, createPetComposer(ctx));
Object.assign(ctx, createPetFiles(ctx));
Object.assign(ctx, createPetHit(ctx));
Object.assign(ctx, createPetStream(ctx));
Object.assign(ctx, createPetApprovals(ctx));
Object.assign(ctx, createPetWander(ctx));
Object.assign(ctx, createPetReactions(ctx));
Object.assign(ctx, createPetBackendPick(ctx));

// ---- 启动 --------------------------------------------------------------------

async function start() {
    const sessionCard = PREVIEW ? null : createSessionCard({
        card: $('sessionCard'), panel: $('sessionPanel'), toggle: $('dockHide'), divider: $('sessionDivider'), badge: $('sessionCount'),
        navigation: $('sessionNavigation'), position: $('sessionPosition'), previous: $('sessionPrevious'), next: $('sessionNext'),
        stop: $('sessionStop'),
        title: $('sessionTitle'), status: $('sessionStatus'), api,
        onToggle: expanded => { ctx.dockVisibility.update({ pinned: expanded }); ctx.renderBubble(); ctx.reaimBubble(); },
        onNotifications: (count, available) => {
            if ($('dock').dataset.sessions !== String(available)) $('dock').dataset.sessions = String(available);
            const pending = String(count > 0);
            if ($('dock').dataset.notifications !== pending) $('dock').dataset.notifications = pending;
            const label = count ? `展开桌宠操作，${count} 个会话有动态` : '展开桌宠操作';
            if ($('dockReveal').title !== label) {
                $('dockReveal').title = label;
                $('dockReveal').setAttribute('aria-label', label);
            }
        },
    });
    const assets = await api.getAssets();
    if (!assets) return;
    sessionCard?.initialize(assets);
    if (!PREVIEW) $('dock').dataset.mode = ctx.dock.mode;
    ctx.syncDockLayers();
    $('dockReveal').addEventListener('click', () => ctx.setDock('pill'));
    $('dock').addEventListener('focusin', () => ctx.dockHover(true));
    window.addEventListener('pagehide', () => {
        for (const dispose of [() => ctx.pointerBindings?.dispose(), () => ctx.dockVisibility.dispose(), () => sessionCard?.dispose(),
            () => ctx.director?.dispose(), () => ctx.dock.voice?.cancel(), () => ctx.speech.dispose(), () => ctx.backend?.destroy?.()]) {
            try { dispose(); } catch (error) { console.warn('[DeskPet] 清理页面资源失败：', error); }
        }
        ctx.disposeBubble();
    }, { once: true });
    ctx.applyPrefs(await api.getPrefs?.().catch(() => null));
    api.onPrefs?.(ctx.applyPrefs);
    ctx.bindWalk();
    document.title = `${assets.name} · 桌宠`;
    ctx.setPetName(assets.name);

    await ctx.pickBackend(assets);
    if (PREVIEW) {
        await ctx.renderPreview(assets);
        return;
    }
    const backend = ctx.backend;

    // 朗读时表情跟着念到的句子换（见 speech），导演的新帧先不上脸
    ctx.director = createEmotionDirector({ onFrame: (next) => { if (!ctx.speech.holdsFrames()) ctx.applyFrame(next); } });
    ctx.startReactions();
    const life = ctx.life;
    ctx.bindStream();
    api.onPlayTtsAudio?.((payload) => ctx.speech.play(payload));
    // 别的窗口开始朗读、在菜单里关了朗读：这条不念了，字全部显示出来
    api.onStopTtsAudio?.(() => ctx.speech.stop());
    ctx.bindMood(assets.agentId);
    ctx.proactiveDirector = ctx.director;
    api.onProactive?.(ctx.speakProactive);
    api.onTopicMissing?.(() => {
        if (ctx.bubble.proactive?.kind === 'topic') {
            ctx.bubble.reply = '';
            ctx.bubble.proactive = null;
        }
        ctx.notice('这个话题已经不在了（可能被删掉了）', { ms: 4000 });
    });
    ctx.bindBubble();
    ctx.bindComposer();
    ctx.bindApprovals();
    ctx.bindFileDrop();
    ctx.bindCursor();
    ctx.pointerBindings = ctx.bindTaps();
    // 窗口隐藏时停掉渲染和呼吸动画，显示回来再继续。
    let paused = false;
    api.onVisibility?.((visible) => {
        paused = !visible;
        if (paused) { ctx.cursorHit.cursor({ outside: true }); ctx.reportHit(false); }
        ctx.dockVisibility.update({ visible });
        // 藏起来就不出声了，录着的音也停掉（不然麦克风开着、整窗挡着点击）
        if (paused) {
            ctx.speech.stop();
            if ((ctx.dock.mode === 'rec' && !ctx.transcribing()) || (ctx.composer.open && !ctx.hasDraft())) ctx.closeComposer();
        }
        // 光标停在气泡上时被藏起来收不到 mouseleave：别让旧回复从此一直挂着
        if (ctx.bubble.hovered) {
            ctx.bubble.hovered = false;
            if (!paused && ctx.bubble.reply && !ctx.bubble.replyId) ctx.scheduleReplyHide(REPLY_HOLD_AFTER_HOVER_MS);
        }
        document.body.classList.toggle('is-paused', paused);
        backend.setPaused(paused);
        ctx.lifeFx.setPaused(paused);
        life.hold('hidden', paused);
        if (!paused) ctx.lastActivity = Date.now();
    });
    // 定期看一眼角色占在哪里：气泡和输入框贴在头顶上方（小头像、矮立绘不会离得老远）；
    // Linux 用输入区代替整窗穿透（见主进程注释），把角色和界面的包围盒报上去。
    let headY = null; // 第一次量到头就摆上去，之后差得多才挪
    let headX = null;
    let headWidth = null;
    // 气泡、角标、小符号都跟着头走：全身像的头在窗口上部，Q 版的大头矮矮的在中间，头歪在一边时气泡也挪过去
    const followHead = () => {
        const h = backend.head?.();
        const b = h ? null : backend.bounds();
        const head = h || (b && { x: b.x + b.width / 2, y: b.y, width: b.width * 0.5 });
        if (!head) return;
        const root = document.documentElement.style;
        // 动作会让头顶上下晃，差得不多就不挪，免得气泡跟着抖
        const y = Math.round(Math.max(TOP_RESERVE, Math.min(window.innerHeight - 40, head.y)));
        if (headY === null || Math.abs(y - headY) > 16) {
            headY = y;
            root.setProperty('--pet-head', `${y}px`);
        }
        const x = Math.round(Math.max(0, Math.min(window.innerWidth, head.x)));
        const w = Math.round(Math.max(24, Math.min(window.innerWidth, head.width)));
        if (headX === null || Math.abs(x - headX) > 8 || Math.abs(w - headWidth) > 8) {
            headX = x;
            headWidth = w;
            root.setProperty('--pet-head-x', `${x}px`);
            root.setProperty('--pet-head-w', `${w}px`);
        }
        ctx.aimBubble(headX);
    };
    const activityTimer = setInterval(() => {
        if (paused) return;
        followHead();
        const b = backend.bounds();
        const ui = ctx.uiBounds();
        const drawn = ctx.uiBounds({ withIdleDock: true });
        const rect = b && drawn ? ctx.union(b, drawn) : (b || drawn);
        if (rect) api.setContentBounds({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height });
        ctx.wantsOut(ui);
        life.setMood(ctx.director.baseline);
        life.tick();
        ctx.wanderTick(ctx.uiBounds({ withBadge: false }));
        if (Date.now() - ctx.lastActivity > IDLE_AFTER_MS && !ctx.frame.state) backend.setActive(life.phase === 'asleep' ? 'sleep' : 'idle');
    }, 250);
    window.addEventListener('pagehide', () => clearInterval(activityTimer), { once: true });

    ctx.applyFrame(ctx.director.frame);
    document.body.dataset.lifePhase = life.phase;
    backend.life?.phase(life.phase);
    // 设置里的「动作速度」：只有精灵形象（Codex 宠物）按帧播放，有 setSpeed
    const syncSpeed = () => backend.setSpeed?.(ctx.prefs.animationSpeed || 'normal');
    syncSpeed();
    window.addEventListener('deskpet:prefs', syncSpeed);
    window.__deskPetReady = { backend: backend.kind, info: backend.info || null };
    // 调试和录屏：__deskPetLife.force('asleep') 直接睡着，__deskPetLife.perform('yawn') 演一个动作
    window.__deskPetLife = life;
    window.__deskPetBounds = () => backend.bounds();
    window.__deskPetHead = () => backend.head?.() || null;
    // 量出形象的长宽比后告诉主进程，窗口按比例改（全身像高、Q 版矮），脚底不动
    Promise.resolve(backend.figureReady).then((aspect) => {
        window.__deskPetFigure = { outfit: assets.outfit?.id || null, aspect };
        if (aspect && assets.outfit) api.reportFigure?.({ outfit: assets.outfit.id, aspect });
        followHead();
    }).catch(() => {});
    console.log('[DeskPet] ready', JSON.stringify(window.__deskPetReady));
    api.pageReady?.();
}

start().catch((error) => {
    console.error('[DeskPet] 启动失败', error);
    // 告诉主进程别再等这个页面了：等着交给桌宠的话按失败退回去
    api.pageFailed?.(String(error?.message || error));
    ctx.notice(`桌宠启动失败：${error.message}`, { error: true, ms: 60000 });
});
