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
        const light = app?.currentTheme === 'light';
        const defaults = light
            ? ['#f2efe7', '#fcfaf4', '#1b211f', '#626a66', '#b94832', '#21675c', '#21675c']
            : ['#171a1d', '#20252a', '#f2f0e9', '#a7afb1', '#f2a900', '#76bfae', '#76bfae'];
        const names = ['background', 'surface', 'ink', 'muted', 'accent', 'secondary', 'tertiary'];
        const variables = ['--primary-bg', '--secondary-bg', '--primary-text', '--secondary-text',
            '--highlight-text', '--success-color', '--quoted-text'];
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

    global.MusicStageModeUtils = Object.freeze({
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