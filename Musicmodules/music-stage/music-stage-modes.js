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
    const registry = new Map();
    core.forEach(({ id, label, manager }) => {
        if (!manager?.create) throw new Error(`Music stage manager missing: ${id}`);
        registry.set(id, { id, label, create: (container, services) => manager.create(container, services) });
    });
    global.MusicStageAdvancedModes?.entries?.forEach(entry => registry.set(entry.id, entry));

    const resolveSegment = frame => {
        const current = frame.activeLine;
        const track = frame.track?.path || frame.track?.title || 'unknown-track';
        return {
            key: `${track}:${getLineKey(current)}`,
            lines: current ? [current, frame.nextLines.find(line => line.fullText.trim())].filter(Boolean) : []
        };
    };
    const chooseMode = (frame, segment, previous, recent, config) => {
        const ids = ['luminous', 'partita', 'cadenza', 'fume'].filter(id => registry.has(id));
        const text = segment.lines.map(line => line.fullText).join(' ');
        const chars = splitGraphemes(text).filter(char => char.trim()).length;
        const words = segment.lines.reduce((sum, line) => sum + (line.words?.length || 0), 0);
        const duration = segment.lines.reduce((sum, line) => sum + Math.max(0.2, line.endTime - line.startTime), 0);
        const translated = segment.lines.some(line => line.translation);
        const marks = (text.match(/[!?！？…—]/g) || []).length;
        const random = seededRandom(`starborn:${segment.key}`);
        const scores = {
            luminous: random() * 0.42 + frame.audio.vocal * 1.05 + frame.audio.bass * 0.72,
            partita: random() * 0.42 + Math.min(1.4, words / Math.max(1, duration) * 0.48) + Math.min(0.7, words * 0.035),
            cadenza: random() * 0.42 + marks * 0.28 + (1 - frame.audio.power) * 0.66,
            fume: random() * 0.42 + Math.min(1.15, chars / 34) + (translated ? 0.48 : 0)
        };
        if (chars <= 18) scores.luminous += 0.48;
        if (chars >= 34) scores.fume += 0.58;
        if (words >= 10) scores.partita += 0.42;
        if (marks >= 2) scores.cadenza += 0.38;
        scores[ids[hashString(segment.key) % ids.length]] += 0.44;
        const avoid = config.modes?.starborn?.avoidRepeat !== false;
        if (avoid) recent.forEach((id, index) => { if (scores[id] !== undefined) scores[id] -= index === 0 ? 0.72 : 0.34; });
        const candidates = ids.filter(id => !avoid || id !== previous);
        return registry.get((candidates.length ? candidates : ids).sort((a, b) => scores[b] - scores[a])[0]);
    };

    const createStarborn = (container, services) => {
        const mode = makeModeBase('starborn', '星诞', container, services);
        const cue = createElement('div', 'starborn-director-cue');
        const burst = createElement('div', 'starborn-transition-burst');
        cue.setAttribute('aria-hidden', 'true');
        burst.setAttribute('aria-hidden', 'true');
        mode.root.append(cue, burst);
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
            Array.from(children).forEach(release);
            current = null;
        };
        const mount = (entry, frame) => {
            // A retiring instance is still owned and always destroyed, including
            // exits during crossfade; no cancellation can bypass its disposer.
            Array.from(children).forEach(child => { if (child !== current) release(child); });
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
            cue.textContent = `STAR BORN · ${String(count).padStart(2, '0')} / ${entry.label}`;
            mode.root.dataset.directedMode = entry.id;
            mode.root.dataset.transitionCount = String(count);
            lastTransition = frame.playbackTime;
        };
        mode.updateFrame = frame => {
            if (mode.destroyed || mode.suspended) return;
            latest = frame;
            const segment = resolveSegment(frame);
            const nextTrack = frame.track?.path || frame.track?.title || '';
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
                Array.from(children).forEach(child => { if (child !== current) release(child); });
                if (current) current.born = frame.playbackTime - 0.52;
                if (backward) lastTransition = frame.playbackTime;
                segmentKey = segment.key;
                observedLine = null;
                protectedUntil = -Infinity;
            }
            const line = frame.activeLine;
            const lineChanged = segment.key !== segmentKey;
            segmentKey = segment.key;
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
                mount(chooseMode(frame, segment, current?.id, recent, mode.config), frame);
            }
            if (line && observedLine !== line) {
                observedLine = line;
                // Protect every observed overlapping line until its final timed
                // word/syllable ends; line-only lyrics use their declared end.
                let vocalEnd = line.words?.length ? line.startTime : line.endTime;
                (line.words || []).forEach(word => {
                    if (Number.isFinite(word.endTime)) vocalEnd = Math.max(vocalEnd, word.endTime);
                    (word.syllables || []).forEach(syllable => {
                        if (Number.isFinite(syllable.endTime)) vocalEnd = Math.max(vocalEnd, syllable.endTime);
                    });
                });
                protectedUntil = Math.max(protectedUntil, vocalEnd);
            }
            const duration = reduced?.matches ? 0.001 : 0.52;
            children.forEach(child => {
                const retired = child.retireAt !== null;
                const elapsed = frame.playbackTime - (retired ? child.retireAt : child.born);
                if (retired && elapsed >= duration) { release(child); return; }
                const progress = Math.max(0, Math.min(1, elapsed / duration));
                child.layer.style.opacity = String(retired ? 1 - progress : progress);
                child.layer.style.filter = `blur(${(retired ? progress : 1 - progress) * 12}px)`;
                child.mode.updateFrame(frame);
            });
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
        create(id, container, services) { return this.get(id).create(container, services); }
    });
})(window);