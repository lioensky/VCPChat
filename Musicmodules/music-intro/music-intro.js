// 音乐窗口过场动画：开场（首次/手动重放是完整版，平时是短版）和进出舞台的过场。
// 圆环和文字画在临时 SVG 上，过场结束时移除整层；开场可以按键或点击跳过。
// 时间轴按秒写，离散的「剪辑点」按 25 帧对齐，和参考分镜的节奏一致。
(function (global) {
    'use strict';

    const SEEN_KEY = 'musicIntroFullSeen';
    const NS = 'http://www.w3.org/2000/svg';
    const W = 1000, H = 600, CX = 500, CY = 300;

    // ---------- 时间工具 ----------
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const progress = (t, a, b) => clamp01((t - a) / (b - a));
    const smooth = (p) => p * p * (3 - 2 * p);
    const easeOut = (p) => 1 - Math.pow(1 - p, 3);
    const frameOf = (t) => Math.floor(t * 25 + 1e-6);
    // 分段线性关键帧，段内再做 smoothstep，速度在关键帧处不突变太多即可。
    const keys = (list, t) => {
        if (t <= list[0][0]) return list[0][1];
        for (let i = 0; i < list.length - 1; i++) {
            const [t0, v0] = list[i], [t1, v1] = list[i + 1];
            if (t <= t1) return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
        }
        return list[list.length - 1][1];
    };
    // 打字：不是匀速，按字符给一点固定的快慢，像真人敲出来的。
    const typed = (text, t, a, b) => {
        if (t < a || !text) return '';
        const p = clamp01((t - a) / (b - a));
        const jitter = p < 1 ? 0.07 * Math.sin(p * 23.7) + 0.04 * Math.sin(p * 61.3) : 0;
        return text.slice(0, Math.max(1, Math.min(text.length, Math.ceil(clamp01(p + jitter) * text.length))));
    };
    const arc = (r, start, sweep, x = CX, y = CY) => {
        if (r <= 0 || sweep <= 0) return '';
        const pt = (a) => `${(x + Math.cos(a) * r).toFixed(2)},${(y + Math.sin(a) * r).toFixed(2)}`;
        if (sweep >= Math.PI * 1.999) return `M${pt(start)}A${r},${r} 0 1 1 ${pt(start + Math.PI)}A${r},${r} 0 1 1 ${pt(start + Math.PI * 2)}`;
        return `M${pt(start)}A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${pt(start + sweep)}`;
    };
    const DEG = Math.PI / 180;

    // 「降低动态」统一读 music-motion.js（设置里可选跟随系统 / 开 / 关）；没加载时退回系统设置。
    const reducedMotion = () => (global.MusicMotion
        ? global.MusicMotion.reduced()
        : Boolean(global.matchMedia?.('(prefers-reduced-motion: reduce)').matches));

    // ---------- 节点 ----------
    const el = (tag, attrs = {}, parent) => {
        const node = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        if (parent) parent.appendChild(node);
        return node;
    };

    const buildScene = (root) => {
        const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' }, root);
        const n = { svg };
        n.veil = el('rect', { class: 'mi-veil', x: -2000, y: -2000, width: W + 4000, height: H + 4000, opacity: 0 }, svg);

        // 开场第一段：访问请求
        n.access = el('g', { opacity: 0 }, svg);
        n.accessText = el('text', { x: 392, y: 306, 'font-size': 15, 'font-weight': 500, 'letter-spacing': '1.2' }, n.access);
        n.accessCursor = el('rect', { x: 392, y: 293, width: 2.5, height: 16, class: 'mi-block' }, n.access);

        // 第二段：我们自己的记号（细圆 + 五根音轨竖条）和身份核验
        n.mark = el('g', { opacity: 0, transform: 'translate(0 0)' }, svg);
        n.markParts = buildMark(n.mark, 330, 300, 46, 2.2);
        n.markWord = el('text', { x: 262, y: 382, 'font-size': 17, 'font-weight': 700, 'letter-spacing': '3' }, n.mark);
        n.brand = [
            el('text', { x: 262, y: 404, 'font-size': 9, 'letter-spacing': '2.2', class: 'mi-muted', opacity: 0 }, n.mark),
            el('text', { x: 262, y: 418, 'font-size': 9, 'letter-spacing': '2.2', class: 'mi-muted', opacity: 0 }, n.mark)
        ];
        n.brand[0].textContent = '本地曲库';
        n.brand[1].textContent = '';
        n.auth = el('g', { opacity: 0 }, svg);
        n.authLabel = el('text', { x: 410, y: 292, 'font-size': 9, 'letter-spacing': '2.4', class: 'mi-muted' }, n.auth);
        n.authLabel.textContent = '准备曲库';
        n.authText = el('text', { x: 410, y: 314, 'font-size': 18, 'font-weight': 600, 'letter-spacing': '1' }, n.auth);
        n.authCursor = el('rect', { x: 410, y: 300, width: 2.5, height: 17, class: 'mi-block' }, n.auth);

        // 第三段：扫描圆环
        n.scan = el('g', { opacity: 0 }, svg);
        n.scanRings = el('g', {}, n.scan);
        n.outer = el('path', { class: 'mi-stroke', 'stroke-width': 1.6 }, n.scanRings);
        n.white = el('path', { class: 'mi-ring-soft', 'stroke-width': 3 }, n.scanRings);
        n.innerA = el('path', { class: 'mi-stroke', 'stroke-width': 1 }, n.scanRings);
        n.innerB = el('path', { class: 'mi-stroke', 'stroke-width': 1 }, n.scanRings);
        n.dots = [0, 1].map(() => el('circle', { r: 2.6, class: 'mi-block' }, n.scanRings));

        n.cap = el('circle', { r: 3, class: 'mi-block' }, n.scanRings);
        // 扫描收尾：环收到记号大小，字退场，环里画出记号；扫描环就是记号的圆周。
        n.scanMark = el('g', {}, n.scan);
        n.scanMarkParts = buildMark(n.scanMark, CX, CY, 46, 2.2);
        n.scanMarkParts.ring.style.display = 'none';
        n.scanText = el('text', { x: CX, y: CY + 6, 'text-anchor': 'middle', 'font-size': 17, 'font-weight': 600 }, n.scan);
        n.scanSub = el('text', { x: CX, y: CY + 30, 'text-anchor': 'middle', 'font-size': 9, 'letter-spacing': '2.4', class: 'mi-muted' }, n.scan);

        // 第四段：欢迎面板
        n.welcome = el('g', { opacity: 0 }, svg);
        n.welcomeInner = el('g', {}, n.welcome);
        n.welcomeHead = el('text', { x: CX, y: 262, 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 700, 'letter-spacing': '1' }, n.welcomeInner);
        n.welcomeHead.textContent = '欢迎回来';
        n.welcomeBlock = el('rect', { x: CX - 128, y: 276, width: 256, height: 46, class: 'mi-block' }, n.welcomeInner);
        n.welcomeName = el('text', { x: CX, y: 310, 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 700, 'letter-spacing': '2', class: 'mi-on-block' }, n.welcomeInner);
        n.welcomeName.textContent = 'VCP MUSIC';
        n.welcomeRule = el('rect', { x: CX - 128, y: 330, width: 0, height: 2, class: 'mi-block' }, n.welcomeInner);
        n.welcomeSub = el('text', { x: CX, y: 352, 'text-anchor': 'middle', 'font-size': 10, 'letter-spacing': '2.6', class: 'mi-muted' }, n.welcomeInner);
        n.welcomeMark = el('g', {}, n.welcomeInner);
        drawMark(buildMark(n.welcomeMark, CX, 394, 17.5, 1.6), 99, 0);

        // 进出舞台：档案号
        n.file = el('g', { opacity: 0 }, svg);
        n.fileLabel = el('text', { x: CX, y: CY - 8, 'text-anchor': 'middle', 'font-size': 9, 'letter-spacing': '2.4', class: 'mi-muted' }, n.file);
        n.fileText = el('text', { x: CX, y: CY + 14, 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 700, 'letter-spacing': '.5' }, n.file);

        n.flash = document.createElement('div');
        n.flash.className = 'mi-flash';
        root.appendChild(n.flash);
        // 收尾揭开时的扫描头：整层不再半透明淡出（那样会透出底下还在搭的首页），改成从左往右一刀切开
        n.wipe = document.createElement('div');
        n.wipe.className = 'mi-wipe';
        root.appendChild(n.wipe);
        return n;
    };

    // 光标跟在已打出的字后面；字宽随字体变，直接量。
    const textWidth = (node) => {
        if (!node.textContent) return 0;
        try { return node.getComputedTextLength(); } catch (e) { return node.textContent.length * 9; }
    };

    // ---------- VCP Music 记号：庞加莱圆盘 ----------
    // 双曲平面的圆盘模型：圆周是无穷远，测地线是与圆周正交的圆弧。七条测地线隔一个点相连成七瓣（七声音阶），
    // 里面再套一层缩小的同样结构。
    const geodesic = (cx, cy, R, a, b) => {
        const h = (b - a) / 2, m = (a + b) / 2;
        const d = R / Math.cos(h), r = R * Math.tan(h);
        const p1 = `${(cx + R * Math.cos(a)).toFixed(2)},${(cy + R * Math.sin(a)).toFixed(2)}`;
        const p2 = `${(cx + R * Math.cos(b)).toFixed(2)},${(cy + R * Math.sin(b)).toFixed(2)}`;
        return `M${p1}A${r.toFixed(2)},${r.toFixed(2)} 0 0 0 ${p2}`;
    };
    // 记号只取圆盘中间交织的那一片：测地线画在一个比可见圆周大 1.53 倍的圆盘上，再裁进可见圆周里，
    // 外圈不留空白。R 是可见圆周的半径。
    let clipSeq = 0;
    const DISK = 1.533;
    const buildMark = (parent, cx, cy, R, width) => {
        const step = Math.PI * 2 / 7, off = -Math.PI / 2;
        const id = `mi-mark-clip-${++clipSeq}`;
        const defs = el('defs', {}, parent);
        el('circle', { cx, cy, r: R }, el('clipPath', { id }, defs));
        const body = el('g', { 'clip-path': `url(#${id})` }, parent);
        const line = (d, w, op) => el('path', { d, class: 'mi-stroke', 'stroke-width': w.toFixed(2), opacity: op, pathLength: 1, 'stroke-dasharray': '0 1' }, body);
        const D = R * DISK;
        const outer = [], inner = [];
        for (let k = 0; k < 7; k++) {
            outer.push(line(geodesic(cx, cy, D, off + k * step, off + (k + 2) * step), width * 0.62, '1'));
            inner.push(line(geodesic(cx, cy, D * 0.52, off + (k + 1) * step, off + (k + 3) * step), width * 0.45, '.6'));
        }
        const ring = el('circle', { cx, cy, r: R, class: 'mi-stroke', 'stroke-width': width, pathLength: 1, 'stroke-dasharray': '0 1', transform: `rotate(-90 ${cx} ${cy})` }, parent);
        const core = el('circle', { cx, cy, r: width * 1.5, class: 'mi-block', opacity: '0' }, parent);
        return { ring, outer, inner, core };
    };
    // 按顺序画出记号：圆周 → 七条测地线 → 内圈 → 中心点。k 把整段时长按比例压缩。
    const drawMark = (mp, t, t0, k = 1) => {
        const at = (a, b) => easeOut(progress(t, t0 + a * k, t0 + b * k));
        drawStroke(mp.ring, at(0, 0.55));
        mp.outer.forEach((path, i) => drawStroke(path, at(0.4 + i * 0.07, 0.75 + i * 0.07)));
        mp.inner.forEach((path, i) => drawStroke(path, at(0.8 + i * 0.04, 1.1 + i * 0.04)));
        mp.core.setAttribute('opacity', t >= t0 + 1.1 * k ? '1' : '0');
    };
    const drawStroke = (node, p) => node.setAttribute('stroke-dasharray', `${p.toFixed(4)} ${(1 - p + 0.0001).toFixed(4)}`);

    // ---------- 扫描环（开场与短版共用） ----------
    // local 是扫描段内的秒数；speed 把同一条轨迹压快（短版 1.5 倍）。
    const renderScan = (n, local, { speed = 1, count = 0, label = '整理曲目', sub = '' } = {}) => {
        const t = local * speed;
        const collapse = smooth(progress(t, 1.12, 1.38));
        const r = keys([[0, 1500], [0.2, 900], [0.4, 520], [0.6, 330], [0.8, 274], [1.0, 258], [1.9, 246]], t) * (1 - collapse) + 46 * collapse;
        const outerStart = keys([[0, 470], [0.4, 230], [0.8, 20], [1.2, -70], [1.9, -90]], t) * DEG;
        const outerSweep = keys([[0, 30], [0.4, 190], [0.8, 300], [1.2, 352], [1.6, 360]], t) * DEG;
        const whiteStart = keys([[0, -100], [0.5, 120], [1.0, 230], [1.9, 270]], t) * DEG;
        const whiteSweep = keys([[0, 18], [0.6, 70], [1.2, 40], [1.9, 28]], t) * DEG;
        const innerR = r * 0.78;
        const innerStart = (-40 + t * 140) * DEG;
        const innerSweep = keys([[0, 0], [0.5, 60], [1.0, 120], [1.9, 140]], t) * DEG;
        n.outer.setAttribute('d', arc(r, outerStart, outerSweep));
        n.white.setAttribute('d', arc(r * 0.91, whiteStart, whiteSweep));
        n.innerA.setAttribute('d', arc(innerR, innerStart, innerSweep));
        n.innerB.setAttribute('d', arc(innerR, innerStart + Math.PI, innerSweep));
        const orbit = (t * 210) * DEG;
        n.dots.forEach((dot, i) => {
            dot.setAttribute('cx', (CX + Math.cos(orbit + i * Math.PI) * innerR * 0.86).toFixed(2));
            dot.setAttribute('cy', (CY + Math.sin(orbit + i * Math.PI) * innerR * 0.86).toFixed(2));
        });
        // 收拢时辅助弧和轨道点退掉，只剩外环
        for (const node of [n.white, n.innerA, n.innerB, ...n.dots]) node.style.opacity = String(1 - collapse);
        drawMark(n.scanMarkParts, t, 1.2, 0.26);
        const capA = outerStart + outerSweep;
        n.cap.setAttribute('cx', (CX + Math.cos(capA) * r).toFixed(2));
        n.cap.setAttribute('cy', (CY + Math.sin(capA) * r).toFixed(2));

        // 两帧频闪：圆环突然放大变淡，像信号没对上。
        const f = frameOf(t);
        const glitch = f === 19 || f === 20 || f === 22;
        n.scanRings.setAttribute('transform', glitch ? `translate(${CX} ${CY}) scale(1.9) translate(${-CX} ${-CY})` : '');
        n.scanRings.style.opacity = glitch ? '0.32' : String(keys([[0, 0], [0.04, 0.2], [0.12, 0.65], [0.2, 1]], t));
        n.scanRings.style.filter = glitch ? 'blur(1.4px)' : '';

        // 字距从很散收拢到正常
        const tracking = keys([[0, 26], [0.2, 12], [0.4, 5], [0.6, 1.6], [0.8, 0]], t);
        n.scanText.setAttribute('letter-spacing', tracking.toFixed(2));
        n.scanText.textContent = `${label} ${Math.max(0, Math.round(count))} 首`;
        const textOut = 1 - smooth(progress(t, 1.02, 1.18));
        n.scanText.style.opacity = String(keys([[0, 0], [0.16, 1]], t) * textOut);
        n.scanSub.textContent = sub;
        n.scanSub.style.opacity = String(progress(t, 0.5, 0.7) * textOut);
    };

    // ---------- 开场 ----------
    const FULL = { scan: 6.2, welcome: 8.0, exit: 9.0, end: 9.75 };
    const SHORT = { end: 2.5 };

    const renderFull = (n, t, ctx) => {
        const f = frameOf(t);
        // 访问请求
        n.access.style.opacity = t < 0.35 || t >= 2.1 ? '0' : f === frameOf(2.0) ? '0.25' : '1';
        n.accessText.textContent = typed('打开音乐曲库', t, 0.4, 1.0);
        n.accessCursor.setAttribute('x', String(392 + textWidth(n.accessText) + 4));
        n.accessCursor.style.opacity = Math.floor(t * 2.5) % 2 ? '0' : '1';

        // 记号描线、音轨竖条升起、文字
        n.mark.style.opacity = t >= 2.2 && t < FULL.scan ? '1' : '0';
        // 先画圆周（无穷远），再一条一条画出七条测地线，然后内圈、外圈编织带和中心点
        drawMark(n.markParts, t, 2.2);
        n.markWord.textContent = typed('VCP · MUSIC', t, 3.0, 3.45);
        n.brand.forEach((line, i) => {
            const p = easeOut(progress(t, 3.3 + i * 0.08, 3.85 + i * 0.08));
            line.setAttribute('opacity', String(clamp01(p * 3)));
            line.setAttribute('transform', `translate(${(1 - p) * 60} 0)`);
        });
        n.mark.setAttribute('transform', `translate(${keys([[2.2, 70], [3.4, 70], [3.9, 0]], t)} 0)`);

        // 身份核验
        n.auth.style.opacity = t >= 3.6 && t < 6.2 ? '1' : '0';
        let auth = '';
        if (t < 4.75) {
            auth = typed('你好', t, 3.6, 3.8);
            if (t >= 4.12 && ctx.name) auth += '，' + typed(ctx.name, t, 4.15, 4.5);
        } else if (t < 5.35) auth = typed('读取曲库', t, 4.8, 5.05);
        else {
            auth = typed('排列档案', t, 5.4, 5.62);
            if (t >= 5.78) auth += '.'.repeat(Math.min(3, 1 + Math.floor((t - 5.78) / 0.12)));
        }
        n.authText.textContent = auth;
        n.authCursor.setAttribute('x', String(410 + textWidth(n.authText) + 4));
        n.authCursor.style.opacity = Math.floor(t * 2.5) % 2 ? '0' : '1';

        // 扫描环：曲库计数跟着环收拢一起数上来
        const scanOn = t >= FULL.scan && t < FULL.welcome;
        n.scan.style.opacity = scanOn ? String(f >= frameOf(7.75) ? keys([[7.75, 1], [7.9, 0.1]], t) : 1) : '0';
        if (scanOn) {
            const local = t - FULL.scan;
            renderScan(n, local, {
                count: ctx.count() * easeOut(progress(local, 0.1, 1.2)),
                sub: progress(local, 0.5, 0.7) > 0 ? (ctx.name || '') : ''
            });
        }

        // 欢迎面板：开头几帧面板和字一起闪，像信号接通
        const welcomeOn = t >= FULL.welcome && t < FULL.end;
        n.welcome.style.opacity = welcomeOn ? '1' : '0';
        if (welcomeOn) {
            const k = f - frameOf(FULL.welcome);
            const panel = k >= 0 && k < 7 ? [1, 0, 0.28, 0, 1, 1, 1][k] : 1;
            const ink = k >= 0 && k < 7 ? [0, 0, 0.2, 1, 0, 0.25, 1][k] : 1;
            n.welcomeBlock.style.opacity = String(panel);
            n.welcomeName.style.opacity = String(panel);
            n.welcomeHead.style.opacity = String(ink);
            n.welcomeRule.setAttribute('width', String(256 * easeOut(progress(t, 8.3, 8.7))));
            const subOn = t >= 8.55 && !(f === frameOf(8.63) || f === frameOf(8.71));
            n.welcomeSub.style.opacity = subOn ? '1' : '0';
            n.welcomeSub.textContent = `曲库 ${Math.max(0, Math.round(ctx.count()))} 首`;
            n.welcomeMark.style.opacity = t >= 8.4 ? '1' : '0';
            const exit = smooth(progress(t, FULL.exit, FULL.exit + 0.36));
            n.welcomeInner.setAttribute('transform', `translate(${CX} ${CY}) scale(${1 - 0.46 * exit}) translate(${-CX} ${-CY})`);
            n.welcome.style.opacity = String(1 - Math.pow(exit, 3));
            n.welcome.style.filter = exit > 0 ? `blur(${(8 * exit).toFixed(2)}px)` : '';
        }
        // 白场，然后从左往右揭开露出主界面（没揭到的部分始终不透明）
        const white = smooth(progress(t, FULL.exit - 0.05, FULL.exit + 0.35));
        n.flash.style.opacity = String(white * ctx.flashPeak);
        ctx.wipe = smooth(progress(t, FULL.exit + 0.35, FULL.end));
        return 1;
    };

    const renderShort = (n, t, ctx) => {
        n.scan.style.opacity = String(1 - smooth(progress(t, 1.45, 1.75)));
        renderScan(n, t, {
            speed: 1.5,
            count: ctx.count() * easeOut(progress(t, 0.1, 1.0)),
            sub: ctx.name || ''
        });
        const white = smooth(progress(t, 1.35, 1.8));
        n.flash.style.opacity = String(white * ctx.flashPeak);
        ctx.wipe = smooth(progress(t, 1.8, SHORT.end));
        return 1;
    };

    // ---------- 进出舞台、舞台里换模式 ----------
    // 进：第一帧还是档案页（舞台被按住不显示），圆环收拢、打出档案号。圆环收拢后停在「闸门」上，
    //     舞台加载好（3D 场景着色器预热完、第一帧画出来）才往下走：白场到不透明，这一刻放开舞台，白场退去时下面已经是舞台。
    //     加载慢时圆环在原地转，标签换成 LOADING STAGE，不会露出空白画面。
    // 退：舞台还在演的时候圆环先收拢、纸色底盖严，盖严后才真正退出舞台；舞台拆完 3D 场景、档案页恢复好，再闪一下白场揭开。
    // 换模式（舞台里切到 3D 模式或从 3D 切走）：纸色底盖住舞台，等新模式加载好再揭开。
    // 顺序很要紧：过场先画上屏，重活（建 3D 场景、拆场景、档案页恢复渲染）都排在盖住之后才开始，卡顿只会发生在盖住的时候。
    const TRANSIT = { enter: 1.1, exit: 0.85, switch: 0.7, enterGate: 0.44, enterRelease: 0.58, exitGate: 0.3, exitRelease: 0.3, switchGate: 0.2 };
    const TRANSIT_KINDS = ['enter', 'exit', 'switch'];
    const GATE_MAX = 12; // 最多等 12 秒；再慢也揭开，不把界面挡死
    const renderTransit = (n, t, ctx) => {
        const kind = ctx.direction;
        const releaseAt = kind === 'enter' ? TRANSIT.enterRelease : kind === 'exit' ? TRANSIT.exitRelease : TRANSIT.switchGate;
        if (!ctx.released && t >= releaseAt) { ctx.released = true; ctx.release?.(); }
        n.innerA.setAttribute('d', ''); n.innerB.setAttribute('d', '');
        // 等加载时圆环一直转
        const spin = (ctx.wait || 0) * 200 * DEG;
        const loading = ctx.waiting && ctx.loadingLabel !== false ? '正在载入舞台' + '.'.repeat(1 + (Math.floor((ctx.wait || 0) * 3) % 3)) : '';
        let r, sweep, start;
        if (kind === 'enter') {
            const backdropOpacity = t < releaseAt ? smooth(progress(t, 0, 0.14)) : 0;
            n.svg.parentElement.style.setProperty('--mi-enter-backdrop', String(backdropOpacity));
            r = keys([[0, 640], [0.2, 300], [0.45, 168], [0.7, 160]], t);
            sweep = keys([[0, 30], [0.25, 220], [0.5, 360]], t) * DEG;
            start = keys([[0, 200], [0.5, -90]], t) * DEG + spin;
            n.white.setAttribute('d', arc(r * 0.9, start + Math.PI * 0.8, 50 * DEG));
            n.scan.style.opacity = String(smooth(progress(t, 0, 0.08)));
            n.fileLabel.textContent = loading || '进入舞台';
            n.fileText.textContent = typed(ctx.file, t, 0.04, 0.34);
            // 白场 90% 以上只维持约 110ms：0.45 起快速升到不透明，放开舞台后立刻开始退。
            n.flash.style.opacity = String(smooth(progress(t, 0.45, releaseAt)) * (1 - smooth(progress(t, releaseAt + 0.01, TRANSIT.enter - 0.1))));
            // 白场盖严之后，遮罩和圆环一起撤掉，白场退去时只剩舞台。
            if (t >= releaseAt) n.scan.style.opacity = '0';
        } else if (kind === 'exit') {
            // 0.28 秒内纸色底盖严、圆环收拢；闸门（0.3）之后白场 0.1 秒升起，纸色底在白场后面撤掉，白场退去露出档案页。
            const gate = TRANSIT.exitGate;
            n.flash.style.opacity = String(smooth(progress(t, gate, gate + 0.1)) * (1 - smooth(progress(t, gate + 0.11, gate + 0.42))));
            n.veil.setAttribute('opacity', String(t < gate + 0.1 ? smooth(progress(t, 0.04, 0.28)) : 0));
            if (t < gate + 0.1) {
                r = keys([[0, 640], [0.18, 300], [0.3, 168]], t);
                sweep = keys([[0, 30], [0.26, 360]], t) * DEG;
                start = keys([[0, 200], [0.3, -90]], t) * DEG + spin;
                n.scan.style.opacity = String(smooth(progress(t, 0, 0.08)));
            } else {
                r = keys([[gate + 0.1, 160], [gate + 0.3, 520]], t);
                sweep = keys([[gate + 0.1, 360], [gate + 0.3, 40]], t) * DEG;
                start = keys([[gate + 0.1, -90], [gate + 0.3, 160]], t) * DEG + spin;
                n.scan.style.opacity = String(1 - smooth(progress(t, gate + 0.1, gate + 0.38)));
            }
            n.white.setAttribute('d', t < gate + 0.1 ? arc(r * 0.9, start + Math.PI * 0.8, 50 * DEG) : '');
            n.fileLabel.textContent = loading || '返回';
            n.fileText.textContent = typed('曲库', t, 0.04, 0.2);
        } else {
            // 换模式：舞台在点击 0.17 秒后才开始建新模式，纸色底 0.14 秒就盖严；等新模式加载好后揭开
            const gate = TRANSIT.switchGate;
            n.flash.style.opacity = '0';
            n.veil.setAttribute('opacity', String(smooth(progress(t, 0, 0.14)) * (1 - smooth(progress(t, gate + 0.05, TRANSIT.switch)))));
            r = keys([[0, 400], [0.18, 168], [gate + 0.05, 160], [TRANSIT.switch, 420]], t);
            sweep = keys([[0, 60], [0.18, 360], [gate + 0.05, 360], [TRANSIT.switch, 40]], t) * DEG;
            start = keys([[0, 120], [0.18, -90]], t) * DEG + spin;
            n.white.setAttribute('d', arc(r * 0.9, start + Math.PI * 0.8, 50 * DEG));
            n.scan.style.opacity = String(smooth(progress(t, 0, 0.1)) * (1 - smooth(progress(t, gate + 0.05, TRANSIT.switch - 0.1))));
            n.fileLabel.textContent = loading || '切换舞台';
            n.fileText.textContent = typed(ctx.file, t, 0.02, 0.18);
        }
        n.outer.setAttribute('d', arc(r, start, sweep));
        n.cap.setAttribute('cx', (CX + Math.cos(start + sweep) * r).toFixed(2));
        n.cap.setAttribute('cy', (CY + Math.sin(start + sweep) * r).toFixed(2));
        n.file.style.opacity = n.scan.style.opacity;
        return 1;
    };

    // 降低动态：不放过场，但加载中的画面也不能露出来。直接盖一层纸色底，加载好了直接撤，没有任何动画；
    // 等得久（超过 0.4 秒）才在中间写一行 LOADING STAGE。
    // 揭开：裁掉左边已经扫过的部分，扫描头停在切口上；0 和 1 都不画扫描头
    const applyWipe = (root, n, wipe = 0) => {
        const on = wipe > 0 && wipe < 1;
        root.style.clipPath = wipe > 0 ? `inset(0 0 0 ${(wipe * 100).toFixed(3)}%)` : '';
        n.wipe.style.opacity = on ? '1' : '0';
        if (on) n.wipe.style.left = `${(wipe * 100).toFixed(3)}%`;
    };

    const renderStill = (n, t, ctx) => {
        const releaseAt = ctx.direction === 'enter' ? 0.001 : 0;
        if (!ctx.released && t >= releaseAt) { ctx.released = true; ctx.release?.(); }
        n.veil.setAttribute('opacity', '1');
        n.flash.style.opacity = '0';
        n.scan.style.opacity = '0';
        n.fileLabel.textContent = '正在载入舞台';
        n.fileText.textContent = ctx.file || '';
        n.file.style.opacity = ctx.waiting && ctx.wait > 0.4 ? '1' : '0';
        return 1;
    };

    // music.html 里一开始就有一层底色盖着，等脚本接手；接手后把它换掉。
    const dropCover = () => document.getElementById('music-intro-cover')?.remove();

    // ---------- 播放器 ----------
    const init = (app) => {
        let current = null;
        let userName = '';

        const loadName = async () => {
            try {
                const api = global.utilityAPI?.loadSettings ? global.utilityAPI : app?.api || global.electronAPI;
                const settings = await api?.loadSettings?.();
                const name = String(settings?.userName || '').trim();
                if (name) userName = name.slice(0, 24);
            } catch (e) { /* 取不到设置就不写名字 */ }
        };
        const namePromise = loadName();

        // 调试用：?introSlow=10 让过场慢 10 倍，方便逐帧看舞台什么时候露出来。
        let timeScale = 1;
        try { timeScale = 1 / Math.max(1, Number(new URLSearchParams(global.location.search).get('introSlow')) || 1); } catch (e) { /* 正常速度 */ }

        const count = () => (Array.isArray(app?.playlist) ? app.playlist.length : 0);
        const flashPeak = () => parseFloat(getComputedStyle(document.body).getPropertyValue('--mi-flash-peak')) || 1;

        // 舞台「按住」：进场时舞台先不显示，退场时舞台先不消失，等白场盖严再放开。
        const HOLD = ['mi-stage-hold-enter', 'mi-stage-hold-exit'];
        const releaseStage = () => {
            if (!HOLD.some((c) => document.body.classList.contains(c))) return;
            // 放开的那一下不要再走舞台自己的 0.38 秒淡入淡出，白场后面直接换好。
            document.body.classList.add('mi-stage-snap');
            document.body.classList.remove(...HOLD);
            requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('mi-stage-snap')));
        };

        const stop = (instant = false) => {
            if (!current) return;
            const run = current;
            current = null;
            run.flush?.();
            releaseStage();
            cancelAnimationFrame(run.raf);
            run.detach();
            document.body.classList.remove('music-intro-playing');
            if (instant || reducedMotion()) { run.root.remove(); run.done?.(); return; }
            const fade = run.root.animate([{ opacity: getComputedStyle(run.root).opacity }, { opacity: 0 }], { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
            fade.finished.catch(() => {}).then(() => { run.root.remove(); run.done?.(); });
        };

        const start = (kind, extra = {}) => {
            stop(true);
            const root = document.createElement('div');
            root.className = 'music-intro' + (TRANSIT_KINDS.includes(kind) ? ' is-transit' : '');
            root.dataset.intro = kind;
            const transit = root.classList.contains('is-transit');
            if (!transit) {
                root.setAttribute('role', 'presentation');
                const skip = document.createElement('div');
                skip.className = 'mi-skip';
                skip.textContent = '按任意键跳过';
                root.appendChild(skip);
            }
            document.body.appendChild(root);
            if (!transit) dropCover();
            const nodes = buildScene(root);
            const ctx = { name: userName, count, flashPeak: flashPeak(), direction: kind, file: extra.file || '', release: extra.release || releaseStage, released: false, wait: extra.wait || 0, waiting: Boolean(extra.wait), loadingLabel: extra.loadingLabel };
            const render = extra.still ? renderStill : kind === 'full' ? renderFull : kind === 'short' ? renderShort : renderTransit;
            const length = extra.still ? 0.02 : kind === 'full' ? FULL.end : kind === 'short' ? SHORT.end : TRANSIT[kind];
            if (extra.still) root.dataset.still = '1';

            const onKey = (event) => { event.preventDefault(); event.stopPropagation(); stop(); };
            const onPointer = (event) => { event.stopPropagation(); stop(); };
            if (!transit) {
                global.addEventListener('keydown', onKey, true);
                root.addEventListener('pointerdown', onPointer);
                document.body.classList.add('music-intro-playing');
            }
            const run = {
                root,
                raf: 0,
                gate: extra.gate,
                done: extra.done,
                // 闸门上还没做的事（真正进出舞台）无论如何都要做：过场被打断、窗口在后台不出帧时由这里补上
                flush: () => {
                    const g = extra.gate;
                    if (!g?.action || g.acted) return;
                    g.acted = true;
                    clearTimeout(run.actionTimer);
                    try { g.action(); } catch (e) { console.warn('[MusicIntro]', e); }
                },
                detach: () => {
                    global.removeEventListener('keydown', onKey, true);
                    root.removeEventListener('pointerdown', onPointer);
                }
            };
            current = run;
            namePromise.then(() => { ctx.name = userName; });

            // 预览/截图用：?introAt=秒 固定在某一帧。
            const fixed = extra.at;
            const t0 = performance.now();
            // 闸门：时间走到 gate.at 时，gate.ready() 不成立就停在这一刻（圆环照转），成立了再往下走。
            const gate = extra.gate;
            // 时间一帧最多走 0.1 秒：加载把主线程卡住时，回来接着放，不会一下跳到结尾、让新画面直接蹦出来。
            let clock = 0, last = t0, waitStart = 0, readyFrames = 0;
            const tick = (now) => {
                if (current !== run) return;
                const step = Math.min(Math.max(0, now - last) / 1000 * timeScale, 0.1);
                last = now;
                if (fixed == null) {
                    clock += step;
                    if (gate && !gate.passed) clock = Math.min(clock, gate.at);
                }
                let t = fixed ?? clock;
                if (fixed == null && gate && !gate.passed && t >= gate.at && gate.action && !gate.acted) {
                    // 闸门这一帧先画上屏（等两帧确认），再开始重活；卡顿出现时屏幕上已经是盖好的画面
                    gate.frames = (gate.frames || 0) + 1;
                    ctx.waiting = true;
                    t = gate.at;
                    if (gate.frames >= 3) run.flush();
                } else if (fixed == null && gate && !gate.passed && t >= gate.at) {
                    if (!waitStart) waitStart = now;
                    const waited = (now - waitStart) / 1000;
                    let ok = true;
                    try { ok = gate.ready(); } catch (e) { ok = true; }
                    // 一开始就好了直接走；等过的要再多等两帧，让新画面先画出来
                    readyFrames = ok ? readyFrames + 1 : 0;
                    const pass = ok && (waited === 0 || readyFrames >= 3);
                    if (pass || waited > GATE_MAX) {
                        gate.passed = true;
                        ctx.waiting = false;
                    } else {
                        ctx.waiting = true;
                        ctx.wait = waited;
                        t = gate.at;
                    }
                }
                root.toggleAttribute('data-waiting', Boolean(ctx.waiting));
                const opacity = render(nodes, t, ctx);
                root.style.opacity = String(opacity);
                applyWipe(root, nodes, ctx.wipe);
                if (fixed == null && t >= length) { current = null; run.flush(); releaseStage(); run.detach(); document.body.classList.remove('music-intro-playing'); root.remove(); run.done?.(); return; }
                run.raf = requestAnimationFrame(tick);
            };
            run.raf = requestAnimationFrame(tick);
            if (fixed != null) tick(t0);
            else if (gate?.action) run.actionTimer = setTimeout(run.flush, 1500);
            return run;
        };

        // 减少动态：开场只是一层底色淡出（进出舞台另有一层不动的纸色底，见 renderStill）。
        const fadeOnly = () => {
            const root = document.createElement('div');
            root.className = 'music-intro';
            document.body.appendChild(root);
            dropCover();
            root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-out', fill: 'forwards' })
                .finished.catch(() => {}).then(() => root.remove());
        };

        const playIntro = (kind) => {
            if (reducedMotion()) { fadeOnly(); return; }
            if (kind === 'full') { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* 只是记住看过 */ } }
            start(kind);
        };

        // ---------- 进出舞台：只看 body 上的类和舞台宿主公开的状态，不碰舞台代码 ----------
        // 3D 模式名单以舞台登记表为准（music-stage-advanced-modes.js 的 traits）；舞台脚本没加载时（测试）用这份
        const SCENE_3D_FALLBACK = ['diorama', 'tunnel', 'kowloon'];
        const isScene3d = (id) => (global.MusicStageModes?.traits ? global.MusicStageModes.traits(id).scene3d : SCENE_3D_FALLBACK.includes(id));
        const stageRoot = () => document.querySelector('.music-stage');
        const modeRoot = () => document.querySelector('.music-stage-mode-root');
        const modeLabel = (id) => global.MusicStageModes?.get?.(id)?.label
            || modeRoot()?.closest('.music-stage')?.querySelector(`[data-stage-mode="${id}"]`)?.textContent || id || '';
        // 舞台当前模式加载好了没有：3D 模式看它自己报的 initialized（着色器预热完）或已降级成文字；2D 模式建好就算好。
        const stageModeReady = () => {
            const host = app?.stageHost;
            if (!host || !host.active) return true;
            if (modeRoot()?.classList.contains('is-switching')) return false;
            const snap = host.getDebugSnapshot?.();
            if (!snap) return true;
            if (!snap.hasModeInstance) return false;
            const mode = snap.mode;
            if (!mode || !('initialized' in mode)) return true;
            return Boolean(mode.initialized || mode.fallbackMode);
        };
        // 退出时舞台 0.38 秒后才拆 3D 场景并把根节点藏起来；拆完再揭开，卡顿留在白场后面。
        const stageGone = () => {
            const host = app?.stageHost;
            if (!host || host.active) return true;
            return stageRoot()?.hidden !== false;
        };

        let wasStage = document.body.classList.contains('music-stage-active');
        let lastMode = app?.stageHost?.modeId || null;
        // 舞台宿主原来的 enter / exit（接管之后存在这里）；action 里调它们才是真正进出舞台。
        let hostEnter = null, hostExit = null;
        const canCover = () => !document.hidden
            && !(current && !current.root.classList.contains('is-transit')); // 开场还没放完就不叠过场

        // direction: enter / exit / switch。extra.deferred = true 表示舞台还没动，由过场在盖好之后去调宿主；
        // 否则是舞台已经自己动了（别处直接改了状态），过场只能跟在后面盖，用「按住舞台」的办法补救。
        const transit = (direction, extra = {}) => {
            if (!canCover()) return null;
            // 降低动态：同样先盖后做，只是盖的是一层不动的纸色底
            const still = reducedMotion();
            if (direction === 'enter') {
                // 档案页据此把选中卡抬起来并继续画；舞台先不露出来，直到过场放完。
                document.body.classList.add('music-stage-entering');
                const track = app?.playlist?.[app.currentTrackIndex];
                // 过场中间写的是要播放的曲名（去掉扩展名）
                const file = String(track?.title || '').replace(/\.[a-z0-9]{2,5}$/i, '');
                const hold = () => {
                    document.body.classList.remove('mi-stage-hold-exit');
                    document.body.classList.add('mi-stage-hold-enter');
                };
                const run = start('enter', {
                    file: still ? '' : file,
                    still,
                    loadingLabel: isScene3d(app?.stageHost?.modeId),
                    gate: {
                        at: still ? 0 : TRANSIT.enterGate,
                        ready: stageModeReady,
                        action: extra.deferred ? () => { hold(); wasStage = true; hostEnter(); lastMode = app?.stageHost?.modeId || lastMode; } : null
                    },
                    done: () => document.body.classList.remove('music-stage-entering')
                });
                if (!extra.deferred) hold();
                return run;
            }
            if (direction === 'switch') {
                return start('switch', {
                    file: extra.label || '',
                    still,
                    gate: { at: still ? 0 : TRANSIT.switchGate, ready: stageModeReady },
                    release: () => {}
                });
            }
            document.body.classList.remove('music-stage-entering');
            const run = start('exit', {
                loadingLabel: false,
                still,
                gate: {
                    at: still ? 0 : TRANSIT.exitGate,
                    ready: stageGone,
                    action: extra.deferred ? () => {
                        // 纸色底已经盖严：舞台不用再淡出，直接撤
                        document.body.classList.add('mi-stage-snap');
                        wasStage = false;
                        hostExit();
                        requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('mi-stage-snap')));
                    } : null
                }
            });
            if (!extra.deferred) {
                document.body.classList.remove('mi-stage-hold-enter');
                document.body.classList.add('mi-stage-hold-exit');
            }
            return run;
        };

        // ---------- 接管进出舞台的入口 ----------
        // 以前是舞台先动、过场跟着盖：退出时档案页一恢复渲染、舞台一拆场景就卡，过场的第一帧反而排在卡顿后面。
        // 现在把入口接过来：先放过场，盖好了（闸门那一帧已经上屏）再调宿主原来的 enter / exit。
        const pendingKind = () => (current && current.root.classList.contains('is-transit') ? current.root.dataset.intro : null);
        // 过场还没走到闸门（还没真正进出）就反悔：这次进出作废，盖着的东西淡掉，舞台状态原样不动。
        const cancelPending = () => {
            const gate = current?.gate;
            if (!gate?.action || gate.acted) return false;
            gate.acted = true;
            clearTimeout(current.actionTimer);
            stop();
            return true;
        };
        const requestEnter = () => {
            const host = app?.stageHost;
            if (!host || pendingKind() === 'enter') return;
            if (pendingKind() === 'exit') {
                if (cancelPending()) return; // 还没退出去：留在舞台
                stop(true);                 // 已经退了：收掉退场，下面重新进
            }
            if (host.active) return;
            if (!transit('enter', { deferred: true })) hostEnter();
        };
        const requestExit = () => {
            const host = app?.stageHost;
            if (!host || pendingKind() === 'exit') return;
            if (pendingKind() === 'enter') {
                if (cancelPending()) return; // 还没进去：留在原处
                stop(true);                 // 已经进了：收掉进场，下面再退
            }
            if (!host.active) return;
            if (!transit('exit', { deferred: true })) hostExit();
        };
        // 按的是「切换」：以最后想去的那一边为准（过场中再按就是反悔）。
        const requestToggle = () => {
            const host = app?.stageHost;
            if (!host) return;
            const kind = pendingKind();
            const heading = kind === 'enter' ? true : kind === 'exit' ? false : host.active;
            if (heading) requestExit(); else requestEnter();
        };
        // 自动化测试（webdriver）里舞台保持同步进出，脚本调完 enter() 立刻就能查状态；要测接管就带 ?introCover=1。
        let adoptAllowed = true;
        try { adoptAllowed = !global.navigator?.webdriver || new URLSearchParams(global.location.search).get('introCover') === '1'; } catch (e) { /* 照常接管 */ }
        const adoptHost = () => {
            if (!adoptAllowed) return false;
            const host = app?.stageHost;
            if (!host || hostEnter || typeof host.enter !== 'function' || typeof host.exit !== 'function') return Boolean(hostEnter);
            hostEnter = host.enter;
            hostExit = host.exit;
            host.enter = requestEnter;
            host.exit = requestExit;
            host.toggle = requestToggle;
            lastMode = host.modeId || lastMode;
            return true;
        };
        // Esc 由舞台宿主自行处理，在它前面拦截以保留过渡动画。
        const onEscape = (event) => {
            if (event.key !== 'Escape' || event.defaultPrevented || !adoptHost() || !app.stageHost.active) return;
            if (document.querySelector('.music-stage-settings.is-open, .music-stage-mode-switcher.is-open')) return; // 先关设置或模式菜单，交给宿主
            event.preventDefault();
            event.stopPropagation();
            requestExit();
        };
        // 冒泡阶段挂在 document 上：底栏面板、搜索框先各自处理 Esc 并拦住，轮到这里才是「退出舞台」；宿主绑在 window 上，排在后面。
        document.addEventListener('keydown', onEscape);
        if (adoptAllowed && !adoptHost()) {
            // 舞台宿主一般先于这里初始化；万一还没有，等它出现
            let tries = 0;
            const wait = setInterval(() => { if (adoptHost() || ++tries > 50) clearInterval(wait); }, 200);
        }

        // 兜底：没走上面入口、舞台自己变了（比如宿主内部直接退出），MutationObserver 在首帧绘制之前回调，按住舞台再盖。
        const onBody = () => {
            const isStage = document.body.classList.contains('music-stage-active');
            if (isStage === wasStage) return;
            wasStage = isStage;
            lastMode = app?.stageHost?.modeId || lastMode;
            if (current?.root.dataset.intro === 'switch') stop(true);
            transit(isStage ? 'enter' : 'exit');
        };
        const bodyObserver = new MutationObserver(onBody);
        bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

        // 舞台里换模式：宿主在换之前给模式根节点加 is-switching。切到 3D 或从 3D 切走时要加载，盖上纸色底等它好。
        const onModeRoot = () => {
            const host = app?.stageHost;
            const node = modeRoot();
            if (!host || !node) return;
            const next = host.modeId;
            const previous = lastMode;
            lastMode = next;
            if (!node.classList.contains('is-switching') || !host.active || next === previous) return;
            if (current) return; // 进出舞台的过场还在放，它自己会等加载
            if (!isScene3d(next) && !isScene3d(previous)) return;
            transit('switch', { label: modeLabel(next) });
        };
        let modeObserver = null;
        const watchModeRoot = () => {
            const node = modeRoot();
            if (!node || modeObserver) return;
            lastMode = app?.stageHost?.modeId || lastMode;
            modeObserver = new MutationObserver(onModeRoot);
            modeObserver.observe(node, { attributes: true, attributeFilter: ['class'] });
        };
        watchModeRoot();
        if (!modeObserver) document.addEventListener('DOMContentLoaded', watchModeRoot, { once: true });

        const api = {
            /** 重新放一遍完整开场（设置里「播放完整开场」调用这个）。 */
            replay: () => playIntro('full'),
            playShort: () => playIntro('short'),
            skip: () => stop(),
            /** 进出舞台过场；舞台进出时会自动调用，一般不需要手动调。 */
            transit,
            /** 截图/调试：把某一段固定在第 t 秒。 */
            freeze: (kind, t, extra = {}) => start(kind, { ...extra, at: t }),
            get playing() { return current ? current.root.dataset.intro : null; },
            /** 调试：舞台当前模式是否加载好、退出后是否已拆完。 */
            stageState: () => ({ ready: stageModeReady(), gone: stageGone(), snapshot: app?.stageHost?.getDebugSnapshot?.() })
        };
        app && (app.musicIntro = api);
        global.MusicIntro = api;

        // 开窗即放：第一次是完整版，之后是短版。?intro=full|short|off 可以强制。
        let forced = null;
        try { forced = new URLSearchParams(global.location.search).get('intro'); } catch (e) { /* 没有查询串 */ }
        // 自动化测试（webdriver）不放开场，免得挡住界面；要看就显式带 ?intro=。
        if (!forced && global.navigator?.webdriver) forced = 'off';
        if (forced === 'off') dropCover();
        else {
            let seen = false;
            try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { /* 当作没看过 */ }
            playIntro(forced === 'full' || forced === 'short' ? forced : (seen ? 'short' : 'full'));
        }
        return api;
    };

    // dropCover：启动中途出错时由 music.js 撤掉开窗底色层，免得界面被挡住
    global.MusicIntroLib = { init, dropCover };
})(window);
