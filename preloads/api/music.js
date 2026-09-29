'use strict';

// 音乐播放器：播放列表、Rust 音频引擎播放控制与音效链（EQ/IR/响度/饱和/交叉馈送/重采样）、歌词、WebDAV 音源。
// 主进程：modules/ipc/musicHandlers.js
// 渲染端：Musicmodules/
const { invoke, send, on, onSignal } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/musicHandlers.js'],
    roles: ['utility'],
    api: {
        openMusicWindow: send('open-music-window').roles('chat', 'utility'),
        musicRendererReady: send('music-renderer-ready'),
        getMusicPendingTrack: invoke('music-get-pending-track'),

        // 播放列表
        getMusicPlaylist: invoke('get-music-playlist'),
        saveMusicPlaylist: invoke('save-music-playlist', 'playlist'),
        getCustomPlaylists: invoke('get-custom-playlists'),
        saveCustomPlaylists: invoke('save-custom-playlists', 'playlists'),
        addMusicFolder: invoke('music-add-folder'),
        shareMusicTrack: invoke('music-share-track', 'trackPath'),
        onMusicFiles: on('music-files'),
        onMusicScanStart: onSignal('music-scan-start'),
        onMusicScanProgress: on('music-scan-progress'),
        onMusicScanComplete: on('music-scan-complete'),

        // 播放控制；桌面小组件也可控制播放
        musicLoad: invoke('music-load', 'track'),
        musicPlay: invoke('music-play').roles('utility', 'desktop'),
        musicPause: invoke('music-pause').roles('utility', 'desktop'),
        seekMusic: invoke('music-seek', 'position').roles('utility', 'desktop'),
        getMusicState: invoke('music-get-state').roles('utility', 'desktop'),
        setMusicVolume: invoke('music-set-volume', 'volume').roles('utility', 'desktop'),
        queueNextMusicTrack: invoke('music-queue-next', 'track'),
        cancelMusicPreload: invoke('music-cancel-preload'),
        onMusicSetTrack: on('music-set-track'),
        onMusicControl: on('music-control'),
        onAudioEngineError: on('audio-engine-error'),
        // 桌面小组件 → 音乐窗口的遥控指令（上一首/下一首等）
        sendMusicRemoteCommand: send('music-remote-command', 'command').roles('desktop'),

        // 输出设备与音效链
        getMusicDevices: invoke('music-get-devices', 'options'),
        configureMusicOutput: invoke('music-configure-output', 'options'),
        configureMusicOutputBits: invoke('music-configure-output-bits', 'options'),
        configureMusicOptimizations: invoke('music-configure-optimizations', 'options'),
        configureMusicUpsampling: invoke('music-configure-upsampling', 'options'),
        configureMusicResampling: invoke('music-configure-resampling', 'options'),
        setMusicNoiseShaperCurve: invoke('music-set-noise-shaper-curve', 'options'),
        setMusicEq: invoke('music-set-eq', 'options'),
        setMusicEqType: invoke('music-set-eq-type', 'options'),
        musicLoadIr: invoke('music-load-ir', 'options'),
        musicUnloadIr: invoke('music-unload-ir'),
        selectMusicIrFile: invoke('select-ir-file'),
        getMusicIrStatus: invoke('music-get-ir-status'),
        listMusicIrPresets: invoke('music-list-ir-presets'),
        getMusicIrPresetPath: invoke('music-get-ir-preset-path', 'presetName'),
        configureMusicNormalization: invoke('music-configure-normalization', 'options'),
        getMusicLoudnessInfo: invoke('music-get-loudness-info', 'options'),
        scanMusicLoudness: invoke('music-scan-loudness', 'options'),
        scanMusicLoudnessInBackground: invoke('music-scan-loudness-background', 'options'),
        getMusicSaturation: invoke('music-get-saturation'),
        setMusicSaturation: invoke('music-set-saturation', 'options'),
        getMusicCrossfeed: invoke('music-get-crossfeed'),
        setMusicCrossfeed: invoke('music-set-crossfeed', 'options'),
        getMusicDynamicLoudness: invoke('music-get-dynamic-loudness'),
        setMusicDynamicLoudness: invoke('music-set-dynamic-loudness', 'options'),
        getMusicSettings: invoke('music-get-settings'),
        saveMusicSettings: invoke('music-save-settings', 'settings'),

        // 歌词
        getMusicLyrics: invoke('music-get-lyrics', 'options'),
        fetchMusicLyrics: invoke('music-fetch-lyrics', 'options'),
        searchMusicLyricsCandidates: invoke('music-search-lyrics-candidates', 'options'),
        applyMusicLyricsCandidate: invoke('music-apply-lyrics-candidate', 'options'),

        // WebDAV 音源
        listWebdavServers: invoke('webdav-list-servers'),
        addWebdavServer: invoke('webdav-add-server', 'data'),
        removeWebdavServer: invoke('webdav-remove-server', 'data'),
        testWebdavConnection: invoke('webdav-test-connection', 'data'),
        listWebdavDirectory: invoke('webdav-list-directory', 'data'),
        scanWebdavAudio: invoke('webdav-scan-audio', 'data'),
        getWebdavFileUrl: invoke('webdav-get-file-url', 'data'),
        loadWebdavTrack: invoke('webdav-load-track', 'data'),
        onWebdavScanProgress: on('webdav-scan-progress'),
    },
};