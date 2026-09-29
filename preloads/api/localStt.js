'use strict';

// 本地语音识别（SenseVoice）资源包与转写。主进程：modules/ipc/localSttHandlers.js
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/localSttHandlers.js'],
    roles: ['chat'],
    api: {
        getLocalSttStatus: invoke('local-stt:status'),
        prepareLocalStt: invoke('local-stt:prepare', (options = {}) => [options]),
        cancelLocalSttPrepare: invoke('local-stt:cancel'),
        removeLocalStt: invoke('local-stt:remove'),
        transcribeLocalStt: invoke('local-stt:transcribe', (payload) => [payload]),
        onLocalSttState: on('local-stt:state'),
    },
};
