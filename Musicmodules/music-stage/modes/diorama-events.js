(function (global) {
    'use strict';
    const R = global.MusicStageRuntime;
    const D = global.MusicStageDioramaDirector;
    const { clamp, seededRandom } = R;
    const smooth = D.smooth;
    // Conservative swept footprint: includes the rabbit's body/ears, not just feet.
    const rabbitPathClear = (event, track, options = {}) => {
        const boxes = [];
        const enabled = options.narrativeStations !== false && (options.stationIntensity ?? 1) > 0;
        if (enabled) {
            // Local addresses only: compilation cost does not grow with song length.
            const address = event.address ?? event.trackAddress ?? 0;
            for (let id = Math.max(0, Math.floor((address - 180) / 110)); id <= Math.ceil((address + 180) / 110); id++) {
                const f = track.at(id * 110 + 38);
                const side = id % 2 ? 1 : -1;
                boxes.push({ frame: f, x: side * 8.7, z: 0, hx: 5.8, hz: 17 });
            }
            const spacing = 16 / clamp(options.stationIntensity ?? 1, 0.5, 2);
            for (let id = Math.floor((address - 100) / spacing); id <= Math.ceil((address + 100) / spacing); id++)
                boxes.push({ frame: track.at(id * spacing), x: -3.4, z: 0, hx: 0.2, hz: 0.2 });
        }
        for (const sign of track.encounters || []) {
            if (Math.hypot(sign.position.x - event.anchor.x, sign.position.z - event.anchor.z) > 60) continue;
            boxes.push({ frame: { position: sign.position,
                right: { x: Math.cos(sign.yaw), z: Math.sin(sign.yaw) },
                forward: { x: Math.sin(sign.yaw), z: -Math.cos(sign.yaw) } },
                x: 0, z: 0, hx: sign.width / 2 + 0.5, hz: 0.4 });
        }
        const local = (p, box) => {
            const dx = p.x - box.frame.position.x, dz = p.z - box.frame.position.z;
            return [dx * box.frame.right.x + dz * box.frame.right.z - box.x,
                dx * box.frame.forward.x + dz * box.frame.forward.z - box.z];
        };
        for (let step = 0; step < 7; step++) {
            const a = rabbitAt(event, 0.6 + step * 0.8), b = rabbitAt(event, 0.6 + (step + 1) * 0.8);
            for (const box of boxes) {
                const p = local(a, box), q = local(b, box);
                let enter = 0, exit = 1;
                for (let axis = 0; axis < 2; axis++) {
                    const half = (axis ? box.hz : box.hx) + 1.6;
                    const delta = q[axis] - p[axis];
                    if (Math.abs(delta) < 1e-9) {
                        if (Math.abs(p[axis]) > half) { enter = 2; break; }
                    } else {
                        const t0 = (-half - p[axis]) / delta, t1 = (half - p[axis]) / delta;
                        enter = Math.max(enter, Math.min(t0, t1));
                        exit = Math.min(exit, Math.max(t0, t1));
                    }
                }
                if (enter <= exit) return false;
            }
        }
        return true;
    };
    // Compile once. No live audio, frame counters, or random births.
    const compile = (timeline, track, options = {}) => {
        const events = [];
        const occupied = timeline.protectedIntervals.map(i => ({ start: i.start - 2, end: i.end + 2.5 }));
        const gaps = [];
        let cursor = 5;
        for (const interval of occupied) {
            if (interval.start > cursor) gaps.push({ start: cursor, end: interval.start });
            cursor = Math.max(cursor, interval.end);
        }
        if (cursor < timeline.duration - 1) gaps.push({ start: cursor, end: timeline.duration - 1 });
        const random = seededRandom(`${timeline.seed}:encounters`);
        let whale = false, lastEnd = -25;
        for (const gap of gaps) {
            for (let start = Math.max(gap.start, lastEnd + 24); start < gap.end; start = lastEnd + 24) {
            const available = gap.end - start;
            if (available < 2.8) break;
            const act = timeline.sample(start);
            let kind = 'meteor', duration = 2.8;
            if (!whale && available >= 11 && start > 20 && ['Open', 'Interlude', 'Chorus'].includes(act.act)) {
                kind = 'whale'; duration = 11; whale = true;
            } else if (options.fireworks === true && available >= 6
                && timeline.acts.some(a => a.kind === 'Chorus' && a.end <= start && start - a.end < 12)) {
                kind = 'fireworks'; duration = 6;
            } else if (available >= 8 && start > 12) {
                kind = 'rabbit'; duration = 8;
            }
            const side = random() > 0.5 ? 1 : -1;
            const address = timeline.distanceAt(start + duration * 0.5, options.cameraSpeed ?? 1)
                + (kind === 'whale' ? 70 : kind === 'rabbit' ? 24 : 200);
            const frame = track.at(address);
            events.push({
                id: events.length, kind, start, end: start + duration, duration, side, address,
                seed: `${timeline.seed}:${kind}:${events.length}`,
                anchor: { ...frame.position }, right: { ...frame.right }, forward: { ...frame.forward },
                yaw: frame.yaw, readingClearance: 'silent-window', reflection: true,
                budget: { points: kind === 'whale' ? 1800 : 900, ripples: 12 }
            });
            lastEnd = start + duration;
            }
        }
        // Small encounters may start in ordinary breaths. They do not own
        // the camera and are placed using the planned view, not track forward.
        const free = (start, end) => !events.some(e => start < e.end + 12 && end > e.start - 12);
        const add = (kind, start, duration, frame, side, extra = {}) => {
            events.push({ id: events.length, kind, start, end: start + duration, duration, side,
                seed: `${timeline.seed}:${kind}:${start}`, anchor: { ...frame.position },
                right: { ...frame.right }, forward: { ...frame.forward }, yaw: frame.yaw,
                readingClearance: 'peripheral', reflection: true,
                budget: { points: 900, ripples: 12 }, ...extra });
        };
        // Fireworks get a chance before the small encounters consume the breath.
        if (options.fireworks === true) {
            let previous = -40;
            for (const phrase of timeline.phrases) {
                const start = phrase.end + 0.2;
                if (timeline.sample(phrase.start).act !== 'Chorus'
                    || start - previous < 32 || start + 6 > timeline.duration || !free(start, start + 6)) continue;
                const view = global.MusicStageDioramaCamera.pose(timeline, track, start + 2, options);
                const forward = { x: Math.sin(view.yaw), y: 0, z: -Math.cos(view.yaw) };
                add('fireworks', start, 6, { yaw: view.yaw, forward,
                    right: { x: Math.cos(view.yaw), y: 0, z: Math.sin(view.yaw) },
                    position: { x: view.position.x + forward.x * 180, y: 0,
                        z: view.position.z + forward.z * 180 } }, 1, { viewPlaced: true });
                previous = start;
            }
        }
        let smallIndex = 0;
        for (let i = 0; i + 1 < timeline.protectedIntervals.length; i++) {
            const a = timeline.protectedIntervals[i], b = timeline.protectedIntervals[i + 1];
            const start = a.end + 0.15;
            if (b.start - start < 0.8 || start < 8) continue;
            const kind = smallIndex % 2 ? 'rabbit' : 'meteor';
            const duration = kind === 'rabbit' ? 8 : 2.8;
            if (start + duration > timeline.duration || !free(start, start + duration)) continue;
            const pose = global.MusicStageDioramaCamera.pose(timeline, track, start + 1.4, options);
            const distance = kind === 'rabbit' ? 32 : 180;
            const right = { x: Math.cos(pose.yaw), y: 0, z: Math.sin(pose.yaw) };
            const forward = { x: Math.sin(pose.yaw), y: 0, z: -Math.cos(pose.yaw) };
            // Rabbit stays below the lyric slot; meteor above it.
            const frame = { yaw: pose.yaw, right, forward, position: {
                x: pose.position.x + forward.x * distance,
                y: 0, z: pose.position.z + forward.z * distance
            } };
            add(kind, start, duration, frame, smallIndex % 2 ? -1 : 1, { viewPlaced: true,
                trackAddress: timeline.distanceAt(start + 1.4, options.cameraSpeed ?? 1) + distance });
            smallIndex++;
        }
        if (options.narrativeStations !== false && (options.stationIntensity ?? 1) > 0) {
            const speed = options.cameraSpeed ?? 1;
            const total = timeline.distanceAt(timeline.duration, speed);
            for (let id = 0; id * 110 + 38 < total; id += 2) {
                const address = id * 110 + 38;
                let lo = 0, hi = timeline.duration;
                for (let j = 0; j < 28; j++) {
                    const mid = (lo + hi) / 2;
                    if (timeline.distanceAt(mid, speed) < address - 23) lo = mid; else hi = mid;
                }
                const start = (lo + hi) / 2;
                if (start < 2 || start + 6 > timeline.duration || !free(start, start + 6)) continue;
                const f = track.at(address);
                const side = id % 2 ? 1 : -1;
                const view = global.MusicStageDioramaCamera.pose(timeline, track, start + 1, options);
                const p = worldPoint({ anchor: f.position, right: f.right, forward: f.forward }, side * 4.8, 0, 1.5);
                const bearing = Math.atan2(p.x - view.position.x, view.position.z - p.z);
                const angle = Math.atan2(Math.sin(bearing - view.yaw), Math.cos(bearing - view.yaw));
                const halfFov = Math.atan(Math.tan(view.fov * Math.PI / 360) * (options.aspect || 1.6));
                if (Math.abs(angle) > halfFov * 0.85) continue;
                add('pigeons', start, 6, f, side, { stationId: id, address });
            }
        }
        // Perched birds need no long spectacle cooldown, but never overlap a pool owner.
        const birdFree = start => !events.some(e => start < e.end + 2 && start + 7 > e.start - 2);
        for (const sign of track.encounters || []) {
            if (sign.id % 3 === 2) continue;
            const start = Math.max(0, sign.start - 1);
            if (start + 7 > timeline.duration || !birdFree(start)) continue;
            const yaw = sign.yaw;
            const right = { x: Math.cos(yaw), y: 0, z: Math.sin(yaw) };
            const forward = { x: Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
            add('pigeons', start, 7, { position: sign.position, right, forward, yaw }, sign.side,
                { perch: 'sign', encounterId: sign.id, birdCount: 2, takeoff: 3,
                    perchPosition: { x: sign.position.x + forward.x * 0.12,
                        y: sign.position.y + sign.height / 2 + 0.4 + 0.035 + 0.32,
                        z: sign.position.z + forward.z * 0.12 } });
        }
        if (options.narrativeStations !== false && (options.stationIntensity ?? 1) > 0) {
            const spacing = 16 / clamp(options.stationIntensity ?? 1, 0.5, 2);
            const speed = options.cameraSpeed ?? 1;
            for (let start = 10; start + 7 < timeline.duration; start += 13) {
                if (!birdFree(start)) continue;
                const address = Math.ceil((timeline.distanceAt(start, speed) + 18) / spacing) * spacing;
                const id = Math.round(address / spacing);
                if (id % 7 === 3) continue;
                let lo = 0, hi = timeline.duration;
                for (let j = 0; j < 24; j++) {
                    const mid = (lo + hi) / 2;
                    if (timeline.distanceAt(mid, speed) < address) lo = mid; else hi = mid;
                }
                if (timeline.sample((lo + hi) / 2).density < 0.4 && id % 4 !== 0) continue;
                const f = track.at(address);
                const p = worldPoint({ anchor: f.position, ...f }, -3.05, 0, 6.16);
                const view = global.MusicStageDioramaCamera.pose(timeline, track, start + 1, options);
                const angle = Math.atan2(p.x - view.position.x, view.position.z - p.z) - view.yaw;
                if (Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)))
                    > Math.atan(Math.tan(view.fov * Math.PI / 360) * (options.aspect || 1.6)) * 0.85) continue;
                add('pigeons', start, 7, f, -1, { perch: 'lamp', poleId: id, address,
                    birdCount: 1, takeoff: 3, perchPosition: p });
            }
        }
        // Shift the entire deterministic path, not the current frame. Reject
        // unsafe routes when no nearby water corridor fits the whole sweep.
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.kind !== 'rabbit') continue;
            const original = { ...event.anchor };
            let safe = false;
            for (const shift of [0, 5, -5, 10, -10, 16, -16, 23, -23]) {
                event.anchor = { ...original, x: original.x + event.right.x * shift,
                    z: original.z + event.right.z * shift };
                if (rabbitPathClear(event, track, options)) { safe = true; break; }
            }
            if (!safe) events.splice(i, 1);
            else event.collisionClearance = 1.6;
        }
        events.sort((a, b) => a.start - b.start);
        events.forEach((e, i) => { e.id = i; });
        return events;
    };
    const worldPoint = (event, lateral, ahead, y) => ({
        x: event.anchor.x + event.right.x * lateral + event.forward.x * ahead,
        y,
        z: event.anchor.z + event.right.z * lateral + event.forward.z * ahead
    });
    const rabbitAt = (event, age) => {
        const cycle = clamp((age - 0.6) / 0.8, 0, 7);
        const step = Math.min(6, Math.floor(cycle));
        const phase = cycle - step;
        const flight = clamp((phase - 0.16) / 0.72);
        const blend = smooth(flight);
        const landing = n => ({
            lateral: event.side * (event.viewPlaced ? 3 : 10) + (n % 2 ? 1.8 : -1.8),
            ahead: -10 + n * 3.1
        });
        const a = landing(step), b = landing(step + 1);
        const lateral = a.lateral + (b.lateral - a.lateral) * blend;
        const ahead = a.ahead + (b.ahead - a.ahead) * blend;
        const hop = Math.sin(Math.PI * flight);
        const crouch = (1 - smooth(phase / 0.16)) * 0.16
            + smooth((phase - 0.88) / 0.12) * 0.16;
        const direction = Math.atan2(b.lateral - a.lateral, b.ahead - a.ahead);
        const previous = step ? -direction : direction;
        const turn = previous + (direction - previous) * smooth(phase / 0.35);
        return { ...worldPoint(event, lateral, ahead, 0.55 + hop * 1.25 - crouch),
            hop, phase, flight, crouch, turn, lateral, ahead, travel: cycle / 7 };
    };
    const sample = (event, time) => {
        const age = time - event.start;
        if (time < event.start || time >= event.end) return null;
        const progress = age / event.duration;
        const fade = smooth(age / 0.65) * (1 - smooth((age - event.duration + 1.2) / 1.2));
        const ripples = [];
        let body = null, stage = 'passing';
        if (event.kind === 'rabbit') {
            body = rabbitAt(event, age);
            for (let step = 0; step <= 7; step++) {
                const contact = 0.6 + step * 0.8;
                const elapsed = age - contact;
                if (elapsed < 0 || elapsed > 2.2) continue;
                const foot = rabbitAt(event, contact);
                for (const offset of [-0.28, 0.28]) ripples.push({
                    ...worldPoint(event, foot.lateral + offset, foot.ahead, 0.045),
                    radius: 0.15 + elapsed * 1.6, opacity: (1 - elapsed / 2.2) * 0.4
                });
            }
        } else if (event.kind === 'pigeons') {
            body = { ...(event.perchPosition || worldPoint(event, event.side * 4.8, 0, 1.5)), age };
            stage = age < (event.takeoff ?? 1) ? 'perched' : 'flight';
        } else if (event.kind === 'whale') {
            stage = age < 2 ? 'omen' : age < 3 ? 'emerge' : age < 5 ? 'rise'
                : age < 6 ? 'cross' : age < 7.5 ? 'land' : 'afterglow';
            const leap = clamp((age - 2) / 5.5);
            body = { ...worldPoint(event, event.side * (26 - leap * 52), 0,
                -3 + Math.sin(leap * Math.PI) * 16 - 10 * smooth((age - 6.5) / 2)), leap };
            for (const contact of [0, 2.2, 7.1]) {
                const elapsed = age - contact;
                if (elapsed < 0 || elapsed > 4) continue;
                ripples.push({ ...worldPoint(event, event.side * (contact < 3 ? 25 : -25), 0, 0.05),
                    radius: 2 + elapsed * 5, opacity: smooth(elapsed / 0.3) * (1 - elapsed / 4) * 0.5 });
            }
        }
        return { id: event.id, kind: event.kind, age, progress, fade, body, stage, ripples };
    };
    const create = (T, scene) => {
        const root = new T.Group();
        scene.add(root);
        const capacity = 1800;
        const positions = new Float32Array(capacity * 3);
        const colors = new Float32Array(capacity * 3);
        const geometry = new T.BufferGeometry();
        geometry.setAttribute('position', new T.BufferAttribute(positions, 3).setUsage(T.DynamicDrawUsage));
        geometry.setAttribute('color', new T.BufferAttribute(colors, 3).setUsage(T.DynamicDrawUsage));
        const material = new T.PointsMaterial({ size: 0.12, transparent: true, opacity: 0.8,
            vertexColors: true, depthWrite: false, fog: false });
        const points = new T.Points(geometry, material);
        points.frustumCulled = false;
        root.add(points);
        const linePositions = new Float32Array(12000);
        const lineGeometry = new T.BufferGeometry();
        lineGeometry.setAttribute('position', new T.BufferAttribute(linePositions, 3).setUsage(T.DynamicDrawUsage));
        const lineMaterial = new T.LineBasicMaterial({ color: '#cde9e2', transparent: true,
            opacity: 0.85, depthWrite: false });
        const outlines = new T.LineSegments(lineGeometry, lineMaterial);
        outlines.frustumCulled = false;
        root.add(outlines);
        let lineCursor = 0;
        const contour = (knots, transform, closed = false) => {
            const curve = new T.CatmullRomCurve3(knots.map(p => new T.Vector3(...p)), closed, 'centripetal');
            const divisions = knots.length * 5;
            let previous = transform(curve.getPoint(0));
            for (let i = 1; i <= divisions; i++) {
                const next = transform(curve.getPoint(i / divisions));
                if (lineCursor + 6 > linePositions.length) break;
                previous.toArray(linePositions, lineCursor);
                next.toArray(linePositions, lineCursor + 3);
                lineCursor += 6;
                previous = next;
            }
        };
        const drawAnimal = (event, performance) => {
            lineCursor = 0;
            const pose = performance.body;
            const yaw = event.yaw + (event.kind === 'rabbit' ? pose.turn : 0);
            const cy = Math.cos(yaw), sy = Math.sin(yaw);
            const transform = (offset = [0, 0, 0]) => p => {
                const x = p.x + offset[0], y = p.y + offset[1], z = p.z + offset[2];
                return new T.Vector3(pose.x + x * cy - z * sy, pose.y + y,
                    pose.z + x * sy + z * cy);
            };
            if (event.kind === 'rabbit') {
                const tuck = pose.hop * 0.35;
                for (const side of [-1, 1]) {
                    const x = side * 0.25;
                    const tr = transform();
                    // Back, cheek, nose, chest and belly form one readable outline.
                    contour([[x,0.05,0.85],[x,0.48,0.55],[x,0.58,-0.15],
                        [x,0.85,-0.55],[x,0.82,-0.91],[x,0.62,-1.14],
                        [x,0.4,-0.98],[x,0.18,-0.55],[x,-0.2,-0.35],
                        [x,-0.24,0.4],[x,0.05,0.85]], tr);
                    const lag = Math.sin(pose.flight * Math.PI * 2 - 0.6) * 0.18;
                    contour([[x,0.8,-0.62],[x+side*0.09,1.36,-0.5+lag],
                        [x+side*0.12,1.88,-0.55+lag],[x,1.72,-0.72+lag],
                        [x-side*0.06,0.83,-0.79]], tr, true);
                    contour([[x,0.05,-0.48],[x,-0.22+tuck,-0.56],
                        [x,-0.5+tuck,-0.79],[x,-0.51+tuck,-1.02],
                        [x,-0.4+tuck,-0.66],[x,0.05,-0.48]], tr);
                    contour([[x,0.23,0.53],[x+side*0.12,-0.07,0.78],
                        [x,-0.36+tuck,0.5],[x,-0.53+tuck,0.13],
                        [x,-0.5+tuck,-0.17],[x,-0.31+tuck,0.1],[x,0.23,0.53]], tr);
                    contour([[x,0.67,-0.85],[x+side*0.025,0.7,-0.88],
                        [x,0.72,-0.85]], tr, true);
                }
                contour([[-0.18,0.16,0.8],[0,0.42,1.1],[0.18,0.16,0.8],[0,0,0.95]], transform(), true);
            } else {
                for (let bird = 0; bird < (event.birdCount ?? 3); bird++) {
                    const flight = Math.max(0, pose.age - (event.takeoff ?? 1) - bird * 0.22);
                    const lift = flight * smooth(flight / 0.4);
                    const tr = transform([(event.perch ? bird - ((event.birdCount ?? 1) - 1) / 2 : bird) * 0.85
                        + lift * 0.8, lift * 1.7, (event.perch ? 0 : bird * 0.7) - lift * 3]);
                    const opening = smooth(flight / 0.3);
                    const flap = Math.sin(flight * 11) * opening;
                    for (const side of [-1, 1]) {
                        const x = side * 0.13;
                        contour([[x,0,0.35],[x,0.22,0],[x,0.4,-0.25],
                            [x,0.37,-0.48],[x,0.27,-0.64],[x,0.22,-0.44],
                            [x,-0.12,-0.1],[x,-0.16,0.3]], tr, true);
                        // Shoulder -> elbow -> wrist -> feather tips -> shoulder.
                        const wing = (u, z) => [side * (0.12 + u * (0.2 + opening * 0.8)),
                            0.13 + u * flap * 0.65, z + (1 - opening) * u * 0.5];
                        contour([[x,0.13,-0.08],wing(0.45,-0.2),wing(0.9,-0.12),
                            wing(1.25,0.08),wing(1.1,0.24),wing(0.8,0.36),
                            wing(0.4,0.3),[x,0.08,0.18]], tr, true);
                        for (let feather = 0; feather < 4; feather++)
                            contour([wing(0.5,0.12),wing(0.8+feather*0.12,0.34-feather*0.06)], tr);
                        contour([[x,-0.12,0.05],[x,-0.3+opening*0.2,0.14],
                            [x,-0.32+opening*0.2,-0.03]], tr);
                    }
                    contour([[-0.1,0,0.27],[-0.28,-0.04,0.72],[0,0,0.64],
                        [0.28,-0.04,0.72],[0.1,0,0.27]], tr, true);
                }
            }
            lineGeometry.setDrawRange(0, lineCursor / 3);
            lineGeometry.attributes.position.needsUpdate = true;
        };
        const ringGeometry = new T.RingGeometry(0.94, 1, 48);
        const ringMaterial = new T.MeshBasicMaterial({ color: '#76bfae', transparent: true,
            opacity: 0.35, depthWrite: false, side: T.DoubleSide, forceSinglePass: true });
        const rings = new T.InstancedMesh(ringGeometry, ringMaterial, 12);
        rings.instanceMatrix.setUsage(T.DynamicDrawUsage);
        rings.frustumCulled = false;
        root.add(rings);
        const bodyGeometry = new T.SphereGeometry(1, 16, 10);
        const bodyMaterial = new T.MeshBasicMaterial({ color: '#76bfae', transparent: true,
            opacity: 0.085, depthWrite: false });
        const volumes = new T.InstancedMesh(bodyGeometry, bodyMaterial, 12);
        volumes.instanceMatrix.setUsage(T.DynamicDrawUsage);
        volumes.frustumCulled = false;
        root.add(volumes);
        const dummy = new T.Object3D(), cold = new T.Color(), warm = new T.Color(), color = new T.Color();
        let events = [], active = null, state = null, seedId = null, samples = [];
        let dead = false;
        const parts = (kind, pose) => {
            if (kind === 'pigeons') {
                const result = [];
                for (let bird = 0; bird < 3; bird++) {
                    const flight = Math.max(0, pose.age - 1 - bird * 0.22);
                    const flap = Math.sin(flight * 13) * 0.6 * smooth(flight / 0.3);
                    const x = bird * 0.85 + flight * (0.8 + bird * 0.2);
                    const y = flight * 1.7, z = -flight * 3 + bird * 0.7;
                    result.push([x, y, z, 0.18, 0.22, 0.4, 0],
                        [x, y + 0.18, z - 0.3, 0.14, 0.14, 0.16, 0],
                        [x - 0.36, y + flap, z, 0.45, 0.055, 0.22, flap],
                        [x + 0.36, y + flap, z, 0.45, 0.055, 0.22, -flap]);
                }
                return result;
            }
            if (kind === 'rabbit') {
                const kick = Math.sin(pose.phase * Math.PI * 2);
                return [
                    [0, 0, 0, 0.48, 0.5, 0.85, 0],
                    [0, 0.48, -0.67, 0.34, 0.36, 0.38, 0],
                    [-0.18, 1.05, -0.62, 0.11, 0.6, 0.12, kick * 0.18],
                    [0.18, 1.07, -0.62, 0.11, 0.62, 0.12, kick * 0.18 - 0.1],
                    [-0.28, -0.25, -0.52, 0.13, 0.38, 0.15, kick * 0.7],
                    [0.28, -0.25, -0.52, 0.13, 0.38, 0.15, kick * 0.7],
                    [-0.35, -0.18, 0.42, 0.23, 0.36, 0.3, -kick * 0.6],
                    [0.35, -0.18, 0.42, 0.23, 0.36, 0.3, -kick * 0.6],
                    [0, 0.12, 0.88, 0.23, 0.23, 0.23, 0]
                ];
            }
            const tail = Math.sin(pose.leap * Math.PI * 3) * 0.4;
            return [
                [0, 0, -0.8, 2.1, 2.3, 6.4, 0],
                [0, 0.25, -5.2, 2, 1.85, 2.6, 0],
                [0, -0.1, 5.3, 1.05, 1.05, 3.6, tail],
                [-2.6, -1.3, -1.2, 2.8, 0.22, 1.05, -0.3],
                [2.6, -1.3, -1.2, 2.8, 0.22, 1.05, 0.3],
                [-1.65, 0, 8.1, 2.5, 0.28, 1.25, tail],
                [1.65, 0, 8.1, 2.5, 0.28, 1.25, tail]
            ];
        };
        const setSeed = event => {
            if (seedId === event.seed) return;
            seedId = event.seed;
            const random = seededRandom(seedId);
            samples = Array.from({ length: capacity }, () => {
                const y = random() * 2 - 1, angle = random() * Math.PI * 2;
                const r = Math.sqrt(1 - y * y);
                return [r * Math.cos(angle), y, r * Math.sin(angle), random()];
            });
        };
        return {
            reset(timeline, track, options) {
                events = compile(timeline, track, options);
                track.events = events;
                active = state = null;
                seedId = null;
                root.visible = false;
            },
            update(time, options, quality, palette, audio = {}) {
                if (dead) return;
                root.visible = options.journeyEvents !== false && !options.reducedMotion
                    && (options.motionAmount ?? 1) > 0 && (options.animationIntensity ?? 1) > 0;
                active = events[Math.max(0, D.upperBound(events, time, 'start') - 1)];
                state = active ? sample(active, time) : null;
                root.visible = root.visible && Boolean(state)
                    && (active?.kind !== 'pigeons' || active.perch === 'sign' || options.narrativeStations !== false
                        && (options.stationIntensity ?? 1) > 0);
                if (!root.visible) { state = null; return; }
                setSeed(active);
                cold.set(palette.secondary || '#76bfae');
                warm.set(palette.accent || '#f2a900');
                material.opacity = state.fade * (palette.light ? 0.55 : 0.85) * (1 + clamp(audio.energy) * 0.08);
                const count = quality === 'energy-saving' ? 320 : quality === 'ultimate' ? 1800 : 900;
                geometry.setDrawRange(0, count);
                volumes.count = 0;
                // After submersion only world-space ripples survive.
                const bodyVisible = active.kind !== 'whale' || state.age < 8.5;
                const vectorAnimal = active.kind === 'rabbit' || active.kind === 'pigeons';
                points.visible = bodyVisible && !vectorAnimal;
                volumes.visible = bodyVisible && !vectorAnimal;
                outlines.visible = vectorAnimal;
                if (vectorAnimal) {
                    lineMaterial.color.copy(cold).lerp(new T.Color('#ffffff'), 0.45);
                    lineMaterial.opacity = state.fade * 0.9;
                    drawAnimal(active, state);
                }
                const bodyParts = state.body ? parts(active.kind, state.body) : null;
                const whale = active.kind === 'whale';
                const yaw = active.yaw + (whale ? active.side * Math.PI / 2 : 0);
                const cy = Math.cos(yaw), sy = Math.sin(yaw);
                const pitch = whale ? Math.cos(state.body.leap * Math.PI) * -0.55 : 0;
                const cp = Math.cos(pitch), sp = Math.sin(pitch);
                const bodyPoint = (x, y, z) => {
                    const py = y * cp - z * sp, pz = y * sp + z * cp;
                    return { x: state.body.x + x * cy - pz * sy, y: state.body.y + py,
                        z: state.body.z + x * sy + pz * cy };
                };
                if (bodyParts && !vectorAnimal && quality !== 'energy-saving') {
                    bodyMaterial.color.copy(cold);
                    bodyMaterial.opacity = state.fade * (whale ? 0.07 : 0.12);
                    bodyParts.forEach(part => {
                        const p = bodyPoint(part[0], part[1], part[2]);
                        dummy.position.set(p.x, p.y, p.z);
                        dummy.rotation.set(pitch + part[6], -yaw, 0, 'YXZ');
                        dummy.scale.set(part[3], part[4], part[5]);
                        dummy.updateMatrix();
                        volumes.setMatrixAt(volumes.count++, dummy.matrix);
                    });
                    volumes.instanceMatrix.needsUpdate = true;
                }
                for (let i = 0; i < (vectorAnimal ? 0 : count); i++) {
                    const s = samples[i];
                    let p, brightness = 0.5 + s[3] * 0.5;
                    if (bodyParts) {
                        const part = bodyParts[i % bodyParts.length];
                        const a = part[6], ca = Math.cos(a), sa = Math.sin(a);
                        const y = s[1] * part[4], z = s[2] * part[5];
                        p = bodyPoint(part[0] + s[0] * part[3],
                            part[1] + y * ca - z * sa, part[2] + y * sa + z * ca);
                        // Keep the real underwater position: the water depth
                        // buffer and reflection clip plane hide submerged parts.
                    } else if (active.kind === 'meteor') {
                        const tail = i / count;
                        const progress = state.progress - tail * 0.16;
                        p = worldPoint(active, active.side * (active.viewPlaced ? 24 - progress * 48 : 95 - progress * 110),
                            0, active.viewPlaced ? 58 - progress * 18 : 95 - progress * 45);
                        brightness *= (1 - tail) ** 2;
                    } else {
                        const burst = i % 2;
                        const age = state.age - 0.7 - burst * 1.7;
                        const expansion = Math.max(0, age);
                        p = worldPoint(active, active.side * (active.viewPlaced ? 18 + burst * 12 : 65 + burst * 30) + s[0] * expansion * 12,
                            s[2] * expansion * 8, 27 + burst * 9 + s[1] * expansion * 12 - expansion * expansion * 2.2);
                        brightness *= age < 0 ? 0 : Math.exp(-expansion * 0.8);
                    }
                    positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
                    color.copy(cold).lerp(warm, active.kind === 'fireworks' ? 0.7 : 0.15).multiplyScalar(brightness);
                    color.toArray(colors, i * 3);
                }
                geometry.attributes.position.needsUpdate = true;
                geometry.attributes.color.needsUpdate = true;
                material.size = ['rabbit', 'pigeons'].includes(active.kind) ? 0.11 : whale ? 0.16 : 0.6;
                rings.count = 0;
                ringMaterial.color.copy(cold);
                for (const ripple of state.ripples.slice(0, 12)) {
                    dummy.position.set(ripple.x, ripple.y, ripple.z);
                    dummy.rotation.set(-Math.PI / 2, 0, 0);
                    dummy.scale.setScalar(ripple.radius);
                    dummy.updateMatrix();
                    rings.setMatrixAt(rings.count, dummy.matrix);
                    color.copy(cold).multiplyScalar(ripple.opacity * state.fade);
                    rings.setColorAt(rings.count++, color);
                }
                rings.instanceMatrix.needsUpdate = true;
                if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
            },
            snapshot(camera) {
                const count = root.visible && points.visible ? geometry.drawRange.count : 0;
                const lineCount = root.visible && outlines.visible ? lineCursor / 3 : 0;
                const diagnosticPositions = lineCount ? linePositions : positions;
                const diagnosticCount = lineCount || count;
                let inView = 0;
                const p = new T.Vector3();
                if (camera && diagnosticCount) {
                    camera.updateMatrixWorld();
                    for (let i = 0; i < diagnosticCount; i++) {
                        if (diagnosticPositions[i * 3 + 1] < 0) continue;
                        p.fromArray(diagnosticPositions, i * 3).project(camera);
                        if (Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.9 && Math.abs(p.z) < 1) inView++;
                    }
                }
                return { eventPlan: events, activeEvent: state, eventPoints: count,
                    eventLineVertices: lineCount, eventVertices: diagnosticCount,
                    eventInView: inView, eventRipples: root.visible ? rings.count : 0 };
            },
            destroy() {
                if (dead) return;
                dead = true;
                scene.remove(root);
                rings.dispose(); volumes.dispose();
                geometry.dispose(); material.dispose();
                lineGeometry.dispose(); lineMaterial.dispose();
                ringGeometry.dispose(); ringMaterial.dispose();
                bodyGeometry.dispose(); bodyMaterial.dispose();
                events = []; samples = [];
            }
        };
    };
    global.MusicStageDioramaEvents = Object.freeze({ compile, sample, rabbitAt, rabbitPathClear, worldPoint, create });
})(window);