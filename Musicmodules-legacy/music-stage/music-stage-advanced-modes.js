(function (global) {
    'use strict';

    const managers = {
        tempera: global.MusicStageTemperaManager,
        sonnet: global.MusicStageSonnetManager,
        diorama: global.MusicStageDioramaManager,
        fume: global.MusicStageFumeManager,
        tunnel: global.MusicStageTunnelManager
    };

    const definitions = [
        { id: 'tempera', label: '凝彩', manager: managers.tempera },
        { id: 'sonnet', label: '商籁', manager: managers.sonnet },
        { id: 'diorama', label: '镜台', manager: managers.diorama },
        { id: 'fume', label: '浮名', manager: managers.fume },
        { id: 'tunnel', label: '隧图', manager: managers.tunnel }
    ];

    global.MusicStageAdvancedModes = Object.freeze({
        entries: Object.freeze(definitions
            .filter((entry) => entry.manager?.create)
            .map((entry) => Object.freeze({
                id: entry.id,
                label: entry.label,
                create(container, services) {
                    return entry.manager.create(container, services);
                }
            })))
    });
})(window);