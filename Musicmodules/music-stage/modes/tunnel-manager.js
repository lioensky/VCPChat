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

    /* ============================================================================
     * 1. 深空分镜导演 (Deep-Space Cinematography & Shot Director)
     *    - 自动识别乐段 (Drift / Verse / Pre / Chorus / Interlude / Horizon)
     *    - 确定性时间-弧长积分，保证 Seek / 暂停 / 重放落在完全一致的分镜与空间坐标
     *    - 为每句歌词分配三维空间遭遇锚点 (Spatial Encounter) 与机位运镜 (Shot Rig)
     * ============================================================================ */
    const ACT_PRESETS = Object.freeze({
        Drift:     { speed: 15.0, fov: 46, knotFlow: 0.32, nebulaAlpha: 0.48, warp: 0.08, lateralAmp: 0.55, rollAmp: 0.018 },
        Verse:     { speed: 22.0, fov: 50, knotFlow: 0.55, nebulaAlpha: 0.65, warp: 0.22, lateralAmp: 0.85, rollAmp: 0.028 },
        Pre:       { speed: 29.0, fov: 53, knotFlow: 0.78, nebulaAlpha: 0.78, warp: 0.45, lateralAmp: 1.05, rollAmp: 0.036 },
        Chorus:    { speed: 38.0, fov: 60, knotFlow: 1.00, nebulaAlpha: 0.95, warp: 0.88, lateralAmp: 1.30, rollAmp: 0.048 },
        Interlude: { speed: 18.0, fov: 44, knotFlow: 0.68, nebulaAlpha: 0.72, warp: 0.16, lateralAmp: 1.15, rollAmp: 0.042 },
        Horizon:   { speed: 11.0, fov: 48, knotFlow: 0.40, nebulaAlpha: 0.55, warp: 0.05, lateralAmp: 0.45, rollAmp: 0.015 }
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

    const vocalEndOf = (line) => Math.max(
        finiteNumber(line?.startTime, 0),
        finiteNumber(line?.vocalEndTime, finiteNumber(line?.endTime, finiteNumber(line?.startTime, 0) + 3.2))
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

        const sampleState = (time) => {
            const t = clamp(time, 0, duration);
            const idx = Math.max(0, upperBound(acts, t, 'start') - 1);
            const act = acts[idx];
            const prev = acts[Math.max(0, idx - 1)];
            const span = Math.max(0.4, Math.min(2.6, (act.end - act.start) * 0.42));
            const blend = idx === 0 ? 1 : smooth((t - act.start) / span);
            const out = { act: act.kind, actIndex: idx, blend };
            for (const k of Object.keys(act.params)) {
                out[k] = mix(prev.params[k], act.params[k], blend);
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
            const baseDist = mix(distances[idx], distances[idx + 1], clamp((t - t0) / span));
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
            return {
                index: idx,
                startTime: line.startTime,
                endTime: line.endTime,
                vocalEnd: vocalEndOf(line),
                actKind,
                rig,
                lateralX: sign * (2.2 + (idx % 3) * 1.15) + (rand() - 0.5) * 1.2,
                verticalY: ((idx % 3) - 1) * 1.05 + (rand() - 0.5) * 0.8,
                rollBias: sign * (0.022 + (idx % 2) * 0.014) + rig.roll * 0.45,
                pitchBias: ((idx % 2 === 0 ? 1 : -1) * 0.018),
                yawBias: -sign * 0.038,
                knotP,
                knotQ
            };
        });

        // 編排深空巨构与结项流形遭遇序列 (Celestial & Knotted Manifold Encounters)
        // 类型涵盖：
        //   - 'station' -> 高维环面结流形 / 戴森星门遗迹 (Torus Knot (p,q) Manifold)
        //   - 'rings'   -> 洛希吸积盘与螺旋星环 (Roche Accretion Vortex)
        //   - 'planet'  -> 幽暗晨昏线气态巨行星與极光磁层 (Abyssal Terminator Planet)
        //   - 'ship'    -> 远航张拉星帆孤舟群与离子弦尾迹 (Nomad Solar-Sail Monolith)
        const ENCOUNTER_CYCLE = 2400;
        const encounterSlots = [
            { slotId: 0, type: 'station', baseS: 560,  side: -1, radial: 38, elev: 10,  scale: 1.15, rotSpeed: 0.11, tilt: [0.42, 0.18, -0.28], p: 3, q: 5 },
            { slotId: 1, type: 'planet',  baseS: 860,  side:  1, radial: 56, elev: 18,  scale: 1.25, rotSpeed: 0.05, tilt: [0.22, -0.12, 0.16], p: 2, q: 3 },
            { slotId: 2, type: 'rings',   baseS: 1160, side: -1, radial: 50, elev: -12, scale: 1.32, rotSpeed: 0.09, tilt: [0.68, 0.24, 0.34], p: 2, q: 5 },
            { slotId: 3, type: 'ship',    baseS: 1460, side:  1, radial: 30, elev: -9,  scale: 1.10, rotSpeed: 0.04, tilt: [-0.08, 0.14, -0.12], p: 3, q: 4 },
            { slotId: 4, type: 'station', baseS: 1760, side:  1, radial: 42, elev: 14,  scale: 1.28, rotSpeed: -0.10, tilt: [-0.52, 0.31, 0.22], p: 4, q: 7 },
            { slotId: 5, type: 'planet',  baseS: 2060, side: -1, radial: 60, elev: -16, scale: 1.18, rotSpeed: 0.06, tilt: [0.31, 0.15, -0.24], p: 3, q: 5 },
            { slotId: 6, type: 'rings',   baseS: 2360, side:  1, radial: 46, elev: 12,  scale: 1.22, rotSpeed: -0.08, tilt: [-0.62, -0.20, 0.29], p: 5, q: 8 },
            { slotId: 7, type: 'ship',    baseS: 2660, side: -1, radial: 32, elev: 8,   scale: 1.05, rotSpeed: 0.05, tilt: [0.06, -0.18, 0.10], p: 2, q: 3 }
        ];

        return {
            seedHash,
            duration,
            acts,
            lines,
            lineShots,
            encounterSlots,
            ENCOUNTER_CYCLE,
            sampleState,
            distanceAt,
            spineAt
        };
    };

    /* ============================================================================
     * 2. 粒子结项流形与深空巨构点云生成器 (Procedural Knotted Manifolds)
     *    每个模板返回 { pos, normal, meta }，交由 GPU Shader 执行凝聚、涡流解算与着色
     *    meta.x: 局部相位 u ∈ [0,1]
     *    meta.y: 子结构材质通道 shade ∈ {0, 1, 2, 3}
     *    meta.z: 基础粒子半径缩放
     *    meta.w: 个人随机种子 seed ∈ [0,1]
     * ============================================================================ */
    const createManifoldTemplates = (pointsPerSlot) => {
        // A. 高维环面结流形 / 戴森星门遗迹 (Torus Knot (p,q) Manifold + Harmonic Filaments)
        const buildTorusKnotManifold = (count, p, q, radius, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const normal = new Float32Array(count * 3);
            const meta = new Float32Array(count * 4);
            const strands = 3;

            for (let i = 0; i < count; i += 1) {
                const u = rand();
                const t = (i / count) * TAU * p + (rand() - 0.5) * 0.04;
                const pqPhase = (q / p) * t;
                const tubeR = radius * (0.36 + 0.12 * Math.cos(pqPhase));
                const coreR = radius * (0.72 + 0.28 * Math.cos(pqPhase));

                // 环面结主曲线中心与切向基
                const cx = coreR * Math.cos(t);
                const cy = coreR * Math.sin(t);
                const cz = tubeR * Math.sin(pqPhase);

                const idx3 = i * 3;
                const idx4 = i * 4;

                if (u < 0.62) {
                    // 1. 结项主谐波丝束 (Harmonic Ribbon Strands)
                    const strandIdx = i % strands;
                    const twist = t * 2.5 + (strandIdx / strands) * TAU;
                    const minorR = (1.2 + rand() * 2.4) * (0.65 + 0.35 * Math.sin(t * 3.0));
                    const nx = Math.cos(twist) * Math.cos(t) - Math.sin(twist) * Math.sin(t) * 0.5;
                    const ny = Math.cos(twist) * Math.sin(t) + Math.sin(twist) * Math.cos(t) * 0.5;
                    const nz = Math.sin(twist);
                    pos[idx3] = cx + nx * minorR;
                    pos[idx3 + 1] = cy + ny * minorR;
                    pos[idx3 + 2] = cz + nz * minorR;
                    normal[idx3] = nx;
                    normal[idx3 + 1] = ny;
                    normal[idx3 + 2] = nz;
                    meta[idx4] = (t / (TAU * p)) % 1;
                    meta[idx4 + 1] = strandIdx === 0 ? 1 : 0; // 0=主骨白弦, 1=松石谐波弦
                    meta[idx4 + 2] = 1.15 + rand() * 0.85;
                    meta[idx4 + 3] = rand();
                } else if (u < 0.86) {
                    // 2. 相位引力包络环与张拉弦 (Phase Containment Halo)
                    const ringAngle = rand() * TAU;
                    const ringR = radius * (1.02 + (rand() - 0.5) * 0.08);
                    const planeTilt = (i % 2 === 0 ? 0.38 : -0.38);
                    const rx = Math.cos(ringAngle) * ringR;
                    const ry = Math.sin(ringAngle) * ringR * Math.cos(planeTilt);
                    const rz = Math.sin(ringAngle) * ringR * Math.sin(planeTilt);
                    pos[idx3] = rx;
                    pos[idx3 + 1] = ry;
                    pos[idx3 + 2] = rz;
                    const inv = 1 / Math.max(0.001, Math.hypot(rx, ry, rz));
                    normal[idx3] = rx * inv;
                    normal[idx3 + 1] = ry * inv;
                    normal[idx3 + 2] = rz * inv;
                    meta[idx4] = ringAngle / TAU;
                    meta[idx4 + 1] = 2; // 2=琥珀星门刻度环
                    meta[idx4 + 2] = 1.3 + rand() * 0.7;
                    meta[idx4 + 3] = rand();
                } else {
                    // 3. 奇点核心与轴向射流 (Singularity Core & Axial Jet)
                    const jet = rand() < 0.55;
                    if (jet) {
                        const side = rand() < 0.5 ? -1 : 1;
                        const zDist = side * Math.pow(rand(), 1.4) * radius * 1.45;
                        const spread = (0.4 + Math.abs(zDist) * 0.06) * rand();
                        const a = rand() * TAU;
                        pos[idx3] = Math.cos(a) * spread;
                        pos[idx3 + 1] = Math.sin(a) * spread;
                        pos[idx3 + 2] = zDist;
                        normal[idx3] = Math.cos(a);
                        normal[idx3 + 1] = Math.sin(a);
                        normal[idx3 + 2] = side * 0.4;
                    } else {
                        const r = Math.pow(rand(), 1.8) * radius * 0.22;
                        const theta = rand() * TAU;
                        const phi = Math.acos(2 * rand() - 1);
                        pos[idx3] = r * Math.sin(phi) * Math.cos(theta);
                        pos[idx3 + 1] = r * Math.sin(phi) * Math.sin(theta);
                        pos[idx3 + 2] = r * Math.cos(phi);
                        normal[idx3] = Math.sin(phi) * Math.cos(theta);
                        normal[idx3 + 1] = Math.sin(phi) * Math.sin(theta);
                        normal[idx3 + 2] = Math.cos(phi);
                    }
                    meta[idx4] = rand();
                    meta[idx4 + 1] = 3; // 3=核心辉光
                    meta[idx4 + 2] = 1.6 + rand() * 1.1;
                    meta[idx4 + 3] = rand();
                }
            }
            return { pos, normal, meta };
        };

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
        const buildNomadFleet = (count, scale, seedStr) => {
            const rand = seededRandom(seedStr);
            const pos = new Float32Array(count * 3);
            const normal = new Float32Array(count * 3);
            const meta = new Float32Array(count * 4);

            for (let i = 0; i < count; i += 1) {
                const idx3 = i * 3;
                const idx4 = i * 4;
                const u = rand();

                if (u < 0.48) {
                    // 双曲面张拉光帆翼 (Hyperbolic Paraboloid Solar Sails, 3 片对称星帆)
                    const wing = i % 3;
                    const wingAngle = (wing / 3) * TAU + Math.PI * 0.5;
                    const s = Math.pow(rand(), 0.75); // 展向 [0,1]
                    const chord = (rand() - 0.5) * 2.0 * (1 - s * 0.72); // 弦向收尖
                    const spanLen = s * 28.0 * scale;
                    const sweepZ = -s * s * 16.0 * scale + chord * 7.5 * scale;
                    const camber = Math.sin(s * Math.PI) * 3.2 * scale;

                    const localX = Math.cos(wingAngle) * (2.2 * scale + spanLen) - Math.sin(wingAngle) * camber;
                    const localY = Math.sin(wingAngle) * (2.2 * scale + spanLen) + Math.cos(wingAngle) * camber;
                    const localZ = sweepZ;

                    // 旋转使星帆孤舟呈优雅斜切巡航角
                    pos[idx3] = localX * 0.85 + localZ * 0.48;
                    pos[idx3 + 1] = localY * 0.92;
                    pos[idx3 + 2] = -localX * 0.48 + localZ * 0.85;

                    normal[idx3] = Math.cos(wingAngle);
                    normal[idx3 + 1] = Math.sin(wingAngle);
                    normal[idx3 + 2] = 0.35;

                    meta[idx4] = s;
                    meta[idx4 + 1] = s > 0.78 ? 1 : 0; // 翼尖松石导光，翼面骨白微光
                    meta[idx4 + 2] = 1.1 + (1 - s) * 0.65;
                    meta[idx4 + 3] = rand();
                } else if (u < 0.68) {
                    // 中轴棱镜龙骨与引力环 (Prism Spine & Ring Core)
                    const zSpine = (rand() - 0.5) * 34.0 * scale;
                    const rSpine = (1 - Math.abs(zSpine) / (19.0 * scale)) * 2.2 * scale;
                    const a = rand() * TAU;
                    const lx = Math.cos(a) * Math.max(0.3, rSpine);
                    const ly = Math.sin(a) * Math.max(0.3, rSpine);
                    const lz = zSpine;
                    pos[idx3] = lx * 0.85 + lz * 0.48;
                    pos[idx3 + 1] = ly;
                    pos[idx3 + 2] = -lx * 0.48 + lz * 0.85;
                    normal[idx3] = 0;
                    normal[idx3 + 1] = 1;
                    normal[idx3 + 2] = 0;
                    meta[idx4] = (zSpine / (34.0 * scale)) + 0.5;
                    meta[idx4 + 1] = 2; // 琥珀核心龙骨
                    meta[idx4 + 2] = 1.5 + rand() * 0.7;
                    meta[idx4 + 3] = rand();
                } else {
                    // 螺旋双股离子尾迹弦 (Helical Ion Wake Plume)
                    const wakeT = Math.pow(rand(), 1.25);
                    const wakeLen = (14.0 + wakeT * 68.0) * scale;
                    const strand = i % 2 === 0 ? 1 : -1;
                    const helixAngle = wakeT * 14.0 + (strand > 0 ? 0 : Math.PI);
                    const helixR = (0.8 + wakeT * 4.8) * scale;
                    const lx = Math.cos(helixAngle) * helixR;
                    const ly = Math.sin(helixAngle) * helixR;
                    const lz = wakeLen;
                    pos[idx3] = lx * 0.85 + lz * 0.48;
                    pos[idx3 + 1] = ly;
                    pos[idx3 + 2] = -lx * 0.48 + lz * 0.85;
                    normal[idx3] = 0;
                    normal[idx3 + 1] = 0;
                    normal[idx3 + 2] = 1;
                    meta[idx4] = wakeT;
                    meta[idx4 + 1] = 3; // 离子尾焰渐隐
                    meta[idx4 + 2] = (1 - wakeT * 0.65) * 1.9;
                    meta[idx4 + 3] = rand();
                }
            }
            return { pos, normal, meta };
        };

        return {
            stationA: buildTorusKnotManifold(pointsPerSlot, 3, 5, 25, 'manifold-knot-3-5'),
            stationB: buildTorusKnotManifold(pointsPerSlot, 4, 7, 26, 'manifold-knot-4-7'),
            ringsA:   buildRocheRings(pointsPerSlot, 22, 48, 'manifold-roche-a'),
            ringsB:   buildRocheRings(pointsPerSlot, 24, 52, 'manifold-roche-b'),
            planetA:  buildAbyssalPlanet(pointsPerSlot, 26, 'manifold-planet-a'),
            planetB:  buildAbyssalPlanet(pointsPerSlot, 24, 'manifold-planet-b'),
            shipA:    buildNomadFleet(pointsPerSlot, 1.0, 'manifold-nomad-a'),
            shipB:    buildNomadFleet(pointsPerSlot, 0.92, 'manifold-nomad-b')
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
                        vec3 col = mix(uStarColor, mix(uNebulaA, uNebulaB, vSeed), 0.28);
                        gl_FragColor = vec4(col * (core * 1.55 + halo + airy), (core + halo + airy) * vAlpha);
                    }
                }
            `
        });
        const fieldPoints = new T.Points(fieldGeo, fieldMat);
        fieldPoints.frustumCulled = false;
        root.add(fieldPoints);

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

        const makeEntityMaterial = (typeCode) => new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            uniforms: {
                uTime: { value: 0 },
                uPixelRatio: { value: 1 },
                uCohesion: { value: 1 },
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
                uniform float uTime, uPixelRatio, uCohesion, uPresence, uDissolveDir, uScale, uDensity, uAudioPulse, uGlow, uType;
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
                        // Torus Knot 谐波呼吸
                        float harmonic = sin(uTime * 1.4 + phase * 18.8495 + seed * 6.28);
                        localPos += nrm * harmonic * (0.45 + uAudioPulse * 0.55);
                    } else if (uType > 1.5 && uType < 2.5) {
                        // Roche Rings 开普勒差速旋转微扰
                        float kepler = uTime * (0.35 + (1.0 - phase) * 0.45);
                        float cs = cos(kepler * 0.15), sn = sin(kepler * 0.15);
                        localPos.xz = mat2(cs, -sn, sn, cs) * localPos.xz;
                    } else if (uType > 2.5) {
                        // Nomad Ship 离子尾迹推进波动
                        if (shade > 2.5) {
                            float wave = sin(uTime * 3.8 - phase * 14.0 + seed * 6.28);
                            localPos.xy += vec2(cos(seed * 6.28), sin(seed * 6.28)) * wave * phase * 1.4;
                        }
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
                    vec3 lightDir = normalize(vec3(-0.62, 0.58, 0.52));

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

        const slotTemplateMap = [
            { tmpl: manifoldTemplates.stationA, code: 0 },
            { tmpl: manifoldTemplates.planetA,  code: 1 },
            { tmpl: manifoldTemplates.ringsA,   code: 2 },
            { tmpl: manifoldTemplates.shipA,    code: 3 },
            { tmpl: manifoldTemplates.stationB, code: 0 },
            { tmpl: manifoldTemplates.planetB,  code: 1 },
            { tmpl: manifoldTemplates.ringsB,   code: 2 },
            { tmpl: manifoldTemplates.shipB,    code: 3 }
        ];
        const entityNodes = slotTemplateMap.map((item) => buildEntityMesh(item.tmpl, item.code));

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
                    gl_PointSize = clamp((1.55 + localCohesion * 0.85 + vocalWave * 1.15) * uPixelRatio * 320.0 / depth, 1.0, 26.0);

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

        const clearGlyphStage = () => {
            while (glyphStage.children.length) {
                const mesh = glyphStage.children[0];
                glyphStage.remove(mesh);
                mesh.material?.uniforms?.map?.value?.dispose?.();
                mesh.material?.dispose?.();
                mesh.geometry?.dispose?.();
            }
            glyphCacheKey = '';
        };

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
            const cacheKey = JSON.stringify([
                currentLineKey,
                subText,
                colors.inkHex,
                colors.accentHex,
                colors.secondaryHex,
                scale.toFixed(2)
            ]);

            if (cacheKey === glyphCacheKey) return;
            clearGlyphStage();
            glyphCacheKey = cacheKey;

            const mainFont = '800 80px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
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
            let rowW = 0;
            glyphs.forEach((g) => {
                const adv = Math.max(16, measureCtx.measureText(g.text || ' ').width);
                if (rowW + adv > 1360 && rows[rows.length - 1].length) {
                    rows.push([]);
                    rowW = 0;
                }
                rows[rows.length - 1].push({ ...g, advance: adv });
                rowW += adv;
            });

            const maxRowWidth = Math.max(1, ...rows.map((r) => r.reduce((s, g) => s + g.advance, 0)));
            const unit = Math.min(0.024 * scale, 38 / maxRowWidth, 11.5 / (rows.length * 108 + 76));
            const rawSamples = [];

            const addGlyphMesh = (label, px, py, advance, start, end, isSub = false, normOrder = 0.5) => {
                if (!String(label || '').trim()) return null;
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(32, Math.ceil(advance + 44));
                canvas.height = isSub ? 92 : 148;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) return null;

                ctx.font = isSub ? '500 32px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif' : mainFont;
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#ffffff';
                ctx.shadowColor = '#ffffff';
                ctx.shadowBlur = isSub ? 3 : 8;
                ctx.fillText(label, 22, canvas.height * 0.5);

                const map = new T.CanvasTexture(canvas);
                map.generateMipmaps = false;
                map.minFilter = T.LinearFilter;
                map.magFilter = T.LinearFilter;

                const wWorld = canvas.width * unit;
                const hWorld = canvas.height * unit;
                const centerX = px + (advance * unit) * 0.5;
                const centerY = py;

                const mat = new T.ShaderMaterial({
                    transparent: true,
                    depthTest: false,
                    depthWrite: false,
                    uniforms: {
                        map: { value: map },
                        time: { value: 0 },
                        begin: { value: start },
                        finish: { value: end },
                        alpha: { value: 1 },
                        motion: { value: 1 },
                        glow: { value: 1 },
                        wait: { value: isSub ? colors.secondary.clone().multiplyScalar(0.78) : colors.ink.clone().multiplyScalar(0.52) },
                        sung: { value: isSub ? colors.secondary.clone() : colors.accent.clone() },
                        ink: { value: colors.ink.clone() }
                    },
                    vertexShader: `
                        uniform float time, begin, finish, motion;
                        varying vec2 vUv;
                        varying float vActive;
                        void main() {
                            vUv = uv;
                            float p = clamp((time - begin) / max(0.001, finish - begin), 0.0, 1.0);
                            float pulse = sin(p * 3.14159265) * motion;
                            vActive = pulse;
                            vec3 pos = position;
                            pos.xy *= 1.0 + pulse * 0.06;
                            pos.y += pulse * 0.24;
                            pos.z += pulse * 0.35;
                            gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
                        }
                    `,
                    fragmentShader: `
                        uniform sampler2D map;
                        uniform float time, begin, finish, alpha, glow;
                        uniform vec3 wait, sung, ink;
                        varying vec2 vUv;
                        varying float vActive;
                        void main() {
                            float cov = texture2D(map, vUv).a;
                            if (cov < 0.01) discard;
                            float p = clamp((time - begin) / max(0.001, finish - begin), 0.0, 1.0);
                            float wipe = 1.0 - smoothstep(p - 0.04, p + 0.04, vUv.x);
                            if (p <= 0.0) wipe = 0.0;
                            if (p >= 1.0) wipe = 1.0;
                            // 擦亮前沿高光游标 (Leading Edge Spark)
                            float edgeGlow = exp(-pow((vUv.x - p) * 14.0, 2.0)) * step(0.01, p) * step(p, 0.99);
                            float core = smoothstep(0.16, 0.74, cov);
                            float a = clamp(core + cov * (1.0 - core) * glow * 0.68, 0.0, 1.0) * alpha;
                            vec3 baseCol = mix(wait, mix(sung, ink, 0.22), wipe);
                            vec3 finalCol = baseCol + ink * edgeGlow * 0.65 + sung * vActive * 0.25;
                            gl_FragColor = vec4(finalCol, a);
                            #include <tonemapping_fragment>
                            #include <colorspace_fragment>
                        }
                    `
                });

                const mesh = new T.Mesh(new T.PlaneGeometry(wWorld, hWorld), mat);
                mesh.position.set(centerX, centerY, 0);
                mesh.renderOrder = 30;
                glyphStage.add(mesh);

                // 直接在创建字形时一次性采样 Alpha 通道供结项粒子使用（兼容无 getImageData 的测试桩）
                const imgData = ctx.getImageData?.(0, 0, canvas.width, canvas.height)?.data;
                const pColor = isSub ? colors.secondary : colors.accent;
                if (imgData && imgData.length >= canvas.width * canvas.height * 4) {
                    const stride = isSub ? 6 : 5;
                    for (let y = 0; y < canvas.height; y += stride) {
                        for (let x = 0; x < canvas.width; x += stride) {
                            if (imgData[(y * canvas.width + x) * 4 + 3] < 130) continue;
                            rawSamples.push({
                                x: centerX + ((x + 0.5) / canvas.width - 0.5) * wWorld,
                                y: centerY + (0.5 - (y + 0.5) / canvas.height) * hWorld,
                                color: pColor,
                                order: normOrder
                            });
                        }
                    }
                }
                return mesh;
            };

            let totalGlyphCount = Math.max(1, rows.reduce((s, r) => s + r.length, 0));
            let glyphCounter = 0;
            rows.forEach((row, ri) => {
                let x = -row.reduce((s, g) => s + g.advance, 0) * unit * 0.5;
                const y = ((rows.length - 1) * 0.5 - ri) * 108 * unit + (subText ? 0.65 : 0.15);
                row.forEach((g) => {
                    const order = glyphCounter / totalGlyphCount;
                    glyphCounter += 1;
                    addGlyphMesh(g.text, x, y, g.advance, g.startTime, g.endTime, false, order);
                    x += g.advance * unit;
                });
            });

            if (subText) {
                measureCtx.font = '500 32px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
                const subLines = String(subText).split('\n').filter(Boolean).slice(0, 2);
                subLines.forEach((subRowText, sri) => {
                    const labels = splitGraphemes(subRowText);
                    const advances = labels.map((ch) => Math.max(10, measureCtx.measureText(ch).width));
                    const totalW = advances.reduce((a, b) => a + b, 0);
                    const fit = Math.min(1, 1360 / Math.max(1, totalW));
                    let x = -totalW * unit * fit * 0.5;
                    const y = -(rows.length * 54 + 44 + sri * 42) * unit;
                    labels.forEach((ch, idx) => {
                        const mesh = addGlyphMesh(ch, x, y, advances[idx], -1, -0.5, true, idx / Math.max(1, labels.length));
                        if (mesh) {
                            mesh.scale.x = fit;
                            mesh.position.x = x + advances[idx] * unit * fit * 0.5;
                        }
                        x += advances[idx] * unit * fit;
                    });
                });
            }

            // 若运行在无像素缓冲环境（如 JSDOM 冒烟测试），生成程序化李萨如字形骨架点位兜底
            if (!rawSamples.length && glyphStage.children.length) {
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
            const abyssBg = colors.background.clone().multiplyScalar(0.38);
            if (scene?.background?.copy) scene.background.copy(abyssBg);
            else if (scene) scene.background = abyssBg;
            if (scene?.fog?.color?.copy) scene.fog.color.copy(abyssBg);

            fieldMat.uniforms.uStarColor.value.copy(colors.ink).lerp(colors.muted, 0.35);
            fieldMat.uniforms.uNebulaA.value.copy(colors.secondary);
            fieldMat.uniforms.uNebulaB.value.copy(colors.accent);

            filamentMat.uniforms.uColorA.value.copy(colors.secondary);
            filamentMat.uniforms.uColorB.value.copy(colors.accent);
            filamentMat.uniforms.uColorC.value.copy(colors.muted);

            streakMat.uniforms.uColorA.value.copy(colors.ink);
            streakMat.uniforms.uColorB.value.copy(colors.secondary);

            entityNodes.forEach((node) => {
                node.mat.uniforms.uColorPrimary.value.copy(colors.secondary);
                node.mat.uniforms.uColorAccent.value.copy(colors.accent);
                node.mat.uniforms.uColorInk.value.copy(colors.ink);
                node.mat.uniforms.uColorEmber.value.copy(colors.ember);
            });

            lyricParticleMat.uniforms.uTint.value.copy(colors.accent);
            frameArcMats.forEach((m, idx) => m.color.copy(idx === 0 ? colors.secondary : colors.accent));
            ripples.forEach((r, idx) => r.mat.color.copy(idx % 2 === 0 ? colors.secondary : colors.accent));
            glyphCacheKey = ''; // 触发当前句按新主题重绘
        };

        const reset = (lines = [], identity = 'tunnel-track') => {
            clearGlyphStage();
            currentLineKey = '';
            activePointCount = 0;
            lyricGeo.setDrawRange(0, 0);
            timeline = compileTunnelTimeline(lines, identity);
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
            const live = audioState.playing;
            const settingVal = (key, fb) => {
                const v = Number(settings?.[key]);
                return Number.isFinite(v) ? v : fb;
            };

            const speedScale = clamp(settingVal('cameraSpeed', 1), 0.35, 2.2);
            const motionAmount = settings.reducedMotion
                ? 0
                : clamp(settingVal('motionAmount', 1), 0, 2) * clamp(settingVal('animationIntensity', 1), 0, 2);
            const breathAmount = clamp(settingVal('cameraBreath', 0.5), 0, 2);
            const shakeAmount = settings.reducedMotion ? 0 : clamp(settingVal('cameraShake', 1), 0, 2);
            const objectDensity = clamp(settingVal('objectDensity', 1), 0.25, 2);
            const glowAmount = clamp(settingVal('glow', 1), 0, 2);
            const dissolveAmount = clamp(settingVal('dissolveAmount', 0.72), 0, 1);
            const holdRatio = clamp(settingVal('textHoldRatio', 0.32), 0, 0.8);
            const pauseDur = clamp(settingVal('pauseDuration', 0.9), 0, 3);

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
            const lineProgress = activeLine ? clamp((time - lineStart) / Math.max(0.4, lineEnd - lineStart)) : 0;

            // 句内镜头节奏：入场微推进 -> 阅读平稳托举 -> 句尾失重滑翔
            const readingHold = activeLine
                ? smooth(lineProgress / 0.22) * (1 - smooth((lineProgress - 0.78) / 0.22))
                : 0;
            const speedMod = activeLine ? (1.0 - readingHold * 0.26) : 0.92;
            cruiseSpeed = (actState.speed / 22.0) * speedScale * speedMod * (settings.reducedMotion ? 0 : 1);
            totalTravelDistance = timeline.distanceAt(time, speedScale);

            const camSpine = timeline.spineAt(totalTravelDistance, motionAmount);

            // 2. 分镜机位平滑插值 (Shot Rig Interpolation)
            let rigOffX = 0;
            let rigOffY = 0;
            let rigAimX = 0;
            let rigAimY = 0;
            let rigRoll = 0;
            let rigFov = 0;

            if (shot && motionAmount > 0.001) {
                const prevShot = timeline.lineShots[Math.max(0, lineIdx - 1)] || shot;
                const cutBlend = smoother((time - lineStart) / Math.min(2.2, Math.max(0.65, (lineEnd - lineStart) * 0.45)));
                rigOffX = mix(prevShot.rig.offset[0], shot.rig.offset[0], cutBlend) * motionAmount;
                rigOffY = mix(prevShot.rig.offset[1], shot.rig.offset[1], cutBlend) * motionAmount;
                rigAimX = mix(prevShot.rig.aimBias[0], shot.rig.aimBias[0], cutBlend) * motionAmount;
                rigAimY = mix(prevShot.rig.aimBias[1], shot.rig.aimBias[1], cutBlend) * motionAmount;
                rigRoll = mix(prevShot.rollBias, shot.rollBias, cutBlend) * motionAmount;
                rigFov = shot.rig.fovAdd * cutBlend * Math.min(1, motionAmount);
            }

            // 漂移呼吸与低频微震（阅读区间自动衰减抖动，保护字幕清晰度）
            const readDamp = 1.0 - readingHold * 0.55;
            const driftX = (Math.sin(time * 0.29) * 1.15 + Math.cos(time * 0.13) * 0.65) * breathAmount * motionAmount;
            const driftY = (Math.cos(time * 0.23) * 0.82 + Math.sin(time * 0.17) * 0.45) * breathAmount * motionAmount;
            const shakeX = Math.sin(time * 16.3) * bassSmooth * 0.18 * shakeAmount * readDamp;
            const shakeY = Math.cos(time * 18.7) * bassSmooth * 0.14 * shakeAmount * readDamp;

            const camX = camSpine.x + camSpine.right.x * (rigOffX + driftX) + camSpine.up.x * (rigOffY + driftY) + shakeX;
            const camY = camSpine.y + camSpine.right.y * (rigOffX + driftX) + camSpine.up.y * (rigOffY + driftY) + shakeY;
            const camZ = camSpine.z;
            cameraInstance.position.set(camX, camY, camZ);

            // 前视目标：沿深空航道前方 140 米处，叠加分镜偏航与歌词舞台牵引
            const lookAheadSpine = timeline.spineAt(totalTravelDistance + 140, motionAmount);
            let lookX = lookAheadSpine.x + rigAimX * 4.5;
            let lookY = lookAheadSpine.y + rigAimY * 4.5;
            let lookZ = lookAheadSpine.z;

            // 3. 更新空间锚定歌词与结项粒子流形
            const nextKey = activeLine ? `${activeLine.index}:${activeLine.startTime}:${activeLine.fullText}` : '';
            if (nextKey !== currentLineKey) {
                currentLineKey = nextKey;
                buildLyricStage(activeLine, settings);
            } else if (activeLine && !glyphCacheKey) {
                buildLyricStage(activeLine, settings);
            }

            if (activeLine && activePointCount > 0) {
                const start = finiteNumber(activeLine.startTime, time);
                const vocalEnd = Math.max(start + 0.25, glyphVocalEnd);
                const exitStart = vocalEnd + Math.min(0.95, holdRatio * 0.55 + pauseDur * 0.18);
                const exitDuration = 0.55 + dissolveAmount * 0.65;

                const entryPhase = clamp((time - start) / 0.34);
                const exitPhase = clamp((time - exitStart) / exitDuration);
                const alive = time >= start - 0.05 && time < exitStart + exitDuration;

                const cohesion = settings.reducedMotion ? 1 : smoother(entryPhase);
                const solidIn = settings.reducedMotion ? 1 : smooth((entryPhase - 0.48) / 0.52);
                const solidOut = 1 - smooth(exitPhase / 0.32);
                const disperse = smooth((exitPhase - 0.12) / 0.88) * (0.35 + dissolveAmount * 0.65);
                const glyphAlpha = alive ? solidIn * solidOut : 0;

                // 歌词三维锚点：位于镜头前方的弯曲航道断面，带独立空间视差与优雅侧倾
                const stageDist = 33.5;
                const stageSpine = timeline.spineAt(totalTravelDistance + stageDist, motionAmount);
                const floatX = Math.sin(time * 0.34) * 0.38 * motionAmount;
                const floatY = (Math.cos(time * 0.27) * 0.28 + vocalSmooth * 0.22) * motionAmount;
                const shotX = (shot ? shot.lateralX * 0.38 : 0) * motionAmount;
                const shotY = (shot ? shot.verticalY * 0.38 : 0) * motionAmount;

                const stageX = mix(camX, stageSpine.x, 0.65) + shotX + floatX;
                const stageY = mix(camY, stageSpine.y, 0.65) + shotY + floatY;
                const stageZ = camZ - stageDist;

                lyricAnchorGroup.position.set(stageX, stageY, stageZ);
                const aspectScale = Math.min(1, Math.max(0.42, viewportAspect * 0.68));
                lyricAnchorGroup.scale.setScalar(aspectScale);

                // 歌词平面面向相机并保留微幅电影级欧拉倾角
                const dx = camX - stageX;
                const dy = camY - stageY;
                const dz = camZ - stageZ;
                const faceYaw = Math.atan2(dx, dz) + (shot ? shot.yawBias : 0) * motionAmount;
                const facePitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 0.65 + (shot ? shot.pitchBias : 0) * motionAmount;
                const faceRoll = ((shot ? shot.rollBias : 0) + Math.sin(time * 0.31) * 0.012) * motionAmount;
                lyricAnchorGroup.rotation.set(facePitch, faceYaw, faceRoll);

                // 镜头视线向当前歌词锚点温和聚焦（保证任意机位下字幕均在黄金构图区内）
                lookX = mix(lookX, stageX, 0.58);
                lookY = mix(lookY, stageY, 0.58);
                lookZ = mix(lookZ, stageZ, 0.58);

                glyphStage.visible = alive && glyphAlpha > 0.004;
                glyphStage.children.forEach((mesh) => {
                    mesh.material.uniforms.time.value = time;
                    mesh.material.uniforms.alpha.value = glyphAlpha;
                    mesh.material.uniforms.motion.value = motionAmount;
                    mesh.material.uniforms.glow.value = glowAmount;
                });

                const releaseIn = smooth(exitPhase / 0.22);
                const releaseOut = 1 - smooth((exitPhase - 0.58) / 0.42);
                const particleOpacity = (!alive || settings.reducedMotion)
                    ? 0
                    : clamp((1 - solidIn * 0.72) * 0.92 + solidIn * releaseIn * releaseOut * (0.45 + dissolveAmount * 0.55), 0, 1);

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
                glyphStage.visible = false;
                lyricPoints.visible = false;
                frameArcLines.forEach((arcLine) => { arcLine.visible = false; });
                lyricParticleMat.uniforms.uOpacity.value = 0;
            }

            cameraInstance.lookAt(lookX, lookY, lookZ);
            cameraInstance.rotation.z += rigRoll + camSpine.curvature * 0.032 * motionAmount
                + Math.sin(time * 0.21) * 0.008 * breathAmount * motionAmount;

            const targetFov = clamp(
                actState.fov + rigFov + bassSmooth * 2.4 * shakeAmount + (cruiseSpeed - 1.0) * 3.5 * Math.min(1, motionAmount),
                38,
                68
            );
            if (Math.abs(cameraInstance.fov - targetFov) > 0.02) {
                cameraInstance.fov = targetFov;
                cameraInstance.updateProjectionMatrix();
            }

            // 4. 更新深空星尘、体积星云与结项引力丝束
            const showStarfield = settings.starfield !== false;
            fieldPoints.visible = showStarfield;
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
            const audioPulse = clamp(bassSmooth * 1.1 + vocalSmooth * 0.35, 0, 1.2);

            timeline.encounterSlots.forEach((slot, idx) => {
                const node = entityNodes[idx];
                const enabled = slot.type === 'planet' ? showPlanets
                    : slot.type === 'rings' ? showRings
                        : slot.type === 'ship' ? showShips
                            : showStations;
                if (!enabled) {
                    node.points.visible = false;
                    return;
                }

                // 计算该巨构在当前周期内的世界弧长坐标 sWorld（掠过身后 220m 后再折返至下一周期 2180m 远方）
                const cycleIndex = Math.max(0, Math.floor((totalTravelDistance - slot.baseS + 220) / cycle));
                const sWorld = slot.baseS + cycleIndex * cycle;
                const relS = sWorld - totalTravelDistance; // >0 在镜头前方，<0 已掠过镜头后方

                if (relS < -180 || relS > 1820) {
                    node.points.visible = false;
                    return;
                }

                // 远近双端丝滑存在包络 (uPresence)：
                // 远端 1820m -> 920m 从 0% 极微弱星雾渐显，近端 -30m -> -180m 在身后彻底消隐
                const farPresence = 1.0 - smoother((relS - 920) / 880);
                const nearPresence = smooth((relS + 180) / 150);
                const presence = clamp(farPresence * nearPresence, 0, 1);
                if (presence <= 0.002) {
                    node.points.visible = false;
                    return;
                }

                node.points.visible = true;
                const anchorSpine = timeline.spineAt(sWorld, motionAmount);
                // 远方未完全凝聚时，巨构位置略微向航道中轴聚拢，随凝聚自然舒展到两侧巡航位
                const birthSpread = 0.65 + 0.35 * (1.0 - smooth((relS - 460) / 1150));
                const wx = anchorSpine.x + anchorSpine.right.x * (slot.side * slot.radial * birthSpread) + anchorSpine.up.x * (slot.elev * birthSpread);
                const wy = anchorSpine.y + anchorSpine.right.y * (slot.side * slot.radial * birthSpread) + anchorSpine.up.y * (slot.elev * birthSpread);
                const wz = anchorSpine.z;
                node.points.position.set(wx, wy, wz);

                const rotY = time * slot.rotSpeed + idx * 1.1;
                node.points.rotation.set(slot.tilt[0], rotY + slot.tilt[1], slot.tilt[2]);

                // 结项凝聚与近场擦肩解体包络：
                // 远方 (relS: 1680 -> 440) 从深空纵向星尘细丝缓缓坍缩凝结为精密流形；
                // 黄金视距 (relS: 440 -> 135) 保持 100% 凝聚展示；
                // 擦肩掠过 (relS: 135 -> -160) 受引力潮汐拉扯，沿切向涡流解体为漫天星尘。
                let cohesion = 1.0;
                let dissolveDir = -1.0;
                if (relS > 440) {
                    cohesion = 1.0 - smoother((relS - 440) / 1220);
                    dissolveDir = -1.0;
                } else if (relS < 135) {
                    const passPhase = clamp((135 - relS) / 260);
                    cohesion = 1.0 - easeInCubic(passPhase) * (0.48 + dissolveAmount * 0.52);
                    dissolveDir = 1.0;
                }

                const u = node.mat.uniforms;
                u.uTime.value = time;
                u.uCohesion.value = cohesion;
                u.uPresence.value = presence;
                u.uDissolveDir.value = dissolveDir;
                u.uScale.value = slot.scale;
                u.uDensity.value = objectDensity;
                u.uAudioPulse.value = audioPulse;
                u.uGlow.value = glowAmount;
            });
        };

        return {
            get distance() { return totalTravelDistance; },
            get currentSpeed() { return cruiseSpeed; },
            reset,
            setPalette,
            update,
            resize(w, h, ratio) {
                viewportAspect = Math.max(0.2, Number(w) / Math.max(1, Number(h)));
                pixelRatio = ratio;
                fieldMat.uniforms.uPixelRatio.value = ratio;
                filamentMat.uniforms.uViewport.value.set(Math.max(1, w * ratio), Math.max(1, h * ratio));
                lyricParticleMat.uniforms.uPixelRatio.value = ratio;
                entityNodes.forEach((node) => { node.mat.uniforms.uPixelRatio.value = ratio; });
            },
            destroy() {
                clearGlyphStage();
                scene.remove(root);
                [fieldGeo, filamentGeo, streakGeo, lyricGeo, rippleGeo, ...frameArcGeos].forEach((g) => g?.dispose?.());
                [fieldMat, filamentMat, streakMat, lyricParticleMat, ...frameArcMats].forEach((m) => m?.dispose?.());
                entityNodes.forEach((node) => {
                    node.geo?.dispose?.();
                    node.mat?.dispose?.();
                });
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
        let initialized = false;
        let fallbackMode = false;
        let initializing = null;
        let latest = null;
        let source = null;
        let identity = '';
        let width = 1;
        let height = 1;
        let lastTime = null;
        let paletteKey = '';

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

        const resize = () => {
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            if (!renderer || !camera) return;
            const cap = mode.config.quality === 'energy-saving' ? 1 : mode.config.quality === 'ultimate' ? 2 : 1.5;
            const dpr = Math.min(cap, global.devicePixelRatio || 1);
            renderer.setPixelRatio(dpr);
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            world?.resize?.(width, height, dpr);
        };

        const disposeGraphics = () => {
            world?.destroy?.();
            world = null;
            if (renderer) {
                renderer.dispose?.();
                renderer.forceContextLoss?.();
                renderer.domElement?.remove?.();
                renderer = null;
            }
            camera = null;
            scene = null;
            initialized = false;
        };

        const update = (frame) => {
            if (mode.destroyed || mode.suspended || !frame) return;
            latest = frame;
            if (!initialized) {
                renderFallback(frame);
                if (!fallbackMode) void initialize();
                return;
            }

            const nextIdentity = frame.track?.path || frame.track?.title || 'tunnel-track';
            if (source !== frame.lines || identity !== nextIdentity) {
                source = frame.lines;
                identity = nextIdentity;
                lastTime = null;
                world?.reset?.(frame.lines || [], identity);
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
            renderer.render(scene, camera);
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

                renderer = new T.WebGLRenderer({
                    antialias: true,
                    alpha: false,
                    powerPreference: 'high-performance'
                });
                renderer.outputColorSpace = T.SRGBColorSpace;
                renderer.toneMapping = T.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.08;
                renderer.domElement.className = 'tunnel-canvas';
                mode.root.insertBefore(renderer.domElement, fallback);

                mode.scope.listen(renderer.domElement, 'webglcontextlost', (event) => {
                    event.preventDefault();
                    fallbackMode = true;
                    disposeGraphics();
                    if (latest) renderFallback(latest);
                });

                world = createTunnelWorld(T, scene, services?.app);
                initialized = true;
                resize();
                world.setPalette(services?.app?.stagePalette || {});
                if (latest) update(latest);
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

        mode.updateFrame = update;
        mode.resize = () => { resize(); if (latest && initialized) update(latest); };
        const baseConfig = mode.updateConfig;
        mode.updateConfig = (config) => { baseConfig(config); resize(); if (latest && initialized) update(latest); };
        mode.updateTheme = () => { if (latest && initialized) update(latest); };
        const resume = mode.resume;
        mode.resume = () => { resume(); lastTime = null; if (latest) update(latest); };
        mode.getDebugSnapshot = () => ({
            initialized,
            fallbackMode,
            distance: world?.distance || 0,
            currentSpeed: world?.currentSpeed || 0,
            cameraPos: camera?.position?.toArray() || null,
            activeLine: latest?.activeLine?.fullText || null
        });
        mode.scope.add(() => { disposeGraphics(); latest = source = null; });

        resize();
        void initialize();
        return mode;
    };

    global.MusicStageTunnelManager = Object.freeze({ create });
})(window);