'use strict';

const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/chartHandlers.js'],
    roles: ['chat'],
    api: {
        chartEmbedAcquire: invoke('chart:embed-acquire', 'chartId'),
        chartEmbedSnapshot: invoke('chart:embed-snapshot', 'request'),
        chartEmbedRelease: invoke('chart:embed-release', 'request'),
        chartEmbedReadDataSource: invoke('chart:embed-read-data-source', 'request'),
        chartEmbedOpen: invoke('chart:embed-open', 'chartId'),
        onChartEmbedChanged: on('chart:embed-changed'),
    },
};