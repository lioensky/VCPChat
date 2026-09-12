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
uniform vec3 uPaper;
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
    finalColor = mix(color,vec4(uPaper,1.0),vignette);
}`;
    const createPostProcess = (PIXI, stage) => {
        const descriptors = {};
        ['Distortion', 'Dispersion', 'Rgb', 'Grain', 'Contrast', 'Halftone', 'Vignette', 'Time']
            .forEach(key => { descriptors[`u${key}`] = { value: 0, type: 'f32' }; });
        descriptors.uPaper = { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' };
        const uniforms = new PIXI.UniformGroup(descriptors);
        const filter = new PIXI.Filter({
            glProgram: PIXI.GlProgram.from({ vertex, fragment, name: 'vcp-folia-optical-print' }),
            resources: { opticalUniforms: uniforms },
            antialias: 'on'
        });
        return {
            update(frame, tuning, width, height) {
                const kick = motionScale(tuning) * amount(tuning.opticalImpact, 0.65, 1) * clamp(tuning.performance?.impact || 0);
                const values = {
                    Distortion: amount(tuning.lensDistortion, 0.35),
                    Dispersion: amount(tuning.lensDispersion, 0.18, 1),
                    Rgb: clamp(amount(tuning.rgbShift, 0, 1) + kick * 0.45),
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
                const paper = tuning.palette?.background || '#171a1d';
                const n = parseInt(paper.slice(1), 16);
                uniforms.uniforms.uPaper.set([(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]);
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
        const e = ease(p);
        const paths = {
            'editorial-column': [-0.055 + e * 0.095, 0.025 - e * 0.04, 0.98 + e * 0.07, -0.006 + e * 0.01],
            'type-impact': [-0.025 + e * 0.05, 0.012 - e * 0.02, 1 + Math.sin(e * Math.PI) * 0.055, -0.004 + e * 0.008],
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
        const softness = amount(tuning.cameraSoftness, 0.75, 1);
        if (glyphs.length) {
            // Folia-style normalized focus weights: temporal averaging, not frame-history damping.
            // Subtract the closest distance before exponentiation to remain stable during long gaps.
            const sigma = 0.18 + softness * 0.65;
            const distance = d => Math.max(d.startTime - frame.playbackTime, frame.playbackTime - d.endTime, 0);
            let nearest = Infinity;
            glyphs.forEach(node => { nearest = Math.min(nearest, distance(node.dataset)); });
            let total = 0, x = 0, y = 0;
            glyphs.forEach(node => {
                const d = node.dataset;
                const delta = distance(d);
                const weight = Math.exp(-(delta * delta - nearest * nearest) / (2 * sigma * sigma));
                total += weight;
                x += d.baseX * weight;
                y += d.baseY * weight;
            });
            focusX = x / total;
            focusY = y / total;
        }
        const tracking = amount(tuning.cameraTracking, 0.35, 1);
        const start = frame.activeLine?.startTime ?? frame.playbackTime;
        const end = Math.min(frame.activeLine?.endTime ?? start, frame.nextLines?.[0]?.startTime ?? Infinity);
        const ramp = Math.min(Math.max(0.001, (end - start) * 0.4), 0.45 + softness * 0.75);
        // All shots share a neutral boundary pose and a continuous absolute-time breathing layer.
        // Thus a direct seek gives exactly the same pose as uninterrupted playback.
        const envelope = ease((frame.playbackTime - start) / ramp) * ease((end - frame.playbackTime) / ramp);
        const travel = strength * envelope * (1 - softness * 0.4);
        return {
            x: width / 2 + (path[0] * width * 0.35 - clamp(focusX - width / 2, -width * 0.12, width * 0.12) * tracking) * travel
                + Math.sin(time * 0.13) * width * 0.003 * breath * strength,
            y: height / 2 + (path[1] * height * 0.3 - clamp(focusY - height / 2, -height * 0.08, height * 0.08) * tracking) * travel
                + Math.cos(time * 0.11) * height * 0.003 * breath * strength,
            scale: 1 + (path[2] - 1) * travel
                + clamp(tuning.performance?.impact || 0) * 0.035 * strength,
            rotation: (path[3] * travel + (tuning.performance?.impact || 0) * 0.012 * strength)
                * amount(tuning.cameraRoll, 0.25, 1)
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

    // Lightweight phrase compiler: punctuation and vocal gaps are boundaries; source timing is unchanged.
    const compilePhrases = (line, tuning) => {
        const glyphs = glyphTiming(line);
        const limit = Math.round(amount(tuning.phraseLength, 12, 24)) || 12;
        let phrase = 0, count = 0;
        glyphs.forEach((glyph, index) => {
            const previous = glyphs[index - 1];
            const naturalBreak = previous && (/[，。！？；、,.!?;:：]/u.test(previous.text)
                || glyph.startTime - previous.endTime > 0.4);
            const wordBreak = previous && (/\s/u.test(previous.text) || /[\u3040-\u30ff\u3400-\u9fff]/u.test(glyph.text));
            if (count >= 3 && (naturalBreak || (count >= limit && wordBreak))) {
                phrase += 1;
                count = 0;
            }
            glyph.phrase = phrase;
            if (glyph.text.trim()) count += 1;
        });
        const groups = [];
        glyphs.forEach(glyph => {
            if (!groups[glyph.phrase]) groups[glyph.phrase] = { start: glyph.startTime, end: glyph.endTime };
            groups[glyph.phrase].end = Math.max(groups[glyph.phrase].end, glyph.endTime);
        });
        glyphs.forEach(glyph => {
            glyph.phraseStart = groups[glyph.phrase].start;
            glyph.phraseEnd = groups[glyph.phrase].end;
        });
        return glyphs;
    };

    const buildLyrics = (PIXI, container, line, width, height, tuning, seed) => {
        clear(container);
        container.position.set(0, 0);
        const kind = shotKind(seed, tuning);
        const random = seededRandom(seed);
        const fontSize = Math.min(width * 0.08, height * 0.12, 76) * amount(tuning.fontScale, 1, 1.5);
        const maxWidth = width * 0.68;
        const rows = [[]];
        let rowWidth = 0;
        const layout = tuning.lyricLayout || 'phrases';
        const nodes = compilePhrases(line, tuning).map((glyph, index) => {
            const node = new PIXI.Text({
                text: glyph.text,
                style: {
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
                    fontSize, fontWeight: '800', fill: '#ffffff',
                    stroke: { color: tuning.palette?.background || '#171a1d', width: Math.max(1, fontSize * 0.025) }
                }
            });
            node.anchor.set(0.5);
            const advance = Math.max(fontSize * 0.18, node.width) + fontSize * 0.035;
            const row = rows[rows.length - 1];
            const phraseBreak = layout !== 'lines' && row.length && row[row.length - 1].dataset.phrase !== glyph.phrase;
            if ((rowWidth + advance > maxWidth || phraseBreak) && row.length) {
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
                const alignment = layout === 'staircase' ? (rowIndex % 3 - 1) * width * 0.055 : 0;
                d.baseX = width / 2 + (d.rowX - total / 2) * fit + shift + alignment;
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
            const phraseAge = time - d.phraseStart;
            const punch = phraseAge >= 0 ? Math.sin(Math.min(1, phraseAge / 0.48) * Math.PI) * Math.exp(-phraseAge * 3) : 0;
            const performance = amount(tuning.performanceIntensity, 1.25) * strength;
            const isTempera = tuning.performanceMode === 'tempera';
            node.position.x += (isTempera ? direction * punch * d.fontSize * 0.12 : -entry * d.fontSize * 0.45) * performance;
            node.position.y -= punch * d.fontSize * (isTempera ? 0.18 : 0.07) * performance;
            node.skew.x = (isTempera ? -punch * 0.09 : entry * 0.16) * performance;
            node.scale.set(
                d.fit * Math.max(0.2, 1 + pop * strength + punch * 0.12 * performance),
                d.fit * Math.max(0.2, 1 + pop * strength - punch * 0.08 * performance)
            );
            const phraseEmphasis = amount(tuning.phraseEmphasis, 0.4, 1);
            const phraseWeight = ease((time - d.phraseStart + 0.3) / 0.3)
                * (1 - ease((time - d.phraseEnd) / 0.65));
            const focusAlpha = 1 - phraseEmphasis * 0.5 * (1 - phraseWeight);
            node.alpha = (time < d.startTime ? amount(tuning.waitingOpacity, 0.25, 1) : 1) * (1 - exit * 0.8) * focusAlpha;
            // Keep the raster white for tinting; choose the theme ink on the GPU.
            node.tint = active && tuning.textInversion !== false
                ? color : parseInt((tuning.palette?.ink || '#f2f0e9').slice(1), 16);
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
        // Never fade still-singing text in anticipation of the next line.
        // Retiring background geometry supplies the outgoing half of the cut.
        return 0.45 + enter * 0.55;
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

    // Compile once per lyric-array identity. Greedy spacing is deterministic even
    // after a direct seek; no runtime random draws or replay of missed events.
    const accentCueCache = new WeakMap();
    const accentCues = (lines, seed) => {
        if (!Array.isArray(lines)) return new Set();
        let cache = accentCueCache.get(lines);
        if (!cache) { cache = new Map(); accentCueCache.set(lines, cache); }
        if (cache.has(seed)) return cache.get(seed);
        const selected = new Set();
        let previous = -Infinity;
        lines.forEach((line, index) => {
            const duration = line.endTime - line.startTime;
            const count = splitGraphemes(line.fullText).filter(c => c.trim()).length;
            const gap = index ? line.startTime - lines[index - 1].endTime : 1;
            const random = seededRandom(`${seed}:${index}:${line.fullText}`);
            if (duration >= 2.4 && count >= 3 && count / duration < 9
                && line.startTime - previous >= 7
                && (gap > 0.45 || /[，。！？…!?]/u.test(line.fullText) || random() > 0.40)) {
                selected.add(index);
                previous = line.startTime;
            }
        });
        // Bound alternate track keys when callers replace metadata in place.
        if (cache.size >= 4) cache.delete(cache.keys().next().value);
        cache.set(seed, selected);
        return selected;
    };

    const createAccentChoreography = (PIXI, parent, nodes, groups, color, mode, seed) => {
        const layer = new PIXI.Container();
        parent.addChild(layer);
        const random = seededRandom(`accent:${mode}:${seed}`);
        const eligible = nodes.filter(node => node.dataset.text.trim()
            && !/^[，。！？、,.!?;:：；]$/u.test(node.dataset.text));
        // Only three glyphs, never a whole-line particle emitter.
        const targets = eligible.filter((node, index) => index >= Math.floor(eligible.length * 0.3))
            .filter((node, index) => index % Math.max(1, Math.floor(eligible.length / 3)) === 0).slice(0, 3);
        const particles = (mode === 'sonnet' ? targets : []).flatMap((target, index) => {
            const baseAngle = random() * Math.PI * 2;
            return Array.from({ length: 5 }, (_, arm) => {
                const trail = [];
                for (let j = 0; j < 18; j++) {
                    const dot = new PIXI.Graphics().circle(0, 0, j === 0 ? 3.2 : 1.6)
                        .fill({ color, alpha: 1 });
                    layer.addChild(dot);
                    trail.push(dot);
                }
                return {
                    target, trail, index, arm,
                    angle: baseAngle + arm * Math.PI * 2 / 5 + (random() - 0.5) * 0.22,
                    direction: arm % 2 ? -1 : 1,
                    radiusScale: 0.8 + random() * 0.4,
                    lead: 1.65 + arm * 0.13 + random() * 0.15
                };
            });
        });
        const frameSegments = [];
        const group = groups[Math.min(1, groups.length - 1)];
        let pen = null, corners = null;
        if (group && mode === 'tempera') {
            const x = group.left - 20, y = group.top - 16;
            const w = group.right - group.left + 40, h = group.bottom - group.top + 32;
            corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
            pen = new PIXI.Graphics().rect(-3, -3, 6, 6).fill({ color, alpha: 0.9 });
            layer.addChild(pen);
            for (let side = 0; side < 4; side++) {
                for (let step = 0; step < 12; step++) {
                    const a = corners[side], b = corners[side + 1];
                    const segment = new PIXI.Graphics();
                    const p = step / 12, q = (step + 0.85) / 12;
                    segment.moveTo(a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p)
                        .lineTo(a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q)
                        .stroke({ color, width: step === 0 ? 2.5 : 1.2, alpha: 0.7 });
                    layer.addChild(segment);
                    frameSegments.push(segment);
                }
            }
        }
        return {
            update(frame, tuning) {
                const strength = motionScale(tuning) * amount(tuning.accentMotion, 1);
                const track = frame.track?.path || frame.track?.title || '';
                const enabled = tuning.accentEffects !== false && tuning.showDecor !== false && strength > 0
                    && accentCues(frame.lines, `${mode}:${track}`).has(frame.currentLineIndex);
                layer.visible = enabled;
                if (!enabled) return;
                const time = frame.playbackTime;
                const viewportSpan = Math.min(frame.viewport?.width || 900, frame.viewport?.height || 600);
                particles.forEach(({ target, trail, angle, index, arm, direction, radiusScale, lead }) => {
                    const d = target.dataset;
                    // Approach starts inside this shot, arriving shortly after onset.
                    const arrival = d.startTime + Math.min(0.12, (d.endTime - d.startTime) * 0.3);
                    const duration = Math.min(lead, Math.max(0.15, arrival - frame.activeLine.startTime));
                    const p = (time - arrival + duration) / duration;
                    const glow = p >= 1 ? Math.exp(-(time - arrival) * 7) : 0;
                    if (mode === 'sonnet' && arm === 0 && glow > 0.01) {
                        target.tint = color;
                        target.scale.x *= 1 + glow * 0.07 * strength;
                        target.scale.y *= 1 + glow * 0.07 * strength;
                    }
                    trail.forEach((dot, j) => {
                        const u = p - j * 0.014;
                        const armBudget = tuning.quality === 'ultimate' ? 5
                            : tuning.quality === 'energy-saving' ? 2 : 4;
                        dot.visible = mode === 'sonnet' && u >= 0 && u <= 1 && arm < armBudget
                            && (tuning.quality !== 'energy-saving' || (index === 0 && j < 8));
                        if (!dot.visible) return;
                        const sweep = Math.PI * 2.6;
                        const turn = (1 - u) * sweep;
                        // Normalized logarithmic spiral: large, viewport-bounded
                        // entrances converge to the glyph, regardless of font size.
                        const growth = Math.log(1.618034) / (Math.PI / 2);
                        const reach = Math.min(viewportSpan * 0.44, Math.max(130, d.fontSize * 4.2))
                            * radiusScale * Math.min(1.5, strength);
                        const radius = (Math.exp(turn * growth) - 1) / (Math.exp(sweep * growth) - 1) * reach;
                        dot.position.set(target.x + Math.cos(angle + turn * direction) * radius,
                            target.y + Math.sin(angle + turn * direction) * radius * 0.86);
                        dot.alpha = ease(u / 0.08) * (1 - j / trail.length) * (arm === 0 ? 0.8 : 0.55);
                    });
                });
                const age = time - (group?.start ?? frame.activeLine.startTime) + 0.15;
                const draw = clamp(age / 1.15) * frameSegments.length;
                if (pen) {
                    const progress = clamp(age / 1.15) * 4;
                    const side = Math.min(3, Math.floor(progress));
                    const local = progress - side;
                    const a = corners[side], b = corners[side + 1];
                    pen.position.set(a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local);
                    pen.rotation = Math.PI / 4;
                    pen.alpha = ease(age / 0.12) * (1 - ease((age - 1.15) / 0.25));
                }
                frameSegments.forEach((segment, index) => {
                    const head = draw - index;
                    const tail = ease((age - 1.65 - index * 0.009) / 0.7);
                    segment.alpha = head < 0 ? 0 : (0.3 + Math.exp(-head * 0.65) * 0.7) * (1 - tail);
                });
            },
            snapshot() {
                return { emitters: particles.length, targets: mode === 'sonnet' ? targets.length : 0,
                    particles: particles.reduce((sum, particle) => sum + particle.trail.length, 0),
                    visibleParticles: particles.reduce((sum, particle) => sum
                        + particle.trail.filter(dot => layer.visible && dot.visible).length, 0),
                    frameSegments: frameSegments.length, visible: layer.visible };
            }
        };
    };

    // Live onsets are deliberately separate from deterministic lyric cues.
    // Fixed-size spectrum history; no event queue, ticker, timers or unbounded particles.
    const createPerformance = () => {
        const bins = new Float32Array(48);
        let lastTime = null, track = null, source = null, playing = false;
        let baseline = 0.02, energy = 0, hitAt = -Infinity, hitStrength = 0, hits = 0;
        const state = { impact: 0, phrasePulse: 0, energy: 0, phrase: -1, time: 0, reset: true };
        return {
            update(frame, tuning, nodes) {
                const time = Number(frame.playbackTime) || 0;
                const identity = frame.track?.path || frame.track?.title || '';
                const dt = lastTime === null ? 0 : time - lastTime;
                const reset = lastTime === null || identity !== track || source !== frame.lines || dt < -0.025 || dt > 0.5;
                const resumed = frame.isPlaying && !playing;
                const spectrum = frame.audio?.spectrum || [];
                let flux = 0;
                // Do not feed changing analyser samples into a paused scene.
                if (reset || resumed || (frame.isPlaying && dt > 0)) {
                    for (let i = 0; i < bins.length; i++) {
                        const value = clamp(Number(spectrum[Math.floor(i / bins.length * spectrum.length)]) || 0);
                        flux += Math.max(0, value - bins[i]);
                        bins[i] = value;
                    }
                    flux /= bins.length;
                    if (reset || resumed) {
                        baseline = 0.02;
                        hitAt = -Infinity;
                        hitStrength = 0;
                        energy = clamp(frame.audio?.power || 0);
                    } else {
                        const a = 1 - Math.exp(-dt * 3);
                        energy += (clamp(frame.audio?.power || 0) - energy) * a;
                        const threshold = Math.max(0.018, baseline * 1.8);
                        if (flux > threshold && energy > 0.035 && time - hitAt > 0.38) {
                            hitAt = time;
                            hitStrength = clamp((flux - threshold) * 10 + 0.35);
                            hits++;
                        }
                        baseline += (flux - baseline) * (1 - Math.exp(-dt * 1.8));
                    }
                }
                let phrase = -1, phraseStart = -Infinity;
                for (const node of nodes) {
                    const d = node.dataset;
                    if (d.phraseStart <= time && d.phraseStart > phraseStart) {
                        phraseStart = d.phraseStart;
                        phrase = d.phrase;
                    }
                }
                const pulse = age => age >= 0 && age < 0.85
                    ? (1 - Math.exp(-age * 35)) * Math.exp(-age * 5) : 0;
                const strength = motionScale(tuning) * amount(tuning.performanceIntensity, 1.25);
                state.phrasePulse = pulse(time - phraseStart) * strength;
                state.impact = clamp(pulse(time - hitAt) * hitStrength * amount(tuning.beatImpact, 1.15) * strength
                    + state.phrasePulse * 0.45);
                state.energy = energy;
                state.phrase = phrase;
                state.time = time;
                state.reset = reset;
                lastTime = time;
                track = identity;
                source = frame.lines;
                playing = Boolean(frame.isPlaying);
                return state;
            },
            snapshot() { return { ...state, onsets: hits, historyBins: bins.length }; },
            reset() { lastTime = null; hitAt = -Infinity; bins.fill(0); }
        };
    };

    // One retained graphic per phrase: GPU transforms animate a real reveal mask
    // and a separate accent rail without rebuilding geometry on every frame.
    const buildPhraseStage = (PIXI, textContainer, nodes, color) => {
        const groups = [];
        for (const node of nodes) {
            const d = node.dataset;
            let group = groups[d.phrase];
            if (!group) {
                const root = new PIXI.Container();
                textContainer.addChild(root);
                group = groups[d.phrase] = { root, nodes: [], start: d.phraseStart, end: d.phraseEnd,
                    left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
            }
            group.nodes.push(node);
            group.root.addChild(node);
            const margin = d.fontSize * d.fit;
            group.left = Math.min(group.left, d.baseX - d.advance * d.fit / 2 - margin * 0.25);
            group.right = Math.max(group.right, d.baseX + d.advance * d.fit / 2 + margin * 0.25);
            group.top = Math.min(group.top, d.baseY - margin * 0.85);
            group.bottom = Math.max(group.bottom, d.baseY + margin * 0.85);
        }
        for (const group of groups) {
            if (!group) continue;
            const width = group.right - group.left, height = group.bottom - group.top;
            const mask = new PIXI.Graphics().rect(0, 0, width, height).fill(0xffffff);
            mask.position.set(group.left, group.top);
            textContainer.addChild(mask);
            group.root.mask = mask;
            group.mask = mask;
            const rail = new PIXI.Graphics().rect(0, 0, width, 3).fill({ color, alpha: 0.85 });
            rail.position.set(group.left, group.bottom - height * 0.12);
            textContainer.addChild(rail);
            group.rail = rail;
            const bracket = new PIXI.Graphics();
            bracket.moveTo(12, 0).lineTo(0, 0).lineTo(0, height);
            bracket.lineTo(12, height);
            bracket.moveTo(width - 12, 0).lineTo(width, 0).lineTo(width, height).lineTo(width - 12, height);
            bracket.stroke({ color, width: 1.4, alpha: 0.55 });
            bracket.position.set(group.left, group.top);
            textContainer.addChild(bracket);
            group.bracket = bracket;
        }
        return groups;
    };
    const animatePhraseStage = (groups, frame, tuning, kind) => {
        const time = frame.playbackTime;
        const motion = motionScale(tuning);
        for (const group of groups) {
            if (!group) continue;
            // The reveal is complete at vocal onset, never concealing singing glyphs.
            const enter = motion && tuning.sceneTransitions !== false ? expo((time - group.start + 0.45) / 0.45) : 1;
            const focus = ease((time - group.start + 0.25) / 0.25) * (1 - ease((time - group.end) / 0.55));
            // Detach settled masks to avoid clipping scatter/impact at high strength.
            const reveal = enter < 1 && tuning.quality !== 'energy-saving';
            group.root.mask = reveal ? group.mask : null;
            group.mask.visible = reveal;
            group.mask.scale.set(kind === 'mask-reveal' ? 1 : Math.max(0.001, enter),
                kind === 'mask-reveal' ? Math.max(0.001, enter) : 1);
            group.rail.scale.x = Math.max(0.001, enter);
            group.rail.alpha = focus * (0.3 + (tuning.performance?.phrasePulse || 0) * 0.35);
            group.rail.visible = tuning.showDecor !== false;
            group.bracket.alpha = focus * 0.7;
            group.bracket.visible = tuning.performanceMode === 'sonnet' && tuning.guideLines !== false;
        }
    };

    // A bounded, deterministic typographic world. Lyrics are the route itself:
    // complete horizontal/vertical lines join into an editorial path while only
    // a small window around the active line owns display objects.
    const createEditorialTrack = (PIXI, parent, mode) => {
        const root = new PIXI.Container();
        const decor = new PIXI.Container();
        const text = new PIXI.Container();
        root.addChild(decor, text);
        parent.addChild(root);

        let entries = [];
        let source = null;
        let signature = '';
        let activeIndex = -1;
        let width = 1;
        let height = 1;
        let color = 0xffffff;
        let layout = [];
        let glyphs = [];

        const release = () => {
            clear(decor);
            clear(text);
            entries = [];
            glyphs = [];
        };

        const compileLayout = (lines, seed, nextWidth, nextHeight, tuning) => {
            const result = [];
            let x = nextWidth * 0.5;
            let y = nextHeight * 0.48;
            const verticalChance = amount(tuning.trackVerticalChance, 0.42, 0.9);
            const junction = amount(tuning.trackJunction, 0.45, 1);
            lines.forEach((line, index) => {
                const random = seededRandom(`editorial-track:${seed}:${index}:${line.fullText}`);
                let vertical = random() < verticalChance;
                // Probability shapes the normal rhythm, while a three-line
                // guard guarantees that the editorial route eventually turns.
                if (result.length >= 3) {
                    const recent = result.slice(-3);
                    const repeated = recent.every(point => point.vertical === recent[0].vertical);
                    if (repeated) vertical = !recent[0].vertical;
                }
                const turn = index > 0 && vertical !== result[index - 1].vertical;
                if (index > 0) {
                    const previous = result[index - 1];
                    const sideStep = (random() - 0.5) * junction;
                    if (vertical) {
                        y += nextHeight * (0.39 + random() * 0.08);
                        x += nextWidth * (turn ? 0.13 + sideStep * 0.09 : sideStep * 0.14);
                    } else {
                        x += nextWidth * (0.40 + random() * 0.08);
                        y += nextHeight * (turn ? 0.12 + sideStep * 0.08 : sideStep * 0.13);
                    }
                }
                result.push({
                    x, y, vertical,
                    rotation: (random() - 0.5) * 0.045 * junction,
                    scale: 0.88 + random() * 0.16,
                    labelSide: random() > 0.5 ? 1 : -1
                });
            });
            return result;
        };

        const makeEntry = (line, lineIndex, point, tuning) => {
            const entryRoot = new PIXI.Container();
            const entryDecor = new PIXI.Container();
            const entryText = new PIXI.Container();
            entryRoot.addChild(entryDecor, entryText);
            entryRoot.position.set(point.x, point.y);
            entryRoot.rotation = point.rotation;
            const timed = compilePhrases(line, tuning);
            const visible = timed.filter(glyph => glyph.text.trim());
            const count = Math.max(1, visible.length);
            const minimumSegment = Math.round(amount(tuning.trackMinSegment, 3, 8)) || 3;
            const segmentByGlyph = new Array(timed.length).fill(0);
            let segment = 0;
            let visibleBefore = 0;
            timed.forEach((glyph, glyphIndex) => {
                segmentByGlyph[glyphIndex] = segment;
                if (glyph.text.trim()) {
                    visibleBefore += 1;
                    return;
                }
                const visibleAfter = timed.slice(glyphIndex + 1).filter(item => item.text.trim()).length;
                if (visibleBefore >= minimumSegment && visibleAfter >= minimumSegment) {
                    segment += 1;
                    visibleBefore = 0;
                }
            });
            const segmentCount = segment + 1;
            const baseFontSize = Math.min(width * 0.065, height * 0.092, 66)
                * amount(tuning.fontScale, 1, 1.5) * point.scale;
            const maxSpan = point.vertical ? height * 0.76 : width * 0.66;
            const minimumFontSize = Math.min(width, height) * 0.022;
            // Never compress the advance below a glyph body. Long lines reduce
            // their type size first; this keeps vertical CJK text from stacking.
            const fontSize = Math.max(minimumFontSize, Math.min(baseFontSize, maxSpan / (count * 1.08)));
            const advance = fontSize * 1.08;
            const start = -(count - 1) * advance * 0.5;
            const segmentOffset = fontSize * (0.62 + amount(tuning.trackJunction, 0.45, 1) * 0.7);
            let visibleIndex = 0;
            const nodes = timed.map((glyph, glyphIndex) => {
                const node = new PIXI.Text({
                    text: glyph.text,
                    style: {
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
                        fontSize,
                        fontWeight: mode === 'tempera' ? '900' : '750',
                        fill: '#ffffff',
                        stroke: { color: tuning.palette?.background || '#171a1d', width: Math.max(1, fontSize * 0.022) }
                    }
                });
                node.anchor.set(0.5);
                const blank = !glyph.text.trim();
                const ordinal = visibleIndex;
                if (!blank) visibleIndex += 1;
                const axis = start + ordinal * advance;
                const segmentIndex = segmentByGlyph[glyphIndex];
                const centeredSegment = segmentIndex - (segmentCount - 1) * 0.5;
                const crossAxis = centeredSegment * segmentOffset;
                const baseX = point.vertical ? crossAxis : axis;
                const baseY = point.vertical ? axis : crossAxis;
                node.position.set(baseX, baseY);
                node.visible = !blank;
                node.dataset = {
                    ...glyph,
                    index: glyphIndex,
                    baseX,
                    baseY,
                    worldX: point.x + baseX,
                    worldY: point.y + baseY,
                    fontSize,
                    fit: 1,
                    advance,
                    segment: segmentIndex,
                    angle: ((glyphIndex % 5) - 2) * 0.035
                };
                entryText.addChild(node);
                return node;
            });

            const span = Math.max(fontSize * 1.5, (count - 1) * advance + fontSize * 1.35);
            const breadth = fontSize * 1.62 + Math.max(0, segmentCount - 1) * segmentOffset;
            const left = point.vertical ? -breadth * 0.5 : -span * 0.5;
            const top = point.vertical ? -span * 0.5 : -breadth * 0.5;
            const boxWidth = point.vertical ? breadth : span;
            const boxHeight = point.vertical ? span : breadth;
            const graphic = new PIXI.Graphics();
            if (mode === 'tempera') {
                graphic.roundRect(left - 12, top - 9, boxWidth + 24, boxHeight + 18, 4)
                    .fill({ color, alpha: lineIndex % 2 ? 0.085 : 0.14 });
                graphic.rect(
                    point.vertical ? left - 17 : left,
                    point.vertical ? top : top + boxHeight + 7,
                    point.vertical ? 4 : boxWidth,
                    point.vertical ? boxHeight : 4
                ).fill({ color, alpha: 0.72 });
            } else {
                const corner = Math.min(18, breadth * 0.24);
                graphic.moveTo(left + corner, top).lineTo(left, top).lineTo(left, top + corner);
                graphic.moveTo(left + boxWidth - corner, top).lineTo(left + boxWidth, top).lineTo(left + boxWidth, top + corner);
                graphic.moveTo(left, top + boxHeight - corner).lineTo(left, top + boxHeight).lineTo(left + corner, top + boxHeight);
                graphic.moveTo(left + boxWidth - corner, top + boxHeight).lineTo(left + boxWidth, top + boxHeight)
                    .lineTo(left + boxWidth, top + boxHeight - corner);
                graphic.stroke({ color, width: 1.25, alpha: 0.52 });
            }
            entryDecor.addChild(graphic);

            const marker = new PIXI.Text({
                text: `${String(lineIndex + 1).padStart(2, '0')} / ${point.vertical ? 'VERTICAL' : 'HORIZONTAL'}`,
                style: {
                    fontFamily: '"Segoe UI", sans-serif',
                    fontSize: Math.max(9, fontSize * 0.16),
                    fontWeight: '600',
                    letterSpacing: 2,
                    fill: '#ffffff'
                }
            });
            marker.tint = color;
            marker.alpha = 0.64;
            marker.position.set(left, top - Math.max(14, fontSize * 0.28));
            entryDecor.addChild(marker);

            const accentLayer = new PIXI.Container();
            entryRoot.addChild(accentLayer);
            const accent = {
                layer: accentLayer,
                pen: null,
                segments: [],
                particles: [],
                left,
                top,
                width: boxWidth,
                height: boxHeight
            };
            if (lineIndex === activeIndex && mode === 'tempera') {
                const corners = [
                    [left - 12, top - 9],
                    [left + boxWidth + 12, top - 9],
                    [left + boxWidth + 12, top + boxHeight + 9],
                    [left - 12, top + boxHeight + 9],
                    [left - 12, top - 9]
                ];
                accent.corners = corners;
                accent.pen = new PIXI.Graphics().rect(-3, -3, 6, 6).fill({ color, alpha: 0.95 });
                accentLayer.addChild(accent.pen);
                for (let side = 0; side < 4; side += 1) {
                    const a = corners[side];
                    const b = corners[side + 1];
                    for (let step = 0; step < 12; step += 1) {
                        const p = step / 12;
                        const q = (step + 0.82) / 12;
                        const part = new PIXI.Graphics();
                        part.moveTo(a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p)
                            .lineTo(a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q)
                            .stroke({ color, width: step === 0 ? 2.6 : 1.25, alpha: 0.8 });
                        accentLayer.addChild(part);
                        accent.segments.push(part);
                    }
                }
            } else if (lineIndex === activeIndex && mode === 'sonnet') {
                const targets = nodes.filter(node => node.visible)
                    .filter((node, index, list) => index % Math.max(1, Math.floor(list.length / 3)) === 0)
                    .slice(0, 3);
                const random = seededRandom(`track-accent:${lineIndex}:${line.fullText}`);
                targets.forEach((target, targetIndex) => {
                    for (let arm = 0; arm < 4; arm += 1) {
                        const trail = [];
                        for (let dotIndex = 0; dotIndex < 14; dotIndex += 1) {
                            const dot = new PIXI.Graphics().circle(0, 0, dotIndex ? 1.5 : 3)
                                .fill({ color, alpha: 1 });
                            accentLayer.addChild(dot);
                            trail.push(dot);
                        }
                        accent.particles.push({
                            target,
                            targetIndex,
                            arm,
                            trail,
                            angle: random() * Math.PI * 2 + arm * Math.PI * 0.5,
                            direction: arm % 2 ? -1 : 1,
                            reach: fontSize * (2.8 + random() * 1.7)
                        });
                    }
                });
            }
            accentLayer.visible = false;

            return { root: entryRoot, nodes, line, lineIndex, point, entryDecor, entryText, accent };
        };

        const rebuild = (frame, tuning, nextColor, seed) => {
            release();
            source = frame.lines;
            activeIndex = frame.currentLineIndex;
            color = nextColor;
            layout = compileLayout(frame.lines, seed, width, height, tuning);
            const before = tuning.quality === 'energy-saving' ? 1 : 2;
            const after = tuning.quality === 'energy-saving' ? 2 : 4;
            const first = Math.max(0, activeIndex - before);
            const last = Math.min(frame.lines.length - 1, Math.max(activeIndex, 0) + after);
            for (let index = first; index <= last; index += 1) {
                const entry = makeEntry(frame.lines[index], index, layout[index], tuning);
                text.addChild(entry.root);
                entries.push(entry);
                glyphs.push(...entry.nodes);
            }

            // Sparse junction marks suggest continuation without drawing a literal railway.
            for (let index = Math.max(1, first); index <= last; index += 1) {
                const a = layout[index - 1], b = layout[index];
                const junction = new PIXI.Graphics();
                const elbowX = b.vertical ? b.x : a.x;
                const elbowY = b.vertical ? a.y : b.y;
                junction.moveTo(a.x, a.y).lineTo(elbowX, elbowY).lineTo(b.x, b.y);
                junction.stroke({ color, width: mode === 'tempera' ? 2 : 1, alpha: mode === 'tempera' ? 0.18 : 0.24 });
                const tickSize = Math.min(width, height) * 0.012;
                junction.moveTo(elbowX - tickSize, elbowY).lineTo(elbowX + tickSize, elbowY);
                junction.moveTo(elbowX, elbowY - tickSize).lineTo(elbowX, elbowY + tickSize);
                junction.stroke({ color, width: 1, alpha: 0.42 });
                decor.addChild(junction);
            }
        };

        return {
            update(frame, tuning, nextColor, seed, nextWidth, nextHeight) {
                width = nextWidth;
                height = nextHeight;
                const nextSignature = [
                    seed, width, height, tuning.fontScale, tuning.trackVerticalChance,
                    tuning.trackJunction, tuning.trackMinSegment, tuning.quality, nextColor
                ].join(':');
                if (source !== frame.lines || activeIndex !== frame.currentLineIndex || signature !== nextSignature) {
                    signature = nextSignature;
                    rebuild(frame, tuning, nextColor, seed);
                }
                if (activeIndex < 0 || !layout[activeIndex]) {
                    root.visible = false;
                    return { x: width / 2, y: height / 2, scale: 1, rotation: 0, glyphs };
                }
                root.visible = true;
                const time = frame.playbackTime;
                const motion = motionScale(tuning);
                const glyphStrength = amount(tuning.typographyMotion ?? tuning.glyphMotion, 1) * motion;
                const glyphStyle = tuning.glyphStyle || 'rise';
                const ink = parseInt((tuning.palette?.ink || '#f2f0e9').slice(1), 16);
                entries.forEach(entry => {
                    const relative = entry.lineIndex - activeIndex;
                    const lead = Math.max(0.8, Math.min(4.5, entry.line.startTime - (frame.activeLine?.startTime || time)));
                    const paved = relative <= 0 ? 1 : ease(1 - (entry.line.startTime - time) / lead);
                    const retired = relative < 0 ? Math.max(0.12, 0.42 - Math.abs(relative) * 0.11) : 1;
                    entry.root.alpha = paved * retired;
                    entry.root.scale.set(0.94 + paved * 0.06);
                    entry.nodes.forEach(node => {
                        const d = node.dataset;
                        const p = clamp((time - d.startTime) / Math.max(0.04, d.endTime - d.startTime));
                        const arrival = 1 - expo((time - d.startTime + 0.18) / 0.52);
                        const active = time >= d.startTime && time < d.endTime;
                        const direction = d.index % 2 ? 1 : -1;
                        let offsetX = 0;
                        let offsetY = 0;
                        if (glyphStyle === 'scatter') {
                            offsetX = direction * arrival * d.fontSize * 0.72;
                            offsetY = -direction * arrival * d.fontSize * 0.48;
                        } else {
                            offsetX = entry.point.vertical ? arrival * d.fontSize * 0.7 : 0;
                            offsetY = entry.point.vertical ? 0 : arrival * d.fontSize * 0.7;
                        }
                        node.position.set(
                            d.baseX + offsetX * glyphStrength,
                            d.baseY + offsetY * glyphStrength
                        );
                        node.rotation = glyphStyle === 'scatter'
                            ? d.angle * arrival * glyphStrength
                            : 0;
                        const activePulse = active ? Math.sin(p * Math.PI) * 0.08 : 0;
                        const entryScale = glyphStyle === 'impact' ? arrival * 0.48 : arrival * 0.16;
                        node.scale.set(Math.max(0.28, 1 - entryScale * glyphStrength + activePulse * glyphStrength));
                        node.alpha = time < d.startTime ? amount(tuning.waitingOpacity, 0.25, 1) : 1;
                        node.tint = active && tuning.textInversion !== false ? nextColor : ink;
                    });

                    const cueSeed = `${mode}:${seed}`;
                    const accentEnabled = entry.lineIndex === activeIndex
                        && tuning.accentEffects !== false
                        && tuning.showDecor !== false
                        && glyphStrength > 0
                        && accentCues(frame.lines, cueSeed).has(activeIndex);
                    const accent = entry.accent;
                    accent.layer.visible = accentEnabled;
                    if (accentEnabled && mode === 'tempera' && accent.pen) {
                        const age = time - entry.line.startTime + 0.12;
                        const route = clamp(age / 1.2) * 4;
                        const side = Math.min(3, Math.floor(route));
                        const local = route - side;
                        const a = accent.corners[side];
                        const b = accent.corners[side + 1];
                        accent.pen.position.set(
                            a[0] + (b[0] - a[0]) * local,
                            a[1] + (b[1] - a[1]) * local
                        );
                        accent.pen.rotation = Math.PI / 4;
                        accent.pen.alpha = ease(age / 0.1) * (1 - ease((age - 1.25) / 0.35));
                        const draw = clamp(age / 1.2) * accent.segments.length;
                        accent.segments.forEach((segmentNode, segmentIndex) => {
                            const head = draw - segmentIndex;
                            const tail = ease((age - 1.55 - segmentIndex * 0.008) / 0.65);
                            segmentNode.alpha = head < 0 ? 0
                                : (0.28 + Math.exp(-head * 0.7) * 0.72) * (1 - tail);
                        });
                    } else if (accentEnabled && mode === 'sonnet') {
                        accent.particles.forEach(particle => {
                            const d = particle.target.dataset;
                            const arrivalTime = d.startTime + Math.min(0.12, (d.endTime - d.startTime) * 0.3);
                            const duration = Math.min(1.45, Math.max(0.35, arrivalTime - entry.line.startTime));
                            const travel = (time - arrivalTime + duration) / duration;
                            const armBudget = tuning.quality === 'ultimate' ? 4
                                : tuning.quality === 'energy-saving' ? 2 : 3;
                            particle.trail.forEach((dot, dotIndex) => {
                                const u = travel - dotIndex * 0.018;
                                dot.visible = particle.arm < armBudget && u >= 0 && u <= 1
                                    && (tuning.quality !== 'energy-saving' || dotIndex < 8);
                                if (!dot.visible) return;
                                const turn = (1 - u) * Math.PI * 2.35;
                                const radius = (1 - ease(u)) * particle.reach * Math.min(1.5, glyphStrength);
                                dot.position.set(
                                    d.baseX + Math.cos(particle.angle + turn * particle.direction) * radius,
                                    d.baseY + Math.sin(particle.angle + turn * particle.direction) * radius * 0.84
                                );
                                dot.alpha = ease(u / 0.08) * (1 - dotIndex / particle.trail.length)
                                    * (particle.arm ? 0.55 : 0.85);
                            });
                        });
                    }
                });

                const point = layout[activeIndex];
                const hasNext = activeIndex + 1 < layout.length;
                const next = hasNext ? layout[activeIndex + 1] : point;
                const lookAhead = amount(tuning.trackLookAhead, 0.38, 1);
                const lineProgress = ease(frame.lineProgress || 0);
                const axisSpan = (point.vertical ? height : width) * 0.13;
                const readingX = point.x + (point.vertical ? 0 : axisSpan * (lineProgress * 2 - 1));
                const readingY = point.y + (point.vertical ? axisSpan * (lineProgress * 2 - 1) : 0);
                const nextSpan = (next.vertical ? height : width) * 0.13;
                const nextStartX = next.x + (next.vertical ? 0 : -nextSpan);
                const nextStartY = next.y + (next.vertical ? -nextSpan : 0);
                const junctionDuration = 0.18 + lookAhead * 0.42;
                const junctionProgress = hasNext
                    ? ease((lineProgress - (1 - junctionDuration)) / junctionDuration)
                    : 0;
                const focusX = readingX + (nextStartX - readingX) * junctionProgress;
                const focusY = readingY + (nextStartY - readingY) * junctionProgress;
                const tracking = amount(tuning.cameraTracking, 0.35, 1);
                const breath = Math.sin(time * 0.43) * 0.012 * amount(tuning.cameraBreath, 0.5) * motion;
                return {
                    x: focusX,
                    y: focusY,
                    scale: 1.02 + tracking * 0.08 + breath,
                    rotation: -point.rotation * amount(tuning.cameraRoll, 0.25, 1) * motion,
                    glyphs
                };
            },
            destroy() {
                release();
                root.removeFromParent();
                root.destroy({ children: true });
                source = null;
                layout = [];
            },
            snapshot() {
                return {
                    trackEntries: entries.length,
                    trackGlyphs: glyphs.length,
                    trackActive: activeIndex,
                    trackAccentObjects: entries.reduce((total, entry) => total
                        + entry.accent.segments.length
                        + entry.accent.particles.reduce((sum, particle) => sum + particle.trail.length, 0), 0),
                    trackAccentVisible: entries.some(entry => entry.accent.layer.visible)
                };
            }
        };
    };

    const createRetirement = (PIXI, stage) => {
        let layer = null, born = 0, lastFrame = null, lastTuning = null, outgoingLine = null;
        const release = () => {
            if (layer) { layer.removeFromParent(); layer.destroy({ children: true }); layer = null; }
        };
        return {
            capture(containers, scene, nextLine) {
                release();
                const frame = lastFrame, tuning = lastTuning;
                if (!frame?.isPlaying || !nextLine || !frame.activeLine
                    || nextLine === frame.activeLine || !motionScale(tuning)
                    || tuning.sceneTransitions === false || tuning.quality === 'energy-saving'
                    || nextLine.startTime < frame.playbackTime
                    || nextLine.startTime - frame.playbackTime > 0.2) return;
                layer = new PIXI.Container();
                layer.position.copyFrom(scene.position);
                layer.pivot.copyFrom(scene.pivot);
                layer.scale.copyFrom(scene.scale);
                layer.rotation = scene.rotation;
                for (const container of containers) {
                    if (!container.visible) continue;
                    const copy = new PIXI.Container();
                    copy.position.copyFrom(container.position);
                    copy.pivot.copyFrom(container.pivot);
                    copy.scale.copyFrom(container.scale);
                    copy.rotation = container.rotation;
                    copy.alpha = container.alpha;
                    for (const child of container.removeChildren()) copy.addChild(child);
                    layer.addChild(copy);
                }
                stage.addChildAt(layer, 0);
                born = nextLine.startTime;
                outgoingLine = nextLine;
            },
            update(frame, tuning) {
                if (layer) {
                    const elapsed = frame.playbackTime - born;
                    const changedTrack = lastFrame && (frame.track?.path || frame.track?.title || '')
                        !== (lastFrame.track?.path || lastFrame.track?.title || '');
                    const jumped = lastFrame && (frame.playbackTime - lastFrame.playbackTime > 0.5
                        || frame.playbackTime < lastFrame.playbackTime - 0.025);
                    if (elapsed < 0 || elapsed >= 0.6 || frame.activeLine !== outgoingLine || changedTrack || jumped
                        || !motionScale(tuning) || tuning.sceneTransitions === false
                        || tuning.quality === 'energy-saving') release();
                    else {
                        const p = ease(elapsed / 0.6);
                        layer.alpha = (1 - p) * 0.7;
                        // Pose remains absolute, not integrated.
                        layer.skew.x = p * 0.045 * motionScale(tuning);
                    }
                }
                lastFrame = frame;
                lastTuning = tuning;
            },
            snapshot() { return { outgoingLayers: layer ? 1 : 0 }; },
            destroy() { release(); lastFrame = lastTuning = outgoingLine = null; }
        };
    };

    global.MusicStagePixiEffects = Object.freeze({
        createRetirement, createEditorialTrack,
        createPerformance, buildPhraseStage, animatePhraseStage, createAccentChoreography,
        amount, ease, expo, clear, camera, shotKind, glyphTiming, buildLyrics, animateLyrics, motionScale, createPostProcess,
        applyQuality, transition, buildMotif, compilePhrases
    });
})(window);