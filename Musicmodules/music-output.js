// Musicmodules/music-output.js
// 设备、采样率、重采样控制

function setupOutput(app) {
    app.populateDeviceList = async (forceRefresh = false) => {
        if (!window.electron) return;
        try {
            const result = await window.electron.invoke('music-get-devices', { refresh: forceRefresh });
            if (result.status === 'success' && result.devices) {
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
            }
        } catch (e) { console.error("Error populating device list:", e); }
    };

    app.configureOutput = async () => {
        if (!window.electron) return;
        const selectedId = app.deviceSelect.value === 'default' ? null : parseInt(app.deviceSelect.value, 10);
        const useExc = app.wasapiSwitch.checked;

        if (selectedId === app.currentDeviceId && useExc === app.useWasapiExclusive) return;

        app.deviceSelect.disabled = true;
        app.wasapiSwitch.disabled = true;

        try {
            app.currentDeviceId = selectedId;
            app.useWasapiExclusive = useExc;
            await window.electron.invoke('music-configure-output', {
                device_id: app.currentDeviceId,
                exclusive: app.useWasapiExclusive
            });
            await app.populateDeviceList(false);
            app.deviceSelect.value = app.currentDeviceId === null ? 'default' : app.currentDeviceId;
        } catch (e) { console.error("Error configuring output:", e); }
        finally {
            app.deviceSelect.disabled = false;
            app.wasapiSwitch.disabled = false;
        }
    };

    app.configureUpsampling = async () => {
        if (!window.electron) return;
        const rate = parseInt(app.upsamplingSelect.value, 10);
        if (rate === app.targetUpsamplingRate) return;
        app.targetUpsamplingRate = rate;
        await window.electron.invoke('music-configure-upsampling', {
            target_samplerate: app.targetUpsamplingRate > 0 ? app.targetUpsamplingRate : null
        });
        app.saveSettings();
    };

    app.configureResampling = async () => {
        if (!window.electron) return;
        await window.electron.invoke('music-configure-resampling', {
            quality: app.resampleQualitySelect.value,
            use_cache: app.resampleCacheSwitch.checked,
            preemptive_resample: app.preemptiveResampleSwitch.checked
        });
        app.saveSettings();
    };
}
