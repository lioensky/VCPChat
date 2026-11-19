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
        const buildSign = (encounter, standby) => {
            const group = new T.Group();
            group.position.set(encounter.position.x, encounter.position.y, encounter.position.z);
            group.rotation.y = -encounter.yaw;
            const backingColor = new T.Color(palette.surface || palette.background || '#111b1c')
                .lerp(new T.Color(palette.deep || palette.background || '#111b1c'), 0.35);
            const trimColor = new T.Color(palette.secondary || '#76bfae');
            // One material and one draw for the whole board: the backing parts
            // come first, the bright trim after them, each in its own colour.
            const back = new T.MeshStandardMaterial({
                roughness: 0.58, metalness: 0.35,
                emissive: palette.accent || '#f2a900', emissiveIntensity: 0
            });
            // A board with nothing on it is still a made thing: cabinet seams
            // across its face, glass that picks up the sky at a glancing view,
            // and at night the hood lamps washing down it, a pool under each.
            const sheen = { value: new T.Color(palette.secondary || '#76bfae') };
            // New boards can be rendered immediately, even on a paused frame.
            const wash = { value: back.emissive.clone().multiplyScalar(standby) };
            const pitch = { value: 3 }, backings = { value: 0 };
            back.onBeforeCompile = shader => {
                Object.assign(shader.uniforms, { sheen, wash, pitch, backings });
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>',
                        '#include <common>\nuniform float backings;\nvarying float vTrim;\nvarying vec2 vPanel;\nvarying vec2 vFace;')
                    .replace('#include <begin_vertex>', `#include <begin_vertex>
                        #ifdef USE_INSTANCING
                        vTrim = step(backings - 0.5, float(gl_InstanceID));
                        #else
                        vTrim = 0.0;
                        #endif
                        #ifdef USE_INSTANCING
                        vec2 panel = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
                        #else
                        vec2 panel = vec2(1.0);
                        #endif
                        vPanel = uv * panel;
                        // Only the lyric face of the board itself is lamplit.
                        vFace = vec2(step(0.5, normal.z) * step(1.5, panel.y), panel.y);`);
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>',
                        '#include <common>\nvarying float vTrim;\nvarying vec2 vPanel;\nvarying vec2 vFace;\nuniform vec3 sheen, wash;\nuniform float pitch;')
                    .replace('#include <roughnessmap_fragment>',
                        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, vTrim);')
                    .replace('#include <metalnessmap_fragment>',
                        '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.7, vTrim);')
                    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
                        // Trim glows about seven times as strongly as the backing.
                        totalEmissiveRadiance *= mix(1.0, 6.857, vTrim);
                        float plain = 1.0 - vTrim;
                        vec2 cabinet = abs(fract(vPanel / 0.96) - 0.5) * 0.96;
                        float grain = length(fwidth(vPanel));
                        float seam = (1.0 - smoothstep(0.004, 0.02 + grain, 0.48 - max(cabinet.x, cabinet.y)))
                            * 0.03 / (0.03 + grain);
                        float grazing = 1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
                        float glance = grazing * grazing * grazing;
                        totalEmissiveRadiance += sheen * (0.01 + 0.16 * glance) * (1.0 - 0.7 * seam) * plain;
                        float below = vFace.y - vPanel.y;
                        float lamp = 0.5 + 0.5 * cos(6.2832 * vPanel.x / pitch - 3.1416);
                        float pool = exp(-below * 0.85) * mix(0.3 + 0.7 * lamp, 1.0, smoothstep(0.0, 1.5, below))
                            * smoothstep(0.0, 0.12, below);
                        totalEmissiveRadiance += wash * pool * vFace.x * (1.0 - 0.45 * seam) * plain;`);
            };
            // A trackside display board: bezel, hooded lamp row, lattice legs
            // on footings, raking back stays, a service ledge and its ladder.
            const trim = 'trim', pieces = [[], []];
            const transform = new T.Object3D();
            const add = (sx, sy, sz, x, y, z, mat, rx = 0, rz = 0) => {
                transform.scale.set(sx, sy, sz);
                transform.position.set(x, y, z);
                transform.rotation.set(rx, 0, rz);
                transform.updateMatrix();
                pieces[mat === trim ? 1 : 0].push(transform.matrix.clone());
            };
            const W = encounter.width + 0.7, H = encounter.height + 1.5;
            const top = H / 2 - 0.35, bottom = -H / 2 - 0.35, water = -encounter.position.y;
            add(W, H, 0.25, 0, -0.35, -0.16, back);
            add(W + 0.2, 0.09, 0.34, 0, top, -0.12, trim);
            add(W + 0.2, 0.09, 0.34, 0, bottom, -0.12, trim);
            for (const side of [-1, 1]) add(0.09, H, 0.34, side * W / 2, -0.35, -0.12, trim);
            // Hood and the lamps under it.
            add(W + 0.5, 0.07, 1.0, 0, top + 0.2, 0.26, back, 0.12);
            const lamps = Math.max(3, Math.round(W / 3));
            pitch.value = W / lamps;
            for (let i = 0; i < lamps; i++)
                add(0.7, 0.05, 0.1, (i + 0.5) / lamps * W - W / 2, top + 0.08, 0.6, trim);
            // Service ledge along the foot of the board.
            add(W, 0.06, 0.8, 0, bottom - 0.05, 0.28, back);
            add(W, 0.04, 0.04, 0, bottom + 0.42, 0.66, trim);
            for (let i = 0; i <= 4; i++) add(0.04, 0.46, 0.04, (i / 4 - 0.5) * (W - 0.1), bottom + 0.2, 0.66, trim);
            const legHeight = bottom - water + 0.6, legY = (bottom + water - 0.6) / 2;
            for (const side of [-1, 1]) {
                const x = side * encounter.width * 0.36;
                for (const chord of [-0.42, 0.42]) add(0.12, legHeight, 0.12, x + chord, legY, -0.28, trim);
                // Lattice between the chords, then a stay raking back into the water.
                const bays = Math.max(1, Math.round((bottom - water) / 0.9)), bay = (bottom - water) / bays;
                for (let i = 0; i < bays; i++) {
                    add(Math.hypot(0.84, bay), 0.05, 0.05, x, bottom - (i + 0.5) * bay, -0.28, trim,
                        0, (i % 2 ? 1 : -1) * Math.atan2(bay, 0.84));
                    add(0.84, 0.05, 0.05, x, bottom - (i + 1) * bay + 0.03, -0.28, trim);
                }
                add(1.5, 0.5, 1.5, x, water + 0.12, -0.28, back);
                const rise = top - 1.2 - water, run = 3.4;
                add(0.1, Math.hypot(rise, run), 0.1, x, water + rise / 2, -0.3 - run / 2, trim, Math.atan2(run, rise));
                add(0.9, 0.4, 0.9, x, water + 0.1, -0.3 - run, back);
                add(0.14, 0.14, 0.14, side * (W / 2 + 0.02), top + 0.3, -0.12, trim);
            }
            // Ladder up to the ledge.
            const ladder = encounter.width * 0.36 + 1.15;
            for (const stile of [-0.2, 0.2]) add(0.04, bottom - water + 0.5, 0.04, ladder + stile, (bottom + water) / 2 + 0.25, 0.62, trim);
            for (let y = water + 0.35; y < bottom + 0.4; y += 0.32) add(0.4, 0.03, 0.03, ladder, y, 0.62, trim);
            const parts = new T.InstancedMesh(box, back, pieces[0].length + pieces[1].length);
            backings.value = pieces[0].length;
            pieces.flat().forEach((matrix, i) => {
                parts.setMatrixAt(i, matrix);
                parts.setColorAt(i, i < backings.value ? backingColor : trimColor);
            });
            group.add(parts);
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
            root.add(group);
            group.updateMatrixWorld(true);
            // held starts at rest: a board built partway through a frame is
            // lit by it before the next frame's reset reaches it.
            return { group, materials: [back, performance], textures: [], performance, back, wash, held: 0,
                size: { x: W / 2, y: H / 2 } };
        };
        const plane = new T.PlaneGeometry(1, 1);
        const box = new T.BoxGeometry(1, 1, 1);
        let palette = {}, timeline = null, track = null, options = {};
        let readingBounds = [], lastCamera = null, lastDiagnosticTime = 0;
        const sight = new T.Raycaster();
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
        // A line of words written on the sky or on a board; the warm-up builds one too.
        const skyLine = ({ map, constellation, style, ranges, starts, ends }) => new T.ShaderMaterial({
            transparent: true, depthWrite: false, side: T.DoubleSide, forceSinglePass: true,
            // A line written on the sky is never hidden by what the train passes.
            depthTest: !constellation,
            uniforms: {
                map: { value: map }, time: { value: 0 }, fade: { value: 1 },
                glow: { value: 1 }, vocal: { value: 0 },
                constellation: { value: constellation ? 1 : 0 },
                entrance: { value: 1 }, departure: { value: 0 },
                motion: { value: 0 }, style: { value: style }, waterEcho: { value: 0 },
                // Dark strokes blended over a pale sky in linear light come out
                // far paler than their opacity suggests, so by day the words
                // still to be sung are laid on more heavily.
                rest: { value: palette.light ? 0.82 : 0.48 },
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
                    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
                }`,
            fragmentShader: `uniform sampler2D map;uniform float time,fade,glow,vocal;
                uniform float constellation,entrance,departure,style,waterEcho,rest;
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
                        // Preserve the source glyph's reveal and dissolve
                        // while adding only the water's soft breakup.
                        alpha*=mix(0.72,1.0,waterReveal*dissolve);
                    }
                    float brightness=1.0+peak*glow*0.7;
                    brightness+=singing*step(0.8,end-start)*vocal*0.15*glow;
                    vec3 lit=mix(color,mix(cold,ink,0.55),constellation*0.38);
                    gl_FragColor=vec4(lit*brightness,alpha*fade*mix(rest,0.95,step(start,time)));
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        });
        const subtitleMaterial = (map, constellation) => new T.MeshBasicMaterial({ map, color: palette.ink || '#f2f0e9',
            transparent: true, opacity: 0.7, depthWrite: false, depthTest: !constellation,
            side: T.DoubleSide, forceSinglePass: true });
        const build = phrase => {
            const group = new T.Group(), materials = [], textures = [];
            const midpoint = (phrase.start + phrase.end) * 0.5;
            const intended = C.pose(timeline, track, midpoint, options);
            let opening = C.pose(timeline, track, phrase.start, options);
            let closing = C.pose(timeline, track, phrase.end, options);
            const act = timeline.sample(phrase.start);
            const constellation = options.lyricCarrier === 'constellation'
                || options.lyricCarrier !== 'sign' && ['Chorus', 'Open'].includes(act.act);
            let reference = intended;
            // A line sung while the camera swings round cannot stay in a picture
            // that is turning past it. Write it where the camera spends most of
            // the line looking, so it is read whole for as long as possible.
            const heading = view => { const g = view.sky || view.direction; return Math.atan2(g.x, -g.z); };
            const turnBetween = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
            if (constellation && turnBetween(heading(opening), heading(closing)) > 0.5) {
                const views = Array.from({ length: 13 }, (_, i) =>
                    C.pose(timeline, track, phrase.start + (phrase.end - phrase.start) * i / 12, options));
                const reach = Math.atan(Math.tan((views[6].fov || 48) * Math.PI / 360)
                    * Math.max(0.35, options.aspect || 1.6)) * 0.55;
                let best = views[6], held = -1;
                for (const view of views) {
                    const count = views.filter(other => turnBetween(heading(other), heading(view)) < reach).length;
                    if (count >= held) { held = count; best = view; }
                }
                opening = closing = reference = best;
            }
            const actEnd = timeline.acts[act.actIndex]?.end ?? phrase.end;
            const style = !constellation ? 0 : actEnd - phrase.end < 4 ? 3 : act.act === 'Chorus' ? 2 : 1;
            const encounter = !constellation
                ? track.encounters[track.pageEncounter.get(phrase.id)] : null;
            // How far the camera itself goes while the line is up.
            const at = time => track.addressAt ? track.addressAt(time) : timeline.distanceAt(time, options.cameraSpeed);
            const travel = at(phrase.end) - at(phrase.start);
            const distance = 24 + travel * 1.3 + (constellation ? 12 : 0);
            const canvas = document.createElement('canvas');
            // Drawn on the CPU: an accelerated canvas has to be read back from the GPU to become a texture.
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            // Microsoft YaHei has only regular and bold: anything under 600 is the
            // thin regular face, which loses its strokes against the sky.
            const font = `700 144px "Microsoft YaHei","PingFang SC",sans-serif`;
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
            const mat = skyLine({ map, constellation, style, ranges, starts, ends });
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
            const yaw = constellation ? reference.skyYaw ?? reference.yaw : reference.yaw;
            const right = new T.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
            const shift = constellation ? 0 : Math.min(2.5, halfHeight * aspect * 0.12);
            // The camera keeps travelling and turning while a phrase is read.
            // Aim at where it looks over the whole phrase, not only at its midpoint.
            const gaze = view => constellation && view.sky || view.direction;
            const aimed = axis => (opening.position[axis] + gaze(opening)[axis] * distance) * 0.25
                + (reference.position[axis] + gaze(reference)[axis] * distance) * 0.5
                + (closing.position[axis] + gaze(closing)[axis] * distance) * 0.25;
            group.position.set(aimed('x') + right.x * shift,
                Math.max(height + 0.5, aimed('y') + halfHeight * 0.12),
                aimed('z') + right.z * shift);
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
                const screenHeight = Math.min(encounter.height * 0.6, (encounter.width - 0.6) / ratio);
                text.scale.set(screenHeight * ratio, screenHeight, 1);
            }
            const supplemental = R.resolveSupplementalText(timeline.lines[phrase.lineIndex]);
            if (supplemental && options.showTranslation !== false) {
                const sub = document.createElement('canvas');
                sub.width = 2048; sub.height = 256;
                const sc = sub.getContext('2d', { willReadFrequently: true });
                const subWidth = encounter ? encounter.width - 0.6 : Math.max(width, 7);
                // Size the translation against the lyric it accompanies, then
                // shrink or wrap only as far as the text needs.
                const wanted = encounter ? 0.74 : height * scale * 0.27;
                const subFont = px => `500 ${Math.round(px)}px "Microsoft YaHei","PingFang SC",sans-serif`;
                let rows = supplemental.split('\n').map(row => row.trim()).filter(Boolean).slice(0, 2);
                let px = R.clamp(wanted / subWidth * 2048, 44, 116);
                const widest = () => { sc.font = subFont(px); return Math.max(1, ...rows.map(row => sc.measureText(row).width)); };
                if (rows.length === 1 && widest() > 1960) {
                    const glyphs = R.splitGraphemes(rows[0]);
                    let cut = Math.ceil(glyphs.length / 2);
                    for (let offset = 0; offset < glyphs.length / 4; offset++) {
                        if (!(glyphs[cut + offset] || 'x').trim()) { cut += offset; break; }
                        if (!(glyphs[cut - offset] || 'x').trim()) { cut -= offset; break; }
                    }
                    rows = [glyphs.slice(0, cut).join('').trim(), glyphs.slice(cut).join('').trim()].filter(Boolean);
                }
                if (rows.length > 1) px = Math.min(px, 92);
                px = Math.max(40, px * Math.min(1, 1960 / widest()));
                sc.font = subFont(px);
                sc.fillStyle = '#ffffff'; sc.textAlign = 'center'; sc.textBaseline = 'middle';
                rows.forEach((row, i) => sc.fillText(row, 1024, 128 + (i - (rows.length - 1) / 2) * px * 1.22, 1960));
                const subTexture = texture(sub);
                textures.push(subTexture);
                const subMat = subtitleMaterial(subTexture, constellation);
                materials.push(subMat);
                const subtitle = new T.Mesh(plane, subMat);
                subtitle.scale.set(subWidth, subWidth / 8, 1);
                subtitle.position.set(0, -height * scale * 0.5 - subWidth / 16 * 0.62, 0.07);
                if (encounter) {
                    // Two rows on the screen: lyric above, translation below.
                    text.position.y = 0.42;
                    subtitle.position.y = -1.3;
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
            // The water pass reflects layer 0 automatically. Keep the live
            // constellation on layer 1 so the explicit echo below is the only
            // lyric reflection and can own its opacity and animation.
            if (constellation) {
                group.traverse(object => object.layers.set(1));
                if (group.userData.reflectedSubtitle)
                    group.userData.reflectedSubtitle.layers.set(2);
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
            const subtitle = group.userData.subtitle;
            return { group, materials, textures, mat, phrase, constellation, text, encounter, glyphGeometry,
                echo, echoMat, style, home: group.position.clone(), homeYaw: group.rotation.y,
                halfWidth: width / 2, halfHeight: height * scale / 2,
                // Lower edge of the block once the translation rows are included.
                subtitleDrop: subtitle ? subtitle.scale.y * 0.3 - subtitle.position.y : 0,
                echoLevel: echo ? echo.position.y + group.position.y : 0,
                reflectedLevel: group.userData.reflectedSubtitle
                    ? group.userData.reflectedSubtitle.position.y + group.position.y : 0 };
        };
        // Sky lyrics live in the world, but a turning camera may not push them
        // out of the picture. Slide the block just far enough to stay readable;
        // the correction is a pure function of the current camera pose.
        const corner = new T.Vector3(), slide = new T.Vector3(), axis = new T.Vector3();
        const swung = new T.Vector3();
        const keepInFrame = (node, camera, frame) => {
            const group = node.group;
            // When the camera turns away from where a line was written, the edge
            // of the picture carries the line round with it, still facing the
            // camera, so a sung line is never left behind the lens.
            const home = swung.copy(node.home);
            group.rotation.y = node.homeYaw;
            if (camera) {
                const m = camera.matrixWorld.elements;
                const ox = home.x - m[12], oz = home.z - m[14], reach = Math.hypot(ox, oz);
                const fx = -m[8], fz = -m[10];
                if (reach > 1e-3 && Math.hypot(fx, fz) > 1e-3) {
                    const heading = Math.atan2(ox, -oz), gaze = Math.atan2(fx, -fz);
                    const off = Math.atan2(Math.sin(heading - gaze), Math.cos(heading - gaze));
                    const edge = Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect * (frame?.x ?? 0.94));
                    const allowed = Math.max(0, edge - Math.atan(node.halfWidth / reach));
                    if (Math.abs(off) > allowed) {
                        const turn = off - Math.sign(off) * allowed, carried = heading - turn;
                        home.x = m[12] + Math.sin(carried) * reach;
                        home.z = m[14] - Math.cos(carried) * reach;
                        group.rotation.y = node.homeYaw + turn;
                    }
                }
            }
            group.position.copy(home);
            if (camera) {
                const tanV = Math.tan(camera.fov * Math.PI / 360);
                const tanH = tanV * camera.aspect;
                const limitX = frame?.x ?? 0.94, limitY = frame?.y ?? 0.9;
                const ry = group.rotation.y;
                const drop = group.userData.subtitle?.visible
                    ? Math.max(node.halfHeight, node.subtitleDrop) : node.halfHeight;
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, behind = false;
                for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
                    corner.set(home.x + Math.cos(ry) * node.halfWidth * sx,
                        home.y + (sy > 0 ? node.halfHeight : -drop),
                        home.z - Math.sin(ry) * node.halfWidth * sx).applyMatrix4(camera.matrixWorldInverse);
                    if (corner.z > -1) behind = true;
                    minX = Math.min(minX, corner.x / (-corner.z * tanH));
                    maxX = Math.max(maxX, corner.x / (-corner.z * tanH));
                    minY = Math.min(minY, corner.y / (-corner.z * tanV));
                    maxY = Math.max(maxY, corner.y / (-corner.z * tanV));
                }
                const correction = (low, high, limit) => high - low >= limit * 2 ? -(high + low) / 2
                    : high > limit ? limit - high : low < -limit ? -limit - low : 0;
                corner.copy(home).applyMatrix4(camera.matrixWorldInverse);
                const depth = -corner.z;
                // A display board nearer than the line would hide it: the line
                // rises clear of the board for as long as the two overlap.
                let lift = 0;
                if (!behind) signs.forEach(board => {
                    let boardLeft = Infinity, boardRight = -Infinity, boardBottom = Infinity, boardTop = -Infinity;
                    let nearest = Infinity;
                    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
                        corner.set(sx * board.size.x, sy * board.size.y - 0.35, 0)
                            .applyMatrix4(board.group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
                        nearest = Math.min(nearest, -corner.z);
                        boardLeft = Math.min(boardLeft, corner.x / (-corner.z * tanH));
                        boardRight = Math.max(boardRight, corner.x / (-corner.z * tanH));
                        boardBottom = Math.min(boardBottom, corner.y / (-corner.z * tanV));
                        boardTop = Math.max(boardTop, corner.y / (-corner.z * tanV));
                    }
                    if (nearest < 1 || nearest > depth || boardBottom > maxY) return;
                    const shared = (Math.min(maxX, boardRight) - Math.max(minX, boardLeft)) / Math.max(1e-6, maxX - minX);
                    lift = Math.max(lift, Math.max(0, boardTop + 0.05 - minY) * D.smooth(shared / 0.15));
                });
                const dx = behind ? 0 : correction(minX, maxX, limitX);
                const dy = behind ? 0 : lift + correction(minY + lift, maxY + lift, limitY);
                if (dx || dy) {
                    slide.set(0, 0, 0);
                    slide.addScaledVector(axis.setFromMatrixColumn(camera.matrixWorld, 0), dx * depth * tanH);
                    slide.addScaledVector(axis.setFromMatrixColumn(camera.matrixWorld, 1), dy * depth * tanV);
                    group.position.add(slide);
                    group.position.y = Math.max(node.halfHeight + 0.4, group.position.y);
                }
            }
            // Mirror-only children are parked at a fixed world height.
            if (node.echo) node.echo.position.y = node.echoLevel - group.position.y;
            const reflected = group.userData.reflectedSubtitle;
            if (reflected) reflected.position.y = node.reflectedLevel - group.position.y;
        };
        /*
         * Boards and lines are built as the song reaches them, long after the
         * stage has warmed its shaders. One of each, never shown, is built now
         * so their shaders are compiled with the rest and the first board or
         * line of the song does not stall the frame it appears in.
         */
        const primer = (() => {
            const blank = global.document.createElement('canvas');
            blank.width = blank.height = 4;
            const map = texture(blank);
            const sign = buildSign({ position: { x: 0, y: -400, z: 0 }, yaw: 0, width: 4, height: 2 }, 0);
            const none = new Array(64).fill(2), never = new Array(64).fill(1e8);
            const line = skyLine({ map, constellation: false, style: 0, ranges: none, starts: never, ends: never });
            const subtitle = subtitleMaterial(map, false);
            sign.group.add(new T.Mesh(plane, line), new T.Mesh(plane, subtitle));
            sign.group.visible = false;
            return { sign, map, materials: [line, subtitle] };
        })();
        return {
            reset(nextTimeline, nextTrack, nextOptions, nextPalette) {
                timeline = nextTimeline; track = nextTrack; options = nextOptions; palette = nextPalette || {};
                clear();
            },
            update(time, tuning, audio = {}, camera = null, frame = null) {
                if (!timeline) return;
                camera?.updateMatrixWorld();
                lastCamera = camera; lastDiagnosticTime = time;
                const distance = track.addressAt ? track.addressAt(time) : timeline.distanceAt(time, options.cameraSpeed ?? 1);
                // Hood lamps are a night thing, and they dim while a line is up.
                // A line written on the sky is drawn over whatever stands behind
                // it, and a lit board there would eat its contrast: while one is
                // up, and a little either side of it, every board goes dark.
                let sky = 0;
                const around = Math.max(0, D.upperBound(timeline.phrases, time, 'start') - 1);
                for (let i = Math.max(0, around - 2); i <= Math.min(timeline.phrases.length - 1, around + 3); i++) {
                    const phrase = timeline.phrases[i];
                    if (track.pageEncounter?.has(phrase.id)) continue;
                    sky = Math.max(sky, D.smooth((time - phrase.start + 1.6) / 1.2)
                        * (1 - D.smooth((time - phrase.end - 1) / 2)));
                }
                const standby = (palette.light ? 0 : 0.24) * (1 - sky);
                signs.forEach(sign => {
                    sign.performance.uniforms.light.value = 0;
                    sign.performance.uniforms.closing.value = 0;
                    sign.back.emissiveIntensity = 0;
                    sign.held = 0;
                    sign.wash.value.copy(sign.back.emissive).multiplyScalar(standby);
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
                    if (!signs.has(encounter.id)) signs.set(encounter.id, buildSign(encounter, standby));
                }
                for (let i = Math.max(0, center - 2); i <= Math.min(phrases.length - 1, center + 3); i++) {
                    if (time > phrases[i].end + 12 || time < phrases[i].start - 8) continue;
                    const encounterId = track.pageEncounter.get(phrases[i].id);
                    if (encounterId !== undefined && !signs.has(encounterId)) {
                        const encounter = track.encounters[encounterId];
                        desiredSigns.add(encounterId);
                        signs.set(encounterId, buildSign(encounter, standby));
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
                    // The upright translation is the readable one; its water
                    // echo is decoration and never a substitute.
                    if (subtitle) subtitle.visible = tuning.showTranslation !== false;
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
                                * (1 - D.smooth((time - node.phrase.end - 0.5) / 2.8))
                                * node.mat.uniforms.fade.value * 0.18 : 0;
                        node.echoMat.uniforms.time.value = time;
                        node.echoMat.uniforms.fade.value = echoFade;
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
                        // The lamps go down ahead of a line and come back only once
                        // the board has stood empty for a while, so they do not
                        // flash in the breath between two lines on the same board.
                        sign.held = Math.max(sign.held, D.smooth((time - node.phrase.start + 1.4) / 1.2)
                            * (1 - D.smooth((time - node.phrase.end - 1.6) / 2.4)));
                        sign.wash.value.copy(sign.back.emissive).multiplyScalar(standby * (1 - 0.8 * sign.held));
                    }
                    if (subtitle) subtitle.material.opacity = (palette.light ? 0.96 : 0.82) * enter * (1 - exit);
                    if (node.constellation) keepInFrame(node, camera, frame);
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
                        const textCentre = new T.Vector3().applyMatrix4(node.text.matrixWorld);
                        // How much of a sky line a nearer display board hides.
                        let covered = 0;
                        if (!node.encounter && right > left && top > bottom) signs.forEach(board => {
                            const half = board.size;
                            const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new T.Vector3(
                                x * half.x, y * half.y - 0.35, 0).applyMatrix4(board.group.matrixWorld).project(camera));
                            if (points.some(p => Math.abs(p.z) > 1) || points[0].z > corners[0].z) return;
                            const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
                            covered = Math.max(covered,
                                overlap(left, right, Math.min(...points.map(p => p.x)), Math.max(...points.map(p => p.x)))
                                * overlap(bottom, top, Math.min(...points.map(p => p.y)), Math.max(...points.map(p => p.y)))
                                / ((right - left) * (top - bottom)));
                        });
                        // Share of the line that scenery (poles, shelters, posts)
                        // stands in front of, sampled on a grid of sight lines.
                        let blocked = 0, blockedBy = '';
                        const scenery = scene.children.filter(child => child !== root);
                        for (let ix = 0; ix < 5; ix++) for (let iy = 0; iy < 3; iy++) {
                            const target = new T.Vector3(-0.45 + ix * 0.225, -0.35 + iy * 0.35, 0)
                                .applyMatrix4(node.text.matrixWorld);
                            const origin = new T.Vector3().setFromMatrixPosition(camera.matrixWorld);
                            const reach = origin.distanceTo(target);
                            sight.set(origin, target.sub(origin).normalize());
                            sight.far = reach - 0.6;
                            const hit = sight.intersectObjects(scenery, true).find(item => item.object.isInstancedMesh);
                            if (hit) { blocked++; blockedBy = `${hit.object.name}@${Math.round(hit.distance)}m`; }
                        }
                        blocked /= 15;
                        readingBounds.push({
                            phraseId: node.phrase.id, left, right, bottom, top, covered, blocked, blockedBy,
                            fade: uniforms.fade.value,
                            carrier: node.encounter ? 'sign' : 'sky',
                            encounterId: node.encounter?.id ?? null,
                            side: node.encounter?.side ?? null,
                            fitsCarrier,
                            animatedVertices: corners.length,
                            attached: !node.encounter || node.group.parent === sign?.group,
                            // Which row of the screen a line sits on is layout; drifting
                            // sideways or off the surface is the error.
                            anchorError: sign ? Math.hypot(...sign.group.worldToLocal(textCentre.clone())
                                .toArray().filter((_, axis) => axis !== 1)) : 0,
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
            destroy() {
                clear();
                release(primer.sign);
                primer.materials.forEach(material => material.dispose());
                primer.map.dispose();
                plane.dispose(); box.dispose(); scene.remove(root); timeline = track = null;
            }
        };
    };
    global.MusicStageDioramaLyrics = Object.freeze({ create });
})(window);
