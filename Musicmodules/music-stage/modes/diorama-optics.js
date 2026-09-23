(function (global) {
    'use strict';
    const create = (T) => {
        const target = new T.WebGLRenderTarget(1, 1, {
            type: T.HalfFloatType, depthBuffer: true
        });
        const scene = new T.Scene();
        const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const geometry = new T.PlaneGeometry(2, 2);
        const material = new T.ShaderMaterial({
            depthTest: false, depthWrite: false,
            uniforms: {
                image: { value: target.texture },
                texel: { value: new T.Vector2(1, 1) },
                time: { value: 0 }, grain: { value: 0.08 },
                vignette: { value: 0.22 }, bloom: { value: 0.15 }
            },
            vertexShader: `varying vec2 uvScreen;
                void main(){uvScreen=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
            fragmentShader: `uniform sampler2D image;uniform vec2 texel;
                uniform float time,grain,vignette,bloom;varying vec2 uvScreen;
                vec3 bright(vec2 uv){vec3 c=texture2D(image,clamp(uv,0.001,0.999)).rgb;
                    return max(c-vec3(0.75),vec3(0.0));}
                void main(){
                    vec3 color=texture2D(image,uvScreen).rgb;
                    vec3 glow=vec3(0.0);
                    for(int i=1;i<=4;i++){
                        float f=float(i);
                        glow+=(bright(uvScreen+texel*vec2(f*5.0,0.0))
                            +bright(uvScreen-texel*vec2(f*5.0,0.0)))/(f*8.0);
                        glow+=(bright(uvScreen+texel*vec2(0.0,f*2.0))
                            +bright(uvScreen-texel*vec2(0.0,f*2.0)))/(f*16.0);
                    }
                    color+=glow*bloom;
                    vec2 p=uvScreen*2.0-1.0;
                    color*=1.0-vignette*smoothstep(0.2,1.7,dot(p,p))*0.6;
                    gl_FragColor=vec4(color,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    float n=fract(sin(dot(gl_FragCoord.xy+floor(time*24.0),
                        vec2(12.9898,78.233)))*43758.5453)-0.5;
                    gl_FragColor.rgb=clamp(gl_FragColor.rgb+n*grain*0.08,0.0,1.0);
                }`
        });
        scene.add(new T.Mesh(geometry, material));
        let dead = false;
        return {
            render(renderer, world, worldCamera, time, config) {
                if (dead) return;
                const tuning = config.modes?.diorama || {};
                if (tuning.postProcess === false || config.quality === 'energy-saving') {
                    renderer.render(world, worldCamera);
                    return;
                }
                const size = renderer.getDrawingBufferSize(new T.Vector2());
                if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
                material.uniforms.texel.value.set(1 / size.x, 1 / size.y);
                material.uniforms.time.value = time;
                material.uniforms.grain.value = tuning.grain ?? 0.08;
                material.uniforms.vignette.value = tuning.vignette ?? 0.22;
                material.uniforms.bloom.value = (tuning.glow ?? 1) * 0.15;
                const previous = renderer.getRenderTarget();
                try {
                    renderer.setRenderTarget(target);
                    renderer.clear();
                    renderer.render(world, worldCamera);
                    renderer.setRenderTarget(previous);
                    renderer.render(scene, camera);
                } finally {
                    renderer.setRenderTarget(previous);
                }
            },
            destroy() {
                if (dead) return;
                dead = true;
                target.dispose();
                geometry.dispose();
                material.dispose();
            }
        };
    };
    global.MusicStageDioramaOptics = Object.freeze({ create });
})(window);