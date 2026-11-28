// Musicmodules/music-output.js
// 设备、采样率、重采样控制

function setupOutput(app) {
    let populateSeq = 0;
    app.populateDeviceList = async (forceRefresh = false) => {
        if (!app.api?.getMusicDevices || !app.deviceSelect) return;
        const seq = ++populateSeq;
        // 引擎没起来、列设备失败时，下拉框原来是空的（一个选项都没有，看着像坏了）：至少留一个「默认设备」
        const keepDefault = () => {
            if (app.deviceSelect.options?.length) return;
            const opt = document.createElement('option');
            opt.value = 'default';
            opt.textContent = '默认设备';
            app.deviceSelect.appendChild(opt);
            app.deviceSelect.value = 'default';
        };
        try {
            const result = await app.api.getMusicDevices({ refresh: forceRefresh });
            if (seq !== populateSeq) return;
            if (result?.status === 'success' && result.devices) {
                app.deviceSelect.innerHTML = '';
                const useFrag = typeof document.createDocumentFragment === 'function';
                const target = useFrag ? document.createDocumentFragment() : app.deviceSelect;
                const defaultOption = document.createElement('option');
                defaultOption.value = 'default';
                defaultOption.textContent = '默认设备';
                target.appendChild(defaultOption);

                const preferred = result.devices.preferred || [];
                if (preferred.length > 0) {
                    const group = document.createElement('optgroup');
                    group.label = result.devices.preferred_name || '推荐设备';
                    for (let i = 0; i < preferred.length; i += 1) {
                        const d = preferred[i];
                        const opt = document.createElement('option');
                        opt.value = d.id;
                        opt.textContent = d.name;
                        group.appendChild(opt);
                    }
                    target.appendChild(group);
                }

                const other = result.devices.other || [];
                if (other.length > 0) {
                    const group = document.createElement('optgroup');
                    group.label = '其他设备';
                    for (let i = 0; i < other.length; i += 1) {
                        const d = other[i];
                        const opt = document.createElement('option');
                        opt.value = d.id;
                        opt.textContent = d.name;
                        group.appendChild(opt);
                    }
                    target.appendChild(group);
                }
                if (useFrag) app.deviceSelect.appendChild(target);
                // 重建选项会把选中项清回第一个：放回引擎正在用的那个，不然打开窗口总显示「默认设备」。
                const current = app.currentDeviceId === null || app.currentDeviceId === undefined ? 'default' : String(app.currentDeviceId);
                let known = false;
                const opts = app.deviceSelect.options || app.deviceSelect.querySelectorAll('option');
                for (let i = 0; i < opts.length; i += 1) {
                    if (String(opts[i].value) === current) { known = true; break; }
                }
                app.deviceSelect.value = known ? current : 'default';
            } else keepDefault();
        } catch (e) {
            if (seq !== populateSeq) return;
            console.error("Error populating device list:", e);
            keepDefault();
        }
    };

    // 引擎打开输出时退回了什么（新引擎在 /state 的 output_fallback 里报；旧引擎没有这个字段，什么都不显示）。
    const FALLBACK_TEXT = {
        exclusive: '独占模式没能打开（声卡被别的程序占着，或不支持这首歌的格式），现在用共享模式播放。',
        device: '选的音频设备不在了（拔掉了或编号变了），现在用默认设备播放。'
    };
    let fallbackNoteEl = null;
    app.syncOutputFallback = (state) => {
        if (!state || !Array.isArray(state.output_fallback)) return;
        const note = (fallbackNoteEl && fallbackNoteEl.isConnected) ? fallbackNoteEl : (fallbackNoteEl = document.getElementById('output-fallback-note'));
        if (!note) return;
        // 独占这句只在开关还开着时说；用户已经关掉独占就不用提了。
        let text = '';
        const list = state.output_fallback;
        if (list.length > 0) {
            const wasapiOn = Boolean(app.wasapiSwitch?.checked);
            for (let i = 0; i < list.length; i += 1) {
                const k = list[i];
                if (k === 'exclusive' && !wasapiOn) continue;
                const msg = FALLBACK_TEXT[k];
                if (msg) text = text ? `${text} ${msg}` : msg;
            }
        }
        const hidden = text.length === 0;
        if (note.textContent !== text) note.textContent = text;
        if (note.hidden !== hidden) note.hidden = hidden;
    };
    // 输出是在开始播放时才真正打开的，所以开播后和改设置后过一会儿再问一次。
    let fallbackCheckTimer = null;
    app.checkOutputFallbackSoon = (delay = 900) => {
        if (!app.api?.getMusicState) return;
        clearTimeout(fallbackCheckTimer);
        fallbackCheckTimer = setTimeout(async () => {
            try {
                const result = await app.api.getMusicState();
                if (result?.status === 'success') app.syncOutputFallback(result.state);
            } catch (e) { /* 只是提示 */ }
        }, delay);
    };

    app.configureOutput = async () => {
        if (!app.api?.configureMusicOutput) return;
        const parsedId = app.deviceSelect.value === 'default' ? null : parseInt(app.deviceSelect.value, 10);
        const selectedId = parsedId !== null && Number.isFinite(parsedId) ? parsedId : null;
        const useExc = app.wasapiSwitch.checked;

        if (selectedId === app.currentDeviceId && useExc === app.useWasapiExclusive) return;

        app.deviceSelect.disabled = true;
        app.wasapiSwitch.disabled = true;

        const previous = { device: app.currentDeviceId, exclusive: app.useWasapiExclusive };
        const rollback = (message) => {
            // 引擎没换成（没连上、旧引擎不认或 IPC 抛错）：界面退回原来的设备和开关，不然显示的是没生效的新设备，
            // 再选一次同一个还会被上面「没变化」直接挡掉，怎么也换不过去。
            app.currentDeviceId = previous.device;
            app.useWasapiExclusive = previous.exclusive;
            app.wasapiSwitch.checked = previous.exclusive;
            app.deviceSelect.value = previous.device === null ? 'default' : previous.device;
            const reason = message ? (globalThis.MusicErrorText ? globalThis.MusicErrorText(message, '音频引擎没有响应') : message) : '音频引擎没有响应';
            app.showPlaybackNotice?.(`切换输出没有成功：${reason}`);
        };
        let applied = false;
        try {
            app.currentDeviceId = selectedId;
            app.useWasapiExclusive = useExc;
            const result = await app.api.configureMusicOutput({
                device_id: app.currentDeviceId,
                exclusive: app.useWasapiExclusive
            });
            if (result?.status === 'success') {
                applied = true;
                app.syncOutputFallback(result.state);
            } else rollback(result?.message);
            app.checkOutputFallbackSoon();
            await app.populateDeviceList(false);
            app.deviceSelect.value = app.currentDeviceId === null ? 'default' : app.currentDeviceId;
        } catch (e) {
            console.error("Error configuring output:", e);
            if (!applied) rollback(e?.message || String(e));
        } finally {
            app.deviceSelect.disabled = false;
            app.wasapiSwitch.disabled = false;
        }
    };

    app.configureUpsampling = async () => {
        if (!app.api?.configureMusicUpsampling) return;
        const parsedRate = parseInt(app.upsamplingSelect.value, 10);
        const rate = Number.isFinite(parsedRate) ? parsedRate : 0;
        if (rate === app.targetUpsamplingRate) return;
        const prevRate = app.targetUpsamplingRate;
        app.targetUpsamplingRate = rate;
        try {
            const result = await app.api.configureMusicUpsampling({
                target_samplerate: app.targetUpsamplingRate > 0 ? app.targetUpsamplingRate : null
            });
            if (result?.status === 'error') {
                app.targetUpsamplingRate = prevRate;
                if (app.upsamplingSelect) app.upsamplingSelect.value = String(prevRate || 0);
                return;
            }
            app.saveSettings();
        } catch (e) {
            console.error("Error configuring upsampling:", e);
            app.targetUpsamplingRate = prevRate;
            if (app.upsamplingSelect) app.upsamplingSelect.value = String(prevRate || 0);
        }
    };

    app.configureResampling = async () => {
        if (!app.api?.configureMusicResampling) return;
        try {
            const result = await app.api.configureMusicResampling({
                quality: app.resampleQualitySelect.value,
                use_cache: app.resampleCacheSwitch.checked,
                preemptive_resample: app.preemptiveResampleSwitch.checked
            });
            if (result?.status === 'error') return;
            app.saveSettings();
        } catch (e) {
            console.error("Error configuring resampling:", e);
        }
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('beforeunload', () => {
            if (fallbackCheckTimer) { clearTimeout(fallbackCheckTimer); fallbackCheckTimer = null; }
        }, { once: true });
    }
}
