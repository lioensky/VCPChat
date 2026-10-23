// 光标在不在角色上（各个后端读完像素报到这里）、界面和角色的包围盒，
// 以及拖动、点击、双击带来的反应（指针生命周期本身在 pointerGestures.js）。
// 贴边藏起来时主进程按这里报的「想探出来」决定探不探头。
import { dockHitArea, containsPoint } from 'vcp-deskpet://pet/app/dockHitArea.js';
import { createCursorHitGate } from 'vcp-deskpet://pet/app/dockVisibility.js';
import { bindPointer } from 'vcp-deskpet://pet/app/pointerGestures.js';

const DOUBLE_TAP_MS = 300;     // 这么短内的第二下算双击；单击的反应等这段时间过了再做
const DOCK_BOTTOM = 6;         // 小胶囊离窗口底边（与 #dock 的 bottom 一致）
const LIFE_ANNOYED_AT = 3;     // 与 petLife 的 annoyedAt 一致：连点到这一下就不再打开输入框

export function createPetHit(ctx) {
    const { api, $ } = ctx;
    const cursorHit = createCursorHitGate();

    // 角色在窗口里的包围盒（贴边用）；后端还没起来时没有
    // 往下算到小胶囊的底：贴任务栏时是胶囊落在任务栏上，悬停冒出来的胶囊不会被任务栏挡住
    function figureBounds() {
        try {
            const b = window.__deskPetBounds?.();
            if (!b) return null;
            return { ...b, height: Math.max(b.height, window.innerHeight - DOCK_BOTTOM - b.y) };
        } catch {
            return null;
        }
    }

    // 放下时：光标还压在角色上是拖动留下的，不当成「鼠标停在上面」；探头状态重新报一次
    function afterDrag() {
        hitFromDrag = true;
        lastWantOut = null;
    }

    // ---- 命中：光标在不在角色上 --------------------------------------------------------

    let lastHit = false;
    // null：下一次一定报上去（页面刚加载、刚拖完放下时，主进程那边的探头状态可能和这里对不上）
    let lastWantOut = null;
    // 拖动时光标一直压在角色上；放下（可能刚收进边里）后在光标真正移开或移上来之前，不算「鼠标在角色上」，
    // 免得刚藏进去就又探出来，也免得一直报着拖动时的旧值、该探头时不探
    let hitFromDrag = false;
    function reportHit(hit) {
        hit = cursorHit.resolve(hit);
        // 只看不点：鼠标穿过去，悬停胶囊也不冒；光标压在角色上时角色变得很淡，看得清后面的东西
        document.body.classList.toggle('is-ghost-hover', Boolean(ctx.prefs.clickThrough && hit));
        if (ctx.prefs.clickThrough) hit = false;
        if (hit !== lastHit) {
            lastHit = hit;
            hitFromDrag = false;
            api.setHit(hit);
        }
        ctx.dockHover(hit);
    }

    // 收起后主进程回到穿透：下一次命中不管和上次一样不一样都要报上去
    function forgetHit() {
        lastHit = null;
    }

    // 藏在屏幕边里时，主进程按这个决定探不探出来：鼠标在角色上，或者头顶有气泡、输入框
    function wantsOut(ui) {
        const wantOut = (lastHit && !hitFromDrag) || Boolean(ui);
        if (wantOut === lastWantOut) return;
        lastWantOut = wantOut;
        api.wantOut?.(wantOut);
    }

    // 气泡、输入框这些界面元素也要能点到（按像素穿透只看角色本身）。
    function uiAt(x, y) {
        if (!$('dock').hidden && (ctx.dock.mode === 'hidden' || ctx.dock.mode === 'pill')
            && containsPoint(dockHitArea(innerWidth, innerHeight, { collapsed: ctx.dock.mode === 'hidden', sessions: $('dock').dataset.sessions !== 'false' }), x, y)) return true;
        return Boolean(document.elementFromPoint(x, y)?.closest('.pet-ui'));
    }

    function union(a, b) {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
    }

    // 正在显示的气泡、输入条这些；withIdleDock：连收起时脚边那道小横条也算上
    // （只给 Linux 的窗口形状用，不算就画不出来；闲逛、贴边探头只看真正打开的界面）
    // withBadge：头边那个「没看到的回复」小气泡算不算（溜达不看它，不然它挂着就永远不走）
    function uiBounds({ withIdleDock = false, withBadge = true } = {}) {
        let rect = null;
        for (const el of document.querySelectorAll('.pet-ui')) {
            if (el.hidden || (el.dataset.mode === 'hidden' && !withIdleDock)) continue;
            if (el.id === 'dock' && ctx.dock.mode === 'pill' && !withIdleDock) continue;
            if (!withBadge && el.id === 'missedBadge') continue;
            const visual = el.getBoundingClientRect();
            const r = el.id === 'dock' && withIdleDock && (ctx.dock.mode === 'hidden' || ctx.dock.mode === 'pill')
                ? union(dockHitArea(innerWidth, innerHeight, { collapsed: ctx.dock.mode === 'hidden', sessions: $('dock').dataset.sessions !== 'false' }), visual) : visual;
            if (!r.width || !r.height) continue;
            rect = rect ? union(rect, r) : { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return rect;
    }

    // 头那一块（摸头、点头用）：从头顶往下大约一个头高、头宽以内。
    // 量不出头时退回包围盒上方四分之一、中间六成宽。
    function onHead(x, y) {
        const backend = ctx.backend;
        const zone = backend.zone?.(x, y);
        if (zone !== undefined) return zone === 'head';
        const h = backend.head?.();
        if (h) return y >= h.y && y <= h.y + h.width * 0.9 && Math.abs(x - h.x) <= h.width / 2;
        const b = backend.bounds();
        if (!b) return false;
        return y >= b.y && y <= b.y + b.height * 0.25 && Math.abs(x - (b.x + b.width / 2)) <= b.width * 0.3;
    }

    // 主进程轮询到的光标位置（Linux 上页面自己收指针，见下）
    function bindCursor() {
        // Linux 上主进程不轮询光标（窗口输入区按内容裁过，指针直接进页面）：用页面自己收到的指针判断停在哪
        if (/Linux/.test(navigator.platform)) {
            window.addEventListener('pointermove', (e) => {
                if (e.buttons) return;
                const ui = uiAt(e.clientX, e.clientY);
                cursorHit.cursor({ outside: false, ui });
                if (ui) reportHit(true);
                else ctx.backend.probe(e.clientX, e.clientY);
            });
            document.documentElement.addEventListener('pointerleave', () => { cursorHit.cursor({ outside: true }); reportHit(false); });
        }
        api.onCursor(({ x, y, outside }) => {
            const ui = !outside && uiAt(x, y);
            cursorHit.cursor({ outside, ui });
            if (!outside) {
                if (ui) reportHit(true);
                else ctx.backend.probe(x, y);
            } else reportHit(false); // 出了窗口也算离开：下次直接落在角色身上时胶囊照样冒出来
            ctx.life.cursor({ x, y, inside: !outside, onHead: !outside && onHead(x, y) });
            // 光标停着时视线归 petLife 管（游走、犯困低头），动起来再跟光标
            if (!ctx.life.gaze && ctx.prefs.followCursor !== false) ctx.backend.focus(x, y);
        });
    }

    // ---- 拖动、点击、双击 -------------------------------------------------------------

    function bindTaps() {
        let streak = 0;
        let drag = null;
        const bindings = bindPointer({
            api, afterDrag, figureBounds, doubleTapMs: DOUBLE_TAP_MS, onActivity: () => { ctx.lastActivity = Date.now(); },
            onTap: (at) => {
                // 正在念的时候点一下：别念了
                if (ctx.speech.active() || ctx.speech.speaking()) {
                    ctx.speech.stop();
                    return;
                }
                ctx.life.tap({ onHead: onHead(at.x, at.y) });
            },
            onTapDown: () => {
                streak = ctx.life.tapDown();
                // 连点时第二下打开的输入框没写东西就收回去，别让它跟着一开一关
                if (streak >= LIFE_ANNOYED_AT && ctx.composer.open && !$('composerInput').value.trim()) ctx.closeComposer();
            },
            // 连点没断时双击不打开；停了一下再双击（比如第一次双击慢了，马上补一次）照常打开
            onDoubleTap: ({ afterPause } = {}) => { if (streak < LIFE_ANNOYED_AT || afterPause) ctx.openComposer(); },
            onDrag: (kind, e) => {
                if (kind === 'start') {
                    drag = { x: e.screenX, at: performance.now(), vx: 0 };
                    ctx.dock.dragging = true;
                    ctx.dockVisibility.update({ dragging: true });
                    ctx.life.hold('drag', true);
                    ctx.backend.life?.held(true);
                    ctx.lifeFx.held(true);
                } else if (kind === 'move' && drag) {
                    const at = performance.now();
                    const dt = Math.max(1, at - drag.at);
                    // 速度做个平滑，免得一顿一顿地甩
                    drag.vx = drag.vx * 0.7 + (((e.screenX - drag.x) / dt) * 1000) * 0.3;
                    drag.x = e.screenX;
                    drag.at = at;
                    ctx.backend.life?.dragVelocity(drag.vx);
                } else if (kind === 'end' && drag) {
                    drag = null;
                    ctx.dock.dragging = false;
                    ctx.dock.hover = false;
                    ctx.dockVisibility.update({ dragging: false, hover: false });
                    ctx.backend.life?.held(false);
                    ctx.lifeFx.held(false);
                    ctx.life.hold('drag', false);
                    ctx.life.dragEnd();
                }
            },
        });
        // 甩出去落到任务栏上：再演一次落地
        api.onLanded?.(() => ctx.life.perform('landed'));
        return bindings;
    }

    return { cursorHit, figureBounds, afterDrag, reportHit, forgetHit, wantsOut, uiAt, union, uiBounds, onHead, bindCursor, bindTaps };
}
