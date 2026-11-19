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
        const scenes = planScenes(timeline, options);
        const path = trainPath(timeline, scenes, speed, options);
        const length = Math.max(path.addressAt(timeline.duration), path.trainAt(timeline.duration)) + 600;
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
        // Screens are set out along where the camera actually goes, which is
        // not always where the cab is.
        const plan = global.MusicStageDioramaDirector.planEncounters(timeline,
            { ...options, cameraSpeed: speed, addressAt: path.addressAt });
        plan.encounters.forEach(encounter => {
            const frame = at(encounter.address);
            // The first encounter is to the right; successive encounters
            // alternate sides without ever creating a second screen per page.
            encounter.side = encounter.id % 2 === 0 ? 1 : -1;
            // When the next line is written on the sky, this screen is the last
            // of its run and nothing is read after it: it stands well back from
            // the line, so it is out of the picture when the camera looks ahead.
            const phrases = timeline.phrases || [];
            const next = phrases[upperBound(phrases, encounter.end - 0.001, 'start')];
            const skyNext = Boolean(next) && !plan.pageEncounter.has(next.id);
            if (skyNext && next.start - encounter.end < 10) encounter.lateral = 21;
            encounter.position = {
                x: frame.position.x + frame.right.x * encounter.lateral * encounter.side,
                y: 4.6,
                z: frame.position.z + frame.right.z * encounter.lateral * encounter.side
            };
            const middle = at((encounter.startDistance + encounter.endDistance) * 0.5);
            encounter.yaw = Math.atan2(encounter.position.x - middle.position.x,
                middle.position.z - encounter.position.z);
            // Large enough that lyric and translation are both legible from the
            // far end of the reading span, still inside the frame at the near end.
            encounter.width = Math.min(16, 18.5 * Math.max(0.45, options.aspect || 1.6));
            encounter.height = 4.2;
            // When the next line is written on the sky, the camera has to let go
            // of this screen by then, or the screen stands in front of that line.
            encounter.skyStart = skyNext ? next.start : Infinity;
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
        // On the way up to the roof and down again the camera passes the train
        // on the side of the screen being read then: the pantograph is then off
        // to the other side of the picture and never comes between them.
        const screenSide = t => {
            const reading = plan.encounters.filter(item => item.start - 5 <= t && item.end + 2 >= t);
            const nearest = reading.sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))[0];
            return nearest ? nearest.side : 1;
        };
        const rideSides = rideSpans(timeline).map(span => ({
            entry: screenSide(span.start + ROOF.blend / 2), exit: screenSide(span.end - ROOF.blend / 2) }));
        return { at, encounters: plan.encounters, pageEncounter: plan.pageEncounter, turns, initialYaw,
            scenes, rideSides, path, addressAt: path.addressAt, timeAt: path.timeAt, trainAt: path.trainAt };
    };
    const CHASE_LATERAL = 7.5;
    const CHASE_LEAD = 66;
    const chaseAmount = height => smooth((height - 3.9) / 0.7);
    /*
     * Each chorus is seen from somewhere else. The first looks down on the
     * train from behind and to one side. The second runs low over the water
     * alongside it, the lit windows going by with their reflection underneath.
     * The third goes up over the wires and looks down the length of the roofs.
     * Height is where the camera ends up, lead how far the nose of the train
     * runs ahead of it, yaw and pitch what is added to the forward gaze. The
     * line on the sky is written off to one side of that gaze where the train
     * would otherwise run through it.
     */
    const CHASE_RIGS = Object.freeze([
        { name: 'QUARTER', lateral: CHASE_LATERAL, lead: CHASE_LEAD, height: null, yaw: -0.075, pitch: 0, fov: 0,
            skyYaw: 0, skyPitch: 0.1 },
        // Out over the water ahead of the train and turned to face it: the
        // lamps and the lit cab come on, the whole train strung out behind.
        { name: 'BOW', lateral: -5.4, lead: -13, height: 1.5, yaw: 2.82, pitch: 0.07, fov: -22,
            skyYaw: -0.17, skyPitch: 0.2 },
        { name: 'ALONGSIDE', lateral: -CHASE_LATERAL, lead: 44, height: 1.7, yaw: 0.3, pitch: 0.13, fov: -4,
            skyYaw: -0.12, skyPitch: 0.16 },
        { name: 'OVERHEAD', lateral: 1.8, lead: 60, height: 8.6, yaw: -0.02, pitch: -0.2, fov: 0,
            skyYaw: 0, skyPitch: 0.2 }
    ]);
    const chaseRigs = new WeakMap();
    const chaseRig = (timeline, act) => {
        let rigs = chaseRigs.get(timeline);
        if (!rigs) {
            let chorus = 0;
            rigs = timeline.acts.map(item => CHASE_RIGS[item.kind === 'Chorus' ? chorus++ % CHASE_RIGS.length : 0]);
            chaseRigs.set(timeline, rigs);
        }
        return rigs[act.index] || CHASE_RIGS[0];
    };
    // Starts and stops without a jolt: no speed and no acceleration at either end.
    const ease = value => { const p = clamp(value); return p * p * p * (p * (p * 6 - 15) + 10); };
    // A long move along the line: it gathers speed gently, keeps an even pace
    // through the middle, and comes to rest gently, so its top speed is no more
    // than half as much again as its average.
    const glide = (value, edge = 0.3) => {
        const p = clamp(value), total = 1 - edge;
        const ramp = x => edge * (x * x * x - x * x * x * x / 2);
        if (p < edge) return ramp(p / edge) / total;
        if (p > 1 - edge) return 1 - ramp((1 - p) / edge) / total;
        return (p - edge / 2) / total;
    };
    /*
     * Leaving the cab for a high act is a crane move with an order to it. The
     * camera first lifts out to one side of the line; only when it is clear of
     * the train does the train draw ahead of it. Coming back it catches the
     * train up first, and slides in over the nose last. Each part takes
     * seconds, so nothing in the frame changes place faster than the eye follows.
     */
    const crane = (act, previous, t, timeline) => {
        const to = chaseAmount(act.params.height);
        const from = act.index ? chaseAmount(previous.params.height) : to;
        // The shot belongs to whichever of the two acts is the high one; from
        // one high act straight into another it is carried across.
        const own = timeline ? chaseRig(timeline, act) : CHASE_RIGS[0];
        const before = timeline && act.index ? chaseRig(timeline, previous) : own;
        const across = glide((t - act.start) / Math.max(0.001, Math.min(12, (act.end - act.start) * 0.8)));
        const rig = to > from || own === before ? own : to < from ? before : {
            name: across < 0.5 ? before.name : own.name, lateral: mix(before.lateral, own.lateral, across),
            lead: mix(before.lead, own.lead, across), yaw: mix(before.yaw, own.yaw, across),
            pitch: mix(before.pitch, own.pitch, across), fov: mix(before.fov, own.fov, across),
            skyYaw: mix(before.skyYaw, own.skyYaw, across), skyPitch: mix(before.skyPitch, own.skyPitch, across)
        };
        const level = item => chaseAmount(item.params.height) > 0.5
            ? (timeline ? chaseRig(timeline, item) : CHASE_RIGS[0]).height ?? item.params.height : item.params.height;
        // Coming back down to the cab: catch the train up first, slide in over
        // the nose last. The camera has the length of the train to make up and
        // must not outrun the eye doing it, so the way back takes its time; when
        // the act after a high one is too short for that, it sets off before
        // the high act is over.
        // Behind the train it first closes in to just off the side of the
        // roofs, up above them, out of the way of the screens either side of the
        // line, then runs up over the train, and comes down in front of the cab.
        const back = (p, high, low, start, lower) => {
            const shot = high === to ? own : before;
            if (shot.lead <= 0) return { rig: shot, out: mix(high, low, ease((p - 0.45) / 0.55)),
                lead: mix(high, low, glide(p / 0.8)), height: mix(start, level(lower), ease((p - 0.3) / 0.7)) };
            const narrow = Math.min(1, ROOF_SIDE / Math.max(0.01, Math.abs(shot.lateral)));
            const over = Math.max(OVER_ROOF, start);
            return { rig: shot, out: mix(high, low, ease((p - 0.8) / 0.15)) * mix(1, narrow, ease(p / 0.35)),
                lead: mix(high, low, glide(p / 0.8)),
                height: mix(mix(start, over, ease(p / 0.3)), level(lower), ease((p - 0.83) / 0.17)) };
        };
        const early = item => Math.max(0, RETURN - (item.end - item.start) * 0.85);
        if (to < from) return back((t - act.start + early(act)) / RETURN, from, to, level(previous), act);
        // Going up takes its time too.
        const p = (t - act.start) / Math.max(0.001, Math.min(10, (act.end - act.start) * 0.8));
        const height = (a, b) => act.index ? mix(level(previous), level(act), ease((p - a) / b)) : level(act);
        const up = to > from ? { rig, out: mix(from, to, ease(p / 0.6)), lead: mix(from, to, ease((p - 0.25) / 0.75)),
            height: height(0, 0.6) } : { rig, out: to, lead: to, height: height(0, 0.5) };
        const next = timeline?.acts[act.index + 1];
        const below = next ? chaseAmount(next.params.height) : to;
        if (!next || below >= to || t < act.end - early(next)) return up;
        const down = back((t - act.end + early(next)) / RETURN, to, below, up.height, next);
        return { rig: up.rig, out: Math.min(up.out, down.out), lead: Math.min(up.lead, down.lead), height: down.height };
    };
    const RETURN = 11, ROOF_SIDE = 2.6, OVER_ROOF = 5.6;
    /*
     * When nobody is singing for a while there is nothing to read, and the
     * camera can go somewhere else: back into the saloon of the leading car, or
     * out to the waterside to let the train run past. Scenes are planned once
     * from the song, so seeking lands in the same shot every time. They keep
     * clear of the high acts and end well before the next line.
     */
    const SCENE_KINDS = ['SALOON', 'TRACKSIDE'];
    const SCENE_BLEND = 3, SCENE_RAISE = 2.5;
    const planScenes = (timeline, options = {}) => {
        if (options.cameraCuts === false || options.reducedMotion) return [];
        const low = t => {
            const index = timeline.sample(t).actIndex, act = timeline.acts[index];
            const move = crane(act, timeline.acts[Math.max(0, index - 1)], t, timeline);
            return act.kind !== 'Terminus' && move.out === 0 && move.lead === 0 && rideAt(timeline, t) === 0;
        };
        const scenes = [];
        let cursor = 0;
        for (const busy of [...timeline.protectedIntervals, { start: timeline.duration, end: timeline.duration }]) {
            // The song may open inside the car; later scenes wait for the last screen to let go.
            let from = cursor ? cursor + 2.5 : 0;
            const until = busy.start - 5;
            while (until - from >= 7.5) {
                let start = from;
                while (start < until && !low(start)) start += 0.5;
                let end = start;
                while (end + 0.5 <= until && end - start < 14 && low(end + 0.5)) end += 0.5;
                // Watching the train go by needs longer than a look round the saloon.
                const wanted = start === 0 ? 'SALOON' : SCENE_KINDS[scenes.length % SCENE_KINDS.length];
                const kind = wanted === 'TRACKSIDE' && end - start < 10 ? 'SALOON' : wanted;
                if (end - start >= 7.5)
                    scenes.push({ id: scenes.length, kind, start, end, side: scenes.length % 2 ? 1 : -1 });
                from = Math.max(end, start + 0.5) + 8;
            }
            cursor = Math.max(cursor, busy.end);
        }
        return scenes;
    };
    /*
     * Some verses are ridden on the roof instead of from the cab: from over
     * the joint of the leading set, down the length of the first car's roof
     * and its pantograph to where the line runs out. From that far back the
     * pantograph is narrow and low in the middle of the picture, and the
     * screens stand out to either side of it. Getting there is a crane move with an order to it, like the
     * high acts': out past the side of the cab, let the train draw ahead,
     * up past the cant rail, and in over the roof; coming back the same way.
     * Lead is how far the nose runs ahead of the camera, out how far the
     * camera stands off to the side on its way up.
     */
    const ROOF = Object.freeze({ name: 'ROOF', lead: 13, height: 4.95, out: 2.6, pitch: -0.07, fov: 4, sky: 0.12, blend: 6 });
    const rides = new WeakMap();
    const rideSpans = timeline => {
        let spans = rides.get(timeline);
        if (!spans) {
            spans = [];
            let verse = 0;
            for (const act of timeline.acts) {
                if (act.kind !== 'Verse') continue;
                const length = act.end - act.start, visit = verse++;
                // Every other verse goes up for the whole verse; the others ride
                // their second half up there when they are long enough to.
                if (visit % 2) { if (length >= 2.5 * ROOF.blend) spans.push({ start: act.start, end: act.end }); }
                else if (length >= 30) spans.push({ start: act.start + length * 0.45, end: act.end });
            }
            rides.set(timeline, spans);
        }
        return spans;
    };
    // How far along the way up to the roof the camera is at this time, and
    // which span of the song's that is and whether it is on its way out.
    const rideAt = (timeline, t, detail) => {
        const spans = rideSpans(timeline), index = upperBound(spans, t, 'start') - 1, span = spans[index];
        if (!span || t > span.end) return 0;
        if (detail) { detail.index = index; detail.leaving = t > (span.start + span.end) / 2; }
        return Math.min(clamp((t - span.start) / ROOF.blend), clamp((span.end - t) / ROOF.blend));
    };
    // The saloon camera rides at seated eye level, measured back from the nose.
    const SALOON = Object.freeze({ back: 9.1, travel: 2.4, lateral: 0.11, height: 2.34, sill: 2.35 });
    const TRACKSIDE = Object.freeze({ lateral: 6.5, height: 1.5 });
    /*
     * Beside the line the camera goes on ahead of the train first, out to the
     * waterside, and stands there; the train comes up behind it and runs on
     * past into the picture; then the camera follows it along the first car
     * and climbs back in at the front. This is how far the nose is ahead of the camera.
     */
    const TRACKSIDE_AHEAD = 18, TRACKSIDE_PAST = 22;
    const passing = progress => -0.4 - (TRACKSIDE_AHEAD - 0.4) * glide(progress / 0.28)
        + (TRACKSIDE_AHEAD + TRACKSIDE_PAST) * glide((progress - 0.28) / 0.28)
        - (TRACKSIDE_PAST + 0.4) * glide((progress - 0.58) / 0.28);
    const sceneAt = (track, t) => {
        const scenes = track.scenes || [];
        const scene = scenes[upperBound(scenes, t + SCENE_RAISE, 'start') - 1];
        if (!scene || t > scene.end + SCENE_RAISE) return null;
        const opening = scene.start === 0;
        const weight = (opening ? 1 : ease((t - scene.start) / SCENE_BLEND)) * (1 - ease((t - scene.end + SCENE_BLEND) / SCENE_BLEND));
        // The cab view is lifted to window height a little before and after, so
        // the way in and out of the car goes through the windscreen and not the floor.
        const raised = (opening ? 1 : ease((t - scene.start + SCENE_RAISE) / SCENE_RAISE))
            * (1 - ease((t - scene.end) / SCENE_RAISE));
        return { scene, weight, raised, progress: clamp((t - scene.start) / (scene.end - scene.start)) };
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
    const motionOf = options => options.reducedMotion ? 0 : clamp(options.motionAmount ?? 1, 0, 2)
        * clamp(options.animationIntensity ?? 1, 0, 2);
    // How far the nose of the train runs ahead of the camera.
    const leadAt = (timeline, scenes, t, motion) => {
        if (!motion) return -0.4;
        const state = timeline.sample(t);
        const act = timeline.acts[state.actIndex];
        const move = crane(act, timeline.acts[Math.max(0, state.actIndex - 1)], t, timeline);
        const staged = sceneAt({ scenes }, t);
        const beside = staged?.scene.kind === 'TRACKSIDE' ? staged : null;
        const riding = rideAt(timeline, t);
        if (beside) return passing(beside.progress);
        return Math.max(mix(-0.4, move.rig.lead, move.lead),
            riding > 0 ? mix(-0.4, ROOF.lead, ease((riding - 0.15) / 0.45)) : -Infinity);
    };
    /*
     * The train never runs backwards and the camera never flies back down the
     * line. When the train is to draw ahead the camera first slows, down to
     * standing still beside the line, and only the rest is the train speeding
     * up; when it is to be caught up the camera hurries after it, and the train
     * gives way a little, never below a third of its speed. Both are worked out
     * once from the song, as a schedule along the line: screens, stations and
     * everything else that is set out for the camera use the camera's own.
     */
    const trainPath = (timeline, scenes, speed, options = {}) => {
        const motion = motionOf(options);
        const duration = timeline.duration;
        const step = Math.max(1 / 30, duration / 120000);
        const count = Math.max(1, Math.ceil(duration / step));
        const train = new Float64Array(count + 1), camera = new Float64Array(count + 1);
        let base = timeline.distanceAt(0, speed), lead = leadAt(timeline, scenes, 0, motion), ahead = 0;
        train[0] = base - 0.4; camera[0] = train[0] - lead;
        for (let i = 1; i <= count; i++) {
            const t = Math.min(duration, i * step);
            const next = timeline.distanceAt(t, speed), travel = next - base;
            const nextLead = leadAt(timeline, scenes, t, motion), change = nextLead - lead;
            ahead += change > 0 ? Math.max(0, change - travel) : -Math.min(-change, travel * 0.65);
            base = next; lead = nextLead;
            train[i] = base - 0.4 + ahead;
            // Never behind where it was a moment ago, whatever rounding says.
            camera[i] = Math.max(camera[i - 1], train[i] - lead);
        }
        const sampler = values => time => {
            const t = clamp(time, 0, duration);
            const i = Math.min(count - 1, Math.floor(t / step));
            const span = Math.min(duration, (i + 1) * step) - i * step;
            return mix(values[i], values[i + 1], clamp((t - i * step) / Math.max(1e-9, span)));
        };
        const addressAt = sampler(camera);
        // When the camera reaches an address along the line.
        const timeAt = address => {
            let lo = 0, hi = count;
            while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (camera[mid] < address) lo = mid; else hi = mid; }
            const a = camera[lo], b = camera[hi];
            return clamp(Math.min(duration, (lo + (b > a ? clamp((address - a) / (b - a)) : 0)) * step), 0, duration);
        };
        return { addressAt, trainAt: sampler(train), timeAt };
    };
    const pose = (timeline, track, time, options = {}) => {
        const t = clamp(time, 0, timeline.duration);
        const state = timeline.sample(t);
        const motion = motionOf(options);
        const distance = timeline.distanceAt(t, options.cameraSpeed ?? 1);
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
        const move = crane(act, previous, t, timeline);
        const staged = motion ? sceneAt(track, t) : null;
        const inside = staged?.scene.kind === 'SALOON' ? staged : null;
        const beside = staged?.scene.kind === 'TRACKSIDE' ? staged : null;
        // Out to the waterside, the train past, the train caught up, back in: in that order.
        const aside = beside ? ease(beside.progress / 0.25) * (1 - ease((beside.progress - 0.8) / 0.2)) : 0;
        const rideSpan = {};
        const riding = motion ? rideAt(timeline, t, rideSpan) : 0;
        const rideSide = riding > 0 ? track.rideSides?.[rideSpan.index]?.[rideSpan.leaving ? 'exit' : 'entry'] ?? 1 : 1;
        const ride = {
            out: ease(riding / 0.3) * (1 - ease((riding - 0.7) / 0.3)),
            lead: ease((riding - 0.15) / 0.45),
            up: ease((riding - 0.45) / 0.3),
            over: ease((riding - 0.7) / 0.3)
        };
        // The train keeps to the speed of the song whatever the camera does: it
        // is the camera that moves along the line to frame it. Drawing the train
        // ahead of the camera, or catching it up, never runs the train backwards.
        const rel = leadAt(timeline, track.scenes, t, motion);
        const trainFront = track.trainAt ? track.trainAt(t) : distance - 0.4, along = trainFront - rel;
        const frame = track.at(along);
        if (riding > 0) move.height = mix(move.height, ROOF.height, ride.up);
        if (inside) move.height = mix(move.height, Math.max(move.height, SALOON.sill), inside.raised);
        if (beside) move.height = mix(move.height, TRACKSIDE.height, aside);
        const position = {
            x: frame.position.x + frame.right.x * (-0.25 + n(0.8, 1) * 0.025 * handheld),
            y: (motion ? move.height : 2.2) + Math.sin(t * Math.PI * 0.4) * 0.01 * handheld
                + n(1.3, 2) * 0.018 * handheld + timeline.rhythmAt(t).impulse * 0.012 * handheld,
            z: frame.position.z + frame.right.z * -0.25
        };
        position.x += frame.right.x * lateralTravel + frame.forward.x * push;
        position.z += frame.right.z * lateralTravel + frame.forward.z * push;
        position.y += lift;
        // Low acts are seen from the cab. When the camera rises it also leaves the
        // train: it swings out to one side and lets the train run ahead, so the
        // high acts look down on lit carriages crossing the water.
        const chase = motion ? Math.max(move.out, aside, ease(riding / 0.15)) : 0;
        // On the roof the camera sits on the centre line, not over the driver's seat.
        const swing = motion ? move.rig.lateral * move.out + TRACKSIDE.lateral * aside
            + (rideSide * ROOF.out + 0.25) * ride.out + 0.25 * ride.over : 0;
        position.x += frame.right.x * swing;
        position.z += frame.right.z * swing;
        // A rig that looks back at the train turns as the train falls behind it,
        // keeping the cab in view as it goes by instead of spinning round in its path.
        const lookBack = (() => {
            if (!motion) return 0;
            if (Math.abs(move.rig.yaw) <= 1.5) return move.out;
            const across = Math.abs(move.rig.lateral) * move.out;
            const behind = Math.max(0.01, -mix(-0.4, move.rig.lead, move.lead));
            const settled = Math.PI - Math.atan2(Math.abs(move.rig.lateral), -move.rig.lead);
            return Math.min(1, (Math.PI - Math.atan2(across, behind)) / settled) * ease(move.lead / 0.7);
        })();
        let yaw = frame.yaw + yawBias + n(0.55, 3) * 0.003 * handheld
            + directionSign * arch * openness * 0.012 * strength + move.rig.yaw * lookBack;
        let pitch = mix(-0.025, -0.12, state.openness) + move.rig.pitch * (motion ? move.out : 0);
        const finale = state.act === 'Terminus' && motion && !timeline.isSinging(t)
            ? smooth((t - act.start) / Math.max(1, act.end - act.start)) : 0;
        // A stationary roadside screen owns the gaze, never the train position.
        // Derive the blend analytically so seeking midway through a handoff is exact.
        const encounters = track.encounters || [];
        const encounterIndex = upperBound(encounters, t, 'start') - 1;
        const encounter = encounters[encounterIndex];
        const upcoming = encounters[encounterIndex + 1];
        const blendAngle = (a, b, weight) => a
            + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * weight;
        let fov = motion ? state.fov - arch * (1.2 + openness * 1.8) * strength + move.rig.fov * move.out + ROOF.fov * ride.over : 48;
        const halfFrame = Math.atan(Math.tan(fov * Math.PI / 360) * Math.max(0.35, options.aspect || 1.6)) * 0.84;
        // A screen is read from its own side of the frame, with the line ahead
        // still in view: the camera turns only as far as it takes to hold the
        // whole screen inside the picture. Going from one screen to the next is
        // then a short pan across the track instead of a swing from side to side.
        const aim = item => {
            const dx = item.position.x - position.x;
            const dz = item.position.z - position.z;
            const reach = Math.hypot(dx, dz);
            const pitch = Math.atan2(item.position.y - position.y, reach);
            const full = Math.atan2(dx, -dz);
            if (!item.width) return { yaw: full, pitch };
            const off = Math.atan2(Math.sin(full - frame.yaw), Math.cos(full - frame.yaw));
            const needed = Math.abs(off) + Math.atan(item.width * 0.5 / reach) - halfFrame;
            // From the roof the gaze stays down the line, so a screen stands
            // out to its own side of the pantograph instead of behind it.
            const turn = Math.min(Math.abs(off), Math.max(needed, Math.abs(off) * 0.6 * (1 - Math.max(ride.lead, ride.out))));
            return { yaw: frame.yaw + Math.sign(off) * turn, pitch };
        };
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
            const release = Math.min(upcoming ? Math.min(4, Math.max(0.1, upcoming.start - encounter.end)) : 4,
                Math.max(0.8, encounter.skyStart - encounter.end));
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
        // On the roof the gaze is tipped down after a screen has taken it, so
        // the nose and the lamp stay in the bottom of the picture.
        pitch += ROOF.pitch * ride.over;
        // Apply after roadside gaze release so the last sign cannot cancel the skyward finale.
        // The moon uses this same fixed celestial offset in the world renderer.
        yaw = blendAngle(yaw, Math.atan2(-210, 420), finale);
        pitch = mix(pitch, Math.atan2(300 - position.y, Math.hypot(210, 420)), finale);
        pitch += n(0.7, 4) * 0.0025 * handheld * (1 - finale);
        let roll = motion ? n(0.45, 5) * 0.002 * handheld + directionSign * arch * openness * 0.006 * strength : 0;
        if (aside > 0) {
            // From the waterside the camera looks back in over the line, level
            // with the windows, and the train comes through the picture.
            yaw = blendAngle(yaw, frame.yaw - 0.34, aside);
            pitch = mix(pitch, 0.015, aside);
            fov = mix(fov, 52, aside);
        }
        if (inside && inside.weight > 0) {
            // Ride low in the aisle, so the leading benches frame the view.
            const w = inside.weight, side = inside.scene.side;
            const seat = trainFront + 0.4 - SALOON.back + SALOON.travel * inside.progress;
            const car = track.at(seat);
            const offset = -side * SALOON.lateral + Math.sin(t * 0.9) * 0.015;
            position.x = mix(position.x, car.position.x + car.right.x * offset, w);
            position.z = mix(position.z, car.position.z + car.right.z * offset, w);
            position.y = mix(position.y, SALOON.height + Math.sin(t * 1.7) * 0.006, w);
            yaw = blendAngle(yaw, car.yaw + side * 0.24 + Math.sin(t * 0.23) * 0.05, w);
            pitch = mix(pitch, 0.028, w);
            fov = mix(fov, 61, w);
            roll = mix(roll, Math.sin(t * 1.1) * 0.004, w);
        }
        const cp = Math.cos(pitch);
        const direction = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
        // Where a line on the sky is written for this view.
        const out = motion ? move.out : 0;
        // Even from the cab a line on the sky is written above the horizon, clear of
        // the poles and the far shore that gather where the line ahead runs out.
        const skyYaw = yaw + move.rig.skyYaw * out, skyPitch = pitch + mix(0.08, move.rig.skyPitch, out) + ROOF.sky * ride.over;
        const sky = { x: Math.sin(skyYaw) * Math.cos(skyPitch), y: Math.sin(skyPitch),
            z: -Math.cos(skyYaw) * Math.cos(skyPitch) };
        return {
            position, direction, yaw, pitch, sky, skyYaw,
            roll, fov, eventFocus, finale,
            // How far the saloon has to be there to be seen or passed through.
            saloon: inside ? inside.raised : 0,
            // How much of the picture is the lit saloon itself, for the lens.
            cabinView: inside ? inside.weight : 0,
            // The saloon at sundown has the low sun in it; it empties as the song
            // turns inward, and in an interlude nobody is left aboard.
            cabinSunset: state.dusk ?? 0,
            cabinEmpty: Math.max(state.dream ?? 0, act?.kind === 'Interlude' ? 1 : 0.6),
            scene: staged && staged.weight > 0 ? { id: staged.scene.id, kind: staged.scene.kind, weight: staged.weight } : null,
            shot: openness > 0.6 ? 'rising-traverse' : 'window-tracking',
            rig: !motion ? 'CAB' : staged && staged.weight > 0.5 ? staged.scene.kind : rig,
            encounterId, reading, distance: along, state, chase, chaseRig: move.out > 0.5 ? move.rig.name : null,
            ride: riding > 0 ? ROOF.name : null,
            // Where the front of the train is along the line.
            trainFront,
            look: { x: position.x + direction.x * 30, y: position.y + direction.y * 30,
                z: position.z + direction.z * 30 }
        };
    };
    global.MusicStageDioramaCamera = Object.freeze({ createTrack, pose, noise, readingEnvelope, planScenes });
})(window);
