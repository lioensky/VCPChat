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

    const resolveAccent = (app) => {
        const color = app?.visualizerColor || { r: 121, g: 216, b: 255 };
        return {
            r: clamp(Number(color.r) || 121, 0, 255),
            g: clamp(Number(color.g) || 216, 0, 255),
            b: clamp(Number(color.b) || 255, 0, 255)
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
        makeModeBase
    });
})(window);