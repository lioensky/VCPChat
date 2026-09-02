import DiceBox from "/node_modules/@3d-dice/dice-box/dist/dice-box.es.js";

const Box = new DiceBox({
    container: "#dice-canvas-container",
    assetPath: "/assets/dice-box/",
    theme: "default",
    offscreen: true,
    scale: 6
});

const api = window.utilityAPI || window.electronAPI;
const elements = {
    notationInput: document.getElementById('notation-input'),
    rollButton: document.getElementById('roll-button'),
    rollStatus: document.getElementById('roll-status'),
    currentNotation: document.getElementById('current-notation'),
    resultCard: document.getElementById('result-card'),
    resultTotal: document.getElementById('result-total'),
    resultDetail: document.getElementById('result-detail'),
    rollCount: document.getElementById('roll-count'),
    quickDice: Array.from(document.querySelectorAll('.quick-die')),
    minimizeButton: document.getElementById('minimize-dice-btn'),
    maximizeButton: document.getElementById('maximize-dice-btn'),
    closeButton: document.getElementById('close-dice-btn'),
    titlebar: document.querySelector('.titlebar')
};

const state = {
    rollCount: 0,
    rolling: false,
    fallbackTimer: null,
    resizeTimer: null,
    orbitRateFrame: null,
    orbitAnimations: []
};

const normalizeNotation = (value) => String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();

const isValidNotation = (notation) => {
    if (!notation || notation.length > 80) return false;

    const terms = notation.match(/[+-]?[^+-]+/g);
    if (!terms?.length) return false;

    let hasDice = false;

    return terms.every((term) => {
        const unsignedTerm = term.replace(/^[+-]/, '');

        if (/^\d*d\d+$/i.test(unsignedTerm)) {
            hasDice = true;
            const [countText, sidesText] = unsignedTerm.toLowerCase().split('d');
            const count = Number(countText || 1);
            const sides = Number(sidesText);
            return count >= 1 && count <= 100 && sides >= 2 && sides <= 1000;
        }

        return /^\d+$/.test(unsignedTerm);
    }) && hasDice;
};

const toDiceBoxNotations = (notation) => notation
    .split(/\+(?=\d*d)/i)
    .map((part) => part.trim())
    .filter(Boolean);

const getDiceCounts = (notation) => {
    const counts = new Map();
    const terms = normalizeNotation(notation).match(/[+-]?[^+-]+/g) || [];

    terms.forEach((term) => {
        if (term.startsWith('-')) return;

        const match = term.replace(/^\+/, '').match(/^(\d*)d(\d+)$/);
        if (!match) return;

        const count = Number(match[1] || 1);
        const sides = Number(match[2]);
        counts.set(sides, (counts.get(sides) || 0) + count);
    });

    return counts;
};

const syncQuickDice = (notation) => {
    const diceCounts = getDiceCounts(notation);

    elements.quickDice.forEach((button) => {
        const buttonNotation = normalizeNotation(button.dataset.notation);
        const sides = Number(buttonNotation.split('d')[1]);
        const poolCount = diceCounts.get(sides) || 0;

        button.classList.toggle('is-active', buttonNotation === notation);
        button.classList.toggle('is-in-pool', poolCount > 0);
        button.dataset.poolCount = poolCount > 0 ? String(poolCount) : '';
        button.setAttribute(
            'aria-label',
            `${buttonNotation}，骰池中 ${poolCount} 枚；左键立即投掷，右键加入骰池`
        );
    });
};

const setNotation = (notation) => {
    const normalized = normalizeNotation(notation);
    elements.notationInput.value = normalized;
    elements.currentNotation.textContent = normalized || '—';
    syncQuickDice(normalized);
};

const addDieToPool = (dieNotation, sourceButton) => {
    if (state.rolling) return;

    const normalizedDie = normalizeNotation(dieNotation);
    const dieMatch = normalizedDie.match(/^1d(\d+)$/);
    if (!dieMatch) return;

    const sides = Number(dieMatch[1]);
    const currentNotation = normalizeNotation(elements.notationInput.value);
    let nextNotation = isValidNotation(currentNotation) ? currentNotation : '';

    const terms = nextNotation ? nextNotation.match(/[+-]?[^+-]+/g) || [] : [];
    const matchingIndex = terms.findIndex((term) => {
        if (term.startsWith('-')) return false;
        const match = term.replace(/^\+/, '').match(/^(\d*)d(\d+)$/);
        return match && Number(match[2]) === sides;
    });

    if (matchingIndex >= 0) {
        const sign = terms[matchingIndex].startsWith('+') ? '+' : '';
        const match = terms[matchingIndex].replace(/^\+/, '').match(/^(\d*)d(\d+)$/);
        const nextCount = Number(match[1] || 1) + 1;

        if (nextCount > 100) {
            elements.rollStatus.textContent = `d${sides} 已达到 100 枚上限`;
            return;
        }

        terms[matchingIndex] = `${sign}${nextCount}d${sides}`;
        nextNotation = terms.join('');
    } else {
        nextNotation = `${nextNotation}${nextNotation ? '+' : ''}1d${sides}`;
    }

    setNotation(nextNotation);
    elements.rollStatus.textContent = `已将 1d${sides} 加入骰池`;

    sourceButton.classList.remove('just-added');
    void sourceButton.offsetWidth;
    sourceButton.classList.add('just-added');

    window.setTimeout(() => {
        sourceButton.classList.remove('just-added');
        if (!state.rolling) elements.rollStatus.textContent = '骰池已就绪，等待投掷';
    }, 950);
};

const setupOrbitAnimations = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const orbitDefinitions = [
        {
            element: document.querySelector('.orbit-outer'),
            from: 'translate(-50%, -50%) rotate(-12deg)',
            to: 'translate(-50%, -50%) rotate(348deg)',
            duration: 18000
        },
        {
            element: document.querySelector('.orbit-inner'),
            from: 'translate(-50%, -50%) rotate(383deg)',
            to: 'translate(-50%, -50%) rotate(23deg)',
            duration: 14000
        }
    ];

    state.orbitAnimations = orbitDefinitions
        .filter(({ element }) => element)
        .map(({ element, from, to, duration }) => {
            const animation = element.animate(
                [
                    { transform: from },
                    { transform: to }
                ],
                {
                    duration,
                    iterations: Infinity,
                    easing: 'linear'
                }
            );
            animation.playbackRate = 1;
            return animation;
        });
};

const transitionOrbitRate = (targetRate, duration) => {
    if (!state.orbitAnimations.length) return;

    if (state.orbitRateFrame) {
        window.cancelAnimationFrame(state.orbitRateFrame);
        state.orbitRateFrame = null;
    }

    const startRates = state.orbitAnimations.map((animation) => animation.playbackRate);
    const startTime = performance.now();

    const updateRate = (now) => {
        const progress = Math.min((now - startTime) / duration, 1);
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        state.orbitAnimations.forEach((animation, index) => {
            const nextRate = startRates[index]
                + (targetRate - startRates[index]) * easedProgress;
            animation.updatePlaybackRate(nextRate);
        });

        if (progress < 1) {
            state.orbitRateFrame = window.requestAnimationFrame(updateRate);
        } else {
            state.orbitRateFrame = null;
        }
    };

    state.orbitRateFrame = window.requestAnimationFrame(updateRate);
};

const refreshDiceViewport = () => {
    const container = document.getElementById('dice-canvas-container');
    const { width, height } = container.getBoundingClientRect();

    if (width < 32 || height < 32) return;

    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
            const stableRect = container.getBoundingClientRect();
            if (stableRect.width >= 32 && stableRect.height >= 32) {
                window.dispatchEvent(new Event('resize'));
            }
        });
    });
};

const bindStableViewportResize = () => {
    const container = document.getElementById('dice-canvas-container');

    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            const width = entry?.contentRect?.width || 0;
            const height = entry?.contentRect?.height || 0;

            if (width < 32 || height < 32) return;

            if (state.resizeTimer) window.clearTimeout(state.resizeTimer);
            state.resizeTimer = window.setTimeout(refreshDiceViewport, 160);
        });

        observer.observe(container);
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshDiceViewport();
    });
};

const clearFallbackTimer = () => {
    if (!state.fallbackTimer) return;
    window.clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
};

const setRollingState = (rolling) => {
    const wasRolling = state.rolling;
    state.rolling = rolling;
    document.body.classList.toggle('is-rolling', rolling);
    elements.rollButton.disabled = rolling;
    elements.rollStatus.textContent = rolling ? '正在扰动命运轨迹' : '命运正在候场';

    if (wasRolling !== rolling) {
        transitionOrbitRate(rolling ? 5 : 1, rolling ? 650 : 1500);
    }

    clearFallbackTimer();

    if (rolling) {
        state.fallbackTimer = window.setTimeout(() => {
            setRollingState(false);
            elements.rollStatus.textContent = '轨迹已稳定';
        }, 15000);
    }
};

const showInvalidNotation = () => {
    elements.notationInput.classList.remove('is-invalid');
    void elements.notationInput.offsetWidth;
    elements.notationInput.classList.add('is-invalid');
    elements.rollStatus.textContent = '表达式似乎迷路了';
    elements.notationInput.focus();
    elements.notationInput.select();

    window.setTimeout(() => {
        elements.notationInput.classList.remove('is-invalid');
        if (!state.rolling) elements.rollStatus.textContent = '命运正在候场';
    }, 1400);
};

const parseAndRoll = (notationValue) => {
    const notation = normalizeNotation(notationValue);
    if (!isValidNotation(notation)) {
        showInvalidNotation();
        return false;
    }

    setNotation(notation);
    setRollingState(true);

    try {
        Box.roll(toDiceBoxNotations(notation));
        return true;
    } catch (error) {
        console.error('[Dice] Failed to roll notation:', notation, error);
        setRollingState(false);
        elements.rollStatus.textContent = '投掷未能启动';
        return false;
    }
};

const formatRollResults = (results) => {
    if (!Array.isArray(results) || results.length === 0) {
        return {
            total: '—',
            detail: '结果落入了观测盲区'
        };
    }

    const groups = results.map((group) => {
        const rolls = Array.isArray(group?.rolls)
            ? group.rolls.map((roll) => Number(roll?.value)).filter(Number.isFinite)
            : [];
        const modifier = Number(group?.modifier) || 0;
        const groupValue = Number(group?.value);
        const value = Number.isFinite(groupValue)
            ? groupValue
            : rolls.reduce((sum, roll) => sum + roll, 0) + modifier;

        let detail = rolls.length ? `[${rolls.join(' · ')}]` : String(value);
        if (modifier > 0) detail += ` + ${modifier}`;
        if (modifier < 0) detail += ` − ${Math.abs(modifier)}`;

        return { value, detail };
    });

    return {
        total: groups.reduce((sum, group) => sum + group.value, 0),
        detail: groups.map((group) => group.detail).join('  +  ')
    };
};

const presentResults = (results) => {
    const presentation = formatRollResults(results);

    setRollingState(false);
    state.rollCount += 1;

    elements.resultTotal.textContent = presentation.total;
    elements.resultDetail.textContent = presentation.detail;
    elements.resultDetail.title = presentation.detail;
    elements.rollStatus.textContent = '命运已作出回应';
    elements.rollCount.textContent = `本次观测 ${state.rollCount} 回`;

    elements.resultCard.classList.remove('has-result');
    void elements.resultCard.offsetWidth;
    elements.resultCard.classList.add('has-result');

    window.setTimeout(() => {
        if (!state.rolling) elements.rollStatus.textContent = '命运正在候场';
    }, 2600);
};

const applyTheme = (theme) => {
    const normalizedTheme = theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('light-theme', normalizedTheme === 'light');

    Box.updateConfig({
        colorScheme: normalizedTheme
    });
};

const signalReady = () => {
    if (api?.sendDiceModuleReady) api.sendDiceModuleReady();
    if (api?.windowReady) api.windowReady('dice');
};

const initializeTheme = async () => {
    try {
        const theme = api?.getCurrentTheme
            ? await api.getCurrentTheme()
            : 'dark';
        applyTheme(theme);
    } catch (error) {
        console.warn('[Dice] Unable to read initial theme, using dark theme.', error);
        applyTheme('dark');
    }

    if (api?.onThemeUpdated) api.onThemeUpdated(applyTheme);
};

const bindWindowControls = () => {
    elements.minimizeButton.addEventListener('click', () => {
        api?.minimizeWindow?.();
    });

    elements.maximizeButton.addEventListener('click', () => {
        api?.maximizeWindow?.();
    });

    elements.closeButton.addEventListener('click', () => {
        if (api?.closeWindow) api.closeWindow();
        else window.close();
    });

    elements.titlebar.addEventListener('dblclick', (event) => {
        if (!event.target.closest('.window-controls')) {
            api?.maximizeWindow?.();
        }
    });
};

const bindRollControls = () => {
    elements.rollButton.addEventListener('click', () => {
        if (!state.rolling) parseAndRoll(elements.notationInput.value);
    });

    elements.notationInput.addEventListener('input', () => {
        const notation = normalizeNotation(elements.notationInput.value);
        elements.currentNotation.textContent = notation || '—';
        elements.notationInput.classList.remove('is-invalid');
        syncQuickDice(notation);
    });

    elements.notationInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !state.rolling) {
            event.preventDefault();
            parseAndRoll(elements.notationInput.value);
        }

        if (event.key === 'Escape') {
            setNotation('1d20');
            elements.notationInput.blur();
        }
    });

    elements.quickDice.forEach((button) => {
        button.addEventListener('click', () => {
            const notation = button.dataset.notation;
            setNotation(notation);

            if (!state.rolling) {
                parseAndRoll(notation);
            }
        });

        button.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            addDieToPool(button.dataset.notation, button);
        });
    });
};

const bindRemoteRolls = () => {
    if (!api?.onRollDice) return;

    api.onRollDice((notation, options) => {
        console.log(`[Dice] Received remote roll: ${notation}`, options);

        const isLight = document.body.classList.contains('light-theme');
        const defaultThemeColor = isLight ? '#7b55ad' : '#a78bfa';

        Box.updateConfig({
            ...(options || {}),
            themeColor: options?.themeColor || defaultThemeColor
        });

        parseAndRoll(notation);
    });
};

Box.init()
    .then(async () => {
        console.log('[Dice] Dice Box is ready.');

        Box.onRollComplete = (results) => {
            console.log('[Dice] Roll complete:', results);
            presentResults(results);

            if (api?.sendDiceRollComplete) {
                api.sendDiceRollComplete(results);
            }
        };

        setupOrbitAnimations();
        bindStableViewportResize();
        bindWindowControls();
        bindRollControls();
        bindRemoteRolls();
        setNotation(elements.notationInput.value);
        refreshDiceViewport();

        await initializeTheme();
        signalReady();
    })
    .catch((error) => {
        console.error('[Dice] Failed to initialize Dice Box:', error);
        elements.rollStatus.textContent = '3D 引擎启动失败';
        elements.resultDetail.textContent = '请关闭窗口后重新打开';
        signalReady();
    });
