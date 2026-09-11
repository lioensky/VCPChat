(function (global) {
    'use strict';

    // Adapted from Folia's sonnetLensFilter, sonnetMotion and sonnetCameraTracking (AGPL-3.0).
    // Native host adapter: no independent ticker and no accumulated camera time.
    const R = global.MusicStageRuntime;
    const { clamp, seededRandom, splitGraphemes } = R;
    const amount = (value, fallback = 0, max = 2) => clamp(Number.isFinite(Number(value)) ? Number(value) : fallback, 0, max);
    const ease = (v) => { const t = clamp(v); return t * t * (3 - 2 * t); };
    const expo = (v) => { const t = clamp(v); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); };
    const kinds = ['editorial-column', 'type-impact', 'fragment-collage', 'tracking-ribbon', 'mask-reveal', 'poster-blocks', 'quiet-tableau'];

    const vertex = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main() {
    vec2 p = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    p.x = p.x * (2.0 / uOutputTexture.x) - 1.0;
    p.y = p.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(p, 0.0, 1.0);
    vTextureCoord = aPosition * uOutputFrame.zw * uInputSize.zw;
}`;
    const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;
uniform highp vec4 uOutputFrame;
uniform float uDistortion;
uniform float uDispersion;
uniform float uRgb;
uniform float uGrain;
uniform float uContrast;
uniform float uHalftone;
uniform float uVignette;
uniform float uTime;
vec4 sampleInside(vec2 uv) {
    if (uv.x < uInputClamp.x || uv.y < uInputClamp.y || uv.x > uInputClamp.z || uv.y > uInputClamp.w) return vec4(0.0);
    return texture(uTexture, uv);
}
float screenDot(vec2 p, float a, float v) {
    float c = cos(a), s = sin(a);
    float d = length(fract(mat2(c,s,-s,c) * p / 5.0) - 0.5) * 5.0;
    float r = sqrt(clamp(v,0.0,1.0)) * 3.1;
    return 1.0 - smoothstep(r - 1.2,r + 1.2,d);
}
void main() {
    vec2 screenUv = vTextureCoord * uInputSize.xy / max(uOutputFrame.zw,vec2(1.0));
    vec2 centered = screenUv - 0.5;
    float aspect = uOutputFrame.z / max(uOutputFrame.w,1.0);
    centered.x *= aspect;
    float r2 = dot(centered,centered);
    float curve = uDistortion * 0.32;
    vec2 warped = centered * (1.0 - curve*r2 + curve*0.16*r2*r2);
    warped.x /= aspect;
    vec2 uv = (warped + 0.5) * uOutputFrame.zw * uInputSize.zw;
    float radius = sqrt(r2);
    vec2 dispersion = radius > 0.0001 ? centered/radius : vec2(0.0);
    dispersion *= uDispersion * 0.012 * smoothstep(0.12,0.9,radius);
    dispersion.x /= aspect;
    vec2 offset = dispersion * uOutputFrame.zw * uInputSize.zw + vec2(0.9063,0.4226)*uRgb*3.0*uInputSize.zw;
    vec4 center = sampleInside(uv);
    vec4 red = sampleInside(uv + offset);
    vec4 blue = sampleInside(uv - offset);
    float alpha = max(center.a,max(red.a,blue.a));
    vec3 rgb = max(center.rgb*(0.84-clamp(max(uDispersion,uRgb),0.0,1.0)*0.18),vec3(red.r,center.g,blue.b));
    if (alpha > 0.0001) rgb /= alpha;
    rgb = clamp((rgb-0.5)*(1.0+uContrast*0.5)+0.5,0.0,1.0);
    vec3 dots = vec3(screenDot(gl_FragCoord.xy,0.2618,rgb.r),screenDot(gl_FragCoord.xy,1.309,rgb.g),screenDot(gl_FragCoord.xy,0.0,rgb.b));
    rgb = mix(rgb,dots,uHalftone);
    float noise = fract(sin(dot(gl_FragCoord.xy + floor(uTime*24.0),vec2(12.9898,78.233)))*43758.5453)-0.5;
    rgb = clamp(rgb + noise*uGrain*0.18,0.0,1.0);
    vec4 color = vec4(rgb*alpha,alpha);
    float vignette = smoothstep(0.52,1.08,radius)*uVignette*0.6;
    finalColor = mix(color,vec4(0.0,0.0,0.0,1.0),vignette);
}`;
    const createPostProcess = (PIXI, stage) => {
        const descriptors = {};
        ['Distortion', 'Dispersion', 'Rgb', 'Grain', 'Contrast', 'Halftone', 'Vignette', 'Time']
            .forEach(key => { descriptors[`u${key}`] = { value: 0, type: 'f32' }; });
        const uniforms = new PIXI.UniformGroup(descriptors);
        const filter = new PIXI.Filter({
            glProgram: PIXI.GlProgram.from({ vertex, fragment, name: 'vcp-folia-optical-print' }),
            resources: { opticalUniforms: uniforms },
            antialias: 'on'
        });
        return {
            update(frame, tuning, width, height) {
                const values = {
                    Distortion: amount(tuning.lensDistortion, 0.35),
                    Dispersion: amount(tuning.lensDispersion, 0.18, 1),
                    Rgb: amount(tuning.rgbShift, 0, 1),
                    Grain: amount(tuning.grain, 0, 1),
                    Contrast: amount(tuning.contrast, 0, 1),
                    Halftone: amount(tuning.halftone, 0, 1),
                    Vignette: amount(tuning.vignette, 0.18, 1)
                };
                const enabled = tuning.postProcess !== false && tuning.quality !== 'energy-saving'
                    && Object.values(values).some(value => value > 0);
                stage.filters = enabled ? [filter] : null;
                if (!enabled) return;
                if (!stage.filterArea) stage.filterArea = new PIXI.Rectangle();
                stage.filterArea.x = stage.filterArea.y = 0;
                stage.filterArea.width = width;
                stage.filterArea.height = height;
                Object.entries(values).forEach(([key, value]) => { uniforms.uniforms[`u${key}`] = value; });
                uniforms.uniforms.uTime = frame.playbackTime || 0;
            },
            destroy() { stage.filters = null; filter.destroy(); }
        };
    };

    const clear = container => container.removeChildren().forEach(child => child.destroy({ children: true }));
    const motionScale = tuning => tuning.reducedMotion ? 0 : amount(tuning.animationIntensity, 1);
    const shotKind = (seed, tuning) => kinds.includes(tuning.shotFlow)
        ? tuning.shotFlow : kinds[R.hashString(seed) % kinds.length];

    const camera = (frame, tuning, kind, width, height, glyphs = []) => {
        const p = clamp(frame.lineProgress || 0);
        const e = ['tracking-ribbon', 'fragment-collage', 'quiet-tableau', 'poster-blocks'].includes(kind)
            ? p * 0.55 + ease(p) * 0.45
            : p < 0.18 ? expo(p / 0.18) * 0.22 : p < 0.78 ? 0.22 + (p - 0.18) / 0.6 * 0.56 : 0.78 + (1 - (1 - (p - 0.78) / 0.22) ** 2) * 0.22;
        const paths = {
            'editorial-column': [-0.055 + e * 0.095, 0.025 - e * 0.04, 0.98 + e * 0.07, -0.006 + e * 0.01],
            'type-impact': [-0.035 + e * 0.07, 0.018 - e * 0.028, 1 + (1 - expo(p / 0.18)) * 0.22 + e * 0.08, -0.01 + e * 0.016],
            'fragment-collage': [-0.045 + e * 0.085, 0.028 - Math.sin(e * Math.PI) * 0.055, 0.97 + e * 0.09, -0.014 + e * 0.028],
            'tracking-ribbon': [-0.16 + e * 0.28, 0.05 - e * 0.085, 0.98 + e * 0.07, 0.008 - e * 0.014],
            'mask-reveal': [0.035 - e * 0.065, 0.1 - e * 0.135, 0.96 + e * 0.12, -0.006 + e * 0.009],
            'poster-blocks': [-0.012 + e * 0.024, 0.008 - e * 0.016, 0.99 + e * 0.025, -0.0015 + e * 0.003],
            'quiet-tableau': [-0.022 + e * 0.04, 0.014 - e * 0.025, 1 + e * 0.028, -0.002 + e * 0.003]
        };
        const path = paths[kind] || paths['quiet-tableau'];
        const strength = amount(tuning.cameraIntensity, 1) * motionScale(tuning);
        const time = (frame.playbackTime || 0) * Math.PI * 2;
        const breath = amount(tuning.cameraBreath, 0.5);
        let focusX = width / 2, focusY = height / 2;
        if (glyphs.length) {
            let current = glyphs[0].dataset;
            let next = current;
            for (const node of glyphs) {
                next = node.dataset;
                if (next.startTime > frame.playbackTime) break;
                current = next;
            }
            const t = ease((frame.playbackTime - current.startTime) / Math.max(0.001, next.startTime - current.startTime));
            focusX = current.baseX + (next.baseX - current.baseX) * t;
            focusY = current.baseY + (next.baseY - current.baseY) * t;
        }
        const tracking = amount(tuning.cameraTracking, 0.35, 1);
        return {
            x: width / 2 + (path[0] * width * 0.45 - clamp(focusX - width / 2, -width * 0.2, width * 0.2) * tracking + Math.sin(time * 0.13) * width * 0.006 * breath) * strength,
            y: height / 2 + (path[1] * height * 0.45 - clamp(focusY - height / 2, -height * 0.15, height * 0.15) * tracking + Math.cos(time * 0.11) * height * 0.006 * breath) * strength,
            scale: 1 + (path[2] - 1) * strength,
            rotation: path[3] * strength
        };
    };

    // Split timing within each source word, preserving its real boundaries rather than retiming a whole line.
    const glyphTiming = line => (line?.resolvedWords || []).flatMap(word => {
        const chars = splitGraphemes(word.text);
        return chars.map((text, index) => ({
            text,
            startTime: word.startTime + (word.endTime - word.startTime) * index / Math.max(1, chars.length),
            endTime: word.startTime + (word.endTime - word.startTime) * (index + 1) / Math.max(1, chars.length)
        }));
    });

    const buildLyrics = (PIXI, container, line, width, height, tuning, seed) => {
        clear(container);
        container.position.set(0, 0);
        const kind = shotKind(seed, tuning);
        const random = seededRandom(seed);
        const fontSize = Math.min(width * 0.08, height * 0.12, 76) * amount(tuning.fontScale, 1, 1.5);
        const maxWidth = width * 0.68;
        const rows = [[]];
        let rowWidth = 0;
        const nodes = glyphTiming(line).map((glyph, index) => {
            const node = new PIXI.Text({
                text: glyph.text,
                style: {
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
                    fontSize, fontWeight: '800', fill: '#ffffff',
                    stroke: { color: '#080b14', width: Math.max(1, fontSize * 0.025) }
                }
            });
            node.anchor.set(0.5);
            const advance = Math.max(fontSize * 0.18, node.width) + fontSize * 0.035;
            if (rowWidth + advance > maxWidth && rows[rows.length - 1].length) {
                rows.push([]);
                rowWidth = 0;
            }
            node.dataset = { ...glyph, advance, rowX: rowWidth + advance / 2, index, angle: (random() - 0.5) * 0.18 };
            rows[rows.length - 1].push(node);
            rowWidth += advance;
            container.addChild(node);
            return node;
        });
        const lineHeight = fontSize * 1.4;
        const fit = Math.min(1, height * 0.42 / Math.max(lineHeight, rows.length * lineHeight));
        rows.forEach((row, rowIndex) => {
            const total = row.reduce((sum, node) => sum + node.dataset.advance, 0);
            const shift = kind === 'editorial-column' ? -width * 0.04
                : kind === 'fragment-collage' ? (rowIndex % 2 ? 1 : -1) * width * 0.035 : 0;
            row.forEach(node => {
                const d = node.dataset;
                d.baseX = width / 2 + (d.rowX - total / 2) * fit + shift;
                d.baseY = height * 0.47 + (rowIndex - (rows.length - 1) / 2) * lineHeight * fit;
                d.fit = fit;
                d.fontSize = fontSize;
                node.position.set(d.baseX, d.baseY);
                node.scale.set(fit);
            });
        });
        return nodes;
    };

    const animateLyrics = (nodes, frame, tuning, color) => {
        const strength = amount(tuning.typographyMotion ?? tuning.glyphMotion, 1) * motionScale(tuning);
        const style = tuning.glyphStyle || 'rise';
        const time = frame.playbackTime || 0;
        const release = amount(tuning.releaseDuration, 0.45, 1.5);
        const lineEnd = frame.activeLine?.endTime ?? Infinity;
        const exit = release > 0 ? ease((time - lineEnd) / release) : 0;
        nodes.forEach(node => {
            const d = node.dataset;
            const progress = clamp((time - d.startTime) / Math.max(0.04, d.endTime - d.startTime));
            const entry = 1 - expo((time - d.startTime + 0.12) / 0.42);
            const active = time >= d.startTime && time < d.endTime;
            const bounce = active ? Math.sin(progress * Math.PI) : 0;
            const direction = d.index % 2 ? 1 : -1;
            node.position.set(
                d.baseX + (style === 'scatter' ? direction * entry * d.fontSize * 0.65 : 0) * strength,
                d.baseY + (entry * d.fontSize * (style === 'scatter' ? direction : 1) * 0.65 - bounce * d.fontSize * 0.08 - exit * d.fontSize * 0.35) * strength
            );
            node.rotation = style === 'scatter' ? d.angle * (entry + bounce) * strength : 0;
            const pop = style === 'impact' ? -entry * 0.38 + bounce * 0.2 : bounce * 0.1 - entry * 0.12;
            node.scale.set(d.fit * (1 + pop * strength));
            node.alpha = (time < d.startTime ? amount(tuning.waitingOpacity, 0.25, 1) : 1) * (1 - exit * 0.8);
            node.tint = active && tuning.textInversion !== false ? color : 0xffffff;
        });
    };

    const applyQuality = (app, width, height, quality) => {
        const budget = quality === 'ultimate' ? 3840 * 2160 : quality === 'energy-saving' ? 1280 * 720 : 1920 * 1080 * 1.5;
        const cap = quality === 'energy-saving' ? 1 : Math.min(2, global.devicePixelRatio || 1);
        const resolution = Math.max(0.25, Math.min(cap, Math.sqrt(budget / Math.max(1, width * height))));
        if (Math.abs(app.renderer.resolution - resolution) > 0.01) app.renderer.resize(width, height, resolution);
    };

    const transition = (frame, tuning) => {
        if (!motionScale(tuning) || tuning.sceneTransitions === false || !frame.activeLine) return 1;
        const duration = Math.min(0.24, Math.max(0.08, (frame.activeLine.endTime - frame.activeLine.startTime) * 0.12));
        const enter = ease((frame.playbackTime - frame.activeLine.startTime) / duration);
        const nextStart = frame.nextLines?.[0]?.startTime;
        // Fade only between adjacent shots; retain the outgoing lyric through an instrumental gap.
        const exit = Number.isFinite(nextStart) && nextStart <= frame.activeLine.endTime + 0.25
            ? ease((frame.playbackTime - nextStart + duration) / duration) : 0;
        return (0.28 + enter * 0.72) * (1 - exit * 0.72);
    };

    // Seeded graphic families complement the retained HUD, without creating per-frame graphics.
    const buildMotif = (PIXI, container, width, height, color, seed) => {
        const random = seededRandom(`motif:${seed}`);
        const kind = Math.floor(random() * 4);
        const graphic = new PIXI.Graphics();
        const cx = width * 0.5, cy = height * 0.46;
        const r = Math.min(width, height) * 0.32;
        if (kind === 0) {
            for (let i = 0; i < 7; i++) {
                const angle = i / 7 * Math.PI * 2;
                graphic.ellipse(cx, cy, r, r * (0.22 + i * 0.08));
                graphic.circle(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * 0.45, 3 + i);
            }
        } else if (kind === 1) {
            for (let i = -7; i <= 7; i++) {
                const x = cx + i * r / 7;
                const h = (0.2 + random() * 0.8) * r;
                graphic.rect(x, cy - h / 2, r * 0.06, h);
                graphic.moveTo(x, cy + r * 0.7).lineTo(x, cy + r * 0.8);
            }
        } else if (kind === 2) {
            for (let i = 0; i < 8; i++) {
                const y = cy - r + i * r * 0.27;
                graphic.moveTo(cx - r, y).lineTo(cx, y - r * 0.25).lineTo(cx + r, y);
                graphic.moveTo(cx - r + i * r * 0.28, cy - r).lineTo(cx - r + i * r * 0.28, cy + r);
            }
        } else {
            for (let i = 0; i < 12; i++) {
                const a = i * Math.PI / 6;
                const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
                graphic.moveTo(cx, cy).quadraticCurveTo(x, cy, x, y).quadraticCurveTo(cx, y, cx, cy);
            }
        }
        graphic.stroke({ color, width: 1.2, alpha: 0.22 });
        container.addChild(graphic);
        return graphic;
    };

    global.MusicStagePixiEffects = Object.freeze({
        amount, ease, expo, clear, camera, shotKind, glyphTiming, buildLyrics, animateLyrics, motionScale, createPostProcess,
        applyQuality, transition, buildMotif
    });
})(window);