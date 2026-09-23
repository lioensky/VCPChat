(function (global) {
    'use strict';
    const { clamp, seededRandom } = global.MusicStageRuntime;
    const create = (T, scene) => {
        const root = new T.Group();
        scene.add(root);
        const geometries = new Set(), materials = new Set();
        const geometry = g => { geometries.add(g); return g; };
        const material = m => { materials.add(m); return m; };
        const box = geometry(new T.BoxGeometry(1, 1, 1));
        const steel = material(new T.MeshStandardMaterial({ color: '#626b76', metalness: 0.8, roughness: 0.28 }));
        const timber = material(new T.MeshStandardMaterial({ color: '#292d32', roughness: 0.95 }));
        const concrete = material(new T.MeshStandardMaterial({ color: '#444852', roughness: 0.8 }));
        const lampMaterial = material(new T.MeshBasicMaterial({ color: '#ffd994' }));
        const instances = (mat, count) => {
            const mesh = new T.InstancedMesh(box, mat, count);
            mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
            mesh.frustumCulled = false;
            root.add(mesh);
            return mesh;
        };
        const rails = instances(steel, 320);
        const sleepers = instances(timber, 400);
        const poles = instances(steel, 48);
        const arms = instances(steel, 48);
        const platforms = instances(concrete, 8);
        const benches = instances(timber, 16);
        const lamps = instances(lampMaterial, 48);
        // Architectural motifs replace the old floating frames. Four bounded
        // pools share geometry; stations differ in silhouette, not in world.
        const architecture = instances(steel, 256);
        const masonry = instances(concrete, 160);
        const furnishings = instances(timber, 128);
        const stationGlow = instances(lampMaterial, 96);
        let stationTypes = [];
        const wirePositions = new Float32Array(48 * 8 * 6);
        const wireGeometry = geometry(new T.BufferGeometry());
        wireGeometry.setAttribute('position', new T.BufferAttribute(wirePositions, 3).setUsage(T.DynamicDrawUsage));
        const wireMaterial = material(new T.LineBasicMaterial({ color: '#60717d', transparent: true,
            opacity: 0.42, depthWrite: false }));
        const wires = new T.LineSegments(wireGeometry, wireMaterial);
        wires.frustumCulled = false;
        root.add(wires);
        const ridgePositions = [];
        for (let i = 0; i < 192; i++) {
            const a = i / 192 * Math.PI * 2, b = (i + 1) / 192 * Math.PI * 2;
            const elevation = angle => 4 + 9 * Math.pow(0.5 + 0.5 * Math.sin(angle * 7 + 1), 3)
                + 3 * Math.sin(angle * 19);
            const ax = Math.cos(a) * 650, az = Math.sin(a) * 650;
            const bx = Math.cos(b) * 650, bz = Math.sin(b) * 650;
            ridgePositions.push(ax, -2, az, bx, -2, bz, ax, elevation(a), az,
                bx, -2, bz, bx, elevation(b), bz, ax, elevation(a), az);
        }
        const ridgeGeometry = geometry(new T.BufferGeometry());
        ridgeGeometry.setAttribute('position', new T.Float32BufferAttribute(ridgePositions, 3));
        const ridgeMaterial = material(new T.MeshBasicMaterial({ color: '#1c2935', side: T.DoubleSide, fog: false }));
        const ridge = new T.Mesh(ridgeGeometry, ridgeMaterial);
        root.add(ridge);
        const dummy = new T.Object3D();
        const place = (mesh, index, track, s, lateral, y, sx, sy, sz) => {
            const f = track.at(s);
            dummy.position.set(f.position.x + f.right.x * lateral, y, f.position.z + f.right.z * lateral);
            dummy.rotation.set(0, -f.yaw, 0);
            dummy.scale.set(sx, sy, sz);
            dummy.updateMatrix();
            mesh.setMatrixAt(index, dummy.matrix);
        };
        const hemisphere = new T.HemisphereLight('#819ab6', '#14191e', 0.65);
        const moonLight = new T.DirectionalLight('#b1cee9', 1.5);
        moonLight.position.set(-70, 100, -140);
        root.add(hemisphere, moonLight);
        const lights = Array.from({ length: 2 }, () => {
            const light = new T.PointLight('#ffd28c', 22, 22, 2);
            root.add(light);
            return light;
        });
        const skyMat = material(new T.ShaderMaterial({
            side: T.BackSide, depthWrite: false,
            uniforms: {
                night: { value: new T.Color('#080f20') },
                horizon: { value: new T.Color('#415266') },
                cold: { value: new T.Color('#8bbfc8') },
                open: { value: 0 },
                auroraActive: { value: 1.0 },
                auroraTime: { value: 0.0 },
                auroraRhythm: { value: 0.0 },
                auroraHeading: { value: 0.0 },
                auroraGreen: { value: new T.Color('#22f09d') },
                auroraViolet: { value: new T.Color('#9d4edd') }
            },
            vertexShader: `varying vec3 ray;
                void main(){ray=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `varying vec3 ray;uniform vec3 night,horizon,cold;uniform float open;
                uniform float auroraActive, auroraTime, auroraRhythm, auroraHeading;
                uniform vec3 auroraGreen, auroraViolet;
                float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
                float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),
                    mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                    mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                    mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
                void main(){
                    vec3 d=normalize(ray);
                    float h=pow(max(d.y,0.0),0.45);
                    vec3 c=mix(horizon,night,clamp(h*1.7,0.0,1.0));
                    float band=exp(-pow(dot(d,normalize(vec3(0.35,0.8,0.48)))-0.18,2.0)*90.0);
                    float cloud=noise(d*12.0)*0.6+noise(d*33.0)*0.3+noise(d*91.0)*0.1;
                    c+=cold*band*pow(cloud,3.0)*(0.12+open*0.22);
                    // Angular curtains share the same coordinates as their visibility mask.
                    // Fixed celestial heading, calibrated once to the opening shot, not a HUD.
                    if (auroraActive > 0.001 && d.y > 0.02) {
                        float angle = atan(d.x, -d.z) - auroraHeading;
                        float u = atan(sin(angle), cos(angle));
                        float elevation = asin(clamp(d.y, -1.0, 1.0));
                        float sector = smoothstep(-0.85, -0.48, u)
                                     * (1.0 - smoothstep(0.16, 0.48, u));
                        float drift = auroraTime * 0.065;
                        vec3 emission = vec3(0.0);
                        for (int layer = 0; layer < 3; layer++) {
                            float k = float(layer);
                            float fold = sin(u * 8.0 + drift + k * 1.7)
                                       + 0.35 * sin(u * 19.0 - drift * 0.7 + k);
                            float base = 0.13 + k * 0.045 + fold * 0.025;
                            float altitude = elevation - base;
                            float height = 0.17 + 0.045 * sin(u * 6.0 + k + drift * 0.4);
                            float v = max(0.0, altitude) / height;
                            float filament = noise(vec3(u * 95.0 + fold * 1.4,
                                drift * 0.4 + k * 5.0, v * 0.18));
                            float fine = pow(0.5 + 0.5 * sin(u * 310.0 + fold * 6.0
                                + drift * 1.2 + v * 0.7), 6.0);
                            float veil = smoothstep(-0.012, 0.015, altitude)
                                * exp(-v * 2.7) * (0.22 + filament * 0.65 + fine * 0.28);
                            float hem = exp(-pow(altitude / 0.012, 2.0)) * 0.22;
                            vec3 spectral = mix(auroraGreen, auroraViolet,
                                smoothstep(0.25, 1.1, v));
                            emission += spectral * (veil + hem) / (1.0 + k * 0.65);
                        }
                        c += emission * sector * auroraActive * (0.75 + auroraRhythm * 0.2);
                    }
                    gl_FragColor=vec4(c,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const sky = new T.Mesh(geometry(new T.SphereGeometry(850, 32, 20)), skyMat);
        sky.renderOrder = -100;
        root.add(sky);
        const random = seededRandom('last-train-fixed-sky');
        const positions = [], colors = [];
        for (let i = 0; i < 8000; i++) {
            const y = random(), angle = random() * Math.PI * 2;
            const r = Math.sqrt(1 - y * y);
            positions.push(Math.cos(angle) * r * 780, y * 780, Math.sin(angle) * r * 780);
            const brightness = 0.25 + Math.pow(random(), 5) * 0.75;
            colors.push(brightness * 0.86, brightness * 0.93, brightness);
        }
        const starGeo = geometry(new T.BufferGeometry());
        starGeo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
        starGeo.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
        const starMat = material(new T.PointsMaterial({ size: 1.15, sizeAttenuation: false,
            vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, fog: false }));
        const stars = new T.Points(starGeo, starMat);
        root.add(stars);
        const moon = new T.Mesh(geometry(new T.SphereGeometry(20, 32, 24)),
            material(new T.MeshBasicMaterial({ color: '#cbdde8', fog: false })));
        root.add(moon);
        const target = new T.WebGLRenderTarget(512, 320, { depthBuffer: true });
        const mirror = new T.PerspectiveCamera();
        const textureMatrix = new T.Matrix4();
        const waterMat = material(new T.ShaderMaterial({
            depthWrite: true, transparent: false,
            uniforms: { reflection: { value: target.texture }, textureMatrix: { value: textureMatrix },
                time: { value: 0 }, strength: { value: 1 }, tint: { value: new T.Color('#10212d') },
                energy: { value: 0 } },
            vertexShader: `uniform mat4 textureMatrix;varying vec4 reflected;varying vec3 world;
                void main(){vec4 p=modelMatrix*vec4(position,1.0);world=p.xyz;reflected=textureMatrix*p;
                    gl_Position=projectionMatrix*viewMatrix*p;}`,
            fragmentShader: `uniform sampler2D reflection;uniform float time,strength,energy;uniform vec3 tint;
                varying vec4 reflected;varying vec3 world;
                void main(){vec2 wave=vec2(sin(world.z*0.65+time*0.45),cos(world.x*0.48-time*0.32));
                    vec2 uv=reflected.xy/max(reflected.w,0.001)+wave*(0.0007+energy*0.0004);
                    float valid=step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0)*step(0.0,reflected.w);
                    vec3 r=texture2D(reflection,clamp(uv,0.001,0.999)).rgb;
                    float f=0.12+0.75*pow(1.0-abs(normalize(cameraPosition-world).y),3.0);
                    vec3 c=mix(tint,r,clamp(f*strength*valid,0.0,0.92));
                    gl_FragColor=vec4(c,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const water = new T.Mesh(geometry(new T.PlaneGeometry(1800, 1800)), waterMat);
        water.rotation.x = -Math.PI / 2;
        root.add(water);
        let dead = false, reflectionEnabled = true, liveStations = 0, quality = 'standard';
        let instanceKey = '', instanceTrack = null, lightAnchors = [], instanceRebuilds = 0;
        let auroraTrack = null;
        let baseStarOpacity = 0.8;
        const updateLights = (track, s, saving, audio) => {
            lightAnchors.sort((a, b) => Math.abs(a.address - s) - Math.abs(b.address - s));
            for (let i = 0; i < lights.length; i++) {
                const anchor = lightAnchors[i];
                const f = track.at(anchor?.address ?? s);
                lights[i].position.set(f.position.x - f.right.x * 3.05, 5.6, f.position.z - f.right.z * 3.05);
                lights[i].intensity = anchor && !saving ? 24 * (1 + clamp(audio.impact) * 0.12) : 0;
            }
        };
        const setPalette = (palette = {}) => {
            const light = Boolean(palette.light);
            const background = new T.Color(palette.background || '#171a1d');
            const surface = new T.Color(palette.surface || palette.background || '#20252a');
            const deep = new T.Color(palette.deep || palette.background || '#171a1d');
            const ink = new T.Color(palette.ink || '#f2f0e9');
            const muted = new T.Color(palette.muted || '#a7afb1');
            const secondary = new T.Color(palette.secondary || '#76bfae');
            const tertiary = new T.Color(palette.tertiary || palette.secondary || '#76bfae');
            const emission = new T.Color(palette.emission || palette.accent || '#f2a900');
            const structure = new T.Color(palette.material || palette.surface || '#2a3035');
            const border = new T.Color(palette.border || palette.muted || '#3b4449');
            // Separate substrate, atmospheric fill and luminous accents.
            skyMat.uniforms.night.value.copy(deep).lerp(tertiary, light ? 0.025 : 0.045)
                .multiplyScalar(light ? 0.85 : 0.42);
            skyMat.uniforms.horizon.value.copy(background).lerp(muted, light ? 0.08 : 0.2)
                .lerp(tertiary, light ? 0.035 : 0.06);
            skyMat.uniforms.cold.value.copy(tertiary);
            // Theme-native spectral pair; keep luminance bounded, retaining hue.
            const luminous = color => {
                const hsl = color.getHSL({});
                return color.setHSL(hsl.h, clamp(hsl.s, 0.25, 0.88), clamp(hsl.l, 0.42, 0.66));
            };
            skyMat.uniforms.auroraGreen.value.copy(luminous(secondary.clone()));
            skyMat.uniforms.auroraViolet.value.copy(luminous(emission.clone().lerp(tertiary, 0.12)));
            waterMat.uniforms.tint.value.copy(deep).lerp(secondary, light ? 0.04 : 0.025)
                .multiplyScalar(light ? 0.78 : 0.48);
            scene.fog = new T.FogExp2(skyMat.uniforms.horizon.value, 0.008);
            steel.color.copy(structure).lerp(muted, light ? 0.3 : 0.5);
            concrete.color.copy(surface).lerp(border, light ? 0.2 : 0.45);
            timber.color.copy(deep).lerp(structure, 0.55).lerp(emission, 0.025);
            hemisphere.color.copy(light ? surface : muted).lerp(tertiary, 0.12);
            hemisphere.groundColor.copy(deep);
            hemisphere.intensity = light ? 1.8 : 0.65;
            moonLight.color.copy(light ? surface : ink).lerp(tertiary, 0.12);
            moon.material.color.copy(light ? surface : ink).lerp(emission, 0.08);
            lampMaterial.color.copy(emission);
            lights.forEach(l => l.color.copy(emission));
            starMat.color.copy(light ? surface : ink).lerp(tertiary, 0.08);
            baseStarOpacity = light ? 0.15 : 0.8;
            starMat.opacity = baseStarOpacity;
            ridgeMaterial.color.copy(skyMat.uniforms.horizon.value).lerp(deep, 0.35)
                .multiplyScalar(light ? 0.8 : 0.55);
            wireMaterial.color.copy(border).lerp(secondary, 0.25);
        };
        const update = (timeline, track, pose, time, config, audio = {}) => {
            if (dead) return;
            const tuning = config.modes?.diorama || {};
            quality = config.quality || 'standard';
            const saving = quality === 'energy-saving';
            const s = pose.distance;
            sky.position.set(pose.position.x, 0, pose.position.z);
            stars.position.copy(sky.position);
            ridge.position.copy(sky.position);
            moon.position.set(sky.position.x - 210, 300, sky.position.z - 420);
            water.position.set(pose.position.x, 0, pose.position.z);
            stars.visible = tuning.showParticles !== false;
            starMat.opacity = baseStarOpacity * (1 - clamp(pose.finale ?? 0));
            starGeo.setDrawRange(0, saving ? 1500 : quality === 'ultimate' ? 8000 : 4000);
            skyMat.uniforms.open.value = pose.state.openness;
            const auroraEnabled = tuning.aurora !== false;
            skyMat.uniforms.auroraActive.value = auroraEnabled ? 1.0 : 0.0;
            if (auroraTrack !== track) {
                const opening = global.MusicStageDioramaCamera.pose(timeline, track, 0, tuning);
                skyMat.uniforms.auroraHeading.value = opening.yaw - 0.34;
                auroraTrack = track;
            }
            const motion = clamp(tuning.motionAmount ?? 1, 0, 2) * clamp(config.animationIntensity ?? 1, 0, 2);
            skyMat.uniforms.auroraTime.value = time * motion;
            // A phrase-length beat envelope, not the fast onset impulse (which flickers).
            const beats = timeline.beats || [];
            const index = global.MusicStageDioramaDirector.upperBound(beats, time) - 1;
            const next = beats[index + 1] ?? ((beats[index] ?? 0) + 0.9);
            const phase = Math.max(0, index) + clamp((time - (beats[index] ?? 0))
                / Math.max(0.08, next - (beats[index] ?? 0)));
            const gain = clamp(tuning.audioReactivity ?? 1, 0, 2);
            skyMat.uniforms.auroraRhythm.value = time === 0 || motion === 0 ? 0
                : (0.5 - 0.5 * Math.cos(phase * Math.PI / 8)) * gain;
            waterMat.uniforms.time.value = time;
            waterMat.uniforms.energy.value = clamp(audio.energy);
            reflectionEnabled = tuning.waterReflection !== false && (tuning.waterStrength ?? 1) > 0;
            waterMat.uniforms.strength.value = reflectionEnabled ? clamp(tuning.waterStrength ?? 1, 0, 2) : 0;
            const spacing = 16 / clamp(tuning.stationIntensity ?? 1, 0.5, 2);
            const nextInstanceKey = [Math.floor(s / 2), Math.floor(s / 0.75), Math.floor(s / spacing),
                Math.floor(s / 110), quality, tuning.narrativeStations, tuning.stationIntensity].join(':');
            if (instanceTrack === track && nextInstanceKey === instanceKey) {
                updateLights(track, s, saving, audio);
                return;
            }
            instanceTrack = track; instanceKey = nextInstanceKey; instanceRebuilds++;
            const railCount = saving ? 90 : 160;
            const railStart = Math.floor(s / 2) - 15;
            for (let i = 0; i < railCount; i++) {
                for (let side = 0; side < 2; side++) {
                    place(rails, i * 2 + side, track, (railStart + i) * 2, (side ? 1 : -1) * 0.7175,
                        0.32, 0.075, 0.13, 2.04);
                }
            }
            rails.count = railCount * 2;
            sleepers.count = saving ? 200 : 400;
            const tieStart = Math.floor(s / 0.75) - 30;
            for (let i = 0; i < sleepers.count; i++) place(sleepers, i, track, (tieStart + i) * 0.75, 0, 0.18, 2.35, 0.16, 0.24);
            const enabled = tuning.narrativeStations !== false && (tuning.stationIntensity ?? 1) > 0;
            poles.count = arms.count = lamps.count = 0;
            const poleStart = Math.floor(s / spacing) - 3;
            const speed = tuning.cameraSpeed ?? 1;
            const densityAt = address => {
                let lo = 0, hi = timeline.duration;
                for (let j = 0; j < 18; j++) {
                    const mid = (lo + hi) * 0.5;
                    if (timeline.distanceAt(mid, speed) < address) lo = mid;
                    else hi = mid;
                }
                return timeline.sample((lo + hi) * 0.5).density;
            };
            let wireVertex = 0;
            lightAnchors = [];
            for (let i = 0; i < (enabled ? (saving ? 16 : 32) : 0); i++) {
                const id = poleStart + i;
                const address = id * spacing;
                const density = densityAt(address);
                if (density < 0.4 && id % 4 !== 0) continue;
                const slot = poles.count++;
                place(poles, slot, track, address, -3.4, 3.4, 0.12, 6.8, 0.12);
                place(arms, arms.count++, track, address, -1.8, 6.7, 3.4, 0.09, 0.1);
                if (id % 7 !== 3) {
                    place(lamps, lamps.count++, track, address, -3.05, 5.8, 0.65, 0.08, 0.22);
                    lightAnchors.push({ address, distance: Math.abs(address - s) });
                }
                if (density >= 0.4) {
                    for (let segment = 0; segment < 8; segment++) {
                        for (const u of [segment / 8, (segment + 1) / 8]) {
                            const f = track.at(address + u * spacing);
                            wirePositions[wireVertex++] = f.position.x;
                            wirePositions[wireVertex++] = 6.6 - Math.sin(u * Math.PI) * 0.24;
                            wirePositions[wireVertex++] = f.position.z;
                        }
                    }
                }
            }
            wireGeometry.setDrawRange(0, wireVertex / 3);
            wireGeometry.attributes.position.needsUpdate = true;
            wires.visible = enabled;
            lightAnchors.sort((a, b) => a.distance - b.distance);
            platforms.count = benches.count = 0;
            architecture.count = masonry.count = furnishings.count = stationGlow.count = 0;
            liveStations = 0;
            stationTypes = [];
            const addPart = (mesh, address, lateral, y, sx, sy, sz) => {
                if (mesh.count >= mesh.instanceMatrix.count) return;
                place(mesh, mesh.count++, track, address, lateral, y, sx, sy, sz);
            };
            const stationStart = Math.floor(s / 110) - 1;
            const motifNames = ['sheltered-platform', 'door-gallery', 'water-stairs', 'window-arcade'];
            for (let i = 0; i < 4 && enabled; i++) {
                const id = stationStart + i;
                if (id < 0) continue;
                const address = id * 110 + 38;
                const open = densityAt(address) < 0.4;
                const type = open ? 2 : id % 4;
                const side = id % 2 ? 1 : -1;
                const lateral = value => side * value;
                // All objects remain below/away from the lyric viewing zone:
                // lyric signs stand at +/-18m; shelters stay within +/-10m.
                addPart(platforms, address, lateral(6.5), 0.55, 5, 1.1, 28);
                addPart(stationGlow, address, lateral(4.08), 1.12, 0.045, 0.035, 28);
                addPart(masonry, address, lateral(8.8), 1.25, 0.18, 0.3, 28);
                if (type === 0) {
                    // A canopy supplies near/mid-depth parallax, with a warm
                    // underside and a dark rim instead of a wireframe cage.
                    addPart(architecture, address, lateral(7), 5.35, 5.8, 0.18, 26);
                    for (let bay = 0; bay < 5; bay++) {
                        const z = address - 11 + bay * 5.5;
                        addPart(architecture, z, lateral(8.7), 3.2, 0.16, 4.2, 0.18);
                        addPart(architecture, z, lateral(6.7), 5.1, 4.2, 0.12, 0.16);
                        if ((id + bay) % 7 !== 3)
                            addPart(stationGlow, z, lateral(6.5), 5.04, 2.4, 0.035, 0.12);
                    }
                } else if (type === 1) {
                    // Receding doorways: grounded counterparts of old memory
                    // frames. A missing lintel on return creates an absence.
                    for (let bay = 0; bay < 6; bay++) {
                        const z = address - 11 + bay * 4.4;
                        for (const edge of [-1, 1])
                            addPart(masonry, z, lateral(6.8 + edge * 1.5), 2.8, 0.22, 3.4, 0.35);
                        if ((id + bay) % 6 !== 4)
                            addPart(architecture, z, lateral(6.8), 4.6, 3.3, 0.16, 0.38);
                        addPart(stationGlow, z, lateral(8.25), 3.6, 0.04, 1.2, 0.06);
                    }
                } else if (type === 2) {
                    // Broad steps descend toward the water, not into the sky.
                    // In open acts they replace dense station silhouettes.
                    for (let step = 0; step < 7; step++) {
                        const height = 1.05 - step * 0.14;
                        addPart(masonry, address, lateral(9.2 + step * 0.65),
                            height * 0.5, 0.7, height, 13 - step * 0.65);
                    }
                    for (const z of [-10, 10]) {
                        addPart(architecture, address + z, lateral(10), 2.4, 0.12, 4.8, 0.12);
                        addPart(stationGlow, address + z, lateral(10), 4.65, 0.5, 0.12, 0.5);
                    }
                } else {
                    // Window arcade and low walls leave actual openings for
                    // water and the far horizon. Missing panes are intentional.
                    addPart(masonry, address, lateral(8.8), 1.6, 0.3, 1, 25);
                    for (let bay = 0; bay < 7; bay++) {
                        const z = address - 12 + bay * 4;
                        addPart(architecture, z, lateral(8.8), 3.05, 0.14, 3, 0.14);
                        if (bay < 6 && (id + bay) % 5 !== 2) {
                            addPart(architecture, z + 2, lateral(8.8), 4.5, 0.14, 0.12, 4);
                            addPart(furnishings, z + 2, lateral(8.8), 2.4, 0.22, 0.12, 4);
                            addPart(stationGlow, z + 2, lateral(8.75), 4.42, 0.04, 0.025, 2.8);
                        }
                    }
                }
                for (let seat = 0; seat < (saving ? 1 : 3); seat++) {
                    if ((id + seat) % 4 === 2) continue;
                    const z = address - 7 + seat * 7;
                    addPart(furnishings, z, lateral(7), 1.7, 1.8, 0.15, 0.6);
                    addPart(furnishings, z, lateral(7.25), 2.04, 1.8, 0.65, 0.1);
                    for (const leg of [-0.65, 0.65])
                        addPart(architecture, z, lateral(7 + leg), 1.4, 0.08, 0.6, 0.45);
                }
                stationTypes.push(motifNames[type]);
                liveStations++;
            }
            updateLights(track, s, saving, audio);
            [rails, sleepers, poles, arms, lamps, platforms, benches,
                architecture, masonry, furnishings, stationGlow].forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
        };
        const renderReflection = (renderer, camera) => {
            if (dead || !reflectionEnabled) return;
            camera.updateMatrixWorld();
            mirror.position.copy(camera.position);
            mirror.position.y *= -1;
            const direction = camera.getWorldDirection(new T.Vector3());
            direction.y *= -1;
            mirror.up.set(0, 1, 0).transformDirection(camera.matrixWorld);
            mirror.up.y *= -1;
            mirror.lookAt(direction.add(mirror.position));
            mirror.near = camera.near;
            mirror.far = camera.far;
            mirror.projectionMatrix.copy(camera.projectionMatrix);
            mirror.updateMatrixWorld();
            textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
                .multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
            const plane = new T.Plane(new T.Vector3(0, 1, 0), 0).applyMatrix4(mirror.matrixWorldInverse);
            const clip = new T.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
            const e = mirror.projectionMatrix.elements;
            const q = new T.Vector4((Math.sign(clip.x) + e[8]) / e[0],
                (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
            const dot = clip.dot(q);
            if (Math.abs(dot) < 0.00001) return;
            clip.multiplyScalar(2 / dot);
            e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1 - 0.001; e[14] = clip.w;
            mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
            mirror.layers.enable(2);
            const size = renderer.getSize(new T.Vector2());
            const width = quality === 'ultimate' ? 1024 : quality === 'energy-saving' ? 256 : 512;
            const height = Math.max(1, Math.round(width * size.y / Math.max(1, size.x)));
            if (target.width !== width || target.height !== height) target.setSize(width, height);
            const oldTarget = renderer.getRenderTarget(), oldAutoClear = renderer.autoClear;
            const oldXr = renderer.xr.enabled;
            water.visible = false;
            try {
                renderer.xr.enabled = false;
                renderer.autoClear = true;
                renderer.setRenderTarget(target);
                renderer.clear();
                renderer.render(scene, mirror);
            } finally {
                renderer.setRenderTarget(oldTarget);
                renderer.autoClear = oldAutoClear;
                renderer.xr.enabled = oldXr;
                water.visible = true;
            }
        };
        setPalette();
        return {
            update, setPalette, renderReflection,
            snapshot: () => ({ liveStations, stationTypes, waterVisible: water.visible, reflectionEnabled,
                auroraVisible: Boolean(skyMat.uniforms.auroraActive.value > 0.5),
                starOpacity: starMat.opacity, moonRadius: 20,
                instanceRebuilds, reflectionSize: [target.width, target.height],
                architecturalInstances: architecture.count + masonry.count + furnishings.count + stationGlow.count,
                worldInstances: rails.count + sleepers.count + poles.count + platforms.count
                    + architecture.count + masonry.count + furnishings.count + stationGlow.count }),
            destroy() {
                if (dead) return;
                dead = true;
                scene.remove(root);
                root.traverse(object => { if (object.isInstancedMesh) object.dispose(); });
                geometries.forEach(g => g.dispose());
                materials.forEach(m => m.dispose());
                target.dispose();
            }
        };
    };
    global.MusicStageDioramaWorld = Object.freeze({ create });
})(window);