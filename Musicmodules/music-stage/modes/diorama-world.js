(function (global) {
    'use strict';
    const { clamp, seededRandom } = global.MusicStageRuntime;
    const smooth = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
    // A pole stands between the train and whatever it looks at. Each one goes
    // on the side away from the next roadside screen, so it never crosses a lyric.
    const poleSide = (track, address, fallback = -1) => {
        const encounters = track?.encounters || [];
        let lo = 0, hi = encounters.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (encounters[mid].address - 10 < address) lo = mid + 1;
            else hi = mid;
        }
        const next = encounters[lo];
        return next && next.address - address < 140 ? -next.side : fallback;
    };
    // Whether something `lateral` metres off the track at `address` comes
    // between the train and a lyric screen on that side while the screen is
    // being read. Screens are 16 m wide; the camera reads from startDistance
    // to endDistance.
    const inSight = (track, address, lateral, side, margin = 3) => {
        for (const screen of track?.encounters || []) {
            if (screen.side !== side || Math.abs(screen.address - address) > 160) continue;
            const k = lateral / screen.lateral;
            const first = (address - k * (screen.address + 9)) / (1 - k);
            const last = (address - k * (screen.address - 9)) / (1 - k);
            if (first - margin <= screen.endDistance + 2 && last + margin >= screen.startDistance - 2) return true;
        }
        return false;
    };
    // Anything lower than the sight line to a screen's bottom row is harmless.
    const SIGHT_FLOOR = 2.35;
    const LAMP_GAIN = 2.6;
    const POLE_OFFSET = 3.4, LAMP_OFFSET = 2.55, LAMP_Y = 5.8, CONTACT_Y = 5.72;
    // Scanned surfaces and models sit beside the modes, wherever the page that hosts them lives.
    const ASSETS = (() => {
        const here = global.document?.currentScript?.src;
        return here ? new URL('../assets/', here).href : 'music-stage/assets/';
    })();
    const SIGNAL_RED = '#ff3b2f';
    // Landmarks on the far shore, as bearings round the sky. The line runs towards -z.
    const ISLE = Object.freeze({ bearing: -1.3, reach: 0.2, radius: 520, crest: 34, height: 27, tower: 0.16 });
    const PEAK = Object.freeze({ bearing: -1.08, reach: 0.21, radius: 646, height: 62 });
    const create = (T, scene) => {
        const root = new T.Group();
        scene.add(root);
        const geometries = new Set(), materials = new Set();
        const geometry = g => { geometries.add(g); return g; };
        const material = m => { materials.add(m); return m; };
        const box = geometry(new T.BoxGeometry(1, 1, 1));
        const steel = material(new T.MeshStandardMaterial({ color: '#626b76', metalness: 0.8, roughness: 0.4 }));
        const timber = material(new T.MeshStandardMaterial({ color: '#292d32', roughness: 0.95 }));
        const concrete = material(new T.MeshStandardMaterial({ color: '#444852', roughness: 0.8 }));
        // Whatever gives off light, or is painted, is one mesh with a colour
        // per instance: warm lamps, cold lamps, a crossing's signal lamps, and
        // two paints that are simply a fixed tone.
        const lampMaterial = { color: new T.Color('#ffd994') }, coldLampMaterial = { color: new T.Color('#9fe6d6') };
        const warmPaint = new T.Color('#6b5326'), palePaint = new T.Color('#5d6468');
        const glowMaterial = material(new T.MeshBasicMaterial({ color: '#ffffff' }));
        /*
         * Scanned wood, gravel and rock are used for their light and dark
         * only. They break up a palette colour and roughen how it takes the
         * light; they never bring a hue of their own. Until a scan arrives,
         * and wherever it cannot be read, the plain material stands in.
         */
        let released = false;
        const scans = [];
        const scan = (file, arrived) => {
            const held = { map: { value: null }, ready: { value: 0 } };
            if (T.TextureLoader) new T.TextureLoader().load(ASSETS + file, texture => {
                if (released) { texture.dispose(); return; }
                texture.wrapS = texture.wrapT = T.RepeatWrapping;
                texture.anisotropy = 4;
                scans.push(texture);
                held.map.value = texture;
                held.ready.value = 1;
                arrived?.(texture);
            }, undefined, () => {});
            return held;
        };
        const planks = scan('planks.webp'), gravel = scan('ballast.webp');
        // How wet the line is after rain, 0 to 1: surfaces darken, flat ones
        // turn glossy and hold standing water that gives back the lamps.
        const wetness = { value: 0 };
        // Where the sea stands: what is in it is darker and glossy up to a tide line just above.
        const tideLine = { value: 0 };
        // The lamps nearest the camera light what stands round them: a pool on
        // the paving under each, the wall beside it, the underside of a roof.
        const SPILLS = 12;
        const spills = { value: Array.from({ length: SPILLS }, () => new T.Vector4()) };
        const spillTint = { value: new T.Color() }, WHITE = new T.Color(1, 1, 1);
        let spillList = [];
        // Boards are laid along the longer side of whatever they clad, an
        // edge of the piece falling on a gap between two boards.
        const grained = bed => {
            const wood = material(new T.MeshStandardMaterial({ color: '#292d32', roughness: 0.95 }));
            if (bed) wood.defines = { TRACK_BED: '' };
            wood.onBeforeCompile = shader => {
                Object.assign(shader.uniforms, { wetness, planks: planks.map, planked: planks.ready,
                    gravel: gravel.map, gravelled: gravel.ready, stone: { value: concrete.color } });
                shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
                    attribute float bed;
                    varying vec3 vGrainAt, vGrainSize, vGrainFace, vGrainWorld;
                    varying float vBed, vGrainSeed;`).replace('#include <begin_vertex>', `#include <begin_vertex>
                    #ifdef USE_INSTANCING
                        mat4 grainMatrix = modelMatrix * instanceMatrix;
                        vGrainSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz),
                            length(instanceMatrix[2].xyz));
                        vGrainSeed = fract(sin(mod(float(gl_InstanceID), 289.0) * 12.9898) * 43758.5453);
                    #else
                        mat4 grainMatrix = modelMatrix;
                        vGrainSize = vec3(1.0);
                        vGrainSeed = 0.0;
                    #endif
                    vGrainAt = position * vGrainSize;
                    vGrainFace = normal;
                    vGrainWorld = (grainMatrix * vec4(position, 1.0)).xyz;
                    vBed = bed;`);
                shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
                    uniform sampler2D planks, gravel;
                    uniform float planked, gravelled, wetness;
                    uniform vec3 stone;
                    varying vec3 vGrainAt, vGrainSize, vGrainFace, vGrainWorld;
                    varying float vBed, vGrainSeed;
                    float grainRelief = 0.0, grainDepth = 0.0;`).replace('#include <color_fragment>', `#include <color_fragment>
                    #ifdef TRACK_BED
                    if (vBed > 0.5) {
                        float pebbles = texture2D(gravel, vGrainWorld.xz * 0.5).r;
                        diffuseColor.rgb = stone * mix(0.8, 0.4 + 1.45 * pebbles, gravelled);
                        grainRelief = pebbles * gravelled;
                        grainDepth = 0.018;
                    } else {
                        vec2 board = vec2(0.0586 + floor(vGrainSeed * 9.0) / 9.0 + (vGrainAt.z * 0.94 + 0.12) / 2.16,
                            vGrainAt.x / 2.16 + vGrainSeed);
                    #else
                    {
                        vec3 face = abs(vGrainFace);
                        vec2 at = face.x > face.y && face.x > face.z ? vGrainAt.zy
                            : face.y > face.z ? vGrainAt.xz : vGrainAt.xy;
                        vec2 extent = face.x > face.y && face.x > face.z ? vGrainSize.zy
                            : face.y > face.z ? vGrainSize.xz : vGrainSize.xy;
                        if (extent.y > extent.x) { at = at.yx; extent = extent.yx; }
                        vec2 board = vec2(0.0586 + floor(vGrainSeed * 9.0) / 9.0 + (at.y + extent.y * 0.5) / 1.62,
                            at.x / 1.62 + vGrainSeed);
                    #endif
                        float wood = texture2D(planks, board).r;
                        diffuseColor.rgb *= mix(1.0, min(0.2 + 2.3 * wood, 2.1), planked);
                        grainRelief = wood * planked;
                        grainDepth = 0.008;
                    }
                    diffuseColor.rgb *= 1.0 - 0.42 * wetness;`).replace('#include <roughnessmap_fragment>',
                    `#include <roughnessmap_fragment>
                    roughnessFactor = mix(roughnessFactor, 0.32, wetness);`).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                    {
                        // Relief from the scan's own light and dark, by screen-space derivatives.
                        vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
                        vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
                        float det = dot(dpdx, r1);
                        normal = normalize(abs(det) * normal - sign(det) * grainDepth
                            * (dFdx(grainRelief) * r1 + dFdy(grainRelief) * r2));
                    }`);
            };
            wood.customProgramCacheKey = () => (bed ? 'grained-bed' : 'grained');
            return wood;
        };
        const wood = grained(false), permanentWay = grained(true);
        // Shore rocks: a scanned pile, lit as stone in the palette's colour.
        const rockMaterial = material(new T.MeshStandardMaterial({ color: '#444852', roughness: 0.92 }));
        scan('coast-rock.webp', texture => {
            texture.flipY = false;
            rockMaterial.map = rockMaterial.bumpMap = texture;
            rockMaterial.bumpScale = 0.4;
            rockMaterial.needsUpdate = true;
        });
        // Several boxes fused into one shape, so a profile still costs one instance.
        const fused = parts => {
            const positions = [], normals = [], indices = [];
            for (const [sx, sy, sz, x, y, z] of parts) {
                const part = new T.BoxGeometry(sx, sy, sz).translate(x, y, z);
                const base = positions.length / 3;
                positions.push(...part.attributes.position.array);
                normals.push(...part.attributes.normal.array);
                for (const index of part.index.array) indices.push(index + base);
                part.dispose();
            }
            const shape = new T.BufferGeometry();
            shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            shape.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
            shape.setIndex(indices);
            return geometry(shape);
        };
        const instances = (mat, count, shape = box) => {
            const mesh = new T.InstancedMesh(shape, mat, count);
            mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
            mesh.frustumCulled = false;
            mesh.count = 0;
            root.add(mesh);
            return mesh;
        };
        /*
         * Lineside fittings are low in faces and rich in surface, as good game
         * props are: a post is a bevelled bar, but its paint is streaked, a
         * panel is perforated, a poster glows in its case. The surfaces are
         * painted once, here, into one sheet: red is how light the surface is,
         * green its relief, blue whether it shines from within. Colour comes
         * from the palette, never from the sheet.
         */
        const SHEET = 1024;
        const sheetRegions = {};
        const paintSheet = () => {
            const doc = global.document;
            const canvas = doc?.createElement?.('canvas');
            const layers = canvas && ['albedo', 'relief', 'glow'].map(() => {
                const c = doc.createElement('canvas');
                c.width = c.height = SHEET;
                return c.getContext?.('2d');
            });
            if (!layers || layers.some(c => !c)) return null;
            const [A, H, E] = layers;
            A.fillStyle = 'rgb(196,196,196)'; A.fillRect(0, 0, SHEET, SHEET);
            H.fillStyle = 'rgb(128,128,128)'; H.fillRect(0, 0, SHEET, SHEET);
            E.fillStyle = '#000'; E.fillRect(0, 0, SHEET, SHEET);
            const random = seededRandom('lineside-sheet');
            const grey = v => { const g = Math.max(0, Math.min(255, Math.round(v))); return `rgb(${g},${g},${g})`; };
            const region = (name, x, y, w, h, paint) => {
                sheetRegions[name] = [(x + 1) / SHEET, 1 - (y + h - 1) / SHEET, (w - 2) / SHEET, (h - 2) / SHEET];
                for (const c of layers) { c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); c.translate(x, y); }
                paint(w, h);
                for (const c of layers) c.restore();
            };
            // Draw something on every copy of a tile that touches it, so it repeats without a seam.
            const wrapped = (w, h, x, y, draw) => {
                for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) draw(x + dx, y + dy);
            };
            const blot = (c, x, y, r, value, alpha) => {
                const g = c.createRadialGradient(x, y, 0, x, y, r);
                g.addColorStop(0, `rgba(${value},${value},${value},${alpha})`);
                g.addColorStop(1, `rgba(${value},${value},${value},0)`);
                c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
            };
            // Plain: the tone as it is, lit through where it shines.
            region('plain', 0, 0, 16, 16, (w, h) => { E.fillStyle = '#fff'; E.fillRect(0, 0, w, h); });
            // Painted metal out in the weather: streaks run down from every ledge, blotches of wear.
            region('weathered', 16, 0, 240, 240, (w, h) => {
                for (let i = 0; i < 70; i++) {
                    const x = random() * w, y = random() * h, r = 12 + random() * 46;
                    wrapped(w, h, x, y, (px, py) => blot(A, px, py, r, random() > 0.5 ? 150 : 222, 0.22));
                }
                for (let i = 0; i < 140; i++) {
                    const x = random() * w, top = random() * h, length = 20 + random() * 120;
                    const g = A.createLinearGradient(0, top, 0, top + length);
                    const v = 120 + random() * 50;
                    g.addColorStop(0, `rgba(${v},${v},${v},0.32)`); g.addColorStop(1, `rgba(${v},${v},${v},0)`);
                    A.fillStyle = g;
                    wrapped(w, h, x, top, (px, py) => A.fillRect(px, py, 1 + random() * 2, length));
                }
                for (let i = 0; i < 900; i++) {
                    const x = random() * w, y = random() * h;
                    H.fillStyle = grey(110 + random() * 40); H.fillRect(x, y, 1, 1);
                }
            });
            // Concrete: cast in panels, stained, pitted.
            region('concrete', 256, 0, 240, 240, (w, h) => {
                for (let i = 0; i < 90; i++) {
                    const x = random() * w, y = random() * h, r = 10 + random() * 60;
                    wrapped(w, h, x, y, (px, py) => blot(A, px, py, r, random() > 0.6 ? 150 : 214, 0.25));
                }
                for (let i = 0; i < 1600; i++) {
                    const x = random() * w, y = random() * h, d = random();
                    A.fillStyle = grey(d > 0.8 ? 120 : 210); A.fillRect(x, y, 1, 1);
                    H.fillStyle = grey(d > 0.8 ? 70 : 140); H.fillRect(x, y, 1 + (d > 0.95), 1 + (d > 0.95));
                }
            });
            // Paving slabs on a platform: square, a dark joint between them.
            region('paving', 496, 0, 240, 240, (w, h) => {
                for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
                    A.fillStyle = grey(186 + random() * 22); A.fillRect(i * 60 + 2, j * 60 + 2, 56, 56);
                    blot(A, i * 60 + 30 + (random() - 0.5) * 30, j * 60 + 30, 24, 160, 0.3 * random());
                }
                A.fillStyle = grey(96); H.fillStyle = grey(60);
                for (let k = 0; k <= 4; k++) {
                    for (const c of [A, H]) { c.fillRect(k * 60 - 1, 0, 3, h); c.fillRect(0, k * 60 - 1, w, 3); }
                }
            });
            // Perforated sheet: a staggered field of round holes, dark through.
            region('perforated', 736, 0, 64, 64, (w, h) => {
                for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
                    const x = i * 16 + 8 + (j % 2) * 8, y = j * 16 + 8;
                    wrapped(w, h, x, y, (px, py) => {
                        for (const [c, v] of [[A, 26], [H, 20]]) {
                            c.fillStyle = grey(v); c.beginPath(); c.arc(px, py, 4.6, 0, Math.PI * 2); c.fill();
                        }
                    });
                }
            });
            // Corrugated sheeting: ribs along the fall of the roof.
            region('corrugated', 800, 0, 64, 64, (w, h) => {
                for (let x = 0; x < w; x++) {
                    const wave = Math.sin(x / w * Math.PI * 8);
                    H.fillStyle = grey(128 + wave * 110); H.fillRect(x, 0, 1, h);
                    A.fillStyle = grey(190 + wave * 30); A.fillRect(x, 0, 1, h);
                }
            });
            // Tactile paving: rows of raised domes.
            region('tactile', 864, 0, 64, 64, (w, h) => {
                for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
                    const x = i * 16 + 8, y = j * 16 + 8;
                    const g = H.createRadialGradient(x, y, 0, x, y, 6);
                    g.addColorStop(0, grey(250)); g.addColorStop(1, grey(128));
                    H.fillStyle = g; H.beginPath(); H.arc(x, y, 6, 0, Math.PI * 2); H.fill();
                    A.fillStyle = grey(214); A.beginPath(); A.arc(x, y, 5, 0, Math.PI * 2); A.fill();
                }
            });
            // Louvres: slats tipped down, a shadow under each.
            region('louvre', 928, 0, 64, 64, (w, h) => {
                for (let y = 0; y < h; y++) {
                    const u = (y % 8) / 8;
                    H.fillStyle = grey(60 + u * 190); H.fillRect(0, y, w, 1);
                    A.fillStyle = grey(u < 0.2 ? 70 : 190 + u * 30); A.fillRect(0, y, w, 1);
                }
            });
            // Warning stripes at forty-five degrees.
            region('stripes', 0, 256, 64, 64, (w, h) => {
                A.fillStyle = grey(40);
                for (let k = -2; k < 4; k++) {
                    A.beginPath(); A.moveTo(k * 32, 0); A.lineTo(k * 32 + 16, 0);
                    A.lineTo(k * 32 + 16 + 64, 64); A.lineTo(k * 32 + 64, 64); A.fill();
                }
            });
            // Glass: clear but never quite clean, grime gathered at the foot.
            region('glass', 64, 256, 128, 128, (w, h) => {
                A.fillStyle = grey(150); A.fillRect(0, 0, w, h);
                for (let i = 0; i < 26; i++) {
                    const x = random() * w, y = random() * h;
                    wrapped(w, h, x, y, (px, py) => blot(A, px, py, 8 + random() * 22, 190, 0.18));
                }
            });
            // Posters in lit cases: a sky, a sun or moon, the sea's lines, and a block of print.
            const poster = (name, x, y, mood) => region(name, x, y, 128, 192, (w, h) => {
                const sky = A.createLinearGradient(0, 0, 0, h);
                sky.addColorStop(0, grey(mood ? 90 : 230)); sky.addColorStop(0.62, grey(mood ? 200 : 170));
                sky.addColorStop(1, grey(mood ? 120 : 110));
                A.fillStyle = sky; A.fillRect(0, 0, w, h);
                A.fillStyle = grey(mood ? 250 : 255);
                A.beginPath(); A.arc(w * (0.3 + 0.4 * random()), h * 0.36, 16 + random() * 10, 0, Math.PI * 2); A.fill();
                A.strokeStyle = grey(mood ? 70 : 90); A.lineWidth = 2;
                for (let k = 0; k < 6; k++) {
                    A.beginPath();
                    for (let x0 = 0; x0 <= w; x0 += 4) A.lineTo(x0, h * 0.64 + k * 7 + Math.sin(x0 / 9 + k) * 2);
                    A.stroke();
                }
                A.fillStyle = grey(30);
                A.fillRect(10, h - 44, w * 0.62, 9);
                for (let k = 0; k < 3; k++) A.fillRect(10, h - 28 + k * 6, w * (0.3 + random() * 0.5), 2);
                E.fillStyle = grey(230); E.fillRect(0, 0, w, h);
            });
            poster('poster-a', 192, 256, 0);
            poster('poster-b', 320, 256, 1);
            poster('poster-c', 448, 256, 0);
            // A timetable: a heading and columns of small print, lit from behind.
            region('timetable', 576, 256, 96, 144, (w, h) => {
                A.fillStyle = grey(232); A.fillRect(0, 0, w, h);
                A.fillStyle = grey(50); A.fillRect(6, 6, w - 12, 12);
                for (let row = 0; row < 18; row++) {
                    A.fillStyle = grey(row % 2 ? 214 : 232); A.fillRect(6, 24 + row * 6.5, w - 12, 6.5);
                    A.fillStyle = grey(70); A.fillRect(8, 26 + row * 6.5, 7, 2.5);
                    for (let k = 0; k < 5; k++) if (random() > 0.25) A.fillRect(22 + k * 13, 26 + row * 6.5, 8, 2.5);
                }
                E.fillStyle = grey(150); E.fillRect(0, 0, w, h);
            });
            // A route map: the line as one rule, its stops as rings, small print under each.
            region('route', 672, 256, 192, 96, (w, h) => {
                A.fillStyle = grey(230); A.fillRect(0, 0, w, h);
                A.fillStyle = grey(60); A.fillRect(10, 40, w - 20, 5);
                for (let k = 0; k < 8; k++) {
                    const x = 14 + k * (w - 28) / 7;
                    A.fillStyle = grey(240); A.beginPath(); A.arc(x, 42.5, 5, 0, Math.PI * 2); A.fill();
                    A.strokeStyle = grey(50); A.lineWidth = 2; A.stroke();
                    A.fillStyle = grey(80); A.fillRect(x - 6, 54, 12, 3); A.fillRect(x - 4, 60, 8, 2);
                }
                A.fillStyle = grey(50); A.fillRect(10, 10, 60, 10);
                E.fillStyle = grey(140); E.fillRect(0, 0, w, h);
            });
            // A station name board with no name that can be read: a large word of
            // brush-like strokes, a small line under it, the neighbours each side.
            region('nameboard', 0, 400, 512, 128, (w, h) => {
                A.fillStyle = grey(236); A.fillRect(0, 0, w, h);
                A.fillStyle = grey(36);
                for (let k = 0; k < 3; k++) {
                    const x = 170 + k * 62;
                    const strokes = 3 + Math.floor(random() * 3);
                    for (let s = 0; s < strokes; s++) {
                        const horizontal = random() > 0.45;
                        const sx = x + random() * 30, sy = 18 + random() * 40;
                        if (horizontal) A.fillRect(x + random() * 8, sy, 30 + random() * 14, 6);
                        else A.fillRect(sx, 16 + random() * 10, 6, 30 + random() * 20);
                    }
                    A.fillRect(x + 2, 66, 44, 6);
                }
                A.fillStyle = grey(90);
                A.fillRect(196, 84, 120, 6);
                for (const [x, dir] of [[18, -1], [w - 18, 1]]) {
                    A.beginPath(); A.moveTo(x, 104); A.lineTo(x - dir * 12, 96); A.lineTo(x - dir * 12, 112); A.fill();
                    A.fillRect(dir < 0 ? 36 : w - 36 - 70, 98, 70, 5); A.fillRect(dir < 0 ? 36 : w - 36 - 50, 108, 50, 3);
                }
                E.fillStyle = grey(200); E.fillRect(0, 0, w, h);
            });
            // A clock face: a ring of marks and two hands, at ten to two.
            region('clock', 512, 400, 128, 128, (w, h) => {
                A.fillStyle = grey(240); A.beginPath(); A.arc(64, 64, 60, 0, Math.PI * 2); A.fill();
                A.strokeStyle = grey(40); A.lineWidth = 5; A.stroke();
                for (let k = 0; k < 12; k++) {
                    const a = k / 12 * Math.PI * 2;
                    A.lineWidth = k % 3 ? 2 : 5;
                    A.beginPath(); A.moveTo(64 + Math.cos(a) * 46, 64 + Math.sin(a) * 46);
                    A.lineTo(64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54); A.stroke();
                }
                A.lineWidth = 5; A.beginPath(); A.moveTo(64, 64); A.lineTo(64 - 26, 64 - 18); A.stroke();
                A.lineWidth = 3; A.beginPath(); A.moveTo(64, 64); A.lineTo(64 + 34, 64 - 30); A.stroke();
                E.fillStyle = grey(190); E.beginPath(); E.arc(64, 64, 58, 0, Math.PI * 2); E.fill();
            });
            // The front of a drinks machine: rows of lit samples with a button under each,
            // the lit panel below, the slot and the flap.
            region('vending', 640, 400, 96, 192, (w, h) => {
                A.fillStyle = grey(70); A.fillRect(0, 0, w, h);
                for (let row = 0; row < 3; row++) for (let k = 0; k < 5; k++) {
                    const x = 6 + k * 17.5, y = 8 + row * 30;
                    A.fillStyle = grey(150 + random() * 100); A.fillRect(x, y, 13, 20);
                    E.fillStyle = grey(255); E.fillRect(x, y, 13, 20); E.fillRect(x + 4, y + 23, 5, 3);
                    A.fillStyle = grey(230); A.fillRect(x + 4, y + 23, 5, 3);
                }
                A.fillStyle = grey(200); A.fillRect(6, 102, 60, 46); E.fillStyle = grey(160); E.fillRect(6, 102, 60, 46);
                A.fillStyle = grey(30); A.fillRect(72, 108, 16, 30); A.fillRect(10, 160, w - 20, 22);
                H.fillStyle = grey(60); H.fillRect(10, 160, w - 20, 22);
            });
            // A pole's number plate.
            region('plate', 736, 400, 48, 96, (w, h) => {
                A.fillStyle = grey(232); A.fillRect(0, 0, w, h);
                A.strokeStyle = grey(50); A.lineWidth = 3; A.strokeRect(3, 3, w - 6, h - 6);
                A.fillStyle = grey(40);
                for (let k = 0; k < 3; k++) { A.fillRect(14, 14 + k * 26, 20, 4); A.fillRect(14, 30 + k * 26, 20, 4); A.fillRect(30, 14 + k * 26, 4, 18); }
            });
            // Vertical slots, as in a litter bin or a cabinet door.
            region('slots', 784, 400, 64, 64, (w, h) => {
                for (let x = 0; x < w; x++) {
                    const u = (x % 16) / 16;
                    A.fillStyle = grey(u > 0.75 ? 40 : 196); A.fillRect(x, 0, 1, h);
                    H.fillStyle = grey(u > 0.75 ? 40 : 150); H.fillRect(x, 0, 1, h);
                }
            });
            // Weatherboarding: lapped boards, each casting a line of shadow on the next.
            region('boards', 848, 400, 64, 64, (w, h) => {
                for (let y = 0; y < h; y++) {
                    const u = (y % 16) / 16;
                    A.fillStyle = grey(u > 0.88 ? 90 : 170 + u * 40); A.fillRect(0, y, w, 1);
                    H.fillStyle = grey(70 + u * 150); H.fillRect(0, y, w, 1);
                }
            });
            const a = A.getImageData(0, 0, SHEET, SHEET).data, hh = H.getImageData(0, 0, SHEET, SHEET).data;
            const e = E.getImageData(0, 0, SHEET, SHEET).data;
            const data = new Uint8Array(SHEET * SHEET * 4);
            // Rows go bottom-up, as texture coordinates do.
            for (let y = 0; y < SHEET; y++) for (let x = 0; x < SHEET; x++) {
                const from = (y * SHEET + x) * 4, to = ((SHEET - 1 - y) * SHEET + x) * 4;
                data[to] = a[from]; data[to + 1] = hh[from]; data[to + 2] = e[from]; data[to + 3] = 255;
            }
            return data;
        };
        const sheetTexture = (() => {
            const data = paintSheet();
            const texture = data
                ? new T.DataTexture(data, SHEET, SHEET, T.RGBAFormat)
                : new T.DataTexture(new Uint8Array([196, 128, 255, 255]), 1, 1, T.RGBAFormat);
            if (data) {
                texture.generateMipmaps = true;
                texture.minFilter = T.LinearMipmapLinearFilter;
                texture.magFilter = T.LinearFilter;
                texture.anisotropy = 4;
            }
            texture.needsUpdate = true;
            return texture;
        })();
        const regionOf = name => sheetRegions[name] || [0, 0, 1, 1];
        // Tones a fitting takes: indices into the list the shader reads.
        const TONE = Object.freeze({ steel: 0, concrete: 1, timber: 2, pale: 3, warm: 4, glass: 5, lamp: 6,
            room: 7, ceiling: 8, cold: 9, ink: 10, sky: 11, poster: 12 });
        const dressTones = Array.from({ length: 13 }, () => new T.Color());
        // A box whose edges are cut back by a set width in metres, whatever its
        // size: each corner remembers which way its bevel moves it.
        const bevelledBox = (() => {
            const position = [], normal = [], inset = [];
            const corner = (axis, c) => {
                const into = c.map((v, k) => (k === axis ? 0 : -v));
                return { p: c.map(v => v * 0.5), i: into };
            };
            const tri = (verts, n) => {
                // Wind each triangle to face its normal, judged at a nominal bevel.
                const at = v => v.p.map((x, k) => x + v.i[k] * 0.1);
                const [p0, p1, p2] = verts.map(at);
                const u = p1.map((x, k) => x - p0[k]), w = p2.map((x, k) => x - p0[k]);
                const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
                if (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] < 0) verts = [verts[0], verts[2], verts[1]];
                for (const v of verts) { position.push(...v.p); inset.push(...v.i); normal.push(...n); }
            };
            const signs = [-1, 1];
            for (let axis = 0; axis < 3; axis++) for (const s of signs) {
                const [b, d] = [0, 1, 2].filter(k => k !== axis);
                const quad = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
                    const c = [0, 0, 0]; c[axis] = s; c[b] = x; c[d] = y; return corner(axis, c);
                });
                const n = [0, 0, 0]; n[axis] = s;
                tri([quad[0], quad[1], quad[2]], n); tri([quad[0], quad[2], quad[3]], n);
            }
            for (let axis = 0; axis < 3; axis++) {
                const [b, d] = [0, 1, 2].filter(k => k !== axis);
                for (const sb of signs) for (const sd of signs) {
                    const ends = signs.map(sa => { const c = [0, 0, 0]; c[axis] = sa; c[b] = sb; c[d] = sd; return c; });
                    const [fb0, fb1] = ends.map(c => corner(b, c)), [fd0, fd1] = ends.map(c => corner(d, c));
                    const n = [0, 0, 0]; n[b] = sb * Math.SQRT1_2; n[d] = sd * Math.SQRT1_2;
                    tri([fb0, fb1, fd1], n); tri([fb0, fd1, fd0], n);
                }
            }
            for (const x of signs) for (const y of signs) for (const z of signs) {
                const c = [x, y, z], k = 1 / Math.sqrt(3);
                tri([corner(0, c), corner(1, c), corner(2, c)], [x * k, y * k, z * k]);
            }
            const shape = new T.BufferGeometry();
            shape.setAttribute('position', new T.Float32BufferAttribute(position, 3));
            shape.setAttribute('normal', new T.Float32BufferAttribute(normal, 3));
            shape.setAttribute('inset', new T.Float32BufferAttribute(inset, 3));
            return geometry(shape);
        })();
        /*
         * Weather on built things, so no two posts and no two metres of wall
         * are the same: broad patchy grime, rain streaks down the uprights,
         * dirt where a piece meets the ground, dust settling on its top. It
         * only scales lightness and roughness, never adds a hue; on the light
         * theme it is kept faint so paper stays clean.
         */
        const weatherAmount = { value: 1 };
        const WEATHER = `
            float weatherHash(vec3 p) {
                p = fract(p * 0.3183099 + 0.1) * 17.0;
                return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
            }
            float weatherNoise(vec3 x) {
                vec3 i = floor(x), f = fract(x);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(mix(weatherHash(i), weatherHash(i + vec3(1, 0, 0)), f.x),
                        mix(weatherHash(i + vec3(0, 1, 0)), weatherHash(i + vec3(1, 1, 0)), f.x), f.y),
                    mix(mix(weatherHash(i + vec3(0, 0, 1)), weatherHash(i + vec3(1, 0, 1)), f.x),
                        mix(weatherHash(i + vec3(0, 1, 1)), weatherHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
            }
            // x: what the lightness is multiplied by; y: what the roughness gains.
            vec2 weather(vec3 world, vec3 up, float height, float seed, float amount) {
                float broad = weatherNoise(world * 0.31) * 0.6 + weatherNoise(world * 1.27 + 7.0) * 0.4;
                float fine = weatherNoise(world * 6.3);
                float upright = 1.0 - abs(up.y);
                float run = weatherNoise(vec3((world.x - world.z) * 4.7, world.y * 0.3, (world.x + world.z) * 4.7));
                float streak = smoothstep(0.55, 0.92, run) * upright;
                float grime = (1.0 - smoothstep(0.0, 0.55, height)) * upright;
                float dust = smoothstep(0.7, 0.95, up.y) * smoothstep(0.45, 0.8, broad);
                float lightness = 1.0 + (broad - 0.5) * 0.42 + (fine - 0.5) * 0.14 + (seed - 0.5) * 0.18
                    - streak * 0.26 - grime * 0.34 - dust * 0.1;
                return vec2(mix(1.0, lightness, amount),
                    amount * (broad * 0.3 + streak * 0.18 + grime * 0.1 + fine * 0.12 - 0.16));
            }`;
        const weathered = (target, key) => {
            target.onBeforeCompile = shader => {
                shader.uniforms.weatherAmount = weatherAmount;
                shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
                    varying vec3 vWeatherWorld, vWeatherUp;
                    varying float vWeatherHeight, vWeatherSeed;`).replace('#include <begin_vertex>', `#include <begin_vertex>
                    #ifdef USE_INSTANCING
                        mat4 weatherMatrix = modelMatrix * instanceMatrix;
                        vWeatherSeed = fract(sin(mod(float(gl_InstanceID), 289.0) * 12.9898) * 43758.5453);
                    #else
                        mat4 weatherMatrix = modelMatrix;
                        vWeatherSeed = 0.5;
                    #endif
                    vWeatherWorld = (weatherMatrix * vec4(position, 1.0)).xyz;
                    vWeatherUp = normalize(mat3(weatherMatrix) * normal);
                    // Only an upright piece has a foot; a lying bar is dirtied as a whole.
                    vec3 weatherAxis = mat3(weatherMatrix) * vec3(0.0, 1.0, 0.0);
                    vWeatherHeight = normalize(weatherAxis).y > 0.7
                        ? vWeatherWorld.y - (weatherMatrix * vec4(0.0, -0.5, 0.0, 1.0)).y : 9.0;`);
                shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
                    uniform float weatherAmount;
                    varying vec3 vWeatherWorld, vWeatherUp;
                    varying float vWeatherHeight, vWeatherSeed;
                    vec2 weatherNow = vec2(1.0, 0.0);
                    ${WEATHER}`).replace('#include <color_fragment>', `#include <color_fragment>
                    weatherNow = weather(vWeatherWorld, normalize(vWeatherUp), vWeatherHeight, vWeatherSeed, weatherAmount);
                    diffuseColor.rgb *= weatherNow.x;`).replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
                    roughnessFactor = clamp(roughnessFactor + weatherNow.y, 0.05, 1.0);`);
            };
            target.customProgramCacheKey = () => key;
        };
        weathered(steel, 'weathered-steel');
        weathered(concrete, 'weathered-concrete');
        const DRESSED_CAPACITY = 2600;
        const dressedMaterial = material(new T.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7, metalness: 0.2 }));
        const dressSky = { value: new T.Color() }, dressFill = { value: 0 };
        dressedMaterial.onBeforeCompile = shader => {
            Object.assign(shader.uniforms, { dressSheet: { value: sheetTexture }, dressTones: { value: dressTones },
                dressSky, wetness, tideLine, spills, spillTint, weatherAmount, dressFill, dressPuddles: { value: new T.Vector4(...regionOf('concrete')) } });
            shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
                attribute vec3 inset;
                attribute vec4 dressRect, dressLook, dressCut;
                uniform vec3 dressTones[13];
                varying vec2 vDressUv;
                varying vec4 vDressRect;
                varying vec3 vDressTone;
                varying float vDressTile, vDressRough, vDressMetal, vDressGlow, vDressGlass;
                varying vec3 vDressWorld, vDressUp;
                varying float vDressHeight, vDressSeed, vDressEdge;`)
                .replace('#include <begin_vertex>', `#include <begin_vertex>
                vec3 dressSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz),
                    length(instanceMatrix[2].xyz));
                vec3 dressCutBy = min(dressCut.xyz, dressSize * 0.49);
                transformed = position + inset * dressCutBy / max(dressSize, vec3(0.0001));
                vec3 face = abs(normal);
                vec3 across = face.y > face.x && face.y > face.z ? vec3(1.0, 0.0, 0.0)
                    : face.x > face.z ? vec3(0.0, 0.0, -sign(normal.x)) : vec3(sign(normal.z), 0.0, 0.0);
                vec3 upward = face.y > face.x && face.y > face.z ? vec3(0.0, 0.0, -sign(normal.y)) : vec3(0.0, 1.0, 0.0);
                vec3 metres = transformed * dressSize;
                vDressTile = dressLook.x;
                vDressUv = dressLook.x > 0.0
                    ? vec2(dot(metres, across), dot(metres, upward)) / dressLook.x
                    : vec2(dot(transformed, across), dot(transformed, upward)) + 0.5;
                vDressRect = dressRect;
                int toneIndex = int(dressLook.y + 0.5);
                vDressTone = dressTones[toneIndex];
                vDressGlass = toneIndex == 5 ? 1.0 : 0.0;
                vDressRough = dressLook.z;
                vDressMetal = dressLook.w;
                vDressGlow = dressCut.w;
                vDressWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
                vDressUp = normalize(mat3(modelMatrix * instanceMatrix) * normal);
                vDressSeed = fract(sin(mod(float(gl_InstanceID), 289.0) * 12.9898) * 43758.5453);
                vec3 dressAxis = normalize(mat3(modelMatrix * instanceMatrix) * vec3(0.0, 1.0, 0.0));
                vDressHeight = dressAxis.y > 0.7
                    ? vDressWorld.y - (modelMatrix * instanceMatrix * vec4(0.0, -0.5, 0.0, 1.0)).y : 9.0;
                // The narrow cut along an edge, where paint wears through and catches the light.
                vDressEdge = max(face.x, max(face.y, face.z)) < 0.95 && max(dressCutBy.x, max(dressCutBy.y, dressCutBy.z)) < 0.05
                    ? 1.0 : 0.0;`);
            shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
                uniform sampler2D dressSheet;
                uniform vec3 dressSky;
                uniform vec4 dressPuddles;
                uniform float wetness, tideLine, weatherAmount, dressFill;
                varying float vDressHeight, vDressSeed, vDressEdge;
                vec2 dressWeather = vec2(1.0, 0.0);
                ${WEATHER}
                uniform vec4 spills[${SPILLS}];
                uniform vec3 spillTint;
                varying vec3 vDressWorld, vDressUp;
                float dressPuddle = 0.0;
                varying vec2 vDressUv;
                varying vec4 vDressRect;
                varying vec3 vDressTone;
                varying float vDressTile, vDressRough, vDressMetal, vDressGlow, vDressGlass;
                vec3 dressTexel = vec3(0.77, 0.5, 1.0);`)
                .replace('#include <color_fragment>', `#include <color_fragment>
                {
                    vec2 cell = vDressTile > 0.0 ? fract(vDressUv) : clamp(vDressUv, 0.0, 1.0);
                    vec2 grad = vDressRect.zw;
                    dressTexel = textureGrad(dressSheet, vDressRect.xy + cell * vDressRect.zw,
                        dFdx(vDressUv) * grad, dFdy(vDressUv) * grad).rgb;
                    diffuseColor.rgb = vDressTone * dressTexel.r * 1.3 * (1.0 - vDressGlow * dressTexel.b);
                    float bare = 1.0 - step(0.01, vDressGlow) - vDressGlass;
                    if (bare > 0.5) {
                        dressWeather = weather(vDressWorld, normalize(vDressUp), vDressHeight, vDressSeed, weatherAmount);
                        float worn = vDressEdge * smoothstep(0.35, 0.75, weatherNoise(vDressWorld * 9.0 + vDressSeed * 31.0));
                        diffuseColor.rgb *= dressWeather.x * (1.0 + 0.35 * worn * weatherAmount);
                    }
                    float soaked = 1.0 - smoothstep(tideLine + 0.04, tideLine + 0.16, vDressWorld.y);
                    diffuseColor.rgb *= 1.0 - 0.45 * soaked * (1.0 - vDressGlow);
                    if (wetness > 0.0) {
                        // Water stands in the low, stained patches of anything flat and open to the sky.
                        float level = smoothstep(0.8, 0.95, vDressUp.y);
                        float stain = texture(dressSheet, dressPuddles.xy + fract(vDressWorld.xz * 0.11) * dressPuddles.zw).r;
                        dressPuddle = level * smoothstep(0.74, 0.6, stain) * smoothstep(0.3, 0.8, wetness);
                        diffuseColor.rgb *= 1.0 - wetness * (0.3 + 0.2 * level) - dressPuddle * 0.3;
                    }
                }`)
                .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
                roughnessFactor = clamp(vDressRough + dressWeather.y + (0.5 - dressTexel.g) * 0.2, 0.05, 1.0);
                roughnessFactor = mix(roughnessFactor, mix(0.28, 0.04, dressPuddle), wetness * (1.0 - vDressGlow));
                roughnessFactor = mix(roughnessFactor, 0.2, 1.0 - smoothstep(tideLine + 0.04, tideLine + 0.16, vDressWorld.y));`)
                .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
                metalnessFactor = vDressMetal;`)
                .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                {
                    vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
                    vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
                    float det = dot(dpdx, r1);
                    float relief = dressTexel.g * (1.0 - dressPuddle);
                    normal = normalize(abs(det) * normal - sign(det) * 0.006
                        * (dFdx(relief) * r1 + dFdy(relief) * r2));
                }`)
                .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
                totalEmissiveRadiance += vDressTone * dressTexel.r * 1.3 * dressTexel.b * vDressGlow;
                {
                    vec3 spill = vec3(0.0);
                    for (int i = 0; i < ${SPILLS}; i++) {
                        vec3 toLamp = spills[i].xyz - vDressWorld;
                        float d2 = dot(toLamp, toLamp);
                        float facing = max(0.0, dot(normalize(vDressUp), toLamp * inversesqrt(max(d2, 0.0001))));
                        spill += vec3(spills[i].w * facing / (1.0 + d2 * 0.8));
                    }
                    totalEmissiveRadiance += diffuseColor.rgb * spillTint * spill;
                    // Light off the sky and the water: a wall turned from the moon is dim, not black.
                    totalEmissiveRadiance += diffuseColor.rgb * dressSky * dressFill * (0.75 + 0.25 * vDressUp.y);
                }
                if (vDressGlass > 0.5) {
                    // Glass gives back the sky, more of it the flatter it is seen.
                    float facing = max(0.0, abs(dot(normalize(vViewPosition), normal)));
                    totalEmissiveRadiance += dressSky * (0.06 + 0.42 * pow(max(0.0, 1.0 - facing), 3.0));
                }`);
        };
        dressedMaterial.customProgramCacheKey = () => 'dressed-lineside';
        const dressed = new T.InstancedMesh(bevelledBox, dressedMaterial, DRESSED_CAPACITY);
        dressed.instanceMatrix.setUsage(T.DynamicDrawUsage);
        dressed.frustumCulled = false;
        dressed.count = 0;
        dressed.name = 'dressed';
        root.add(dressed);
        const dressAttribute = name => {
            const attribute = new T.InstancedBufferAttribute(new Float32Array(DRESSED_CAPACITY * 4), 4);
            attribute.setUsage(T.DynamicDrawUsage);
            bevelledBox.setAttribute(name, attribute);
            return attribute;
        };
        const dressRect = dressAttribute('dressRect'), dressLook = dressAttribute('dressLook'), dressCut = dressAttribute('dressCut');
        const matrixScale = new T.Vector3();
        /*
         * A look: which part of the sheet, repeated every so many metres or
         * stretched once over each face (tile 0), the tone, how rough and how
         * metallic, how wide the bevel ('round' cuts a bar to an octagon), and
         * whether it shines.
         */
        const look = ({ sheet = 'plain', tile = 0, tone = TONE.steel, rough = 0.6, metal = 0.3, bevel = 0.012, glow = 0 }) => {
            const rect = regionOf(sheet);
            return {
                instanceMatrix: dressed.instanceMatrix,
                get count() { return dressed.count; },
                set count(value) { dressed.count = value; },
                setMatrixAt(index, matrix) {
                    dressed.setMatrixAt(index, matrix);
                    dressRect.setXYZW(index, rect[0], rect[1], rect[2], rect[3]);
                    dressLook.setXYZW(index, tile, tone, rough, metal);
                    if (bevel === 'round') {
                        matrixScale.setFromMatrixScale(matrix);
                        const sizes = [matrixScale.x, matrixScale.y, matrixScale.z];
                        const long = sizes.indexOf(Math.max(...sizes));
                        const cut = Math.min(...sizes.filter((_, k) => k !== long)) * 0.293;
                        dressCut.setXYZW(index, long === 0 ? 0.004 : cut, long === 1 ? 0.004 : cut, long === 2 ? 0.004 : cut, glow);
                    } else dressCut.setXYZW(index, bevel, bevel, bevel, glow);
                }
            };
        };
        // The fittings' finishes.
        const LOOK = {
            paint: look({ sheet: 'weathered', tile: 1.6, rough: 0.55, metal: 0.35 }),
            tube: look({ sheet: 'weathered', tile: 1.6, rough: 0.45, metal: 0.45, bevel: 'round' }),
            bright: look({ sheet: 'weathered', tile: 2.4, rough: 0.3, metal: 0.8, bevel: 'round' }),
            perforated: look({ sheet: 'perforated', tile: 0.12, rough: 0.5, metal: 0.5, bevel: 0.006 }),
            corrugated: look({ sheet: 'corrugated', tile: 0.6, rough: 0.5, metal: 0.45, bevel: 0.004 }),
            louvre: look({ sheet: 'louvre', tile: 0.32, rough: 0.6, metal: 0.3 }),
            slots: look({ sheet: 'slots', tile: 0.24, rough: 0.6, metal: 0.3 }),
            concrete: look({ sheet: 'concrete', tile: 2.2, tone: TONE.concrete, rough: 0.9, metal: 0, bevel: 0.02 }),
            paving: look({ sheet: 'paving', tile: 2.4, tone: TONE.concrete, rough: 0.85, metal: 0, bevel: 0.01 }),
            coping: look({ sheet: 'concrete', tile: 1.4, tone: TONE.pale, rough: 0.8, metal: 0, bevel: 0.03 }),
            tactile: look({ sheet: 'tactile', tile: 0.3, tone: TONE.warm, rough: 0.7, metal: 0, bevel: 0.004 }),
            stripes: look({ sheet: 'stripes', tile: 0.5, tone: TONE.warm, rough: 0.6, metal: 0.1, bevel: 0.006 }),
            glass: look({ sheet: 'glass', tile: 1.2, tone: TONE.glass, rough: 0.12, metal: 0.6, bevel: 0.002 }),
            boards: look({ sheet: 'boards', tile: 0.9, tone: TONE.timber, rough: 0.85, metal: 0, bevel: 0.006 }),
            // Painted soffit boards: lit only by the lamps under them, so each tube leaves its own pool.
            soffit: look({ sheet: 'boards', tile: 0.9, tone: TONE.pale, rough: 0.9, metal: 0, bevel: 0.004 }),
            timber: look({ sheet: 'weathered', tile: 1.2, tone: TONE.timber, rough: 0.85, metal: 0, bevel: 0.01 }),
            ink: look({ sheet: 'weathered', tile: 1.6, tone: TONE.ink, rough: 0.6, metal: 0.2 }),
            pale: look({ sheet: 'weathered', tile: 1.6, tone: TONE.pale, rough: 0.6, metal: 0.1 }),
            warm: look({ sheet: 'weathered', tile: 1.6, tone: TONE.warm, rough: 0.6, metal: 0.1 }),
            warmTube: look({ sheet: 'weathered', tile: 1.6, tone: TONE.warm, rough: 0.6, metal: 0.1, bevel: 'round' }),
            nameboard: look({ sheet: 'nameboard', tone: TONE.pale, rough: 0.5, metal: 0, glow: 0.6, bevel: 0.004 }),
            timetable: look({ sheet: 'timetable', tone: TONE.pale, rough: 0.4, metal: 0, glow: 0.5, bevel: 0.002 }),
            route: look({ sheet: 'route', tone: TONE.pale, rough: 0.4, metal: 0, glow: 0.5, bevel: 0.002 }),
            clock: look({ sheet: 'clock', tone: TONE.pale, rough: 0.4, metal: 0, glow: 0.6, bevel: 0.002 }),
            plate: look({ sheet: 'plate', tone: TONE.pale, rough: 0.5, metal: 0.1, bevel: 0.002 }),
            vending: look({ sheet: 'vending', tone: TONE.room, rough: 0.35, metal: 0.2, glow: 1, bevel: 0.003 }),
            posters: ['poster-a', 'poster-b', 'poster-c'].map(sheet =>
                look({ sheet, tone: TONE.poster, rough: 0.3, metal: 0, glow: 1, bevel: 0.002 })),
            lamp: look({ tone: TONE.lamp, rough: 0.4, metal: 0, glow: 1, bevel: 0.01 }),
            coldLamp: look({ tone: TONE.cold, rough: 0.4, metal: 0, glow: 1, bevel: 0.01 }),
            lantern: look({ tone: TONE.lamp, rough: 0.6, metal: 0, glow: 0.45, bevel: 0.06 }),
            window: look({ tone: TONE.room, rough: 0.4, metal: 0, glow: 1, bevel: 0.002 }),
            figure: look({ sheet: 'concrete', tile: 3, tone: TONE.ink, rough: 0.95, metal: 0, bevel: 0.04 }),
            head: look({ sheet: 'concrete', tile: 3, tone: TONE.ink, rough: 0.95, metal: 0, bevel: 0.07 })
        };
        // Flat-bottom rail: head, web and foot. Sleepers carry their tie plates.
        // A rail is rust everywhere but the band its wheels run on: only that
        // narrow strip along the crown is polished, and only it catches the lamps.
        const railMaterial = material(new T.MeshStandardMaterial({ color: '#626b76', metalness: 0.8, roughness: 0.4 }));
        railMaterial.onBeforeCompile = shader => {
            shader.vertexShader = shader.vertexShader.replace('#include <common>',
                '#include <common>\nvarying vec3 vRail;').replace('#include <begin_vertex>',
                '#include <begin_vertex>\nvRail = vec3(position.xy, normal.y);');
            shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
                varying vec3 vRail;
                float railCrown() {
                    return step(0.5, vRail.z) * step(0.07, vRail.y) * smoothstep(0.03, 0.021, abs(vRail.x));
                }`).replace('#include <color_fragment>', `#include <color_fragment>
                diffuseColor.rgb *= mix(0.34, 0.8, railCrown());`).replace('#include <roughnessmap_fragment>',
                `#include <roughnessmap_fragment>
                roughnessFactor = mix(0.92, 0.36, railCrown());`).replace('#include <metalnessmap_fragment>',
                `#include <metalnessmap_fragment>
                metalnessFactor = mix(0.3, 0.9, railCrown());`);
        };
        const rails = instances(railMaterial, 320, fused([
            [0.07, 0.05, 1, 0, 0.055, 0], [0.024, 0.09, 1, 0, 0, 0], [0.15, 0.024, 1, 0, -0.055, 0]]));
        // Each sleeper brings its own length of ballast: a crowned bed the
        // timbers sit in, its shoulders falling away into the shallows.
        const sleepers = instances(permanentWay, 400, (() => {
            const shape = fused([
                [2.4, 0.16, 0.24, 0, 0, 0], [0.34, 0.03, 0.2, -0.7175, 0.09, 0], [0.34, 0.03, 0.2, 0.7175, 0.09, 0],
                // Fastenings: a clip and its bolt head each side of each rail's foot.
                ...[-0.7175, 0.7175].flatMap(rail => [-0.115, 0.115].flatMap(clip => [
                    [0.05, 0.035, 0.11, rail + clip, 0.12, 0], [0.03, 0.03, 0.03, rail + clip * 1.12, 0.15, 0]]))]);
            const position = Array.from(shape.attributes.position.array);
            const normal = Array.from(shape.attributes.normal.array);
            const index = Array.from(shape.index.array);
            const bed = new Array(position.length / 3).fill(0);
            const profile = [[-2.3, -0.3], [-1.5, 0.03], [1.5, 0.03], [2.3, -0.3]], half = 0.39;
            for (let i = 0; i < 3; i++) {
                const [x0, y0] = profile[i], [x1, y1] = profile[i + 1];
                const length = Math.hypot(x1 - x0, y1 - y0), base = position.length / 3;
                position.push(x0, y0, -half, x1, y1, -half, x0, y0, half, x1, y1, half);
                for (let corner = 0; corner < 4; corner++) {
                    normal.push(-(y1 - y0) / length, (x1 - x0) / length, 0);
                    bed.push(1);
                }
                index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
            }
            shape.setAttribute('position', new T.Float32BufferAttribute(position, 3));
            shape.setAttribute('normal', new T.Float32BufferAttribute(normal, 3));
            shape.setAttribute('bed', new T.Float32BufferAttribute(bed, 1));
            shape.setIndex(index);
            return shape;
        })());
        // Tapered octagonal column: catenary masts, lamp posts, signals.
        const masts = instances(steel, 72, geometry(new T.CylinderGeometry(0.065, 0.115, 1, 8)));
        // Everything else is drawn from one pool per material, whatever it
        // depicts, so richer scenery does not cost more draw calls.
        const steelParts = instances(steel, 960);
        const concreteParts = instances(concrete, 400);
        const timberParts = instances(wood, 240);
        const GLOW_CAPACITY = 288;
        const glow = instances(glowMaterial, GLOW_CAPACITY);
        const glowKinds = new Uint8Array(GLOW_CAPACITY);
        glow.setColorAt(0, lampMaterial.color);
        // Each kind writes into the shared mesh and remembers which colour it takes.
        const tinted = kind => ({
            instanceMatrix: glow.instanceMatrix,
            get count() { return glow.count; },
            set count(value) { glow.count = value; },
            setMatrixAt(index, matrix) { glowKinds[index] = kind; glow.setMatrixAt(index, matrix); }
        });
        const glowParts = tinted(0), coldGlowParts = tinted(1);
        // The pair of lamps at a level crossing, flashing in turn.
        const signalLamps = tinted(2);
        const warmMarks = tinted(3), paleMarks = tinted(4);
        // A lit room seen through its window: the lamp colour, well short of the lamp itself.
        const windowLight = tinted(5), roomGlow = new T.Color();
        // A ceiling with lamps under it: far dimmer than a lamp, and one even tone.
        const litSurface = tinted(6), ceilingGlow = new T.Color();
        // A buoy's light, a short wink every few seconds, and the red paint under it.
        const beacons = tinted(7), signalBody = tinted(8);
        const sceneryPools = [masts, steelParts, concreteParts, timberParts, glow, dressed];
        Object.entries({ rails, sleepers, masts, steelParts, concreteParts, timberParts, glow })
            .forEach(([name, mesh]) => { mesh.name = name; });
        // The bed hides the track from below, so the water never shows it.
        rails.layers.set(1);
        sleepers.layers.set(1);
        // The rock pile is a data script of its own, fetched once the stage is up.
        let rocks = null, rocksArrived = false;
        // The camera's path past each address, worked out once per journey.
        let passing = new Map(), passingTrack = null;
        const raiseRocks = () => {
            const data = global.MusicStageAssets?.coastRock;
            if (!data || released || rocks) return;
            const bytes = text => Uint8Array.from(global.atob(text), c => c.charCodeAt(0));
            const quantised = new Uint16Array(bytes(data.position).buffer);
            const position = new Float32Array(quantised.length);
            for (let i = 0; i < quantised.length; i++)
                position[i] = quantised[i] / 65535 * data.size[i % 3] + data.origin[i % 3];
            const shape = geometry(new T.BufferGeometry());
            shape.setAttribute('position', new T.BufferAttribute(position, 3));
            shape.setAttribute('normal', new T.BufferAttribute(new Int8Array(bytes(data.normal).buffer), 3, true));
            shape.setAttribute('uv', new T.BufferAttribute(new Uint16Array(bytes(data.uv).buffer), 2, true));
            shape.setIndex(new T.BufferAttribute(new Uint16Array(bytes(data.index).buffer), 1));
            rocks = instances(rockMaterial, 40, shape);
            rocks.name = 'rocks';
            sceneryPools.push(rocks);
            rocksArrived = true;
        };
        if (T.TextureLoader && global.document?.createElement) {
            if (global.MusicStageAssets?.coastRock) raiseRocks();
            else {
                const tag = global.document.createElement('script');
                tag.src = ASSETS + 'coast-rock.js';
                tag.onload = raiseRocks;
                global.document.head?.appendChild(tag);
            }
        }
        let stationTypes = [], stationPlan = [];
        const wirePositions = new Float32Array(40 * 20 * 6);
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
        /*
         * The far shore is a long coastline. Off it lies a small island: a wooded
         * table of land, its lighthouse tower standing on top, joined to
         * the shore by a long bridge. Beyond and to the right, a snow-capped peak. They
         * are part of the same silhouette as the ridge, a tone apart: the
         * island nearer and darker, the mountain hazed and capped with snow.
         */
        const ridgeTones = new Array(ridgePositions.length / 3).fill(1);
        const facet = (a0, a1, radius, low0, high0, low1, high1, tone) => {
            const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius;
            const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
            ridgePositions.push(x0, low0, z0, x1, low1, z1, x0, high0, z0, x1, low1, z1, x1, high1, z1, x0, high0, z0);
            for (let i = 0; i < 6; i++) ridgeTones.push(tone);
        };
        const isleCrest = u => ISLE.crest * Math.pow(Math.max(0, 1 - u * u), 0.55) * (0.86 + 0.14 * Math.cos(u * 2.2 - 0.5))
            + (Math.abs(u) < 0.97 ? 1.6 * Math.sin(u * 23) + 1.1 * Math.sin(u * 51 + 1) : 0);
        for (let i = 0; i < 56; i++) {
            const u0 = i / 28 - 1, u1 = (i + 1) / 28 - 1;
            facet(ISLE.bearing + u0 * ISLE.reach, ISLE.bearing + u1 * ISLE.reach, ISLE.radius,
                -2, Math.max(-2, isleCrest(u0)), -2, Math.max(-2, isleCrest(u1)), 0.72);
        }
        // The tower: a stem that opens out to the deck near its top, a lantern, a mast.
        const towerAt = ISLE.bearing + ISLE.tower * ISLE.reach, towerFoot = isleCrest(ISLE.tower) - 1;
        [[0, 0.8, 0.62, 1.1], [0.62, 1.1, 0.76, 2.7], [0.76, 2.7, 0.8, 2.7], [0.8, 1.7, 0.88, 1.3], [0.88, 0.22, 1, 0.14]]
            .forEach(([from, wide0, to, wide1]) => {
                const y0 = towerFoot + from * ISLE.height, y1 = towerFoot + to * ISLE.height;
                const split = (w0, w1) => {
                    const x0 = Math.cos(towerAt - w0 / ISLE.radius) * ISLE.radius, z0 = Math.sin(towerAt - w0 / ISLE.radius) * ISLE.radius;
                    const x1 = Math.cos(towerAt + w0 / ISLE.radius) * ISLE.radius, z1 = Math.sin(towerAt + w0 / ISLE.radius) * ISLE.radius;
                    const x2 = Math.cos(towerAt - w1 / ISLE.radius) * ISLE.radius, z2 = Math.sin(towerAt - w1 / ISLE.radius) * ISLE.radius;
                    const x3 = Math.cos(towerAt + w1 / ISLE.radius) * ISLE.radius, z3 = Math.sin(towerAt + w1 / ISLE.radius) * ISLE.radius;
                    ridgePositions.push(x0, y0, z0, x1, y0, z1, x2, y1, z2, x1, y0, z1, x3, y1, z3, x2, y1, z2);
                    for (let i = 0; i < 6; i++) ridgeTones.push(0.72);
                };
                split(wide0, wide1);
            });
        const peakCrest = u => {
            const flank = Math.pow(Math.max(0, 1 - Math.abs(u)), 1.75);
            return PEAK.height * Math.min(flank, 0.93 + 0.02 * Math.sin(u * 90)) / 0.93;
        };
        const snowLine = u => PEAK.height * (0.62 + 0.05 * Math.sin(u * 37) + 0.03 * Math.sin(u * 83));
        for (let i = 0; i < 64; i++) {
            const u0 = i / 32 - 1, u1 = (i + 1) / 32 - 1;
            const a0 = PEAK.bearing + u0 * PEAK.reach, a1 = PEAK.bearing + u1 * PEAK.reach;
            const h0 = peakCrest(u0), h1 = peakCrest(u1), s0 = Math.min(h0, snowLine(u0)), s1 = Math.min(h1, snowLine(u1));
            facet(a0, a1, PEAK.radius, -2, s0, -2, s1, 1.22);
            if (h0 > s0 || h1 > s1) facet(a0, a1, PEAK.radius, s0, h0, s1, h1, 2.3);
        }
        const ridgeGeometry = geometry(new T.BufferGeometry());
        ridgeGeometry.setAttribute('position', new T.Float32BufferAttribute(ridgePositions, 3));
        ridgeGeometry.setAttribute('color', new T.Float32BufferAttribute(ridgeTones.flatMap(tone => [tone, tone, tone]), 3));
        const ridgeMaterial = material(new T.MeshBasicMaterial({ color: '#1c2935', side: T.DoubleSide, fog: false,
            vertexColors: true }));
        const ridge = new T.Mesh(ridgeGeometry, ridgeMaterial);
        root.add(ridge);
        const dummy = new T.Object3D();
        const scratch = new T.Color(), white = new T.Color('#ffffff');
        // Local axes: x across the track, y up, z along it. Roll leans a part
        // across the track, pitch tips it along the track.
        const place = (mesh, index, track, s, lateral, y, sx, sy, sz, roll = 0, pitch = 0) => {
            const f = track.at(s);
            dummy.position.set(f.position.x + f.right.x * lateral, y, f.position.z + f.right.z * lateral);
            dummy.rotation.set(pitch, -f.yaw, roll, 'YXZ');
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
        const headlight = new T.PointLight('#ffe9c4', 0, 16, 2);
        root.add(headlight);
        /*
         * The train is drawn after a classic seaside electric railcar:
         * short two-car articulated sets in a two-tone livery, a folded front
         * of three panes with a lamp on the roof, deep sash windows, one
         * lozenge pantograph to a set. From the cab it is all around the camera
         * and unseen; when the camera rises and swings out it is the subject of
         * the picture: two sets coupled, lit from inside, running over the water.
         */
        const CAR = Object.freeze({ length: 12.6, half: 1.3, sill: 1.22, floor: 1.36, waist: 2.16, bandTop: 3.12, cant: 3.2,
            crown: 3.85, bogie: 3.9, joint: 0.5, coupling: 0.9 });
        const CARS = 4, TIP = -CAR.length / 2;
        const SET_PITCH = CAR.length * 2 + CAR.joint + CAR.coupling;
        // 1 while the camera is close to the nose from outside: the saloon's real
        // cab is drawn then and the windscreen is clear glass in front of it;
        // further off the windscreen paints its own cab and the saloon is not drawn.
        const cabReal = { value: 0 }, tailReal = { value: 0 };
        // The rounded end in plan: distance behind the face, half width, share of the roof's rise.
        const NOSE = [[0, 0.46, 0.59], [0.058, 0.76, 0.73], [0.139, 1.02, 0.87],
            [0.253, 1.205, 0.96], [0.39, 1.274, 1], [0.59, CAR.half, 1]];
        const fascia = (x, lip = 0) => {
            const across = Math.abs(x);
            const end = NOSE.findIndex(([, width]) => across <= width);
            if (end < 1) return TIP + (end < 0 ? NOSE.at(-1)[0] : 0) - lip;
            const [z0, x0] = NOSE[end - 1], [z1, x1] = NOSE[end];
            return TIP + z0 + (z1 - z0) * (across - x0) / (x1 - x0) - lip;
        };
        const CAB_WINDOWS = [[-1.177, -0.485], [-0.423, 0.423], [0.485, 1.177]];
        const CAB_WINDOW_Y = 2.642, CAB_WINDOW_HEIGHT = 0.822;
        const CAB_LAMP_X = 0.805, CAB_LAMP_Y = 1.857, CAB_TAIL_Y = 1.628;
        const CAB_SIGN_Y = 2.027;
        const HOOD_RING = Array.from({ length: 13 }, (_, i) => i / 12 * Math.PI);
        // Openings along a side, measured from the middle of the car towards its inner end.
        const DOORS = [-4.3, 3.55], DOOR_HALF = 0.5, CREW_DOOR = -5.2, CREW_DOOR_HALF = 0.33, WINDOWS = [-2.95, -1.7, -0.45, 0.8, 2.05, 4.95], WINDOW_PITCH = 1.25;
        const DOOR_PANES = [2.60, 0.62, 0.86], SIDE_PANES = [2.63, 1.02, 0.86], CAB_PANE = [2.66, 0.5, 0.74];
        const CABIN = { ceiling: 3.34, tube: 3.285, rail: 0.86, first: -3.75, pitch: 2.17, length: 1.88, lamps: 5 };
        const cabinDaylight = { value: 0 };
        // How the saloon feels: low sun through the windows, the car emptying of
        // people, and the straps swinging with the ride. The director can set
        // pose.cabinSunset and pose.cabinEmpty (0 to 1); the stage tuning can too.
        const cabinMood = { sunset: { value: 0 }, empty: { value: 0 }, clock: { value: 0 }, sway: { value: 1 }, rain: { value: 0 } };
        /*
         * A small detail map made here, not loaded: R is woven pile for the
         * seats, G brushed streaks for stainless, B soft grime and wear, A a
         * fine grain. It tiles, it is the same on every run, and it is shared
         * by whatever wants surface detail (one sampler, no extra draws).
         */
        const detailAtlas = (() => {
            const SIZE = 256, data = new Uint8Array(SIZE * SIZE * 4);
            let seed = 0x2f6e2b1;
            const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
            const lattice = cells => { const g = new Float32Array(cells * cells); for (let i = 0; i < g.length; i++) g[i] = random(); return g; };
            const value = (g, cells, x, y) => {
                const fx = x * cells, fy = y * cells, ix = Math.floor(fx), iy = Math.floor(fy);
                const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
                const at = (i, j) => g[((j % cells) + cells) % cells * cells + ((i % cells) + cells) % cells];
                const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
                const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
                return top + (bottom - top) * sy;
            };
            const octaves = [4, 8, 16, 32].map(cells => [cells, lattice(cells)]);
            const fine = lattice(128), pile = lattice(64), streakRows = lattice(SIZE);
            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const u = x / SIZE, v = y / SIZE, i = (y * SIZE + x) * 4;
                    // Pile: a basket weave every 4 texels, each tuft a little different.
                    const weave = ((x >> 2) + (y >> 2)) % 2 ? Math.sin((x % 4 + 0.5) / 4 * Math.PI) : Math.sin((y % 4 + 0.5) / 4 * Math.PI);
                    const tuft = value(pile, 64, u, v);
                    data[i] = Math.round(255 * clamp(0.35 + 0.4 * weave * (0.6 + 0.4 * tuft) + 0.25 * (random() - 0.5)));
                    // Brushing runs along u; rows differ, and drift slowly.
                    const row = streakRows[y] * 0.6 + value(octaves[3][1], 32, u * 0.25, v) * 0.4;
                    data[i + 1] = Math.round(255 * clamp(0.5 + (row - 0.5) * 0.9 + (random() - 0.5) * 0.12));
                    let grime = 0, weight = 0.5;
                    octaves.forEach(([cells, g]) => { grime += value(g, cells, u, v) * weight; weight *= 0.5; });
                    data[i + 2] = Math.round(255 * clamp(grime / 0.9375));
                    data[i + 3] = Math.round(255 * clamp(value(fine, 128, u, v) * 0.7 + random() * 0.3));
                }
            }
            const texture = new T.DataTexture(data, SIZE, SIZE, T.RGBAFormat);
            texture.wrapS = texture.wrapT = T.RepeatWrapping;
            texture.magFilter = T.LinearFilter;
            texture.minFilter = T.LinearMipmapLinearFilter;
            texture.generateMipmaps = true;
            texture.anisotropy = 4;
            texture.needsUpdate = true;
            return texture;
        })();
        const cabinLightFunctions = `
            const float CEILING=${CABIN.ceiling},TUBE_Y=${CABIN.tube},RAIL=${CABIN.rail};
            const float FIRST_TUBE=${CABIN.first},TUBE_STEP=${CABIN.pitch},TUBE_HALF=${CABIN.length * 0.5};
            float tubeCentre(float z){
                float index=floor((z-FIRST_TUBE)/TUBE_STEP+0.5);
                return FIRST_TUBE+clamp(index,0.0,${(CABIN.lamps-1).toFixed(1)})*TUBE_STEP;
            }
            float tubes(vec2 p,float spread){
                float across=abs(p.x)-RAIL;
                return exp(-across*across/max(spread*spread,0.0001))
                    *(1.0-smoothstep(TUBE_HALF-spread,TUBE_HALF+spread,abs(p.y-tubeCentre(p.y))));
            }
            vec3 lampColour(vec3 theme,float day){
                return mix(mix(vec3(1.0,0.73,0.43),theme,0.29),vec3(0.91,0.94,1.0),day*0.66);
            }
        `;
        // Shapes gathered into one geometry, each vertex remembering which paint it takes.
        const fuser = () => {
            const positions = [], normals = [], groups = [], indices = [], fineIndices = [];
            // Small fittings can be marked fine: they go at the end of the index
            // buffer, so the saving tier can stop drawing short of them.
            let fine = false;
            const detail = on => { fine = on; };
            const add = (shape, group = 0) => {
                const flat = shape.index ? shape.toNonIndexed() : shape;
                const base = positions.length / 3;
                positions.push(...flat.attributes.position.array);
                normals.push(...flat.attributes.normal.array);
                const into = fine ? fineIndices : indices;
                for (let i = 0; i < flat.attributes.position.count; i++) { groups.push(group); into.push(base + i); }
                if (flat !== shape) flat.dispose();
                shape.dispose();
            };
            const boxAt = (sx, sy, sz, x, y, z, group) => add(new T.BoxGeometry(sx, sy, sz).translate(x, y, z), group);
            const forward = new T.Vector3(0, 0, 1), along = new T.Vector3(), turn = new T.Quaternion();
            // A square bar from one point to another.
            const beam = (ax, ay, az, bx, by, bz, thickness, group) => {
                along.set(bx - ax, by - ay, bz - az);
                const bar = new T.BoxGeometry(thickness, thickness, along.length());
                bar.applyQuaternion(turn.setFromUnitVectors(forward, along.normalize()));
                add(bar.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), group);
            };
            // A sheet through rows of points, smooth along and across.
            const sheet = (rows, group, smoothNormal) => {
                const points = [], index = [], n = rows[0].length;
                rows.forEach(row => row.forEach(point => points.push(...point)));
                for (let r = 0; r < rows.length - 1; r++) for (let i = 0; i < n - 1; i++) {
                    const a = r * n + i;
                    index.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
                }
                const shape = new T.BufferGeometry();
                shape.setAttribute('position', new T.Float32BufferAttribute(points, 3));
                shape.setIndex(index);
                shape.computeVertexNormals();
                if (smoothNormal) {
                    const normals = shape.attributes.normal;
                    const direction = new T.Vector3();
                    for (let i = 0; i < normals.count; i++) {
                        direction.fromBufferAttribute(normals, i);
                        smoothNormal(points[i * 3], points[i * 3 + 1], points[i * 3 + 2], direction);
                        normals.setXYZ(i, direction.x, direction.y, direction.z);
                    }
                }
                add(shape, group);
            };
            // A bogie: side frames with their axle boxes, the bolster, two wheelsets.
            const bogie = (z, group) => {
                for (const side of [-1, 1]) {
                    boxAt(0.1, 0.2, 2.5, side * 0.87, 0.8, z, group);
                    boxAt(0.16, 0.28, 0.52, side * 0.91, 0.9, z, group);
                    for (const axle of [-0.95, 0.95]) {
                        add(new T.CylinderGeometry(0.4, 0.4, 0.12, 28).rotateZ(Math.PI / 2)
                            .translate(side * 0.7175, 0.79, z + axle), group);
                        boxAt(0.14, 0.2, 0.26, side * 0.91, 0.79, z + axle, group);
                        if (group === 2) {
                            add(new T.CylinderGeometry(0.136, 0.16, 0.046, 12).rotateZ(Math.PI / 2)
                                .translate(side * 0.807, 0.79, z + axle), 4);
                            add(new T.TorusGeometry(0.358, 0.013, 4, 28).rotateY(Math.PI / 2)
                                .translate(side * 0.785, 0.79, z + axle), 4);
                        }
                    }
                }
                boxAt(1.72, 0.16, 0.38, 0, 0.92, z, group);
                for (const axle of [-0.95, 0.95]) {
                    add(new T.CylinderGeometry(0.07, 0.07, 1.44, 8).rotateZ(Math.PI / 2).translate(0, 0.79, z + axle), group);
                    // The motor hung between the axle and the bolster.
                    add(new T.CylinderGeometry(0.25, 0.25, 0.82, 12).rotateZ(Math.PI / 2)
                        .translate(0, 0.76, z + axle * 0.56), group);
                }
                // A coil spring: the bar wound in turns, each standing proud of the core.
                const coil = (x, y, at, radius, height, turns) => {
                    add(new T.CylinderGeometry(radius * 0.8, radius * 0.8, height, 8).translate(x, y, at), group);
                    const plainCoil = !fine; fine = true;
                    for (let turn = 0; turn < turns; turn++) {
                        add(new T.CylinderGeometry(radius, radius, height / turns * 0.42, 8)
                            .translate(x, y - height / 2 + height * (turn + 0.5) / turns, at), group === 2 ? 6 : group);
                    }
                    if (plainCoil) fine = false;
                };
                for (const side of [-1, 1]) {
                    const x = side * 0.93;
                    for (const axle of [-0.95, 0.95]) {
                        // Wing springs either side of each axle box, on a seat cast into it.
                        for (const wing of [-0.2, 0.2]) {
                            coil(x, 0.985, z + axle + wing, 0.05, 0.19, 4);
                            boxAt(0.13, 0.03, 0.12, x, 0.88, z + axle + wing, group);
                        }
                        const coarse = !fine; fine = true;
                        // The axle-box cover, bolted on, with its lubricator plug.
                        add(new T.CylinderGeometry(0.085, 0.085, 0.03, 14).rotateZ(Math.PI / 2)
                            .translate(side * 0.995, 0.79, z + axle), group);
                        add(new T.CylinderGeometry(0.03, 0.03, 0.03, 8).rotateZ(Math.PI / 2)
                            .translate(side * 1.02, 0.79, z + axle), group === 2 ? 6 : group);
                        for (let bolt = 0; bolt < 4; bolt++) {
                            const a = bolt / 4 * Math.PI * 2 + Math.PI / 4;
                            boxAt(0.02, 0.018, 0.018, side * 1.012, 0.79 + Math.sin(a) * 0.062, z + axle + Math.cos(a) * 0.062, group === 2 ? 6 : group);
                        }
                        if (coarse) fine = false;
                        // Brake blocks on their hangers, outside each wheel.
                        const out = axle + Math.sign(axle) * 0.47;
                        boxAt(0.1, 0.2, 0.06, side * 0.7175, 0.8, z + out, group);
                        beam(side * 0.7175, 0.9, z + out, side * 0.8, 1.14, z + out - Math.sign(axle) * 0.05, 0.03, group);
                    }
                    // The frame rises over the bolster; a pair of springs carries it on the plank below.
                    beam(x - side * 0.05, 1.07, z - 0.6, x - side * 0.05, 1.07, z + 0.6, 0.09, group);
                    for (const end of [-1, 1]) {
                        beam(x - side * 0.05, 0.95, z + end * 1.02, x - side * 0.05, 1.07, z + end * 0.6, 0.085, group);
                        coil(x, 0.83, z + end * 0.15, 0.072, 0.3, 5);
                    }
                    boxAt(0.2, 0.04, 0.66, x, 0.66, z, group);
                    const plain = !fine; fine = true;
                    // A brake cylinder on each frame, its rod to the hanger and its hose up to the body.
                    add(new T.CylinderGeometry(0.065, 0.065, 0.2, 12).rotateX(Math.PI / 2).translate(side * 0.78, 1.0, z + 0.48), group);
                    add(new T.CylinderGeometry(0.075, 0.075, 0.025, 12).rotateX(Math.PI / 2).translate(side * 0.78, 1.0, z + 0.37), group);
                    beam(side * 0.78, 1.0, z + 0.58, side * 0.76, 1.08, z + 1.32, 0.018, group === 2 ? 6 : group);
                    const hose = new T.CatmullRomCurve3([[side * 0.78, 1.06, z + 0.4], [side * 0.82, 1.14, z + 0.24],
                        [side * 0.86, 1.1, z + 0.08], [side * 0.9, 1.2, z - 0.05]].map(([hx, hy, hz]) => new T.Vector3(hx, hy, hz)));
                    add(new T.TubeGeometry(hose, 8, 0.016, 5, false), group === 2 ? 7 : group);
                    if (plain) fine = false;
                    for (const end of [-0.3, 0.3]) beam(x, 0.66, z + end, x, 1.04, z + end * 1.25, 0.03, group);
                }
            };
            const finish = () => {
                const shape = new T.BufferGeometry();
                shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
                shape.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
                shape.setAttribute('color', new T.Float32BufferAttribute(new Float32Array(positions.length).fill(1), 3));
                shape.setIndex([...indices, ...fineIndices]);
                shape.userData.groups = groups;
                shape.userData.coarse = indices.length;
                return geometry(shape);
            };
            return { add, boxAt, beam, sheet, bogie, finish, detail };
        };
        const roundedOutline = (path, width, height, radius) => {
            const x = width * 0.5, y = height * 0.5;
            path.moveTo(-x + radius, -y);
            path.lineTo(x - radius, -y); path.quadraticCurveTo(x, -y, x, -y + radius);
            path.lineTo(x, y - radius); path.quadraticCurveTo(x, y, x - radius, y);
            path.lineTo(-x + radius, y); path.quadraticCurveTo(-x, y, -x, y - radius);
            path.lineTo(-x, -y + radius); path.quadraticCurveTo(-x, -y, -x + radius, -y);
            return path;
        };
        // Paint groups: 0 upper body, 1 lower body, 2 running gear, 3 roof, 4 brushed trim, 5 tread, 6 spring steel.
        const carGeometry = (() => {
            const { add, boxAt, beam, sheet, bogie, finish, detail } = fuser();
            const sash = (side, z, [y, width, height]) => {
                // Three visible faces of the surround, with the back buried in the bodywork.
                const profile = [[0.009, 0.074, 0.105], [0.027, 0.064, 0.101],
                    [0.033, 0.007, 0.078], [0.014, -0.008, 0.071]];
                sheet(profile.map(([depth, pad, radius]) => roundedOutline(new T.Path(), width + pad, height + pad, radius)
                    .getPoints(2).map(p => [side * (CAR.half + depth), y + p.y, z - p.x * side])), 4);
            };
            const windscreenRim = (left, right, y, h) => {
                const width = right - left, mid = (right + left) * 0.5;
                const rim = (pad, r, protrusion) => roundedOutline(new T.Path(), width + pad, h + pad, r)
                    .getPoints(3).reverse().map(p => [mid + p.x, y + p.y, fascia(mid + p.x, protrusion)]);
                sheet([rim(0.099, 0.093, 0.013), rim(0.065, 0.081, 0.039), rim(0.018, 0.059, 0.044)], 4);
                sheet([rim(0.018, 0.059, 0.044), rim(-0.02, 0.049, 0.035), rim(-0.036, 0.041, 0.018)], 2);
            };
            // A door in its opening: the leaf stands back from the skin behind a
            // stainless frame, its window held in black rubber with round corners,
            // a kick plate along its foot and a seal on both edges.
            const LEAF = CAR.half - 0.042;
            const doorway = (side, z, half, [y, width, height], sliding) => {
                const top = CAR.bandTop - 0.03, foot = CAR.floor, low = y - height / 2, high = y + height / 2;
                const leafHalf = half - 0.028, at = side * (LEAF - 0.014);
                const panel = (y0, y1, z0, z1, group) => {
                    if (y1 - y0 > 0.002 && z1 - z0 > 0.002) boxAt(0.028, y1 - y0, z1 - z0, at, (y0 + y1) / 2, z + (z0 + z1) / 2, group);
                };
                panel(foot, CAR.waist, -leafHalf, leafHalf, 1);
                panel(CAR.waist, low, -leafHalf, leafHalf, 0);
                panel(high, top, -leafHalf, leafHalf, 0);
                panel(low, high, -leafHalf, -width / 2, 0);
                panel(low, high, width / 2, leafHalf, 0);
                const gasket = [[0, 0.074, 0.08], [0.011, 0.056, 0.072], [0.013, 0.016, 0.054], [-0.006, -0.006, 0.047]];
                sheet(gasket.map(([depth, pad, radius]) => roundedOutline(new T.Path(), width + pad, height + pad, radius)
                    .getPoints(3).map(p => [side * (LEAF + depth), y + p.y, z - p.x * side])), 7);
                // Stainless frame: jambs, head and the threshold plate with its tread.
                const deep = CAR.half + 0.006 - (LEAF - 0.03), mid = side * (CAR.half + 0.006 - deep / 2);
                for (const edge of [-1, 1]) {
                    boxAt(deep, top - foot + 0.03, 0.022, mid, (top + foot + 0.03) / 2, z + edge * (half - 0.011), 4);
                    // The rubber seal where the leaf meets the frame.
                    boxAt(0.016, top - foot - 0.02, 0.012, side * (LEAF + 0.004), (top + foot) / 2, z + edge * (leafHalf - 0.004), 7);
                }
                boxAt(deep, 0.024, half * 2, mid, top + 0.018, z, 4);
                boxAt(deep + 0.02, 0.016, half * 2, side * (CAR.half + 0.016 - (deep + 0.02) / 2), foot - 0.006, z, 5);
                boxAt(0.05, foot - CAR.sill, half * 2, side * (CAR.half - 0.075), (foot + CAR.sill) / 2, z, 2);
                // Kick plate, and the pull or handle.
                boxAt(0.006, 0.12, leafHalf * 2 - 0.03, side * (LEAF + 0.003), foot + 0.075, z, 4);
                if (sliding) {
                    boxAt(0.012, 0.16, 0.032, side * (LEAF + 0.006), 2.0, z - side * (leafHalf - 0.07), 7);
                } else {
                    boxAt(0.03, 0.026, 0.11, side * (LEAF + 0.016), 2.12, z + side * (leafHalf - 0.09), 4);
                    boxAt(0.012, 0.05, 0.05, side * (LEAF + 0.006), 2.12, z + side * (leafHalf - 0.06), 4);
                }
            };
            // The cross-section, anticlockwise seen from behind. The upper body
            // turns into the roof without a gutter, as on the real cars.
            const corner = Array.from({ length: 7 }, (_, i) => {
                const a = i / 6 * 65 * Math.PI / 180;
                return [CAR.half - 0.42 + Math.cos(a) * 0.42, CAR.cant + Math.sin(a) * 0.4];
            });
            const [edgeX, edgeY] = corner.at(-1);
            const roof = Array.from({ length: 13 }, (_, i) => {
                const x = edgeX * (1 - i / 6);
                return [x, edgeY + (CAR.crown - edgeY) * (1 - (x / edgeX) ** 2)];
            });
            const mirror = points => points.map(([x, y]) => [-x, y]).reverse();
            const lower = [[CAR.half - 0.095, CAR.sill], [CAR.half - 0.026, CAR.sill + 0.13],
                [CAR.half, CAR.sill + 0.36], [CAR.half, CAR.waist]];
            const belt = [[CAR.half, CAR.waist], [CAR.half, CAR.bandTop]];
            const upper = [[CAR.half, CAR.bandTop], ...corner];
            const section = [[lower, 1], [belt, 0], [upper, 1], [roof, 3],
                [mirror(upper), 1], [mirror(belt), 0], [mirror(lower), 1],
                [[[-CAR.half, CAR.sill], [CAR.half, CAR.sill]], 2]];
            const stations = [...NOSE.map(([back, wide, rise]) => [TIP + back, wide / CAR.half, rise]), [CAR.length / 2, 1, 1]];
            const at = ([x, y], [z, wide, rise]) => [x * wide, y > CAR.cant ? CAR.cant + (y - CAR.cant) * rise : y, z];
            const curved = new T.Vector3();
            const smoothCabRoof = (x, y, z, direction) => {
                const height = smooth((y - CAR.bandTop) / (CAR.crown - CAR.bandTop));
                const front = 1 - smooth((z - TIP) / 0.58);
                if (front <= 0) return;
                // Share the normal at the seam where the painted brow turns into the curved roof.
                curved.set(x * 0.54, 0.11 + height * 1.75, -1).normalize();
                direction.lerp(curved, front * smooth((y - CAR.bandTop) / 0.24)).normalize();
            };
            // Side panels below the cream band are cut where the doors are, so
            // the leaves can sit back in their openings instead of being drawn on.
            const openings = [[CREW_DOOR - CREW_DOOR_HALF, CREW_DOOR + CREW_DOOR_HALF],
                ...DOORS.map(z => [z - DOOR_HALF, z + DOOR_HALF])];
            const cutRuns = (() => {
                const runs = [];
                let run = stations.slice(0, -1);
                for (const [from, to] of openings) {
                    runs.push([...run, [from, 1, 1]]);
                    run = [[to, 1, 1]];
                }
                runs.push([...run, stations.at(-1)]);
                return runs;
            })();
            for (const [points, group] of section) {
                if (points === lower || points === belt || points === section[5][0] || points === section[6][0]) {
                    for (const run of cutRuns) sheet(run.map(station => points.map(point => at(point, station))), group,
                        group === 1 ? smoothCabRoof : null);
                    continue;
                }
                if (group === 3) {
                    // The painted cap follows the rounded face and the roof changes above the cab.
                    sheet(stations.slice(0, -1).map(station => points.map(point => at(point, station))), 1, smoothCabRoof);
                    sheet(stations.slice(-2).map(station => points.map(point => at(point, station))), group);
                } else {
                    sheet(stations.map(station => points.map(point => at(point, station))), group, group === 1 ? smoothCabRoof : null);
                }
            }
            // The two ends, closed in bands from one side across to the other.
            const half = roof.slice(0, 7);
            const cap = (station, front) => [[lower, 1], [belt, 0], [upper, 1], [half, 1]].forEach(([points, group]) => {
                const right = points.map(point => at(point, station)), left = right.map(([x, y, z]) => [-x, y, z]);
                sheet(front ? [left, right] : [right, left], front ? group : 2, front && group === 1 ? smoothCabRoof : null);
            });
            cap(stations[0], true);
            cap(stations.at(-1), false);
            for (const [left, right] of CAB_WINDOWS) windscreenRim(left, right, CAB_WINDOW_Y, CAB_WINDOW_HEIGHT);
            // Enamel destination frame and the metal lip along the bottom of the face.
            boxAt(0.732, 0.214, 0.064, 0, CAB_SIGN_Y, fascia(0, 0.033), 2);
            boxAt(0.711, 0.195, 0.034, 0, CAB_SIGN_Y, fascia(0, 0.064), 4);
            for (const side of [-1, 1]) {
                const x = side * (CAR.half + 0.008);
                WINDOWS.forEach(z => {
                    sash(side, z, SIDE_PANES);
                    boxAt(0.032, 0.028, 1.026, side * (CAR.half + 0.016), 2.189, z, 4);
                    detail(true);
                    // Two-stage sash: a short fixed upper light set back, the tall
                    // lower light that lifts in front of it, the meeting rail between.
                    const [y, width, height] = SIDE_PANES, low = y - height / 2, rail = y + height * 0.14;
                    const outer = side * (CAR.half + 0.021), inner = side * (CAR.half + 0.015);
                    for (const edge of [-1, 1]) {
                        boxAt(0.02, rail - low - 0.01, 0.034, outer, (rail + low) / 2, z + edge * (width / 2 - 0.035), 4);
                        boxAt(0.014, y + height / 2 - rail - 0.02, 0.026, inner, (y + height / 2 + rail) / 2, z + edge * (width / 2 - 0.03), 4);
                    }
                    boxAt(0.02, 0.03, width - 0.05, outer, low + 0.03, z, 4);
                    boxAt(0.026, 0.044, width - 0.04, outer, rail, z, 4);
                    boxAt(0.014, 0.022, width - 0.06, inner, y + height / 2 - 0.025, z, 4);
                    detail(false);
                    detail(true);
                    // Latches on the meeting rail and finger lifts on the bottom rail.
                    for (const edge of [-0.27, 0.27]) {
                        boxAt(0.03, 0.022, 0.05, side * (CAR.half + 0.036), rail + 0.004, z + edge * width, 6);
                        boxAt(0.026, 0.018, 0.06, side * (CAR.half + 0.033), low + 0.06, z + edge * width, 6);
                    }
                    detail(false);
                });
                for (const z of DOORS) {
                    doorway(side, z, DOOR_HALF, DOOR_PANES, true);
                    // The step under the doorway, its tread and nosing, and its brackets.
                    boxAt(0.21, 0.051, 1.05, side * (CAR.half + 0.018), CAR.sill + 0.042, z, 2);
                    boxAt(0.183, 0.018, 1.016, side * (CAR.half + 0.029), CAR.sill + 0.075, z, 5);
                    boxAt(0.023, 0.025, 1.044, side * (CAR.half + 0.129), CAR.sill + 0.067, z, 4);
                    for (const edge of [-0.47, 0.47]) {
                        beam(side * 1.16, CAR.sill - 0.19, z + edge, side * 1.39, CAR.sill + 0.031, z + edge, 0.037, 2);
                    }
                    detail(true);
                    // Grab rails on the body either side of the opening, stood off on round feet.
                    for (const edge of [-1, 1]) {
                        const rail = z + edge * (DOOR_HALF + 0.075);
                        // Beside the crew door there is room for only that door's own rail.
                        if (Math.abs(rail - CREW_DOOR) < CREW_DOOR_HALF + 0.25) continue;
                        add(new T.CylinderGeometry(0.013, 0.013, 0.86, 8).translate(side * (CAR.half + 0.052), 2.02, rail), 4);
                        for (const y of [1.62, 2.42]) {
                            add(new T.CylinderGeometry(0.011, 0.011, 0.056, 6).rotateZ(Math.PI / 2)
                                .translate(side * (CAR.half + 0.026), y, rail), 4);
                            add(new T.CylinderGeometry(0.022, 0.022, 0.01, 8).rotateZ(Math.PI / 2)
                                .translate(side * (CAR.half + 0.004), y, rail), 4);
                        }
                    }
                    // The door lamp over the opening, which lights while the doors are open.
                    add(new T.CylinderGeometry(0.034, 0.04, 0.03, 10).rotateZ(Math.PI / 2)
                        .translate(side * (CAR.half + 0.016), 3.28, z + DOOR_HALF - 0.12), 7);
                    add(new T.SphereGeometry(0.03, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-side * Math.PI / 2)
                        .translate(side * (CAR.half + 0.03), 3.28, z + DOOR_HALF - 0.12), 9);
                    detail(false);
                }
                doorway(side, CREW_DOOR, CREW_DOOR_HALF, CAB_PANE, false);
                // Rolled drip rail above the glazing, and the lower seam between the doors.
                [[DOORS[0] + DOOR_HALF, DOORS[1] - DOOR_HALF], [DOORS[1] + DOOR_HALF, 6.2]].forEach(([from, to]) =>
                    boxAt(0.024, 0.029, to - from, x, CAR.waist, (from + to) / 2, 1));
                add(new T.CylinderGeometry(0.015, 0.015, 11.78, 7).rotateX(Math.PI / 2)
                    .translate(x, CAR.bandTop + 0.073, 0.26), 1);
                boxAt(0.03, 0.07, CAR.length - 1.1, x, CAR.sill + 0.02, 0.5, 2);
                // Hung under the floor: resistors, control gear, a reservoir.
                boxAt(0.6, 0.42, 1.9, side * 0.8, 0.84, 0.2, 2);
                boxAt(0.6, 0.34, 1.15, side * 0.8, 0.88, 2.2 + side * 0.25, 2);
                boxAt(0.5, 0.3, 0.85, side * 0.82, 0.9, 4.3, 2);
                detail(true);
                // Each case has a lid with a rim, hinges along its top and a catch.
                for (const [z, long, y, tall] of [[0.2, 1.9, 0.84, 0.42], [2.2 + side * 0.25, 1.15, 0.88, 0.34], [4.3, 0.85, 0.9, 0.3]]) {
                    const face = side * 1.105;
                    boxAt(0.012, tall - 0.07, long - 0.09, face, y, z, 6);
                    boxAt(0.02, 0.022, long - 0.03, face, y + tall / 2 - 0.02, z, 2);
                    for (const hinge of [-0.3, 0.3]) boxAt(0.03, 0.05, 0.07, face, y + tall / 2 - 0.04, z + hinge * long, 4);
                    boxAt(0.03, 0.06, 0.04, face, y - tall / 2 + 0.07, z, 4);
                    // Hangers up to the underframe.
                    for (const end of [-0.42, 0.42]) boxAt(0.05, 0.16, 0.05, side * 0.8, y + tall / 2 + 0.06, z + end * long, 2);
                }
                // The brake pipe and the conduit, clipped along under the sill.
                add(new T.CylinderGeometry(0.022, 0.022, 9.6, 6).rotateX(Math.PI / 2).translate(side * 1.16, CAR.sill - 0.07, 0.6), 6);
                add(new T.CylinderGeometry(0.014, 0.014, 9.6, 6).rotateX(Math.PI / 2).translate(side * 1.16, CAR.sill - 0.125, 0.6), 2);
                for (let clip = -3.8; clip < 5.2; clip += 1.5) boxAt(0.04, 0.1, 0.03, side * 1.16, CAR.sill - 0.09, clip, 2);
                detail(false);
                // The crew door behind the cab: its seams, a rail to climb by on either side, and the steps below.
                for (const edge of [-0.34, 0.34]) {
                    const rail = -5.2 + edge * 1.34;
                    add(new T.CylinderGeometry(0.011, 0.011, 1.0, 6).translate(side * (CAR.half + 0.05), 2.2, rail), 4);
                    for (const y of [1.72, 2.68]) {
                        add(new T.CylinderGeometry(0.011, 0.011, 0.05, 6).rotateZ(Math.PI / 2).translate(side * (CAR.half + 0.027), y, rail), 4);
                    }
                }
                for (const [y, out] of [[1.0, 0.07], [0.72, 0.09]]) {
                    boxAt(0.15, 0.022, 0.46, side * (CAR.half - 0.02 + out), y, -5.2, 5);
                    for (const edge of [-0.22, 0.22]) {
                        beam(side * (CAR.half - 0.06), CAR.sill, -5.2 + edge, side * (CAR.half + out), y, -5.2 + edge, 0.022, 2);
                    }
                }
            }
            // On the far side of the resistors: a second reservoir, the compressor and its motor.
            add(new T.CylinderGeometry(0.13, 0.13, 1.1, 10).rotateX(Math.PI / 2).translate(0.32, 0.92, -1.75), 2);
            for (const band of [-0.4, 0.4]) {
                add(new T.CylinderGeometry(0.177, 0.177, 0.04, 10).rotateX(Math.PI / 2).translate(-0.3, 0.88, -1.6 + band), 6);
            }
            boxAt(0.5, 0.3, 0.46, 0.1, 0.9, 3.3, 2);
            add(new T.CylinderGeometry(0.16, 0.16, 0.5, 10).rotateX(Math.PI / 2).translate(0.1, 0.9, 3.85), 2);
            for (let rib = 0; rib < 7; rib++) boxAt(0.03, 0.34, 0.05, 1.115, 0.84, -0.55 + rib * 0.25, 3);
            add(new T.CylinderGeometry(0.17, 0.17, 1.5, 10).rotateX(Math.PI / 2).translate(-0.3, 0.88, -1.6), 2);
            boxAt(2.1, 0.2, CAR.length - 1.4, 0, CAR.sill - 0.08, 0.5, 2);
            bogie(-CAR.bogie, 2);
            // Cab end: buffer beam, coupler, lifeguard and separate head and tail lamps.
            boxAt(1.02, 0.15, 0.08, 0, CAR.sill + 0.04, TIP - 0.035, 2);
            // The anticlimber: three ribs across the beam.
            for (const rib of [-0.045, 0, 0.045]) boxAt(1.06, 0.018, 0.05, 0, CAR.sill + 0.04 + rib, TIP - 0.085, 4);
            boxAt(0.2, 0.158, 0.54, 0, 0.98, TIP - 0.15, 2);
            boxAt(0.28, 0.136, 0.135, 0, 0.98, TIP - 0.46, 2);
            boxAt(0.208, 0.042, 0.092, -0.033, 0.98, TIP - 0.558, 4);
            add(new T.CylinderGeometry(0.034, 0.034, 0.165, 10).translate(0.074, 0.978, TIP - 0.503), 4);
            boxAt(1.8, 0.07, 0.07, 0, 0.6, TIP + 0.3, 2);
            for (const side of [-1, 1]) {
                beam(side * 0.6, 0.6, TIP + 0.3, side * 0.6, CAR.sill, TIP + 0.8, 0.06, 2);
                const brakeHose = new T.CatmullRomCurve3([
                    [side * 0.42, 1.16, -0.027], [side * 0.42, 0.86, -0.12],
                    [side * 0.34, 0.76, -0.24], [side * 0.26, 0.87, -0.34]
                ].map(([x, y, offset]) => new T.Vector3(x, y, TIP + offset)));
                add(new T.TubeGeometry(brakeHose, 10, 0.025, 6, false), 2);
                boxAt(0.064, 0.092, 0.057, side * 0.42, 1.16, TIP - 0.045, 4);
                boxAt(0.055, 0.053, 0.072, side * 0.26, 0.87, TIP - 0.34, 4);
                const x = side * CAB_LAMP_X, y = CAB_LAMP_Y;
                const slope = (fascia(x + 0.055) - fascia(x - 0.055)) / 0.11;
                const heading = -Math.atan(slope);
                add(new T.CylinderGeometry(0.139, 0.119, 0.112, 18).rotateX(Math.PI / 2).rotateY(heading)
                    .translate(x, y, fascia(x, 0.057)), 1);
                add(new T.TorusGeometry(0.104, 0.016, 6, 18).rotateY(heading).translate(x, y, fascia(x, 0.113)), 4);
                add(new T.CylinderGeometry(0.093, 0.09, 0.014, 18).rotateX(Math.PI / 2).rotateY(heading)
                    .translate(x, y, fascia(x, 0.113)), 2);
                add(new T.BoxGeometry(0.186, 0.118, 0.07).rotateY(heading)
                    .translate(x, CAB_TAIL_Y, fascia(x, 0.034)), 1);
                add(new T.BoxGeometry(0.15, 0.09, 0.018).rotateY(heading)
                    .translate(x, CAB_TAIL_Y, fascia(x, 0.07)), 2);
            }
            detail(true);
            // The face, finished: a drip strip over the windscreens, a seam along the
            // waist, grab handles either side, wipers parked on the outer panes, the
            // washer jets, and the jumper sockets with their cables on the buffer beam.
            {
                const across = (from, to, y, lip, radius, group, steps = 24) => {
                    const points = Array.from({ length: steps + 1 }, (_, i) => {
                        const x = from + (to - from) * i / steps;
                        return new T.Vector3(x, y, fascia(x, lip));
                    });
                    add(new T.TubeGeometry(new T.CatmullRomCurve3(points), steps, radius, 5, false), group);
                };
                across(-1.27, 1.27, CAB_WINDOW_Y + CAB_WINDOW_HEIGHT / 2 + 0.085, 0.012, 0.014, 4);
                across(-1.29, 1.29, CAR.waist, 0.004, 0.009, 1);
                across(-1.29, 1.29, CAR.sill + 0.36, 0.004, 0.007, 1);
                for (const side of [-1, 1]) {
                    // Grab handle on stand-offs beside the headlamp.
                    const x = side * 1.12, lip = fascia(x, 0.06), base = fascia(x, 0.002);
                    add(new T.CylinderGeometry(0.012, 0.012, 0.5, 8).translate(x, 1.86, lip), 4);
                    for (const y of [1.64, 2.08]) beam(x, y, base, x, y, lip, 0.02, 4);
                    // Wiper parked along the bottom of the outer pane: pivot, arm and blade.
                    const pivotX = side * 0.56, pivotY = CAB_WINDOW_Y - CAB_WINDOW_HEIGHT / 2 - 0.03;
                    const tipX = side * 0.98, tipY = pivotY + 0.1;
                    add(new T.CylinderGeometry(0.026, 0.03, 0.04, 10).rotateX(Math.PI / 2)
                        .translate(pivotX, pivotY, fascia(pivotX, 0.03)), 6);
                    beam(pivotX, pivotY, fascia(pivotX, 0.05), tipX, tipY, fascia(tipX, 0.05), 0.016, 6);
                    beam(side * 0.6, pivotY + 0.085, fascia(side * 0.6, 0.06), side * 1.1, pivotY + 0.105, fascia(side * 1.1, 0.06), 0.016, 7);
                    add(new T.CylinderGeometry(0.012, 0.012, 0.02, 6).rotateX(Math.PI / 2)
                        .translate(side * 0.3, pivotY, fascia(side * 0.3, 0.03)), 6);
                    // Jumper socket and its cable looped down to the beam.
                    const jx = side * 0.66;
                    boxAt(0.14, 0.12, 0.1, jx, CAR.sill - 0.06, TIP - 0.03, 2);
                    add(new T.CylinderGeometry(0.04, 0.04, 0.05, 10).rotateX(Math.PI / 2).translate(jx, CAR.sill - 0.06, TIP - 0.1), 6);
                    const cable = new T.CatmullRomCurve3([
                        [jx, CAR.sill - 0.06, TIP - 0.12], [jx + side * 0.04, CAR.sill - 0.3, TIP - 0.2],
                        [jx - side * 0.12, CAR.sill - 0.38, TIP - 0.14], [jx - side * 0.2, CAR.sill - 0.14, TIP - 0.06]
                    ].map(([x, y, z]) => new T.Vector3(x, y, z)));
                    add(new T.TubeGeometry(cable, 12, 0.018, 6, false), 7);
                }
                // A step rung under the destination box, for reaching the board.
                boxAt(0.36, 0.022, 0.06, 0, 1.5, fascia(0, 0.04), 5);
                for (const end of [-0.17, 0.17]) beam(end, 1.5, fascia(end, 0.004), end, 1.5, fascia(end, 0.06), 0.02, 4);
            }
            detail(false);
            // Roof. Two pressed-steel cooler housings in tandem: rounded hoods with
            // slotted grilles at either end of their flanks, lid seams and lifting
            // eyes, bolted down on a flange. Near the cab a ventilator can on its
            // feet, the whistle and a radio aerial; conduits run in clips along the
            // roof to the pantograph, and a drip strip finishes each edge.
            const roofAt = x => edgeY + (CAR.crown - edgeY) * (1 - (x / edgeX) ** 2);
            const hood = (from, to, wide, height) => {
                const base = roofAt(wide / 2) - 0.02, round = 0.26, half = wide / 2;
                // Rounded in section (a squarish superellipse) and in plan at both ends.
                const ring = (scaleX, scaleY, grow = 0, thetas = HOOD_RING) => thetas.map(theta => {
                    const c = Math.cos(theta), sn = Math.sin(theta);
                    return [Math.sign(c) * Math.abs(c) ** 0.32 * (half * scaleX + grow), base + Math.abs(sn) ** 0.32 * (height * scaleY + grow)];
                });
                const stations = [];
                for (let i = 0; i <= 4; i++) {
                    const a = i / 4 * Math.PI / 2, sx = 0.42 + 0.58 * Math.sin(a), sy = 0.62 + 0.38 * Math.sin(a);
                    stations.push([from + round * (1 - Math.cos(a)), sx, sy]);
                }
                const mirrorEnd = stations.map(([z, sx, sy]) => [from + to - z, sx, sy]).reverse();
                const all = [[from, 0, 0], ...stations, ...mirrorEnd, [to, 0, 0]];
                sheet(all.map(([z, sx, sy]) => ring(sx, sy).map(([x, y]) => [x, y, z])), 10);
                // Grilles stand a few millimetres off the flanks, near each end.
                const grilleRing = HOOD_RING.filter(t => t > 0.18 && t < 1.05);
                for (const side of [-1, 1]) for (const [g0, g1] of [[from + round + 0.06, from + round + 0.62], [to - round - 0.62, to - round - 0.06]]) {
                    const rows = [g0, (g0 + g1) / 2, g1].map(z => ring(1, 1, 0.005, grilleRing).map(([x, y]) => [x * side, y, z]));
                    sheet(rows, 8);
                    sheet(rows.slice().reverse(), 8);
                }
                detail(true);
                // Lid seams across the top, lifting eyes, and the flange it is bolted down on.
                const length = to - from;
                for (const seam of [0.36, 0.64]) boxAt(wide * 0.7, 0.012, 0.022, 0, base + height + 0.003, from + seam * length, 6);
                for (const end of [0.2, 0.8]) for (const side of [-1, 1]) {
                    add(new T.TorusGeometry(0.03, 0.009, 4, 8).translate(side * half * 0.5, base + height * 0.98 + 0.03, from + end * length), 6);
                }
                for (const side of [-1, 1]) {
                    boxAt(0.07, 0.03, length - 0.3, side * (half + 0.02), base + 0.015, (from + to) / 2, 2);
                    for (let bolt = 0; bolt < 6; bolt++) {
                        add(new T.CylinderGeometry(0.014, 0.014, 0.02, 6)
                            .translate(side * (half + 0.035), base + 0.038, from + 0.25 + bolt * (length - 0.5) / 5), 6);
                    }
                }
                detail(false);
            };
            hood(-0.95, 1.35, 1.36, 0.3);
            hood(1.55, 3.85, 1.36, 0.3);
            detail(true);
            // Ventilator can on three feet, its cap and the rain lip under the cap.
            {
                const x = 0.36, z = -5.0, foot = roofAt(x);
                add(new T.CylinderGeometry(0.15, 0.15, 0.24, 16).translate(x, foot + 0.17, z), 10);
                add(new T.CylinderGeometry(0.19, 0.19, 0.035, 16).translate(x, foot + 0.31, z), 10);
                add(new T.CylinderGeometry(0.155, 0.19, 0.05, 16).translate(x, foot + 0.27, z), 2);
                for (let leg = 0; leg < 3; leg++) {
                    const a = leg / 3 * Math.PI * 2 + 0.4;
                    beam(x + Math.cos(a) * 0.12, foot + 0.07, z + Math.sin(a) * 0.12, x + Math.cos(a) * 0.2, foot - 0.01, z + Math.sin(a) * 0.2, 0.022, 10);
                }
            }
            // The whistle on its bracket, and the radio aerial.
            add(new T.CylinderGeometry(0.028, 0.034, 0.2, 8).translate(-0.4, roofAt(0.4) + 0.08, -5.45), 4);
            boxAt(0.05, 0.05, 0.2, -0.4, roofAt(0.4) + 0.19, -5.38, 4);
            add(new T.CylinderGeometry(0.045, 0.045, 0.08, 6).translate(-0.4, roofAt(0.4) + 0.19, -5.26), 4);
            {
                const x = -0.62, z = -4.35, foot = roofAt(x);
                boxAt(0.14, 0.03, 0.22, x, foot + 0.015, z, 10);
                add(new T.CylinderGeometry(0.03, 0.04, 0.12, 8).translate(x, foot + 0.09, z), 7);
                beam(x, foot + 0.15, z, x, foot + 0.5, z + 0.04, 0.012, 6);
                beam(x, foot + 0.5, z + 0.04, x, foot + 0.53, z + 0.3, 0.012, 6);
            }
            // Conduits along the roof in clips, from the pantograph back over the hoods.
            for (const [x, from, to, radius] of [[0.58, -4.6, 4.6, 0.02], [0.66, -4.4, 4.6, 0.014], [-0.6, -2.2, 4.2, 0.018]]) {
                const y = roofAt(Math.abs(x)) + radius + 0.01;
                add(new T.CylinderGeometry(radius, radius, to - from, 6).rotateX(Math.PI / 2).translate(x, y, (from + to) / 2), 10);
                for (let clip = from + 0.3; clip < to; clip += 0.75) boxAt(0.06, radius * 2 + 0.02, 0.03, x, y - 0.005, clip, 2);
            }
            // The drip strip along each roof edge.
            for (const side of [-1, 1]) {
                add(new T.CylinderGeometry(0.018, 0.018, CAR.length - 1.0, 6).rotateX(Math.PI / 2)
                    .translate(side * (edgeX - 0.02), edgeY + 0.02, 0.5), 1);
            }
            detail(false);
            // The pantograph stands near the cab end of every car: a frame on
            // four insulators, a lozenge braced across its lower arms, and a
            // head of two strips with their horns turned down.
            {
                const centre = -3.4, base = CAR.crown + 0.15, knee = 4.84, top = CONTACT_Y - 0.03;
                // The insulating mat it stands on, following the roof, with a walkway edge.
                const mat = [-1.2, 1.2].map(dz => Array.from({ length: 9 }, (_, i) => {
                    const x = 0.78 - i / 8 * 1.56;
                    return [x, roofAt(Math.abs(x)) + 0.012, centre + dz];
                }));
                sheet(mat, 7);
                for (const end of [-1, 1]) boxAt(1.5, 0.02, 0.04, 0, CAR.crown + 0.01, centre + end * 1.2, 7);
                // The raising cylinder and its damper, between the base rails.
                add(new T.CylinderGeometry(0.05, 0.05, 0.42, 10).rotateX(Math.PI / 2).translate(0, base + 0.04, centre + 0.35), 10);
                beam(0, base + 0.04, centre + 0.12, 0.14, base + 0.2, centre - 0.12, 0.022, 6);
                for (const side of [-1, 1]) {
                    boxAt(0.26, 0.03, 2.2, side * 0.76, roofAt(0.76) + 0.05, centre, 2);
                    for (const post of [-0.75, 0.75]) boxAt(0.05, 0.08, 0.05, side * 0.76, roofAt(0.76) + 0.01, centre + post, 2);
                    const x = side * 0.42;
                    boxAt(0.06, 0.05, 1.56, x, base, centre, 2);
                    for (const end of [-1, 1]) {
                        const z = centre + end * 0.62;
                        detail(true);
                        // A porcelain insulator of three sheds, capped in metal top and bottom.
                        add(new T.CylinderGeometry(0.04, 0.05, 0.17, 10).translate(x, base - 0.105, z), 10);
                        for (const shed of [-0.16, -0.115, -0.07]) {
                            add(new T.CylinderGeometry(0.06, 0.085, 0.022, 12).translate(x, base + shed, z), 10);
                        }
                        add(new T.CylinderGeometry(0.05, 0.05, 0.025, 10).translate(x, base - 0.03, z), 6);
                        detail(false);
                        boxAt(0.12, 0.02, 0.12, x, CAR.crown - 0.02, z, 2);
                        beam(x, base, centre - end * 0.14, x * 0.9, knee, centre + end * 0.92, 0.036, 2);
                        beam(x * 0.9, knee, centre + end * 0.92, x * 0.72, top, centre + end * 0.17, 0.03, 2);
                        detail(true);
                        // Knuckles at the knee and bearings at the foot, and a braided shunt across the foot.
                        add(new T.CylinderGeometry(0.034, 0.034, 0.075, 10).rotateZ(Math.PI / 2).translate(x * 0.9, knee, centre + end * 0.92), 6);
                        add(new T.CylinderGeometry(0.046, 0.046, 0.11, 10).rotateZ(Math.PI / 2).translate(x, base + 0.005, centre - end * 0.14), 10);
                        const shunt = new T.CatmullRomCurve3([[x, base + 0.02, centre - end * 0.2], [x + 0.06 * Math.sign(x), base - 0.06, centre - end * 0.3],
                            [x, base - 0.02, centre - end * 0.42]].map(([px, py, pz]) => new T.Vector3(px, py, pz)));
                        add(new T.TubeGeometry(shunt, 6, 0.012, 5, false), 7);
                        detail(false);
                        // Braced across from one side's foot to the other side's knee.
                        beam(x, base + 0.04, centre - end * 0.14, -x * 0.9, knee - 0.04, centre + end * 0.92, 0.018, 2);
                    }
                    // The springs that raise it, along the base.
                    add(new T.CylinderGeometry(0.03, 0.03, 0.62, 8).rotateX(Math.PI / 2).translate(side * 0.2, base + 0.01, centre), 4);
                }
                for (const end of [-1, 1]) {
                    boxAt(0.9, 0.04, 0.04, 0, base, centre + end * 0.62, 2);
                    boxAt(0.8, 0.036, 0.036, 0, knee, centre + end * 0.92, 2);
                    // Collector: a channel holding the carbon strip, horns curling down at either end,
                    // carried on two small springs over the head frame.
                    const z = centre + end * 0.17;
                    boxAt(1.12, 0.032, 0.07, 0, top, z, 4);
                    boxAt(1.0, 0.022, 0.042, 0, top + 0.026, z, 7);
                    for (const side of [-1, 1]) {
                        const horn = new T.CatmullRomCurve3([[0.55, 0], [0.66, -0.004], [0.74, -0.04], [0.79, -0.11], [0.8, -0.2]]
                            .map(([x, y]) => new T.Vector3(side * x, top + y, z)));
                        add(new T.TubeGeometry(horn, 10, 0.016, 6, false), 4);
                        detail(true);
                        for (let turn = 0; turn < 4; turn++) {
                            add(new T.CylinderGeometry(0.022, 0.022, 0.012, 8).translate(side * 0.3, top - 0.075 + turn * 0.018, z), 6);
                        }
                        add(new T.CylinderGeometry(0.012, 0.012, 0.08, 6).translate(side * 0.3, top - 0.05, z), 6);
                        detail(false);
                    }
                }
                for (const side of [-1, 1]) boxAt(0.03, 0.03, 0.34, side * 0.3, top - 0.03, centre, 2);
                boxAt(0.84, 0.03, 0.03, 0, base, centre - 0.14, 2);
                boxAt(0.84, 0.03, 0.03, 0, base, centre + 0.14, 2);
                // The lead from the frame down to the roof.
                beam(0.42, base, centre - 0.7, 0.36, roofAt(0.36) + 0.3, -5.0 + 0.19, 0.02, 2);
            }
            return finish();
        })();
        carGeometry.setAttribute('finish', new T.Float32BufferAttribute(carGeometry.userData.groups, 1));
        // Which car carries an outer cab: 1 the leading car, 2 the last, as an attribute per
        // car rather than from the instance index.
        carGeometry.setAttribute('carLead', new T.InstancedBufferAttribute(new Float32Array([1, 0, 0, 2]), 1));
        const carHorizon = { value: new T.Color('#9daebc') }, carWater = { value: new T.Color('#285a5e') };
        // Enamel under a clear lacquer: the physical model gives the coat its own sharp
        // reflection of the sky over the satin paint beneath.
        const carMaterial = material(new T.MeshPhysicalMaterial({ vertexColors: true, metalness: 0, roughness: 0.5,
            clearcoat: 1, clearcoatRoughness: 0.12 }));
        carMaterial.onBeforeCompile = shader => {
            Object.assign(shader.uniforms, { carHorizon, carWater, wetness, cabReal, tailReal, paperDay: cabinDaylight });
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nattribute float finish,carLead;varying vec3 vCarPaint;varying float vFinish,vCarLead;')
                .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarPaint=position;vFinish=finish;vCarLead=carLead;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>
                    uniform vec3 carHorizon,carWater;
                    uniform float wetness;
                    uniform float cabReal,tailReal,paperDay;
                    varying vec3 vCarPaint;
                    varying float vFinish,vCarLead;
                    // The windscreen openings in the face, by their middle and half size across and up.
                    float cabOpening(vec2 p){
                        float open=0.0;
                        ${CAB_WINDOWS.map(([l, r]) => `{vec2 q=abs(p-vec2(${((l + r) / 2).toFixed(3)},${CAB_WINDOW_Y.toFixed(3)}))-vec2(${((r - l) / 2 - 0.02).toFixed(3)},${(CAB_WINDOW_HEIGHT / 2 - 0.02).toFixed(3)})+0.05;
                        open=max(open,step(length(max(q,0.0))+min(max(q.x,q.y),0.0),0.05));}`).join('\n                        ')}
                        return open;
                    }
                    float carGrain(vec2 uv){
                        vec2 cell=floor(uv),f=fract(uv);
                        f=f*f*(3.0-2.0*f);
                        vec4 t=fract(sin(vec4(dot(cell,vec2(37.2,57.6)))+vec4(0.0,37.2,57.6,94.8))*3719.76);
                        return mix(mix(t.x,t.y,f.x),mix(t.z,t.w,f.x),f.y)-0.5;
                    }`)
                .replace('#include <color_fragment>', `#include <color_fragment>
                    // With the real cab drawn behind it, the leading face is open where the windscreens are.
                    if((vCarLead>1.5?tailReal:vCarLead>0.5?cabReal:0.0)>0.5&&vFinish<0.5&&vCarPaint.z<${(TIP + 0.62).toFixed(3)}&&cabOpening(vCarPaint.xy)>0.5)discard;
                    // Finishes: 0-1 enamel, 2 running gear, 3 roofing, 4 and 6 bright metal, 5 tread,
                    // 7 rubber, 8 grille, 9 lamp lens, 10 grey equipment paint.
                    float g=floor(vFinish+0.5);
                    float enamel=step(g,1.5);
                    float roofing=1.0-step(0.5,abs(g-3.0));
                    float trim=(1.0-step(0.5,abs(g-4.0)))+(1.0-step(0.5,abs(g-6.0)));
                    float tread=1.0-step(0.5,abs(g-5.0));
                    float rubber=1.0-step(0.5,abs(g-7.0));
                    float grille=1.0-step(0.5,abs(g-8.0));
                    float equipment=1.0-step(0.5,abs(g-10.0));
                    float sill=1.0-smoothstep(${CAR.sill.toFixed(3)},${CAR.waist.toFixed(3)},vCarPaint.y);
                    float run=sin(vCarPaint.z*8.1+sin(vCarPaint.z*2.7)*1.6);
                    float weather=run*sin(vCarPaint.y*5.6+vCarPaint.z*1.7);
                    float sillShadow=sill*(0.23+0.035*weather);
                    float eave=exp(-abs(vCarPaint.y-${CAR.cant.toFixed(3)})*10.0)*0.12;
                    float along=vCarPaint.z+vCarPaint.x*0.69;
                    vec2 at=vec2(along,vCarPaint.y);
                    float panelGrain=carGrain(at*vec2(6.5,12.0));
                    float micro=carGrain(at*vec2(48.0,66.0));
                    micro*=1.0-smoothstep(0.22,1.0,length(fwidth(at*vec2(48.0,66.0))));
                    float rain=max(0.0,carGrain(at*vec2(33.0,2.2)))*(1.0-smoothstep(0.07,0.28,fwidth(along)));
                    float underSill=exp(-abs(vCarPaint.y-2.14)*4.8)*step(vCarPaint.y,2.14);
                    // Pressed-steel sides: lap seams at the window piers, a rivet row along
                    // each seam and along the band edges, every panel a shade off its neighbour.
                    float flank=smoothstep(${(CAR.half - 0.05).toFixed(3)},${(CAR.half - 0.012).toFixed(3)},abs(vCarPaint.x))
                        *step(vCarPaint.y,${CAR.cant.toFixed(3)})*step(${(CAR.sill + 0.08).toFixed(3)},vCarPaint.y);
                    float pierPhase=(vCarPaint.z-(${(WINDOWS[0] - WINDOW_PITCH / 2).toFixed(3)}))/${WINDOW_PITCH.toFixed(3)};
                    float pierBand=step(-0.05,pierPhase)*step(pierPhase,${((WINDOWS[WINDOWS.length - 2] - WINDOWS[0]) / WINDOW_PITCH + 1.05).toFixed(3)});
                    float seamD=abs(fract(pierPhase+0.5)-0.5)*${WINDOW_PITCH.toFixed(3)};
                    float seamW=fwidth(vCarPaint.z)+0.0015;
                    float seam=(1.0-smoothstep(0.0025,0.0025+seamW,seamD))*pierBand*flank;
                    float lap=(1.0-smoothstep(0.004,0.012+seamW,seamD))*(1.0-seam)*pierBand*flank;
                    float panelTone=fract(sin(floor(pierPhase+0.5)*12.9898+vCarPaint.x*0.3)*43758.5)-0.5;
                    vec2 rivetCell=vec2(vCarPaint.z/0.072,vCarPaint.y/0.072);
                    float rivetRows=exp(-pow((vCarPaint.y-${(CAR.waist - 0.035).toFixed(3)})/0.006,2.0))
                        +exp(-pow((vCarPaint.y-${(CAR.sill + 0.27).toFixed(3)})/0.006,2.0))
                        +exp(-pow((vCarPaint.y-${(CAR.bandTop + 0.03).toFixed(3)})/0.006,2.0));
                    float rivetCols=exp(-pow((seamD-0.022)/0.006,2.0))*pierBand*step(vCarPaint.y,${CAR.waist.toFixed(3)});
                    float rivetAlong=1.0-smoothstep(0.18,0.32,length(fract(vec2(rivetCell.x,0.5))-0.5));
                    float rivetUp=1.0-smoothstep(0.18,0.32,length(fract(vec2(0.5,rivetCell.y))-0.5));
                    float rivetFade=1.0-smoothstep(0.25,0.6,max(fwidth(rivetCell.x),fwidth(rivetCell.y)));
                    float rivet=clamp(rivetRows*rivetAlong+rivetCols*rivetUp,0.0,1.0)*flank*rivetFade;
                    float rivetLit=rivet*(fract(rivetCell.y)-0.5+fract(rivetCell.x)*0.0);
                    // Road dirt thrown up from the wheels, darkest at the solebar and in the
                    // corners of the doorways, and the paler dust that dries on top of it.
                    float grime=pow(1.0-smoothstep(${CAR.sill.toFixed(3)},${(CAR.sill + 0.75).toFixed(3)},vCarPaint.y),1.6)
                        *(0.55+0.45*carGrain(at*vec2(3.0,9.0))+0.25*run);
                    // The cream is kept clean: only the faintest panel shading, no road dirt.
                    float cream=1.0-step(0.5,g);
                    float soil=1.0-0.7*cream;
                    diffuseColor.rgb*=1.0-enamel*(sillShadow+eave*soil-panelGrain*0.03-micro*0.025+rain*(0.13*underSill+0.08*sill)*soil
                        +seam*0.2-lap*0.05+panelTone*0.03*soil+grime*0.06-rivetLit*0.5);
                    diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(0.95,0.93,0.89),enamel*grime*0.3*soil);
                    // Roofing: dull, laid in sheets across the car, dust and soot gathering towards the middle.
                    float sheetJoin=abs(fract(vCarPaint.z/0.64)-0.5)*0.64;
                    float join=(1.0-smoothstep(0.006,0.006+fwidth(vCarPaint.z)*1.5,sheetJoin))*roofing;
                    float dust=carGrain(vCarPaint.xz*vec2(2.2,0.9))*0.5+carGrain(vCarPaint.xz*vec2(9.0,4.0))*0.25;
                    float soot=exp(-pow((vCarPaint.z+3.4)/1.6,2.0))*exp(-vCarPaint.x*vCarPaint.x*2.0);
                    diffuseColor.rgb*=1.0-roofing*(0.10*soot-0.16*dust)+join*0.22;
                    diffuseColor.rgb*=1.0+roofing*0.10*(1.0-exp(-pow((abs(vCarPaint.x)-1.0)/0.12,2.0))-1.0);
                    // Grilles: rows of narrow slots.
                    float slotsU=vCarPaint.z*26.0;
                    float slot=smoothstep(0.18,0.32,abs(fract(slotsU)-0.5));
                    slot=mix(slot,0.55,smoothstep(0.3,0.9,fwidth(slotsU)));
                    diffuseColor.rgb*=1.0-grille*(0.78-0.62*slot);
                    // Equipment paint picks up the same dirt as the roof.
                    float runs=max(0.0,carGrain(vec2(vCarPaint.z*18.0+vCarPaint.x*18.0,vCarPaint.y*1.5)))*(1.0-smoothstep(0.2,0.8,fwidth(vCarPaint.z*18.0)));
                    diffuseColor.rgb*=1.0-equipment*(0.04+0.12*dust+0.18*runs);
                    diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(1.08,1.02,0.9),equipment*max(0.0,dust)*0.8);
                    vec2 stamp=vec2(vCarPaint.x*58.0,vCarPaint.z*43.0);
                    stamp.x+=mod(floor(stamp.y),2.0)*0.5;
                    vec2 raised=(fract(stamp)-0.5)*vec2(1.55,0.66);
                    float bump=(1.0-smoothstep(0.15,0.30,abs(raised.x)+abs(raised.y)))
                        *(1.0-smoothstep(0.25,1.0,max(fwidth(stamp.x),fwidth(stamp.y))));
                    diffuseColor.rgb*=1.0-tread*(0.23-0.44*bump);
                    // Bright metal is brushed: fine streaks one way, a few duller scuffs across.
                    vec2 brushAt=vec2((vCarPaint.z+vCarPaint.x)*2.5,vCarPaint.y*240.0);
                    float brush=carGrain(brushAt)*(1.0-smoothstep(0.3,1.0,fwidth(brushAt.y)));
                    float scuff=max(0.0,carGrain(vCarPaint.zy*vec2(14.0,9.0)))*trim;
                    diffuseColor.rgb*=1.0+trim*(brush*0.22-scuff*0.18);
                    // Chipped paint where hands, boots and brooms meet the body: along the
                    // doorway edges, the foot of the doors and the sill lip, the grey-brown
                    // primer showing through.
                    float doorD=min(min(abs(abs(vCarPaint.z-(${DOORS[0].toFixed(3)}))-${DOOR_HALF.toFixed(3)}),
                        abs(abs(vCarPaint.z-(${DOORS[1].toFixed(3)}))-${DOOR_HALF.toFixed(3)})),
                        abs(abs(vCarPaint.z-(${CREW_DOOR.toFixed(3)}))-${CREW_DOOR_HALF.toFixed(3)}));
                    float wearZone=max((1.0-smoothstep(0.02,0.09,doorD))*(1.0-smoothstep(1.5,2.6,vCarPaint.y)),
                        1.0-smoothstep(0.0,0.07,vCarPaint.y-${(CAR.sill + 0.02).toFixed(3)}));
                    float chipNoise=carGrain(vec2(vCarPaint.z*70.0,vCarPaint.y*55.0))+carGrain(vec2(vCarPaint.z*19.0,vCarPaint.y*15.0))*0.8;
                    float chip=smoothstep(0.18,0.26,chipNoise-0.55*(1.0-wearZone))*wearZone*(enamel*(1.0-0.75*cream)+equipment)
                        *(1.0-smoothstep(0.3,1.0,fwidth(vCarPaint.z*70.0)));
                    vec3 primer=mix(diffuseColor.rgb,vec3(dot(diffuseColor.rgb,vec3(0.33))),0.75)*vec3(0.86,0.78,0.7);
                    diffuseColor.rgb=mix(diffuseColor.rgb,primer,chip*0.8);
                    // Wet: the paint darkens, and water runs in threads down from the window
                    // sills and the eaves, gathering in beads on the flanks.
                    float rivulet=smoothstep(0.28,0.42,carGrain(vec2(along*36.0,vCarPaint.y*1.4)))
                        *(1.0-smoothstep(0.4,1.0,fwidth(along*36.0)));
                    vec2 beadCell=vec2(along*34.0,vCarPaint.y*30.0);
                    vec2 beadAt=fract(beadCell)-0.5+vec2(carGrain(floor(beadCell)*1.7),carGrain(floor(beadCell)*2.3))*0.5;
                    float bead=(1.0-smoothstep(0.08,0.16,length(beadAt)))*step(0.3,carGrain(floor(beadCell)*0.9+3.1))*smoothstep(0.1,0.5,carGrain(at*vec2(2.0,3.0))+0.3)
                        *(1.0-smoothstep(0.3,0.8,fwidth(beadCell.x)));
                    float wetPaint=wetness*(enamel+roofing+equipment);
                    diffuseColor.rgb*=1.0-wetPaint*(0.22+0.1*rivulet)*(1.0-0.45*cream);
                    diffuseColor.rgb*=1.0-wetness*trim*0.12;`)
                .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
                    // Satin enamel, a little rougher where the road dirt has settled; dull roofing and rubber.
                    float paintRough=0.50+panelGrain*0.10+micro*0.05+grime*0.16+seam*0.2;
                    roughnessFactor=0.68;
                    roughnessFactor=mix(roughnessFactor,paintRough,enamel);
                    roughnessFactor=mix(roughnessFactor,0.28+brush*0.10+scuff*0.25+micro*0.04,trim);
                    roughnessFactor=mix(roughnessFactor,0.86+dust*0.08,roofing);
                    roughnessFactor=mix(roughnessFactor,0.8,rubber+grille);
                    roughnessFactor=mix(roughnessFactor,0.42+dust*0.22+panelGrain*0.1,equipment);
                    roughnessFactor=mix(roughnessFactor,0.67-0.18*bump,tread);
                    // Chips are dull primer; wet surfaces turn glassy, beads and threads most of all.
                    roughnessFactor=mix(roughnessFactor,0.75,chip);
                    roughnessFactor=mix(roughnessFactor,mix(0.2,0.06,max(rivulet,bead)),wetPaint*0.85);
                    roughnessFactor=mix(roughnessFactor,roughnessFactor*0.6,wetness*trim);`)
                .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
                    metalnessFactor=mix(metalnessFactor,0.62,trim);
                    metalnessFactor=mix(metalnessFactor,0.0,rubber+grille+roofing);
                    metalnessFactor=mix(metalnessFactor,0.45-dust*0.2,equipment);
                    metalnessFactor=mix(metalnessFactor,0.0,chip);`)
                .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
                    // Only the lacquered enamel keeps a clear coat, dulled by the road dirt; rain glazes the rest.
                    material.clearcoat=clamp(enamel*(1.0-grime*0.7)*(1.0-chip)*(1.0-seam)*(0.5-0.15*cream)+wetness*(roofing+equipment)*0.8+wetPaint*0.25,0.0,1.0);
                    // On the light page the paint keeps the colour it was given: the lacquer
                    // would only lift it towards the white paper sky.
                    material.clearcoat*=1.0-0.7*paperDay;
                    material.clearcoatRoughness=clamp(mix(0.14+micro*0.05,0.05,wetness),0.0,1.0);`)
                .replace('#include <opaque_fragment>', `
                    // A wide cool highlight from the coast and a softer return from the water below.
                    vec3 eye=normalize(vViewPosition);
                    vec3 reflected=inverseTransformDirection(reflect(-eye,normal),viewMatrix);
                    float facing=clamp(dot(eye,normal),0.0,1.0);
                    float gloss=pow(1.0-facing,2.0);
                    // Each pressed panel bows a touch between its seams, so the coast
                    // breaks into a slightly different line on every one.
                    float bow=sin(fract(pierPhase+0.5)*6.2832)*0.03*pierBand*flank+panelTone*0.03*flank;
                    float slope=reflected.y+(vCarPaint.y-2.36)*0.17+panelGrain*0.044+micro*0.018+bow;
                    float line=(slope-0.21)*4.1;
                    float skyStrip=exp(-line*line);
                    float seaStrip=exp(-abs(slope+0.22)*4.6);
                    // On the cream the coast reads as a neutral sheen, not a warm stain.
                    vec3 coastTint=mix(carHorizon,vec3(dot(carHorizon,vec3(0.3,0.5,0.2))),0.6*cream);
                    vec3 reflectedCoast=coastTint*skyStrip*(0.036+0.070*gloss)
                        +carWater*seaStrip*(0.022+0.085*gloss);
                    float sheen=enamel*(1.0-grime*0.6)*(1.0-seam)+trim*(1.5-scuff)+equipment*(0.7-dust*0.4);
                    // Rain glazes the paint: the coast reflection sharpens and brightens, every
                    // thread of water and bead catches a point of sky.
                    sheen*=1.0+wetPaint*1.6;
                    outgoingLight+=carHorizon*wetPaint*(skyStrip*0.10+gloss*0.08+bead*(0.12+0.3*gloss)+rivulet*0.07*(0.4+skyStrip));
                    // Metal edges catch the sky as a crisp rim.
                    outgoingLight+=trim*carHorizon*(pow(1.0-facing,4.0)*0.22+skyStrip*0.06)*(1.0-scuff);
                    outgoingLight+=reflectedCoast*sheen*(1.0-0.65*paperDay)+(1.0-enamel-trim)*(1.0-roofing-rubber-grille)*carHorizon*gloss*0.022;
                    #include <opaque_fragment>`);
        };
        const cars = instances(carMaterial, CARS, carGeometry);
        cars.name = 'trainCars';
        // What a set has once: the bellows and shared bogie at its joint.
        const kitGeometry = (() => {
            const { boxAt, beam, bogie, finish } = fuser();
            boxAt(1.86, 2.0, CAR.joint + 0.06, 0, 2.33, 0);
            for (const fold of [-0.16, 0, 0.16]) boxAt(1.96, 2.1, 0.035, 0, 2.33, fold);
            bogie(0);
            return finish();
        })();
        const kits = instances(timber, CARS / 2, kitGeometry);
        kits.name = 'trainKit';
        // Too dark to show in the water; layer 1 is drawn for the viewer only.
        kits.layers.set(1);
        // A window is one quad just proud of the shell. What shows in it is
        // worked out per pixel by following the line of sight into the saloon.
        const glassGeometry = (() => {
            const positions = [], uvs = [], panes = [], indices = [];
            const pane = (side, z, y, w, h, seed, kind, skin = CAR.half + 0.012) => {
                const base = positions.length / 3, x = side * skin;
                // Wound so the pane faces outwards on either side.
                const z0 = z + side * w / 2, z1 = z - side * w / 2;
                positions.push(x, y - h / 2, z0, x, y - h / 2, z1, x, y + h / 2, z1, x, y + h / 2, z0);
                uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
                for (let i = 0; i < 4; i++) panes.push(seed, w, h, kind);
                indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            };
            for (const side of [-1, 1]) {
                WINDOWS.forEach((z, i) => pane(side, z, ...SIDE_PANES, i * 7 + (side > 0 ? 3 : 61), 0));
                // Door lights sit back in their leaves.
                DOORS.forEach((z, i) => pane(side, z, ...DOOR_PANES, 131 + i * 9 + side, 1, CAR.half - 0.036));
                pane(side, CREW_DOOR, ...CAB_PANE, 211 + side, 2, CAR.half - 0.036);
            }
            const shape = new T.BufferGeometry();
            shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            shape.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
            shape.setAttribute('pane', new T.Float32BufferAttribute(panes, 4));
            shape.setIndex(indices);
            return geometry(shape);
        })();
        const glassMaterial = material(new T.ShaderMaterial({
            uniforms: { warm: { value: new T.Color('#ffd28c') }, seat: { value: new T.Color('#1d4a40') },
                night: { value: new T.Color('#05080f') }, shadowInk: { value: new T.Color('#24212a') },
                day: cabinDaylight, power: { value: 1.3 }, empty: cabinMood.empty },
            vertexShader: `attribute vec4 pane;varying vec2 vUv;varying vec4 vPane;varying vec3 vPos,vEye;varying float car;
                void main(){vUv=uv;vPane=pane;vPos=position;
                    #ifdef USE_INSTANCING
                    mat4 m=modelMatrix*instanceMatrix;car=float(gl_InstanceID);
                    #else
                    mat4 m=modelMatrix;car=0.0;
                    #endif
                    vEye=(inverse(m)*vec4(cameraPosition,1.0)).xyz;
                    gl_Position=projectionMatrix*viewMatrix*m*vec4(position,1.0);
                }`,
            fragmentShader: `uniform vec3 warm,seat,night,shadowInk;uniform float power,day,empty;
                varying vec2 vUv;varying vec4 vPane;varying vec3 vPos,vEye;varying float car;
                ${cabinLightFunctions}
                const float WIDE=1.24,FLOOR=${CAR.floor.toFixed(2)},CEIL=3.34,END=${(CAR.length / 2 - 0.12).toFixed(2)};
                float h(float n){return fract(sin(mod(n,289.0)*12.9898)*43758.5453);}
                float figure(vec2 p,float bend){
                    float head=length((p-vec2(bend*0.11,0.155-abs(bend)*0.06))*vec2(1.0,0.82))-0.104;
                    float neck=length(max(abs(p-vec2(bend*0.048,0.027))-vec2(0.034,0.036),0.0))-0.026;
                    float shoulders=length(max(abs(p+vec2(0.0,0.20))-vec2(0.12,0.17),0.0))-0.066;
                    return min(min(head,neck),shoulders);
                }
                // Whoever is in a row of places along the car, as coverage.
                float row(vec3 p,float pitch,float neck,float share,float salt){
                    float place=floor(p.z/pitch);
                    float who=place*1.7+floor(car+0.5)*37.0+salt;
                    float taken=step(1.0-share,h(who));
                    vec2 q=vec2((fract(p.z/pitch)-0.5)*pitch+(h(who+0.3)-0.5)*0.1,p.y-neck-(h(who+0.7)-0.5)*0.12);
                    return taken*(1.0-empty)*(1.0-smoothstep(-0.012,0.016,figure(q,h(who+4.7)*2.0-1.0)));
                }
                void main(){
                    float side=sign(vPos.x);
                    vec3 rd=normalize(vPos-vEye);
                    float inward=max(-rd.x*side,0.03);
                    rd.x=-side*inward;
                    // Follow the sight line to the far wall, the ceiling, the floor or a bulkhead.
                    float tWall=(abs(vPos.x)+WIDE)/inward;
                    float tLid=rd.y>0.0?(CEIL-vPos.y)/rd.y:1e4;
                    float tFloor=rd.y<0.0?(FLOOR-vPos.y)/rd.y:1e4;
                    float tEnd=abs(rd.z)>1e-4?(sign(rd.z)*END-vPos.z)/rd.z:1e4;
                    float t=min(min(tWall,tEnd),min(tLid,tFloor));
                    vec3 p=vPos+rd*t;
                    vec3 c;
                    if(t==tWall){
                        // Far side: cream panelling, its windows black with night, seat backs under them.
                        float w=abs(fract((p.z+${(-WINDOWS[0]).toFixed(2)})/${WINDOW_PITCH.toFixed(2)}+0.5)-0.5)*${WINDOW_PITCH.toFixed(2)};
                        float hole=smoothstep(0.5,0.47,w)*smoothstep(2.2,2.23,p.y)*smoothstep(3.06,3.03,p.y);
                        vec3 wash=lampColour(warm,day);
                        c=mix(wash*(0.30+0.34*smoothstep(2.0,3.25,p.y)),night,hole*0.94);
                        c=mix(c,warm*0.3,smoothstep(0.03,0.015,abs(p.y-2.14)));
                        c=mix(c,seat*(0.7+0.3*smoothstep(1.5,2.0,p.y)),step(p.y,2.02));
                    }else if(t==tEnd){
                        // Bulkhead with the doorway through to the next car.
                        c=mix(warm*0.5,warm*0.85,step(abs(p.x),0.42)*step(p.y,3.05));
                    }else if(t==tLid){
                        // Ceiling: two fluorescent runs above the benches.
                        c=lampColour(warm,day)*(0.27+1.36*tubes(p.xz,0.092));
                    }else{
                        c=warm*0.14*(0.8+0.2*step(0.5,fract(p.z*1.6)));
                    }
                    c*=mix(1.0,0.7,clamp(t/9.0,0.0,1.0));
                    // People, far to near: facing us on the far bench, standing in the aisle, backs to this window.
                    float tFar=(abs(vPos.x)+0.92)/inward,tMid=abs(vPos.x)/inward,tNear=(abs(vPos.x)-0.98)/inward;
                    vec3 q=vPos+rd*tFar;
                    float open=smoothstep(0.1,0.32,inward);
                    float opposite=step(tFar,t)*open*row(q,0.56,2.32,0.42,side*5.0+1.0);
                    c=mix(c,shadowInk*1.6+warm*0.018,opposite);
                    q=vPos+rd*tMid;
                    float aisle=step(tMid,t)*open*row(q,1.15,2.8,0.16,3.0);
                    c=mix(c,shadowInk*1.18,aisle);
                    q=vPos+rd*tNear;
                    float beside=step(tNear,t)*row(q,0.56,2.34,0.38,side*9.0+2.0);
                    c=mix(c,shadowInk,beside);
                    // Hand straps swing in a row above the near bench.
                    q=vPos+rd*((abs(vPos.x)-0.72)/inward);
                    vec2 strap=vec2((fract(q.z/0.42)-0.5)*0.42,q.y-2.98);
                    c=mix(c,warm*0.25,smoothstep(0.012,0.0,abs(length(strap)-0.055))*step(abs(q.z),END));
                    if(vPane.w>1.5)c*=0.3;
                    // The sky rolls across the glass at a glancing view. The lower pane stays warmer.
                    float grazing=pow(1.0-inward,4.0);
                    vec3 reflectedSky=night*2.5+seat*(0.10+0.56*smoothstep(0.34,0.98,vUv.y));
                    c=mix(c,reflectedSky,grazing*0.56);
                    c+=seat*smoothstep(0.52,0.88,vUv.y)*grazing*0.11;
                    vec2 size=vPane.yz,g=(vUv-0.5)*size;
                    if(vPane.w<0.5)c=mix(c,warm*0.2,smoothstep(0.02,0.011,abs(g.y-size.y*0.14)));
                    float edge=length(max(abs(g)-size*0.5+0.085,0.0))-0.085;
                    c=mix(c,vec3(0.012),smoothstep(-0.034,-0.02,edge));
                    gl_FragColor=vec4(c*power,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const glass = instances(glassMaterial, CARS, glassGeometry);
        glass.name = 'trainWindows';
        // One graphic atlas for the destination board and the painted fleet number.
        const destinationGraphic = (() => {
            const canvas = global.document.createElement('canvas');
            canvas.width = 384; canvas.height = 192;
            const g = canvas.getContext('2d');
            if (!g) return null;
            g.fillStyle = '#182c3a';
            g.fillRect(0, 0, 384, 96);
            g.strokeStyle = '#b6aa88'; g.lineWidth = 5;
            g.strokeRect(4, 4, 376, 88);
            g.fillStyle = '#fff1cd';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.font = 'bold 47px "Yu Gothic", "Meiryo", sans-serif';
            g.fillText('潮見・岬町', 192, 37);
            g.font = 'bold 17px sans-serif';
            g.fillText('S H I O M I   /   M I S A K I', 192, 74);
            g.font = 'bold 86px sans-serif';
            g.fillText('307', 192, 148);
            const map = new T.CanvasTexture(canvas);
            map.colorSpace = T.SRGBColorSpace;
            scans.push(map);
            return map;
        })();
        // The panes follow the same convex profile as their metal frames.
        // The two light pairs share the end mesh with the painted signage.
        const endGeometry = (() => {
            const positions = [], uvs = [], kinds = [], indices = [];
            // From the corner with the larger x to the other, rising h about y.
            const quad = (ax, az, bx, bz, y, h, kind, u0 = 0, u1 = 1) => {
                const base = positions.length / 3;
                positions.push(ax, y - h / 2, az, bx, y - h / 2, bz, bx, y + h / 2, bz, ax, y + h / 2, az);
                uvs.push(u0, 0, u1, 0, u1, 1, u0, 1);
                for (let i = 0; i < 4; i++) kinds.push(kind);
                indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            };
            const onFace = (middle, width, y, h, lip, kind) => {
                const a = middle + width / 2, b = middle - width / 2;
                const slope = (fascia(middle + 0.055) - fascia(middle - 0.055)) / 0.11;
                const z = fascia(middle, lip);
                quad(a, z + (a - middle) * slope, b, z + (b - middle) * slope, y, h, kind);
            };
            CAB_WINDOWS.forEach(([left, right], index) => {
                const cuts = [right, ...NOSE.flatMap(([, width]) => [-width, width])
                    .filter(x => x > left && x < right).sort((a, b) => b - a), left];
                for (let i = 0; i < cuts.length - 1; i++) {
                    const a = cuts[i], b = cuts[i + 1];
                    quad(a, fascia(a, 0.027), b, fascia(b, 0.027), CAB_WINDOW_Y, CAB_WINDOW_HEIGHT,
                        index === 1 ? 0 : 6, (right - a) / (right - left), (right - b) / (right - left));
                }
            });
            onFace(0, 0.670, CAB_SIGN_Y, 0.157, 0.085, 1);
            onFace(0, 0.49, 1.70, 0.147, 0.015, 7);
            for (const side of [-1, 1]) {
                const x = side * CAB_LAMP_X;
                onFace(x, 0.173, CAB_LAMP_Y, 0.179, 0.124, 2);
                onFace(x, 0.50, CAB_TAIL_Y, 0.43, 0.085, 3);
                onFace(x, 0.125, CAB_TAIL_Y, 0.072, 0.082, 4);
                onFace(x, 0.91, CAB_LAMP_Y, 0.92, 0.142, 5);
            }
            const shape = new T.BufferGeometry();
            shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            shape.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
            shape.setAttribute('kind', new T.Float32BufferAttribute(kinds, 1));
            shape.setIndex(indices);
            return geometry(shape);
        })();
        // Instance 0 is the leading end, instance 1 the trailing one.
        const endMaterial = material(new T.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: { warm: { value: new T.Color('#ffd28c') }, head: { value: new T.Color('#fff3d6') }, cold: carHorizon,
                red: { value: new T.Color('#ff3b2f') }, day: cabinDaylight, destination: { value: destinationGraphic },
                rain: cabinMood.rain, clock: cabinMood.clock, cabReal, tailReal },
            vertexShader: `attribute float kind;varying vec2 vUv;varying float vKind,vTail;varying vec3 vPos,vEye;
                void main(){vUv=uv;vKind=kind;vTail=float(gl_InstanceID);
                    vPos=position;vEye=(inverse(modelMatrix*instanceMatrix)*vec4(cameraPosition,1.0)).xyz;
                    gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
            fragmentShader: `uniform vec3 warm,head,red,cold;uniform float day,rain,clock,cabReal,tailReal;uniform sampler2D destination;
                ${RAIN_GLASS}
                varying vec2 vUv;varying float vKind,vTail;varying vec3 vPos,vEye;
                // The cab behind the windscreen, traced through its few solid shapes: the
                // driver's desk with its cowl and gauges, controller and brake handle, the
                // seat and the driver on it (the leading end only), the cabinet opposite,
                // and the bulkhead whose glazed door shows the lit saloon.
                const float FRONT=${(TIP + 0.26).toFixed(3)},CF=${CAR.floor.toFixed(3)},BACK=${(TIP + 1.35).toFixed(3)};
                float hitBox(vec3 o,vec3 d,vec3 lo,vec3 hi,inout float best,inout vec3 n){
                    vec3 inv=1.0/d,t0=(lo-o)*inv,t1=(hi-o)*inv,tn=min(t0,t1),tf=max(t0,t1);
                    float near=max(max(tn.x,tn.y),tn.z),far=min(min(tf.x,tf.y),tf.z);
                    if(near<far&&near>0.0&&near<best){
                        best=near;
                        n=near==tn.x?vec3(-sign(d.x),0,0):near==tn.y?vec3(0,-sign(d.y),0):vec3(0,0,-sign(d.z));
                        return 1.0;
                    }
                    return 0.0;
                }
                float hitBall(vec3 o,vec3 d,vec3 c,float r,inout float best,inout vec3 n){
                    vec3 oc=o-c;float b=dot(oc,d),q=dot(oc,oc)-r*r,h=b*b-q;
                    if(h<0.0)return 0.0;
                    float t=-b-sqrt(h);
                    if(t>0.0&&t<best){best=t;n=normalize(oc+d*t);return 1.0;}
                    return 0.0;
                }
                vec3 cab(vec3 cabin,vec3 ray,float tail){
                    vec3 o=vPos,d=ray;
                    d.x=abs(d.x)<0.0001?0.0001:d.x;d.y=abs(d.y)<0.0001?0.0001:d.y;
                    // The room: walls, floor, ceiling and the bulkhead.
                    float dz=max(d.z,0.045);
                    float back=(BACK-o.z)/dz,wall=(1.23-o.x*sign(d.x))/abs(d.x);
                    float ceiling=d.y>0.0?(3.317-o.y)/d.y:100.0,floorHit=d.y<0.0?(o.y-CF)/(-d.y):100.0;
                    float best=min(min(back,wall),min(ceiling,floorHit));
                    vec3 n=best==back?vec3(0,0,-1):best==wall?vec3(-sign(d.x),0,0):best==ceiling?vec3(0,-1,0):vec3(0,1,0);
                    float what=0.0;
                    // 1 desk, 2 cowl, 3 handles, 4 seat, 5 driver, 6 cabinet.
                    if(hitBox(o,d,vec3(-1.22,CF,FRONT-0.05),vec3(-0.36,2.02,FRONT+0.44),best,n)>0.0)what=1.0;
                    if(hitBox(o,d,vec3(-1.12,2.02,FRONT-0.05),vec3(-0.5,2.2,FRONT+0.16),best,n)>0.0)what=2.0;
                    if(hitBox(o,d,vec3(-1.12,2.02,FRONT+0.26),vec3(-1.04,2.2,FRONT+0.34),best,n)>0.0)what=3.0;
                    if(hitBox(o,d,vec3(-0.56,2.02,FRONT+0.26),vec3(-0.48,2.14,FRONT+0.34),best,n)>0.0)what=3.0;
                    if(hitBox(o,d,vec3(-1.0,CF+0.36,FRONT+0.62),vec3(-0.6,CF+0.5,FRONT+1.02),best,n)>0.0)what=4.0;
                    if(hitBox(o,d,vec3(-1.0,CF+0.5,FRONT+0.98),vec3(-0.6,CF+1.12,FRONT+1.08),best,n)>0.0)what=4.0;
                    if(tail<0.5){
                        if(hitBox(o,d,vec3(-0.98,CF+0.5,FRONT+0.7),vec3(-0.62,CF+1.16,FRONT+0.97),best,n)>0.0)what=5.0;
                        if(hitBall(o,d,vec3(-0.8,CF+1.31,FRONT+0.84),0.115,best,n)>0.0)what=5.0;
                        if(hitBox(o,d,vec3(-0.94,CF+1.38,FRONT+0.68),vec3(-0.66,CF+1.43,FRONT+0.98),best,n)>0.0)what=5.0;
                        if(hitBox(o,d,vec3(-0.98,CF+0.9,FRONT+0.4),vec3(-0.9,CF+1.02,FRONT+0.78),best,n)>0.0)what=5.0;
                    }
                    if(hitBox(o,d,vec3(0.42,CF,FRONT-0.05),vec3(1.22,CF+0.78,FRONT+0.5),best,n)>0.0)what=6.0;
                    // 7 chrome knobs on the handles, 8 the roller blind, 9 the radio set on the cabinet,
                    // 10 the extinguisher by the bulkhead, 11 a grab pole, 12 the ceiling fan.
                    if(hitBall(o,d,vec3(-1.08,2.23,FRONT+0.3),0.035,best,n)>0.0)what=7.0;
                    if(hitBall(o,d,vec3(-0.52,2.16,FRONT+0.3),0.03,best,n)>0.0)what=7.0;
                    if(hitBox(o,d,vec3(-1.22,3.12,FRONT-0.02),vec3(1.22,3.28,FRONT+0.07),best,n)>0.0)what=8.0;
                    if(hitBox(o,d,vec3(-1.18,2.88,FRONT-0.01),vec3(-0.42,3.12,FRONT+0.01),best,n)>0.0)what=8.0;
                    if(hitBox(o,d,vec3(0.55,CF+0.78,FRONT+0.05),vec3(0.98,CF+0.98,FRONT+0.34),best,n)>0.0)what=9.0;
                    if(hitBox(o,d,vec3(0.86,CF,BACK-0.2),vec3(1.0,CF+0.5,BACK-0.06),best,n)>0.0)what=10.0;
                    if(hitBox(o,d,vec3(0.36,CF,FRONT+0.6),vec3(0.4,3.317,FRONT+0.64),best,n)>0.0)what=11.0;
                    if(hitBox(o,d,vec3(0.12,3.25,FRONT+0.5),vec3(0.48,3.317,FRONT+0.86),best,n)>0.0)what=12.0;
                    vec3 hit=o+d*best;
                    // Painted grey-green fittings, a darker floor, a pale ceiling.
                    vec3 paint=mix(vec3(0.165,0.2,0.18),vec3(0.86,0.83,0.74),day*0.8);
                    vec3 wallTone=hit.y<2.05?paint*1.15:vec3(0.58,0.55,0.48)*mix(0.6,1.0,day);
                    vec3 albedo=what>0.5?paint:best==floorHit?paint*0.45:best==ceiling?vec3(0.7,0.68,0.62):wallTone;
                    float shine=0.35,metal=0.0;
                    if(what>1.5&&what<2.5)albedo*=0.55;
                    if(what>2.5&&what<3.5){albedo=vec3(0.05);shine=0.6;}
                    if(what>3.5&&what<4.5){albedo=vec3(0.12,0.2,0.14);shine=0.15;}
                    if(what>4.5&&what<5.5)albedo=vec3(0.035,0.04,0.05);
                    if(what>6.5&&what<7.5){albedo=vec3(0.75,0.74,0.7);metal=1.0;shine=1.0;}
                    if(what>7.5&&what<8.5){albedo=mix(vec3(0.09,0.14,0.11),vec3(0.6,0.62,0.55),day*0.7);shine=0.1;}
                    if(what>8.5&&what<9.5){albedo=vec3(0.06,0.065,0.07);shine=0.5;}
                    if(what>9.5&&what<10.5){albedo=vec3(0.55,0.06,0.04);shine=0.8;}
                    if(what>10.5&&what<11.5){albedo=vec3(0.7,0.7,0.68);metal=1.0;shine=1.0;}
                    if(what>11.5)albedo=vec3(0.7,0.7,0.66);
                    // Checker plate on the floor.
                    if(best==floorHit&&what<0.5){
                        vec2 q=hit.xz*vec2(28.0,20.0);q.x+=mod(floor(q.y),2.0)*0.5;
                        vec2 f=(fract(q)-0.5)*vec2(1.6,0.6);
                        albedo*=1.0+0.5*(1.0-smoothstep(0.12,0.24,abs(f.x)+abs(f.y)));
                        shine=0.5;
                    }
                    // Panel seams and a vent in the desk front, rivet-headed seams on the cabinet doors.
                    if((what>0.5&&what<1.5)||(what>5.5&&what<6.5)){
                        float seamZ=abs(fract((hit.x+hit.z)*3.2)-0.5);
                        albedo*=1.0-0.4*(1.0-smoothstep(0.015,0.03,seamZ))*step(0.5,abs(n.z));
                        float vent=step(0.5,abs(n.z))*step(abs(hit.y-(CF+0.25)),0.08)*step(0.5,fract(hit.x*30.0));
                        albedo*=1.0-0.55*vent;
                    }
                    // Ambient shading: darker into the corners and under the desk.
                    float occlusion=smoothstep(0.0,0.25,hit.y-CF)*0.6+0.4;
                    occlusion*=0.55+0.45*smoothstep(0.0,0.3,1.23-abs(hit.x));
                    occlusion*=1.0-0.35*step(hit.y,2.02)*step(hit.x,-0.36)*step(hit.z,FRONT+0.6)*step(0.5,abs(n.y))*step(what,0.5);
                    // One lamp over the desk, with a gloss highlight on paint and a sharp one on chrome.
                    vec3 lampAt=vec3(-0.3,3.25,FRONT+0.7);
                    vec3 lamp=lampAt-hit;
                    float fall=1.0/(1.0+dot(lamp,lamp)*0.9);
                    vec3 l=normalize(lamp);
                    float lit=0.1*occlusion+0.9*max(dot(n,l),0.0)*fall*2.4*occlusion;
                    vec3 halfway=normalize(l-d);
                    float spec=pow(max(dot(n,halfway),0.0),mix(18.0,90.0,metal))*shine*fall*2.4;
                    vec3 c=albedo*cabin*lit*(0.55+day*0.6)*mix(1.0,0.35,metal)+cabin*spec*mix(vec3(0.25),albedo,metal);
                    // Chrome also shows the windows behind the viewer.
                    c+=metal*cold*0.25*smoothstep(-0.2,0.6,reflect(d,n).z*-1.0);
                    if(best==back&&what<0.5){
                        float door=(1.0-smoothstep(0.32,0.36,abs(hit.x)))*smoothstep(1.62,1.68,hit.y)*(1.0-smoothstep(3.0,3.05,hit.y));
                        float pane=(1.0-smoothstep(0.24,0.27,abs(hit.x)))*smoothstep(2.2,2.24,hit.y)*(1.0-smoothstep(2.95,2.99,hit.y));
                        float notice=step(abs(hit.x+0.75),0.22)*step(abs(hit.y-2.55),0.17);
                        float handle=step(abs(hit.x-0.26),0.015)*step(abs(hit.y-2.0),0.08);
                        c=mix(c,c*0.7,door);
                        // Through the door glass: the saloon, its tubes, the dark band of the seats and standing people.
                        vec3 saloon=cabin*(0.28+day*0.3)*(0.8+0.4*smoothstep(2.2,2.95,hit.y));
                        saloon+=cabin*0.6*(1.0-smoothstep(0.004,0.012,abs(hit.y-2.9)));
                        saloon*=1.0-0.6*step(hit.y,2.42);
                        float person=(1.0-smoothstep(0.05,0.06,abs(hit.x-0.06)))*step(hit.y,2.78)+(1.0-smoothstep(0.045,0.055,length(vec2(hit.x-0.06,hit.y-2.82))));
                        saloon=mix(saloon,saloon*0.25,clamp(person,0.0,1.0));
                        c=mix(c,saloon,pane);
                        // A grab rail across the bulkhead and the line where cream meets the lower paint.
                        c*=1.0-0.45*(1.0-smoothstep(0.008,0.016,abs(hit.y-2.05)));
                        c+=cabin*0.25*(1.0-smoothstep(0.006,0.012,abs(hit.y-2.6)))*step(0.36,abs(hit.x));
                        c=mix(c,mix(vec3(0.75,0.72,0.62),vec3(0.3,0.42,0.5),step(0.5,fract(hit.y*24.0))*step(abs(hit.x+0.75),0.18))*cabin*0.55,notice);
                        c=mix(c,cabin*0.9,handle);
                    }
                    if(best==wall&&what<0.5){
                        float window=smoothstep(2.28,2.34,hit.y)*(1.0-smoothstep(2.91,3.01,hit.y));
                        c=mix(c,cold*0.12,window*0.79);
                        c*=1.0-0.5*(1.0-smoothstep(0.01,0.025,abs(hit.y-2.3)))-0.5*(1.0-smoothstep(0.01,0.025,abs(hit.y-2.98)));
                    }
                    if(best==ceiling&&what<0.5)c+=cabin*0.5*(1.0-smoothstep(0.03,0.09,abs(hit.x+0.32)))*step(hit.z,FRONT+1.0);
                    if(what>11.5)c*=0.6+0.4*step(0.5,fract(length(hit.xz-vec2(0.3,FRONT+0.68))*40.0));
                    // Gauges on the cowl's face: bezel, dial and a needle; a row of pilot lamps below.
                    if(what>1.5&&what<2.5){
                        for(int i=0;i<2;i++){
                            vec2 g=hit.xy-vec2(i==0?-0.95:-0.67,2.12);
                            float dist=length(g);
                            float dial=1.0-smoothstep(0.036,0.042,dist);
                            float bezel=(1.0-smoothstep(0.042,0.05,dist))*smoothstep(0.036,0.042,dist);
                            vec2 needle=vec2(cos(i==0?2.2:1.1),sin(i==0?2.2:1.1));
                            float needleD=length(g-needle*clamp(dot(g,needle),0.0,0.032));
                            c=mix(c,vec3(0.85,0.92,0.78)*0.6*(0.6+0.4*day),dial);
                            c=mix(c,vec3(0.02),dial*(1.0-smoothstep(0.002,0.004,needleD)));
                            c=mix(c,vec3(0.02),dial*(1.0-smoothstep(0.03,0.032,dist))*smoothstep(0.028,0.03,dist)*step(0.5,fract(atan(g.y,g.x)*6.0/3.1416)));
                            c+=cabin*bezel*0.5;
                        }
                    }
                    // The desk top: rows of switches and pilot lamps, some lit.
                    if(what>0.5&&what<1.5&&n.y>0.5){
                        vec2 q=vec2(hit.x*30.0,(hit.z-FRONT)*26.0);
                        vec2 id=floor(q),f=fract(q)-0.5;
                        float on=fract(sin(dot(id,vec2(41.3,17.9)))*921.7);
                        float key=(1.0-smoothstep(0.18,0.26,max(abs(f.x),abs(f.y))))*step(hit.z,FRONT+0.2)*step(-1.18,hit.x)*step(hit.x,-0.4);
                        vec3 lampTint=on>0.8?vec3(1.0,0.25,0.15):on>0.6?vec3(0.4,1.0,0.5):on>0.45?vec3(1.0,0.7,0.25):vec3(0.0);
                        c=mix(c,vec3(0.04)+lampTint*1.1,key);
                    }
                    // The driver is a silhouette with the saloon light on the shoulders.
                    if(what>4.5&&what<5.5)c=vec3(0.012,0.013,0.018)*(0.6+day*2.0)+cabin*(0.05*max(n.y,0.0)+0.03*max(n.x,0.0));
                    return c;
                }
                void main(){
                    float tail=step(0.5,vTail);
                    vec3 c;float a=1.0;
                    vec2 p=vUv*2.0-1.0;float r=dot(p,p);
                    if(vKind<0.5||(vKind>5.5&&vKind<6.5)){
                        float glassEdge=length(max(abs(p)-vec2(0.88),0.0))-0.12;
                        a=1.0-smoothstep(-0.035,-0.008,glassEdge);
                        vec3 cabin=mix(vec3(1.0,0.75,0.44),warm,0.24);
                        float fall=smoothstep(-0.84,0.82,p.y);
                        vec3 ray=normalize(vPos-vEye);
                        float grazing=pow(1.0-clamp(ray.z,0.0,1.0),2.0);
                        float dash=1.0-smoothstep(-0.59,-0.44,p.y+0.07*p.x);
                        // Rain on the outside bends the view through each bead and runnel.
                        vec3 wet=rainOnGlass(vPos.xy,clock,rain);
                        ray=normalize(ray+vec3(wet.xy*9.0,0.0));
                        c=cab(cabin,ray,tail);
                        c=mix(c,vec3(0.012,0.018,0.017),dash*0.3);
                        // Glass: a thick, faintly green pane. What is behind it loses some light;
                        // its face reflects the coast, more and more towards grazing.
                        c*=vec3(0.80,0.86,0.83);
                        vec3 paneNormal=normalize(vec3(vPos.x*0.42,0.07,-1.0));
                        vec3 bounce=reflect(ray,paneNormal);
                        float cosine=clamp(dot(-ray,paneNormal),0.0,1.0);
                        float fresnel=0.05+0.95*pow(1.0-cosine,5.0);
                        float horizon=exp(-abs(bounce.y+0.02)*26.0);
                        vec3 sky=mix(cold*0.55,cold*(0.9+day*0.5),smoothstep(-0.02,0.35,bounce.y));
                        vec3 sea=mix(vec3(0.012,0.024,0.03),cold*0.18,exp(-abs(bounce.y)*7.0));
                        vec3 mirror=(bounce.y>-0.02?sky:sea)+cold*horizon*0.55;
                        // A soft band where the brow over the glass is reflected.
                        mirror*=1.0-0.55*smoothstep(0.55,0.95,p.y);
                        c=mix(c,mirror,clamp(fresnel*1.3+0.03,0.0,0.8));
                        // The edge of the glass seen through its thickness, a thin bright line inside the rubber.
                        float rim=length(max(abs(p)-vec2(0.88),0.0))-0.12;
                        c+=cold*0.22*(1.0-smoothstep(-0.07,-0.045,rim))*smoothstep(-0.11,-0.075,rim)*(0.4+fresnel*2.0);
                        // Each drop is a lens: darker in its body, a bright rim of sky at its edge.
                        float dropRim=clamp(length(wet.xy)*90.0,0.0,1.0);
                        c=mix(c,c*0.75+mirror*0.25+cold*0.35*dropRim,wet.z*0.7);
                        if((tail<0.5?cabReal:tailReal)>0.5){
                            // Close to the leading end the real cab is drawn behind the glass, so the
                            // pane keeps only what is on it: the reflection, its edge and the rain.
                            float edgeLine=(1.0-smoothstep(-0.07,-0.045,rim))*smoothstep(-0.11,-0.075,rim);
                            // On the light page the glass gives back more of the paper sky, so the cab is a soft layer behind it.
                            float cover=clamp(fresnel*1.3+0.07+0.3*day,0.0,0.8+0.05*day);
                            vec3 surface=mix(mirror*vec3(0.92,1.0,0.96),cold,0.5*day);
                            surface=mix(surface,mirror*0.6+cold*0.35*dropRim,wet.z);
                            cover=max(cover,wet.z*(0.35+0.4*dropRim));
                            cover=max(cover,edgeLine*0.6);
                            surface+=cold*0.4*edgeLine;
                            c=surface;
                            a*=cover;
                        }
                        if(vKind<0.5){
                            // The wiper parked low across the pane.
                            vec2 arm=vec2(1.05,0.10),from=p-vec2(-0.58,-0.8);
                            float armDist=length(from-arm*clamp(dot(from,arm)/dot(arm,arm),0.0,1.0));
                            float blade=1.0-smoothstep(0.016,0.032,armDist);
                            c=mix(c,vec3(0.012),blade);
                            a=max(a,blade*step(glassEdge,0.0));
                        }
                    }else if(vKind<1.5){
                        c=texture2D(destination,vec2(vUv.x,0.5+vUv.y*0.5)).rgb*(0.65+day*0.36);
                    }else if(vKind<2.5){
                        a=1.0-smoothstep(0.85,1.0,r);
                        float fresnel=exp(-abs(r-0.71)*13.0);
                        float core=(1.0-smoothstep(0.0,0.78,r))*(1.0-tail);
                        float flutes=0.82+0.18*cos(p.x*35.0);
                        c=cold*(0.20+fresnel*0.46)+head*core*(1.1+1.8*flutes);
                    }else if(vKind<3.5){
                        a=exp(-r*8.0)*0.24*tail;c=red*1.05;
                    }else if(vKind<4.5){
                        vec2 edge=max(abs(p)-vec2(0.73,0.58),0.0);
                        a=1.0-smoothstep(0.15,0.24,length(edge));
                        c=red*mix(0.14,2.2,tail)*(0.83+0.17*cos(p.x*28.0));
                    }else if(vKind<5.5){
                        a=exp(-r*8.5)*0.27*(1.0-tail);c=head*1.28;
                    }else{
                        vec4 number=texture2D(destination,vec2(vUv.x,vUv.y*0.5));
                        c=number.rgb*(0.37+day*0.45);a=number.a;
                    }
                    gl_FragColor=vec4(c,a);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const trainEnds = instances(endMaterial, 2, endGeometry);
        trainEnds.renderOrder = 2; trainEnds.name = 'trainEnds';
        const cabinGlow = new T.PointLight('#ffd28c', 0, 15, 2);
        root.add(cabinGlow);
        const trainParts = [cars, glass, kits, trainEnds];
        /*
         * The saloon of the leading car, for the breaks in the song when the
         * camera rides inside. It is laid out as the 300 series is: long benches
         * under the windows, a rack and a row of hand straps over each, twin
         * rows of ceiling lights, and a glazed bulkhead through which
         * the cab, the driver and the line ahead can be seen. The windows are
         * real openings, so what goes by outside is the same world the train
         * runs through. It is one mesh in one material, shown only while it is
         * needed, in the same tones the lit windows show from outside.
         * Paints: panel, dado, moquette, floor, metal, tube, ceiling, gangway,
         * printed card (9), luggage (10/11), dials (12/13), route diagram (14),
         * silhouette (15), heater (16), vent (17), trim (18), piping (19), stainless (20), cab paint (21).
         */
        const SITTERS = [
            [-1, -2.9, 'doze', 1.05], [-1, -0.7, 'bag', 0.94], [1, -1.9, 'read', 1.0],
            [1, 0.9, 'bag', 0.92], [-1, 2.3, 'rest', 1.08], [1, 4.9, 'doze', 0.96]
        ];
        const saloonGeometry = (() => {
            // Two lists: the shell and the cab, drawn at any distance through the
            // windscreen, then the fittings, drawn only when the camera is close.
            const lists = { coarse: [[], [], []], fine: [[], [], []] };
            let coarse = false;
            const add = (shape, paint) => {
                const flat = shape.index ? shape.toNonIndexed() : shape;
                const [positions, normals, paints] = coarse ? lists.coarse : lists.fine;
                positions.push(...flat.attributes.position.array);
                normals.push(...flat.attributes.normal.array);
                for (let i = 0; i < flat.attributes.position.count; i++) paints.push(paint);
                if (flat !== shape) flat.dispose();
                shape.dispose();
            };
            const boxAt = (sx, sy, sz, x, y, z, paint) => add(new T.BoxGeometry(sx, sy, sz).translate(x, y, z), paint);
            // Fewer steps round the edges where they would not show: four for the
            // cab's fittings, a plain box where the radius is a few millimetres.
            let edgeSteps = 6;
            const roundedPanel = (width, height, length, radius, steps = edgeSteps) => {
                if (steps < 4 || radius < 0.014 && steps < 6) return new T.BoxGeometry(width, height, length);
                const panel = new T.BoxGeometry(width, height, length, steps, steps, steps);
                const points = panel.attributes.position, surface = panel.attributes.normal;
                const half = [width / 2, height / 2, length / 2];
                const offsets = steps === 6 ? [0, 0.38, 1, 0, 1, 0.38, 0] : [0, 1, 0, 1, 0];
                const normal = new T.Vector3();
                for (let i = 0; i < points.count; i++) {
                    const mapAxis = (value, limit) => {
                        const middle = steps / 2, step = Math.round((value / limit + 1) * middle);
                        return step === middle ? 0 : Math.sign(step - middle) * (limit - radius * offsets[step]);
                    };
                    const x = mapAxis(points.getX(i), half[0]), y = mapAxis(points.getY(i), half[1]);
                    const z = mapAxis(points.getZ(i), half[2]);
                    const cx = clamp(x, radius - half[0], half[0] - radius);
                    const cy = clamp(y, radius - half[1], half[1] - radius);
                    const cz = clamp(z, radius - half[2], half[2] - radius);
                    normal.set(x - cx, y - cy, z - cz).normalize();
                    points.setXYZ(i, cx + radius * normal.x, cy + radius * normal.y, cz + radius * normal.z);
                    surface.setXYZ(i, normal.x, normal.y, normal.z);
                }
                return panel;
            };
            const moulded = (sx, sy, sz, radius, x, y, z, paint) =>
                add(roundedPanel(sx, sy, sz, radius).translate(x, y, z), paint);
            const sashRim = (width, height, rail, r, depth, curve = 4) => {
                const outline = new T.Shape(), opening = new T.Path();
                roundedOutline(outline, width, height, r);
                roundedOutline(opening, width - 2 * rail, height - 2 * rail, r - rail * 0.7);
                outline.holes.push(opening);
                return new T.ExtrudeGeometry(outline, {
                    depth, bevelEnabled: true, bevelThickness: 0.003,
                    bevelSize: 0.003, bevelSegments: 1, curveSegments: curve
                }).translate(0, 0, -depth / 2);
            };
            const F = CAR.floor, WALL = CAR.half - 0.04, END = CAR.length / 2, TOP = CABIN.ceiling, SILL = 2.2, HEAD = 3.06;
            const BULKHEAD = TIP + 1.35, FRONT = TIP + 0.26;
            coarse = true;
            boxAt(2.6, 0.06, CAR.length, 0, F - 0.03, 0, 3);
            boxAt(2.6, 0.06, CAR.length, 0, TOP + 0.03, 0, 6);
            coarse = false;
            for (let lamp = 0; lamp < CABIN.lamps; lamp += 1) {
                const z = CABIN.first + lamp * CABIN.pitch;
                moulded(0.54, 0.035, 1.08, 0.011, 0, TOP - 0.018, z, 18);
                boxAt(0.46, 0.018, 0.98, 0, TOP - 0.035, z, 17);
                for (const side of [-1, 1]) {
                    const x = side * CABIN.rail;
                    moulded(0.15, 0.044, CABIN.length + 0.105, 0.018, x, TOP - 0.021, z, 18);
                    add(new T.CylinderGeometry(0.023, 0.023, CABIN.length, 10).rotateX(Math.PI / 2)
                        .translate(x, CABIN.tube, z), 5);
                    for (const end of [-1, 1]) {
                        moulded(0.10, 0.055, 0.063, 0.014, x, CABIN.tube + 0.012, z + end * (CABIN.length * 0.5 + 0.02), 18);
                    }
                }
            }
            // Cards hung across the aisle in the gaps between the tubes.
            for (const z of [1.525, -0.975, -3.475]) {
                boxAt(0.62, 0.02, 0.02, 0, TOP - 0.05, z, 4);
                moulded(0.60, 0.32, 0.022, 0.007, 0, TOP - 0.21, z, 18);
                boxAt(0.574, 0.294, 0.025, 0, TOP - 0.21, z, 9);
            }
            // Broad, faceless shapes read in the carriage light. Build every pose
            // from the same ink material so the joints disappear into the outline.
            const UP = new T.Vector3(0, 1, 0);
            const SHADOW = 15;
            const placeFigure = (parts, x, y, z, yaw) => {
                const matrix = new T.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
                parts.forEach(shape => add(shape.applyMatrix4(matrix), SHADOW));
            };
            const oval = (rx, ry, rz, x, y, z) => new T.SphereGeometry(1, 16, 10)
                .scale(rx, ry, rz).translate(x, y, z);
            const limb = (parts, from, to, radius) => {
                const span = new T.Vector3(...to).sub(new T.Vector3(...from));
                const distance = span.length();
                parts.push(new T.CapsuleGeometry(radius, Math.max(0.01, distance - radius), 3, 8)
                    .applyQuaternion(new T.Quaternion().setFromUnitVectors(UP, span.divideScalar(distance)))
                    .translate((from[0] + to[0]) * 0.5, (from[1] + to[1]) * 0.5, (from[2] + to[2]) * 0.5));
            };
            const coat = (parts, hip, shoulder, lean) => {
                const outline = [[0, 0], [0.60, 0.08], [0.70, 0.4], [0.83, 0.8], [0.67, 0.95], [0, 1]];
                parts.push(new T.LatheGeometry(outline.map(([radius, y]) => new T.Vector2(radius, y)), 12)
                    .scale(0.19, shoulder - hip, 0.24).rotateZ(lean).translate(0, hip, 0));
            };
            const head = (parts, shoulder, nod = 0) => {
                const x = -0.018 + nod * 0.16;
                const y = shoulder + 0.126 - nod * 0.08;
                parts.push(oval(0.106, 0.138, 0.091, x, y, 0));
                limb(parts, [-0.012, shoulder - 0.045, 0], [x, y - 0.035, 0], 0.062);
            };
            const sitter = (side, z, pose, size) => {
                const parts = [], shoulder = 0.57 * size;
                coat(parts, 0.02, shoulder, pose === 'doze' ? -0.16 : -0.06);
                const nod = { doze: 0.57, read: 0.48, bag: 0.22, rest: 0.04 }[pose];
                head(parts, shoulder, nod);
                for (const sign of [-1, 1]) {
                    const foot = sign * 0.084;
                    limb(parts, [0.025, 0.09, foot], [0.37, 0.07, foot], 0.084);
                    limb(parts, [0.37, 0.08, foot], [0.41, -0.39, foot], 0.061);
                    parts.push(oval(0.117, 0.046, 0.065, 0.47, -0.4, foot));
                    const elbow = [0.055, 0.23, sign * 0.18];
                    const grip = pose === 'rest' ? [0.31, 0.19, sign * 0.11] : [0.25, 0.33, sign * 0.07];
                    limb(parts, [0, shoulder - 0.09, sign * 0.15], elbow, 0.058);
                    limb(parts, elbow, grip, 0.047);
                }
                if (pose === 'bag') parts.push(oval(0.105, 0.129, 0.16, 0.24, 0.22, 0));
                if (pose === 'read') parts.push(new T.BoxGeometry(0.16, 0.016, 0.23).rotateZ(0.42).translate(0.3, 0.33, 0));
                placeFigure(parts, side * (WALL - 0.36), F + 0.46, z, side > 0 ? Math.PI : 0);
            };
            const stander = () => {
                const parts = [];
                coat(parts, 0.74, 1.38, -0.04);
                head(parts, 1.38, 0.1);
                for (const side of [-1, 1]) {
                    const foot = side * 0.088;
                    limb(parts, [-0.008, 0.86, foot], [0.026, 0.09, foot], 0.065);
                    parts.push(oval(0.104, 0.042, 0.063, 0.05, 0.045, foot));
                }
                limb(parts, [0, 1.26, -0.16], [0.04, 0.76, -0.19], 0.056);
                const elbow = [-0.10, 1.48, 0.21];
                limb(parts, [0, 1.29, 0.15], elbow, 0.057);
                limb(parts, elbow, [-0.21, 3.1 - F, 0.20], 0.047);
                placeFigure(parts, 0.84, F, -4.02, 0);
            };
            const openings = [...WINDOWS.map(z => [z - 0.5, z + 0.5]), ...DOORS.map(z => [z - 0.3, z + 0.3]), [-5.44, -4.98]]
                .sort((a, b) => a[0] - b[0]);
            const gripLoop = [[0.063, 0], [0.05, 0.018], [-0.027, 0.054], [-0.048, 0.039],
                [-0.048, -0.039], [-0.027, -0.054], [0.05, -0.018]].map(([y,z]) => new T.Vector3(0, y, z));
            const grip = new T.TubeGeometry(new T.CatmullRomCurve3(gripLoop, true, 'catmullrom', 0.25), 20, 0.0085, 7, true);
            const sashRubber = sashRim(1.046, 0.887, 0.045, 0.077, 0.03).rotateY(Math.PI / 2);
            const sashMetal = sashRim(1.006, 0.85, 0.021, 0.065, 0.018).rotateY(Math.PI / 2);
            const doorRubber = sashRim(0.665, 0.895, 0.037, 0.086, 0.025).rotateY(Math.PI / 2);
            const doorMetal = sashRim(0.629, 0.856, 0.018, 0.077, 0.017).rotateY(Math.PI / 2);
            for (const side of [-1, 1]) {
                const x = side * WALL;
                coarse = true;
                boxAt(0.08, SILL - F, CAR.length, x, (SILL + F) / 2, 0, 1);
                boxAt(0.08, TOP - HEAD, CAR.length, x, (TOP + HEAD) / 2, 0, 0);
                coarse = false;
                moulded(0.088, 0.12, CAR.length - 0.15, 0.033, side * (WALL - 0.049), TOP - 0.065, 0, 18);
                // The posts between one opening and the next.
                let from = TIP;
                for (const [a, b] of [...openings, [END, END]]) {
                    const bay = a - from;
                    if (bay > 0) {
                        coarse = true;
                        boxAt(0.08, HEAD - SILL, bay, x, (HEAD + SILL) / 2, (a + from) / 2, 0);
                        coarse = false;
                        moulded(0.033, HEAD - SILL + 0.047, bay - 0.013, 0.012,
                            side * (WALL - 0.042), (HEAD + SILL) / 2, (a + from) / 2, 18);
                    }
                    from = b;
                }
                WINDOWS.forEach((z, i) => {
                    const frameX = side * (WALL - 0.044), trimX = side * (WALL - 0.068);
                    add(sashRubber.clone().translate(frameX, 2.63, z), 13);
                    add(sashMetal.clone().translate(trimX, 2.63, z), 4);
                    moulded(0.038, 0.044, 0.979, 0.011, trimX, 2.76, z, 4);
                    moulded(0.025, 0.029, 0.085, 0.008, side * (WALL - 0.091), 2.784, z + 0.29, 18);
                    moulded(0.102, 0.045, 1.067, 0.012, side * (WALL - 0.057), SILL - 0.009, z, 18);
                    // Advertisement cards in the cove over the windows.
                    if (i % 2 === (side > 0 ? 0 : 1)) boxAt(0.012, 0.19, 0.72, side * (WALL - 0.05), 3.2, z, 9);
                });
                DOORS.forEach(z => {
                    add(doorRubber.clone().translate(side * (WALL - 0.052), 2.63, z), 13);
                    add(doorMetal.clone().translate(side * (WALL - 0.072), 2.63, z), 4);
                    for (const edge of [-0.51, 0.51]) {
                        moulded(0.083, TOP - F, 0.073, 0.017, side * (WALL - 0.039), (TOP + F) / 2, z + edge, 4);
                    }
                    for (const leaf of [-1, 1]) {
                        moulded(0.036, 0.633, 0.447, 0.014, side * (WALL - 0.042), 1.87, z + leaf * 0.237, 18);
                        moulded(0.047, 0.11, 0.046, 0.013, side * (WALL - 0.07), 2.08, z + leaf * 0.093, 4);
                    }
                    // The route diagram over the door, and the seam where the leaves meet.
                    boxAt(0.012, 0.15, 0.9, side * (WALL - 0.05), 3.2, z, 14);
                    boxAt(0.012, SILL - F - 0.06, 0.016, side * (WALL - 0.045), (SILL + F) / 2, z, 13);
                    boxAt(0.02, 0.05, 1.06, side * (WALL - 0.05), F + 0.025, z, 4);
                });
                for (const [a, b] of [[-3.65, 2.9], [4.2, END - 0.15]]) {
                    const middle = (a + b) / 2, run = b - a;
                    const seats = Math.round(run / 0.94), bay = run / seats;
                    for (let i = 0; i < seats; i++) {
                        const z = a + bay * (i + 0.5);
                        // A thick cushion with a rolled front edge, a fuller back with a roll along its top.
                        moulded(0.56, 0.16, bay - 0.006, 0.052, side * (WALL - 0.3), F + 0.37, z, 2);
                    }
                    // The back is one long upholstered piece the length of the bench, rolled along its top.
                    add(roundedPanel(0.2, 0.42, run - 0.01, 0.08).rotateZ(-side * 0.1)
                        .translate(side * (WALL - 0.135), F + 0.635, middle), 2);
                    add(roundedPanel(0.13, 0.08, run - 0.01, 0.04)
                        .translate(side * (WALL - 0.08), F + 0.81, middle), 2);
                    moulded(0.032, 0.018, run - 0.042, 0.007, side * (WALL - 0.57), F + 0.3, middle, 19);
                    moulded(0.40, 0.29, run, 0.022, side * (WALL - 0.24), F + 0.155, middle, 18);
                    moulded(0.05, 0.03, run, 0.012, side * (WALL - 0.445), F + 0.285, middle, 4);
                    moulded(0.016, 0.25, run - 0.06, 0.006, side * (WALL - 0.442), F + 0.15, middle, 16);
                    boxAt(0.02, 0.022, run, side * (WALL - 0.452), F + 0.011, middle, 13);
                    // Polished strips between the three slotted bands of the heater cover.
                    for (const y of [-0.117, -0.039, 0.039, 0.117]) {
                        add(new T.CylinderGeometry(0.0055, 0.0055, run - 0.07, 6).rotateX(Math.PI / 2)
                            .translate(side * (WALL - 0.452), F + 0.15 + y, middle), 4);
                    }
                    // Luggage rack: tubes on brackets, not a shelf.
                    for (let out = 0.05; out < 0.34; out += 0.037) {
                        add(new T.CylinderGeometry(0.006, 0.006, run, 6).rotateX(Math.PI / 2)
                            .translate(side * (WALL - out), 3.1, middle), 4);
                    }
                    for (let z = a + 0.1; z <= b - 0.05; z += (run - 0.2) / Math.max(1, Math.round(run / 1.25))) {
                        boxAt(0.3, 0.014, 0.02, side * (WALL - 0.17), 3.09, z, 4);
                        boxAt(0.02, 0.14, 0.02, side * (WALL - 0.05), 3.02, z, 4);
                    }
                    for (const end of [a, b]) {
                        // The bench end: under the seat a mirror-polished panel, an upside-down
                        // trapezoid (full depth at the top, cut back towards the floor); above the
                        // seat nothing but the grab rail, a post that bends over to the wall, and a
                        // bar from the post to the wall at seat height.
                        const aisle = side * (WALL - 0.6), at = u => side * (WALL - u);
                        const outline = new T.Shape();
                        [[0.02, F + 0.035], [0.47, F + 0.035], [0.585, F + 0.28], [0.02, F + 0.28]]
                            .forEach(([u, y], i) => (i ? outline.lineTo(at(u), y) : outline.moveTo(at(u), y)));
                        add(new T.ExtrudeGeometry(outline, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.004,
                            bevelSize: 0.004, bevelSegments: 2 }).translate(0, 0, end - 0.006), 4);
                        const rail = new T.CatmullRomCurve3([
                            [aisle, F + 0.02], [aisle, F + 0.74], [aisle + side * 0.025, F + 0.84],
                            [aisle + side * 0.12, F + 0.895], [at(0.05), F + 0.9],
                        ].map(([rx, y]) => new T.Vector3(rx, y, end)), false, 'centripetal');
                        add(new T.TubeGeometry(rail, 24, 0.017, 10, false), 4);
                        add(new T.CylinderGeometry(0.0145, 0.0145, 0.55, 10).rotateZ(Math.PI / 2)
                            .translate(at(0.325), F + 0.43, end), 4);
                        // Floor flange under the post, wall roses where the bars meet the wall.
                        add(new T.CylinderGeometry(0.03, 0.038, 0.018, 14).translate(aisle, F + 0.009, end), 4);
                        for (const y of [F + 0.43, F + 0.9]) {
                            add(new T.CylinderGeometry(0.03, 0.03, 0.03, 12).rotateZ(Math.PI / 2)
                                .translate(at(0.035), y, end), 4);
                        }
                    }
                }
                add(new T.CylinderGeometry(0.015, 0.015, CAR.length - 2.6, 10).rotateX(Math.PI / 2)
                    .translate(side * 0.62, 3.12, 0.8), 4);
                for (let z = -3.4; z < END - 0.5; z += 0.42) {
                    boxAt(0.012, 0.20, 0.022, side * 0.62, 3.01, z, 22);
                    add(grip.clone().translate(side * 0.62, 2.86, z), 22);
                }
            }
            grip.dispose();
            sashRubber.dispose(); sashMetal.dispose();
            doorRubber.dispose(); doorMetal.dispose();
            // Recessed floor hatches show their metal lip in the aisle light.
            for (const z of [-2.05, 1.28, 3.56]) {
                for (const x of [-0.33, 0.33]) boxAt(0.017, 0.004, 0.63, x, F + 0.002, z, 4);
                for (const edge of [-0.308, 0.308]) boxAt(0.643, 0.004, 0.017, 0, F + 0.002, z + edge, 4);
                for (const x of [-0.23, 0.23]) boxAt(0.068, 0.004, 0.024, x, F + 0.003, z - 0.23, 13);
            }
            SITTERS.forEach(([side, z, pose, size]) => sitter(side, z, pose, size));
            stander();
            // A rucksack and a parcel left up on the racks.
            boxAt(0.22, 0.17, 0.32, -(WALL - 0.17), 3.2, 0.4, 11);
            boxAt(0.22, 0.14, 0.3, WALL - 0.17, 3.18, -2.6, 10);
            coarse = true;
            edgeSteps = 4;
            // Cab bulkhead and the front of the cab: a glazed door or pane in the middle, one either side.
            for (const [z, post, paint] of [[BULKHEAD, 0.12, 0], [FRONT, 0.09, 21]]) {
                boxAt(2.6, SILL - F, 0.06, 0, (SILL + F) / 2, z, 1);
                boxAt(2.6, TOP - 3.05, 0.06, 0, (TOP + 3.05) / 2, z, 0);
                for (const x of [-1.2, -0.46, 0.46, 1.2]) boxAt(Math.abs(x) > 1 ? 0.2 : post, 3.05 - SILL, 0.06, x, (3.05 + SILL) / 2, z, paint);
            }
            // The cab door in the bulkhead: jambs, kick plate, handle.
            for (const x of [-0.46, 0.46]) moulded(0.053, SILL - F, 0.092, 0.013, x, (SILL + F) / 2, BULKHEAD, 4);
            moulded(0.87, 0.63, 0.032, 0.013, 0, F + 0.45, BULKHEAD + 0.035, 18);
            moulded(0.852, 0.18, 0.029, 0.01, 0, F + 0.105, BULKHEAD + 0.042, 4);
            moulded(0.033, 0.153, 0.032, 0.014, 0.36, F + 0.72, BULKHEAD + 0.065, 4);
            for (const x of [-0.81, 0, 0.81]) {
                const span = x === 0 ? 0.828 : 0.594;
                add(sashRim(span, 0.819, 0.026, 0.091, 0.024, 2).translate(x, 2.628, BULKHEAD + 0.048), 13);
                add(sashRim(span - 0.02, 0.798, 0.014, 0.081, 0.012, 2).translate(x, 2.628, BULKHEAD + 0.064), 4);
            }
            // The driver's desk on the left: a console under the windscreen, an
            // instrument hood leaning back towards the glass with two gauges and a
            // row of lamps, the master controller on the left and the brake valve
            // on the right, a seat on a post, and a visor over the glass.
            const DESK = -0.8, CAB = 21;
            moulded(0.84, 2.0 - F, 0.3, 0.02, DESK, (2.0 + F) / 2, FRONT + 0.16, CAB);
            moulded(0.9, 0.04, 0.44, 0.012, DESK, 2.02, FRONT + 0.22, CAB);
            moulded(0.86, 0.03, 0.03, 0.01, DESK, 2.02, FRONT + 0.44, 4);
            const hood = shape => shape.rotateX(-0.62).translate(DESK, 2.27, FRONT + 0.12);
            // The hood stands on a skirt, high enough to show over the sill of the glass.
            moulded(0.62, 0.17, 0.06, 0.012, DESK, 2.1, FRONT + 0.1, CAB);
            add(hood(roundedPanel(0.64, 0.25, 0.05, 0.016)), CAB);
            for (const x of [-0.15, 0.13]) {
                add(hood(new T.CylinderGeometry(0.062, 0.062, 0.02, 20).rotateX(Math.PI / 2).translate(x, 0.025, 0.03)), 12);
                add(hood(new T.TorusGeometry(0.064, 0.009, 6, 20).translate(x, 0.025, 0.041)), 4);
                add(hood(new T.BoxGeometry(0.006, 0.052, 0.004).translate(0, 0.022, 0).rotateZ(x > 0 ? -0.9 : 0.5)
                    .translate(x, 0.025, 0.043)), 13);
            }
            [-0.21, -0.13, 0.05, 0.13, 0.21].forEach((x, i) => add(hood(new T.CylinderGeometry(0.011, 0.011, 0.012, 8)
                .rotateX(Math.PI / 2).translate(x, -0.085, 0.03)), i === 1 || i === 3 ? 5 : 13));
            // Master controller: a box on the desk, a notched top plate, a handle with a ball knob.
            moulded(0.2, 0.17, 0.24, 0.024, -1.08, 2.12, FRONT + 0.27, 13);
            add(new T.CylinderGeometry(0.095, 0.095, 0.018, 18).translate(-1.08, 2.215, FRONT + 0.27), 4);
            add(new T.CylinderGeometry(0.014, 0.014, 0.07, 8).translate(-1.08, 2.255, FRONT + 0.27), 4);
            add(new T.CapsuleGeometry(0.013, 0.15, 2, 6).rotateX(Math.PI / 2).rotateY(0.45)
                .translate(-1.045, 2.29, FRONT + 0.34), 4);
            add(new T.SphereGeometry(0.027, 12, 8).translate(-1.01, 2.29, FRONT + 0.41), 13);
            // Brake valve: a drum with a long handle swung towards the driver.
            add(new T.CylinderGeometry(0.068, 0.078, 0.1, 16).translate(-0.52, 2.09, FRONT + 0.3), 13);
            add(new T.CylinderGeometry(0.05, 0.05, 0.02, 14).translate(-0.52, 2.15, FRONT + 0.3), 4);
            add(new T.CapsuleGeometry(0.012, 0.19, 2, 6).rotateX(Math.PI / 2).rotateY(-0.55)
                .translate(-0.565, 2.17, FRONT + 0.38), 4);
            add(new T.SphereGeometry(0.024, 12, 8).translate(-0.61, 2.17, FRONT + 0.46), 13);
            // The driver's seat on its post, and the visor.
            add(new T.CylinderGeometry(0.028, 0.028, 0.44, 10).translate(DESK, F + 0.22, FRONT + 0.84), 4);
            add(new T.CylinderGeometry(0.17, 0.19, 0.025, 16).translate(DESK, F + 0.012, FRONT + 0.84), 4);
            moulded(0.42, 0.085, 0.4, 0.035, DESK, F + 0.48, FRONT + 0.82, 2);
            moulded(0.4, 0.4, 0.065, 0.03, DESK, F + 0.76, FRONT + 1.03, 2);
            // A roller blind over the driver's glass, drawn a third of the way down.
            add(new T.CylinderGeometry(0.024, 0.024, 0.68, 10).rotateZ(Math.PI / 2).translate(DESK, 3.01, FRONT + 0.08), 13);
            boxAt(0.64, 0.25, 0.006, DESK, 2.875, FRONT + 0.085, 10);
            boxAt(0.66, 0.016, 0.014, DESK, 2.75, FRONT + 0.085, 4);
            boxAt(0.012, 0.06, 0.006, DESK, 2.712, FRONT + 0.085, 13);
            // The day's running card clipped on the hood, standing up beside the gauges.
            add(new T.BoxGeometry(0.16, 0.22, 0.008).rotateX(-0.3).translate(-0.55, 2.43, FRONT + 0.2), 12);
            add(new T.BoxGeometry(0.06, 0.025, 0.014).rotateX(-0.3).translate(-0.55, 2.535, FRONT + 0.232), 4);
            // The driver's bag on the locker opposite.
            moulded(0.34, 0.2, 0.18, 0.04, 0.72, F + 0.92, FRONT + 0.26, 11);
            add(new T.TorusGeometry(0.06, 0.01, 6, 14, Math.PI).translate(0.72, F + 1.02, FRONT + 0.26), 13);
            // To the right of the cab door: a locker against the front, and a lamp in the cab roof.
            moulded(0.72, 0.78, 0.34, 0.02, 0.8, F + 0.39, FRONT + 0.19, CAB);
            moulded(0.74, 0.03, 0.36, 0.01, 0.8, F + 0.795, FRONT + 0.19, 13);
            moulded(0.3, 0.025, 0.22, 0.01, 0, TOP - 0.012, FRONT + 0.55, 5);
            {
                const driver = [];
                coat(driver, 0, 0.56, -0.03);
                head(driver, 0.56);
                driver.push(oval(0.125, 0.047, 0.104, -0.009, 0.798, 0));
                driver.push(oval(0.095, 0.017, 0.098, 0.095, 0.769, 0));
                for (const side of [-1, 1]) {
                    const elbow = [0.12, 0.28, side * 0.19];
                    limb(driver, [0, 0.48, side * 0.14], elbow, 0.051);
                    limb(driver, elbow, [0.44, 0.35, side * 0.25], 0.047);
                }
                placeFigure(driver, -0.8, F + 0.55, FRONT + 0.86, Math.PI / 2);
            }
            // The inner end, and the dark of the gangway through to the next car.
            boxAt(2.6, TOP - F, 0.06, 0, (TOP + F) / 2, END - 0.03, 0);
            boxAt(0.84, 1.9, 0.02, 0, F + 0.95, END - 0.07, 7);
            // A dark rubber frame round the open gangway, and a threshold plate.
            for (const x of [-0.45, 0.45]) moulded(0.07, 1.95, 0.05, 0.02, x, F + 0.975, END - 0.08, 13);
            moulded(0.97, 0.07, 0.05, 0.02, 0, F + 1.935, END - 0.08, 13);
            moulded(0.9, 0.012, 0.3, 0.004, 0, F + 0.006, END - 0.2, 4);
            const shape = new T.BufferGeometry();
            const [positions, normals, paints] = [0, 1, 2].map(i => lists.coarse[i].concat(lists.fine[i]));
            shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            shape.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
            shape.setAttribute('paint', new T.Float32BufferAttribute(paints, 1));
            shape.userData.coarse = lists.coarse[2].length;
            return geometry(shape);
        })();
        const saloonMaterial = material(new T.ShaderMaterial({
            uniforms: { warm: glassMaterial.uniforms.warm, seat: glassMaterial.uniforms.seat,
                sunset: cabinMood.sunset, empty: cabinMood.empty, clock: cabinMood.clock, sway: cabinMood.sway,
                detail: { value: detailAtlas },
                sky: carHorizon, shadowInk: glassMaterial.uniforms.shadowInk, day: cabinDaylight, power: glassMaterial.uniforms.power,
                boards: planks.map, boardsReady: planks.ready, cabReal, tailCab: { value: 0 } },
            vertexShader: `attribute float paint;uniform float clock,sway;varying float vPaint;varying vec3 vNormal,vPos,vView;
                void main(){vPaint=paint;vec3 p=position,nn=normal;
                    if(paint>21.5){
                        // Each strap swings from its hanger: mostly along the car, a little across.
                        float zp=-3.4+floor((p.z+3.4)/0.42+0.5)*0.42;
                        vec3 pivot=vec3(sign(p.x)*0.62,3.11,zp);
                        float a=sway*(0.11*sin(clock*1.35+zp*0.55)+0.035*sin(clock*2.9+zp*1.9));
                        float b=sway*0.05*sin(clock*1.1+zp*0.8+sign(p.x));
                        vec3 q=p-pivot;
                        q=vec3(q.x,q.y*cos(a)-q.z*sin(a),q.y*sin(a)+q.z*cos(a));
                        q=vec3(q.x*cos(b)-q.y*sin(b),q.x*sin(b)+q.y*cos(b),q.z);
                        p=pivot+q;
                        nn=vec3(nn.x,nn.y*cos(a)-nn.z*sin(a),nn.y*sin(a)+nn.z*cos(a));
                        nn=vec3(nn.x*cos(b)-nn.y*sin(b),nn.x*sin(b)+nn.y*cos(b),nn.z);
                    }
                    vNormal=nn;vPos=p;
                    vView=(inverse(modelMatrix)*vec4(cameraPosition,1.0)).xyz-p;
                    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
            fragmentShader: `uniform vec3 warm,seat,sky,shadowInk;uniform float power,day,boardsReady,sunset,empty,cabReal,tailCab;
                uniform sampler2D boards,detail;
                varying float vPaint;varying vec3 vNormal,vPos,vView;
                ${cabinLightFunctions}
                const float FLOOR=${CAR.floor.toFixed(2)},PITCH=${WINDOW_PITCH.toFixed(2)};
                const vec2 SAT[${SITTERS.length}]=vec2[](${SITTERS.map(([side, z]) => `vec2(${side.toFixed(1)},${z.toFixed(2)})`).join(',')});
                float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
                float tubeLux(vec3 p,vec3 n,float side){
                    float z=tubeCentre(p.z), toward=clamp(p.z,z-TUBE_HALF,z+TUBE_HALF);
                    vec3 ray=vec3(side*RAIL,TUBE_Y,toward)-p;
                    float square=dot(ray,ray);
                    float facing=max(dot(n,ray)*inversesqrt(max(square,0.008)),0.0);
                    return facing/(0.66+square*1.20);
                }
                float reflectTubes(vec3 p,vec3 ray,float width){
                    if(ray.y<=0.014)return 0.0;
                    float t=(TUBE_Y-p.y)/ray.y;
                    return tubes(p.xz+ray.xz*t,width)*smoothstep(0.0,0.15,t)*(1.0-smoothstep(5.0,10.0,t));
                }
                // The car as a box seen along a ray: lamp strips on a cream ceiling, cream
                // walls with dark windows over green benches and slotted heaters, the
                // honey floor. Polished metal reflects it; the open gangway looks into it.
                vec3 cabinScene(vec3 o,vec3 d,vec3 cream,vec3 lamp,float far){
                    float dx=abs(d.x)<1e-4?1e-4:d.x,dy=abs(d.y)<1e-4?1e-4:d.y,dz=abs(d.z)<1e-4?1e-4:d.z;
                    float tx=((dx>0.0?1.24:-1.24)-o.x)/dx,ty=((dy>0.0?CEILING:FLOOR)-o.y)/dy;
                    float tz=far>0.0?(far-o.z)/dz:1e4;if(tz<0.0)tz=1e4;
                    float t=max(min(min(tx,ty),tz),0.0);vec3 p=o+d*t,c;
                    vec3 green=mix(seat,vec3(0.15,0.31,0.014),0.85);
                    if(t==tz){
                        // The far end: cream, with the dark of the next gangway.
                        c=cream*0.6*lamp;
                        c=mix(c,vec3(0.02,0.022,0.03),step(abs(p.x),0.42)*step(p.y,FLOOR+1.9));
                    }else if(ty<tx){
                        if(dy>0.0){
                            float vent=step(abs(p.x),0.25)*step(0.5,fract(p.x*30.0));
                            c=cream*(0.55-0.25*vent)*lamp+lamp*tubes(p.xz,0.06)*2.6;
                        }else{
                            float joint=step(0.93,fract(p.x/0.11));
                            c=mix(vec3(0.36,0.25,0.14),vec3(0.42,0.33,0.22),day)*(0.95-0.4*joint)*lamp*0.75;
                        }
                    }else{
                        float y=p.y-FLOOR;
                        float w=abs(fract((p.z+2.95)/1.25+0.5)-0.5)*1.25;
                        float glass=step(w,0.47)*step(2.24,p.y)*step(p.y,3.02);
                        if(y<0.37)c=cream*0.5*lamp;
                        else if(y<0.86)c=green*1.2*lamp;
                        else c=mix(cream*0.66*lamp,mix(sky*0.35,sky*0.9,day),glass);
                    }
                    return mix(c,cream*0.42*lamp,smoothstep(6.0,16.0,t)*0.6);
                }
                // Low sun from the left of the car, through the side windows: whether a
                // point can see it, traced back to the glass, with the sash rail across it.
                const vec3 SUN_TO=normalize(vec3(-1.0,0.6,0.95));
                const float GLASS_X=-${(CAR.half - 0.06).toFixed(3)};
                const float PANES[${WINDOWS.length}]=float[](${WINDOWS.map(z => z.toFixed(2)).join(',')});
                const float DOORWAYS[${DOORS.length}]=float[](${DOORS.map(z => z.toFixed(2)).join(',')});
                float opening(vec2 q,vec2 size,float soft){
                    vec2 d=abs(q)-size;
                    return 1.0-smoothstep(-soft,soft,max(d.x,d.y));
                }
                float sunPatch(vec3 p,vec3 n){
                    float facing=dot(n,SUN_TO);
                    if(sunset<0.001||facing<=0.0||p.x<GLASS_X+0.03)return 0.0;
                    // Under and against the near bench the sun cannot reach.
                    if(p.x<-0.66&&p.y<FLOOR+0.56)return 0.0;
                    float t=(GLASS_X-p.x)/SUN_TO.x;
                    vec3 h=p+SUN_TO*t;
                    float soft=0.006+t*0.012,lit=0.0;
                    for(int i=0;i<${WINDOWS.length};i++)lit=max(lit,opening(h.zy-vec2(PANES[i],2.63),vec2(0.47,0.4),soft));
                    for(int i=0;i<${DOORS.length};i++)lit=max(lit,opening(h.zy-vec2(DOORWAYS[i],2.6),vec2(0.29,0.41),soft));
                    lit*=smoothstep(0.012,0.02+soft,abs(h.y-2.76));
                    return lit*smoothstep(0.0,0.25,facing);
                }
                // Seen from outside, nothing of the saloon may stand out past the shell:
                // the rounded nose in plan and the curve of the roof at the eaves.
                float insideShell(vec3 p){
                    float d=p.z-(${TIP.toFixed(3)});
                    vec2 wr=vec2(${CAR.half.toFixed(3)},1.0);
                    ${NOSE.slice(1).map(([z1, w1, r1], i) => { const [z0, w0, r0] = NOSE[i];
                        return `if(d<${z1.toFixed(3)}&&wr.y==1.0&&wr.x==${CAR.half.toFixed(3)})wr=mix(vec2(${w0.toFixed(3)},${r0.toFixed(3)}),vec2(${w1.toFixed(3)},${r1.toFixed(3)}),clamp((d-${z0.toFixed(3)})/${(z1 - z0).toFixed(3)},0.0,1.0));`; }).join('\n                    ')}
                    float wide=wr.x;
                    float e=clamp((p.y-${CAR.cant.toFixed(3)})/(0.4*wr.y),0.0,1.0);
                    float section=${(CAR.half - 0.42).toFixed(3)}+0.42*sqrt(1.0-e*e);
                    return step(0.0,d)*step(abs(p.x),wide/${CAR.half.toFixed(3)}*section-0.03);
                }
                void main(){
                    if((cabReal>0.5||tailCab>0.5)&&insideShell(vPos)<0.5)discard;
                    // Nobody drives from the cab at the back.
                    if(tailCab>0.5&&vPaint>14.5&&vPaint<15.5&&vPos.z<${(TIP + 1.35).toFixed(3)})discard;
                    vec3 cream=mix(vec3(0.70,0.66,0.52),vec3(0.79,0.77,0.72),day);
                    vec3 light=lampColour(warm,day*0.45),n=normalize(vNormal),v=normalize(vView);
                    vec3 c,env=vec3(0.0);float shine=0.0,chrome=0.0;
                    // What the metal sees: the lamps, fading at sunset to the amber of the windows.
                    vec3 seen=light*(1.0-0.62*sunset)+mix(vec3(0.5,0.26,0.1),vec3(0.3,0.28,0.24),day)*sunset;
                    bool cushion=vPaint>1.5&&vPaint<2.5;
                    bool floorboards=vPaint>2.5&&vPaint<3.5;
                    bool metal=vPaint>3.5&&vPaint<4.5;
                    bool figure=vPaint>14.5&&vPaint<15.5;
                    bool enamel=vPaint>17.5&&vPaint<18.5;
                    if(vPaint<0.5||enamel){
                        float seam=exp(-abs(vPos.y-2.20)*42.0)*0.12;
                        float mottling=sin(vPos.z*21.0+vPos.y*7.1)*sin(vPos.y*12.4-vPos.z*8.7);
                        float seal=exp(-abs(vPos.y-3.066)*59.0)+exp(-abs(vPos.y-2.21)*46.0);
                        float dirt=texture2D(detail,vec2(vPos.z*0.5,vPos.y*0.5)+vPos.x*0.3).b;
                        c=cream*((enamel?0.75:0.64)-seam)*(1.0+0.023*mottling-0.07*seal)
                            *(1.0-0.06*dirt*(1.0-smoothstep(FLOOR,FLOOR+0.9,vPos.y))-0.025*(dirt-0.5));
                        shine=reflectTubes(vPos,reflect(-v,n),0.24)*(enamel?0.115:0.042);
                    }
                    else if(vPaint<1.5)c=cream*0.43;
                    else if(vPaint<2.5){
                        // Looped wool catches grazing light along the rolled edge.
                        vec3 moquette=mix(seat,vec3(0.15,0.31,0.014),0.85*(1.0-day));
                        moquette=mix(moquette,vec3(0.15,0.31,0.014),0.85*day);
                        vec2 fibre=vec2(vPos.z,vPos.x+vPos.y)*vec2(284.0,321.0);
                        float fibreFade=1.0-smoothstep(0.7,3.4,max(fwidth(fibre.x),fwidth(fibre.y)));
                        vec4 cloth=texture2D(detail,vec2(vPos.z,vPos.y+vPos.x)*vec2(4.6,4.6));
                        float nap=(cloth.r-0.5)*2.2*mix(1.0,0.4,fibreFade)+sin(fibre.x+sin(fibre.y*0.52))*sin(fibre.y)*fibreFade*0.5
                            -(texture2D(detail,vPos.zy*0.35).b-0.5)*0.9;
                        float wear=sin(vPos.z*15.1+vPos.x*7.0)*sin(vPos.z*27.7-vPos.y*9.0);
                        float edge=pow(clamp(1.0-abs(dot(n,v)),0.0,1.0),2.3);
                        c=(moquette+warm*0.016)*(1.0+0.12*nap+0.045*wear+0.30*edge);
                        // Velour shows a soft sheen where it rolls over towards the light.
                        float roll=smoothstep(0.25,0.9,n.y)*(1.0-smoothstep(0.92,1.0,n.y));
                        c+=moquette*roll*0.32+light*edge*smoothstep(0.11,0.97,n.y)*0.02;
                    }else if(vPaint<3.5){
                        // Boards laid along the car, butt joints staggered, varnish worn dull.
                        float board=vPos.x/0.11,id=floor(board),grain=fwidth(board);
                        float run=vPos.z/1.9+hash(vec2(id,3.0))*5.0;
                        float seam=1.0-smoothstep(0.0,0.05+grain,0.5-abs(fract(board)-0.5));
                        float butt=1.0-smoothstep(0.0,0.006+fwidth(run),0.5-abs(fract(run)-0.5));
                        float tone=0.82+0.36*hash(vec2(id,floor(run)));
                        float fade=0.2/(0.2+grain);
                        float wood=sin(vPos.x*104.0+sin(vPos.z*1.9+id*3.0)*1.8)*sin(vPos.x*32.0+vPos.z*0.64);
                        float grainWave=0.5+0.5*sin(vPos.x*248.0+sin(vPos.z*3.8+id)*2.1+wood*1.2);
                        float grainDetail=pow(grainWave,4.0)*(1.0-smoothstep(0.8,3.3,fwidth(vPos.x)*248.0));
                        float wear=exp(-vPos.x*vPos.x*8.0);
                        float sampleId=hash(vec2(id,1.1));
                        vec2 woodUv=vec2((floor(sampleId*9.0)+0.30+fract(board)*0.40)/9.0,
                            vPos.z*0.63+sampleId*4.1);
                        float scanned=texture2D(boards,woodUv).r;
                        float patina=mix(1.0,mix(0.8,1.18,scanned),boardsReady);
                        float scuff=texture2D(detail,vPos.xz*vec2(0.9,0.22)).b;
                        patina*=mix(0.86,1.12,scuff)*(1.0-0.16*smoothstep(0.75,1.2,abs(vPos.x))*(1.0-scuff));
                        c=mix(vec3(0.33,0.285,0.21),vec3(0.42,0.33,0.22),day)*mix(1.0,0.5+0.5*tone+0.05*wood-0.05*grainDetail,fade)
                            *(1.0-0.40*max(seam,butt)*fade)*(0.89+0.19*wear)*patina;
                        vec3 r=reflect(-v,n);
                        // The varnish holds a long soft streak of each lamp row down the aisle.
                        shine=reflectTubes(vPos,r,0.32)*(0.05+0.3*pow(max(1.0-r.y,0.0),2.4))
                            *(1.0-0.36*seam*fade)*mix(1.0,0.6,wear);
                    }else if(vPaint<4.5){
                        // Polished chrome: it is the car, seen bent round the tube.
                        vec3 reflected=reflect(-v,n);
                        float grazing=pow(1.0-clamp(abs(dot(n,v)),0.0,1.0),3.0);
                        c=vec3(0.06,0.062,0.065);
                        env=mix(cabinScene(vPos+n*0.02,reflected,cream,seen,0.0),cream*seen*0.5,0.35)*(0.72+0.28*grazing);
                        // In the cab there are no benches to reflect: grey-green panels and the glass.
                        if(vPos.z<${(TIP + 1.45).toFixed(2)})env=mix(cream*seen*0.32,cream*seen*0.75,smoothstep(-0.3,0.6,reflected.y))*(0.72+0.28*grazing);
                        chrome=0.9;
                        shine=reflectTubes(vPos,reflected,0.06)*1.1;
                    }
                    else if(vPaint<5.5)c=light*2.8;
                    else if(vPaint<6.5)c=cream*(mix(0.62,0.6,day)+0.45*tubes(vPos.xz,0.55)+mix(0.7,0.5,day)*tubes(vPos.xz,0.22))*(1.0-0.3*smoothstep(1.0,1.26,abs(vPos.x)));
                    else if(vPaint<7.5){
                        // The open gangway: through the bellows into the next car, in perspective.
                        vec3 d=-v,o=vPos+d*(0.7/max(d.z,0.05))-vec3(0.0,0.0,${CAR.length.toFixed(2)}+0.7);
                        float tunnel=1.0-smoothstep(0.30,0.42,max(abs(vPos.x)*0.98,abs(vPos.y-FLOOR-0.95)*0.44));
                        c=cabinScene(o,d,cream,seen,${(CAR.length / 2).toFixed(2)})*mix(0.25,0.9,tunnel);
                        chrome=1.0;env=c;
                    }
                    else if(vPaint<8.5)c=warm*0.4+vec3(0.08);
                    else if(vPaint<9.5){
                        // Printed excursion cards with miniature coastal illustrations.
                        bool hung=abs(n.z)>0.5;
                        vec2 q=hung?vec2(vPos.x/0.29,(vPos.y-CEILING+0.21)/0.15)
                            :vec2((fract((vPos.z+2.95)/PITCH+0.5)-0.5)*PITCH/0.36,(vPos.y-3.2)/0.095);
                        float id=hash(vec2(floor((vPos.z+2.95)/PITCH+0.5),hung?n.z:n.x));
                        if(id>0.5)q.x=-q.x;
                        vec3 ink=id<0.3?seat*1.25:id<0.72?warm*0.75:cream*0.24;
                        float soft=fwidth(q.y)*1.5,split=-0.28+0.4*(fract(id*7.0)-0.5);
                        float inside=smoothstep(1.0,0.92,max(abs(q.x),abs(q.y)));
                        float block=smoothstep(split+0.02,split-0.02,q.x);
                        float row=floor(q.y*2.2+0.5);
                        float type=(1.0-smoothstep(0.1,0.1+soft*2.2,abs(fract(q.y*2.2+0.5)-0.5)))
                            *step(split+0.14,q.x)*step(q.x,0.25+0.6*hash(vec2(row,id)))*step(abs(row),1.5);
                        vec2 print=vec2((q.x+0.94)/max(split+0.94,0.1),(q.y+0.82)/1.64);
                        float artwork=step(max(abs(print.x-0.5),abs(print.y-0.5)),0.5);
                        float sun=1.0-smoothstep(0.12,0.12+soft,length(print-vec2(0.67,0.68)));
                        float headland=smoothstep(0.03,-0.02,print.y-0.40-0.10*sin(print.x*5.9+id*3.0));
                        float tide=step(print.y,0.29);
                        vec3 art=mix(ink*0.45+cream*0.33,warm*0.72+cream*0.17,sun);
                        art=mix(art,ink*0.28,headland);
                        art=mix(art,seat*0.45+cream*(0.10+0.06*sin(print.y*85.0)),tide);
                        c=mix(cream*0.86,art,artwork*block*inside);
                        c=mix(c,cream*0.22,type*inside*0.75*0.4/(0.4+soft*8.0));
                        if(hung){
                            // The cards hung over the aisle are loud: two posters side by side,
                            // flat colour, a big round shape and bold diagonal bands.
                            float leaf=step(0.0,q.x);
                            vec2 pp=vec2(q.x*2.0-(leaf*2.0-1.0),q.y);
                            float pick=fract(id*5.3+leaf*0.37);
                            vec3 red=vec3(0.78,0.13,0.09),green=seat*1.9+vec3(0.02,0.05,0.0),gold=warm*1.05,sea=sky*1.15;
                            vec3 ground=pick<0.25?red:pick<0.5?gold:pick<0.75?green:sea;
                            vec3 motif=pick<0.25?gold:pick<0.5?red:pick<0.75?gold:red;
                            float s2=fwidth(pp.y)*1.5;
                            float disc=1.0-smoothstep(0.42,0.42+s2,length(pp-vec2(0.18-0.4*fract(id*3.1),0.15)));
                            float bands=step(0.5,fract((pp.x+pp.y*0.7)*1.6+id*2.0))*step(pp.y,-0.25);
                            vec3 pop=mix(ground,motif,disc);
                            pop=mix(pop,cream*0.9,bands*0.85);
                            float margin=smoothstep(0.86,0.84,max(abs(pp.x),abs(pp.y)));
                            float title=(1.0-smoothstep(0.03,0.03+s2,abs(pp.y-0.68)))*step(abs(pp.x+0.15),0.55);
                            pop=mix(pop,vec3(0.02),title*0.8);
                            c=mix(cream*0.9,mix(pop,cream*0.85,0.42*day),margin);
                        }
                    }else if(vPaint>13.5&&vPaint<14.5){
                        // The line over the door: every station a dot, this one filled in.
                        vec2 q=vec2(fract((vPos.z+4.3)/7.85+0.5)-0.5,vPos.y-3.2)*vec2(7.85,1.0);
                        float soft=fwidth(q.y)*1.2,stop=(fract(q.x/0.055+0.5)-0.5)*0.055;
                        float line=1.0-smoothstep(0.004,0.004+soft,abs(q.y+0.012));
                        float dot=1.0-smoothstep(0.011,0.011+soft,length(vec2(stop,q.y+0.012)));
                        float span=step(abs(q.x),0.4);
                        c=cream*0.86;
                        c=mix(c,seat*1.1,max(line,dot)*span*0.9);
                        c=mix(c,warm*0.9,dot*step(abs(q.x-0.11),0.027));
                        c=mix(c,cream*0.25,(1.0-smoothstep(0.006,0.006+soft,abs(q.y-0.04)))*step(abs(q.x),0.16)*0.6);
                    }else if(vPaint<10.5)c=cream*0.36;
                    else if(vPaint<11.5)c=warm*0.2+seat*0.04;
                    else if(vPaint<12.5)c=cream*0.64;
                    else if(vPaint<13.5)c=vec3(0.016,0.016,0.02)+warm*0.012;
                    else if(vPaint<15.5){
                        float rim=pow(1.0-clamp(abs(dot(n,v)),0.0,1.0),2.2)*smoothstep(-0.15,0.8,n.y);
                        c=shadowInk+cream*rim*0.021;
                    }else if(vPaint<16.5){
                        // The heater cover under the bench: glossy cream sheet with three
                        // bands of long slots, each band two rows staggered like brickwork.
                        float y=vPos.y-(FLOOR+0.15);
                        float bandC=clamp(floor(y/0.078+0.5),-1.0,1.0)*0.078;
                        float u=y-bandC,band=abs(u);
                        float inBand=1.0-smoothstep(0.025,0.028,band);
                        float row=step(0.0,u);
                        vec2 cell=vec2(vPos.z/0.058+row*0.5+bandC*3.2,0.0);
                        vec2 slot=vec2((fract(cell.x)-0.5)*0.058,u-(row*2.0-1.0)*0.012);
                        vec2 d=abs(slot)-vec2(0.02,0.0042);
                        float sd=length(max(d,0.0))+min(max(d.x,d.y),0.0)-0.0035;
                        float soft=max(fwidth(vPos.z),fwidth(vPos.y))*1.2;
                        float hole=(1.0-smoothstep(-soft,soft,sd))*inBand;
                        hole=mix(hole,0.34*inBand,smoothstep(0.25,1.0,fwidth(cell.x)*2.0));
                        float frame=1.0-smoothstep(0.0,0.003+soft,abs(band-0.027));
                        c=cream*mix(0.78,0.7,inBand)*(1.0-0.12*frame);
                        c=mix(c,vec3(0.012,0.012,0.014),hole);
                        shine=reflectTubes(vPos,reflect(-v,n),0.12)*0.22*(1.0-hole);
                    }else if(vPaint<17.5){
                        float slot=abs(fract(vPos.x*33.0)-0.5);
                        float slat=smoothstep(0.23,0.35+fwidth(vPos.x)*16.0,slot+n.x*0.016);
                        float lip=1.0-smoothstep(0.012,0.064,abs(slot-0.34));
                        c=cream*mix(0.22,0.6,slat)+light*lip*0.035;
                    }else if(vPaint>21.5){
                        // Hand straps: white moulded grips on pale bands.
                        c=cream*0.86+vec3(0.03);
                        shine=reflectTubes(vPos,reflect(-v,n),0.2)*0.12;
                    }else if(vPaint>20.5){
                        // The cab is painted a quiet grey-green, smooth, a little gloss.
                        c=mix(mix(vec3(0.13,0.16,0.14),cream*0.4,0.25),vec3(0.55,0.555,0.55),day);
                        shine=reflectTubes(vPos,reflect(-v,n),0.2)*0.08;
                    }else if(vPaint>19.5){
                        // Brushed stainless: it takes the cream of the car and the wood of the floor, grained across.
                        // Brushed stainless: low down it holds the floor's honey, higher the cream and the lamps.
                        float grain=0.9+0.2*texture2D(detail,vec2(vPos.x*0.7+vPos.z*0.7,vPos.y*9.0)).g;
                        vec3 r=reflect(-v,n);
                        float low=smoothstep(-0.35,0.25,r.y)*smoothstep(FLOOR+0.03,FLOOR+0.4,vPos.y);
                        c=mix(vec3(0.30,0.21,0.12),mix(cream*0.62,vec3(0.56,0.58,0.6),0.5),low)*grain;
                        // Brushed: too rough for a picture, it holds the floor's warmth below,
                        // the wall across, the lit roof above, and a bright line along its top.
                        vec3 floorTone=mix(vec3(0.33,0.285,0.21),vec3(0.42,0.33,0.22),day)*seen*0.8;
                        vec3 soft=mix(floorTone,cream*0.62*seen,smoothstep(-0.45,0.05,r.y));
                        soft=mix(soft,cream*seen*1.1,smoothstep(0.25,0.8,r.y));
                        float lip=smoothstep(FLOOR+0.57,FLOOR+0.625,vPos.y);
                        env=(soft*(0.85+0.15*grain)+seen*lip*0.6)*0.9;
                        chrome=0.8;
                        shine=reflectTubes(vPos,r,0.14)*0.45;
                    }else{
                        c=mix(seat,vec3(0.061,0.084,0.035),0.58)*0.66;
                        shine=reflectTubes(vPos,reflect(-v,n),0.28)*0.06;
                    }
                    // Two tube rows and a cooler ambient contribution entering through the windows.
                    float direct=(tubeLux(vPos,n,-1.0)+tubeLux(vPos,n,1.0))*0.77*(1.0-0.72*sunset);
                    float wall=1.0-smoothstep(0.93,1.27,abs(vPos.x))*smoothstep(2.8,3.18,vPos.y)*0.24;
                    vec3 fill=mix(vec3(0.075,0.072,0.045),vec3(0.40,0.38,0.32),day);
                    fill*=0.70+0.30*smoothstep(FLOOR,2.7,vPos.y);
                    float windowFill=smoothstep(0.35,1.24,abs(vPos.x))
                        *(1.0-smoothstep(0.22,1.22,abs(vPos.y-2.55)));
                    fill+=mix(sky,sky*vec3(1.0,0.93,0.8),day)*windowFill*mix(0.23,0.13,day);
                    // At sunset the car is lit from outside: an amber fill, the lamps nearly out.
                    fill=mix(fill,mix(vec3(0.20,0.105,0.06),vec3(0.46,0.42,0.36),day)*(0.75+0.25*windowFill),sunset*0.85);
                    float lit=wall;
                    // Corners gather shadow: where the walls meet the floor and the ceiling.
                    if(!floorboards)lit*=0.55+0.45*smoothstep(FLOOR,FLOOR+0.3,vPos.y);
                    else lit*=1.0-0.3*smoothstep(1.02,1.25,abs(vPos.x));
                    lit*=1.0-0.22*smoothstep(3.05,3.32,vPos.y)*smoothstep(1.05,1.26,abs(vPos.x));
                    if(vPaint<2.5||enamel){
                        float overhead=exp(-abs(vPos.y-3.09)*23.0)*smoothstep(0.90,1.12,abs(vPos.x));
                        lit*=1.0-0.14*overhead;
                    }
                    // Under the benches the floor is in their shadow.
                    float bench=step(-3.65,vPos.z)*step(vPos.z,2.9)+step(4.2,vPos.z);
                    if(floorboards)lit*=mix(1.0,1.0-0.78*smoothstep(0.62,0.9,abs(vPos.x)),bench);
                    // Whoever sits on a bench darkens it under and behind them, and the floor at their feet.
                    float sat=0.0,stood=0.0;
                    if(cushion||floorboards){
                        for(int i=0;i<${SITTERS.length};i++){
                            vec2 who=SAT[i];
                            float along=vPos.z-who.y,across=abs(vPos.x)-${(CAR.half - 0.04 - 0.36).toFixed(3)};
                            if(who.x*vPos.x<0.0)continue;
                            sat=max(sat,exp(-along*along/0.05-across*across/0.08));
                            stood=max(stood,exp(-along*along/0.05-(across+0.46)*(across+0.46)/0.03));
                        }
                    }
                    if(cushion){
                        float crease=exp(-abs(vPos.y-(FLOOR+0.45))*25.0)*smoothstep(0.92,1.12,abs(vPos.x));
                        lit*=(1.0-0.42*sat)*(1.0-0.37*crease);
                    }
                    sat*=1.0-empty;stood*=1.0-empty;
                    if(floorboards){lit*=1.0-0.4*stood;shine*=1.0-0.7*stood;}
                    // By night the lamps are up by the roof: what is low down is in their dusk,
                    // the underside of a cushion is dark, and its rolled top shines like satin.
                    if(!floorboards&&!cushion&&vPaint<15.5||vPaint>16.5)lit*=mix(mix(0.6,1.06,smoothstep(FLOOR+0.35,CEILING-0.1,vPos.y)),1.0,day*0.6);
                    if(cushion){
                        lit*=0.5+0.5*smoothstep(-0.7,0.35,n.y)+0.25*smoothstep(0.5,0.95,n.y);
                        shine=max(shine,reflectTubes(vPos,reflect(-v,n),0.45)*0.22*smoothstep(0.2,0.9,n.y));
                    }
                    vec3 lamp=light*(0.15*(1.0-0.6*sunset)+direct);
                    vec3 colour=c*lit*(fill+lamp)+shine*mix(light,vec3(0.66,0.79,0.84),metal?0.42:0.12)*(1.0-0.5*sunset);
                    colour=mix(colour,env+shine*light*0.5,chrome);
                    float sun=sunPatch(vPos,n)*sunset;
                    vec3 sunlight=mix(vec3(2.6,1.25,0.48),vec3(1.25,1.12,0.9),day);
                    colour+=c*sun*sunlight*(1.0-0.5*float(metal))+sun*sunlight*shine*0.6;
                    if(vPaint>4.5&&vPaint<6.5)colour=c*(1.0-0.6*sunset);
                    // At night the cab sits a shade darker than the saloon behind it.
                    if(vPos.z<${(TIP + 1.38).toFixed(2)}&&!(vPaint>4.5&&vPaint<5.5))colour*=mix(0.8,1.0,day);
                    if(figure){
                        // People thin out as the car empties (the driver stays): a dither, so it stays one opaque pass.
                        const float B[16]=float[](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
                        ivec2 cell=ivec2(mod(gl_FragCoord.xy,4.0));
                        if((B[cell.x+cell.y*4]+0.5)/16.0<empty&&vPos.z>${(TIP + 1.35).toFixed(2)})discard;
                        colour=mix(c*0.83,cream*light*0.1*(0.6+0.4*smoothstep(-0.3,0.8,n.y)),0.4*(1.0-day))+sunlight*0.03*sunset;
                    }
                    // On the light page the car keeps to quiet paper tones.
                    colour=mix(colour,vec3(dot(colour,vec3(0.3,0.55,0.15))),0.28*day);
                    gl_FragColor=vec4(colour*power*0.82,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const saloon = new T.Mesh(saloonGeometry, saloonMaterial);
        saloon.name = 'trainSaloon'; saloon.visible = false; saloon.frustumCulled = false;
        // For the viewer only: from outside the windows already show it.
        saloon.layers.set(1);
        const innerGlassMaterial = material(new T.ShaderMaterial({
            side: T.DoubleSide,
            transparent: true,
            depthWrite: false,
            uniforms: { warm: glassMaterial.uniforms.warm, night: glassMaterial.uniforms.night, day: cabinDaylight,
                rain: cabinMood.rain, clock: cabinMood.clock },
            vertexShader: `varying vec3 vPos,vEye;
                void main(){
                    vPos=position;
                    vEye=(inverse(modelMatrix)*vec4(cameraPosition,1.0)).xyz;
                    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
                }`,
            fragmentShader: `uniform vec3 warm,night;uniform float day,rain,clock;
                varying vec3 vPos,vEye;
                ${cabinLightFunctions}
                ${RAIN_GLASS}
                void main(){
                    vec3 ray=normalize(vPos-vEye);
                    // The windscreen faces along the car; the rest face across it.
                    bool screen=abs(vPos.z-(${(TIP + 0.26).toFixed(3)}))<0.01&&abs(vPos.x)<1.2;
                    float grazing=pow(1.0-abs(screen?ray.z:ray.x),2.6);
                    if(screen)ray.z=-ray.z;else ray.x=-ray.x;
                    float hot=0.0;
                    if(ray.y>0.015){
                        float t=(TUBE_Y-vPos.y)/ray.y;
                        vec2 hit=vPos.xz+ray.xz*t;
                        float range=smoothstep(0.04,0.25,t)*(1.0-smoothstep(4.0,9.0,t));
                        hot=(tubes(hit,0.07)+0.20*tubes(hit+vec2(0.035,0.07),0.08))*range;
                    }
                    vec3 pane=mix(night*1.7+vec3(0.018,0.014,0.008),lampColour(warm,day)*0.86,clamp(hot*0.95,0.0,1.0));
                    float alpha=clamp(mix(0.23,0.14,day)+grazing*0.18+hot*0.46,0.0,0.78);
                    // Rain on the outside of the glass: beads and runnels catch the lamps at their rims.
                    vec3 wet=rainOnGlass(screen?vPos.xy:vec2(vPos.z*sign(vPos.x),vPos.y),clock,rain);
                    float rim=clamp(length(wet.xy)*90.0,0.0,1.0);
                    pane=mix(pane,lampColour(warm,day)*(0.12+0.75*rim)+night*0.8,wet.z*0.55);
                    alpha=max(alpha,wet.z*(0.1+0.32*rim));
                    gl_FragColor=vec4(pane,alpha);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        // The side panes, and the three panes of the windscreen seen from the cab side.
        const innerPaneGeometry = (() => {
            const position = Array.from(glassGeometry.attributes.position.array), index = Array.from(glassGeometry.index.array);
            const z = TIP + 0.26;
            CAB_WINDOWS.forEach(([x0, x1]) => {
                const b = position.length / 3;
                position.push(x0, 2.2, z, x1, 2.2, z, x1, 3.05, z, x0, 3.05, z);
                index.push(b, b + 1, b + 2, b, b + 2, b + 3);
            });
            const shape = new T.BufferGeometry();
            shape.setAttribute('position', new T.Float32BufferAttribute(position, 3));
            shape.setIndex(index);
            return geometry(shape);
        })();
        const innerGlass = new T.Mesh(innerPaneGeometry, innerGlassMaterial);
        innerGlass.layers.set(1);
        innerGlass.frustumCulled = false;
        innerGlass.renderOrder = 2;
        saloon.add(innerGlass);
        root.add(saloon);
        // The cab at the back of the train, seen through its own clear windscreens:
        // the same saloon, sharing its buffers, with a draw range of its own.
        const tailGeometry = new T.BufferGeometry();
        for (const name of Object.keys(saloonGeometry.attributes)) tailGeometry.setAttribute(name, saloonGeometry.attributes[name]);
        tailGeometry.userData.coarse = saloonGeometry.userData.coarse;
        geometry(tailGeometry);
        const tailSaloon = new T.Mesh(tailGeometry, saloonMaterial);
        tailSaloon.name = 'trainTailCab'; tailSaloon.visible = false; tailSaloon.matrixAutoUpdate = false;
        tailSaloon.layers.set(1);
        const flagTail = value => () => {
            if (saloonMaterial.uniforms.tailCab.value === value) return;
            saloonMaterial.uniforms.tailCab.value = value;
            saloonMaterial.uniformsNeedUpdate = true;
        };
        saloon.onBeforeRender = flagTail(0);
        tailSaloon.onBeforeRender = flagTail(1);
        root.add(tailSaloon);
        const placeSaloon = (track, front, visible) => {
            saloon.visible = visible;
            if (!visible) return;
            const reach = (CAR.length + CAR.joint) / 2, joint = front - CAR.length - CAR.joint / 2;
            const j = track.at(joint).position, own = track.at(joint + reach + CAR.bogie).position;
            const dx = own.x - j.x, dz = own.z - j.z, span = Math.hypot(dx, dz) || 1;
            saloon.position.set(j.x + dx / span * reach, 0, j.z + dz / span * reach);
            saloon.rotation.set(0, Math.atan2(-dx, -dz), 0);
        };
        const cabEye = new T.Vector3(), tailMatrixInverse = new T.Matrix4();
        const paintTrain = (upper, lower, gear, roof) => {
            const trim = roof.clone().lerp(upper, 0.46);
            // The roof is dressed in dull roofing, near black; its equipment is a pale weathered grey.
            const roofing = roof.clone().lerp(gear, 0.55).multiplyScalar(0.82);
            const rubber = gear.clone().lerp(roofing, 0.5).multiplyScalar(0.55);
            // Pressed-steel equipment on the roof: a dark weathered gunmetal, warmer than the roofing.
            const equipment = gear.clone().lerp(trim, 0.42).lerp(new T.Color('#5a5446'), 0.25);
            const lens = new T.Color('#c27a34').lerp(upper, 0.25);
            const colours = [upper, lower, gear, roofing, trim, trim.clone().lerp(gear, 0.32), gear.clone().lerp(trim, 0.38),
                    rubber, rubber.clone().lerp(equipment, 0.35), lens, equipment],
                attribute = carGeometry.attributes.color;
            carGeometry.userData.groups.forEach((group, i) => attribute.setXYZ(i, colours[group].r, colours[group].g, colours[group].b));
            attribute.needsUpdate = true;
        };
        const placeTrain = (track, front, visible) => {
            trainParts.forEach(mesh => { mesh.visible = visible; });
            if (!visible) { cars.count = glass.count = kits.count = trainEnds.count = 0; return; }
            cars.count = glass.count = CARS;
            // The saving tier stops short of the small fittings at the end of the car's index buffer.
            carGeometry.setDrawRange(0, quality === 'energy-saving' ? carGeometry.userData.coarse : Infinity);
            kits.count = CARS / 2;
            trainEnds.count = 2;
            const reach = (CAR.length + CAR.joint) / 2;
            for (let i = 0; i < CARS; i++) {
                // A car rides on its own bogie and on the one it shares at the
                // joint, so it follows the curve as a chord. The second car of
                // a set faces backwards.
                const set = i >> 1, second = i % 2 === 1;
                const joint = front - set * SET_PITCH - CAR.length - CAR.joint / 2;
                const j = track.at(joint).position;
                const own = track.at(joint + (second ? -1 : 1) * (reach + CAR.bogie)).position;
                const dx = own.x - j.x, dz = own.z - j.z, span = Math.hypot(dx, dz) || 1;
                dummy.position.set(j.x + dx / span * reach, 0, j.z + dz / span * reach);
                dummy.rotation.set(0, Math.atan2(-dx, -dz), 0);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                cars.setMatrixAt(i, dummy.matrix);
                glass.setMatrixAt(i, dummy.matrix);
                if (i === 0 || i === CARS - 1) trainEnds.setMatrixAt(i === 0 ? 0 : 1, dummy.matrix);
                if (i === 1) cabinGlow.position.set(dummy.position.x, 2.4, dummy.position.z);
                if (!second) {
                    const a = track.at(joint + 1).position, b = track.at(joint - 1).position;
                    dummy.position.set(j.x, 0, j.z);
                    dummy.rotation.set(0, Math.atan2(-(a.x - b.x), -(a.z - b.z)), 0);
                    dummy.updateMatrix();
                    kits.setMatrixAt(set, dummy.matrix);
                }
            }
            cars.instanceMatrix.needsUpdate = glass.instanceMatrix.needsUpdate = kits.instanceMatrix.needsUpdate
                = trainEnds.instanceMatrix.needsUpdate = true;
        };
        const skyMat = material(new T.ShaderMaterial({
            side: T.BackSide, depthWrite: false,
            uniforms: {
                night: { value: new T.Color('#080f20') },
                horizon: { value: new T.Color('#415266') },
                cold: { value: new T.Color('#8bbfc8') },
                open: { value: 0 },
                // Fixed celestial moon direction, identical to the moon mesh offset.
                moonDir: { value: new T.Vector3(-210, 300, -420).normalize() },
                moonTint: { value: new T.Color('#cbdde8') },
                glowTint: { value: new T.Color('#415266') },
                moonGlow: { value: 1 },
                // The ride starts at dusk, the last of the sun going down behind
                // the far peak, and drifts into a dream later on.
                dusk: { value: 0 }, dream: { value: 0 },
                duskHigh: { value: new T.Color('#4a5878') }, sunset: { value: new T.Color('#c97a52') },
                dreamTint: { value: new T.Color('#2a2350') },
                sunDir: { value: new T.Vector3(Math.cos(PEAK.bearing + 0.03), 0, Math.sin(PEAK.bearing + 0.03)) },
                horizonGlow: { value: 1 },
                accent: { value: 0 },
                auroraActive: { value: 1.0 },
                auroraTime: { value: 0.0 },
                auroraRhythm: { value: 0.0 },
                auroraHeading: { value: 0.0 },
                auroraGreen: { value: new T.Color('#22f09d') },
                auroraViolet: { value: new T.Color('#9d4edd') }
            },
            vertexShader: `varying vec3 ray;
                void main(){ray=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `varying vec3 ray;uniform vec3 night,horizon,cold,duskHigh,sunset,dreamTint,sunDir;
                uniform float open,dusk,dream;
                uniform vec3 moonDir,moonTint,glowTint;uniform float moonGlow,horizonGlow,accent;
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
                    // A dream deepens the zenith toward the theme's own night colour.
                    c=mix(c,dreamTint,dream*0.35*clamp(h*1.4,0.0,1.0));
                    if(dusk>0.0){
                        // Afterglow: warm and low over the sun's bearing, a band of
                        // rose above it, and the rest of the sky still blue, not black.
                        // Clamped: a GPU's pow() of a hair below zero is NaN, and one NaN in
                        // the sky spreads through the environment map onto everything lit.
                        float toward=clamp(0.5+0.5*dot(normalize(vec3(d.x,0.0,d.z)+vec3(0.0001)),sunDir),0.0,1.0);
                        float low=exp(-max(d.y,0.0)*6.0);
                        c=mix(c,duskHigh,dusk*0.55*(1.0-low));
                        c=mix(c,sunset,low*(0.2+0.8*pow(toward,3.0))*dusk*0.85);
                        float rose=(d.y-0.13)*8.0;
                        c=mix(c,sunset*vec3(1.0,0.8,0.9),exp(-rose*rose)*pow(toward,1.5)*dusk*0.3);
                    }
                    float across=dot(d,normalize(vec3(0.35,0.8,0.48)))-0.18;
                    float band=exp(-across*across*90.0);
                    float cloud=noise(d*12.0)*0.6+noise(d*33.0)*0.3+noise(d*91.0)*0.1;
                    c+=cold*band*pow(cloud,3.0)*(0.12+open*0.22);
                    // Moonlight scattering: a tight corona plus a wide, faint veil.
                    float md=max(dot(d,moonDir),0.0);
                    float corona=pow(md,220.0)*0.55+pow(md,48.0)*0.16+pow(md,7.0)*0.05;
                    c+=moonTint*corona*moonGlow*(0.85+cloud*0.3)*(1.0+accent*0.4);
                    // Residual light pooled at the horizon (distant towns, last dusk).
                    float rim=exp(-abs(d.y)*16.0)*(0.6+0.4*noise(vec3(d.xz*4.0,1.0)));
                    c+=glowTint*rim*horizonGlow*(0.1+open*0.08);
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
                        c += emission * sector * auroraActive
                            * (0.75 + auroraRhythm * 0.2 + accent * 0.55);
                    }
                    // Nothing that is not a number may leave the sky: through the lens and
                    // the environment map it would black out or flare everything near it.
                    if(any(isnan(c))||any(isinf(c)))c=vec3(0.0);
                    c=max(c,vec3(0.0));
                    gl_FragColor=vec4(c,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const sky = new T.Mesh(geometry(new T.SphereGeometry(850, 32, 20)), skyMat);
        sky.renderOrder = -100;
        root.add(sky);
        // What the lit materials outside see in their gloss: the same sky,
        // rendered small into a cube that the renderer blurs by roughness. The
        // cube is made once and only redrawn, so no material recompiles when
        // the palette, the dusk, the dream or the rain change what is in it.
        const envTarget = new T.WebGLCubeRenderTarget(64, { type: T.HalfFloatType });
        const envCamera = new T.CubeCamera(1, 2000, envTarget);
        const envScene = new T.Scene();
        const envSkyMat = material(new T.ShaderMaterial({
            side: T.BackSide, depthWrite: false,
            uniforms: { ...skyMat.uniforms, envGain: { value: 1 } },
            vertexShader: skyMat.vertexShader,
            fragmentShader: skyMat.fragmentShader.replace('uniform vec3 auroraGreen, auroraViolet;',
                'uniform vec3 auroraGreen, auroraViolet;uniform float envGain;')
                .replace('gl_FragColor=vec4(c,1.0);', 'gl_FragColor=vec4(c*envGain,1.0);')
        }));
        envScene.add(new T.Mesh(sky.geometry, envSkyMat));
        scene.environment = envTarget.texture;
        let envDirty = true, envKey = '';
        const prepareEnvironment = renderer => {
            if (dead || !envDirty || !renderer) return;
            envDirty = false;
            envCamera.update(renderer, envScene);
            envTarget.texture.needsPMREMUpdate = true;
        };
        const random = seededRandom('last-train-fixed-sky');
        const positions = [], colors = [], sizes = [], phases = [];
        // Lights of towns on the far shore come first in the buffer, so every
        // quality level keeps them. They sit in front of the ridge, low enough
        // to lay their own reflections on the water.
        const shore = seededRandom('last-train-far-shore');
        for (let town = 0; town < 7; town++) {
            const bearing = shore() * Math.PI * 2, spread = 0.05 + shore() * 0.09;
            for (let i = 0, count = 18 + Math.floor(shore() * 30); i < count; i++) {
                const angle = bearing + (shore() + shore() - 1) * spread;
                const radius = 600 + shore() * 30, tall = shore() > 0.93;
                positions.push(Math.cos(angle) * radius, tall ? 9 + shore() * 9 : 0.8 + shore() * shore() * 5,
                    Math.sin(angle) * radius);
                const brightness = 0.45 + shore() * 0.55, warm = shore();
                colors.push(brightness, brightness * (0.7 + warm * 0.2), brightness * (0.34 + warm * 0.4));
                sizes.push(1.5 + shore() * 1.5);
                phases.push(shore());
            }
        }
        const light = (bearing, radius, y, brightness, warm, size) => {
            positions.push(Math.cos(bearing) * radius, y, Math.sin(bearing) * radius);
            colors.push(brightness, brightness * (0.7 + warm * 0.2), brightness * (0.34 + warm * 0.4));
            sizes.push(size);
            phases.push(shore());
        };
        // The island: the harbour and the shrine town at its foot, a few lights up the slope.
        for (let i = 0; i < 70; i++) {
            const u = 0.1 + shore() * 0.85, climb = shore() * shore();
            light(ISLE.bearing + u * ISLE.reach, ISLE.radius - 2, 1 + climb * 18 * Math.sqrt(Math.max(0, 1 - u * u)),
                0.5 + shore() * 0.5, shore(), 1.8 + shore() * 1.4);
        }
        // Its bridge: a string of lamps from the island across to the land.
        for (let i = 0; i <= 30; i++) {
            light(ISLE.bearing + ISLE.reach * (0.96 + i / 30 * 1.5), ISLE.radius + i / 30 * 90, 3.2, 1, 0.75, 2.6);
        }
        // The tower: lit windows round the deck, the lantern, and the stem picked out below.
        const beaconAt = ISLE.bearing + ISLE.tower * ISLE.reach;
        const beaconFoot = ISLE.crest * Math.pow(1 - ISLE.tower * ISLE.tower, 0.55) * 0.9;
        for (let i = -3; i <= 3; i++) light(beaconAt + i * 0.75 / ISLE.radius, ISLE.radius - 3, beaconFoot + ISLE.height * 0.78, 1.2, 0.9, 2.2);
        for (let i = 1; i <= 6; i++) light(beaconAt, ISLE.radius - 3, beaconFoot + ISLE.height * 0.1 * i, 0.6, 1, 1.7);
        light(beaconAt, ISLE.radius - 3, beaconFoot + ISLE.height * 0.9, 1.8, 1, 5);
        const townLights = positions.length / 3;
        for (let i = 0; i < 8000; i++) {
            const y = random(), angle = random() * Math.PI * 2;
            const r = Math.sqrt(1 - y * y);
            positions.push(Math.cos(angle) * r * 780, y * 780, Math.sin(angle) * r * 780);
            const magnitude = Math.pow(random(), 5);
            const brightness = 0.25 + magnitude * 0.75;
            // Stellar temperature: most white-blue, a few warm giants.
            const warm = random() > 0.9 ? 1 : 0;
            colors.push(brightness * (0.86 + warm * 0.14), brightness * (0.93 - warm * 0.05),
                brightness * (1 - warm * 0.22));
            sizes.push(1.1 + magnitude * 2.8);
            phases.push(random());
        }
        const starGeo = geometry(new T.BufferGeometry());
        starGeo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
        starGeo.setAttribute('starColor', new T.Float32BufferAttribute(colors, 3));
        starGeo.setAttribute('starSize', new T.Float32BufferAttribute(sizes, 1));
        starGeo.setAttribute('phase', new T.Float32BufferAttribute(phases, 1));
        // Soft round stars; twinkle is a pure function of the playback clock.
        const starMat = material(new T.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: {
                time: { value: 0 }, opacity: { value: 0.8 }, twinkle: { value: 1 }, accent: { value: 0 },
                pixelRatio: { value: 1 }, tint: { value: new T.Color('#ffffff') }
            },
            vertexShader: `attribute vec3 starColor;attribute float starSize,phase;
                uniform float time,opacity,twinkle,pixelRatio,accent;
                varying vec3 vColor;varying float vAlpha;
                void main(){
                    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
                    float tw=0.5+0.5*sin(time*(0.6+phase*2.1)+phase*43.0);
                    float slow=0.5+0.5*sin(time*0.23+phase*17.0);
                    vColor=starColor*mix(1.0,0.5+0.5*tw*slow+0.25,twinkle);
                    // Chapter accent: stars surge in as a chorus opens.
                    vAlpha=opacity*(1.0+accent*0.45);
                    gl_PointSize=starSize*pixelRatio*(0.9+0.25*tw*twinkle);
                }`,
            fragmentShader: `uniform vec3 tint;varying vec3 vColor;varying float vAlpha;
                void main(){
                    vec2 p=gl_PointCoord*2.0-1.0;float r=dot(p,p);
                    if(r>1.0)discard;
                    float core=exp(-r*7.0);float halo=exp(-r*2.4)*0.32;
                    float a=(core+halo)*vAlpha;
                    gl_FragColor=vec4(vColor*tint*(core*1.25+halo),a);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        starMat.opacity = 0.8;
        const stars = new T.Points(starGeo, starMat);
        root.add(stars);
        // A gibbous moon with maria, a few ray craters and limb darkening. It
        // travels with the camera, so the viewing direction is a constant.
        const moonMat = material(new T.ShaderMaterial({
            uniforms: { color: { value: new T.Color('#cbdde8') },
                toViewer: { value: new T.Vector3(210, -300, 420).normalize() },
                sun: { value: new T.Vector3(210, -300, 420).normalize()
                    .add(new T.Vector3(0.62, 0.34, -0.2)).normalize() } },
            vertexShader: `varying vec3 surface;
                void main(){surface=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `varying vec3 surface;uniform vec3 color,toViewer,sun;
                float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
                float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),
                    mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                    mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                    mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
                float crater(vec3 p,vec3 at,float size){
                    float d=distance(p,normalize(at))/size;
                    return smoothstep(1.0,0.75,d)*-0.16+exp(-pow((d-1.0)*5.0,2.0))*0.2
                        +exp(-d*0.9)*0.12*step(1.0,d);}
                void main(){
                    vec3 p=normalize(surface);
                    float seas=smoothstep(0.46,0.66,noise(p*2.1+3.7)*0.62+noise(p*4.6)*0.38);
                    float albedo=0.96-seas*0.34+(noise(p*11.0)-0.5)*0.14+(noise(p*27.0)-0.5)*0.07;
                    albedo+=crater(p,vec3(0.25,-0.55,0.8),0.12)+crater(p,vec3(-0.2,0.1,0.95),0.08)
                        +crater(p,vec3(0.55,0.2,0.75),0.06)+crater(p,vec3(-0.5,-0.4,0.7),0.1)
                        +crater(p,vec3(0.1,0.6,0.7),0.07);
                    float limb=0.66+0.34*pow(max(dot(p,toViewer),0.0),0.55);
                    float lit=smoothstep(-0.12,0.26,dot(p,sun));
                    gl_FragColor=vec4(color*albedo*limb*mix(0.05,1.0,lit),1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const moonColor = moonMat.uniforms.color.value;
        const moon = new T.Mesh(geometry(new T.SphereGeometry(20, 32, 24)), moonMat);
        root.add(moon);
        const target = new T.WebGLRenderTarget(512, 320, { depthBuffer: true, type: T.HalfFloatType });
        const mirror = new T.PerspectiveCamera();
        const textureMatrix = new T.Matrix4();
        // How hard it is raining, 0..1; shared with every shader that shows it.
        const rainAmount = { value: 0 };
        const waterMat = material(new T.ShaderMaterial({
            depthWrite: true, transparent: false,
            uniforms: { reflection: { value: target.texture }, textureMatrix: { value: textureMatrix },
                time: { value: 0 }, strength: { value: 1 }, tint: { value: new T.Color('#10212d') },
                energy: { value: 0 },
                moonDir: { value: new T.Vector3(-210, 300, -420).normalize() },
                moonTint: { value: new T.Color('#cbdde8') }, glitter: { value: 1 },
                fogTint: { value: new T.Color('#415266') }, fogDensity: { value: 0.008 },
                lampTint: { value: new T.Color('#ffd28c') },
                lampPos: { value: Array.from({ length: 4 }, () => new T.Vector3()) },
                lampPower: { value: new Float32Array(4) }, rain: rainAmount, calm: { value: 0 },
                // Where the train wades: its nose, three points down its length and its tail.
                wake: { value: 0 }, wakePath: { value: Array.from({ length: 5 }, () => new T.Vector2()) } },
            vertexShader: `uniform mat4 textureMatrix;varying vec4 reflected;varying vec3 world;
                void main(){vec4 p=modelMatrix*vec4(position,1.0);world=p.xyz;reflected=textureMatrix*p;
                    gl_Position=projectionMatrix*viewMatrix*p;}`,
            fragmentShader: `uniform sampler2D reflection;uniform float time,strength,energy,glitter,fogDensity,rain,calm,wake;
                uniform vec3 tint,moonDir,moonTint,fogTint,lampTint;uniform vec2 wakePath[5];
                uniform vec3 lampPos[4];uniform float lampPower[4];
                varying vec4 reflected;varying vec3 world;
                float h21(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
                float n21(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                    return mix(mix(h21(i),h21(i+vec2(1.0,0.0)),f.x),mix(h21(i+vec2(0.0,1.0)),h21(i+vec2(1.0,1.0)),f.x),f.y);}
                // Rings spreading from where drops land: one drop per cell per
                // cycle, at its own place and time. Returns the slope of the surface.
                vec2 rings(vec2 p,float t,float seed){
                    vec2 cell=floor(p),g=vec2(0.0);
                    for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
                        vec2 c=cell+vec2(float(i),float(j));
                        float h=h21(c+seed);
                        vec2 centre=c+vec2(h21(c*1.7+seed+3.1),h21(c*2.3+seed+7.9));
                        float age=fract(t*(0.9+h*0.4)+h*7.0);
                        vec2 d=p-centre;float r=length(d);
                        float front=r-age*1.1;
                        float wave=sin(front*31.0)*exp(-front*front*90.0)*(1.0-age)*(1.0-age);
                        g+=d/max(r,0.001)*wave;
                    }
                    return g;
                }
                // The water the train pushes aside. Measured from the nearest stretch
                // of the train: how far back from the nose (s) and how far out from
                // the side of the car (h). Returns the slope; foam in w.
                vec3 stirred(vec2 p){
                    float best=1e9,s=0.0,d=0.0,run=0.0;vec2 tangent=vec2(0.0,1.0),side=vec2(1.0,0.0);
                    for(int i=0;i<4;i++){
                        vec2 a=wakePath[i],b=wakePath[i+1],ab=b-a;float len=max(length(ab),0.001);
                        vec2 t=ab/len;float u=dot(p-a,t);
                        // Ahead of the nose and beyond the tail the line runs on straight.
                        float lo=i==0?-1e4:0.0,hi=i==3?1e4:len;
                        float k=clamp(u,lo,hi);vec2 q=a+t*k;float e=length(p-q);
                        if(e<best){best=e;s=run+k;tangent=t;vec2 n=vec2(-t.y,t.x);d=dot(p-q,n);side=n*sign(d);}
                        run+=len;
                    }
                    float h=abs(d)-1.32,length_=run;
                    if(h<-0.2&&s>-0.3&&s<length_)return vec3(0.0);
                    vec2 g=vec2(0.0);float foam=0.0;
                    // Wash running out from the hull all along its length.
                    float beside=smoothstep(-1.0,0.5,s)*(1.0-smoothstep(length_,length_+6.0,s));
                    float hh=max(h,0.0);
                    float wash=sin(hh*6.5-time*8.0+s*0.7)*exp(-hh*0.55);
                    g+=side*wash*0.3*beside;
                    foam+=exp(-hh*2.6)*beside*(0.55+0.45*sin(s*1.3-time*5.0+hh*3.0));
                    // Two arms opening behind the nose at about twenty degrees.
                    float behind=max(s,0.0),arm=hh-0.36*behind;
                    float arms=sin(arm*4.5-time*5.0)*exp(-arm*arm*0.35)*exp(-behind/48.0)*smoothstep(-2.0,0.0,s);
                    g+=(side*0.8-tangent*0.35)*arms*0.28;
                    // Churned water closing in behind the last car.
                    float after=max(s-length_,0.0);
                    float trail=(1.0-smoothstep(1.2+after*0.12,2.6+after*0.18,abs(d)))*exp(-after/22.0)*step(length_,s);
                    g+=(vec2(n21(p*3.1+time*1.7),n21(p.yx*2.7-time*1.4))-0.5)*0.4*trail;
                    foam+=trail*0.6;
                    // The nose shoulders the water up in front of it.
                    float bow=exp(-pow(max(-s,0.0)*0.7,2.0))*(1.0-smoothstep(0.8,2.6,abs(d)))*step(s,0.0);
                    g-=tangent*bow*0.25;foam+=bow*0.5;
                    return vec3(g,foam);
                }
                void main(){
                    vec3 toCam=cameraPosition-world;float dist=length(toCam);vec3 v=toCam/max(dist,0.001);
                    // Analytic ripple normal: two swells and fine chop, damped with distance.
                    float damp=1.0/(1.0+dist*0.02);
                    vec2 g=vec2(0.0);
                    g+=vec2(0.65,0.0)*cos(world.z*0.65+world.x*0.12+time*0.45)*0.05;
                    g+=vec2(0.0,0.48)*-sin(world.x*0.48-time*0.32)*0.05;
                    g+=vec2(1.9,1.3)*cos(world.x*1.9+world.z*1.3+time*1.1)*0.018;
                    g+=vec2(-1.4,2.3)*cos(-world.x*1.4+world.z*2.3-time*0.9)*0.014;
                    // In the dream the sea goes still enough to be a mirror for the stars.
                    g*=damp*(1.0+energy*0.6)*(1.0-calm*0.75);
                    // Rain breaks the mirror up: rings near by, a fine roughness further off.
                    if(rain>0.0){
                        float nearRings=1.0-smoothstep(10.0,34.0,dist);
                        vec2 r=rings(world.xz*1.6,time,0.0)+rings(world.xz*2.3+17.0,time*1.13,5.0)*0.7;
                        g+=r*0.09*rain*nearRings;
                        g+=(vec2(n21(world.xz*7.0+time*3.0),n21(world.zx*6.0-time*2.7))-0.5)*0.05*rain*(1.0-nearRings*0.5);
                    }
                    // Where the train wades it stirs the mirror up, still or not.
                    float churn=0.0;vec2 stir=vec2(0.0);
                    if(wake>0.0){vec3 w=stirred(world.xz);stir=w.xy*wake;g+=stir;churn=clamp(w.z,0.0,1.0)*wake;}
                    vec3 n=normalize(vec3(-g.x,1.0,-g.y));
                    // The stirred water throws what it mirrors about far more than the swell does.
                    vec2 uv=reflected.xy/max(reflected.w,0.001)+n.xz*(0.018+energy*0.008+rain*0.03)+stir*0.07*damp;
                    float valid=step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0)*step(0.0,reflected.w);
                    vec3 r=texture2D(reflection,clamp(uv,0.001,0.999)).rgb;
                    // Schlick Fresnel for water (F0 ~ 0.02), lifted so the mirror reads at night.
                    float cosT=clamp(dot(n,v),0.0,1.0);
                    float f=0.1+0.9*(0.02+0.98*pow(1.0-cosT,5.0));
                    f=max(f,0.12+0.75*pow(1.0-abs(v.y),3.0));
                    vec3 c=mix(tint,r,clamp(f*strength*valid,0.0,0.94));
                    // Broken moon path: tight specular lobe sparked by a flickering facet grid.
                    vec3 refl=reflect(-v,n);
                    float lobe=pow(max(dot(refl,moonDir),0.0),260.0);
                    float wide=pow(max(dot(refl,moonDir),0.0),28.0)*0.08;
                    // Glints come and go as smooth patches, never as squares, and
                    // thin out right under the camera where each would fill the view.
                    float spark=smoothstep(0.55,0.9,n21(world.xz*vec2(9.0,4.6)+vec2(time*0.8,-time*0.5))
                        *n21(world.xz*vec2(2.1,1.1)-vec2(time*0.22))*2.0);
                    c+=moonTint*(lobe*(0.14+spark*1.0)*mix(0.1,1.0,smoothstep(8.0,40.0,dist))+wide)*glitter*strength;
                    // Vertical lamp streaks along the camera-lamp bearing.
                    for(int i=0;i<4;i++){
                        if(lampPower[i]<=0.0)continue;
                        vec2 cam=cameraPosition.xz;vec2 L=lampPos[i].xz-cam;float ld=length(L);
                        if(ld<0.5)continue;
                        vec2 dir=L/ld;vec2 rel=world.xz-cam;
                        float along=dot(rel,dir);float across=abs(rel.x*dir.y-rel.y*dir.x);
                        float width=0.18+ld*0.012;
                        float band=exp(-across*across/(width*width))
                            *smoothstep(ld*0.35,ld*0.8,along)*(1.0-smoothstep(ld*0.98,ld*1.08,along));
                        float shimmer=0.55+0.45*sin(along*5.0-time*2.2+n.x*20.0);
                        c+=lampTint*band*shimmer*lampPower[i]*0.55*strength;
                    }
                    // Broken water along the hull catches what light there is.
                    float lace=smoothstep(0.35,0.75,n21(world.xz*vec2(5.0,6.3)+vec2(time*1.3,-time*0.9)));
                    c=mix(c,c*1.35+fogTint*0.12+moonTint*0.03,churn*lace*0.4*strength);
                    // Match scene FogExp2 so the far plane melts into the horizon.
                    float fog=1.0-exp(-fogDensity*fogDensity*dist*dist);
                    c=mix(c,fogTint,clamp(fog,0.0,1.0));
                    gl_FragColor=vec4(c,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const water = new T.Mesh(geometry(new T.PlaneGeometry(1800, 1800)), waterMat);
        water.rotation.x = -Math.PI / 2;
        root.add(water);
        // Additive lamp halos: one soft point per lit lamp, reflected by the mirror pass too.
        const haloPositions = new Float32Array(64 * 3);
        const haloGeometry = geometry(new T.BufferGeometry());
        haloGeometry.setAttribute('position', new T.BufferAttribute(haloPositions, 3).setUsage(T.DynamicDrawUsage));
        haloGeometry.setDrawRange(0, 0);
        const haloMat = material(new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending,
            uniforms: { color: { value: new T.Color('#ffd28c') }, intensity: { value: 1 },
                size: { value: 1.6 }, pixelRatio: { value: 1 } },
            vertexShader: `uniform float size,pixelRatio;varying float vFade;
                void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;
                    float d=max(1.0,-mv.z);
                    gl_PointSize=clamp(size*pixelRatio*300.0/d,2.0,180.0);
                    vFade=1.0-smoothstep(70.0,150.0,d);}`,
            fragmentShader: `uniform vec3 color;uniform float intensity;varying float vFade;
                void main(){vec2 p=gl_PointCoord*2.0-1.0;float r=dot(p,p);
                    if(r>1.0)discard;
                    float core=exp(-r*22.0);float glow=exp(-r*4.5)*0.32;
                    float a=(core+glow)*intensity*vFade;
                    gl_FragColor=vec4(color*a,a);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const halos = new T.Points(haloGeometry, haloMat);
        halos.frustumCulled = false;
        root.add(halos);
        /*
         * Where the sea has come over the line the train wades. The nose
         * shoulders up a wave on either side, a curling crest with a slope of
         * foam behind it that opens out the faster it runs; the water heaped
         * against the sides breaks white; behind the last car a band of foam
         * lies on the sea and slowly comes apart. The wheels fling water out in
         * streaks that fall back. Everything is one mesh, laid out each frame
         * from the train's place and pace; the foam itself is drawn by the shader.
         */
        const SPLASH_VERTS = 2400, SPLASH_INDEX = 4200;
        const splashPositions = new Float32Array(SPLASH_VERTS * 3), splashUv = new Float32Array(SPLASH_VERTS * 2);
        const splashFoam = new Float32Array(SPLASH_VERTS * 2), splashLooks = new Float32Array(SPLASH_VERTS * 2);
        const splashIndex = new Uint16Array(SPLASH_INDEX);
        const splashGeometry = geometry(new T.BufferGeometry());
        [['position', splashPositions, 3], ['uv', splashUv, 2], ['foam', splashFoam, 2], ['look', splashLooks, 2]]
            .forEach(([name, array, size]) => splashGeometry.setAttribute(name,
                new T.BufferAttribute(array, size).setUsage(T.DynamicDrawUsage)));
        splashGeometry.setIndex(new T.BufferAttribute(splashIndex, 1).setUsage(T.DynamicDrawUsage));
        splashGeometry.setDrawRange(0, 0);
        const splashSeeds = (() => {
            const r = seededRandom('wading');
            return Float32Array.from({ length: 1024 }, () => r());
        })();
        const splashTint = { value: new T.Color('#dfe6e8') }, splashWarm = { value: new T.Color('#ffd28c') };
        const splashClock = { value: 0 };
        const splashMaterial = material(new T.ShaderMaterial({
            transparent: true, depthWrite: false, side: T.DoubleSide,
            uniforms: { tint: splashTint, warm: splashWarm, clock: splashClock },
            vertexShader: `attribute vec2 foam,look;varying vec2 vUv,vFoam,vLook;varying float vFar,vNear;
                void main(){vUv=uv;vFoam=foam;vLook=look;
                    vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;
                    vFar=1.0-smoothstep(70.0,140.0,-mv.z);vNear=0.35+0.65*smoothstep(2.0,9.0,-mv.z);}`,
            fragmentShader: `uniform vec3 tint,warm;uniform float clock;varying vec2 vUv,vFoam,vLook;varying float vFar,vNear;
                float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
                float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
                float cells(vec2 p){
                    // Foam is a net of bubbles torn open into lace: ridges of a warped noise.
                    vec2 w=p+vec2(noise(p*0.7+clock*0.3),noise(p*0.7-clock*0.25))*1.6;
                    float n=noise(w*2.1)*0.55+noise(w*4.7)*0.3+noise(w*11.0)*0.15;
                    return 1.0-abs(n*2.0-1.0);
                }
                void main(){
                    float a;float lit=0.0;
                    if(vLook.x<0.5){
                        // Foam on the surface: v runs 0 at the hull to 1 at the far edge,
                        // the crest a little way out; whitest there, lace beyond it.
                        float v=vUv.y;
                        float lace=cells(vFoam);
                        float crest=exp(-pow((v-0.26)/0.05,2.0))*(0.55+0.45*noise(vFoam*3.0));
                        float body=smoothstep(0.74+0.18*v,0.97,lace+0.22*(1.0-v));
                        float film=smoothstep(0.5,0.9,lace)*0.12;
                        // The far edge is torn, never ruled: where it fades wanders with a broad noise.
                        float edge=v+(noise(vFoam*0.9+3.1)-0.5)*0.55;
                        a=(crest*0.85+body*(0.6-0.45*v)+film)*smoothstep(0.95,0.35,edge)*smoothstep(0.0,0.06,v+0.06);
                        a*=smoothstep(0.0,0.22,vUv.x+(noise(vFoam*1.1)-0.5)*0.12)*smoothstep(1.0,0.65,vUv.x);
                        lit=(1.0-v)*0.5;
                    }else{
                        // A streak of thrown water: dense at its head, thinning to its tail.
                        float across=vUv.y*2.0-1.0;
                        a=exp(-across*across*5.0)*(1.0-vUv.x)*(0.6+0.4*noise(vec2(vUv.x*6.0,vLook.y*40.0)));
                        lit=0.6;
                    }
                    a*=vLook.y*vFar*vNear;
                    if(a<0.004)discard;
                    gl_FragColor=vec4(mix(tint,warm,lit*0.35),min(1.0,a));
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const splash = new T.Mesh(splashGeometry, splashMaterial);
        splash.frustumCulled = false;
        splash.renderOrder = 3;
        splash.name = 'splash';
        root.add(splash);
        let splashSpeed = 0, splashFront = null, splashTime = 0, wading = 0;
        const eye = new T.Vector3(), flight = new T.Vector3(), broad = new T.Vector3(), toEye = new T.Vector3(), ahead = new T.Vector3();
        const wade = (track, pose, time, level, saving, visible) => {
            const front = pose.trainFront ?? pose.distance;
            // The train's own pace along the line, steadied over a few frames.
            let speed = splashSpeed;
            if (track.trainAt) speed = (track.trainAt(time + 0.15) - track.trainAt(time - 0.15)) / 0.3;
            else if (splashFront !== null && time > splashTime && time - splashTime < 0.5)
                speed = splashSpeed * 0.85 + 0.15 * (front - splashFront) / (time - splashTime);
            splashFront = front; splashTime = time; splashSpeed = speed;
            // The rail head is at 0.41: nothing until the water is over it.
            wading = visible ? smooth((level - 0.3) / 0.12) * smooth(Math.abs(speed) / 7) : 0;
            splash.visible = wading > 0.01;
            if (!splash.visible) return;
            const night = !palBase?.light;
            splashTint.value.copy(dressTones[TONE.pale]).multiplyScalar(night ? 0.6 : 1.1);
            splashWarm.value.copy(night ? roomGlow : dressTones[TONE.pale]).multiplyScalar(night ? 1.1 : 1.1);
            splashClock.value = time;
            eye.set(pose.position.x, pose.position.y, pose.position.z);
            const pace = Math.min(1.6, Math.abs(speed) / 12);
            let v = 0, n = 0;
            const vertex = (x, y, z, u, w, fx, fz, kind, alpha) => {
                splashPositions.set([x, y, z], v * 3);
                splashUv.set([u, w], v * 2);
                splashFoam.set([fx, fz], v * 2);
                splashLooks.set([kind, alpha * wading], v * 2);
                return v++;
            };
            const at = (address, lateral) => {
                const f = track.at(address);
                return [f.position.x + f.right.x * lateral, f.position.z + f.right.z * lateral];
            };
            /*
             * A band of foam on the water: rows along it, each row a cross-section
             * of [lateral, height, across] points; `foamAt` says where on the water
             * each point's lace is drawn.
             */
            const band = (rows, foamAt) => {
                const width = rows[0].points.length, first = v;
                if (v + rows.length * width > SPLASH_VERTS) return;
                rows.forEach(({ address, u, points, alpha }) => points.forEach(([lateral, y, across]) => {
                    const [x, z] = at(address, lateral);
                    const [fx, fz] = foamAt(address, lateral, y);
                    vertex(x, y, z, u, across, fx, fz, 0, alpha);
                }));
                for (let r = 0; r < rows.length - 1; r++) for (let k = 0; k < width - 1; k++) {
                    if (n + 6 > SPLASH_INDEX) return;
                    const a = first + r * width + k, b = a + width;
                    splashIndex.set([a, b, a + 1, a + 1, b, b + 1], n);
                    n += 6;
                }
            };
            // Lace that travels with the train, churning as it goes.
            const carried = (address, lateral) => [(front - address) * 0.9 - time * 2.4 * pace, Math.abs(lateral) * 1.3];
            // Lace that stays where it was left on the sea.
            const left = (address, lateral) => [address * 0.9, lateral * 1.3];
            const length = SET_PITCH * CARS / 2, tail = front - length;
            for (const side of [-1, 1]) {
                // The bow wave: from the nose's shoulder out and back along an arm.
                const arm = 5 + 7 * pace, open = 0.24 + 0.08 * pace, segments = saving ? 8 : 16;
                band(Array.from({ length: segments + 1 }, (_, k) => {
                    const u = k / segments, behind = u * arm - 0.4, reach = 1.32 + Math.max(0, behind) * open;
                    const lift = (0.12 + 0.06 * pace) * (1 - u * 0.8);
                    return { address: front - behind, u, alpha: 1 - u * 0.5, points: [
                        [side * 1.3, level + lift * 0.7, 0], [side * (reach - 0.05), level + lift, 0.22],
                        [side * reach, level + lift * 0.9, 0.3], [side * (reach + 0.5 + u), level + lift * 0.3, 0.6],
                        [side * (reach + 0.9 + 1.5 * u), level + 0.01, 1]] };
                }), carried);
                // The wave stands up off its crest near the nose in a thin, torn sheet.
                band(Array.from({ length: segments + 1 }, (_, k) => {
                    const u = k / segments * 0.6, behind = u * arm - 0.4, reach = 1.32 + Math.max(0, behind) * open;
                    const lift = (0.12 + 0.06 * pace) * (1 - u * 0.8), rise = (0.14 + 0.2 * pace) * Math.pow(1 - u / 0.6, 1.4);
                    return { address: front - behind, u: u / 0.6, alpha: 0.85, points: [
                        [side * reach, level + lift * 0.9, 0.24], [side * (reach + 0.1), level + lift + rise * 0.55, 0.4],
                        [side * (reach + 0.28), level + lift + rise, 0.8]] };
                }), (address, lateral, y) => [(front - address) * 1.4 - time * 3 * pace, y * 6]);
                // Water heaped and breaking along the sides of the train.
                const hull = saving ? 10 : 24;
                band(Array.from({ length: hull + 1 }, (_, k) => {
                    const u = k / hull, address = front - arm * 0.3 - u * (length - arm * 0.3);
                    return { address, u: 0.08 + u * 0.84, alpha: 0.32, points: [
                        [side * 1.28, level + 0.09, 0], [side * 1.5, level + 0.06, 0.28], [side * 2.2, level + 0.01, 1]] };
                }), carried);
            }
            // The wake: foam left on the sea behind the last car, spreading and fading.
            const trail = 22 + 34 * pace, wake = saving ? 12 : 30;
            band(Array.from({ length: wake + 1 }, (_, k) => {
                const u = k / wake, behind = u * trail, width = 1.5 + behind * 0.14;
                return { address: tail - behind, u: 0.1 + u * 0.9, alpha: 0.7 * (1 - u), points: [
                    [-width - 1, level + 0.01, 1], [-width * 0.4, level + 0.015, 0.3], [0, level + 0.02, 0.24],
                    [width * 0.4, level + 0.015, 0.3], [width + 1, level + 0.01, 1]] };
            }), left);
            // Water thrown off the wheels: each streak flies out, up and back from
            // its bogie, drawn along its own line of flight and turned to the eye.
            const bogies = [];
            for (let car = 0; car < CARS; car++) {
                const set = car >> 1, second = car % 2 === 1;
                const joint = front - set * SET_PITCH - CAR.length - CAR.joint / 2;
                bogies.push(joint + (second ? -1 : 1) * (CAR.length / 2 + CAR.joint / 2 + CAR.bogie));
                if (!second) bogies.push(joint);
            }
            const streaks = saving ? 7 : 16;
            let s = 0;
            for (const bogie of bogies) for (const side of [-1, 1]) for (let k = 0; k < streaks; k++, s = (s + 4) % 1020) {
                if (v + 4 > SPLASH_VERTS || n + 6 > SPLASH_INDEX) break;
                const life = (splashSeeds[s] + time * (1.4 + splashSeeds[s + 1])) % 1, t = life * 0.6;
                const out = (1.6 + splashSeeds[s + 2] * 2.2) * pace, rise = (1.5 + splashSeeds[s + 3] * 2.4) * pace;
                const lateral = side * (1.15 + out * t), height = level + Math.max(0, rise * t - 4.9 * t * t);
                const address = bogie + (splashSeeds[s + 2] - 0.5) * 1.6 - speed * t * 0.7;
                const [x, z] = at(address, lateral);
                const f = track.at(address);
                // Velocity relative to the water: outward, up or falling, and left behind.
                flight.set(f.right.x * side * out, rise - 9.8 * t, f.right.z * side * out)
                    .addScaledVector(ahead.set(f.right.z, 0, -f.right.x), -speed * 0.7);
                const reach = 0.05 + flight.length() * 0.045;
                flight.normalize();
                toEye.set(eye.x - x, eye.y - height, eye.z - z).normalize();
                broad.crossVectors(flight, toEye).normalize().multiplyScalar(0.012 + 0.02 * splashSeeds[s + 1]);
                const alpha = (1 - life) * 0.8;
                const head = [x, height, z], back = [x - flight.x * reach, height - flight.y * reach, z - flight.z * reach];
                const a = vertex(head[0] + broad.x, head[1] + broad.y, head[2] + broad.z, 0, 0, 0, 0, 1, alpha);
                vertex(head[0] - broad.x, head[1] - broad.y, head[2] - broad.z, 0, 1, 0, 0, 1, alpha);
                vertex(back[0] + broad.x, back[1] + broad.y, back[2] + broad.z, 1, 0, 0, 0, 1, alpha);
                vertex(back[0] - broad.x, back[1] - broad.y, back[2] - broad.z, 1, 1, 0, 0, 1, alpha);
                splashIndex.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], n);
                n += 6;
            }
            splashGeometry.setDrawRange(0, n);
            for (const name of ['position', 'uv', 'foam', 'look']) splashGeometry.attributes[name].needsUpdate = true;
            splashGeometry.index.needsUpdate = true;
        };
        // --- Rain (stage setting: off / light / heavy) ---
        // Streaks fall through a box that travels with the camera but stays
        // put in the world, so they slide past as the camera moves. All of the
        // motion is in the vertex shader; the CPU only sets a few uniforms.
        // Nothing falls inside the car the camera is riding in.
        const RAIN_MAX = 14000, RAIN_BOX = 34, RAIN_HEIGHT = 18;
        const rainSeeds = new Float32Array(RAIN_MAX * 4 * 3), rainCorners = new Float32Array(RAIN_MAX * 4 * 2);
        const rainIndex = new Uint32Array(RAIN_MAX * 6);
        {
            const drop = seededRandom('diorama-rain');
            for (let i = 0; i < RAIN_MAX; i++) {
                const seed = [drop(), drop(), drop()];
                [[-1, 0], [1, 0], [1, 1], [-1, 1]].forEach(([x, y], k) => {
                    rainSeeds.set(seed, (i * 4 + k) * 3);
                    rainCorners.set([x, y], (i * 4 + k) * 2);
                });
                rainIndex.set([0, 1, 2, 0, 2, 3].map(v => v + i * 4), i * 6);
            }
        }
        const rainGeometry = geometry(new T.BufferGeometry());
        rainGeometry.setAttribute('position', new T.BufferAttribute(rainSeeds, 3));
        rainGeometry.setAttribute('corner', new T.BufferAttribute(rainCorners, 2));
        rainGeometry.setIndex(new T.BufferAttribute(rainIndex, 1));
        rainGeometry.setDrawRange(0, 0);
        const rainMat = material(new T.ShaderMaterial({
            // A streak's two sides swap with the angle it is seen at; draw both.
            transparent: true, depthWrite: false, side: T.DoubleSide,
            uniforms: { time: { value: 0 }, amount: rainAmount, centre: { value: new T.Vector3() },
                colour: { value: new T.Color('#c9d6e0') }, opacity: { value: 0.3 },
                wind: { value: new T.Vector2(0.9, 0.35) },
                shelterA: { value: new T.Vector3() }, shelterB: { value: new T.Vector3() }, shelter: { value: 0 },
                lampAt: { value: Array.from({ length: 4 }, () => new T.Vector3(0, -100, 0)) },
                lampTint: { value: new T.Color('#ffd28c') }, lampGain: { value: 1 } },
            vertexShader: `attribute vec2 corner;
                uniform float time,amount,shelter,lampGain;uniform vec3 centre,shelterA,shelterB;uniform vec2 wind;
                uniform vec3 lampAt[4];
                varying float vAlpha;varying float vAcross;varying float vGlow;
                const float BOX=${RAIN_BOX.toFixed(1)},HEIGHT=${RAIN_HEIGHT.toFixed(1)};
                void main(){
                    float fall=7.5+position.z*2.5;
                    vec3 p;
                    p.x=centre.x+(fract((position.x*BOX-centre.x)/BOX)-0.5)*BOX;
                    p.z=centre.z+(fract((position.z*BOX*1.618-centre.z)/BOX)-0.5)*BOX;
                    float drop=fract(position.y-time*fall/HEIGHT);
                    p.y=max(centre.y,2.0)-HEIGHT*0.4+drop*HEIGHT;
                    vec3 v=vec3(wind.x,-fall,wind.y);
                    // A streak is as long as the drop falls while the shutter is open.
                    vec3 tail=p-v*(0.03+fract(position.y*13.7)*0.025);
                    vec3 head=mix(p,tail,corner.y);
                    vec3 toCam=normalize(cameraPosition-head);
                    vec3 side=normalize(cross(normalize(v),toCam));
                    float dist=distance(cameraPosition,p);
                    float width=0.003+dist*0.0011;
                    head+=side*corner.x*width;
                    // Inside the car the camera rides in, nothing falls.
                    vec3 ab=shelterB-shelterA;
                    float k=clamp(dot(p-shelterA,ab)/max(dot(ab,ab),0.001),0.0,1.0);
                    vec3 q=p-(shelterA+ab*k);
                    float inside=shelter*step(length(q.xz),1.45)*step(p.y,4.1);
                    // Close drops are out of focus and faint; far ones thin into the haze.
                    vAlpha=(1.0-inside)*smoothstep(0.6,3.5,dist)*(1.0-smoothstep(BOX*0.18,BOX*0.5,dist))
                        *step(0.0,p.y)*(0.35+0.65*fract(position.x*91.3));
                    vAcross=corner.x;
                    // Drops falling through a lamp's light catch it.
                    vGlow=0.0;
                    for(int i=0;i<4;i++){vec3 l=p-lampAt[i];vGlow+=1.0/(1.0+dot(l,l)*0.35);}
                    vGlow*=lampGain;
                    gl_Position=projectionMatrix*viewMatrix*vec4(head,1.0);
                    if(vAlpha<=0.0)gl_Position=vec4(2.0,2.0,2.0,1.0);
                }`,
            fragmentShader: `uniform vec3 colour,lampTint;uniform float opacity;
                varying float vAlpha;varying float vAcross;varying float vGlow;
                void main(){
                    float a=vAlpha*opacity*(1.0-vAcross*vAcross)*(1.0+vGlow*2.5);
                    if(a<0.004)discard;
                    gl_FragColor=vec4(colour+lampTint*vGlow*1.5,min(a,0.9));
                    #include <colorspace_fragment>
                }`
        }));
        const rainDrops = new T.Mesh(rainGeometry, rainMat);
        rainDrops.frustumCulled = false;
        rainDrops.visible = false;
        rainDrops.renderOrder = 5;
        // For the viewer only: the mirror pass would draw every streak twice.
        rainDrops.layers.set(1);
        root.add(rainDrops);
        // Every tier rains; the saving tier with far fewer streaks.
        const RAIN_COUNTS = { 'energy-saving': 4000, standard: 9000, ultimate: RAIN_MAX };
        // The light under each of the nearest lamps, seen as a cone in the
        // haze: faint on a clear night, plain in the rain. One draw for all.
        const BEAMS = 6;
        const beamMat = material(new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
            uniforms: { haze: { value: 0 } },
            vertexShader: `varying vec3 vColour;varying float vDown;varying vec3 vNormal;varying vec3 vView;
                void main(){
                    vColour=instanceColor;vDown=uv.y;
                    vec4 world=modelMatrix*instanceMatrix*vec4(position,1.0);
                    vNormal=normalize(mat3(modelMatrix*instanceMatrix)*normal);
                    vView=normalize(cameraPosition-world.xyz);
                    gl_Position=projectionMatrix*viewMatrix*world;
                }`,
            fragmentShader: `uniform float haze;varying vec3 vColour;varying float vDown;varying vec3 vNormal;varying vec3 vView;
                void main(){
                    // Brightest down the middle of the cone as seen, fading to the ground.
                    float edge=abs(dot(normalize(vNormal),vView));
                    float a=pow(edge,1.5)*pow(vDown,1.6)*haze;
                    gl_FragColor=vec4(vColour*a,1.0);
                }`
        }));
        const beams = new T.InstancedMesh(geometry(new T.ConeGeometry(2.1, 5.4, 20, 1, true).translate(0, -2.7, 0)),
            beamMat, BEAMS);
        beams.instanceMatrix.setUsage(T.DynamicDrawUsage);
        for (let i = 0; i < BEAMS; i++) beams.setColorAt(i, new T.Color(0, 0, 0));
        beams.frustumCulled = false;
        beams.count = 0;
        beams.layers.set(1);
        root.add(beams);
        const beamMatrix = new T.Matrix4(), beamColour = new T.Color();
        const RAIN_LEVELS = { off: 0, light: 0.45, heavy: 1 };
        let rainLevel = 0, rainClock = 0;
        // The sea's height. Scenery may raise it a little where the line runs
        // through shallow water; the mirror follows it.
        let waterLevel = 0;
        // Cabin window foreground (layer 1: viewer only, never mirrored).
        const cabin = new T.Group();
        cabin.renderOrder = 1000;
        const panel = geometry(new T.PlaneGeometry(1, 1));
        const frameMat = material(new T.MeshBasicMaterial({ color: '#07090c', transparent: true,
            depthTest: false, depthWrite: false, fog: false }));
        const rimMat = material(new T.MeshBasicMaterial({ color: '#ffd28c', transparent: true,
            depthTest: false, depthWrite: false, fog: false, blending: T.AdditiveBlending }));
        const sheenMat = material(new T.ShaderMaterial({
            transparent: true, depthTest: false, depthWrite: false, blending: T.AdditiveBlending,
            uniforms: { color: { value: new T.Color('#ffd28c') }, opacity: { value: 0 },
                rain: cabinMood.rain, clock: cabinMood.clock, size: { value: new T.Vector2(1, 1) }, wet: { value: 0 } },
            vertexShader: `varying vec2 vUv;void main(){vUv=uv;
                gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            // Faint reflection of the lit carriage in the glass, pooled at the sill,
            // and rain on the windscreen catching the cab light at its rims.
            fragmentShader: `uniform vec3 color;uniform float opacity,rain,clock,wet;uniform vec2 size;varying vec2 vUv;
                ${RAIN_GLASS}
                void main(){float a=(pow(1.0-vUv.y,3.0)*0.8+pow(abs(vUv.x-0.5)*2.0,4.0)*0.3)*opacity;
                    vec3 drop=rainOnGlass(vUv*size*1.6,clock,rain);
                    float rim=clamp(length(drop.xy)*90.0,0.0,1.0);
                    float d=drop.z*(0.05+0.3*rim)*wet;
                    gl_FragColor=vec4(color*(a+d),a+d);}`
        }));
        const cabinPart = mat => {
            const mesh = new T.Mesh(panel, mat);
            mesh.layers.set(1);
            mesh.renderOrder = 1000 + (mat === frameMat ? 2 : mat === rimMat ? 3 : 1);
            mesh.frustumCulled = false;
            cabin.add(mesh);
            return mesh;
        };
        const sheen = cabinPart(sheenMat);
        const pillars = [cabinPart(frameMat), cabinPart(frameMat)];
        const header = cabinPart(frameMat), sill = cabinPart(frameMat);
        const rims = [cabinPart(rimMat), cabinPart(rimMat)];
        root.add(cabin);
        let cabinWeight = 0;
        const updateCabin = (camera, pose, track, aspect, config) => {
            const tuning = config.modes?.diorama || {};
            const f = track.at(pose.distance);
            const delta = Math.abs(Math.atan2(Math.sin(pose.yaw - f.yaw), Math.cos(pose.yaw - f.yaw)));
            const gaze = smooth((delta - 0.22) / 0.4);
            const inside = 1 - smooth((pose.state.openness - 0.45) / 0.3);
            cabinWeight = tuning.cabinFrame === false ? 0
                : gaze * inside * (1 - clamp(pose.finale ?? 0)) * (1 - clamp(pose.eventFocus?.weight ?? 0))
                    * (1 - clamp(pose.saloon ?? 0)) * (1 - clamp(pose.chase ?? 0));
            cabin.visible = cabinWeight > 0.002;
            if (!cabin.visible) return;
            cabin.position.copy(camera.position);
            cabin.quaternion.copy(camera.quaternion);
            const z = -0.5;
            const h = Math.tan(camera.fov * Math.PI / 360) * -z, w = h * Math.max(0.35, aspect);
            // Slide in from beyond the frame edges; the reading centre stays clear.
            const pw = Math.min(w * 0.12, h * 0.16), bh = h * 0.1;
            const e = smooth(cabinWeight);
            pillars.forEach((mesh, i) => {
                const s = i ? 1 : -1;
                mesh.scale.set(pw, h * 2.4, 1);
                mesh.position.set(s * (w + pw / 2 - pw * e), 0, z);
                rims[i].scale.set(pw * 0.06, h * 2.2, 1);
                rims[i].position.set(s * (w - pw * e + pw * 0.03), 0, z);
            });
            header.scale.set(w * 2.4, bh, 1);
            header.position.set(0, h + bh / 2 - bh * e, z);
            sill.scale.set(w * 2.4, bh * 1.3, 1);
            sill.position.set(0, -h - bh * 0.65 + bh * 1.3 * e, z);
            sheen.scale.set(w * 2, h * 2, 1);
            sheenMat.uniforms.size.value.set(w * 2, h * 2);
            sheenMat.uniforms.wet.value = e;
            sheen.position.set(0, 0, z);
            frameMat.opacity = e;
            rimMat.opacity = e * 0.35;
            rimMat.color.copy(haloMat.uniforms.color.value);
            sheenMat.uniforms.color.value.copy(haloMat.uniforms.color.value);
            sheenMat.uniforms.opacity.value = e * (palBase?.light ? 0.03 : 0.07);
        };
        let dead = false, reflectionEnabled = true, liveStations = 0, quality = 'standard';
        // How far the water has risen over the track in the dream, in metres.
        let drownLevel = 0;
        // Gulls are drawn as strokes after the overhead line, in the same buffer.
        let wireCount = 0, gullsOn = false;
        const GULLS = 5;
        const flyGulls = (track, s, time) => {
            let v = wireCount;
            if (gullsOn) for (let i = 0; i < GULLS && v + 24 <= wirePositions.length; i++) {
                // Each keeps pace with the train a while, wheeling slowly off to one side.
                const along = s + 22 + i * 13 + Math.sin(time * 0.11 + i * 2.1) * 6;
                const f = track.at(along);
                const lateral = (i % 2 ? 1 : -1) * (7 + i * 2.6) + Math.sin(time * 0.23 + i) * 3;
                const y = 7.5 + i * 1.1 + Math.sin(time * 0.37 + i * 1.7) * 0.7;
                const flap = Math.sin(time * (5.5 + i * 0.4) + i * 1.3);
                const cx = f.position.x + f.right.x * lateral, cz = f.position.z + f.right.z * lateral;
                const wing = [[-0.62, 0.12 + flap * 0.22], [-0.28, 0.04 - flap * 0.05], [0, -0.04], [0.28, 0.04 - flap * 0.05],
                    [0.62, 0.12 + flap * 0.22]];
                for (let k = 0; k < 4; k++) for (const [w, h] of [wing[k], wing[k + 1]]) {
                    // The wings spread across the line of flight.
                    wirePositions[v++] = cx + f.right.x * w;
                    wirePositions[v++] = y + h;
                    wirePositions[v++] = cz + f.right.z * w;
                }
            }
            wireGeometry.setDrawRange(0, v / 3);
            wireGeometry.attributes.position.needsUpdate = true;
        };
        let trackKey = '', sceneryKey = '', instanceTrack = null, lightAnchors = [], instanceRebuilds = 0;
        let stationInstances = 0;
        let auroraTrack = null;
        let baseStarOpacity = 0.8;
        // Palette-derived baselines; chapter warmth modulates around them each frame.
        let palBase = null, liveWarmth = 0.5, liveAccent = 0, haloBase = 1, liveDusk = 0, liveDream = 0;
        // The lamps of a crossing light in turn, a little faster than once a second.
        const signalLit = new T.Color(SIGNAL_RED).multiplyScalar(3.2), signalDark = new T.Color(SIGNAL_RED).multiplyScalar(0.06);
        const buoyPaint = new T.Color(SIGNAL_RED).multiplyScalar(0.09);
        const tintGlow = time => {
            const turn = Math.floor(time * 2.2) & 1;
            // By day a window is only a little warmer than the wall it is in.
            if (palBase?.light) roomGlow.copy(lampMaterial.color).multiplyScalar(0.3 / LAMP_GAIN).lerp(palePaint, 0.7);
            else roomGlow.copy(lampMaterial.color).multiplyScalar(0.34);
            if (palBase?.light) ceilingGlow.copy(palePaint).multiplyScalar(0.82);
            else ceilingGlow.copy(lampMaterial.color).multiplyScalar(0.04).lerp(timber.color, 0.3);
            let signal = 0;
            for (let i = 0; i < glow.count; i++) {
                const kind = glowKinds[i];
                if (kind === 2) {
                    // Every third is the lamp on a barrier arm, lit with whichever is nearer.
                    glow.setColorAt(i, signal % 3 === 2 || signal % 3 === turn ? signalLit : signalDark);
                    signal++;
                } else if (kind === 7) {
                    // Each buoy keeps its own time, so they do not wink together.
                    glow.setColorAt(i, (time * 0.31 + i * 0.37) % 1 < 0.14 ? signalLit : signalDark);
                } else if (kind === 8) glow.setColorAt(i, buoyPaint);
                else glow.setColorAt(i, kind === 0 ? lampMaterial.color : kind === 1 ? coldLampMaterial.color
                    : kind === 3 ? warmPaint : kind === 4 ? palePaint : kind === 5 ? roomGlow : ceilingGlow);
            }
            glow.instanceColor.needsUpdate = true;
            spillTint.value.copy(lampMaterial.color).lerp(WHITE, 0.35).multiplyScalar(palBase?.light ? 0.05 : 0.7);
            weatherAmount.value = palBase?.light ? 0.35 : 1;
            dressFill.value = palBase?.light ? 0 : 0.6;
            // The fittings take the same tones as the plain pools, and glass the sky.
            const night = !palBase?.light;
            [steel.color, concrete.color, wood.color, palePaint, warmPaint, null, lampMaterial.color, roomGlow,
                ceilingGlow, coldLampMaterial.color].forEach((colour, i) => { if (colour) dressTones[i].copy(colour); });
            dressTones[TONE.pale].copy(palePaint).lerp(concrete.color, 0.2).multiplyScalar(night ? 1.6 : 1);
            // Boarding is never quite black: weathered timber keeps some grey even at night.
            if (night) dressTones[TONE.timber].multiplyScalar(1.4);
            dressTones[TONE.glass].copy(skyMat.uniforms.horizon.value).multiplyScalar(night ? 0.25 : 0.95);
            // A poster case is lit white from behind; only the night warms it a little.
            if (night) dressTones[TONE.poster].copy(palePaint).multiplyScalar(1.5).lerp(roomGlow, 0.35);
            else dressTones[TONE.poster].copy(palePaint).multiplyScalar(1.04);
            dressTones[TONE.ink].copy(steel.color).multiplyScalar(night ? 0.35 : 0.6);
            dressTones[TONE.sky].copy(skyMat.uniforms.horizon.value);
            dressSky.value.copy(skyMat.uniforms.horizon.value).multiplyScalar(night ? 0.6 : 0.3);
        };
        const updateLights = (track, s, saving, audio) => {
            lightAnchors.sort((a, b) => Math.abs(a.address - s) - Math.abs(b.address - s));
            for (let i = 0; i < lights.length; i++) {
                const anchor = lightAnchors[i];
                const f = track.at(anchor?.address ?? s);
                const side = anchor?.side ?? -1;
                lights[i].position.set(f.position.x + f.right.x * LAMP_OFFSET * side, (anchor?.y ?? LAMP_Y) - 0.2,
                    f.position.z + f.right.z * LAMP_OFFSET * side);
                lights[i].intensity = anchor && !saving ? 24 * (1 + clamp(audio.impact) * 0.12) : 0;
            }
            // Cones of light in the haze under the nearest lamps, and the rain
            // lit where it falls through them. Not by day: the page has no haze to light.
            const night = palBase && !palBase.light && !saving;
            beams.count = 0;
            for (let i = 0; i < BEAMS && night; i++) {
                const anchor = lightAnchors[i];
                if (!anchor || Math.abs(anchor.address - s) > 90) break;
                const f = track.at(anchor.address);
                beamMatrix.makeTranslation(f.position.x + f.right.x * LAMP_OFFSET * anchor.side, (anchor.y ?? LAMP_Y) - 0.15,
                    f.position.z + f.right.z * LAMP_OFFSET * anchor.side);
                beams.setMatrixAt(beams.count, beamMatrix);
                beams.setColorAt(beams.count, beamColour.copy(lampMaterial.color).multiplyScalar(0.06));
                beams.count++;
            }
            beams.instanceMatrix.needsUpdate = true;
            if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
            beamMat.uniforms.haze.value = 0.25 + rainLevel * 0.55;
            for (let i = 0; i < 4; i++) {
                const anchor = night ? lightAnchors[i] : null;
                const at = rainMat.uniforms.lampAt.value[i];
                if (!anchor) { at.set(0, -100, 0); continue; }
                const f = track.at(anchor.address);
                at.set(f.position.x + f.right.x * LAMP_OFFSET * anchor.side, (anchor.y ?? LAMP_Y) - 1.5,
                    f.position.z + f.right.z * LAMP_OFFSET * anchor.side);
            }
            rainMat.uniforms.lampTint.value.copy(lampMaterial.color).multiplyScalar(0.25);
            // Water streaks only for lamps still ahead of the camera.
            const ahead = lightAnchors.filter(a => a.address > s + 2);
            for (let i = 0; i < 4; i++) {
                const anchor = ahead[i];
                const power = anchor ? Math.exp(-(anchor.address - s) / 70) : 0;
                if (anchor) {
                    const f = track.at(anchor.address);
                    waterMat.uniforms.lampPos.value[i].set(f.position.x + f.right.x * LAMP_OFFSET * anchor.side, anchor.y,
                        f.position.z + f.right.z * LAMP_OFFSET * anchor.side);
                }
                waterMat.uniforms.lampPower.value[i] = saving ? 0 : power;
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
            // By day the scene is a page: the sky is the page itself, not a
            // dimmed copy of it, saturated colours are washed toward the muted
            // tone and the page as watercolour is, and nothing is darker than a
            // soft grey. The night keeps the theme's colours as they are.
            const page = background.clone().lerp(white, 0.35);
            const watercolour = (colour, toMuted, toPage) => light
                ? colour.clone().lerp(muted, toMuted).lerp(page, toPage) : colour.clone();
            // Separate substrate, atmospheric fill and luminous accents.
            skyMat.uniforms.night.value.copy(deep).lerp(tertiary, 0.045).multiplyScalar(0.42);
            skyMat.uniforms.horizon.value.copy(background).lerp(muted, 0.2).lerp(tertiary, 0.06);
            if (light) {
                skyMat.uniforms.night.value.copy(page).lerp(tertiary, 0.03);
                skyMat.uniforms.horizon.value.copy(page).lerp(muted, 0.05);
            }
            skyMat.uniforms.cold.value.copy(tertiary);
            // Theme-native spectral pair; keep luminance bounded, retaining hue.
            const luminous = color => {
                const hsl = color.getHSL({});
                return color.setHSL(hsl.h, clamp(hsl.s, 0.25, 0.88), clamp(hsl.l, 0.42, 0.66));
            };
            skyMat.uniforms.auroraGreen.value.copy(watercolour(luminous(secondary.clone()), 0.3, 0.3));
            skyMat.uniforms.auroraViolet.value.copy(watercolour(luminous(emission.clone().lerp(tertiary, 0.12)), 0.6, 0.3));
            waterMat.uniforms.tint.value.copy(deep).lerp(secondary, light ? 0.04 : 0.025)
                .multiplyScalar(light ? 0.78 : 0.48);
            scene.fog = new T.FogExp2(skyMat.uniforms.horizon.value, 0.008);
            waterMat.uniforms.fogTint.value.copy(skyMat.uniforms.horizon.value);
            waterMat.uniforms.moonTint.value.copy(light ? surface : ink).lerp(emission, 0.08);
            waterMat.uniforms.glitter.value = light ? 0.25 : 1;
            waterMat.uniforms.lampTint.value.copy(emission);
            steel.color.copy(structure).lerp(muted, light ? 0.45 : 0.5);
            if (light) steel.color.lerp(page, 0.3);
            concrete.color.copy(surface).lerp(border, light ? 0.2 : 0.45);
            timber.color.copy(deep).lerp(structure, 0.55).lerp(emission, 0.025);
            if (light) timber.color.lerp(page, 0.42);
            // Rust takes a little of the lamp colour.
            railMaterial.color.copy(steel.color).lerp(emission, light ? 0.04 : 0.1);
            wood.color.copy(timber.color);
            permanentWay.color.copy(timber.color);
            rockMaterial.color.copy(concrete.color).multiplyScalar(rockMaterial.map ? 1.7 : 0.8);
            hemisphere.color.copy(light ? surface : muted).lerp(tertiary, 0.12);
            hemisphere.groundColor.copy(deep);
            hemisphere.intensity = light ? 1.8 : 0.65;
            moonLight.color.copy(light ? surface : ink).lerp(tertiary, 0.12);
            moonColor.copy(light ? surface : ink).lerp(emission, 0.08);
            // Lamps are brighter than white, so the lens has something to spread.
            // By day they are pale and only warm, not the theme's accent shining
            // out of the mist: everything saturated is taken down by day, so
            // nothing jumps out of the white.
            // On a page a lamp's light is a pale gold: brightness alone does not stand out from white.
            const lamp = light ? new T.Color('#e3c27f') : emission;
            lampMaterial.color.copy(lamp).multiplyScalar(light ? 1.5 : LAMP_GAIN);
            coldLampMaterial.color.copy(luminous(secondary.clone())).multiplyScalar(1.7);
            // Paint does not shine: a marking is a little lighter than what it is painted on.
            warmPaint.copy(emission).lerp(concrete.color, light ? 0.8 : 0.4).multiplyScalar(light ? 0.92 : 0.2);
            palePaint.copy(light ? surface : ink).lerp(concrete.color, 0.3).multiplyScalar(light ? 0.95 : 0.3);
            // By day lamps hardly light what is round them: their light is near white.
            lights.forEach(l => l.color.copy(lamp).lerp(white, light ? 0.65 : 0));
            const signal = watercolour(new T.Color(SIGNAL_RED), 0.5, 0.3);
            signalLit.copy(signal).multiplyScalar(light ? 1.25 : 3.2);
            signalDark.copy(signal).multiplyScalar(light ? 0.45 : 0.06);
            buoyPaint.copy(signal).multiplyScalar(light ? 0.6 : 0.09);
            // By day a figure is a soft grey wash, not a hole in the page.
            if (light) glassMaterial.uniforms.shadowInk.value.copy(muted).lerp(page, 0.2).multiplyScalar(0.62);
            else glassMaterial.uniforms.shadowInk.value.set('#24212a');
            // Cream window band and the deep green body learn a little of the current theme.
            const ivory = new T.Color('#eed6a1').lerp(light ? surface : ink, light ? 0.46 : 0.19);
            const green = new T.Color('#426b3f').lerp(luminous(secondary.clone()), light ? 0.1 : 0.22);
            // On the page the train is drawn in ink wash: a grey-green body a
            // shade darker than the paper round it, and the gear under it in
            // ink, not left blank where the haze reaches it.
            const runningGear = watercolour(new T.Color('#33322e').lerp(deep, light ? 0.08 : 0.40), 0.1, 0);
            const roof = watercolour(new T.Color('#484f45').lerp(structure, 0.37), 0.25, 0.12);
            paintTrain(ivory, light ? watercolour(green, 0.5, 0.06) : green, runningGear, roof);

            carHorizon.value.copy(light ? surface : muted).lerp(secondary, 0.3);
            carWater.value.copy(secondary).lerp(deep, 0.31);
            cabinDaylight.value = light ? 1 : 0;
            // By day the inside of the car is lit from the windows, not by its lamps.
            glassMaterial.uniforms.warm.value.copy(emission).lerp(white, 0.18);
            // By day too the saloon keeps the warm white of its own strips and the
            // full green of its moquette: the page washes the world, not the car.
            if (light) glassMaterial.uniforms.warm.value.set('#f3dfb8').lerp(surface, 0.3);
            glassMaterial.uniforms.seat.value.copy(secondary).multiplyScalar(0.3);
            if (light) glassMaterial.uniforms.seat.value.copy(secondary).multiplyScalar(0.36);
            glassMaterial.uniforms.night.value.copy(deep).multiplyScalar(0.5);
            endMaterial.uniforms.warm.value.copy(glassMaterial.uniforms.warm.value);
            cabinGlow.color.copy(emission);
            starMat.uniforms.tint.value.copy(light ? surface : ink).lerp(tertiary, 0.08);
            baseStarOpacity = light ? 0.15 : 0.8;
            starMat.opacity = baseStarOpacity;
            starMat.uniforms.opacity.value = baseStarOpacity;
            skyMat.uniforms.moonTint.value.copy(moonColor);
            skyMat.uniforms.moonGlow.value = light ? 0.3 : 1;
            skyMat.uniforms.glowTint.value.copy(emission).lerp(tertiary, 0.5);
            skyMat.uniforms.horizonGlow.value = light ? 0.35 : 1;
            ridgeMaterial.color.copy(skyMat.uniforms.horizon.value).lerp(deep, 0.35)
                .multiplyScalar(light ? 0.8 : 0.55);
            wireMaterial.color.copy(watercolour(border.clone().lerp(secondary, 0.25), 0, 0.2));
            haloBase = light ? 0.35 : 1;
            frameMat.color.copy(deep).lerp(structure, 0.35).multiplyScalar(0.4);
            if (light) frameMat.color.copy(muted).lerp(page, 0.15).multiplyScalar(0.72);
            haloMat.uniforms.color.value.copy(lamp);
            // The page is bright enough already: by day the gloss is kept low,
            // or every lit surface would be lifted by the white around it.
            envSkyMat.uniforms.envGain.value = light ? 0.35 : 0.6;
            envDirty = true;
            // Dusk and dream colours. By day the afterglow is only a warm wash on the page.
            const sunsetHue = new T.Color('#c47a55').lerp(emission, 0.2);
            if (light) {
                skyMat.uniforms.duskHigh.value.copy(page).lerp(muted, 0.12);
                skyMat.uniforms.sunset.value.copy(page).lerp(sunsetHue, 0.55);
                skyMat.uniforms.dreamTint.value.copy(page).lerp(tertiary, 0.12);
            } else {
                skyMat.uniforms.duskHigh.value.copy(skyMat.uniforms.night.value).lerp(tertiary, 0.3)
                    .multiplyScalar(2.2).lerp(skyMat.uniforms.horizon.value, 0.35);
                skyMat.uniforms.sunset.value.copy(sunsetHue);
                skyMat.uniforms.dreamTint.value.copy(new T.Color('#241f48')).lerp(tertiary, 0.2).lerp(deep, 0.2);
            }
            // Rain: pale streaks against the night, pencil-grey strokes on the page.
            rainMat.uniforms.colour.value.copy(light ? ink.clone().lerp(page, 0.3) : skyMat.uniforms.horizon.value.clone().lerp(white, 0.6));
            rainMat.uniforms.opacity.value = light ? 0.38 : 0.17;
            // An overcast sky is greyer and, at night, a little lower and closer.
            const overcast = skyMat.uniforms.horizon.value.clone();
            const greyed = overcast.getHSL({});
            overcast.setHSL(greyed.h, greyed.s * 0.35, greyed.l * (light ? 0.93 : 0.8));
            palBase = {
                light, overcast, moon: moonColor.clone(), moonGlow: skyMat.uniforms.moonGlow.value,
                glitter: waterMat.uniforms.glitter.value,
                horizon: skyMat.uniforms.horizon.value.clone(),
                night: skyMat.uniforms.night.value.clone(),
                hemi: hemisphere.color.clone(), hemiIntensity: hemisphere.intensity,
                lamp: lamp.clone(), warm: lamp.clone(), cold: tertiary.clone()
            };
        };
        // Warmth 0..1 → bias -1 (cold, open chorus) .. +1 (warm, tightening pre-chorus).
        // Everything is re-derived from the palette baseline, so no state accumulates.
        const applyWarmth = (warmth, openness, energy) => {
            if (!palBase) return;
            liveWarmth = warmth;
            const bias = (clamp(warmth) - 0.5) * 2;
            const toward = bias > 0 ? palBase.warm : palBase.cold;
            const amount = Math.abs(bias);
            const k = palBase.light ? 0.5 : 1;
            scratch.copy(palBase.horizon).lerp(toward, amount * 0.12 * k).lerp(palBase.overcast, rainLevel * 0.5)
                .lerp(skyMat.uniforms.sunset.value, liveDusk * 0.3);
            skyMat.uniforms.horizon.value.copy(scratch);
            waterMat.uniforms.fogTint.value.copy(scratch);
            if (scene.fog) {
                scene.fog.color.copy(scratch);
                // Warm passages close in; open chapters and loud passages thin the haze.
                // By day distant things fade into the page rather than darken.
                scene.fog.density = 0.008 * (palBase.light ? 1.45 : 1) * (1 + Math.max(0, bias) * 0.18)
                    * (1 - clamp(openness) * 0.18) * (1 - clamp(energy) * 0.06) * (1 + rainLevel * (palBase.light ? 0.45 : 0.9)) * (1 - liveDream * 0.3);
                waterMat.uniforms.fogDensity.value = scene.fog.density;
            }
            skyMat.uniforms.night.value.copy(palBase.night).lerp(palBase.cold, Math.max(0, -bias) * 0.05 * k)
                .lerp(palBase.overcast, rainLevel * 0.3);
            hemisphere.color.copy(palBase.hemi).lerp(toward, amount * 0.16 * k);
            hemisphere.intensity = palBase.hemiIntensity * (1 + Math.max(0, -bias) * 0.12) * (1 - rainLevel * 0.2);
            // The moon goes behind the rain clouds, and its path on the water with it.
            moonColor.copy(palBase.moon).multiplyScalar(1 - rainLevel * 0.75);
            skyMat.uniforms.moonGlow.value = palBase.moonGlow * (1 - rainLevel * 0.8);
            waterMat.uniforms.glitter.value = palBase.glitter * (1 - rainLevel * 0.7);
            // Warm chapters deepen lamps toward amber, cold ones bleach them slightly.
            scratch.copy(palBase.lamp).lerp(white, Math.max(0, -bias) * 0.22);
            lights.forEach(l => l.color.copy(scratch).lerp(white, palBase.light ? 0.65 : 0));
            waterMat.uniforms.lampTint.value.copy(scratch);
            haloMat.uniforms.color.value.copy(scratch);
            lampMaterial.color.copy(scratch).multiplyScalar((palBase.light ? 1.5 : LAMP_GAIN) * (1 + Math.max(0, bias) * 0.15));
        };
        // The setting eases in and out over a couple of seconds of wall-clock
        // time, but the first frame after entering the stage starts as set.
        const updateRain = (track, pose, time, tuning, tier) => {
            const wanted = RAIN_LEVELS[tuning.rain] ?? 0;
            const now = (global.performance?.now?.() ?? Date.now()) / 1000;
            if (!rainClock) rainLevel = wanted;
            const step = clamp(now - (rainClock || now), 0, 0.25) * 0.5;
            rainClock = now;
            rainLevel += Math.max(-step, Math.min(step, wanted - rainLevel));
            rainAmount.value = rainLevel;
            // Ground, platforms and fittings darken and shine as they get wet.
            if (!Number.isFinite(tuning.wetness)) wetness.value = rainLevel;
            const count = Math.round((RAIN_COUNTS[tier] ?? RAIN_COUNTS.standard) * rainLevel);
            rainDrops.visible = count > 0;
            rainGeometry.setDrawRange(0, count * 6);
            if (!count) return;
            const u = rainMat.uniforms;
            u.time.value = time;
            u.centre.value.set(pose.position.x, pose.position.y, pose.position.z);
            // The train, front to back, as one straight run: it is nearly straight over its length.
            const front = pose.trainFront ?? pose.distance - 0.4, back = front - SET_PITCH * 2;
            const a = track.at(front), b = track.at(back);
            u.shelterA.value.set(a.position.x, 0, a.position.z);
            u.shelterB.value.set(b.position.x, 0, b.position.z);
            const here = track.at(clamp(pose.distance, back, front));
            const lateral = Math.abs((pose.position.x - here.position.x) * here.right.x + (pose.position.z - here.position.z) * here.right.z);
            const inside = pose.distance <= front + 0.5 && pose.distance >= back - 0.5 && lateral < 1.45 && pose.position.y < 4.1;
            u.shelter.value = inside || (pose.chase ?? 0) > 0.002 || (pose.saloon ?? 0) > 0.002 ? 1 : 0;
        };
        const update = (timeline, track, pose, time, config, audio = {}) => {
            if (dead) return;
            const tuning = config.modes?.diorama || {};
            quality = config.quality || 'standard';
            const saving = quality === 'energy-saving';
            const s = pose.distance;
            if (Number.isFinite(tuning.wetness)) wetness.value = clamp(tuning.wetness);
            liveDusk = clamp(pose.state.dusk ?? 0);
            liveDream = clamp(pose.state.dream ?? 0);
            skyMat.uniforms.dusk.value = liveDusk;
            skyMat.uniforms.dream.value = liveDream;
            waterMat.uniforms.calm.value = liveDream * (1 - rainLevel);
            // The gloss outside follows the sky in coarse steps, not every frame.
            const key = `${Math.round(liveDusk * 8)}:${Math.round(liveDream * 8)}:${Math.round(rainLevel * 8)}`;
            if (key !== envKey) { envKey = key; envDirty = true; }
            sky.position.set(pose.position.x, 0, pose.position.z);
            stars.position.copy(sky.position);
            ridge.position.copy(sky.position);
            moon.position.set(sky.position.x - 210, 300, sky.position.z - 420);
            water.position.set(pose.position.x, waterLevel, pose.position.z);
            stars.visible = tuning.showParticles !== false;
            starMat.opacity = baseStarOpacity * (1 - clamp(pose.finale ?? 0)) * (1 - rainLevel * 0.85)
                * (1 - liveDusk * 0.85) * (1 + liveDream * 0.6);
            starMat.uniforms.opacity.value = starMat.opacity;
            starMat.uniforms.time.value = time;
            starGeo.setDrawRange(0, townLights + (saving ? 1500 : quality === 'ultimate' ? 8000 : 4000));
            skyMat.uniforms.open.value = pose.state.openness;
            const auroraEnabled = tuning.aurora !== false;
            skyMat.uniforms.auroraActive.value = auroraEnabled ? (1.0 - rainLevel * 0.95) * (1 - liveDusk) * (1 + liveDream * 0.4) : 0.0;
            if (auroraTrack !== track) {
                const opening = global.MusicStageDioramaCamera.pose(timeline, track, 0, tuning);
                skyMat.uniforms.auroraHeading.value = opening.yaw - 0.34;
                auroraTrack = track;
            }
            const motion = clamp(tuning.motionAmount ?? 1, 0, 2) * clamp(config.animationIntensity ?? 1, 0, 2);
            skyMat.uniforms.auroraTime.value = time * motion;
            starMat.uniforms.twinkle.value = clamp(motion);
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
            updateRain(track, pose, time, tuning, quality);
            // Analytic chapter swell (seek-exact) plus frozen-on-pause audio response.
            const accent = motion ? (timeline.accentAt?.(time) ?? 0) : 0;
            liveAccent = accent;
            skyMat.uniforms.accent.value = accent;
            starMat.uniforms.accent.value = accent;
            applyWarmth(pose.state.warmth ?? 0.5, pose.state.openness, audio.energy);
            // Lamps spread wider in the wet air.
            haloMat.uniforms.intensity.value = haloBase * (1 + clamp(audio.impact) * 0.35 + accent * 0.25) * (1 + rainLevel * 0.3);
            reflectionEnabled = tuning.waterReflection !== false && (tuning.waterStrength ?? 1) > 0;
            waterMat.uniforms.strength.value = reflectionEnabled ? clamp(tuning.waterStrength ?? 1, 0, 2) : 0;
            const spacing = 16 / clamp(tuning.stationIntensity ?? 1, 0.5, 2);
            headlight.color.copy(palBase?.lamp || white).lerp(white, 0.45);
            headlight.intensity = saving ? 0 : 3 * (palBase?.light ? 0.4 : 1);
            const front = pose.trainFront ?? s - 0.4;
            const ahead = track.at(front + 7.5);
            headlight.position.set(ahead.position.x, 0.7, ahead.position.z);
            // From the cab the train is all behind the lens: nothing of it to draw.
            placeTrain(track, front, tuning.showTrain !== false && (pose.chase ?? 0) > 0.002);
            // From outside, at any distance, the real cab shows through clear windscreens,
            // so the glass never turns from clear to painted as the camera moves.
            // Outside means the eye is not within the leading car's shell. The director
            // raises pose.saloon a little before the camera goes in, so it cannot say.
            placeSaloon(track, front, true);
            saloon.updateMatrixWorld();
            const eyeLocal = pose.position ? saloon.worldToLocal(cabEye.set(pose.position.x, pose.position.y ?? 0, pose.position.z)) : null;
            const eyeInside = eyeLocal && Math.abs(eyeLocal.x) < CAR.half + 0.05 && eyeLocal.y < CAR.crown + 0.1
                && eyeLocal.z > TIP - 0.1 && eyeLocal.z < CAR.length / 2 + 0.1;
            const outside = (pose.chase ?? 0) > 0.002 && !eyeInside;
            cabReal.value = outside && tuning.showTrain !== false ? 1 : 0;
            // Beyond this reach only the shell and the cab are drawn: the seats, lamps and people are too small to miss.
            const CAB_FULL_REACH = 9;
            const nose = track.at(front - 1.2).position, eyeAt = pose.position;
            const near = !outside || (eyeAt && Math.hypot(eyeAt.x - nose.x, (eyeAt.y ?? 0) - 2.2, eyeAt.z - nose.z) < CAB_FULL_REACH);
            saloonGeometry.setDrawRange(0, near ? Infinity : saloonGeometry.userData.coarse);
            placeSaloon(track, front, tuning.showTrain !== false && ((pose.saloon ?? 0) > 0.002 || cabReal.value > 0));
            // From outside the real cab's own inner panes would glaze the windscreen twice,
            // and the saloon is culled like any other mesh when it is out of view.
            innerGlass.visible = cabReal.value === 0;
            saloon.frustumCulled = cabReal.value > 0;
            // The last car's cab, the same way: clear glass whenever the train is seen from outside it.
            const showTail = tuning.showTrain !== false && (pose.chase ?? 0) > 0.002;
            tailSaloon.visible = false;
            tailReal.value = 0;
            if (showTail) {
                cars.getMatrixAt(CARS - 1, tailSaloon.matrix);
                tailSaloon.matrixWorld.multiplyMatrices(root.matrixWorld, tailSaloon.matrix);
                const tailEye = pose.position ? cabEye.set(pose.position.x, pose.position.y ?? 0, pose.position.z)
                    .applyMatrix4(tailMatrixInverse.copy(tailSaloon.matrixWorld).invert()) : null;
                const insideTail = tailEye && Math.abs(tailEye.x) < CAR.half + 0.05 && tailEye.y < CAR.crown + 0.1
                    && tailEye.z > TIP - 0.1 && tailEye.z < CAR.length / 2 + 0.1;
                if (!insideTail) {
                    tailReal.value = 1;
                    tailSaloon.visible = true;
                    const tailNear = tailEye && Math.hypot(tailEye.x, tailEye.y - 2.2, tailEye.z - TIP) < CAB_FULL_REACH;
                    tailGeometry.setDrawRange(0, tailNear ? Infinity : tailGeometry.userData.coarse);
                }
            }
            cabinMood.sunset.value = clamp(pose.cabinSunset ?? tuning.cabinSunset ?? 0);
            cabinMood.empty.value = clamp(pose.cabinEmpty ?? tuning.cabinEmpty ?? 0);
            cabinMood.clock.value = time;
            cabinMood.rain.value = rainAmount.value;
            cabinMood.sway.value = time > 0 ? 1 : 0;
            cabinGlow.intensity = saving || tuning.showTrain === false ? 0 : 4.5 * (palBase?.light ? 0.4 : 1) * clamp(pose.chase ?? 0);
            // The permanent way slides forward in long strides; scenery is laid
            // out again only when a new pole or station comes into range.
            const lookingBack = pose.chaseRig === 'BOW';
            const nextTrackKey = [Math.floor(s / 12), quality, lookingBack].join(':');
            const nextSceneryKey = [Math.floor(s / spacing), Math.floor(s / 110), quality, lookingBack,
                tuning.narrativeStations, tuning.stationIntensity, tuning.cameraSpeed].join(':');
            if (instanceTrack !== track || nextTrackKey !== trackKey) {
                trackKey = nextTrackKey;
                const stride = Math.floor(s / 12) * 12;
                rails.count = (saving ? 90 : 160) * 2;
                for (let i = 0; i < rails.count / 2; i++) {
                    for (let side = 0; side < 2; side++) {
                        place(rails, i * 2 + side, track, stride - (lookingBack ? 120 : 30) + i * 2, (side ? 1 : -1) * 0.7175,
                            0.335, 1, 1, 2.04);
                    }
                }
                sleepers.count = saving ? 140 : 400;
                for (let i = 0; i < sleepers.count; i++) place(sleepers, i, track, stride - (lookingBack ? 114 : 24) + i * 0.75, 0, 0.18, 1, 1, 1);
                rails.instanceMatrix.needsUpdate = sleepers.instanceMatrix.needsUpdate = true;
            }
            // Timing and the dream are read every frame, so the water stands where
            // it should even on the first frame after a seek.
            const speed = tuning.cameraSpeed ?? 1;
            // When the camera reaches an address along the line.
            const timeAt = address => {
                if (track.timeAt) return track.timeAt(address);
                let lo = 0, hi = timeline.duration;
                for (let j = 0; j < 18; j++) {
                    const mid = (lo + hi) * 0.5;
                    if (timeline.distanceAt(mid, speed) < address) lo = mid;
                    else hi = mid;
                }
                return (lo + hi) * 0.5;
            };
            const stateAt = address => timeline.sample(timeAt(address));
            /*
             * As the song goes on the line turns to a dream: the water rises over
             * the track, the busy shore falls away, and what is left is a lamp, a
             * lit window far off, someone waiting. The director says how far into
             * the dream an address is; failing that, the last part of the song is.
             */
            const dreamAt = address => {
                const dream = stateAt(address).dream;
                if (Number.isFinite(dream)) return clamp(dream);
                return smooth((timeAt(address) / Math.max(1, timeline.duration || 1) - 0.55) / 0.15);
            };
            drownLevel = 0.45 * smooth((dreamAt(s) - 0.3) / 0.5);
            waterLevel = drownLevel;
            water.position.y = waterLevel;
            wade(track, pose, time, waterLevel, saving, tuning.showTrain !== false);
            // Even at a crawl the wheels stir it; at speed the arms open out behind.
            const stirring = tuning.showTrain !== false
                ? smooth((waterLevel - 0.3) / 0.12) * (0.4 + 0.6 * smooth(Math.abs(splashSpeed) / 7)) : 0;
            waterMat.uniforms.wake.value = stirring;
            if (stirring > 0) {
                const head = pose.trainFront ?? pose.distance, reach = SET_PITCH * CARS / 2;
                waterMat.uniforms.wakePath.value.forEach((point, i) => {
                    const at = track.at(head - reach * i / 4).position;
                    point.set(at.x, at.z);
                });
            }
            // The water the train stirs follows its length down the line.
            tideLine.value = waterLevel;
            splash.layers.set(saving ? 1 : 0);
            if (rocksArrived) { rocksArrived = false; sceneryKey = ''; }
            if (instanceTrack === track && nextSceneryKey === sceneryKey) {
                flyGulls(track, s, time);
                tintGlow(time);
                updateLights(track, s, saving, audio);
                return;
            }
            instanceTrack = track; sceneryKey = nextSceneryKey; instanceRebuilds++;
            const enabled = tuning.narrativeStations !== false && (tuning.stationIntensity ?? 1) > 0;
            sceneryPools.forEach(mesh => { mesh.count = 0; });
            // On the saving tier the fittings and the rocks are left out of the reflection.
            dressed.layers.set(saving ? 1 : 0);
            if (rocks) rocks.layers.set(saving ? 1 : 0);
            const part = (mesh, address, lateral, y, sx, sy, sz, roll = 0, pitch = 0) => {
                if (mesh.count >= mesh.instanceMatrix.count) return;
                place(mesh, mesh.count++, track, address, lateral, y, sx, sy, sz, roll, pitch);
            };
            // A straight member between two points of the cross-section at one address.
            const span = (mesh, address, l0, y0, l1, y1, thick, depth = thick) => part(mesh, address,
                (l0 + l1) / 2, (y0 + y1) / 2, Math.hypot(l1 - l0, y1 - y0), thick, depth, Math.atan2(y1 - y0, l1 - l0));
            const rawPart = part, rawSpan = span;
            spillList = [];
            const spillAt = (address, lateral, y, power = 1) => {
                const f = track.at(address);
                spillList.push([f.position.x + f.right.x * lateral, y, f.position.z + f.right.z * lateral, power]);
            };
            // A pile of shore rocks, turned and sized so no two read as the same one.
            const rock = (address, lateral, size, turn, sunk = 0.12) => {
                if (!rocks || rocks.count >= (saving ? 6 : rocks.instanceMatrix.count)) return;
                // On the saving tier only the larger rocks are kept.
                if (saving && size < 0.9) return;
                if (inTheWay(address, lateral, size * 1.7, size * 3, size * 3 + 1)) return;
                const f = track.at(address);
                dummy.position.set(f.position.x + f.right.x * lateral, -sunk * size, f.position.z + f.right.z * lateral);
                dummy.rotation.set(0, turn, 0);
                dummy.scale.set(size, size * (0.85 + 0.3 * Math.abs(Math.sin(turn * 3.1))), size);
                dummy.updateMatrix();
                rocks.setMatrixAt(rocks.count++, dummy.matrix);
            };
            // Where the camera is as it goes by an address: how far out to one
            // side of the line, and how high. In the cab it is on the line.
            if (passingTrack !== track) { passing = new Map(); passingTrack = track; }
            const cameraAt = address => {
                const key = Math.round(address / 2);
                let at = passing.get(key);
                if (!at) {
                    const view = global.MusicStageDioramaCamera.pose(timeline, track, timeAt(key * 2), tuning);
                    const f = track.at(view.distance);
                    at = { y: view.position.y, lateral: (view.position.x - f.position.x) * f.right.x
                        + (view.position.z - f.position.z) * f.right.z };
                    passing.set(key, at);
                }
                return at;
            };
            // When the camera leaves the cab it flies beside the line, sometimes
            // low over the water. Nothing may stand where it goes: true if a
            // thing at this lateral, this tall and this wide would be in its way.
            const inTheWay = (address, lateral, top, half = 1, along = 3) => {
                for (let at = address - along; at <= address + along; at += 2) {
                    const camera = cameraAt(at);
                    if (Math.abs(camera.lateral) > 1.3 && Math.abs(camera.lateral - lateral) < half + 0.8
                        && camera.y < top + 0.9) return true;
                }
                return false;
            };
            // With no screen ahead the camera may still be turned to a line on the
            // sky: a pole then takes the side the camera faces away from as it
            // comes up to and passes that pole.
            const awayFromGaze = address => {
                for (const lead of [0, 16, 32]) {
                    const view = global.MusicStageDioramaCamera.pose(timeline, track, timeAt(address - lead), tuning);
                    const heading = track.at(address - lead).yaw;
                    const turn = Math.atan2(Math.sin(view.yaw - heading), Math.cos(view.yaw - heading));
                    if (Math.abs(turn) > 0.08) return turn > 0 ? -1 : 1;
                }
                return -1;
            };
            // Stations are laid out first: poles and props keep out of them.
            const stations = [];
            const stationStart = Math.floor(s / 110) - 1;
            for (let i = 0; i < 4 && enabled; i++) {
                const id = stationStart + i;
                if (id < 0) continue;
                const address = id * 110 + 38;
                // Prefer the side where fewer of its bays stand in a screen's sight line.
                const exposure = side => [-11, -5.5, 0, 5.5, 11].filter(bay =>
                    inSight(track, address + bay, 7, side)).length;
                const preferred = id % 2 ? 1 : -1;
                let side = exposure(-preferred) < exposure(preferred) ? -preferred : preferred;
                // A station takes the other side from the camera, or is not built.
                const flownOver = towards => inTheWay(address, towards * 5.4, 5.2, 4.6, 15);
                // Nor does it stand where a screen does: the screen's lower edge
                // would go through the canopy and the name board.
                const screened = towards => (track.encounters || []).some(item => item.side === towards
                    && item.lateral - item.width / 2 < 11 && Math.abs(item.address - address) < 21);
                const taken = towards => flownOver(towards) || screened(towards);
                if (taken(side)) side = -side;
                if (taken(side)) continue;
                // Deep in the dream only every other station is left, and that one bare.
                const dream = dreamAt(address);
                if (dream > 0.5 && id % 2) continue;
                stations.push({ id, address, open: stateAt(address).density < 0.4, side, dream });
            }
            const atStation = (address, side, margin) => stations.some(station =>
                station.side === side && Math.abs(station.address - address) < 14 + margin);

            // --- Catenary masts, lamp posts and the overhead line ---
            let haloCount = 0, wireVertex = 0;
            lightAnchors = [];
            // A camera turned to face the train sees further back along the line than ahead.
            const poleStart = Math.floor(s / spacing) - (lookingBack ? 10 : 3);
            const polePlan = [];
            for (let i = 0; i <= (enabled ? (saving ? 16 : 32) : -1); i++) {
                const id = poleStart + i;
                const address = id * spacing;
                const state = stateAt(address);
                const present = state.density >= 0.4 || id % 4 === 0;
                // The line is electrified wherever the train rides low; over open
                // water the camera climbs above bare lamp posts instead.
                let side = poleSide(track, address, awayFromGaze(address));
                if (inSight(track, address, POLE_OFFSET, side)) side = -side;
                // Nor may a pole stand where the camera swings out past it.
                const flownPast = towards => inTheWay(address, towards * POLE_OFFSET, 8.5, 1.4);
                if (flownPast(side) && !inSight(track, address, POLE_OFFSET, -side)) side = -side;
                const clear = !inSight(track, address, POLE_OFFSET, side) && !flownPast(side);
                // A high camera also sees the masts ahead of it, so the wire only
                // starts a few spans after the train has come down.
                polePlan.push({ id, address, present: present && clear, side,
                    wired: present && clear && state.density >= 0.4 && !saving
                        && [0, 24, 48, 72].every(back => stateAt(address - back).height < 4.2) });
            }
            const wire = (a0, l0, y0, a1, l1, y1) => {
                if (wireVertex + 6 > wirePositions.length) return;
                for (const [address, lateral, y] of [[a0, l0, y0], [a1, l1, y1]]) {
                    const f = track.at(address);
                    wirePositions[wireVertex++] = f.position.x + f.right.x * lateral;
                    wirePositions[wireVertex++] = y;
                    wirePositions[wireVertex++] = f.position.z + f.right.z * lateral;
                }
            };
            polePlan.slice(0, -1).forEach((pole, index) => {
                if (!pole.present) return;
                const { id, address, side } = pole;
                const L = value => side * value;
                const stagger = id % 2 ? 0.18 : -0.18;
                part(LOOK.concrete, address, L(POLE_OFFSET), 0.3, 0.6, 0.6, 0.6);
                if (!saving) {
                    // Base flange and its bolts, the louvred switch box on the far
                    // side with its conduit, and the pole's number plate.
                    part(LOOK.paint, address, L(POLE_OFFSET), 0.63, 0.32, 0.06, 0.32);
                    for (const [bx, bz] of [[-0.11, -0.11], [0.11, -0.11], [-0.11, 0.11], [0.11, 0.11]])
                        part(LOOK.paint, address + bz, L(POLE_OFFSET + bx), 0.68, 0.04, 0.05, 0.04);
                    part(LOOK.louvre, address, L(POLE_OFFSET + 0.17), 1.45, 0.14, 0.42, 0.24);
                    part(LOOK.paint, address, L(POLE_OFFSET + 0.17), 1.68, 0.18, 0.04, 0.28);
                    part(LOOK.tube, address, L(POLE_OFFSET + 0.13), 0.98, 0.035, 0.55, 0.035);
                    part(LOOK.plate, address, L(POLE_OFFSET - 0.115), 2.0, 0.012, 0.24, 0.12);
                }
                if (pole.wired) {
                    part(masts, address, L(POLE_OFFSET), 4.3, 1, 7.4, 1);
                    // Cantilever: top tube, tie rod, bracket tube and steady arm.
                    span(steelParts, address, L(POLE_OFFSET), 7.25, L(0.2), 7.0, 0.07);
                    span(steelParts, address, L(POLE_OFFSET), 7.85, L(1.4), 7.13, 0.03);
                    span(steelParts, address, L(POLE_OFFSET), 6.25, L(0.6), 6.95, 0.07);
                    span(steelParts, address, L(1.9), 6.6, stagger, CONTACT_Y + 0.05, 0.04);
                    // Insulators: a stack of sheds on each tube where it meets the mast.
                    for (const y of [7.22, 6.3]) for (let shed = 0; shed < 3; shed++)
                        part(LOOK.coping, address, L(POLE_OFFSET - 0.3 - shed * 0.08), y + (y > 7 ? -0.01 : 0.012) * shed, 0.035, 0.15, 0.15);
                    part(steelParts, address, L(POLE_OFFSET), 7.93, 0.5, 0.05, 0.05);
                } else part(masts, address, L(POLE_OFFSET), 2.55, 0.85, 3.9, 0.85);
                // Over open water the camera flies at 5 to 7 m and the line is
                // written on the sky: bare posts stay below that eye line.
                const lampY = pole.wired ? LAMP_Y : 4.2;
                const dreaming = dreamAt(address) > 0.5;
                if (dreaming ? id % 4 === 0 : id % 7 !== 3) {
                    // Luminaire: bracket, hooded housing and the lit diffuser below it.
                    span(steelParts, address, L(POLE_OFFSET), lampY + 0.02, L(LAMP_OFFSET - 0.2), lampY + 0.2, 0.05);
                    if (!saving) {
                        // A stay under the bracket and the clamp that holds both to the pole.
                        span(steelParts, address, L(POLE_OFFSET), lampY - 0.4, L(LAMP_OFFSET + 0.3), lampY + 0.12, 0.025);
                        part(steelParts, address, L(POLE_OFFSET), lampY - 0.19, 0.2, 0.5, 0.2);
                    }
                    // Hooded housing: a lid sloping off the front, the body, the lit diffuser under it.
                    part(LOOK.paint, address, L(LAMP_OFFSET), lampY + 0.17, 0.82, 0.09, 0.3);
                    part(LOOK.paint, address, L(LAMP_OFFSET - 0.02), lampY + 0.235, 0.7, 0.04, 0.24, side * 0.08);
                    part(glowParts, address, L(LAMP_OFFSET), lampY + 0.105, 0.66, 0.04, 0.2);
                    spillAt(address, L(LAMP_OFFSET), lampY - 0.2, 2.2);
                    const hf = track.at(address);
                    haloPositions[haloCount * 3] = hf.position.x + hf.right.x * L(LAMP_OFFSET);
                    haloPositions[haloCount * 3 + 1] = lampY;
                    haloPositions[haloCount * 3 + 2] = hf.position.z + hf.right.z * L(LAMP_OFFSET);
                    haloCount++;
                    lightAnchors.push({ address, side, y: lampY, distance: Math.abs(address - s) });
                }
                // A block signal on every eleventh pole, its lamp in the cold palette colour.
                if (id % 11 === 5 && !saving && !dreaming && !atStation(address, side, 2) && !inSight(track, address, 2.3, side)) {
                    part(masts, address + 1.2, L(2.3), 1.9, 0.7, 3.8, 0.7);
                    part(LOOK.ink, address + 1.2, L(2.3), 3.55, 0.36, 1.0, 0.16);
                    part(LOOK.paint, address + 1.08, L(2.3), 3.86, 0.3, 0.04, 0.22);
                    part(coldGlowParts, address + 1.1, L(2.3), 3.72, 0.15, 0.15, 0.03);
                    part(steelParts, address + 1.08, L(2.3), 3.5, 0.3, 0.04, 0.22);
                    part(glowParts, address + 1.1, L(2.3), 3.36, 0.11, 0.11, 0.03);
                }
                const next = polePlan[index + 1];
                if (!pole.wired || !next.wired) return;
                const nextStagger = next.id % 2 ? 0.18 : -0.18;
                for (let segment = 0; segment < 8; segment++) {
                    const u0 = segment / 8, u1 = (segment + 1) / 8;
                    const sag = u => 7.0 - Math.sin(u * Math.PI) * 0.72;
                    const lateral = u => L(0.2) + (next.side * 0.2 - L(0.2)) * u;
                    wire(address + u0 * spacing, lateral(u0), sag(u0), address + u1 * spacing, lateral(u1), sag(u1));
                    // Feeder along the mast tops.
                    const feeder = u => L(POLE_OFFSET) + (next.side - side) * POLE_OFFSET * u;
                    const droop = u => 7.95 - Math.sin(u * Math.PI) * 0.3;
                    if (side === next.side) wire(address + u0 * spacing, feeder(u0), droop(u0),
                        address + u1 * spacing, feeder(u1), droop(u1));
                    // Droppers hang the level contact wire from the sagging messenger.
                    if (segment % 2 === 1) wire(address + u1 * spacing, lateral(u1), sag(u1), address + u1 * spacing,
                        stagger + (nextStagger - stagger) * u1, CONTACT_Y);
                }
                for (let half = 0; half < 2; half++) wire(address + half * spacing / 2,
                    stagger + (nextStagger - stagger) * half / 2, CONTACT_Y, address + (half + 1) * spacing / 2,
                    stagger + (nextStagger - stagger) * (half + 1) / 2, CONTACT_Y);
            });
            wireCount = wireVertex;
            gullsOn = enabled && !saving;
            wires.visible = enabled;
            haloGeometry.setDrawRange(0, haloCount);
            haloGeometry.attributes.position.needsUpdate = true;
            halos.visible = enabled && !saving;
            lightAnchors.sort((a, b) => a.distance - b.distance);

            // --- Stations ---
            liveStations = 0;
            stationTypes = [];
            stationPlan = [];
            const motifNames = ['sheltered-platform', 'waiting-shelters', 'water-stairs', 'station-house', 'lone-platform'];
            const beforeStations = sceneryPools.reduce((sum, mesh) => sum + mesh.count, 0);
            for (const { id, address, open, side, dream } of stations) {
                // The steps belong to open water; lit stations rotate through the other three.
                const type = dream > 0.5 ? 4 : open ? 2 : [0, 1, 3][id % 3];
                const lateral = value => side * value;
                // Whatever would stand between the train and a line being sung is
                // left out, bay by bay: the station keeps an opening there.
                const clear = (at, offset, top) => top < SIGHT_FLOOR || !inSight(track, at, Math.abs(offset), side);
                const part = (mesh, at, offset, y, sx, sy, sz, roll = 0, pitch = 0) => {
                    const pieces = y + sy / 2 < SIGHT_FLOOR ? 1 : Math.max(1, Math.round(sz / 5.5));
                    for (let i = 0; i < pieces; i++) {
                        const z = at - sz / 2 + (i + 0.5) * sz / pieces;
                        if (clear(z, offset, y + sy / 2)) rawPart(mesh, z, offset, y, sx, sy, sz / pieces, roll, pitch);
                    }
                };
                const span = (mesh, at, l0, y0, l1, y1, thick, depth = thick) => {
                    const pieces = Math.max(1, Math.round(depth / 5.5));
                    for (let i = 0; i < pieces; i++) {
                        const z = at - depth / 2 + (i + 0.5) * depth / pieces;
                        if (clear(z, (l0 + l1) / 2, Math.max(y0, y1))) rawSpan(mesh, z, l0, y0, l1, y1, thick, depth / pieces);
                    }
                };
                // All objects remain below/away from the lyric viewing zone:
                // lyric signs stand at +/-18m; shelters stay within +/-10m and
                // take the side with no screen nearby.
                // Fittings that stand above the sight line go up whole or not at all.
                const whole = (at, offset, top, reach = 0) =>
                    [-reach, 0, reach].every(d => clear(at + d, offset, top));
                // A bevelled member between two points of the cross-section, kept whole.
                const strut = (finish, at, l0, y0, l1, y1, thick, depth = thick) =>
                    rawSpan(finish, at, lateral(l0), y0, lateral(l1), y1, thick, depth);
                const fit = (finish, at, offset, y, sx, sy, sz, roll = 0, pitch = 0) =>
                    rawPart(finish, at, lateral(offset), y, sx, sy, sz, roll, pitch);
                // Someone waiting: a figure in a long coat, seen only as a shape.
                const figure = (z, offset, seed) => {
                    const r = seededRandom(`waiting:${id}:${seed}`);
                    const tall = 0.92 + r() * 0.14, base = 1.12;
                    const y = v => base + v * tall;
                    for (const leg of [-0.075, 0.075]) part(LOOK.figure, z + leg, lateral(offset), y(0.36), 0.11, 0.72 * tall, 0.11);
                    // A coat that narrows from the hem to the shoulders, arms close at the sides.
                    [[0.66, 0.42, 0.26, 0.44], [1.0, 0.36, 0.24, 0.41], [1.3, 0.2, 0.22, 0.38]]
                        .forEach(([at, height, depth, width]) => part(LOOK.figure, z, lateral(offset), y(at),
                            depth, height * tall, width));
                    for (const arm of [-0.2, 0.2]) part(LOOK.figure, z + arm, lateral(offset), y(1.07), 0.09, 0.5 * tall, 0.09, 0, arm * 0.2);
                    part(LOOK.figure, z, lateral(offset), y(1.45), 0.08, 0.08, 0.08);
                    part(LOOK.head, z, lateral(offset), y(1.58), 0.17, 0.21, 0.16);
                    // Some carry a closed umbrella, its tip on the deck.
                    if (r() > 0.5) part(LOOK.tube, z + 0.33, lateral(offset - 0.05), y(0.42), 0.03, 0.86, 0.03, 0, 0.12);
                };
                // A platform bench: slatted seat and back on two cast ends, an arm at each.
                const bench = (z, back, length = 1.8) => {
                    for (let slat = 0; slat < 4; slat++)
                        part(LOOK.timber, z, lateral(back - 0.42 + slat * 0.11), 1.57, 0.085, 0.035, length);
                    for (let slat = 0; slat < 2; slat++)
                        part(LOOK.timber, z, lateral(back - 0.02 - slat * 0.012), 1.78 + slat * 0.15, 0.03, 0.1, length, side * -0.12);
                    for (const end of [-1, 1]) {
                        const at = z + end * (length / 2 - 0.12);
                        part(LOOK.paint, at, lateral(back - 0.38), 1.33, 0.06, 0.46, 0.06);
                        part(LOOK.paint, at, lateral(back - 0.06), 1.4, 0.06, 0.6, 0.06);
                        part(LOOK.paint, at, lateral(back - 0.22), 1.53, 0.42, 0.04, 0.05);
                        part(LOOK.tube, at + end * 0.04, lateral(back - 0.24), 1.8, 0.36, 0.035, 0.035);
                        part(LOOK.paint, at + end * 0.04, lateral(back - 0.4), 1.68, 0.035, 0.24, 0.035);
                    }
                };
                // A litter bin: slotted drum, a lid with a hood over the mouth.
                const bin = (z, offset) => {
                    part(LOOK.slots, z, lateral(offset), 1.48, 0.42, 0.72, 0.42);
                    part(LOOK.paint, z, lateral(offset), 1.88, 0.46, 0.08, 0.46);
                    part(LOOK.ink, z, lateral(offset - 0.2), 1.72, 0.03, 0.12, 0.26);
                };
                // The station name board: a lit panel on two posts, the line's band
                // under the name, a hood with its lamp over the top.
                const nameboard = (z, offset) => {
                    if (!whole(z, offset, 3.3, 1.1)) return;
                    const face = offset - 0.06;
                    for (const post of [-1.12, 1.12]) {
                        fit(LOOK.tube, z + post, offset, 2.2, 0.08, 2.2, 0.08);
                        fit(LOOK.paint, z + post, offset, 1.16, 0.16, 0.06, 0.16);
                    }
                    fit(LOOK.paint, z, offset, 2.62, 0.1, 0.96, 2.36);
                    fit(LOOK.nameboard, z, face, 2.64, 0.02, 0.8, 2.2);
                    fit(LOOK.warm, z, face - 0.005, 2.3, 0.02, 0.09, 2.2);
                    fit(LOOK.paint, z, offset - 0.12, 3.14, 0.32, 0.06, 2.4);
                    fit(LOOK.lamp, z, offset - 0.2, 3.1, 0.06, 0.02, 2.1);
                };
                // A drinks machine, its front the brightest thing on the platform.
                const machine = (z, offset) => {
                    if (!whole(z, offset, 2.93)) return;
                    fit(LOOK.paint, z, offset, 2.015, 0.7, 1.83, 1.02);
                    fit(LOOK.vending, z, offset - 0.36, 2.0, 0.02, 1.7, 0.9);
                    spillAt(z, lateral(offset - 0.9), 1.9, 0.7);
                    fit(LOOK.paint, z, offset - 0.1, 2.97, 0.86, 0.06, 1.08);
                    fit(LOOK.ink, z, offset, 1.14, 0.74, 0.08, 1.06);
                };
                // A glass-and-steel waiting shelter: four posts in their sleeves, a
                // flat roof with a deep fascia and a light under it, perforated
                // panels low, glass high, a lit poster case closing one end.
                const glassShelter = (z, index) => {
                    const front = 6.75, back = 8.6, mid = (front + back) / 2, half = 2.1;
                    const roofY = 3.66, wallTop = 3.3;
                    bench(z, back - 0.05, 3.2);
                    if (![-half, 0, half].every(at => clear(z + at, 7.6, roofY + 0.1))) return;
                    for (const end of [-half, half]) for (const lat of [front, back]) {
                        fit(LOOK.tube, z + end, lat, 2.37, 0.1, 2.54, 0.1);
                        fit(LOOK.paint, z + end, lat, 1.3, 0.17, 0.38, 0.17);
                    }
                    // Roof: the sheet, its fascia band all round, the light in a slot underneath.
                    fit(LOOK.paint, z, mid + 0.15, roofY + 0.06, back - front + 0.75, 0.06, half * 2 + 0.5, side * 0.05);
                    fit(LOOK.paint, z, front - 0.22, roofY, 0.05, 0.26, half * 2 + 0.5);
                    fit(LOOK.warm, z, front - 0.25, roofY, 0.012, 0.13, half * 2 + 0.3);
                    fit(LOOK.paint, z, back + 0.38, roofY + 0.02, 0.05, 0.2, half * 2 + 0.5);
                    for (const end of [-1, 1]) fit(LOOK.paint, z + end * (half + 0.25), mid + 0.15, roofY, back - front + 0.75, 0.22, 0.05);
                    fit(LOOK.ink, z, mid, roofY - 0.05, 0.22, 0.03, half * 2 - 0.3);
                    if ((id + index) % 5 !== 3) {
                        fit(LOOK.lamp, z, mid, roofY - 0.07, 0.1, 0.012, half * 2 - 0.5);
                        spillAt(z, lateral(mid), roofY - 0.25, 1.2);
                    }
                    // Back wall: three bays, perforated below the rail and glazed above.
                    for (let bay = -1; bay <= 1; bay++) {
                        const at = z + bay * half * 2 / 3;
                        fit(LOOK.perforated, at, back, 1.56, 0.02, 0.62, half * 2 / 3 - 0.08);
                        fit(LOOK.glass, at, back, 2.6, 0.015, 1.3, half * 2 / 3 - 0.08);
                        if (bay < 1) fit(LOOK.paint, at + half / 3, back, 2.3, 0.06, 2.0, 0.05);
                    }
                    for (const y of [1.25, 1.88, wallTop]) fit(LOOK.paint, z, back, y, 0.07, 0.06, half * 2);
                    fit(LOOK.warm, z, back - 0.04, wallTop - 0.17, 0.01, 0.2, half * 2 - 0.1);
                    // The poster case at the far end, lit both sides; a glass screen at the near one.
                    const caseAt = z + half * (index ? -1 : 1), poster = LOOK.posters[(id + index) % 3];
                    fit(LOOK.paint, caseAt, mid + 0.1, 2.25, back - front - 0.1, 1.95, 0.13);
                    for (const face of [-1, 1]) fit(poster, caseAt + face * 0.066, mid + 0.1, 2.27, back - front - 0.32, 1.72, 0.008);
                    const screenAt = z - half * (index ? -1 : 1);
                    fit(LOOK.glass, screenAt, back - 0.45, 2.3, 0.8, 1.95, 0.015);
                    fit(LOOK.paint, screenAt, back - 0.45, 3.28, 0.86, 0.05, 0.05);
                    // Timetable on the front post.
                    fit(LOOK.paint, z - half * 0.5, front + 0.02, 2.45, 0.05, 0.86, 0.62);
                    fit(LOOK.timetable, z - half * 0.5, front - 0.01, 2.45, 0.01, 0.78, 0.54);
                };
                // A timber shelter as on the small platforms: a weatherboarded back
                // between cheek walls, a tin lean-to roof on two posts, one tube lamp.
                const timberShelter = (z, index) => {
                    bench(z, 8.4, 2.6);
                    if (![-2.1, 0, 2.1].every(at => clear(z + at, 7.6, 3.8))) return;
                    fit(LOOK.boards, z, 8.62, 2.3, 0.08, 2.4, 4.2);
                    for (const cheek of [-2.1, 2.1]) {
                        fit(LOOK.boards, z + cheek, 7.95, 2.3, 1.3, 2.4, 0.08);
                        fit(LOOK.timber, z + cheek, 6.75, 2.42, 0.11, 2.6, 0.11);
                        fit(LOOK.concrete, z + cheek, 6.75, 1.16, 0.22, 0.12, 0.22);
                        fit(LOOK.timber, z + cheek, 7.2, 3.3, 0.9, 0.08, 0.08, side * 0.6);
                    }
                    strut(LOOK.corrugated, z, 6.3, 3.82, 8.95, 3.5, 0.03, 4.8);
                    strut(LOOK.timber, z, 6.4, 3.74, 8.9, 3.44, 0.14, 0.09);
                    fit(LOOK.timber, z, 6.42, 3.72, 0.06, 0.18, 4.8);
                    fit(LOOK.timber, z, 8.62, 3.5, 0.14, 0.12, 4.3);
                    fit(LOOK.paint, z, 7.5, 3.6, 0.14, 0.05, 1.5);
                    if ((id + index) % 5 !== 3) {
                        fit(LOOK.lamp, z, 7.5, 3.565, 0.07, 0.03, 1.3);
                        spillAt(z, lateral(7.5), 3.35, 1.0);
                        rawPart(windowLight, z, lateral(8.575), 2.85, 0.012, 1.2, 4.0);
                    }
                    fit(LOOK.paint, z - 1.0, 8.555, 2.6, 0.03, 0.74, 1.0);
                    fit(LOOK.posters[(id + index) % 3], z - 1.0, 8.535, 2.6, 0.01, 0.66, 0.44);
                    fit(LOOK.timetable, z + 1.0, 8.55, 2.6, 0.01, 0.6, 0.42);
                };
                if (type === 4) {
                    // A bare platform standing just clear of the water: a slab on two
                    // piers, a lamp on a post, a bench, and one or two people waiting.
                    part(LOOK.concrete, address, lateral(5.6), 0.86, 3.2, 0.3, 12);
                    part(LOOK.coping, address, lateral(4.1), 1.03, 0.36, 0.06, 12.1);
                    for (const pier of [-4.5, 4.5]) part(LOOK.concrete, address + pier, lateral(5.6), 0.3, 2.6, 0.9, 0.5);
                    const lamp = address - 3.5;
                    if (whole(lamp, 6.6, 3.9)) {
                        fit(LOOK.tube, lamp, 6.6, 2.5, 0.09, 2.8, 0.09);
                        fit(LOOK.paint, lamp, 6.6, 1.12, 0.18, 0.1, 0.18);
                        strut(LOOK.tube, lamp, 6.6, 3.8, 5.9, 3.95, 0.04);
                        fit(LOOK.paint, lamp, 5.85, 3.95, 0.36, 0.14, 0.36);
                        fit(LOOK.lamp, lamp, 5.85, 3.86, 0.26, 0.04, 0.26);
                        spillAt(lamp, lateral(5.85), 3.6, 1.6);
                    }
                    bench(address + 1.5, 6.9, 1.6);
                    figure(address - 1.2, 5.1, 0);
                    if (id % 3 === 0) figure(address + 4.2, 5.9, 1);
                    stationTypes.push(motifNames[type]);
                    stationPlan.push({ address, side, type: motifNames[type] });
                    liveStations++;
                    continue;
                }
                // The platform is a deck on cross walls standing in the water, its
                // edge carried out past them on a beam: coping stones, the white line,
                // and the band of tactile paving a pace back from the edge.
                part(LOOK.paving, address, lateral(6.6), 0.97, 4.8, 0.26, 28);
                part(LOOK.concrete, address, lateral(4.3), 0.9, 0.32, 0.36, 28);
                for (let pier = 0; pier < (saving ? 4 : 8); pier++) {
                    part(LOOK.concrete, address - 13.3 + pier * (saving ? 8.87 : 3.8), lateral(6.75), 0.42, 4.3, 0.86, 0.55);
                }
                part(LOOK.coping, address, lateral(4.2), 1.13, 0.7, 0.08, 28.2);
                part(glowParts, address, lateral(3.84), 1.12, 0.045, 0.035, 28);
                part(paleMarks, address, lateral(4.5), 1.174, 0.07, 0.012, 27.6);
                part(LOOK.tactile, address, lateral(4.95), 1.112, 0.3, 0.02, 27.6);
                part(LOOK.concrete, address, lateral(8.8), 1.25, 0.18, 0.3, 28);
                // Steps run down into the shallows at both ends.
                for (let step = 0; step < 4; step++) {
                    const height = 1.1 - (step + 1) * 0.22;
                    for (const end of [-1, 1]) part(LOOK.concrete, address + end * (14.45 + step * 0.9),
                        lateral(6.5), height / 2, 5, height, 0.9);
                }
                if (!saving && !open) {
                    machine(address - 9.5, 8.22);
                    bin(address - 8.4, 8.4);
                    // The card reader on its post by the steps.
                    part(LOOK.paint, address + 12.4, lateral(5.5), 1.62, 0.1, 1.04, 0.1);
                    part(LOOK.paint, address + 12.4, lateral(5.5), 2.2, 0.2, 0.14, 0.26, side * 0.5);
                    part(coldGlowParts, address + 12.4, lateral(5.46), 2.275, 0.1, 0.012, 0.12, side * 0.5);
                }
                if (type === 0) {
                    // Butterfly canopy on a single row of Y columns: two roof
                    // planes fold down to a valley gutter over the column line.
                    // Under the sheeting the boards of the ceiling catch the tube
                    // lamps, and the purlins cross them as dark lines.
                    span(LOOK.corrugated, address, lateral(4.1), 5.62, lateral(7), 5.16, 0.05, 26);
                    span(LOOK.corrugated, address, lateral(7), 5.16, lateral(9.5), 5.5, 0.05, 26);
                    span(LOOK.soffit, address, lateral(4.18), 5.542, lateral(6.86), 5.117, 0.02, 25.9);
                    span(LOOK.soffit, address, lateral(7.14), 5.114, lateral(9.42), 5.424, 0.02, 25.9);
                    for (const [offset, y] of [[4.9, 5.37], [6.0, 5.2], [7.9, 5.16], [8.8, 5.28]])
                        part(LOOK.paint, address, lateral(offset), y, 0.07, 0.1, 26);
                    part(LOOK.paint, address, lateral(7), 5.02, 0.32, 0.24, 26);
                    part(LOOK.paint, address, lateral(4.12), 5.56, 0.07, 0.24, 26.1);
                    part(LOOK.paint, address, lateral(9.48), 5.44, 0.07, 0.22, 26.1);
                    for (let bay = 0; bay < 5; bay++) {
                        const z = address - 11 + bay * 5.5;
                        part(LOOK.tube, z, lateral(7), 3.0, 0.24, 3.8, 0.24);
                        part(LOOK.concrete, z, lateral(7), 1.2, 0.46, 0.2, 0.46);
                        part(LOOK.paint, z, lateral(7), 1.33, 0.34, 0.06, 0.34);
                        span(LOOK.tube, z, lateral(7), 4.15, lateral(4.9), 5.38, 0.11);
                        span(LOOK.tube, z, lateral(7), 4.15, lateral(9.0), 5.33, 0.11);
                        part(LOOK.paint, z, lateral(7), 4.18, 0.3, 0.2, 0.3);
                        if ((id + bay) % 7 !== 3) {
                            part(glowParts, z + 2.75, lateral(5.5), 5.3, 0.1, 0.04, 2.3);
                            spillAt(z + 2.75, lateral(5.5), 5.1, 2.6);
                            // The batten the tube is fixed to, and its two drops.
                            if (!saving) part(LOOK.paint, z + 2.75, lateral(5.5), 5.345, 0.16, 0.05, 2.5);
                        }
                        // The valley gutter drains down the end columns.
                        if (!saving && (bay === 0 || bay === 4)) {
                            part(LOOK.tube, z + (bay ? 0.19 : -0.19), lateral(7), 3.05, 0.08, 3.7, 0.08);
                            part(LOOK.paint, z + (bay ? 0.19 : -0.19), lateral(7), 1.34, 0.12, 0.08, 0.14);
                        }
                        // Timetable, fare table and route map on the middle columns.
                        if (!saving && (bay === 1 || bay === 3)) {
                            part(LOOK.paint, z, lateral(6.84), 2.45, 0.04, 1.0, 0.74);
                            part(bay === 1 ? LOOK.timetable : LOOK.route, z, lateral(6.815), 2.45, 0.01, 0.9, 0.66);
                        }
                    }
                    if (!saving) {
                        // Hanging platform sign: a lit box on two drops.
                        for (const hanger of [-0.8, 0.8])
                            part(LOOK.tube, address - 2.75, lateral(5.6 + hanger), 4.9, 0.03, 0.75, 0.03);
                        part(LOOK.paint, address - 2.75, lateral(5.6), 4.3, 2.1, 0.5, 0.12);
                        for (const face of [-0.065, 0.065])
                            part(LOOK.nameboard, address - 2.75 + face, lateral(5.6), 4.3, 2.0, 0.42, 0.005);
                        // The back rail.
                        for (const y of [1.65, 2.15]) part(LOOK.tube, address, lateral(9.15), y, 0.05, 0.05, 26);
                        for (let post = 0; post <= 8; post++)
                            part(LOOK.tube, address - 13 + post * 3.25, lateral(9.15), 1.65, 0.06, 1.1, 0.06);
                        nameboard(address + 8.25, 8.85);
                        // A clock hangs from the canopy beside the platform sign.
                        const clock = address + 2.75;
                        if (clear(clock, 5.6, 5)) {
                            fit(LOOK.tube, clock, 5.6, 4.86, 0.03, 0.62, 0.03);
                            fit(LOOK.paint, clock, 5.6, 4.3, 0.16, 0.56, 0.56);
                            for (const face of [-0.085, 0.085]) fit(LOOK.clock, clock, 5.6 + face, 4.3, 0.005, 0.48, 0.48);
                        }
                    }
                } else if (type === 1) {
                    // Two waiting shelters with the platform open to the water
                    // between them: one of glass and steel, one of timber.
                    // A shelter that would stand in a sight line leaves only its bench.
                    glassShelter(address - 4.6, 0);
                    timberShelter(address + 3.6, 1);
                    if (!saving) {
                        nameboard(address + 9.2, 8.6);
                        // A sign on a pole at the platform's open end.
                        const pole = address - 9.6;
                        if (whole(pole, 6.4, 3.4)) {
                            fit(LOOK.tube, pole, 6.4, 2.6, 0.07, 3.0, 0.07);
                            fit(LOOK.paint, pole, 6.4, 1.18, 0.14, 0.08, 0.14);
                            fit(LOOK.paint, pole, 6.4, 3.2, 0.05, 0.62, 0.56);
                            for (const face of [-0.03, 0.03]) fit(LOOK.timetable, pole, 6.4 + face, 3.2, 0.005, 0.54, 0.48);
                            fit(LOOK.warm, pole, 6.4, 3.56, 0.06, 0.1, 0.56);
                        }
                    }
                } else if (type === 2) {
                    // Broad steps descend toward the water, not into the sky.
                    // In open acts they replace dense station silhouettes.
                    for (let step = 0; step < 7; step++) {
                        const height = 1.05 - step * 0.14;
                        part(LOOK.concrete, address, lateral(9.2 + step * 0.65),
                            height * 0.5, 0.7, height, 13 - step * 0.65);
                    }
                    for (const z of [-10, 10]) {
                        part(masts, address + z, lateral(10), 2.5, 0.75, 3.0, 0.75);
                        part(steelParts, address + z, lateral(10), 4.42, 0.56, 0.06, 0.56);
                        part(glowParts, address + z, lateral(10), 4.2, 0.34, 0.38, 0.34);
                    }
                    if (!saving) {
                        // A gate standing alone in the shallows beyond the steps: round
                        // columns leaning in on stone footings, a tie beam run through
                        // them and wedged, a strut carrying the tablet, and a lintel
                        // that lifts towards its ends.
                        const gate = lateral(15.5);
                        for (const z of [-2.9, 2.9]) {
                            part(LOOK.warmTube, address + z * 0.975, gate, 3.0, 0.46, 5.9, 0.46, 0, z > 0 ? 0.045 : -0.045);
                            part(LOOK.concrete, address + z, gate, 0.16, 1.05, 0.5, 1.05);
                            part(LOOK.concrete, address + z, gate, 0.5, 0.82, 0.18, 0.82);
                            part(steelParts, address + z * 0.96, gate, 4.92, 0.6, 0.05, 0.16);
                        }
                        part(LOOK.warm, address, gate, 4.7, 0.22, 0.38, 7.5);
                        part(LOOK.warm, address, gate, 5.27, 0.18, 0.76, 0.3);
                        part(LOOK.timber, address, lateral(15.36), 5.27, 0.05, 0.84, 0.58);
                        part(LOOK.warm, address, gate, 5.8, 0.36, 0.3, 6.9);
                        part(LOOK.warm, address, gate, 6.08, 0.54, 0.2, 4.4);
                        for (const end of [-1, 1]) {
                            part(LOOK.warm, address + end * 3.3, gate, 6.17, 0.54, 0.2, 2.3, 0, end * 0.08);
                            part(LOOK.ink, address + end * 3.3, gate, 6.3, 0.62, 0.05, 2.34, 0, end * 0.08);
                        }
                        part(LOOK.ink, address, gate, 6.2, 0.62, 0.05, 4.44);
                        part(coldGlowParts, address, gate, 4.3, 0.2, 0.3, 0.2);
                        part(steelParts, address, gate, 4.47, 0.26, 0.04, 0.26);
                    }
                    // Rocks gathered against the ends of the steps and out past the gate.
                    const pile = seededRandom(`rocks:${id}`);
                    for (const [along, out, size] of [[-8.6, 11.2, 1.25], [-10.9, 13.4, 0.8], [8.2, 12.2, 1.45],
                        [10.8, 10.6, 0.7], [6.4, 17.6, 1.0], [-5.6, 18.4, 0.6]]) {
                        rock(address + along + (pile() - 0.5) * 1.2, lateral(out + (pile() - 0.5) * 1.2),
                            size * (0.85 + pile() * 0.35), pile() * 6.28);
                    }
                } else {
                    // A timber station house along the back of the platform:
                    // weatherboarded walls on a concrete base, a row of sash windows
                    // lit from inside, the ticket window and the way through beside
                    // it, posters by the door, and a tin gable roof whose eaves come
                    // out over the platform. Where it would stand in a sight line only
                    // the boarded fence at its foot is built.
                    const HOUSE = 13, wall = lateral(8.36), face = lateral(8.3);
                    part(LOOK.concrete, address, lateral(9.6), 0.55, 2.4, 1.1, HOUSE);
                    part(LOOK.boards, address, wall, 1.72, 0.1, 1.2, HOUSE);
                    part(LOOK.paint, address, wall, 2.34, 0.16, 0.05, HOUSE + 0.1);
                    if ([-6, -3, 0, 3, 6].every(at => clear(address + at, 9.3, 4.6))) {
                        rawPart(LOOK.boards, address, wall, 2.95, 0.1, 1.2, HOUSE);
                        for (const end of [-1, 1]) {
                            rawPart(LOOK.boards, address + end * HOUSE / 2, lateral(9.4), 2.35, 2.1, 2.5, 0.1);
                            rawPart(LOOK.timber, address + end * HOUSE / 2, lateral(8.36), 2.35, 0.14, 2.5, 0.14);
                            // The gable closes up to the ridge in two steps of boarding.
                            rawPart(LOOK.boards, address + end * HOUSE / 2, lateral(9.4), 3.83, 1.9, 0.46, 0.1);
                            rawPart(LOOK.boards, address + end * HOUSE / 2, lateral(9.4), 4.22, 0.8, 0.32, 0.1);
                        }
                        // Sash windows: a lit pane, its cross of glazing bars, sill and head.
                        [-5.2, -3.2, -1.2, 5.2].forEach((at, index) => {
                            const z = address + at;
                            rawPart((id + index) % 4 === 1 ? warmMarks : windowLight, z, face, 2.6, 0.02, 0.95, 1.3);
                            fit(LOOK.timber, z, 8.285, 2.6, 0.03, 0.95, 0.045);
                            fit(LOOK.timber, z, 8.285, 2.6, 0.03, 0.045, 1.3);
                            fit(LOOK.timber, z, 8.25, 2.1, 0.14, 0.05, 1.44);
                            fit(LOOK.timber, z, 8.28, 3.1, 0.05, 0.07, 1.44);
                        });
                        // The ticket window with its counter and grille, and the open way through.
                        rawPart(glowParts, address + 1.0, face, 2.42, 0.02, 0.5, 0.82);
                        for (let bar = -2; bar <= 2; bar++) fit(LOOK.paint, address + 1.0 + bar * 0.16, 8.28, 2.42, 0.015, 0.5, 0.015);
                        fit(LOOK.timber, address + 1.0, 8.18, 2.1, 0.34, 0.05, 1.06);
                        fit(LOOK.paint, address + 1.0, 8.2, 2.78, 0.26, 0.04, 1.06, side * 0.25);
                        rawPart(windowLight, address + 3.2, face, 2.2, 0.02, 2.0, 1.12);
                        for (const jamb of [-0.6, 0.6]) fit(LOOK.timber, address + 3.2 + jamb, 8.28, 2.2, 0.07, 2.06, 0.09);
                        fit(LOOK.timber, address + 3.2, 8.28, 3.24, 0.07, 0.08, 1.28);
                        fit(LOOK.clock, address + 2.1, 8.29, 3.02, 0.01, 0.34, 0.34);
                        // Posters and the timetable on the wall by the way through.
                        for (const [at, finish] of [[4.3, LOOK.posters[id % 3]], [-3.2 + 1.0, LOOK.timetable]]) {
                            if (at < 0) continue;
                            fit(LOOK.paint, address + at, 8.29, 2.5, 0.03, 0.82, 0.6);
                            fit(finish, address + at, 8.27, 2.5, 0.01, 0.74, 0.52);
                        }
                        // Roof: two tin slopes, the ridge cap, the gutter and its
                        // downpipes, and bulbs under the eaves.
                        rawSpan(LOOK.corrugated, address, lateral(7.35), 3.42, lateral(9.4), 4.5, 0.05, HOUSE + 1.2);
                        rawSpan(LOOK.corrugated, address, lateral(9.4), 4.5, lateral(11.2), 3.55, 0.05, HOUSE + 1.2);
                        fit(LOOK.paint, address, 9.4, 4.56, 0.22, 0.1, HOUSE + 1.3);
                        fit(LOOK.tube, address, 7.37, 3.36, 0.1, 0.1, HOUSE + 1.2);
                        for (const end of [-1, 1]) fit(LOOK.tube, address + end * (HOUSE / 2 + 0.3), 7.4, 2.3, 0.07, 2.2, 0.07);
                        for (const at of [-4.2, 0, 4.2]) {
                            fit(LOOK.paint, address + at, 7.8, 3.5, 0.3, 0.04, 0.3);
                            fit(LOOK.lamp, address + at, 7.8, 3.44, 0.12, 0.06, 0.12);
                            spillAt(address + at, lateral(7.8), 3.2, 0.9);
                        }
                    }
                    if (!saving) machine(address + 7.6, 8.0);
                }
                if (type !== 1) for (let seat = 0; seat < (saving ? 1 : 3); seat++) {
                    if ((id + seat) % 4 === 2) continue;
                    const z = address - 7 + seat * 7 + (type === 0 ? 2.75 : type === 3 ? 0.6 - seat * 1.6 : 0);
                    bench(z, type === 2 ? 7.25 : 8.2);
                }
                stationTypes.push(motifNames[type]);
                stationPlan.push({ address, side, type: motifNames[type] });
                liveStations++;
            }
            stationInstances = sceneryPools.reduce((sum, mesh) => sum + mesh.count, 0) - beforeStations;

            // --- Level crossings ---
            // A road comes up out of the shallows, crosses the line and goes down
            // again, as the coast road does at every other station along the bay.
            // The train is always passing, so the arms are down and the lamps flash.
            const crossings = [];
            const ROAD = 2.3, crossingPitch = spacing * 11;
            for (let cell = Math.floor((s - 80) / crossingPitch); cell <= Math.floor((s + 260) / crossingPitch)
                && enabled; cell++) {
                if (cell < 0) continue;
                // Midway between two poles, so neither stands in the road.
                const address = cell * crossingPitch + spacing * 5.5;
                if ([-1, 1].some(side => atStation(address, side, 10)) || dreamAt(address) > 0.3) continue;
                crossings.push(address);
                part(LOOK.timber, address, 0, 0.3, 1.26, 0.2, ROAD * 2);
                for (const side of [-1, 1]) {
                    const L = value => side * value;
                    part(LOOK.concrete, address, L(2.0), 0.3, 2.4, 0.2, ROAD * 2);
                    span(LOOK.concrete, address, L(3.2), 0.3, L(8.2), -0.22, 0.2, ROAD * 2);
                    for (const edge of [-1, 1]) {
                        part(LOOK.concrete, address + edge * (ROAD + 0.1), L(4.3), 0.32, 2.2, 0.34, 0.2);
                        // The road's edge line, and a guard rail down the ramp.
                        part(paleMarks, address + edge * (ROAD - 0.22), L(2.0), 0.406, 2.4, 0.012, 0.1);
                        span(LOOK.tube, address + edge * (ROAD + 0.1), L(5.5), 0.86, L(8.1), 0.36, 0.06, 0.06);
                        for (const post of [5.6, 6.8, 8.0])
                            part(LOOK.tube, address + edge * (ROAD + 0.1), L(post), 0.5 - (post - 5.6) * 0.19, 0.07, 0.7, 0.07);
                    }
                    // The stop line.
                    part(paleMarks, address, L(3.05), 0.406, 0.28, 0.012, ROAD * 2 - 0.5);
                    // The signal stands on the left of the road as it comes up to the line.
                    const post = address - side * (ROAD + 0.55), at = L(3.3);
                    // The road stays; its signal and barrier give way to the camera.
                    if (inTheWay(post, L(3.6), 3.7, 1.3, 5)) continue;
                    const tall = !inSight(track, post, 3.3, side, 4);
                    part(LOOK.concrete, post, at, 0.34, 0.5, 0.5, 0.5);
                    part(masts, post, at, tall ? 2.0 : 1.4, 0.95, tall ? 2.9 : 1.7, 0.95);
                    for (const band of [0.85, 1.25]) part(LOOK.stripes, post, at, band, 0.2, 0.2, 0.2);
                    // Two lamps side by side on a dark board, each under its hood.
                    part(LOOK.ink, post, at, 1.95, 0.07, 0.38, 0.98);
                    for (const lamp of [-0.27, 0.27]) {
                        part(signalLamps, post + lamp, at, 1.95, 0.13, 0.21, 0.21);
                        part(LOOK.ink, post + lamp, at, 2.09, 0.3, 0.03, 0.27);
                        part(LOOK.ink, post + lamp, at, 1.95, 0.24, 0.26, 0.26);
                    }
                    if (tall) {
                        // The crossed boards, and the bell on top.
                        for (const lean of [-0.6, 0.6]) part(LOOK.stripes, post, at, 2.72, 0.045, 0.15, 1.28, 0, lean);
                        part(LOOK.paint, post, at, 3.5, 0.24, 0.16, 0.24);
                        part(LOOK.ink, post, at, 3.4, 0.14, 0.06, 0.14);
                    }
                    // The barrier machine and its arm, down across the road in bands of light and dark.
                    part(LOOK.louvre, post, L(3.85), 0.78, 0.34, 0.8, 0.5);
                    part(LOOK.paint, post, L(3.85), 1.2, 0.4, 0.05, 0.56);
                    part(LOOK.stripes, post + side * 2.6, L(3.85), 1.08, 0.08, 0.08, 4.3);
                    part(signalLamps, post + side * 3.0, L(3.85), 0.98, 0.07, 0.09, 0.09);
                    rock(address - side * (ROAD + 1.6), L(7.4), 0.75, cell * 2.4 + side);
                    rock(address + side * (ROAD + 1.1), L(6.1), 0.5, cell * 1.3 - side);
                }
            }
            // --- Remains of old piers: weathered posts standing in the shallows ---
            for (let cell = Math.floor((s - 60) / 34); cell <= Math.floor((s + 240) / 34) && enabled && !saving; cell++) {
                if (cell < 0) continue;
                const random = seededRandom(`mooring:${cell}`);
                if (random() > 0.62) continue;
                const address = cell * 34 + random() * 18;
                if (dreamAt(address) > 0.5 && cell % 3) continue;
                // Only where no screen stands within reading distance on that side.
                const side = poleSide(track, address);
                const count = 3 + Math.floor(random() * 5), outward = random() > 0.45;
                const reach = 8.5 + random() * 5, lantern = random() > 0.5;
                if (atStation(address, side, 12) || crossings.some(at => Math.abs(at - address) < 14)) continue;
                if (random() > 0.6) rock(address - 1.5, side * (reach + 1.4), 0.55 + random() * 0.5, random() * 6.28, 0.2);
                for (let post = 0; post < count; post++) {
                    const height = 0.9 + random() * 1.7;
                    const at = address + (outward ? (random() - 0.5) * 0.5 : post * 1.9);
                    const lateral = side * (reach + (outward ? post * 1.7 : (random() - 0.5) * 0.5));
                    const lean = [(random() - 0.5) * 0.2, (random() - 0.5) * 0.16];
                    const tall = height + (lantern && post === count - 1 ? 0.35 : 0);
                    // Even a low post is in the way when it stands under a screen being read.
                    if (inSight(track, at, Math.abs(lateral), side, tall > SIGHT_FLOOR ? 3 : 1)) continue;
                    if (inTheWay(at, lateral, tall + 0.3, 0.5)) continue;
                    part(timberParts, at, lateral, height / 2 - 0.3, 0.22, height + 0.6, 0.22, lean[0], lean[1]);
                    if (lantern && post === count - 1) {
                        part(steelParts, at, lateral, height + 0.06, 0.2, 0.05, 0.2);
                        part(coldGlowParts, at, lateral, height + 0.2, 0.13, 0.22, 0.13);
                    }
                }
            }
            // A small house on its rock: boarded walls, a tin roof, a lit window and the lamp by its door.
            const house = (address, lateral, side, random) => {
                const L = value => lateral + side * value;
                rock(address, lateral, 3.2, random() * 6.28, 0.3);
                rawPart(LOOK.boards, address, lateral, 2.0, 3.4, 2.4, 4.6);
                rawSpan(LOOK.corrugated, address, L(-2.1), 2.95, lateral, 4.3, 0.05, 5.2);
                rawSpan(LOOK.corrugated, address, lateral, 4.3, L(2.1), 2.95, 0.05, 5.2);
                rawPart(LOOK.timber, address, lateral, 4.32, 0.18, 0.12, 5.3);
                rawPart(windowLight, address - 0.8, L(-1.71), 2.2, 0.02, 0.8, 1.1);
                rawPart(LOOK.timber, address - 0.8, L(-1.72), 2.2, 0.03, 0.85, 0.05);
                rawPart(LOOK.timber, address + 1.2, L(-1.72), 1.75, 0.04, 1.7, 0.85);
                rawPart(glowParts, address + 1.9, L(-1.8), 2.75, 0.14, 0.18, 0.14);
                if (haloCount < haloPositions.length / 3) {
                    const f = track.at(address + 1.9);
                    haloPositions.set([f.position.x + f.right.x * L(-1.8), 2.75, f.position.z + f.right.z * L(-1.8)], haloCount * 3);
                    haloCount++;
                }
            };
            // --- Out on the water: squid boats under their lamps, and channel buoys ---
            // A boat works the dark well off the line, a row of bare bulbs strung
            // over its deck from bow to stern; the water doubles every one of them.
            for (let cell = Math.floor((s - 80) / 95); cell <= Math.floor((s + 320) / 95) && enabled && !saving; cell++) {
                if (cell < 0) continue;
                const random = seededRandom(`isaribi:${cell}`);
                if (random() > 0.55) continue;
                const address = cell * 95 + random() * 40;
                const side = random() > 0.5 ? 1 : -1, reach = 32 + random() * 40;
                if (dreamAt(address) > 0.4) {
                    // In the dream the boats are gone. Now and then a house stands on
                    // a rock far out, one window lit.
                    if (cell % 3 === 0) house(address, side * (reach + 10), side, random);
                    // Paper lanterns set adrift, a few together, lit from within.
                    else if (cell % 3 === 1) for (let k = 0; k < 4 + Math.floor(random() * 4); k++) {
                        const at = address + (random() - 0.5) * 30, out = side * (6 + random() * 22);
                        if (inTheWay(at, out, 1, 0.6)) continue;
                        rawPart(LOOK.paint, at, out, waterLevel + 0.03, 0.34, 0.06, 0.34);
                        rawPart(LOOK.lantern, at, out, waterLevel + 0.22, 0.28, 0.32, 0.28);
                        if (haloCount < haloPositions.length / 3) {
                            const f = track.at(at);
                            haloPositions.set([f.position.x + f.right.x * out, waterLevel + 0.24, f.position.z + f.right.z * out], haloCount * 3);
                            haloCount++;
                        }
                    }
                    continue;
                }
                const lateral = side * reach, length = 10 + random() * 3, bulbs = 7 + Math.floor(random() * 3);
                // Farther out than any screen stands, so a boat can only ever be behind one.
                const bow = random() > 0.5 ? 1 : -1;
                // Hull, its sheer stepping up to the bow, wheelhouse aft, masts fore and aft.
                part(concreteParts, address, lateral, 0.35, 2.7, 0.75, length);
                part(concreteParts, address + bow * length * 0.36, lateral, 0.86, 2.4, 0.3, length * 0.26);
                part(steelParts, address, lateral, 0.76, 2.76, 0.06, length + 0.04);
                part(concreteParts, address - bow * length * 0.3, lateral, 1.45, 1.8, 1.5, 2.2);
                part(windowLight, address - bow * (length * 0.3 - 1.12), lateral, 1.62, 1.3, 0.42, 0.02);
                for (const end of [-0.42, 0.4]) part(steelParts, address + bow * length * end, lateral, 2.2, 0.09, 3.6, 0.09);
                // The lamp wire runs between the masts, a bulb under it every metre or so.
                part(steelParts, address - bow * length * 0.01, lateral, 3.55, 0.03, 0.03, length * 0.82);
                for (let i = 0; i < bulbs; i++) {
                    const along = address + bow * length * (-0.38 + 0.76 * (i + 0.5) / bulbs);
                    part(glowParts, along, lateral, 3.32, 0.24, 0.3, 0.24);
                    // Every other bulb throws a halo, so the row reads from far off.
                    if (i % 2 === 0 && haloCount < haloPositions.length / 3) {
                        const f = track.at(along);
                        haloPositions.set([f.position.x + f.right.x * lateral, 3.2, f.position.z + f.right.z * lateral], haloCount * 3);
                        haloCount++;
                    }
                }
            }
            // Buoys mark the channel along the line, a red light winking on each.
            for (let cell = Math.floor((s - 60) / 130); cell <= Math.floor((s + 260) / 130) && enabled && !saving; cell++) {
                if (cell < 0) continue;
                const random = seededRandom(`buoy:${cell}`);
                if (random() > 0.7) continue;
                const address = cell * 130 + random() * 50, side = poleSide(track, address, random() > 0.5 ? 1 : -1);
                if (dreamAt(address) > 0.4) continue;
                const reach = 15 + random() * 10, lateral = side * reach;
                if (atStation(address, side, 20) || inSight(track, address, reach, side, 3)
                    || inTheWay(address, lateral, 3, 1.2)) continue;
                part(steelParts, address, lateral, 0.15, 1.3, 0.7, 1.3);
                part(signalBody, address, lateral, 0.62, 0.9, 0.3, 0.9);
                for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]])
                    part(steelParts, address + z, lateral + x, 1.35, 0.05, 1.3, 0.05, x * 0.35, -z * 0.35);
                part(steelParts, address, lateral, 2.02, 0.42, 0.05, 0.42);
                part(beacons, address, lateral, 2.2, 0.2, 0.28, 0.2);
            }
            haloGeometry.setDrawRange(0, haloCount);
            {
                const eyeX = pose.position.x, eyeZ = pose.position.z;
                spillList.sort((a, b) => Math.hypot(a[0] - eyeX, a[2] - eyeZ) - Math.hypot(b[0] - eyeX, b[2] - eyeZ));
                spills.value.forEach((slot, i) => {
                    const lamp = spillList[i];
                    if (lamp && !saving) slot.set(lamp[0], lamp[1], lamp[2], lamp[3]); else slot.set(0, -100, 0, 0);
                });
            }
            flyGulls(track, s, time);
            tintGlow(time);
            updateLights(track, s, saving, audio);
            sceneryPools.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
            dressRect.needsUpdate = dressLook.needsUpdate = dressCut.needsUpdate = true;
        };
        const renderReflection = (renderer, camera) => {
            prepareEnvironment(renderer);
            if (dead || !reflectionEnabled) return;
            camera.updateMatrixWorld();
            mirror.position.copy(camera.position);
            mirror.position.y = 2 * waterLevel - mirror.position.y;
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
            const plane = new T.Plane(new T.Vector3(0, 1, 0), -waterLevel).applyMatrix4(mirror.matrixWorldInverse);
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
            // Half the picture's own resolution, within a ceiling per tier.
            const buffer = size.x * renderer.getPixelRatio();
            // The ripples blur the mirror image anyway; below the top tier it
            // is drawn at a sixth of the picture's pixels rather than a quarter.
            const width = Math.round(Math.min(buffer * (quality === 'ultimate' ? 0.5 : 0.4),
                quality === 'ultimate' ? 1440 : quality === 'energy-saving' ? 384 : 960));
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
            update, setPalette, renderReflection, updateCabin, prepareEnvironment,
            // How hard it is raining (0..1), for any shader that shows it.
            rain: rainAmount,
            setPixelRatio(ratio) {
                starMat.uniforms.pixelRatio.value = Math.max(0.5, ratio || 1);
                haloMat.uniforms.pixelRatio.value = Math.max(0.5, ratio || 1);
            },
            setWetness(amount) { wetness.value = clamp(amount ?? 0); },
            snapshot: () => ({ liveStations, stationTypes, stationPlan, drownLevel,
                wading, splashTriangles: splash.visible ? splashGeometry.drawRange.count / 3 : 0, wetness: wetness.value, waterVisible: water.visible, reflectionEnabled,
                warmth: liveWarmth, accent: liveAccent, fogDensity: scene.fog?.density ?? 0,
                rain: rainLevel, rainStreaks: rainDrops.visible ? rainGeometry.drawRange.count / 6 : 0, waterLevel,
                lampHalos: halos.visible ? haloGeometry.drawRange.count : 0,
                cabinWeight: cabin.visible ? cabinWeight : 0, saloonVisible: saloon.visible, cabReal: cabReal.value,
                auroraVisible: Boolean(skyMat.uniforms.auroraActive.value > 0.5),
                starOpacity: starMat.opacity, moonRadius: 20,
                instanceRebuilds, reflectionSize: [target.width, target.height],
                architecturalInstances: stationInstances,
                poolFill: sceneryPools.map(mesh => [mesh.count, mesh.instanceMatrix.count]),
                worldInstances: rails.count + sleepers.count
                    + sceneryPools.reduce((sum, mesh) => sum + mesh.count, 0) }),
            destroy() {
                if (dead) return;
                dead = true;
                scene.remove(root);
                root.traverse(object => { if (object.isInstancedMesh) object.dispose(); });
                released = true;
                scans.forEach(texture => texture.dispose());
                geometries.forEach(g => g.dispose());
                materials.forEach(m => m.dispose());
                target.dispose();
                envTarget.dispose();
                if (scene.environment === envTarget.texture) scene.environment = null;
            }
        };
    };
    // Rain on a pane of glass, for the shaders that draw windows. p is a point
    // on the pane in metres (y up), t the playback clock, rain 0..1. Returns
    // the refraction offset in metres (xy) and how much of the point is under
    // water (z): still beads that come and go, and runnels that slide down,
    // each clearing a path through the beads.
    const RAIN_GLASS = `
        float rainHash(vec2 c){return fract(sin(dot(c,vec2(12.9898,78.233)))*43758.5453);}
        vec3 rainOnGlass(vec2 p,float t,float rain){
            if(rain<=0.0)return vec3(0.0);
            vec3 o=vec3(0.0);
            float column=floor(p.x/0.11),hc=rainHash(vec2(column,3.7));
            float cycle=1.4,q=mod(p.y+hc*cycle,cycle);
            float head=cycle*(1.0-fract(t*(0.18+hc*0.22)+hc*5.0));
            float x=p.x-(column+0.5)*0.11-sin(p.y*8.0+hc*6.0)*0.012;
            float runs=step(hc,rain*0.55);
            vec2 d=vec2(x,(q-head)*0.75);
            float drop=smoothstep(0.016,0.009,length(d))*runs;
            float above=q-head;
            float trail=smoothstep(0.0045,0.0015,abs(x))*step(0.0,above)*(1.0-smoothstep(0.0,0.45,above))*runs;
            float cleared=step(0.0,above)*step(above,0.6)*smoothstep(0.022,0.01,abs(x))*runs;
            o.xy+=d*drop*0.8+vec2(x*trail*0.6,0.0);
            o.z=max(drop,trail*0.7);
            vec2 g=p/0.03,c=floor(g),f=fract(g)-0.5;
            float h=rainHash(c);
            vec2 at=f-(vec2(rainHash(c+1.3),rainHash(c+7.1))-0.5)*0.5;
            float life=fract(t*0.07+h*9.0);
            float present=step(h,rain*0.6)*smoothstep(0.0,0.08,life)*(1.0-smoothstep(0.8,1.0,life))*(1.0-cleared);
            float r=0.1+0.2*rainHash(c+4.4);
            float bead=smoothstep(r,r*0.55,length(at))*present;
            o.xy+=at*bead*0.03*0.7;
            o.z=max(o.z,bead);
            return o;
        }`;
    global.MusicStageDioramaWorld = Object.freeze({ create, poleSide, inSight, RAIN_GLASS });
})(window);
