(function (global) {
    'use strict';

    const Runtime = global.MusicStageRuntime;
    if (!Runtime) throw new Error('MusicStageRuntime must load before stage-mode-utils.js');

    const { clamp, hashString, seededRandom, splitGraphemes, DisposableScope } = Runtime;

    const createElement = (tag, className = '', text = undefined) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };

    const getLineKey = (line) => line
        ? `${line.index}:${line.startTime}:${line.endTime}:${line.fullText}`
        : 'empty';

    const createWord = (state, index, className = '') => {
        const element = createElement('span', `stage-word ${className}`.trim(), state?.text || '');
        element.dataset.wordIndex = String(index);
        updateWord(element, state, index);
        return element;
    };

    const updateWord = (element, state, index) => {
        if (!element) return;
        const progress = clamp(Number(state?.progress) || 0);
        element.dataset.text = state?.text || element.textContent || '';
        element.style.setProperty('--stage-word-progress', `${(progress * 100).toFixed(2)}%`);
        element.style.setProperty('--stage-word-order', String(index));
        element.classList.toggle('is-active', state?.status === 'active');
        element.classList.toggle('is-passed', state?.status === 'passed');
        element.classList.toggle('is-waiting', state?.status === 'waiting');
    };

    const renderWords = (container, frame, className = '') => {
        const elements = (frame.wordStates || []).map((state, index) => createWord(state, index, className));
        container.replaceChildren(...elements);
        return elements;
    };

    const updateWords = (elements, states) => {
        elements.forEach((element, index) => updateWord(element, states?.[index], index));
    };

    // Resolve CSS colors once per theme change, never in the animation loop.
    // The browser handles variables, named colors, hsl and color-mix for us.
    const refreshTheme = (app, root = document.body) => {
        // Custom stage palettes carry their own light/dark state. In global
        // mode, retain the application's authoritative theme state.
        const stage = root?.closest?.('.music-stage');
        const custom = stage?.classList.contains('stage-theme-custom');
        const light = custom ? stage.classList.contains('stage-theme-light')
            : app?.currentTheme === 'light' || document.body.classList.contains('light-theme');
        const defaults = light
            ? ['#f2efe7', '#fcfaf4', '#1b211f', '#626a66', '#b94832', '#21675c', '#21675c']
            : ['#171a1d', '#20252a', '#f2f0e9', '#a7afb1', '#f2a900', '#76bfae', '#76bfae'];
        defaults.push(...(light
            ? ['#f2efe7', '#e7e1d5', '#d2cbc0', '#b94832']
            : ['#171a1d', '#2a3035', '#3b4449', '#f2a900']));
        const names = ['background', 'surface', 'ink', 'muted', 'accent', 'secondary', 'tertiary',
            'deep', 'material', 'border', 'emission'];
        const variables = ['--primary-bg', '--secondary-bg', '--primary-text', '--secondary-text',
            '--highlight-text', '--success-color', '--quoted-text',
            '--tertiary-bg', '--accent-bg', '--border-color', '--button-bg'];
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
        root.appendChild(probe);
        const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        const palette = { light };
        try {
            names.forEach((name, index) => {
                probe.style.color = `var(${variables[index]}, ${defaults[index]})`;
                let hex = defaults[index];
                if (context?.getImageData) {
                    context.clearRect(0, 0, 1, 1);
                    context.fillStyle = defaults[index];
                    context.fillStyle = global.getComputedStyle(probe).color;
                    context.fillRect(0, 0, 1, 1);
                    const data = context.getImageData(0, 0, 1, 1).data;
                    hex = '#' + Array.from(data).slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
                }
                palette[name] = hex;
            });
        } finally {
            probe.remove();
        }
        const n = parseInt(palette.accent.slice(1), 16);
        palette.accentRgb = Object.freeze({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 });
        app.stagePalette = Object.freeze(palette);
        return app.stagePalette;
    };

    const resolveAccent = (app) => {
        const color = app?.stagePalette?.accentRgb || app?.visualizerColor || { r: 121, g: 216, b: 255 };
        return {
            r: clamp(Number.isFinite(color.r) ? color.r : 121, 0, 255),
            g: clamp(Number.isFinite(color.g) ? color.g : 216, 0, 255),
            b: clamp(Number.isFinite(color.b) ? color.b : 255, 0, 255)
        };
    };

    const makeModeBase = (id, label, container, services) => {
        const scope = new DisposableScope();
        const root = createElement('section', `music-stage-mode music-stage-mode-${id}`);
        root.dataset.mode = id;
        container.appendChild(root);
        let config = services?.config || global.MusicStageConfig?.get?.() || {};
        let destroyed = false;
        let suspended = false;

        return {
            id,
            label,
            root,
            scope,
            services,
            get config() { return config; },
            get suspended() { return suspended; },
            get destroyed() { return destroyed; },
            updateConfig(next) { config = next || config; },
            activate() { suspended = false; },
            suspend() { suspended = true; },
            resume() { suspended = false; },
            updateTheme() {},
            resize() {},
            updateTrack() {},
            updateLyrics() {},
            destroy() {
                if (destroyed) return;
                destroyed = true;
                scope.destroy();
                root.replaceChildren();
                root.remove();
            }
        };
    };

    /*
     * How large a 3D mode draws. A device pixel ratio cap alone lets a
     * maximised window on a 4K screen shade eight million pixels a frame,
     * several times over once reflections and post-processing are added; the
     * drawing buffer is held to a pixel budget instead, and steps down further
     * while the frame rate is not being held.
     */
    const PIXEL_BUDGET = Object.freeze({ 'energy-saving': 1.0e6, standard: 2.4e6, ultimate: 4.2e6 });
    const RATIO_CAP = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    /*
     * When the frame rate is not being held, a 3D mode steps down a rung at a
     * time: first fewer pixels, then the next lower tier (ultimate drops its
     * multisampling; standard drops the lens and caps at 30 frames), then
     * fewer pixels again. The lyrics are in the scene, so the picture is not
     * shrunk all the way before the effects go. Pixels come back, one rung at
     * a time, after a long steady stretch, waiting twice as long each time.
     */
    const TIER_ORDER = ['ultimate', 'standard', 'energy-saving'];
    const LADDER = ['scale', 'scale', 'tier', 'scale', 'scale', 'tier'];
    const SCALE_STEP = 0.84;
    const createRenderScale = () => {
        let rung = 0;
        let last = 0;
        let average = 0;
        let frames = 0;
        let steady = 0;
        let patience = 900;
        let longRun = 0, strikes = 0;
        let derivedFrom = null, derived = null, derivedDrop = 0;
        const taken = () => LADDER.slice(0, rung);
        const scaleSteps = () => taken().filter(step => step === 'scale').length;
        const tierDrops = () => taken().filter(step => step === 'tier').length;
        return {
            get factor() { return Math.max(0.55, SCALE_STEP ** scaleSteps()); },
            // How many rungs down the ladder this mode has gone, for the settings.
            get steps() { return rung; },
            // The tier this mode draws at: the chosen one, less what it had to drop.
            quality(quality) {
                const drops = tierDrops();
                if (!drops) return quality;
                const from = Math.max(0, TIER_ORDER.indexOf(quality));
                return TIER_ORDER[Math.min(TIER_ORDER.length - 1, from + drops)];
            },
            // The configuration with that tier, the same object while nothing changes.
            config(config) {
                const drops = tierDrops();
                if (!drops || !config) return config;
                if (derivedFrom !== config || derivedDrop !== drops) {
                    derivedFrom = config; derivedDrop = drops;
                    derived = { ...config, quality: this.quality(config.quality) };
                }
                return derived;
            },
            ratio(quality, width, height) {
                const budget = PIXEL_BUDGET[quality] || PIXEL_BUDGET.standard;
                const cap = RATIO_CAP[quality] || RATIO_CAP.standard;
                const fit = Math.sqrt(budget / Math.max(1, width * height));
                return Math.max(0.5, Math.min(cap, global.devicePixelRatio || 1, fit) * this.factor);
            },
            // Start again from the top, e.g. after the listener chose a tier.
            reset() { rung = 0; frames = 0; steady = 0; patience = 900; strikes = 0; },
            // Feed the time of every drawn frame, and the interval the frame
            // cap aims for. Returns true when the drawing changed.
            tick(now, aim = 0) {
                let interval = now - last;
                last = now;
                if (!(interval > 0) || interval > 2000) { frames = 0; longRun = 0; return false; }
                // One long frame is a seek or a rebuild, not a slow renderer;
                // several in a row (a machine managing a few frames a second) are.
                if (interval > 250) {
                    longRun += 1;
                    if (longRun < 3) { frames = 0; return false; }
                    interval = 250;
                } else longRun = 0;
                average = frames ? average * 0.92 + interval * 0.08 : interval;
                frames += 1;
                // Enough frames to judge: 45, or one and a half seconds at a few a second.
                if (frames < 45 && frames * average < 1500) return false;
                // Slow means well behind the cap, or under about 43 frames a second without one.
                const slow = Math.max(23, aim * 1.3);
                const fast = Math.max(17.6, aim * 1.08);
                if (average > slow && rung < LADDER.length) {
                    frames = 0; steady = 0;
                    // A tier drop does not come back by itself, so a moment of
                    // load (a song change, another app busy) must not cause it:
                    // it takes two slow judgements in a row.
                    if (LADDER[rung] === 'tier' && ++strikes < 2) return false;
                    strikes = 0;
                    rung += 1;
                    return true;
                }
                strikes = 0;
                // A dropped tier caps the frame rate lower, so the frame times can no
                // longer show whether it would cope: it stays down until the
                // listener picks a tier again (reset).
                if (rung > 0 && LADDER[rung - 1] === 'scale' && average < fast) {
                    steady += 1;
                    if (steady > patience) {
                        // Try the rung above again, and wait longer before the next try.
                        rung -= 1;
                        patience *= 2; frames = 0; steady = 0;
                        return true;
                    }
                } else steady = 0;
                return false;
            }
        };
    };

    /*
     * What each quality tier asks of the GPU, in one place so both 3D modes
     * agree. The canvas itself is only antialiased when nothing is drawn over
     * it afterwards: with the lens on, the scene is drawn into its own target
     * and the canvas's multisampled buffer would only cost memory and a resolve.
     */
    const TIERS = Object.freeze({
        'energy-saving': Object.freeze({ fps: 30, lens: false, samples: 0 }),
        standard: Object.freeze({ fps: 60, lens: true, samples: 0 }),
        ultimate: Object.freeze({ fps: 0, lens: true, samples: 4 })
    });
    const tier = (quality) => TIERS[quality] || TIERS.standard;

    /*
     * Draws at most the tier's frame rate. A 120 or 144 Hz display would
     * otherwise have the stage drawn twice as often as anyone can follow a
     * camera move, at twice the power. Returns true when this frame is drawn.
     */
    // The player's duration comes from polling and can wobble by a few
    // milliseconds; only a real change is worth rebuilding the whole song for.
    const durationChanged = (compiled, next) =>
        Number.isFinite(compiled) && Number.isFinite(next) ? Math.abs(compiled - next) > 0.5 : !Object.is(compiled, next);

    /*
     * A paused stage draws the same picture every frame: the clock stands
     * still and the spectrum settles to zero. The host keeps calling every
     * frame, so a mode that redraws regardless keeps the GPU busy on a still
     * image. same() is true when this frame's inputs equal those of the frame
     * last drawn; anything else that changes the picture (settings, theme,
     * size) is passed in extra or calls invalidate().
     */
    const createStillGate = () => {
        let key = null, lines = null;
        return {
            same(frame, extra = '') {
                if (frame.isPlaying) { key = null; return false; }
                const audio = frame.audio || {};
                const spectrum = audio.spectrum || [];
                let sum = 0;
                for (let i = 0; i < spectrum.length; i += 1) sum += Number(spectrum[i]) || 0;
                const next = `${frame.playbackTime}|${frame.track?.path || frame.track?.title || ''}|${frame.currentLineIndex}`
                    + `|${audio.power}|${audio.bass}|${audio.lowMid}|${audio.mid}|${audio.vocal}|${audio.treble}|${sum}`
                    + `|${global.devicePixelRatio || 1}|${extra}`;
                if (next === key && frame.lines === lines) return true;
                key = next;
                lines = frame.lines;
                return false;
            },
            invalidate() { key = null; }
        };
    };

    const createFrameCap = () => {
        let last = -Infinity;
        return {
            aim(quality) { const fps = tier(quality).fps; return fps ? 1000 / fps : 0; },
            take(now, quality) {
                const aim = this.aim(quality);
                // A little early is still this frame: display intervals jitter.
                if (aim && now - last < aim - 3) return false;
                last = aim && now - last < aim * 2 ? last + aim : now;
                return true;
            },
            reset() { last = -Infinity; }
        };
    };

    /*
     * Compile every material in the scene, visible or not, before the first
     * frame. Otherwise each effect compiles its shaders the first time it
     * appears, and on Windows that stalls the frame for tens to hundreds of
     * milliseconds right at the chorus. A material drawn into an offscreen
     * target (the lens, the water) compiles differently from one drawn to the
     * canvas, so it is compiled for each place the frame will draw it.
     */
    /*
     * Compile what the scene draws and wait until the driver has linked it.
     * The renderer's own wait throws from a timer once the renderer has been
     * disposed (a stage left before its warm-up finished); this one just stops.
     */
    const compileReady = (renderer, scene, camera) => {
        if (!renderer.compileAsync || !renderer.properties) {
            renderer.compile(scene, camera);
            return Promise.resolve();
        }
        const waiting = renderer.compile(scene, camera);
        return new Promise((resolve) => {
            const check = () => {
                try {
                    for (const material of waiting) {
                        const program = renderer.properties.get(material)?.currentProgram;
                        if (!program || program.isReady()) waiting.delete(material);
                    }
                } catch {
                    waiting.clear();
                }
                if (!waiting.size) resolve();
                else setTimeout(check, 10);
            };
            check();
        });
    };

    const precompile = async (T, renderer, scene, camera, { canvas = true, offscreen = true, report = true } = {}) => {
        const previous = renderer.getRenderTarget();
        const probe = offscreen ? new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType }) : null;
        try {
            for (const target of [canvas ? null : undefined, probe || undefined]) {
                if (target === undefined) continue;
                renderer.setRenderTarget(target);
                await compileReady(renderer, scene, camera);
            }
        } catch (error) {
            console.warn('[MusicStage] shader warm-up skipped:', error);
        } finally {
            renderer.setRenderTarget(previous);
            probe?.dispose();
        }
        if (report) await settlePrograms(renderer);
    };

    /*
     * Shader errors are not checked per program (that waits on the GPU
     * process every time), so look once, after the warm-up, and say which
     * program the driver refused and why.
     *
     * A driver without background compiling links a program the first time
     * anything asks about it: here, or else in the first frame, which then
     * asks about every program at once and stalls for the whole lot. So each
     * program is asked here, and its uniform table read the way the first
     * draw would, a slice at a time with a frame in between. With background
     * compiling every program is ready by now and this costs nothing.
     */
    const settlePrograms = async (renderer, alive = () => true, budget = 24) => {
        let started = global.performance?.now?.() ?? Date.now();
        const seen = new Set();
        try {
            for (const entry of [...(renderer.info?.programs || [])]) {
                if (!alive()) return;
                const gl = renderer.getContext?.();
                if (!gl || gl.isContextLost()) {
                    console.warn('[MusicStage] WebGL context lost during shader warm-up');
                    return;
                }
                const program = entry.program;
                if (!program || seen.has(program)) continue;
                seen.add(program);
                if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                    const shaderLog = (shader) => (shader && gl.getShaderInfoLog(shader)) || '';
                    console.error('[MusicStage] shader program failed:', entry.name || entry.type || '',
                        '\nprogram:', gl.getProgramInfoLog(program) || '',
                        '\nvertex:', shaderLog(entry.vertexShader),
                        '\nfragment:', shaderLog(entry.fragmentShader));
                    continue;
                }
                entry.getUniforms?.();
                entry.getAttributes?.();
                const now = global.performance?.now?.() ?? Date.now();
                if (now - started > budget) {
                    await breathe();
                    started = global.performance?.now?.() ?? Date.now();
                }
            }
        } catch (error) {
            console.warn('[MusicStage] shader check skipped:', error);
        }
    };

    /*
     * Once a mode starts down the ladder, its next tier drop may turn the lens
     * off, and every material drawn straight to the canvas is a program of its
     * own. Compile those in the background while the scale rungs are taken,
     * or the drop links them all in one frame, on a machine already behind.
     * Returns true once it has started.
     */
    const warmLensless = (T, renderer, scene, camera, scaler, quality) => {
        if (!renderer || scaler.steps < 1) return false;
        const at = Math.max(0, TIER_ORDER.indexOf(quality));
        const next = TIER_ORDER[Math.min(TIER_ORDER.length - 1, at + 1)];
        if (!tier(quality).lens || tier(next).lens) return false;
        // Without background compiling the driver links them right here, all
        // at once, which is a longer stall than the drop itself would cause.
        if (!renderer.extensions?.has?.('KHR_parallel_shader_compile')) return true;
        precompile(T, renderer, scene, camera, { canvas: true, offscreen: false, report: false });
        return true;
    };

    /*
     * A dissolve for a 3D mode handing over to the next song. The scene can
     * only be read back right after it is drawn, so `capture` is called after
     * each frame drawn while the old song is going; `reveal` then puts the
     * last of those over the new scene and lets it dissolve. One 2D canvas at
     * drawing-buffer size, emptied again once it has faded.
     */
    const createHandoverVeil = (root) => {
        const veil = createElement('canvas', 'stage-handover-veil');
        veil.setAttribute('aria-hidden', 'true');
        veil.width = 1; veil.height = 1;
        root.appendChild(veil);
        let context = null, captured = false, timer = 0, takenAt = -Infinity;
        const empty = () => { veil.width = 1; veil.height = 1; captured = false; takenAt = -Infinity; };
        return {
            get captured() { return captured; },
            // Reading the 3D picture back stalls until the GPU has drawn it, so
            // while a mode is waiting on the next song it keeps one picture a
            // quarter of a second rather than every frame: on the slow sky it
            // looks at by then, nobody can tell the difference.
            capture(source, { every = 250 } = {}) {
                if (!source || !source.width) return;
                const now = global.performance?.now?.() ?? Date.now();
                if (captured && now - takenAt < every
                    && veil.width === source.width && veil.height === source.height) return;
                takenAt = now;
                if (veil.width !== source.width || veil.height !== source.height) {
                    veil.width = source.width; veil.height = source.height;
                    context = null;
                }
                context = context || veil.getContext('2d', { alpha: false });
                if (!context) return;
                try { context.drawImage(source, 0, 0); captured = true; } catch { captured = false; }
            },
            reveal(duration = 900) {
                global.clearTimeout(timer);
                if (!captured) return;
                veil.style.transition = 'none';
                veil.style.opacity = '1';
                veil.classList.add('is-showing');
                void veil.offsetWidth;
                veil.style.transition = `opacity ${duration}ms cubic-bezier(0.33, 0, 0.2, 1)`;
                veil.style.opacity = '0';
                timer = global.setTimeout(() => { veil.classList.remove('is-showing'); empty(); }, duration + 60);
            },
            cancel() { global.clearTimeout(timer); veil.classList.remove('is-showing'); empty(); },
            destroy() { global.clearTimeout(timer); empty(); veil.remove(); }
        };
    };

    /*
     * The stage's track card sits over the top-left of the picture. Where a
     * mode is free to move its words, it keeps them out from under the card.
     * The card's box is read only when it or the stage changes size, never
     * per frame, and handed out in the picture's own -1..1 units (y up).
     */
    const watchOverlay = (root, selector = '.music-stage-id3') => {
        const card = root?.closest?.('.music-stage')?.querySelector?.(selector) || null;
        let box = null;
        const measure = () => {
            box = null;
            if (!card || !root.isConnected) return;
            const view = root.getBoundingClientRect(), r = card.getBoundingClientRect();
            if (!view.width || !view.height || !r.width || !r.height) return;
            if (global.getComputedStyle?.(card)?.display === 'none') return;
            const x = px => (px - view.left) / view.width * 2 - 1;
            const y = px => 1 - (px - view.top) / view.height * 2;
            box = { left: x(r.left), right: x(r.right), top: y(r.top), bottom: y(r.bottom) };
            if (box.right <= -1 || box.left >= 1 || box.bottom >= 1 || box.top <= -1) box = null;
        };
        const observer = card && global.ResizeObserver ? new global.ResizeObserver(measure) : null;
        observer?.observe(card);
        observer?.observe(root);
        return {
            get box() { return box; },
            measure,
            destroy() { observer?.disconnect(); box = null; }
        };
    };

    // 给只用 DOM 排字的舞台：把左上角档案卡的右边、下边（相对舞台的像素）写成
    // --stage-card-right / --stage-card-bottom，CSS 里用 max() 让开；窗口宽时卡片
    // 碰不到内容，这两个值不起作用。只在卡片或舞台改尺寸时量一次。
    const watchCardInset = (root, selector = '.music-stage-id3') => {
        const card = root?.closest?.('.music-stage')?.querySelector?.(selector) || null;
        const measure = () => {
            let right = 0, bottom = 0;
            if (card && root.isConnected && global.getComputedStyle?.(card)?.display !== 'none') {
                const view = root.getBoundingClientRect(), r = card.getBoundingClientRect();
                if (r.width && r.height && r.right > view.left && r.left < view.left + view.width / 2) {
                    right = Math.round(r.right - view.left);
                    bottom = Math.round(r.bottom - view.top);
                }
            }
            root.style.setProperty('--stage-card-right', `${right}px`);
            root.style.setProperty('--stage-card-bottom', `${bottom}px`);
        };
        const observer = card && global.ResizeObserver ? new global.ResizeObserver(measure) : null;
        observer?.observe(card);
        observer?.observe(root);
        measure();
        return { measure, destroy() { observer?.disconnect(); } };
    };

    // The faces a 3D stage can write its lyrics in. Each list starts with the
    // face Windows ships, then the usual macOS and open-source equivalents.
    const LYRIC_FONTS = Object.freeze({
        sans: '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Segoe UI",sans-serif',
        serif: '"SimSun","Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif',
        kai: '"KaiTi","STKaiti","Kaiti SC","AR PL UKai CN",serif'
    });
    const lyricFont = key => LYRIC_FONTS[key] || LYRIC_FONTS.sans;

    // 2D 歌词舞台的字体：随 VCPChat 带的 Noto Sans SC 可变字体（100–900 都有），
    // 没加载到时退回系统黑体。字体按 unicode-range 分片，用到哪些字才下载哪片，
    // 所以要拿整首歌的字去 load；load 完后舞台要把画好的字图作废重画。
    const STAGE_FONT = '"Noto Sans SC Variable","Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif';
    // 一句歌词按词分主次：虚词、标点小一号，最长的实词（一样长取靠后的）大一号，
    // 其余在小范围里浮动；词还上下错开一点（重点词不动，小字错得多）。按种子确定。
    // glyphs 是逐字的数组（每项有 text），返回 [{ from, to, scale, jag, blank }]，from/to 是字下标。
    const FUNCTION_CHARS = new Set(Array.from('的了在把是我你他她它们和与也就都着过吗呢吧啊呀哦被让给从向到这那之而又很'));
    const MINOR_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'me', 'my', 'with', 'and', 'or', 'is', 'i', 'you', 'it', 'by', 'for']);
    const segmenter = (() => { try { return new Intl.Segmenter('zh', { granularity: 'word' }); } catch (_) { return null; } })();
    const wordPlan = (glyphs, seed) => {
        const texts = glyphs.map(g => String(g.text ?? ''));
        const starts = [];
        let offset = 0;
        texts.forEach((t) => { starts.push(offset); offset += t.length; });
        const joined = texts.join('');
        const pieces = segmenter ? [...segmenter.segment(joined)].map(p => ({ at: p.index, len: p.segment.length, word: p.isWordLike }))
            : texts.map((t, i) => ({ at: starts[i], len: t.length, word: /[\p{L}\p{N}]/u.test(t) }));
        const words = [];
        let gi = 0;
        for (const piece of pieces) {
            const from = gi;
            while (gi < texts.length && starts[gi] < piece.at + piece.len) gi += 1;
            if (gi > from) words.push({ from, to: gi, blank: !piece.word, text: texts.slice(from, gi).join('') });
        }
        if (gi < texts.length) words.push({ from: gi, to: texts.length, blank: false, text: texts.slice(gi).join('') });
        const random = seededRandom(`${seed}:words`);
        const minor = w => w.blank || (w.to - w.from === 1 && FUNCTION_CHARS.has(w.text)) || MINOR_WORDS.has(w.text.toLowerCase());
        let key = -1;
        words.forEach((w, i) => { if (!minor(w) && (key < 0 || w.to - w.from >= words[key].to - words[key].from)) key = i; });
        words.forEach((w, i) => {
            const r = random();
            w.scale = w.blank && !w.text.trim() ? 1 : i === key && words.length > 1 ? 1.45 : minor(w) ? 0.62 : 0.85 + r * 0.35;
            w.key = i === key && words.length > 1;
        });
        const jr = seededRandom(`${seed}:jags`);
        words.forEach((w) => { const o = (jr() - 0.5) * 2; w.jag = w.key ? 0 : o * (w.scale < 0.7 ? 0.32 : 0.2); });
        return words;
    };

    const fontLoads = new Map();
    const loadLyricFont = (lines, weights, onLoaded, extra = '') => {
        const fonts = global.document?.fonts;
        if (!fonts?.load) return true;
        const text = [...new Set(splitGraphemes(`${extra}${(lines || []).map(l => `${l?.fullText || l?.original || ''}${l?.translation || ''}`).join('')}`))].join('').slice(0, 4000) || '歌';
        let ready = true;
        const pending = [];
        for (const w of weights) {
            const font = `${w} 32px ${STAGE_FONT}`;
            try { if (fonts.check(font, text)) continue; } catch (_) { continue; }
            ready = false;
            const key = `${font}|${text}`;
            if (!fontLoads.has(key)) fontLoads.set(key, fonts.load(font, text).catch(() => []));
            pending.push(fontLoads.get(key));
        }
        if (!ready && typeof onLoaded === 'function') Promise.all(pending).then(() => onLoaded());
        return ready;
    };

    // The colour a cover is "about": the hue with the most vivid area,
    // averaged over the pixels of that hue. A grey, black or white cover has
    // no such colour and gives null, so the stage keeps its theme's sky.
    const coverColour = (image) => {
        if (!image) return null;
        const size = 32;
        let data;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(image, 0, 0, size, size);
            data = context.getImageData(0, 0, size, size).data;
        } catch (_) { return null; }
        return dominantHue(data);
    };
    const dominantHue = (data) => {
        const BINS = 18;
        const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
        let total = 0, count = 0;
        for (let i = 0; i + 2 < data.length; i += 4) {
            const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const l = (max + min) / 2, d = max - min;
            count++;
            if (d < 0.08) continue;
            const s = d / (1 - Math.abs(2 * l - 1) || 1);
            let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            h = (h * 60 + 360) % 360;
            // Vivid and mid-tone counts; near-black and near-white hardly do.
            const w = s * s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.6);
            const bin = bins[Math.floor(h / (360 / BINS)) % BINS];
            bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
            total += w;
        }
        // Spread each bin over its neighbours so a hue on a bin edge is not split.
        let best = -1, bestW = 0;
        bins.forEach((bin, i) => {
            const w = bin.w + 0.5 * (bins[(i + 1) % BINS].w + bins[(i + BINS - 1) % BINS].w);
            if (w > bestW) { bestW = w; best = i; }
        });
        if (best < 0 || !count || total / count < 0.03) return null;
        const bin = bins[best];
        if (!bin.w) return null;
        const hex = [bin.r, bin.g, bin.b]
            .map(v => Math.round(Math.min(1, v / bin.w) * 255).toString(16).padStart(2, '0')).join('');
        return '#' + hex;
    };

    // A 3D stage's hold on the cover's colour: set() it whenever the song
    // may have changed, settle() it once a drawn frame, and towardHue() any
    // colour to lean it to the cover's hue by the eased weight, keeping
    // that colour's own lightness. Weight and hue both ease over about two
    // seconds of wall-clock time, so a song change glides, never cuts.
    const createCoverTint = (THREE) => {
        const state = { target: null, colour: new THREE.Color(), next: null, weight: 0, aim: 0, at: 0 };
        const coverHsl = {}, toneHsl = {}, scratch = new THREE.Color();
        const close = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 0.003;
        return {
            get weight() { return state.weight; },
            get target() { return state.target; },
            set(hex) {
                const next = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
                if (next === state.target) return;
                state.target = next;
                if (!next) return;
                state.next = new THREE.Color(next);
                // Coming from no colour: start from this one, just faded in.
                if (state.weight < 0.01) state.colour.copy(state.next);
            },
            settle(amount, now) {
                const dt = state.at ? Math.min(0.25, Math.max(0, (now - state.at) / 1000)) : 1;
                state.at = now;
                const k = 1 - Math.exp(-dt * 1.6);
                state.aim = state.target ? clamp(Number(amount) || 0, 0, 1) : 0;
                state.weight += (state.aim - state.weight) * k;
                if (Math.abs(state.aim - state.weight) < 0.002) state.weight = state.aim;
                if (state.target && state.next) {
                    state.colour.lerp(state.next, k);
                    if (close(state.colour, state.next)) state.colour.copy(state.next);
                }
                state.colour.getHSL(coverHsl);
                return state.weight;
            },
            settling: () => Math.abs(state.aim - state.weight) > 0.002
                || Boolean(state.target && state.next && !close(state.colour, state.next)),
            // Mixed straight across, not round the colour wheel: a partial
            // turn from teal toward red would land on green, a hue in
            // neither. Weights near 1 are for what should wear the cover's
            // hue; small ones only warm or cool a colour.
            towardHue(colour, weight, satFloor = 0) {
                if (!(weight > 0)) return colour;
                colour.getHSL(toneHsl);
                scratch.setHSL(coverHsl.h, Math.max(toneHsl.s, coverHsl.s * satFloor), toneHsl.l);
                return colour.lerp(scratch, Math.min(1, weight));
            }
        };
    };

    // Hand the main thread back for a frame between the steps of building a
    // 3D stage, so the curtain's animation keeps moving while it is built.
    // A hidden window has no frames; the timer stands in for one.
    const breathe = () => new Promise((resolve) => {
        let done = false;
        const go = () => { if (!done) { done = true; resolve(); } };
        global.requestAnimationFrame?.(() => global.setTimeout(go, 0));
        global.setTimeout(go, 50);
    });

    // Where the song is, for a stage's small running caption: "03 / 32",
    // or what the stage is waiting through when no line is up yet.
    const lineCounter = (frame, digits = 2) => {
        const count = frame?.lines?.length || 0;
        const index = Number(frame?.currentLineIndex);
        if (!count) return '暂无歌词';
        if (!(index >= 0)) return frame.lyricsEstimated ? '纯文本歌词' : '前奏';
        const pad = value => String(value).padStart(digits, '0');
        return `${pad(Math.min(count, index + 1))} / ${pad(count)}${frame.lyricsEstimated ? ' · 未对时' : ''}`;
    };

    // 只有纯文本歌词（没有时间）时，按字数把它们铺在整首歌上，让靠时间走的舞台也能唱起来。
    // 返回一个新 frame（lines / 当前句 / 进度 / 字的状态都按铺开的时间算），带 lyricsEstimated；
    // 有带时间的歌词、或者也没有纯文本时，原样返回。
    const estimatedCache = new WeakMap();
    const estimateLines = (plain, duration) => {
        const R = global.MusicStageRuntime;
        let byDuration = estimatedCache.get(plain);
        if (!byDuration) { byDuration = new Map(); estimatedCache.set(plain, byDuration); }
        const key = Math.round(duration);
        const hit = byDuration.get(key);
        if (hit) return hit;
        const total = duration > 0 ? duration : Math.max(60, plain.length * 4.5);
        const begin = Math.min(12, total * 0.08);
        const end = Math.max(begin + plain.length, total - Math.min(10, total * 0.06));
        const weights = plain.map(text => Math.max(4, R.splitGraphemes(text.replace(/\s+/g, '')).length));
        const sum = weights.reduce((a, b) => a + b, 0) || 1;
        // 每句占满自己那一段（不留成间奏），字按 0.38 秒一个念出来，最多用掉这一段的七成
        const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
        let t = begin;
        const raw = plain.map((text, i) => {
            const slot = (end - begin) * weights[i] / sum;
            const start = t;
            t += slot;
            const tokens = text.split(/\s+/).filter(Boolean).flatMap(tok => (CJK.test(tok) ? R.splitGraphemes(tok) : [tok]));
            const units = tokens.map(tok => Math.max(1, Math.min(6, R.splitGraphemes(tok).length * (CJK.test(tok) ? 1 : 0.4))));
            const total = units.reduce((a, b) => a + b, 0) || 1;
            const span = Math.min(slot * 0.7, total * 0.38 + 0.4);
            let w = start + 0.1;
            const words = tokens.map((tok, k) => {
                const d = span * units[k] / total;
                const word = { text: tok, startTime: +w.toFixed(3), endTime: +(w + d).toFixed(3) };
                w += d;
                return word;
            });
            return { time: +start.toFixed(3), endTime: +(t - 0.3).toFixed(3), original: text, translation: '', words };
        });
        const lines = R.normalizeLines(raw).filter(line => R.readableText(line.fullText));
        byDuration.clear();
        byDuration.set(key, lines);
        return lines;
    };
    const withPlainLyrics = (frame) => {
        if (!frame || frame.lines?.length || !frame.plainLines?.length || !global.MusicStageRuntime) return frame;
        const R = global.MusicStageRuntime;
        const lines = estimateLines(frame.plainLines, frame.duration);
        const t = frame.playbackTime || 0;
        const currentLineIndex = R.findActiveLineIndex(lines, t, -1);
        const activeLine = currentLineIndex >= 0 ? lines[currentLineIndex] : null;
        const lineProgress = activeLine ? clamp((t - activeLine.startTime) / Math.max(0.001, activeLine.endTime - activeLine.startTime), 0, 1) : 0;
        return {
            ...frame,
            ...R.resolveWordState(activeLine, t),
            lines,
            currentLineIndex,
            activeLine,
            previousLine: currentLineIndex > 0 ? lines[currentLineIndex - 1] : null,
            nextLines: currentLineIndex >= 0 ? lines.slice(currentLineIndex + 1, currentLineIndex + 4) : lines.slice(0, 3),
            lineProgress,
            lyricsEstimated: true
        };
    };

    // 值噪声查表：格点上的 hash12 预先算进一张 512×512 的浮点纹理，
    // 着色器里按平滑后的小数位做一次线性取样，结果与逐像素算四次 hash 的值噪声相同，
    // 省下大部分运算。纹理按 WebGL 上下文缓存。
    const NOISE_SIZE = 512;
    const NOISE_OFF = 128;
    const NOISE_GLSL = `
uniform sampler2D uNoise;
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 u = f * f * (3.0 - 2.0 * f);
    return textureLod(uNoise, (i + u + ${NOISE_OFF}.5) / ${NOISE_SIZE}.0, 0.0).r;
}`;
    const noiseTextures = new WeakMap();
    let noiseData = null;
    // 噪声表的原始数值（不走 gl 自己建纹理的渲染器用）
    const noisePixels = () => {
        if (!noiseData) {
            const f = Math.fround;
            const fract = x => x - Math.floor(x);
            noiseData = new Float32Array(NOISE_SIZE * NOISE_SIZE);
            for (let j = 0; j < NOISE_SIZE; j += 1) {
                for (let i = 0; i < NOISE_SIZE; i += 1) {
                    const x = i - NOISE_OFF, y = j - NOISE_OFF;
                    let a = f(fract(f(x * 0.1031))), b = f(fract(f(y * 0.1031))), c = a;
                    const d = f(f(a * f(b + 33.33)) + f(b * f(c + 33.33)) + f(c * f(a + 33.33)));
                    a = f(a + d); b = f(b + d); c = f(c + d);
                    noiseData[j * NOISE_SIZE + i] = fract(f(f(a + b) * c));
                }
            }
        }
        return { size: NOISE_SIZE, data: noiseData };
    };
    const noiseTexture = (gl) => {
        const cached = noiseTextures.get(gl);
        if (cached && gl.isTexture(cached)) return cached;
        noisePixels();
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, NOISE_SIZE, NOISE_SIZE, 0, gl.RED, gl.FLOAT, noiseData);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        noiseTextures.set(gl, t);
        return t;
    };
    // 把噪声纹理绑到 unit 号纹理单元，并告诉 program 的 uNoise
    const bindNoise = (gl, location, unit) => {
        if (!location) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, noiseTexture(gl));
        gl.uniform1i(location, unit);
    };

    // 字按原生分辨率画，光、烟、粒子这些贵的效果照旧按像素预算的低分辨率算。
    // 低分辨率那一遍一次写三张图：没有字时的颜色、被这一句的字整个盖住时的颜色、
    // 被上一句的字整个盖住时的颜色。三者都是平滑的，放大不会糊；真正锐利的只有字的覆盖率，
    // 合成那一遍按屏幕原生像素重新采样字形纹理，在三张图之间插值：
    //   col = base + r * (text - base) + r0 * (prev - base)
    // 舞台给出 coverage(uv) 的 GLSL（返回 vec4：x 当前句、y 上一句在这一点的覆盖率，zw 由舞台自用），以及它要用的 uniform；
    // 需要在插值之后再加一笔（比如上一句碎掉时的火星）的，再给一段 post(col, c)。
    // 泛光取亮部那一遍里定义了 SHARP_SEED：字交给逐字层画的舞台，在那一遍仍要把字算进去。
    const SPLIT_OUT_GLSL = `
layout(location = 0) out vec4 outBase;
layout(location = 1) out vec4 outText;
layout(location = 2) out vec4 outPrev;`;
    const SPLIT_VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
    const compileProgram = (gl, vert, frag, label) => {
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`[${label}] shader: ${gl.getShaderInfoLog(shader)}`);
            return shader;
        };
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vert));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, frag));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`[${label}] link: ${gl.getProgramInfoLog(program)}`);
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i += 1) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
        }
        return { program, uniforms };
    };
    // 泛光（可选）：从合成好的颜色里取亮的部分，在 1/2 到 1/32 的小图上逐级缩小再放大（双滤波），
    // 加回合成那一遍。只在小图上算，开销远小于再画一遍全屏；亮度阈值以下的不泛。
    const BLOOM_LEVELS = 5;
    const BLOOM_DOWN = `#version 300 es
precision mediump float;
uniform sampler2D uSrc;
uniform vec2 uHalf;   // 源图半个像素（uv）
uniform vec2 uDst;
out vec4 outColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uDst;
    vec3 c = texture(uSrc, uv).rgb * 4.0;
    c += texture(uSrc, uv + vec2(-uHalf.x, -uHalf.y)).rgb;
    c += texture(uSrc, uv + vec2(uHalf.x, -uHalf.y)).rgb;
    c += texture(uSrc, uv + vec2(-uHalf.x, uHalf.y)).rgb;
    c += texture(uSrc, uv + vec2(uHalf.x, uHalf.y)).rgb;
    outColor = vec4(c / 8.0, 1.0);
}`;
    const BLOOM_UP = `#version 300 es
precision mediump float;
uniform sampler2D uSrc;
uniform vec2 uHalf;
uniform vec2 uDst;
out vec4 outColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uDst;
    vec2 h = uHalf;
    vec3 c = texture(uSrc, uv + vec2(-h.x * 2.0, 0.0)).rgb;
    c += texture(uSrc, uv + vec2(-h.x, h.y)).rgb * 2.0;
    c += texture(uSrc, uv + vec2(0.0, h.y * 2.0)).rgb;
    c += texture(uSrc, uv + vec2(h.x, h.y)).rgb * 2.0;
    c += texture(uSrc, uv + vec2(h.x * 2.0, 0.0)).rgb;
    c += texture(uSrc, uv + vec2(h.x, -h.y)).rgb * 2.0;
    c += texture(uSrc, uv + vec2(0.0, -h.y * 2.0)).rgb;
    c += texture(uSrc, uv + vec2(-h.x, -h.y)).rgb * 2.0;
    outColor = vec4(c / 12.0, 1.0);
}`;
    const createSharpText = (gl, { coverage, post = 'vec3 post(vec3 col, vec4 c) { return col; }', label = 'stage' }) => {
        const frag = (seed) => `#version 300 es
precision highp float;
precision highp int;
${seed ? '#define SHARP_SEED 1' : ''}
uniform sampler2D uBase;
uniform sampler2D uTextLayer;
uniform sampler2D uPrevLayer;
uniform sampler2D uBloomTex;
uniform vec2 uRes;
uniform float uGrain;
uniform float uGrainStep;
uniform float uBloom;
uniform vec2 uKnee;     // 泛光阈值、过渡宽度
out vec4 outColor;
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
${coverage}
${post}
void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec4 c = coverage(uv);
    vec3 base = texture(uBase, uv).rgb;
    vec3 col = base;
    if (c.x > 0.002) col += c.x * (texture(uTextLayer, uv).rgb - base);
    if (c.y > 0.002) col += c.y * (texture(uPrevLayer, uv).rgb - base);
    col = post(col, c);
${seed ? `    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    outColor = vec4(col * smoothstep(uKnee.x, uKnee.x + uKnee.y, lum), 1.0);
}` : `    // 金字塔逐级相加，五级叠起来约是原亮度的五倍
    if (uBloom > 0.0) col += texture(uBloomTex, uv).rgb * (uBloom / ${BLOOM_LEVELS}.0);
    col += (hash12(floor(gl_FragCoord.xy / 1.5) + uGrainStep * 11.0) - 0.5) * 0.025 * uGrain;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`}`;
        const { program, uniforms } = compileProgram(gl, SPLIT_VERT, frag(false), `${label}:sharp`);
        let bloomGl = null;
        const bloomPrograms = () => {
            if (bloomGl) return bloomGl;
            const half = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
            bloomGl = {
                seed: compileProgram(gl, SPLIT_VERT, frag(true), `${label}:bloom-seed`),
                down: compileProgram(gl, SPLIT_VERT, BLOOM_DOWN, `${label}:bloom-down`),
                up: compileProgram(gl, SPLIT_VERT, BLOOM_UP, `${label}:bloom-up`),
                format: half ? [gl.RGBA16F, gl.HALF_FLOAT] : [gl.RGBA8, gl.UNSIGNED_BYTE],
                levels: [], fbos: [], size: [0, 0]
            };
            return bloomGl;
        };
        const linearTexture = () => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const fbo = gl.createFramebuffer();
        const layers = Array.from({ length: 3 }, linearTexture);
        const vao = gl.createVertexArray();
        let size = [0, 0];
        const bindLayers = (u) => {
            layers.forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
            gl.uniform1i(u.uBase, 0);
            gl.uniform1i(u.uTextLayer, 1);
            gl.uniform1i(u.uPrevLayer, 2);
        };
        // 泛光金字塔：第 0 级是低分辨率图的一半，逐级再减半
        const runBloom = (knee, bind) => {
            const B = bloomPrograms();
            const w0 = Math.max(1, size[0] >> 1), h0 = Math.max(1, size[1] >> 1);
            if (B.size[0] !== w0 || B.size[1] !== h0) {
                B.size = [w0, h0];
                for (let i = 0; i < BLOOM_LEVELS; i += 1) {
                    if (!B.levels[i]) { B.levels[i] = linearTexture(); B.fbos[i] = gl.createFramebuffer(); }
                    gl.bindTexture(gl.TEXTURE_2D, B.levels[i]);
                    gl.texImage2D(gl.TEXTURE_2D, 0, B.format[0], Math.max(1, w0 >> i), Math.max(1, h0 >> i), 0, gl.RGBA, B.format[1], null);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbos[i]);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, B.levels[i], 0);
                }
            }
            const dims = i => [Math.max(1, w0 >> i), Math.max(1, h0 >> i)];
            gl.bindVertexArray(vao);
            gl.disable(gl.BLEND);
            // 取亮部：按第 0 级的像素重新合成一次（字的覆盖率在这个尺寸上自动取 mip）
            gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbos[0]);
            gl.viewport(0, 0, w0, h0);
            gl.useProgram(B.seed.program);
            bindLayers(B.seed.uniforms);
            gl.uniform2f(B.seed.uniforms.uRes, w0, h0);
            gl.uniform2f(B.seed.uniforms.uKnee, knee[0], knee[1]);
            bind?.(B.seed.uniforms, 3);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.useProgram(B.down.program);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(B.down.uniforms.uSrc, 0);
            for (let i = 1; i < BLOOM_LEVELS; i += 1) {
                const [sw, sh] = dims(i - 1), [dw, dh] = dims(i);
                gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbos[i]);
                gl.viewport(0, 0, dw, dh);
                gl.bindTexture(gl.TEXTURE_2D, B.levels[i - 1]);
                gl.uniform2f(B.down.uniforms.uHalf, 0.5 / sw, 0.5 / sh);
                gl.uniform2f(B.down.uniforms.uDst, dw, dh);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }
            gl.useProgram(B.up.program);
            gl.uniform1i(B.up.uniforms.uSrc, 0);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            for (let i = BLOOM_LEVELS - 1; i > 0; i -= 1) {
                const [sw, sh] = dims(i), [dw, dh] = dims(i - 1);
                gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbos[i - 1]);
                gl.viewport(0, 0, dw, dh);
                gl.bindTexture(gl.TEXTURE_2D, B.levels[i]);
                gl.uniform2f(B.up.uniforms.uHalf, 0.5 / sw, 0.5 / sh);
                gl.uniform2f(B.up.uniforms.uDst, dw, dh);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }
            gl.disable(gl.BLEND);
            return B.levels[0];
        };
        return {
            program, uniforms,
            get size() { return size; },
            get textLayer() { return layers[1]; },
            get prevLayer() { return layers[2]; },
            // 低分辨率那一遍：绑到三张图上
            begin(w, h) {
                if (w !== size[0] || h !== size[1]) {
                    size = [w, h];
                    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                    layers.forEach((t, i) => {
                        gl.bindTexture(gl.TEXTURE_2D, t);
                        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
                    });
                }
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
                gl.viewport(0, 0, w, h);
            },
            // 合成那一遍：按屏幕像素画到画布上。bind(uniforms, firstFreeUnit) 绑舞台自己的纹理和参数。
            // bloom > 0 时先在小图上算泛光（knee：亮度阈值、过渡宽度）
            finish(w, h, { grain = 0, grainStep = 0, bloom = 0, knee = [0.6, 0.3] } = {}, bind = null) {
                const glowTex = bloom > 0 ? runBloom(knee, bind) : null;
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.viewport(0, 0, w, h);
                gl.useProgram(program);
                gl.bindVertexArray(vao);
                bindLayers(uniforms);
                gl.uniform2f(uniforms.uRes, w, h);
                gl.uniform1f(uniforms.uGrain, grain);
                gl.uniform1f(uniforms.uGrainStep, grainStep);
                gl.uniform1f(uniforms.uBloom, bloom);
                // 泛光图固定放在 15 号单元，不和舞台自己的纹理抢
                gl.activeTexture(gl.TEXTURE15);
                gl.bindTexture(gl.TEXTURE_2D, glowTex || layers[0]);
                gl.uniform1i(uniforms.uBloomTex, 15);
                bind?.(uniforms, 3);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }
        };
    };
    // 离屏图：一张颜色纹理加帧缓冲，按需改尺寸
    const createTarget = (gl, { premul = false } = {}) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        let size = [0, 0];
        return {
            tex, fbo, premul,
            get size() { return size; },
            bind(w, h) {
                if (w !== size[0] || h !== size[1]) {
                    size = [w, h];
                    gl.bindTexture(gl.TEXTURE_2D, tex);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
                }
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                gl.viewport(0, 0, w, h);
            }
        };
    };
    // 给「先画到低分辨率离屏图、再放大到屏幕」的舞台用的泛光和上屏：
    //   run(scene, over, knee, start)：scene 是低分辨率的画面，over 是叠在上面的一层（预乘透明度，比如字），
    //     两者合起来取亮部，在 1/2 到 1/32 的小图上双滤波；返回泛光纹理
    //   present(scene, glow, w, h, opts)：把画面放大到屏幕，加上泛光和颗粒
    //   add(glow, w, h, strength)：只把泛光叠加到当前画布上（只给一部分东西泛光时用，比如烟花火星）
    const createBloom = (gl, { label = 'stage' } = {}) => {
        const seedFrag = `#version 300 es
precision mediump float;
uniform sampler2D uScene;
uniform sampler2D uOver;
uniform float uHasOver;
uniform vec2 uDst;
uniform vec2 uKnee;
out vec4 outColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uDst;
    vec3 col = texture(uScene, uv).rgb;
    if (uHasOver > 0.5) { vec4 o = texture(uOver, uv); col = o.rgb + col * (1.0 - o.a); }
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    outColor = vec4(col * smoothstep(uKnee.x, uKnee.x + uKnee.y, lum), 1.0);
}`;
        const presentFrag = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uGlow;
uniform vec2 uRes;
uniform float uBloom;
uniform float uGrain;
uniform float uGrainStep;
out vec4 outColor;
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec3 col = texture(uScene, uv).rgb;
    if (uBloom > 0.0) col += texture(uGlow, uv).rgb * (uBloom / ${BLOOM_LEVELS}.0);
    col += (hash12(floor(gl_FragCoord.xy / 1.5) + uGrainStep * 11.0) - 0.5) * 0.025 * uGrain;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
        const seed = compileProgram(gl, SPLIT_VERT, seedFrag, `${label}:glow-seed`);
        const down = compileProgram(gl, SPLIT_VERT, BLOOM_DOWN, `${label}:glow-down`);
        const up = compileProgram(gl, SPLIT_VERT, BLOOM_UP, `${label}:glow-up`);
        const present = compileProgram(gl, SPLIT_VERT, presentFrag, `${label}:present`);
        const addFrag = `#version 300 es
precision mediump float;
uniform sampler2D uGlow;
uniform vec2 uRes;
uniform float uBloom;
out vec4 outColor;
void main() {
    outColor = vec4(texture(uGlow, gl_FragCoord.xy / uRes).rgb * (uBloom / ${BLOOM_LEVELS}.0), 1.0);
}`;
        let adder = null;
        const half = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
        const format = half ? [gl.RGBA16F, gl.HALF_FLOAT] : [gl.RGBA8, gl.UNSIGNED_BYTE];
        const levels = [], fbos = [];
        let base = [0, 0];
        const vao = gl.createVertexArray();
        return {
            // start：泛光最细一层是画面的 1/2^start（1 = 一半；2 = 四分之一，便宜很多，光晕只是更软）
            run(scene, over, knee = [0.6, 0.3], start = 1) {
                const [sw, sh] = scene.size;
                const w0 = Math.max(1, sw >> start), h0 = Math.max(1, sh >> start);
                if (base[0] !== w0 || base[1] !== h0) {
                    base = [w0, h0];
                    for (let i = 0; i < BLOOM_LEVELS; i += 1) {
                        if (!levels[i]) {
                            levels[i] = gl.createTexture(); fbos[i] = gl.createFramebuffer();
                            gl.bindTexture(gl.TEXTURE_2D, levels[i]);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                        }
                        gl.bindTexture(gl.TEXTURE_2D, levels[i]);
                        gl.texImage2D(gl.TEXTURE_2D, 0, format[0], Math.max(1, w0 >> i), Math.max(1, h0 >> i), 0, gl.RGBA, format[1], null);
                        gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[i]);
                        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, levels[i], 0);
                    }
                }
                const dims = i => [Math.max(1, w0 >> i), Math.max(1, h0 >> i)];
                gl.bindVertexArray(vao);
                gl.disable(gl.BLEND);
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[0]);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                gl.viewport(0, 0, w0, h0);
                gl.useProgram(seed.program);
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.tex); gl.uniform1i(seed.uniforms.uScene, 0);
                gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (over || scene).tex); gl.uniform1i(seed.uniforms.uOver, 1);
                gl.uniform1f(seed.uniforms.uHasOver, over ? 1 : 0);
                gl.uniform2f(seed.uniforms.uDst, w0, h0);
                gl.uniform2f(seed.uniforms.uKnee, knee[0], knee[1]);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.useProgram(down.program);
                gl.activeTexture(gl.TEXTURE0);
                gl.uniform1i(down.uniforms.uSrc, 0);
                for (let i = 1; i < BLOOM_LEVELS; i += 1) {
                    const [pw, ph] = dims(i - 1), [dw, dh] = dims(i);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[i]);
                    gl.viewport(0, 0, dw, dh);
                    gl.bindTexture(gl.TEXTURE_2D, levels[i - 1]);
                    gl.uniform2f(down.uniforms.uHalf, 0.5 / pw, 0.5 / ph);
                    gl.uniform2f(down.uniforms.uDst, dw, dh);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                }
                gl.useProgram(up.program);
                gl.uniform1i(up.uniforms.uSrc, 0);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.ONE, gl.ONE);
                for (let i = BLOOM_LEVELS - 1; i > 0; i -= 1) {
                    const [pw, ph] = dims(i), [dw, dh] = dims(i - 1);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[i - 1]);
                    gl.viewport(0, 0, dw, dh);
                    gl.bindTexture(gl.TEXTURE_2D, levels[i]);
                    gl.uniform2f(up.uniforms.uHalf, 0.5 / pw, 0.5 / ph);
                    gl.uniform2f(up.uniforms.uDst, dw, dh);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                }
                gl.disable(gl.BLEND);
                return levels[0];
            },
            present(scene, glow, w, h, { bloom = 0, grain = 0, grainStep = 0 } = {}) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.viewport(0, 0, w, h);
                gl.disable(gl.BLEND);
                gl.bindVertexArray(vao);
                gl.useProgram(present.program);
                const u = present.uniforms;
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.tex); gl.uniform1i(u.uScene, 0);
                gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glow || scene.tex); gl.uniform1i(u.uGlow, 1);
                gl.uniform2f(u.uRes, w, h);
                gl.uniform1f(u.uBloom, glow ? bloom : 0);
                gl.uniform1f(u.uGrain, grain);
                gl.uniform1f(u.uGrainStep, grainStep);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            },
            // run 之后第 i 层：第 i 层及更粗各层模糊之和（共 BLOOM_LEVELS - i 层，取用时除掉）。
            // knee 给 [-1, 0.5] 时不取亮部、整张图都进来，就是一组圆润的多级模糊（比 mip 的方块模糊圆）。
            level(i) { return levels[Math.min(Math.max(i, 0), BLOOM_LEVELS - 1)]; },
            levels: BLOOM_LEVELS,
            add(glow, w, h, strength = 1) {
                if (!adder) adder = compileProgram(gl, SPLIT_VERT, addFrag, `${label}:glow-add`);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.viewport(0, 0, w, h);
                gl.bindVertexArray(vao);
                gl.useProgram(adder.program);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.ONE, gl.ONE);
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glow); gl.uniform1i(adder.uniforms.uGlow, 0);
                gl.uniform2f(adder.uniforms.uRes, w, h);
                gl.uniform1f(adder.uniforms.uBloom, strength);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.disable(gl.BLEND);
            }
        };
    };
    // 逐字层：一句字图里的每个字画成一个小四边形，按屏幕像素画在合成好的画面上，各自缩放、旋转、
    // 位移、淡入（入场、唱到时的动作都由播放时间算出，拖进度、暂停都对）。字的颜色取自 createSharpText
    // 低分辨率那一遍的「被字盖住的颜色」，在字原来的位置取，所以光照、唱到的颜色和整句画法一致。
    // 舞台给出 home(t) 的 GLSL：字图坐标（y 朝下）→ 屏幕 uv（y 朝上），和它要用的 uniform。
    // 每个字 20 个浮点：
    //   box（字图 uv 的外框 x0 y0 x1 y1）、centre（字心 uv、字编号、字号像素）、
    //   xf（位移 x y 像素、缩放、旋转）、look（不透明度、闪白、描边样式 0 无 1 深色硬边 2 浅纸压痕、0）、
    //   block（字底色块 0 无 1 荧光笔、擦出进度 0..1、这一行的倾角、字宽一半的像素）
    const GLYPH_FLOATS = 20;
    const createGlyphLayer = (gl, { home, label = 'stage' }) => {
        const vert = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aBox;
layout(location = 1) in vec4 aCtr;
layout(location = 2) in vec4 aXf;
layout(location = 3) in vec4 aLook;
layout(location = 4) in vec4 aBlock;
uniform vec2 uTextSize;
${home}
out vec2 vTex;
out vec2 vHome;
flat out vec4 vCtr;
flat out vec4 vLook;
flat out vec4 vBlock;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    vec2 t = mix(aBox.xy, aBox.zw, corner);
    vec2 rel = (t - aCtr.xy) * uTextSize;
    float c = cos(aXf.w), s = sin(aXf.w);
    rel = mat2(c, s, -s, c) * rel * aXf.z + aXf.xy;
    vec2 sp = home(aCtr.xy + rel / uTextSize);
    gl_Position = vec4(sp * 2.0 - 1.0, 0.0, 1.0);
    vTex = t;
    vHome = home(t);
    vCtr = aCtr;
    vLook = aLook;
    vBlock = aBlock;
}`;
        const frag = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uText;
uniform sampler2D uTextLayer;
uniform vec2 uTextSize;
uniform float uLod;      // 段落进场时整句是虚的（mip 级），< 0 不虚
uniform float uFade;
uniform vec4 uFill;      // a > 0 时字用这个颜色（rgb）而不是原位的颜色
uniform vec4 uBlockCol;  // 荧光笔的颜色和不透明度
in vec2 vTex;
in vec2 vHome;
flat in vec4 vCtr;
flat in vec4 vLook;
flat in vec4 vBlock;
out vec4 outColor;
// 只取自己这个字的笔画（字框按编号写在 G 通道），邻字伸进外框的笔画不跟着动
float cov(vec2 uv) {
    // 整句虚着的时候模糊会溢出字框，按字框裁会露出方边：这时不裁（邻字的虚影本来也看不清）
    if (uLod > 1.0) return textureLod(uText, uv, uLod).r;
    ivec2 p = clamp(ivec2(uv * uTextSize), ivec2(0), ivec2(uTextSize) - 1);
    if (int(texelFetch(uText, p, 0).g * 255.0 + 0.5) != int(vCtr.z + 0.5)) return 0.0;
    return uLod >= 0.0 ? textureLod(uText, uv, uLod).r : texture(uText, uv).r;
}
void main() {
    float r = cov(vTex);
    vec2 px = vCtr.w / uTextSize;
    vec4 o = vec4(0.0);
    if (vLook.z > 0.5 && vLook.z < 1.5) {
        // 深色硬边：字外一圈深色描边，右下一层半透明的硬投影，像剪下来贴上去
        float rim = r;
        for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.7854;
            rim = max(rim, cov(vTex + vec2(cos(a), sin(a)) * px * 0.075));
        }
        vec2 so = vec2(0.045, 0.06) * px;
        float sh = max(cov(vTex - so), max(cov(vTex - so + vec2(0.06, 0.0) * px), cov(vTex - so - vec2(0.0, 0.06) * px)));
        o = vec4(0.0, 0.0, 0.0, sh * 0.5);
        vec4 rc = vec4(vec3(0.071, 0.055, 0.118) * 0.92, 0.92) * rim;
        o = rc + o * (1.0 - rc.a);
    } else if (vLook.z > 1.5) {
        // 浅纸：右下错开一点的白色压痕
        float hl = cov(vTex - vec2(0.03, 0.04) * px) * 0.5;
        o = vec4(vec3(hl), hl);
    }
    if (vBlock.x > 0.5 && vBlock.y > 0.0) {
        // 荧光笔：字的下半截一道色带，按唱的进度从左往右擦出来；相邻的字接成一条
        vec2 d = (vTex - vCtr.xy) * uTextSize;
        float ca = cos(vBlock.z), sa = sin(vBlock.z);
        d = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / vCtr.w;
        float hw = vBlock.w / vCtr.w;
        float along = (d.x + hw) / (2.0 * hw);
        float aa = 1.5 / vCtr.w;
        float band = smoothstep(-0.12 - aa, -0.12, d.y) * (1.0 - smoothstep(0.34, 0.34 + aa, d.y))
            * step(-hw - 0.03, d.x) * step(d.x, hw + 0.03) * (1.0 - smoothstep(vBlock.y - 0.02, vBlock.y, along));
        // 笔触的边不是一刀切：上下沿按位置起伏一点
        band *= 0.85 + 0.15 * sin(d.x * 9.0 + vCtr.z);
        vec4 bc = vec4(uBlockCol.rgb, 1.0) * uBlockCol.a * band;
        o = o + bc * (1.0 - o.a);
    }
    vec3 fill = mix(texture(uTextLayer, vHome).rgb, uFill.rgb, uFill.a) + vec3(1.0, 0.97, 0.92) * vLook.y;
    o = vec4(fill * r, r) + o * (1.0 - r);
    outColor = o * vLook.x * uFade;
}`;
        const { program, uniforms } = compileProgram(gl, vert, frag, `${label}:glyphs`);
        const vao = gl.createVertexArray();
        const buffer = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        for (let i = 0; i < GLYPH_FLOATS / 4; i += 1) {
            gl.enableVertexAttribArray(i);
            gl.vertexAttribPointer(i, 4, gl.FLOAT, false, GLYPH_FLOATS * 4, i * 16);
            gl.vertexAttribDivisor(i, 1);
        }
        gl.bindVertexArray(null);
        return {
            program, uniforms,
            // 画到当前帧缓冲上（预乘透明度叠加）。bind(uniforms) 绑 uText、uTextLayer 和 home 要用的参数
            draw(data, count, bind) {
                if (!count) return;
                gl.useProgram(program);
                gl.bindVertexArray(vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * GLYPH_FLOATS), gl.DYNAMIC_DRAW);
                bind(uniforms);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
                gl.disable(gl.BLEND);
                gl.bindVertexArray(null);
            }
        };
    };
    // 入场、唱到时的字的动作：输入归一化的时间，返回 [位移 x, 位移 y（字号倍数，y 朝下）, 缩放, 旋转, 不透明度, 闪白]
    const easeOut = k => 1 - Math.pow(1 - k, 3);
    const backOut = (k, s = 1.9) => 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2);
    const bounceOut = (k) => {
        if (k < 1 / 2.75) return 7.5625 * k * k;
        if (k < 2 / 2.75) { k -= 1.5 / 2.75; return 7.5625 * k * k + 0.75; }
        if (k < 2.5 / 2.75) { k -= 2.25 / 2.75; return 7.5625 * k * k + 0.9375; }
        k -= 2.625 / 2.75; return 7.5625 * k * k + 0.984375;
    };
    const GLYPH_ENTER = Object.freeze({
        pop: k => [0, 0, 0.35 + 0.65 * backOut(k), 0, Math.min(1, k * 3), 0],
        rise: k => [0, (1 - easeOut(k)) * 0.45, 1, 0, Math.min(1, k * 2.2), 0],
        drop: k => [0, -(1 - bounceOut(k)) * 0.7, 1, 0, Math.min(1, k * 4), 0],
        stamp: k => [0, 0, 1 + (1 - easeOut(k)) * 0.85, (1 - easeOut(k)) * 0.18, Math.min(1, k * 2.5), k > 0.55 ? Math.max(0, 1 - (k - 0.55) * 4) * 0.35 : 0],
        spin: k => [0, 0, 0.5 + 0.5 * easeOut(k), -(1 - easeOut(k)) * 1.3, Math.min(1, k * 2.5), 0],
        slide: k => [-(1 - easeOut(k)) * 0.6, 0, 1, 0, Math.min(1, k * 2.5), 0]
    });
    const GLYPH_SING = Object.freeze({
        bounce: k => [0, -Math.sin(Math.PI * k) * 0.16, 1, 0, 1, 0],
        swell: k => [0, 0, 1 + Math.sin(Math.PI * k) * 0.14, 0, 1, 0],
        nod: k => [0, 0, 1, Math.sin(Math.PI * 2 * k) * 0.12 * (1 - k), 1, 0],
        flash: k => [0, 0, 1 + Math.sin(Math.PI * k) * 0.05, 0, 1, (1 - k) * 0.55]
    });
    // 退场（k：0..1 退场进度，i：第几个字，用来错开和定方向）
    const GLYPH_EXIT = Object.freeze({
        fall: (k, i) => [Math.sin(i * 2.1) * 0.15 * k, k * k * 1.6, 1, Math.sin(i * 1.7) * 0.5 * k * k, 1 - k * k, 0],
        scatter: (k, i) => {
            const a = i * 2.39996 + 0.7, e = easeOut(k);
            return [Math.cos(a) * 0.9 * e, Math.sin(a) * 0.9 * e, 1 - 0.4 * e, Math.sin(a * 3) * 0.8 * e, 1 - k, k < 0.2 ? (0.2 - k) * 2 : 0];
        },
        ascend: (k, i) => [0, -easeOut(k) * 0.7, 1 + 0.12 * k, 0, Math.max(0, 1 - k * 1.15 + Math.sin(i) * 0.05), 0]
    });
    const glyphExit = (kind, k, i, still = false) => {
        if (still || !GLYPH_EXIT[kind]) return [0, 0, 1, 0, 1 - k, 0];
        return GLYPH_EXIT[kind](Math.min(1, Math.max(0, k)), i);
    };
    // 一个字这一刻的姿态（入场 × 唱到）：enter/sing 是上面两张表里的名字，tauEnter/tauSing 是距入场、开唱的秒数
    const glyphPose = (enter, tauEnter, sing, tauSing, still = false) => {
        if (still) return [0, 0, 1, 0, 1, 0];
        if (tauEnter < 0) return [0, 0, 1, 0, 0, 0];
        const e = (GLYPH_ENTER[enter] || GLYPH_ENTER.rise)(Math.min(1, tauEnter / 0.42));
        if (tauSing < -0.02 || tauSing > 0.32 || !GLYPH_SING[sing]) return e;
        const g = GLYPH_SING[sing](Math.max(0, tauSing) / 0.32);
        return [e[0] + g[0], e[1] + g[1], e[2] * g[2], e[3] + g[3], e[4] * g[4], e[5] + g[5]];
    };
    // 字形纹理和画布都按屏幕原生像素；效果层按像素预算缩小。返回两者尺寸
    const sharpSizes = (w, h, pixels, ratioCap = 2) => {
        const native = Math.min(ratioCap, global.devicePixelRatio || 1);
        const low = Math.min(native, Math.sqrt(pixels / (w * h)));
        return {
            native, low,
            nw: Math.max(1, Math.round(w * native)), nh: Math.max(1, Math.round(h * native)),
            lw: Math.max(1, Math.round(w * low)), lh: Math.max(1, Math.round(h * low))
        };
    };

    global.MusicStageModeUtils = Object.freeze({
        NOISE_GLSL, noiseTexture, noisePixels, bindNoise,
        SPLIT_OUT_GLSL, compileProgram, createSharpText, sharpSizes,
        createTarget, createBloom,
        GLYPH_FLOATS, createGlyphLayer, GLYPH_ENTER, GLYPH_SING, GLYPH_EXIT, glyphPose, glyphExit,
        lineCounter, withPlainLyrics,
        watchOverlay, watchCardInset, breathe, settlePrograms,
        coverColour, dominantHue, createCoverTint,
        lyricFont,
        STAGE_FONT,
        loadLyricFont,
        wordPlan,
        createRenderScale,
        createHandoverVeil,
        createFrameCap, createStillGate, durationChanged,
        precompile,
        compileReady,
        warmLensless,
        tier,
        clamp,
        hashString,
        seededRandom,
        splitGraphemes,
        createElement,
        getLineKey,
        createWord,
        updateWord,
        renderWords,
        updateWords,
        resolveAccent,
        refreshTheme,
        makeModeBase
    });
})(window);