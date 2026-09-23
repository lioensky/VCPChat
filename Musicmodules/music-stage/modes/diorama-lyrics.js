(function (global) {
    'use strict';
    const R = global.MusicStageRuntime;
    const C = global.MusicStageDioramaCamera;
    const D = global.MusicStageDioramaDirector;
    const create = (T, scene) => {
        const root = new T.Group();
        scene.add(root);
        const live = new Map();
        const signs = new Map();
        const buildSign = encounter => {
            const group = new T.Group();
            group.position.set(encounter.position.x, encounter.position.y, encounter.position.z);
            group.rotation.y = -encounter.yaw;
            const backingColor = new T.Color(palette.surface || palette.background || '#111b1c')
                .lerp(new T.Color(palette.deep || palette.background || '#111b1c'), 0.35);
            const back = new T.MeshStandardMaterial({ color: backingColor, roughness: 0.58, metalness: 0.35 });
            const trim = new T.MeshStandardMaterial({ color: palette.secondary || '#76bfae', roughness: 0.35, metalness: 0.7 });
            const backing = new T.InstancedMesh(box, back, 1);
            const frame = new T.InstancedMesh(box, trim, 3);
            group.add(backing, frame);
            let frameIndex = 0;
            const transform = new T.Object3D();
            const add = (sx, sy, sz, x, y, z, mat) => {
                transform.scale.set(sx, sy, sz);
                transform.position.set(x, y, z);
                transform.updateMatrix();
                if (mat === back) backing.setMatrixAt(0, transform.matrix);
                else frame.setMatrixAt(frameIndex++, transform.matrix);
            };
            add(encounter.width + 0.7, encounter.height + 1.5, 0.25, 0, -0.35, -0.16, back);
            add(encounter.width + 0.9, 0.07, 0.3, 0, encounter.height / 2 + 0.4, -0.12, trim);
            for (const side of [-1, 1]) add(0.14, encounter.position.y, 0.14,
                side * encounter.width * 0.4, -encounter.position.y / 2, -0.22, trim);
            const performance = new T.ShaderMaterial({
                transparent: true, depthWrite: false,
                uniforms: { bins: { value: new Float32Array(24) }, light: { value: 0 },
                    closing: { value: 0 }, accent: { value: new T.Color(palette.accent || '#f2a900') } },
                vertexShader: `varying vec2 vUv;void main(){vUv=uv;
                    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
                fragmentShader: `varying vec2 vUv;uniform float bins[24],light,closing;uniform vec3 accent;
                    float band(float index){
                        float value=0.0;
                        for(int i=0;i<24;i++){
                            if(float(i)==clamp(index,0.0,23.0))value=bins[i];
                        }
                        return value;
                    }
                    void main(){
                        // Cubic curve with the main player's gentle 0.5 tension.
                        float x=vUv.x*23.0;
                        float index=floor(x),t=fract(x);
                        float a=band(index-1.0),b=band(index);
                        float c=band(index+1.0),d=band(index+2.0);
                        float m0=(c-a)*0.25,m1=(d-b)*0.25;
                        float t2=t*t,t3=t2*t;
                        float level=clamp((2.0*t3-3.0*t2+1.0)*b+(t3-2.0*t2+t)*m0
                            +(-2.0*t3+3.0*t2)*c+(t3-t2)*m1,min(b,c),max(b,c));
                        float edge=smoothstep(0.0,0.035,vUv.x)*(1.0-smoothstep(0.965,1.0,vUv.x));
                        float curve=0.1+level*0.75;
                        float delta=vUv.y-curve;
                        float aa=max(fwidth(delta),0.006);
                        float line=1.0-smoothstep(0.014,0.014+aa,abs(delta));
                        float halo=exp(-abs(delta)*32.0)*0.16;
                        float fill=(1.0-smoothstep(-aa,aa,delta))
                            *pow(clamp(vUv.y/max(curve,0.001),0.0,1.0),2.0)
                            *smoothstep(0.0,0.12,level)*0.12;
                        float border=step(0.94,vUv.y);
                        float runner=exp(-pow((vUv.x-closing)*16.0,2.0))
                            *step(0.001,closing)*(1.0-step(0.999,closing));
                        float alpha=edge*((line*0.72+halo+fill)*(0.35+light*0.65)+border*runner*0.5);
                        gl_FragColor=vec4(accent*(0.8+light*0.55),clamp(alpha,0.0,1.0));
                        #include <tonemapping_fragment>
                        #include <colorspace_fragment>
                    }`
            });
            const strip = new T.Mesh(plane, performance);
            strip.scale.set(encounter.width, 0.55, 1);
            strip.position.set(0, -encounter.height / 2 - 0.58, 0.025);
            group.add(strip);
            back.emissive.set(palette.accent || '#f2a900');
            trim.emissive.set(palette.accent || '#f2a900');
            root.add(group);
            return { group, materials: [back, trim, performance], textures: [], performance, back, trim };
        };
        const plane = new T.PlaneGeometry(1, 1);
        const box = new T.BoxGeometry(1, 1, 1);
        let palette = {}, timeline = null, track = null, options = {};
        let readingBounds = [], lastCamera = null, lastDiagnosticTime = 0;
        const release = node => {
            node.group.parent?.remove(node.group);
            node.group.traverse(object => {
                if (object.isInstancedMesh) object.dispose();
            });
            node.materials.forEach(m => m.dispose());
            node.textures.forEach(t => t.dispose());
            node.glyphGeometry?.dispose();
        };
        const clear = () => {
            live.forEach(release); live.clear();
            signs.forEach(release); signs.clear();
        };
        const texture = canvas => {
            const t = new T.CanvasTexture(canvas);
            t.colorSpace = T.SRGBColorSpace;
            t.minFilter = T.LinearMipmapLinearFilter;
            t.generateMipmaps = true;
            return t;
        };
        const build = phrase => {
            const group = new T.Group(), materials = [], textures = [];
            const midpoint = (phrase.start + phrase.end) * 0.5;
            const intended = C.pose(timeline, track, midpoint, options);
            const act = timeline.sample(phrase.start);
            const constellation = options.lyricCarrier === 'constellation'
                || options.lyricCarrier !== 'sign' && ['Chorus', 'Open'].includes(act.act);
            const actEnd = timeline.acts[act.actIndex]?.end ?? phrase.end;
            const style = !constellation ? 0 : actEnd - phrase.end < 4 ? 3 : act.act === 'Chorus' ? 2 : 1;
            const encounter = !constellation
                ? track.encounters[track.pageEncounter.get(phrase.id)] : null;
            const reference = intended;
            const travel = timeline.distanceAt(phrase.end, options.cameraSpeed)
                - timeline.distanceAt(phrase.start, options.cameraSpeed);
            const distance = 24 + travel * 1.3 + (constellation ? 12 : 0);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const font = `${constellation ? '500' : '700'} 144px "Microsoft YaHei","PingFang SC",sans-serif`;
            ctx.font = font;
            const advances = phrase.glyphs.map(g => Math.max(1, ctx.measureText(g.text).width));
            const total = advances.reduce((a, b) => a + b, 0);
            canvas.width = Math.min(4096, Math.ceil(total + 64));
            canvas.height = 224;
            ctx.font = font;
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffffff';
            const fit = Math.min(1, (canvas.width - 64) / total);
            ctx.save();
            ctx.translate(32, 0);
            ctx.scale(fit, 1);
            let x = 0;
            const ranges = [], starts = [], ends = [];
            phrase.glyphs.forEach((g, index) => {
                ctx.fillText(g.text, x, 108);
                ranges.push((32 + (x + advances[index]) * fit) / canvas.width);
                starts.push(g.startTime);
                ends.push(g.endTime);
                x += advances[index];
            });
            ctx.restore();
            while (ranges.length < 64) { ranges.push(2); starts.push(1e8); ends.push(1e8); }
            const map = texture(canvas);
            textures.push(map);
            const mat = new T.ShaderMaterial({
                transparent: true, depthWrite: false, side: T.DoubleSide, forceSinglePass: true,
                uniforms: {
                    map: { value: map }, time: { value: 0 }, fade: { value: 1 },
                    glow: { value: 1 }, vocal: { value: 0 },
                    constellation: { value: constellation ? 1 : 0 },
                    entrance: { value: 1 }, departure: { value: 0 },
                    motion: { value: 0 }, style: { value: style }, waterEcho: { value: 0 },
                    accent: { value: new T.Color(palette.accent || '#f2a900') },
                    ink: { value: new T.Color(palette.ink || '#f2f0e9') },
                    cold: { value: new T.Color(palette.secondary || '#76bfae') },
                    ranges: { value: ranges }, starts: { value: starts }, ends: { value: ends }
                },
                vertexShader: `
                    attribute vec3 glyphTiming;
                    uniform float time,motion,constellation,entrance,departure,style,waterEcho;
                    varying vec2 vUv;
                    void main(){
                        vUv=uv;
                        float age=max(0.0,time-glyphTiming.x);
                        float duration=max(0.04,glyphTiming.y-glyphTiming.x);
                        float singing=step(glyphTiming.x,time)*(1.0-step(glyphTiming.y,time));
                        float emphasis=sin(clamp(age/duration,0.0,1.0)*3.14159265)*singing;
                        float stagger=clamp((entrance-glyphTiming.z*0.16)/0.84,0.0,1.0);
                        stagger=stagger*stagger*(3.0-2.0*stagger);
                        float incoming=1.0-stagger;
                        vec3 p=position;
                        // Keep sign glyphs close to their physical surface.
                        p.y+=motion*(emphasis*mix(0.012,0.055,constellation)
                            -incoming*mix(0.045,0.38,constellation)
                            +departure*constellation*0.2);
                        p.z+=motion*constellation*(incoming*(0.3+glyphTiming.z*0.45)
                            -departure*(0.5+glyphTiming.z*0.25));
                        p.x+=motion*constellation*(incoming*0.08-departure*0.14)
                            *sin(glyphTiming.z*9.0);
                        if(style>1.5 && style<2.5){
                            p.x+=motion*constellation*(incoming*0.2-departure*0.28);
                        }
                        if(waterEcho>0.5)p=position;
                        gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
                    }`,
                fragmentShader: `uniform sampler2D map;uniform float time,fade,glow,vocal;
                    uniform float constellation,entrance,departure,style,waterEcho;
                    uniform vec3 accent,ink,cold;uniform float ranges[64],starts[64],ends[64];
                    varying vec2 vUv;
                    void main(){float start=1e8,end=1e8;float selected=0.0;
                        for(int i=0;i<64;i++){if(selected<0.5 && vUv.x<=ranges[i]){
                            start=starts[i];end=ends[i];selected=1.0;}}
                        float age=time-start;float singing=step(start,time)*(1.0-step(end,time));
                        float passed=step(end,time);float attack=smoothstep(0.0,0.08,age);
                        float peak=singing*attack*exp(-max(age-0.08,0.0)*8.0);
                        vec3 color=mix(ink,accent,step(start,time));
                        color=mix(color,mix(accent,cold,0.55),passed*smoothstep(0.0,0.6,time-end));
                        float wave=sin(vUv.x*9.0+time*0.7)*0.012;
                        vec2 sampleUv=vUv+vec2(0.0,wave*constellation*(1.0-entrance));
                        float alpha=texture2D(map,sampleUv).a;
                        // The same glyph supplies both the incoming water-light
                        // and the settled text. No second particle coordinate system.
                        float waterReveal=smoothstep(0.0,0.18,entrance-vUv.y*0.12);
                        float dissolve=1.0-smoothstep(0.0,0.3,departure-(1.0-vUv.x)*0.16);
                        alpha*=mix(1.0,waterReveal*dissolve,constellation);
                        if(style>2.5 && departure>0.0){
                            float speck=step(0.965,fract(sin(dot(floor(vUv*vec2(900.0,180.0)),
                                vec2(12.9898,78.233)))*43758.5453));
                            alpha=max(alpha,texture2D(map,sampleUv).a*speck*departure*0.5);
                        }
                        if(waterEcho>0.5){
                            sampleUv=vUv+vec2(sin(vUv.y*27.0+time*0.6)*0.004,
                                sin(vUv.x*43.0-time*0.7)*0.018);
                            alpha=texture2D(map,sampleUv).a;
                        }
                        float brightness=1.0+peak*glow*0.7;
                        brightness+=singing*step(0.8,end-start)*vocal*0.15*glow;
                        vec3 lit=mix(color,mix(cold,ink,0.55),constellation*0.38);
                        gl_FragColor=vec4(lit*brightness,alpha*fade*mix(0.48,0.95,step(start,time)));
                        #include <tonemapping_fragment>
                        #include <colorspace_fragment>
                    }`
            });
            materials.push(mat);
            const halfHeight = distance * Math.tan(reference.fov * Math.PI / 360);
            const glyphHeight = halfHeight * 0.19;
            let width = glyphHeight * canvas.width / canvas.height;
            const height = glyphHeight;
            const aspect = Math.max(0.35, options.aspect || 1.6);
            const scale = Math.min(1, halfHeight * 2 * aspect * 0.76 / width);
            width *= scale;
            // One atlas, one draw, independent glyph quads. Timing stays with
            // the actual glyph rather than a second detached effects emitter.
            const vertices = [], uvs = [], timings = [], indices = [];
            phrase.glyphs.forEach((glyph, index) => {
                const left = index ? ranges[index - 1] : 0;
                const right = index === phrase.glyphs.length - 1 ? 1 : ranges[index];
                const first = vertices.length / 3;
                for (const [u, v] of [[left, 0], [right, 0], [right, 1], [left, 1]]) {
                    vertices.push(u - 0.5, v - 0.5, 0);
                    uvs.push(u, v);
                    timings.push(glyph.startTime, glyph.endTime,
                        index / Math.max(1, phrase.glyphs.length - 1));
                }
                indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
            });
            const glyphGeometry = new T.BufferGeometry();
            glyphGeometry.setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
            glyphGeometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
            glyphGeometry.setAttribute('glyphTiming', new T.Float32BufferAttribute(timings, 3));
            glyphGeometry.setIndex(indices);
            const text = new T.Mesh(glyphGeometry, mat);
            text.frustumCulled = false;
            text.scale.set(width, height * scale, 1);
            text.position.z = 0.055;
            group.add(text);
            const yaw = reference.yaw;
            const right = new T.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
            const shift = constellation ? 0 : Math.min(2.5, halfHeight * aspect * 0.12);
            group.position.set(reference.position.x + reference.direction.x * distance + right.x * shift,
                Math.max(height + 0.5, reference.position.y + reference.direction.y * distance + halfHeight * 0.12),
                reference.position.z + reference.direction.z * distance + right.z * shift);
            group.rotation.y = -yaw;
            const addBox = (sx, sy, sz, px, py, pz, material) => {
                const mesh = new T.Mesh(box, material);
                mesh.scale.set(sx, sy, sz);
                mesh.position.set(px, py, pz);
                group.add(mesh);
                return mesh;
            };
            if (encounter) {
                group.position.set(0, 0, 0);
                group.rotation.y = 0;
                const ratio = canvas.width / canvas.height;
                const screenHeight = Math.min(encounter.height * 0.65, (encounter.width - 0.6) / ratio);
                text.scale.set(screenHeight * ratio, screenHeight, 1);
            }
            const supplemental = R.resolveSupplementalText(timeline.lines[phrase.lineIndex]);
            if (supplemental && options.showTranslation !== false) {
                const sub = document.createElement('canvas');
                sub.width = 2048; sub.height = 256;
                const sc = sub.getContext('2d');
                sc.font = '48px "Microsoft YaHei",sans-serif';
                sc.fillStyle = '#ffffff'; sc.textAlign = 'center'; sc.textBaseline = 'middle';
                supplemental.split('\n').slice(0, 2).forEach((line, i) => sc.fillText(line, 1024, 70 + i * 65, 1960));
                const subTexture = texture(sub);
                textures.push(subTexture);
                const subMat = new T.MeshBasicMaterial({ map: subTexture, color: palette.ink || '#f2f0e9',
                    transparent: true, opacity: 0.7, depthWrite: false, side: T.DoubleSide, forceSinglePass: true });
                materials.push(subMat);
                const subtitle = new T.Mesh(plane, subMat);
                subtitle.scale.set(Math.max(width, 7), Math.max(width, 7) / 8, 1);
                subtitle.position.set(0, -height * scale * 0.6 - 0.45, 0.07);
                if (encounter) {
                    subtitle.scale.set(encounter.width - 0.6, (encounter.width - 0.6) / 8, 1);
                    subtitle.position.y = -1.35;
                }
                group.add(subtitle);
                group.userData.subtitle = subtitle;
                if (constellation) {
                    // Kept ABOVE the clipping plane. Vertical pre-inversion
                    // cancels the mirror's vertical inversion; never put this
                    // mesh below water where oblique clipping would remove it.
                    const reflectedSubtitle = subtitle.clone();
                    reflectedSubtitle.layers.set(2);
                    reflectedSubtitle.scale.y *= -1;
                    reflectedSubtitle.position.y = Math.max(0.6, height * scale * 0.5) - group.position.y;
                    group.add(reflectedSubtitle);
                    group.userData.reflectedSubtitle = reflectedSubtitle;
                }
            }
            let echo = null, echoMat = null;
            if (constellation) {
                // Exact atlas, layout and parent world transform, mirror-only.
                echoMat = mat.clone();
                echoMat.uniforms.map.value = map;
                echoMat.uniforms.waterEcho.value = 1;
                materials.push(echoMat);
                echo = new T.Mesh(glyphGeometry, echoMat);
                echo.scale.copy(text.scale);
                echo.position.set(0, Math.max(0.3, text.scale.y * 0.52) - group.position.y, text.position.z);
                echo.layers.set(2);
                echo.frustumCulled = false;
                group.add(echo);
            }
            if (encounter) {
                const sign = signs.get(encounter.id);
                if (!sign) throw new Error(`Missing roadside sign for encounter ${encounter.id}`);
                sign.group.add(group);
            } else root.add(group);
            return { group, materials, textures, mat, phrase, constellation, text, encounter, glyphGeometry,
                echo, echoMat, style };
        };
        return {
            reset(nextTimeline, nextTrack, nextOptions, nextPalette) {
                timeline = nextTimeline; track = nextTrack; options = nextOptions; palette = nextPalette || {};
                clear();
            },
            update(time, tuning, audio = {}, camera = null) {
                if (!timeline) return;
                lastCamera = camera; lastDiagnosticTime = time;
                const distance = timeline.distanceAt(time, options.cameraSpeed ?? 1);
                signs.forEach(sign => {
                    sign.performance.uniforms.light.value = 0;
                    sign.performance.uniforms.closing.value = 0;
                    sign.back.emissiveIntensity = 0;
                    sign.trim.emissiveIntensity = 0;
                });
                const phrases = timeline.phrases;
                const center = Math.max(0, D.upperBound(phrases, time, 'start') - 1);
                const wanted = new Set();
                const desiredSigns = new Set();
                for (const encounter of track.encounters || []) {
                    // A screen must survive for all its pages, even when the train
                    // has moved beyond the usual distance-based recycling window.
                    if ((encounter.address < distance - 85 || encounter.address > distance + 145)
                        && (time < encounter.previewStart || time > encounter.releaseAfter)) continue;
                    desiredSigns.add(encounter.id);
                    if (!signs.has(encounter.id)) signs.set(encounter.id, buildSign(encounter));
                }
                for (let i = Math.max(0, center - 2); i <= Math.min(phrases.length - 1, center + 3); i++) {
                    if (time > phrases[i].end + 12 || time < phrases[i].start - 8) continue;
                    const encounterId = track.pageEncounter.get(phrases[i].id);
                    if (encounterId !== undefined && !signs.has(encounterId)) {
                        const encounter = track.encounters[encounterId];
                        desiredSigns.add(encounterId);
                        signs.set(encounterId, buildSign(encounter));
                    }
                    wanted.add(i);
                    if (!live.has(i)) live.set(i, build(phrases[i]));
                    const node = live.get(i);
                    node.mat.uniforms.time.value = time;
                    node.mat.uniforms.glow.value = R.clamp(tuning.glow ?? 1, 0, 2);
                    node.mat.uniforms.vocal.value = R.clamp(audio.vocal);
                    const reflected = node.group.userData.reflectedSubtitle;
                    const subtitle = node.group.userData.subtitle;
                    const reflectionOn = tuning.waterReflection !== false && (tuning.waterStrength ?? 1) > 0;
                    if (reflected) reflected.visible = reflectionOn && tuning.showTranslation !== false;
                    if (subtitle) subtitle.visible = tuning.showTranslation !== false && (!reflected || !reflectionOn);
                    const previousEnd = phrases[i - 1]?.end ?? -Infinity;
                    const nextStart = phrases[i + 1]?.start ?? Infinity;
                    // Sign pages must not crossfade in the same physical slot.
                    // Each side owns at most half of the intervening breath.
                    const enterDuration = Math.min(node.constellation ? 1.8 : 0.45,
                        Math.max(0.001, (node.phrase.start - previousEnd) * (node.constellation ? 1 : 0.5)));
                    const exitDuration = Math.min(node.constellation ? 2.4 : 0.4,
                        Math.max(0.001, (nextStart - node.phrase.end) * (node.constellation ? 1 : 0.5)));
                    const enter = D.smooth((time - node.phrase.start + enterDuration) / enterDuration);
                    const exit = D.smooth((time - node.phrase.end) / exitDuration);
                    node.mat.uniforms.fade.value = enter * (1 - exit);
                    node.group.visible = node.mat.uniforms.fade.value > 0;
                    const moving = !options.reducedMotion && (tuning.motionAmount ?? 1) > 0
                        && (options.animationIntensity ?? 1) > 0;
                    node.mat.uniforms.entrance.value = moving ? enter : 1;
                    node.mat.uniforms.departure.value = moving ? exit : 0;
                    node.mat.uniforms.motion.value = moving
                        ? Math.min(1.5, R.clamp(tuning.motionAmount ?? 1, 0, 2)
                            * R.clamp(options.animationIntensity ?? 1, 0, 2)) : 0;
                    if (node.echoMat) {
                        const echoFade = reflectionOn && moving
                            ? D.smooth((time - node.phrase.start + enterDuration + 0.7) / 0.7)
                                * (1 - D.smooth((time - node.phrase.end - 0.5) / 2.8)) * 0.18 : 0;
                        node.echoMat.uniforms.time.value = time;
                        node.echoMat.uniforms.fade.value = echoFade;
                        node.group.visible ||= echoFade > 0;
                        node.echo.visible = echoFade > 0;
                    }
                    if (node.encounter) {
                        const sign = signs.get(node.encounter.id);
                        const activation = node.phrase.glyphs.reduce((level, glyph) => {
                            const age = time - glyph.startTime;
                            if (age < 0) return level;
                            const singing = time < glyph.endTime;
                            return Math.max(level, singing ? 0.55 + Math.exp(-age * 8) * 0.45
                                : 0.4 * (1 - D.smooth((time - glyph.endTime) / 0.7)));
                        }, 0) * enter * (1 - exit);
                        sign.performance.uniforms.light.value = Math.max(sign.performance.uniforms.light.value, activation);
                        sign.performance.uniforms.bins.value = audio.spectrum || sign.performance.uniforms.bins.value;
                        if (time >= node.phrase.end && time < node.phrase.end + exitDuration)
                            sign.performance.uniforms.closing.value = exit;
                        sign.back.emissiveIntensity = activation * 0.035;
                        sign.trim.emissiveIntensity = activation * 0.24;
                    }
                    if (subtitle) subtitle.material.opacity = 0.7 * enter * (1 - exit);
                }
                // A malformed/overlapping vocal timeline can still produce two
                // pages at one address. Latest started page owns that address.
                // Hide the whole page, including translation and romanization.
                const owners = new Map();
                live.forEach(node => {
                    if (!node.encounter || !node.group.visible) return;
                    const previous = owners.get(node.encounter.id);
                    if (!previous || node.phrase.start > previous.phrase.start
                        || node.phrase.start === previous.phrase.start && node.phrase.id > previous.phrase.id)
                        owners.set(node.encounter.id, node);
                });
                live.forEach(node => {
                    if (node.encounter && owners.get(node.encounter.id) !== node) node.group.visible = false;
                });
                live.forEach((node, id) => { if (!wanted.has(id)) { release(node); live.delete(id); } });
                signs.forEach((node, id) => {
                    if (!desiredSigns.has(id)) { release(node); signs.delete(id); }
                });
            },
            diagnose() {
                const camera = lastCamera, time = lastDiagnosticTime;
                readingBounds = [];
                if (camera) {
                    camera.updateMatrixWorld();
                    root.updateMatrixWorld(true);
                    live.forEach(node => {
                        if (time < node.phrase.start || time >= node.phrase.end) return;
                        // Mirror the vertex shader, not the undeformed plane.
                        // This diagnostic catches real animated glyph overflow.
                        const attributes = node.glyphGeometry.attributes;
                        const uniforms = node.mat.uniforms;
                        const amount = uniforms.motion.value;
                        const sky = node.constellation ? 1 : 0;
                        const entrance = uniforms.entrance.value;
                        const departure = uniforms.departure.value;
                        const corners = [];
                        let fitsCarrier = true;
                        const toCarrier = node.text.matrix.clone();
                        for (let v = 0; v < attributes.position.count; v++) {
                            const start = attributes.glyphTiming.getX(v);
                            const end = attributes.glyphTiming.getY(v);
                            const order = attributes.glyphTiming.getZ(v);
                            const age = Math.max(0, time - start);
                            const emphasis = time >= start && time < end
                                ? Math.sin(R.clamp(age / Math.max(0.04, end - start)) * Math.PI) : 0;
                            const incoming = 1 - D.smooth((entrance - order * 0.16) / 0.84);
                            const vertex = new T.Vector3(
                                attributes.position.getX(v) + amount * sky
                                    * ((incoming * 0.08 - departure * 0.14) * Math.sin(order * 9)
                                        + (node.style === 2 ? incoming * 0.2 - departure * 0.28 : 0)),
                                attributes.position.getY(v) + amount
                                    * (emphasis * (sky ? 0.055 : 0.012)
                                        - incoming * (sky ? 0.38 : 0.045) + departure * sky * 0.2),
                                attributes.position.getZ(v) + amount * sky
                                    * (incoming * (0.3 + order * 0.45) - departure * (0.5 + order * 0.25))
                            );
                            if (node.encounter) {
                                const local = vertex.clone().applyMatrix4(toCarrier);
                                fitsCarrier &&= Math.abs(local.x) <= node.encounter.width / 2
                                    && Math.abs(local.y) <= node.encounter.height / 2
                                    && local.z > -0.035;
                            }
                            corners.push(vertex.applyMatrix4(node.text.matrixWorld).project(camera));
                        }
                        const left = Math.min(...corners.map(p => p.x));
                        const right = Math.max(...corners.map(p => p.x));
                        const bottom = Math.min(...corners.map(p => p.y));
                        const top = Math.max(...corners.map(p => p.y));
                        const sign = node.encounter && signs.get(node.encounter.id);
                        const signCentre = sign
                            ? new T.Vector3(0, 0, 0).applyMatrix4(sign.group.matrixWorld) : null;
                        const textCentre = new T.Vector3().applyMatrix4(node.text.matrixWorld);
                        readingBounds.push({
                            phraseId: node.phrase.id, left, right, bottom, top,
                            carrier: node.encounter ? 'sign' : 'sky',
                            encounterId: node.encounter?.id ?? null,
                            side: node.encounter?.side ?? null,
                            fitsCarrier,
                            animatedVertices: corners.length,
                            attached: !node.encounter || node.group.parent === sign?.group,
                            anchorError: signCentre ? signCentre.distanceTo(textCentre) : 0,
                            heightRatio: (top - bottom) / 2,
                            inside: corners.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)
                                && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.z) <= 1)
                        });
                    });
                }
            },
            snapshot() { this.diagnose(); return ({ readingBounds, liveSigns: signs.size,
                visibleSignPages: Array.from(live.values())
                    .filter(node => node.encounter && node.group.visible)
                    .map(node => ({ encounterId: node.encounter.id, phraseId: node.phrase.id })),
                encounterCount: track?.encounters.length || 0,
                encounterSides: track?.encounters.map(item => item.side) || [],
                lyricNodes: live.size, lyricTextures: Array.from(live.values())
                .reduce((sum, node) => sum + node.textures.length, 0) }); },
            destroy() { clear(); plane.dispose(); box.dispose(); scene.remove(root); timeline = track = null; }
        };
    };
    global.MusicStageDioramaLyrics = Object.freeze({ create });
})(window);