// modules/ipc/musicEngineHandlers.js
// 音频引擎设置的 IPC：输出设备、EQ、升频/重采样、响度、饱和、声道、交叉馈送、动态响度、噪声整形、位深、
// 引擎设置存取、无缝预载、卷积 IR 及其预设。几乎都是原样转发给引擎 HTTP 接口（audioEngineApi）。
// 由 musicHandlers.js 在注册 IPC 时调用；从那里搬出来，行为不变。
const path = require('path');
const fs = require('fs-extra');

const DEFAULT_IR_PRESET_DIR = path.join(__dirname, '..', '..', 'audio_engine', 'IRPreset');

function registerMusicEngineHandlers({ ipcMain, dialog, audioEngineApi, webdavManager, getDialogWindow, irPresetDir = DEFAULT_IR_PRESET_DIR }) {
    // --- New handlers for WASAPI and device selection ---
    ipcMain.handle('music-get-devices', async (event, options = {}) => {
        const refresh = options.refresh ? '?refresh=true' : '';
        return await audioEngineApi(`/devices${refresh}`, 'GET');
    });

    ipcMain.handle('music-configure-output', (event, { device_id, exclusive }) => {
        return audioEngineApi('/configure_output', 'POST', { device_id, exclusive });
    });

    // --- New handler for EQ ---
    ipcMain.handle('music-set-eq', (event, { bands, enabled }) => {
        return audioEngineApi('/set_eq', 'POST', { bands, enabled });
    });

    // --- New handler for Upsampling ---
    ipcMain.handle('music-configure-upsampling', (event, { target_samplerate }) => {
        return audioEngineApi('/configure_upsampling', 'POST', { target_samplerate });
    });

    // --- Resampling Settings Handler ---
    ipcMain.handle('music-configure-resampling', (event, { quality, use_cache, preemptive_resample }) => {
        return audioEngineApi('/configure_resampling', 'POST', { quality, use_cache, preemptive_resample });
    });

    ipcMain.handle('music-set-eq-type', (event, { type, fir_taps }) => {
        return audioEngineApi('/set_eq_type', 'POST', { type, fir_taps });
    });

    ipcMain.handle('music-configure-optimizations', (event, data) => {
        return audioEngineApi('/configure_optimizations', 'POST', data);
    });

    // --- Loudness Normalization Handlers ---
    ipcMain.handle('music-configure-normalization', async (event, data) => {
        console.log('[Music] configure_normalization request:', JSON.stringify(data));
        const result = await audioEngineApi('/configure_normalization', 'POST', data);
        console.log('[Music] configure_normalization response:', JSON.stringify(result));
        return result;
    });

    ipcMain.handle('music-get-loudness-info', async () => {
        return await audioEngineApi('/loudness_info', 'GET');
    });

    ipcMain.handle('music-scan-loudness', (event, { path }) => {
        return audioEngineApi('/scan_loudness', 'POST', { path });
    });

    ipcMain.handle('music-scan-loudness-background', (event, { path, store }) => {
        return audioEngineApi('/scan_loudness_background', 'POST', { path, store });
    });

    // --- Saturation Effect Handlers ---
    ipcMain.handle('music-get-saturation', async () => {
        return await audioEngineApi('/saturation', 'GET');
    });

    ipcMain.handle('music-set-saturation', (event, data) => {
        return audioEngineApi('/set_saturation', 'POST', data);
    });

    // --- 声道（左右平衡 / 互换 / 单声道），新引擎才有 /set_channels ---
    ipcMain.handle('music-set-channels', (event, data) => {
        return audioEngineApi('/set_channels', 'POST', data);
    });

    // --- Crossfeed Handlers ---
    ipcMain.handle('music-get-crossfeed', async () => {
        return await audioEngineApi('/crossfeed', 'GET');
    });

    ipcMain.handle('music-set-crossfeed', (event, data) => {
        return audioEngineApi('/set_crossfeed', 'POST', data);
    });

    // --- Dynamic Loudness Handlers ---
    ipcMain.handle('music-get-dynamic-loudness', async () => {
        return await audioEngineApi('/dynamic_loudness', 'GET');
    });

    ipcMain.handle('music-set-dynamic-loudness', (event, data) => {
        return audioEngineApi('/set_dynamic_loudness', 'POST', data);
    });

    // --- Noise Shaper Handlers ---
    ipcMain.handle('music-get-noise-shaper-curve', async () => {
        return await audioEngineApi('/noise_shaper_curve', 'GET');
    });

    ipcMain.handle('music-set-noise-shaper-curve', (event, { curve }) => {
        return audioEngineApi('/set_noise_shaper_curve', 'POST', { curve });
    });

    ipcMain.handle('music-configure-output-bits', (event, { bits }) => {
        return audioEngineApi('/configure_output_bits', 'POST', { bits });
    });

    // --- IR Status Handler ---
    ipcMain.handle('music-get-ir-status', async () => {
        return await audioEngineApi('/ir_status', 'GET');
    });
    
    // --- Settings Persistence ---
    ipcMain.handle('music-get-settings', async () => {
        return await audioEngineApi('/settings', 'GET');
    });

    ipcMain.handle('music-save-settings', (event, data) => {
        return audioEngineApi('/save_settings', 'POST', data);
    });

    // --- Gapless Playback Handlers ---
    ipcMain.handle('music-queue-next', (event, { path, username, password, serverId }) => {
        // 远程曲目预载要带上它所在服务器的账号；不然引擎用的是上一次配置的那台，换台就预载失败。
        if (!username && !password) {
            const creds = webdavManager.credentialsForTrack?.({ serverId, path });
            if (creds?.username && creds?.password) ({ username, password } = creds);
        }
        return audioEngineApi('/queue_next', 'POST', { path, username, password });
    });

    ipcMain.handle('music-cancel-preload', () => {
        return audioEngineApi('/cancel_preload', 'POST');
    });

    // --- FIR IR Convolver Handlers ---
    ipcMain.handle('music-load-ir', (event, { path }) => {
        return audioEngineApi('/load_ir', 'POST', { path });
    });

    ipcMain.handle('music-unload-ir', () => {
        return audioEngineApi('/unload_ir', 'POST');
    });

    // --- IR Presets Handling ---
    const IR_AUDIO_EXTENSIONS = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.ape']);
    ipcMain.handle('music-list-ir-presets', async () => {
        try {
            const files = await fs.readdir(irPresetDir);
            return files
                .filter(file => IR_AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()))
                .map(file => path.parse(file).name);
        } catch (err) {
            if (err?.code === 'ENOENT') return [];
            console.error('[Music] Failed to list IR presets:', err);
            return [];
        }
    });

    ipcMain.handle('music-get-ir-preset-path', async (event, presetName) => {
        try {
            const files = await fs.readdir(irPresetDir);
            const match = files.find(file => {
                const p = path.parse(file);
                return p.name === presetName && IR_AUDIO_EXTENSIONS.has(p.ext.toLowerCase());
            });
            return match ? path.join(irPresetDir, match) : null;
        } catch (err) {
            if (err?.code === 'ENOENT') return null;
            console.error('[Music] Failed to get IR preset path:', err);
            return null;
        }
    });

    // --- IR File Selection Dialog ---
    ipcMain.handle('select-ir-file', async () => {
        const result = await dialog.showOpenDialog(getDialogWindow(), {
            title: '选择脉冲响应文件 (IR)',
            filters: [
                { name: '音频文件', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a', 'ape'] },
                { name: 'WAV', extensions: ['wav'] },
                { name: 'FLAC', extensions: ['flac'] },
                { name: '所有文件', extensions: ['*'] }
            ],
            properties: ['openFile']
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });
}

module.exports = { registerMusicEngineHandlers };
