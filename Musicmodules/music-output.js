// Musicmodules/music-output.js
// 设备、采样率、重采样控制

function setupOutput(app) {
    app.populateDeviceList = async (forceRefresh = false) => {
        if (!app.api?.getMusicDevices) return;
        // 引擎没起来、列设备失败时，下拉框原来是空的（一个选项都没有，看着像坏了）：至少留一个「默认设备」
        const keepDefault = () => {
            if (app.deviceSelect.options.length) return;
            const opt = document.createElement('option');
            opt.value = 'default';
            opt.textContent = '默认设备';
            app.deviceSelect.appendChild(opt);
            app.deviceSelect.value = 'default';
        };
        try {
            const result = await app.api.getMusicDevices({ refresh: forceRefresh });
            if (result?.status === 'success' && result.devices) {
                app.deviceSelect.innerHTML = '';
                const defaultOption = document.createElement('option');
                defaultOption.value = 'default';
                defaultOption.textContent = '默认设备';
                app.deviceSelect.appendChild(defaultOption);

                const preferred = result.devices.preferred || [];
                if (preferred.length > 0) {
                    const group = document.createElement('optgroup');
                    group.label = result.devices.preferred_name || '推荐设备';
                    preferred.forEach(d => {
                        const opt = document.createElement('option');
                        opt.value = d.id;
                        opt.textContent = d.name;
                        group.appendChild(opt);
                    });
                    app.deviceSelect.appendChild(group);
                }

                const other = result.devices.other || [];
                if (other.length > 0) {
                    const group = document.createElement('optgroup');
                    group.label = '其他设备';
                    other.forEach(d => {
                        const opt = document.createElement('option');
                        opt.value = d.id;
                        opt.textContent = d.name;
                        group.appendChild(opt);
                    });
                    app.deviceSelect.appendChild(group);
                }
                // 重建选项会把选中项清回第一个：放回引擎正在用的那个，不然打开窗口总显示「默认设备」。
                const current = app.currentDeviceId === null || app.currentDeviceId === undefined ? 'default' : String(app.currentDeviceId);
                const known = [...app.deviceSelect.querySelectorAll('option')].some((o) => String(o.value) === current);
                app.deviceSelect.value = known ? current : 'default';
            } else keepDefault();
        } catch (e) { console.error("Error populating device list:", e); keepDefault(); }
    };

    // 引擎打开输出时退回了什么（新引擎在 /state 的 output_fallback 里报；旧引擎没有这个字段，什么都不显示）。
    const FALLBACK_TEXT = {
        exclusive: '独占模式没能打开（声卡被别的程序占着，或不支持这首歌的格式），现在用共享模式播放。',
        device: '选的音频设备不在了（拔掉了或编号变了），现在用默认设备播放。'
    };
    app.syncOutputFallback = (state) => {
        const note = document.getElementById('output-fallback-note');
        if (!note || !state || !Array.isArray(state.output_fallback)) return;
        // 独占这句只在开关还开着时说；用户已经关掉独占就不用提了。
        const lines = state.output_fallback
            .filter((k) => k !== 'exclusive' || app.wasapiSwitch?.checked)
            .map((k) => FALLBACK_TEXT[k])
            .filter(Boolean);
        note.textContent = lines.join(' ');
        note.hidden = lines.length === 0;
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
        const selectedId = app.deviceSelect.value === 'default' ? null : parseInt(app.deviceSelect.value, 10);
        const useExc = app.wasapiSwitch.checked;

        if (selectedId === app.currentDeviceId && useExc === app.useWasapiExclusive) return;

        app.deviceSelect.disabled = true;
        app.wasapiSwitch.disabled = true;

        const previous = { device: app.currentDeviceId, exclusive: app.useWasapiExclusive };
        try {
            app.currentDeviceId = selectedId;
            app.useWasapiExclusive = useExc;
            const result = await app.api.configureMusicOutput({
                device_id: app.currentDeviceId,
                exclusive: app.useWasapiExclusive
            });
            if (result?.status === 'success') app.syncOutputFallback(result.state);
            else {
                // 引擎没换成（没连上、旧引擎不认）：界面退回原来的设备和开关，不然显示的是没生效的新设备，
                // 再选一次同一个还会被上面「没变化」直接挡掉，怎么也换不过去。
                app.currentDeviceId = previous.device;
                app.useWasapiExclusive = previous.exclusive;
                app.wasapiSwitch.checked = previous.exclusive;
                const reason = result?.message ? (globalThis.MusicErrorText ? globalThis.MusicErrorText(result.message, '音频引擎没有响应') : result.message) : '音频引擎没有响应';
                app.showPlaybackNotice?.(`切换输出没有成功：${reason}`);
            }
            app.checkOutputFallbackSoon();
            await app.populateDeviceList(false);
            app.deviceSelect.value = app.currentDeviceId === null ? 'default' : app.currentDeviceId;
        } catch (e) { console.error("Error configuring output:", e); }
        finally {
            app.deviceSelect.disabled = false;
            app.wasapiSwitch.disabled = false;
        }
    };

    app.configureUpsampling = async () => {
        if (!app.api?.configureMusicUpsampling) return;
        const rate = parseInt(app.upsamplingSelect.value, 10);
        if (rate === app.targetUpsamplingRate) return;
        app.targetUpsamplingRate = rate;
        await app.api.configureMusicUpsampling({
            target_samplerate: app.targetUpsamplingRate > 0 ? app.targetUpsamplingRate : null
        });
        app.saveSettings();
    };

    app.configureResampling = async () => {
        if (!app.api?.configureMusicResampling) return;
        await app.api.configureMusicResampling({
            quality: app.resampleQualitySelect.value,
            use_cache: app.resampleCacheSwitch.checked,
            preemptive_resample: app.preemptiveResampleSwitch.checked
        });
        app.saveSettings();
    };
}
