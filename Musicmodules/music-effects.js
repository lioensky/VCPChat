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

    app.sendEqSettings = async () => {
        if (!window.electron) return;
        const newBands = {};
        for (const band in app.eqBands) {
            const slider = document.getElementById(`eq-${band}`);
            newBands[band] = parseInt(slider.value, 10);
        }
        app.eqEnabled = app.eqSwitch.checked;
        await window.electron.invoke('music-set-eq', { bands: newBands, enabled: app.eqEnabled });
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
        if (!window.electron) return;
        app.updateIrStatus('加载中...', 'idle');
        try {
            const result = await window.electron.invoke('music-load-ir', { path: filePath });
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
        if (!window.electron) return;
        try {
            await window.electron.invoke('music-unload-ir');
            app.irLoadedPath = null; app.irEnabled = false; app.irSwitch.checked = false;
            app.updateIrStatus('未加载', 'idle');
        } catch (e) {}
    };

    // --- Loudness ---
    app.updateLoudnessSettings = async () => {
        if (!window.electron) return;
        app.loudnessEnabled = app.loudnessSwitch.checked;
        app.loudnessMode = app.loudnessModeSelect.value;
        app.targetLufs = parseFloat(app.loudnessLufsSlider.value);
        app.loudnessPreampDb = parseFloat(app.loudnessPreampSlider.value);

        await window.electron.invoke('music-configure-normalization', {
            enabled: app.loudnessEnabled, target_lufs: app.targetLufs,
            mode: app.loudnessMode, preamp_db: app.loudnessPreampDb
        });
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
        if (!window.electron) return;
        app.saturationEnabled = app.saturationSwitch.checked;
        app.saturationType = app.saturationTypeSelect.value;
        app.saturationDrive = parseFloat(app.saturationDriveSlider.value) / 100;
        app.saturationMix = parseFloat(app.saturationMixSlider.value) / 100;
        await window.electron.invoke('music-set-saturation', {
            enabled: app.saturationEnabled, drive: app.saturationDrive, mix: app.saturationMix
        });
        app.saveSettings();
    };

    app.updateSaturationDriveDisplay = () => { app.saturationDriveValue.textContent = app.saturationDriveSlider.value + '%'; };
    app.updateSaturationMixDisplay = () => { app.saturationMixValue.textContent = app.saturationMixSlider.value + '%'; };

    // --- Crossfeed ---
    app.updateCrossfeedSettings = async () => {
        if (!window.electron) return;
        app.crossfeedEnabled = app.crossfeedSwitch.checked;
        app.crossfeedMix = parseFloat(app.crossfeedMixSlider.value) / 100;
        await window.electron.invoke('music-set-crossfeed', { enabled: app.crossfeedEnabled, mix: app.crossfeedMix });
        app.saveSettings();
    };

    app.updateCrossfeedMixDisplay = () => { app.crossfeedMixValue.textContent = app.crossfeedMixSlider.value + '%'; };

    // --- Dynamic Loudness ---
    app.updateDynamicLoudnessSettings = async () => {
        if (!window.electron) return;
        app.dynamicLoudnessEnabled = app.dynamicLoudnessSwitch.checked;
        app.dynamicLoudnessStrength = parseFloat(app.dynamicLoudnessStrengthSlider.value) / 100;
        await window.electron.invoke('music-set-dynamic-loudness', {
            enabled: app.dynamicLoudnessEnabled, strength: app.dynamicLoudnessStrength
        });
        app.saveSettings();
    };

    app.updateDynamicLoudnessStrengthDisplay = () => { app.dynamicLoudnessStrengthValue.textContent = app.dynamicLoudnessStrengthSlider.value + '%'; };

    // --- Noise Shaper ---
    app.updateNoiseShaperSettings = async () => {
        if (!window.electron) return;
        app.outputBits = parseInt(app.outputBitsSelect.value, 10);
        app.noiseShaperCurve = app.noiseShaperCurveSelect.value;
        await window.electron.invoke('music-configure-output-bits', { bits: app.outputBits });
        await window.electron.invoke('music-set-noise-shaper-curve', { curve: app.noiseShaperCurve });
    };

    app.updateOptimizations = async () => {
        if (!window.electron) return;
        await window.electron.invoke('music-configure-optimizations', { dither_enabled: app.ditherSwitch.checked });
    };
}
