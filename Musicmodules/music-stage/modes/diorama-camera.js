(function (global) {
    'use strict';
    const { clamp, hashString } = global.MusicStageRuntime;
    const { smooth, upperBound } = global.MusicStageDioramaDirector;
    const mix = (a, b, p) => a + (b - a) * p;
    const noise = (time, seed) => {
        const i = Math.floor(time);
        const value = n => hashString(`${seed}:${n}`) / 4294967295 * 2 - 1;
        return mix(value(i), value(i + 1), smooth(time - i));
    };
    // Horizontal unit-speed curve. Integrate headings on a fixed spatial grid,
    // so arc length really is metres (not a spline's arbitrary parameter).
    const createTrack = (timeline, speed = 1, options = {}) => {
        const step = 2;
        const length = timeline.distanceAt(timeline.duration, speed) + 600;
        const count = Math.ceil(length / step);
        const x = new Float64Array(count + 1), z = new Float64Array(count + 1);
        const phase = timeline.seedHash / 4294967295 * Math.PI * 2;
        const heading = s => 0.12 * Math.sin(s / 180 + phase)
            + 0.045 * Math.sin(s / 73 + phase * 0.7);
        for (let i = 1; i <= count; i++) {
            const yaw = heading((i - 0.5) * step);
            x[i] = x[i - 1] + Math.sin(yaw) * step;
            z[i] = z[i - 1] - Math.cos(yaw) * step;
        }
        const at = distance => {
            const s = clamp(distance, 0, count * step);
            const index = Math.min(count - 1, Math.floor(s / step));
            const p = (s - index * step) / step;
            const yaw = heading(s);
            const forward = { x: Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
            const right = { x: Math.cos(yaw), y: 0, z: Math.sin(yaw) };
            const extension = distance < 0 ? distance : Math.max(0, distance - count * step);
            return {
                position: { x: mix(x[index], x[index + 1], p) + forward.x * extension,
                    y: 0, z: mix(z[index], z[index + 1], p) + forward.z * extension },
                forward, right, yaw
            };
        };
        const plan = global.MusicStageDioramaDirector.planEncounters(timeline, { ...options, cameraSpeed: speed });
        plan.encounters.forEach(encounter => {
            const frame = at(encounter.address);
            // The first encounter is to the right; successive encounters
            // alternate sides without ever creating a second screen per page.
            encounter.side = encounter.id % 2 === 0 ? 1 : -1;
            encounter.position = {
                x: frame.position.x + frame.right.x * encounter.lateral * encounter.side,
                y: 4.2,
                z: frame.position.z + frame.right.z * encounter.lateral * encounter.side
            };
            const middle = at((encounter.startDistance + encounter.endDistance) * 0.5);
            encounter.yaw = Math.atan2(encounter.position.x - middle.position.x,
                middle.position.z - encounter.position.z);
            encounter.width = Math.min(13, 15 * Math.max(0.45, options.aspect || 1.6));
            encounter.height = 3.6;
        });
        // Compile continuous yaw cues, including interrupted transitions.
        const cues = timeline.acts.slice(1).map(act => ({ time: act.start, rig: rigFor(act) }));
        if (options.cameraCuts !== false) timeline.cuts.forEach(cut =>
            cues.push({ time: cut.time, rig: cut.rig || rigFor(timeline.acts[cut.actIndex]) }));
        cues.sort((a, b) => a.time - b.time);
        const turns = [];
        const initialYaw = rigYaw(rigFor(timeline.acts[0]));
        for (const cue of cues) {
            const last = turns[turns.length - 1];
            const from = last ? mix(last.from, last.to, smooth((cue.time - last.time) / 3.5)) : initialYaw;
            turns.push({ time: cue.time, from, to: rigYaw(cue.rig) });
        }
        return { at, encounters: plan.encounters, pageEncounter: plan.pageEncounter, turns, initialYaw };
    };
    const rigFor = act => act.kind === 'Departure' ? 'RAIL'
        : ['Chorus', 'Open'].includes(act.kind) ? 'WIDE'
            : act.kind === 'Interlude' ? 'WINDOW'
                : act.kind === 'Verse' && act.index % 2 ? 'WINDOW' : 'CAB';
    const rigYaw = rig => rig === 'WINDOW' ? 0.7 : 0;
    const readingEnvelope = (timeline, t) => {
        const intervals = timeline.protectedIntervals;
        const index = upperBound(intervals, t, 'start') - 1;
        let result = 0;
        for (let i = Math.max(0, index); i <= Math.min(intervals.length - 1, index + 1); i++) {
            const interval = intervals[i];
            result = Math.max(result, smooth((t - interval.start + 0.3) / 0.3)
                * (1 - smooth((t - interval.end) / 0.3)));
        }
        return result;
    };
    const pose = (timeline, track, time, options = {}) => {
        const t = clamp(time, 0, timeline.duration);
        const state = timeline.sample(t);
        const motion = options.reducedMotion ? 0 : clamp(options.motionAmount ?? 1, 0, 2)
            * clamp(options.animationIntensity ?? 1, 0, 2);
        const distance = timeline.distanceAt(t, options.cameraSpeed ?? 1);
        const frame = track.at(distance);
        const act = timeline.acts[state.actIndex];
        const previous = timeline.acts[Math.max(0, state.actIndex - 1)];
        const cutsEnabled = motion && options.cameraCuts !== false;
        const cutIndex = cutsEnabled ? upperBound(timeline.cuts, t, 'time') - 1 : -1;
        const cut = cutIndex >= 0 ? timeline.cuts[cutIndex] : null;
        const currentCut = cut && cut.actIndex >= act.index ? cut : null;
        let rig = motion ? rigFor(act) : 'CAB';
        if (currentCut) rig = currentCut.rig || rigFor(timeline.acts[currentCut.actIndex]);
        const turn = track.turns?.[upperBound(track.turns, t, 'time') - 1];
        const yawBias = motion ? (turn
            ? mix(turn.from, turn.to, smooth((t - turn.time) / 3.5)) : track.initialYaw || 0) : 0;
        const reading = readingEnvelope(timeline, t);
        const seed = timeline.seedHash;
        const handheld = motion * (1 - reading * 0.55);
        const n = (frequency, offset) => noise(t * frequency, seed + offset);
        // Phrase-scale choreography, distinct from handheld vibration.
        // Zero velocity at the phrase edges avoids resetting motion on each word.
        const lineIndex = upperBound(timeline.lines, t, 'startTime') - 1;
        const line = timeline.lines[lineIndex];
        const vocalEnd = line ? (line.vocalEndTime ?? line.endTime) : 0;
        const lineDuration = line ? Math.max(0.1, vocalEnd - line.startTime) : 1;
        const lineProgress = line ? clamp((t - line.startTime) / lineDuration) : 0;
        // Rapid credits/short syllables must not compress a full camera move into milliseconds.
        const arch = Math.sin(Math.PI * lineProgress) ** 2 * smooth((lineDuration - 1.2) / 2);
        const directionSign = lineIndex % 2 ? -1 : 1;
        const strength = Math.min(1.5, motion);
        const openness = state.openness;
        const lateralTravel = directionSign * arch * (0.35 + openness * 0.65) * strength;
        const lift = arch * (0.12 + openness * 0.5) * strength;
        const push = arch * openness * 0.6 * strength;
        const position = {
            x: frame.position.x + frame.right.x * (-0.25 + n(0.8, 1) * 0.025 * handheld),
            y: (motion ? state.height : 2.2) + Math.sin(t * Math.PI * 0.4) * 0.01 * handheld
                + n(1.3, 2) * 0.018 * handheld + timeline.rhythmAt(t).impulse * 0.012 * handheld,
            z: frame.position.z + frame.right.z * -0.25
        };
        position.x += frame.right.x * lateralTravel + frame.forward.x * push;
        position.z += frame.right.z * lateralTravel + frame.forward.z * push;
        position.y += lift;
        let yaw = frame.yaw + yawBias + n(0.55, 3) * 0.003 * handheld
            + directionSign * arch * openness * 0.012 * strength;
        let pitch = mix(-0.025, -0.12, state.openness);
        const finale = state.act === 'Terminus' && motion && !timeline.isSinging(t)
            ? smooth((t - act.start) / Math.max(1, act.end - act.start)) : 0;
        // A stationary roadside screen owns the gaze, never the train position.
        // Derive the blend analytically so seeking midway through a handoff is exact.
        const encounters = track.encounters || [];
        const encounterIndex = upperBound(encounters, t, 'start') - 1;
        const encounter = encounters[encounterIndex];
        const upcoming = encounters[encounterIndex + 1];
        const aim = item => {
            const dx = item.position.x - position.x;
            const dz = item.position.z - position.z;
            return { yaw: Math.atan2(dx, -dz),
                pitch: Math.atan2(item.position.y - position.y, Math.hypot(dx, dz)) };
        };
        const blendAngle = (a, b, weight) => a
            + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * weight;
        let encounterId = null;
        const directHandoff = encounter && upcoming && t >= encounter.end
            && upcoming.start - encounter.end > 0 && upcoming.start - encounter.end <= 7;
        if (directHandoff) {
            const a = aim(encounter), b = aim(upcoming);
            const weight = smooth((t - encounter.end) / (upcoming.start - encounter.end));
            yaw = blendAngle(a.yaw, b.yaw, weight);
            pitch = mix(a.pitch, b.pitch, weight);
            encounterId = weight < 0.5 ? encounter.id : upcoming.id;
            rig = 'WINDOW';
        }
        if (encounter && !directHandoff) {
            const release = upcoming ? Math.min(4, Math.max(0.1, upcoming.start - encounter.end)) : 4;
            const weight = 1 - smooth((t - encounter.end) / release);
            if (weight > 0) {
                const target = aim(encounter);
                yaw = blendAngle(yaw, target.yaw, weight);
                pitch = mix(pitch, target.pitch, weight);
                encounterId = encounter.id;
                rig = 'WINDOW';
            }
        }
        if (upcoming && !directHandoff) {
            const lead = Math.min(5, Math.max(0.1, upcoming.start - (encounter?.end ?? 0)));
            const weight = smooth((t - upcoming.start + lead) / lead);
            if (weight > 0) {
                const target = aim(upcoming);
                yaw = blendAngle(yaw, target.yaw, weight);
                pitch = mix(pitch, target.pitch, weight);
                encounterId = upcoming.id;
            }
        }
        let fov = motion ? state.fov - arch * (1.2 + openness * 1.8) * strength : 48;
        let eventFocus = null;
        const events = track.events || [];
        const event = events[upperBound(events, t, 'start') - 1];
        if (motion && options.journeyEvents !== false && event?.kind === 'whale'
            && t < event.end && !timeline.isSinging(t)) {
            const performance = global.MusicStageDioramaEvents.sample(event, t);
            const age = performance.age;
            const weight = smooth(age / 2) * (1 - smooth((age - 8.2) / 2.8));
            const target = aim({ position: {
                x: performance.body.x, y: Math.max(0.8, performance.body.y), z: performance.body.z
            } });
            yaw = blendAngle(yaw, target.yaw, weight);
            pitch = mix(pitch, target.pitch, weight);
            // Reserve room for head and tail, particularly in portrait windows.
            const aspect = Math.max(0.35, options.aspect || 1.6);
            const distanceToBody = Math.hypot(performance.body.x - position.x, performance.body.z - position.z);
            const fit = 2 * Math.atan(15 / Math.max(1, distanceToBody * Math.min(1, aspect))) * 180 / Math.PI;
            fov = mix(fov, Math.max(fov, Math.min(80, fit)), weight);
            eventFocus = { id: event.id, weight };
        }
        // Apply after roadside gaze release so the last sign cannot cancel the skyward finale.
        // The moon uses this same fixed celestial offset in the world renderer.
        yaw = blendAngle(yaw, Math.atan2(-210, 420), finale);
        pitch = mix(pitch, Math.atan2(300 - position.y, Math.hypot(210, 420)), finale);
        pitch += n(0.7, 4) * 0.0025 * handheld * (1 - finale);
        const cp = Math.cos(pitch);
        const direction = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
        return {
            position, direction, yaw, pitch,
            roll: motion ? n(0.45, 5) * 0.002 * handheld
                + directionSign * arch * openness * 0.006 * strength : 0,
            fov, eventFocus, finale,
            shot: openness > 0.6 ? 'rising-traverse' : 'window-tracking',
            rig: !motion ? 'CAB' : rig,
            encounterId, reading, distance, state,
            look: { x: position.x + direction.x * 30, y: position.y + direction.y * 30,
                z: position.z + direction.z * 30 }
        };
    };
    global.MusicStageDioramaCamera = Object.freeze({ createTrack, pose, noise, readingEnvelope });
})(window);