/*
 * 町景：雨夜里的城寨叠楼。管渲染器、档位、镜头导演和歌词状态；
 * 楼体、招牌与歌词屏、巷道与雨夜分别在 kowloon-city / kowloon-signs /
 * kowloon-alley 里，接口见各文件头。
 */
(function (global) {
    'use strict';
    const U = global.MusicStageModeUtils;
    const R = global.MusicStageRuntime;

    const ease = (t) => t * t * (3 - 2 * t);
    const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

    /*
     * 镜头：按歌曲段落排（前奏、主歌、预副歌、副歌、间奏、尾奏），每段有自己的一组机位。
     * 一个镜头 8–12 秒，只在乐句开头换；两个机位离得近就缓动过去，离得远（比如从
     * 半空到巷子里）就直接切，不让镜头穿楼。机位内都是慢速的升、移、推、绕。
     */
    const PHASES = ['intro', 'verse', 'prechorus', 'chorus', 'interlude', 'outro'];
    // 把歌词行排成段落：[{ start, end, phase }]。没有副歌标记时，把重复出现的句子当副歌。
    const planPhases = (lines, duration) => {
        const list = (lines || []).filter(l => l && Number.isFinite(l.startTime)).map(l => ({
            start: l.startTime, end: Number.isFinite(l.endTime) ? l.endTime : l.startTime + 3,
            text: String(l.fullText || '').trim(), chorus: Boolean(l.isChorus)
        }));
        if (!list.length) return [{ start: 0, end: Math.max(30, duration || 0) || 1e9, phase: 'interlude' }];
        if (!list.some(l => l.chorus)) {
            const seen = new Map();
            list.forEach((l, i) => { if (l.text.length >= 4) seen.set(l.text, (seen.get(l.text) || []).concat(i)); });
            seen.forEach(idx => { if (idx.length >= 2 && idx[idx.length - 1] - idx[0] > 3) idx.forEach(i => { list[i].chorus = true; }); });
        }
        const out = [];
        const push = (start, end, phase) => {
            if (end - start < 0.05) return;
            const last = out[out.length - 1];
            if (last && last.phase === phase) last.end = end;
            else out.push({ start, end, phase });
        };
        if (list[0].start > 3) push(0, list[0].start, 'intro');
        list.forEach((l, i) => {
            const next = list[i + 1];
            let phase = l.chorus ? 'chorus' : 'verse';
            // 副歌前的一两句（不超过 12 秒）算预副歌。
            if (!l.chorus) {
                for (let k = 1; k <= 2 && list[i + k]; k += 1) {
                    if (list[i + k].chorus && list[i + k].start - l.start <= 12) { phase = 'prechorus'; break; }
                    if (list[i + k].start - list[i + k - 1].end > 8) break;
                }
            }
            const until = next ? Math.min(next.start, l.end + 8) : l.end + 2;
            push(Math.min(l.start, out.length ? out[out.length - 1].end : l.start), until, phase);
            if (next && next.start - until > 0.05) push(until, next.start, 'interlude');
        });
        const tail = out[out.length - 1].end;
        push(tail, Math.max(tail + 12, duration || 0), 'outro');
        return out;
    };
    // 把段落切成镜头：每个 8–12 秒，切点吸附到最近的乐句开头。
    const planShots = (phases, lines) => {
        const starts = (lines || []).map(l => l?.startTime).filter(Number.isFinite);
        const snap = (t) => {
            let best = t, gap = 2.6;
            starts.forEach(s => { const d = Math.abs(s - t); if (d < gap) { gap = d; best = s; } });
            return best;
        };
        const shots = [];
        phases.forEach((p, pi) => {
            const len = p.end - p.start;
            // 前奏和尾奏各是一个长镜头，不切。
            const n = p.phase === 'intro' || p.phase === 'outro' ? 1 : Math.max(1, Math.round(len / 10));
            let from = p.start;
            for (let i = 1; i <= n; i += 1) {
                const to = i === n ? p.end : Math.max(from + 5, snap(p.start + len * i / n));
                if (to - from >= 3 || !shots.length) shots.push({ start: from, end: to, phase: p.phase, index: shots.length, block: pi, first: i === 1 });
                else shots[shots.length - 1].end = to;
                from = to;
                if (from >= p.end - 0.01) break;
            }
        });
        return shots;
    };

    const createDirector = (layout) => {
        const C = layout.CAMERA;
        const screen = layout.SCREENS.find(s => s.primary);
        const sc = screen.center;
        const orbitAt = (target, radius, height, az) => [target[0] + Math.sin(az) * radius, height, target[2] + Math.cos(az) * radius];
        const rigs = {
            iso: (t, seed) => {
                const a = (seed - 0.5) * 0.5 + (t - 0.5) * (C.iso.orbit * Math.PI / 180) * 0.6;
                const base = C.iso.position, target = C.iso.target;
                const dx = base[0] - target[0], dz = base[2] - target[2];
                const r = Math.hypot(dx, dz), a0 = Math.atan2(dx, dz) + a;
                const zoom = 1 - t * 0.08;
                return { position: [target[0] + Math.sin(a0) * r * zoom, base[1] * zoom, target[2] + Math.cos(a0) * r * zoom], look: target, fov: C.iso.fov };
            },
            street: (t, seed) => {
                const dir = seed < 0.5 ? 1 : -1;
                const k = dir > 0 ? t : 1 - t;
                const p = lerp3(C.street.from, C.street.to, 0.15 + k * 0.7);
                const look = [sc[0] + (p[0] - sc[0]) * 0.45, C.street.target[1], sc[2]];
                return { position: p, look, fov: C.street.fov };
            },
            screen: (t) => {
                const p = C.screen.position;
                const z = p[2] - t * 4;
                return { position: [p[0] - 6 + t * 3, p[1] - 3 + t * 1.5, z], look: C.screen.target, fov: C.screen.fov };
            },
            // 固定斜俯视：几道周期互不成倍数的慢正弦，绕、俯仰、推拉都很轻。
            diorama: (t, seed, time = 0) => {
                const wave = (period, phase) => Math.sin(time / period * Math.PI * 2 + phase);
                const base = C.iso.position, target = C.iso.target;
                const dx = base[0] - target[0], dz = base[2] - target[2];
                const r = Math.hypot(dx, dz, base[1] - target[1]);
                const az = Math.atan2(dx, dz) + (15 * wave(67, 0) + 5 * wave(29, 1.3)) * Math.PI / 180;
                const el = Math.asin((base[1] - target[1]) / r) + 4 * wave(47, 0.7) * Math.PI / 180;
                const k = r * Math.exp(0.06 * wave(41, 2.1));
                return {
                    position: [target[0] + Math.sin(az) * Math.cos(el) * k, target[1] + Math.sin(el) * k, target[2] + Math.cos(az) * Math.cos(el) * k],
                    look: target, fov: C.iso.fov
                };
            },
            roof: (t, seed) => {
                const from = seed < 0.5 ? C.roof.from : C.roof.to, to = seed < 0.5 ? C.roof.to : C.roof.from;
                const p = lerp3(from, to, 0.1 + t * 0.35);
                const ahead = lerp3(from, to, 0.6 + t * 0.35);
                return { position: p, look: [ahead[0], ahead[1] - 20, ahead[2]], fov: C.roof.fov };
            },
            // 前奏：从南面街上低处升起来，先是楼脚和招牌，升过屋顶后背后的巨构露出来。
            rise: (t) => {
                const k = ease(t);
                return { position: [sc[0] - 14 + k * 10, 5 + k * 62, 138 - k * 6], look: [sc[0] - 4, 16 + k * 52, 40 - k * 120], fov: 42 };
            },
            // 主歌：半空贴着正立面横移，主屏从画面一侧滑到另一侧，前景掠过全息幅和电线。
            facade: (t, seed) => {
                const dir = seed < 0.5 ? 1 : -1;
                const x = sc[0] + dir * (-26 + t * 52);
                return { position: [x, 25 + Math.sin(t * Math.PI) * 2.5, 85], look: [sc[0] + (x - sc[0]) * 0.4, sc[1] - 1.5, sc[2]], fov: 50 };
            },
            // 主歌：从高处降到主屏跟前。
            crane: (t, seed) => {
                const side = seed < 0.5 ? 1 : -1;
                const k = ease(t);
                return { position: [sc[0] + side * (30 - k * 16), 52 - k * 27, 108 - k * 24], look: [sc[0], sc[1] + 2 - k * 2, sc[2]], fov: 46 };
            },
            // 副歌：从牌楼前的人群平视起，镜头一边横移一边抬头，摇到主屏和它上面的天。
            hero: (t, seed) => {
                const G = layout.GATE || { x: sc[0] - 24, z: 61 };
                const k = ease(Math.min(1, t * 1.25));
                const from = [G.x, 3.2, G.z - 4], to = [sc[0], sc[1] + 3, sc[2] - 4];
                return { position: [G.x + 5 + ease(t) * (sc[0] - 1 - G.x - 5), 1.75 + k * 0.5, 67.4 + k * 1.2], look: lerp3(from, to, k), fov: 66 };
            },
            // 副歌：大全景环绕，城寨、全息幅、巨构、烟囱都在画面里。
            sweep: (t, seed) => {
                const dir = seed < 0.5 ? 1 : -1;
                const az = dir * (-0.55 + ease(t) * 0.8);
                const target = [4, 36, 6];
                return { position: orbitAt(target, 150 - t * 22, 50 + t * 24, az), look: target, fov: 50 };
            },
            // 间奏：掠过屋顶的天线林，朝着远处的巨构飞。
            skim: (t, seed) => {
                const side = seed < 0.5 ? 1 : -1;
                const p = [side * (-70 + t * 60), 54 - t * 4, 66 - t * 70];
                return { position: p, look: [p[0] + side * 60, 62, p[2] - 160], fov: 58 };
            },
            // 尾奏：从斜俯视慢慢拉远升高。
            pullback: (t) => {
                const k = ease(t);
                const base = C.iso.position, target = C.iso.target;
                return { position: [base[0] + k * 46, base[1] + k * 52, base[2] + k * 84], look: [target[0], target[1] + k * 22, target[2] - k * 30], fov: C.iso.fov };
            }
        };
        // 各段落能用的机位。巷道模块给的机位按它自己标的 phase 归进来。
        const POOLS = {
            intro: ['rise'],
            verse: ['facade', 'crane', 'street', 'screen', 'iso'],
            prechorus: ['street', 'screen'],
            chorus: ['sweep', 'hero', 'iso', 'sweep'],
            interlude: ['skim', 'roof'],
            outro: ['pullback']
        };
        // 贴近地面或在巷子里的机位：和半空机位之间不做缓动，直接切。
        let extra = [];
        const L = () => global.MusicStageKowloonLayout;
        const poolFor = (phase) => {
            const mine = POOLS[phase] || POOLS.verse;
            const theirs = extra.filter(r => (r.phase || 'interlude') === phase || (phase === 'prechorus' && !r.phase)).map(r => r.id);
            // 预副歌优先进巷子；间奏巷子和屋顶各半。
            if (phase === 'prechorus' && theirs.length) return theirs.concat(mine[0]);
            return mine.concat(theirs);
        };
        const evalRig = (shot, time) => {
            const t = Math.min(1, Math.max(0, (time - shot.start) / Math.max(0.1, shot.end - shot.start)));
            if (rigs[shot.id]) return rigs[shot.id](t, shot.seed, time);
            const rig = extra.find(r => r.id === shot.id);
            if (rig) {
                const f = t * (rig.points.length - 1);
                const i = Math.min(rig.points.length - 2, Math.floor(f));
                const k = f - i;
                return { position: lerp3(rig.points[i], rig.points[i + 1], k), look: lerp3(rig.look[i], rig.look[i + 1], k), fov: rig.fov || 55 };
            }
            return rigs.iso(t, shot.seed);
        };
        let plan = null, planKey = null, current = null, previous = null;
        const ensurePlan = (frame) => {
            const lines = frame.lines || [];
            const key = `${lines.length}:${lines[0]?.startTime}:${lines[lines.length - 1]?.startTime}:${extra.length}`;
            if (plan && planKey === key) return plan;
            const phases = planPhases(lines, frame.duration || frame.track?.duration || 0);
            const shots = planShots(phases, lines);
            let last = null, before = null;
            const seenPhase = {};
            shots.forEach(shot => {
                const pool = poolFor(shot.phase);
                const seed = (L().hash(`shot:${shot.index}:${Math.round(shot.start)}`) % 1000) / 1000;
                // 段落的第一个镜头固定用这一段的主机位，后面的轮着来，不和上一个重复。
                // 每段的第一个镜头按这一段第几次出现轮着换，同一段歌再来时不重样。
                seenPhase[shot.phase] = (seenPhase[shot.phase] || 0) + (shot.first ? 1 : 0);
                let id = pool[(seenPhase[shot.phase] - 1) % pool.length];
                if (shot.first && shot.phase === 'chorus') id = seenPhase.chorus % 2 ? 'sweep' : 'hero';
                else if (!shot.first) {
                    const fresh = pool.filter((r, i) => r !== last && r !== before && pool.indexOf(r) === i);
                    const rest = fresh.length ? fresh : pool.filter(r => r !== last);
                    id = rest.length ? rest[Math.floor(seed * rest.length)] : pool[0];
                }
                shot.id = id; shot.seed = seed;
                before = last; last = id;
            });
            plan = { phases, shots }; planKey = key;
            return plan;
        };
        /*
         * 沙盒截面：把切出来的那块城寨当桌上的模型看。平行投影、斜俯视，镜头不切，
         * 只跟着段落慢慢换角度和远近：主歌看整块，预副歌凑近东面的剖面，
         * 副歌正对歌词屏，间奏转到西面。
         */
        const SANDBOX_VIEWS = {
            intro: { az: 40, el: 40, size: 66, target: [4, 12, 40] },
            verse: { az: 40, el: 30, size: 45, target: [4, 15, 40] },
            prechorus: { az: 60, el: 26, size: 40, target: [22, 15, 42] },
            chorus: { az: 20, el: 23, size: 37, target: [8, 17, 52] },
            interlude: { az: -38, el: 31, size: 45, target: [4, 15, 40] },
            outro: { az: 46, el: 36, size: 70, target: [4, 10, 40] }
        };
        const sandboxNow = { az: 40, el: 30, size: 54, target: [4, 13, 40], at: null };
        const sandboxPose = (phase, time) => {
            const goal = SANDBOX_VIEWS[phase] || SANDBOX_VIEWS.verse;
            const dt = sandboxNow.at === null ? Infinity : time - sandboxNow.at;
            sandboxNow.at = time;
            // 拖进度条或刚进来：直接到位；平时用几秒钟慢慢靠过去。
            const k = dt < 0 || dt > 1.5 ? 1 : 1 - Math.exp(-dt * 0.55);
            ['az', 'el', 'size'].forEach(key => { sandboxNow[key] += (goal[key] - sandboxNow[key]) * k; });
            sandboxNow.target = lerp3(sandboxNow.target, goal.target, k);
            const az = (sandboxNow.az + Math.sin(time * 0.071) * 7) * Math.PI / 180;
            const el = (sandboxNow.el + Math.sin(time * 0.053 + 1.1) * 1.5) * Math.PI / 180;
            const FOV = 30, distance = sandboxNow.size / Math.tan(FOV * Math.PI / 360);
            const t = sandboxNow.target;
            return {
                position: [t[0] + Math.sin(az) * Math.cos(el) * distance, t[1] + Math.sin(el) * distance, t[2] + Math.cos(az) * Math.cos(el) * distance],
                look: [t[0], t[1], t[2]], fov: FOV, ortho: true
            };
        };
        const shotAt = (shots, time) => {
            for (let i = shots.length - 1; i >= 0; i -= 1) if (time >= shots[i].start) return shots[i];
            return shots[0];
        };
        const director = {
            force: null,
            setExtraRigs(list) { extra = Array.isArray(list) ? list.filter(r => r?.points?.length >= 2) : []; plan = null; },
            mode: 'auto',
            plan: (frame) => ensurePlan(frame),
            phaseAt(frame, time) { return shotAt(ensurePlan(frame).shots, time).phase; },
            pose(frame, time) {
                const phase = director.phaseAt(frame, time);
                if (director.mode === 'sandbox' && !director.force) return { id: 'sandbox', phase, ...sandboxPose(phase, time) };
                if (director.mode === 'diorama' && !director.force) return { id: 'diorama', phase, ...rigs.diorama(0, 0, time) };
                if (director.force?.position) return { id: 'custom', phase, fov: 60, ...director.force };
                if (director.force) {
                    const { id, t } = director.force;
                    return { id, phase, ...evalRig({ id, seed: 0.3, start: 0, end: 1 }, t) };
                }
                const next = shotAt(ensurePlan(frame).shots, time);
                if (!current || (!director.hold && next !== current)) {
                    // 往回拖进度条或换歌：不过渡。
                    previous = current && Math.abs(time - current.end) < 1.5 ? { shot: current, at: time } : null;
                    current = next;
                    if (previous) {
                        const a = evalRig(previous.shot, time), b = evalRig(current, time);
                        const far = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]) > 70;
                        // 离得远就切；副歌第一拍也切，要的就是那一下。
                        if (far || (current.first && current.phase === 'chorus')) previous = null;
                    }
                }
                const now = evalRig(current, time);
                // 一点点呼吸感：位置上几厘米到几十厘米的慢漂。
                const breathe = Math.min(0.5, Math.hypot(now.position[0] - now.look[0], now.position[2] - now.look[2]) * 0.004);
                now.position = [now.position[0] + Math.sin(time * 0.37) * breathe, now.position[1] + Math.sin(time * 0.29 + 1.3) * breathe * 0.6, now.position[2]];
                const BLEND = 2.2;
                if (previous && time - previous.at < BLEND) {
                    const before = evalRig(previous.shot, time);
                    const k = ease((time - previous.at) / BLEND);
                    return { id: current.id, phase, position: lerp3(before.position, now.position, k), look: lerp3(before.look, now.look, k), fov: before.fov + (now.fov - before.fov) * k };
                }
                return { id: current.id, phase, ...now };
            },
            reset() { current = previous = null; plan = null; sandboxNow.at = null; }
        };
        return director;
    };

    // 截图脚本用：拿到最近一个实例，固定机位。
    let lastInstance = null;
    /*
     * 拖拽看景：按住拖动绕着当前机位的注视点转、滚轮推拉；松手 8 秒后慢慢
     * 回到导演给的机位。只是叠在机位上的偏移，不改导演的安排。
     */
    const createOrbit = () => {
        const view = { az: 0, el: 0, zoom: 1 };
        let dragging = null, idleSince = -Infinity, wake = () => {};
        const LIMIT = { az: 75 * Math.PI / 180, elMin: -25 * Math.PI / 180, elMax: 30 * Math.PI / 180, zMin: 0.35, zMax: 2.2 };
        const clampView = () => {
            view.az = Math.max(-LIMIT.az, Math.min(LIMIT.az, view.az));
            view.el = Math.max(LIMIT.elMin, Math.min(LIMIT.elMax, view.el));
            view.zoom = Math.max(LIMIT.zMin, Math.min(LIMIT.zMax, view.zoom));
        };
        return {
            attach(scope, element, onWake) {
                wake = onWake;
                scope.listen(element, 'pointerdown', event => {
                    if (event.button !== 0) return;
                    dragging = { x: event.clientX, y: event.clientY, id: event.pointerId };
                    element.setPointerCapture?.(event.pointerId);
                    element.style.cursor = 'grabbing';
                });
                scope.listen(element, 'pointermove', event => {
                    if (!dragging || event.pointerId !== dragging.id) return;
                    view.az -= (event.clientX - dragging.x) * 0.005;
                    view.el += (event.clientY - dragging.y) * 0.004;
                    dragging.x = event.clientX; dragging.y = event.clientY;
                    clampView(); idleSince = performance.now(); wake();
                });
                const end = event => {
                    if (!dragging || event.pointerId !== dragging.id) return;
                    dragging = null; idleSince = performance.now(); element.style.cursor = '';
                };
                scope.listen(element, 'pointerup', end);
                scope.listen(element, 'pointercancel', end);
                scope.listen(element, 'wheel', event => {
                    event.preventDefault();
                    view.zoom *= Math.exp(event.deltaY * 0.0012);
                    clampView(); idleSince = performance.now(); wake();
                }, { passive: false });
                scope.listen(element, 'dblclick', () => { view.az = view.el = 0; view.zoom = 1; wake(); });
            },
            get active() { return Boolean(dragging) || performance.now() - idleSince < 8000 || Math.abs(view.az) + Math.abs(view.el) + Math.abs(view.zoom - 1) > 0.002; },
            // 每帧：闲着够久就往回收；返回叠加了偏移的机位。
            apply(pose, dt) {
                if (!dragging && performance.now() - idleSince > 8000) {
                    const k = 1 - Math.exp(-Math.max(0, dt) * 1.2);
                    view.az -= view.az * k; view.el -= view.el * k; view.zoom += (1 - view.zoom) * k;
                }
                if (Math.abs(view.az) + Math.abs(view.el) + Math.abs(view.zoom - 1) < 1e-4) return pose;
                const [px, py, pz] = pose.position, [lx, ly, lz] = pose.look;
                const dx = px - lx, dy = py - ly, dz = pz - lz;
                const r = Math.hypot(dx, dy, dz);
                const az = Math.atan2(dx, dz) + view.az;
                const el = Math.max(-0.2, Math.min(1.45, Math.asin(dy / r) + view.el));
                const k = r * view.zoom;
                return { ...pose, position: [lx + Math.sin(az) * Math.cos(el) * k, Math.max(0.8, ly + Math.sin(el) * k), lz + Math.cos(az) * Math.cos(el) * k] };
            }
        };
    };

    const create = (container, services) => {
        const mode = U.makeModeBase('kowloon', '町景', container, services);
        const fallback = U.createElement('div', 'kowloon-fallback diorama-fallback');
        const fallbackLine = U.createElement('div', 'diorama-fallback-line');
        const translation = U.createElement('div', 'stage-translation diorama-fallback-translation');
        fallback.append(fallbackLine, translation);
        mode.root.append(fallback);
        const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let T, scene, camera, renderer, layout, city, signs, alley, optics, sandbox, director, shared, placeholderLights = [];
        let initialized = false, fallbackMode = false, initializing = null;
        let latest = null, lastTime = null, width = 1, height = 1, shotId = '';
        /*
         * 取景避让：机位是按 16:9、画面中心构图的，但窗口底部有播放条、顶上有标题栏、右边
         * 可能开着抽屉。每半秒量一次这些浮层占掉的边，把画面的光学中心挪到剩下那块安全区
         * 的中间（离轴投影，不动机位），窗口比 16:9 窄时把视角放宽，保住横向取景。
         */
        const frame2d = { top: 0, right: 0, bottom: 0, left: 0, measuredAt: -1e9, cur: { x: 0, y: 0, widen: 1 } };
        const OVERLAYS = [
            ['.music-stage-top-chrome', 'top'], ['.music-stage-transport', 'bottom'],
            ['.md-dock', 'bottom'], ['.md-pnl.md-open', 'right'], ['.music-stage-settings-panel.is-open', 'right']
        ];
        const measureInsets = (now) => {
            if (now - frame2d.measuredAt < 500) return;
            frame2d.measuredAt = now;
            const doc = mode.root.ownerDocument;
            const box = mode.root.getBoundingClientRect();
            const next = { top: 0, right: 0, bottom: 0, left: 0 };
            OVERLAYS.forEach(([selector, side]) => {
                doc.querySelectorAll(selector).forEach(el => {
                    const style = global.getComputedStyle?.(el);
                    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return;
                    const r = el.getBoundingClientRect();
                    if (r.width < 4 || r.height < 4) return;
                    if (side === 'top') next.top = Math.max(next.top, r.bottom - box.top);
                    if (side === 'bottom') next.bottom = Math.max(next.bottom, box.bottom - r.top);
                    if (side === 'right' && r.left > box.left + box.width * 0.4) next.right = Math.max(next.right, box.right - r.left);
                });
            });
            const dock = parseFloat(global.getComputedStyle?.(doc.body).getPropertyValue('--music-dock-safe-bottom')) || 0;
            next.bottom = Math.max(next.bottom, dock);
            // 浮层再大也只让出画面的一部分，免得构图被挤没。
            frame2d.top = Math.min(next.top, height * 0.2);
            frame2d.bottom = Math.min(next.bottom, height * 0.3);
            frame2d.right = Math.min(next.right, width * 0.45);
        };
        const DESIGN_ASPECT = 16 / 9;
        const applyFraming = (pose, dt) => {
            measureInsets(performance.now());
            const safeW = Math.max(1, width - frame2d.right - frame2d.left), safeH = Math.max(1, height - frame2d.top - frame2d.bottom);
            const targetX = (frame2d.right - frame2d.left) / 2;
            const targetY = (frame2d.bottom - frame2d.top) / 2;
            // 安全区比设计画幅窄多少，就把视角放宽多少（上限 1.9 倍）；被上下浮层吃掉的高度补一半。
            const targetWiden = Math.min(1.9, Math.max(1, DESIGN_ASPECT / (safeW / height)) * (1 + (1 - safeH / height) * 0.5));
            const k = dt > 0 ? Math.min(1, dt * 4) : 1;
            const cur = frame2d.cur;
            cur.x += (targetX - cur.x) * k; cur.y += (targetY - cur.y) * k; cur.widen += (targetWiden - cur.widen) * k;
            const fov = Math.min(100, 2 * Math.atan(Math.tan(pose.fov * Math.PI / 360) * cur.widen) * 180 / Math.PI);
            const ox = Math.round(cur.x), oy = Math.round(cur.y);
            const view = camera.view;
            const changed = Math.abs(camera.fov - fov) > 1e-3 || (view?.offsetX || 0) !== ox || (view?.offsetY || 0) !== oy
                || (view && (view.fullWidth !== width || view.fullHeight !== height));
            if (!changed) return;
            camera.fov = fov;
            if (ox || oy) camera.setViewOffset(width, height, ox, oy, width, height);
            else if (view?.enabled) camera.clearViewOffset();
            camera.updateProjectionMatrix();
        };

        // 沙盒截面用平行投影：画面高度取「机位到注视点的距离 × 视角」，所以拖拽推拉、
        // 窄窗放宽、让开浮层这些照常起作用；相机本身退到固定的远处，不会钻进楼里。
        const SANDBOX_FOG = 0.035, ORTHO_DISTANCE = 300;
        let wasOrtho = false, wasBoxed = false, skyKeep = null, skyLift = null;
        const applyOrtho = (pose) => {
            if (!pose.ortho) {
                if (wasOrtho) { wasOrtho = false; camera.updateProjectionMatrix(); }
                return;
            }
            wasOrtho = true;
            const dx = pose.position[0] - pose.look[0], dy = pose.position[1] - pose.look[1], dz = pose.position[2] - pose.look[2];
            const distance = Math.hypot(dx, dy, dz) || 1;
            const halfH = distance * Math.tan(camera.fov * Math.PI / 360), halfW = halfH * width / height;
            const k = ORTHO_DISTANCE / distance;
            camera.position.set(pose.look[0] + dx * k, pose.look[1] + dy * k, pose.look[2] + dz * k);
            camera.lookAt(pose.look[0], pose.look[1], pose.look[2]);
            const sx = Math.round(frame2d.cur.x) / width * 2 * halfW, sy = Math.round(frame2d.cur.y) / height * 2 * halfH;
            camera.projectionMatrix.makeOrthographic(-halfW + sx, halfW + sx, halfH - sy, -halfH - sy, 1, 900);
            camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        };

        let dirty = true, lastWall = 0, canvasSmoothing = true, placeholderGround = null, lastDrawnQuality = null;
        const orbit = createOrbit();
        const cap = U.createFrameCap();
        const onset = R.createAudioOnset();
        const audio = { energy: 0, bass: 0, vocal: 0, impact: 0 };
        const palette = () => services?.app?.stagePalette || {};
        const renderScale = U.createRenderScale();
        const drawn = () => renderScale.config(mode.config);
        const wantsCanvasSmoothing = () => !(global.MusicStageDioramaOptics?.active(mode.config, mode.config.modes?.kowloon || {}) ?? false);
        const options = () => ({ ...(mode.config.modes?.kowloon || {}), reducedMotion: global.MusicStageRuntime.isReducedMotion(reduced), quality: drawn().quality });
        const lensObj = { postProcess: undefined, cabin: 0, threshold: 0.95, glow: 1.1, grain: 0.06, vignette: 0.28 };
        const showCaption = () => !signs;

        const renderFallback = frame => {
            const key = U.getLineKey(frame.activeLine);
            if (fallbackLine.dataset.key !== key) {
                fallbackLine.dataset.key = key;
                if (frame.activeLine) U.renderWords(fallbackLine, frame, 'diorama-word');
                else fallbackLine.textContent = frame.track?.title || '等待音乐';
                translation.textContent = R.resolveSupplementalText(frame.activeLine);
            }
            U.updateWords(Array.from(fallbackLine.children), frame.wordStates || []);
        };
        const resize = () => {
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            if (!renderer) return;
            renderer.setPixelRatio(renderScale.ratio(drawn().quality, width, height));
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        };
        const moduleList = [];
        const syncModules = () => {
            moduleList.length = 0;
            if (alley) moduleList.push(alley);
            if (city) moduleList.push(city);
            if (signs) moduleList.push(signs);
        };
        const modules = () => moduleList;
        const lightGroups = [];
        const sandboxViewer = { position: { x: 0, y: 0, z: 0 } };
        const disposeGraphics = () => {
            for (let i = 0; i < moduleList.length; i += 1) {
                try { moduleList[i].dispose(); } catch (error) { console.warn('[MusicStage:Kowloon] dispose', error); }
            }
            optics?.destroy();
            try { sandbox?.dispose(); } catch (error) { console.warn('[MusicStage:Kowloon] dispose', error); }
            if (placeholderGround) {
                placeholderGround.geometry?.dispose();
                placeholderGround.material?.dispose();
                placeholderGround = null;
            }
            city = signs = alley = optics = sandbox = null;
            moduleList.length = 0;
            const oldRenderer = renderer;
            renderer = camera = scene = null;
            oldRenderer?.dispose();
            if (R.releaseWebGLContext) R.releaseWebGLContext(oldRenderer);
            else oldRenderer?.forceContextLoss();
            oldRenderer?.domElement?.remove?.();
            initialized = false;
            lastDrawnQuality = null;
            dirty = true;
        };

        const lyricState = (frame, time) => {
            const line = frame.activeLine;
            if (!line) return { key: '', line: null, words: [], progress: 0, translation: '', next: frame.nextLines?.[0] ? { text: frame.nextLines[0].fullText } : null, prev: frame.previousLine ? { text: frame.previousLine.fullText } : null };
            const words = (frame.wordStates || []).map(w => ({ text: w.text, start: w.startTime, end: w.endTime, progress: w.progress, status: w.status }));
            return {
                key: U.getLineKey(line), line: line.fullText, words, progress: frame.lineProgress || 0,
                start: line.startTime, end: line.endTime, isChorus: Boolean(line.isChorus),
                translation: R.resolveSupplementalText(line),
                next: frame.nextLines?.[0] ? { text: frame.nextLines[0].fullText } : null,
                prev: frame.previousLine ? { text: frame.previousLine.fullText } : null,
                time
            };
        };

        const update = (frame, force = false) => {
            if (mode.destroyed || mode.suspended) return;
            latest = frame;
            if (!initialized) {
                renderFallback(frame);
                if (!fallbackMode) void initialize();
                return;
            }
            const activeConfig = drawn();
            const still = !frame.isPlaying && lastTime !== null && R.finiteNumber(frame.playbackTime) === lastTime;
            if (!force && !dirty && (still || !cap.take(performance.now(), activeConfig.quality))) return;
            dirty = false;
            const time = R.finiteNumber(frame.playbackTime);
            const dt = lastTime === null ? 0 : Math.max(0, Math.min(0.25, time - lastTime));
            const live = onset.update(frame);
            const gain = R.clamp((mode.config.modes?.kowloon?.audioReactivity) ?? 1, 0, 2);
            audio.energy = live.energy * gain;
            audio.impact = live.impact * gain;
            audio.bass = R.clamp(frame.audio?.bass) * gain;
            audio.vocal = R.clamp(frame.audio?.vocal) * gain;

            const settings = options();
            director.mode = ['diorama', 'sandbox'].includes(settings.cameraMode) && (settings.cameraMode !== 'sandbox' || sandbox) ? settings.cameraMode : 'auto';
            // 看景时导演不换机位，免得手里的画面被切走。
            director.hold = orbit.active;
            const pose = orbit.apply(director.pose(frame, time), performance.now() / 1000 - (lastWall || performance.now() / 1000));
            lastWall = performance.now() / 1000;
            if (pose.id !== shotId) shotId = pose.id;
            camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
            camera.lookAt(pose.look[0], pose.look[1], pose.look[2]);
            applyFraming(pose, dt);
            applyOrtho(pose);
            camera.updateMatrixWorld();

            const state = {
                time: settings.reducedMotion ? 0 : time, dt, playbackTime: time, isPlaying: frame.isPlaying,
                audio, lyric: lyricState(frame, time), camera, shot: pose.id, phase: pose.phase || 'verse', options: settings,
                lines: frame.lines || [],
                track: { title: services?.app?.stripAudioExtension?.(frame.track?.title) || frame.track?.title || '', artist: frame.track?.artist || '' }
            };
            state.song = state.track;
            shared.uTime.value = state.time;
            // 沙盒截面：告诉各模块现在看的是哪一块、焦点在哪（雨、近景细节跟着焦点走，不跟远处的相机）。
            const boxed = Boolean(pose.ortho && sandbox);
            state.sandbox = boxed ? sandbox.box : null;
            state.focus = boxed ? pose.look : null;
            if (boxed !== wasBoxed) {
                wasBoxed = boxed;
                for (let i = 0; i < moduleList.length; i += 1) moduleList[i].setSandbox?.(boxed ? sandbox.box : null);
            }
            // 渲染顺序：巷道先（它要画积水反射），再楼体、招牌。
            for (let i = 0; i < moduleList.length; i += 1) moduleList[i].update(state);
            sandbox?.update(boxed, camera, state);
            // 沙盒里相机在两百多米外，灯按离焦点的远近挑；雾也只算盒子里这一段。
            let viewer = camera;
            if (boxed) {
                sandboxViewer.position.x = pose.look[0];
                sandboxViewer.position.y = pose.look[1] + 4;
                sandboxViewer.position.z = pose.look[2] + 14;
                viewer = sandboxViewer;
            }
            lightGroups.length = 0;
            for (let i = 0; i < moduleList.length; i += 1) {
                const ml = moduleList[i].lights?.();
                if (ml) lightGroups.push(ml);
            }
            if (!signs && placeholderLights.length) lightGroups.push(placeholderLights);
            global.MusicStageKowloonShared.gatherLights(shared, lightGroups, viewer);
            const fogDensity = scene.fog?.density;
            if (boxed && scene.fog) scene.fog.density = fogDensity * SANDBOX_FOG;
            // 从上往下看，屋顶占了大半画面：给一层偏冷的天光，天台上的东西才看得清。
            // 街上那层暖光收一半，墙面才不会整块发橙。
            const glowKeep = shared.uGlowStrength.value;
            if (boxed) { skyKeep.copy(shared.uSky.value); shared.uSky.value.multiplyScalar(1.6).add(skyLift); shared.uGlowStrength.value = glowKeep * 0.5; }

            if (showCaption()) { fallback.hidden = false; renderFallback(frame); }
            else fallback.hidden = true;
            if (frame.isPlaying && renderScale.tick(performance.now(), cap.aim(activeConfig.quality))) {
                resize();
                const nextQ = drawn().quality;
                if (nextQ !== lastDrawnQuality) {
                    lastDrawnQuality = nextQ;
                    const nextTier = { name: nextQ || 'standard', ...U.tier(nextQ) };
                    for (let i = 0; i < moduleList.length; i += 1) moduleList[i].setTier?.(nextTier);
                }
            }
            renderer.info.reset();
            const tuned = mode.config.modes?.kowloon || {};
            lensObj.postProcess = tuned.postProcess;
            lensObj.cabin = tuned.cabin || 0;
            lensObj.threshold = tuned.threshold ?? 0.95;
            lensObj.glow = tuned.glow ?? 1.1;
            lensObj.grain = tuned.grain ?? 0.06;
            lensObj.vignette = tuned.vignette ?? 0.28;
            if (optics) optics.render(renderer, scene, camera, settings.reducedMotion ? 0 : time, drawn(), lensObj);
            else renderer.render(scene, camera);
            if (boxed && scene.fog) scene.fog.density = fogDensity;
            if (boxed) { shared.uSky.value.copy(skyKeep); shared.uGlowStrength.value = glowKeep; }
            lastTime = time;
        };

        const initialize = () => {
            if (initializing) return initializing;
            initializing = Promise.resolve().then(async () => {
                if (!global.MusicStageKowloonLayout || !global.MusicStageKowloonCity || !global.MusicStageKowloonShared) {
                    throw new Error('Kowloon modules are unavailable');
                }
                T = global.THREE || await import('../../../vendor/three.module.js');
                if (mode.destroyed) return;
                scene = new T.Scene();
                scene.background = new T.Color(0x0b1018);
                scene.fog = new T.FogExp2(0x101822, 0.0042);
                camera = new T.PerspectiveCamera(32, 1, 0.3, 2400);
                // 第 3 层：只给主相机、不进倒影的东西（屋顶杂物、雨丝等）。
                camera.layers.enable(3);
                canvasSmoothing = wantsCanvasSmoothing();
                renderer = new T.WebGLRenderer({ antialias: canvasSmoothing, alpha: false, powerPreference: 'high-performance' });
                renderer.debug.checkShaderErrors = false;
                renderer.outputColorSpace = T.SRGBColorSpace;
                renderer.toneMapping = T.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.1;
                renderer.info.autoReset = false;
                renderer.domElement.className = 'diorama-canvas kowloon-canvas';
                mode.root.insertBefore(renderer.domElement, fallback);
                const canvas = renderer.domElement;
                canvas.style.touchAction = 'none';
                orbit.attach(mode.scope, canvas, () => { dirty = true; if (latest && !latest.isPlaying) update(latest, true); });
                mode.scope.listen(canvas, 'webglcontextlost', event => {
                    event.preventDefault();
                    if (renderer?.domElement !== canvas) return;
                    fallbackMode = true;
                    disposeGraphics();
                    if (latest) renderFallback(latest);
                });
                layout = global.MusicStageKowloonLayout.build('kowloon');
                shared = global.MusicStageKowloonShared.createLightUniforms(T);
                skyKeep = new T.Color(); skyLift = new T.Color(0.035, 0.05, 0.075);
                const initQuality = drawn().quality;
                lastDrawnQuality = initQuality;
                const tier = { name: initQuality || 'standard', ...U.tier(initQuality) };
                const ctx = { scene, renderer, camera, layout, palette: palette(), tier, options: options(), lightUniforms: shared, rand: s => global.MusicStageKowloonLayout.rng(s) };
                await U.breathe();
                if (mode.destroyed || !renderer) return;
                // 巷道先建：它定雾、天空和湿度。
                if (global.MusicStageKowloonAlley?.create) alley = global.MusicStageKowloonAlley.create(T, ctx);
                await U.breathe();
                if (mode.destroyed || !renderer) return;
                city = global.MusicStageKowloonCity.create(T, ctx);
                ctx.city = city; ctx.alley = alley;
                await U.breathe();
                if (mode.destroyed || !renderer) return;
                if (global.MusicStageKowloonSigns?.create) {
                    ctx.asyncPaint = true;
                    signs = global.MusicStageKowloonSigns.create(T, ctx);
                    if (typeof signs?.paintAsync === 'function') {
                        await signs.paintAsync(() => !mode.destroyed && !!renderer);
                        if (mode.destroyed || !renderer) return;
                    }
                }
                syncModules();
                if (!alley) {
                    // 巷道模块还没并进来：先铺一块湿地面，好看楼体落地。
                    shared.uWet.value = 0.7;
                    placeholderGround = new T.Mesh(new T.PlaneGeometry(1200, 1200), new T.MeshBasicMaterial({ color: 0x07090c }));
                    placeholderGround.rotation.x = -Math.PI / 2;
                    placeholderGround.name = 'kowloon-placeholder-ground';
                    scene.add(placeholderGround);
                }
                // 招牌模块还没并进来时，用一组占位霓虹光看楼体受光。
                placeholderLights = signs ? [] : layout.slots(sl => sl.use === 'sign' && sl.floor <= 4)
                    .filter((_, i) => i % 7 === 0).map((sl, i) => ({
                        position: [sl.pos[0] + sl.normal[0] * 1.2, sl.pos[1], sl.pos[2] + sl.normal[2] * 1.2],
                        color: [[1, 0.2, 0.55], [0.2, 0.9, 1], [1, 0.55, 0.15], [0.4, 1, 0.5], [0.7, 0.3, 1]][i % 5],
                        intensity: 1.6, radius: 9
                    }));
                if (global.MusicStageKowloonSandbox?.create) {
                    await U.breathe();
                    if (mode.destroyed || !renderer) return;
                    sandbox = global.MusicStageKowloonSandbox.create(T, ctx);
                    sandbox.setPalette(palette());
                    sandbox.scan();
                }
                director = createDirector(layout);
                director.setExtraRigs(alley?.cameraRigs?.());
                modules().forEach(m => m.setTier?.(tier));
                optics = global.MusicStageDioramaOptics?.create(T);
                resize();
                // 分层雾补丁必须在着色器预热前挂到所有材质上，否则首帧 hazeScan 会让预热结果全部作废并同步重编译。
                alley?.prepareHaze?.();
                const alive = () => !mode.destroyed && !!renderer;
                await U.precompile(T, renderer, scene, camera, { canvas: canvasSmoothing, offscreen: true, report: false, alive });
                if (!alive()) return;
                if (!canvasSmoothing) await optics?.precompile?.(renderer);
                if (!alive()) return;
                await U.settlePrograms(renderer, alive);
                if (mode.destroyed || !renderer) return;
                initialized = true;
                dirty = true;
                if (latest) update(latest, true);
            }).catch(error => {
                disposeGraphics();
                fallbackMode = true;
                if (!mode.destroyed) {
                    console.warn('[MusicStage:Kowloon] 使用文字降级：', error);
                    if (latest) renderFallback(latest);
                }
            });
            return initializing;
        };

        mode.updateFrame = frame => update(frame);
        mode.resize = () => { resize(); if (latest && initialized) update(latest, true); };
        const baseConfig = mode.updateConfig;
        mode.updateConfig = config => {
            if (config?.quality !== mode.config.quality) renderScale.reset();
            baseConfig(config);
            if (initialized && canvasSmoothing !== wantsCanvasSmoothing()) {
                disposeGraphics();
                initializing = null;
                void initialize();
                return;
            }
            if (initialized) {
                const q = drawn().quality;
                lastDrawnQuality = q;
                const tier = { name: q || 'standard', ...U.tier(q) };
                modules().forEach(m => { m.setTier?.(tier); m.setOptions?.(options()); });
            }
            resize();
            if (latest) update(latest, true);
        };
        mode.updateTheme = () => {
            if (initialized) { modules().forEach(m => m.setPalette?.(palette())); sandbox?.setPalette(palette()); }
            if (latest) update(latest, true);
        };
        const resume = mode.resume;
        mode.resume = () => { resume(); cap.reset(); if (latest) update(latest, true); };
        mode.scope.listen(global, 'music-motion-change', () => {
            dirty = true;
            if (latest && initialized) update(latest, true);
        });
        mode.getDegrade = () => ({ steps: renderScale.steps, quality: drawn().quality });
        mode.getDebugSnapshot = () => ({
            initialized, fallbackMode, shot: shotId, framing: { ...frame2d.cur, top: frame2d.top, right: frame2d.right, bottom: frame2d.bottom, fov: camera?.fov },
            camera: camera?.position.toArray(),
            pixelRatio: renderer?.getPixelRatio(), renderScale: renderScale.factor,
            degradeSteps: renderScale.steps, drawnQuality: drawn().quality, canvasSmoothing,
            drawCalls: renderer?.info.render.calls, triangles: renderer?.info.render.triangles,
            geometries: renderer?.info.memory.geometries, textures: renderer?.info.memory.textures,
            programs: renderer?.info.programs?.length,
            lights: shared?.uLightCount.value,
            ...(initialized ? Object.assign({}, ...modules().map(m => m.stats?.() || {}), sandbox?.stats() || {}) : null)
        });
        // harness 用：固定机位截图。
        mode.debugScene = () => ({ scene, camera, renderer, T });
        mode.debugPlan = () => (director && latest ? director.plan(latest) : null);
        mode.debugTime = (t) => { if (latest) { latest = { ...latest, playbackTime: t }; dirty = true; update(latest, true); } };
        mode.debugSetShot = (id, t = 0.5) => { if (director) director.force = id && typeof id === 'object' ? id : id ? { id, t } : null; dirty = true; if (latest) update(latest, true); };
        mode.scope.add(() => { disposeGraphics(); latest = null; });
        resize();
        void initialize();
        lastInstance = mode;
        return mode;
    };

    global.MusicStageKowloonManager = Object.freeze({ create, createDirector, planPhases, planShots, PHASES, debugInstance: () => lastInstance });
})(window);
