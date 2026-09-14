(function (global) {
    'use strict';

    const { clamp, seededRandom } = global.MusicStageRuntime;
    const smooth = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
    const TYPES = ['helix', 'platform', 'memory', 'water', 'echo'];
    // Stable route addresses, not a frame-time slideshow. Short tracks still get a first encounter.
    const plan = (frames, seed) => {
        const random = seededRandom(`stations:${seed}`);
        const result = [];
        for (let start = 0; start < frames.length; start += 4) {
            result.push({
                start, end: Math.min(start + 4, frames.length),
                type: TYPES[result.length % TYPES.length],
                phase: random() * Math.PI * 2,
                variant: Math.floor(result.length / TYPES.length)
            });
        }
        return result;
    };

    const create = (THREE, scene) => {
        let frames = [];
        let descriptors = [];
        let palette = {};
        let seed = '';
        let quality = '';
        const live = new Map();
        const geometries = new Set();
        const materials = new Set();
        const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
        geometries.add(boxGeometry);
        const vector = p => new THREE.Vector3(p.x, p.y, p.z);
        const basis = f => new THREE.Matrix4().makeBasis(
            vector(f.right), vector(f.up), vector(f.forward).negate()
        );
        const root = new THREE.Group();
        root.name = 'diorama-narrative-stations';
        scene.add(root);
        let water = null;
        let activeWater = null;
        let dead = false;

        const material = (color, opacity = 1) => {
            const mat = new THREE.MeshBasicMaterial({
                color, transparent: true, opacity, depthWrite: false,
                side: THREE.DoubleSide
            });
            materials.add(mat);
            return mat;
        };
        const build = descriptor => {
            const group = new THREE.Group();
            const f = frames[descriptor.start];
            group.position.copy(vector(f.position));
            group.quaternion.setFromRotationMatrix(basis(f));
            const inverse = group.quaternion.clone().invert();
            const origin = vector(f.position);
            const length = Math.max(20, (descriptor.end - descriptor.start) * 11.5);
            const dark = new THREE.Color(palette.background || '#171a1d');
            const ink = new THREE.Color(palette.ink || '#f2f0e9');
            const accent = palette.accent || '#f2a900';
            const secondary = palette.secondary || '#76bfae';
            const ownedMaterials = [
                material(dark.clone().lerp(ink, 0.12), 0.75),
                material(accent, 0.62), material(secondary, 0.38), material(ink, 0.28)
            ];
            const nodes = [];
            const helixStrands = [];
            const ownedGeometries = [];
            const addBox = (parent, x, y, z, sx, sy, sz, mat = ownedMaterials[0]) => {
                const mesh = new THREE.Mesh(boxGeometry, mat);
                mesh.position.set(x, y, z);
                mesh.scale.set(sx, sy, sz);
                parent.add(mesh);
                return mesh;
            };
            const line = (points, mat) => {
                const geo = new THREE.BufferGeometry().setFromPoints(points);
                geometries.add(geo);
                ownedGeometries.push(geo);
                const lineMat = new THREE.LineBasicMaterial({
                    color: mat.color, transparent: true, opacity: mat.opacity, depthWrite: false
                });
                materials.add(lineMat);
                ownedMaterials.push(lineMat);
                group.add(new THREE.Line(geo, lineMat));
            };
            const frameGroup = index => {
                const anchor = frames[Math.min(frames.length - 1, index)];
                const sub = new THREE.Group();
                sub.position.copy(vector(anchor.position).sub(origin).applyQuaternion(inverse));
                sub.quaternion.setFromRotationMatrix(basis(anchor)).premultiply(inverse);
                group.add(sub);
                return sub;
            };

            if (descriptor.type === 'helix') {
                // Helix is a quiet peripheral structure, never a bright cage over the lyrics.
                ownedMaterials.forEach(mat => { mat.opacity *= 0.22; });
                // Actual opposed strands with paired half-rungs. Centre is opened before arrival.
                for (let side = 0; side < 2; side++) {
                    const points = [];
                    for (let j = 0; j <= 144; j++) {
                        const z = -length * j / 144;
                        const a = descriptor.phase + j / 144 * Math.PI * 3 + side * Math.PI;
                        points.push(new THREE.Vector3(Math.cos(a) * 5.6, Math.sin(a) * 4.8, z));
                    }
                    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 144, 0.035, 5, false);
                    geometries.add(geo);
                    ownedGeometries.push(geo);
                    const strand = new THREE.Mesh(geo, ownedMaterials[side + 1]);
                    strand.userData.baseOpacity = ownedMaterials[side + 1].opacity;
                    strand.userData.side = side;
                    group.add(strand);
                    helixStrands.push(strand);
                }
                for (let j = 0; j < 28; j++) {
                    const angle = descriptor.phase + j / 28 * Math.PI * 3;
                    for (const sign of [-1, 1]) {
                        // Pivot at the strand attachment, not at the centre of the tunnel.
                        const half = new THREE.Group();
                        group.add(half);
                        const rungMat = material(sign > 0 ? accent : secondary, 0.11);
                        ownedMaterials.push(rungMat);
                        const rod = addBox(half, -2.5, 0, 0, 5, 0.025, 0.065, rungMat);
                        const tip = addBox(half, -5, 0, 0, 0.09, 0.12, 0.09, rungMat);
                        nodes.push({
                            object: half, rod, tip, mat: rungMat, kind: 'rung', sign, angle,
                            z: -length * j / 28,
                            address: descriptor.start + j / 28 * (descriptor.end - descriptor.start),
                            lag: 0.045 * Math.sin(j * 1.71 + sign * 0.4)
                        });
                    }
                }
            } else if (descriptor.type === 'platform' || descriptor.type === 'water') {
                for (let j = 0; j < descriptor.end - descriptor.start; j++) {
                    const sub = frameGroup(descriptor.start + j);
                    for (const sign of [-1, 1]) {
                        addBox(sub, sign * 7.5, -3.2, -4, 4, 0.22, 11.2);
                        addBox(sub, sign * 5.5, -3.02, -4, 0.055, 0.04, 11.2, ownedMaterials[1]);
                        addBox(sub, sign * 9.2, 0, -5, 0.18, 6.3, 0.2);
                        addBox(sub, sign * 8.2, 3.1, -5, 2.2, 0.065, 0.1, ownedMaterials[3]);
                        // Empty bench and a door frame: repeated, but one seat is missing on later visits.
                        if (!(descriptor.variant % 2 && sign === 1 && j === 2)) {
                            addBox(sub, sign * 7.4, -2.1, -5, 2, 0.13, 0.7);
                            addBox(sub, sign * 7.4, -1.55, -5.3, 2, 0.9, 0.1);
                            for (const leg of [-0.7, 0.7]) addBox(sub, sign * 7.4 + leg, -2.65, -5, 0.08, 1, 0.5);
                        }
                        const lamp = addBox(sub, sign * 9.05, 1.4, -4.85, 0.06, 1.4, 0.06, ownedMaterials[2]);
                        nodes.push({ object: lamp, kind: 'lamp', address: descriptor.start + j });
                    }
                }
            } else {
                for (let j = 0; j < 12; j++) {
                    const sub = new THREE.Group();
                    const sign = j % 2 ? 1 : -1;
                    sub.position.set(sign * (5.9 + (j % 3) * 0.5), (j % 3 - 1) * 0.6, -j * length / 12);
                    sub.rotation.y = sign * 0.22;
                    group.add(sub);
                    // Recurrent window motif, with progressively missing edges.
                    addBox(sub, -1.2, 0, 0, 0.075, 4.2, 0.12, ownedMaterials[3]);
                    if ((j + descriptor.variant) % 5 !== 3) addBox(sub, 1.2, 0, 0, 0.075, 4.2, 0.12, ownedMaterials[2]);
                    addBox(sub, 0, 2.1, 0, 2.4, 0.06, 0.12, ownedMaterials[1]);
                    addBox(sub, 0, -2.1, 0, 2.4, 0.06, 0.12);
                    if (descriptor.type === 'memory') {
                        // Stair silhouette split across depth; never a solid billboard across the lyrics.
                        for (let k = 0; k < 5; k++) {
                            addBox(sub, -0.8 + k * 0.36, -1.6 + k * 0.5, k * 0.24,
                                0.42, 0.12, 0.7, ownedMaterials[k % 2 ? 0 : 3]);
                        }
                    }
                    nodes.push({ object: sub, kind: 'slice', x: sub.position.x, z: sub.position.z,
                        sign, address: descriptor.start + j / 12 * 4 });
                }
            }
            // Thin paired route traces tie different encounters together.
            for (const sign of [-1, 1]) line([
                new THREE.Vector3(sign * 5.4, -3, 5),
                new THREE.Vector3(sign * 5.4, -3, -length)
            ], ownedMaterials[2]);
            const baseOpacity = ownedMaterials.map(mat => mat.opacity);
            root.add(group);
            return { descriptor, group, nodes, helixStrands, ownedMaterials, ownedGeometries, baseOpacity, length };
        };
        const release = station => {
            root.remove(station.group);
            station.ownedMaterials.forEach(mat => { mat.dispose(); materials.delete(mat); });
            station.ownedGeometries.forEach(geo => { geo.dispose(); geometries.delete(geo); });
        };

        const createWater = () => {
            const target = new THREE.WebGLRenderTarget(512, 256, {
                minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true
            });
            const textureMatrix = new THREE.Matrix4();
            const uniforms = {
                reflection: { value: target.texture }, textureMatrix: { value: textureMatrix },
                time: { value: 0 }, energy: { value: 0 }, strength: { value: 0 },
                texel: { value: new THREE.Vector2(1 / 512, 1 / 256) },
                tint: { value: new THREE.Color(palette.background || '#171a1d') },
                light: { value: new THREE.Color(palette.secondary || '#76bfae') }
            };
            const mat = new THREE.ShaderMaterial({
                uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
                vertexShader: `
                    uniform mat4 textureMatrix;
                    varying vec4 projected;
                    varying vec2 surface;
                    varying vec3 worldPosition;
                    void main() {
                        vec4 world = modelMatrix * vec4(position, 1.0);
                        worldPosition = world.xyz;
                        projected = textureMatrix * world;
                        surface = uv;
                        gl_Position = projectionMatrix * viewMatrix * world;
                    }
                `,
                fragmentShader: `
                    uniform sampler2D reflection;
                    uniform float time;
                    uniform float energy;
                    uniform float strength;
                    uniform vec2 texel;
                    uniform vec3 tint;
                    uniform vec3 light;
                    varying vec4 projected;
                    varying vec2 surface;
                    varying vec3 worldPosition;
                    void main() {
                        vec2 p = surface * vec2(24.0, 64.0);
                        vec2 wave = vec2(sin(p.y * 1.3 + time * 0.65),
                                         cos(p.x * 1.7 - time * 0.43));
                        for (int i = 0; i < 3; i++) {
                            float fi = float(i);
                            vec2 delta = p - vec2(5.0 + fi * 6.0, 14.0 + fi * 16.0);
                            float radius = length(delta);
                            float phase = radius * 2.4 - time * (1.1 + fi * 0.13);
                            wave += delta / max(radius, 0.1) * sin(phase)
                                  * exp(-radius * 0.08) * (0.3 + energy);
                        }
                        vec2 uv = projected.xy / max(projected.w, 0.001);
                        uv += wave * (0.0015 + energy * 0.003);
                        uv = clamp(uv, vec2(0.008), vec2(0.992));
                        vec2 blur = texel * (1.4 + length(wave) * 2.0 + (1.0 - surface.y) * 3.0);
                        vec3 reflected = texture2D(reflection, uv).rgb * 0.28;
                        reflected += texture2D(reflection, clamp(uv + blur, 0.0, 1.0)).rgb * 0.18;
                        reflected += texture2D(reflection, clamp(uv - blur, 0.0, 1.0)).rgb * 0.18;
                        reflected += texture2D(reflection, clamp(uv + vec2(blur.x, -blur.y), 0.0, 1.0)).rgb * 0.18;
                        reflected += texture2D(reflection, clamp(uv + vec2(-blur.x, blur.y), 0.0, 1.0)).rgb * 0.18;
                        float edge = smoothstep(0.0, 0.12, surface.x) * smoothstep(0.0, 0.12, 1.0-surface.x)
                                   * smoothstep(0.0, 0.13, surface.y) * smoothstep(0.0, 0.13, 1.0-surface.y);
                        float distanceFade = 1.0 - smoothstep(35.0, 90.0, distance(cameraPosition, worldPosition));
                        vec3 color = mix(tint, reflected, 0.65) + light * pow(max(0.0, wave.x * 0.28), 6.0) * 0.1;
                        gl_FragColor = vec4(color, edge * distanceFade * strength * 0.76);
                        #include <tonemapping_fragment>
                        #include <colorspace_fragment>
                    }
                `
            });
            // Older packaged Three versions use encodings_fragment.
            if (!THREE.ShaderChunk.colorspace_fragment) {
                mat.fragmentShader = mat.fragmentShader.replace('colorspace_fragment', 'encodings_fragment');
            }
            const geo = new THREE.PlaneGeometry(28, 64);
            const mesh = new THREE.Mesh(geo, mat);
            mesh.visible = false;
            mesh.renderOrder = 2;
            scene.add(mesh);
            return { target, mesh, mat, geo, uniforms, camera: new THREE.PerspectiveCamera(), size: '' };
        };

        const reset = (nextFrames, nextSeed, nextPalette) => {
            live.forEach(release);
            live.clear();
            frames = nextFrames;
            seed = nextSeed;
            palette = nextPalette || {};
            descriptors = plan(frames, seed);
            activeWater = null;
            if (water) {
                water.mesh.visible = false;
                water.uniforms.tint.value.set(palette.background || '#171a1d');
                water.uniforms.light.value.set(palette.secondary || '#76bfae');
            }
        };
        const update = (address, time, energy, config, motion = 1) => {
            if (dead) return;
            quality = config.quality || 'standard';
            const tuning = config.modes?.diorama || {};
            const enabled = tuning.narrativeStations !== false;
            root.visible = enabled;
            activeWater = null;
            const centre = Math.max(0, Math.min(descriptors.length - 1, Math.floor(address / 4)));
            const wanted = new Set();
            if (enabled) {
                for (let i = Math.max(0, centre - 1); i <= Math.min(descriptors.length - 1, centre + 2); i++) wanted.add(i);
            }
            live.forEach((station, index) => {
                if (!wanted.has(index)) { release(station); live.delete(index); }
            });
            wanted.forEach(index => {
                if (!live.has(index)) live.set(index, build(descriptors[index]));
                const station = live.get(index);
                const d = station.descriptor;
                const visibility = smooth((address - d.start + 6) / 3) * (1 - smooth((address - d.end - 0.5) / 2));
                const intensity = clamp(tuning.stationIntensity ?? 1, 0, 2);
                // Keep the lyric reading corridor quiet while the station remains visible at the edges.
                const lyricSafety = d.type === 'helix'
                    ? 0.28 + 0.72 * Math.min(1, Math.abs(address - (d.start + d.end) * 0.5) / 1.7)
                    : 1;
                station.ownedMaterials.forEach((mat, j) => {
                    mat.opacity = Math.min(1, station.baseOpacity[j] * visibility * intensity * lyricSafety);
                });
                station.group.visible = visibility > 0.001 && intensity > 0;
                if (d.type === 'helix') {
                    // The external rails dissolve from the camera-facing/front half first.
                    // Far rails remain as a faint genetic trace instead of a bright tunnel.
                    const front = smooth((address - d.start + 0.6) / 2.1);
                    station.helixStrands.forEach(strand => {
                        const sideFade = strand.userData.side === 0
                            ? 1 - front * 0.62 : 1 - front * 0.78;
                        strand.material.opacity = strand.userData.baseOpacity
                            * visibility * intensity * lyricSafety * sideFade;
                    });
                }
                station.nodes.forEach(node => {
                    const passed = smooth((address - node.address + 0.6) / 1.5);
                    if (node.kind === 'rung') {
                        // Open ahead of the reading plane. Retraction clears the centre first;
                        // the short remnant is then drawn along its own helical backbone.
                        const unzip = smooth((address - node.address + 1.05 + node.lag) / 1.3);
                        const retract = smooth(unzip / 0.72);
                        const carry = smooth((unzip - 0.24) / 0.76) * Math.min(1, motion);
                        const slide = carry * 2.6;
                        const phase = node.angle + (node.sign < 0 ? Math.PI : 0)
                            - slide / station.length * Math.PI * 3;
                        const x = Math.cos(phase) * 5.6;
                        const y = Math.sin(phase) * 4.8;
                        const radius = Math.hypot(x, y);
                        node.object.position.set(x, y, node.z + slide);
                        node.object.rotation.set(0, carry * node.sign * 0.38,
                            Math.atan2(y, x) + carry * node.sign * 0.48);
                        const remaining = (radius - 0.12) * (1 - retract * 0.95);
                        node.rod.scale.x = remaining;
                        node.rod.position.x = -remaining / 2;
                        node.tip.position.x = -remaining;
                        // Thin paired tips briefly survive the pull, then disappear at the edge.
                        node.mat.opacity = 0.11 * visibility * intensity * lyricSafety
                            * (1 - smooth((unzip - 0.68) / 0.32) * 0.9);
                    } else if (node.kind === 'lamp') {
                        node.object.scale.y = 0.9 + (1 - passed) * 0.5 + energy * 0.15;
                    } else {
                        node.object.position.x = node.x + node.sign * passed * 1.5 * motion;
                        node.object.position.z = node.z + Math.sin(time * 0.13 + node.address) * 0.4 * motion;
                        node.object.rotation.z = node.sign * passed * 0.18 * motion;
                    }
                });
                if (d.type === 'water' && station.group.visible && address > d.start - 3 && address < d.end + 1) {
                    activeWater = station;
                }
            });
            if (activeWater && tuning.waterReflection !== false) {
                if (!water) water = createWater();
                const station = activeWater;
                water.mesh.quaternion.copy(station.group.quaternion);
                water.mesh.rotateX(-Math.PI / 2);
                water.mesh.position.set(0, -3.45, -station.length / 2)
                    .applyQuaternion(station.group.quaternion).add(station.group.position);
                water.mesh.updateMatrixWorld(true);
                water.mesh.visible = true;
                water.uniforms.time.value = time * motion;
                water.uniforms.energy.value = energy * motion;
                water.uniforms.strength.value = clamp(tuning.waterStrength ?? 1, 0, 2)
                    * smooth((address - station.descriptor.start + 3) / 2)
                    * (1 - smooth((address - station.descriptor.end) / 1));
            } else if (water) water.mesh.visible = false;
        };

        const renderReflection = (renderer, camera) => {
            if (!water?.mesh.visible || dead) return;
            const { mesh, target, uniforms } = water;
            const mirror = water.camera;
            const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, mesh.position);
            if (plane.distanceToPoint(camera.position) <= 0.05) { mesh.visible = false; return; }
            camera.updateMatrixWorld();
            const reflectPoint = point => point.addScaledVector(normal, -2 * plane.distanceToPoint(point));
            mirror.position.copy(reflectPoint(camera.position.clone()));
            const look = camera.getWorldDirection(new THREE.Vector3()).add(camera.position);
            mirror.up.copy(camera.up).transformDirection(camera.matrixWorld).reflect(normal);
            mirror.lookAt(reflectPoint(look));
            mirror.near = camera.near;
            mirror.far = camera.far;
            mirror.projectionMatrix.copy(camera.projectionMatrix);
            mirror.updateMatrixWorld();
            // Projective texture coordinates use the unmodified projection.
            uniforms.textureMatrix.value.set(
                0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1
            ).multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
            // Oblique near-plane clipping also works for the existing custom liquid/ribbon shaders.
            const clipPlane = plane.clone().applyMatrix4(mirror.matrixWorldInverse);
            const clip = new THREE.Vector4(clipPlane.normal.x, clipPlane.normal.y, clipPlane.normal.z, clipPlane.constant);
            const e = mirror.projectionMatrix.elements;
            const q = new THREE.Vector4((Math.sign(clip.x) + e[8]) / e[0],
                (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
            const dot = clip.dot(q);
            if (Math.abs(dot) < 0.00001) return;
            clip.multiplyScalar(2 / dot);
            e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1 - 0.002; e[14] = clip.w;
            mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
            const size = renderer.getSize(new THREE.Vector2());
            const cap = quality === 'ultimate' ? 1024 : quality === 'energy-saving' ? 256 : 512;
            const w = Math.max(1, Math.min(cap, Math.round(size.x * 0.5)));
            const h = Math.max(1, Math.round(w * size.y / Math.max(1, size.x)));
            const key = `${w}:${h}`;
            if (water.size !== key) {
                target.setSize(w, h);
                uniforms.texel.value.set(1 / w, 1 / h);
                water.size = key;
            }
            const oldTarget = renderer.getRenderTarget();
            const oldAutoClear = renderer.autoClear;
            const oldXr = renderer.xr.enabled;
            const oldShadow = renderer.shadowMap.autoUpdate;
            mesh.visible = false;
            try {
                renderer.xr.enabled = false;
                renderer.shadowMap.autoUpdate = false;
                renderer.autoClear = true;
                renderer.setRenderTarget(target);
                renderer.clear();
                renderer.render(scene, mirror);
            } finally {
                renderer.setRenderTarget(oldTarget);
                renderer.autoClear = oldAutoClear;
                renderer.xr.enabled = oldXr;
                renderer.shadowMap.autoUpdate = oldShadow;
                mesh.visible = true;
            }
        };
        const destroy = () => {
            if (dead) return;
            dead = true;
            live.forEach(release);
            live.clear();
            scene.remove(root);
            geometries.forEach(geo => geo.dispose());
            materials.forEach(mat => mat.dispose());
            geometries.clear();
            materials.clear();
            if (water) {
                scene.remove(water.mesh);
                water.geo.dispose();
                water.mat.dispose();
                water.target.dispose();
                water = null;
            }
        };
        return { reset, update, renderReflection, destroy,
            snapshot: () => ({ liveStations: live.size, stationTypes: Array.from(live.values(), s => s.descriptor.type),
                waterVisible: Boolean(water?.mesh.visible), stationCount: descriptors.length }) };
    };
    global.MusicStageDioramaStations = Object.freeze({ create, plan, smooth });
})(window);