(function (global) {
    'use strict';

    const managers = {
        tempera: global.MusicStageTemperaManager,
        sonnet: global.MusicStageSonnetManager,
        diorama: global.MusicStageDioramaManager,
        fume: global.MusicStageFumeManager,
        tunnel: global.MusicStageTunnelManager,
        kowloon: global.MusicStageKowloonManager,
        inkdraft: global.MusicStageInkdraftManager,
        fogpane: global.MusicStageFogpaneManager,
        lumiere: global.MusicStageLumiereManager,
        hanabi: global.MusicStageHanabiManager,
        clockwork: global.MusicStageClockworkManager,
        orbit: global.MusicStageOrbitManager,
        signal: global.MusicStageSignalManager,
        groupchat: global.MusicStageGroupchatManager,
        impression: global.MusicStageImpressionManager
    };

    // traits 是舞台宿主按模式切换的外观特性，宿主和开场只读这里，不再各写一份名单：
    //   scene3d  自己画满每个像素的 3D 场景（宿主加 .stage-scene-3d，切歌时先淡出、等新歌词再重建）
    //   opaque   画面铺满整张纸，底下的模糊封面不用画（.stage-opaque；3D 场景自动算）
    //   night    浅色主题下画面仍是夜色，左上角字标换成浅色（.stage-night）
    const definitions = [
        { id: 'tempera', label: '凝彩', manager: managers.tempera },
        { id: 'sonnet', label: '商籁', manager: managers.sonnet },
        { id: 'diorama', label: '镜台', manager: managers.diorama, traits: { scene3d: true } },
        { id: 'fume', label: '浮名', manager: managers.fume },
        { id: 'tunnel', label: '隧图', manager: managers.tunnel, traits: { scene3d: true } },
        { id: 'kowloon', label: '町景', manager: managers.kowloon, traits: { scene3d: true } },
        { id: 'inkdraft', label: '墨痕', manager: managers.inkdraft, traits: { opaque: true } },
        { id: 'fogpane', label: '雾笺', manager: managers.fogpane, traits: { opaque: true, night: true } },
        { id: 'lumiere', label: '绘光', manager: managers.lumiere, traits: { opaque: true, night: true } },
        { id: 'hanabi', label: '花火', manager: managers.hanabi, traits: { opaque: true, night: true } },
        { id: 'clockwork', label: '时计', manager: managers.clockwork, traits: { opaque: true } },
        { id: 'orbit', label: '回环', manager: managers.orbit, traits: { opaque: true } },
        { id: 'signal', label: '信号', manager: managers.signal, traits: { opaque: true } },
        { id: 'groupchat', label: '群唱', manager: managers.groupchat, traits: { opaque: true } },
        { id: 'impression', label: '印象', manager: managers.impression, traits: { opaque: true } }
    ];

    global.MusicStageAdvancedModes = Object.freeze({
        entries: Object.freeze(definitions
            .filter((entry) => entry.manager?.create)
            .map((entry) => Object.freeze({
                id: entry.id,
                label: entry.label,
                traits: Object.freeze({ scene3d: false, opaque: false, night: false, ...entry.traits }),
                create(container, services) {
                    return entry.manager.create(container, services);
                }
            })))
    });
})(window);