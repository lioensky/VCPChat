(function (global) {
    'use strict';
    /*
     * The walled block at street level: the alleys and the street outside,
     * their wet floor and what it mirrors, the cables, pipes and laundry
     * strung over the alleys, the shutters, stalls and clutter along them,
     * the drip under every air conditioner, the rain, the haze, the sky, the
     * night's ambient light, and the camera paths that run inside the alleys.
     *
     * Nothing here adds a real three.js light. Every shader that shows lamp
     * or sign light reads the stage's shared light set (`uLightPos`, `uLightCol`):
     * the signs' lights handed in each frame plus the alley's own lamps
     * nearest the camera.
     */
    const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
    const mix = (a, b, p) => a + (b - a) * p;
    const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

    // Layers: the rain and the drips are for the viewer only; the floor never
    // sees itself. The mirror pass leaves both out.
    const LAYER_VIEW_ONLY = 3;
    const LAYER_FLOOR = 4;
    const MAX_LIGHTS = 32;
    // Covered stretches (built over the alley) the rain cannot reach, nearest first.
    const MAX_SHELTERS = 16;
    const SIGN_SLOTS = 24;
    const LIGHT_DECL = `uniform vec3 uLightPos[${MAX_LIGHTS}];uniform vec3 uLightCol[${MAX_LIGHTS}];uniform float uLightRad[${MAX_LIGHTS}];uniform int uLightCount;`;
    const RAIN_LEVELS = { off: 0, light: 0.45, heavy: 1 };
    const RAIN_COUNTS = { 'energy-saving': 3500, standard: 8000, ultimate: 16000 };
    const RAIN_BOX = 26, RAIN_HEIGHT = 22;
    // The ground map covers the block and the streets around it.
    const MAP = { x0: -140, z0: -110, size: 280 };

    const mulberry = seed => () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const hash = text => {
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    };
    const xyz = p => Array.isArray(p) ? (p.length === 2 ? [p[0], 0, p[1]] : [p[0], p[1], p[2]])
        : [p?.x ?? 0, p?.y ?? 0, p?.z ?? 0];

    // Alleys as straight runs: { a:[x,z], b:[x,z], width, alley, dir, normal, length }.
    const alleyRuns = layout => {
        const runs = [];
        const list = layout?.ALLEYS || layout?.alleys || [];
        list.forEach((alley, index) => {
            let points = (alley.points || alley.path || alley.line || []).map(xyz);
            // The layout's own form: an axis-aligned run { axis, c, w, from, to }.
            if (!points.length && Number.isFinite(alley.c)) {
                const ew = /^(x|ew|east|h)/i.test(String(alley.axis ?? 'x'));
                points = ew ? [[alley.from, 0, alley.c], [alley.to, 0, alley.c]] : [[alley.c, 0, alley.from], [alley.c, 0, alley.to]];
            }
            const width = alley.width ?? alley.w ?? 2;
            for (let i = 0; i + 1 < points.length; i++) {
                const a = points[i], b = points[i + 1];
                const dx = b[0] - a[0], dz = b[2] - a[2];
                const length = Math.hypot(dx, dz);
                if (length < 0.5) continue;
                const dir = [dx / length, dz / length];
                runs.push({ a: [a[0], a[2]], b: [b[0], b[2]], width, length, dir, normal: [-dir[1], dir[0]],
                    alley: alley.id ?? index, main: index === 0 || alley.main === true });
            }
        });
        return runs;
    };
    const facadeSlots = (layout, use) => {
        const slots = [];
        (layout?.facades || []).forEach(facade => (facade.slots || []).forEach(slot => {
            if (!use || slot.use === use) slots.push({ pos: xyz(slot.pos), normal: xyz(slot.normal || [0, 0, 1]), slot });
        }));
        return slots;
    };

    /* ---------------- shared shader pieces ---------------- */
    const NOISE = `
        float kHash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
        float kNoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);
            return mix(mix(kHash(i),kHash(i+vec2(1,0)),u.x),mix(kHash(i+vec2(0,1)),kHash(i+vec2(1,1)),u.x),u.y);}
        float kFbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*kNoise(p);p=p*2.03+vec2(17.1,9.2);a*=0.5;}return v;}`;
    // Diffuse and a glossy lobe from every pseudo light. `aniso` stretches the
    // lobe toward the viewer, the long streak a lamp leaves on a wet road.
    const LIGHTS = `
        uniform vec3 uLightPos[${MAX_LIGHTS}];uniform vec3 uLightCol[${MAX_LIGHTS}];uniform float uLightRad[${MAX_LIGHTS}];uniform int uLightCount;
        void kLights(vec3 P,vec3 N,vec3 V,float gloss,float aniso,inout vec3 diff,inout vec3 spec){
            vec2 c=normalize(V.xz+vec2(1e-4));vec3 tAlong=vec3(c.x,0.0,c.y),tAcross=vec3(-c.y,0.0,c.x);
            float ax=mix(0.35,0.02,gloss),ay=ax*(1.0+aniso*9.0);
            for(int i=0;i<${MAX_LIGHTS};i++){
                if(i>=uLightCount)break;
                vec3 L=uLightPos[i]-P;float d2=dot(L,L);float r=uLightRad[i];
                if(d2>r*r)continue;
                float fall=1.0-sqrt(d2)/r;float att=fall*fall;
                L*=inversesqrt(max(d2,1e-4));
                diff+=uLightCol[i]*att*max(dot(N,L),0.0);
                vec3 H=normalize(L+V);float hn=max(H.y*N.y+dot(H.xz,N.xz),0.05);
                float hx=dot(H,tAcross)/hn,hy=dot(H,tAlong)/hn;
                float lobe=exp(-(hx*hx/(ax*ax)+hy*hy/(ay*ay)))/(1.0+ax*ay*40.0);
                spec+=uLightCol[i]*att*lobe*max(dot(N,L),0.0)*mix(0.3,3.0,gloss);
            }
        }`;

    const create = (T, ctx = {}) => {
        const scene = ctx.scene;
        const layout = ctx.layout || {};
        let tierName = ctx.tier?.name || ctx.options?.quality || 'standard';
        let options = { rain: 'light', ...(ctx.options || {}) };
        let palette = ctx.palette || {};
        const seedText = `${layout.seed ?? 'kowloon'}:alley`;
        const rand = (() => {
            const own = typeof ctx.rand === 'function' ? ctx.rand(seedText) : null;
            return typeof own === 'function' ? own : mulberry(hash(seedText));
        })();
        const pick = list => list[Math.floor(rand() * list.length) % list.length];
        const range = (a, b) => a + (b - a) * rand();
        const root = new T.Group();
        root.name = 'kowloonAlley';
        scene.add(root);
        ctx.camera?.layers.enable(LAYER_VIEW_ONLY);
        ctx.camera?.layers.enable(LAYER_FLOOR);
        const disposables = [];
        const keep = thing => { disposables.push(thing); return thing; };
        const runs = alleyRuns(layout);
        const ST = layout.STREET || {};
        const streets = {
            south: ST.south ? [ST.south.z0, ST.south.z1] : [60, 72],
            east: ST.east ? [ST.east.x0, ST.east.x1] : [100, 110],
            west: ST.west ? [ST.west.x0, ST.west.x1] : [-110, -100],
            north: ST.north ? [ST.north.z0, ST.north.z1] : [-70, -60]
        };

        /* ------------- shared uniforms ------------- */
        const shared = {
            time: { value: 0 },
            rain: { value: 0 },
            wetness: { value: 0.6 },
            day: { value: 0 },
            hemiSky: { value: new T.Color('#1b2a3d') },
            hemiGround: { value: new T.Color('#2a1b26') },
            glowTint: { value: new T.Color('#000000') },
            flash: { value: 0 },
            // Where the nearby detail gathers: the camera, or in the sandbox view (camera far
            // off, parallel projection) a spot on the street by the focus. sb is 1 in that view.
            eye: { value: new T.Vector3(0, 1.7, 0) },
            sb: { value: 0 },
            sbBox: { value: new T.Vector4(-30, 38, 8, 72) },
            shelterBox: { value: Array.from({ length: MAX_SHELTERS }, () => new T.Vector4(0, 0, 0, 0)) },
            shelterY: { value: new Float32Array(MAX_SHELTERS) }
        };
        // The stage's shared light set (filled by the stage from every module's
        // lights()); on its own, a private set of the same shape.
        const lu = ctx.lightUniforms || null;
        const lightUniforms = lu || {
            uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new T.Vector3(0, -999, 0)) },
            uLightCol: { value: Array.from({ length: MAX_LIGHTS }, () => new T.Vector3()) },
            uLightRad: { value: new Float32Array(MAX_LIGHTS).fill(1) },
            uLightCount: { value: 0 },
            uLightHalo: { value: new Float32Array(MAX_LIGHTS).fill(1) }
        };
        const lightSet = { uLightPos: lightUniforms.uLightPos, uLightCol: lightUniforms.uLightCol,
            uLightRad: lightUniforms.uLightRad, uLightCount: lightUniforms.uLightCount,
            // 0 for a light that should not glow in the haze (a screen's fill light).
            uLightHalo: lightUniforms.uLightHalo || { value: new Float32Array(MAX_LIGHTS).fill(1) } };
        const SHELTER = `uniform vec4 shelterBox[${MAX_SHELTERS}];uniform float shelterY[${MAX_SHELTERS}];
            float kSheltered(vec3 p){float s=0.0;for(int i=0;i<${MAX_SHELTERS};i++){vec4 b=shelterBox[i];
                s=max(s,step(b.x,p.x)*step(p.x,b.z)*step(b.y,p.z)*step(p.z,b.w)*step(p.y,shelterY[i]));}return s;}`;
        const bridges = (layout.bridges || layout.BRIDGES || []).map(b => ({
            x0: Math.min(b.x0, b.x1), x1: Math.max(b.x0, b.x1), z0: Math.min(b.z0, b.z1), z1: Math.max(b.z0, b.z1),
            y0: b.y0 ?? 8.5, alley: b.alley }));

        /* ------------- sky, haze, ambient ------------- */
        const fog = new T.FogExp2('#141c26', 0.016);
        scene.fog = fog;
        // Layered haze in place of the flat exponential fog: a thick, dark-blue layer on
        // the ground, a thin one through the middle, and above the roofs a smog band the
        // city lights from below, so the far towers stand half in gold.
        // shape: x ground amount, y ground scale height, z mid amount, w high band amount.
        const haze = {
            kwHazeLow: { value: new T.Color('#10151f') },
            kwHazeMid: { value: new T.Color('#3a2716') },
            kwHazeHigh: { value: new T.Color('#a8682a') },
            kwHazeShape: { value: new T.Vector4(1.6, 8, 0.28, 0.45) },
            kwHazeSb: shared.sb,
            // Its own copy of the density, so a caller scaling scene.fog for one view does not reach it.
            kwHazeDensity: { value: 0.0105 }
        };
        const HAZE_VERTEX_PARS = `#include <fog_pars_vertex>
            #ifdef USE_FOG
            varying vec3 vKwHazeW;
            #endif`;
        const HAZE_VERTEX = `#include <fog_vertex>
            #ifdef USE_FOG
            vKwHazeW=cameraPosition+transpose(mat3(viewMatrix))*mvPosition.xyz;
            #endif`;
        const HAZE_FRAGMENT_PARS = `#include <fog_pars_fragment>
            #ifdef USE_FOG
            varying vec3 vKwHazeW;
            uniform vec3 kwHazeLow,kwHazeMid,kwHazeHigh;uniform vec4 kwHazeShape;uniform float kwHazeSb;
            uniform float kwHazeDensity;
            vec4 kwHaze(vec3 p){
                // Nothing within a few metres of the lens: the walls beside the camera keep their dark.
                vec3 ro=cameraPosition;vec3 d=p-ro;
                // The sandbox view looks at a cut block from far outside: only the air inside it
                // counts, the low layer and a little above, never the smog band the camera sits in.
                if(kwHazeSb>0.5){
                    float far=length(d);vec3 dir=d/max(far,1e-3);
                    float reach=min(far,45.0);
                    if(dir.y<-1e-3)reach=min(reach,max(0.0,(28.0-p.y)/-dir.y));
                    ro=p-dir*reach;d=p-ro;
                }
                float L=length(d),ds=L/6.0;
                float tau=0.0;vec3 acc=vec3(0.0);
                for(int i=0;i<6;i++){
                    float y=ro.y+d.y*((float(i)+0.5)/6.0);
                    float g=kwHazeShape.x*exp(-max(y,0.0)/kwHazeShape.y);
                    float hi=kwHazeShape.w*smoothstep(25.0,120.0,y)*(1.0-smoothstep(260.0,420.0,y))*(1.0-kwHazeSb);
                    float sg=(g+kwHazeShape.z*(1.0-0.6*kwHazeSb)+hi)*kwHazeDensity*ds*max(kwHazeSb,smoothstep(1.5,6.0,L*(float(i)+0.5)/6.0));
                    vec3 c=mix(kwHazeLow,kwHazeMid,smoothstep(4.0,32.0,y));
                    c=mix(c,kwHazeHigh,smoothstep(24.0,120.0,y));
                    acc+=c*exp(-tau)*(1.0-exp(-sg));
                    tau+=sg;
                }
                return vec4(acc,exp(-tau));
            }
            #endif`;
        const hazeFragment = additive => `#ifdef USE_FOG
            {vec4 kwH=kwHaze(vKwHazeW);
            ${additive ? 'gl_FragColor.rgb*=kwH.a;' : 'gl_FragColor.rgb=gl_FragColor.rgb*kwH.a+kwH.rgb;'}}
            #endif`;
        const hazeSource = (vertex, fragment, additive) => [
            vertex.replace('#include <fog_pars_vertex>', HAZE_VERTEX_PARS).replace('#include <fog_vertex>', HAZE_VERTEX),
            fragment.replace('#include <fog_pars_fragment>', HAZE_FRAGMENT_PARS).split('#include <fog_fragment>').join(hazeFragment(additive))
        ];
        const hazeable = src => typeof src === 'string' && src.includes('#include <fog_fragment>') && src.includes('#include <fog_pars_fragment>');
        // Every fogged material on the stage (the block's and the signs' too) takes the
        // layered haze; a material is patched once, and only while it sits in this scene.
        const hazed = new WeakSet();
        const hazeMaterial = m => {
            if (!m || hazed.has(m) || m.fog === false) return;
            hazed.add(m);
            const additive = m.blending === T.AdditiveBlending;
            if (m.isShaderMaterial) {
                if (!hazeable(m.fragmentShader) || !m.vertexShader.includes('#include <fog_vertex>')) return;
                [m.vertexShader, m.fragmentShader] = hazeSource(m.vertexShader, m.fragmentShader, additive);
                Object.assign(m.uniforms, haze);
                m.needsUpdate = true;
                return;
            }
            const before = m.onBeforeCompile;
            const key = m.customProgramCacheKey();
            m.onBeforeCompile = (shader, renderer) => {
                if (before) before.call(m, shader, renderer);
                if (!hazeable(shader.fragmentShader)) return;
                [shader.vertexShader, shader.fragmentShader] = hazeSource(shader.vertexShader, shader.fragmentShader, additive);
                Object.assign(shader.uniforms, haze);
            };
            m.customProgramCacheKey = () => `${key}|kwHaze${additive ? 'A' : ''}`;
            m.needsUpdate = true;
        };
        let hazeScanAt = -1;
        const hazeScan = force => {
            if (options.heightFog === false) return;
            const now = global.performance?.now?.() ?? Date.now();
            if (!force && now - hazeScanAt < 1000) return;
            hazeScanAt = now;
            scene.traverse(o => {
                if (!o.material || o.isPoints || o.isLine) return;
                (Array.isArray(o.material) ? o.material : [o.material]).forEach(hazeMaterial);
            });
        };
        // The block's own ambient terms live in the shared uniforms; these are their night/day values.
        const hemi = { color: new T.Color(), groundColor: new T.Color(), intensity: 1 };
        // A low, heavy cloud deck lit from below by the city.
        const skyMat = keep(new T.ShaderMaterial({
            side: T.BackSide, depthWrite: false, fog: false,
            uniforms: { time: shared.time, rain: shared.rain, day: shared.day, flash: shared.flash, flashAt: { value: new T.Vector2(0.4, -0.6) },
                zenith: { value: new T.Color('#05070c') }, glowA: { value: new T.Color('#2a1630') },
                glowB: { value: new T.Color('#4a2a26') }, haze: { value: new T.Color('#1c2a38') } },
            vertexShader: `varying vec3 vDir;void main(){vDir=normalize(position);
                vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_Position=p.xyww;}`,
            fragmentShader: `uniform float time,rain,day,flash;uniform vec2 flashAt;uniform vec3 zenith,glowA,glowB,haze;varying vec3 vDir;${NOISE}
                void main(){
                    vec3 d=normalize(vDir);float h=max(d.y,0.0);
                    vec2 at=d.xz/(d.y+0.35)*1.2+vec2(time*0.012,time*0.004);
                    float fine=smoothstep(0.02,0.3,h);
                    float deck=kFbm(at)*0.7+mix(0.15,kFbm(at*2.7+7.0),fine)*0.3;
                    // The cloud's underside takes the city's colour; the thin gaps stay black.
                    float lit=smoothstep(0.32,0.78,deck);
                    float under=exp(-h*3.4);
                    vec3 glow=mix(glowB,glowA,smoothstep(0.0,0.5,h))*(0.35+0.65*under)*(0.45+0.85*lit);
                    vec3 col=zenith*(0.6+0.4*lit)+glow*(1.0+rain*0.4);
                    // Lightning inside the cloud: a patch of the deck lights up, then the whole sky.
                    vec2 bolt=d.xz/(d.y+0.35)-flashAt;
                    float spot=exp(-dot(bolt,bolt)*0.8)*(0.6+0.8*smoothstep(0.3,0.7,deck));
                    col+=vec3(0.62,0.66,0.85)*flash*(spot*2.4+0.35*(0.4+lit));
                    col=mix(col,haze*(1.0+under),smoothstep(0.25,0.0,h)*(0.6+0.3*rain));
                    col=mix(col,vec3(0.56,0.6,0.64)*(0.75+0.25*lit),day);
                    gl_FragColor=vec4(col,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const sky = new T.Mesh(keep(new T.SphereGeometry(900, 32, 16)), skyMat);
        sky.name = 'kowloonSky'; sky.frustumCulled = false; sky.renderOrder = -10;
        root.add(sky);

        /* ------------- ground map: road, pavement, low spots ------------- */
        const MAP_PX = 1024;
        const canvas = global.document?.createElement('canvas');
        let groundMap;
        if (canvas) {
            canvas.width = canvas.height = MAP_PX;
            const g = canvas.getContext('2d');
            const px = v => (v - MAP.x0) / MAP.size * MAP_PX;
            const pz = v => (v - MAP.z0) / MAP.size * MAP_PX;
            const len = v => v / MAP.size * MAP_PX;
            g.fillStyle = '#000'; g.fillRect(0, 0, MAP_PX, MAP_PX);
            g.globalCompositeOperation = 'lighter';
            const rect = (style, x0, z0, x1, z1) => { g.fillStyle = style; g.fillRect(px(x0), pz(z0), len(x1 - x0), len(z1 - z0)); };
            // Streets outside the block: south (z 60..72) and east (x 60..70); pavement either side.
            const { south, east, west, north } = streets;
            rect('rgb(255,0,0)', west[0], MAP.z0, west[1] - 2.5, south[0] + 2.5);
            rect('rgb(0,255,0)', west[1] - 2.5, MAP.z0, west[1], south[0]);
            rect('rgb(255,0,0)', MAP.x0, north[0], MAP.x0 + MAP.size, north[1] - 2.5);
            rect('rgb(0,255,0)', west[1], north[1] - 2.5, east[0], north[1]);
            rect('rgb(255,0,0)', MAP.x0, south[0] + 2.5, MAP.x0 + MAP.size, south[1]);
            rect('rgb(255,0,0)', east[0] + 2.5, MAP.z0, east[1], south[0] + 2.5);
            rect('rgb(0,255,0)', MAP.x0, south[0], MAP.x0 + MAP.size, south[0] + 2.5);
            rect('rgb(0,255,0)', MAP.x0, south[1], MAP.x0 + MAP.size, south[1] + 2.5);
            rect('rgb(0,255,0)', east[0], MAP.z0, east[0] + 2.5, south[0]);
            rect('rgb(0,255,0)', east[1], MAP.z0, east[1] + 2.5, south[0]);
            // Low ground, where water gathers: the alley's middle and the kerb's gutter.
            g.filter = 'blur(3px)';
            g.strokeStyle = 'rgb(0,0,200)'; g.lineCap = 'round';
            runs.forEach(run => {
                g.lineWidth = len(run.width * 0.55);
                g.beginPath(); g.moveTo(px(run.a[0]), pz(run.a[1])); g.lineTo(px(run.b[0]), pz(run.b[1])); g.stroke();
            });
            g.lineWidth = len(1.2);
            g.beginPath(); g.moveTo(px(MAP.x0), pz(south[0] + 3)); g.lineTo(px(east[0] + 3), pz(south[0] + 3));
            g.lineTo(px(east[0] + 3), pz(MAP.z0)); g.stroke();
            g.beginPath(); g.moveTo(px(MAP.x0), pz(south[1] - 0.6)); g.lineTo(px(MAP.x0 + MAP.size), pz(south[1] - 0.6)); g.stroke();
            g.filter = 'none';
            groundMap = keep(new T.CanvasTexture(canvas));
            groundMap.colorSpace = T.NoColorSpace;
            groundMap.flipY = false;
            groundMap.anisotropy = 4;
        } else {
            groundMap = keep(new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1));
            groundMap.needsUpdate = true;
        }

        /* ------------- the mirror for the puddles ------------- */
        const mirror = new T.PerspectiveCamera();
        mirror.layers.disableAll();
        mirror.layers.enable(0);
        const target = keep(new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, depthBuffer: true }));
        target.texture.colorSpace = T.NoColorSpace;
        const textureMatrix = new T.Matrix4();
        let reflectionOn = tierName !== 'energy-saving';

        /* ------------- the floor ------------- */
        const floorMat = keep(new T.ShaderMaterial({
            fog: true,
            uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, {}]),
            vertexShader: `uniform mat4 textureMatrix;varying vec3 vWorld;varying vec4 vMirror;
                #include <fog_pars_vertex>
                void main(){vec4 w=modelMatrix*vec4(position,1.0);vWorld=w.xyz;vMirror=textureMatrix*w;
                    vec4 mvPosition=viewMatrix*w;gl_Position=projectionMatrix*mvPosition;
                    #include <fog_vertex>
                }`,
            fragmentShader: `uniform sampler2D groundMap,reflection;uniform vec4 mapRect;uniform float time,rain,wetness,day,reflectOn;
                uniform vec3 hemiSky,hemiGround,glowTint;varying vec3 vWorld;varying vec4 vMirror;
                #include <fog_pars_fragment>
                ${SHELTER}
                ${NOISE}${LIGHTS}
                // Rings spreading from raindrops: two offset grids, one ring per cell at a time.
                vec2 kRipples(vec2 p,float t){
                    vec2 n=vec2(0.0);
                    for(int layer=0;layer<2;layer++){
                        vec2 q=p*(layer==0?3.2:4.7)+float(layer)*13.7;vec2 cell=floor(q);vec2 f=fract(q)-0.5;
                        float seed=kHash(cell+float(layer)*3.1);
                        vec2 c=vec2(kHash(cell+7.3),kHash(cell+1.9))*0.4-0.2;
                        float life=fract(t*(0.9+seed*0.8)+seed*7.0);
                        vec2 d=f-c;float r=length(d)+1e-4;float ring=life*0.42;
                        float w=sin(clamp((r-ring)*42.0,-3.1416,3.1416))*(1.0-life)*(1.0-life)*smoothstep(0.08,0.0,abs(r-ring));
                        n+=d/r*w*step(seed,0.25+rain*0.75);
                    }
                    return n;
                }
                void main(){
                    vec2 p=vWorld.xz;
                    vec3 g=texture2D(groundMap,(p-mapRect.xy)*mapRect.zw).rgb;
                    float road=g.r,tile=g.g,low=g.b;
                    float n1=kFbm(p*0.31),n2=kNoise(p*2.7),n3=kNoise(p*13.0);
                    // Alley concrete: cast in bays, cracked, patched.
                    vec2 bay=abs(fract(p/vec2(1.6,2.4))-0.5);
                    float joint=smoothstep(0.46,0.5,max(bay.x,bay.y));
                    float crack=1.0-smoothstep(0.0,0.025,abs(kFbm(p*0.8+3.0)-0.5));
                    float patchy=smoothstep(0.55,0.6,kNoise(p*0.45+9.0));
                    vec3 concrete=vec3(0.15,0.145,0.138)*(0.7+0.55*n1)*(0.85+0.3*n2)*(1.0-joint*0.45-crack*0.5);
                    concrete=mix(concrete,vec3(0.09,0.09,0.092)*(0.8+0.4*n3),patchy*0.8);
                    // Road asphalt with worn paint: a broken centre line, a stop line by the alley mouths.
                    vec3 asphalt=vec3(0.055,0.058,0.064)*(0.75+0.5*n2)*(0.9+0.2*n3);
                    float lineZ=abs(p.y-66.0),lineX=abs(p.x-65.0);
                    float dash=step(0.5,fract(p.x/6.0))*(1.0-smoothstep(0.06,0.09,lineZ))*step(p.x,61.0)
                        +step(0.5,fract(p.y/6.0))*(1.0-smoothstep(0.06,0.09,lineX))*step(p.y,59.0);
                    float paint=clamp(dash,0.0,1.0)*smoothstep(0.25,0.6,kNoise(p*1.7));
                    asphalt=mix(asphalt,vec3(0.42,0.38,0.22),paint*0.55);
                    // Pavement: small square tiles, some missing, some stained.
                    vec2 tq=fract(p/0.3);float grout=smoothstep(0.44,0.5,max(abs(tq.x-0.5),abs(tq.y-0.5)));
                    float tone=kHash(floor(p/0.3));
                    vec3 tiles=vec3(0.2,0.19,0.18)*(0.75+0.35*tone)*(1.0-grout*0.6)*(0.8+0.3*n1);
                    vec3 albedo=mix(mix(concrete,asphalt,road),tiles,tile);
                    // Grime gathers at the low spots and in streaks.
                    albedo*=1.0-0.35*low*n1-0.2*smoothstep(0.6,0.8,kNoise(p*vec2(0.2,1.1)));
                    // Gratings in the gutter, every few metres.
                    vec2 gr=vec2(fract(p.x/9.0)*9.0,p.y-63.0);
                    float grate=step(abs(gr.x-4.5),0.45)*step(abs(gr.y),0.22)*road;
                    albedo=mix(albedo,vec3(0.03)*(0.6+0.8*step(0.5,fract(gr.x*12.0))),grate);
                    // Water: in the low spots first, everywhere once it pours.
                    float height=n1*0.65+n2*0.12+low*0.55-crack*0.1;
                    float flood=0.78-wetness*0.32-rain*0.12;
                    float puddle=smoothstep(flood,flood+0.05,height)*smoothstep(0.05,0.3,wetness);
                    vec2 bump=vec2(kNoise(p*9.0+1.0)-0.5,kNoise(p*9.0+4.0)-0.5)*(0.25+0.4*n3);
                    vec2 rip=rain>0.0?kRipples(p,time)*rain*(1.0-0.85*kSheltered(vec3(vWorld.x,0.0,vWorld.z))):vec2(0.0);
                    vec2 tilt=mix(bump*(1.0-wetness*0.5),rip*0.9,puddle)+rip*0.25*(1.0-puddle);
                    vec3 N=normalize(vec3(tilt.x,1.0,tilt.y));
                    vec3 V=normalize(cameraPosition-vWorld);
                    float gloss=mix(mix(0.15,0.62,wetness),0.97,puddle)*(1.0-grate*0.5);
                    albedo*=1.0-0.45*wetness*(1.0-puddle)-0.6*puddle;
                    vec3 diff=vec3(0.0),spec=vec3(0.0);
                    kLights(vWorld,N,V,gloss,mix(0.7,1.0,puddle),diff,spec);
                    vec3 ambient=mix(hemiGround,hemiSky,0.5+0.5*N.y)*0.55+glowTint*0.5;
                    vec3 col=albedo*(ambient+diff)+spec*(0.35+0.65*wetness);
                    // What stands over the water, upside down in it.
                    float fres=0.03+0.97*pow(1.0-max(dot(N,V),0.0),5.0);
                    float mirrorAmount=puddle*mix(0.35,1.0,fres)+(1.0-puddle)*wetness*fres*0.45;
                    vec3 mirrored=hemiSky*0.6;
                    if(reflectOn>0.5){
                        vec2 uv=vMirror.xy/vMirror.w+tilt*mix(0.03,0.008,puddle);
                        mirrored=texture2D(reflection,uv).rgb;
                    }
                    col=mix(col,mirrored,clamp(mirrorAmount,0.0,1.0)*(1.0-0.4*day));
                    gl_FragColor=vec4(col,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    #include <fog_fragment>
                }`
        }));
        Object.assign(floorMat.uniforms, {
            groundMap: { value: groundMap }, reflection: { value: target.texture },
            mapRect: { value: new T.Vector4(MAP.x0, MAP.z0, 1 / MAP.size, 1 / MAP.size) },
            textureMatrix: { value: textureMatrix }, reflectOn: { value: reflectionOn ? 1 : 0 },
            time: shared.time, rain: shared.rain, wetness: shared.wetness, day: shared.day,
            ...lightSet,
            hemiSky: shared.hemiSky, hemiGround: shared.hemiGround, glowTint: shared.glowTint,
            shelterBox: shared.shelterBox, shelterY: shared.shelterY
        });
        const floorGeometry = keep(new T.PlaneGeometry(MAP.size, MAP.size, 1, 1));
        floorGeometry.rotateX(-Math.PI / 2);
        floorGeometry.translate(MAP.x0 + MAP.size / 2, 0, MAP.z0 + MAP.size / 2);
        const floor = new T.Mesh(floorGeometry, floorMat);
        floor.name = 'kowloonFloor';
        floor.layers.set(LAYER_FLOOR);
        root.add(floor);

        /* ------------- lit props: one material, patterns by kind ------------- */
        // kind: 0 painted metal, 1 rolling shutter, 2 grille, 3 tarp, 4 crate/cardboard,
        // 5 lamp (emissive), 6 concrete, 7 pipe metal, 8 plastic, 9 bin bag
        const propMaterial = name => {
            const m = keep(new T.MeshStandardMaterial({ color: '#ffffff', roughness: 0.75, metalness: 0.1 }));
            m.onBeforeCompile = shader => {
                Object.assign(shader.uniforms, { ...lightSet, wetness: shared.wetness, time: shared.time,
                    hemiSky: shared.hemiSky, hemiGround: shared.hemiGround, glowTint: shared.glowTint });
                shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
                    attribute float kind;varying float vKind;varying vec3 vLocal,vSize,vFace,vKWorld;varying float vSeed;`)
                    .replace('#include <begin_vertex>', `#include <begin_vertex>
                    vKind=kind;vFace=normal;
                    #ifdef USE_INSTANCING
                    vSize=vec3(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz),length(instanceMatrix[2].xyz));
                    vSeed=fract(sin(float(gl_InstanceID)*12.9898)*43758.5453);
                    vec4 kw=modelMatrix*instanceMatrix*vec4(position,1.0);
                    #else
                    vSize=vec3(1.0);vSeed=0.0;vec4 kw=modelMatrix*vec4(position,1.0);
                    #endif
                    vLocal=position*vSize;vKWorld=kw.xyz;`);
                shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
                    uniform float wetness,time;uniform vec3 hemiSky,hemiGround,glowTint;varying float vKind;varying vec3 vLocal,vSize,vFace,vKWorld;varying float vSeed;
                    float kRelief=0.0,kDepth=0.0,kGlow=0.0;
                    ${NOISE}${LIGHTS}`)
                    .replace('#include <color_fragment>', `#include <color_fragment>
                    {
                        vec3 af=abs(vFace);
                        vec2 at=af.x>af.y&&af.x>af.z?vLocal.zy:af.y>af.z?vLocal.xz:vLocal.xy;
                        vec2 w=vKWorld.xz+vKWorld.y;
                        float grime=kFbm(at*1.3+vSeed*20.0);
                        float streak=kNoise(vec2(at.x*7.0,at.y*0.6)+vSeed*9.0);
                        int k=int(vKind+0.5);
                        if(k==1){
                            // Corrugated slats, paint chipped at the bottom, rust running down.
                            float slat=fract(vLocal.y/0.075);
                            // Slats finer than a couple of pixels fade to their average, no moire.
                            float resolve=1.0-smoothstep(0.2,0.55,fwidth(vLocal.y/0.075));
                            kRelief=smoothstep(0.0,0.5,abs(slat-0.5))*resolve;kDepth=0.006*resolve;
                            diffuseColor.rgb*=0.94+0.12*(kRelief-0.5*resolve);
                            diffuseColor.rgb*=0.85+0.25*kNoise(at*vec2(0.6,2.0));
                            float rust=smoothstep(0.55,0.8,grime+0.35*(1.0-smoothstep(0.0,0.9,vLocal.y+vSize.y*0.5)));
                            diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.22,0.11,0.06)*(0.6+0.6*streak),rust*0.8);
                            // Scrawl and stuck-on bills, a few per shutter.
                            float bill=step(0.82,kHash(floor(at*vec2(1.5,2.2))+vSeed*5.0))*step(abs(vLocal.y),0.5);
                            diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.55,0.52,0.45)*(0.7+0.3*kNoise(at*3.0)),bill*0.7);
                        } else if(k==2){
                            vec2 bars=abs(fract(at/vec2(0.12,0.12))-0.5);
                            if(min(bars.x,bars.y)>0.11&&af.y<0.5)discard;
                        } else if(k==3){
                            kRelief=kNoise(at*vec2(2.0,0.7))*0.6+kNoise(at*9.0)*0.15;kDepth=0.04;
                            diffuseColor.rgb*=0.7+0.4*grime;
                            diffuseColor.rgb*=1.0-0.4*smoothstep(0.6,0.9,streak);
                        } else if(k==4){
                            float board=fract(at.y/0.12);kRelief=smoothstep(0.0,0.08,board)*smoothstep(1.0,0.92,board);kDepth=0.01;
                            diffuseColor.rgb*=0.75+0.35*kNoise(at*vec2(0.5,10.0));
                        } else if(k==5){
                            kGlow=1.0;
                        } else if(k==6){
                            diffuseColor.rgb*=0.7+0.45*grime;kRelief=kNoise(at*6.0);kDepth=0.01;
                            diffuseColor.rgb*=1.0-0.35*smoothstep(0.5,0.9,streak);
                        } else if(k==7){
                            float rust=smoothstep(0.5,0.85,grime+0.25*streak);
                            diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.2,0.1,0.05)*(0.7+0.5*streak),rust);
                            kRelief=rust*kNoise(at*20.0);kDepth=0.004;
                        } else if(k==9){
                            kRelief=kNoise(at*5.0)+0.3*kNoise(at*17.0);kDepth=0.05;
                        } else {
                            diffuseColor.rgb*=0.75+0.4*grime;
                            diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*0.45,smoothstep(0.55,0.85,streak)*0.6);
                        }
                        diffuseColor.rgb*=1.0-0.35*wetness*(1.0-kGlow);
                    }`)
                    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
                    {int k=int(vKind+0.5);
                     roughnessFactor=k==8||k==9?0.35:k==3?0.6:k==6?0.9:k==1||k==7?0.55:0.7;
                     roughnessFactor=mix(roughnessFactor,0.18,wetness*(k==6?0.4:k==1?0.35:0.8));}`)
                    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
                    {int k=int(vKind+0.5);metalnessFactor=k==1||k==2||k==7||k==0?0.45:0.0;}`)
                    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                    if(kDepth>0.0){vec3 r1=cross(dFdy(-vViewPosition),normal),r2=cross(normal,dFdx(-vViewPosition));
                        float det=dot(dFdx(-vViewPosition),r1);
                        normal=normalize(abs(det)*normal-sign(det)*kDepth*12.0*(dFdx(kRelief)*r1+dFdy(kRelief)*r2));}`)
                    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
                    {
                        vec3 wn=normalize(inverseTransformDirection(normal,viewMatrix));
                        vec3 wv=normalize(cameraPosition-vKWorld);
                        vec3 d=vec3(0.0),s=vec3(0.0);
                        kLights(vKWorld,wn,wv,1.0-roughnessFactor,0.2,d,s);
                        reflectedLight.directDiffuse+=diffuseColor.rgb*(d*0.55+mix(hemiGround,hemiSky,wn.y*0.5+0.5)*0.5
                            +glowTint*exp(-max(vKWorld.y,0.0)/14.0)*0.4);
                        reflectedLight.directSpecular+=s*mix(0.12,0.6,1.0-roughnessFactor);
                    }`)
                    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
                    if(kGlow>0.5){totalEmissiveRadiance=diffuseColor.rgb*(1.6+0.6*kNoise(vec2(time*7.0,vSeed*40.0))*step(0.93,vSeed));}`);
            };
            m.customProgramCacheKey = () => `kowloon-prop-${name}`;
            return m;
        };
        const props = [];
        // An instanced pool: add() records a placement; build() writes them out.
        const pool = (name, geometry, capacity) => {
            const mat = propMaterial(name);
            const kinds = new Float32Array(capacity);
            geometry.setAttribute('kind', new T.InstancedBufferAttribute(kinds, 1));
            const mesh = new T.InstancedMesh(keep(geometry), mat, capacity);
            mesh.name = `kowloonAlley-${name}`;
            mesh.count = 0;
            mesh.instanceMatrix.setUsage(T.StaticDrawUsage);
            mesh.frustumCulled = false;
            root.add(mesh);
            const dummy = new T.Object3D(), colour = new T.Color();
            const record = { mesh, count: 0, capacity,
                add(position, scale, yaw, kind, tint, pitch = 0, roll = 0) {
                    if (this.count >= capacity) return;
                    dummy.position.set(position[0], position[1], position[2]);
                    dummy.rotation.set(pitch, yaw, roll, 'YXZ');
                    dummy.scale.set(scale[0], scale[1], scale[2]);
                    dummy.updateMatrix();
                    mesh.setMatrixAt(this.count, dummy.matrix);
                    mesh.setColorAt(this.count, colour.set(tint));
                    kinds[this.count] = kind;
                    this.count++;
                },
                // A placement from an explicit matrix (pipes between two points).
                addMatrix(matrix, kind, tint) {
                    if (this.count >= capacity) return;
                    mesh.setMatrixAt(this.count, matrix);
                    mesh.setColorAt(this.count, colour.set(tint));
                    kinds[this.count] = kind;
                    this.count++;
                },
                build() {
                    mesh.count = this.count;
                    mesh.instanceMatrix.needsUpdate = true;
                    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
                    geometry.attributes.kind.needsUpdate = true;
                }
            };
            props.push(record);
            return record;
        };
        const boxes = pool('box', new T.BoxGeometry(1, 1, 1), 7800);
        const cylinders = pool('cylinder', new T.CylinderGeometry(1, 1, 1, 7, 1, true), 3000);
        const lumps = pool('lump', new T.IcosahedronGeometry(1, 0), 1200);
        // Pipe from a to b with radius r.
        const up = new T.Vector3(0, 1, 0), va = new T.Vector3(), vb = new T.Vector3(), q = new T.Quaternion();
        const pm = new T.Matrix4(), ps = new T.Vector3();
        const pipe = (a, b, r, kind, tint) => {
            va.set(a[0], a[1], a[2]); vb.set(b[0], b[1], b[2]);
            const length = va.distanceTo(vb);
            if (length < 0.02) return;
            q.setFromUnitVectors(up, vb.clone().sub(va).normalize());
            ps.set(r, length, r);
            pm.compose(va.add(vb).multiplyScalar(0.5), q, ps);
            cylinders.addMatrix(pm, kind, tint);
        };

        /* ------------- lamps the alley owns ------------- */
        const lamps = [];
        const lamp = (position, color, intensity, radius, flicker = 0) =>
            lamps.push({ position, color, intensity, radius, flicker, seed: rand(), cone: position[1] > 1.5 });
        // Where steam rises: food stalls, gratings in the gutter.
        const steamSources = [];

        /* ------------- cables, laundry lines: one ribbon mesh ------------- */
        const wirePositions = [], wireColors = [], wireIndex = [];
        const cA = new T.Vector3(), cB = new T.Vector3(), cT = new T.Vector3(), cU = new T.Vector3(), cV = new T.Vector3();
        const ribbon = (points, width, colour) => {
            // An X-shaped section, so the cable has a body from any side.
            const base = wirePositions.length / 3;
            const tint = new T.Color(colour);
            for (let i = 0; i < points.length; i++) {
                const p = points[i], next = points[Math.min(points.length - 1, i + 1)], prev = points[Math.max(0, i - 1)];
                cT.set(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]).normalize();
                cU.crossVectors(cT, up);
                if (cU.lengthSq() < 1e-6) cU.set(1, 0, 0);
                cU.normalize();
                cV.crossVectors(cT, cU).normalize();
                for (const [dir, s] of [[cU, 1], [cU, -1], [cV, 1], [cV, -1]]) {
                    wirePositions.push(p[0] + dir.x * width * s, p[1] + dir.y * width * s, p[2] + dir.z * width * s);
                    wireColors.push(tint.r, tint.g, tint.b);
                }
                if (i > 0) {
                    const a = base + (i - 1) * 4, b = base + i * 4;
                    wireIndex.push(a, a + 1, b, a + 1, b + 1, b, a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
                }
            }
        };
        const sagLine = (a, b, sag, segments) => {
            const out = [];
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                out.push([mix(a[0], b[0], t), mix(a[1], b[1], t) - sag * 4 * t * (1 - t), mix(a[2], b[2], t)]);
            }
            return out;
        };
        // Garments as hanging quads under a line: shirts, towels, trousers.
        const garmentPositions = [], garmentColors = [], garmentIndex = [];
        const CLOTH = ['#6d7f8c', '#8c5a5a', '#c9c1b0', '#4f6b5a', '#9a8a5a', '#5a5f7a', '#b0b8bf', '#7a4a3a', '#2e3338'];
        const garment = (top, along, width, drop, colour) => {
            const base = garmentPositions.length / 3;
            const tint = new T.Color(colour);
            const sway = range(-0.08, 0.08);
            const rows = [0, 0.5, 1];
            rows.forEach(r => {
                const y = top[1] - drop * r;
                const out = sway * r;
                const narrow = r > 0.4 ? 1 - range(0, 0.25) : 1;
                for (const s of [-0.5, 0.5]) {
                    garmentPositions.push(top[0] + along[0] * width * s * narrow + along[1] * out,
                        y, top[2] + along[1] * width * s * narrow - along[0] * out);
                    const shade = 1 - r * 0.25;
                    garmentColors.push(tint.r * shade, tint.g * shade, tint.b * shade);
                }
            });
            for (let r = 0; r < 2; r++) {
                const a = base + r * 2;
                garmentIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            }
        };

        /* ------------- set dressing along every alley run ------------- */
        const SHUTTER_PAINT = ['#4f5a52', '#5a6168', '#6b6a5e', '#3f4f5f', '#5d4e43', '#7a7f80', '#3e5248'];
        const TARP = ['#7a2a2a', '#2a4a7a', '#2f5f45', '#8a6a2a', '#4a4a52', '#6a2f55'];
        const CRATE = ['#5a4a35', '#7a6648', '#3a4a5a', '#6a3030', '#2f5a4a', '#8a8070'];
        // Warm sodium and bare bulbs for most, a cold cyan tube here and there against them.
        const LAMP_TONES = [[1.0, 0.7, 0.4], [1.0, 0.6, 0.28], [0.3, 0.9, 1.0], [1.0, 0.84, 0.62]];
        const wallAt = (run, t, side, off = 0) => {
            const x = mix(run.a[0], run.b[0], t), z = mix(run.a[1], run.b[1], t);
            const d = run.width / 2 - off;
            return [x + run.normal[0] * d * side, z + run.normal[1] * d * side];
        };
        let laundryCount = 0, cableCount = 0;
        runs.forEach(run => {
            const yaw = Math.atan2(run.dir[0], run.dir[1]);
            const steps = Math.floor(run.length);
            // Clutter on the floor, against the walls.
            for (let i = 0; i < steps * 0.35; i++) {
                const side = rand() < 0.5 ? -1 : 1;
                const t = rand();
                const [x, z] = wallAt(run, t, side, range(0.2, 0.45));
                const r = rand();
                if (r < 0.3) lumps.add([x, 0.22, z], [range(0.25, 0.4), range(0.2, 0.3), range(0.25, 0.35)], rand() * 6, 9, pick(['#151618', '#1d2a3a', '#2a2a22']));
                else if (r < 0.55) boxes.add([x, 0.2, z], [range(0.35, 0.6), range(0.3, 0.45), range(0.3, 0.5)], yaw + range(-0.3, 0.3), 4, pick(CRATE));
                else if (r < 0.7) cylinders.add([x, 0.3, z], [0.12, 0.6, 0.12], 0, 8, pick(['#a03028', '#2a5a8a', '#c0a040']));
                else if (r < 0.85) cylinders.add([x, 0.18, z], [0.18, 0.36, 0.18], 0, 8, pick(['#3a6a8a', '#8a3a3a', '#d0d0c8']));
                else boxes.add([x, 0.45, z], [0.4, 0.9, 0.06], yaw + range(-0.5, 0.5), 0, pick(['#2a3a5a', '#5a2a2a']));
            }
            // Pipes along both walls: two or three runs high up, downpipes now and then.
            for (const side of [-1, 1]) {
                const n = 1 + Math.floor(rand() * 3);
                for (let i = 0; i < n; i++) {
                    const h = range(2.9, 6.5);
                    const r = range(0.04, 0.12);
                    const off = 0.08 + r + i * 0.04;
                    const [x0, z0] = wallAt({ ...run }, 0, side, off), [x1, z1] = wallAt(run, 1, side, off);
                    pipe([x0, h, z0], [x1, h, z1], r, 7, pick(['#5a5a55', '#6a5a4a', '#4a5a5a', '#7a7a70']));
                    for (let b = range(0.5, 2); b < run.length; b += range(1.6, 2.6)) {
                        const [bx, bz] = wallAt(run, b / run.length, side, off * 0.5);
                        boxes.add([bx, h, bz], [0.04, 0.05, off + r], yaw + Math.PI / 2, 0, '#2a2a2a');
                    }
                }
            }
            // Strip lights under the eaves, in cages; most alleys have a few.
            for (let d = range(2, 6); d < run.length; d += range(7, 12)) {
                const side = rand() < 0.5 ? -1 : 1;
                const [x, z] = wallAt(run, d / run.length, side, 0.2);
                const tone = pick([LAMP_TONES[0], LAMP_TONES[0], LAMP_TONES[2], LAMP_TONES[3]]);
                const h = range(3, 3.8);
                boxes.add([x, h, z], [1.2, 0.05, 0.06], yaw, 5, new T.Color(tone[0], tone[1], tone[2]));
                boxes.add([x, h + 0.05, z], [1.26, 0.03, 0.12], yaw, 0, '#2a2c2e');
                lamp([x, h - 0.1, z], tone, tone === LAMP_TONES[2] ? 1.15 : 1.0, 5, rand() < 0.12 ? 1 : 0);
            }
            // Cables over the alley: bundles crossing, a few running along it.
            for (let d = range(0.5, 2); d < run.length; d += range(1.2, 3.2)) {
                const t = d / run.length;
                const bundle = 1 + Math.floor(rand() * 5);
                const h = range(3.2, 22) * (rand() < 0.6 ? 0.5 : 1) + 2.5;
                const skew = range(-1.5, 1.5);
                for (let k = 0; k < bundle; k++) {
                    const [ax, az] = wallAt(run, t, -1, 0);
                    const [bx, bz] = wallAt(run, clamp(t + skew / run.length), 1, 0);
                    const dh = range(-0.6, 0.6);
                    ribbon(sagLine([ax, h + k * 0.07, az], [bx, h + dh + k * 0.07, bz], range(0.15, 0.6), 6),
                        range(0.008, 0.02), pick(['#0b0b0c', '#111214', '#1a1a1a', '#202326']));
                    cableCount++;
                }
            }
            for (const side of [-1, 1]) {
                if (rand() < 0.4) continue;
                const h = range(3, 5.5), off = range(0.25, 0.5);
                const [ax, az] = wallAt(run, 0, side, off), [bx, bz] = wallAt(run, 1, side, off);
                const pieces = Math.max(1, Math.round(run.length / 5));
                for (let p = 0; p < pieces; p++) {
                    const t0 = p / pieces, t1 = (p + 1) / pieces;
                    for (let k = 0; k < 3; k++) {
                        ribbon(sagLine([mix(ax, bx, t0), h + k * 0.05, mix(az, bz, t0)], [mix(ax, bx, t1), h + k * 0.05, mix(az, bz, t1)],
                            range(0.08, 0.3), 6), 0.012, '#0d0e10');
                    }
                }
            }
            // Laundry lines between windows across the narrow alleys.
            if (run.width < 3) {
                for (let d = range(3, 8); d < run.length; d += range(6, 14)) {
                    const t = d / run.length;
                    const h = 2.85 * Math.floor(range(2, 7)) + 1.9;
                    const [ax, az] = wallAt(run, t, -1, 0), [bx, bz] = wallAt(run, t, 1, 0);
                    const sag = range(0.1, 0.25);
                    ribbon(sagLine([ax, h, az], [bx, h, bz], sag, 6), 0.006, '#2a2a2a');
                    const across = [bx - ax, bz - az];
                    const span = Math.hypot(across[0], across[1]);
                    const dir = [across[0] / span, across[1] / span];
                    for (let c = 0.2; c < span - 0.25; c += range(0.35, 0.6)) {
                        const u = c / span;
                        const y = h - sag * 4 * u * (1 - u);
                        const w = range(0.3, 0.55);
                        garment([ax + dir[0] * (c + w / 2), y, az + dir[1] * (c + w / 2)], dir, w,
                            range(0.4, 0.85), pick(CLOTH));
                        c += w;
                        laundryCount++;
                    }
                }
            }
        });

        /* ------------- shopfronts on every ground floor that faces an alley or a street ------------- */
        const alleyWidth = id => (layout.ALLEYS || []).find(a => a.id === id)?.w ?? 2;
        (layout.facades || []).forEach(f => {
            const kind = String(f.kind || '');
            if (f.y0 > 0.5 || !(kind.startsWith('alley') || kind === 'street' || kind === 'well')) return;
            const street = kind === 'street';
            const width0 = street ? 10 : kind === 'well' ? 3 : alleyWidth(kind.slice(6));
            const n = f.normal, tg = f.tangent;
            const facing = Math.atan2(n[0], n[2]);
            const at = (t, off) => [f.p0[0] + tg[0] * t + n[0] * off, f.p0[1] + tg[2] * t + n[2] * off];
            let s = range(0.1, 0.6);
            while (s < f.length - 1.2) {
                const width = Math.min(f.length - s - 0.15, range(1.6, street ? 4.2 : 3.2));
                if (width < 1) break;
                const t = s + width / 2;
                const [x, z] = at(t, 0.04);
                const r = rand();
                if (r < (street ? 0.38 : 0.45)) {
                    const open = rand() < 0.3 ? range(0.6, 1.4) : 0;
                    const height = range(2.3, 2.6);
                    const shut = height - open;
                    boxes.add([x, open + shut / 2, z], [width, shut, 0.06], facing, 1, pick(SHUTTER_PAINT));
                    const [hx, hz] = at(t, 0.15);
                    boxes.add([hx, height + 0.12, hz], [width + 0.1, 0.24, 0.3], facing, 0, '#3a3c3e');
                    if (open > 0) {
                        const [lx, lz] = at(t, -0.4);
                        boxes.add([lx, open - 0.05, lz], [width * 0.8, 0.04, 0.04], facing, 5, '#ffcf8a');
                        const [sx, sz] = at(t, 0.5);
                        lamp([sx, open * 0.5, sz], LAMP_TONES[1], 0.8, 3.5);
                    }
                } else if (r < 0.58) {
                    boxes.add([x, 1.25, z], [width, 2.5, 0.05], facing, 2, '#4a4e50');
                } else if (r < (street ? 0.86 : 0.74)) {
                    // An open stall: counter, awning, a hanging bulb, goods stacked.
                    const reach = street ? 1.8 : Math.min(0.9, width0 * 0.3);
                    const [cx, cz] = at(t, 0.3);
                    boxes.add([cx, 0.45, cz], [width * 0.9, 0.9, 0.5], facing, pick([0, 4, 6]), pick(CRATE));
                    const [awx, awz] = at(t, reach / 2);
                    if (street) boxes.add([awx, 2.75, awz], [width, 0.03, reach + 0.1], facing, 3, pick(TARP), -0.22);
                    const [bx, bz] = at(t, reach * 0.35);
                    const tone = pick([LAMP_TONES[0], LAMP_TONES[1], LAMP_TONES[1], LAMP_TONES[3]]);
                    lumps.add([bx, 2.45, bz], [0.05, 0.065, 0.05], 0, 5, new T.Color(tone[0], tone[1], tone[2]));
                    lamp([bx, 2.35, bz], tone, 0.9, 4, rand() < 0.15 ? 1 : 0);
                    if (rand() < 0.35) steamSources.push([cx, 0.95, cz, range(3, 5)]);
                    for (let i = 0; i < 3; i++) {
                        const [gx, gz] = at(t + range(-width * 0.35, width * 0.35), 0.3);
                        boxes.add([gx, 0.95 + i * 0.2, gz], [range(0.3, 0.5), 0.18, range(0.25, 0.4)], facing + range(-0.2, 0.2), 4, pick(CRATE));
                    }
                } else {
                    // A dark stair door: frame and a step.
                    boxes.add([x, 1.1, z], [0.12, 2.2, 0.2], facing, 6, '#3a3634');
                    const [dx, dz] = at(t, 0.15);
                    boxes.add([dx, 0.07, dz], [width * 0.6, 0.14, 0.3], facing, 6, '#4a4642');
                }
                s += width + range(0.1, 0.5);
            }
        });

        /* ------------- the street outside: lamps, poles, kerbs, stalls ------------- */
        const { south, east } = streets;
        const kerbZ = south[0] + 2.5;
        // The front gate stands in the mouth of the main north-south alley; its market
        // runs along the pavement either side and a little way into the alley.
        const gateAlley = (layout.ALLEYS || []).find(a => a.id === 'B' && a.axis === 'z') || { c: -14, w: 2.2 };
        const GATE = { x: gateAlley.c, z: south[0] + 1.2, half: 3.6,
            market: [gateAlley.c - 13, gateAlley.c + 12], inner: south[0] - 10 };
        const inGate = (x, z) => x > GATE.market[0] - 1 && x < GATE.market[1] + 1 && z > GATE.inner - 0.5 && z < south[0] + 4;
        boxes.add([0, 0.08, south[0] + 1.25], [260, 0.16, 2.5], 0, 6, '#3a3836');
        boxes.add([0, 0.08, south[1] + 1.25], [260, 0.16, 2.5], 0, 6, '#3a3836');
        boxes.add([east[0] + 1.25, 0.08, -25], [2.5, 0.16, 170], 0, 6, '#3a3836');
        boxes.add([0, 0.09, kerbZ], [260, 0.18, 0.18], 0, 6, '#5a5753');
        for (let x = -128; x < east[0]; x += 16) {
            // Tall street lamps on the far kerb, leaning over the road.
            let px = x + range(-1, 1);
            const pz = south[1] + 0.4;
            // Keep clear of the elevated line's piers (every 18 m on the far kerb).
            const pierOff = ((px + 330) % 18 + 18) % 18;
            if (pierOff < 2.2 || pierOff > 15.8) px += pierOff < 9 ? 2.6 - pierOff : 18 - pierOff + 2.6;
            pipe([px, 0, pz], [px, 7.4, pz], 0.09, 7, '#3a3d40');
            pipe([px, 7.4, pz], [px, 7.6, pz - 2.2], 0.06, 7, '#3a3d40');
            boxes.add([px, 7.5, pz - 2.4], [0.35, 0.12, 0.7], 0, 0, '#2a2c2e');
            boxes.add([px, 7.43, pz - 2.4], [0.28, 0.03, 0.6], 0, 5, '#cfe6ff');
            lamp([px, 7.2, pz - 2.4], [0.78, 0.9, 1.0], 2.2, 16);
            // Utility poles with crossarms on the near kerb, cables into the block.
            const ux = x + 8 + range(-1, 1), uz = kerbZ - 0.4;
            pipe([ux, 0, uz], [ux, 10.5, uz], 0.14, 6, '#5a5753');
            for (const h of [8.6, 9.6]) boxes.add([ux, h, uz], [1.8, 0.1, 0.1], 0, 7, '#3a3a3a');
            cylinders.add([ux + 0.5, 8.1, uz], [0.25, 0.7, 0.25], 0, 0, '#5a6066');
            for (let k = 0; k < 6; k++) {
                const ex = ux + range(-4, 4), ey = range(4, 9);
                ribbon(sagLine([ux + range(-0.8, 0.8), range(8.5, 9.8), uz], [ex, ey, south[0] + 0.05], range(0.2, 0.7), 6),
                    range(0.01, 0.025), '#0c0c0d');
                cableCount++;
            }
            if (x > -128) {
                for (let k = 0; k < 3; k++) {
                    ribbon(sagLine([ux - 16, range(8.5, 9.8), uz], [ux, range(8.5, 9.8), uz], range(0.6, 1.2), 8), 0.015, '#0c0c0d');
                }
            }
            // A street stall or a parked hand-cart every other block.
            if (rand() < 0.5) {
                const sx = x + range(2, 6), sz = south[0] + 1.3;
                const paint = pick(['#6a6a60', '#4a5a6a', '#7a5a3a']), tarp = pick(TARP), tone = pick(LAMP_TONES);
                // The market under the gate has its own stalls.
                if (!inGate(sx, sz)) {
                    boxes.add([sx, 0.5, sz], [1.8, 1.0, 0.9], 0, 0, paint);
                    boxes.add([sx, 2.2, sz + 0.2], [2.4, 0.04, 1.6], 0, 3, tarp, -0.12);
                    pipe([sx - 1.1, 0, sz + 0.9], [sx - 1.1, 2.3, sz + 0.9], 0.03, 7, '#555');
                    pipe([sx + 1.1, 0, sz + 0.9], [sx + 1.1, 2.3, sz + 0.9], 0.03, 7, '#555');
                    lumps.add([sx, 2.0, sz + 0.3], [0.08, 0.1, 0.08], 0, 5, new T.Color(tone[0], tone[1], tone[2]));
                    lamp([sx, 1.9, sz + 0.3], tone, 1.5, 6.5);
                }
            }
        }
        for (let z = -100; z < south[0]; z += 18) {
            const px = east[1] + 0.4, pz = z + range(-1, 1);
            pipe([px, 0, pz], [px, 7.4, pz], 0.09, 7, '#3a3d40');
            pipe([px, 7.4, pz], [px - 2.2, 7.6, pz], 0.06, 7, '#3a3d40');
            boxes.add([px - 2.4, 7.43, pz], [0.6, 0.03, 0.28], 0, 5, '#ffd9a0');
            lamp([px - 2.4, 7.2, pz], [1.0, 0.8, 0.55], 2.0, 15);
        }

        /* ------------- vents: gratings in the floor, outlets on the walls ------------- */
        // Kept on their own seed so the rest of the alley stays where it was.
        {
            const vr = mulberry(hash(`${seedText}:vents`));
            const vRange = (a, b) => a + (b - a) * vr();
            runs.forEach(run => {
                const yaw = Math.atan2(run.dir[0], run.dir[1]);
                // A grating in the middle of the alley now and then, breathing all night.
                for (let d = vRange(3, 9); d < run.length - 2; d += vRange(9, 17)) {
                    if (vr() > 0.5) continue;
                    const t = d / run.length;
                    const x = mix(run.a[0], run.b[0], t) + run.normal[0] * vRange(-0.3, 0.3) * run.width;
                    const z = mix(run.a[1], run.b[1], t) + run.normal[1] * vRange(-0.3, 0.3) * run.width;
                    boxes.add([x, 0.012, z], [0.7, 0.024, 0.45], yaw, 2, '#1c1d1f');
                    steamSources.push([x, 0.04, z, vRange(4.5, 7.5)]);
                }
                // Exhaust outlets at head height on the walls, and the odd riser pipe venting.
                for (let d = vRange(4, 10); d < run.length - 2; d += vRange(10, 20)) {
                    if (vr() > 0.45) continue;
                    const side = vr() < 0.5 ? -1 : 1;
                    const t = d / run.length;
                    if (vr() < 0.6) {
                        const h = vRange(2.2, 3.6);
                        const [x, z] = wallAt(run, t, side, 0.06);
                        boxes.add([x, h, z], [0.42, 0.32, 0.1], yaw, 2, '#2a2b2c');
                        const [sx, sz] = wallAt(run, t, side, 0.3);
                        steamSources.push([sx, h, sz, vRange(3, 5)]);
                    } else {
                        const [x, z] = wallAt(run, t, side, 0.18);
                        const h = vRange(0.8, 1.4);
                        cylinders.add([x, h / 2, z], [0.07, h, 0.07], 0, 7, '#4a4844');
                        cylinders.add([x, h + 0.04, z], [0.1, 0.08, 0.1], 0, 7, '#3a3836');
                        steamSources.push([x, h + 0.08, z, vRange(3.5, 6)]);
                    }
                }
            });
        }

        /* ------------- the front gate and its market ------------- */
        const gateLamps = [];
        {
            const gr = mulberry(hash(`${seedText}:gate`));
            const gRange = (a, b) => a + (b - a) * gr();
            const gPick = list => list[Math.floor(gr() * list.length) % list.length];
            const { x: gx, z: gz, half } = GATE;
            const LACQUER = '#4a1a16', DARK = '#2a1412';
            // Two pillars on plinths, a pair of beams, a plaque, a tiled roof with upturned corners.
            for (const side of [-1, 1]) {
                const px = gx + side * half;
                boxes.add([px, 0.3, gz], [0.95, 0.6, 0.95], 0, 6, '#4a4743');
                boxes.add([px, 3.6, gz], [0.5, 6.6, 0.5], 0, 0, LACQUER);
                // Small side bays, lower, the way such gates widen at the foot.
                const sx = gx + side * (half + 1.5);
                boxes.add([sx, 0.25, gz], [0.7, 0.5, 0.7], 0, 6, '#4a4743');
                boxes.add([sx, 2.4, gz], [0.36, 4.3, 0.36], 0, 0, LACQUER);
                boxes.add([gx + side * (half + 0.75), 4.55, gz], [2.0, 0.28, 0.36], 0, 0, DARK);
                boxes.add([gx + side * (half + 0.75), 4.9, gz], [2.5, 0.1, 1.0], 0, 6, '#2a2624');
                boxes.add([gx + side * (half + 0.75), 5.08, gz + 0.22], [2.4, 0.08, 0.6], 0, 6, '#33302c', 0.5);
                boxes.add([gx + side * (half + 0.75), 5.08, gz - 0.22], [2.4, 0.08, 0.6], 0, 6, '#33302c', -0.5);
            }
            boxes.add([gx, 4.4, gz], [half * 2 + 0.6, 0.32, 0.42], 0, 0, DARK);
            boxes.add([gx, 5.7, gz], [half * 2 + 1.2, 0.46, 0.5], 0, 0, LACQUER);
            // Brackets under the eave.
            for (let bx = -half - 0.4; bx <= half + 0.41; bx += 0.55) {
                boxes.add([gx + bx, 6.05, gz], [0.22, 0.24, 0.7], 0, 0, DARK);
            }
            // The plaque: a dark board in a lit frame; the lettering is the signs' business.
            boxes.add([gx, 5.05, gz + 0.24], [2.6, 0.95, 0.08], 0, 0, '#121214');
            boxes.add([gx, 5.55, gz + 0.29], [2.7, 0.04, 0.04], 0, 5, '#ffb060');
            boxes.add([gx, 4.55, gz + 0.29], [2.7, 0.04, 0.04], 0, 5, '#ffb060');
            boxes.add([gx - 1.33, 5.05, gz + 0.29], [0.04, 1.0, 0.04], 0, 5, '#ffb060');
            boxes.add([gx + 1.33, 5.05, gz + 0.29], [0.04, 1.0, 0.04], 0, 5, '#ffb060');
            // Roof: eave slab, two pitched planes, a ridge, corners turned up.
            boxes.add([gx, 6.25, gz], [half * 2 + 2.6, 0.16, 1.9], 0, 6, '#24201e');
            boxes.add([gx, 6.62, gz + 0.45], [half * 2 + 2.2, 0.12, 1.1], 0, 6, '#2e2a27', 0.55);
            boxes.add([gx, 6.62, gz - 0.45], [half * 2 + 2.2, 0.12, 1.1], 0, 6, '#2e2a27', -0.55);
            boxes.add([gx, 6.95, gz], [half * 2 + 2.4, 0.18, 0.2], 0, 6, '#1e1b19');
            for (const side of [-1, 1]) {
                boxes.add([gx + side * (half + 1.55), 6.4, gz], [0.7, 0.1, 1.9], 0, 6, '#24201e', 0, side * 0.35);
                boxes.add([gx + side * (half + 1.25), 7.12, gz], [0.5, 0.14, 0.14], 0, 6, '#1e1b19', 0, -side * 0.6);
            }
            // A cold tube along the underside of the lower beam, red lanterns either side of the way.
            boxes.add([gx, 4.2, gz + 0.1], [half * 2 - 0.6, 0.05, 0.05], 0, 5, '#4ae6ff');
            gateLamps.push([[gx, 4.05, gz + 0.3], [0.3, 0.9, 1.0], 1.3, 6.5]);
            for (const side of [-1, 1]) {
                const lx = gx + side * (half - 1.1);
                pipe([lx, 4.25, gz + 0.05], [lx, 3.75, gz + 0.05], 0.008, 7, '#222');
                lumps.add([lx, 3.5, gz + 0.05], [0.24, 0.3, 0.24], 0, 5, '#ff5a32');
                gateLamps.push([[lx, 3.4, gz + 0.3], [1.0, 0.38, 0.2], 1.1, 5.5]);
            }
            // The market: tarps on poles along the pavement, skipping the gate's own bay.
            const TARPS = ['#5a1c18', '#6a4a1c', '#1c3a50', '#24442a', '#4a2444', '#4a4a44'];
            for (let x = GATE.market[0]; x < GATE.market[1]; ) {
                const w = gRange(2.2, 3.2);
                const cx = x + w / 2;
                x += w + 0.1;
                if (Math.abs(cx - gx) < half + 2.2) continue;
                const depth = gRange(2.6, 3.2), h = gRange(2.75, 3.05);
                boxes.add([cx, h, south[0] + depth / 2 + 0.1], [w, 0.03, depth], 0, 3, gPick(TARPS), -0.14 + gRange(-0.04, 0.04));
                pipe([cx - w / 2 + 0.1, 0, south[0] + depth], [cx - w / 2 + 0.1, h - 0.15, south[0] + depth], 0.025, 7, '#555');
                pipe([cx + w / 2 - 0.1, 0, south[0] + depth], [cx + w / 2 - 0.1, h - 0.15, south[0] + depth], 0.025, 7, '#555');
                // A counter of goods against the shopfront, bulbs on a wire.
                boxes.add([cx, 0.45, south[0] + 0.55], [w * 0.85, 0.9, 0.7], 0, gPick([0, 4, 6]), gPick(CRATE));
                for (let i = 0; i < 4; i++) {
                    boxes.add([cx + gRange(-w * 0.35, w * 0.35), 0.98 + gr() * 0.25, south[0] + gRange(0.35, 0.75)],
                        [gRange(0.25, 0.45), gRange(0.12, 0.25), gRange(0.2, 0.35)], gRange(-0.2, 0.2), gPick([4, 8]), gPick(CRATE));
                }
                const tone = gPick([LAMP_TONES[0], LAMP_TONES[1], LAMP_TONES[1], LAMP_TONES[3]]);
                for (let i = 0; i < 3; i++) {
                    lumps.add([cx - w / 3 + i * w / 3, h - 0.32, south[0] + 1.3], [0.05, 0.065, 0.05], 0, 5, new T.Color(tone[0], tone[1], tone[2]));
                }
                gateLamps.push([[cx, h - 0.45, south[0] + 1.3], tone, 1.2, 5]);
                if (gr() < 0.4) steamSources.push([cx + gRange(-0.5, 0.5), 1.0, south[0] + 0.6, gRange(3, 5)]);
            }
            // Into the alley: tarps strung wall to wall over the first stretch, bulbs between.
            const aw = gateAlley.w ?? 2.2;
            for (let z = south[0] - 0.6; z > GATE.inner; z -= gRange(1.8, 2.4)) {
                boxes.add([gx, gRange(2.9, 3.15), z], [aw + 0.3, 0.03, gRange(1.4, 1.9)], gRange(-0.06, 0.06), 3, gPick(TARPS), gRange(-0.12, 0.12));
                lumps.add([gx + gRange(-0.4, 0.4), 2.7, z - 0.9], [0.05, 0.065, 0.05], 0, 5, '#ffcf8a');
                if (gr() < 0.5) gateLamps.push([[gx, 2.6, z - 0.9], LAMP_TONES[1], 0.9, 4]);
                // Goods stacked against the walls on both sides.
                for (const side of [-1, 1]) {
                    if (gr() < 0.4) continue;
                    boxes.add([gx + side * (aw / 2 - 0.25), 0.3, z - gRange(0, 1.2)], [0.4, 0.6, 0.6], gRange(-0.2, 0.2), 4, gPick(CRATE));
                }
            }
        }
        gateLamps.forEach(l => lamp(...l));

        /* ------------- hand-carts and goods by the doors ------------- */
        const cart = (x, z, yaw, cr) => {
            const c = Math.cos(yaw), s0 = Math.sin(yaw);
            const loc = (lx, lz) => [x + lx * c + lz * s0, z - lx * s0 + lz * c];
            const [bx, bz] = loc(0, 0);
            boxes.add([bx, 0.72, bz], [1.3, 0.08, 0.72], yaw, 0, cr.paint);
            boxes.add([bx, 0.86, bz], [1.3, 0.22, 0.04], yaw, 0, cr.paint);
            for (const side of [-1, 1]) {
                const [wx, wz] = loc(0.15, side * 0.4);
                cylinders.add([wx, 0.32, wz], [0.32, 0.05, 0.32], yaw, 7, '#151515', Math.PI / 2);
                const [hx, hz] = loc(-0.95, side * 0.3);
                const [ex, ez] = loc(-0.55, side * 0.3);
                pipe([ex, 0.74, ez], [hx, 0.95, hz], 0.02, 7, '#3a3a38');
                const [lx, lz] = loc(0.55, side * 0.3);
                pipe([lx, 0, lz], [lx, 0.7, lz], 0.02, 7, '#3a3a38');
            }
            for (let i = 0; i < cr.load; i++) {
                const [gx2, gz2] = loc(cr.r() * 0.8 - 0.4, cr.r() * 0.4 - 0.2);
                boxes.add([gx2, 0.88 + i * 0.12, gz2], [0.38, 0.22, 0.3], yaw + cr.r() * 0.4 - 0.2, cr.r() < 0.5 ? 4 : 8, cr.goods());
            }
        };
        {
            const cr0 = mulberry(hash(`${seedText}:carts`));
            const cRange = (a, b) => a + (b - a) * cr0();
            const cPick = list => list[Math.floor(cr0() * list.length) % list.length];
            const opts = () => ({ paint: cPick(['#3a3430', '#4a3a2a', '#2e3a44', '#5a4a3a']), load: 1 + Math.floor(cr0() * 4), r: cr0, goods: () => cPick(CRATE) });
            runs.forEach(run => {
                const yaw = Math.atan2(run.dir[0], run.dir[1]) - Math.PI / 2;
                for (let d = cRange(6, 20); d < run.length - 3; d += cRange(22, 40)) {
                    if (run.width < 1.6 || cr0() > 0.55) continue;
                    const side = cr0() < 0.5 ? -1 : 1;
                    const [x, z] = wallAt(run, d / run.length, side, 0.55);
                    if (inGate(x, z)) continue;
                    cart(x, z, yaw + (cr0() - 0.5) * 0.2, opts());
                }
                // Goods piled by doorways: crates, sacks, a few bundles.
                for (let d = cRange(3, 10); d < run.length - 2; d += cRange(9, 16)) {
                    if (cr0() > 0.6) continue;
                    const side = cr0() < 0.5 ? -1 : 1;
                    const [x, z] = wallAt(run, d / run.length, side, 0.3);
                    const n = 2 + Math.floor(cr0() * 4);
                    for (let i = 0; i < n; i++) {
                        const [ox, oz] = [cRange(-0.4, 0.4) * run.dir[0], cRange(-0.4, 0.4) * run.dir[1]];
                        if (cr0() < 0.35) lumps.add([x + ox, 0.18 + (i > 2 ? 0.3 : 0), z + oz], [0.28, 0.2, 0.22], cr0() * 6, 4, cPick(['#8a7a5a', '#6a5a40', '#9a9070']));
                        else boxes.add([x + ox, 0.17 + Math.floor(i / 2) * 0.32, z + oz], [cRange(0.35, 0.5), 0.32, cRange(0.3, 0.45)], yaw + cRange(-0.3, 0.3), 4, cPick(CRATE));
                    }
                }
            });
            // A few carts on the street, outside the market.
            for (let i = 0; i < 8; i++) {
                const x = cRange(-95, 90), z = cRange(south[0] + 3, south[0] + 4.5);
                if (inGate(x, z)) continue;
                cart(x, z, cRange(-0.3, 0.3), opts());
            }
        }

        /* ------------- under the built-over stretches ------------- */
        // No sky: tubes on the soffit light the way, and water comes through
        // at the ends where the cover meets the open alley.
        const leaks = [];
        bridges.forEach(b => {
            const ew = b.x1 - b.x0 > b.z1 - b.z0;
            const length = ew ? b.x1 - b.x0 : b.z1 - b.z0;
            const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
            const y = b.y0 - 0.12;
            for (let d = range(0.8, 2); d < length - 0.5; d += range(2.6, 4.2)) {
                const x = ew ? b.x0 + d : cx + range(-0.3, 0.3), z = ew ? cz + range(-0.3, 0.3) : b.z0 + d;
                const tone = pick([LAMP_TONES[0], LAMP_TONES[0], LAMP_TONES[2], LAMP_TONES[1]]);
                const lit = rand() < 0.88;
                boxes.add([x, y, z], [ew ? 1.2 : 0.05, 0.05, ew ? 0.05 : 1.2], 0, lit ? 5 : 0,
                    lit ? new T.Color(tone[0], tone[1], tone[2]) : '#444');
                if (lit) lamp([x, y - 0.1, z], tone, 1.0, Math.min(5, b.y0 * 0.6), rand() < 0.15 ? 1 : 0);
                // Cables and pipes are fixed to the soffit here, not strung across.
                for (let k = 0; k < 3; k++) {
                    const off = range(-0.8, 0.8);
                    ribbon(sagLine(ew ? [x - 1.6, y - 0.05, cz + off] : [cx + off, y - 0.05, z - 1.6],
                        ew ? [x + 1.6, y - 0.05, cz + off] : [cx + off, y - 0.05, z + 1.6], range(0.05, 0.25), 4), 0.012, '#0c0c0d');
                }
            }
            for (const end of [0, 1]) {
                for (let k = 0; k < 3; k++) {
                    const along = end ? length : 0;
                    const pos = ew ? [b.x0 + along, b.y0, cz + range(-0.9, 0.9)] : [cx + range(-0.9, 0.9), b.y0, b.z0 + along];
                    leaks.push({ pos, normal: [0, 0, 0], leak: true });
                }
            }
        });

        /* ------------- drips under the air conditioners ------------- */
        // The block has thousands of units; only those nearest the camera drip.
        // Their positions come from the city once it exists (ctx.city.acPositions).
        const DRIPS = 256;
        const dripGeometry = keep(new T.BufferGeometry());
        const dripOrigin = new Float32Array(DRIPS * 3 * 4 * 3);
        {
            // Per drip: two falling drops (quads) and a splash ring (quad) at the foot.
            const quads = DRIPS * 3;
            const corner = new Float32Array(quads * 4 * 3);
            const index = new Uint32Array(quads * 6);
            for (let i = 0; i < DRIPS; i++) {
                const phase = rand();
                for (let k = 0; k < 3; k++) {
                    const qd = i * 3 + k;
                    for (let c = 0; c < 4; c++) {
                        // corner.xy: quad corner; corner.z packs kind (0/1 drop, 2 splash) + phase.
                        corner.set([c & 1 ? 1 : -1, c & 2 ? 1 : -1, k + phase * 0.5], (qd * 4 + c) * 3);
                    }
                    index.set([qd * 4, qd * 4 + 1, qd * 4 + 2, qd * 4 + 1, qd * 4 + 3, qd * 4 + 2], qd * 6);
                }
            }
            dripOrigin.fill(-1000);
            dripGeometry.setAttribute('position', new T.BufferAttribute(dripOrigin, 3).setUsage(T.DynamicDrawUsage));
            dripGeometry.setAttribute('corner', new T.BufferAttribute(corner, 3));
            dripGeometry.setIndex(new T.BufferAttribute(index, 1));
            dripGeometry.setDrawRange(0, 0);
        }
        let dripSources = null;
        const dripAt = new T.Vector3(1e9, 0, 0);
        const dripPick = [];
        const placeDrips = camera => {
            if (!dripSources) {
                const acs = ctx.city?.acPositions || facadeSlots(layout, 'ac').map(s => [s.pos[0] + s.normal[0] * 0.45, s.pos[1], s.pos[2] + s.normal[2] * 0.45]);
                if (!acs.length && !leaks.length) return;
                // A unit drips from its tray just under and in front of it; leaks pour from the cover's edge.
                dripSources = acs.map(p => [p[0], p[1] - 0.3, p[2]]).concat(leaks.map(l => l.pos));
            }
            if (!camera || camera.position.distanceToSquared(dripAt) < 16) return;
            dripAt.copy(camera.position);
            dripPick.length = 0;
            const cx = camera.position.x, cz = camera.position.z;
            for (let i = 0; i < dripSources.length; i++) {
                const p = dripSources[i];
                const d = (p[0] - cx) ** 2 + (p[2] - cz) ** 2;
                if (d < 2500) dripPick.push([d, i]);
            }
            dripPick.sort((a, b) => a[0] - b[0]);
            const n = Math.min(DRIPS, dripPick.length);
            for (let i = 0; i < n; i++) {
                const p = dripSources[dripPick[i][1]];
                for (let v = 0; v < 12; v++) dripOrigin.set(p, (i * 12 + v) * 3);
            }
            dripGeometry.attributes.position.needsUpdate = true;
            dripGeometry.setDrawRange(0, n * 18);
        };
        const dripMat = keep(new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: true,
            uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, {}]),
            vertexShader: `attribute vec3 corner;uniform float time,kwSb;uniform vec3 kwEye;uniform vec3 uLightPos[${MAX_LIGHTS}];uniform vec3 uLightCol[${MAX_LIGHTS}];uniform float uLightRad[${MAX_LIGHTS}];uniform int uLightCount;
                varying vec2 vUv;varying float vKind,vAlpha;varying vec3 vTint;
                #include <fog_pars_vertex>
                void main(){
                    float kind=floor(corner.z);float phase=fract(corner.z)*2.0;
                    float fallH=max(position.y,0.5);float T=sqrt(2.0*fallH/9.8);
                    float cycle=T+1.1;float t=mod(time+phase*cycle,cycle);
                    vec3 p=position;vUv=corner.xy;vKind=kind;
                    vec3 toCam=cameraPosition-p;float dist=distance(kwEye,p);
                    vAlpha=1.0-smoothstep(18.0+kwSb*30.0,40.0+kwSb*40.0,dist);
                    vec4 mvPosition;
                    if(kind<1.5){
                        float tt=t-kind*0.45;
                        float y=p.y-0.5*9.8*tt*tt;float v=9.8*tt;
                        if(tt<0.0||y<0.0){vAlpha=0.0;}
                        p.y=y;
                        float len=clamp(v*0.018,0.02,0.12)*(1.0+kwSb*4.0);
                        vec3 side=normalize(cross(vec3(0.0,1.0,0.0),toCam));
                        p+=side*corner.x*(0.006+kwSb*0.04)+vec3(0.0,corner.y*len,0.0);
                    } else {
                        float land=t-T;
                        float r=(clamp(land,0.0,0.4)*0.6+0.02)*(1.0+kwSb*1.5);
                        vAlpha*=step(0.0,land)*(1.0-smoothstep(0.0,0.45,land));
                        p=vec3(p.x+corner.x*r,0.012,p.z+corner.y*r);
                    }
                    vec3 glow=vec3(0.06,0.07,0.08);
                    for(int i=0;i<${MAX_LIGHTS};i++){if(i>=uLightCount)break;float f=max(0.0,1.0-length(uLightPos[i]-p)/uLightRad[i]);
                        glow+=uLightCol[i]*f*f;}
                    vTint=glow;
                    mvPosition=viewMatrix*vec4(p,1.0);
                    gl_Position=projectionMatrix*mvPosition;
                    if(vAlpha<=0.0)gl_Position=vec4(2.0,2.0,2.0,1.0);
                    #include <fog_vertex>
                }`,
            fragmentShader: `varying vec2 vUv;varying float vKind,vAlpha;varying vec3 vTint;
                #include <fog_pars_fragment>
                void main(){
                    float a;
                    if(vKind<1.5)a=(1.0-vUv.x*vUv.x)*0.9;
                    else{float r=length(vUv);a=smoothstep(0.75,0.95,r)*(1.0-smoothstep(0.95,1.0,r))*0.8;}
                    a*=vAlpha;if(a<0.01)discard;
                    gl_FragColor=vec4(vTint*a*1.6,1.0);
                    #include <fog_fragment>
                }`
        }));
        Object.assign(dripMat.uniforms, { time: shared.time, kwEye: shared.eye, kwSb: shared.sb, ...lightSet });
        const drips = new T.Mesh(dripGeometry, dripMat);
        drips.name = 'kowloonDrips'; drips.frustumCulled = false; drips.layers.set(LAYER_VIEW_ONLY);
        root.add(drips);

        /* ------------- the rain ------------- */
        const RAIN_MAX = RAIN_COUNTS.ultimate;
        const rainGeometry = keep(new T.BufferGeometry());
        {
            const seeds = new Float32Array(RAIN_MAX * 4 * 3), corners = new Float32Array(RAIN_MAX * 4 * 2);
            const index = new Uint32Array(RAIN_MAX * 6);
            const r = mulberry(hash('kowloon-rain'));
            for (let i = 0; i < RAIN_MAX; i++) {
                const s = [r(), r(), r()];
                for (let c = 0; c < 4; c++) {
                    seeds.set(s, (i * 4 + c) * 3);
                    corners.set([c & 1 ? 1 : -1, c & 2 ? 1 : 0], (i * 4 + c) * 2);
                }
                index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
            }
            rainGeometry.setAttribute('position', new T.BufferAttribute(seeds, 3));
            rainGeometry.setAttribute('corner', new T.BufferAttribute(corners, 2));
            rainGeometry.setIndex(new T.BufferAttribute(index, 1));
            rainGeometry.setDrawRange(0, 0);
        }
        const rainMat = keep(new T.ShaderMaterial({
            transparent: true, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending,
            uniforms: { time: shared.time, amount: shared.rain, centre: { value: new T.Vector3() },
                wind: { value: new T.Vector2(0.6, 0.9) }, colour: { value: new T.Color('#8fa4b8') },
                kwSb: shared.sb, kwSbArea: shared.sbBox,
                ...lightSet,
                shelterBox: shared.shelterBox, shelterY: shared.shelterY },
            vertexShader: `attribute vec2 corner;uniform float time,amount,kwSb;uniform vec4 kwSbArea;uniform vec3 centre;uniform vec2 wind;
                uniform vec3 uLightPos[${MAX_LIGHTS}];uniform vec3 uLightCol[${MAX_LIGHTS}];uniform float uLightRad[${MAX_LIGHTS}];uniform int uLightCount;
                ${SHELTER}
                varying float vAlpha,vAcross;varying vec3 vGlow;
                const float BOX=${RAIN_BOX.toFixed(1)},HEIGHT=${RAIN_HEIGHT.toFixed(1)};
                void main(){
                    float fall=8.5+position.z*3.0;
                    vec3 p;
                    p.x=centre.x+(fract((position.x*BOX-centre.x)/BOX)-0.5)*BOX;
                    p.z=centre.z+(fract((position.z*BOX*1.618-centre.z)/BOX)-0.5)*BOX;
                    float drop=fract(position.y-time*fall/HEIGHT);
                    p.y=max(centre.y,1.0)-HEIGHT*0.35+drop*HEIGHT;
                    // Sandbox view: the rain fills the whole cut block, roofs to street; fewer,
                    // longer, thicker streaks, so they read from far above.
                    if(kwSb>0.5){
                        p.x=mix(kwSbArea.x,kwSbArea.y,fract(position.x*7.31+position.y*3.17));
                        p.z=mix(kwSbArea.z,kwSbArea.w,fract(position.z*5.77+position.x*1.618));
                        p.y=drop*66.0;
                    }
                    vec3 v=vec3(wind.x,-fall,wind.y);
                    vec3 head=mix(p,p-v*(0.035+fract(position.y*13.7)*0.03)*(1.0+kwSb*3.5),corner.y);
                    vec3 toCam=normalize(cameraPosition-head);
                    float dist=distance(cameraPosition,p);
                    head+=normalize(cross(normalize(v),toCam))*corner.x*mix(0.003+dist*0.001,0.055,kwSb);
                    vAlpha=smoothstep(1.0,4.5,dist)*(1.0-smoothstep(BOX*0.2,BOX*0.5,dist))*step(0.0,p.y)*(0.3+0.7*fract(position.x*91.3));
                    if(kwSb>0.5)vAlpha=0.18+0.45*fract(position.x*91.3);
                    vAlpha*=1.0-kSheltered(p);
                    vAcross=corner.x;
                    // Drops falling through a lamp's or a sign's light carry its colour.
                    vec3 glow=vec3(0.0);
                    for(int i=0;i<${MAX_LIGHTS};i++){if(i>=uLightCount)break;float f=max(0.0,1.0-length(uLightPos[i]-p)/(uLightRad[i]*1.2));
                        glow+=uLightCol[i]*f*f;}
                    vGlow=glow+vec3(0.2,0.25,0.3)*kwSb;
                    gl_Position=projectionMatrix*viewMatrix*vec4(head,1.0);
                    if(vAlpha<=0.0)gl_Position=vec4(2.0,2.0,2.0,1.0);
                }`,
            fragmentShader: `uniform vec3 colour;varying float vAlpha,vAcross;varying vec3 vGlow;
                void main(){
                    float a=vAlpha*(1.0-vAcross*vAcross);
                    if(a<0.004)discard;
                    gl_FragColor=vec4((colour*0.06+min(vGlow*0.22,vec3(0.35)))*a,1.0);
                    #include <colorspace_fragment>
                }`
        }));
        const rain = new T.Mesh(rainGeometry, rainMat);
        rain.name = 'kowloonRain'; rain.frustumCulled = false; rain.renderOrder = 5; rain.visible = false;
        rain.layers.set(LAYER_VIEW_ONLY);
        root.add(rain);

        /* ------------- light in the haze: halos and the cones under lamps ------------- */
        const HALOS = MAX_LIGHTS;
        const haloGeometry = keep(new T.InstancedBufferGeometry());
        haloGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
        haloGeometry.setIndex([0, 1, 2, 1, 3, 2]);
        haloGeometry.setAttribute('slot', new T.InstancedBufferAttribute(new Float32Array(Array.from({ length: HALOS }, (_, i) => i)), 1));
        haloGeometry.instanceCount = 0;
        const haloMat = keep(new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false,
            uniforms: { ...lightSet, haze: { value: 0.5 }, day: shared.day },
            vertexShader: `attribute float slot;uniform vec3 uLightPos[${MAX_LIGHTS}];uniform vec3 uLightCol[${MAX_LIGHTS}];uniform float uLightRad[${MAX_LIGHTS}];uniform int uLightCount;
                uniform float uLightHalo[${MAX_LIGHTS}];
                varying vec2 vUv;varying vec3 vCol;
                void main(){
                    int i=int(slot);vec4 lp=vec4(uLightPos[i],uLightRad[i]);vec4 lc=vec4(uLightCol[i],1.0);
                    float size=clamp(lp.w*0.28,0.35,2.4)*(0.75+0.15*min(lc.w,3.0));
                    vec4 mv=viewMatrix*vec4(lp.xyz,1.0);
                    mv.xy+=position.xy*size;
                    // Pulled toward the camera so the wall it hangs on does not cut it in half.
                    mv.xyz+=normalize(-mv.xyz)*min(size*0.6,length(mv.xyz)*0.5);
                    vUv=position.xy;vCol=lc.rgb*min(lc.w,4.0);
                    gl_Position=projectionMatrix*mv;
                    if(uLightHalo[i]<0.5||i>=uLightCount)gl_Position=vec4(2.0,2.0,2.0,1.0);
                }`,
            fragmentShader: `uniform float haze,day;varying vec2 vUv;varying vec3 vCol;
                void main(){float r=dot(vUv,vUv);if(r>1.0)discard;
                    float a=(exp(-r*5.0)*0.6+exp(-r*24.0)*0.5)*(1.0-r);
                    gl_FragColor=vec4(vCol*a*haze*0.22*(1.0-0.7*day),1.0);}`
        }));
        const halos = new T.Mesh(haloGeometry, haloMat);
        halos.name = 'kowloonHalos'; halos.frustumCulled = false; halos.renderOrder = 4;
        root.add(halos);

        for (let x = MAP.x0 + 4.5; x < streets.east[0]; x += 9) {
            if (rand() < 0.3) steamSources.push([x, 0.02, streets.south[0] + 3, range(4, 7)]);
        }

        /* ------------- light you can see in the wet air: cones under lamps ------------- */
        const CONES = 28;
        const coneGeometry = keep(new T.CylinderGeometry(0.06, 1, 1, 18, 1, true));
        coneGeometry.translate(0, -0.5, 0);
        const coneMat = keep(new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false,
            uniforms: { time: shared.time, haze: { value: 0.5 }, day: shared.day },
            vertexShader: `varying float vDown,vEdge;varying vec3 vTint,vWorld;
                void main(){
                    vec4 w=modelMatrix*instanceMatrix*vec4(position,1.0);vWorld=w.xyz;
                    vDown=-position.y;
                    vec3 n=normalize(mat3(modelMatrix*instanceMatrix)*normal);
                    vEdge=abs(dot(n,normalize(cameraPosition-w.xyz)));
                    vTint=instanceColor;
                    gl_Position=projectionMatrix*viewMatrix*w;
                }`,
            fragmentShader: `uniform float time,haze,day;varying float vDown,vEdge;varying vec3 vTint,vWorld;${NOISE}
                void main(){
                    float a=pow(vEdge,2.6)*pow(1.0-vDown,1.8)*smoothstep(0.0,0.15,vDown);
                    // Rain and drift moving through the beam.
                    float drift=kNoise(vec2(vWorld.x*1.3+vWorld.z*0.7,vWorld.y*2.0+time*1.4))*0.5
                        +kNoise(vec2(vWorld.x*4.0-vWorld.z*3.0,vWorld.y*9.0+time*6.0))*0.3;
                    a*=0.55+drift;
                    gl_FragColor=vec4(vTint*a*haze*(1.0-0.8*day),1.0);
                }`
        }));
        const cones = new T.InstancedMesh(coneGeometry, coneMat, CONES);
        cones.name = 'kowloonLightCones'; cones.frustumCulled = false; cones.count = 0; cones.renderOrder = 4;
        cones.instanceMatrix.setUsage(T.DynamicDrawUsage);
        cones.setColorAt(0, new T.Color(0, 0, 0));
        cones.layers.set(LAYER_VIEW_ONLY);
        root.add(cones);
        const coneLamps = lamps.filter(l => l.cone);
        const coneAt = new T.Vector3(1e9, 0, 0), coneDummy = new T.Object3D(), coneColour = new T.Color();
        const coneOrder = coneLamps.map(l => ({ l, d: 0 }));
        const placeCones = camera => {
            if (!camera || camera.position.distanceToSquared(coneAt) < 4) return;
            coneAt.copy(camera.position);
            coneOrder.forEach(e => { const p = e.l.position; e.d = (p[0] - coneAt.x) ** 2 + (p[1] - coneAt.y) ** 2 + (p[2] - coneAt.z) ** 2; });
            coneOrder.sort((a, b) => a.d - b.d);
            const n = Math.min(CONES, coneOrder.length);
            for (let i = 0; i < n; i++) {
                const l = coneOrder[i].l;
                const h = l.position[1];
                const r = Math.min(l.radius * 0.45, h * 0.75);
                coneDummy.position.set(l.position[0], l.position[1], l.position[2]);
                coneDummy.scale.set(r, h, r);
                coneDummy.updateMatrix();
                cones.setMatrixAt(i, coneDummy.matrix);
                const k = 0.03 * Math.min(2.5, l.intensity);
                cones.setColorAt(i, coneColour.setRGB(l.color[0] * k, l.color[1] * k, l.color[2] * k));
            }
            cones.count = n;
            cones.instanceMatrix.needsUpdate = true;
            cones.instanceColor.needsUpdate = true;
        };

        /* ------------- steam ------------- */
        const PUFFS = 6;
        const steamGeometry = keep(new T.InstancedBufferGeometry());
        steamGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
        steamGeometry.setIndex([0, 1, 2, 1, 3, 2]);
        {
            const src = new Float32Array(steamSources.length * PUFFS * 4), seed = new Float32Array(steamSources.length * PUFFS * 2);
            steamSources.forEach((p, i) => {
                for (let k = 0; k < PUFFS; k++) {
                    src.set([p[0], p[1], p[2], p[3]], (i * PUFFS + k) * 4);
                    seed.set([(k + rand() * 0.6) / PUFFS, range(0.7, 1.3)], (i * PUFFS + k) * 2);
                }
            });
            steamGeometry.setAttribute('source', new T.InstancedBufferAttribute(src, 4));
            steamGeometry.setAttribute('seed', new T.InstancedBufferAttribute(seed, 2));
            steamGeometry.instanceCount = steamSources.length * PUFFS;
        }
        const steamMat = keep(new T.ShaderMaterial({
            transparent: true, depthWrite: false, fog: true,
            uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, {}]),
            vertexShader: `attribute vec4 source;attribute vec2 seed;uniform float time,kwSb;uniform vec3 hemiSky;
                ${LIGHT_DECL}
                varying vec2 vUv;varying float vFade,vSeed;varying vec3 vLit;
                #include <fog_pars_vertex>
                void main(){
                    float life=fract(time/source.w+seed.x);
                    vec3 c=source.xyz+vec3(0.35*life+sin(life*5.0+seed.x*30.0)*0.06,life*2.2,0.15*life);
                    float size=(0.12+life*0.55)*seed.y;
                    vec3 right=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0]);
                    vec3 up=vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1]);
                    vec3 w=c+(right*position.x+up*position.y)*size;
                    vUv=position.xy;vSeed=seed.x*37.0+source.x;
                    float dist=kwSb>0.5?10.0:distance(cameraPosition,c);
                    vFade=smoothstep(0.0,0.12,life)*(1.0-smoothstep(0.5,1.0,life))*(1.0-smoothstep(25.0,45.0,dist))*smoothstep(0.8,3.0,dist);
                    vec3 lit=hemiSky*0.6;
                    for(int i=0;i<${MAX_LIGHTS};i++){if(i>=uLightCount)break;float f=max(0.0,1.0-length(uLightPos[i]-c)/uLightRad[i]);lit+=uLightCol[i]*f*f;}
                    vLit=lit;
                    vec4 mvPosition=viewMatrix*vec4(w,1.0);gl_Position=projectionMatrix*mvPosition;
                    #include <fog_vertex>
                }`,
            fragmentShader: `varying vec2 vUv;varying float vFade,vSeed;varying vec3 vLit;${NOISE}
                #include <fog_pars_fragment>
                void main(){
                    float r=length(vUv);if(r>1.0)discard;
                    float puff=kFbm(vUv*1.6+vSeed)*1.3-0.25;
                    float a=smoothstep(1.0,0.2,r)*clamp(puff,0.0,1.0)*vFade*0.2;
                    if(a<0.004)discard;
                    gl_FragColor=vec4(vLit*0.9,a);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    #include <fog_fragment>
                }`
        }));
        Object.assign(steamMat.uniforms, { time: shared.time, kwSb: shared.sb, hemiSky: shared.hemiSky, ...lightSet });
        const steam = new T.Mesh(steamGeometry, steamMat);
        steam.name = 'kowloonSteam'; steam.frustumCulled = false; steam.renderOrder = 3;
        steam.visible = steamSources.length > 0;
        root.add(steam);

        /* ------------- people: dark figures under lit umbrellas ------------- */
        // One instanced mesh. Each figure walks a stretch of alley or pavement and back;
        // legs swing in the vertex shader; umbrellas open while it rains and take the
        // colour of whatever sign is nearest.
        const WALKERS = { 'energy-saving': 32, standard: 64, ultimate: 96 };
        const MAX_WALKERS = 96;
        const walkerGeometry = keep(new T.InstancedBufferGeometry());
        {
            const pos = [], nor = [], part = [];
            const m4 = new T.Matrix4(), nm = new T.Matrix3();
            const add = (geo, id, matrix) => {
                const g = geo.index ? geo.toNonIndexed() : geo;
                g.applyMatrix4(matrix);
                const P = g.attributes.position, N = g.attributes.normal;
                for (let i = 0; i < P.count; i++) {
                    pos.push(P.getX(i), P.getY(i), P.getZ(i));
                    nor.push(N.getX(i), N.getY(i), N.getZ(i));
                    part.push(id);
                }
                g.dispose(); if (g !== geo) geo.dispose();
            };
            const at = (x, y, z, sx = 1, sy = 1, sz = 1, rx = 0) => m4.compose(new T.Vector3(x, y, z),
                new T.Quaternion().setFromEuler(new T.Euler(rx, 0, 0)), new T.Vector3(sx, sy, sz));
            // Legs hang from the hip (y 0.82) so the shader can swing them about it.
            add(new T.BoxGeometry(0.12, 0.82, 0.14), 1, at(-0.09, 0.41, 0));
            add(new T.BoxGeometry(0.12, 0.82, 0.14), 2, at(0.09, 0.41, 0));
            // A long coat, a bag on one hip, a head.
            add(new T.CylinderGeometry(0.19, 0.25, 0.92, 8, 1, false), 0, at(0, 1.05, 0, 1, 1, 0.68));
            add(new T.BoxGeometry(0.1, 0.26, 0.24), 0, at(-0.27, 0.9, 0));
            add(new T.SphereGeometry(0.11, 7, 5), 0, at(0, 1.62, 0.01));
            // The umbrella: shaft from the hand, a shallow canopy.
            add(new T.CylinderGeometry(0.012, 0.012, 0.95, 4, 1, true), 4, at(0.14, 1.55, 0.06));
            add(new T.ConeGeometry(0.58, 0.26, 10, 1, true), 3, at(0.1, 2.08, 0.06));
            walkerGeometry.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
            walkerGeometry.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
            walkerGeometry.setAttribute('part', new T.Float32BufferAttribute(part, 1));
            void nm;
        }
        {
            const wr = mulberry(hash(`${seedText}:walkers`));
            const wRange = (a, b) => a + (b - a) * wr();
            const paths = [];
            const total = runs.reduce((sum, r) => sum + (r.length > 8 ? r.length : 0), 0);
            const alleyRun = () => {
                let k = wr() * total;
                for (const r of runs) { if (r.length <= 8) continue; k -= r.length; if (k <= 0) return r; }
                return runs[0];
            };
            // Gate traffic first so even the fewest figures include it, then the rest mixed.
            for (let i = 0; i < 4; i++) {
                const lat = wRange(-0.25, 0.25);
                paths.push([GATE.x + lat, south[0] + wRange(3, 8), GATE.x + lat * 0.5, south[0] - wRange(14, 30)]);
            }
            while (paths.length < MAX_WALKERS) {
                if (wr() < 0.32) {
                    // The pavement by the shops, or out in the road where the market spills.
                    const z = wr() < 0.6 ? wRange(south[0] + 1.9, south[0] + 2.3) : wRange(south[0] + 3.2, south[0] + 9.3);
                    const x0 = wRange(-100, 85), len = wRange(18, 50);
                    paths.push([x0, z, x0 + len, z + wRange(-0.3, 0.3)]);
                } else {
                    const r = alleyRun();
                    if (!r || !runs.length) break;
                    const len = Math.min(r.length - 1, wRange(8, 28));
                    const t0 = wRange(0, Math.max(0, r.length - len)) / r.length, t1 = t0 + len / r.length;
                    const lat = wRange(-0.22, 0.22) * r.width;
                    const p0 = [mix(r.a[0], r.b[0], t0) + r.normal[0] * lat, mix(r.a[1], r.b[1], t0) + r.normal[1] * lat];
                    const p1 = [mix(r.a[0], r.b[0], t1) + r.normal[0] * lat, mix(r.a[1], r.b[1], t1) + r.normal[1] * lat];
                    paths.push([p0[0], p0[1], p1[0], p1[1]]);
                }
            }
            // Shuffle all but the gate's, so any prefix is spread over the whole block.
            for (let i = paths.length - 1; i > 4; i--) {
                const j = 4 + Math.floor(wr() * (i - 3));
                [paths[i], paths[j]] = [paths[j], paths[i]];
            }
            const UMBRELLA = ['#1a1c20', '#1a1c20', '#2a2e36', '#b8bcc0', '#a02a24', '#24508a', '#b09030', '#2e7070'];
            const path = new Float32Array(MAX_WALKERS * 4), motion = new Float32Array(MAX_WALKERS * 4), tint = new Float32Array(MAX_WALKERS * 3);
            const c = new T.Color();
            paths.slice(0, MAX_WALKERS).forEach((p, i) => {
                path.set(p, i * 4);
                motion.set([wRange(0.7, 1.25), wr(), wr() < 0.78 ? 1 : 0, wr()], i * 4);
                c.set(UMBRELLA[Math.floor(wr() * UMBRELLA.length) % UMBRELLA.length]);
                tint.set([c.r, c.g, c.b], i * 3);
            });
            walkerGeometry.setAttribute('path', new T.InstancedBufferAttribute(path, 4));
            walkerGeometry.setAttribute('motion', new T.InstancedBufferAttribute(motion, 4));
            walkerGeometry.setAttribute('tint', new T.InstancedBufferAttribute(tint, 3));
            walkerGeometry.instanceCount = WALKERS.standard;
        }
        const walkerMat = keep(new T.ShaderMaterial({
            fog: true, side: T.DoubleSide,
            uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, {}]),
            vertexShader: `attribute float part;attribute vec4 path,motion;attribute vec3 tint;
                uniform float time,rain;uniform vec3 hemiSky;
                ${LIGHT_DECL}
                varying vec3 vN,vW,vTint;varying float vPart;
                #include <fog_pars_vertex>
                void main(){
                    vec2 a=path.xy,b=path.zw;float len=max(length(b-a),0.5);
                    float s=fract(time*motion.x/(2.0*len)+motion.y);
                    float u=s<0.5?s*2.0:2.0-2.0*s;
                    vec2 dir=(b-a)/len*(s<0.5?1.0:-1.0);
                    vec2 at=mix(a,b,u);
                    vec3 fw=vec3(dir.x,0.0,dir.y),rt=vec3(dir.y,0.0,-dir.x);
                    float stride=time*motion.x*4.2+motion.w*40.0;
                    vec3 p=position,n=normal;
                    float h=0.94+motion.w*0.12;
                    if(part>0.5&&part<2.5){
                        // Legs swing about the hip.
                        float sw=sin(stride)*(part<1.5?0.42:-0.42);
                        float c=cos(sw),sn=sin(sw);float y=p.y-0.82;
                        p=vec3(p.x,0.82+y*c-p.z*sn,y*sn+p.z*c);
                        n=vec3(n.x,n.y*c-n.z*sn,n.y*sn+n.z*c);
                    }
                    float open=motion.z*smoothstep(0.03,0.15,rain);
                    // Furled when the rain stops: the canopy folds down the shaft.
                    if(part>2.5&&part<3.5){p.xz=mix(vec2(0.14,0.06),p.xz,max(open,0.08));p.y=mix(1.62,p.y,max(open,0.3));}
                    if(part>2.5&&motion.z<0.5)p=vec3(0.0,0.9,0.0);
                    p.y=p.y*h+abs(sin(stride))*0.025;
                    // Never walk through the lens: a figure the camera is about to pass steps out of frame.
                    float clear=smoothstep(0.9,1.7,distance(cameraPosition.xz,at));
                    p.xz*=clear;p.y*=clear;
                    vec3 w=vec3(at.x,0.0,at.y)+rt*p.x+fw*p.z+vec3(0.0,p.y,0.0);
                    vN=normalize(rt*n.x+fw*n.z+vec3(0.0,n.y,0.0));vW=w;vTint=tint;vPart=part;
                    vec4 mvPosition=viewMatrix*vec4(w,1.0);gl_Position=projectionMatrix*mvPosition;
                    #include <fog_vertex>
                }`,
            fragmentShader: `uniform vec3 hemiSky;uniform float wet;
                ${LIGHT_DECL}
                varying vec3 vN,vW,vTint;varying float vPart;
                #include <fog_pars_fragment>
                void main(){
                    vec3 n=normalize(vN);
                    bool canopy=vPart>2.5&&vPart<3.5;
                    vec3 alb=canopy?vTint:vec3(0.035,0.037,0.042);
                    vec3 V=normalize(cameraPosition-vW);
                    vec3 col=alb*hemiSky*0.5;
                    vec3 rim=vec3(0.0);
                    for(int i=0;i<${MAX_LIGHTS};i++){
                        if(i>=uLightCount)break;
                        vec3 d=uLightPos[i]-vW;float l=length(d);
                        float f=max(0.0,1.0-l/uLightRad[i]);f*=f;
                        vec3 L=d/max(l,1e-3);
                        // A canopy glows through from either side; a body only catches its edge.
                        float k=canopy?(abs(dot(n,L))*0.6+0.15):max(dot(n,L),0.0);
                        col+=alb*uLightCol[i]*f*k*(canopy?0.75:1.0);
                        float edge=pow(1.0-abs(dot(n,V)),3.0);
                        rim+=uLightCol[i]*f*edge*max(dot(L,-V)+0.4,0.0);
                    }
                    col+=rim*(canopy?0.15:0.35)*(0.6+0.4*wet);
                    gl_FragColor=vec4(col,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    #include <fog_fragment>
                }`
        }));
        Object.assign(walkerMat.uniforms, { time: shared.time, rain: shared.rain, wet: shared.wetness, hemiSky: shared.hemiSky, ...lightSet });
        const walkers = new T.Mesh(walkerGeometry, walkerMat);
        walkers.name = 'kowloonWalkers'; walkers.frustumCulled = false;
        root.add(walkers);

        /* ------------- rain hitting the ground near the camera ------------- */
        const SPLASHES = 1400;
        const splashGeometry = keep(new T.InstancedBufferGeometry());
        splashGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
        splashGeometry.setIndex([0, 1, 2, 1, 3, 2]);
        {
            const r = mulberry(hash('kowloon-splash'));
            const seed = new Float32Array(SPLASHES * 3);
            for (let i = 0; i < SPLASHES; i++) seed.set([r(), r(), r()], i * 3);
            splashGeometry.setAttribute('seed', new T.InstancedBufferAttribute(seed, 3));
            splashGeometry.instanceCount = 0;
        }
        const splashMat = keep(new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false,
            uniforms: { time: shared.time, centre: { value: new T.Vector3() }, kwSb: shared.sb, ...lightSet,
                shelterBox: shared.shelterBox, shelterY: shared.shelterY },
            vertexShader: `attribute vec3 seed;uniform float time,kwSb;uniform vec3 centre;
                ${LIGHT_DECL}
                ${SHELTER}
                varying vec2 vUv;varying float vLife;varying vec3 vLit;
                void main(){
                    // Sandbox view: spread along the street by the focus, and big enough to see.
                    float BOX=mix(14.0,40.0,kwSb);
                    float cycle=0.55+seed.z*0.5;float t=time/cycle+seed.z*7.0;float n=floor(t);float life=fract(t);
                    // A new spot for every drop.
                    vec2 j=fract(seed.xy+vec2(n*0.6180339,n*0.4142135));
                    vec3 p=vec3(centre.x+(fract((j.x*BOX-centre.x)/BOX)-0.5)*BOX,0.0,centre.z+(fract((j.y*BOX-centre.z)/BOX)-0.5)*BOX);
                    float size=(0.035+0.05*life)*(1.0+kwSb*3.5);
                    vec3 right=normalize(vec3(viewMatrix[0][0],0.0,viewMatrix[2][0]));
                    vec3 w=p+right*position.x*size+vec3(0.0,position.y*size*(1.2-life)*1.4,0.0);
                    vUv=position.xy;vLife=life;
                    vec3 lit=vec3(0.05,0.06,0.08);
                    for(int i=0;i<${MAX_LIGHTS};i++){if(i>=uLightCount)break;float f=max(0.0,1.0-length(uLightPos[i]-p)/uLightRad[i]);lit+=uLightCol[i]*f*f;}
                    vLit=lit*(1.0-kSheltered(p))*mix(1.0-smoothstep(4.0,7.0,distance(cameraPosition,p)),step(${streets.south[0].toFixed(1)},p.z)*1.6,kwSb);
                    gl_Position=projectionMatrix*viewMatrix*vec4(w,1.0);
                    if(life>0.35)gl_Position=vec4(2.0,2.0,2.0,1.0);
                }`,
            fragmentShader: `varying vec2 vUv;varying float vLife;varying vec3 vLit;
                void main(){
                    // A small crown: two arcs thrown up and out.
                    float x=abs(vUv.x);float arc=1.0-smoothstep(0.0,0.25,abs(vUv.y-(1.0-x*x)*0.9));
                    float a=arc*(1.0-vLife/0.35)*0.5;
                    if(a<0.01)discard;
                    gl_FragColor=vec4(vLit*a,1.0);
                }`
        }));
        const splashes = new T.Mesh(splashGeometry, splashMat);
        splashes.name = 'kowloonSplashes'; splashes.frustumCulled = false; splashes.renderOrder = 5;
        splashes.layers.set(LAYER_VIEW_ONLY);
        root.add(splashes);

        /* ------------- write out the static pools ------------- */
        props.forEach(p => p.build());
        let wires = null, laundry = null;
        const vertexLit = (positions, colors, index, name, double) => {
            const geometry = keep(new T.BufferGeometry());
            geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
            geometry.setIndex(index);
            const mat = keep(new T.ShaderMaterial({
                fog: true, side: double ? T.DoubleSide : T.FrontSide,
                uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, {}]),
                vertexShader: `uniform vec3 uLightPos[${MAX_LIGHTS}];uniform vec3 uLightCol[${MAX_LIGHTS}];uniform float uLightRad[${MAX_LIGHTS}];uniform int uLightCount;
                    uniform vec3 hemiSky;uniform float wetness;attribute vec3 color;varying vec3 vCol;
                    #include <fog_pars_vertex>
                    void main(){
                        vec4 w=modelMatrix*vec4(position,1.0);
                        vec3 lit=hemiSky*0.5;
                        for(int i=0;i<${MAX_LIGHTS};i++){if(i>=uLightCount)break;float f=max(0.0,1.0-length(uLightPos[i]-w.xyz)/uLightRad[i]);
                            lit+=uLightCol[i]*f*f;}
                        vCol=color*(1.0-0.3*wetness)*lit;
                        vec4 mvPosition=viewMatrix*w;gl_Position=projectionMatrix*mvPosition;
                        #include <fog_vertex>
                    }`,
                fragmentShader: `varying vec3 vCol;
                    #include <fog_pars_fragment>
                    void main(){gl_FragColor=vec4(vCol,1.0);
                        #include <tonemapping_fragment>
                        #include <colorspace_fragment>
                        #include <fog_fragment>
                    }`
            }));
            Object.assign(mat.uniforms, { ...lightSet, hemiSky: shared.hemiSky, wetness: shared.wetness });
            const mesh = new T.Mesh(geometry, mat);
            mesh.name = name;
            root.add(mesh);
            return mesh;
        };
        if (wireIndex.length) wires = vertexLit(wirePositions, wireColors, wireIndex, 'kowloonCables', true);
        if (garmentIndex.length) laundry = vertexLit(garmentPositions, garmentColors, garmentIndex, 'kowloonLaundry', true);

        /* ------------- camera paths inside the alleys ------------- */
        // Short runs at walking pace (a shot lasts a lyric line or a gap, 5-12 s),
        // chosen where there is something to see: under a covered stretch, at a
        // crossing, where the floor holds water. Points and look targets pair up.
        const rigs = [];
        {
            const alleys = layout.ALLEYS || [];
            const byId = id => alleys.find(a => a.id === id);
            const along = (a, s, lateral = 0, y = 1.6) => a.axis === 'x' ? [s, y, a.c + lateral] : [a.c + lateral, y, s];
            const run = (id, a, s0, s1, opts = {}) => {
                const n = 10, points = [], look = [];
                const dir = Math.sign(s1 - s0) || 1;
                for (let i = 0; i <= n; i++) {
                    const t = i / n;
                    const s = mix(s0, s1, t);
                    const y = typeof opts.y === 'function' ? opts.y(t) : opts.y ?? 1.6;
                    const sway = Math.sin(t * Math.PI * 1.3 + s0) * Math.min(0.18, a.w * 0.06);
                    points.push(along(a, s, sway, y));
                    const lift = typeof opts.lift === 'function' ? opts.lift(t) : opts.lift ?? 0.5;
                    look.push(along(a, s + dir * (opts.ahead ?? 8), sway * 0.5, y + lift));
                }
                rigs.push({ id, points, look, fov: opts.fov ?? 58, phase: opts.phase || 'verse', duration: opts.duration ?? 10 });
            };
            const A = byId('A') || alleys[0], B = byId('B') || alleys[1];
            const covered = bridges.filter(b => b.alley === A?.id || b.alley === B?.id);
            // Through a covered stretch of a main alley, tubes overhead: the one nearest the
            // middle of the block, walking in towards the centre, with a lamp where it starts.
            const centreOf = b => Math.hypot((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
            const under = covered.slice().sort((p, q) => centreOf(p) - centreOf(q))[0];
            if (under) {
                const a = byId(under.alley);
                const mid = a.axis === 'x' ? (under.x0 + under.x1) / 2 : (under.z0 + under.z1) / 2;
                const inward = mid > 0 ? -1 : 1;
                const s0 = mid - inward * 9, s1 = mid + inward * 7;
                for (const [s, side] of [[s0 + inward * 1.5, 1], [mid, -1], [s1 - inward * 2, 1]]) {
                    const p = along(a, s, side * (a.w / 2 - 0.12), 2.75);
                    const yaw = a.axis === 'x' ? 0 : Math.PI / 2;
                    const tone = side > 0 ? LAMP_TONES[0] : LAMP_TONES[2];
                    boxes.add(p, [1.1, 0.05, 0.06], yaw, 5, new T.Color(tone[0], tone[1], tone[2]));
                    lamp([p[0], p[1] - 0.1, p[2]], tone, 1.1, 5.5);
                }
                boxes.build();
                run('alley-under', a, s0, s1, { lift: 0.3, phase: 'verse', duration: 10 });
            }
            if (A) {
                run('alley-walk', A, -34, -18, { lift: t => 0.4 + 0.8 * Math.sin(t * Math.PI), phase: 'verse', duration: 10 });
                // Low over the water, so what hangs overhead is seen again in it.
                run('alley-puddle', A, 22, 12, { y: 0.45, lift: 1.4, fov: 62, phase: 'interlude', duration: 10 });
                // The long take: a hand's breadth over the water, steadily on for sixteen metres,
                // the alley's screen and tubes sliding past in the puddles.
                run('alley-glide', A, -10, 6, { y: t => 0.36 + 0.08 * t, lift: t => 1.0 + 0.4 * t, ahead: 9, fov: 60, phase: 'prechorus', duration: 12 });
            }
            if (B) run('alley-cross', B, 38, 24, { lift: 0.6, phase: 'prechorus', duration: 9 });
            // A narrow side alley, dim and close.
            const side = byId('N') || alleys.find(a => a.w < 2);
            if (side) run('alley-narrow', side, -8, 4, { fov: 62, lift: 0.3, phase: 'verse', duration: 9 });
            // Rising out of the main crossing, looking up through the cables.
            if (A && B) {
                const x = B.c, z = A.c, points = [], look = [];
                for (let i = 0; i <= 12; i++) {
                    const t = i / 12, e = t * t * (3 - 2 * t);
                    points.push([x + 0.3, mix(1.6, 24, e), z + 0.3 - e * 0.6]);
                    look.push([x + 6 - e * 4, mix(5, 40, e), z - 2 + e * 1.5]);
                }
                rigs.push({ id: 'alley-rise', points, look, fov: 64, phase: 'chorus', duration: 10 });
            }
            // From the street, through the gate and the market, into the main north-south alley.
            if (B && B.axis === 'z') {
                const points = [], look = [];
                const z0 = streets.south[0] + 9.5, z1 = streets.south[0] - 12;
                for (let i = 0; i <= 14; i++) {
                    const t = i / 14;
                    const z = mix(z0, z1, t);
                    const bob = Math.sin(t * Math.PI * 9) * 0.025;
                    points.push([B.c + 2.2 * (1 - smooth(0, 0.5, t)), 1.72 + bob, z]);
                    // Up at the gate's plaque on the way in, down to eye level once under the tarps.
                    const up = 1 - smooth(0.25, 0.6, t);
                    look.push([B.c + 0.6 * (1 - smooth(0, 0.5, t)), mix(1.9, 4.2, up), z - mix(8, 14, up)]);
                }
                rigs.push({ id: 'street-enter', points, look, fov: 56, phase: 'prechorus', duration: 12 });
            }
        }

        /* ------------- per-frame ------------- */
        let rainLevel = RAIN_LEVELS[options.rain] ?? RAIN_LEVELS.light, rainClock = 0;
        const own = new T.Vector3();
        const scratchColor = new T.Color();
        const ownSorted = lamps.map(l => ({ lamp: l, d: 0 }));
        const lightList = [];
        const flickerOf = (l, time) => {
            if (!l.flicker) return 1;
            // A dying tube: mostly on, now and then a stutter.
            const t = time * 1.3 + l.seed * 50;
            const stutter = Math.sin(t) * Math.sin(t * 7.3) > 0.55;
            return stutter ? (Math.sin(time * 60) > 0 ? 0.15 : 0.6) : 1;
        };
        let lastTime = 0;
        const gather = (state, camera) => {
            const cp = camera?.position || own.set(0, 1.7, 0);
            let n = lightUniforms.uLightCount.value | 0;
            if (!lu) {
                // On its own (tests): the signs handed in, then the nearest own lamps.
                lightList.length = 0;
                const signs = state?.signLights || [];
                for (let i = 0; i < signs.length && lightList.length < SIGN_SLOTS; i++) {
                    const l = signs[i];
                    lightList.push({ position: l.position, color: l.color, intensity: l.intensity ?? 1, radius: l.radius ?? 8 });
                }
                ownSorted.forEach(entry => {
                    const p = entry.lamp.position;
                    entry.d = (p[0] - cp.x) ** 2 + (p[1] - cp.y) ** 2 + (p[2] - cp.z) ** 2;
                });
                ownSorted.sort((a, b) => a.d - b.d);
                for (let i = 0; i < ownSorted.length && lightList.length < MAX_LIGHTS; i++) {
                    const l = ownSorted[i].lamp;
                    lightList.push({ position: l.position, color: l.color, intensity: l.intensity * flickerOf(l, state.time || 0), radius: l.radius });
                }
                lightList.forEach((l, i) => {
                    lightUniforms.uLightPos.value[i].set(l.position[0], l.position[1], l.position[2]);
                    lightUniforms.uLightCol.value[i].set(l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity);
                    lightUniforms.uLightRad.value[i] = l.radius;
                });
                n = lightList.length;
                lightUniforms.uLightCount.value = n;
            }
            haloGeometry.instanceCount = MAX_LIGHTS;
            // The covered stretches nearest the camera.
            shelterOrder.forEach(e => {
                const b = e.b;
                const dx = Math.max(b.x0 - cp.x, 0, cp.x - b.x1), dz = Math.max(b.z0 - cp.z, 0, cp.z - b.z1);
                e.d = dx * dx + dz * dz;
            });
            shelterOrder.sort((a, b) => a.d - b.d);
            for (let i = 0; i < MAX_SHELTERS; i++) {
                const b = shelterOrder[i]?.b;
                if (b) { shared.shelterBox.value[i].set(b.x0, b.z0, b.x1, b.z1); shared.shelterY.value[i] = b.y0; }
                else { shared.shelterBox.value[i].set(0, 0, -1, -1); shared.shelterY.value[i] = -1; }
            }
        };
        const shelterOrder = bridges.map(b => ({ b, d: 0 }));

        let mirrorLive = false;
        const mirrorDir = new T.Vector3();
        const mirrorUp = new T.Vector3(0, 1, 0);
        const mirrorPlane = new T.Plane();
        const mirrorClip = new T.Vector4();
        const mirrorQ = new T.Vector4();
        const mirrorSize = new T.Vector2();
        const renderMirror = camera => {
            const renderer = ctx.renderer;
            mirrorLive = Boolean(renderer && reflectionOn && camera && camera.position.y < 28);
            floorMat.uniforms.reflectOn.value = mirrorLive ? 1 : 0;
            // From high up the puddles are a few pixels each: the sky and the lamp streaks do.
            if (!mirrorLive) return;
            camera.updateMatrixWorld();
            mirror.position.copy(camera.position);
            mirror.position.y = -mirror.position.y;
            const direction = camera.getWorldDirection(mirrorDir);
            direction.y *= -1;
            mirror.up.set(0, 1, 0).transformDirection(camera.matrixWorld);
            mirror.up.y *= -1;
            mirror.lookAt(direction.add(mirror.position));
            mirror.near = camera.near; mirror.far = camera.far;
            mirror.projectionMatrix.copy(camera.projectionMatrix);
            mirror.updateMatrixWorld();
            mirror.matrixWorldInverse.copy(mirror.matrixWorld).invert();
            textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
                .multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
            // Clip what is under the floor with an oblique near plane.
            mirrorPlane.set(mirrorUp, 0).applyMatrix4(mirror.matrixWorldInverse);
            mirrorClip.set(mirrorPlane.normal.x, mirrorPlane.normal.y, mirrorPlane.normal.z, mirrorPlane.constant);
            const e = mirror.projectionMatrix.elements;
            mirrorQ.set((Math.sign(mirrorClip.x) + e[8]) / e[0], (Math.sign(mirrorClip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
            const dot = mirrorClip.dot(mirrorQ);
            if (Math.abs(dot) < 1e-5) return;
            mirrorClip.multiplyScalar(2 / dot);
            e[2] = mirrorClip.x; e[6] = mirrorClip.y; e[10] = mirrorClip.z + 1 - 0.001; e[14] = mirrorClip.w;
            mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
            // Whatever else the viewer's camera sees (other modules' layers), less the floor and the rain.
            mirror.layers.mask = camera.layers.mask;
            mirror.layers.disable(LAYER_VIEW_ONLY);
            mirror.layers.disable(LAYER_FLOOR);
            const size = renderer.getSize(mirrorSize);
            const buffer = size.x * renderer.getPixelRatio();
            const width = Math.max(64, Math.round(Math.min(buffer * (tierName === 'ultimate' ? 0.5 : 0.4), tierName === 'ultimate' ? 1280 : 640)));
            const height = Math.max(1, Math.round(width * size.y / Math.max(1, size.x)));
            if (target.width !== width || target.height !== height) target.setSize(width, height);
            const oldTarget = renderer.getRenderTarget();
            const oldAutoClear = renderer.autoClear;
            try {
                renderer.autoClear = true;
                renderer.setRenderTarget(target);
                renderer.render(scene, mirror);
            } finally {
                renderer.setRenderTarget(oldTarget);
                renderer.autoClear = oldAutoClear;
            }
        };

        const baseSky = new T.Color(), flashSky = new T.Color('#aab4e0'), fogBase = new T.Color();
        const hazeMidBase = new T.Color(), hazeHighBase = new T.Color(), hazeLowBase = new T.Color();
        const applyAtmosphere = () => {
            const light = Boolean(palette.light);
            shared.day.value = light ? 1 : 0;
            const accent = new T.Color(palette.accent || '#f2a900');
            const deep = new T.Color(palette.deep || '#171a1d');
            // Night: blue-black on the ground, amber smog above the roofs. The low haze takes a
            // little of the theme's own colour, never its saturation.
            const hazeColor = light ? new T.Color('#9aa3aa') : new T.Color('#0f141d').lerp(deep, 0.15);
            hazeColor.lerp(accent, light ? 0.03 : 0.02);
            haze.kwHazeLow.value.copy(hazeColor);
            hazeLowBase.copy(hazeColor);
            haze.kwHazeMid.value.set(light ? '#a8a49c' : '#3a2716');
            haze.kwHazeHigh.value.set(light ? '#c8b89c' : '#a8682a');
            // Where the sky meets the roofs it is the smog's own colour.
            const horizon = light ? new T.Color('#a8aeb2') : new T.Color('#5c3816');
            skyMat.uniforms.haze.value.copy(horizon);
            skyMat.uniforms.zenith.value.set(light ? '#5a6670' : '#06070b');
            skyMat.uniforms.glowA.value.set(light ? '#606a72' : '#2e1a0c');
            skyMat.uniforms.glowB.value.set(light ? '#7a7c7a' : '#5a3212');
            hemi.color.set(light ? '#b8c2cc' : '#1c2c48');
            hemi.groundColor.set(light ? '#7a7570' : '#141826');
            hemi.intensity = light ? 1.4 : 0.55;
            shared.hemiSky.value.copy(hemi.color).multiplyScalar(light ? 0.9 : 0.6);
            shared.hemiGround.value.copy(hemi.groundColor).multiplyScalar(light ? 0.8 : 0.6);
            dayDim = light ? 0.5 : 1;
            if (scene.background?.isColor) scene.background.copy(horizon);
            else scene.background = horizon.clone();
            // scene.fog.color is what the far skyline fades into on its own: the lit smog, never
            // darker than the sky's horizon. Everything else on the stage takes the layered haze.
            fogBase.copy(options.heightFog === false ? hazeColor : horizon);
            fog.color.copy(fogBase);
            hazeMidBase.copy(haze.kwHazeMid.value);
            hazeHighBase.copy(haze.kwHazeHigh.value);
            baseSky.set(light ? '#8e9aa6' : '#1e2a42');
            if (lu) {
                lu.uSky.value.copy(baseSky);
                lu.uGround.value.set(light ? '#6e6762' : '#1c1a20');
                lu.uGlow.value.set(light ? '#d0a080' : '#ffa040');
            }
            shared.glowTint.value.set(light ? '#000000' : '#ffa040').multiplyScalar(light ? 0 : 0.18);
        };
        let dayDim = 1;
        applyAtmosphere();

        const updateRain = (state, camera, real = camera) => {
            const opt = state.options || options;
            const wanted = RAIN_LEVELS[opt.rain ?? options.rain] ?? RAIN_LEVELS.light;
            const now = (global.performance?.now?.() ?? Date.now()) / 1000;
            if (!rainClock) rainLevel = wanted;
            const step = clamp(now - (rainClock || now), 0, 0.25) * 0.4;
            rainClock = now;
            rainLevel += Math.max(-step, Math.min(step, wanted - rainLevel));
            shared.rain.value = rainLevel;
            // It has rained all evening: the floor is wet even when it stops.
            shared.wetness.value = Number.isFinite(options.wetness) ? clamp(options.wetness) : 0.55 + 0.45 * rainLevel;
            const share = tierName === 'energy-saving' ? 0.5 : 1;
            const count = Math.min(RAIN_MAX, Math.round((RAIN_COUNTS[tierName] ?? RAIN_COUNTS.standard) * rainLevel * share * (shared.sb.value ? 1.6 : 1)));
            rain.visible = count > 0;
            rainGeometry.setDrawRange(0, count * 6);
            splashGeometry.instanceCount = Math.round(SPLASHES * rainLevel * share * (tierName === 'ultimate' ? 1 : 0.7));
            splashes.visible = splashGeometry.instanceCount > 0 && (camera ? camera.position.y < 12 : true);
            if (camera) splashMat.uniforms.centre.value.copy(camera.position);
            coneMat.uniforms.haze.value = (0.5 + rainLevel * 0.9) * (camera ? 1 - smooth(10, 50, camera.position.y) * 0.7 : 1);
            if (camera) rainMat.uniforms.centre.value.copy(camera.position);
            // Thick between the walls, thin enough from above that the whole block still reads.
            const height = real ? real.position.y : 2;
            const near = 1 - smooth(4, 48, height);
            if (options.heightFog === false) {
                fog.density = (0.0045 + 0.017 * near) * (1 + rainLevel * 0.45) * (palette.light ? 0.7 : 1) * (options.fog ?? 1);
            } else {
                // The height model does most of the work; the ground layer still thins as the
                // camera climbs, so the whole block reads from above.
                fog.density = 0.0105 * (1 + rainLevel * 0.45) * (palette.light ? 0.7 : 1) * (options.fog ?? 1);
                const shape = haze.kwHazeShape.value;
                shape.x = 1.6 * (0.35 + 0.65 * near);
                shape.z = 0.28 * (1 + rainLevel * 0.3);
                shape.w = 0.45 * (options.smog ?? 1) * (palette.light ? 0.4 : 1);
            }
            haze.kwHazeDensity.value = fog.density;
            if (lu) {
                lu.uRain.value = rainLevel;
                lu.uWet.value = shared.wetness.value;
                // Rain scatters the street's light up the walls.
                lu.uGlowStrength.value = (palette.light ? 0.1 : 0.32) * (1 + rainLevel * 0.25);
            }
            haloMat.uniforms.haze.value = 0.45 + rainLevel * 0.8;
        };

        /* ------------- lightning at the top of each chorus ------------- */
        // Two strikes, the second a little weaker, gone within about a second.
        let strikeTimes = [], strikeSource = null, lastChorus = false, liveStrike = -1e9;
        const strikeAt = since => since < 0 || since > 1.4 ? 0 : Math.min(1,
            Math.exp(-((since - 0.04) ** 2) / 0.0025) + 0.7 * Math.exp(-((since - 0.27) ** 2) / 0.0042) + 0.22 * Math.exp(-since * 3.2));
        const updateLightning = state => {
            const t = Number.isFinite(state.playbackTime) ? state.playbackTime : state.time || 0;
            let since = Infinity, start = 0;
            if (Array.isArray(state.lines) && state.lines.length) {
                if (state.lines !== strikeSource) {
                    strikeSource = state.lines;
                    strikeTimes = state.lines.filter((line, i) => line?.isChorus && !state.lines[i - 1]?.isChorus)
                        .map(line => line.startTime).filter(Number.isFinite);
                }
                for (let i = strikeTimes.length - 1; i >= 0; i--) {
                    if (strikeTimes[i] <= t) { since = t - strikeTimes[i]; start = strikeTimes[i]; break; }
                }
            } else {
                const chorus = Boolean(state.lyric?.isChorus);
                if (chorus && !lastChorus) liveStrike = state.lyric?.start ?? t;
                lastChorus = chorus;
                since = t - liveStrike; start = liveStrike;
            }
            const opt = state.options || options;
            const allowed = opt.lightning !== false && !opt.reducedMotion;
            const value = allowed ? strikeAt(since) * (palette.light ? 0.35 : 1) : 0;
            shared.flash.value = value;
            if (value > 0) {
                // Each strike lights a different part of the deck.
                const h = hash(`strike:${start.toFixed(2)}`);
                skyMat.uniforms.flashAt.value.set(((h & 1023) / 1023 - 0.5) * 3, (((h >> 10) & 1023) / 1023 - 0.7) * 2);
            }
            if (lu) {
                lu.uSky.value.copy(baseSky).lerp(flashSky, value * 0.8).multiplyScalar(1 + value * 1.6);
            }
            fog.color.copy(fogBase).lerp(flashSky, value * 0.25);
            haze.kwHazeLow.value.copy(hazeLowBase).lerp(flashSky, value * 0.25);
            haze.kwHazeMid.value.copy(hazeMidBase).lerp(flashSky, value * 0.3);
            haze.kwHazeHigh.value.copy(hazeHighBase).lerp(flashSky, value * 0.35).multiplyScalar(1 + value * 0.8);
        };

        const update = (state = {}) => {
            const real = state.camera || ctx.camera;
            const time = Number.isFinite(state.time) ? state.time : 0;
            shared.time.value = time;
            lastTime = time;
            // Sandbox view: the camera is hundreds of metres off, so what follows the viewer
            // (drips, splashes, light cones, the covered stretches) gathers on the street by
            // the focus instead, and the rain fills the cut block.
            const box = state.sandbox || null;
            shared.sb.value = box ? 1 : 0;
            let camera = real;
            if (box) {
                shared.sbBox.value.set(box.x0, box.x1, box.z0, box.z1);
                const f = state.focus || [(box.x0 + box.x1) / 2, 0, (box.z0 + box.z1) / 2];
                anchor.position.set(clamp(f[0], box.x0 + 8, box.x1 - 8), 1.7, clamp(streets.south[0] + 4, box.z0, box.z1));
                camera = anchor;
            }
            if (camera) shared.eye.value.copy(camera.position);
            gather(state, camera);
            hazeScan(false);
            updateRain(state, camera, real);
            // Detail that only shows from inside the alleys.
            const far = state.shot === 'iso' || state.shot === 'roof';
            drips.visible = !far;
            if (!far) placeDrips(camera);
            if (laundry) laundry.visible = true;
            updateLightning(state);
            cones.visible = !far;
            if (!far) placeCones(camera);
            steam.visible = !far && steamSources.length > 0;
            renderMirror(real);
        };
        const anchor = { position: new T.Vector3() };

        const setTier = tier => {
            tierName = (typeof tier === 'string' ? tier : tier?.name) || 'standard';
            walkerGeometry.instanceCount = WALKERS[tierName] ?? WALKERS.standard;
            reflectionOn = tierName !== 'energy-saving' && options.reflections !== false;
        };
        setTier(ctx.tier || tierName);

        const stats = () => {
            const meshes = [];
            root.traverse(o => { if (o.isMesh && o.visible) meshes.push(o); });
            let triangles = 0;
            meshes.forEach(m => {
                const g = m.geometry;
                const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
                const range = Number.isFinite(g.drawRange.count) ? Math.min(tris, g.drawRange.count / 3) : tris;
                triangles += range * (m.isInstancedMesh ? m.count : g.isInstancedBufferGeometry ? g.instanceCount : 1);
            });
            return {
                alleyDrawCalls: meshes.length, alleyTriangles: Math.round(triangles),
                reflection: mirrorLive ? [target.width, target.height] : null,
                rain: rainLevel, rainStreaks: rain.visible ? rainGeometry.drawRange.count / 6 : 0,
                lamps: lamps.length, lightsUsed: lightUniforms.uLightCount.value, drips: DRIPS,
                cables: cableCount, garments: laundryCount,
                instances: Object.fromEntries(props.map(p => [p.mesh.name, p.count])),
                fogDensity: fog.density, walkers: walkerGeometry.instanceCount, rigs: rigs.map(r => r.id)
            };
        };

        const lampLights = lamps.map(l => ({
            position: l.position, color: l.color, intensity: l.intensity,
            radius: l.radius, flicker: l.flicker, flickerValue: 1
        }));
        const api = {
            update,
            setPalette(p) { palette = p || {}; applyAtmosphere(); },
            setTier,
            setOptions(o) { options = { ...options, ...(o || {}) }; setTier(tierName); },
            // The alley's own lamps, for anything else that wants their light.
            lights: () => {
                for (let i = 0; i < lamps.length; i += 1) {
                    const l = lamps[i];
                    const dst = lampLights[i];
                    dst.intensity = l.intensity * dayDim;
                    dst.flickerValue = flickerOf(l, lastTime);
                }
                return lampLights;
            },
            cameraRigs: () => rigs.map(r => ({ id: r.id, points: r.points.map(p => p.slice()), look: r.look.map(p => p.slice()), fov: r.fov,
                phase: r.phase, duration: r.duration })),
            layers: { viewOnly: LAYER_VIEW_ONLY, floor: LAYER_FLOOR },
            // Lightning brightness now, 0..1 (0 when no strike), for anything that flashes with it.
            flash: () => shared.flash.value,
            stats,
            dispose() {
                if (scene.fog === fog) scene.fog = null;
                scene.remove(root);
                disposables.forEach(d => d.dispose?.());
                if (lastInstance === api) lastInstance = null;
            },
            // For the screenshot script: the scene and this module's own group.
            debug: () => ({ scene, root, options, tierName, renderer: ctx.renderer })
        };
        lastInstance = api;
        return api;
    };
    let lastInstance = null;

    global.MusicStageKowloonAlley = Object.freeze({ create, debugInstance: () => lastInstance });
})(typeof window !== 'undefined' ? window : globalThis);
