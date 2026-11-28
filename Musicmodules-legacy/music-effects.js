// Musicmodules/music-effects.js
// 效果器逻辑：EQ, IR, Loudness, Saturation, Crossfeed, DynamicLoudness, NoiseShaper

function setupEffects(app) {
    // --- EQ Control ---
    app.populateEqPresets = () => {
        const presetNames = {
            'balance': '平衡', 'classical': '古典', 'pop': '流行',
            'rock': '摇滚', 'electronic': '电子', 'acg_vocal': '萌系ACG'
        };
        for (const preset in app.eqPresets) {
            const option = document.createElement('option');
            option.value = preset;
            option.textContent = presetNames[preset] || preset;
            app.eqPresetSelect.appendChild(option);
        }
    };

    app.updateEqSectionState = () => {
        const isExpanded = app.eqSwitch.checked;
        const content = app.eqSection.querySelector('.block-content');

        app.eqSection.classList.toggle('eq-collapsed', !isExpanded);
        app.eqSwitch.setAttribute('aria-expanded', String(isExpanded));
        if (content) content.setAttribute('aria-hidden', String(!isExpanded));
    };

    app.applyEqPreset = (presetName) => {
        const preset = app.eqPresets[presetName];
        if (!preset) return;
        for (const band in preset) {
            const slider = document.getElementById(`eq-${band}`);
            if (slider) slider.value = preset[band];
        }
        app.sendEqSettings();
    };

    app.createEqBands = () => {
        app.eqBandsContainer.innerHTML = '';
        for (const band in app.eqBands) {
            const bandContainer = document.createElement('div');
            bandContainer.className = 'eq-band';
            const label = document.createElement('label');
            label.setAttribute('for', `eq-${band}`);
            label.textContent = band;
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.id = `eq-${band}`;
            slider.min = -15; slider.max = 15; slider.step = 1;
            slider.value = app.eqBands[band];
            slider.addEventListener('input', () => app.sendEqSettings());
            bandContainer.appendChild(label);
            bandContainer.appendChild(slider);
            app.eqBandsContainer.appendChild(bandContainer);
        }
    };

    // 拖动滑块时每个 input 事件都会触发一次设置。各次请求走独立的连接，
    // 到达引擎的先后没有保证，旧值可能盖掉新值；逐个排队又会在松手后还要追很久。
    // 这里同一类设置同时只发一个请求，发送期间的新值只保留最后一个。
    const latestSlots = new Map();
    app.sendLatest = (key, send) => {
        const slot = latestSlots.get(key);
        if (slot) {
            slot.next = send;
            return slot.done;
        }
        const created = { next: null, done: null };
        latestSlots.set(key, created);
        created.done = (async () => {
            let current = send;
            let result;
            while (current) {
                created.next = null;
                try {
                    result = await current();
                } catch (error) {
                    result = { status: 'error', message: error?.message || String(error) };
                }
                current = created.next;
            }
            latestSlots.delete(key);
            return result;
        })();
        return created.done;
    };

    let eqSyncQueue = Promise.resolve();
    let eqRequestSeq = 0;
    let eqPending = 0;
    app.sendEqSettings = async () => {
        if (!app.api?.setMusicEq) return;
        const newBands = {};
        for (const band in app.eqBands) {
            const slider = document.getElementById(`eq-${band}`);
            newBands[band] = parseInt(slider.value, 10);
        }
        const enabled = app.eqSwitch.checked;
        const eqType = app.eqTypeSelect?.value;
        const firTaps = parseInt(app.firTapsSelect?.value, 10) || 1023;
        app.eqEnabled = enabled;
        const requestSeq = ++eqRequestSeq;
        // 没有其它请求在排队时发起的那一个一定执行，后来者之间只保留最新的。
        const mustRun = eqPending === 0;
        eqPending++;
        // Snapshot each gesture and serialize type/enable/bands. A slider event
        // must not duplicate an in-flight FIR rebuild or race an older type.
        const operation = eqSyncQueue.then(async () => {
            // 排队期间又来了更新的值：中间这些不必再发，只发最后一个。
            if (!mustRun && requestSeq !== eqRequestSeq) return { status: 'superseded' };
            if (app.api?.setMusicEqType && eqType !== undefined) {
                if (app._syncedEqType !== eqType || app._syncedFirTaps !== firTaps) {
                    const typeResult = await app.api.setMusicEqType({ type: eqType, fir_taps: firTaps });
                    // IPC represents transport/engine failures as status:error.
                    // Do not advance successful sync markers on those failures.
                    if (typeResult?.status === 'error') return typeResult;
                    app._syncedEqType = eqType;
                    app._syncedFirTaps = firTaps;
                }
            }
            // Type changes can enable/unload filters; apply the captured toggle last.
            const result = await app.api.setMusicEq({ bands: newBands, enabled });
            if (result?.status === 'error') return result;
            app.saveSettings?.();
            return result;
        });
        // One rejected operation must not poison subsequent retries. The caller
        // still receives the original result/rejection, never a false success.
        eqSyncQueue = operation.catch(() => {}).then(() => { eqPending--; });
        return operation;
    };

    // --- IR Convolver ---
    app.updateIrStatus = (text, state = 'idle') => {
        const statusText = app.irStatus.querySelector('.ir-status-text');
        statusText.textContent = text;
        app.irStatus.className = 'ir-status';
        if (state === 'loaded') app.irStatus.classList.add('loaded');
        else if (state === 'error') app.irStatus.classList.add('error');
    };

    app.loadIrFile = async (filePath) => {
        if (!app.api?.musicLoadIr) return;
        app.updateIrStatus('加载中...', 'idle');
        try {
            const result = await app.api.musicLoadIr({ path: filePath });
            if (result.status === 'success') {
                app.irLoadedPath = filePath;
                app.irEnabled = true;
                app.irSwitch.checked = true;
                app.updateIrStatus('加载成功', 'loaded');
            } else {
                app.updateIrStatus(`错误: ${result.message}`, 'error');
                app.irEnabled = false; app.irSwitch.checked = false;
            }
        } catch (e) {
            app.updateIrStatus(`错误: ${e.message}`, 'error');
            app.irEnabled = false; app.irSwitch.checked = false;
        }
    };

    app.unloadIr = async () => {
        if (!app.api?.musicUnloadIr) return;
        try {
            await app.api.musicUnloadIr();
            app.irLoadedPath = null; app.irEnabled = false; app.irSwitch.checked = false;
            app.updateIrStatus('未加载', 'idle');
        } catch (e) {}
    };

    // --- Loudness ---
    app.updateLoudnessSettings = async () => {
        if (!app.api?.configureMusicNormalization) return;
        app.loudnessEnabled = app.loudnessSwitch.checked;
        app.loudnessMode = app.loudnessModeSelect.value;
        app.targetLufs = parseFloat(app.loudnessLufsSlider.value);
        app.loudnessPreampDb = parseFloat(app.loudnessPreampSlider.value);

        const loudness = {
            enabled: app.loudnessEnabled, target_lufs: app.targetLufs,
            mode: app.loudnessMode, preamp_db: app.loudnessPreampDb
        };
        await app.sendLatest('loudness', () => app.api.configureMusicNormalization(loudness));
        const isRg = app.loudnessMode === 'replaygain_track' || app.loudnessMode === 'replaygain_album';
        if (app.replaygainSwitch.checked !== isRg) {
            app.replaygainSwitch._programmaticUpdate = true;
            app.replaygainSwitch.checked = isRg;
            Promise.resolve().then(() => { app.replaygainSwitch._programmaticUpdate = false; });
        }
        app.saveSettings();
    };

    app.updateLoudnessLufsDisplay = () => { app.loudnessLufsValue.textContent = app.loudnessLufsSlider.value; };
    app.updateLoudnessPreampDisplay = () => {
        const val = parseFloat(app.loudnessPreampSlider.value);
        app.loudnessPreampValue.textContent = (val >= 0 ? '+' : '') + val + ' dB';
    };

    // --- Saturation ---
    app.updateSaturationSettings = async () => {
        if (!app.api?.setMusicSaturation) return;
        app.saturationEnabled = app.saturationSwitch.checked;
        app.saturationType = app.saturationTypeSelect.value;
        app.saturationDrive = parseFloat(app.saturationDriveSlider.value) / 100;
        app.saturationMix = parseFloat(app.saturationMixSlider.value) / 100;
        const saturation = { enabled: app.saturationEnabled, drive: app.saturationDrive, mix: app.saturationMix };
        await app.sendLatest('saturation', () => app.api.setMusicSaturation(saturation));
        app.saveSettings();
    };

    app.updateSaturationDriveDisplay = () => { app.saturationDriveValue.textContent = app.saturationDriveSlider.value + '%'; };
    app.updateSaturationMixDisplay = () => { app.saturationMixValue.textContent = app.saturationMixSlider.value + '%'; };

    // --- Crossfeed ---
    app.updateCrossfeedSettings = async () => {
        if (!app.api?.setMusicCrossfeed) return;
        app.crossfeedEnabled = app.crossfeedSwitch.checked;
        app.crossfeedMix = parseFloat(app.crossfeedMixSlider.value) / 100;
        const crossfeed = { enabled: app.crossfeedEnabled, mix: app.crossfeedMix };
        await app.sendLatest('crossfeed', () => app.api.setMusicCrossfeed(crossfeed));
        app.saveSettings();
    };

    app.updateCrossfeedMixDisplay = () => { app.crossfeedMixValue.textContent = app.crossfeedMixSlider.value + '%'; };

    // --- Dynamic Loudness ---
    app.updateDynamicLoudnessSettings = async () => {
        if (!app.api?.setMusicDynamicLoudness) return;
        app.dynamicLoudnessEnabled = app.dynamicLoudnessSwitch.checked;
        app.dynamicLoudnessStrength = parseFloat(app.dynamicLoudnessStrengthSlider.value) / 100;
        const dynamicLoudness = { enabled: app.dynamicLoudnessEnabled, strength: app.dynamicLoudnessStrength };
        await app.sendLatest('dynamic-loudness', () => app.api.setMusicDynamicLoudness(dynamicLoudness));
        app.saveSettings();
    };

    app.updateDynamicLoudnessStrengthDisplay = () => { app.dynamicLoudnessStrengthValue.textContent = app.dynamicLoudnessStrengthSlider.value + '%'; };

    // --- Noise Shaper ---
    app.updateNoiseShaperSettings = async () => {
        if (!app.api?.configureMusicOutputBits || !app.api?.setMusicNoiseShaperCurve) return;
        app.outputBits = parseInt(app.outputBitsSelect.value, 10);
        app.noiseShaperCurve = app.noiseShaperCurveSelect.value;
        await app.api.configureMusicOutputBits({ bits: app.outputBits });
        await app.api.setMusicNoiseShaperCurve({ curve: app.noiseShaperCurve });
        app.saveSettings();
    };

    app.updateOptimizations = async () => {
        if (!app.api?.configureMusicOptimizations) return;
        await app.api.configureMusicOptimizations({ dither_enabled: app.ditherSwitch.checked });
        app.saveSettings();
    };
}
