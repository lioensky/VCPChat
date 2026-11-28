/* Mode registry and Starborn director. Individual renderers live in modes/. */
(function (global) {
    'use strict';
    const U = global.MusicStageModeUtils;
    if (!U) throw new Error('MusicStageModeUtils must load before music-stage-modes.js');
    const { seededRandom, hashString, splitGraphemes, createElement, makeModeBase, getLineKey } = U;
    const core = [
        { id: 'luminous', label: '流光', manager: global.MusicStageLuminousManager },
        { id: 'partita', label: '云阶', manager: global.MusicStagePartitaManager },
        { id: 'cadenza', label: '心象', manager: global.MusicStageCadenzaManager }
    ];
    const NO_TRAITS = Object.freeze({ scene3d: false, opaque: false, night: false });
    const registry = new Map();
    core.forEach(({ id, label, manager }) => {
        if (!manager?.create) throw new Error(`Music stage manager missing: ${id}`);
        registry.set(id, { id, label, traits: NO_TRAITS, create: (container, services) => manager.create(container, services) });
    });
    global.MusicStageAdvancedModes?.entries?.forEach(entry => registry.set(entry.id, entry));

    const STARBORN_CANDIDATE_IDS = Object.freeze([
        'luminous', 'partita', 'cadenza', 'fume', 'tempera', 'sonnet'
    ]);
    // 候选模式在注册表初始化后保持不变，预先过滤避免每次切句重复分配数组
    const STARBORN_IDS = STARBORN_CANDIDATE_IDS.filter(id => registry.has(id));

    const resolveSegment = frame => {
        const current = frame.activeLine;
        const track = frame.track?.path || frame.track?.title || 'unknown-track';
        let lines = [];
        if (current) {
            lines.push(current);
            const nextLines = frame.nextLines;
            for (let i = 0; nextLines && i < nextLines.length; i += 1) {
                const candidate = nextLines[i];
                if (candidate && candidate.fullText.trim()) { lines.push(candidate); break; }
            }
        }
        return {
            key: `${track}:${getLineKey(current)}`,
            lines
        };
    };
    const chooseMode = (frame, segment, previous, recent, config) => {
        // Diorama is deliberately excluded: Starborn crossfades can temporarily
        // own two children, which is unsuitable for concurrent Three/WebGL scenes.
        const ids = STARBORN_IDS;
        const segLines = segment.lines;
        let text = '';
        let words = 0;
        let syllables = 0;
        let duration = 0;
        let translated = false;
        let romanized = false;
        let chorus = false;
        let hintedFast = false;
        for (let i = 0; i < segLines.length; i += 1) {
            const line = segLines[i];
            if (i > 0) text += ' ';
            text += line.fullText;
            const lineWords = line.words;
            if (lineWords && lineWords.length) {
                words += lineWords.length;
                for (let wi = 0; wi < lineWords.length; wi += 1) {
                    const syls = lineWords[wi].syllables;
                    if (syls) syllables += syls.length;
                }
            }
            const span = line.endTime - line.startTime;
            duration += span > 0.2 ? span : 0.2;
            if (!translated && line.translation) translated = true;
            if (!romanized && line.romanization) romanized = true;
            if (!chorus && line.isChorus) chorus = true;
            if (!hintedFast) {
                const reveal = line.renderHints?.wordRevealMode;
                if (reveal === 'fast' || reveal === 'instant') hintedFast = true;
            }
        }
        const graphemes = splitGraphemes(text);
        let chars = 0;
        for (let i = 0; i < graphemes.length; i += 1) {
            if (graphemes[i].trim()) chars += 1;
        }
        let marks = 0;
        for (let i = 0; i < text.length; i += 1) {
            const c = text.charCodeAt(i);
            if (c === 33 || c === 63 || c === 0xff01 || c === 0xff1f || c === 0x2026 || c === 0x2014) marks += 1;
        }
        const random = seededRandom(`starborn:${segment.key}`);
        const scores = {
            luminous: random() * 0.42 + frame.audio.vocal * 1.05 + frame.audio.bass * 0.72
                + (chorus ? 0.5 : 0) + Math.min(0.4, syllables * 0.025),
            partita: random() * 0.42 + Math.min(1.4, words / Math.max(1, duration) * 0.48)
                + Math.min(0.7, words * 0.035) + (syllables ? 0.18 : 0),
            cadenza: random() * 0.42 + marks * 0.28 + (1 - frame.audio.power) * 0.66
                + (romanized && translated ? 0.2 : 0),
            fume: random() * 0.42 + Math.min(1.15, chars / 34)
                + (translated ? 0.32 : 0) + (romanized ? 0.2 : 0),
            tempera: random() * 0.42 + frame.audio.bass * 0.95 + frame.audio.power * 0.65
                + (chorus ? 0.36 : 0) + (hintedFast ? 0.28 : 0),
            sonnet: random() * 0.42 + frame.audio.vocal * 0.72 + marks * 0.22
                + Math.min(0.52, chars / 48) + (hintedFast ? 0.2 : 0)
        };
        if (chars <= 18) scores.luminous += 0.48;
        if (chars >= 34) scores.fume += 0.58;
        if (words >= 10) scores.partita += 0.42;
        if (marks >= 2) scores.cadenza += 0.38;
        if (frame.audio.bass > 0.55) scores.tempera += 0.35;
        if (chars >= 20 && chars <= 42) scores.sonnet += 0.28;
        scores[ids[hashString(segment.key) % ids.length]] += 0.44;
        const avoid = config.modes?.starborn?.avoidRepeat !== false;
        if (avoid) {
            for (let i = 0; i < recent.length; i += 1) {
                const rid = recent[i];
                if (scores[rid] !== undefined) scores[rid] -= i === 0 ? 0.72 : 0.34;
            }
        }
        let bestId = '';
        let bestScore = -Infinity;
        for (let i = 0; i < ids.length; i += 1) {
            const id = ids[i];
            if (avoid && id === previous) continue;
            const sc = scores[id];
            if (sc > bestScore) { bestScore = sc; bestId = id; }
        }
        if (!bestId) {
            for (let i = 0; i < ids.length; i += 1) {
                const id = ids[i];
                const sc = scores[id];
                if (sc > bestScore) { bestScore = sc; bestId = id; }
            }
        }
        return registry.get(bestId);
    };

    const createStarborn = (container, services) => {
        const mode = makeModeBase('starborn', '星诞', container, services);
        const cue = createElement('div', 'starborn-director-cue');
        const burst = createElement('div', 'starborn-transition-burst');
        // The small star cluster reads the vocal level; as an element of its own
        // it takes that level without restyling the performances beside it.
        const star = createElement('div', 'starborn-star');
        cue.setAttribute('aria-hidden', 'true');
        burst.setAttribute('aria-hidden', 'true');
        star.setAttribute('aria-hidden', 'true');
        mode.root.append(cue, burst, star);
        const children = new Set();
        const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let current = null;
        let segmentKey = '';
        let observedLine = null;
        let protectedUntil = -Infinity;
        let track = '';
        let source = null;
        let lastTransition = -Infinity;
        let lastTime = null;
        let count = 0;
        let latest = null;
        const recent = [];
        const release = child => {
            if (!child || !children.delete(child)) return;
            child.mode.destroy();
            child.layer.remove();
        };
        const clear = () => {
            for (const child of children) release(child);
            current = null;
        };
        const mount = (entry, frame) => {
            // A retiring instance is still owned and always destroyed, including
            // exits during crossfade; no cancellation can bypass its disposer.
            for (const child of children) { if (child !== current) release(child); }
            if (current) current.retireAt = frame.playbackTime;
            const layer = createElement('div', 'starborn-performance-layer');
            layer.style.transition = 'none';
            layer.dataset.directedMode = entry.id;
            mode.root.append(layer);
            current = {
                layer, retireAt: null, born: frame.playbackTime - (frame.isPlaying ? 0 : 0.52), id: entry.id,
                mode: entry.create(layer, { ...services, config: mode.config })
            };
            children.add(current);
            count += 1;
            recent.unshift(entry.id);
            recent.splice(2);
            cue.textContent = `星诞 · ${String(count).padStart(2, '0')} / ${entry.label}`;
            mode.root.dataset.directedMode = entry.id;
            mode.root.dataset.transitionCount = String(count);
            lastTransition = frame.playbackTime;
        };
        mode.updateFrame = frame => {
            if (mode.destroyed || mode.suspended) return;
            latest = frame;
            const line = frame.activeLine;
            const nextTrack = frame.track?.path || frame.track?.title || '';
            const nextSegKey = `${nextTrack || 'unknown-track'}:${getLineKey(line)}`;
            const trackChanged = track !== nextTrack;
            const sourceChanged = source !== frame.lines;
            const previousTime = lastTime;
            const backward = previousTime !== null && frame.playbackTime < previousTime - 0.05;
            const jumpedForward = previousTime !== null && frame.playbackTime - previousTime > 0.5;
            lastTime = frame.playbackTime;
            track = nextTrack;
            source = frame.lines;
            if (trackChanged) {
                clear();
                segmentKey = '';
                observedLine = null;
                protectedUntil = -Infinity;
                recent.length = 0;
                lastTransition = -Infinity;
            } else if (backward || jumpedForward || sourceChanged) {
                // A clock correction, seek, or refreshed lyric array is not a
                // musical cut. Keep the renderer and synchronize its new frame.
                // Discard outgoing layers whose old timestamps no longer apply.
                for (const child of children) { if (child !== current) release(child); }
                if (current) current.born = frame.playbackTime - 0.52;
                if (backward) lastTransition = frame.playbackTime;
                segmentKey = nextSegKey;
                observedLine = null;
                protectedUntil = -Infinity;
            }
            const lineChanged = nextSegKey !== segmentKey;
            segmentKey = nextSegKey;
            const lock = mode.config.modes?.starborn?.transitionLock ?? 4;
            // Cold start may mount mid-line. All subsequent automatic cuts must
            // occur at a fresh line boundary, never when a deferred lock expires.
            const atBoundary = line && frame.playbackTime >= line.startTime
                && frame.playbackTime - line.startTime <= 0.12;
            const canCut = lineChanged && frame.isPlaying && atBoundary
                && line.fullText.trim()
                && !backward && !jumpedForward
                && frame.playbackTime - lastTransition >= lock
                && line.startTime >= protectedUntil - 0.001;
            if (!current || canCut) {
                const segment = resolveSegment(frame);
                mount(chooseMode(frame, segment, current?.id, recent, mode.config), frame);
            }
            if (line && observedLine !== line) {
                observedLine = line;
                // Runtime already resolves words, fallback glyphs and nested
                // syllables into one authoritative vocal boundary.
                protectedUntil = Math.max(
                    protectedUntil,
                    line.vocalEndTime ?? line.endTime
                );
            }
            const duration = global.MusicStageRuntime.isReducedMotion(reduced) ? 0.001 : 0.52;
            const lowPower = mode.config?.quality === 'energy-saving';
            for (const child of children) {
                const retired = child.retireAt !== null;
                const elapsed = frame.playbackTime - (retired ? child.retireAt : child.born);
                if (retired && elapsed >= duration) { release(child); continue; }
                const progress = Math.max(0, Math.min(1, elapsed / duration));
                const rawOp = retired ? 1 - progress : progress;
                const nextOp = rawOp <= 0 ? '0' : rawOp >= 1 ? '1' : rawOp.toFixed(3);
                if (child._op !== nextOp) { child._op = nextOp; child.layer.style.opacity = nextOp; }
                // A settled layer needs no filter: blur(0) is drawn the same,
                // but still costs a whole-stage offscreen pass every frame.
                const blur = lowPower ? 0 : (retired ? progress : 1 - progress) * 12;
                const nextFilter = blur > 0.05 ? `blur(${blur.toFixed(1)}px)` : 'none';
                if (child._filter !== nextFilter) { child._filter = nextFilter; child.layer.style.filter = nextFilter; }
                child.mode.updateFrame(frame);
            }
        };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = config => {
            updateConfig(config);
            children.forEach(child => child.mode.updateConfig?.(config));
        };
        mode.resize = viewport => children.forEach(child => child.mode.resize?.(viewport));
        mode.updateTheme = theme => children.forEach(child => child.mode.updateTheme?.(theme));
        const suspend = mode.suspend;
        const resume = mode.resume;
        mode.suspend = () => { suspend(); children.forEach(child => child.mode.suspend?.()); };
        mode.resume = () => {
            resume();
            children.forEach(child => child.mode.resume?.());
            if (latest) mode.updateFrame(latest);
        };
        mode.getDebugSnapshot = () => ({
            children: children.size, directedMode: current?.id || null,
            transitionCount: count, lastTransition, protectedUntil,
            transitionPolicy: 'fresh-line-boundary',
            candidateModes: STARBORN_CANDIDATE_IDS.slice(),
            excludesWebGLModes: true,
            child: current?.mode.getDebugSnapshot?.() || null
        });
        mode.scope.add(() => { clear(); latest = source = observedLine = null; });
        return mode;
    };
    registry.set('starborn', { id: 'starborn', label: '星诞', create: createStarborn });
    global.MusicStageModes = Object.freeze({
        ids: Object.freeze(Array.from(registry.keys())),
        entries: Object.freeze(Array.from(registry.values())),
        get(id) { return registry.get(id) || registry.get('luminous'); },
        // 模式的外观特性（见 music-stage-advanced-modes.js）；不认识的 id 一律当普通 2D 模式
        traits(id) { return registry.get(id)?.traits || NO_TRAITS; },
        create(id, container, services) { return this.get(id).create(container, services); }
    });
})(window);