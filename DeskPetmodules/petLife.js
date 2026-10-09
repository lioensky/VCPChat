// 桌宠闲着时的「生气」：什么时候做什么。
//   醒着：隔一阵做个小动作（东张西望、伸懒腰、歪头、哼歌）；光标不动时视线自己游走。
//   犯困：很久没人理就打哈欠，眼皮发沉、时不时点一下头；再过一会儿睡着。
//   睡着：光标在窗口里晃、单击、拖动、来回复时醒来（被戳醒和被叫醒是惊醒，光标晃醒是慢慢睁眼）；
//        光标在头上来回蹭不会吵醒，只会在梦里笑一下。
//   互动：连点几下会不耐烦，戳个不停会晕；光标在头上来回蹭是摸头；拖起来时慌，放下时落地。
// 这里只决定时机和动作名，不碰 DOM 和渲染；各后端按动作名自己演（见 lifeMotion.js 和 deskpet.js）。
// 时间和随机数都可以注入，测试里用假时钟走完整条时间线。

export const LIFE_TIMINGS = Object.freeze({
    microMinMs: 9000,       // 两个待机小动作之间至少隔这么久
    microMaxMs: 22000,
    gazeIdleMs: 2500,       // 光标停住这么久后视线开始自己游走
    gazeMinMs: 1200,        // 每看一处停留多久
    gazeMaxMs: 3600,
    drowsyAfterMs: 180000,  // 这么久没人理就开始犯困
    sleepAfterMs: 60000,    // 犯困后再过这么久睡着
    nodMinMs: 7000,         // 犯困时点头的间隔
    nodMaxMs: 13000,
    wakeMs: 1600,           // 慢慢醒来的过程
    startleMs: 1000,        // 惊醒
    tapStreakMs: 450,       // 两下之间不超过这么久算连点
    annoyedAt: 3,           // 连点到第几下开始不耐烦
    dizzyAt: 6,             // 连点到第几下晕了
    patStrokeMinPx: 14,     // 光标在头上往一个方向至少走这么远才算一下
    patWindowMs: 1400,      // 这段时间内来回够 patStrokes 下算摸头
    patStrokes: 3,
    patRepeatMs: 900,       // 一直摸着时每隔这么久再反应一次
    wakeTravelPx: 60,       // 睡着时光标在窗口里（不在头上）累计晃这么远才醒
    wakeTravelWindowMs: 1500,
});

// 每个动作演多久（毫秒）；后端按这个长度安排参数曲线或 CSS 动画。
export const ACTION_MS = Object.freeze({
    lookAround: 3200,
    stretch: 2600,
    tilt: 2200,
    hum: 3200,
    yawn: 2800,
    nod: 1800,
    wake: 1600,
    startle: 1000,
    poke: 800,
    headTap: 1200,
    pat: 1400,
    sleepPat: 1600,
    annoyed: 2000,
    dizzy: 2600,
    landed: 700,
    // 回复里的动作（DeskPetmodules/gestures.js）
    agree: 1300,
    disagree: 1300,
    cheer: 1100,
    bow: 1800,
});

// 待机小动作和权重；不连着做同一个。
const MICRO_ACTIONS = [
    ['lookAround', 3],
    ['tilt', 3],
    ['stretch', 2],
    ['hum', 2],
];

// 长期心情（侧栏和桌宠共用的 moodState）怎么影响闲时：
//   pace 小动作间隔的倍数，sleepy 多久犯困的倍数，weights 覆盖各小动作的权重
const MOOD_STYLE = {
    happy: { pace: 0.75, sleepy: 1.2, weights: { hum: 4 } },
    excited: { pace: 0.6, sleepy: 1.5, weights: { hum: 4, lookAround: 4 } },
    affectionate: { pace: 0.85, sleepy: 1, weights: { hum: 3, tilt: 4 } },
    shy: { pace: 1, sleepy: 1, weights: { tilt: 4, hum: 1 } },
    calm: { pace: 1.2, sleepy: 1, weights: { hum: 1 } },
    concerned: { pace: 1.3, sleepy: 1, weights: { lookAround: 4, hum: 0 } },
    sad: { pace: 1.6, sleepy: 0.8, weights: { hum: 0, stretch: 1 } },
    tired: { pace: 1.5, sleepy: 0.5, weights: { hum: 0, stretch: 4 } },
    angry: { pace: 1.3, sleepy: 1.2, weights: { hum: 0, tilt: 1 } },
};

export function createPetLife({
    now = () => Date.now(),
    random = Math.random,
    timings = {},
    onAction = () => {},
    onPhase = () => {},
    onGaze = () => {},
} = {}) {
    const t = { ...LIFE_TIMINGS, ...timings };
    const between = (lo, hi) => lo + random() * (hi - lo);

    let phase = 'awake';           // awake | drowsy | asleep
    let lastInteraction = now();   // 最近一次有人理它（光标在窗口里动、点、拖、说话）
    let drowsySince = 0;
    let nextMicroAt = now() + between(t.microMinMs, t.microMaxMs);
    let nextNodAt = 0;
    let busyUntil = 0;             // 正在演的动作结束前不插新的小动作
    let lastMicro = null;
    let style = null;              // MOOD_STYLE 里当前心情那一项，按强度插值过
    let quiet = false;             // 免打扰：不做引人注意的小动作，只安静地呼吸眨眼、打盹
    const holds = new Set();       // reply / composer / drag / hidden：期间不犯困、不做小动作

    // 视线：光标在动时跟光标（gaze = null），停住后自己游走，困了、睡着时垂下来
    let cursor = null;             // { x, y, at }
    let gaze = null;               // { x, y }，以角色为中心、-1..1
    let nextGazeAt = 0;
    let followCursor = true;       // 关掉时光标动也不跟，只自己四处看

    // 连点、摸头、晃醒
    let tapStreak = 0;
    let lastTapAt = 0;
    let pat = { dir: 0, travel: 0, strokes: [], lastFiredAt: -Infinity };
    let wakeTravel = [];

    function setPhase(next) {
        if (next === phase) return;
        phase = next;
        if (phase === 'drowsy') {
            drowsySince = now();
            nextNodAt = now() + between(t.nodMinMs, t.nodMaxMs);
        }
        onPhase(phase);
        updateGaze(true);
    }

    function act(name) {
        busyUntil = now() + (ACTION_MS[name] || 1000);
        onAction({ name, ms: ACTION_MS[name] || 1000 });
    }

    function setGaze(next) {
        const same = (next === null && gaze === null)
            || (next && gaze && next.x === gaze.x && next.y === gaze.y);
        if (same) return;
        gaze = next;
        onGaze(gaze);
    }

    // force：阶段刚变，马上换视线，不等下一次游走
    function updateGaze(force = false) {
        const at = now();
        if (phase !== 'awake') {
            // 困了低着眼，睡着时垂下头；不跟光标
            setGaze({ x: 0, y: phase === 'asleep' ? -0.6 : -0.35 });
            return;
        }
        const cursorFresh = followCursor && cursor && at - cursor.at < t.gazeIdleMs;
        if (cursorFresh) {
            setGaze(null);
            return;
        }
        if (!force && gaze && at < nextGazeAt) return;
        // 大多数时候看前方附近，偶尔瞟向两边或上方
        const roll = random();
        const x = roll < 0.45 ? between(-0.25, 0.25) : (roll < 0.75 ? -1 : 1) * between(0.45, 0.9);
        const y = between(-0.3, 0.45);
        nextGazeAt = at + between(t.gazeMinMs, t.gazeMaxMs);
        setGaze({ x: round2(x), y: round2(y) });
    }

    // 有人理它：困了就醒，睡着了按方式醒；重新开始计时
    function interact({ startle = false, gentle = false } = {}) {
        lastInteraction = now();
        if (phase === 'asleep') {
            setPhase('awake');
            act(startle ? 'startle' : 'wake');
            nextMicroAt = now() + between(t.microMinMs, t.microMaxMs);
            return 'woke';
        }
        if (phase === 'drowsy') {
            setPhase('awake');
            if (!gentle) act('startle');
            nextMicroAt = now() + between(t.microMinMs, t.microMaxMs);
            return 'perked';
        }
        return null;
    }

    function trackPat(x, y, at) {
        if (pat.last && at - pat.last.at > 300) pat = { ...pat, dir: 0, travel: 0, last: null };
        if (pat.last) {
            const dx = x - pat.last.x;
            const dir = Math.sign(dx);
            if (dir && dir === pat.dir) {
                pat.travel += Math.abs(dx);
            } else if (dir) {
                // 换方向：上一程走够了才算一下
                if (pat.travel >= t.patStrokeMinPx) pat.strokes.push(at);
                pat.dir = dir;
                pat.travel = Math.abs(dx);
            }
        }
        pat.last = { x, y, at };
        pat.strokes = pat.strokes.filter((s) => at - s <= t.patWindowMs);
        if (pat.strokes.length >= t.patStrokes && at - pat.lastFiredAt >= t.patRepeatMs) {
            pat.lastFiredAt = at;
            return true;
        }
        return false;
    }

    return {
        get phase() { return phase; },
        get gaze() { return gaze; },
        get busy() { return now() < busyUntil; },
        get holds() { return [...holds]; },
        get quiet() { return quiet; },

        // 免打扰开着时不自己找事做（被碰到的反应照常）
        setQuiet(on) { quiet = Boolean(on); },

        // 视线跟不跟光标（设置里的开关）
        setFollowCursor(on) {
            const next = on !== false;
            if (next === followCursor) return;
            followCursor = next;
            updateGaze(true);
        },

        // 长期心情 { emotion, intensity }：开心时小动作多、爱哼歌，难过时少动、不哼歌，累了更早犯困
        setMood(mood) {
            const base = MOOD_STYLE[mood?.emotion];
            const k = Math.max(0, Math.min(1, Number(mood?.intensity) || 0));
            if (!base || k < 0.2) { style = null; return; }
            const lerp = (v) => 1 + (v - 1) * k;
            style = { pace: lerp(base.pace), sleepy: lerp(base.sleepy), weights: base.weights };
        },

        // 回复在流、输入框开着、拖动中、窗口隐藏时按住时钟
        hold(reason, on) {
            const had = holds.has(reason);
            if (on) holds.add(reason);
            else holds.delete(reason);
            if (on && !had && reason !== 'hidden') {
                // 有人找它说话或拖它：困了、睡着了都要醒（被拖、来回复都算被吵醒）
                // 免打扰时主窗口那边的回复不该把它吓一跳：慢慢醒
                const quietReply = reason === 'reply' && quiet;
                interact({ startle: reason === 'drag' || (reason === 'reply' && !quiet), gentle: reason === 'composer' || quietReply });
            }
            if (!on && had) {
                lastInteraction = now();
                nextMicroAt = now() + between(t.microMinMs, t.microMaxMs);
            }
        },

        // 光标位置（窗口内坐标）；inside=false 是窗口外的光标（只用来看过去），onHead 由页面按角色的包围盒算
        cursor({ x, y, inside = true, onHead = false }) {
            const at = now();
            const moved = !cursor || Math.hypot(x - cursor.x, y - cursor.y) >= 2;
            if (!moved) return null;
            const prev = cursor;
            cursor = { x, y, at, inside };
            if (!inside) {
                if (phase === 'awake') updateGaze();
                return null;
            }
            const patted = onHead && trackPat(x, y, at);
            if (!onHead) pat = { dir: 0, travel: 0, strokes: [], lastFiredAt: pat.lastFiredAt };
            if (phase === 'asleep') {
                if (patted) {
                    act('sleepPat');
                    return 'sleepPat';
                }
                if (onHead) return null;
                // 光标在窗口里晃够一段距离才醒，路过一下不算
                // 只算窗口里连着的移动：刚从窗外进来、隔了很久才再动的那一跳不算
                if (prev?.inside && at - prev.at <= 250) wakeTravel.push({ d: Math.hypot(x - prev.x, y - prev.y), at });
                wakeTravel = wakeTravel.filter((w) => at - w.at <= t.wakeTravelWindowMs);
                const travel = wakeTravel.reduce((sum, w) => sum + w.d, 0);
                if (travel < t.wakeTravelPx) return null;
                wakeTravel = [];
                return interact();
            }
            const woke = interact({ gentle: true });
            if (phase === 'awake') updateGaze();
            if (patted) {
                act('pat');
                return 'pat';
            }
            return woke;
        },

        // 每次按下又松开（没拖动）都报一下，用来数连点；返回连点到第几下
        tapDown() {
            const at = now();
            tapStreak = at - lastTapAt <= t.tapStreakMs ? tapStreak + 1 : 1;
            lastTapAt = at;
            lastInteraction = at;
            if (phase !== 'awake') return tapStreak;
            // 还在戳就继续晕（每多三下晕一次），连点没断之前双击也不再打开输入框
            if (tapStreak === t.annoyedAt) act('annoyed');
            else if (tapStreak >= t.dizzyAt && (tapStreak - t.dizzyAt) % 3 === 0) act('dizzy');
            return tapStreak;
        },

        // 单击（已经排除了双击）；返回实际演的动作名，null 表示这下被连点反应盖过去了
        tap({ onHead = false } = {}) {
            const woke = interact({ startle: true });
            if (woke) return 'startle';
            // 连点反应正在演，不再插一个开心
            if (tapStreak >= t.annoyedAt || (now() < busyUntil && tapStreak > 1)) return null;
            const name = onHead ? 'headTap' : 'poke';
            act(name);
            return name;
        },

        // 有事要说（主动发言、闹钟）：睡着就惊醒
        wake({ startle = false } = {}) {
            return interact({ startle, gentle: !startle });
        },

        dragEnd() {
            act('landed');
        },

        tick() {
            const at = now();
            if (holds.has('hidden')) return;
            const held = holds.size > 0;
            if (held) {
                lastInteraction = at;
            }
            if (phase === 'awake') {
                updateGaze();
                if (!held && at - lastInteraction >= t.drowsyAfterMs * (style?.sleepy || 1)) {
                    setPhase('drowsy');
                    if (!quiet) act('yawn');
                    return;
                }
                if (!held && !quiet && at >= nextMicroAt && at >= busyUntil) {
                    const name = pickMicro();
                    lastMicro = name;
                    act(name);
                    nextMicroAt = at + between(t.microMinMs, t.microMaxMs) * (style?.pace || 1);
                }
                return;
            }
            if (phase === 'drowsy') {
                if (at - drowsySince >= t.sleepAfterMs) {
                    setPhase('asleep');
                    return;
                }
                if (!quiet && at >= nextNodAt && at >= busyUntil) {
                    act(random() < 0.3 ? 'yawn' : 'nod');
                    nextNodAt = at + between(t.nodMinMs, t.nodMaxMs);
                }
            }
        },

        // 调试和录屏用：直接演某个动作
        perform(name) {
            if (ACTION_MS[name]) act(name);
        },

        // 调试和录屏用：直接跳到某个阶段
        force(next) {
            if (next === 'awake') interact({ gentle: true });
            else if (next === 'drowsy') { setPhase('drowsy'); act('yawn'); }
            else if (next === 'asleep') setPhase('asleep');
        },
    };

    function pickMicro() {
        const pool = MICRO_ACTIONS
            .map(([name, w]) => [name, style?.weights[name] ?? w])
            .filter(([name, w]) => name !== lastMicro && w > 0);
        const total = pool.reduce((sum, [, w]) => sum + w, 0);
        let roll = random() * total;
        for (const [name, w] of pool) {
            roll -= w;
            if (roll < 0) return name;
        }
        return pool[pool.length - 1][0];
    }
}

function round2(v) {
    return Math.round(v * 100) / 100;
}
