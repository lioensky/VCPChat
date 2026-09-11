/*
 * Folia Classic / Partita / Cadenza visual language, native playback-clock port.
 * Copyright upstream Folia contributors; adaptation licensed AGPL-3.0.
 * No independent ticker, worker, or wall-clock animation is created here.
 */
(function (global) {
    'use strict';
    const U = global.MusicStageModeUtils;
    const L = global.MusicStageLyricLayout;
    const { clamp, createElement: el, seededRandom } = U;
    const { number } = L;
    const ease = value => 1 - Math.pow(1 - clamp(value), 3);
    // Unit mass, stiffness 200, damping 20: analytic underdamped step response.
    const spring = seconds => seconds <= 0 ? 0 : 1 - Math.exp(-10 * seconds) * (Math.cos(10 * seconds) + Math.sin(10 * seconds));
    const lerp = (a, b, t) => a + (b - a) * t;
    const glowPulse = progress => progress <= 0 || progress >= 1 ? 0
        : progress < 0.3 ? ease(progress / 0.3) : (1 - progress) / 0.7;

    const createWord = (token, placement, scene) => {
        const outer = el('div', 'lyric-performance-word');
        const body = el('span', 'lyric-performance-body', token.text);
        const glow = el('span', 'lyric-performance-glow');
        glow.setAttribute('aria-hidden', 'true');
        const glyphs = token.glyphs.map(glyph => {
            const node = el('span', '', glyph.char);
            glow.append(node);
            return node;
        });
        const ripple = el('span', 'lyric-performance-ripple');
        ripple.setAttribute('aria-hidden', 'true');
        outer.append(glow, body, ripple);
        outer.style.fontSize = `${scene.fontSize}px`;
        outer.style.fontFamily = scene.fontFamily;
        outer.style.fontWeight = String(scene.fontWeight);
        outer.style.left = `${placement.x}px`;
        outer.style.top = `${placement.y}px`;
        outer.style.width = `${placement.width}px`;
        const color = token.color || 'var(--performance-accent)';
        outer.style.setProperty('--word-color', color);
        return { outer, body, glyphs, ripple, token, placement };
    };

    const animateWord = (node, scene, time, tuning, intensity, audio) => {
        const { token, placement: p, outer, body, glyphs, ripple } = node;
        const profile = scene.profile;
        const instant = profile.reveal === 'instant';
        const start = token.startTime - profile.lookahead;
        const end = instant ? scene.line.endTime : token.endTime;
        const elapsed = time - start;
        const active = time >= start && time <= end;
        const passed = time > end;
        const enter = instant ? (time >= start ? 1 : 0) : spring(elapsed);
        const release = passed ? ease((time - end) / 0.5) : 0;
        const drift = passed ? ease((time - end) / 5) : 0;
        const motion = intensity * number(tuning.motion, 1);
        const rotation = tuning.wordRotation !== false;
        const baseScale = number(p.scale, 1);
        const activeScale = lerp(1, 1.4, motion);
        const scale = instant ? baseScale : baseScale * lerp(lerp(1, 0.5, motion), activeScale, enter)
            - baseScale * (activeScale - 1) * release;
        const offsetX = number(p.entryX, 0) * (1 - enter) * motion;
        const offsetY = number(p.entryY, 0) * (1 - enter) * motion;
        const float = scene.kind === 'cadenza' ? audio.power * motion : 0;
        const x = offsetX + number(p.driftX, 0) * drift * motion + Math.sin(time * 1.2 + token.index) * float * 4;
        const y = offsetY + number(p.driftY, 0) * drift * motion + Math.cos(time * 1.5 + token.index) * float * 2.5;
        const angle = rotation ? (number(p.rotate, 0) + (instant ? 0 : 20 * (1 - enter))
            + number(p.passedRotate, 0) * drift) * motion : 0;
        outer.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) rotate(${angle.toFixed(2)}deg) scale(${Math.max(0.05, scale).toFixed(4)})`;
        outer.style.opacity = String(elapsed < 0 ? number(tuning.waitingOpacity, 0) : lerp(1, 0.82, release));
        outer.style.zIndex = active ? '3' : '1';
        const blur = instant ? 0 : Math.max(0, 10 * (1 - ease(elapsed / 0.2)));
        body.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
        const mix = time < token.startTime ? 0 : passed
            ? 1 - ease((time - end) / (profile.reveal === 'fast' ? 0.24 : 0.8))
            : instant ? 1 : clamp((time - token.startTime) / Math.max(0.001, end - token.startTime));
        body.style.color = `color-mix(in srgb, var(--word-color) ${(mix * 100).toFixed(2)}%, var(--performance-ink))`;
        const glowAmount = number(tuning.glow, 1);
        const fade = passed ? Math.pow(1 - clamp((time - end) / 0.9), 2) : 1;
        token.glyphs.forEach((glyph, index) => {
            let strength;
            if (instant) strength = glowPulse((time - token.startTime) / 0.067);
            else if (profile.reveal === 'fast') strength = glowPulse((time - token.startTime) / Math.max(0.12, end - token.startTime));
            else if ((token.sourceGlyphCount || token.glyphs.length) > 1) {
                strength = glowPulse((time - glyph.startTime) / Math.max(0.006, (glyph.endTime - glyph.startTime) * 6)) * fade;
            } else {
                strength = time < token.startTime ? 0
                    : passed ? 0.9 * fade : ease((time - token.startTime) / Math.max(0.018, (end - token.startTime) * 0.18));
            }
            glyphs[index].style.opacity = String(clamp(strength * glowAmount, 0, 1));
            glyphs[index].style.textShadow = glowAmount <= 0 ? 'none'
                : `0 0 ${20 * glowAmount}px var(--word-color),0 0 ${40 * glowAmount}px var(--word-color)`;
        });
        const rippleProgress = clamp((time - token.startTime) / 0.5);
        const showRipple = scene.line.isChorus && tuning.chorusRipple !== false && intensity > 0
            && time >= token.startTime && rippleProgress < 1;
        ripple.hidden = !showRipple;
        if (showRipple) {
            ripple.style.opacity = String((1 - rippleProgress) * 0.8);
            ripple.style.transform = `translate(-50%,-50%) scale(${0.2 + rippleProgress * number(p.rippleScale, 2.5)})`;
        }
    };

    const mountScene = (layout, line, kind) => {
        const root = el('div', 'lyric-performance-scene');
        root.setAttribute('aria-label', line.fullText);
        const field = el('div', 'lyric-performance-field');
        field.setAttribute('aria-hidden', 'true');
        field.style.width = `${layout.width}px`;
        field.style.height = `${layout.height}px`;
        root.append(field);
        const scene = {
            ...layout, line, kind, root, field, profile: L.profile(line),
            nodes: [], groups: [], retireAt: null
        };
        if (layout.groups) {
            layout.groups.forEach(group => {
                const wrapper = el('div', 'lyric-performance-chunk');
                wrapper.style.left = `${group.x}px`;
                wrapper.style.top = `${group.y}px`;
                wrapper.style.width = `${group.width}px`;
                wrapper.style.height = `${group.height}px`;
                const guide = el('div', `lyric-performance-guide ${group.side === 'right' ? 'is-right' : ''}`);
                const head = el('span', 'lyric-performance-guide-head');
                guide.append(head);
                wrapper.append(guide);
                field.append(wrapper);
                scene.groups.push({ ...group, wrapper, guide, head });
                group.placements.forEach(p => {
                    const node = createWord(p.token, p, scene);
                    wrapper.append(node.outer);
                    scene.nodes.push(node);
                });
            });
        } else {
            layout.placements.forEach(p => {
                const node = createWord(p.token, p, scene);
                field.append(node.outer);
                scene.nodes.push(node);
            });
        }
        return scene;
    };

    const renderScene = (scene, frame, tuning, intensity) => {
        const time = frame.playbackTime;
        const profile = scene.profile;
        const enter = profile.enter ? ease((time - scene.line.startTime) / profile.enter) : 1;
        const naturalExit = profile.exit ? clamp((time - profile.exitStart) / profile.exit) : time > profile.end ? 1 : 0;
        const forcedExit = scene.retireAt === null ? 0 : clamp((time - scene.retireAt) / Math.max(0.03, profile.exit));
        const exit = Math.max(naturalExit, forcedExit);
        const transitions = tuning.sceneTransitions !== false && intensity > 0;
        scene.root.style.opacity = String(transitions ? enter * (1 - ease(exit)) : (scene.retireAt === null && time <= profile.end ? 1 : 0));
        scene.root.style.filter = transitions ? `blur(${((1 - enter) * 10 + exit * 20).toFixed(2)}px)` : 'none';
        scene.root.style.transform = `scale(${transitions ? (0.9 + enter * 0.1 + exit * 0.1).toFixed(4) : 1})`;
        const breath = number(tuning.breathing, 1) * intensity * number(tuning.motion, 1);
        const phase = (time % 7) / 7 * Math.PI * 2;
        const floatY = (-Math.sin(phase) * 14 + Math.sin(phase * 2) * 2) * breath;
        scene.field.style.transform = `translate(-50%,-50%) translateY(${floatY.toFixed(2)}px) scale(${number(scene.fitScale, 1) * (1 + Math.sin(phase) * 0.01 * breath)})`;
        scene.groups.forEach(group => {
            const entry = spring(time - group.startTime + profile.lookahead);
            const waiting = time < group.startTime - profile.lookahead;
            group.wrapper.style.opacity = waiting ? '0' : '1';
            group.wrapper.style.transform = `translateX(${((1 - entry) * (group.side === 'left' ? -40 : 40) * intensity).toFixed(2)}px)`;
            group.guide.hidden = tuning.guideLines === false;
            const progress = ease((time - group.startTime + profile.lookahead) / 0.4);
            group.guide.style.transform = `scaleX(${progress})`;
            group.guide.style.opacity = time <= group.endTime ? '0.8' : '0.24';
            const reading = clamp((time - group.startTime) / Math.max(0.001, group.endTime - group.startTime));
            group.head.hidden = tuning.guidePulse === false || waiting || time > group.endTime || intensity <= 0;
            group.head.style.left = `${reading * 100}%`;
            group.head.style.opacity = String(0.45 + clamp(frame.audio.vocal) * 0.55);
        });
        scene.nodes.forEach(node => animateWord(node, scene, time, tuning, intensity, frame.audio));
    };

    const createManager = (id, label, container, services, compile, options = {}) => {
        const mode = U.makeModeBase(id, label, container, services);
        mode.root.classList.add('lyric-performance-mode');
        const viewport = el('div', 'lyric-performance-viewport');
        const subtitle = el('div', 'lyric-performance-subtitle');
        const translation = el('div', 'stage-translation');
        const upcoming = el('div', 'lyric-performance-upcoming');
        const empty = el('div', 'lyric-performance-empty', '等待音乐');
        subtitle.append(translation, upcoming);
        mode.root.append(viewport, subtitle, empty);
        const decor = ['luminous', 'partita', 'cadenza'].includes(id)
            ? global.MusicStageLyricDecor?.create(mode.root, id) : null;
        if (decor) mode.scope.add(() => decor.destroy());
        const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const cache = new Map();
        let scenes = [];
        let latest = null;
        let source = null;
        let trackKey = '';
        let currentLine = null;
        let layoutKey = '';
        let fontEpoch = 0;
        let force = true;
        let pretext = null;
        let loadError = false;
        let lastTime = null;
        let configEpoch = 0;
        let lastPausedKey = '';
        let lastRenderNow = -Infinity;
        let compileError = false;
        const invalidate = () => { force = true; compileError = false; cache.clear(); };
        const clear = () => {
            scenes.forEach(scene => scene.root.remove());
            scenes = [];
            currentLine = null;
        };
        const getTuning = () => ({ ...options.defaults, ...mode.config.modes?.[id] });
        const measure = (text, size, family, weight = 700) => {
            if (!context) return text.length * size * 0.6;
            context.font = `${weight} ${size}px ${family}`;
            return context.measureText(text).width;
        };
        const getLayout = (line, env) => {
            let value = cache.get(line);
            if (!value) {
                try {
                    value = compile(line, env);
                    value.compileError = false;
                } catch (error) {
                    compileError = true;
                    console.error(`[MusicStage:${id}] Layout compilation failed:`, error);
                    value = { width: 1, height: 1, fontSize: 32, fontFamily: env.family, fontWeight: 700, placements: [], compileError: true };
                }
                const placements = value.groups ? value.groups.flatMap(group => group.placements) : value.placements;
                const colors = env.tuning.wordColors;
                if (Array.isArray(colors)) placements.forEach(placement => {
                    const text = placement.token.text.trim();
                    const match = colors.find(entry => typeof entry?.word === 'string' && typeof entry?.color === 'string'
                        && text && (L.cjk.test(text) ? entry.word.includes(text)
                            : entry.word.toLowerCase().split(/\s+/).includes(text.toLowerCase())));
                    if (match && global.CSS?.supports('color', match.color)) {
                        placement.token = { ...placement.token, color: match.color };
                    }
                });
                cache.set(line, value);
                if (cache.size > 8) cache.delete(cache.keys().next().value);
            }
            return value;
        };
        mode.updateFrame = frame => {
            if (mode.destroyed || mode.suspended) return;
            latest = frame;
            const width = Math.max(1, viewport.clientWidth);
            const height = Math.max(1, viewport.clientHeight);
            const tuning = getTuning();
            const motion = reduced?.matches ? 0 : number(mode.config.animationIntensity, 1);
            const nextTrack = frame.track?.path || frame.track?.title || '';
            const changedSource = source !== frame.lines || trackKey !== nextTrack;
            const accent = U.resolveAccent(services.app);
            const pausedKey = `${frame.playbackTime}:${width}:${height}:${configEpoch}:${fontEpoch}:${Boolean(pretext)}:${loadError}:${accent?.r}:${accent?.g}:${accent?.b}`;
            if (!force && !changedSource && !frame.isPlaying && pausedKey === lastPausedKey) return;
            if (!force && !changedSource && frame.isPlaying && mode.config.quality === 'energy-saving'
                && frame.now - lastRenderNow < 1000 / 30) return;
            lastRenderNow = frame.now;
            lastPausedKey = frame.isPlaying ? '' : pausedKey;
            const jumped = lastTime !== null && (frame.playbackTime < lastTime - 0.05 || frame.playbackTime - lastTime > 1);
            lastTime = frame.playbackTime;
            if (changedSource) {
                source = frame.lines;
                trackKey = nextTrack;
                invalidate();
            }
            const family = tuning.fontFamily || '"Segoe UI","Microsoft YaHei",sans-serif';
            const key = JSON.stringify([width, height, family, tuning.fontScale, tuning.widthRatio,
                tuning.wordSpacing, tuning.semanticLayout, tuning.staggerMin, tuning.staggerMax,
                tuning.power, tuning.layoutStyle, tuning.heroEmphasis, tuning.wordColors, motion, fontEpoch, Boolean(pretext)]);
            if (key !== layoutKey) {
                layoutKey = key;
                invalidate();
            }
            mode.root.style.setProperty('--performance-accent', accent
                ? `rgb(${clamp(accent.r, 0, 255)},${clamp(accent.g, 0, 255)},${clamp(accent.b, 0, 255)})`
                : 'var(--stage-accent)');
            decor?.update(frame, tuning, motion);
            const env = { width, height, tuning, motion, family, measure, pretext, trackKey };
            if (force || changedSource || jumped) {
                clear();
                force = false;
            }
            const line = frame.activeLine;
            if (line !== currentLine) {
                scenes = scenes.filter(scene => {
                    if (scene.retireAt !== null) { scene.root.remove(); return false; }
                    scene.retireAt = line?.startTime ?? frame.playbackTime;
                    return true;
                });
                currentLine = line;
                if (line && (!options.pretext || pretext)) {
                    const layout = getLayout(line, env);
                    compileError = Boolean(layout.compileError);
                    const scene = mountScene(layout, line, id);
                    scenes.push(scene);
                    viewport.append(scene.root);
                }
            }
            scenes = scenes.filter(scene => {
                if (scene.retireAt !== null && frame.playbackTime >= scene.retireAt + Math.max(0.03, scene.profile.exit)) {
                    scene.root.remove();
                    return false;
                }
                renderScene(scene, frame, tuning, motion);
                return true;
            });
            const alive = line && scenes.some(scene => scene.line === line && frame.playbackTime <= scene.profile.end);
            empty.hidden = Boolean(alive && scenes.length);
            empty.textContent = options.pretext && !pretext
                ? loadError ? '排版引擎加载失败，请重新进入舞台' : '正在准备空间排版…'
                : compileError ? '歌词排版失败，请查看控制台'
                    : frame.lines.length ? '间奏' : frame.track ? '纯音乐 · 暂无歌词' : '等待音乐';
            if (compileError) empty.hidden = false;
            translation.textContent = tuning.showTranslation === false ? '' : line?.translation || line?.romanization || '';
            upcoming.textContent = tuning.showUpcoming === false ? '' : frame.nextLines[0]?.fullText || '';
            // Preheat only the next line, using the same bounded layout cache.
            const next = frame.nextLines[0];
            if (next && next.startTime - frame.playbackTime < 1.2 && next.startTime > frame.playbackTime
                && (!options.pretext || pretext)) getLayout(next, env);
        };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = config => {
            updateConfig(config);
            configEpoch += 1;
            lastRenderNow = -Infinity;
            if (latest) mode.updateFrame(latest);
        };
        mode.resize = invalidate;
        mode.updateTheme = invalidate;
        const resume = mode.resume;
        mode.resume = () => { resume(); if (latest) mode.updateFrame(latest); };
        mode.scope.listen(document.fonts, 'loadingdone', () => { fontEpoch += 1; invalidate(); });
        mode.scope.listen(reduced, 'change', invalidate);
        if (options.pretext) {
            L.loadPretext().then(module => {
                if (mode.destroyed) return;
                pretext = module;
                invalidate();
                if (latest) mode.updateFrame(latest);
            }).catch(error => {
                if (mode.destroyed) return;
                loadError = true;
                console.error('[MusicStage] Pretext load failed:', error);
                if (latest) mode.updateFrame(latest);
            });
        }
        mode.getDebugSnapshot = () => ({
            scenes: scenes.length, words: scenes.reduce((sum, scene) => sum + scene.nodes.length, 0),
            layoutCache: cache.size, suspended: mode.suspended, pretextReady: Boolean(pretext)
        });
        mode.scope.add(() => {
            clear();
            cache.clear();
            latest = source = pretext = null;
            canvas.width = canvas.height = 1;
        });
        return mode;
    };
    global.MusicStageLyricPerformance = Object.freeze({ createManager, spring, ease, seededRandom });
})(window);