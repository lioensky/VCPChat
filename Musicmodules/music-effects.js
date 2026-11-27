// Musicmodules/music-effects.js
// 效果器逻辑：EQ, IR, Loudness, Saturation, Crossfeed, DynamicLoudness, NoiseShaper

function setupEffects(app) {
    // --- EQ Control ---
    app.populateEqPresets = () => {
        const presetNames = {
            'balance': '平衡', 'classical': '古典', 'pop': '流行',
            'rock': '摇滚', 'electronic': '电子', 'acg_vocal': '萌系ACG'
        };
        // 滑块拖得和哪个预设都不一样时显示「自定义」；这一项不能从列表里选。
        const useFrag = typeof document.createDocumentFragment === 'function';
        const target = useFrag ? document.createDocumentFragment() : app.eqPresetSelect;
        const custom = document.createElement('option');
        custom.value = 'custom';
        custom.textContent = '自定义';
        custom.disabled = true;
        custom.hidden = true;
        target.appendChild(custom);
        for (const preset in app.eqPresets) {
            const option = document.createElement('option');
            option.value = preset;
            option.textContent = presetNames[preset] || preset;
            target.appendChild(option);
        }
        if (useFrag) app.eqPresetSelect.appendChild(target);
        app.syncEqPresetSelect();
    };

    // 预设下拉要跟着滑块走：以前选了「摇滚」再拖一个频段，下拉还写着「摇滚」；
    // 重开窗口时不管滑块是什么，下拉都停在第一项「平衡」。
    app.syncEqPresetSelect = () => {
        if (!app.eqPresetSelect || !app.eqPresets) return;
        const current = {};
        for (const band in app.eqBands || {}) {
            const slider = document.getElementById(`eq-${band}`);
            current[band] = Number(slider ? slider.value : app.eqBands[band]) || 0;
        }
        const match = Object.keys(app.eqPresets).find((name) => {
            const preset = app.eqPresets[name];
            return Object.keys(current).every((band) => (Number(preset[band]) || 0) === current[band]);
        });
        app.eqPresetSelect.value = match || 'custom';
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
        app.syncEqPresetSelect();
    };

    app.createEqBands = () => {
        app.eqBandsContainer.innerHTML = '';
        const useFrag = typeof document.createDocumentFragment === 'function';
        const target = useFrag ? document.createDocumentFragment() : app.eqBandsContainer;
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
            slider.addEventListener('input', () => { app.sendEqSettings(); app.syncEqPresetSelect(); });
            bandContainer.appendChild(label);
            bandContainer.appendChild(slider);
            target.appendChild(bandContainer);
        }
        if (useFrag) app.eqBandsContainer.appendChild(target);
        app.syncEqPresetSelect();
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
            const parsed = parseInt(slider ? slider.value : app.eqBands[band], 10);
            const value = Number.isFinite(parsed) ? parsed : 0;
            newBands[band] = value;
            app.eqBands[band] = value;
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

    let irLoadSeq = 0;
    app.loadIrFile = async (filePath) => {
        if (!app.api?.musicLoadIr) return;
        const seq = ++irLoadSeq;
        app.updateIrStatus('加载中…', 'idle');
        try {
            const result = await app.api.musicLoadIr({ path: filePath });
            if (seq !== irLoadSeq) return;
            if (result.status === 'success') {
                app.irLoadedPath = filePath;
                app.irEnabled = true;
                app.irSwitch.checked = true;
                app.updateIrStatus('加载成功', 'loaded');
            } else {
                app.updateIrStatus((window.MusicErrorText || ((m, f) => f))(result.message, '加载失败'), 'error');
                app.irEnabled = false; app.irSwitch.checked = false;
            }
        } catch (e) {
            if (seq !== irLoadSeq) return;
            app.updateIrStatus((window.MusicErrorText || ((m, f) => f))(e, '加载失败'), 'error');
            app.irEnabled = false; app.irSwitch.checked = false;
        }
    };

    // 选 IR 文件。取消了选择时，开关和下拉要回到实际状态：没有加载着的 IR 就不能显示「开」或「自定义」。
    app.pickIrFile = async () => {
        let filePath = null;
        try { filePath = await app.api?.selectMusicIrFile?.(); } catch (e) { filePath = null; }
        if (filePath) return app.loadIrFile(filePath);
        if (!app.irLoadedPath) {
            app.irEnabled = false;
            app.irSwitch.checked = false;
            if (app.irPresetSelect?.value === 'custom') {
                app.irPresetSelect.value = '';
                if (app.irLoadBtn) app.irLoadBtn.style.display = 'none';
            }
        }
        return undefined;
    };

    app.unloadIr = async () => {
        if (!app.api?.musicUnloadIr) return;
        const seq = ++irLoadSeq;
        try {
            const result = await app.api.musicUnloadIr();
            if (seq !== irLoadSeq) return;
            if (result?.status === 'error') {
                app.updateIrStatus((window.MusicErrorText || ((m, f) => f))(result.message, '卸载失败'), 'error');
                return;
            }
            app.irLoadedPath = null; app.irEnabled = false; app.irSwitch.checked = false;
            app.updateIrStatus('未加载', 'idle');
        } catch (e) {
            if (seq !== irLoadSeq) return;
            app.updateIrStatus((window.MusicErrorText || ((m, f) => f))(e, '卸载失败'), 'error');
        }
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

    app.updateLoudnessLufsDisplay = () => { app.loudnessLufsValue.textContent = `${app.loudnessLufsSlider.value} LUFS`; };
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

    // --- 切歌交叉淡入：引擎在曲尾和预载好的下一首做等功率交叉，时长随设置一起保存 ---
    app.crossfadeSelect?.addEventListener('change', () => app.saveSettings());

    app.updateDynamicLoudnessStrengthDisplay = () => { app.dynamicLoudnessStrengthValue.textContent = app.dynamicLoudnessStrengthSlider.value + '%'; };

    // --- Noise Shaper ---
    app.updateNoiseShaperSettings = async () => {
        if (!app.api?.configureMusicOutputBits || !app.api?.setMusicNoiseShaperCurve) return;
        const bits = parseInt(app.outputBitsSelect.value, 10);
        const curve = app.noiseShaperCurveSelect.value;
        app.outputBits = bits;
        app.noiseShaperCurve = curve;
        await app.sendLatest('noise-shaper', async () => {
            await app.api.configureMusicOutputBits({ bits });
            return app.api.setMusicNoiseShaperCurve({ curve });
        });
        app.saveSettings();
    };

    // 「抖动处理」就是噪声整形的总开关：关掉时下面的位深和曲线不起作用，跟着变灰。
    app.syncDitherSection = () => {
        const on = !!app.ditherSwitch?.checked;
        document.getElementById('noise-shaper-section')?.classList.toggle('is-inactive', !on);
        if (app.outputBitsSelect) app.outputBitsSelect.disabled = !on;
        if (app.noiseShaperCurveSelect) app.noiseShaperCurveSelect.disabled = !on;
    };

    app.updateOptimizations = async () => {
        if (!app.api?.configureMusicOptimizations) return;
        const ditherEnabled = app.ditherSwitch.checked;
        await app.sendLatest('optimizations', () => app.api.configureMusicOptimizations({ dither_enabled: ditherEnabled }));
        app.saveSettings();
    };
}
