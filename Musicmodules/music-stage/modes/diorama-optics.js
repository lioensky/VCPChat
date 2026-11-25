(function (global) {
    'use strict';
    /*
     * The diorama's lens. The scene is drawn into a floating-point target, the
     * light above a threshold is spread through a chain of ever smaller
     * buffers and added back, and the result is graded, vignetted and grained.
     * The glow is what makes a lamp a light instead of a yellow box.
     */
    const LEVELS = 4;
    // Whether the lens draws for these settings; when it does not, the scene
    // goes straight to the canvas, which then needs its own antialiasing.
    const active = (config, lens) => {
        const tuning = lens || config.modes?.diorama || {};
        return tuning.postProcess !== false && global.MusicStageModeUtils?.tier(config.quality).lens !== false;
    };
    const create = (T) => {
        const target = new T.WebGLRenderTarget(1, 1, {
            type: T.HalfFloatType, depthBuffer: true,
            // The scene is drawn into this target, so the canvas's own antialiasing never applies.
            // The tier sets the sample count on the first frame.
            samples: 4
        });
        const chain = Array.from({ length: LEVELS }, () => new T.WebGLRenderTarget(1, 1, {
            type: T.HalfFloatType, depthBuffer: false,
            minFilter: T.LinearFilter, magFilter: T.LinearFilter
        }));
        const scene = new T.Scene();
        const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const geometry = new T.PlaneGeometry(2, 2);
        const vertexShader = `varying vec2 uvScreen;
            void main(){uvScreen=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;
        const pass = (fragmentShader, uniforms, extra = {}) => new T.ShaderMaterial({
            depthTest: false, depthWrite: false, vertexShader, fragmentShader, uniforms, ...extra
        });
        // First step down: keep only what is brighter than the threshold, with a soft knee.
        const prefilter = pass(`uniform sampler2D image;uniform vec2 texel;uniform float threshold;
            varying vec2 uvScreen;
            vec3 tap(vec2 o){vec3 c=texture2D(image,uvScreen+o*texel).rgb;
                // A NaN or negative pixel from any material must not bloom into a blot.
                c=mix(vec3(0.0),min(c,vec3(24.0)),vec3(greaterThanEqual(c,vec3(0.0))));
                float l=max(c.r,max(c.g,c.b));
                float soft=clamp(l-threshold+0.35,0.0,0.7);soft=soft*soft/1.4;
                return c*max(soft,l-threshold)/max(l,0.0001);}
            void main(){
                gl_FragColor=vec4((tap(vec2(-1.0,-1.0))+tap(vec2(1.0,-1.0))
                    +tap(vec2(-1.0,1.0))+tap(vec2(1.0,1.0)))*0.25,1.0);
            }`, { image: { value: null }, texel: { value: new T.Vector2() }, threshold: { value: 0.82 } });
        const down = pass(`uniform sampler2D image;uniform vec2 texel;varying vec2 uvScreen;
            void main(){
                vec3 c=texture2D(image,uvScreen).rgb*4.0;
                c+=texture2D(image,uvScreen+texel*vec2(-1.0,-1.0)).rgb;
                c+=texture2D(image,uvScreen+texel*vec2(1.0,-1.0)).rgb;
                c+=texture2D(image,uvScreen+texel*vec2(-1.0,1.0)).rgb;
                c+=texture2D(image,uvScreen+texel*vec2(1.0,1.0)).rgb;
                gl_FragColor=vec4(c*0.125,1.0);
            }`, { image: { value: null }, texel: { value: new T.Vector2() } });
        // Each step up is added onto the sharper level below it.
        const up = pass(`uniform sampler2D image;uniform vec2 texel;uniform float weight;varying vec2 uvScreen;
            void main(){
                vec3 c=texture2D(image,uvScreen+texel*vec2(-2.0,0.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(2.0,0.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(0.0,-2.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(0.0,2.0)).rgb;
                c+=(texture2D(image,uvScreen+texel*vec2(-1.0,-1.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(1.0,-1.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(-1.0,1.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(1.0,1.0)).rgb)*2.0;
                gl_FragColor=vec4(c/12.0*weight,1.0);
            }`, { image: { value: null }, texel: { value: new T.Vector2() }, weight: { value: 1 } },
        { blending: T.AdditiveBlending, transparent: true });
        // Without multisampling the edges are smoothed here instead, on the
        // pass that reads every pixel anyway: a few taps along the local edge.
        const material = pass(`uniform sampler2D image,glowMap;
            uniform float time,grain,vignette,bloom,smoothing,grade,cabin;uniform vec2 texel;varying vec2 uvScreen;
            float luma(vec3 c){c=c/(1.0+c);return dot(c,vec3(0.299,0.587,0.114));}
            vec3 smoothed(vec2 uv){
                vec3 m=texture2D(image,uv).rgb;
                if(smoothing<0.5)return m;
                float lNW=luma(texture2D(image,uv+texel*vec2(-1.0,-1.0)).rgb);
                float lNE=luma(texture2D(image,uv+texel*vec2(1.0,-1.0)).rgb);
                float lSW=luma(texture2D(image,uv+texel*vec2(-1.0,1.0)).rgb);
                float lSE=luma(texture2D(image,uv+texel*vec2(1.0,1.0)).rgb);
                float lM=luma(m);
                float lMin=min(lM,min(min(lNW,lNE),min(lSW,lSE)));
                float lMax=max(lM,max(max(lNW,lNE),max(lSW,lSE)));
                if(lMax-lMin<max(0.03,lMax*0.12))return m;
                vec2 dir=vec2(-((lNW+lNE)-(lSW+lSE)),(lNW+lSW)-(lNE+lSE));
                float reduce=max((lNW+lNE+lSW+lSE)*0.03125,1.0/128.0);
                dir=clamp(dir/(min(abs(dir.x),abs(dir.y))+reduce),-8.0,8.0)*texel;
                vec3 a=0.5*(texture2D(image,uv-dir/6.0).rgb+texture2D(image,uv+dir/6.0).rgb);
                vec3 b=0.5*a+0.25*(texture2D(image,uv-dir*0.5).rgb+texture2D(image,uv+dir*0.5).rgb);
                float lB=luma(b);
                return lB<lMin||lB>lMax?a:b;
            }
            void main(){
                vec3 color=smoothed(uvScreen);
                color=mix(vec3(0.0),color,vec3(greaterThanEqual(color,vec3(0.0))));
                color+=texture2D(glowMap,uvScreen).rgb*bloom;
                vec2 p=uvScreen*2.0-1.0;
                color*=1.0-(vignette+cabin*0.3)*smoothstep(0.2,1.7,dot(p,p))*0.6;
                // In the saloon: colour settles towards warm white, and what the
                // ceiling strips do not reach falls into real shadow.
                float cl=dot(color,vec3(0.2126,0.7152,0.0722));
                vec3 settled=mix(vec3(cl),color,0.82)*vec3(1.0,0.98,0.92);
                settled*=0.5+0.5*smoothstep(0.0,0.5,cl);
                color=mix(color,settled,cabin);
                // Grade, as film stock does: shadows a little cool, lights a little
                // warm, a touch more colour, and a black that is lifted and tinted
                // rather than empty.
                float l=dot(color,vec3(0.2126,0.7152,0.0722));
                float lit=smoothstep(0.015,0.7,l);
                vec3 graded=color*mix(vec3(0.93,0.99,1.07),vec3(1.06,1.0,0.92),lit);
                graded=max(mix(vec3(l),graded,1.14),0.0)+vec3(0.0012,0.002,0.0035)*(1.0-lit);
                color=mix(color,graded,grade);
                gl_FragColor=vec4(color,1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
                float n=fract(sin(dot(gl_FragCoord.xy+floor(time*24.0),
                    vec2(12.9898,78.233)))*43758.5453)-0.5;
                gl_FragColor.rgb=clamp(gl_FragColor.rgb+n*grain*0.08,0.0,1.0);
            }`, {
            image: { value: target.texture }, glowMap: { value: chain[0].texture },
            time: { value: 0 }, grain: { value: 0.08 }, vignette: { value: 0.22 }, bloom: { value: 0.6 },
            smoothing: { value: 0 }, texel: { value: new T.Vector2() }, grade: { value: 1 }, cabin: { value: 0 }
        });
        const quad = new T.Mesh(geometry, material);
        scene.add(quad);
        const draw = (renderer, shader, source, destination, texelOf) => {
            shader.uniforms.image.value = source.texture;
            shader.uniforms.texel.value.set(1 / texelOf.width, 1 / texelOf.height);
            quad.material = shader;
            renderer.setRenderTarget(destination);
            renderer.render(scene, camera);
        };
        let dead = false;
        return {
            active,
            // The diorama's own settings unless another mode passes its own.
            render(renderer, world, worldCamera, time, config, lens) {
                if (dead) return;
                if (!active(config, lens)) {
                    renderer.render(world, worldCamera);
                    return;
                }
                const tuning = lens || config.modes?.diorama || {};
                // Multisampling a half-float target is the largest single cost of
                // the lens on an integrated GPU; only the top tier pays for it.
                const samples = global.MusicStageModeUtils?.tier(config.quality).samples ?? 4;
                if (target.samples !== samples) {
                    target.samples = samples;
                    target.dispose();
                }
                material.uniforms.smoothing.value = samples ? 0 : 1;
                const size = renderer.getDrawingBufferSize(new T.Vector2());
                material.uniforms.texel.value.set(1 / size.x, 1 / size.y);
                if (target.width !== size.x || target.height !== size.y) {
                    target.setSize(size.x, size.y);
                    chain.forEach((level, index) => level.setSize(
                        Math.max(2, Math.round(size.x / 2 ** (index + 1))),
                        Math.max(2, Math.round(size.y / 2 ** (index + 1)))));
                }
                material.uniforms.time.value = time;
                material.uniforms.grain.value = tuning.grain ?? 0.08;
                material.uniforms.vignette.value = tuning.vignette ?? 0.22;
                // In the saloon the ceiling strips bloom over the cream panels round them.
                const cabin = Math.min(1, Math.max(0, tuning.cabin || 0));
                material.uniforms.cabin.value = cabin;
                material.uniforms.bloom.value = (tuning.glow ?? 1) * 0.6 * (1 + cabin * 0.9);
                const threshold = tuning.threshold ?? 0.82;
                // By day the walls are near the paper's white, so only the strips themselves may bloom.
                const inside = Math.min(threshold, threshold > 1 ? 1.12 : 0.62);
                prefilter.uniforms.threshold.value = threshold - (threshold - inside) * cabin;
                // The day lens raises the threshold; by day the grade is lighter too.
                material.uniforms.grade.value = (tuning.threshold ?? 0.82) > 1 ? 0.45 : 1;
                const previous = renderer.getRenderTarget();
                const autoClear = renderer.autoClear;
                try {
                    renderer.setRenderTarget(target);
                    renderer.clear();
                    renderer.render(world, worldCamera);
                    draw(renderer, prefilter, target, chain[0], target);
                    for (let i = 1; i < LEVELS; i += 1) draw(renderer, down, chain[i - 1], chain[i], chain[i - 1]);
                    // The wide levels carry more: a lamp has a small hot core and a broad veil.
                    renderer.autoClear = false;
                    for (let i = LEVELS - 1; i > 0; i -= 1) {
                        up.uniforms.weight.value = 1.15;
                        draw(renderer, up, chain[i], chain[i - 1], chain[i]);
                    }
                    renderer.autoClear = autoClear;
                    quad.material = material;
                    renderer.setRenderTarget(previous);
                    renderer.render(scene, camera);
                } finally {
                    renderer.autoClear = autoClear;
                    quad.material = material;
                    renderer.setRenderTarget(previous);
                }
            },
            destroy() {
                if (dead) return;
                dead = true;
                target.dispose();
                chain.forEach((level) => level.dispose());
                geometry.dispose();
                [material, prefilter, down, up].forEach((shader) => shader.dispose());
            }
        };
    };
    global.MusicStageDioramaOptics = Object.freeze({ create, active });
})(window);
