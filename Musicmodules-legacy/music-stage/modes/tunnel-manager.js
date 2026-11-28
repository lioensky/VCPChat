(function (global) {
    'use strict';

    const U = global.MusicStageModeUtils;
    const R = global.MusicStageRuntime;
    if (!U || !R) throw new Error('MusicStage utilities must load before tunnel-manager.js');

    const { clamp, finiteNumber, hashString, seededRandom, splitGraphemes, buildGlyphTimeline } = R;

    const smooth = (v) => { const p = clamp(v); return p * p * (3 - 2 * p); };
    const smoother = (v) => { const p = clamp(v); return p * p * p * (p * (p * 6 - 15) + 10); };
    const easeOutCubic = (v) => { const p = clamp(v); return 1 - Math.pow(1 - p, 3); };
    const easeInCubic = (v) => { const p = clamp(v); return p * p * p; };
    const mix = (a, b, t) => a + (b - a) * t;
    const TAU = Math.PI * 2;

    const upperBound = (items, value, key) => {
        let lo = 0;
        let hi = items.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const itemVal = key ? items[mid][key] : items[mid];
            if (itemVal <= value) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    const blendAngle = (a, b, weight) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * weight;

    // Where the key light comes from, and where the sun that casts it hangs in
    // the sky. The sun is drawn further into the frame than the light strictly
    // allows, so bodies keep a lit face while it stays in the picture.
    const unit = (v) => { const length = Math.hypot(...v); return v.map((n) => n / length); };
    const KEY_LIGHT = unit([-0.78, 0.44, 0.26]);
    const SUN_AT = unit([-0.5, 0.26, -0.83]);
    // What a body is made as: the surface kinds a planet can be given.
    const WORLD = { gas: 0, moon: 1, ice: 2, volcanic: 3, home: 4, desert: 5, iceGiant: 6, asteroid: 7 };
    // The galaxy's plane, tilted across the upper part of the view, and its bright middle.
    const GALAXY_POLE = unit([0.18, 0.93, 0.33]);
    const GALAXY_CORE = unit([0.75, 0.21, -1]);
    const COMET_AT = unit([0.52, -0.2, -0.83]);
    const glslVec3 = (v) => `vec3(${v.map((n) => n.toFixed(4)).join(', ')})`;
    // Surface maps sit beside the modes, wherever the page that hosts them lives.
    const ASSETS = (() => {
        const here = global.document?.currentScript?.src;
        return here ? new URL('../assets/', here).href : 'music-stage/assets/';
    })();

    /* ============================================================================
     * 1. 深空分镜导演 (Deep-Space Cinematography & Shot Director)
     *    - 自动识别乐段 (Drift / Verse / Pre / Chorus / Interlude / Horizon)
     *    - 确定性时间-弧长积分，保证 Seek / 暂停 / 重放落在完全一致的分镜与空间坐标
     *    - 为每句歌词分配三维空间遭遇锚点 (Spatial Encounter) 与机位运镜 (Shot Rig)
     * ============================================================================ */
    const ACT_PRESETS = Object.freeze({
        Drift:     { speed: 15.0, fov: 46, knotFlow: 0.32, nebulaAlpha: 0.48, warp: 0.08, lateralAmp: 0.55, rollAmp: 0.018, rocks: 0.55 },
        Verse:     { speed: 22.0, fov: 50, knotFlow: 0.55, nebulaAlpha: 0.65, warp: 0.22, lateralAmp: 0.85, rollAmp: 0.028, rocks: 0.00 },
        Pre:       { speed: 29.0, fov: 53, knotFlow: 0.78, nebulaAlpha: 0.78, warp: 0.45, lateralAmp: 1.05, rollAmp: 0.036, rocks: 0.00 },
        Chorus:    { speed: 38.0, fov: 60, knotFlow: 1.00, nebulaAlpha: 0.95, warp: 0.88, lateralAmp: 1.30, rollAmp: 0.048, rocks: 0.00 },
        Interlude: { speed: 18.0, fov: 44, knotFlow: 0.68, nebulaAlpha: 0.72, warp: 0.16, lateralAmp: 1.15, rollAmp: 0.042, rocks: 1.00 },
        Horizon:   { speed: 11.0, fov: 48, knotFlow: 0.40, nebulaAlpha: 0.55, warp: 0.05, lateralAmp: 0.45, rollAmp: 0.015, rocks: 0.70 }
    });

    const SHOT_RIGS = Object.freeze([
        // 0: 幽邃中轴凝视 (Abyssal Axial) —— 经典深空景深，镜头微幅呼吸
        { id: 'AXIAL_GAZE', offset: [0.0, 0.0], aimBias: [0.0, 0.0], roll: 0.0, fovAdd: -2.0 },
        // 1: 左舷迷航横移 (Port Lateral Drift) —— 镜头偏左下方，向右上星云深处斜切仰望
        { id: 'PORT_DRIFT', offset: [-4.8, -1.8], aimBias: [2.4, 1.1], roll: -0.045, fovAdd: 1.5 },
        // 2: 右舷引力掠过 (Starboard Grazing) —— 镜头偏右上方，向左下结项流形俯冲掠过
        { id: 'STARBOARD_GRAZE', offset: [5.2, 2.1], aimBias: [-2.6, -1.2], roll: 0.048, fovAdd: 2.0 },
        // 3: 巨构仰视分镜 (Monolith Low-Angle) —— 压低机位仰视深空星环与孤舟掠顶
        { id: 'LOW_MONOLITH', offset: [1.4, -3.6], aimBias: [-0.8, 2.2], roll: -0.025, fovAdd: 3.5 },
        // 4: 悬臂高轨俯瞰 (High Orbital) —— 抬升机位俯视结项弦线在下方盘旋交织
        { id: 'HIGH_ORBIT', offset: [-2.2, 3.8], aimBias: [1.2, -2.0], roll: 0.032, fovAdd: 1.0 }
    ]);

    const NEUTRAL_CAMERA = Object.freeze({ x: 0, y: 0, aimX: 0, aimY: 0, roll: 0, fov: 0, lyricX: 0, lyricY: 0, yaw: 0, pitch: 0 });
    const CAMERA_CHANNELS = Object.keys(NEUTRAL_CAMERA);
    const sampleCamera = (shot, time) => {
        if (!shot) return NEUTRAL_CAMERA;
        const blend = smoother((time - shot.startTime) / shot.cameraSpan);
        const pose = {};
        for (const key of CAMERA_CHANNELS) pose[key] = mix(shot.cameraFrom[key], shot.cameraTo[key], blend);
        return pose;
    };

    const vocalEndOf = (line) => Math.max(
        finiteNumber(line?.startTime, 0),
        finiteNumber(line?.vocalEndTime, finiteNumber(line?.endTime, finiteNumber(line?.startTime, 0) + 3.2))
    );
    const LYRIC_HANDOFF_SECONDS = 0.38;
    const LYRIC_FADE_SECONDS = 0.16;
    const lyricsCanHandoff = (from, to, dwell) => Boolean(
        from?.fullText?.trim() && to?.fullText?.trim()
        && to.startTime > from.startTime
        && to.startTime - vocalEndOf(from) <= Math.min(0.85, dwell + 0.3)
    );

    const normalizeKeyText = (line) => String(line?.fullText || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{Z}\s]/gu, '');

    const classifyTunnelActs = (lines) => {
        const kinds = lines.map((line) => (line?.isChorus ? 'Chorus' : 'Verse'));
        if (!lines.some((line) => line?.isChorus)) {
            const keys = lines.map(normalizeKeyText);
            const pairs = new Map();
            for (let i = 0; i + 1 < keys.length; i += 1) {
                if (keys[i].length < 2 || keys[i + 1].length < 2) continue;
                const pairKey = `${keys[i]}||${keys[i + 1]}`;
                const prev = pairs.get(pairKey);
                if (prev !== undefined && i - prev >= 4 && lines[i].startTime - lines[prev].startTime >= 10) {
                    let span = 2;
                    while (
                        span < 10 &&
                        prev + span < i &&
                        i + span < keys.length &&
                        keys[prev + span] === keys[i + span]
                    ) {
                        span += 1;
                    }
                    for (let j = 0; j < span; j += 1) {
                        kinds[prev + j] = 'Chorus';
                        kinds[i + j] = 'Chorus';
                    }
                } else if (prev === undefined) {
                    pairs.set(pairKey, i);
                }
            }
        }
        if (!kinds.includes('Chorus')) {
            for (let i = 6; i < kinds.length; i += 10) {
                for (let j = i; j < Math.min(i + 4, kinds.length); j += 1) {
                    kinds[j] = 'Chorus';
                }
            }
        }
        for (let i = 1; i < kinds.length; i += 1) {
            if (kinds[i] === 'Chorus' && kinds[i - 1] !== 'Chorus') {
                for (let j = Math.max(0, i - 2); j < i; j += 1) {
                    if (kinds[j] === 'Verse' && lines[i].startTime - vocalEndOf(lines[j]) < 10) {
                        kinds[j] = 'Pre';
                    }
                }
            }
        }
        return kinds;
    };

    const compileTunnelTimeline = (rawLines, identity, durationHint = 0) => {
        const seedHash = hashString(`tunnel-cine-v2:${identity || 'abyss'}`);
        const rand = seededRandom(`tunnel-director:${seedHash}`);
        const lines = (Array.isArray(rawLines) ? rawLines : [])
            .filter((line) => Number.isFinite(finiteNumber(line?.startTime, NaN)))
            .slice()
            .sort((a, b) => a.startTime - b.startTime);

        const lastVocal = lines.reduce((acc, line) => Math.max(acc, vocalEndOf(line)), 0);
        const duration = Math.max(24, finiteNumber(durationHint, 0), lastVocal + 12);
        const kinds = classifyTunnelActs(lines);
        const acts = [];

        const pushAct = (kind, start, end) => {
            const s = Math.max(0, start);
            const e = Math.min(duration, end);
            if (e <= s + 0.01) return;
            const prev = acts[acts.length - 1];
            if (prev && prev.kind === kind && Math.abs(prev.end - s) < 0.02) {
                prev.end = e;
            } else {
                acts.push({ kind, start: s, end: e, index: acts.length, params: { ...(ACT_PRESETS[kind] || ACT_PRESETS.Verse) } });
            }
        };

        if (!lines.length) {
            pushAct('Drift', 0, duration * 0.2);
            pushAct('Verse', duration * 0.2, duration * 0.55);
            pushAct('Chorus', duration * 0.55, duration * 0.85);
            pushAct('Horizon', duration * 0.85, duration);
        } else {
            if (lines[0].startTime > 0.2) {
                pushAct('Drift', 0, lines[0].startTime);
            }
            lines.forEach((line, idx) => {
                const nextStart = idx + 1 < lines.length ? lines[idx + 1].startTime : duration;
                const vEnd = Math.min(nextStart, Math.max(line.startTime + 0.5, vocalEndOf(line)));
                const gap = nextStart - vEnd;
                pushAct(kinds[idx], line.startTime, gap > 5.0 ? vEnd : nextStart);
                if (idx === lines.length - 1) {
                    pushAct('Horizon', vEnd, duration);
                } else if (gap > 5.0) {
                    pushAct('Interlude', vEnd, nextStart);
                }
            });
        }
        if (!acts.length) pushAct('Verse', 0, duration);

        const actChannels = Object.keys(ACT_PRESETS.Verse);
        acts.forEach((act, index) => {
            act.blendSpan = clamp((act.end - act.start) * 0.42, 0.4, 2.6);
            const prev = acts[index - 1];
            act.blendFrom = { ...act.params };
            if (prev) {
                const progress = smooth((act.start - prev.start) / prev.blendSpan);
                for (const key of actChannels) act.blendFrom[key] = mix(prev.blendFrom[key], prev.params[key], progress);
            }
        });
        const sampleState = (time) => {
            const t = clamp(time, 0, duration);
            const idx = Math.max(0, upperBound(acts, t, 'start') - 1);
            const act = acts[idx];
            const blend = idx === 0 ? 1 : smooth((t - act.start) / act.blendSpan);
            const out = { act: act.kind, actIndex: idx, blend };
            for (const k of actChannels) {
                out[k] = mix(act.blendFrom[k], act.params[k], blend);
            }
            return out;
        };

        // 确定性弧长积分表：保证任意 seek 到 time 时，空间曲率坐标严格唯一
        const step = Math.max(1 / 25, duration / 24000);
        const count = Math.ceil(duration / step);
        const distances = new Float64Array(count + 1);
        for (let i = 1; i <= count; i += 1) {
            const t0 = (i - 1) * step;
            const t1 = Math.min(duration, i * step);
            const s0 = sampleState(t0).speed;
            const s1 = sampleState(t1).speed;
            distances[i] = distances[i - 1] + (s0 + s1) * 0.5 * (t1 - t0);
        }

        const distanceAt = (time, speedScale = 1) => {
            const t = clamp(time, 0, duration);
            const idx = Math.min(count - 1, Math.floor(t / step));
            const t0 = idx * step;
            const span = Math.max(1e-5, Math.min(duration, (idx + 1) * step) - t0);
            let baseDist = mix(distances[idx], distances[idx + 1], clamp((t - t0) / span));
            // Keep cruising if playback outlives the compiled timeline.
            if (time > duration) baseDist += (time - duration) * Math.max(0.2, sampleState(duration).speed);
            return baseDist * clamp(speedScale, 0.25, 2.5);
        };

        // 三维深空弯曲航道 (3D Abyssal Spline)：利用多重无理数频率合成平滑曲率
        const phaseA = (seedHash & 0xffff) / 0xffff * TAU;
        const phaseB = ((seedHash >>> 16) & 0xffff) / 0xffff * TAU;
        const spineAt = (s, motionScale = 1) => {
            const m = clamp(motionScale, 0, 2);
            const x = (Math.sin(s * 0.0029 + phaseA) * 22.0 + Math.cos(s * 0.0067 + phaseB) * 9.5) * m;
            const y = (Math.cos(s * 0.0023 + phaseB) * 13.5 + Math.sin(s * 0.0053 + phaseA * 0.7) * 6.0) * m;
            const dx = (Math.cos(s * 0.0029 + phaseA) * 22.0 * 0.0029 - Math.sin(s * 0.0067 + phaseB) * 9.5 * 0.0067) * m;
            const dy = (-Math.sin(s * 0.0023 + phaseB) * 13.5 * 0.0023 + Math.cos(s * 0.0053 + phaseA * 0.7) * 6.0 * 0.0053) * m;
            const invLen = 1 / Math.hypot(dx, dy, 1);
            const forward = { x: dx * invLen, y: dy * invLen, z: -invLen };
            const rightLen = Math.hypot(forward.z, 0, -forward.x) || 1;
            const right = { x: -forward.z / rightLen, y: 0, z: forward.x / rightLen };
            const up = {
                x: forward.y * right.z - forward.z * right.y,
                y: forward.z * right.x - forward.x * right.z,
                z: forward.x * right.y - forward.y * right.x
            };
            const curvature = Math.sin(s * 0.0041 + phaseA) * 0.6 + Math.cos(s * 0.0083 + phaseB) * 0.4;
            return { x, y, z: -s, forward, right, up, curvature };
        };

        // 为每一句歌词编排分镜机位 (Shot Rig) 与三维空间结项锚点
        let prevRigIdx = 0;
        let previousShot = null;
        const lineShots = lines.map((line, idx) => {
            const actKind = kinds[idx] || 'Verse';
            let rigIdx = (idx + Math.floor(rand() * 3)) % SHOT_RIGS.length;
            if (rigIdx === prevRigIdx) rigIdx = (rigIdx + 1) % SHOT_RIGS.length;
            if (actKind === 'Chorus' && idx % 2 === 0) rigIdx = idx % 4 === 0 ? 3 : 2;
            prevRigIdx = rigIdx;
            const rig = SHOT_RIGS[rigIdx];
            const sign = idx % 2 === 0 ? 1 : -1;
            const knotP = 2 + (idx % 3);
            const knotQ = 3 + ((idx * 2) % 4);
            const lateralX = sign * (2.2 + (idx % 3) * 1.15) + (rand() - 0.5) * 1.2;
            const verticalY = ((idx % 3) - 1) * 1.05 + (rand() - 0.5) * 0.8;
            const shot = {
                index: idx,
                startTime: line.startTime,
                endTime: line.endTime,
                vocalEnd: vocalEndOf(line),
                actKind,
                cameraFrom: sampleCamera(previousShot, line.startTime),
                cameraTo: {
                    x: rig.offset[0], y: rig.offset[1], aimX: rig.aimBias[0], aimY: rig.aimBias[1],
                    roll: sign * (0.022 + (idx % 2) * 0.014) + rig.roll * 0.45,
                    fov: rig.fovAdd, lyricX: lateralX, lyricY: verticalY, pitch: sign * 0.018, yaw: -sign * 0.038
                },
                cameraSpan: clamp((line.endTime - line.startTime) * 0.45, 0.65, 2.2),
                knotP,
                knotQ
            };
            previousShot = shot;
            return shot;
        });

        // 編排深空巨构与结项流形遭遇序列 (Celestial & Knotted Manifold Encounters)
        // 类型涵盖：
        //   - 'station' -> 高维环面结流形 / 戴森星门遗迹 (Torus Knot (p,q) Manifold)
        //   - 'rings'   -> 洛希吸积盘与螺旋星环 (Roche Accretion Vortex)
        //   - 'planet'  -> 幽暗晨昏线气态巨行星與极光磁层 (Abyssal Terminator Planet)
        //   - 'ship'    -> 远航张拉星帆孤舟群与离子弦尾迹 (Nomad Solar-Sail Monolith)
        const ENCOUNTER_CYCLE = 2400;
        // Home is drawn at this many times a planet's size, its surface a little below the route.
        const HOME_SIZE = 12, HOME_DEPTH = 26 * 1.25 * 12 + 30;
        // Each station keeps close company with a planet: it comes up small
        // against the disc, then passes near the camera.
        // A slot is a different world each time round, so no planet is met
        // twice: the planets and ringed bodies list theirs in order.
        const encounterSlots = [
            { slotId: 0, type: 'station', baseS: 792,  side:  1, radial: 21, elev: 7,   scale: 0.58, rotSpeed: 0.05, tilt: [0.42, 0.18, -0.28], p: 3, q: 5 },
            { slotId: 1, type: 'planet',  baseS: 860,  side:  1, radial: 56, elev: 18,  scale: 1.25, rotSpeed: 0.05, tilt: [0.22, -0.12, 0.16], p: 2, q: 3, worlds: [WORLD.moon, WORLD.volcanic, WORLD.ice] },
            { slotId: 2, type: 'rings',   baseS: 1160, side: -1, radial: 50, elev: -12, scale: 1.32, rotSpeed: 0.09, tilt: [0.68, 0.24, 0], p: 2, q: 5, worlds: [WORLD.gas, WORLD.ice, WORLD.moon] },
            { slotId: 3, type: 'ship',    baseS: 1460, side:  1, radial: 58, elev: -9,  scale: 1.10, rotSpeed: 0.04, tilt: [-0.08, 0.14, -0.12], p: 3, q: 4 },
            { slotId: 4, type: 'station', baseS: 1985, side: -1, radial: 23, elev: -5,  scale: 0.62, rotSpeed: -0.05, tilt: [-0.52, 0.31, 0.22], p: 4, q: 7 },
            { slotId: 5, type: 'planet',  baseS: 2060, side: -1, radial: 60, elev: -16, scale: 1.18, rotSpeed: 0.06, tilt: [0.31, 0.15, -0.24], p: 3, q: 5, worlds: [WORLD.desert, WORLD.iceGiant, WORLD.moon] },
            { slotId: 6, type: 'rings',   baseS: 2360, side:  1, radial: 46, elev: 12,  scale: 1.22, rotSpeed: -0.08, tilt: [-0.62, -0.20, 0.29], p: 5, q: 8, worlds: [WORLD.iceGiant, WORLD.asteroid, WORLD.desert] },
            { slotId: 7, type: 'ship',    baseS: 2660, side: -1, radial: 25, elev: 5,   scale: 0.66, rotSpeed: 0.012, tilt: [0.35, 0.5 - 7 * 1.1, -0.95], p: 2, q: 3, hold: true },
            { slotId: 8, type: 'ship',    baseS: 1730, side:  1, radial: 25, elev: -4,  scale: 0.6,  rotSpeed: 0.01, tilt: [0.3, -0.55 - 8 * 1.1, 0.12], p: 3, q: 7, hold: true }
        ];

        // The first chorus is flown through a ring system. The whole procession
        // of encounters is slid along the route so that the first ringed planet
        // (whose ring plane the route pierces, between planet and outer edge)
        // is reached a few seconds into that chorus.
        const choruses = acts.filter((act) => act.kind === 'Chorus' && act.end - act.start > 4);
        const passTime = (act) => act.start + Math.min(5, (act.end - act.start) * 0.5);
        const passAt = (act) => distanceAt(passTime(act));
        // A pass has the sky to itself: nothing else arrives within a few seconds of it.
        const hero = (act, place) => act && { ...place, distance: passAt(act), hold: true,
            clearFrom: distanceAt(Math.max(0, passTime(act) - 4.5)), clearTo: distanceAt(passTime(act) + 3.5) };
        const ringPass = choruses[0] ? { distance: passAt(choruses[0]), baseS: 1160 } : null;
        // The later choruses each get a pass of their own, placed outside the
        // procession: the second skims the sunlit cloud tops of a gas giant,
        // the third goes up through a ring system from its shaded side.
        const heroPasses = [
            hero(choruses[1], { slotId: 5, side: 1, radial: 35, elev: -5, tilt: [0.31, 0.15, -0.24], world: WORLD.gas }),
            hero(choruses[2], { slotId: 6, side: 1, radial: 46, elev: 12, tilt: [-0.62, -0.2, 0], world: WORLD.gas })
        ].filter(Boolean);
        // The voyage sets out from home: the opening drifts low over the
        // night side of a vast world, cities lit beneath the weather.
        if (duration > 45) {
            heroPasses.unshift({ slotId: 1, distance: distanceAt(Math.min(12, duration * 0.06)), side: -1, radial: 150, elev: HOME_DEPTH - 30,
                tilt: [1.25, 0.6, 0.18], hold: true, world: WORLD.home, size: HOME_SIZE, clearFrom: 0, clearTo: distanceAt(16) });
        }
        // The close is an arrival: a ringed planet gathers far ahead through
        // the last act and the song ends on the slow approach to it. Far out,
        // under a small sun, it is a cold ice giant with fine rings.
        const closing = acts[acts.length - 1];
        if (closing && closing.kind === 'Horizon' && closing.end - closing.start > 12) {
            heroPasses.push({ slotId: 2, distance: distanceAt(duration) + 150, side: -1, radial: 58, elev: -10,
                tilt: [0.5, 0.2, -0.25], hold: true, world: WORLD.iceGiant, clearFrom: distanceAt(duration - 16), clearTo: Infinity });
        }

        const usableDuration = durationHint > 0 ? Math.min(duration, durationHint) : duration;
        const existingPeaks = choruses.slice(0, 3).map(passTime);
        const findEncounter = (fraction, maxSpan, low, high) => {
            const preferred = usableDuration * fraction;
            const span = Math.min(maxSpan, usableDuration * 0.22);
            const earlier = Math.max(span * 0.5, usableDuration * low);
            const later = Math.min(usableDuration - span * 0.5, usableDuration * high);
            let winner = clamp(preferred, earlier, later);
            let best = Infinity;
            for (let i = 0; i <= 28; i += 1) {
                const t = mix(earlier, later, i / 28);
                const act = sampleState(t).act;
                const quiet = act === 'Drift' || act === 'Interlude';
                const conflict = existingPeaks.reduce((near, peak) => Math.max(near, 1 - Math.abs(peak - t) / (span * 0.5 + 4)), 0);
                const score = Math.abs(t - preferred) - (quiet ? span * 0.28 : 0) + conflict * span * 1.5;
                if (score < best) { winner = t; best = score; }
            }
            return { start: winner - span * 0.5, peak: winner, end: winner + span * 0.5 };
        };
        const asteroidBelt = findEncounter(0.23, 18, 0.14, 0.38);
        const blackHole = findEncounter(0.67, 22, 0.50, 0.83);
        // Between the first two choruses the route passes close by a comet.
        const cometPass = findEncounter(0.36, 30, 0.28, 0.46);

        return {
            seedHash,
            duration,
            acts,
            lines,
            lineShots,
            encounterSlots,
            ringPass,
            heroPasses,
            asteroidBelt,
            blackHole,
            cometPass,
            ENCOUNTER_CYCLE,
            sampleState,
            distanceAt,
            spineAt
        };
    };

    const encounterAmount = ({ start, peak, end }, time) => smooth((time - start) / ((peak - start) * 0.76))
        * smooth((end - time) / ((end - peak) * 0.76));

    /* ============================================================================
     * 2. 粒子结项流形与深空巨构点云生成器 (Procedural Knotted Manifolds)
     *    每个模板返回 { pos, normal, meta }，交由 GPU Shader 执行凝聚、涡流解算与着色
     *    meta.x: 局部相位 u ∈ [0,1]
     *    meta.y: 子结构材质通道 shade ∈ {0, 1, 2, 3}
     *    meta.z: 基础粒子半径缩放
     *    meta.w: 个人随机种子 seed ∈ [0,1]
     * ============================================================================ */
    // One set of dimensions for each encounter: the point template and the
    // solid body are built from the same numbers, so they coincide.
    const ENTITY_SPECS = Object.freeze({
        // Each craft slot is a different spacecraft each time round: the
        // first is the slot's own, the rest follow in turn.
        stationA: { radius: 25, plan: 'truss', variants: [{ radius: 25, plan: 'mir' }] },
        stationB: { radius: 26, plan: 'cross', variants: [{ radius: 26, plan: 'skylab' }] },
        ringsA: { inner: 22, outer: 48 }, ringsB: { inner: 24, outer: 52 },
        planetA: { radius: 26 }, planetB: { radius: 24 },
        shipA: { scale: 1.0, variants: [{ radius: 25, plan: 'apollo' }] },
        // The probe slot's first pass comes in the opening, still near home:
        // `turns` picks the craft for each time round, from the one before the first.
        shipB: { scale: 0.92, radius: 25, plan: 'probe', variants: [{ radius: 25, plan: 'sputnik' }, { radius: 25, plan: 'hubble' }], turns: [1, 0, 2] },
        scope: { radius: 25, plan: 'telescope' }
    });
    // A solar sail, after the square sails that have flown: a thin film in
    // four quadrants, slack between four diagonal booms, and a small drum of
    // a spacecraft at the centre. The film lies across Z, turned to cruise
    // at a slant.
    const sailPlan = (scale) => {
        const half = 23 * scale;
        return {
            half, bus: 1.5 * scale, busLength: 2.6 * scale, boom: 0.16 * scale,
            // Each quadrant sags between the booms that hold it.
            billow(x, y) {
                const ax = Math.abs(x) / half, ay = Math.abs(y) / half;
                return -half * 0.13 * Math.abs(ax - ay) * (1 - Math.max(ax, ay)) * 4 * Math.min(1, Math.max(ax, ay) * 3);
            },
            pose(x, y, z, out) {
                const y1 = y * 0.94 - z * 0.34, z1 = y * 0.34 + z * 0.94;
                out[0] = x * 0.85 + z1 * 0.48; out[1] = y1; out[2] = -x * 0.48 + z1 * 0.85;
                return out;
            }
        };
    };
    const createManifoldTemplates = (pointsPerSlot) => {
        // B. 洛希吸积盘与螺旋密度波星环 (Roche Accretion Vortex & Spiral Density Waves)
        const buildRocheRings = (count, innerR, outerR, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const normal = new Float32Array(count * 3);
            const meta = new Float32Array(count * 4);
            const span = outerR - innerR;

            for (let i = 0; i < count; i += 1) {
                const idx3 = i * 3;
                const idx4 = i * 4;
                const u = rand();
                let r = innerR;
                let shade = 0;

                if (u < 0.38) {
                    // 内层高能吸积亮环 (Inner Photon Rim)
                    r = innerR + Math.pow(rand(), 1.35) * span * 0.28;
                    shade = 2; // 琥珀亮金
                } else if (u < 0.76) {
                    // 中层螺旋密度波带 (跳过卡西尼暗缝 0.28~0.35)
                    const band = 0.35 + rand() * 0.36;
                    r = innerR + band * span;
                    shade = 1; // 松石冰晶带
                } else {
                    // 外层洛希离散星尘晕与伴星微粒
                    r = innerR + (0.74 + Math.pow(rand(), 0.75) * 0.38) * span;
                    shade = 0; // 幽暗骨白微尘
                }

                // 螺旋密度波对数偏角
                const armOffset = (i % 2) * Math.PI;
                const spiralTheta = rand() * TAU + Math.log(Math.max(1, r / innerR)) * 3.2 + armOffset;
                const waveCompress = 1 + 0.045 * Math.sin(spiralTheta * 2.0 - r * 0.18);
                const finalR = r * waveCompress;
                const thickness = (shade === 0 ? 2.4 : shade === 1 ? 0.65 : 0.35) * (rand() - 0.5);

                pos[idx3] = Math.cos(spiralTheta) * finalR;
                pos[idx3 + 1] = thickness + Math.sin(spiralTheta * 3.0) * 0.35;
                pos[idx3 + 2] = Math.sin(spiralTheta) * finalR;

                normal[idx3] = Math.cos(spiralTheta) * 0.25;
                normal[idx3 + 1] = thickness >= 0 ? 0.96 : -0.96;
                normal[idx3 + 2] = Math.sin(spiralTheta) * 0.25;

                meta[idx4] = (spiralTheta % TAU) / TAU;
                meta[idx4 + 1] = shade;
                meta[idx4 + 2] = shade === 2 ? 1.55 + rand() * 0.8 : shade === 1 ? 1.15 + rand() * 0.55 : 0.85 + rand() * 0.5;
                meta[idx4 + 3] = rand();
            }
            return { pos, normal, meta };
        };

        // C. 幽暗晨昏线行星与极光磁层 (Abyssal Planet + Magnetosphere Dipole Arcs)
        const buildAbyssalPlanet = (count, radius, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const normal = new Float32Array(count * 3);
            const meta = new Float32Array(count * 4);
            const golden = Math.PI * (3 - Math.sqrt(5));
            const surfCount = Math.floor(count * 0.76);

            for (let i = 0; i < count; i += 1) {
                const idx3 = i * 3;
                const idx4 = i * 4;
                if (i < surfCount) {
                    // 斐波那契球面 + 气态纬向涡流微移
                    const y = 1 - ((i + 0.5) / surfCount) * 2;
                    const r = Math.sqrt(Math.max(0, 1 - y * y));
                    const phi = i * golden + Math.sin(y * 9.0) * 0.18;
                    const nx = Math.cos(phi) * r;
                    const ny = y;
                    const nz = Math.sin(phi) * r;
                    const atmoShell = Math.abs(y) > 0.82 ? 1.012 : 1.0;

                    pos[idx3] = nx * radius * atmoShell;
                    pos[idx3 + 1] = ny * radius * atmoShell;
                    pos[idx3 + 2] = nz * radius * atmoShell;
                    normal[idx3] = nx;
                    normal[idx3 + 1] = ny;
                    normal[idx3 + 2] = nz;

                    // 区分极冠极光环 (shade=2)、赤道气旋带 (shade=1) 与幽暗星体表面 (shade=0)
                    const absY = Math.abs(y);
                    const isAuroraOval = absY > 0.78 && absY < 0.92;
                    const isStormBelt = Math.abs(Math.sin(y * 7.5)) > 0.86;
                    meta[idx4] = (phi % TAU) / TAU;
                    meta[idx4 + 1] = isAuroraOval ? 2 : isStormBelt ? 1 : 0;
                    meta[idx4 + 2] = isAuroraOval ? 1.85 + rand() * 0.7 : 1.15 + rand() * 0.65;
                    meta[idx4 + 3] = rand();
                } else {
                    // 偶极子磁层结项丝线 (Dipole Magnetosphere Filaments): r = L * sin^2(theta)
                    const arcIdx = i % 10;
                    const lon = (arcIdx / 10) * TAU + (rand() - 0.5) * 0.14;
                    const theta = 0.22 + rand() * (Math.PI - 0.44);
                    const sinT = Math.sin(theta);
                    const L = radius * (1.28 + (arcIdx % 3) * 0.26);
                    const r = Math.max(radius * 0.95, L * sinT * sinT);
                    const x = r * sinT * Math.cos(lon);
                    const y = r * Math.cos(theta);
                    const z = r * sinT * Math.sin(lon);
                    const inv = 1 / Math.max(0.001, Math.hypot(x, y, z));
                    pos[idx3] = x;
                    pos[idx3 + 1] = y;
                    pos[idx3 + 2] = z;
                    normal[idx3] = x * inv;
                    normal[idx3 + 1] = y * inv;
                    normal[idx3 + 2] = z * inv;
                    meta[idx4] = theta / Math.PI;
                    meta[idx4 + 1] = 3; // 磁力线流光
                    meta[idx4 + 2] = 1.05 + rand() * 0.55;
                    meta[idx4 + 3] = rand();
                }
            }
            return { pos, normal, meta };
        };

        // D. 远航张拉星帆孤舟与离子弦尾迹 (Nomad Solar-Sail Monolith & Ion Wake)
        // D. 太阳帆：方形薄膜、四根对角桁、中心鼓形舱，点云与实体同一套尺寸
        const buildSolarSail = (count, scale, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const normal = new Float32Array(count * 3);
            const meta = new Float32Array(count * 4);
            const plan = sailPlan(scale);
            const at = new Float32Array(3);
            for (let i = 0; i < count; i += 1) {
                const u = rand();
                let x, y, z, shade;
                if (u < 0.72) {
                    x = (rand() * 2 - 1) * plan.half; y = (rand() * 2 - 1) * plan.half;
                    z = plan.billow(x, y);
                    shade = Math.max(Math.abs(x), Math.abs(y)) > plan.half * 0.9 ? 1 : 0;
                } else if (u < 0.9) {
                    const r = rand() * plan.half, sx = rand() < 0.5 ? -1 : 1, sy = rand() < 0.5 ? -1 : 1;
                    x = sx * r; y = sy * r; z = 0; shade = 2;
                } else {
                    const a = rand() * TAU;
                    x = Math.cos(a) * plan.bus; y = Math.sin(a) * plan.bus; z = (rand() - 0.3) * plan.busLength; shade = 2;
                }
                plan.pose(x, y, z, at);
                pos.set(at, i * 3);
                plan.pose(0, 0, 1, at);
                normal.set(at, i * 3);
                meta.set([rand(), shade, 1.0 + rand() * 0.7, rand()], i * 4);
            }
            return { pos, normal, meta };
        };

        const S = ENTITY_SPECS;
        return {
            ringsA:   buildRocheRings(pointsPerSlot, S.ringsA.inner, S.ringsA.outer, 'manifold-roche-a'),
            ringsB:   buildRocheRings(pointsPerSlot, S.ringsB.inner, S.ringsB.outer, 'manifold-roche-b'),
            planetA:  buildAbyssalPlanet(pointsPerSlot, S.planetA.radius, 'manifold-planet-a'),
            planetB:  buildAbyssalPlanet(pointsPerSlot, S.planetB.radius, 'manifold-planet-b'),
            shipA:    buildSolarSail(pointsPerSlot, S.shipA.scale, 'manifold-sail-a'),
            shipB:    buildSolarSail(pointsPerSlot, S.shipB.scale, 'manifold-sail-b')
        };
    };

    /* ============================================================================
     * 3. 隧图三维世界构建 (Abyssal Tunnel World)
     *    - 深空星尘 + 体积星云团 + 结项测地线丝束 + GPU 天体流形 + 空间锚定结项歌词
     * ============================================================================ */
    const createTunnelWorld = (T, scene) => {
        const root = new T.Group();
        scene.add(root);

        let viewportAspect = 1.6;
        let pixelRatio = 1;
        let viewportPixels = 720;
        let stagePalette = {};
        let timeline = compileTunnelTimeline([], 'init', 180);
        let totalTravelDistance = 0;
        let cruiseSpeed = 1.0;

        const parsePalette = () => {
            const accent = stagePalette.accent || '#F2A900';
            const secondary = stagePalette.secondary || '#76BFAE';
            const ink = stagePalette.ink || '#F2F0E9';
            const muted = stagePalette.muted || '#8FA4B3';
            const background = stagePalette.background || '#070A0F';
            return {
                accent: new T.Color(accent),
                secondary: new T.Color(secondary),
                ink: new T.Color(ink),
                muted: new T.Color(muted),
                background: new T.Color(background),
                ember: new T.Color('#E06C5F'),
                accentHex: accent,
                secondaryHex: secondary,
                inkHex: ink
            };
        };

        /* ------------------------------------------------------------------------
         * 层级 1：幽邃深空星场与体积星云微粒 (Abyssal Starfield & Volumetric Nebula)
         * 完全由 GPU 在相机局部盒子内取模循环 (Camera-Relative Toroidal Box)，
         * 无论镜头如何弯曲横移，星尘与星云始终均匀环绕且绝对静止于世界空间。
         * ------------------------------------------------------------------------ */
        const STAR_COUNT = 960;
        const NEBULA_COUNT = 68;
        const fieldTotal = STAR_COUNT + NEBULA_COUNT;
        const fieldOffsets = new Float32Array(fieldTotal * 3);
        const fieldMeta = new Float32Array(fieldTotal * 4); // x: size, y: layer(0=far,1=near,2=nebula), z: seed1, w: seed2
        const fieldRand = seededRandom('abyssal-field-v2');

        const BOX_X = 340;
        const BOX_Y = 220;
        const BOX_Z = 1800;

        for (let i = 0; i < fieldTotal; i += 1) {
            const isNebula = i >= STAR_COUNT;
            const isNear = !isNebula && i >= Math.floor(STAR_COUNT * 0.78);
            const i3 = i * 3;
            const i4 = i * 4;
            fieldOffsets[i3] = (fieldRand() - 0.5) * BOX_X;
            fieldOffsets[i3 + 1] = (fieldRand() - 0.5) * BOX_Y;
            fieldOffsets[i3 + 2] = -fieldRand() * BOX_Z;

            fieldMeta[i4] = isNebula
                ? 28.0 + fieldRand() * 38.0
                : isNear
                    ? 1.9 + fieldRand() * 2.4
                    : 0.75 + fieldRand() * 1.25;
            fieldMeta[i4 + 1] = isNebula ? 2.0 : isNear ? 1.0 : 0.0;
            fieldMeta[i4 + 2] = fieldRand();
            fieldMeta[i4 + 3] = fieldRand();
        }

        const fieldGeo = new T.BufferGeometry();
        fieldGeo.setAttribute('position', new T.BufferAttribute(fieldOffsets, 3));
        fieldGeo.setAttribute('aMeta', new T.BufferAttribute(fieldMeta, 4));

        const fieldMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                uCamPos: { value: new T.Vector3() },
                uTime: { value: 0 },
                uPixelRatio: { value: 1 },
                uStarColor: { value: new T.Color('#b8c7d4') },
                uNebulaA: { value: new T.Color('#76bfae') },
                uNebulaB: { value: new T.Color('#f2a900') },
                uNebulaAlpha: { value: 0.65 },
                uAudioPulse: { value: 0 },
                uDensity: { value: 1 }
            },
            vertexShader: `
                attribute vec4 aMeta;
                uniform vec3 uCamPos;
                uniform float uTime, uPixelRatio, uNebulaAlpha, uAudioPulse, uDensity;
                varying float vLayer;
                varying float vAlpha;
                varying float vSeed;
                varying float vTwinkle;

                void main() {
                    vLayer = aMeta.y;
                    vSeed = aMeta.z;
                    // 按密度裁剪部分星点与星云
                    if (aMeta.w > clamp(uDensity * 0.85 + 0.15, 0.2, 1.0)) {
                        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                        gl_PointSize = 0.0;
                        return;
                    }
                    vec3 box = vec3(340.0, 220.0, 1800.0);
                    float parallax = vLayer > 1.5 ? 0.65 : (vLayer > 0.5 ? 1.0 : 0.42);
                    vec3 rel = mod(position - uCamPos * parallax + box * 0.5, box) - box * 0.5;
                    // 将 Z 轴锁定在镜头前方 [-1720, +80]
                    rel.z = mod(position.z - uCamPos.z * parallax, 1800.0) - 1720.0;

                    vec3 worldPos = uCamPos + rel;
                    vec4 mv = modelViewMatrix * vec4(worldPos, 1.0);
                    gl_Position = projectionMatrix * mv;

                    float depth = max(1.0, -mv.z);
                    float nearFade = smoothstep(8.0, 65.0, depth);
                    float farFade = 1.0 - smoothstep(1150.0, 1700.0, depth);

                    if (vLayer > 1.5) {
                        // 体积星云团：巨大柔焦光斑，近处自动消隐防止糊屏
                        float nebNear = smoothstep(95.0, 260.0, depth);
                        gl_PointSize = clamp(aMeta.x * uPixelRatio * 420.0 / depth, 8.0, 135.0);
                        vTwinkle = 0.85 + 0.15 * sin(uTime * 0.25 + aMeta.z * 18.0);
                        vAlpha = nebNear * farFade * (0.024 + aMeta.z * 0.028) * uNebulaAlpha * (1.0 + uAudioPulse * 0.22);
                    } else {
                        gl_PointSize = clamp(aMeta.x * uPixelRatio * 290.0 / depth, 1.0, 22.0);
                        vTwinkle = 0.68 + 0.32 * sin(uTime * (0.5 + aMeta.w * 1.6) + aMeta.z * 37.0);
                        vAlpha = nearFade * farFade * (0.24 + aMeta.z * 0.58) * vTwinkle;
                    }
                }
            `,
            fragmentShader: `
                uniform vec3 uStarColor, uNebulaA, uNebulaB;
                varying float vLayer;
                varying float vAlpha;
                varying float vSeed;
                varying float vTwinkle;

                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r2 = dot(p, p);
                    if (r2 > 1.0) discard;

                    if (vLayer > 1.5) {
                        // 柔焦各向异性星云散射
                        float cloud = exp(-r2 * 2.8) * (1.0 - r2);
                        vec3 col = mix(uNebulaA, uNebulaB, smoothstep(0.15, 0.85, vSeed));
                        gl_FragColor = vec4(col * vTwinkle, cloud * vAlpha);
                    } else {
                        float core = exp(-r2 * 8.5);
                        float halo = exp(-r2 * 2.2) * 0.34 * vTwinkle;
                        // 十字星芒微刺 (Subtle Airy Cross)
                        float cross = exp(-abs(p.x) * 18.0) * exp(-abs(p.y) * 4.5)
                                    + exp(-abs(p.y) * 18.0) * exp(-abs(p.x) * 4.5);
                        float airy = vLayer > 0.5 ? cross * 0.16 * (1.0 - r2) : 0.0;
                        // Stars have temperatures: a few cool orange ones, many
                        // warm and white, some hot and blue. The halo keeps the
                        // tint; the core burns towards white.
                        float heat = fract(vSeed * 7.31);
                        vec3 tint = heat < 0.14 ? vec3(1.0, 0.66, 0.42) : heat < 0.45 ? vec3(1.0, 0.9, 0.74)
                            : heat < 0.8 ? vec3(1.0) : vec3(0.7, 0.82, 1.0);
                        vec3 col = mix(uStarColor, mix(uNebulaA, uNebulaB, vSeed), 0.12) * tint;
                        gl_FragColor = vec4(mix(col, vec3(1.0), core * 0.6) * (core * 1.55 + halo + airy), (core + halo + airy) * vAlpha);
                    }
                }
            `
        });
        const fieldPoints = new T.Points(fieldGeo, fieldMat);
        fieldPoints.frustumCulled = false;
        root.add(fieldPoints);

        /* ------------------------------------------------------------------------
         * Layer 0: the sky everything else is seen against. A galaxy crosses the
         * upper part of the view, a warm cloud hangs round the sun and a cool one
         * low on the far side. The clouds are worked out once into a small map of
         * densities, so a frame costs one lookup, the sun and a layer of stars.
         * ------------------------------------------------------------------------ */
        const skyMasks = new T.WebGLRenderTarget(2048, 1024, {
            depthBuffer: false, generateMipmaps: false,
            minFilter: T.LinearFilter, magFilter: T.LinearFilter, wrapS: T.RepeatWrapping
        });
        const skyBakeMat = new T.ShaderMaterial({
            depthTest: false, depthWrite: false, blending: T.NoBlending,
            vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: `
                varying vec2 vUv;
                float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
                float noise(vec3 p) {
                    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
                    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                        mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                        mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                        mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
                }
                float fbm(vec3 p) {
                    float sum = 0.0, gain = 0.5;
                    for (int i = 0; i < 7; i++) { sum += gain * noise(p); p = p * 2.03 + vec3(7.1, 3.3, 5.7); gain *= 0.5; }
                    return sum;
                }
                float ridge(vec3 p) {
                    float sum = 0.0, gain = 0.5;
                    for (int i = 0; i < 7; i++) {
                        sum += gain * (1.0 - abs(noise(p) * 2.0 - 1.0));
                        p = p * 2.07 + vec3(1.7, 9.2, 4.4); gain *= 0.5;
                    }
                    return sum;
                }
                void main() {
                    float lon = (vUv.x - 0.5) * 6.2831853, lat = (vUv.y - 0.5) * 3.14159265;
                    vec3 d = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));
                    vec3 w = d * 2.4 + vec3(fbm(d * 2.6 + 1.7), fbm(d * 2.6 + 9.2), fbm(d * 2.6 + 4.4)) * 1.1;
                    // Folded a second time, the gas draws out into sheets and threads.
                    w += (vec3(fbm(w * 2.1 + 3.1), fbm(w * 2.1 + 7.7), fbm(w * 2.1 + 1.3)) - 0.5) * 0.9;
                    // Red: the cool cloud. Green: the warm one round the sun. Each
                    // is a soft body of gas with bright threads where it is compressed.
                    float coolAt = smoothstep(0.25, 0.95, dot(d, normalize(vec3(0.66, -0.36, -0.66))));
                    float coolBody = smoothstep(0.4, 0.86, fbm(w * 1.2 + 3.0) * 0.6 + ridge(w * 1.6) * 0.55);
                    float coolThread = pow(ridge(w * 3.4 + 2.0), 4.0);
                    float cool = coolAt * clamp(coolBody * 0.62 + sqrt(coolBody) * coolThread * 1.5, 0.0, 1.0);
                    float warmAt = smoothstep(0.45, 0.98, dot(d, ${glslVec3(SUN_AT)}));
                    float warmBody = smoothstep(0.42, 0.9, fbm(w * 1.5 + 11.0) * 0.55 + ridge(w * 2.2 + 5.0) * 0.55);
                    float warmThread = pow(ridge(w * 4.1 + 8.0), 4.0);
                    float warm = warmAt * clamp(warmBody * 0.62 + sqrt(warmBody) * warmThread * 1.5, 0.0, 1.0);
                    // Blue: the galaxy, clumped, with its bulge. Alpha: dust that hides it.
                    float h = dot(d, ${glslVec3(GALAXY_POLE)});
                    float band = exp(-h * h / 0.022) * (0.35 + 0.9 * fbm(d * 6.0 + 20.0));
                    float bulge = exp(-(1.0 - dot(d, ${glslVec3(GALAXY_CORE)})) * 14.0) * exp(-h * h / 0.05);
                    float lanes = exp(-h * h / 0.006) * smoothstep(0.5, 0.78, ridge(d * 7.0 + 31.0)) * 0.9;
                    // Dark dust threads through both clouds, sharp-edged against the glow.
                    lanes = max(lanes, max(coolAt, warmAt * 0.8) * smoothstep(0.6, 0.76, ridge(w * 2.6 + 17.0)) * 0.72);
                    gl_FragColor = vec4(cool, warm, clamp(band * 0.7 + bulge * 0.9, 0.0, 1.0), clamp(lanes, 0.0, 1.0));
                }
            `
        });
        const skyGeo = new T.SphereGeometry(1, 32, 16);
        const skyMat = new T.ShaderMaterial({
            side: T.BackSide, depthTest: false, depthWrite: false, fog: false,
            uniforms: {
                uMasks: { value: skyMasks.texture },
                uBase: { value: new T.Color('#020305') },
                uColorA: { value: new T.Color('#76bfae') },
                uColorB: { value: new T.Color('#f2a900') },
                uColorStar: { value: new T.Color('#b8c7d4') },
                uColorSun: { value: new T.Color('#fff1d6') },
                uInk: { value: new T.Color('#f2f0e9') },
                uTime: { value: 0 }, uNebula: { value: 1 }, uPaper: { value: 0 }, uJourney: { value: 0 }, uComet: { value: 0 },
                uHole: { value: new T.Vector2(0, 0.08) },
                uHoleDir: { value: new T.Vector3(0, 0, -1) },
                uHoleRight: { value: new T.Vector3(1, 0, 0) },
                uHoleUp: { value: new T.Vector3(0, 1, 0) },
                uViewport: { value: new T.Vector2(1280, 720) }
            },
            vertexShader: `
                varying vec3 vDir;
                void main() {
                    vDir = position;
                    // Turned with the camera, never moved by it: the sky is infinitely far.
                    vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
                    gl_Position = clip.xyww;
                }
            `,
            fragmentShader: `
                uniform sampler2D uMasks;
                uniform vec3 uBase, uColorA, uColorB, uColorStar, uColorSun, uInk;
                uniform float uTime, uNebula, uPaper, uJourney, uComet;
                uniform vec2 uViewport, uHole;
                uniform vec3 uHoleDir, uHoleRight, uHoleUp;
                varying vec3 vDir;
                float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                float bandNoise(float x) {
                    float i = floor(x), f = fract(x);
                    return mix(hash(vec2(i, 0.0)), hash(vec2(i + 1.0, 0.0)), f * f * (3.0 - 2.0 * f));
                }
                vec3 accretion(vec2 x, vec3 background, float read) {
                    vec2 p = mat2(0.95, 0.312, -0.312, 0.95) * x;
                    float r = length(p);
                    float edge = max(fwidth(r), 0.004);
                    float horizon = 1.0 - smoothstep(0.96 - edge, 0.96 + edge, r);
                    float azimuth = atan(p.y, p.x);
                    float warmSide = 0.31 + 0.69 * smoothstep(-1.0, 1.0, -p.x);
                    float plane = length(vec2(p.x, (p.y + 0.08) * 4.15));
                    float gas = smoothstep(0.95, 1.20, plane) * (1.0 - smoothstep(2.05, 3.05, plane));
                    gas *= 1.0 - horizon * smoothstep(-0.28, -0.07, p.y);
                    float spin = azimuth + uTime * 0.38;
                    float turbulence = 0.58 + 0.19 * sin(plane * 12.1 + cos(spin * 3.0) * 1.4)
                        + 0.13 * sin(plane * 25.0 - spin * 3.0) + 0.10 * sin(spin * 7.0 + plane * 6.0);
                    float arcR = length(vec2(p.x, (p.y - 0.04) * 0.88));
                    float farArc = exp(-abs(arcR - 1.16) * 14.0) * smoothstep(-0.33, 0.5, p.y);
                    farArc *= 0.68 + 0.32 * cos(azimuth * 4.0 - uTime * 0.48);
                    float photon = exp(-abs(r - 0.996) / (0.019 + edge)) * (0.29 + warmSide * 0.48);
                    float glow = exp(-abs(plane - 1.46) * 1.65) * (1.0 - horizon) * 0.12;
                    float jet = exp(-abs(p.x) * (7.0 - min(abs(p.y), 4.0)))
                        * smoothstep(1.2, 2.0, abs(p.y)) * (1.0 - smoothstep(2.25, 4.7, abs(p.y)));
                    vec3 disk = mix(uColorB, uColorSun, 0.55);
                    vec3 emission = disk * (gas * turbulence * warmSide * 2.35 + farArc * warmSide * 1.15 + glow)
                        + uColorSun * photon * 0.95 + uColorA * jet * 0.095;
                    return mix(background, vec3(0.0009, 0.0011, 0.0017), horizon) + emission * (0.54 + 0.46 * read);
                }
                void main() {
                    vec3 d = normalize(vDir);
                    vec2 lens = vec2(0.0);
                    float lensRange = 5.1;
                    if (uHole.x > 0.001 && dot(d, uHoleDir) > 0.0) {
                        lens = vec2(dot(d, uHoleRight), dot(d, uHoleUp)) / uHole.y;
                        lensRange = length(lens);
                        if (lensRange < 5.1) {
                            float bend = 0.36 / (0.48 + lensRange * lensRange) * (1.0 - smoothstep(2.7, 5.1, lensRange));
                            d = normalize(d - (uHoleRight * lens.x + uHoleUp * lens.y) * (bend * uHole.x * uHole.y));
                        }
                    }
                    float lat = asin(clamp(d.y, -1.0, 1.0));
                    vec2 uv = vec2(atan(d.x, -d.z) / 6.2831853 + 0.5, lat / 3.14159265 + 0.5);
                    vec4 m = texture2D(uMasks, uv);
                    // Whatever lies behind the reading area steps back.
                    vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
                    float read = mix(0.3, 1.0, smoothstep(0.12, 0.9, length(ndc * vec2(0.75, 1.4))));
                    // One star to a cell of the sky, more of them along the galaxy, a pixel or two wide.
                    vec2 g = uv * vec2(440.0, 220.0), cell = floor(g);
                    float pick = hash(cell), mag = pow(hash(cell + 5.1), 7.0);
                    vec2 at = 0.2 + 0.6 * vec2(hash(cell + 17.3), hash(cell + 41.7));
                    float px = max(length(dFdx(g)), length(dFdy(g)));
                    float dist = length((fract(g) - at) * vec2(cos(lat), 1.0));
                    // The further out, the more stars, and the galaxy fills in.
                    float star = step(0.86 - m.b * (0.3 + 0.12 * uJourney) - uJourney * 0.035, pick) * smoothstep(px * (0.75 + mag * 0.9), px * 0.2, dist)
                        * (0.1 + 0.9 * mag) * (0.8 + 0.2 * sin(uTime * (0.6 + pick * 2.0) + pick * 40.0));
                    // Leaving home the sun shrinks towards a bright star and its glow draws in.
                    float far = uJourney * uJourney;
                    float reach = mix(1.0, 0.32, far);
                    float angle = acos(clamp(dot(d, ${glslVec3(SUN_AT)}), -1.0, 1.0)) / reach;
                    float disc = smoothstep(0.024, 0.008, angle);
                    float corona = (exp(-angle * 24.0) * 0.8 + exp(-angle * 6.5) * 0.14 + exp(-angle * 2.2) * 0.03)
                        * mix(1.0, 0.55, far);
                    // Six thin rays, as a lens draws a point of light.
                    vec3 sunward = ${glslVec3(SUN_AT)};
                    vec3 across = normalize(cross(vec3(0.0, 1.0, 0.0), sunward)), up = cross(sunward, across);
                    vec2 offset = vec2(dot(d, across), dot(d, up));
                    float rays = 0.0;
                    for (int i = 0; i < 3; i++) {
                        float turn = 0.35 + float(i) * 1.0472;
                        vec2 axis = vec2(cos(turn), sin(turn));
                        rays += exp(-abs(dot(offset, vec2(-axis.y, axis.x))) * 420.0) * exp(-abs(dot(offset, axis)) * 15.0);
                    }
                    corona += rays * 0.17 * step(0.0, dot(d, sunward));

                    // A comet low on the far side: a small bright coma, a broad dust
                    // tail curving away from the sun and a thin straight one of gas.
                    vec3 comet = ${glslVec3(COMET_AT)};
                    vec3 away = normalize(comet * dot(comet, sunward) - sunward), side = cross(comet, away);
                    vec3 from = d - comet;
                    float along = dot(from, away), off = dot(from, side), gone = max(along, 0.0);
                    // Passing close, it grows: the coma swells, both tails stretch
                    // across the sky, the dust tail shows striations, and jets of
                    // gas fan out sunward from the nucleus.
                    float grow = 1.0 + 3.0 * uComet;
                    float coma = exp(-length(from) * 190.0 / grow) * 0.9 + exp(-length(from) * 46.0 / grow) * 0.1 * (1.0 + uComet);
                    float bend = off - gone * gone * 0.55 / grow;
                    float striae = 1.0 - 0.35 * uComet * smoothstep(0.3, 0.8, bandNoise(bend * 900.0 / grow + gone * 40.0));
                    float dustTail = exp(-bend * bend / ((0.00006 + gone * 0.008) * grow)) * exp(-gone * 6.5 / grow)
                        * step(0.0, along) * 0.2 * (1.0 + 0.8 * uComet) * striae;
                    float gasTail = exp(-off * off / ((0.00001 + gone * 0.0005) * grow)) * exp(-gone * 4.2 / grow)
                        * step(0.0, along) * 0.16 * (1.0 + uComet);
                    float jets = 0.0;
                    if (uComet > 0.001) {
                        for (int i = 0; i < 3; i++) {
                            float turn = 2.55 + float(i) * 0.48;
                            vec2 aim = vec2(cos(turn), sin(turn));
                            vec2 at = vec2(along, off);
                            float reachOut = dot(at, aim), across = dot(at, vec2(-aim.y, aim.x));
                            jets += exp(-across * across / (0.0000003 + reachOut * reachOut * 0.015)) * step(0.0, reachOut)
                                * exp(-reachOut * 110.0 / grow);
                        }
                        jets *= uComet * 0.35;
                    }
                    float cometSide = step(0.0, dot(d, comet));

                    // Out at the end of the voyage the nearer clouds of gas fall back
                    // a little; the galaxy shows through them in its stars.
                    float late = smoothstep(0.72, 0.98, uJourney);
                    vec3 night = uBase + uColorStar * m.b * 0.055;
                    // Thin gas takes the cloud's colour; where it is dense it brightens
                    // and pales, as lit gas does.
                    float coolCore = m.r * m.r * m.r, warmCore = m.g * m.g * m.g;
                    night += (uColorA * (m.r * 0.06 + coolCore * 0.07) + uColorB * (m.g * 0.05 + warmCore * 0.06)
                        + uColorStar * (coolCore + warmCore) * 0.015) * uNebula * (1.0 - 0.15 * late);
                    night *= (1.0 - m.a * 0.86) * read;
                    night += mix(uColorStar, vec3(1.0), 0.5) * star * (0.5 + 0.5 * read) * 1.3;
                    night += (mix(uColorStar, uColorSun, 0.5) * (coma + dustTail + jets) + uColorA * gasTail * 1.6)
                        * cometSide * (0.45 + 0.55 * read);
                    vec3 sunTone = mix(uColorSun, mix(uColorStar, vec3(1.0), 0.4), far * 0.6);
                    night += sunTone * (disc * 16.0 + corona * (0.6 + 0.4 * read));
                    // On a pale theme the same sky is washes of colour on paper.
                    vec3 paper = mix(uBase, uColorA, m.r * 0.3 * uNebula);
                    paper = mix(paper, uColorB, m.g * 0.22 * uNebula);
                    paper = mix(paper, uInk, m.a * 0.1 + star * 0.45
                        + m.b * smoothstep(0.35, 1.0, uJourney) * 0.07
                        + clamp(coma + dustTail + gasTail + jets, 0.0, 1.0) * 0.3 * cometSide);
                    // The sun on paper: a warm bloom with a white heart, since white
                    // alone would vanish into the page.
                    paper = mix(paper, uColorSun, clamp(corona * 1.6, 0.0, 1.0) * 0.8);
                    // A wide, faint radiance around it fills the page with light.
                    paper = mix(paper, mix(uColorSun, vec3(1.0), 0.45), exp(-angle * 1.5) * 0.5 * mix(1.0, 0.6, far));
                    paper = mix(paper, vec3(1.0), clamp(disc, 0.0, 1.0));

                    vec3 background = mix(night, paper, uPaper);
                    if (lensRange < 5.1) {
                        float mask = uHole.x * (1.0 - smoothstep(4.3, 5.1, lensRange));
                        background = mix(background, accretion(lens, background, read), mask);
                    }
                    if (any(isnan(background)) || any(isinf(background))) background = vec3(0.0);
                    gl_FragColor = vec4(min(max(background, vec3(0.0)), vec3(64.0)), 1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `
        });
        const skyDome = new T.Mesh(skyGeo, skyMat);
        skyDome.frustumCulled = false;
        skyDome.renderOrder = -10;
        root.add(skyDome);
        // The cloud map is drawn once the renderer exists, and again after a lost context.
        const prepare = (renderer) => {
            const quad = new T.Mesh(new T.PlaneGeometry(2, 2), skyBakeMat);
            const previous = renderer.getRenderTarget();
            renderer.setRenderTarget(skyMasks);
            renderer.render(quad, new T.Camera());
            renderer.setRenderTarget(previous);
            quad.geometry.dispose();
        };

        /* ------------------------------------------------------------------------
         * 层级 2：深空结项引力丝束 (Geodesic Braided Filaments)
         * 三股沿深空弯曲航道相互缠绕的李萨如/环面结光丝，在画面边缘勾勒出幽邃的空间曲率，
         * 并在中央阅读区自动压暗让位。
         * ------------------------------------------------------------------------ */
        const FILAMENT_STRANDS = 3;
        const FILAMENT_SEGMENTS = 480;
        const filamentVertCount = FILAMENT_STRANDS * FILAMENT_SEGMENTS * 6;
        const filamentPos = new Float32Array(filamentVertCount * 3);
        const filamentAddr = new Float32Array(filamentVertCount * 3); // x: segIdx, y: strandIdx, z: side(-1/+1)
        const quadCorners = [[0, -1], [1, -1], [0, 1], [0, 1], [1, -1], [1, 1]];
        let fv = 0;
        for (let strand = 0; strand < FILAMENT_STRANDS; strand += 1) {
            for (let seg = 0; seg < FILAMENT_SEGMENTS; seg += 1) {
                for (const [endOff, side] of quadCorners) {
                    filamentAddr.set([seg + endOff, strand, side], fv * 3);
                    fv += 1;
                }
            }
        }
        const filamentGeo = new T.BufferGeometry();
        filamentGeo.setAttribute('position', new T.BufferAttribute(filamentPos, 3));
        filamentGeo.setAttribute('aAddr', new T.BufferAttribute(filamentAddr, 3));

        const filamentMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: T.DoubleSide,
            blending: T.AdditiveBlending,
            uniforms: {
                uTravel: { value: 0 },
                uTime: { value: 0 },
                uMotion: { value: 1 },
                uKnotFlow: { value: 0.6 },
                uAudioPulse: { value: 0 },
                uGlow: { value: 1 },
                uPhaseA: { value: 0 },
                uPhaseB: { value: 0 },
                uViewport: { value: new T.Vector2(1280, 720) },
                uColorA: { value: new T.Color('#76bfae') },
                uColorB: { value: new T.Color('#f2a900') },
                uColorC: { value: new T.Color('#8fa4b3') }
            },
            vertexShader: `
                attribute vec3 aAddr;
                uniform float uTravel, uTime, uMotion, uKnotFlow, uAudioPulse, uPhaseA, uPhaseB;
                uniform vec2 uViewport;
                varying float vSide;
                varying float vStrand;
                varying float vAlpha;
                varying float vPulse;

                vec2 spineXY(float s) {
                    float x = (sin(s * 0.0029 + uPhaseA) * 22.0 + cos(s * 0.0067 + uPhaseB) * 9.5) * uMotion;
                    float y = (cos(s * 0.0023 + uPhaseB) * 13.5 + sin(s * 0.0053 + uPhaseA * 0.7) * 6.0) * uMotion;
                    return vec2(x, y);
                }

                vec3 braidedFilamentAt(float s, float strand) {
                    vec2 center = spineXY(s);
                    // (p,q) 结项缠绕相位：三股丝线围绕深空航道形成呼吸式李萨如结
                    float tau = 6.2831853;
                    float strandAngle = strand * (tau / 3.0);
                    float theta = s * 0.0068 + strandAngle + 0.55 * sin(s * 0.0021 + strand * 1.9);
                    float knotHarmonic = sin(s * 0.017 + strand * 2.094 + uTime * 0.28);
                    float rx = (34.0 + 14.0 * knotHarmonic + 6.0 * cos(s * 0.0043)) * (0.78 + 0.22 * uKnotFlow);
                    float ry = (21.0 + 9.0 * cos(s * 0.013 - strand * 1.4)) * (0.78 + 0.22 * uKnotFlow);
                    vec2 knotOffset = vec2(
                        cos(theta) * rx + sin(theta * 2.0) * 6.5,
                        sin(theta) * ry + cos(theta * 3.0) * 4.2
                    );
                    return vec3(center + knotOffset, -s);
                }

                void main() {
                    float stepLen = 3.6;
                    float s = (floor(uTravel / stepLen) - 18.0 + aAddr.x) * stepLen;
                    vec3 p0 = braidedFilamentAt(s, aAddr.y);
                    vec3 p1 = braidedFilamentAt(s + 0.8, aAddr.y);

                    vec4 mv0 = modelViewMatrix * vec4(p0, 1.0);
                    vec4 clip0 = projectionMatrix * mv0;
                    vec4 clip1 = projectionMatrix * (modelViewMatrix * vec4(p1, 1.0));

                    vec2 screen0 = clip0.xy / max(0.1, clip0.w) * uViewport;
                    vec2 screen1 = clip1.xy / max(0.1, clip1.w) * uViewport;
                    vec2 dir = screen1 - screen0;
                    vec2 tangent = dir / max(0.001, length(dir));
                    vec2 normal = vec2(-tangent.y, tangent.x);

                    float pulseWave = fract(s * 0.0024 - uTime * 0.16 + aAddr.y * 0.333);
                    vPulse = exp(-pow((pulseWave - 0.5) * 14.0, 2.0));

                    float widthPx = (1.35 + 0.85 * vPulse + 0.45 * sin(s * 0.019 + aAddr.y)) * (0.85 + uKnotFlow * 0.35);
                    clip0.xy += normal * aAddr.z * widthPx * 2.0 / uViewport * clip0.w;
                    gl_Position = clip0;

                    vSide = aAddr.z;
                    vStrand = aAddr.y;

                    float depth = max(0.1, -mv0.z);
                    // 空间断续与中央阅读区避让
                    float cell = floor(s / 38.0);
                    float h = fract(sin(cell * 17.13 + aAddr.y * 53.7) * 43758.5453);
                    float gapMask = smoothstep(0.14, 0.34, h);

                    vec2 ndc = clip0.xy / max(0.1, clip0.w);
                    float centerClear = smoothstep(0.24, 0.68, length(ndc * vec2(0.95, 1.35)));
                    float nearFade = smoothstep(14.0, 75.0, depth);
                    float farFade = 1.0 - smoothstep(1100.0, 1620.0, depth);

                    vAlpha = nearFade * farFade * gapMask * (0.07 + 0.24 * vPulse) * (0.22 + 0.78 * centerClear) * (1.0 + uAudioPulse * 0.28);
                }
            `,
            fragmentShader: `
                uniform vec3 uColorA, uColorB, uColorC;
                uniform float uGlow;
                varying float vSide, vStrand, vAlpha, vPulse;

                void main() {
                    float profile = exp(-vSide * vSide * 5.8) + exp(-vSide * vSide * 1.4) * 0.22 * uGlow;
                    vec3 col = vStrand < 0.5 ? uColorA : (vStrand < 1.5 ? uColorB : uColorC);
                    col = mix(col, uColorB, vPulse * 0.45);
                    gl_FragColor = vec4(col * (1.0 + vPulse * 0.65 * uGlow), profile * vAlpha);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `
        });
        const filamentMesh = new T.Mesh(filamentGeo, filamentMat);
        filamentMesh.frustumCulled = false;
        root.add(filamentMesh);

        /* ------------------------------------------------------------------------
         * 层级 3：曲率跃迁微光丝 (Hyper-Warp Geodesic Streaks)
         * 相机相对循环，随副歌 warp 强度与低频脉冲自然拉长，赋予高速深空穿梭感。
         * ------------------------------------------------------------------------ */
        const STREAK_COUNT = 180;
        const streakPos = new Float32Array(STREAK_COUNT * 2 * 3);
        const streakMeta = new Float32Array(STREAK_COUNT * 2 * 3); // x: end(0/1), y: seed1, z: seed2
        const streakRand = seededRandom('abyssal-warp-v2');
        for (let i = 0; i < STREAK_COUNT; i += 1) {
            const angle = streakRand() * TAU;
            const radius = 22 + Math.pow(streakRand(), 1.2) * 125;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius * 0.68;
            const z = -streakRand() * 1600;
            const s1 = streakRand();
            const s2 = streakRand();
            for (let e = 0; e < 2; e += 1) {
                const idx = (i * 2 + e) * 3;
                streakPos.set([x, y, z], idx);
                streakMeta.set([e, s1, s2], idx);
            }
        }
        const streakGeo = new T.BufferGeometry();
        streakGeo.setAttribute('position', new T.BufferAttribute(streakPos, 3));
        streakGeo.setAttribute('aMeta', new T.BufferAttribute(streakMeta, 3));

        const streakMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                uCamPos: { value: new T.Vector3() },
                uStretch: { value: 0.2 },
                uGlow: { value: 1 },
                uColorA: { value: new T.Color('#dce6ee') },
                uColorB: { value: new T.Color('#76bfae') }
            },
            vertexShader: `
                attribute vec3 aMeta;
                uniform vec3 uCamPos;
                uniform float uStretch;
                varying float vAlpha;
                varying float vSeed;

                void main() {
                    vSeed = aMeta.y;
                    vec3 box = vec3(280.0, 190.0, 1600.0);
                    vec3 rel = mod(position - uCamPos + box * 0.5, box) - box * 0.5;
                    rel.z = mod(position.z - uCamPos.z * 1.35, 1600.0) - 1540.0;
                    float len = 3.5 + uStretch * (28.0 + aMeta.z * 92.0);
                    float headDepth = -rel.z;
                    rel.z -= aMeta.x * len;

                    vec3 worldPos = uCamPos + rel;
                    vec4 mv = modelViewMatrix * vec4(worldPos, 1.0);
                    gl_Position = projectionMatrix * mv;

                    float depth = max(0.1, -mv.z);
                    float fade = smoothstep(22.0, 85.0, headDepth) * (1.0 - smoothstep(1050.0, 1520.0, depth));
                    vAlpha = fade * clamp(uStretch, 0.0, 1.2) * (0.08 + aMeta.y * 0.28) * mix(1.0, 0.04, aMeta.x);
                }
            `,
            fragmentShader: `
                uniform vec3 uColorA, uColorB;
                uniform float uGlow;
                varying float vAlpha;
                varying float vSeed;

                void main() {
                    vec3 col = mix(uColorA, uColorB, vSeed * 0.45);
                    gl_FragColor = vec4(col * (1.0 + uGlow * 0.35), vAlpha);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `
        });
        const streakLines = new T.LineSegments(streakGeo, streakMat);
        streakLines.frustumCulled = false;
        root.add(streakLines);

        /* ------------------------------------------------------------------------
         * 层级 4：GPU 驱动的深空天体与粒子结项巨构 (GPU Celestial & Knotted Manifolds)
         * 8 个遭遇槽位各自为独立 Points 节点，模型顶点完全常驻 GPU 显存！
         * 凝聚 (Cohesion)、李萨如结项涡流散射 (Knot Swirl Dissolve)、晨昏线光照与边缘散射
         * 100% 在 Vertex/Fragment Shader 内完成，CPU 每帧仅更新 8 个 Object3D 的位置与 4 个 uniform！
         * ------------------------------------------------------------------------ */
        const POINTS_PER_ENTITY = 2200;
        const manifoldTemplates = createManifoldTemplates(POINTS_PER_ENTITY);
        const fuse = (parts) => {
            const position = [], normal = [], uv = [], part = [], index = [];
            for (const [geometry, code] of parts) {
                const base = position.length / 3;
                const count = geometry.attributes.position.count;
                position.push(...geometry.attributes.position.array);
                normal.push(...geometry.attributes.normal.array);
                uv.push(...(geometry.attributes.uv?.array || new Float32Array(count * 2)));
                for (let i = 0; i < count; i += 1) part.push(code);
                if (geometry.index) for (const i of geometry.index.array) index.push(i + base);
                else for (let i = 0; i < count; i += 1) index.push(i + base);
                geometry.dispose();
            }
            const fused = new T.BufferGeometry();
            fused.setAttribute('position', new T.Float32BufferAttribute(position, 3));
            fused.setAttribute('normal', new T.Float32BufferAttribute(normal, 3));
            fused.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
            fused.setAttribute('aPart', new T.Float32BufferAttribute(part, 1));
            fused.setIndex(index);
            return fused;
        };

        // Stations are built the way the ones in orbit are: pressurised
        // cylinders joined at nodes, a truss, solar wings, radiators, a
        // visiting ship on a port. Part codes: 3 module, 4 solar wing, 5 truss,
        // 6 radiator, 2 lamp. Module and truss maps are laid out in real
        // lengths so plating stays the same size on every piece.
        const stationGeometries = new Map();
        const stationGeometry = (spec) => {
            if (stationGeometries.has(spec)) return stationGeometries.get(spec);
            const k = spec.radius / 25;
            const parts = [];
            let serial = 0;
            const sized = (geometry, around, along) => {
                const uv = geometry.attributes.uv;
                serial += 1;
                for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * around / 8, uv.getY(i) * Math.min(1.9, along / 8) + serial * 2);
                return geometry;
            };
            // axis: 'x' | 'y' | 'z'; at: centre
            const turn = (geometry, axis) => axis === 'x' ? geometry.rotateZ(Math.PI / 2) : axis === 'z' ? geometry.rotateX(Math.PI / 2) : geometry;
            const module = (r, length, axis, at, code = 3) => {
                parts.push([turn(sized(new T.CylinderGeometry(r * k, r * k, length * k, 18, 1), TAU * r, length), axis)
                    .translate(at[0] * k, at[1] * k, at[2] * k), code]);
            };
            const cone = (r0, r1, length, axis, at) => {
                parts.push([turn(sized(new T.CylinderGeometry(r0 * k, r1 * k, length * k, 16, 1), TAU * r1, length), axis)
                    .translate(at[0] * k, at[1] * k, at[2] * k), 3]);
            };
            const beam = (r, length, axis, at, sides = 4) => {
                parts.push([turn(sized(new T.CylinderGeometry(r * k, r * k, length * k, sides, 1), 4, length), axis)
                    .translate(at[0] * k, at[1] * k, at[2] * k), r >= 0.5 ? 5 : 7]);
            };
            const node = (r, at) => {
                parts.push([sized(new T.SphereGeometry(r * k, 16, 10), TAU * r, r * 3).translate(at[0] * k, at[1] * k, at[2] * k), 3]);
            };
            // Stowage and experiments bolted along a truss or a hull.
            const crate = (size, at) => {
                parts.push([sized(new T.BoxGeometry(size[0] * k, size[1] * k, size[2] * k), size[0] * 4, size[1] * 2)
                    .translate(at[0] * k, at[1] * k, at[2] * k), 3]);
            };
            // A dish on a short mast, and a jointed arm.
            const dish = (r, at, tilt) => {
                parts.push([new T.ConeGeometry(r * k, r * 0.45 * k, 20, 1, true).rotateX(tilt).translate(at[0] * k, at[1] * k, at[2] * k), 7]);
                parts.push([new T.CylinderGeometry(0.06 * k, 0.06 * k, r * 1.4 * k, 5, 1, true).translate(at[0] * k, (at[1] - r * 0.8) * k, at[2] * k), 7]);
            };
            const arm = (from, elbow, to) => {
                for (const [a, b] of [[from, elbow], [elbow, to]]) {
                    const span = new T.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
                    const g = new T.CylinderGeometry(0.11 * k, 0.11 * k, span.length() * k, 6, 1, true);
                    g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), span.clone().normalize()));
                    parts.push([g.translate((a[0] + b[0]) / 2 * k, (a[1] + b[1]) / 2 * k, (a[2] + b[2]) / 2 * k), 7]);
                }
                node(0.2, elbow);
            };
            // A flat panel: long side along `axis`, lying in the plane that holds `across`.
            const panel = (length, width, axis, across, at, code) => {
                const g = new T.BoxGeometry(length * k, 0.06 * k, width * k);
                if (axis === 'z') g.rotateY(Math.PI / 2);
                if (axis === 'y') { g.rotateZ(Math.PI / 2); if (across === 'x') g.rotateY(Math.PI / 2); }
                if (axis === 'x' && across === 'y') g.rotateX(Math.PI / 2);
                if (axis === 'z' && across === 'y') g.rotateZ(Math.PI / 2);
                parts.push([g.translate(at[0] * k, at[1] * k, at[2] * k), code]);
            };
            const visitor = (z, facing) => {
                // A capsule on a docking port: service module, crew cone, two small wings.
                module(1.0, 2.6, 'z', [0, 0, z]);
                cone(facing > 0 ? 1.0 : 0.45, facing > 0 ? 0.45 : 1.0, 1.5, 'z', [0, 0, z - facing * 2.05]);
                panel(3.2, 1.1, 'x', 'z', [2.7, 0, z + facing * 0.6], 4);
                panel(3.2, 1.1, 'x', 'z', [-2.7, 0, z + facing * 0.6], 4);
            };
            // A rod between two points, and a can (open-ended tapering drum) along an axis.
            const rod = (a, b, r, code = 7, sides = 5) => {
                const span = new T.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
                const g = sized(new T.CylinderGeometry(r * k, r * k, span.length() * k, sides, 1), 4, span.length());
                g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), span.clone().normalize()));
                parts.push([g.translate((a[0] + b[0]) / 2 * k, (a[1] + b[1]) / 2 * k, (a[2] + b[2]) / 2 * k), code]);
            };
            const can = (top, bottom, length, axis, at, code, sides = 20) => {
                parts.push([turn(sized(new T.CylinderGeometry(top * k, bottom * k, length * k, sides, 1), TAU * Math.max(top, bottom), length), axis)
                    .translate(at[0] * k, at[1] * k, at[2] * k), code]);
            };
            // A panel turned freely: length along `dir` (in the xz-plane or any), face normal `facing`.
            const sheet = (length, width, centre, dir, facing, code) => {
                const g = new T.BoxGeometry(width * k, 0.06 * k, length * k);
                const z = new T.Vector3(...dir).normalize(), y = new T.Vector3(...facing).normalize();
                const x = new T.Vector3().crossVectors(y, z).normalize();
                g.applyMatrix4(new T.Matrix4().makeBasis(x, new T.Vector3().crossVectors(z, x), z));
                parts.push([g.translate(centre[0] * k, centre[1] * k, centre[2] * k), code]);
            };
            // The command and service modules of a lunar ship, nose towards +z
            // (or -z), sitting on the given point: the conical capsule, the
            // service module with its thruster quads, the big engine bell and
            // the four-dish antenna swung out on its boom.
            const lunarShip = (z, facing) => {
                const f = facing, at = (dz) => [0, 0, z + dz * f];
                can(f > 0 ? 0.32 : 1.95, f > 0 ? 1.95 : 0.32, 3.2, 'z', at(5.3), 8, 28);
                can(1.95, 1.95, 7.4, 'z', at(0), 8, 28);
                can(1.98, 1.98, 0.5, 'z', at(3.45), 9, 28);
                can(f > 0 ? 0.55 : 1.3, f > 0 ? 1.3 : 0.55, 2.8, 'z', at(-5.1), 7, 20);
                can(0.7, 0.7, 0.6, 'z', at(-3.9), 9, 14);
                for (let i = 0; i < 4; i += 1) {
                    const a = i * TAU / 4 + 0.4, x = Math.cos(a) * 2.15, y = Math.sin(a) * 2.15;
                    crate([0.55, 0.55, 0.9], [x, y, z + 2.2 * f]);
                    for (const d of [-1, 1]) rod([x, y, z + 2.2 * f], [x * 1.25, y * 1.25, z + (2.2 + d * 0.7) * f], 0.08, 7, 6);
                }
                rod([1.4, -1.4, z - 3.6 * f], [3.6, -3.6, z - 5.4 * f], 0.1);
                for (const [dx, dy] of [[0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]]) {
                    parts.push([new T.ConeGeometry(0.42 * k, 0.22 * k, 14, 1, true).rotateX(-f * Math.PI / 2)
                        .translate((3.6 + dx) * k, (-3.6 + dy) * k, (z - 5.6 * f) * k), 8]);
                }
            };
            if (spec.plan === 'hubble') {
                // A space telescope of the first kind: a long tube in silver blankets, the
                // wider aft shroud, the aperture door swung open, two long
                // solar wings out on masts, two dish antennas on booms, handrails.
                can(2.15, 2.15, 7.6, 'z', [0, 0, -4.4], 8, 28);
                can(1.6, 1.6, 9.0, 'z', [0, 0, 4.3], 8, 28);
                can(1.62, 1.62, 0.25, 'z', [0, 0, 8.7], 9, 28);
                can(2.18, 2.18, 0.35, 'z', [0, 0, -8.1], 8, 28);
                can(2.0, 2.0, 0.3, 'z', [0, 0, -0.65], 7, 28);
                // The door, hinged at the top of the aperture and standing open.
                parts.push([new T.CylinderGeometry(1.62 * k, 1.62 * k, 0.12 * k, 24, 1).rotateX(-0.35)
                    .translate(0, 3.3 * k, 9.5 * k), 8]);
                rod([0, 1.62, 8.8], [0, 2.4, 9.3], 0.12, 7, 6);
                for (const side of [-1, 1]) {
                    rod([side * 2.1, 0, -2.2], [side * 4.0, 0, -2.2], 0.14, 7, 6);
                    sheet(11.8, 2.5, [side * 4.0, 0, -2.2], [0, 0, 1], [side * 0.2, 1, 0], 4);
                    rod([side * 4.0, 0, -8.2], [side * 4.0, 0, 3.8], 0.06, 7, 6);
                    rod([0, side * 2.15, -3.5], [0, side * 4.3, -3.5], 0.08, 7, 6);
                    parts.push([new T.ConeGeometry(0.85 * k, 0.4 * k, 18, 1, true).rotateX(side > 0 ? Math.PI : 0)
                        .translate(0, side * 4.6 * k, -3.5 * k), 8]);
                }
                for (let i = 0; i < 8; i += 1) {
                    const a = i * TAU / 8 + 0.2;
                    rod([Math.cos(a) * 1.75, Math.sin(a) * 1.75, 0.2], [Math.cos(a) * 1.75, Math.sin(a) * 1.75, 8.2], 0.05, 7, 4);
                }
                for (const [x, y] of [[1.6, 1.4], [-1.9, 1.0]]) crate([0.8, 0.5, 1.6], [x, y, -6.2]);
            } else if (spec.plan === 'apollo') {
                // A lunar ship as it was flown out: the command and service
                // modules with the lander docked at the nose, its legs out.
                lunarShip(-3.0, 1);
                can(0.55, 0.55, 1.2, 'z', [0, 0, 4.4], 7, 14);
                // Ascent stage: a faceted cabin, a docking tunnel, a dish and windows.
                can(1.9, 2.1, 2.6, 'z', [0, 0, 6.3], 3, 7);
                crate([2.6, 1.8, 1.6], [0, -1.6, 6.6]);
                crate([1.2, 1.2, 2.2], [2.1, 0.6, 6.2]);
                dish(0.6, [-1.6, 2.4, 6.2], 0.6);
                // Descent stage: an octagon in gold foil, four legs and footpads.
                can(2.4, 2.4, 1.8, 'z', [0, 0, 8.6], 9, 8);
                can(0.9, 1.2, 0.8, 'z', [0, 0, 9.9], 7, 14);
                for (let i = 0; i < 4; i += 1) {
                    const a = i * TAU / 4 + TAU / 8, cx = Math.cos(a), cy = Math.sin(a);
                    rod([cx * 2.2, cy * 2.2, 8.0], [cx * 4.6, cy * 4.6, 10.8], 0.13);
                    rod([cx * 2.3, cy * 2.3, 9.4], [cx * 4.0, cy * 4.0, 10.2], 0.08);
                    parts.push([new T.CylinderGeometry(0.55 * k, 0.45 * k, 0.2 * k, 14, 1).rotateX(Math.PI / 2)
                        .translate(cx * 4.7 * k, cy * 4.7 * k, 11.0 * k), 8]);
                }
            } else if (spec.plan === 'mir') {
                // The modular station: a core with a docking node at its head,
                // five laboratories reaching out from the node and aft, each
                // with its own wings, the long girder on the aft module, ships docked.
                module(2.05, 13, 'z', [0, 0, 0]);
                node(1.75, [0, 0, 7.6]);
                module(2.1, 5.6, 'z', [0, 0, -9.3]);
                for (const [axis, sign] of [['x', 1], ['x', -1], ['y', 1], ['y', -1]]) {
                    const along = (d) => axis === 'x' ? [sign * d, 0, 7.6] : [0, sign * d, 7.6];
                    module(2.05, 11.2, axis, along(7.4));
                    module(1.4, 1.4, axis, along(13.6));
                    const tip = along(9.5), up = axis === 'x' ? [0, 1, 0] : [1, 0, 0];
                    for (const s2 of [-1, 1]) {
                        const c = [tip[0] + up[0] * s2 * 6.4, tip[1] + up[1] * s2 * 6.4, tip[2]];
                        sheet(9.4, 2.5, c, up, [0, 0, 1], 4);
                        rod([tip[0] + up[0] * s2 * 2.0, tip[1] + up[1] * s2 * 2.0, tip[2]], [c[0] - up[0] * s2 * 4.6, c[1] - up[1] * s2 * 4.6, c[2]], 0.1);
                    }
                }
                for (const side of [-1, 1]) {
                    sheet(10.5, 3.0, [side * 8.0, 0, -1.5], [1, 0, 0], [0, 0.3, 1], 4);
                    rod([side * 2.05, 0, -1.5], [side * 2.8, 0, -1.5], 0.12);
                }
                beam(0.32, 14, 'y', [0, 9.1, -9.3], 4);
                crate([1.4, 1.4, 1.4], [0, 16.5, -9.3]);
                visitor(10.6, 1);
                visitor(-14.4, -1);
                dish(1.0, [2.4, 2.2, 3.0], 0.3);
                for (const at of [[0, 0, 15.6], [0, 0, -18.5], [0, 16.8, -9.3]]) {
                    parts.push([new T.IcosahedronGeometry(0.24 * k, 1).translate(at[0] * k, at[1] * k, at[2] * k), 2]);
                }
            } else if (spec.plan === 'skylab') {
                // The first workshop in orbit: a broad white cylinder with a gold
                // sunshade spread over it and a single wing (the other was lost),
                // the solar observatory in its windmill of four wings, and a
                // lunar-type ship docked at the front.
                can(3.3, 3.3, 14.6, 'z', [0, 0, -4.0], 8, 32);
                can(3.32, 3.32, 0.4, 'z', [0, 0, 3.2], 7, 32);
                can(3.32, 3.32, 0.4, 'z', [0, 0, -11.3], 7, 32);
                can(1.6, 3.3, 1.6, 'z', [0, 0, -12.1], 8, 32);
                sheet(9.0, 7.2, [0, 3.45, -4.0], [0, 0, 1], [0, 1, 0.05], 11);
                rod([3.3, 0, -3.5], [5.2, 0, -3.5], 0.15);
                sheet(9.5, 3.6, [10.0, 0, -3.5], [1, 0, 0], [0, 1, 0.2], 4);
                rod([5.2, 0, -3.5], [14.8, 0, -3.5], 0.08);
                can(1.65, 1.65, 4.6, 'z', [0, 0, 5.6], 3, 18);
                can(1.5, 1.5, 4.2, 'z', [0, 0, 10.0], 9, 18);
                lunarShip(17.2, -1);
                // Observatory on its strut, with four wings in an X.
                rod([0, 1.5, 9.6], [0, 4.6, 9.6], 0.25, 5, 4);
                can(1.8, 1.8, 3.4, 'z', [0, 5.6, 9.6], 9, 8);
                for (let i = 0; i < 4; i += 1) {
                    const a = i * TAU / 4 + TAU / 8, d = [Math.cos(a), Math.sin(a), 0];
                    sheet(9.0, 2.6, [d[0] * 6.6, 5.6 + d[1] * 6.6, 9.6], d, [0, 0, 1], 4);
                    rod([d[0] * 1.8, 5.6 + d[1] * 1.8, 9.6], [d[0] * 2.2, 5.6 + d[1] * 2.2, 9.6], 0.12);
                }
            } else if (spec.plan === 'sputnik') {
                // The first: a polished sphere with four whip antennas swept
                // back in two pairs, shown far larger than life.
                parts.push([new T.SphereGeometry(2.9 * k, 40, 26), 8]);
                can(0.55, 0.55, 0.4, 'z', [0, 0, 2.9], 7, 12);
                parts.push([new T.TorusGeometry(2.9 * k, 0.06 * k, 6, 48), 7]);
                for (const [x, y, len] of [[1, 1, 24], [-1, 1, 24], [1, -1, 28], [-1, -1, 28]]) {
                    const base = [x * 1.6, y * 1.6, 2.0];
                    rod(base, [x * 1.6 + x * len * 0.36, y * 1.6 + y * len * 0.22, 2.0 - len * 0.9], 0.07, 7, 5);
                    parts.push([new T.SphereGeometry(0.28 * k, 10, 8).translate(base[0] * k, base[1] * k, base[2] * k), 7]);
                }
            } else if (spec.plan === 'truss') {
                // A long truss across, eight solar wings, radiators, and a
                // spine of modules fore and aft with laboratories off a node.
                beam(0.85, 46, 'x', [0, 1.6, 0]);
                for (const x of [-21, -14.5, 14.5, 21]) {
                    beam(0.22, 23, 'z', [x, 1.6, 0], 6);
                    for (const side of [-1, 1]) {
                        for (const dx of [-1.45, 1.45]) panel(10.2, 2.5, 'z', 'x', [x + dx, 1.6, side * 6.6], 4);
                    }
                }
                for (const x of [-6.2, 6.2]) {
                    for (const dx of [-1.9, 0, 1.9]) panel(6.6, 1.7, 'z', 'y', [x + dx, 1.6, -5.2], 6);
                }
                module(1.35, 5.4, 'z', [0, 0, 8.3]);
                module(1.05, 1.6, 'z', [0, 0, 4.8]);
                module(1.35, 4.6, 'z', [0, 0, 1.6]);
                module(1.15, 2.2, 'z', [0, 0, -1.9]);
                module(1.3, 5.6, 'z', [0, 0, -5.9]);
                module(1.2, 5.0, 'z', [0, 0, -11.3]);
                module(1.3, 4.4, 'x', [3.5, 0, 8.4]);
                module(1.3, 5.2, 'x', [-3.9, 0, 8.4]);
                panel(4.2, 2.4, 'x', 'z', [-8.6, 0.3, 8.4], 7);
                node(1.5, [0, 0, 4.8]);
                node(1.3, [0, 0, -1.9]);
                for (const [x, up] of [[-17.8, 1], [-10.5, -1], [-3.2, 1], [3.4, -1], [10.3, 1], [17.6, -1], [-8, 1], [8.4, 1]]) {
                    crate([1.5, 0.8, 1.1], [x, 1.6 + up * 1.25, 0.2 * up]);
                }
                crate([1.0, 0.7, 2.4], [1.7, 0.4, -6.2]);
                crate([0.9, 0.6, 1.8], [-1.6, 0.5, 2.0]);
                dish(1.3, [3.2, 4.4, 1.2], -0.5);
                dish(0.8, [-1.2, 2.6, -11.0], 0.4);
                arm([1.2, 2.5, 3.2], [4.6, 5.0, 5.2], [3.0, 1.6, 8.2]);
                module(1.1, 3.4, 'y', [0, -2.7, 1.6]);
                module(1.0, 3.0, 'y', [0, -2.5, -5.9]);
                for (const side of [-1, 1]) panel(7.4, 1.5, 'x', 'z', [side * 5.2, 0, -11.6], 4);
                visitor(13.8, -1);
                visitor(-16.0, 1);
                for (const at of [[0, 3.1, 0], [-23.3, 1.6, 0], [23.3, 1.6, 0], [0, 0, 16.4], [0, 0, -19.4]]) {
                    parts.push([new T.IcosahedronGeometry(0.24 * k, 1).translate(at[0] * k, at[1] * k, at[2] * k), 2]);
                }
            } else if (spec.plan === 'telescope') {
                // A space telescope of the cold, far kind: a mirror of eighteen
                // gold hexagons standing on a kite-shaped sunshield of five
                // spaced films, a secondary mirror out on a tripod, and the
                // spacecraft bus on the sunward side. Part code 10: mirror.
                const strut = (a, b, r, code = 7, sides = 5) => {
                    const span = new T.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
                    const g = new T.CylinderGeometry(r * k, r * k, span.length() * k, sides, 1, true);
                    g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), span.clone().normalize()));
                    parts.push([g.translate((a[0] + b[0]) / 2 * k, (a[1] + b[1]) / 2 * k, (a[2] + b[2]) / 2 * k), code]);
                };
                const box = (size, at, code) => {
                    parts.push([sized(new T.BoxGeometry(size[0] * k, size[1] * k, size[2] * k), size[0] * 2, size[1] * 2)
                        .translate(at[0] * k, at[1] * k, at[2] * k), code]);
                };
                // Sunshield: five films, each a little smaller and higher than the last.
                for (let layer = 0; layer < 5; layer += 1) {
                    const grow = 1 - layer * 0.035;
                    const outline = [[-21, 0], [-13.5, 6.6], [0, 7.6], [13.5, 6.6], [21, 0], [13.5, -6.6], [0, -7.6], [-13.5, -6.6]];
                    const film = new T.ShapeGeometry(new T.Shape(outline.map(([x, z]) => new T.Vector2(x * grow * k, z * grow * k))));
                    const uv = film.attributes.uv;
                    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) / (11 * k) + layer * 3, uv.getY(i) / (11 * k));
                    parts.push([film.rotateX(-Math.PI / 2).translate(0, layer * 0.42 * k, 0), 11]);
                }
                // The booms and spreader bars that hold the films out.
                strut([-21, 0.8, 0], [21, 0.8, 0], 0.16);
                strut([0, 0.8, -7.6], [0, 0.8, 7.6], 0.16);
                for (const sx of [-1, 1]) for (const sz of [-1, 1]) strut([0, 0.8, 0], [sx * 13.5, 0.8, sz * 6.6], 0.08);
                // Mirror: two rings of hexagons round an open centre, facing +Z.
                const HEX = 1.42, MIRROR_Y = 9.2, MIRROR_Z = 0.6;
                for (let q = -2; q <= 2; q += 1) {
                    for (let r = -2; r <= 2; r += 1) {
                        if (Math.abs(q + r) > 2 || (q === 0 && r === 0)) continue;
                        const x = HEX * Math.sqrt(3) * (q + r / 2), y = HEX * 1.5 * r;
                        parts.push([new T.CylinderGeometry(HEX * 0.965 * k, HEX * 0.965 * k, 0.16 * k, 6, 1).rotateX(Math.PI / 2)
                            .translate(x * k, (MIRROR_Y + y) * k, MIRROR_Z * k), 10]);
                    }
                }
                // Backplane, the instrument module behind it, and the tower down to the shield.
                box([7.6, 7.2, 0.7], [0, MIRROR_Y, MIRROR_Z - 0.55], 7);
                box([4.6, 4.4, 2.6], [0, MIRROR_Y - 0.6, MIRROR_Z - 2.2], 9);
                box([3.4, 1.6, 0.12], [0, MIRROR_Y + 2.6, MIRROR_Z - 3.6], 6);
                box([1.5, 4.4, 1.5], [0, 3.6, MIRROR_Z - 1.4], 8);
                // Secondary mirror on three long struts; the baffle cone at the centre.
                const SECOND = [0, MIRROR_Y, MIRROR_Z + 8.6];
                strut([-3.5, MIRROR_Y - 3.2, MIRROR_Z], SECOND, 0.09);
                strut([3.5, MIRROR_Y - 3.2, MIRROR_Z], SECOND, 0.09);
                strut([0, MIRROR_Y + 4.3, MIRROR_Z], SECOND, 0.09);
                parts.push([new T.CylinderGeometry(0.55 * k, 0.55 * k, 0.14 * k, 16, 1).rotateX(Math.PI / 2)
                    .translate(SECOND[0] * k, SECOND[1] * k, SECOND[2] * k), 10]);
                parts.push([new T.ConeGeometry(0.75 * k, 2.2 * k, 12, 1, true).rotateX(Math.PI / 2)
                    .translate(0, MIRROR_Y * k, (MIRROR_Z + 1.2) * k), 7]);
                // Bus on the sunward side: a box, a solar array, a dish, a trim flap aft.
                box([3.2, 1.8, 3.2], [0, -1.3, 0], 9);
                panel(7.2, 2.2, 'z', 'x', [0, -2.6, -5.4], 4);
                parts.push([new T.ConeGeometry(0.9 * k, 0.45 * k, 16, 1, true).translate(1.2 * k, -3.0 * k, 1.0 * k), 7]);
                strut([1.2, -2.2, 1.0], [1.2, -3.2, 1.0], 0.07);
                strut([0, 0.4, -7.6], [0, -1.6, -11.6], 0.1);
                panel(3.6, 2.2, 'z', 'x', [0, -2.2, -12.6], 6);
                box([0.5, 0.5, 0.8], [-1.3, -2.4, 1.2], 8);
                box([0.5, 0.5, 0.8], [-0.6, -2.4, 1.5], 8);
            } else if (spec.plan === 'probe') {
                // A deep-space probe of the kind sent past the outer planets:
                // a great white dish over a ten-sided bus, three isotope
                // generators on one boom, the instruments on another, a long
                // lattice mast for the magnetometers and two whip antennas.
                // Part codes 8 and 9: painted and foil-wrapped, without ports.
                const strut = (a, b, r, code = 7, sides = 5) => {
                    const span = new T.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
                    const g = sized(new T.CylinderGeometry(r * k, r * k, span.length() * k, sides, 1, true), 4, span.length());
                    g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), span.clone().normalize()));
                    parts.push([g.translate((a[0] + b[0]) / 2 * k, (a[1] + b[1]) / 2 * k, (a[2] + b[2]) / 2 * k), code]);
                };
                const drum = (r, length, axis, at, code, sides = 16) => {
                    parts.push([turn(sized(new T.CylinderGeometry(r * k, r * k, length * k, sides, 1), TAU * r, length), axis)
                        .translate(at[0] * k, at[1] * k, at[2] * k), code]);
                };
                // The dish opens along +Y: a paraboloid with a rolled rim.
                const DISH = 11, DEPTH = 3.1;
                const profile = [];
                for (let i = 0; i <= 14; i += 1) {
                    const r = DISH * i / 14;
                    profile.push(new T.Vector2(r * k, DEPTH * (r / DISH) * (r / DISH) * k));
                }
                parts.push([sized(new T.LatheGeometry(profile, 48), 8, 8).translate(0, 2.4 * k, 0), 8]);
                parts.push([new T.TorusGeometry(DISH * k, 0.16 * k, 6, 48).rotateX(Math.PI / 2).translate(0, (2.4 + DEPTH) * k, 0), 7]);
                // Feed and subreflector on a tripod above the dish.
                for (let i = 0; i < 3; i += 1) {
                    const a = i * TAU / 3 + 0.5;
                    strut([Math.cos(a) * 7.6, 2.4 + DEPTH * 0.48, Math.sin(a) * 7.6], [Math.cos(a) * 0.9, 9.6, Math.sin(a) * 0.9], 0.1);
                }
                parts.push([new T.ConeGeometry(1.5 * k, 1.0 * k, 20, 1).translate(0, 9.9 * k, 0), 8]);
                parts.push([new T.CylinderGeometry(0.5 * k, 0.8 * k, 1.6 * k, 12, 1).translate(0, 3.3 * k, 0), 9]);
                // Six struts carry the dish on the bus; a fuel sphere sits in its middle.
                drum(4.6, 2.3, 'y', [0, -0.4, 0], 9, 10);
                for (let i = 0; i < 6; i += 1) {
                    const a = i * TAU / 6, b = a + TAU / 12;
                    strut([Math.cos(a) * 4.3, 0.7, Math.sin(a) * 4.3], [Math.cos(b) * 5.6, 2.4 + DEPTH * 0.26, Math.sin(b) * 5.6], 0.11);
                }
                node(2.1, [0, -1.7, 0]);
                for (let i = 0; i < 4; i += 1) {
                    const a = i * TAU / 4 + 0.4;
                    parts.push([new T.ConeGeometry(0.36 * k, 0.8 * k, 8, 1, true).translate(Math.cos(a) * 4.4 * k, -2.0 * k, Math.sin(a) * 4.4 * k), 7]);
                }
                // The record on the side of the bus.
                parts.push([new T.CylinderGeometry(1.05 * k, 1.05 * k, 0.1 * k, 24, 1).rotateZ(Math.PI / 2).translate(4.5 * k, -0.4 * k, 1.2 * k), 9]);
                // Isotope generators: three finned drums in line, out on a boom.
                strut([-3.6, -0.6, -1.4], [-10.5, -3.4, -4.2], 0.5, 5, 4);
                strut([-3.2, -1.4, 0.6], [-10.5, -3.4, -4.2], 0.09);
                for (let i = 0; i < 3; i += 1) {
                    const along = 11.9 + i * 3.1;
                    const at = [-along * 0.9, -3.4 - (along - 10.5) * 0.36, -4.2 - (along - 10.5) * 0.36];
                    const from = [at[0] + 1.3, at[1] + 0.52, at[2] + 0.52], to = [at[0] - 1.3, at[1] - 0.52, at[2] - 0.52];
                    strut(from, to, 0.85, 9, 12);
                    for (let f = 0; f < 6; f += 1) {
                        const fin = new T.BoxGeometry(0.05 * k, 2.5 * k, 0.8 * k).translate(0, 0, 1.2 * k).rotateY(f * TAU / 6);
                        fin.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0),
                            new T.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize()));
                        parts.push([fin.translate(at[0] * k, at[1] * k, at[2] * k), 6]);
                    }
                }
                // Science boom: a lattice arm to a platform that turns its cameras.
                strut([3.8, -0.4, -1.0], [14.5, -1.2, -3.6], 0.5, 5, 4);
                crate([1.6, 1.2, 1.4], [8.2, 0.2, -2.3]);
                drum(0.5, 3.2, 'y', [15.0, -1.6, -3.7], 8, 10);
                crate([2.6, 1.5, 1.3], [15.2, 0.6, -3.7]);
                drum(0.62, 2.8, 'z', [14.4, 0.7, -5.4], 9, 14);
                drum(0.4, 2.2, 'z', [15.9, 0.9, -5.1], 8, 12);
                crate([1.1, 1.9, 0.9], [15.4, -3.6, -3.5]);
                parts.push([new T.ConeGeometry(0.9 * k, 0.5 * k, 16, 1, true).rotateX(-1.2).translate(13.2 * k, 1.9 * k, -3.0 * k), 7]);
                // Magnetometer mast: far longer than the craft, a sensor midway and one at the tip.
                strut([-1.6, -1.2, 3.6], [-9.5, -6.5, 38], 0.5, 5, 3);
                crate([0.9, 0.9, 0.9], [-5.6, -3.9, 21]);
                crate([1.0, 1.0, 1.0], [-9.6, -6.6, 38.4]);
                // Two whips at right angles for the radio and plasma-wave receivers.
                strut([0.6, -1.6, -2.4], [15, -13, -21], 0.07);
                strut([-0.6, -1.6, -2.4], [-13, -15, -21], 0.07);
                // Louvred radiators and electronics bays round the bus.
                for (let i = 0; i < 10; i += 1) {
                    if (i % 3 === 0) continue;
                    const a = i * TAU / 10 + TAU / 20;
                    parts.push([new T.BoxGeometry(2.1 * k, 1.5 * k, 0.12 * k).translate(0, -0.4 * k, 4.5 * k).rotateY(a), i % 2 ? 6 : 8]);
                }
            } else {
                // A core with two laboratories off its forward node, each
                // carrying a great pair of wings at its far end.
                module(2.05, 7.4, 'z', [0, 0, -3.4]);
                module(1.4, 5.6, 'z', [0, 0, 3.0]);
                module(1.5, 2.6, 'z', [0, 0, 7.0]);
                for (const side of [-1, 1]) {
                    module(2.05, 8.6, 'x', [side * 5.8, 0, 7.0]);
                    module(1.35, 5.4, 'x', [side * 12.7, 0, 7.0]);
                    beam(0.28, 7.5, 'x', [side * 18.8, 0, 7.0], 6);
                    for (const up of [-1, 1]) panel(13.5, 3.3, 'y', 'z', [side * 20.5, up * 7.4, 7.0], 4);
                    panel(5.4, 1.5, 'x', 'z', [side * 4.6, 0, 1.6], 4);
                    panel(4.4, 1.4, 'z', 'y', [side * 2.2, 0.4, -4.2], 6);
                }
                beam(0.2, 5.2, 'y', [0, 4.0, -5.8], 6);
                panel(2.6, 2.6, 'x', 'z', [0, 6.7, -5.8], 7);
                node(1.75, [0, 0, 7.0]);
                crate([1.2, 0.7, 2.6], [0, 2.2, -3.0]);
                crate([0.9, 0.6, 1.6], [0, -2.2, -4.4]);
                for (const side of [-1, 1]) {
                    crate([2.4, 0.7, 1.0], [side * 6.4, 2.2, 7.0]);
                    crate([1.4, 0.6, 0.9], [side * 12.4, -1.5, 7.0]);
                    for (const up of [-1, 1]) beam(0.1, 13.5, 'y', [side * 18.7, up * 7.4, 7.0], 5);
                }
                dish(1.1, [1.9, 3.6, 1.0], -0.6);
                arm([0, 2.1, -1.0], [0, 5.4, 2.2], [3.4, 3.0, 5.6]);
                visitor(10.4, -1);
                module(1.55, 5.6, 'z', [0, 0, -10.2]);
                for (const side of [-1, 1]) panel(5.6, 1.4, 'x', 'z', [side * 4.4, 0, -10.6], 4);
                for (const at of [[0, 2.5, 3.0], [-22.7, 0, 7.0], [22.7, 0, 7.0], [0, 6.9, -5.8], [0, 0, -13.3]]) {
                    parts.push([new T.IcosahedronGeometry(0.24 * k, 1).translate(at[0] * k, at[1] * k, at[2] * k), 2]);
                }
            }
            const geometry = fuse(parts);
            stationGeometries.set(spec, geometry);
            return geometry;
        };
        // Gathering points for a built thing are scattered over its own surface.
        const scatterOver = (geometry, count, seedStr) => {
            const rand = seededRandom(seedStr);
            const p = geometry.attributes.position, n = geometry.attributes.normal, part = geometry.attributes.aPart;
            const index = geometry.index.array, faces = index.length / 3;
            const edge = (a, b, axis) => p.array[b * 3 + axis] - p.array[a * 3 + axis];
            const cumulative = new Float32Array(faces);
            let total = 0;
            for (let f = 0; f < faces; f += 1) {
                const a = index[f * 3], b = index[f * 3 + 1], c = index[f * 3 + 2];
                const ux = edge(a, b, 0), uy = edge(a, b, 1), uz = edge(a, b, 2);
                const vx = edge(a, c, 0), vy = edge(a, c, 1), vz = edge(a, c, 2);
                total += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
                cumulative[f] = total;
            }
            const pos = new Float32Array(count * 3), normal = new Float32Array(count * 3), meta = new Float32Array(count * 4);
            for (let i = 0; i < count; i += 1) {
                const f = Math.min(faces - 1, upperBound(cumulative, rand() * total));
                const a = index[f * 3], b = index[f * 3 + 1], c = index[f * 3 + 2];
                let u = rand(), v = rand();
                if (u + v > 1) { u = 1 - u; v = 1 - v; }
                for (let axis = 0; axis < 3; axis += 1) {
                    pos[i * 3 + axis] = p.array[a * 3 + axis] + edge(a, b, axis) * u + edge(a, c, axis) * v;
                    normal[i * 3 + axis] = n.array[a * 3 + axis];
                }
                const code = part.array[a];
                meta.set([rand(), code === 4 ? 2 : code === 2 ? 3 : i % 4 === 0 ? 1 : 0, 1.1 + rand() * 0.8, rand()], i * 4);
            }
            return { pos, normal, meta };
        };
        manifoldTemplates.stationA = scatterOver(stationGeometry(ENTITY_SPECS.stationA), POINTS_PER_ENTITY, 'manifold-station-a');
        manifoldTemplates.stationB = scatterOver(stationGeometry(ENTITY_SPECS.stationB), POINTS_PER_ENTITY, 'manifold-station-b');
        manifoldTemplates.scope = scatterOver(stationGeometry(ENTITY_SPECS.scope), POINTS_PER_ENTITY, 'manifold-telescope');
        manifoldTemplates.shipB = scatterOver(stationGeometry(ENTITY_SPECS.shipB), POINTS_PER_ENTITY, 'manifold-probe');

        const makeEntityMaterial = (typeCode) => new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                uTime: { value: 0 },
                uPixelRatio: { value: 1 },
                uCohesion: { value: 1 },
                uSolid: { value: 0 },
                uPresence: { value: 1 },
                uDissolveDir: { value: 0 }, // -1: 远方星雾孕育, +1: 近处掠过解体
                uScale: { value: 1 },
                uDensity: { value: 1 },
                uAudioPulse: { value: 0 },
                uGlow: { value: 1 },
                uType: { value: typeCode }, // 0=station(knot), 1=planet, 2=rings, 3=ship
                uColorPrimary: { value: new T.Color('#76bfae') },
                uColorAccent: { value: new T.Color('#f2a900') },
                uColorInk: { value: new T.Color('#f2f0e9') },
                uColorEmber: { value: new T.Color('#e06c5f') }
            },
            vertexShader: `
                attribute vec3 aNormal;
                attribute vec4 aMeta; // x: phase, y: shade, z: size, w: seed
                uniform float uTime, uPixelRatio, uCohesion, uSolid, uPresence, uDissolveDir, uScale, uDensity, uAudioPulse, uGlow, uType;
                uniform vec3 uColorPrimary, uColorAccent, uColorInk, uColorEmber;
                varying vec3 vColor;
                varying float vAlpha;
                varying float vLight;

                void main() {
                    if (aMeta.w > clamp(uDensity * 0.82 + 0.18, 0.22, 1.0)) {
                        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                        gl_PointSize = 0.0;
                        return;
                    }

                    float phase = aMeta.x;
                    float shade = aMeta.y;
                    float baseSize = aMeta.z;
                    float seed = aMeta.w;

                    // 按粒子自身 seed 与相位错峰凝聚：低 seed 核心骨架先在远方成形，外围微尘随后柔和汇入
                    float localCohesion = clamp((uCohesion * 1.32) - seed * 0.32, 0.0, 1.0);
                    localCohesion = localCohesion * localCohesion * (3.0 - 2.0 * localCohesion);

                    // 远方入场时从 0.58 倍微缩引力胚胎平滑舒展至完整尺寸，消除硬切膨胀感
                    float birthScale = uDissolveDir < 0.0 ? mix(0.58, 1.0, localCohesion) : 1.0;
                    vec3 localPos = position * (uScale * birthScale);
                    vec3 nrm = normalize(aNormal + vec3(0.0, 0.0001, 0.0));

                    // 1. 结项相位流动与天体内部动力学 (Internal Manifold Dynamics)
                    if (uType < 0.5) {
                        // 轮站：成形前的尘埃随音乐轻微起伏，成形后静止
                        float harmonic = sin(uTime * 1.4 + phase * 18.8495 + seed * 6.28);
                        localPos += nrm * harmonic * (0.45 + uAudioPulse * 0.55) * (1.0 - localCohesion);
                    } else if (uType > 1.5 && uType < 2.5) {
                        // Roche Rings 开普勒差速旋转微扰
                        float kepler = uTime * (0.35 + (1.0 - phase) * 0.45);
                        float cs = cos(kepler * 0.15), sn = sin(kepler * 0.15);
                        localPos.xz = mat2(cs, -sn, sn, cs) * localPos.xz;
                    }

                    // 2. 丝滑星云流线孕育与近场涡流解体 (Streamline Birth & Curl-Swirl Dissolve)
                    float scatter = 1.0 - localCohesion;
                    if (scatter > 0.001) {
                        float swirlAngle = scatter * (2.6 + seed * 3.8) + uTime * (0.28 + seed * 0.18) + phase * 6.28318;
                        if (uDissolveDir < 0.0) {
                            // 远方入场：横向温和收敛为螺旋星云丝缕，纵向沿深空航道拉长，像从星尘流中自然显影
                            float xySpread = scatter * scatter * (10.0 + seed * 22.0);
                            float zStream = -scatter * (32.0 + seed * 85.0);
                            vec3 birthDrift = vec3(
                                cos(swirlAngle) * xySpread,
                                sin(swirlAngle * 0.85) * xySpread * 0.72,
                                zStream
                            );
                            localPos += nrm * (scatter * 3.5) + birthDrift;
                        } else {
                            // 近场擦肩解体：沿切向涡流飘散入镜头后方
                            float radiusSpread = scatter * (26.0 + seed * 58.0);
                            vec3 swirlVec = vec3(
                                cos(swirlAngle) * sin(phase * 9.42 + seed * 6.28),
                                sin(swirlAngle * 0.85) * cos(phase * 6.28 - seed * 3.14),
                                (0.68 + cos(swirlAngle * 0.6) * 0.52)
                            );
                            localPos += (nrm * 0.35 + swirlVec) * radiusSpread;
                        }
                    }

                    // 3. 世界空间与晨昏线边缘散射光照 (Terminator & Rim Scattering)
                    vec4 worldPos = modelMatrix * vec4(localPos, 1.0);
                    vec3 worldNormal = normalize(mat3(modelMatrix) * nrm);
                    vec3 viewDir = normalize(cameraPosition - worldPos.xyz);
                    vec3 lightDir = ${glslVec3(KEY_LIGHT)};

                    float ndotl = dot(worldNormal, lightDir);
                    // 晨昏线柔和过渡 + 背光边缘瑞利辉光 (Rim Halo)
                    float terminator = smoothstep(-0.28, 0.65, ndotl);
                    float rim = pow(1.0 - clamp( abs(dot(worldNormal, viewDir)), 0.0, 1.0 ), 2.2);
                    vLight = clamp(0.22 + terminator * 0.78 + rim * 0.62 + (shade > 1.5 ? 0.35 : 0.0), 0.20, 1.55);

                    // 4. 分级着色
                    if (uType < 0.5) {
                        // Station (Torus Knot)
                        vColor = shade < 0.5 ? uColorInk
                               : shade < 1.5 ? uColorPrimary
                               : shade < 2.5 ? uColorAccent
                               : mix(uColorAccent, uColorInk, 0.45);
                    } else if (uType < 1.5) {
                        // Planet
                        vColor = shade < 0.5 ? uColorPrimary * 0.78
                               : shade < 1.5 ? mix(uColorPrimary, uColorInk, 0.38)
                               : shade < 2.5 ? mix(uColorPrimary, uColorAccent, 0.55) * 1.25
                               : mix(uColorAccent, uColorPrimary, phase);
                    } else if (uType < 2.5) {
                        // Rings
                        vColor = shade < 0.5 ? mix(uColorPrimary, uColorInk, 0.3) * 0.72
                               : shade < 1.5 ? uColorPrimary
                               : uColorAccent * 1.22;
                    } else {
                        // Nomad Ship
                        vColor = shade < 0.5 ? uColorInk
                               : shade < 1.5 ? uColorPrimary * 1.15
                               : shade < 2.5 ? uColorAccent
                               : mix(uColorEmber, uColorAccent, 1.0 - phase);
                    }

                    vec4 mv = viewMatrix * worldPos;
                    gl_Position = projectionMatrix * mv;

                    float depth = max(1.0, -mv.z);
                    float pulseBoost = 1.0 + uAudioPulse * (shade > 1.5 ? 0.32 : 0.14);
                    gl_PointSize = clamp(baseSize * (0.68 + localCohesion * 0.62) * pulseBoost * uPixelRatio * 330.0 / depth, 0.8, 38.0);

                    float nearClip = smoothstep(8.0, 42.0, depth);
                    float farClip = 1.0 - smoothstep(1280.0, 1880.0, depth);
                    // 粒子级错峰渐显：避免整团模型在同一帧突兀亮起
                    float seedFadeIn = smoothstep(seed * 0.42, seed * 0.42 + 0.58, uPresence);
                    float stageAlpha = uDissolveDir < 0.0
                        ? seedFadeIn * (0.18 + 0.82 * localCohesion)
                        : uPresence * (0.28 + 0.72 * localCohesion);
                    vAlpha = nearClip * farClip * stageAlpha * (0.68 + seed * 0.32);

                    // Once the body has formed, the points that sketched its
                    // surface give way to the solid. Planets and rings are left
                    // clean; field lines, jets and wakes stay on the built things.
                    float keep = uType < 0.5 ? (shade > 2.5 ? 0.5 : 0.0)
                        : uType < 2.5 ? 0.0
                        : 0.0;
                    vAlpha *= mix(1.0, keep, smoothstep(0.48, 0.94, uSolid));
                }
            `,
            fragmentShader: `
                uniform float uGlow;
                varying vec3 vColor;
                varying float vAlpha;
                varying float vLight;

                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r2 = dot(p, p);
                    if (r2 > 1.0) discard;
                    float core = exp(-r2 * 7.2);
                    float halo = exp(-r2 * 2.1) * 0.34 * uGlow;
                    float edge = 1.0 - smoothstep(0.65, 1.0, r2);
                    gl_FragColor = vec4(vColor * vLight * (core * 1.65 + halo), (core + halo) * vAlpha * edge);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `
        });

        const buildEntityMesh = (tmpl, typeCode) => {
            const geo = new T.BufferGeometry();
            geo.setAttribute('position', new T.BufferAttribute(tmpl.pos, 3));
            geo.setAttribute('aNormal', new T.BufferAttribute(tmpl.normal, 3));
            geo.setAttribute('aMeta', new T.BufferAttribute(tmpl.meta, 4));
            const mat = makeEntityMaterial(typeCode);
            const points = new T.Points(geo, mat);
            points.frustumCulled = false;
            root.add(points);
            return { geo, mat, points };
        };

        const slotTemplateMap = ['stationA', 'planetA', 'ringsA', 'shipA', 'stationB', 'planetB', 'ringsB', 'shipB', 'scope']
            .map((name, idx) => ({ tmpl: manifoldTemplates[name], spec: ENTITY_SPECS[name], code: idx % 4 }));
        const entityNodes = slotTemplateMap.map((item) => buildEntityMesh(item.tmpl, item.code));

        /* ------------------------------------------------------------------------
         * 层级 4b：天体与巨构的实体 (Solid Bodies)
         * A point cloud alone reads as a sketch of a planet. Each encounter also
         * owns a shaded body: the points show it gathering out of dust far away
         * and tearing apart as the camera sweeps past; in between they give way
         * to the solid, which hides the stars behind it like a real object.
         * ------------------------------------------------------------------------ */
        // Photographed cloud decks and a measured ring profile, kept as
        // luminance only: the palette still decides every colour. Until a map
        // arrives, and wherever it cannot be read, the procedural surface stands in.
        const surfaceMaps = new Map();
        let surfacesReleased = false;
        let sceneDrawn = false;
        const wearSurface = (material, file, slot = 'uSurface', flag = 'uMapped') => {
            if (!file || !T.TextureLoader) return material;
            let entry = surfaceMaps.get(file);
            if (!entry) {
                entry = { texture: null, blend: 0, wearers: [] };
                surfaceMaps.set(file, entry);
                new T.TextureLoader().load(ASSETS + file, (texture) => {
                    if (surfacesReleased) { texture.dispose(); return; }
                    texture.wrapS = T.RepeatWrapping;
                    texture.anisotropy = 4;
                    entry.texture = texture;
                    entry.blend = sceneDrawn ? 0 : 1;
                    entry.wearers.forEach(([wearer, into, mark]) => {
                        wearer.uniforms[into].value = texture;
                        wearer.uniforms[mark].value = entry.blend;
                    });
                }, undefined, () => {});
            }
            entry.wearers.push([material, slot, flag]);
            if (entry.texture) {
                material.uniforms[slot].value = entry.texture;
                material.uniforms[flag].value = smooth(entry.blend);
            }
            return material;
        };
        const advanceSurfaces = (dt) => {
            surfaceMaps.forEach(entry => {
                if (!entry.texture || entry.blend >= 1) return;
                entry.blend = clamp(entry.blend + dt / 0.7);
                const mixAmount = smooth(entry.blend);
                entry.wearers.forEach(([wearer, , flag]) => { wearer.uniforms[flag].value = mixAmount; });
            });
        };
        // Surface kinds: 0 hull, 1 gas planet, 2 ring disc, 3 sail membrane, 4 air above the clouds.
        const AIR_REACH = 1.045;
        const makeBodyMaterial = (kind, seed, surface) => wearSurface(new T.ShaderMaterial({
            defines: { BODY_KIND: kind },
            transparent: kind >= 2,
            depthWrite: kind < 2,
            side: kind === 2 || kind === 3 ? T.DoubleSide : T.FrontSide,
            uniforms: {
                uTime: { value: 0 }, uKind: { value: kind }, uSeed: { value: seed },
                uSurface: { value: null }, uMapped: { value: 0 },
                uRingMap: { value: null }, uRingMapped: { value: 0 }, uRinged: { value: 0 }, uDetail: { value: 1 },
                uWorld: { value: 0 }, uThin: { value: 0 },
                uBounceDir: { value: new T.Vector3(0, 1, 0) }, uBounce: { value: 0 },
                uCohesion: { value: 1 }, uPresence: { value: 1 }, uGlow: { value: 1 },
                uAudioPulse: { value: 0 }, uBodyRadius: { value: 0 },
                uRing: { value: new T.Vector2(1, 2) },
                uLight: { value: new T.Vector3(...KEY_LIGHT) },
                uLightLocal: { value: new T.Vector3(0, 1, 0) },
                uViewport: { value: new T.Vector2(1280, 720) },
                uColorPrimary: { value: new T.Color('#76bfae') },
                uColorAccent: { value: new T.Color('#f2a900') },
                uColorInk: { value: new T.Color('#f2f0e9') },
                uColorEmber: { value: new T.Color('#e06c5f') },
                uFloor: { value: new T.Color('#000000') },
                uPage: { value: new T.Color('#000000') }, uPaper: { value: 0 }
            },
            vertexShader: `
                attribute float aPart;
                uniform float uWorld, uSeed, uKind;
                varying vec3 vLocal, vWorld, vNormal;
                varying vec2 vUv;
                varying float vPart, vDepth, vRise;
                float vhash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
                float vnoise(vec3 p) {
                    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
                    return mix(mix(mix(vhash(i), vhash(i + vec3(1, 0, 0)), f.x),
                        mix(vhash(i + vec3(0, 1, 0)), vhash(i + vec3(1, 1, 0)), f.x), f.y),
                        mix(mix(vhash(i + vec3(0, 0, 1)), vhash(i + vec3(1, 0, 1)), f.x),
                        mix(vhash(i + vec3(0, 1, 1)), vhash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
                }
                void main() {
                    vec3 at = position;
                    #if BODY_KIND == 1
                    if (uWorld > 6.5 && aPart < 0.5) {
                        // A small body is not round: a lumpy, elongated rubble pile
                        // with a waist, like the asteroids probes have visited.
                        vec3 d = normalize(position);
                        float lump = 1.0 + (vnoise(d * 1.4 + uSeed * 7.0) - 0.5) * 0.7
                            + (vnoise(d * 3.3 + uSeed * 3.0) - 0.5) * 0.24 + (vnoise(d * 8.0) - 0.5) * 0.06;
                        float waist = 1.0 - 0.18 * exp(-d.x * d.x * 9.0);
                        at = position * vec3(1.55, 0.8 * waist, 0.85 * waist) * lump;
                    }
                    #endif
                    vRise = 0.0;
                    #if BODY_KIND == 4
                    if (abs(uWorld - 2.0) < 0.5 || abs(uWorld - 3.0) < 0.5) {
                        // The shell of air becomes plumes: on an ice moon, curtains of
                        // vapour over the cracks at the south pole; on a volcanic
                        // moon, the umbrella of one great eruption.
                        vec3 d = normalize(position);
                        vec3 vent = uWorld < 2.5 ? vec3(0.0, -1.0, 0.0) : normalize(vec3(0.62, 0.55, 0.56));
                        float off = acos(clamp(dot(d, vent), -1.0, 1.0));
                        float tall = uWorld < 2.5 ? 0.5 : 0.28;
                        float wide = uWorld < 2.5 ? 0.42 : 0.3;
                        vRise = tall * exp(-off * off / (wide * wide));
                        at = position * (1.0 + vRise);
                    }
                    #endif
                    vLocal = at; vUv = uv; vPart = aPart;
                    vec4 world = modelMatrix * vec4(at, 1.0);
                    vWorld = world.xyz;
                    vNormal = normalize(mat3(modelMatrix) * normal);
                    vec4 mv = viewMatrix * world;
                    vDepth = -mv.z;
                    gl_Position = projectionMatrix * mv;
                }
            `,
            fragmentShader: `
                uniform float uTime, uKind, uSeed, uCohesion, uPresence, uGlow, uAudioPulse, uBodyRadius, uMapped, uRingMapped, uRinged, uDetail, uBounce;
                uniform float uWorld, uThin;
                uniform vec3 uBounceDir;
                uniform sampler2D uSurface, uRingMap;
                uniform vec2 uRing, uViewport;
                uniform vec3 uLight, uLightLocal, uColorPrimary, uColorAccent, uColorInk, uColorEmber, uFloor, uPage;
                uniform float uPaper;
                varying vec3 vLocal, vWorld, vNormal;
                varying vec2 vUv;
                varying float vPart, vDepth, vRise;

                float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
                float noise(vec3 p) {
                    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
                    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                        mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                        mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                        mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
                }
                float fbm(vec3 p) { return noise(p) * 0.55 + noise(p * 2.1) * 0.28 + noise(p * 4.3) * 0.17; }
                // Impact craters on a unit sphere scaled by f: a bowl, a raised
                // rim and a bright apron of ejecta round the fresher ones.
                // x: height, y: ejecta brightness.
                vec2 craters(vec3 p, float keep, float salt) {
                    vec3 base = floor(p - 0.5);
                    vec2 sum = vec2(0.0);
                    for (int i = 0; i < 8; i++) {
                        vec3 cell = base + vec3(mod(float(i), 2.0), mod(floor(float(i) * 0.5), 2.0), floor(float(i) * 0.25));
                        if (hash(cell + salt) > keep) continue;
                        vec3 at = cell + 0.5 + (vec3(hash(cell + 1.3 + salt), hash(cell + 2.7), hash(cell + 5.1)) - 0.5) * 0.5;
                        float size = 0.07 + 0.18 * hash(cell + 8.9);
                        float d = length(p - at) / size;
                        float fresh = step(0.72, hash(cell + 3.3));
                        sum.x += (d < 1.0 ? (d * d - 1.0) * 0.55 : 0.0) + exp(-(d - 1.0) * (d - 1.0) * 30.0) * 0.3;
                        sum.y += fresh * exp(-max(d - 1.0, 0.0) * 2.2) * step(0.8, d) * 0.6;
                    }
                    return sum;
                }
                // Lines that wind across a surface: where a noise field crosses one level.
                float lineae(vec3 p, float width) {
                    float f = fbm(p);
                    return 1.0 - smoothstep(0.0, width, abs(f - 0.5));
                }
                const vec3 SUN = ${glslVec3(SUN_AT)};
                // Where the cloud tops' silhouette falls on the shell of air around them.
                const float LIMB = ${Math.sqrt(1 - 1 / (AIR_REACH * AIR_REACH)).toFixed(4)};

                void main() {
                    // Gathering and tearing apart: a noise front eats the surface.
                    float solid = smoothstep(0.42, 0.97, uCohesion) * 1.1;
                    float grain = noise(vLocal * 0.31 + uSeed * 17.0);
                    if (grain > solid) discard;
                    float front = smoothstep(solid - 0.1, solid, grain) * step(solid, 1.0);
                    float fade = uPresence * smoothstep(5.0, 30.0, vDepth);
                    // Opaque bodies fade by an interleaved-gradient dither, not by blending.
                    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
                    if (uKind < 1.5 && dither > fade) discard;

                    vec3 n = normalize(vNormal);
                    if ((uKind > 2.5 && uKind < 3.5) || (uKind < 1.5 && uWorld > 6.5)) { vec3 fn = cross(dFdx(vWorld), dFdy(vWorld)); if (dot(fn, fn) > 1e-12) n = normalize(fn); }
                    vec3 v = normalize(cameraPosition - vWorld);
                    if (dot(n, v) < 0.0) n = -n;
                    float ndl = dot(n, uLight);
                    float day = smoothstep(-0.18, 0.62, ndl);
                    float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
                    vec3 col = vec3(0.0);
                    float alpha = 1.0;

                    // Each kind of surface compiles only its own code.
                    #if BODY_KIND == 0
                    {
                        // Hull, as spacecraft are finished: white thermal panels,
                        // gold foil blankets, bare truss metal, glass ports in rows.
                        // Sunlight is hard in vacuum; the sky fills the shade a little
                        // and shows in whatever is polished.
                        bool tube = vPart < 2.5;
                        bool lattice = vPart > 4.5 && vPart < 5.5;
                        bool plain = vPart > 7.5;
                        bool truss = lattice || (vPart > 6.5 && !plain);
                        vec2 cells = vUv * (tube ? vec2(96.0, 12.0) : truss ? vec2(8.0, 14.0) : vec2(16.0, 16.0));
                        vec2 cell = floor(cells), inside = fract(cells);
                        float seam = smoothstep(0.0, 0.05, inside.x) * smoothstep(0.0, 0.07, inside.y)
                            * smoothstep(0.0, 0.05, 1.0 - inside.x) * smoothstep(0.0, 0.07, 1.0 - inside.y);
                        // An open truss: longerons along the edges, a batten and a
                        // diagonal in every bay, and nothing between them.
                        if (lattice && uDetail > 0.5) {
                            float member = max(max(step(0.4, abs(inside.x - 0.5)), step(0.42, abs(inside.y - 0.5))),
                                1.0 - smoothstep(0.06, 0.09, abs(inside.x - inside.y)));
                            if (member < 0.5) discard;
                        }
                        float tone = hash(vec3(cell, uSeed + 3.0));
                        // Blankets wrap whole sections; a painted band runs round the rim.
                        float section = tube ? hash(vec3(floor(vUv.x * 16.0), floor(vUv.y * 2.0), uSeed))
                            : hash(vec3(floor(vUv.y * 0.5), 7.0, uSeed));
                        float foil = truss ? 0.0 : plain ? step(8.5, vPart) : step(tube ? 0.86 : 0.66, section);
                        float band = tube ? step(5.5, cell.y) * step(cell.y, 6.5) : 0.0;
                        float portRow = tube ? step(1.5, mod(cell.y, 6.0)) * step(mod(cell.y, 6.0), 2.5) : step(0.5, mod(cell.y, 4.0)) * step(mod(cell.y, 4.0), 1.5);
                        float port = truss || plain ? 0.0 : portRow * (1.0 - foil)
                            * step(0.22, inside.x) * step(inside.x, 0.78) * step(0.28, inside.y) * step(inside.y, 0.72);
                        float lit = port * step(tube ? 0.3 : 0.7, hash(vec3(cell, uSeed)));

                        // Foil is crinkled: its mirror wanders.
                        vec3 crease = vec3(noise(vLocal * 7.0 + 11.0), noise(vLocal * 7.0 + 37.0), noise(vLocal * 7.0 + 71.0)) - 0.5;
                        vec3 nn = normalize(n + crease * 0.4 * foil);
                        float lam = clamp(dot(nn, uLight) * 1.15 + 0.04, 0.0, 1.0);
                        float facing = clamp(dot(nn, v), 0.0, 1.0);
                        vec3 bounce = reflect(-v, nn);
                        // What a polished surface sees: the warm side of the sky
                        // towards the sun, the cool nebula away from it, and the sun.
                        vec3 sky = mix(uColorPrimary * 0.16, mix(uColorEmber, uColorAccent, 0.4) * 0.3,
                            smoothstep(-0.6, 0.7, dot(bounce, SUN)));
                        float sun = max(dot(normalize(uLight + v), nn), 0.0);
                        float fresnel = 0.04 + 0.96 * pow(1.0 - facing, 5.0);

                        // The finishes differ in value and gloss, hardly in hue:
                        // the colour on them is the scene's own, warm from the
                        // sun on one side and the nebula's on the other.
                        vec3 key = mix(uColorInk, uColorAccent, 0.2) * lam;
                        vec3 fill = uColorPrimary * (0.035 + 0.06 * clamp(0.5 - 0.5 * dot(nn, uLight), 0.0, 1.0));
                        // A planet close by throws its own pale light back.
                        vec3 shine = mix(uColorPrimary, uColorInk, 0.45) * uBounce * 0.42
                            * pow(clamp(dot(nn, uBounceDir) * 0.5 + 0.5, 0.0, 1.0), 2.0);
                        vec3 light = key + fill + shine;
                        vec3 shell = mix(uColorPrimary, uColorInk, 0.72);
                        float pale = (0.5 + 0.12 * tone) * mix(1.0, 0.7, step(0.93, tone)) * mix(1.0, 0.55, band);
                        vec3 painted = shell * pale * mix(0.66, 1.0, seam) * light + uColorInk * pow(sun, 48.0) * lam * 0.22
                            + sky * fresnel * 1.3;
                        // Blankets are a darker, glossier wrap; only their highlights run warm.
                        vec3 wrap = mix(shell, uColorAccent, 0.22) * 0.24;
                        vec3 foiled = wrap * mix(0.8, 1.0, seam) * light + sky * (0.5 + 1.2 * fresnel)
                            + mix(uColorInk, uColorAccent, 0.4) * pow(sun, 26.0) * lam * 0.75;
                        vec3 metal = shell * 0.26 * light * (0.55 + 0.45 * step(0.5, abs(fract(cells.y + cells.x) - 0.5) * 2.0))
                            + uColorInk * pow(sun, 30.0) * lam * 0.45 + sky * 0.5;
                        col = truss ? metal : mix(painted, foiled, foil);
                        // Glass: dark, with the sky in it, unless someone is home.
                        col = mix(col, sky * (0.4 + 3.0 * fresnel) + uColorInk * pow(sun, 90.0) * lam, port);
                        col += mix(uColorAccent, uColorInk, 0.45) * lit * 0.8
                            * (0.85 + 0.15 * sin(uTime * 0.9 + hash(vec3(cell, 9.0)) * 6.28)) * uGlow;
                        if (vPart > 10.5) {
                            // Sunshield film: aluminised, slack between its
                            // spreader bars, creased where it was folded.
                            float crease = max(1.0 - smoothstep(0.0, 0.04, abs(fract(vUv.x * 6.0) - 0.5) * 2.0),
                                1.0 - smoothstep(0.0, 0.04, abs(fract(vUv.y * 6.0) - 0.5) * 2.0));
                            vec3 slackN = normalize(n + (vec3(noise(vLocal * 0.9 + 3.0), 0.0, noise(vLocal * 0.9 + 17.0)) - 0.5) * 0.3);
                            float filmLit = clamp(abs(dot(slackN, uLight)), 0.0, 1.0);
                            vec3 filmSky = mix(mix(uColorPrimary, uColorInk, 0.4) * 0.12, mix(uColorEmber, uColorAccent, 0.4) * 0.3,
                                smoothstep(-0.6, 0.7, dot(reflect(-v, slackN), SUN)));
                            col = (shell * (0.1 + 0.34 * filmLit) * mix(uColorInk, uColorAccent, 0.2) + filmSky * 1.3
                                + uColorInk * pow(max(dot(normalize(uLight + v), slackN), 0.0), 14.0) * 0.5 * filmLit)
                                * (1.0 - 0.3 * crease);
                        } else if (vPart > 9.5) {
                            // Telescope mirror: nearly all reflection, faintly warm.
                            vec3 flatN = normalize(n);
                            vec3 seen = reflect(-v, flatN);
                            vec3 mirrored = mix(mix(uColorPrimary, uColorInk, 0.55) * 0.1, mix(uColorEmber, uColorAccent, 0.5) * 0.42,
                                smoothstep(-0.6, 0.7, dot(seen, SUN)));
                            col = mix(mirrored, mirrored * mix(uColorInk, uColorAccent, 0.45) * 2.2, 0.7)
                                + mix(uColorInk, uColorAccent, 0.35) * pow(max(dot(normalize(uLight + v), flatN), 0.0), 200.0) * 2.0
                                + shell * 0.05 * light;
                        } else if (vPart > 5.5 && vPart < 6.5) {
                            // Radiator: white ribbed panels that shed heat edge-on to the sun.
                            float rib = smoothstep(0.0, 0.12, abs(fract(vUv.x * 9.0) - 0.5));
                            float flatLit = clamp(abs(dot(n, uLight)), 0.0, 1.0);
                            col = shell * 0.62 * (uColorPrimary * 0.05 + mix(uColorInk, uColorAccent, 0.2) * flatLit) * mix(0.6, 1.0, rib)
                                + sky * (0.5 + 2.0 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 4.0));
                        } else if (vPart > 3.5 && vPart < 4.5) {
                            // Solar wing: deep blue cells under glass, silver busbars, a hard glint.
                            vec2 at = vUv * vec2(16.0, 6.0);
                            vec2 grid = fract(at);
                            float frame = 1.0 - smoothstep(0.0, 0.06, min(min(grid.x, 1.0 - grid.x), min(grid.y, 1.0 - grid.y)));
                            float bus = 1.0 - smoothstep(0.0, 0.05, abs(fract(at.x * 3.0) - 0.5));
                            float flat_ = clamp(dot(n, uLight), 0.0, 1.0);
                            float face = clamp(dot(n, v), 0.0, 1.0);
                            // Cells are near black with the nebula's tint; what shows
                            // is the grid, the sky in the glass and a glint.
                            vec3 silicon = mix(vec3(0.015, 0.03, 0.07), uColorPrimary * 0.1, 0.6)
                                * (0.85 + 0.3 * hash(vec3(floor(at), uSeed)));
                            vec3 wing = silicon * (0.35 + flat_ * 1.6) + sky * (0.05 + 0.9 * pow(1.0 - face, 3.0));
                            wing = mix(wing, shell * (0.04 + 0.3 * flat_), max(frame, bus * 0.3));
                            col = wing + mix(uColorInk, uColorAccent, 0.25)
                                * pow(max(dot(normalize(uLight + v), n), 0.0), 120.0) * 1.6 * flat_;
                        } else if (vPart > 1.5 && vPart < 2.5) {
                            // Navigation strobes: dim, then a short flash, each on its own beat.
                            float beat = fract(uTime * 0.7 + hash(floor(vLocal * 0.35) + uSeed));
                            float flash = smoothstep(0.88, 0.9, beat) * (1.0 - smoothstep(0.95, 1.0, beat));
                            col = mix(uColorAccent, uColorInk, 0.45) * (0.22 + 2.4 * flash) * uGlow;
                        }
                    }
                    #elif BODY_KIND == 1
                    {
                        if (vPart > 0.5) {
                            // Only the giants keep moons in attendance.
                            if (uWorld > 0.5 && (uWorld < 5.5 || uWorld > 6.5)) discard;
                            // A moon in attendance: airless rock, dark plains,
                            // craters with bright rims, lit hard from one side
                            // and faintly by the planet it circles.
                            float plains = smoothstep(0.42, 0.62, fbm(vLocal * 0.8 + uSeed * 9.0));
                            float pit = noise(vLocal * 2.9 + 4.0 + uSeed * 3.0);
                            float small = noise(vLocal * 7.5 + 9.0);
                            float bowl = smoothstep(0.66, 0.72, pit) - smoothstep(0.72, 0.8, pit) * 1.7
                                + (smoothstep(0.7, 0.75, small) - smoothstep(0.75, 0.82, small) * 1.6) * 0.5;
                            float rock = mix(0.46, 0.2, plains) * (0.85 + 0.3 * noise(vLocal * 15.0)) + bowl * 0.14;
                            float sunlit = clamp(ndl * 1.2 + 0.02, 0.0, 1.0);
                            col = mix(uColorInk, uColorPrimary, 0.12) * max(rock, 0.03) * sunlit * 1.25
                                + uColorPrimary * 0.012;
                        } else if (uWorld > 0.5) {
                        // Worlds other than gas giants, each after a real kind of
                        // body: a grey cratered moon, an ice moon, a volcanic moon,
                        // home, a cold desert world, an ice giant. Shade and relief
                        // are their own; colour still comes from the palette.
                        vec3 p = normalize(vLocal);
                        float R = length(vLocal);
                        float s = uSeed * 13.0;
                        float h = 0.0;
                        vec3 ground = vec3(0.5);
                        vec3 glow = vec3(0.0);
                        float gloss = 0.0, cover = 0.0, airy = 0.0, hard = 1.0;
                        // Craters at up to three sizes, sized for whichever world
                        // this is, so the shader holds one copy of the search.
                        bool moon = uWorld < 1.5, volcanic = abs(uWorld - 3.0) < 0.5;
                        bool desert = abs(uWorld - 5.0) < 0.5, rubble = uWorld > 6.5;
                        vec2 c1 = vec2(0.0), c2 = vec2(0.0), c3 = vec2(0.0);
                        if (moon || volcanic || desert || rubble) {
                            float f1 = moon ? 5.0 : volcanic ? 6.0 : desert ? 7.0 : 4.0;
                            float k1 = moon ? 0.55 : volcanic ? 0.6 : desert ? 0.5 : 0.6;
                            c1 = craters(p * f1, k1, s);
                            if (!volcanic) c2 = craters(p * (moon ? 13.0 : desert ? 20.0 : 11.0), desert ? 0.65 : 0.7, s + 3.0);
                            if (moon && uDetail > 0.5) c3 = craters(p * 34.0, 0.8, s + 7.0);
                        }
                        if (uWorld < 1.5) {
                            // Dark lava seas over bright highlands, craters within
                            // craters, and young ones with bright aprons.
                            float seas = smoothstep(0.5, 0.6, fbm(p * 1.7 + s));
                            h = c1.x * 0.05 + c2.x * 0.018 * (1.0 - seas * 0.6) + c3.x * 0.007 * (1.0 - seas * 0.5);
                            float albedo = mix(0.6, 0.22, seas) * (0.86 + 0.28 * noise(p * 24.0 + s))
                                + (c1.y + c2.y + c3.y * 0.5) * 0.2;
                            ground = mix(uColorInk, uColorPrimary, 0.08) * albedo;
                        } else if (uWorld < 2.5) {
                            // Young bright ice scored by long ruddy cracks, with
                            // patches where the crust has broken up and refrozen.
                            float cracks = clamp(lineae(p * 2.2 + s, 0.02) + lineae(p * 3.7 + s + 4.0, 0.014) * 0.8
                                + lineae(p * 6.3 + s + 9.0, 0.01) * 0.55 * uDetail, 0.0, 1.0);
                            float chaos = smoothstep(0.6, 0.72, fbm(p * 3.0 + s + 20.0));
                            h = -cracks * 0.004 + chaos * (noise(p * 40.0 + s) - 0.5) * 0.012;
                            float albedo = 0.86 - cracks * 0.3 - chaos * 0.22 + (noise(p * 30.0 + s) - 0.5) * 0.06;
                            vec3 ice = mix(uColorInk, uColorPrimary, 0.12);
                            ground = mix(ice, mix(uColorEmber, uColorInk, 0.45), clamp(cracks * 0.7 + chaos * 0.45, 0.0, 1.0)) * albedo;
                        } else if (uWorld < 3.5) {
                            // Sulphur plains mottled light and dark, calderas with
                            // dark floors and rings of fallout; lava glows at night.
                            vec2 cal = c1;
                            float mottle = fbm(p * 4.0 + s) + (noise(p * 18.0 + s) - 0.5) * 0.15;
                            float pit = smoothstep(-0.2, -0.45, cal.x);
                            h = cal.x * 0.008;
                            float albedo = mix(0.5, 0.9, smoothstep(0.3, 0.75, mottle));
                            albedo = mix(albedo, 0.08, pit) + cal.y * 0.35;
                            vec3 sulphur = mix(uColorInk, uColorAccent, 0.42);
                            sulphur = mix(sulphur, mix(uColorEmber, uColorInk, 0.4), (1.0 - smoothstep(0.3, 0.6, mottle)) * 0.4);
                            ground = sulphur * albedo;
                            glow = mix(uColorAccent, uColorEmber, 0.5) * pit * (0.4 + 1.2 * smoothstep(0.5, 0.8, noise(p * 40.0 + s)));
                        } else if (uWorld < 4.5) {
                            // Home: dark sea and continents, ice at the poles,
                            // weather over everything, and cities lit at night.
                            vec3 q = p * 1.6 + s + (vec3(fbm(p * 3.0 + s), fbm(p * 3.0 + s + 5.0), fbm(p * 3.0 + s + 9.0)) - 0.5) * 0.9;
                            // Seen from low orbit, so the coast and the weather carry fine detail.
                            float shape = fbm(q) + (noise(q * 7.0) - 0.5) * 0.1
                                + (uDetail > 0.5 ? (noise(q * 31.0) - 0.5) * 0.04 + (noise(q * 90.0) - 0.5) * 0.015 : 0.0);
                            float land = smoothstep(0.5, 0.512, shape);
                            float coast = 1.0 - smoothstep(0.0, 0.03, abs(shape - 0.506));
                            float cap = smoothstep(0.78, 0.83, abs(p.y) + (noise(p * 9.0 + s) - 0.5) * 0.08);
                            float relief = fbm(q * 5.0 + 3.0) * 0.7 + fbm(q * 40.0) * 0.3;
                            vec3 sea = mix(uColorPrimary, uColorInk, 0.1) * (0.05 + coast * 0.05);
                            vec3 plains = mix(mix(uColorPrimary, uColorInk, 0.6) * 0.13, mix(uColorInk, uColorEmber, 0.18) * 0.26,
                                smoothstep(0.35, 0.7, relief));
                            ground = mix(sea, plains, land);
                            ground = mix(ground, uColorInk * 0.92, cap);
                            vec3 w = vec3(p.x * 9.0, p.y * 16.0, p.z * 9.0) + vec3(uTime * 0.01, 0.0, 0.0) + s + 40.0;
                            float swirl = fbm(w + vec3(fbm(w * 1.7), 0.0, fbm(w * 1.7 + 6.0)) * 1.2);
                            // Big systems of cloud, broken into cells and streets close to.
                            float cells = uDetail > 0.5 ? noise(p * 70.0 + s) * 0.6 + noise(p * 170.0 + s) * 0.4 : 0.5;
                            cover = smoothstep(0.52, 0.66, swirl + (cells - 0.5) * 0.16) * (0.7 + 0.3 * cells);
                            // Towns are points of light, gathered where the land is settled.
                            vec3 g = p * 420.0, cell = floor(g);
                            vec3 spot = cell + 0.5 + (vec3(hash(cell + 1.7), hash(cell + 4.1), hash(cell + 8.3)) - 0.5) * 0.6;
                            float dot_ = length(g - spot), px = max(fwidth(g.x) + fwidth(g.y), 0.05);
                            float settled = land * (1.0 - cap) * smoothstep(0.55, 0.75, fbm(p * 7.0 + s + 30.0));
                            float town = settled * step(0.6, hash(cell)) * (1.0 - smoothstep(0.06, 0.06 + px, dot_))
                                * (1.0 - smoothstep(0.3, 1.0, px)) + settled * 0.3;
                            glow = mix(uColorAccent, uColorInk, 0.45) * town * 0.9 * (1.0 - cover * 0.8);
                            gloss = (1.0 - land) * (1.0 - cap);
                            airy = 1.0; hard = 0.3;
                        } else if (uWorld < 5.5) {
                            // A cold desert: rust dust, dark basalt, frost at one
                            // pole, and a canyon system along the equator.
                            float dark = smoothstep(0.5, 0.66, fbm(p * 2.4 + s + 11.0));
                            float lon = atan(p.z, p.x + 1e-5);
                            float trench = (1.0 - smoothstep(0.0, 0.025 + 0.02 * noise(p * 12.0), abs(p.y + 0.08 + 0.05 * sin(lon * 3.0 + s))))
                                * smoothstep(-0.6, -0.2, sin(lon + s)) ;
                            float cap = smoothstep(0.84, 0.88, p.y + (noise(p * 10.0 + s) - 0.5) * 0.06);
                            h = c1.x * 0.03 + c2.x * 0.01 - trench * 0.02;
                            vec3 dust = mix(uColorEmber, uColorInk, 0.62) * mix(0.55, 0.26, dark) * (0.88 + 0.24 * noise(p * 22.0 + s));
                            ground = mix(dust, uColorInk * 0.9, cap) * (1.0 - trench * 0.35);
                            airy = 0.3; hard = 0.75;
                        } else if (uWorld > 6.5) {
                            // An asteroid: dark carbon-rich rubble, boulders, craters
                            // softened by regolith, brighter where fresh rock shows.
                            float boulders = smoothstep(0.72, 0.8, noise(p * 60.0 + s)) * uDetail;
                            h = c1.x * 0.04 + c2.x * 0.015 + boulders * 0.006 + (noise(p * 25.0 + s) - 0.5) * 0.01;
                            float albedo = 0.2 * (0.8 + 0.4 * noise(p * 14.0 + s)) + (c1.y + c2.y) * 0.12 + boulders * 0.08;
                            ground = mix(uColorInk, uColorPrimary, 0.06) * albedo;
                        } else {
                            // An ice giant: deep haze, faint bands, one dark storm
                            // with a bright cloud riding beside it.
                            float lat = p.y + (fbm(p * 3.0 + s) - 0.5) * 0.05;
                            float bands = 0.5 + 0.5 * sin(lat * 11.0 + s);
                            vec3 at = p - normalize(vec3(0.6, -0.35, 0.72));
                            float spot = exp(-dot(at * vec3(1.0, 2.4, 1.0), at * vec3(1.0, 2.4, 1.0)) * 70.0);
                            float puff = exp(-length(at - vec3(0.0, -0.09, 0.0)) * 30.0);
                            ground = mix(uColorPrimary, uColorInk, 0.62) * (0.66 + 0.06 * bands - spot * 0.3 + puff * 0.35);
                            airy = 1.0; hard = 0.2;
                        }
                        // Relief: the height field tilts the normal, so craters and
                        // canyons fill with shadow near the terminator.
                        vec3 nl = p;
                        if (uWorld > 6.5) {
                            vec3 facet = cross(dFdx(vLocal), dFdy(vLocal));
                            if (dot(facet, facet) > 1e-12) nl = normalize(facet);
                            if (dot(nl, vLocal) < 0.0) nl = -nl;
                        }
                        // Derivatives are taken outside any branch that varies across pixels.
                        {
                            vec3 dpx = dFdx(vLocal), dpy = dFdy(vLocal);
                            float hx = dFdx(h * R), hy = dFdy(h * R);
                            vec3 r1 = cross(dpy, nl), r2 = cross(nl, dpx);
                            float det = dot(dpx, r1);
                            vec3 bumped = abs(det) * nl - sign(det) * (hx * r1 + hy * r2);
                            if (dot(bumped, bumped) > 1e-12) nl = normalize(bumped);
                        }
                        float lam = dot(nl, normalize(uLightLocal));
                        float sunlit = mix(clamp(lam, 0.0, 1.0), smoothstep(-0.12, 0.65, lam), 1.0 - hard);
                        // Relief cannot lift the night side into the light.
                        sunlit *= smoothstep(-0.08, 0.06, dot(p, normalize(uLightLocal)));
                        float facing = clamp(dot(n, v), 0.0, 1.0);
                        // From low over home only the horizon wears the air.
                        float lowOrbit = step(3.5, uWorld) * step(uWorld, 4.5);
                        float haze = mix(rim, pow(1.0 - facing, 14.0), lowOrbit);
                        if (airy > 0.5) ground *= mix(mix(0.55, 0.85, lowOrbit), 1.0, pow(facing, 0.5));
                        ground = mix(ground, uColorInk * 0.95, cover);
                        ground = mix(ground, ground * mix(vec3(1.0), uColorEmber * 1.6, 0.5),
                            (1.0 - smoothstep(0.0, mix(0.45, 0.14, lowOrbit), lam)) * smoothstep(-0.2, 0.1, lam) * airy);
                        col = ground * (0.008 + sunlit * 1.1);
                        float glint = pow(max(dot(reflect(-v, n), uLight), 0.0), 70.0) * gloss * (1.0 - cover);
                        col += mix(uColorAccent, uColorInk, 0.6) * glint * 1.4 * day;
                        col += glow * (1.0 - smoothstep(-0.12, 0.08, ndl)) * uGlow;
                        vec3 air = mix(uColorPrimary, uColorInk, 0.3);
                        col += air * haze * (0.012 + day * 0.8) * airy;
                        float against = pow(max(dot(-v, SUN), 0.0), 4.0);
                        col += air * haze * against * smoothstep(-0.1, 0.7, dot(n, SUN)) * 2.2 * airy;
                        if (uWorld > 3.5 && uWorld < 4.5) {
                            float polarLight = smoothstep(0.8, 0.93, abs(p.y));
                            float curtain = mix(0.4, 1.0, noise(vec3(p.xz * 9.0, uTime * 0.2 + uSeed)));
                            col += mix(uColorPrimary, uColorAccent, 0.25) * polarLight * curtain * (1.0 - day) * 0.3 * uGlow;
                        }
                        } else {
                        // Gas giant: turbulent latitude bands, storms, a soft
                        // terminator, a limb of atmosphere, aurora on the night pole.
                        vec3 p = normalize(vLocal);
                        float warp = uDetail > 0.5 ? fbm(p * 3.1 + uSeed * 5.0 + vec3(uTime * 0.012, 0.0, 0.0)) : 0.5;
                        float lat = p.y + (warp - 0.5) * 0.16;
                        float bands = 0.5 + 0.5 * sin(lat * (15.0 + uSeed * 9.0) + sin(lat * 41.0) * 0.6);
                        float fine = noise(vec3(p.x * 5.0, lat * 46.0, p.z * 5.0) + uSeed * 3.0);
                        float storm = smoothstep(0.62, 0.86, fbm(vec3(p.x * 4.0, lat * 13.0, p.z * 4.0) + uSeed * 11.0));
                        vec3 dark = mix(uColorPrimary, uColorInk, 0.38) * 0.26;
                        vec3 pale = mix(uColorPrimary, uColorInk, 0.8) * 0.74;
                        float deck = bands * (0.72 + fine * 0.28);
                        if (uMapped > 0.0) {
                            // A real cloud deck turns slowly under the same light;
                            // only its light and dark are kept.
                            float polar = smoothstep(0.83, 0.985, abs(p.y));
                            float latitude = clamp(vUv.y + (warp - 0.5) * 0.004 * (1.0 - polar), 0.0, 1.0);
                            vec2 at = vec2(vUv.x + uTime * 0.0014 + uSeed, latitude);
                            float shade = texture2D(uSurface, at).r;
                            if (uDetail > 0.5) {
                                // Belts and zones run at different speeds. The map is
                                // carried along each jet in two overlapping passes, so
                                // the shear never winds it up.
                                float jet = sin(vUv.y * 31.0 + uSeed * 6.0) * 0.016 * (1.0 - polar);
                                float pass = fract(uTime * 0.02);
                                float a = texture2D(uSurface, at + vec2(jet * (pass - 0.5), 0.0)).r;
                                float b = texture2D(uSurface, at + vec2(jet * (fract(pass + 0.5) - 0.5), 0.0)).r;
                                shade = mix(a, b, abs(1.0 - 2.0 * pass));
                                // Close up, the cloud tops break into finer eddies.
                                shade += (noise(p * vec3(34.0, 90.0, 34.0) + warp * 6.0) - 0.5) * 0.07
                                    * (1.0 - smoothstep(0.0005, 0.004, fwidth(vUv.y)));
                            }
                            // Longitude collapses at the poles. Average across it to keep the cloud cap from pinching.
                            if (polar > 0.0) {
                                float cap = (texture2D(uSurface, vec2(0.125, latitude)).r
                                    + texture2D(uSurface, vec2(0.375, latitude)).r
                                    + texture2D(uSurface, vec2(0.625, latitude)).r
                                    + texture2D(uSurface, vec2(0.875, latitude)).r) * 0.25;
                                shade = mix(shade, cap, polar);
                            }
                            float mappedDeck = smoothstep(0.04, 0.96, shade);
                            deck = mix(deck, mappedDeck, uMapped);
                            bands = mix(bands, mappedDeck, uMapped);
                            storm *= 1.0 - uMapped;
                        }
                        vec3 surface = mix(dark, pale, deck);
                        surface = mix(surface, mix(uColorAccent, uColorInk, 0.25) * 0.8, storm * 0.5);
                        surface = mix(surface, mix(uColorEmber, uColorInk, 0.5) * 0.55, smoothstep(0.8, 0.98, bands) * (1.0 - storm) * 0.18);
                        // Belts lean warm and the brightest zones catch the accent.
                        surface = mix(surface, mix(uColorEmber, uColorInk, 0.45) * 0.36, (1.0 - smoothstep(0.12, 0.5, deck)) * 0.28 * uMapped);
                        surface = mix(surface, mix(uColorAccent, uColorInk, 0.55) * 0.8, smoothstep(0.7, 1.0, deck) * 0.22 * uMapped);
                        vec3 air = mix(uColorPrimary, uColorInk, 0.3);
                        // The disc dims towards its edge, where the light has
                        // more air to cross, and the terminator runs warm.
                        float facing = clamp(dot(n, v), 0.0, 1.0);
                        surface *= mix(0.5, 1.0, pow(facing, 0.55));
                        surface = mix(surface, surface * mix(vec3(1.0), uColorEmber * 1.6, 0.55),
                            (1.0 - smoothstep(0.0, 0.5, ndl)) * smoothstep(-0.2, 0.1, ndl));
                        // The rings lay their shadow across the cloud tops.
                        float veil = 1.0;
                        if (uRinged > 0.5 && abs(uLightLocal.y) > 0.01) {
                            float reach = -vLocal.y / uLightLocal.y;
                            vec3 hit = vLocal + uLightLocal * reach;
                            float rt = (length(hit.xz) - uRing.x) / (uRing.y - uRing.x);
                            if (reach > 0.0 && rt > 0.0 && rt < 1.0) {
                                float ice = 0.75 - 0.7 * smoothstep(0.27, 0.285, rt) * (1.0 - smoothstep(0.34, 0.355, rt));
                                if (uRingMapped > 0.0) ice = mix(ice, texture2D(uRingMap, vec2(rt, 0.5)).r, uRingMapped);
                                veil = 1.0 - 0.82 * ice * smoothstep(0.0, 0.03, rt) * (1.0 - smoothstep(0.95, 1.0, rt));
                            }
                        }
                        col = surface * (0.006 + day * 0.99 * veil) + air * rim * (0.012 + day * 0.8 * veil);
                        // Seen against the sun the air along the limb lights up.
                        float against = pow(max(dot(-v, SUN), 0.0), 4.0);
                        col += air * rim * against * smoothstep(-0.1, 0.7, dot(n, SUN)) * 2.2;
                        float polarLight = smoothstep(0.77, 0.94, abs(p.y));
                        float curtain = mix(0.55, 1.0, noise(vec3(p.xz * 5.0, uTime * 0.14 + uSeed)));
                        col += mix(uColorPrimary, uColorAccent, 0.3) * polarLight * curtain * (1.0 - day) * 0.20 * uGlow;
                        if (uDetail > 0.5) {
                            // Lightning deep in the storm belts of the night side:
                            // brief flashes that light a patch of cloud from below.
                            vec3 g = vec3(p.x * 16.0, lat * 30.0, p.z * 16.0), cell = floor(g);
                            float cellSeed = hash(cell + uSeed * 7.0);
                            float beat = uTime * (1.5 + cellSeed * 2.0) + cellSeed * 31.0;
                            float strike = step(0.93, hash(vec3(floor(beat), cellSeed, 3.0))) * pow(1.0 - fract(beat), 6.0);
                            float glowAt = exp(-length(g - cell - 0.5) * 3.2);
                            col += mix(uColorInk, uColorPrimary, 0.25) * strike * glowAt * step(0.55, cellSeed)
                                * (1.0 - day) * 0.55 * uGlow;
                        }
                        }
                    }
                    #elif BODY_KIND == 2
                    {
                        // Ring system: ringlets, a wide division, spiral density
                        // waves, the planet's shadow, and light scattered forward.
                        float r = length(vLocal.xz);
                        float t = clamp((r - uRing.x) / (uRing.y - uRing.x), 0.0, 1.0);
                        float angle = atan(vLocal.z, vLocal.x);
                        float ringlets = 0.25 + 0.75 * noise(vec3(t * 54.0, uSeed * 9.0, 0.0))
                            * (0.6 + 0.4 * noise(vec3(t * 190.0, 4.0, uSeed)));
                        float edges = smoothstep(0.0, 0.03, t) * (1.0 - smoothstep(0.94, 1.0, t));
                        float division = 1.0 - 0.94 * smoothstep(0.27, 0.285, t) * (1.0 - smoothstep(0.34, 0.355, t));
                        float wave = 0.82 + 0.18 * sin(angle * 2.0 - log(max(r, 1.0)) * 9.0 + uTime * 0.12);
                        float dust = 0.82 + 0.18 * noise(vec3(vLocal.xz * 1.3, uSeed));
                        float density = ringlets * division * wave * dust;
                        vec3 tone = mix(mix(uColorAccent, uColorInk, 0.5), mix(uColorPrimary, uColorInk, 0.5), smoothstep(0.0, 0.3, t));
                        tone = mix(tone, uColorInk * 0.5, smoothstep(0.7, 1.0, t));
                        if (uMapped > 0.0) {
                            // A measured profile: how much ice there is along the
                            // radius, and how bright it is.
                            vec4 profile = texture2D(uSurface, vec2(t, 0.5));
                            float sand = 0.84 + 0.16 * noise(vec3(t * 420.0, uSeed * 5.0, 0.0));
                            density = mix(density, profile.r * sand * (0.94 + 0.06 * wave), uMapped);
                            // Dusty and warm near the planet, pale ice in the broad
                            // middle ring, greyer and cooler outside the division.
                            vec3 dusty = mix(uColorInk, mix(uColorAccent, uColorEmber, 0.35), 0.4) * 0.5;
                            vec3 ice = mix(uColorInk, uColorAccent, 0.14);
                            vec3 outerIce = mix(uColorInk, uColorPrimary, 0.3) * 0.8;
                            vec3 mappedTone = mix(dusty, ice, smoothstep(0.12, 0.3, t));
                            mappedTone = mix(mappedTone, outerIce, smoothstep(0.66, 0.76, t));
                            tone = mix(tone, mappedTone * (0.45 + 0.75 * profile.g), uMapped);
                        }
                        if (uThin > 0.5) {
                            // An ice giant's rings: a few narrow dark ringlets, the
                            // outermost the broadest, over a whisper of dust.
                            float thin = 0.0;
                            for (int i = 0; i < 9; i++) {
                                float fi = float(i);
                                float at = 0.16 + fi * 0.09 + (hash(vec3(fi, uSeed, 2.0)) - 0.5) * 0.04;
                                float w = 0.004 + 0.006 * hash(vec3(fi, uSeed, 5.0)) + (i == 8 ? 0.014 : 0.0);
                                thin += exp(-(t - at) * (t - at) / (w * w));
                            }
                            density = clamp(thin, 0.0, 1.0) * 0.26 + 0.07 * noise(vec3(t * 80.0, uSeed, 3.0));
                            tone = mix(uColorInk, uColorPrimary, 0.3) * 0.2;
                        }
                        // Fine ringlets, kept only while a pixel can still resolve them.
                        float grainT = uDetail > 0.5 ? fwidth(t) : 1.0;
                        density *= 1.0 - 0.3 * (1.0 - smoothstep(0.001, 0.004, grainT))
                            * noise(vec3(t * 760.0, uSeed * 7.0, 1.0));
                        density *= 1.0 - 0.22 * (1.0 - smoothstep(0.004, 0.012, grainT))
                            * noise(vec3(t * 230.0, uSeed * 3.0, 2.0));
                        // Close to, the sheet resolves into what it is made of:
                        // clumps strung out along the orbit, grit, glints of ice.
                        float nearBy = uDetail * (1.0 - smoothstep(50.0, 240.0, vDepth));
                        float glint = 0.0;
                        if (nearBy > 0.0) {
                            float clump = noise(vec3(r * 2.4, vLocal.z * 0.33, vLocal.x * 0.33 + uSeed * 5.0));
                            float grit = noise(vec3(vLocal.xz * 4.6, uSeed * 2.0));
                            density *= mix(1.0, (0.5 + 1.0 * clump) * (0.72 + 0.56 * grit), nearBy);
                            glint = smoothstep(0.8, 0.9, noise(vec3(vLocal.xz * 41.0, uSeed + 4.0)))
                                * (1.0 - smoothstep(40.0, 150.0, vDepth)) * uDetail;
                        }
                        float along = -dot(vLocal, uLightLocal);
                        float miss = length(vLocal + uLightLocal * along);
                        // The planet's shadow, its edge softening with distance.
                        float soft = 0.03 + 0.05 * clamp(-along / (uBodyRadius * 3.0), 0.0, 1.0);
                        float shadow = along < 0.0
                            ? smoothstep(uBodyRadius * (1.0 - soft), uBodyRadius * (1.0 + soft), miss) : 1.0;
                        // Ice in sunlight: the lit face reflects, more where the
                        // ring is thick; seen from below, the thin rings glow
                        // with light passed through and the thick one goes dark.
                        float depthOf = density * 3.2;
                        float tilt = 0.3 + 0.7 * abs(uLightLocal.y);
                        float reflected = (1.0 - exp(-depthOf)) * tilt;
                        float passed = depthOf * exp(-depthOf) * 1.9 * tilt;
                        float litFace = smoothstep(-0.04, 0.04, ndl);
                        float forward = pow(max(dot(-v, SUN), 0.0), 6.0);
                        col = tone * (mix(passed, reflected, litFace) * (0.82 + 0.4 * glint) + forward * 0.5 * passed)
                            * mix(0.03, 1.0, shadow);
                        // Seen edge-on a thin sheet still hides what is behind it.
                        float across = max(0.22, abs(dot(n, v)));
                        alpha = (1.0 - exp(-depthOf * 0.8 / across)) * edges * fade;
                    }
                    #elif BODY_KIND == 4
                    {
                        // Air above the cloud tops: brightest along the limb, thinning
                        // outwards, lit on the day side and glowing when the sun is behind.
                        float facing = clamp(dot(n, v), 0.0, 1.0);
                        float halo = facing < LIMB
                            ? pow(facing / LIMB, 2.4)
                            : pow(1.0 - (facing - LIMB) / (1.0 - LIMB), 7.0);
                        float lit = smoothstep(-0.32, 0.45, ndl);
                        float against = pow(max(dot(-v, SUN), 0.0), 4.0) * smoothstep(-0.05, 0.75, dot(n, SUN));
                        col = mix(uColorPrimary, uColorInk, 0.38) * (0.5 + lit)
                            + mix(uColorAccent, uColorInk, 0.5) * against * 1.5;
                        alpha = halo * (0.012 + 0.42 * lit + 0.5 * against) * fade * step(grain, solid - 0.04);
                        if (abs(uWorld - 2.0) < 0.5 || abs(uWorld - 3.0) < 0.5) {
                            // Plumes: fine streaks rising from the vents, thinning with
                            // height, lit by the sun and brightest seen against it.
                            vec3 q = normalize(vLocal);
                            float streaks = noise(vec3(atan(q.z, q.x + 1e-5) * 26.0, vRise * 3.0, uSeed * 5.0)) * 0.6
                                + noise(vec3(atan(q.z, q.x + 1e-5) * 70.0, vRise * 8.0 - uTime * 0.3, uSeed)) * 0.4;
                            float body = smoothstep(0.01, 0.06, vRise) * (0.4 + 0.6 * smoothstep(0.35, 0.8, streaks));
                            float sunPart = smoothstep(-0.3, 0.4, ndl) + against * 2.5;
                            col = mix(uColorInk, uColorPrimary, uWorld < 2.5 ? 0.25 : 0.05)
                                * (uWorld < 2.5 ? 1.0 : 0.85) * (0.15 + sunPart);
                            if (uWorld > 2.5) col = mix(col, mix(uColorAccent, uColorInk, 0.5) * (0.15 + sunPart), 0.4);
                            // Thinning to nothing at the top and along the outline, so no edge shows.
                            float top = vRise / (uWorld < 2.5 ? 0.5 : 0.28);
                            alpha = body * 0.22 * (1.0 - smoothstep(0.15, 0.9, top)) * smoothstep(0.05, 0.5, facing)
                                * fade * step(grain, solid - 0.04);
                        }
                    }
                    #else
                    {
                        // Sail film: aluminised on the sunward face, bare gold
                        // polymer behind; fold creases, slack wrinkles, strips
                        // of thin solar cells, taped edges. It mirrors the sky.
                        vec2 q = vUv * 2.0 - 1.0;
                        vec2 aq = abs(q);
                        float reach = max(aq.x, aq.y);
                        float gap = abs(aq.x - aq.y);
                        if (gap < 0.012 && reach > 0.09) discard;
                        vec3 flat_ = normalize(vNormal);
                        bool sunward = dot(flat_, v) > 0.0;
                        float folds = max(1.0 - smoothstep(0.0, 0.05, abs(fract(q.x * 9.0) - 0.5) * 2.0),
                            1.0 - smoothstep(0.0, 0.05, abs(fract(q.y * 9.0) - 0.5) * 2.0));
                        float slack = noise(vec3(q * vec2(5.0, 23.0) * (aq.x > aq.y ? 1.0 : 0.0)
                            + q.yx * vec2(5.0, 23.0) * (aq.x > aq.y ? 0.0 : 1.0), uSeed * 9.0)) - 0.5;
                        // Tension lines fan out from the hub and the boom tips; a
                        // fine crinkle is left from the film having been packed.
                        float fan = noise(vec3(atan(q.y, q.x) * 26.0, reach * 2.0, uSeed * 5.0)) - 0.5;
                        vec2 crinkle = vec2(noise(vec3(q * 46.0, uSeed)), noise(vec3(q * 46.0 + 19.0, uSeed))) - 0.5;
                        vec3 nn = normalize(n + (aq.x > aq.y ? vec3(0.0, slack, 0.0) : vec3(slack, 0.0, 0.0)) * 0.5
                            + vec3(-q.y, q.x, 0.0) * fan * 0.55 + vec3(crinkle, 0.0) * 0.22 * uDetail);
                        float lam = clamp(abs(dot(nn, uLight)), 0.0, 1.0);
                        float facing = clamp(abs(dot(nn, v)), 0.0, 1.0);
                        vec3 bounce = reflect(-v, nn);
                        vec3 sky = mix(mix(uColorPrimary, uColorInk, 0.3) * 0.13, mix(uColorEmber, uColorAccent, 0.4) * 0.36,
                            smoothstep(-0.25, 0.55, dot(bounce, SUN)));
                        float sun = pow(max(dot(normalize(uLight + v), nn), 0.0), 14.0);
                        vec3 silver = uColorInk * (0.05 + 0.16 * lam) + sky * 1.9 + uColorInk * sun * 1.6 * lam;
                        vec3 gold = mix(mix(uColorPrimary, uColorInk, 0.72), uColorAccent, 0.42) * (0.07 + 0.42 * lam)
                            + mix(uColorAccent, uColorInk, 0.5) * sun * 0.9 * lam + sky * 0.5;
                        col = sunward ? silver : gold;
                        col *= 1.0 - 0.28 * folds;
                        // Thin-film cells in a band on each quadrant, taped hems.
                        float cells = smoothstep(0.5, 0.52, reach) * (1.0 - smoothstep(0.62, 0.64, reach))
                            * smoothstep(0.06, 0.09, gap) * step(0.12, fract(max(aq.x, aq.y) < 0.0 ? 0.0 : min(aq.x, aq.y) * 14.0));
                        col = mix(col, uColorInk * 0.035 * (0.3 + lam) + sky * 0.8, cells * (sunward ? 1.0 : 0.25));
                        float hem = smoothstep(0.965, 0.985, reach) + (1.0 - smoothstep(0.012, 0.03, gap));
                        col = mix(col, uColorInk * (0.1 + 0.5 * lam), clamp(hem, 0.0, 1.0) * 0.8);
                        alpha = (0.9 + 0.1 * (1.0 - facing)) * fade;
                    }
                    #endif
                    // Whatever drifts behind the reading area steps back.
                    vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
                    float forward = smoothstep(0.15, 0.8, length(ndc * vec2(0.8, 1.5)));
                    if (uPaper > 0.5) {
                        // On paper a body is a wash, never darker than a soft grey:
                        // its shade is lifted toward the page, and behind the
                        // lyrics or far off it fades into the page instead of darkening.
                        col = uFloor + col * (vec3(1.0) - uFloor);
                        col = mix(col, uPage, (1.0 - forward) * 0.3);
                        col = mix(col, uPage, smoothstep(700.0, 1700.0, vDepth) * 0.45);
                    } else {
                        col *= mix(0.3, 1.0, forward);
                    }
                    col += mix(uColorAccent, uColorInk, 0.4) * front * 1.6 * uGlow;
                    // A real GPU can make NaN where a software one does not; one bad
                    // pixel would spread through the bloom, so it is cleared here.
                    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
                    col = min(max(col, vec3(0.0)), vec3(64.0));
                    if (isnan(alpha)) alpha = 0.0;
                    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `
        }), surface);

        const buildStationBody = (spec, seed) => [[stationGeometry(spec), makeBodyMaterial(0, seed)]];
        const buildPlanetBody = ({ radius }, seed) =>
            [
                [fuse([
                    [new T.SphereGeometry(radius * 0.985, 72, 44), 0],
                    [new T.SphereGeometry(radius * 0.11, 24, 16).translate(radius * 1.72, radius * 0.1, radius * 0.3), 1],
                    [new T.SphereGeometry(radius * 0.045, 20, 12).translate(-radius * 1.1, -radius * 0.18, radius * 2.0), 1]
                ]),
                    makeBodyMaterial(1, seed, seed < 0.5 ? 'gas-giant-b.webp' : 'gas-giant-a.webp')],
                [fuse([[new T.SphereGeometry(radius * 0.985 * AIR_REACH, 56, 32), 0]]), makeBodyMaterial(4, seed)]
            ];
        const buildRingedBody = ({ inner, outer }, seed) => {
            const bodyRadius = inner / 1.32;
            const disc = makeBodyMaterial(2, seed, 'ring-system.png');
            disc.uniforms.uRing.value.set(inner, outer);
            disc.uniforms.uBodyRadius.value = bodyRadius;
            const globe = wearSurface(makeBodyMaterial(1, seed + 0.37, 'ringed-giant.webp'),
                'ring-system.png', 'uRingMap', 'uRingMapped');
            globe.uniforms.uRinged.value = 1;
            globe.uniforms.uRing.value.set(inner, outer);
            return [
                [fuse([
                    [new T.SphereGeometry(bodyRadius, 56, 36), 0],
                    [new T.SphereGeometry(bodyRadius * 0.13, 24, 16).translate(outer * 1.2, outer * 0.02, 0).rotateY(2.1), 1]
                ]), globe],
                [fuse([[new T.SphereGeometry(bodyRadius * AIR_REACH, 48, 28), 0]]), makeBodyMaterial(4, seed + 0.37)],
                [fuse([[new T.RingGeometry(inner, outer, 192, 2).rotateX(-Math.PI / 2), 0]]), disc]
            ];
        };
        const buildShipBody = (spec, seed) => {
            if (spec.plan) return buildStationBody(spec, seed);
            const plan = sailPlan(spec.scale);
            const at = new Float32Array(3);
            const posed = (geometry) => {
                const p = geometry.attributes.position, n = geometry.attributes.normal;
                for (let i = 0; i < p.count; i += 1) {
                    plan.pose(p.getX(i), p.getY(i), p.getZ(i), at); p.setXYZ(i, at[0], at[1], at[2]);
                    if (n) { plan.pose(n.getX(i), n.getY(i), n.getZ(i), at); n.setXYZ(i, at[0], at[1], at[2]); }
                }
                return geometry;
            };
            const film = new T.PlaneGeometry(plan.half * 2, plan.half * 2, 32, 32);
            const fp = film.attributes.position;
            for (let i = 0; i < fp.count; i += 1) fp.setZ(i, plan.billow(fp.getX(i), fp.getY(i)));
            film.computeVertexNormals();
            const frame = [];
            for (let i = 0; i < 4; i += 1) {
                frame.push([new T.CylinderGeometry(plan.boom, plan.boom * 0.5, plan.half * Math.SQRT2, 6, 1, true)
                    .translate(0, plan.half * Math.SQRT2 / 2, 0).rotateZ(Math.PI / 4 + i * Math.PI / 2), 7]);
            }
            frame.push([new T.CylinderGeometry(plan.bus, plan.bus, plan.busLength, 16, 1)
                .rotateX(Math.PI / 2).translate(0, 0, plan.busLength * 0.2), 3]);
            frame.push([new T.BoxGeometry(plan.bus * 2.4, plan.bus * 0.5, plan.bus * 0.04)
                .translate(0, 0, plan.busLength * 0.72), 4]);
            return [
                [posed(fuse(frame)), makeBodyMaterial(0, seed)],
                [posed(fuse([[film, 0]])), makeBodyMaterial(3, seed)]
            ];
        };
        const bodyBuilders = [buildStationBody, buildPlanetBody, buildRingedBody, buildShipBody];
        const bodyNodes = slotTemplateMap.map((item, idx) => {
            const group = new T.Group();
            group.visible = false;
            const seed = (idx * 0.618 + 0.11) % 1;
            const built = bodyBuilders[item.code](item.spec, seed).map(([geo, mat]) => [geo, mat, 0]);
            (item.spec.variants || []).forEach((variant, v) => {
                built.push([stationGeometry(variant), makeBodyMaterial(0, (seed + 0.29 * (v + 1)) % 1), v + 1]);
            });
            const parts = built.map(([geo, mat, variant]) => {
                const mesh = new T.Mesh(geo, mat);
                mesh.frustumCulled = false;
                // Translucent rings and sails draw after the opaque bodies they wrap.
                mesh.renderOrder = mat.transparent ? 6 : 0;
                group.add(mesh);
                return { geo, mat, mesh, variant };
            });
            root.add(group);
            return { group, parts };
        });
        const worldLight = new T.Vector3(...KEY_LIGHT);
        const bodyTurn = new T.Quaternion();


        /* ------------------------------------------------------------------------
         * Layer 4c: a field of rock. In the quiet passages (the opening drift,
         * interludes, the close) the route runs through scattered boulders that
         * tumble past on every side. They live in a box that travels with the
         * camera, so there are always more ahead, and keep clear of the route.
         * ------------------------------------------------------------------------ */
        const ROCK_COUNT = 110;
        const rockField = (() => {
            const rand = seededRandom('rock-field-v1');
            const proto = new T.IcosahedronGeometry(1, 1);
            const protoPos = proto.attributes.position, per = protoPos.count;
            const position = new Float32Array(ROCK_COUNT * per * 3);
            const home = new Float32Array(ROCK_COUNT * per * 4);
            const spin = new Float32Array(ROCK_COUNT * per * 4);
            const lump = (x, y, z, seed) => 1 + 0.26 * Math.sin(x * 2.3 + seed * 9) * Math.cos(y * 2.9 - seed * 5)
                + 0.2 * Math.sin(z * 3.7 + seed * 13) + 0.12 * Math.cos((x + y + z) * 5.1 + seed * 3);
            for (let r = 0; r < ROCK_COUNT; r += 1) {
                const seed = rand(), size = 0.5 + Math.pow(rand(), 3.2) * 5.2;
                const squash = [0.7 + rand() * 0.6, 0.55 + rand() * 0.5, 0.7 + rand() * 0.6];
                const centre = [(rand() - 0.5) * 300, (rand() - 0.5) * 190, -rand() * 900, seed];
                const axis = unit([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
                const rate = (0.08 + rand() * 0.3) * (rand() < 0.5 ? -1 : 1);
                for (let i = 0; i < per; i += 1) {
                    const x = protoPos.getX(i), y = protoPos.getY(i), z = protoPos.getZ(i);
                    const k = lump(x, y, z, seed) * size, o = (r * per + i);
                    position.set([x * k * squash[0], y * k * squash[1], z * k * squash[2]], o * 3);
                    home.set(centre, o * 4);
                    spin.set([axis[0], axis[1], axis[2], rate], o * 4);
                }
            }
            proto.dispose();
            const geo = new T.BufferGeometry();
            geo.setAttribute('position', new T.BufferAttribute(position, 3));
            geo.setAttribute('aHome', new T.BufferAttribute(home, 4));
            geo.setAttribute('aSpin', new T.BufferAttribute(spin, 4));
            const mat = new T.ShaderMaterial({
                uniforms: {
                    uCamPos: { value: new T.Vector3() }, uTime: { value: 0 }, uAmount: { value: 0 }, uBelt: { value: 0 },
                    uLight: { value: new T.Vector3(...KEY_LIGHT) },
                    uColorPrimary: { value: new T.Color('#76bfae') }, uColorInk: { value: new T.Color('#f2f0e9') },
                    uColorAccent: { value: new T.Color('#f2a900') }, uFloor: { value: new T.Color('#000000') },
                    uPage: { value: new T.Color('#000000') }, uPaper: { value: 0 },
                    uViewport: { value: new T.Vector2(1280, 720) }
                },
                vertexShader: `
                    attribute vec4 aHome, aSpin;
                    uniform vec3 uCamPos;
                    uniform float uTime, uBelt;
                    varying vec3 vWorld, vLocal;
                    varying float vSeed, vDepth, vCycleDepth;
                    void main() {
                        // Tumble about the rock's own axis.
                        float turn = uTime * aSpin.w + aHome.w * 6.28;
                        vec3 k = aSpin.xyz;
                        vec3 local = position * cos(turn) + cross(k, position) * sin(turn) + k * dot(k, position) * (1.0 - cos(turn));
                        vec3 box = vec3(300.0, 190.0, 900.0);
                        vec3 rel = mod(aHome.xyz - uCamPos + box * 0.5, box) - box * 0.5;
                        rel.z = mod(aHome.z - uCamPos.z, 900.0) - 860.0;
                        vCycleDepth = -rel.z;
                        rel.z *= 1.0 - uBelt * 0.46;
                        rel.x *= 1.0 - uBelt * 0.12;
                        // Compress the scattered field into a tilted sheet during the belt passage.
                        rel.y = mix(rel.y, rel.y * 0.25 + rel.x * 0.42 - 13.0 + sin(rel.z * 0.012) * 5.0, uBelt);
                        // Nothing sits on the route itself.
                        float clear = length(rel.xy);
                        rel.xy *= max(clear, 17.0 + aHome.w * 9.0 + uBelt * 5.0) / max(clear, 0.001);
                        float bulk = 1.0 + uBelt * (0.45 + 0.55 * aHome.w);
                        vec3 world = uCamPos + rel + local * bulk;
                        vWorld = world; vLocal = position; vSeed = aHome.w;
                        vec4 mv = viewMatrix * vec4(world, 1.0);
                        vDepth = -mv.z;
                        gl_Position = projectionMatrix * mv;
                    }
                `,
                fragmentShader: `
                    uniform float uAmount, uBelt, uPaper;
                    uniform vec3 uLight, uColorPrimary, uColorInk, uColorAccent, uFloor, uPage;
                    uniform vec2 uViewport;
                    varying vec3 vWorld, vLocal;
                    varying float vSeed, vDepth, vCycleDepth;
                    float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
                    float noise(vec3 p) {
                        vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
                        return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                            mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                            mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                            mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
                    }
                    void main() {
                        // Rocks come and go one by one, and thin out with distance.
                        float present = smoothstep(vSeed * 0.7, vSeed * 0.7 + 0.3, uAmount)
                            * (1.0 - smoothstep(560.0, 840.0, max(vDepth, vCycleDepth))) * smoothstep(4.0, 16.0, vDepth);
                        float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
                        if (dither >= present) discard;
                        // Broken faces, as shattered rock has.
                        vec3 n = cross(dFdx(vWorld), dFdy(vWorld)); n = dot(n, n) > 1e-12 ? normalize(n) : vec3(0.0, 0.0, 1.0);
                        vec3 v = normalize(cameraPosition - vWorld);
                        if (dot(n, v) < 0.0) n = -n;
                        float lit = clamp(dot(n, uLight) * 1.15 + 0.03, 0.0, 1.0);
                        float grain = 0.6 + 0.4 * noise(vLocal * 2.6 + vSeed * 31.0);
                        float pit = smoothstep(0.62, 0.7, noise(vLocal * 1.3 + vSeed * 7.0));
                        vec3 stone = mix(uColorPrimary, uColorInk, 0.55) * (0.2 + 0.14 * vSeed) * grain * (1.0 - 0.45 * pit);
                        vec3 col = stone * (mix(uColorInk, uColorAccent, 0.2) * lit * 1.5
                            + uColorPrimary * (0.05 + 0.07 * clamp(0.5 - 0.5 * dot(n, uLight), 0.0, 1.0)));
                        col = uPaper > 0.5 ? uFloor + col * (vec3(1.0) - uFloor) : col + uFloor;
                        col += uColorPrimary * uBelt * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 2.0) * (0.035 + grain * 0.055);
                        vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
                        float forward = smoothstep(0.15, 0.8, length(ndc * vec2(0.8, 1.5)));
                        if (uPaper > 0.5) {
                            col = mix(col, uPage, (1.0 - forward) * 0.3);
                            col = mix(col, uPage, smoothstep(250.0, 800.0, vDepth) * 0.45);
                        } else {
                            col *= mix(0.35, 1.0, forward);
                        }
                        gl_FragColor = vec4(col, 1.0);
                        #include <tonemapping_fragment>
                        #include <colorspace_fragment>
                    }
                `
            });
            const mesh = new T.Mesh(geo, mat);
            mesh.frustumCulled = false;
            mesh.visible = false;
            root.add(mesh);
            return { geo, mat, mesh, per };
        })();

        const BELT_GRAIN_COUNT = 920;
        const beltDust = (() => {
            const rand = seededRandom('asteroid-belt-dust');
            const sites = new Float32Array(BELT_GRAIN_COUNT * 3);
            for (let i = 0; i < BELT_GRAIN_COUNT; i += 1) {
                const lane = rand() < 0.63 ? 0 : rand() < 0.5 ? -13 : 15;
                sites.set([(rand() - 0.5) * 340, lane + (rand() + rand() - 1) * 21, rand() * 630], i * 3);
            }
            const geo = new T.BufferGeometry();
            geo.setAttribute('position', new T.BufferAttribute(sites, 3));
            const mat = new T.ShaderMaterial({
                transparent: true, depthWrite: false,
                uniforms: {
                    uCamPos: { value: new T.Vector3() }, uBelt: { value: 0 }, uRatio: { value: 1 },
                    uDust: { value: new T.Color('#76bfae') }, uGlint: { value: new T.Color('#f2a900') }
                },
                vertexShader: `
                    uniform vec3 uCamPos;
                    uniform float uBelt, uRatio;
                    varying float vSeed, vFade;
                    void main() {
                        float x = mod(position.x - uCamPos.x + 170.0, 340.0) - 170.0;
                        float z = -mod(position.z + uCamPos.z + 630.0, 630.0);
                        float y = x * 0.42 - 13.0 + position.y + sin(z * 0.012) * 5.0;
                        vec4 mv = viewMatrix * vec4(uCamPos + vec3(x, y, z), 1.0);
                        float depth = max(1.0, -mv.z);
                        vSeed = fract(position.z * 1.719);
                        vFade = uBelt * smoothstep(12.0, 34.0, -z) * (1.0 - smoothstep(415.0, 625.0, -z));
                        vFade *= smoothstep(19.0, 46.0, length(vec2(x, y))) * (1.0 - smoothstep(125.0, 169.0, abs(x)));
                        gl_PointSize = clamp((0.9 + vSeed * 1.65) * 156.0 / depth, 0.75, 3.1) * uRatio;
                        gl_Position = projectionMatrix * mv;
                    }
                `,
                fragmentShader: `
                    uniform vec3 uDust, uGlint;
                    varying float vSeed, vFade;
                    void main() {
                        vec2 p = gl_PointCoord - 0.5;
                        float grain = 1.0 - smoothstep(0.06, 0.24, dot(p, p));
                        gl_FragColor = vec4(mix(uDust, uGlint, vSeed * vSeed), grain * vFade * (0.24 + vSeed * 0.41));
                        #include <tonemapping_fragment>
                        #include <colorspace_fragment>
                    }
                `
            });
            const mesh = new T.Points(geo, mat);
            mesh.frustumCulled = false;
            mesh.visible = false;
            root.add(mesh);
            return { geo, mat, mesh };
        })();

        /* ------------------------------------------------------------------------
         * 层级 5：深空引力波纹环 (Gravitational Wave Ripples)
         * ------------------------------------------------------------------------ */
        const RIPPLE_COUNT = 3;
        const rippleGeo = new T.RingGeometry(0.975, 1.0, 96);
        const ripples = [];
        for (let i = 0; i < RIPPLE_COUNT; i += 1) {
            const mat = new T.MeshBasicMaterial({
                color: new T.Color('#76bfae'),
                transparent: true,
                opacity: 0,
                side: T.DoubleSide,
                depthWrite: false,
                blending: T.AdditiveBlending
            });
            const mesh = new T.Mesh(rippleGeo, mat);
            mesh.visible = false;
            root.add(mesh);
            ripples.push({ mesh, mat, age: 99, life: 1.8, anchor: new T.Vector3() });
        }
        let rippleCursor = 0;
        let bassSmooth = 0;
        let vocalSmooth = 0;
        let prevBass = 0;

        /* ------------------------------------------------------------------------
         * 层级 6：单源三维空间锚定歌词 × 李萨如结项粒子流形 (Spatial Knotted Lyric Stage)
         *   - 彻底废除旧版重复的 rasterizeLyric + solidTextMesh 双轨死代码
         *   - 每一句歌词锚定在三维深空曲率航道的分镜舞台上
         *   - 粒子从高维李萨如结项 (Lissajous Knot) 盘旋凝聚成字，退场时沿涡流丝线飘散入深空
         * ------------------------------------------------------------------------ */
        const lyricAnchorGroup = new T.Group();
        lyricAnchorGroup.renderOrder = 25;
        root.add(lyricAnchorGroup);

        const glyphStage = new T.Group();
        glyphStage.renderOrder = 30;
        lyricAnchorGroup.add(glyphStage);

        const LYRIC_PARTICLE_CAP = 3600;
        const lyrTarget = new Float32Array(LYRIC_PARTICLE_CAP * 3);
        const lyrSeed = new Float32Array(LYRIC_PARTICLE_CAP * 4); // x: uPhase, y: rand1, z: rand2, w: glyphNormTime
        const lyrColor = new Float32Array(LYRIC_PARTICLE_CAP * 3);

        const lyricGeo = new T.BufferGeometry();
        lyricGeo.setAttribute('position', new T.BufferAttribute(lyrTarget, 3).setUsage(T.DynamicDrawUsage));
        lyricGeo.setAttribute('aSeed', new T.BufferAttribute(lyrSeed, 4).setUsage(T.DynamicDrawUsage));
        lyricGeo.setAttribute('aColor', new T.BufferAttribute(lyrColor, 3).setUsage(T.DynamicDrawUsage));

        const lyricParticleMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                uTime: { value: 0 },
                uPixelRatio: { value: 1 },
                uCohesion: { value: 0 },
                uDisperse: { value: 0 },
                uLineProgress: { value: 0 },
                uOpacity: { value: 0 },
                uGlow: { value: 1 },
                uVocal: { value: 0 },
                uKnotP: { value: 3 },
                uKnotQ: { value: 4 },
                uTint: { value: new T.Color('#f2a900') }
            },
            vertexShader: `
                attribute vec4 aSeed; // x: knotPhase, y: rand1, z: rand2, w: glyphNorm
                attribute vec3 aColor;
                uniform float uTime, uPixelRatio, uCohesion, uDisperse, uLineProgress, uGlow, uVocal, uKnotP, uKnotQ;
                varying vec3 vColor;
                varying float vAlpha;
                varying float vSpark;

                void main() {
                    float u = aSeed.x;
                    float r1 = aSeed.y;
                    float r2 = aSeed.z;
                    float glyphOrder = aSeed.w;

                    // 按字序渐进凝聚：左端字先从结项流形中凝结，右端字稍后汇入
                    float localCohesion = clamp((uCohesion * 1.28) - glyphOrder * 0.28, 0.0, 1.0);
                    localCohesion = localCohesion * localCohesion * (3.0 - 2.0 * localCohesion);

                    // 1. 李萨如结项源轨道 (Lissajous / Torus Knot Origin Field)
                    float tau = 6.2831853;
                    float theta = u * tau + uTime * 0.45;
                    float knotR = 16.0 + 7.5 * cos(uKnotQ * theta + r1 * tau);
                    vec3 knotPos = vec3(
                        cos(uKnotP * theta) * knotR * 1.35 + (r1 - 0.5) * 14.0,
                        sin(uKnotP * theta) * knotR * 0.62 + (r2 - 0.5) * 9.0,
                        -38.0 - r2 * 64.0 + sin(uKnotQ * theta) * 18.0
                    );

                    vec3 pos = mix(knotPos, position, localCohesion);

                    // 2. 演唱扫描波纹：当演唱进度扫过当前字所属区间时，激发星尘微涟漪
                    float waveDist = abs(uLineProgress - glyphOrder);
                    float vocalWave = exp(-waveDist * waveDist * 48.0) * localCohesion * (0.45 + uVocal * 0.75);
                    pos.y += sin(uTime * 5.0 + u * 24.0) * vocalWave * 0.42;
                    pos.z += vocalWave * 0.85;

                    // 3. 退场星尘涡流解体 (Curl-Like Spiral Dissolve into Deep Space)
                    if (uDisperse > 0.001) {
                        float d = uDisperse * uDisperse;
                        float curlA = u * tau * 2.0 + uTime * 0.8 + r1 * 6.28;
                        vec3 drift = vec3(
                            cos(curlA) * (14.0 + r1 * 32.0) + (position.x * 0.35),
                            sin(curlA * 0.8) * (10.0 + r2 * 24.0) + d * 8.5,
                            (28.0 + r2 * 95.0)
                        );
                        pos += drift * d;
                    }

                    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
                    gl_Position = projectionMatrix * mv;

                    float depth = max(1.0, -mv.z);
                    vSpark = vocalWave;
                    // Limit the apparent size of sparks as they fly past the lens.
                    float pointSize = (mix(1.55, 0.55, localCohesion) + vocalWave * 0.22) * 190.0 / depth;
                    gl_PointSize = clamp(pointSize, 0.8, 12.0) * uPixelRatio;

                    float nearFade = smoothstep(4.0, 16.0, depth);
                    vAlpha = nearFade * (0.28 + localCohesion * 0.72) * (1.0 - smoothstep(0.65, 1.0, uDisperse));
                    vColor = aColor + vec3(vocalWave * 0.42);
                }
            `,
            fragmentShader: `
                uniform vec3 uTint;
                uniform float uOpacity, uGlow;
                varying vec3 vColor;
                varying float vAlpha;
                varying float vSpark;

                void main() {
                    vec2 p = gl_PointCoord * 2.0 - 1.0;
                    float r2 = dot(p, p);
                    if (r2 > 1.0) discard;
                    float core = exp(-r2 * 7.5);
                    float halo = exp(-r2 * 2.1) * (0.30 + vSpark * 0.45) * uGlow;
                    vec3 col = mix(uTint, vColor, 0.68);
                    gl_FragColor = vec4(col * (core * 1.55 + halo), (core + halo) * vAlpha * uOpacity);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `
        });
        const lyricPoints = new T.Points(lyricGeo, lyricParticleMat);
        lyricPoints.frustumCulled = false;
        lyricAnchorGroup.add(lyricPoints);

        // 围绕歌词舞台的极细相位结项环 (Subtle Astrolabe Framing Arcs)
        const frameRingGroup = new T.Group();
        lyricAnchorGroup.add(frameRingGroup);
        const frameArcGeos = [];
        const frameArcMats = [];
        const frameArcLines = [];
        for (let a = 0; a < 2; a += 1) {
            const startAngle = a === 0 ? -0.42 : Math.PI - 0.42;
            const curve = new T.EllipseCurve(0, 0, 22, 8.2, startAngle, startAngle + 0.84, false, 0);
            const pts = curve.getPoints(64).map((p) => new T.Vector3(p.x, p.y, -0.5));
            const geo = new T.BufferGeometry().setFromPoints(pts);
            const mat = new T.LineBasicMaterial({
                color: new T.Color('#76bfae'),
                transparent: true,
                opacity: 0,
                blending: T.AdditiveBlending,
                depthWrite: false
            });
            const line = new T.Line(geo, mat);
            frameRingGroup.add(line);
            frameArcGeos.push(geo);
            frameArcMats.push(mat);
            frameArcLines.push(line);
        }

        // 共享测量 Canvas（仅用于测量与单次字形生成，不再每帧上传大纹理）
        const measureCanvas = document.createElement('canvas');
        measureCanvas.width = 64;
        measureCanvas.height = 64;
        const measureCtx = measureCanvas.getContext('2d');

        let glyphCacheKey = '';
        let currentLineKey = '';
        let glyphVocalEnd = 0;
        let activePointCount = 0;

        // One atlas texture, one geometry and one material per lyric line. A
        // line used to cost a canvas, texture, material and geometry per glyph.
        const glyphMaterial = new T.ShaderMaterial({
            transparent: true,
            depthTest: false,
            depthWrite: false,
            uniforms: {
                map: { value: null },
                time: { value: 0 },
                alpha: { value: 1 },
                motion: { value: 1 },
                waitMain: { value: new T.Color() },
                sungMain: { value: new T.Color() },
                sub: { value: new T.Color() },
                ink: { value: new T.Color() },
                outline: { value: new T.Color() }
            },
            vertexShader: `
                attribute vec2 aCenter, aLocal, aTiming;
                attribute float aKind;
                uniform float time, motion;
                varying vec2 vUv, vLocal, vTiming;
                varying float vActive, vKind;
                void main() {
                    vUv = uv;
                    vLocal = aLocal;
                    vTiming = aTiming;
                    vKind = aKind;
                    float p = clamp((time - aTiming.x) / max(0.001, aTiming.y - aTiming.x), 0.0, 1.0);
                    float pulse = sin(p * 3.14159265) * motion;
                    vActive = pulse;
                    vec3 pos = position;
                    pos.xy *= 1.0 + pulse * 0.025;
                    pos.y += pulse * 0.12;
                    pos.z += pulse * 0.18;
                    pos.xy += aCenter;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D map;
                uniform float time, alpha;
                uniform vec3 waitMain, sungMain, sub, ink, outline;
                varying vec2 vUv, vLocal, vTiming;
                varying float vActive, vKind;
                void main() {
                    float cov = texture2D(map, vUv).a;
                    // Sample the same mask one pixel out for a narrow contrast edge.
                    vec2 dx = dFdx(vUv) * 0.9;
                    vec2 dy = dFdy(vUv) * 0.9;
                    float surround = max(
                        max(texture2D(map, vUv - dx).a, texture2D(map, vUv + dx).a),
                        max(texture2D(map, vUv - dy).a, texture2D(map, vUv + dy).a));
                    float coverage = max(cov, surround * 0.72);
                    if (coverage < 0.01) discard;
                    float p = clamp((time - vTiming.x) / max(0.001, vTiming.y - vTiming.x), 0.0, 1.0);
                    float wipe = 1.0 - smoothstep(p - 0.04, p + 0.04, vLocal.x);
                    if (p <= 0.0) wipe = 0.0;
                    if (p >= 1.0) wipe = 1.0;
                    float fromEdge = (vLocal.x - p) * 14.0;
                    float edge = exp(-fromEdge * fromEdge) * step(0.01, p) * step(p, 0.99);
                    vec3 mainColor = mix(waitMain, sungMain, wipe) + ink * edge * 0.13 + sungMain * vActive * 0.06;
                    vec3 fill = mix(mainColor, sub, vKind);
                    gl_FragColor = vec4(mix(outline, fill, cov / coverage), coverage * alpha);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `
        });
        const fadingGlyphMaterial = glyphMaterial.clone();
        // A hidden stand-in carries the glyph material from the start, so it is
        // compiled with the rest of the scene and not at the first lyric.
        const glyphWarmup = new T.Mesh(new T.PlaneGeometry(1, 1), glyphMaterial);
        glyphWarmup.visible = false;
        glyphWarmup.frustumCulled = false;
        root.add(glyphWarmup);
        const glyphColorUniforms = ['waitMain', 'sungMain', 'sub', 'ink', 'outline'];
        let glyphCanvas = document.createElement('canvas');
        let glyphMesh = null;
        let glyphTexture = null;
        let glyphLine = null;
        let glyphTop = 0;
        let glyphBottom = 0;
        let fadingGlyph = null;

        const clearFadingGlyph = () => {
            if (!fadingGlyph) return;
            lyricAnchorGroup.remove(fadingGlyph.mesh);
            fadingGlyph.mesh.geometry.dispose();
            fadingGlyph.texture.dispose();
            fadingGlyphMaterial.uniforms.map.value = null;
            fadingGlyph = null;
        };

        const keepFadingGlyph = () => {
            const uniforms = fadingGlyphMaterial.uniforms;
            glyphColorUniforms.forEach(key => uniforms[key].value.copy(glyphMaterial.uniforms[key].value));
            uniforms.map.value = glyphTexture;
            uniforms.motion.value = 0;
            glyphMesh.material = fadingGlyphMaterial;
            lyricAnchorGroup.add(glyphMesh);
            fadingGlyph = { mesh: glyphMesh, texture: glyphTexture, bottom: glyphBottom,
                alpha: glyphMaterial.uniforms.alpha.value };
            glyphMesh = null;
            glyphTexture = null;
            glyphCanvas = document.createElement('canvas');
        };

        const clearGlyphStage = () => {
            if (glyphMesh) {
                glyphStage.remove(glyphMesh);
                glyphMesh.geometry.dispose();
                glyphMesh = null;
            }
            glyphTexture?.dispose();
            glyphTexture = null;
            glyphMaterial.uniforms.map.value = null;
            glyphCacheKey = '';
        };

        // Glyph textures follow the output resolution so text stays sharp on
        // large or high-density windows without paying for it on small ones.
        const glyphResolution = () => Math.round(clamp(viewportPixels / 1000, 1, 2.5) * 4) / 4;

        const buildLyricStage = (line, settings) => {
            if (!line) {
                glyphStage.visible = false;
                activePointCount = 0;
                lyricGeo.setDrawRange(0, 0);
                return;
            }
            const colors = parsePalette();
            const scale = clamp(finiteNumber(settings?.fontScale, 1), 0.65, 1.5);
            const showTrans = settings?.showTranslation !== false;
            const subText = showTrans ? (R.resolveSupplementalText(line) || '') : '';
            const res = glyphResolution();
            const cacheKey = JSON.stringify([
                currentLineKey,
                subText,
                colors.inkHex,
                colors.accentHex,
                colors.secondaryHex,
                scale.toFixed(2),
                res
            ]);

            if (cacheKey === glyphCacheKey) return;
            clearGlyphStage();
            glyphCacheKey = cacheKey;

            const fontFamily = '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
            const mainFont = `600 80px ${fontFamily}`;
            const subFont = `500 35px ${fontFamily}`;
            measureCtx.font = mainFont;

            let glyphs = buildGlyphTimeline(line);
            if (!glyphs.length || !glyphs.some((g) => g.endTime > g.startTime)) {
                const chars = splitGraphemes(line.fullText || '');
                const start = finiteNumber(line.startTime, 0);
                const end = Math.max(start + 0.6, finiteNumber(line.endTime, start + 3.8));
                glyphs = chars.map((text, i) => ({
                    text,
                    startTime: start + ((end - start) * i) / Math.max(1, chars.length),
                    endTime: start + ((end - start) * (i + 1)) / Math.max(1, chars.length)
                }));
            }

            glyphVocalEnd = glyphs.reduce(
                (end, g) => (String(g.text || '').trim() ? Math.max(end, finiteNumber(g.endTime, end)) : end),
                finiteNumber(line.startTime, 0)
            );

            // 自动折行排版
            const rows = [[]];
            const latinWordGlyph = /^[\p{Script=Latin}\p{M}\p{N}'’]+$/u;
            let rowW = 0;
            glyphs.forEach((g) => {
                const adv = Math.max(16, measureCtx.measureText(g.text || ' ').width) + 6;
                let row = rows[rows.length - 1];
                if (rowW + adv > 1360 && row.length) {
                    let breakAt = row.length;
                    if (latinWordGlyph.test(g.text)) {
                        while (breakAt > 0 && latinWordGlyph.test(row[breakAt - 1].text)) breakAt -= 1;
                    }
                    row = breakAt > 0 ? row.splice(breakAt) : [];
                    rows.push(row);
                    rowW = row.reduce((width, item) => width + item.advance, 0);
                }
                row.push({ ...g, advance: adv });
                rowW += adv;
            });

            const maxRowWidth = Math.max(1, ...rows.map((r) => r.reduce((s, g) => s + g.advance, 0)));
            const unit = Math.min(0.024 * scale, 38 / maxRowWidth, 11.5 / (rows.length * 108 + 76));
            const rawSamples = [];

            // Layout first: every glyph becomes a cell (design pixels at the 80px
            // reference size) with a world-space centre.
            const cells = [];
            const addCell = (label, px, py, advance, start, end, isSub = false, normOrder = 0.5, fit = 1) => {
                if (!String(label || '').trim()) return;
                cells.push({
                    label, advance, start, end, isSub, order: normOrder, fit,
                    w: Math.max(32, Math.ceil(advance + 44)),
                    h: isSub ? 92 : 148,
                    cx: px + advance * unit * fit * 0.5,
                    cy: py
                });
            };

            const totalGlyphCount = Math.max(1, rows.reduce((s, r) => s + r.length, 0));
            let glyphCounter = 0;
            rows.forEach((row, ri) => {
                let x = -row.reduce((s, g) => s + g.advance, 0) * unit * 0.5;
                const y = ((rows.length - 1) * 0.5 - ri) * 108 * unit + (subText ? 0.65 : 0.15);
                row.forEach((g) => {
                    const order = glyphCounter / totalGlyphCount;
                    glyphCounter += 1;
                    addCell(g.text, x, y, g.advance, g.startTime, g.endTime, false, order);
                    x += g.advance * unit;
                });
            });

            if (subText) {
                measureCtx.font = subFont;
                const subLines = String(subText).split('\n').filter(Boolean).slice(0, 2);
                subLines.forEach((subRowText, sri) => {
                    // The translation has no per-glyph timing, so it is drawn in a
                    // few wide runs instead of one cell per character.
                    const runs = [];
                    let run = '';
                    splitGraphemes(subRowText).forEach((ch) => {
                        run += ch;
                        if (measureCtx.measureText(run).width >= 480) {
                            runs.push(run);
                            run = '';
                        }
                    });
                    if (run) runs.push(run);
                    const advances = runs.map((text) => Math.max(10, measureCtx.measureText(text).width));
                    const totalW = advances.reduce((a, b) => a + b, 0);
                    const fit = Math.min(1, 1360 / Math.max(1, totalW));
                    let x = -totalW * unit * fit * 0.5;
                    const y = -(rows.length * 54 + 44 + sri * 42) * unit;
                    let passed = 0;
                    runs.forEach((text, idx) => {
                        addCell(text, x, y, advances[idx], -1, -0.5, true,
                            (passed + advances[idx] * 0.5) / Math.max(1, totalW), fit);
                        passed += advances[idx];
                        x += advances[idx] * unit * fit;
                    });
                });
            }

            if (cells.length) {
                glyphTop = -Infinity;
                glyphBottom = Infinity;
                cells.forEach(cell => {
                    const halfHeight = (cell.isSub ? 35 : 80) * unit * 0.5;
                    glyphTop = Math.max(glyphTop, cell.cy + halfHeight);
                    glyphBottom = Math.min(glyphBottom, cell.cy - halfHeight);
                });
                // Shelf-pack the cells into one atlas and draw it once.
                const shelfLimit = Math.floor(4096 / res);
                let penX = 0, penY = 0, shelfH = 0, atlasW = 1;
                cells.forEach((cell) => {
                    if (penX + cell.w > shelfLimit && penX > 0) {
                        penX = 0;
                        penY += shelfH;
                        shelfH = 0;
                    }
                    cell.ax = penX;
                    cell.ay = penY;
                    penX += cell.w;
                    shelfH = Math.max(shelfH, cell.h);
                    atlasW = Math.max(atlasW, penX);
                });
                const atlasH = penY + shelfH;
                glyphCanvas.width = Math.ceil(atlasW * res);
                glyphCanvas.height = Math.ceil(atlasH * res);
                const ctx = glyphCanvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                    ctx.setTransform(res, 0, 0, res, 0, 0);
                    ctx.clearRect(0, 0, atlasW, atlasH);
                    ctx.textBaseline = 'middle';
                    ctx.textAlign = 'center';
                    ctx.fillStyle = '#ffffff';
                    cells.forEach((cell) => {
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(cell.ax, cell.ay, cell.w, cell.h);
                        ctx.clip?.();
                        ctx.font = cell.isSub ? subFont : mainFont;
                        // This mask also seeds the particles, so keep it to the inked strokes.
                        ctx.fillText(cell.label, cell.ax + cell.w * 0.5, cell.ay + cell.h * 0.5);
                        ctx.restore();
                    });

                    const positions = [], centers = [], uvs = [], locals = [], timings = [], kinds = [], indices = [];
                    cells.forEach((cell, index) => {
                        const halfW = cell.w * unit * cell.fit * 0.5;
                        const halfH = cell.h * unit * 0.5;
                        for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
                            positions.push((u * 2 - 1) * halfW, (v * 2 - 1) * halfH, 0);
                            centers.push(cell.cx, cell.cy);
                            uvs.push((cell.ax + u * cell.w) / atlasW, 1 - (cell.ay + (1 - v) * cell.h) / atlasH);
                            locals.push(0.5 + (u - 0.5) * cell.w / cell.advance, v);
                            timings.push(cell.start, cell.end);
                            kinds.push(cell.isSub ? 1 : 0);
                        }
                        const first = index * 4;
                        indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
                    });
                    const geometry = new T.BufferGeometry();
                    geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
                    geometry.setAttribute('aCenter', new T.Float32BufferAttribute(centers, 2));
                    geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
                    geometry.setAttribute('aLocal', new T.Float32BufferAttribute(locals, 2));
                    geometry.setAttribute('aTiming', new T.Float32BufferAttribute(timings, 2));
                    geometry.setAttribute('aKind', new T.Float32BufferAttribute(kinds, 1));
                    geometry.setIndex(indices);

                    glyphTexture = new T.CanvasTexture(glyphCanvas);
                    glyphTexture.generateMipmaps = false;
                    glyphTexture.minFilter = T.LinearFilter;
                    glyphTexture.magFilter = T.LinearFilter;
                    const uniforms = glyphMaterial.uniforms;
                    uniforms.map.value = glyphTexture;
                    if (stagePalette.light) {
                        // On paper the line is written in ink: pale and waiting,
                        // then full and deep as it is sung; the translation in a
                        // quiet grey beneath. No colour, so nothing reads as dirt.
                        uniforms.waitMain.value.copy(colors.ink).lerp(colors.background, 0.22);
                        uniforms.sungMain.value.copy(colors.ink).multiplyScalar(0.8);
                        uniforms.sub.value.copy(colors.muted).lerp(colors.ink, 0.15);
                    } else {
                        uniforms.waitMain.value.copy(colors.ink).lerp(colors.background, 0.15);
                        uniforms.sungMain.value.copy(colors.accent).lerp(colors.ink, 0.28);
                        uniforms.sub.value.copy(colors.secondary).lerp(colors.ink, 0.48);
                    }
                    uniforms.ink.value.copy(colors.ink);
                    uniforms.outline.value.copy(colors.background);

                    glyphMesh = new T.Mesh(geometry, glyphMaterial);
                    glyphMesh.frustumCulled = false;
                    glyphMesh.renderOrder = 30;
                    glyphStage.add(glyphMesh);

                    // 一次性采样整张图集的 Alpha 通道供结项粒子使用（兼容无 getImageData 的测试桩）
                    const pixelW = glyphCanvas.width;
                    const imgData = ctx.getImageData?.(0, 0, pixelW, glyphCanvas.height)?.data;
                    if (imgData && imgData.length >= pixelW * glyphCanvas.height * 4) {
                        cells.forEach((cell) => {
                            // Point sprites are wider than a translation stroke; left
                            // on the small row they merge into a white smear over it.
                            if (cell.isSub) return;
                            const stride = 5;
                            const pColor = stagePalette.light ? colors.ink : colors.accent;
                            const wWorld = cell.w * unit * cell.fit;
                            const hWorld = cell.h * unit;
                            for (let y = 0; y < cell.h; y += stride) {
                                const row = Math.min(glyphCanvas.height - 1, Math.floor((cell.ay + y + 0.5) * res)) * pixelW;
                                for (let x = 0; x < cell.w; x += stride) {
                                    const column = Math.min(pixelW - 1, Math.floor((cell.ax + x + 0.5) * res));
                                    if (imgData[(row + column) * 4 + 3] < 130) continue;
                                    rawSamples.push({
                                        x: cell.cx + ((x + 0.5) / cell.w - 0.5) * wWorld,
                                        y: cell.cy + (0.5 - (y + 0.5) / cell.h) * hWorld,
                                        color: pColor,
                                        order: cell.order
                                    });
                                }
                            }
                        });
                    }
                }
            }

            // 若运行在无像素缓冲环境（如 JSDOM 冒烟测试），生成程序化李萨如字形骨架点位兜底
            if (!rawSamples.length && cells.length) {
                const fallbackRand = seededRandom(`fallback-glyph:${currentLineKey}`);
                for (let i = 0; i < 360; i += 1) {
                    const u = i / 360;
                    rawSamples.push({
                        x: (u - 0.5) * 18.0,
                        y: Math.sin(u * TAU * 2.0) * 1.6 + (fallbackRand() - 0.5) * 1.2,
                        color: colors.accent,
                        order: u
                    });
                }
            }

            const pRand = seededRandom(`knot-lyric:${currentLineKey}`);
            activePointCount = Math.min(LYRIC_PARTICLE_CAP, rawSamples.length);
            for (let i = 0; i < activePointCount; i += 1) {
                const sample = rawSamples[Math.floor((i * rawSamples.length) / activePointCount)];
                const i3 = i * 3;
                const i4 = i * 4;
                lyrTarget[i3] = sample.x;
                lyrTarget[i3 + 1] = sample.y;
                lyrTarget[i3 + 2] = (pRand() - 0.5) * 0.35;

                lyrSeed[i4] = i / Math.max(1, activePointCount);
                lyrSeed[i4 + 1] = pRand();
                lyrSeed[i4 + 2] = pRand();
                lyrSeed[i4 + 3] = sample.order ?? 0.5;

                lyrColor[i3] = sample.color.r;
                lyrColor[i3 + 1] = sample.color.g;
                lyrColor[i3 + 2] = sample.color.b;
            }

            lyricGeo.setDrawRange(0, activePointCount);
            lyricGeo.attributes.position.needsUpdate = true;
            lyricGeo.attributes.aSeed.needsUpdate = true;
            lyricGeo.attributes.aColor.needsUpdate = true;
        };

        /* ------------------------------------------------------------------------
         * 主题调色板同步
         * ------------------------------------------------------------------------ */
        const setPalette = (palette) => {
            stagePalette = palette || {};
            const colors = parsePalette();
            const luma = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
            const paper = luma(colors.background) > luma(colors.ink);
            // On a light theme the sky is the page itself, not a dimmed copy of it.
            const abyssBg = paper ? colors.background.clone().lerp(new T.Color('#ffffff'), 0.35) : colors.background.clone().multiplyScalar(0.38);
            // A pale page cannot carry the theme's saturated accents at full
            // strength on large shapes: on paper they are washed toward the
            // muted tone, as watercolour is, and the page shows through.
            const soften = (c, toMuted, toPage) => paper ? c.clone().lerp(colors.muted, toMuted).lerp(colors.background, toPage) : c.clone();
            const washA = soften(colors.secondary, 0.3, 0.3);
            const washB = soften(colors.accent, 0.6, 0.3);
            const washEmber = soften(colors.ember, 0.6, 0.3);
            if (scene?.background?.copy) scene.background.copy(abyssBg);
            else if (scene) scene.background = abyssBg;
            if (scene?.fog?.color?.copy) scene.fog.color.copy(abyssBg);

            fieldMat.uniforms.uStarColor.value.copy(colors.ink).lerp(colors.muted, 0.35);
            fieldMat.uniforms.uNebulaA.value.copy(colors.secondary);
            fieldMat.uniforms.uNebulaB.value.copy(colors.accent);

            const pale = paper;
            const sky = skyMat.uniforms;
            sky.uBase.value.copy(abyssBg);
            sky.uColorA.value.copy(paper ? colors.secondary.clone().lerp(abyssBg, 0.55) : colors.secondary);
            sky.uColorB.value.copy(paper ? colors.accent.clone().lerp(new T.Color('#ffffff'), 0.62).lerp(abyssBg, 0.3) : colors.ember.clone().lerp(colors.accent, 0.3));
            sky.uColorStar.value.copy(colors.ink).lerp(colors.muted, 0.35);
            // On paper the sun's light is shown as a pale gold, since brightness alone
            // cannot stand out from a white page.
            if (paper) sky.uColorSun.value.set('#e3c27f');
            else sky.uColorSun.value.copy(colors.accent).lerp(new T.Color('#ffffff'), 0.62);
            sky.uInk.value.copy(paper ? colors.muted.clone().lerp(abyssBg, 0.3) : colors.ink);
            sky.uPaper.value = pale ? 1 : 0;

            filamentMat.uniforms.uColorA.value.copy(colors.secondary);
            filamentMat.uniforms.uColorB.value.copy(colors.accent);
            filamentMat.uniforms.uColorC.value.copy(colors.muted);

            streakMat.uniforms.uColorA.value.copy(colors.ink);
            streakMat.uniforms.uColorB.value.copy(colors.secondary);

            entityNodes.forEach((node) => {
                node.mat.uniforms.uColorPrimary.value.copy(washA);
                node.mat.uniforms.uColorAccent.value.copy(washB);
                node.mat.uniforms.uColorInk.value.copy(paper ? colors.muted.clone().lerp(abyssBg, 0.45) : colors.ink);
                node.mat.uniforms.uColorEmber.value.copy(washEmber);
            });
            // Bodies are lit towards "ink". On a light theme ink is the dark
            // colour, so they are lit towards paper, and their shade is a
            // soft grey of the page rather than a hole in it.
            const bodyInk = paper ? colors.background.clone().lerp(new T.Color('#ffffff'), 0.85) : colors.ink;
            const bodyFloor = paper ? abyssBg.clone().lerp(colors.secondary, 0.12).multiplyScalar(0.42) : new T.Color('#000000');
            rockField.mat.uniforms.uColorPrimary.value.copy(washA);
            rockField.mat.uniforms.uColorAccent.value.copy(washB);
            rockField.mat.uniforms.uColorInk.value.copy(bodyInk);
            rockField.mat.uniforms.uFloor.value.copy(bodyFloor);
            rockField.mat.uniforms.uPage.value.copy(abyssBg);
            rockField.mat.uniforms.uPaper.value = paper ? 1 : 0;
            beltDust.mat.uniforms.uDust.value.copy(washA).lerp(bodyInk, 0.35);
            beltDust.mat.uniforms.uGlint.value.copy(washB).lerp(bodyInk, 0.24);
            bodyNodes.forEach((body) => body.parts.forEach(({ mat }) => {
                mat.uniforms.uColorPrimary.value.copy(washA);
                mat.uniforms.uColorAccent.value.copy(washB);
                mat.uniforms.uColorInk.value.copy(bodyInk);
                mat.uniforms.uColorEmber.value.copy(washEmber);
                mat.uniforms.uFloor.value.copy(bodyFloor);
                mat.uniforms.uPage.value.copy(abyssBg);
                mat.uniforms.uPaper.value = paper ? 1 : 0;
            }));

            lyricParticleMat.uniforms.uTint.value.copy(paper ? colors.accent.clone().lerp(new T.Color('#ffffff'), 0.5) : colors.accent);
            frameArcMats.forEach((m, idx) => m.color.copy(idx === 0 ? colors.secondary : colors.accent));
            ripples.forEach((r, idx) => r.mat.color.copy(idx % 2 === 0 ? colors.secondary : colors.accent));
            glyphCacheKey = ''; // 触发当前句按新主题重绘
            clearFadingGlyph();
        };

        const reset = (lines = [], identity = 'tunnel-track', duration = 0) => {
            clearFadingGlyph();
            clearGlyphStage();
            glyphLine = null;
            currentLineKey = '';
            activePointCount = 0;
            lyricGeo.setDrawRange(0, 0);
            timeline = compileTunnelTimeline(lines, identity, duration);
            totalTravelDistance = 0;
            cruiseSpeed = 1.0;
            bassSmooth = 0;
            vocalSmooth = 0;
            prevBass = 0;
            ripples.forEach((r) => { r.age = 99; r.mesh.visible = false; });
        };

        /* ------------------------------------------------------------------------
         * 主帧更新：深空分镜推演 + GPU 流形驱动 + 空间结项歌词演出
         * ------------------------------------------------------------------------ */
        const update = (time, frame, settings, audioState, cameraInstance) => {
            const dt = audioState.dt;
            advanceSurfaces(dt);
            const live = audioState.playing;
            const settingVal = (key, fb) => {
                const v = Number(settings?.[key]);
                return Number.isFinite(v) ? v : fb;
            };

            const speedScale = clamp(settingVal('cameraSpeed', 1), 0.35, 2.2);
            const motionAmount = settings.reducedMotion
                ? 0
                : clamp(settingVal('motionAmount', 1), 0, 2) * clamp(settingVal('animationIntensity', 1), 0, 2);
            const hasMotion = motionAmount > 0.001;
            const breathAmount = clamp(settingVal('cameraBreath', 0.5), 0, 2);
            const shakeAmount = settings.reducedMotion ? 0 : clamp(settingVal('cameraShake', 1), 0, 2);
            const objectDensity = clamp(settingVal('objectDensity', 1), 0.25, 2);
            const glowAmount = clamp(settingVal('glow', 1), 0, 2);
            const dissolveAmount = clamp(settingVal('dissolveAmount', 0.72), 0, 1);
            const holdRatio = clamp(settingVal('textHoldRatio', 0.32), 0, 0.8);
            const pauseDur = clamp(settingVal('pauseDuration', 0.4), 0, 3);
            const dwell = holdRatio * 0.55 + pauseDur;

            if (audioState.seek) {
                bassSmooth = 0;
                vocalSmooth = 0;
                prevBass = 0;
                ripples.forEach((r) => { r.age = 99; r.mesh.visible = false; });
            } else {
                const alpha = 1 - Math.exp(-dt * 11);
                bassSmooth += (audioState.bass - bassSmooth) * alpha;
                vocalSmooth += (audioState.vocal - vocalSmooth) * alpha;
            }

            // 1. 采样导演状态与确定性航道弧长
            const actState = timeline.sampleState(time);
            const activeLine = frame?.activeLine || null;
            const lineIdx = activeLine?.index ?? -1;
            const shot = (lineIdx >= 0 && timeline.lineShots[lineIdx]) ? timeline.lineShots[lineIdx] : null;

            const lineStart = activeLine ? finiteNumber(activeLine.startTime, time) : time;
            const lineEnd = activeLine ? Math.max(lineStart + 0.6, finiteNumber(activeLine.endTime, lineStart + 3.8)) : time + 3.0;
            const shots = timeline.lineShots;
            const nextShotIndex = upperBound(shots, time, 'startTime');
            const cameraShot = shots[nextShotIndex - 1];
            const pose = sampleCamera(cameraShot, time);
            const focusFor = (cue) => cue
                ? smooth((time - cue.startTime + 0.65) / 0.65)
                    * (1 - smooth((time - Math.max(cue.startTime + 0.25, cue.vocalEnd) - dwell) / 0.75))
                : 0;
            const lyricFocus = Math.max(focusFor(cameraShot), focusFor(shots[nextShotIndex]));
            const speedMod = 0.92 - lyricFocus * 0.14;
            cruiseSpeed = (actState.speed / 22.0) * speedScale * speedMod * (settings.reducedMotion ? 0 : 1);
            totalTravelDistance = timeline.distanceAt(time, speedScale);

            const camSpine = timeline.spineAt(totalTravelDistance, motionAmount);

            // 漂移呼吸与低频微震（阅读区间自动衰减抖动，保护字幕清晰度）
            const readDamp = 1.0 - lyricFocus * 0.55;
            const driftX = (Math.sin(time * 0.29) * 1.15 + Math.cos(time * 0.13) * 0.65) * breathAmount * motionAmount;
            const driftY = (Math.cos(time * 0.23) * 0.82 + Math.sin(time * 0.17) * 0.45) * breathAmount * motionAmount;
            const shakeX = Math.sin(time * 16.3) * bassSmooth * 0.18 * shakeAmount * readDamp;
            const shakeY = Math.cos(time * 18.7) * bassSmooth * 0.14 * shakeAmount * readDamp;

            const side = pose.x * motionAmount + driftX;
            const lift = pose.y * motionAmount + driftY;
            const camX = camSpine.x + camSpine.right.x * side + camSpine.up.x * lift + shakeX;
            const camY = camSpine.y + camSpine.right.y * side + camSpine.up.y * lift + shakeY;
            const camZ = camSpine.z;
            cameraInstance.position.set(camX, camY, camZ);

            const lookAheadSpine = timeline.spineAt(totalTravelDistance + 140, motionAmount);
            const stageDist = 33.5;
            const stageSpine = timeline.spineAt(totalTravelDistance + stageDist, motionAmount);
            const stageX = mix(camX, stageSpine.x, 0.65) + (pose.lyricX * 0.38 + Math.sin(time * 0.34) * 0.38) * motionAmount;
            const stageY = mix(camY, stageSpine.y, 0.65)
                + (pose.lyricY * 0.38 + Math.cos(time * 0.27) * 0.28 + vocalSmooth * 0.22) * motionAmount;
            const stageZ = camZ - stageDist;
            const lookToLyric = lyricFocus * 0.58;
            let lookX = mix(lookAheadSpine.x + pose.aimX * 4.5 * motionAmount, stageX, lookToLyric);
            let lookY = mix(lookAheadSpine.y + pose.aimY * 4.5 * motionAmount, stageY, lookToLyric);
            const lookZ = mix(lookAheadSpine.z, stageZ, lookToLyric);

            // 3. 更新空间锚定歌词与结项粒子流形
            const previousLine = frame?.lines?.[lineIdx - 1];
            const upcomingLine = frame?.lines?.[lineIdx + 1];
            const joinsPrevious = lyricsCanHandoff(previousLine, activeLine, dwell);
            const joinsUpcoming = lyricsCanHandoff(activeLine, upcomingLine, dwell);
            const handoffTime = time - lineStart;
            const timeForLine = (upcomingLine?.startTime ?? lineEnd) - lineStart;
            const handoffDuration = clamp(timeForLine * 0.75, 0.05, LYRIC_HANDOFF_SECONDS);
            const handoffProgress = smooth(handoffTime / handoffDuration);
            const handingOff = joinsPrevious && handoffTime >= 0 && handoffTime < handoffDuration;

            const nextKey = activeLine ? `${activeLine.index}:${activeLine.startTime}:${activeLine.fullText}` : '';
            if (nextKey !== currentLineKey) {
                clearFadingGlyph();
                if (handingOff && !audioState.seek && hasMotion
                    && glyphLine === previousLine && glyphMesh && glyphStage.visible) {
                    keepFadingGlyph();
                }
                glyphLine = activeLine;
                currentLineKey = nextKey;
                buildLyricStage(activeLine, settings);
            } else {
                if (audioState.seek || !handingOff || !hasMotion) clearFadingGlyph();
                if (activeLine && !glyphCacheKey) buildLyricStage(activeLine, settings);
            }

            if (activeLine && activePointCount > 0) {
                const start = finiteNumber(activeLine.startTime, time);
                const vocalEnd = Math.max(start + 0.25, glyphVocalEnd);
                // The dwell is the number of seconds the finished line stays whole
                // before it dissolves; it used to be scaled down and capped to
                // a fraction of a second, which made the control inert.
                const exitStart = joinsUpcoming ? Math.max(vocalEnd + dwell, upcomingLine.startTime) : vocalEnd + dwell;
                const exitDuration = 0.55 + dissolveAmount * 0.65;

                const entryPhase = clamp((time - start) / 0.34);
                const exitPhase = clamp((time - exitStart) / exitDuration);
                const alive = time >= start - 0.05 && time < exitStart + exitDuration;

                const cohesion = settings.reducedMotion ? 1 : smoother(entryPhase);
                let solidIn = settings.reducedMotion ? 1 : smooth((entryPhase - 0.48) / 0.52);
                if (joinsPrevious) {
                    solidIn = hasMotion ? handoffProgress
                        : smooth(handoffTime / Math.min(LYRIC_FADE_SECONDS, handoffDuration));
                }
                const fadeForNext = !hasMotion && joinsUpcoming
                    ? smooth((time - upcomingLine.startTime + LYRIC_FADE_SECONDS) / LYRIC_FADE_SECONDS) : 0;
                const solidOut = (1 - smooth(exitPhase / 0.32)) * (1 - fadeForNext);
                const disperse = smooth((exitPhase - 0.12) / 0.88) * (0.35 + dissolveAmount * 0.65);
                const glyphAlpha = alive ? solidIn * solidOut : 0;

                lyricAnchorGroup.position.set(stageX, stageY, stageZ);
                const aspectScale = Math.min(1, Math.max(0.42, viewportAspect * 0.68));
                lyricAnchorGroup.scale.setScalar(aspectScale);

                // 歌词平面面向相机并保留微幅电影级欧拉倾角
                const dx = camX - stageX;
                const dy = camY - stageY;
                const dz = camZ - stageZ;
                const faceYaw = Math.atan2(dx, dz) + pose.yaw * motionAmount;
                const facePitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 0.65 + pose.pitch * motionAmount;
                const faceRoll = (pose.roll + Math.sin(time * 0.31) * 0.012) * motionAmount;
                lyricAnchorGroup.rotation.set(facePitch, faceYaw, faceRoll);

                glyphStage.visible = alive && glyphAlpha > 0.004;
                glyphMaterial.uniforms.time.value = time;
                glyphMaterial.uniforms.alpha.value = glyphAlpha;
                glyphMaterial.uniforms.motion.value = motionAmount;
                if (glyphMesh) glyphMesh.position.y = 0;
                if (fadingGlyph && glyphMesh) {
                    // Keep the ink of the two full blocks apart, including translations.
                    const separation = glyphTop - fadingGlyph.bottom + 0.6;
                    glyphMesh.position.y = -separation * (1 - handoffProgress);
                    fadingGlyph.mesh.position.y = separation * handoffProgress;
                    fadingGlyphMaterial.uniforms.time.value = time;
                    fadingGlyphMaterial.uniforms.alpha.value = fadingGlyph.alpha * (1 - handoffProgress);
                }
                const releaseIn = smooth(exitPhase / 0.22);
                const releaseOut = 1 - smooth((exitPhase - 0.58) / 0.42);
                // Hand over from particles to type at entry and leave room for the line to fade before release.
                const gatherOpacity = joinsPrevious ? 0 : (1 - solidIn) * 0.92;
                const releaseOpacity = (1 - solidOut) * releaseIn * releaseOut * (0.24 + dissolveAmount * 0.24);
                const particleOpacity = (!alive || settings.reducedMotion)
                    ? 0
                    : clamp(gatherOpacity + releaseOpacity, 0, 1);

                lyricPoints.visible = particleOpacity > 0.005;
                lyricParticleMat.uniforms.uTime.value = time;
                lyricParticleMat.uniforms.uCohesion.value = cohesion;
                lyricParticleMat.uniforms.uDisperse.value = disperse;
                lyricParticleMat.uniforms.uLineProgress.value = clamp((time - start) / Math.max(0.2, vocalEnd - start));
                lyricParticleMat.uniforms.uOpacity.value = particleOpacity;
                lyricParticleMat.uniforms.uGlow.value = glowAmount;
                lyricParticleMat.uniforms.uVocal.value = vocalSmooth;
                lyricParticleMat.uniforms.uKnotP.value = shot ? shot.knotP : 3;
                lyricParticleMat.uniforms.uKnotQ.value = shot ? shot.knotQ : 4;

                // 相位星盘细弧随演唱进度优雅张开
                const vocalProg = clamp((time - start) / Math.max(0.2, vocalEnd - start));
                frameArcLines.forEach((arcLine, idx) => {
                    const count = arcLine.geometry.attributes.position.count;
                    const drawCount = Math.max(2, Math.ceil(count * smooth(vocalProg)));
                    arcLine.geometry.setDrawRange(0, drawCount);
                    arcLine.material.opacity = glyphAlpha * (0.22 + vocalSmooth * 0.18) * clamp(glowAmount, 0.3, 1.6);
                    arcLine.rotation.z = (idx === 0 ? 1 : -1) * Math.sin(time * 0.22) * 0.04;
                    arcLine.visible = glyphStage.visible;
                });
            } else {
                clearFadingGlyph();
                glyphStage.visible = false;
                lyricPoints.visible = false;
                frameArcLines.forEach((arcLine) => { arcLine.visible = false; });
                lyricParticleMat.uniforms.uOpacity.value = 0;
            }

            // 4. 更新深空星尘、体积星云与结项引力丝束
            const showStarfield = settings.starfield !== false;
            fieldPoints.visible = showStarfield;
            skyDome.visible = showStarfield;
            const sky = skyMat.uniforms;
            sky.uTime.value = settings.reducedMotion ? 0 : time;
            sky.uJourney.value = clamp(time / Math.max(1, timeline.duration));
            sky.uComet.value = timeline.cometPass ? encounterAmount(timeline.cometPass, time) : 0;
            sky.uNebula.value = actState.nebulaAlpha * clamp(glowAmount, 0.3, 1.6);
            const holeStrength = showStarfield ? encounterAmount(timeline.blackHole, time) : 0;
            sky.uHole.value.x = holeStrength;
            if (holeStrength > 0.001) {
                // A distant encounter stays fixed in the sky as the route drifts past it.
                const distance = timeline.distanceAt(timeline.blackHole.peak, speedScale) + 1030;
                const anchor = timeline.spineAt(distance, motionAmount);
                const offset = 342 * clamp(viewportAspect / 1.55, 0.46, 1.15);
                const direction = sky.uHoleDir.value.set(anchor.x + offset - camX, anchor.y + 195 - camY, anchor.z - camZ);
                const range = direction.length();
                direction.multiplyScalar(1 / range);
                const right = sky.uHoleRight.value.set(-direction.z, 0, direction.x).normalize();
                sky.uHoleUp.value.crossVectors(right, direction);
                const size = mix(93, 105, smooth((viewportAspect - 0.85) / 0.7));
                sky.uHole.value.y = clamp(size / range, 0.048, 0.108) * clamp(0.62 + viewportAspect * 0.32, 0.72, 1);
            }
            const beltAmount = encounterAmount(timeline.asteroidBelt, time);
            const rockAmount = Math.max(actState.rocks, beltAmount * 1.05) * clamp(objectDensity, 0, 1.2);
            rockField.mesh.visible = rockAmount > 0.01;
            rockField.mat.uniforms.uAmount.value = rockAmount;
            rockField.mat.uniforms.uBelt.value = beltAmount;
            rockField.mat.uniforms.uTime.value = settings.reducedMotion ? 0 : time;
            rockField.mat.uniforms.uCamPos.value.copy(cameraInstance.position);
            beltDust.mesh.visible = beltAmount > 0.01;
            beltDust.mat.uniforms.uBelt.value = beltAmount * clamp(objectDensity, 0, 1.2);
            beltDust.mat.uniforms.uCamPos.value.copy(cameraInstance.position);
            filamentMesh.visible = showStarfield;
            streakLines.visible = showStarfield && !settings.reducedMotion;

            fieldMat.uniforms.uCamPos.value.copy(cameraInstance.position);
            fieldMat.uniforms.uTime.value = time;
            fieldMat.uniforms.uNebulaAlpha.value = actState.nebulaAlpha * clamp(glowAmount, 0.3, 1.6);
            fieldMat.uniforms.uAudioPulse.value = bassSmooth * 0.8 + vocalSmooth * 0.3;
            fieldMat.uniforms.uDensity.value = objectDensity;

            filamentMat.uniforms.uTravel.value = totalTravelDistance;
            filamentMat.uniforms.uTime.value = settings.reducedMotion ? 0 : time;
            filamentMat.uniforms.uMotion.value = motionAmount;
            filamentMat.uniforms.uKnotFlow.value = actState.knotFlow;
            filamentMat.uniforms.uAudioPulse.value = bassSmooth;
            filamentMat.uniforms.uGlow.value = glowAmount;
            filamentMat.uniforms.uPhaseA.value = (timeline.seedHash & 0xffff) / 0xffff * TAU;
            filamentMat.uniforms.uPhaseB.value = ((timeline.seedHash >>> 16) & 0xffff) / 0xffff * TAU;

            streakMat.uniforms.uCamPos.value.copy(cameraInstance.position);
            streakMat.uniforms.uStretch.value = settings.reducedMotion
                ? 0
                : clamp(actState.warp * 0.65 + bassSmooth * 0.38, 0.05, 1.25) * Math.min(1.2, motionAmount);
            streakMat.uniforms.uGlow.value = glowAmount;

            // 5. 更新深空引力波纹环 (Gravitational Wave Ripples)
            if (live && bassSmooth > 0.48 && bassSmooth - prevBass > 0.14) {
                const r = ripples[rippleCursor % RIPPLE_COUNT];
                rippleCursor += 1;
                r.age = 0;
                r.mesh.visible = true;
                const spawnSpine = timeline.spineAt(totalTravelDistance + 85, motionAmount);
                r.anchor.set(spawnSpine.x, spawnSpine.y, spawnSpine.z);
            }
            prevBass = bassSmooth;

            ripples.forEach((r) => {
                if (!r.mesh.visible) return;
                r.age += dt;
                const t = r.age / r.life;
                if (t >= 1) {
                    r.mesh.visible = false;
                    r.mat.opacity = 0;
                    return;
                }
                const expand = 6 + easeOutCubic(t) * 88;
                r.mesh.scale.set(expand, expand * 0.68, 1);
                r.mesh.position.copy(r.anchor);
                r.mesh.position.z -= easeOutCubic(t) * 45;
                r.mesh.rotation.z = time * 0.25;
                r.mat.opacity = (1 - t) * (1 - t) * 0.28 * clamp(glowAmount, 0.4, 1.6);
            });

            // 6. 更新 8 个深空粒子结项巨构槽位 (全 GPU 顶点驱动，CPU 仅算 8 个锚点矩阵)
            const showPlanets = settings.showPlanets !== false;
            const showRings = settings.showRings !== false;
            const showShips = settings.showShips !== false;
            const showStations = settings.showStations !== false;
            const cycle = timeline.ENCOUNTER_CYCLE;
            const emergence = 1820, departure = 180;
            const pass = timeline.ringPass;
            const encounterShift = pass
                ? (((pass.distance * clamp(speedScale, 0.25, 2.5) - pass.baseS) % cycle) + cycle) % cycle
                : 0;
            const audioPulse = clamp(bassSmooth * 1.1 + vocalSmooth * 0.35, 0, 1.2);
            let passRush = 0, bankSum = 0, bankWeight = 0;
            let aimWeight = 0, aimX = 0, aimY = 0;

            timeline.encounterSlots.forEach((slot, idx) => {
                const node = entityNodes[idx];
                const enabled = slot.type === 'planet' ? showPlanets
                    : slot.type === 'rings' ? showRings
                        : slot.type === 'ship' ? showShips
                            : showStations;
                const body = bodyNodes[idx];
                body.group.visible = false;
                if (!enabled) {
                    node.points.visible = false;
                    return;
                }

                // Keep the current occurrence until it fades astern, then look ahead to the next cycle.
                const placed = slot.baseS + encounterShift;
                const cycleIndex = Math.ceil((totalTravelDistance - departure - placed) / cycle);
                let sWorld = placed + cycleIndex * cycle;
                let place = slot;
                let handover = 1;
                for (const hero of timeline.heroPasses) {
                    const routeScale = clamp(speedScale, 0.25, 2.5);
                    const heroS = hero.distance * routeScale;
                    if (hero.slotId !== idx) {
                        if (sWorld > hero.clearFrom * routeScale && sWorld < hero.clearTo * routeScale) sWorld = -1e9;
                        continue;
                    }
                    const heroRel = heroS - totalTravelDistance;
                    if (heroRel > -departure && heroRel < emergence) {
                        // One body cannot be in two places. Its turn in the
                        // procession, if it comes first and clear of the pass,
                        // is finished before it is gathered again for the pass.
                        if (place === slot && sWorld < hero.clearFrom * routeScale && sWorld - totalTravelDistance > -departure) continue;
                        const before = placed + Math.floor((heroS - placed) / cycle) * cycle;
                        if (before < hero.clearFrom * routeScale && before + departure > heroS - emergence) {
                            handover = Math.min(handover, smooth((totalTravelDistance - before - departure) / 160));
                        }
                        sWorld = heroS;
                        place = hero;
                    } else if (place === slot && sWorld > heroS && sWorld < heroS + 2000) {
                        // ... and the one after waits until the pass is over.
                        if (heroRel >= emergence) sWorld = -1e9;
                        else handover = Math.min(handover, smooth((-departure - heroRel) / 160));
                    }
                }
                const relS = sWorld - totalTravelDistance; // >0 在镜头前方，<0 已掠过镜头后方

                if (relS < -departure || relS > emergence) {
                    node.points.visible = false;
                    return;
                }

                // 远近双端丝滑存在包络 (uPresence)：
                // 远端 1820m -> 920m 从 0% 极微弱星雾渐显，近端 -30m -> -180m 在身后彻底消隐
                const farPresence = smoother((emergence - relS) / (emergence - 920));
                const nearPresence = smooth((relS + departure) / 150);
                const presence = clamp(farPresence * nearPresence * handover, 0, 1);
                if (presence <= 0.002) {
                    node.points.visible = false;
                    return;
                }

                node.points.visible = true;
                const anchorSpine = timeline.spineAt(sWorld, motionAmount);
                // 远方未完全凝聚时，巨构位置略微向航道中轴聚拢，随凝聚自然舒展到两侧巡航位
                const birthSpread = 0.65 + 0.35 * (1.0 - smooth((relS - 460) / 1150));
                const wx = anchorSpine.x + anchorSpine.right.x * (place.side * place.radial * birthSpread) + anchorSpine.up.x * (place.elev * birthSpread);
                const wy = anchorSpine.y + anchorSpine.right.y * (place.side * place.radial * birthSpread) + anchorSpine.up.y * (place.elev * birthSpread);
                const wz = anchorSpine.z;
                node.points.position.set(wx, wy, wz);

                const rotY = time * slot.rotSpeed + idx * 1.1;
                node.points.rotation.set(place.tilt[0], rotY + place.tilt[1], place.tilt[2]);

                // 结项凝聚与近场擦肩解体包络：
                // 远方 (relS: 1680 -> 440) 从深空纵向星尘细丝缓缓坍缩凝结为精密流形；
                // 黄金视距 (relS: 440 -> 135) 保持 100% 凝聚展示；
                // 擦肩掠过 (relS: 135 -> -160) 受引力潮汐拉扯，沿切向涡流解体为漫天星尘。
                let cohesion = 1.0;
                let dissolveDir = -1.0;
                if (relS > 440) {
                    cohesion = 1.0 - smoother((relS - 440) / 1220);
                    dissolveDir = -1.0;
                } else if (slot.type === 'rings' || place.hold ? relS < -15 : relS < 135) {
                    // A ring system holds together until the camera is through its plane.
                    const passPhase = slot.type === 'rings' || place.hold ? clamp((-15 - relS) / 150) : clamp((135 - relS) / 260);
                    cohesion = 1.0 - easeInCubic(passPhase) * (0.48 + dissolveAmount * 0.52);
                    dissolveDir = 1.0;
                }

                // Form the solid and clear its dust together, including on the approach from the horizon.
                const formed = dissolveDir < 0 ? Math.min(cohesion, mix(0.42, 1, smooth((1020 - relS) / 420))) : cohesion;
                const u = node.mat.uniforms;
                u.uTime.value = time;
                u.uCohesion.value = cohesion;
                u.uSolid.value = formed;
                u.uPresence.value = presence;
                u.uDissolveDir.value = dissolveDir;
                const size = place.size || 1;
                u.uScale.value = slot.scale * size;
                u.uDensity.value = objectDensity;
                u.uAudioPulse.value = audioPulse;
                u.uGlow.value = glowAmount;

                // Neither is drawn while it would be fully transparent: the solid
                // before it starts to form, the points once it has (stations
                // keep theirs for the lamps).
                const lampless = slotTemplateMap[idx].code !== 0 || slot.type !== 'station';
                node.points.visible = !(lampless && formed >= 0.94);
                // The solid shares the points' place, attitude and envelope.
                // Far off a body is only its dust; the solid forms on the approach.
                body.group.visible = formed > 0.42;
                body.group.position.copy(node.points.position);
                body.group.rotation.copy(node.points.rotation);
                body.group.scale.setScalar(slot.scale * size * (dissolveDir < 0 ? mix(0.58, 1, smooth(cohesion)) : 1));

                if (hasMotion) {
                    // Save the change in heading for a close pass; distant bodies drift into view on their own.
                    const attention = smooth(presence / 0.35) * smooth((formed - 0.42) / 0.22);
                    const near = smooth((215 - relS) / 135) * smooth((relS + 150) / 130) * attention;
                    const alongside = smooth(1 - Math.abs(relS - 25) / 150);
                    const offX = wx - camX, offY = wy - camY;
                    const closeBy = alongside * clamp(70 / Math.max(20, Math.hypot(offX, offY))) * attention;
                    const crossTrack = offX * camSpine.right.x + offY * camSpine.right.y;
                    bankSum -= closeBy * crossTrack / Math.hypot(crossTrack, 16);
                    bankWeight += closeBy;
                    passRush = Math.max(passRush, closeBy);
                    const bearing = near / Math.hypot(offX, offY, Math.max(35, relS));
                    aimWeight += near;
                    aimX += offX * bearing;
                    aimY += offY * bearing;
                }

                bodyTurn.copy(body.group.quaternion).invert();
                const world = place !== slot ? (place.world || 0)
                    : slot.worlds ? slot.worlds[Math.max(0, cycleIndex) % slot.worlds.length] : 0;
                // Air only round worlds that have it, rings only round giants.
                const air = world === WORLD.desert ? 0.35 : world === WORLD.home ? 0.3
                    : world === WORLD.ice || world === WORLD.volcanic ? 1
                    : world === 0 || world === WORLD.home || world === WORLD.iceGiant ? 1 : 0;
                // Craft take their turns the same way the worlds do.
                const variants = slotTemplateMap[idx].spec.variants;
                const turns = slotTemplateMap[idx].spec.turns;
                const craft = place !== slot || !variants ? 0
                    : turns ? turns[clamp(cycleIndex + 1, 0, turns.length - 1)]
                        : Math.max(0, cycleIndex) % (variants.length + 1);
                for (const { mat, mesh, variant } of body.parts) {
                    const b = mat.uniforms;
                    mesh.visible = variant === craft;
                    if (!mesh.visible) continue;
                    b.uWorld.value = world;
                    b.uThin.value = world === WORLD.iceGiant ? 1 : 0;
                    const kind = b.uKind.value;
                    if (kind === 4) mesh.visible = air > 0;
                    else if (kind === 2) mesh.visible = world === 0 || world === WORLD.iceGiant;
                    if (!mesh.visible) continue;
                    b.uTime.value = time;
                    b.uCohesion.value = formed;
                    b.uPresence.value = kind === 4 ? presence * air : presence;
                    b.uAudioPulse.value = audioPulse;
                    b.uGlow.value = glowAmount;
                    b.uLightLocal.value.copy(worldLight).applyQuaternion(bodyTurn);
                    if (slot.type === 'station') {
                        // The planet that follows a station in the plan is its companion.
                        const companion = bodyNodes[idx + 1].group;
                        b.uBounceDir.value.copy(companion.position).sub(body.group.position);
                        const apart = b.uBounceDir.value.length();
                        b.uBounce.value = companion.visible && apart > 1 ? clamp(90 / apart) : 0;
                        if (apart > 1) b.uBounceDir.value.divideScalar(apart);
                    }
                }
            });

            const motionStrength = Math.min(1, motionAmount);
            // Blend separate bearings, so two passing bodies cannot cancel into an unstable target.
            const aimReach = (0.16 + 0.38 * (1 - lyricFocus)) * motionStrength;
            const aimDistance = 92 * aimReach / Math.max(1, aimWeight);
            lookX += aimX * aimDistance;
            lookY += aimY * aimDistance;
            const passBank = bankSum / Math.max(1, bankWeight);
            cameraInstance.lookAt(lookX, lookY, lookZ);
            cameraInstance.rotation.z += pose.roll * motionAmount + passBank * 0.11 * motionStrength
                + camSpine.curvature * 0.032 * motionAmount + Math.sin(time * 0.21) * 0.008 * breathAmount * motionAmount;

            const targetFov = clamp(
                actState.fov + (pose.fov + passRush * 5.0 + (cruiseSpeed - 1.0) * 3.5) * motionStrength
                    + bassSmooth * 2.4 * shakeAmount,
                38,
                68
            );
            if (audioState.seek || Math.abs(cameraInstance.fov - targetFov) > 0.02) {
                cameraInstance.fov = targetFov;
                cameraInstance.updateProjectionMatrix();
            }
            sceneDrawn = true;
        };

        // What each quality tier spends inside the world: how many of the
        // gathering points are drawn, and whether the bodies compute their
        // finest surface detail.
        const QUALITY_TIERS = { 'energy-saving': [0.5, 0, 0.4], standard: [0.8, 1, 0.75], ultimate: [1, 1, 1] };
        const setQuality = (tier) => {
            const [points, detail, rocks] = QUALITY_TIERS[tier] || QUALITY_TIERS.standard;
            rockField.geo.setDrawRange(0, Math.floor(ROCK_COUNT * rocks) * rockField.per);
            beltDust.geo.setDrawRange(0, Math.floor(BELT_GRAIN_COUNT * rocks));
            entityNodes.forEach((node) => node.geo.setDrawRange(0, Math.floor(POINTS_PER_ENTITY * points)));
            bodyNodes.forEach((body) => body.parts.forEach(({ mat }) => { mat.uniforms.uDetail.value = detail; }));
        };

        return {
            get distance() { return totalTravelDistance; },
            setQuality,
            get currentSpeed() { return cruiseSpeed; },
            reset,
            setPalette,
            prepare,
            update,
            resize(w, h, ratio) {
                const oldGlyphResolution = glyphResolution();
                viewportAspect = Math.max(0.2, Number(w) / Math.max(1, Number(h)));
                pixelRatio = ratio;
                viewportPixels = Math.max(1, Number(h) * ratio);
                if (glyphResolution() !== oldGlyphResolution) glyphCacheKey = '';
                fieldMat.uniforms.uPixelRatio.value = ratio;
                skyMat.uniforms.uViewport.value.set(Math.max(1, w * ratio), Math.max(1, h * ratio));
                filamentMat.uniforms.uViewport.value.set(Math.max(1, w * ratio), Math.max(1, h * ratio));
                lyricParticleMat.uniforms.uPixelRatio.value = ratio;
                entityNodes.forEach((node) => { node.mat.uniforms.uPixelRatio.value = ratio; });
                bodyNodes.forEach((body) => body.parts.forEach(({ mat }) => {
                    mat.uniforms.uViewport.value.set(Math.max(1, w * ratio), Math.max(1, h * ratio));
                }));
                rockField.mat.uniforms.uViewport.value.set(Math.max(1, w * ratio), Math.max(1, h * ratio));
                beltDust.mat.uniforms.uRatio.value = ratio;
            },
            destroy() {
                clearFadingGlyph();
                clearGlyphStage();
                scene.remove(root);
                [fieldGeo, skyGeo, filamentGeo, streakGeo, lyricGeo, rippleGeo, glyphWarmup.geometry, ...frameArcGeos].forEach((g) => g?.dispose?.());
                [fieldMat, skyMat, skyBakeMat, filamentMat, streakMat, lyricParticleMat, glyphMaterial, fadingGlyphMaterial,
                    ...frameArcMats].forEach((m) => m?.dispose?.());
                skyMasks.dispose();
                entityNodes.forEach((node) => {
                    node.geo?.dispose?.();
                    node.mat?.dispose?.();
                });
                bodyNodes.forEach((body) => body.parts.forEach(({ geo, mat }) => { geo.dispose(); mat.dispose(); }));
                rockField.geo.dispose(); rockField.mat.dispose();
                beltDust.geo.dispose(); beltDust.mat.dispose();
                surfacesReleased = true;
                surfaceMaps.forEach((entry) => entry.texture?.dispose());
                ripples.forEach((r) => r.mat?.dispose?.());
            }
        };
    };

    /* ============================================================================
     * 4. 模式实例宿主桥接 (MusicStage Mode Lifecycle Wrapper)
     * ============================================================================ */
    const create = (container, services) => {
        const mode = U.makeModeBase('tunnel', '隧图', container, services);
        const fallback = U.createElement('div', 'tunnel-fallback');
        const fallbackLine = U.createElement('div', 'tunnel-fallback-line');
        const fallbackSub = U.createElement('div', 'stage-translation tunnel-fallback-sub');
        fallback.append(fallbackLine, fallbackSub);
        mode.root.appendChild(fallback);

        const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let T = null;
        let scene = null;
        let camera = null;
        let renderer = null;
        let world = null;
        let optics = null;
        let initialized = false;
        let fallbackMode = false;
        let initializing = null;
        let latest = null;
        let source = null;
        let identity = '';
        let compiledDuration = -1;
        let contextRetries = 0;
        let contextTimer = 0;
        let lastContextLoss = 0;
        let width = 1;
        let height = 1;
        let lastTime = null;
        let paletteKey = '';
        // Something other than the clock changed since the last drawn frame.
        let dirty = true;
        let canvasSmoothing = null;
        let builtQuality = null;
        const cap = U.createFrameCap();
        const wantsCanvasSmoothing = () => !(global.MusicStageDioramaOptics?.active(mode.config, {}) ?? false);
        const applyQuality = () => {
            if (!world || builtQuality === mode.config.quality) return;
            builtQuality = mode.config.quality;
            world.setQuality?.(builtQuality);
        };

        const tuning = () => ({
            ...(mode.config.modes?.tunnel || {}),
            animationIntensity: mode.config.animationIntensity ?? 1,
            reducedMotion: Boolean(reduced?.matches),
            quality: mode.config.quality
        });

        const renderFallback = (frame) => {
            fallback.hidden = false;
            const line = frame?.activeLine;
            const key = line ? `${line.index}:${line.startTime}:${line.fullText}` : '';
            if (fallbackLine.dataset.key !== key) {
                fallbackLine.dataset.key = key;
                fallbackLine.replaceChildren();
                if (line) U.renderWords(fallbackLine, frame, 'tunnel-fallback-word');
                else fallbackLine.textContent = frame?.track?.title || '等待进入隧图深空';
                fallbackSub.textContent = R.resolveSupplementalText(line);
            }
            U.updateWords(Array.from(fallbackLine.children), frame?.wordStates || []);
        };

        const renderScale = U.createRenderScale();
        const resize = () => {
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            if (!renderer || !camera) return;
            const dpr = renderScale.ratio(mode.config.quality, width, height);
            renderer.setPixelRatio(dpr);
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            world?.resize?.(width, height, dpr);
        };

        const disposeGraphics = () => {
            world?.destroy?.();
            world = null;
            optics?.destroy();
            optics = null;
            if (renderer) {
                renderer.dispose?.();
                renderer.forceContextLoss?.();
                renderer.domElement?.remove?.();
                renderer = null;
            }
            camera = null;
            scene = null;
            initialized = false;
            dirty = true;
            builtQuality = null;
        };

        // A lost context (driver reset, sleep, remote desktop) is usually
        // temporary. Show the text fallback, then rebuild on a fresh canvas a
        // few times before settling for the fallback.
        const recoverContext = () => {
            const now = Date.now();
            if (now - lastContextLoss > 60000) contextRetries = 0;
            lastContextLoss = now;
            console.warn(`[MusicStage:Tunnel] WebGL context lost (retry ${contextRetries} of 3)`);
            fallbackMode = true;
            disposeGraphics();
            if (latest) renderFallback(latest);
            if (mode.destroyed || contextRetries >= 3) return;
            global.clearTimeout(contextTimer);
            contextTimer = global.setTimeout(() => {
                contextTimer = 0;
                if (mode.destroyed || initialized) return;
                fallbackMode = false;
                initializing = null;
                void initialize();
            }, 800 * 2 ** contextRetries++);
        };

        const update = (frame, force = false) => {
            if (mode.destroyed || mode.suspended || !frame) return;
            latest = frame;
            if (!initialized) {
                renderFallback(frame);
                if (!fallbackMode) void initialize();
                return;
            }
            const nextIdentity = frame.track?.path || frame.track?.title || 'tunnel-track';
            // The track length often arrives a moment after the track itself; the
            // journey has to be compiled for the whole song, not just its lyrics.
            const nextDuration = Math.round(finiteNumber(frame.duration, 0));
            const songChanged = source !== frame.lines || identity !== nextIdentity || nextDuration !== compiledDuration;
            // Paused with nothing changed: the last picture is still right, so
            // the GPU can rest. Playing: no more often than the tier's rate.
            const still = !frame.isPlaying && lastTime !== null
                && finiteNumber(frame.playbackTime, 0) === lastTime;
            if (!force && !dirty && !songChanged && (still || !cap.take(performance.now(), mode.config.quality))) return;
            dirty = false;
            applyQuality();

            if (songChanged) {
                source = frame.lines;
                identity = nextIdentity;
                compiledDuration = nextDuration;
                lastTime = null;
                world?.reset?.(frame.lines || [], identity, nextDuration);
            }

            const settings = tuning();
            const stagePal = services?.app?.stagePalette || {};
            const nextPalette = JSON.stringify(stagePal);
            if (nextPalette !== paletteKey) {
                paletteKey = nextPalette;
                world?.setPalette?.(stagePal);
            }

            const time = finiteNumber(frame.playbackTime, 0);
            const dt = lastTime === null ? 0 : time - lastTime;
            const seeking = lastTime === null || dt < -0.1 || dt > 0.5;
            const live = Boolean(frame.isPlaying) && dt > 0 && !settings.reducedMotion;
            const reactivity = clamp(settings.audioReactivity ?? 1, 0, 2);

            const audio = live
                ? {
                    power: clamp(frame.audio?.power) * reactivity,
                    bass: clamp(frame.audio?.bass) * reactivity,
                    vocal: clamp(frame.audio?.vocal) * reactivity,
                    treble: clamp(frame.audio?.treble) * reactivity
                }
                : { power: 0, bass: 0, vocal: 0, treble: 0 };

            world.update(time, frame, settings, {
                seek: seeking,
                playing: live,
                dt: seeking ? 0 : Math.max(0, Math.min(0.08, dt)),
                ...audio
            }, camera);

            fallback.hidden = true;
            if (frame.isPlaying && renderScale.tick(performance.now(), cap.aim(mode.config.quality))) resize();
            renderer.info.reset();
            // The same lens as the diorama: the sun, the lamps and the lyric glow through it.
            if (optics) {
                optics.render(renderer, scene, camera, settings.reducedMotion ? 0 : time, mode.config,
                    { glow: clamp(settings.glow ?? 1, 0, 2) * 0.6, threshold: 1.05, grain: 0.05, vignette: 0.3 });
            } else renderer.render(scene, camera);
            lastTime = time;
        };

        const initialize = () => {
            if (initializing) return initializing;
            initializing = Promise.resolve().then(async () => {
                T = global.THREE || await import('../../../vendor/three.module.js');
                if (mode.destroyed) return;

                scene = new T.Scene();
                const initialBg = new T.Color('#06090e');
                scene.background = initialBg;
                scene.fog = new T.FogExp2(initialBg, 0.00048);

                camera = new T.PerspectiveCamera(50, 1, 0.1, 3200);
                camera.position.set(0, 0, 0);

                canvasSmoothing = wantsCanvasSmoothing();
                renderer = new T.WebGLRenderer({
                    antialias: canvasSmoothing,
                    alpha: false,
                    powerPreference: 'high-performance'
                });
                renderer.outputColorSpace = T.SRGBColorSpace;
                renderer.toneMapping = T.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.08;
                // Checking every program's log reads back from the GPU process and stalls.
                renderer.debug.checkShaderErrors = false;
                renderer.domElement.className = 'tunnel-canvas';
                mode.root.insertBefore(renderer.domElement, fallback);

                const canvas = renderer.domElement;
                mode.scope.listen(canvas, 'webglcontextlost', (event) => {
                    event.preventDefault();
                    // Disposing the renderer loses its context on purpose.
                    if (renderer?.domElement !== canvas) return;
                    recoverContext();
                });

                renderer.info.autoReset = false;
                optics = global.MusicStageDioramaOptics?.create(T) || null;
                world = createTunnelWorld(T, scene, services?.app);
                world.prepare(renderer);
                applyQuality();
                resize();
                world.setPalette(services?.app?.stagePalette || {});
                await U.precompile(T, renderer, scene, camera, { canvas: canvasSmoothing, offscreen: !canvasSmoothing });
                if (mode.destroyed || !renderer) return;
                initialized = true;
                dirty = true;
                if (latest) update(latest, true);
            }).catch((error) => {
                disposeGraphics();
                fallbackMode = true;
                if (!mode.destroyed) {
                    console.warn('[MusicStage:Tunnel] WebGL 加载失败，启用降级：', error);
                    if (latest) renderFallback(latest);
                }
            });
            return initializing;
        };

        mode.updateFrame = (frame) => update(frame);
        mode.resize = () => { resize(); if (latest && initialized) update(latest, true); };
        const baseConfig = mode.updateConfig;
        mode.updateConfig = (config) => {
            baseConfig(config);
            // The canvas is antialiased only when the lens is off; that is fixed
            // when the context is made, so a change of tier rebuilds it.
            if (initialized && canvasSmoothing !== wantsCanvasSmoothing()) {
                disposeGraphics();
                initializing = null;
                lastTime = null;
                void initialize();
                return;
            }
            resize();
            if (latest && initialized) update(latest, true);
        };
        mode.updateTheme = () => { if (latest && initialized) update(latest, true); };
        const resume = mode.resume;
        mode.resume = () => { resume(); lastTime = null; cap.reset(); if (latest) update(latest, true); };
        mode.getDebugSnapshot = () => ({
            initialized,
            fallbackMode,
            pixelRatio: renderer?.getPixelRatio(), renderScale: renderScale.factor,
            drawCalls: renderer?.info.render.calls,
            triangles: renderer?.info.render.triangles,
            programs: renderer?.info.programs?.length,
            canvasSmoothing,
            distance: world?.distance || 0,
            currentSpeed: world?.currentSpeed || 0,
            cameraPos: camera?.position?.toArray() || null,
            activeLine: latest?.activeLine?.fullText || null
        });
        mode.scope.add(() => { global.clearTimeout(contextTimer); disposeGraphics(); latest = source = null; });

        resize();
        void initialize();
        return mode;
    };

    global.MusicStageTunnelManager = Object.freeze({ create, compileTimeline: compileTunnelTimeline });
})(window);
